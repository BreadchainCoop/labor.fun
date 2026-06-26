// weekly-agenda.mjs — Weekly Core Meeting agenda automation, as a profile
// plugin. Drives the weekly-meeting prep so the facilitator doesn't have to
// chase everyone by hand:
//
//   * Each week, `prep_days_before` the meeting, fires a ONE-SHOT agent task
//     that (re)builds the agenda's "This Week" tab into a DECISION-READY draft:
//     it first archives the previous week's contents into the doc's permanent
//     Archive tab, then writes a fresh dated agenda pre-filled with the week's
//     facilitator (from the rota) and rich auto-pulled context — each owner's
//     merged PRs / closed issues from the last 7 days as clickable links with a
//     one-line summary, upcoming deadlines (from the KB deadline digest), and a
//     Goals Review read against the quarter's strategic directives. It then
//     posts the agenda link in the core channel — only after a build is
//     verified (see the `built` marker below).
//   * DMs every project owner (and the facilitator) asking them to fill in
//     their section, and re-nudges on a cadence until they do — silence is not
//     consent. After max_nudges unanswered DMs it escalates once in the core
//     channel and stops DMing that person.
//   * An owner has "responded" when an input file exists at
//     `context/weekly-agenda/inputs/<week>/<slug>.md`. The companion
//     `weekly-agenda` container skill makes the assistant write that file (and
//     drop the update into the doc) when the owner replies in DM; a human can
//     also write it by hand.
//
// Why a persistent "This Week" tab instead of a brand-new tab per week: the
// Google Docs API can read tabs and WRITE INTO existing ones, but cannot
// CREATE a tab programmatically (open feature request, unshipped). So the bot
// owns two permanent tabs — "This Week" (rewritten each cycle) and "Archive"
// (appended to) — and never needs to create one.
//
// Architecture mirrors sd-kickoff.mjs exactly: the plugin needs no secrets and
// imports nothing from the framework. It acts purely through the two
// filesystem contracts every install already exposes:
//   * the shared KB  (flow config, per-week state, collected inputs)
//   * the IPC dirs   (`dm_user`, `message`, `schedule_task` ops — written into
//                     the shared-KB group's own namespace, so same-group
//                     authorization applies)
//
// Configuration lives in the KB so ops can edit it from the dashboard:
// `groups/<sharedKbGroup>/context/weekly-agenda/config.md` (see
// context/weekly-agenda/README.md). Without that file the flow is a no-op.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import matter from 'gray-matter';

const DAY_MS = 86_400_000;
/** Re-request the build this often until the agent confirms it (writes the
 * `built` marker) — so a failed/incomplete build self-heals instead of
 * stalling the week with no agenda. */
const BUILD_RETRY_MS = 30 * 60_000;

/** Local YYYY-MM-DD for a timestamp (the per-week key + the human date). */
export function isoDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The meeting window this flow operates in. Meetings recur weekly on
 * `meetingDay` (0=Sun..6=Sat) at `meetingHour` local time. Returns the NEXT
 * upcoming meeting and the prep window that opens `prepDaysBefore` days before
 * it. `weekKey` (the meeting's local date) namespaces state + inputs.
 */
export function meetingWindow(nowMs, meetingDay = 3, meetingHour = 16, prepDaysBefore = 2) {
  const d = new Date(nowMs);
  const cand = new Date(d.getFullYear(), d.getMonth(), d.getDate(), meetingHour, 0, 0);
  let add = (meetingDay - cand.getDay() + 7) % 7;
  // Meeting day but already past meeting time → target next week's meeting.
  if (add === 0 && nowMs >= cand.getTime()) add = 7;
  cand.setDate(cand.getDate() + add);
  const meetingMs = cand.getTime();
  const windowStartMs = meetingMs - prepDaysBefore * DAY_MS;
  return { weekKey: isoDate(meetingMs), meetingMs, windowStartMs };
}

/**
 * Normalize a facilitator map key to `YYYY-MM-DD`. YAML parses an UNQUOTED
 * `2026-06-10` key as a timestamp, so js-yaml hands us a Date-stringified key
 * (e.g. "Wed Jun 10 2026 00:00:00 GMT+0000…") — reformat those back from their
 * UTC parts (js-yaml reads bare timestamps as UTC midnight). Already-quoted
 * `'2026-06-10'` keys arrive as plain strings and pass straight through.
 */
function normalizeDateKey(k) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(k)) return k;
  const d = new Date(k);
  if (!Number.isNaN(d.getTime())) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  }
  return k;
}

