// sd-kickoff.mjs — Strategic Directives kickoff flow (issue #22), as a profile
// plugin. Drives the quarterly SD process so the committee doesn't have to
// remember it:
//
//   * ~N weeks before quarter end (default 4), announces the kickoff in the
//     committee channel and DMs every committee member asking for input.
//   * Re-nudges each member on a cadence until they respond — silence is not
//     consent. After max_nudges unanswered DMs it escalates once in the
//     committee channel and stops DMing.
//   * A member has "responded" when an input file exists at
//     `context/sd/inputs/<quarter>/<slug>.md`. The companion `sd-kickoff`
//     container skill makes the assistant file that input when the member
//     replies in DM (a human can also write the file by hand).
//   * Once everyone has filed input — or the draft deadline arrives — it
//     schedules a one-shot agent task to compose the first SD draft from the
//     template + inputs + member profiles, and post it to the committee
//     channel for review. Receptive, not pushy: the draft is a starting
//     point; nothing is auto-published.
//
// Architecture: the plugin needs no secrets and imports nothing from the
// framework. It acts purely through the two filesystem contracts every
// install already exposes:
//   * the shared KB  (committee roster, per-quarter state, collected inputs)
//   * the IPC dirs   (`dm_user`, `message`, `schedule_task` ops — written into
//                     the shared-KB group's own namespace, so same-group
//                     authorization applies)
//
// Configuration lives in the KB so ops can edit it from the dashboard:
// `groups/<sharedKbGroup>/context/sd/committee.md` (see context/sd/README.md
// in the example profile). Without that file the flow is a silent no-op.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import matter from 'gray-matter';

const DAY_MS = 86_400_000;

/**
 * The quarter window this flow operates in. Quarters are calendar quarters in
 * server-local time; `label` names the quarter being PLANNED (the one after
 * the current quarter ends — kicking off in June plans Q3).
 */
export function quarterWindow(nowMs, kickoffWeeksBefore = 4) {
  const d = new Date(nowMs);
  const q = Math.floor(d.getMonth() / 3); // 0..3
  // Midnight after the quarter's last day == start of the next quarter.
  const quarterEndMs = new Date(d.getFullYear(), q * 3 + 3, 1).getTime();
  const windowStartMs = quarterEndMs - kickoffWeeksBefore * 7 * DAY_MS;
  const label =
    q === 3 ? `${d.getFullYear() + 1}-Q1` : `${d.getFullYear()}-Q${q + 2}`;
  return { label, quarterEndMs, windowStartMs };
}

/** Parse context/sd/committee.md (frontmatter-driven; body is free text). */
export function parseCommittee(mdText) {
  const fm = matter(mdText).data ?? {};
  const members = Array.isArray(fm.members)
    ? fm.members.filter((m) => typeof m === 'string' && m.trim() !== '')
    : [];
  return {
    members,
    channelJid: typeof fm.channel_jid === 'string' ? fm.channel_jid : '',
    kickoffWeeksBefore: Number(fm.kickoff_weeks_before) || 4,
    nudgeEveryDays: Number(fm.nudge_every_days) || 3,
    maxNudges: Number(fm.max_nudges) || 4,
    draftDaysBeforeEnd: Number(fm.draft_days_before_end) || 7,
  };
}

function kickoffPost(label, members) {
  return (
    `📋 Strategic Directives kickoff for ${label} starts now. ` +
    `I'm collecting input from the SD committee (${members.join(', ')}) by DM. ` +
    `Once everyone has weighed in — or the drafting deadline arrives — I'll post a first draft here for review.`
  );
}

function escalationPost(slug, asks, label) {
  return (
    `⚠️ ${slug} hasn't provided Strategic Directives input for ${label} after ${asks} DM reminders. ` +
    `Committee: please follow up directly — I'll stop nudging them.`
  );
}

function askText(label, askNumber) {
  if (askNumber === 1) {
    return (
      `Hi! Strategic Directives kickoff for ${label} — the committee is gathering input before drafting. ` +
      `What should next quarter's directives consider? Goals, priorities, hours expectations, worries — anything. ` +
      `Reply here in this DM and I'll file your input. ` +
      `I'll check back every few days until I hear from you (silence isn't consent 🙂).`
    );
  }
  return (
    `Reminder ${askNumber - 1} — still waiting on your Strategic Directives input for ${label}. ` +
    `A couple of sentences is plenty; reply here and I'll file it. ` +
    `(Already replied but it wasn't filed? Say "file my SD input" and restate it.)`
  );
}

