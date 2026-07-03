/**
 * Budget/entitlement check for API usage (OSS "API cost tracking & budgets").
 *
 * Kept as a single small module so a hosted control plane can later swap the
 * entitlement source (it would read a local entitlement.json synced from a
 * billing service) without touching the credential proxy or db wiring in
 * src/index.ts. The self-hosted OSS default reads two env vars and computes
 * month-to-date usage from the local api_usage table.
 *
 * Month-to-date totals are cached in memory and refreshed at most once per
 * REFRESH_INTERVAL_MS, since checkQuota runs on the hot path of every
 * /v1/messages request. onUsageRecorded() lets the caller increment the
 * cache immediately after each insert, so enforcement reacts within the same
 * request burst instead of waiting for the next refresh.
 */
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

/**
 * Check the current month-to-date usage against configured budgets.
 * `USAGE_MONTHLY_TOKEN_BUDGET` (int) and/or `USAGE_MONTHLY_COST_BUDGET_USD`
 * (float). Absent env vars = unlimited (that dimension is never checked).
 */
export function checkQuota(): QuotaResult {
  const tokenBudget = readIntEnv('USAGE_MONTHLY_TOKEN_BUDGET');
  const costBudget = readFloatEnv('USAGE_MONTHLY_COST_BUDGET_USD');

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
