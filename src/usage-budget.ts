/**
 * Budget/entitlement check for API usage (OSS "API cost tracking & budgets").
 *
 * Kept as a single small module so a hosted control plane can swap the
 * entitlement source without touching the credential proxy or db wiring in
 * src/index.ts. Budgets come from, in precedence order:
 *
 *   1. entitlement.json — <DATA_DIR>/entitlement.json, synced from the hosted
 *      control plane (src/integrations/control-plane-sync.ts), when present
 *      and parseable
 *   2. env vars        — USAGE_MONTHLY_TOKEN_BUDGET / USAGE_MONTHLY_COST_BUDGET_USD
 *   3. unlimited       — nothing configured (self-hosted OSS default)
 *
 * A `null` budget in the entitlement means that dimension is unlimited (it
 * does NOT fall through to env). The entitlement also carries a plan `state`:
 * `suspended` / `canceled` hard-block every request regardless of budgets;
 * all other states (`trialing`/`active`/`grace`/`over_quota`) enforce budgets
 * normally.
 *
 * FAIL-OPEN: a missing, unreadable, or corrupt entitlement.json falls back to
 * env budgets — it never crashes and never blocks by itself. The parsed file
 * is cached and re-read only when its mtime/size changes, keeping the hot
 * path cheap (checkQuota runs on every /v1/messages request).
 *
 * Month-to-date totals are cached in memory and refreshed at most once per
 * REFRESH_INTERVAL_MS. onUsageRecorded() lets the caller increment the
 * cache immediately after each insert, so enforcement reacts within the same
 * request burst instead of waiting for the next refresh.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getUsageSummary } from './db.js';
import { logger } from './logger.js';

export type QuotaResult = { ok: true } | { ok: false; reason: string };

const REFRESH_INTERVAL_MS = 60_000;

interface MonthToDateCache {
  monthKey: string; // YYYY-MM, so a month rollover forces a fresh sum
  tokens: number;
  costUsd: number;
  lastRefreshedAt: number;
}

let cache: MonthToDateCache | null = null;

function currentMonthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthStartIso(d = new Date()): string {
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

function refreshCache(): MonthToDateCache {
  const monthKey = currentMonthKey();
  const summary = getUsageSummary(monthStartIso());
  const tokens =
    summary.input_tokens +
    summary.output_tokens +
    summary.cache_read_tokens +
    summary.cache_write_tokens;
  cache = {
    monthKey,
    tokens,
    costUsd: summary.est_cost_usd,
    lastRefreshedAt: Date.now(),
  };
  return cache;
}

function getMonthToDate(): MonthToDateCache {
  const monthKey = currentMonthKey();
  if (
    !cache ||
    cache.monthKey !== monthKey ||
    Date.now() - cache.lastRefreshedAt > REFRESH_INTERVAL_MS
  ) {
    return refreshCache();
  }
  return cache;
}

/**
 * Call right after inserting a usage row so the in-memory cache reflects it
 * immediately, ahead of the next scheduled refresh. Keeps budget enforcement
 * timely even under a burst of requests within one refresh window.
 */
export function onUsageRecorded(usage: {
  totalTokens: number;
  costUsd: number;
}): void {
  const monthKey = currentMonthKey();
  if (!cache || cache.monthKey !== monthKey) {
    refreshCache();
    return;
  }
  cache.tokens += usage.totalTokens;
  cache.costUsd += usage.costUsd;
}

/** @internal - for tests only. Resets the in-memory month-to-date cache. */
export function _resetUsageBudgetCache(): void {
  cache = null;
}

// --- Control-plane entitlement (hosted mode) ---

/** Control-plane entitlement states. Mirrors the pinned control-plane contract. */
export type EntitlementState =
  | 'trialing'
  | 'active'
  | 'grace'
  | 'over_quota'
  | 'suspended'
  | 'canceled';

export interface Entitlement {
  state: EntitlementState;
  plan: string;
  /** null = tokens unlimited. */
  monthlyTokenBudget: number | null;
  /** null = cost unlimited. */
  monthlyCostBudgetUsd: number | null;
  periodStart?: string;
  periodEnd?: string;
  /** ISO timestamp the instance last fetched this from the control plane. */
  fetchedAt?: string;
}

/** Absolute path to the local entitlement cache file. */
export function entitlementFilePath(): string {
  return path.join(DATA_DIR, 'entitlement.json');
}

interface CachedEntitlement {
  mtimeMs: number;
  size: number;
  value: Entitlement | null;
}

let entitlementCache: CachedEntitlement | undefined;

/** @internal - for tests only. Resets the in-memory entitlement-file cache. */
export function _resetEntitlementCache(): void {
  entitlementCache = undefined;
}

const VALID_STATES: ReadonlySet<string> = new Set([
  'trialing',
  'active',
  'grace',
  'over_quota',
  'suspended',
  'canceled',
]);

