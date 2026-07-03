/**
 * Monthly usage budget guard.
 *
 * Enforces a per-month token and/or cost ceiling on API usage, plus the hosted
 * control-plane entitlement STATE (suspended/canceled hard-block). Budgets come
 * from, in precedence order:
 *
 *   1. entitlement.json  — the control-plane cache (when present and parseable)
 *   2. env vars          — USAGE_MONTHLY_TOKEN_BUDGET / USAGE_MONTHLY_COST_BUDGET_USD
 *   3. unlimited         — no budget configured
 *
 * A `null` budget in either source means that dimension is unlimited. The
 * entitlement file also carries a `state`: `suspended` / `canceled` hard-block
 * regardless of budgets; every other state (`trialing` / `active` / `grace` /
 * `over_quota`) enforces the budgets normally.
 *
 * FAIL-OPEN: a missing, unreadable, or corrupt entitlement.json falls back to
 * env budgets — it never crashes and never blocks. Self-hosted installs that
 * set no env vars and have no entitlement file run unlimited.
 *
 * The parsed entitlement file is cached and re-read only when its mtime changes,
 * so this stays cheap on the hot path (checked once per API request).
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getUsageTotalsSince } from './db.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

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

// --- mtime-invalidated parse cache -----------------------------------------

interface CachedEntitlement {
  mtimeMs: number;
  size: number;
  value: Entitlement | null;
}

let entitlementCache: CachedEntitlement | undefined;

/** Reset the in-memory cache. Test-only. */
export function _resetEntitlementCache(): void {
  entitlementCache = undefined;
}

/** Structurally validate a parsed entitlement object. Returns null if invalid. */
function coerceEntitlement(raw: unknown): Entitlement | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const validStates: EntitlementState[] = [
    'trialing',
    'active',
    'grace',
    'over_quota',
    'suspended',
    'canceled',
  ];
  if (
    typeof o.state !== 'string' ||
    !validStates.includes(o.state as EntitlementState)
  ) {
    return null;
  }
  const numOrNull = (v: unknown): number | null =>
    v === null || v === undefined
      ? null
      : typeof v === 'number' && Number.isFinite(v)
        ? v
        : null;
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

// --- budget resolution -----------------------------------------------------

function parseEnvNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface ResolvedBudgets {
  /** null = unlimited. */
  monthlyTokenBudget: number | null;
  /** null = unlimited. */
  monthlyCostBudgetUsd: number | null;
  /** Where the budgets came from (for logging/telemetry). */
  source: 'entitlement' | 'env' | 'unlimited';
  /** The entitlement state, if an entitlement file drove the resolution. */
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
      monthlyTokenBudget: ent.monthlyTokenBudget,
      monthlyCostBudgetUsd: ent.monthlyCostBudgetUsd,
      source: 'entitlement',
      state: ent.state,
    };
  }
  // Prefer process.env; fall back to the install's .env (systemd doesn't load
  // .env globally), matching how the rest of the framework reads operator vars.
  const envFile = readEnvFile([
    'USAGE_MONTHLY_TOKEN_BUDGET',
    'USAGE_MONTHLY_COST_BUDGET_USD',
  ]);
  const envTokens = parseEnvNumber(
    process.env.USAGE_MONTHLY_TOKEN_BUDGET ??
      envFile.USAGE_MONTHLY_TOKEN_BUDGET,
  );
  const envCost = parseEnvNumber(
    process.env.USAGE_MONTHLY_COST_BUDGET_USD ??
      envFile.USAGE_MONTHLY_COST_BUDGET_USD,
  );
  if (envTokens !== null || envCost !== null) {
    return {
      monthlyTokenBudget: envTokens,
      monthlyCostBudgetUsd: envCost,
      source: 'env',
      state: null,
    };
  }
  return {
    monthlyTokenBudget: null,
    monthlyCostBudgetUsd: null,
    source: 'unlimited',
    state: null,
  };
}

// --- quota check -----------------------------------------------------------

export interface QuotaResult {
  ok: boolean;
  /** Human-readable reason when blocked. */
  reason?: string;
  /** The state that produced the decision, if entitlement-driven. */
  state?: EntitlementState | null;
}

/** First day of the current UTC month, as an ISO string. */
function monthStartIso(now = new Date()): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  ).toISOString();
}

// The month-to-date totals are cached briefly so we don't re-sum the whole
// api_usage table on every single API request. The credential proxy calls
// checkQuota per request; a few seconds of staleness is fine for a monthly cap.
const TOTALS_TTL_MS = 5_000;
let totalsCache:
  | { at: number; totalTokens: number; totalCostUsd: number }
  | undefined;

/** Test-only: clear the month-to-date totals cache. */
export function _resetTotalsCache(): void {
  totalsCache = undefined;
}

function monthToDateTotals(): { totalTokens: number; totalCostUsd: number } {
  const now = Date.now();
  if (totalsCache && now - totalsCache.at < TOTALS_TTL_MS) {
    return totalsCache;
  }
  const totals = getUsageTotalsSince(monthStartIso());
  totalsCache = { at: now, ...totals };
  return totals;
}

/**
 * Decide whether a new API request is allowed under the current entitlement +
 * budgets. Called by the credential proxy before forwarding a request.
 *
 * - suspended / canceled  → always blocked, regardless of budgets.
 * - otherwise             → blocked only if a configured budget is exceeded.
 * - no budgets configured → always allowed.
 *
 * Never throws: any unexpected error resolves to `{ ok: true }` (fail-open) so
 * a metering bug can't take the whole assistant offline.
 */
export function checkQuota(): QuotaResult {
  try {
    const budgets = resolveBudgets();

    if (budgets.state === 'suspended') {
      return {
        ok: false,
        state: 'suspended',
        reason:
          'This workspace is suspended. API access is paused until the account is reactivated in the control plane.',
      };
    }
    if (budgets.state === 'canceled') {
      return {
        ok: false,
        state: 'canceled',
        reason:
          'This workspace subscription is canceled. API access is disabled.',
      };
    }

    const { monthlyTokenBudget, monthlyCostBudgetUsd } = budgets;
    if (monthlyTokenBudget === null && monthlyCostBudgetUsd === null) {
      return { ok: true, state: budgets.state };
    }

    const { totalTokens, totalCostUsd } = monthToDateTotals();

    if (monthlyTokenBudget !== null && totalTokens >= monthlyTokenBudget) {
      return {
        ok: false,
        state: budgets.state,
        reason: `Monthly token budget reached (${totalTokens.toLocaleString()} / ${monthlyTokenBudget.toLocaleString()} tokens).`,
      };
    }
    if (monthlyCostBudgetUsd !== null && totalCostUsd >= monthlyCostBudgetUsd) {
      return {
        ok: false,
        state: budgets.state,
        reason: `Monthly cost budget reached ($${totalCostUsd.toFixed(2)} / $${monthlyCostBudgetUsd.toFixed(2)}).`,
      };
    }

    return { ok: true, state: budgets.state };
  } catch (err) {
    logger.warn({ err }, 'checkQuota failed — allowing request (fail-open)');
    return { ok: true };
  }
}
