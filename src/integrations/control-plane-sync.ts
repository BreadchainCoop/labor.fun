/**
 * control-plane-sync — the hosted-SaaS control-plane bridge (registered like any
 * other background integration). Every ~5 minutes it:
 *
 *   1. GET  {CONTROL_PLANE_URL}/api/instance/entitlement
 *      → atomic-write the result to <DATA_DIR>/entitlement.json (tmp + rename).
 *        usage-budget.ts reads that file to source budgets + the plan STATE
 *        (suspended/canceled hard-block).
 *   2. POST {CONTROL_PLANE_URL}/api/instance/usage
 *      → drain api_usage rows with id > cursor in batches of ≤500, advancing the
 *        cursor from each response until the table is drained. The cursor is
 *        persisted in the DB (router_state) so a restart never re-sends rows.
 *
 * Dormant unless BOTH CONTROL_PLANE_URL and CONTROL_PLANE_TOKEN are set —
 * absent means self-hosted mode and this integration no-ops. Network errors are
 * logged as warnings and retried next tick; nothing here ever throws out of the
 * loop, so a control-plane outage never affects the assistant.
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import {
  getApiUsageSince,
  getUsageReportCursor,
  setUsageReportCursor,
  type ApiUsageRow,
} from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

const TICK_MS = Number(process.env.CONTROL_PLANE_SYNC_INTERVAL_MS) || 300_000;
const FIRST_RUN_DELAY_MS =
  Number(process.env.CONTROL_PLANE_SYNC_FIRST_DELAY_MS) || 15_000;
const USAGE_BATCH_SIZE = 500;
const HTTP_TIMEOUT_MS = 20_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

interface ControlPlaneConfig {
  url: string;
  token: string;
}

/** Read CONTROL_PLANE_URL / CONTROL_PLANE_TOKEN (process.env, then .env). */
export function controlPlaneConfig(): ControlPlaneConfig | null {
  const env = readEnvFile(['CONTROL_PLANE_URL', 'CONTROL_PLANE_TOKEN']);
  const url = (process.env.CONTROL_PLANE_URL || env.CONTROL_PLANE_URL || '')
    .trim()
    .replace(/\/$/, '');
  const token = (
    process.env.CONTROL_PLANE_TOKEN ||
    env.CONTROL_PLANE_TOKEN ||
    ''
  ).trim();
  if (!url || !token) return null;
  return { url, token };
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Atomic write via a sibling tmp file + rename (never leaves a partial file). */
function atomicWriteJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Pull the entitlement and cache it locally. Returns true on success. On any
 * network/parse error, logs a warning and returns false — the previous cache
 * (if any) is left in place for usage-budget.ts to keep using.
 */
export async function syncEntitlement(
  cfg: ControlPlaneConfig,
): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${cfg.url}/api/instance/entitlement`, {
      method: 'GET',
      headers: authHeaders(cfg.token),
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status },
        'control-plane: entitlement fetch non-200 — keeping last cache',
      );
      return false;
    }
    const body = (await res.json()) as Record<string, unknown>;
    if (typeof body.state !== 'string' || typeof body.plan !== 'string') {
      logger.warn(
        'control-plane: entitlement response missing state/plan — keeping last cache',
      );
      return false;
    }
    atomicWriteJson(path.join(DATA_DIR, 'entitlement.json'), {
      state: body.state,
      plan: body.plan,
      monthlyTokenBudget: body.monthlyTokenBudget ?? null,
      monthlyCostBudgetUsd: body.monthlyCostBudgetUsd ?? null,
      periodStart: body.periodStart ?? null,
      periodEnd: body.periodEnd ?? null,
      fetchedAt: new Date().toISOString(),
    });
    logger.debug(
      { state: body.state, plan: body.plan },
      'control-plane: entitlement cached',
    );
    return true;
  } catch (err) {
    logger.warn(
      { err },
      'control-plane: entitlement sync failed — keeping last cache',
    );
    return false;
  }
}

/** Map a DB usage row (snake_case columns) to the pinned camelCase wire shape. */
function toWireEvent(r: ApiUsageRow): Record<string, unknown> {
  return {
    id: r.id,
    runTag: r.run_tag,
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    estCostUsd: r.est_cost_usd,
    statusCode: r.status_code,
    createdAt: r.created_at,
  };
}

/**
 * Push usage deltas up in batches of ≤500, looping until the table is drained
 * (or a batch fails). The cursor advances from the server's echoed value and is
 * persisted after each accepted batch, so a mid-drain failure resumes cleanly.
 */
export async function syncUsage(cfg: ControlPlaneConfig): Promise<void> {
  try {
    // Loop until a batch is short (drained) or a POST fails. Bounded by the
    // number of pending rows; each iteration advances the persisted cursor.
    for (;;) {
      const cursor = getUsageReportCursor();
      const events = getApiUsageSince(cursor, USAGE_BATCH_SIZE);
      if (events.length === 0) return;

      const res = await fetchWithTimeout(`${cfg.url}/api/instance/usage`, {
        method: 'POST',
        headers: authHeaders(cfg.token),
        body: JSON.stringify({
          cursor,
          events: events.map(toWireEvent),
        }),
      });
      if (!res.ok) {
        logger.warn(
          { status: res.status, cursor },
          'control-plane: usage POST non-200 — will retry next tick',
        );
        return;
      }
      const body = (await res.json()) as { ok?: boolean; cursor?: unknown };
      const newCursor =
        typeof body.cursor === 'number' && Number.isFinite(body.cursor)
          ? body.cursor
          : events[events.length - 1].id;
      // Guard against a server that doesn't advance the cursor (would loop).
      if (newCursor <= cursor) {
        logger.warn(
          { cursor, newCursor },
          'control-plane: usage cursor did not advance — stopping to avoid a loop',
        );
        return;
      }
      setUsageReportCursor(newCursor);

      // Short batch → we drained everything available.
      if (events.length < USAGE_BATCH_SIZE) return;
    }
  } catch (err) {
    logger.warn(
      { err },
      'control-plane: usage sync failed — will retry next tick',
    );
  }
}

/** One sync tick: entitlement first (so budgets are fresh), then usage. */
export async function runSyncTick(): Promise<void> {
  const cfg = controlPlaneConfig();
  if (!cfg) return;
  if (running) return; // never overlap ticks
  running = true;
  try {
    await syncEntitlement(cfg);
    await syncUsage(cfg);
  } finally {
    running = false;
  }
}

export function startControlPlaneSyncLoop(): void {
  const cfg = controlPlaneConfig();
  if (!cfg) {
    logger.info(
      'control-plane-sync: CONTROL_PLANE_URL/TOKEN not set — self-hosted mode, integration dormant',
    );
    return;
  }
  const run = () => {
    runSyncTick().catch((err) =>
      logger.error({ err }, 'control-plane-sync: tick failed'),
    );
  };
  const first = setTimeout(run, FIRST_RUN_DELAY_MS);
  first.unref?.();
  timer = setInterval(run, TICK_MS);
  timer.unref?.();
  logger.info(
    { tickMs: TICK_MS, url: cfg.url },
    'control-plane-sync loop started',
  );
}

export function stopControlPlaneSyncLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
