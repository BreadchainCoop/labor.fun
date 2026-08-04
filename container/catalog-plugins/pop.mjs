/**
 * pop.mjs — POP (Perpetual Organization Protocol) task mirror.
 *
 * Phase 1: the DOWN leg only. Mirrors an org's on-chain tasks into
 * `groups/<sharedKbGroup>/context/tasks/POP-<chain>-<org>-<id>.md` so that the
 * reminder engine, PM orchestrator, digests and the kb-ui /projects page all
 * work on on-chain work for free. Read-only: `POP_READONLY=1` is hardwired, so
 * this cannot sign or broadcast even if a key were present in the environment.
 *
 * LAYOUT NOTE. The plugin loader's scan is NON-RECURSIVE and file-only
 * (`readdirSync` + `statSync(...).isFile()` in src/plugin-loader.ts), so a
 * plugin MUST be a single top-level .mjs. The helper modules therefore live in
 * the sibling `pop/` directory — imported from here, never discovered, because
 * a directory does not match the loader's `.mjs` filter.
 *
 * POLICY-CLOSED. As a catalog plugin this is imported at boot but only
 * REGISTERS when `pop` appears in the profile's `enabledPlugins` (or the
 * ENABLED_PLUGINS env var). Absent from that list it is completely inert.
 *
 * CONFIG (profile.config.json → pluginConfig.pop). Secrets never go here.
 *
 *   {
 *     "sharedKbGroup": "slack_main",
 *     "taskUrlBase": "https://poa.box/t",
 *     "tickMs": 900000,
 *     "firstTickDelayMs": 45000,
 *     "missingTicksBeforeDelete": 3,
 *     "orgs": [{ "name": "Argus", "chainId": 100, "orgId": "0x112d…" }]
 *   }
 *
 * `orgs` empty/absent → dormant, exactly like safeConfig() returning null in
 * src/integrations/safe-payouts.ts.
 */

import fs from 'fs';
import path from 'path';

import { buildEnv, listMembers, listTasks, resolvePopBin, viewTask } from './pop/cli.mjs';
import { mirrorOrg, DEFAULT_MISSING_TICKS, DEFAULT_VIEW_BUDGET } from './pop/mirror.mjs';

export const id = 'pop';
export const kind = 'integration';

const HOUR_MS = 3_600_000;

/** Normalise + default the plugin config. Pure, so it is unit-testable. */
export function resolveConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  const orgs = (Array.isArray(c.orgs) ? c.orgs : [])
    .map((o) => ({
      name: typeof o?.name === 'string' ? o.name.trim() : '',
      chainId: Number(o?.chainId) || 100,
      orgId: typeof o?.orgId === 'string' ? o.orgId.trim() : '',
    }))
    .filter((o) => o.name);
  return {
    orgs,
    sharedKbGroup: typeof c.sharedKbGroup === 'string' ? c.sharedKbGroup.trim() : '',
    taskUrlBase: typeof c.taskUrlBase === 'string' && c.taskUrlBase.trim()
      ? c.taskUrlBase.trim()
      : 'https://poa.box/t',
    // 0 ALWAYS means disabled — the repo-wide convention for interval config.
    tickMs: num(c.tickMs, 15 * 60_000),
    firstTickDelayMs: num(c.firstTickDelayMs, 45_000),
    missingTicksBeforeDelete: num(c.missingTicksBeforeDelete, DEFAULT_MISSING_TICKS),
    // Deep reads per org per tick. 0 disables tier 2 entirely (tier 1 alone
    // already feeds the reminder engine and PM orchestrator).
    viewBudget: num(c.viewBudget, DEFAULT_VIEW_BUDGET),
    graphApiKeyVar: typeof c.graphApiKeyVar === 'string' ? c.graphApiKeyVar.trim() : 'GRAPH_API_KEY',
  };
}

/**
 * Which group's `context/` holds the KB. Config wins; otherwise read the
 * profile's own `sharedKbGroup` — the same fallback weekly-agenda.mjs uses,
 * because a catalog plugin has no access to the parsed PROFILE.
 */
function resolveSharedKb(profileDir, configured) {
  if (configured) return configured;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(profileDir, 'profile.config.json'), 'utf-8'));
    if (typeof cfg.sharedKbGroup === 'string' && cfg.sharedKbGroup.trim()) {
      return cfg.sharedKbGroup.trim();
    }
  } catch {
    /* fall through */
  }
  return 'slack_main';
}

