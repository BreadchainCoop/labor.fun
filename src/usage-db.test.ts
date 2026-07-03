import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  getApiUsageSince,
  getUsageReportCursor,
  insertApiUsage,
  setUsageReportCursor,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

function seed(runTag: string | null = null): void {
  insertApiUsage({
    runTag,
    model: 'claude-opus-4-6',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    estCostUsd: 0.01,
    statusCode: 200,
  });
}

describe('getApiUsageSince (control-plane report drain)', () => {
  it('returns rows with id > cursor, oldest first, with monotonic ids', () => {
    seed('a');
    seed('b');
    seed('c');

    const all = getApiUsageSince(0, 500);
    expect(all).toHaveLength(3);
    expect(all[0].run_tag).toBe('a');
    expect(all[1].id).toBeGreaterThan(all[0].id);
    expect(all[2].id).toBeGreaterThan(all[1].id);

    const afterFirst = getApiUsageSince(all[0].id, 500);
    expect(afterFirst.map((r) => r.run_tag)).toEqual(['b', 'c']);
  });

  it('honors the batch limit for draining', () => {
    for (let i = 0; i < 5; i++) seed();
    expect(getApiUsageSince(0, 2)).toHaveLength(2);
  });

  it('returns full row fields for the wire mapping', () => {
    seed('run-1');
    const [row] = getApiUsageSince(0, 1);
    expect(row).toMatchObject({
      run_tag: 'run-1',
      model: 'claude-opus-4-6',
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 10,
      cache_write_tokens: 5,
      est_cost_usd: 0.01,
      status_code: 200,
    });
    expect(typeof row.id).toBe('number');
    expect(typeof row.created_at).toBe('string');
  });

  it('returns empty when nothing is newer than the cursor', () => {
    seed();
    const [row] = getApiUsageSince(0, 10);
    expect(getApiUsageSince(row.id, 10)).toEqual([]);
  });
});

describe('usage report cursor (router_state persistence)', () => {
  it('defaults to 0 when unset', () => {
    expect(getUsageReportCursor()).toBe(0);
  });

  it('round-trips through the DB and clamps to a non-negative int', () => {
    setUsageReportCursor(42);
    expect(getUsageReportCursor()).toBe(42);

    setUsageReportCursor(-5);
    expect(getUsageReportCursor()).toBe(0);

    setUsageReportCursor(99.9);
    expect(getUsageReportCursor()).toBe(99);
  });
});
