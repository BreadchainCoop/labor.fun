// admin-email.mjs — Administrative email → auto-issues (issue #33), as a
// profile plugin. Admin mail (grant forms, legal, partnerships) lands in one
// person's inbox and gets lost. The fix: the org sets a single auto-forward
// rule on the admin address → the assistant's Gmail, and the assistant triages
// everything that arrives.
//
// The triage itself is agent work (read Gmail, classify, open a GitHub issue,
// notify the owner) — it needs the `gws` gmail tool and the GitHub MCP, which
// live in the container, not here. So this plugin's only job is to keep a
// single recurring triage task scheduled to match the KB config: it emits a
// `schedule_task` IPC when enabled, a `cancel_task` when disabled, and
// re-schedules when the cadence / repo / channel changes. Idempotency of the
// EMAILS (no duplicate issues) is the skill's job, via a Gmail `triaged` label.
//
// Architecture mirrors the other example plugins: no secrets, no framework
// imports; acts only through the shared KB (config + a small state file) and
// the IPC dir (`schedule_task` / `cancel_task` in the shared-KB group's
// namespace, so same-group authorization applies). Config lives in
// `groups/<sharedKbGroup>/context/admin-email/config.md`; without it (or with
// `enabled: false`) the flow is off and any prior task is cancelled.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import matter from 'gray-matter';

/** Parse context/admin-email/config.md (frontmatter config; body is notes). */
export function parseConfig(mdText) {
  const fm = matter(mdText).data ?? {};
  return {
    // Presence of the file means "on" unless explicitly disabled.
    enabled: fm.enabled !== false,
    triageCron:
      typeof fm.triage_cron === 'string' && fm.triage_cron.trim()
        ? fm.triage_cron.trim()
        : '0 */2 * * *', // every 2 hours
    githubRepo: typeof fm.github_repo === 'string' ? fm.github_repo.trim() : '',
    notifyChannelJid:
      typeof fm.notify_channel_jid === 'string'
        ? fm.notify_channel_jid.trim()
        : '',
  };
}

/** The recurring task's prompt — carries config into the agent run so the
 * triage knows which repo to file in and where to summarize. */
export function triagePrompt(cfg) {
  const repoLine = cfg.githubRepo
    ? `Create issues in the **${cfg.githubRepo}** GitHub repo.`
    : `Create issues in the org's default issues repo.`;
  return (
    `Administrative email triage — use the admin-email skill.\n\n` +
    `Process new forwarded admin emails in your Gmail inbox (the gws gmail tool): ` +
    `for each, unwrap the forwarded message, classify it, and for anything ` +
    `actionable (grant action, legal, partnership, finance, etc.) open a GitHub ` +
    `issue with a clear summary, the original sender, any deadline, category ` +
    `labels, and a suggested owner — then DM that owner. ${repoLine} ` +
    `Mark each email triaged (apply the Gmail \`triaged\` label) so it is never ` +
    `processed twice; skip anything already labelled \`triaged\`. ` +
    `Post a one-line summary of what you filed to this channel, or stay silent ` +
    `(wrap output in <internal>) if there was nothing new.`
  );
}

/**
 * Decide what to do given the parsed config (or null when absent) and the
 * current state. Pure — no I/O — so the schedule/cancel/reschedule logic is
 * testable. Returns `{ schedule?, cancel?, nextState, warn? }`.
 *
 * - off (no config / enabled:false): cancel any scheduled task, clear state.
 * - on, nothing scheduled: schedule a fresh recurring task.
 * - on, already scheduled: no-op, unless the cadence/repo/channel changed —
 *   then cancel the old task and schedule a new one (new id avoids an INSERT
 *   conflict on the same primary key).
 */
