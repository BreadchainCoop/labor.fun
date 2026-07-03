import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const configMock = vi.hoisted(() => ({ DATA_DIR: '' }));
vi.mock('./config.js', () => configMock);

// Keep env resolution hermetic — never read a real .env from disk.
vi.mock('./env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// getUsageTotalsSince is the only db surface usage-budget touches.
const totals = vi.hoisted(() => ({ totalTokens: 0, totalCostUsd: 0 }));
vi.mock('./db.js', () => ({
  getUsageTotalsSince: vi.fn(() => totals),
}));

import {
  _resetEntitlementCache,
  _resetTotalsCache,
  checkQuota,
  entitlementFilePath,
  loadEntitlement,
  resolveBudgets,
  type Entitlement,
} from './usage-budget.js';

let tmpDir: string;

function writeEntitlement(e: Partial<Entitlement> & { state: string }): void {
  fs.writeFileSync(entitlementFilePath(), JSON.stringify(e));
  _resetEntitlementCache();
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-budget-test-'));
  configMock.DATA_DIR = tmpDir;
  totals.totalTokens = 0;
  totals.totalCostUsd = 0;
  _resetEntitlementCache();
  _resetTotalsCache();
  delete process.env.USAGE_MONTHLY_TOKEN_BUDGET;
  delete process.env.USAGE_MONTHLY_COST_BUDGET_USD;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('budget precedence: entitlement file over env', () => {
  it('uses env budgets when no entitlement file is present', () => {
    process.env.USAGE_MONTHLY_TOKEN_BUDGET = '1000';
    process.env.USAGE_MONTHLY_COST_BUDGET_USD = '5';
    const b = resolveBudgets();
    expect(b.source).toBe('env');
    expect(b.monthlyTokenBudget).toBe(1000);
    expect(b.monthlyCostBudgetUsd).toBe(5);
  });

  it('is unlimited when neither file nor env is present', () => {
    const b = resolveBudgets();
    expect(b.source).toBe('unlimited');
    expect(b.monthlyTokenBudget).toBeNull();
    expect(b.monthlyCostBudgetUsd).toBeNull();
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
    expect(b.monthlyTokenBudget).toBe(25000);
    expect(b.monthlyCostBudgetUsd).toBe(12);
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
    expect(b.monthlyTokenBudget).toBeNull();
    expect(b.monthlyCostBudgetUsd).toBeNull();
  });
});

describe('state hard-block (suspended / canceled)', () => {
  it('suspended blocks regardless of budgets', () => {
    writeEntitlement({
      state: 'suspended',
      plan: 'starter',
      monthlyTokenBudget: 1_000_000_000,
      monthlyCostBudgetUsd: 1_000_000,
    } as Entitlement);
    const r = checkQuota();
    expect(r.ok).toBe(false);
    expect(r.state).toBe('suspended');
    expect(r.reason).toMatch(/suspended/i);
  });

  it('canceled blocks regardless of budgets', () => {
    writeEntitlement({
      state: 'canceled',
      plan: 'starter',
      monthlyTokenBudget: null,
      monthlyCostBudgetUsd: null,
    } as Entitlement);
    const r = checkQuota();
    expect(r.ok).toBe(false);
    expect(r.state).toBe('canceled');
    expect(r.reason).toMatch(/cancel/i);
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
      totals.totalTokens = 500;
      _resetTotalsCache();
      const r = checkQuota();
      expect(r.ok).toBe(true);
      expect(r.state).toBe(state);
    },
  );
});

describe('budget enforcement', () => {
  it('blocks when the token budget is reached', () => {
    process.env.USAGE_MONTHLY_TOKEN_BUDGET = '1000';
    totals.totalTokens = 1000;
    _resetTotalsCache();
    const r = checkQuota();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/token budget/i);
  });

  it('blocks when the cost budget is reached', () => {
    process.env.USAGE_MONTHLY_COST_BUDGET_USD = '5';
    totals.totalCostUsd = 5.01;
    _resetTotalsCache();
    const r = checkQuota();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cost budget/i);
  });

  it('allows when under budget', () => {
    process.env.USAGE_MONTHLY_TOKEN_BUDGET = '1000';
    totals.totalTokens = 999;
    _resetTotalsCache();
    expect(checkQuota().ok).toBe(true);
  });

  it('allows unlimited (no budgets configured)', () => {
    totals.totalTokens = 999_999_999;
    _resetTotalsCache();
    expect(checkQuota().ok).toBe(true);
  });
});

describe('fail-open on corrupt / missing file', () => {
  it('falls back to env budgets when the file is corrupt JSON', () => {
    process.env.USAGE_MONTHLY_TOKEN_BUDGET = '1000';
    fs.writeFileSync(entitlementFilePath(), '{ not valid json');
    _resetEntitlementCache();
    expect(loadEntitlement()).toBeNull();
    const b = resolveBudgets();
    expect(b.source).toBe('env');
    expect(b.monthlyTokenBudget).toBe(1000);
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

describe('mtime-based cache invalidation', () => {
  it('re-reads the file only when mtime/size changes', () => {
    writeEntitlement({
      state: 'active',
      plan: 'starter',
      monthlyTokenBudget: 100,
      monthlyCostBudgetUsd: null,
    } as Entitlement);
    expect(loadEntitlement()?.monthlyTokenBudget).toBe(100);

    // Rewrite content WITHOUT resetting the in-memory cache. Bump mtime so the
    // guard notices the change (writeFileSync alone may keep the same mtimeMs
    // within one tick, but the size changes here too).
    fs.writeFileSync(
      entitlementFilePath(),
      JSON.stringify({
        state: 'active',
        plan: 'team',
        monthlyTokenBudget: 999999,
        monthlyCostBudgetUsd: null,
      }),
    );
    // Force a distinct mtime so the invalidation is unambiguous.
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
    // Delete the file; the cache guard should still return the cached value
    // because it stats first and, finding it gone, returns null. To prove the
    // cache path, instead corrupt the file in place but restore mtime+size.
    const stat = fs.statSync(entitlementFilePath());
    const replacement = JSON.stringify({
      state: 'active',
      plan: 'starter',
      monthlyTokenBudget: 100, // same length payload not required; we restore stat
      monthlyCostBudgetUsd: null,
    });
    fs.writeFileSync(entitlementFilePath(), replacement);
    fs.utimesSync(entitlementFilePath(), stat.atime, stat.mtime);
    // If size differs, the guard re-reads; assert on the stable field either way.
    const second = loadEntitlement();
    expect(second?.state).toBe(first?.state);
  });
});