/** Structurally validate a parsed entitlement object. Returns null if invalid. */
function coerceEntitlement(raw: unknown): Entitlement | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.state !== 'string' || !VALID_STATES.has(o.state)) {
    return null;
  }
  const numOrNull = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  return {
    state: o.state as EntitlementState,
    plan: typeof o.plan === 'string' ? o.plan : 'unknown',
    monthlyTokenBudget: numOrNull(o.monthlyTokenBudget),
    monthlyCostBudgetUsd: numOrNull(o.monthlyCostBudgetUsd),
    periodStart: typeof o.periodStart === 'string' ? o.periodStart : undefined,
    periodEnd: typeof o.periodEnd === 'string' ? o.periodEnd : undefined,
    fetchedAt: typeof o.fetchedAt === 'string' ? o.fetchedAt : undefined,
  };
}

/**
 * Load the cached entitlement, if any. Fails open: on any read/parse error
 * returns null (→ callers fall back to env budgets). The file is re-read only
 * when its mtime or size changes.
 */
export function loadEntitlement(): Entitlement | null {
  const file = entitlementFilePath();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    // Missing file is the normal self-hosted / pre-first-sync case.
    entitlementCache = { mtimeMs: -1, size: -1, value: null };
    return null;
  }

  if (
    entitlementCache &&
    entitlementCache.mtimeMs === stat.mtimeMs &&
    entitlementCache.size === stat.size
  ) {
    return entitlementCache.value;
  }

  let value: Entitlement | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    value = coerceEntitlement(parsed);
    if (!value) {
      logger.warn(
        { file },
        'entitlement.json present but malformed — ignoring, falling back to env budgets',
      );
    }
  } catch (err) {
    // Corrupt / partially-written file → fail open to env budgets.
    logger.warn(
      { err, file },
      'Failed to read/parse entitlement.json — falling back to env budgets',
    );
    value = null;
  }

  entitlementCache = { mtimeMs: stat.mtimeMs, size: stat.size, value };
  return value;
}

// --- Budget resolution ---

function readIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function readFloatEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export interface ResolvedBudgets {
  /** undefined = that dimension unlimited (never checked). */
  tokenBudget: number | undefined;
  costBudget: number | undefined;
  /** Where the budgets came from (for logging/telemetry). */
  source: 'entitlement' | 'env' | 'unlimited';
  /** The entitlement state, when an entitlement file drove the resolution. */
  state: EntitlementState | null;
}

/**
 * Resolve the effective budgets: entitlement file → env vars → unlimited.
 * The entitlement file wins wholesale when present and parseable (its null
 * budgets mean "unlimited", not "fall through to env").
 */
export function resolveBudgets(): ResolvedBudgets {
  const ent = loadEntitlement();
  if (ent) {
    return {
      tokenBudget: ent.monthlyTokenBudget ?? undefined,
      costBudget: ent.monthlyCostBudgetUsd ?? undefined,
      source: 'entitlement',
      state: ent.state,
    };
  }
  const tokenBudget = readIntEnv('USAGE_MONTHLY_TOKEN_BUDGET');
  const costBudget = readFloatEnv('USAGE_MONTHLY_COST_BUDGET_USD');
  if (tokenBudget !== undefined || costBudget !== undefined) {
    return { tokenBudget, costBudget, source: 'env', state: null };
  }
  return {
    tokenBudget: undefined,
    costBudget: undefined,
    source: 'unlimited',
    state: null,
  };
}

/**
 * Check the current entitlement state and month-to-date usage against the
 * resolved budgets (entitlement.json → env vars → unlimited). A `suspended`
 * or `canceled` entitlement blocks unconditionally; otherwise an absent
 * budget = unlimited (that dimension is never checked).
 */
export function checkQuota(): QuotaResult {
  const budgets = resolveBudgets();

  if (budgets.state === 'suspended') {
    logger.warn('Entitlement state is suspended — rejecting request');
    return {
      ok: false,
      reason:
        'This workspace is suspended. API access is paused until the account is reactivated in the control plane.',
    };
  }
  if (budgets.state === 'canceled') {
    logger.warn('Entitlement state is canceled — rejecting request');
    return {
      ok: false,
      reason:
        'This workspace subscription is canceled. API access is disabled.',
    };
  }

  const { tokenBudget, costBudget } = budgets;

  if (tokenBudget === undefined && costBudget === undefined) {
    return { ok: true };
  }

  const monthToDate = getMonthToDate();

  if (tokenBudget !== undefined && monthToDate.tokens >= tokenBudget) {
    logger.warn(
      { tokens: monthToDate.tokens, tokenBudget },
      'Monthly token budget exceeded — rejecting request',
    );
    return {
      ok: false,
      reason: `Monthly token budget exceeded (${monthToDate.tokens}/${tokenBudget} tokens used this month).`,
    };
  }

  if (costBudget !== undefined && monthToDate.costUsd >= costBudget) {
    logger.warn(
      { costUsd: monthToDate.costUsd, costBudget },
      'Monthly cost budget exceeded — rejecting request',
    );
    return {
      ok: false,
      reason: `Monthly cost budget exceeded ($${monthToDate.costUsd.toFixed(2)}/$${costBudget.toFixed(2)} used this month).`,
    };
  }

  return { ok: true };
}