export function planSync({ config, state, nowMs }) {
  const scheduledId = state?.taskId || null;

  if (!config || !config.enabled) {
    return scheduledId
      ? { cancel: scheduledId, nextState: {} }
      : { nextState: state ?? {} };
  }
  if (!config.notifyChannelJid) {
    return {
      nextState: state ?? {},
      warn: 'admin-email: config needs `notify_channel_jid`',
    };
  }

  const desired = {
    cron: config.triageCron,
    repo: config.githubRepo,
    channel: config.notifyChannelJid,
  };
  const unchanged =
    scheduledId &&
    state.cron === desired.cron &&
    state.repo === desired.repo &&
    state.channel === desired.channel;
  if (unchanged) return { nextState: state };

  const taskId = `admin-email-triage-${nowMs}`;
  const schedule = {
    taskId,
    cron: desired.cron,
    prompt: triagePrompt(config),
    targetJid: desired.channel,
  };
  const next = { taskId, ...desired };
  // Re-schedule: cancel the stale task first (new id sidesteps PK conflicts).
  return scheduledId
    ? { cancel: scheduledId, schedule, nextState: next }
    : { schedule, nextState: next };
}

/** Atomic write: IPC watchers only pick up `*.json`, so write `.tmp` first. */
function writeIpcFile(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  const name = `ae-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
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
 * One reconcile pass: read config + state from the KB, decide, emit IPC,
 * persist state. Exported (injectable paths/clock) for tests. Returns the plan
 * (or a no-op plan). Unlike the review flows there's no window — it just keeps
 * the recurring task in sync with config.
 */
export function tick({ profileDir, logger, nowMs }) {
  let sharedKb = 'slack_main';
  try {
    const pc = JSON.parse(
      fs.readFileSync(path.join(profileDir, 'profile.config.json'), 'utf-8'),
    );
    if (typeof pc.sharedKbGroup === 'string' && pc.sharedKbGroup) {
      sharedKb = pc.sharedKbGroup;
    }
  } catch {
    /* default */
  }

  const ctxDir = path.join(profileDir, 'groups', sharedKb, 'context');
  const configPath = path.join(ctxDir, 'admin-email', 'config.md');
  const statePath = path.join(ctxDir, 'admin-email', 'state.json');

  const config = fs.existsSync(configPath)
    ? parseConfig(fs.readFileSync(configPath, 'utf-8'))
    : null;

  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch {
    /* none yet */
  }

  // Nothing configured and nothing scheduled — fully dormant, touch nothing.
  if (!config && !state.taskId) return { nextState: state };

  const plan = planSync({ config, state, nowMs });
  if (plan.warn) logger.warn({}, plan.warn);

  const ipcDir = path.join(profileDir, 'data', 'ipc', sharedKb, 'tasks');
  if (plan.cancel) {
    writeIpcFile(ipcDir, {
      type: 'cancel_task',
      taskId: plan.cancel,
      timestamp: new Date(nowMs).toISOString(),
    });
  }
  if (plan.schedule) {
    writeIpcFile(ipcDir, {
      type: 'schedule_task',
      taskId: plan.schedule.taskId,
      prompt: plan.schedule.prompt,
      schedule_type: 'cron',
      schedule_value: plan.schedule.cron,
      context_mode: 'isolated',
      targetJid: plan.schedule.targetJid,
      timestamp: new Date(nowMs).toISOString(),
    });
  }

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  atomicWrite(statePath, JSON.stringify(plan.nextState ?? {}, null, 2));

  if (plan.cancel || plan.schedule) {
    logger.info(
      { scheduled: !!plan.schedule, cancelled: !!plan.cancel },
      'admin-email: triage schedule reconciled',
    );
  }
  return plan;
}

export default function register({ registerIntegration, logger }) {
  let timer = null;
  registerIntegration({
    name: 'admin-email',
    start: () => {
      const profileDir = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
      );
      // Reconcile on a slow cadence — it only syncs the schedule to config,
      // the triage itself runs on its own cron task.
      const tickMs = Number(process.env.ADMIN_EMAIL_TICK_MS) || 6 * 3600_000;
      const run = () => {
        try {
          tick({ profileDir, logger, nowMs: Date.now() });
        } catch (err) {
          logger.error({ err }, 'admin-email: tick failed');
        }
      };
      const first = setTimeout(run, 90_000);
      first.unref?.();
      timer = setInterval(run, tickMs);
      timer.unref?.();
      logger.info({ tickMs }, 'admin-email flow started');
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  });
}