/** One full pass over every configured org. Exported for tests + manual runs. */
export async function runOnce({ profileDir, config, readEnvFile, logger, deps = {} }) {
  const cfg = resolveConfig(config);
  if (!cfg.orgs.length) return [];

  const sharedKb = resolveSharedKb(profileDir, cfg.sharedKbGroup);
  const contextDir = path.join(profileDir, 'groups', sharedKb, 'context');
  const tasksDir = path.join(contextDir, 'tasks');
  const peopleDir = path.join(contextDir, 'people');

  // Isolate POP's own state (idempotency cache + subgraph tier state) per
  // profile, so two orgs on one host never share either.
  const agentHome = path.join(profileDir, 'store', 'pop');
  fs.mkdirSync(agentHome, { recursive: true });

  // Read the (optional) Graph API key lazily, never through process.env — the
  // free tier caps at 3K queries/day and a paid key lifts it.
  let graphApiKey;
  try {
    graphApiKey = readEnvFile?.([cfg.graphApiKeyVar])?.[cfg.graphApiKeyVar] || undefined;
  } catch {
    graphApiKey = undefined;
  }

  const list = deps.listTasks || listTasks;
  const members = deps.listMembers || listMembers;
  const view = deps.viewTask || viewTask;
  const syncedAt = new Date().toISOString();
  const stats = [];

  for (const org of cfg.orgs) {
    const env = buildEnv({
      chainId: org.chainId,
      org: org.name,
      agentHome,
      graphApiKey,
      readOnly: true,
    });
    const opts = { env, cwd: agentHome };
    const listResult = await list(org.name, opts);
    const membersResult = listResult.ok ? await members(org.name, opts) : null;
    stats.push(
      await mirrorOrg({
        org: org.name,
        chainId: org.chainId,
        orgId: org.orgId || org.name,
        tasksDir,
        peopleDir,
        taskUrlBase: cfg.taskUrlBase,
        syncedAt,
        listResult,
        membersResult,
        missingTicksBeforeDelete: cfg.missingTicksBeforeDelete,
        fetchView: (taskId) => view(org.name, taskId, opts),
        viewBudget: cfg.viewBudget,
        logger,
      }),
    );
  }
  return stats;
}

export default function register(api, config) {
  const { registerIntegration, readEnvFile, logger, profileDir } = api;
  const cfg = resolveConfig(config);

  let timer = null;
  let first = null;
  // Re-entrancy guard: a slow tick must never overlap the next one. The
  // control-plane-sync loop uses exactly this pattern; safe-payouts does not,
  // and a long chain read is far more likely to overrun than a 60s Safe poll.
  let running = false;

  registerIntegration({
    name: 'pop-task-mirror',
    start: () => {
      if (!cfg.orgs.length) {
        logger.info('[pop] no orgs configured — mirror dormant');
        return;
      }
      if (!resolvePopBin()) {
        logger.warn('[pop] @poa-box/cli is not installed — mirror dormant');
        return;
      }
      if (cfg.tickMs <= 0) {
        logger.info('[pop] tickMs=0 — mirror disabled');
        return;
      }

      // `orgId` is optional today but it feeds the task IDENTITY URL, which is
      // designed to be immutable — it becomes the Linear attachment join key,
      // and `attachmentsForURL` makes that join stateless precisely because the
      // URL never changes. Omitting it falls back to the org NAME, so adding
      // the real hex id later would silently rewrite every task's `pop_url` and
      // orphan every Linear link already attached. Warn now, while the only
      // cost is a re-mirror.
      for (const o of cfg.orgs) {
        if (!o.orgId) {
          logger.warn(
            { org: o.name, chainId: o.chainId },
            '[pop] no orgId configured — the task identity URL will use the org NAME. ' +
              'Set orgId (from `pop org list --json`) before linking anything to these URLs.',
          );
        }
      }

      const tick = () => {
        if (running) {
          logger.debug('[pop] previous tick still running — skipping');
          return;
        }
        running = true;
        runOnce({ profileDir, config, readEnvFile, logger })
          .then((stats) => {
            for (const s of stats) {
              if (s.error) logger.warn({ org: s.org, err: s.error }, '[pop] mirror tick failed');
              else if (s.written || s.deleted || s.tombstoned) {
                logger.info(
                  {
                    org: s.org,
                    written: s.written,
                    unchanged: s.unchanged,
                    tombstoned: s.tombstoned,
                    deleted: s.deleted,
                  },
                  '[pop] mirrored',
                );
              }
            }
          })
          .catch((err) => logger.error({ err }, '[pop] mirror tick threw'))
          .finally(() => {
            running = false;
          });
      };

      first = setTimeout(tick, cfg.firstTickDelayMs);
      first.unref?.();
      timer = setInterval(tick, Math.max(cfg.tickMs, 60_000));
      timer.unref?.();
      logger.info(
        { orgs: cfg.orgs.map((o) => `${o.name}@${o.chainId}`), tickMs: cfg.tickMs },
        '[pop] task mirror started (read-only)',
      );
    },
    stop: () => {
      if (first) clearTimeout(first);
      if (timer) clearInterval(timer);
      first = null;
      timer = null;
    },
  });
}

export { HOUR_MS };
