import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

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

// Point DATA_DIR (where entitlement.json lives) at a per-test temp dir so the
// entitlement layer is exercised hermetically.
const configMock = vi.hoisted(() => ({ DATA_DIR: '' }));
vi.mock('./config.js', () => configMock);

import {
  checkQuota,
  onUsageRecorded,
  _resetUsageBudgetCache,
  _resetEntitlementCache,
  entitlementFilePath,
  loadEntitlement,
  resolveBudgets,
  type Entitlement,
} from './usage-budget.js';
import { getUsageSummary } from './db.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-budget-test-'));
  configMock.DATA_DIR = tmpDir;
  _resetEntitlementCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeEntitlement(e: Partial<Entitlement> & { state: string }): void {
  fs.writeFileSync(entitlementFilePath(), JSON.stringify(e));
  _resetEntitlementCache();
}

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

// --- Control-plane entitlement layer (hosted mode) ---

describe('entitlement precedence: file over env', () => {
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

  it('uses env budgets when no entitlement file is present', () => {
    process.env.USAGE_MONTHLY_TOKEN_BUDGET = '1000';
    process.env.USAGE_MONTHLY_COST_BUDGET_USD = '5';
    const b = resolveBudgets();
    expect(b.source).toBe('env');
    expect(b.tokenBudget).toBe(1000);
    expect(b.costBudget).toBe(5);
  });

  it('is unlimited when neither file nor env is present', () => {
    const b = resolveBudgets();
    expect(b.source).toBe('unlimited');
    expect(b.tokenBudget).toBeUndefined();
    expect(b.costBudget).toBeUndefined();
  });

  it('entitlement file wins over env vars', () => {
    process.env.USAGE_MONTHLY_TOKEN_BUDGET = '1000';
    writeEntitlement({
      state: 'active',
      plan: 'starter',
      monthlyTokenBudget: 25000,
      monthlyCostBudgetUsd: 12,
    } as Entitlement);
    const b = resolveBudgets();
    expect(b.source).toBe('entitlement');
    expect(b.tokenBudget).toBe(25000);
    expect(b.costBudget).toBe(12);
  });

  it('null budget in the entitlement means unlimited (does NOT fall through to env)', () => {
    process.env.USAGE_MONTHLY_TOKEN_BUDGET = '1000';
    writeEntitlement({
      state: 'active',
      plan: 'dedicated',
      monthlyTokenBudget: null,
      monthlyCostBudgetUsd: null,
    } as Entitlement);
    const b = resolveBudgets();
    expect(b.source).toBe('entitlement');
    expect(b.tokenBudget).toBeUndefined();
    expect(b.costBudget).toBeUndefined();

    // And checkQuota allows even with month-to-date usage way past the env cap.
    mockSummary.input_tokens = 999_999_999;
    expect(checkQuota().ok).toBe(true);
  });

  it('entitlement budgets are enforced against month-to-date usage', () => {
    writeEntitlement({
      state: 'active',
      plan: 'starter',
      monthlyTokenBudget: 1000,
      monthlyCostBudgetUsd: null,
    } as Entitlement);
    mockSummary.input_tokens = 1000;
    const result = checkQuota();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.reason).toMatch(/token budget/i);
  });
});

describe('entitlement state hard-block (suspended / canceled)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    _resetUsageBudgetCache();
    vi.clearAllMocks();
    mockSummary.input_tokens = 0;
    mockSummary.est_cost_usd = 0;
    delete process.env.USAGE_MONTHLY_TOKEN_BUDGET;
    delete process.env.USAGE_MONTHLY_COST_BUDGET_USD;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('suspended blocks regardless of budgets', () => {
    writeEntitlement({
      state: 'suspended',
      plan: 'starter',
      monthlyTokenBudget: 1_000_000_000,
      monthlyCostBudgetUsd: 1_000_000,
    } as Entitlement);
    const result = checkQuota();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.reason).toMatch(/suspended/i);
    // Hard-block short-circuits before any usage query.
    expect(getUsageSummary).not.toHaveBeenCalled();
  });

  it('canceled blocks regardless of budgets (even unlimited ones)', () => {
    writeEntitlement({
      state: 'canceled',
      plan: 'starter',
      monthlyTokenBudget: null,
      monthlyCostBudgetUsd: null,
    } as Entitlement);
    const result = checkQuota();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.reason).toMatch(/cancel/i);
  });

  it.each(['trialing', 'active', 'grace', 'over_quota'])(
    'state %s enforces budgets normally (allowed under budget)',
    (state) => {
      writeEntitlement({
        state,
        plan: 'starter',
        monthlyTokenBudget: 1000,
        monthlyCostBudgetUsd: null,
      } as Entitlement);
      mockSummary.input_tokens = 500;
      expect(checkQuota().ok).toBe(true);
    },
  );
});