/** Parse context/weekly-agenda/config.md (frontmatter-driven; body free text). */
export function parseConfig(mdText) {
  const fm = matter(mdText).data ?? {};
  // owners: project label -> KB people slug. Accepts a YAML map.
  const owners =
    fm.owners && typeof fm.owners === 'object' && !Array.isArray(fm.owners)
      ? Object.fromEntries(
          Object.entries(fm.owners)
            .filter(([k, v]) => typeof v === 'string' && v.trim() && String(k).trim())
            .map(([k, v]) => [String(k), String(v)]),
        )
      : {};
  // facilitators: meeting-date (YYYY-MM-DD) -> KB people slug.
  const facilitators =
    fm.facilitators && typeof fm.facilitators === 'object' && !Array.isArray(fm.facilitators)
      ? Object.fromEntries(
          Object.entries(fm.facilitators)
            .filter(([, v]) => typeof v === 'string' && v.trim())
            .map(([k, v]) => [normalizeDateKey(String(k)), String(v)]),
        )
      : {};
  return {
    channelJid: typeof fm.channel_jid === 'string' ? fm.channel_jid : '',
    docId: typeof fm.doc_id === 'string' ? fm.doc_id : '',
    thisWeekTabId: typeof fm.this_week_tab_id === 'string' ? fm.this_week_tab_id : '',
    archiveTabId: typeof fm.archive_tab_id === 'string' ? fm.archive_tab_id : '',
    meetingDay: Number.isInteger(fm.meeting_day) ? fm.meeting_day : 3, // Wed
    meetingHour: Number.isInteger(fm.meeting_hour) ? fm.meeting_hour : 16,
    prepDaysBefore: Number(fm.prep_days_before) || 2,
    nudgeEveryDays: Number(fm.nudge_every_days) || 1,
    maxNudges: Number(fm.max_nudges) || 3,
    owners,
    facilitators,
    // Optional context sources the build agent weaves into the agenda (all
    // org-agnostic — paths are KB-relative, org is the GitHub org to mine).
    // Strategic directives doc → drives the "Goals Review" section.
    directivesDoc: typeof fm.directives_doc === 'string' ? fm.directives_doc.trim() : '',
    // Auto-maintained deadline digest → drives the "Upcoming Deadlines" section.
    deadlineDigest:
      typeof fm.deadline_digest === 'string' && fm.deadline_digest.trim()
        ? fm.deadline_digest.trim()
        : 'deadline-digest.md',
    // GitHub org to mine for each owner's recent merged PRs / closed issues
    // (else the build agent falls back to its profile's configured org).
    githubOrg: typeof fm.github_org === 'string' ? fm.github_org.trim() : '',
  };
}

/** slug -> [project labels they own], so one DM can name all their sections. */
export function assignmentsBySlug(owners) {
  const out = {};
  for (const [project, slug] of Object.entries(owners)) {
    (out[slug] ??= []).push(project);
  }
  return out;
}

/** Render a member for a CHANNEL post: their Discord mention when resolved. */
function mentionFor(slug, mentions) {
  const id = mentions?.[slug];
  return id ? `<@${id}> (${slug})` : slug;
}

/**
 * Map slugs → discord_id from each `people/<slug>.md` frontmatter, so channel
 * posts actually ping people (a plain name doesn't notify on Discord).
 */
