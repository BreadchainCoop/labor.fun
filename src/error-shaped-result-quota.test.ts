import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Locks the classifier's QUOTA_REFUSAL carve-out to the refusals
// usage-budget.ts actually produces. Same hermetic setup as
// usage-budget.test.ts: month-to-date usage comes from a mocked db summary
// and entitlement.json lives in a per-test temp dir.
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

const configMock = vi.hoisted(() => ({ DATA_DIR: '' }));
vi.mock('./config.js', () => configMock);

import { isErrorShapedResult } from './error-shaped-result.js';
import {
  _resetEntitlementCache,
  _resetUsageBudgetCache,
  checkQuota,
  entitlementFilePath,
  type Entitlement,
} from './usage-budget.js';

const DAY_MS = 86_400_000;

// The credential proxy answers a refused request with a 429 whose message is
// the refusal reason, and the bundled CLI (claude-agent-sdk 0.2.107) renders
// that as the run's result text in exactly this form.
function asCliResult(reason: string): string {
  return `API Error: Request rejected (429) · ${reason}`;
}

function writeEntitlement(e: Partial<Entitlement>): void {
  fs.writeFileSync(
    entitlementFilePath(),
    JSON.stringify({
      plan: 'starter',
      monthlyTokenBudget: null,
      monthlyCostBudgetUsd: null,
      ...e,
    }),
  );
  _resetEntitlementCache();
}

describe("the credential proxy's quota refusals are not error-shaped", () => {
  const originalEnv = { ...process.env };
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-refusal-test-'));
    configMock.DATA_DIR = tmpDir;
    _resetEntitlementCache();
    _resetUsageBudgetCache();
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // One case per reason checkQuota() can refuse with. Rewording a reason
  // without updating QUOTA_REFUSAL in error-shaped-result.ts fails here
  // instead of silently turning a tenant's billing notice into a withheld,
  // retried error. A new refusal needs a case here and an alternative there.
  it.each([
    {
      refusal: 'monthly token budget',
      kind: /token budget/i,
      setup: () => {
        process.env.USAGE_MONTHLY_TOKEN_BUDGET = '1000';
        mockSummary.input_tokens = 600;
        mockSummary.output_tokens = 500;
      },
    },
    {
      refusal: 'monthly cost budget',
      kind: /cost budget/i,
      setup: () => {
        process.env.USAGE_MONTHLY_COST_BUDGET_USD = '3.00';
        mockSummary.est_cost_usd = 3;
      },
    },
    {
      refusal: 'suspended workspace',
      kind: /suspended/i,
      setup: () => writeEntitlement({ state: 'suspended' }),
    },
    {
      refusal: 'canceled subscription',
      kind: /canceled/i,
      setup: () => writeEntitlement({ state: 'canceled' }),
    },
    {
      refusal: 'stale entitlement',
      kind: /stale/i,
      setup: () =>
        writeEntitlement({
          state: 'active',
          fetchedAt: new Date(Date.now() - 8 * DAY_MS).toISOString(),
        }),
    },
  ])('keeps the $refusal refusal postable', ({ kind, setup }) => {
    setup();
    const quota = checkQuota();
    if (quota.ok) throw new Error('expected checkQuota() to refuse');
    expect(quota.reason).toMatch(kind);
    expect(isErrorShapedResult(asCliResult(quota.reason))).toBe(false);
  });

  it("keeps the CLI's generic 429 fallback error-shaped", () => {
    expect(
      isErrorShapedResult(
        asCliResult(
          'this may be a temporary capacity issue — check status.anthropic.com',
        ),
      ),
    ).toBe(true);
  });
});
