import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  getApiUsageSince,
  getUsageReportCursor,
  getUsageTotalsSince,
  recordApiUsage,
  setUsageReportCursor,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

function seed(overrides: Parameters<typeof recordApiUsage>[0] = {}): number {
  return recordApiUsage({
    model: 'claude-opus-4-8',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    estCostUsd: 0.01,
    statusCode: 200,
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  });
}

describe('recordApiUsage / getApiUsageSince', () => {
  it('assigns monotonic ids and reads rows with id > cursor, oldest first', () => {
    const id1 = seed({ runTag: 'a' });
    const id2 = seed({ runTag: 'b' });
    const id3 = seed({ runTag: 'c' });
    expect(id1).toBeLessThan(id2);
    expect(id2).toBeLessThan(id3);

    const all = getApiUsageSince(0, 500);
    expect(all.map((e) => e.id)).toEqual([id1, id2, id3]);
    expect(all[0].runTag).toBe('a');

    const afterFirst = getApiUsageSince(id1, 500);
    expect(afterFirst.map((e) => e.id)).toEqual([id2, id3]);
  });

  it('honors the batch limit for draining', () => {
    for (let i = 0; i < 5; i++) seed();
    const batch = getApiUsageSince(0, 2);
    expect(batch).toHaveLength(2);
  });

  it('maps snake_case columns to camelCase event fields', () => {
    seed({
      runTag: 'run-1',
      model: 'claude-sonnet-5',
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      estCostUsd: 0.5,
      statusCode: 429,
    });
    const [e] = getApiUsageSince(0, 500);
    expect(e).toMatchObject({
      runTag: 'run-1',
      model: 'claude-sonnet-5',
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      estCostUsd: 0.5,
      statusCode: 429,
    });
  });
});

describe('getUsageTotalsSince', () => {
  it('sums all token dimensions and cost from a cutoff', () => {
    seed({ createdAt: '2026-06-30T23:59:59.000Z' }); // before cutoff
    seed({ createdAt: '2026-07-01T12:00:00.000Z' });
    seed({ createdAt: '2026-07-02T12:00:00.000Z' });

    const totals = getUsageTotalsSince('2026-07-01T00:00:00.000Z');
    // Two in-window rows: (100+50+10+5) tokens each = 165 * 2 = 330
    expect(totals.totalTokens).toBe(330);
    expect(totals.totalCostUsd).toBeCloseTo(0.02, 6);
  });

  it('returns zeros with no rows', () => {
    expect(getUsageTotalsSince('2026-01-01T00:00:00.000Z')).toEqual({
      totalTokens: 0,
      totalCostUsd: 0,
    });
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