export function resolveDiscordIds(ctxDir, slugs) {
  const out = {};
  for (const slug of slugs) {
    try {
      const fm = matter(
        fs.readFileSync(path.join(ctxDir, 'people', `${slug}.md`), 'utf-8'),
      ).data;
      if (fm?.discord_id) out[slug] = String(fm.discord_id);
    } catch {
      // No people file / unreadable — leave unmapped, render the slug.
    }
  }
  return out;
}

function kickoffPost(weekKey, facilitator, slugs, mentions, docUrl) {
  const who = slugs.map((s) => mentionFor(s, mentions)).join(', ');
  const fac = facilitator ? mentionFor(facilitator, mentions) : 'TBD';
  const link = docUrl ? ` ${docUrl}` : '';
  return (
    `🗓️ Weekly Core Meeting agenda for ${weekKey} is up.${link}\n` +
    `Facilitator: ${fac}. I've pre-filled it with each project's merged PRs/closed issues (linked), ` +
    `upcoming deadlines, and a goals-review read against the Q directives — ` +
    `owners (${who}), please add your project updates before the meeting. ` +
    `I'll DM each of you and check back until your section is in (silence isn't consent 🙂).`
  );
}

function escalationPost(slug, asks, weekKey, mentions) {
  // Recovery-oriented, not a call-out: the most common cause of an "unfilled"
  // section is an update that was sent but never filed (see the file-an-update
  // routine). Offer the self-heal path and stop nudging — never frame it as the
  // person being behind. (Aligns with the shared-mirror voice rule.)
  const who = mentionFor(slug, mentions);
  return (
    `📝 I don't have ${who}'s agenda section for ${weekKey} yet, and I've stopped DMing them. ` +
    `If you already shared an update and it isn't in the doc, it may not have been filed — ` +
    `${who}, just reply "file my agenda update" (restating it) and I'll capture it. No rush.`
  );
}

function askText(weekKey, projects, askNumber, docUrl) {
  const sections = projects.length ? ` (${projects.join(', ')})` : '';
  const link = docUrl ? ` ${docUrl}` : '';
  if (askNumber === 1) {
    return (
      `Hi! Weekly Core Meeting on ${weekKey} — time to fill in your agenda section${sections}. ` +
      `Reply here with your update(s) and I'll drop them into the agenda doc${link}. ` +
      `A few bullets is plenty. I'll check back until I hear from you (silence isn't consent 🙂).`
    );
  }
  return (
    `Reminder ${askNumber - 1} — still need your agenda update${sections} for ${weekKey}. ` +
    `Reply here and I'll file it into the doc. ` +
    `(Already replied but it wasn't filed? Say "file my agenda update" and restate it.)`
  );
}

/**
 * Decide this tick's actions from current state. Pure — no I/O, no clock — so
 * the build/nudge ladder is unit-testable. Returns the actions plus the next
 * state (never mutates the input state).
 */