describe('entitlement fail-open on corrupt / missing file', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    _resetUsageBudgetCache();
    vi.clearAllMocks();
    mockSummary.input_tokens = 0;
    delete process.env.USAGE_MONTHLY_TOKEN_BUDGET;
    delete process.env.USAGE_MONTHLY_COST_BUDGET_USD;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('falls back to env budgets when the file is corrupt JSON', () => {
    process.env.USAGE_MONTHLY_TOKEN_BUDGET = '1000';
    fs.writeFileSync(entitlementFilePath(), '{ not valid json');
    _resetEntitlementCache();
    expect(loadEntitlement()).toBeNull();
    const b = resolveBudgets();
    expect(b.source).toBe('env');
    expect(b.tokenBudget).toBe(1000);
  });

  it('falls back to env when the file is structurally invalid (bad state)', () => {
    process.env.USAGE_MONTHLY_TOKEN_BUDGET = '1000';
    fs.writeFileSync(
      entitlementFilePath(),
      JSON.stringify({ state: 'nonsense', plan: 'x' }),
    );
    _resetEntitlementCache();
    expect(loadEntitlement()).toBeNull();
    expect(resolveBudgets().source).toBe('env');
  });

  it('a corrupt file never blocks (checkQuota stays ok with no env budgets)', () => {
    fs.writeFileSync(entitlementFilePath(), 'garbage');
    _resetEntitlementCache();
    expect(checkQuota().ok).toBe(true);
  });

  it('missing file resolves to unlimited', () => {
    expect(loadEntitlement()).toBeNull();
    expect(resolveBudgets().source).toBe('unlimited');
  });
});

describe('entitlement mtime-based cache invalidation', () => {
  beforeEach(() => {
    _resetUsageBudgetCache();
    vi.clearAllMocks();
  });

  it('re-reads the file only when mtime/size changes', () => {
    writeEntitlement({
      state: 'active',
      plan: 'starter',
      monthlyTokenBudget: 100,
      monthlyCostBudgetUsd: null,
    } as Entitlement);
    expect(loadEntitlement()?.monthlyTokenBudget).toBe(100);

    // Rewrite content WITHOUT resetting the in-memory cache; bump mtime so
    // the invalidation guard is unambiguous.
    fs.writeFileSync(
      entitlementFilePath(),
      JSON.stringify({
        state: 'active',
        plan: 'team',
        monthlyTokenBudget: 999999,
        monthlyCostBudgetUsd: null,
      }),
    );
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(entitlementFilePath(), future, future);

    expect(loadEntitlement()?.monthlyTokenBudget).toBe(999999);
  });

  it('serves the cached value while mtime and size are unchanged', () => {
    writeEntitlement({
      state: 'active',
      plan: 'starter',
      monthlyTokenBudget: 100,
      monthlyCostBudgetUsd: null,
    } as Entitlement);
    const first = loadEntitlement();
    const stat = fs.statSync(entitlementFilePath());
    fs.writeFileSync(
      entitlementFilePath(),
      JSON.stringify({
        state: 'active',
        plan: 'starter',
        monthlyTokenBudget: 100,
        monthlyCostBudgetUsd: null,
      }),
    );
    // Restore stat so the cache guard sees no change.
    fs.utimesSync(entitlementFilePath(), stat.atime, stat.mtime);
    const second = loadEntitlement();
    expect(second?.state).toBe(first?.state);
  });
});