/**
 * Decide this tick's actions from current state. Pure — no I/O, no clock —
 * so the nudge ladder is unit-testable. Returns the actions plus the next
 * state (never mutates the input state).
 */
export function planActions({ nowMs, cfg, members, state, inputs }) {
  const out = { dms: [], posts: [], requestDraft: false };
  const st = {
    ...state,
    members: Object.fromEntries(
      Object.entries(state.members ?? {}).map(([k, v]) => [k, { ...v }]),
    ),
  };

  if (!st.kickoffAnnouncedAt) {
    st.kickoffAnnouncedAt = new Date(nowMs).toISOString();
    out.posts.push(kickoffPost(cfg.label, members));
  }

  const nudgeMs = cfg.nudgeEveryDays * DAY_MS;
  for (const slug of members) {
    if (inputs.has(slug)) continue;
    const m = st.members[slug] ?? { asks: 0, lastAskAt: null, escalated: false };
    const due = !m.lastAskAt || nowMs - Date.parse(m.lastAskAt) >= nudgeMs;
    if (due) {
      if (m.asks >= cfg.maxNudges) {
        if (!m.escalated) {
          m.escalated = true;
          out.posts.push(escalationPost(slug, m.asks, cfg.label));
        }
      } else {
        m.asks += 1;
        m.lastAskAt = new Date(nowMs).toISOString();
        out.dms.push({ slug, text: askText(cfg.label, m.asks) });
      }
    }
    st.members[slug] = m;
  }

  const everyoneIn = members.every((s) => inputs.has(s));
  const draftDue =
    nowMs >= cfg.quarterEndMs - cfg.draftDaysBeforeEnd * DAY_MS;
  if (!st.draftRequestedAt && (everyoneIn || draftDue)) {
    st.draftRequestedAt = new Date(nowMs).toISOString();
    out.requestDraft = true;
  }

  return { ...out, state: st };
}

/** Local-time stamp without timezone suffix — the schedule_task `once` format. */
function localStamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

function draftTaskIpc({ label, committee, inputs, nowMs }) {
  const missing = committee.members.filter((s) => !inputs.has(s));
  const missingNote =
    missing.length > 0
      ? `Members with NO filed input (note them in the draft so the committee follows up): ${missing.join(', ')}.`
      : 'Every committee member filed input.';
  const prompt =
    `Strategic Directives drafting task for ${label}. Use the sd-kickoff skill (Drafting section).\n\n` +
    `1. Read every input file under /workspace/shared-kb/sd/inputs/${label}/.\n` +
    `2. If /workspace/shared-kb/sd/template.md exists, use it as the draft skeleton.\n` +
    `3. Read member capacity (expected_hours_per_week) from /workspace/shared-kb/people/*.md frontmatter and include a recommended hours RANGE plus a CEILING per role, so payment expectations are managed.\n` +
    `4. ${missingNote}\n` +
    `5. Compose the first draft of the ${label} Strategic Directives and save it to the KB at sd/drafts/${label}.md via modify_kb_file.\n` +
    `6. Post the draft (or a tight summary + where the full draft lives) in this channel for committee review.\n\n` +
    `Tone: receptive, not pushy — this is a starting point for the committee, never a final document. Do not publish it anywhere else.`;
  return {
    type: 'schedule_task',
    taskId: `sd-draft-${label.toLowerCase()}`,
    prompt,
    schedule_type: 'once',
    schedule_value: localStamp(nowMs + 2 * 60_000),
    context_mode: 'isolated',
    targetJid: committee.channelJid,
    timestamp: new Date(nowMs).toISOString(),
  };
}

/** Atomic write: IPC watchers only pick up `*.json`, so write `.tmp` first. */
function writeIpcFile(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  const name = `sd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const tmp = path.join(dir, `${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, path.join(dir, name));
}