export function planActions({ nowMs, cfg, slugs, assignments, facilitator, state, filled, built, mentions, docUrl }) {
  const out = { dms: [], posts: [], requestBuild: false };
  const st = {
    ...state,
    members: Object.fromEntries(
      Object.entries(state.members ?? {}).map(([k, v]) => [k, { ...v }]),
    ),
  };

  // Phase 1 — get the doc built FIRST. (Re)request the build task until the
  // agent confirms it actually wrote + verified the skeleton (the `built`
  // marker). We announce and nudge NOTHING here, so the channel/owners are
  // never told the agenda is ready before it is. Re-kick on a retry cadence so
  // a failed build self-heals rather than stalling the week.
  if (!built) {
    const last = st.buildKickedAt ? Date.parse(st.buildKickedAt) : 0;
    if (nowMs - last >= BUILD_RETRY_MS) {
      st.buildKickedAt = new Date(nowMs).toISOString();
      out.requestBuild = true;
    }
    return { ...out, state: st };
  }

  // Phase 2 — build verified. Announce once (now the "pre-filled" claim is
  // true), then run the owner nudge ladder.
  if (!st.announcedAt) {
    st.announcedAt = new Date(nowMs).toISOString();
    out.posts.push(kickoffPost(cfg.weekKey, facilitator, slugs, mentions, docUrl));
  }

  const nudgeMs = cfg.nudgeEveryDays * DAY_MS;
  for (const slug of slugs) {
    if (filled.has(slug)) continue;
    const m = st.members[slug] ?? { asks: 0, lastAskAt: null, escalated: false };
    const due = !m.lastAskAt || nowMs - Date.parse(m.lastAskAt) >= nudgeMs;
    if (due) {
      if (m.asks >= cfg.maxNudges) {
        if (!m.escalated) {
          m.escalated = true;
          out.posts.push(escalationPost(slug, m.asks, cfg.weekKey, mentions));
        }
      } else {
        m.asks += 1;
        m.lastAskAt = new Date(nowMs).toISOString();
        out.dms.push({ slug, text: askText(cfg.weekKey, assignments[slug] ?? [], m.asks, docUrl) });
      }
    }
    st.members[slug] = m;
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

function buildTaskIpc({ cfg, weekKey, facilitator, nowMs }) {
  const facLine = facilitator
    ? `This week's facilitator is "${facilitator}".`
    : `No facilitator is set for ${weekKey} in the config — write "Facilitator: TBD — claim it" and ask the team to claim it.`;
  const orgLine = cfg.githubOrg
    ? `the "${cfg.githubOrg}" GitHub org`
    : `your profile's configured GitHub org`;
  const directivesLine = cfg.directivesDoc
    ? `the strategic directives at \`${cfg.directivesDoc}\` (the quarter's numbered priorities + success metrics)`
    : `the quarter's strategic directives if you can find them in the KB (artifacts/, look for "strategy"/"directives")`;
  const prompt =
    `Weekly Core Meeting agenda build for ${weekKey}. Use the weekly-agenda skill (Build section).\n\n` +
    `You are producing a DECISION-READY agenda, not a bare skeleton. Make it genuinely useful: ` +
    `every recent piece of work shown with a clickable link and a one-line "what it did", deadlines surfaced, ` +
    `and progress read against the quarter's strategic goals. Read these KB sources FIRST and weave them in:\n` +
    `  • ${directivesLine}.\n` +
    `  • the deadline digest at \`${cfg.deadlineDigest}\` (auto-maintained; bucketed Overdue / This week / Next week).\n` +
    `  • each owner's \`people/<slug>.md\` for their \`github_username\` (use it to attribute GitHub activity).\n\n` +
    `STEPS:\n` +
    `1. In Google Doc ${cfg.docId}, FIRST archive the current contents of the "This Week" tab ` +
    `(tabId ${cfg.thisWeekTabId}) by appending them, under a "### ${weekKey}" heading, to the TOP of ` +
    `the Archive tab (tabId ${cfg.archiveTabId}). Never create a new tab — write only into these two existing tabs.\n` +
    `2. Replace the "This Week" tab with a fresh agenda dated ${weekKey}. ${facLine} Use these sections IN ORDER, ` +
    `and match the doc's existing formatting — real heading styles, real bulleted lists (not "- " text), bold ` +
    `labels, and REAL hyperlinks (link the title text to the URL; never paste raw URLs):\n` +
    `   🏁 Check In · ✍️ Revise Agenda\n` +
    `   📣 This Week in Brief — 2–3 sentences YOU write from the data below: what moved, what's stuck, and where the ` +
    `work needs hands. Frame it as the collective's shared picture (what the WORK needs), not a roll-call of who did ` +
    `what. Sign it with the facilitator's name — a rotating weave of the week, not a manager's report.\n` +
    `   🎯 Goals Review — one sub-bullet PER numbered strategic priority from the directives doc; for each, name the ` +
    `priority and give a plain one-line read on where the WORK stands vs its success metrics this week ` +
    `(on track / needs hands / blocked?), citing the shipped work below. This is a status read on the GOAL — never a ` +
    `verdict on a person: don't single anyone out, don't imply who is "behind".\n` +
    `   📅 Upcoming Deadlines — from the deadline digest, list items due THIS WEEK and NEXT WEEK that are still OPEN ` +
    `(skip ones marked ✅ done). Group any past-due-and-still-open items at the top under "Past due — worth a check-in" ` +
    `(a prompt to see what the task needs, not a callout on whoever holds it). Each line: the item as a hyperlink ` +
    `(to the GitHub issue/PR where it is one), its date, and the owner.\n` +
    `   🧑‍🏭 Contributor Pipeline · ‼️ Urgent Topics\n` +
    `   🌱 Active Projects — a collective "shipped this week" changelog, ONE bold sub-heading per project, ` +
    `"• <Project> — <owner name>". Under each, list that owner's MERGED PRs and CLOSED issues from the LAST 7 DAYS, ` +
    `pulled from ${orgLine} by their github_username — each a hyperlink on "title (#num)" + a 4–8 word plain summary. ` +
    `Treat this as a DRAFT the owner edits/expands/corrects, not a final word. Merged PRs are an engineering-only, ` +
    `PARTIAL proxy: design, BD, community, care and organizing work rarely show up as a PR, so absence of PRs is NOT ` +
    `absence of contribution. If an owner had no merged/closed activity, do NOT write a "did nothing" line — write an ` +
    `open invitation instead: "— space for <name>'s update —". Under every owner leave one blank "• " bullet as room ` +
    `for them to add work GitHub can't see. Attribute work to the project whose repo it lives in; if ambiguous, list ` +
    `under their primary one.\n` +
    `   🎉 Appreciations (3 MINIMUM) · 💰 Other topics / Upcoming Time Off\n` +
    `   Also fold any upcoming calendar events (next 7 days) into the relevant section if a calendar is configured.\n` +
    `3. QUALITY BAR: terse but informative — one line per bullet, every PR/issue/deadline is a clickable link, ` +
    `project and priority labels are bold. It should read like a polished agenda a facilitator can run the meeting ` +
    `from, not a raw dump. Owners still flesh out their own narrative — you give them the scaffolding + the facts.\n` +
    `4. VERIFY: re-read the "This Week" tab and confirm the real content landed (dated header, the Goals Review ` +
    `bullets, the Upcoming Deadlines list, and the per-project activity — not just empty section headers). ONLY if ` +
    `it did, mark the build done by writing the marker file weekly-agenda/built/${weekKey}.md via modify_kb_file ` +
    `(a one-line note is fine). Do NOT post anything to the channel on success — the flow announces it once the ` +
    `marker exists.\n` +
    `5. If the doc write or verification FAILED (e.g. tab not found, no Docs access), do NOT write the marker — ` +
    `instead post a short message in this channel saying the agenda build failed and why, so a human can fix it.\n\n` +
    `Tone: a shared mirror, not a scoreboard. You're a peer tool inside a cooperative, not a manager over it — point ` +
    `the agenda at the WORK and what it needs, never at ranking people. Helpful and crisp; a rich starting point the ` +
    `team fills in.`;
  return {
    type: 'schedule_task',
    taskId: `weekly-agenda-build-${weekKey}-${nowMs}`,
    prompt,
    schedule_type: 'once',
    schedule_value: localStamp(nowMs + 2 * 60_000),
    context_mode: 'isolated',
    targetJid: cfg.channelJid,
    timestamp: new Date(nowMs).toISOString(),
  };
}

/** Atomic write: IPC watchers only pick up `*.json`, so write `.tmp` first. */
function writeIpcFile(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  const name = `wa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
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
 * IPC files, persist state. Exported (with injectable paths/clock) so tests can
 * drive it against a temp profile dir. Returns the plan, or null when the flow
 * is unconfigured / out of the prep window.
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
  const configPath = path.join(ctxDir, 'weekly-agenda', 'config.md');
  if (!fs.existsSync(configPath)) return null; // not configured → no-op

  const cfg = parseConfig(fs.readFileSync(configPath, 'utf-8'));
  if (!cfg.channelJid || Object.keys(cfg.owners).length === 0) {
    logger.warn(
      { configPath },
      'weekly-agenda: config.md needs `channel_jid` and an `owners` map',
    );
    return null;
  }

  const { weekKey, meetingMs, windowStartMs } = meetingWindow(
    nowMs,
    cfg.meetingDay,
    cfg.meetingHour,
    cfg.prepDaysBefore,
  );
  if (nowMs < windowStartMs || nowMs >= meetingMs) return null; // outside prep window

  const assignments = assignmentsBySlug(cfg.owners);
  const slugs = Object.keys(assignments);
  const facilitator = cfg.facilitators[weekKey] || '';

  const statePath = path.join(ctxDir, 'weekly-agenda', 'state', `${weekKey}.json`);
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch {
    /* fresh week */
  }

  const inputsDir = path.join(ctxDir, 'weekly-agenda', 'inputs', weekKey);
  const filled = new Set(
    fs.existsSync(inputsDir)
      ? fs.readdirSync(inputsDir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))
      : [],
  );

  // The build agent writes this marker only AFTER it has written the skeleton
  // and re-read the tab to confirm it landed. Its existence is what unlocks the
  // announce + nudges (so we never announce an unbuilt doc).
  const built = fs.existsSync(
    path.join(ctxDir, 'weekly-agenda', 'built', `${weekKey}.md`),
  );

  const mentions = resolveDiscordIds(ctxDir, [...slugs, facilitator].filter(Boolean));
  const docUrl = cfg.docId ? `https://docs.google.com/document/d/${cfg.docId}/edit` : '';

  const plan = planActions({
    nowMs,
    cfg: { weekKey, ...cfg },
    slugs,
    assignments,
    facilitator,
    state,
    filled,
    built,
    mentions,
    docUrl,
  });

  // Same-group IPC namespace: the shared-KB group's own dirs, so the
  // orchestrator authorizes `dm_user`/`message`/`schedule_task` as same-group.
  const ipcDir = path.join(profileDir, 'data', 'ipc', sharedKb);
  if (plan.requestBuild) {
    writeIpcFile(
      path.join(ipcDir, 'tasks'),
      buildTaskIpc({ cfg: { weekKey, ...cfg }, weekKey, facilitator, nowMs }),
    );
  }
  for (const dm of plan.dms) {
    writeIpcFile(path.join(ipcDir, 'tasks'), {
      type: 'dm_user',
      target: dm.slug,
      text: dm.text,
      sourceJid: cfg.channelJid,
      timestamp: new Date(nowMs).toISOString(),
    });
  }
  for (const text of plan.posts) {
    writeIpcFile(path.join(ipcDir, 'messages'), {
      type: 'message',
      chatJid: cfg.channelJid,
      text,
      timestamp: new Date(nowMs).toISOString(),
    });
  }

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  atomicWrite(statePath, JSON.stringify(plan.state, null, 2));

  if (plan.dms.length || plan.posts.length || plan.requestBuild) {
    logger.info(
      {
        weekKey,
        dms: plan.dms.length,
        posts: plan.posts.length,
        buildRequested: plan.requestBuild,
      },
      'weekly-agenda: actions emitted',
    );
  }
  return plan;
}

export default function register({ registerIntegration, logger }) {
  let timer = null;
  registerIntegration({
    name: 'weekly-agenda',
    start: () => {
      // Plugin file lives at <profile>/plugins/weekly-agenda.mjs.
      const profileDir = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
      );
      const tickMs = Number(process.env.WEEKLY_AGENDA_TICK_MS) || 6 * 3600_000;
      const run = () => {
        try {
          tick({ profileDir, logger, nowMs: Date.now() });
        } catch (err) {
          logger.error({ err }, 'weekly-agenda: tick failed');
        }
      };
      // First tick shortly after startup (lets channels/IPC watcher settle),
      // then on the regular cadence. Timers are unref'd so this flow never
      // keeps a shutting-down process alive.
      const first = setTimeout(run, 60_000);
      first.unref?.();
      timer = setInterval(run, tickMs);
      timer.unref?.();
      logger.info({ tickMs }, 'weekly-agenda flow started');
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  });
}
