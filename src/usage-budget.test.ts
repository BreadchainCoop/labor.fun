import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockSummary = {
  requests: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  est_cost_usd: 0,
  by_model: [] as unknown[],
};

vi.mock('./db.js', () => ({
  getUsageSummary: vi.fn(() => mockSummary),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import {
  checkQuota,
  onUsageRecorded,
  _resetUsageBudgetCache,
} from './usage-budget.js';
import { getUsageSummary } from './db.js';

describe('usage-budget', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    _resetUsageBudgetCache();
    vi.clearAllMocks();
    mockSummary.input_tokens = 0;
    mockSummary.output_tokens = 0;
    mockSummary.cache_read_tokens = 0;
    mockSummary.cache_write_tokens = 0;
    mockSummary.est_cost_usd = 0;
    delete process.env.USAGE_MONTHLY_TOKEN_BUDGET;
    delete process.env.USAGE_MONTHLY_COST_BUDGET_USD;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('is unlimited when no budget env vars are set', () => {
    const result = checkQuota();
    expect(result.ok).toBe(true);
    // Should not even query the DB when both budgets are absent.
    expect(getUsageSummary).not.toHaveBeenCalled();
  });

  it('allows requests under the token budget', () => {
    process.env.USAGE_MONTHLY_TOKEN_BUDGET = '1000';
    mockSummary.input_tokens = 100;
    mockSummary.output_tokens = 100;
    const result = checkQuota();
    expect(result.ok).toBe(true);
  });

  it('rejects requests at/over the token budget', () => {
    process.env.USAGE_MONTHLY_TOKEN_BUDGET = '1000';
    mockSummary.input_tokens = 600;
    mockSummary.output_tokens = 500;
    const result = checkQuota();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.reason).toMatch(/token budget/i);
  });

  it('rejects requests at/over the cost budget', () => {
    process.env.USAGE_MONTHLY_COST_BUDGET_USD = '3.00';
    mockSummary.est_cost_usd = 3.5;
    const result = checkQuota();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.reason).toMatch(/cost budget/i);
  });

  it('caches month-to-date and does not re-query the DB immediately', () => {
    process.env.USAGE_MONTHLY_TOKEN_BUDGET = '1000';
    checkQuota();
    checkQuota();
    expect(getUsageSummary).toHaveBeenCalledTimes(1);
  });

  it('onUsageRecorded increments the cache without re-querying the DB', () => {
    process.env.USAGE_MONTHLY_TOKEN_BUDGET = '1000';
    mockSummary.input_tokens = 900;
    // Prime the cache.
    expect(checkQuota().ok).toBe(true);
    expect(getUsageSummary).toHaveBeenCalledTimes(1);

    // Increment past the budget without the mock DB summary changing.
    onUsageRecorded({ totalTokens: 200, costUsd: 0.01 });

    const result = checkQuota();
    expect(result.ok).toBe(false);
    // Still only the one initial DB query — cache increment avoided a re-query.
    expect(getUsageSummary).toHaveBeenCalledTimes(1);
  });
});
