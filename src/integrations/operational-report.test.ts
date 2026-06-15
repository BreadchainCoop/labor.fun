import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from '../db.js';
import {
  periodKey,
  runOperationalReportTick,
  type OperationalReportDeps,
} from './operational-report.js';
import type { PmTask } from '../pm-orchestration.js';

const NOW = Date.parse('2026-06-15T12:00:00Z'); // a Monday

function task(over: Partial<PmTask> = {}): PmTask {
  return {
    id: 'T1',
    title: 'Task one',
    owners: ['Alice'],
    status: 'open',
    upstream: [],
    downstream: [],
    ...over,
  };
}

describe('periodKey', () => {
  it('produces an ISO-week key for weekly', () => {
    expect(periodKey(Date.parse('2026-06-15T00:00:00Z'), 'weekly')).toBe(
      '2026-W24',
    );
  });

  it('produces a YYYY-MM key for monthly', () => {
    expect(periodKey(Date.parse('2026-06-15T00:00:00Z'), 'monthly')).toBe(
      '2026-06',
    );
  });

  it('keeps the same key across a week', () => {
    const mon = periodKey(Date.parse('2026-06-15T00:00:00Z'), 'weekly');
    const fri = periodKey(Date.parse('2026-06-19T00:00:00Z'), 'weekly');
    expect(mon).toBe(fri);
  });
});

describe('runOperationalReportTick', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  function deps(over: Partial<OperationalReportDeps> = {}): {
    deps: OperationalReportDeps;
    sent: string[];
    digests: string[];
  } {
    const sent: string[] = [];
    const digests: string[] = [];
    return {
      sent,
      digests,
      deps: {
        sendMessage: async (_jid, text) => {
          sent.push(text);
        },
        resolveTargetJid: () => 'slack:leaders',
        loadTasks: () => [task()],
        loadCapacities: () => [],
        writeDigest: (md) => digests.push(md),
        now: () => NOW,
        ...over,
      },
    };
  }

  it('posts once and writes a digest', async () => {
    const { deps: d, sent, digests } = deps();
    const r = await runOperationalReportTick(d);
    expect(r.sent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(digests).toHaveLength(1);
  });

  it('does not re-post within the same period (idempotent)', async () => {
    const { deps: d, sent, digests } = deps();
    await runOperationalReportTick(d);
    const r = await runOperationalReportTick(d);
    expect(r.sent).toBe(false);
    expect(sent).toHaveLength(1); // not re-sent
    expect(digests).toHaveLength(2); // digest still refreshed each tick
  });

  it('skips posting when there are no tasks and no members', async () => {
    const { deps: d, sent } = deps({
      loadTasks: () => [],
      loadCapacities: () => [],
    });
    const r = await runOperationalReportTick(d);
    expect(r.sent).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('does not record the period when no target resolves (retries later)', async () => {
    const { deps: d, sent } = deps({ resolveTargetJid: () => null });
    const r1 = await runOperationalReportTick(d);
    expect(r1.sent).toBe(false);
    expect(sent).toHaveLength(0);
    // Target now resolves → it should still post (period wasn't recorded).
    const r2 = await runOperationalReportTick({
      ...d,
      resolveTargetJid: () => 'slack:leaders',
    });
    expect(r2.sent).toBe(true);
    expect(sent).toHaveLength(1);
  });
});