describe('entitlement staleness backstop', () => {
  const originalEnv = { ...process.env };
  const DAY_MS = 24 * 60 * 60 * 1000;

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
    delete process.env.ENTITLEMENT_STALE_BLOCK_HOURS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('allows a fresh entitlement (default threshold, env unset)', () => {
    writeEntitlement({
      state: 'active',
      plan: 'starter',
      monthlyTokenBudget: 1000,
      monthlyCostBudgetUsd: null,
      fetchedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 min ago
    } as Entitlement);
    mockSummary.input_tokens = 100;
    expect(checkQuota().ok).toBe(true);
  });

  it('blocks a stale entitlement (fetchedAt 8 days ago, default threshold)', () => {
    const eightDaysAgo = new Date(Date.now() - 8 * DAY_MS).toISOString();
    writeEntitlement({
      state: 'active',
      plan: 'starter',
      monthlyTokenBudget: 1000,
      monthlyCostBudgetUsd: null,
      fetchedAt: eightDaysAgo,
    } as Entitlement);
    mockSummary.input_tokens = 100;
    const result = checkQuota();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.reason).toMatch(/stale/i);
    expect(result.reason).toMatch(/control-plane connectivity/i);
    expect(result.reason).toContain(eightDaysAgo);
  });

  it('threshold 0 disables the backstop (stale file honored)', () => {
    process.env.ENTITLEMENT_STALE_BLOCK_HOURS = '0';
    writeEntitlement({
      state: 'active',
      plan: 'starter',
      monthlyTokenBudget: 1000,
      monthlyCostBudgetUsd: null,
      fetchedAt: new Date(Date.now() - 8 * DAY_MS).toISOString(),
    } as Entitlement);
    mockSummary.input_tokens = 100; // under budget
    expect(checkQuota().ok).toBe(true);
  });

  it('never triggers when no entitlement file is present (self-hosted)', () => {
    // No entitlement.json; env budget under limit → staleness path untouched.
    process.env.USAGE_MONTHLY_TOKEN_BUDGET = '1000';
    mockSummary.input_tokens = 100;
    expect(checkQuota().ok).toBe(true);
    // And with no budget at all it's still unlimited/ok.
    delete process.env.USAGE_MONTHLY_TOKEN_BUDGET;
    _resetUsageBudgetCache();
    expect(checkQuota().ok).toBe(true);
  });

  it('missing fetchedAt: stale via old file mtime', () => {
    writeEntitlement({
      state: 'active',
      plan: 'starter',
      monthlyTokenBudget: 1000,
      monthlyCostBudgetUsd: null,
      // no fetchedAt
    } as Entitlement);
    // Whole seconds: sub-second mtime precision doesn't survive the
    // utimesSync → statSync round-trip on every filesystem.
    const oldDate = new Date(
      Math.floor((Date.now() - 8 * DAY_MS) / 1000) * 1000,
    );
    fs.utimesSync(entitlementFilePath(), oldDate, oldDate);
    _resetEntitlementCache(); // force re-stat so loadEntitlement sees new mtime
    mockSummary.input_tokens = 100;
    const result = checkQuota();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.reason).toMatch(/stale/i);
    expect(result.reason).toContain(oldDate.toISOString());
  });

  it('missing fetchedAt: fresh via recent file mtime', () => {
    writeEntitlement({
      state: 'active',
      plan: 'starter',
      monthlyTokenBudget: 1000,
      monthlyCostBudgetUsd: null,
      // no fetchedAt; just-written file has a recent mtime
    } as Entitlement);
    mockSummary.input_tokens = 100;
    expect(checkQuota().ok).toBe(true);
  });

  it('honors a custom threshold (ENTITLEMENT_STALE_BLOCK_HOURS=1)', () => {
    process.env.ENTITLEMENT_STALE_BLOCK_HOURS = '1';
    // 2 hours old → older than 1h threshold → blocked.
    writeEntitlement({
      state: 'active',
      plan: 'starter',
      monthlyTokenBudget: 1000,
      monthlyCostBudgetUsd: null,
      fetchedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    } as Entitlement);
    mockSummary.input_tokens = 100;
    expect(checkQuota().ok).toBe(false);

    // 30 minutes old → within 1h threshold → allowed.
    _resetUsageBudgetCache();
    writeEntitlement({
      state: 'active',
      plan: 'starter',
      monthlyTokenBudget: 1000,
      monthlyCostBudgetUsd: null,
      fetchedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    } as Entitlement);
    expect(checkQuota().ok).toBe(true);
  });
});