function atomicWrite(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/**
 * One scheduler tick: read config + state from the KB, decide actions, emit
 * IPC files, persist state. Exported (with injectable paths/clock) so tests
 * can drive it against a temp profile dir. Returns the plan, or null when
 * the flow is unconfigured / out of window.
 */
export function tick({ profileDir, logger, nowMs }) {
  let sharedKb = 'slack_main';
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(profileDir, 'profile.config.json'), 'utf-8'),
    );
    if (typeof cfg.sharedKbGroup === 'string' && cfg.sharedKbGroup) {
      sharedKb = cfg.sharedKbGroup;
    }
  } catch {
    /* fall through to default */
  }

  const ctxDir = path.join(profileDir, 'groups', sharedKb, 'context');
  const committeePath = path.join(ctxDir, 'sd', 'committee.md');
  if (!fs.existsSync(committeePath)) return null; // not configured → no-op

  const committee = parseCommittee(fs.readFileSync(committeePath, 'utf-8'));
  if (committee.members.length === 0 || !committee.channelJid) {
    logger.warn(
      { committeePath },
      'sd-kickoff: committee.md needs `members` and `channel_jid` frontmatter',
    );
    return null;
  }

  const { label, quarterEndMs, windowStartMs } = quarterWindow(
    nowMs,
    committee.kickoffWeeksBefore,
  );
  if (nowMs < windowStartMs || nowMs >= quarterEndMs) return null;

  const statePath = path.join(ctxDir, 'sd', 'state', `${label}.json`);
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch {
    /* fresh quarter */
  }

  const inputsDir = path.join(ctxDir, 'sd', 'inputs', label);
  const inputs = new Set(
    fs.existsSync(inputsDir)
      ? fs
          .readdirSync(inputsDir)
          .filter((f) => f.endsWith('.md'))
          .map((f) => f.replace(/\.md$/, ''))
      : [],
  );

  const plan = planActions({
    nowMs,
    cfg: {
      label,
      quarterEndMs,
      nudgeEveryDays: committee.nudgeEveryDays,
      maxNudges: committee.maxNudges,
      draftDaysBeforeEnd: committee.draftDaysBeforeEnd,
    },
    members: committee.members,
    state,
    inputs,
  });

  // Same-group IPC namespace: the shared-KB group's own dirs, so the
  // orchestrator authorizes `message`/`schedule_task` as same-group ops.
  const ipcDir = path.join(profileDir, 'data', 'ipc', sharedKb);
  for (const dm of plan.dms) {
    writeIpcFile(path.join(ipcDir, 'tasks'), {
      type: 'dm_user',
      target: dm.slug,
      text: dm.text,
      sourceJid: committee.channelJid,
      timestamp: new Date(nowMs).toISOString(),
    });
  }
  for (const text of plan.posts) {
    writeIpcFile(path.join(ipcDir, 'messages'), {
      type: 'message',
      chatJid: committee.channelJid,
      text,
      timestamp: new Date(nowMs).toISOString(),
    });
  }
  if (plan.requestDraft) {
    writeIpcFile(
      path.join(ipcDir, 'tasks'),
      draftTaskIpc({ label, committee, inputs, nowMs }),
    );
  }

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  atomicWrite(statePath, JSON.stringify(plan.state, null, 2));

  if (plan.dms.length || plan.posts.length || plan.requestDraft) {
    logger.info(
      {
        label,
        dms: plan.dms.length,
        posts: plan.posts.length,
        draftRequested: plan.requestDraft,
      },
      'sd-kickoff: actions emitted',
    );
  }
  return plan;
}

export default function register({ registerIntegration, logger }) {
  let timer = null;
  registerIntegration({
    name: 'sd-kickoff',
    start: () => {
      // Plugin file lives at <profile>/plugins/sd-kickoff.mjs.
      const profileDir = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
      );
      const tickMs = Number(process.env.SD_KICKOFF_TICK_MS) || 6 * 3600_000;
      const run = () => {
        try {
          tick({ profileDir, logger, nowMs: Date.now() });
        } catch (err) {
          logger.error({ err }, 'sd-kickoff: tick failed');
        }
      };
      // First tick shortly after startup (lets channels/IPC watcher settle),
      // then on the regular cadence. Timers are unref'd so this flow never
      // keeps a shutting-down process alive.
      const first = setTimeout(run, 60_000);
      first.unref?.();
      timer = setInterval(run, tickMs);
      timer.unref?.();
      logger.info({ tickMs }, 'sd-kickoff flow started');
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  });
}
