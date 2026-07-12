// admin-email.mjs — Administrative email → auto-issues, as a first-party
// CATALOG plugin (M2 of per-tenant plugins). Admin mail (grant forms, legal,
// partnerships) lands in one person's inbox and gets lost. The fix: the org sets
// a single auto-forward rule on the admin address → the assistant's Gmail, and
// the assistant triages everything that arrives.
//
// The triage itself is agent work (read Gmail, classify, open a GitHub issue,
// notify the owner) — it needs the `gws` gmail tool and the GitHub MCP, which
// live in the container, not here. So this plugin's only job is to keep a single
// recurring triage task scheduled to match the config: it emits a
// `schedule_task` IPC when enabled, a `cancel_task` when disabled, and
// re-schedules when the cadence / repo / channel changes. Idempotency of the
// EMAILS (no duplicate issues) is the skill's job, via a Gmail `triaged` label.
//
// PORTED FROM profiles/example/plugins/admin-email.mjs, made org-agnostic:
//   * The triage TARGETS (cron cadence, GitHub repo, notify channel) still live
//     in the KB config file so ops can edit them from the dashboard —
//     groups/<sharedKbGroup>/context/admin-email/config.md.
//   * The PLUGIN-LEVEL knobs that were hardcoded / env-driven in the example are
//     now CONFIG (second arg to register): tick cadence, first-tick delay, which
//     shared-KB group to watch, and DEFAULTS for triage_cron / github_repo /
//     notify_channel_jid that apply when the KB config.md omits them. KB values
//     always win over these config defaults. An org can also run entirely from
//     config by setting notifyChannelJid there and dropping a bare (or absent)
//     config.md that just marks the flow enabled.
//   * profileDir comes from the PluginApi (catalog plugins live outside the
//     profile, so they cannot derive it from import.meta.url).
//
// See container/catalog-plugins/README.md for the full config-key table.

import fs from 'fs';
import path from 'path';

import matter from 'gray-matter';

const HOUR_MS = 3_600_000;

/** Manifest: stable id (matched against ENABLED_PLUGINS) + kind. */
export const id = 'admin-email';
export const kind = 'integration';

/**
 * Normalize the plugin CONFIG (register's 2nd arg) into a fully-defaulted shape.
 * Exported for tests.
 */
export function resolvePluginConfig(config = {}) {
  const c = config && typeof config === 'object' ? config : {};
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    tickMs: num(c.tickMs, 6 * HOUR_MS),
    firstTickDelayMs: num(c.firstTickDelayMs, 90_000),
    sharedKbGroup: typeof c.sharedKbGroup === 'string' ? c.sharedKbGroup.trim() : '',
    // DEFAULTS applied only when the KB config.md omits the corresponding key.
    defaults: {
      triageCron:
        typeof c.triageCron === 'string' && c.triageCron.trim()
          ? c.triageCron.trim()
          : '0 */2 * * *', // every 2 hours
      githubRepo: typeof c.githubRepo === 'string' ? c.githubRepo.trim() : '',
      notifyChannelJid:
        typeof c.notifyChannelJid === 'string' ? c.notifyChannelJid.trim() : '',
    },
  };
}

/**
 * Parse context/admin-email/config.md (frontmatter config; body is notes).
 * `defaults` (from plugin CONFIG) fill any key the file omits, so an org can set
 * org-wide defaults in config and only override in the KB. KB values win.
 */
export function parseConfig(mdText, defaults = {}) {
  const d = {
    triageCron: '0 */2 * * *',
    githubRepo: '',
    notifyChannelJid: '',
    ...defaults,
  };
  const fm = matter(mdText).data ?? {};
  return {
    // Presence of the file means "on" unless explicitly disabled.
    enabled: fm.enabled !== false,
    triageCron:
      typeof fm.triage_cron === 'string' && fm.triage_cron.trim()
        ? fm.triage_cron.trim()
        : d.triageCron,
    githubRepo: typeof fm.github_repo === 'string' ? fm.github_repo.trim() : d.githubRepo,
    notifyChannelJid:
      typeof fm.notify_channel_jid === 'string'
        ? fm.notify_channel_jid.trim()
        : d.notifyChannelJid,
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
 * persist state. Exported (injectable paths/clock/plugin config) for tests.
 * Returns the plan (or a no-op plan). Unlike the review flows there's no window
 * — it just keeps the recurring task in sync with config.
 *
 * `pluginConfig` is the normalized plugin CONFIG (see resolvePluginConfig): its
 * `sharedKbGroup` overrides which group the flow watches, and its `defaults`
 * fill any key the KB config.md omits. When there is NO config.md but the plugin
 * CONFIG supplies a notify channel, the flow still runs off those defaults (a
 * fully config-driven setup).
 */
export function tick({ profileDir, logger, nowMs, pluginConfig = {} }) {
  const pc = resolvePluginConfig(pluginConfig);
  let sharedKb = pc.sharedKbGroup || 'slack_main';
  if (!pc.sharedKbGroup) {
    try {
      const p = JSON.parse(
        fs.readFileSync(path.join(profileDir, 'profile.config.json'), 'utf-8'),
      );
      if (typeof p.sharedKbGroup === 'string' && p.sharedKbGroup) {
        sharedKb = p.sharedKbGroup;
      }
    } catch {
      /* default */
    }
  }

  const ctxDir = path.join(profileDir, 'groups', sharedKb, 'context');
  const configPath = path.join(ctxDir, 'admin-email', 'config.md');
  const statePath = path.join(ctxDir, 'admin-email', 'state.json');

  // Config source: the KB config.md (defaults filled from plugin CONFIG) if it
  // exists. Otherwise, if plugin CONFIG alone supplies a notify channel, run
  // from those defaults — a config-only setup with no KB file at all.
  let config = null;
  if (fs.existsSync(configPath)) {
    config = parseConfig(fs.readFileSync(configPath, 'utf-8'), pc.defaults);
  } else if (pc.defaults.notifyChannelJid) {
    config = { enabled: true, ...pc.defaults };
  }

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

/**
 * Catalog plugin entry point. `api` carries the framework surface (including
 * `profileDir`, since a catalog plugin lives outside the profile) and `config`
 * is this plugin's own config object (PLUGIN_CONFIG['admin-email'] ?? {}).
 */
export default function register({ registerIntegration, logger, profileDir }, config = {}) {
  const pc = resolvePluginConfig(config);
  let timer = null;
  registerIntegration({
    name: 'admin-email',
    start: () => {
      // Reconcile on a slow cadence — it only syncs the schedule to config,
      // the triage itself runs on its own cron task.
      const run = () => {
        try {
          tick({ profileDir, logger, nowMs: Date.now(), pluginConfig: config });
        } catch (err) {
          logger.error({ err }, 'admin-email: tick failed');
        }
      };
      const first = setTimeout(run, pc.firstTickDelayMs);
      first.unref?.();
      timer = setInterval(run, pc.tickMs);
      timer.unref?.();
      logger.info({ tickMs: pc.tickMs }, 'admin-email flow started');
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  });
}
