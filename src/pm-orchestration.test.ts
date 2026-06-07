import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, recordPmDm, getRecentPmDms } from './db.js';
import {
  classify,
  isBriefEmpty,
  dmCandidates,
  buildPmBrief,
  type PmTask,
} from './pm-orchestration.js';

const DAY = 86_400_000;
const DUE_SOON = 7 * DAY;
const NOW = Date.parse('2026-06-15T00:00:00Z');

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

describe('classify', () => {
  it('marks a task blocked when an upstream is still open', () => {
    const tasks = [
      task({ id: 'A', status: 'open' }),
      task({ id: 'B', upstream: ['A'] }),
    ];
    const c = classify(tasks, NOW, DUE_SOON);
    expect(c.blocked.map((t) => t.id)).toEqual(['B']);
  });

  it('does not mark blocked when all upstreams are done', () => {
    const tasks = [
      task({ id: 'A', status: 'done' }),
      task({ id: 'B', upstream: ['A'] }),
    ];
    expect(classify(tasks, NOW, DUE_SOON).blocked).toEqual([]);
  });

  it('marks a task blocking when a downstream is still open', () => {
    const tasks = [
      task({ id: 'A', downstream: ['B'] }),
      task({ id: 'B', status: 'open' }),
    ];
    const c = classify(tasks, NOW, DUE_SOON);
    expect(c.blocking.map((t) => t.id)).toEqual(['A']);
  });

  it('ignores dangling edge ids', () => {
    const c = classify([task({ id: 'A', upstream: ['ghost'] })], NOW, DUE_SOON);
    expect(c.blocked).toEqual([]);
  });

  it('is cycle-safe (A↔B does not hang)', () => {
    const tasks = [
      task({ id: 'A', upstream: ['B'], downstream: ['B'] }),
      task({ id: 'B', upstream: ['A'], downstream: ['A'] }),
    ];
    const c = classify(tasks, NOW, DUE_SOON);
    expect(c.blocked.map((t) => t.id).sort()).toEqual(['A', 'B']);
    expect(c.blocking.map((t) => t.id).sort()).toEqual(['A', 'B']);
  });

  it('classifies overdue vs due-soon by deadline', () => {
    const tasks = [
      task({ id: 'OVER', deadline: '2026-06-10' }), // past
      task({ id: 'SOON', deadline: '2026-06-18' }), // within 7d
      task({ id: 'FAR', deadline: '2026-08-01' }), // beyond
    ];
    const c = classify(tasks, NOW, DUE_SOON);
    expect(c.overdue.map((t) => t.id)).toEqual(['OVER']);
    expect(c.dueSoon.map((t) => t.id)).toEqual(['SOON']);
  });

  it('excludes done tasks from every category and from load', () => {
    const tasks = [
      task({
        id: 'A',
        status: 'done',
        deadline: '2026-06-10',
        downstream: ['B'],
      }),
      task({ id: 'B', status: 'open' }),
    ];
    const c = classify(tasks, NOW, DUE_SOON);
    expect(c.overdue).toEqual([]);
    expect(c.blocking).toEqual([]); // A is done → not blocking
    expect(c.perOwnerLoad.get('Alice')?.openCount).toBe(1); // only B
  });

  it('sums per-owner open count and estimate, splitting multi-owner', () => {
    const tasks = [
      task({ id: 'A', owners: ['Alice', 'Bob'], estimate: '3' }),
      task({ id: 'B', owners: ['Alice'], estimate: '2' }),
    ];
    const load = classify(tasks, NOW, DUE_SOON).perOwnerLoad;
    expect(load.get('Alice')).toEqual({ openCount: 2, estimateSum: 5 });
    expect(load.get('Bob')).toEqual({ openCount: 1, estimateSum: 3 });
  });
});

describe('isBriefEmpty', () => {
  it('true when nothing is blocked/blocking/overdue/due-soon', () => {
    const c = classify([task({ id: 'A' })], NOW, DUE_SOON);
    expect(isBriefEmpty(c)).toBe(true);
  });
  it('false when there is an overdue item', () => {
    const c = classify([task({ deadline: '2026-06-01' })], NOW, DUE_SOON);
    expect(isBriefEmpty(c)).toBe(false);
  });
});

describe('dmCandidates', () => {
  it('targets blocking + overdue owners, deduped by person/task/reason', () => {
    const tasks = [
      task({ id: 'A', owners: ['Alice'], downstream: ['B'] }),
      task({ id: 'B', owners: ['Bob'], status: 'open' }),
      task({ id: 'C', owners: ['Alice'], deadline: '2026-06-01' }),
    ];
    const cands = dmCandidates(classify(tasks, NOW, DUE_SOON));
    expect(cands).toContainEqual({
      person: 'Alice',
      taskId: 'A',
      reason: 'blocking',
    });
    expect(cands).toContainEqual({
      person: 'Alice',
      taskId: 'C',
      reason: 'overdue',
    });
  });
});

describe('buildPmBrief', () => {
  it('renders sections and the do-not-reping list', () => {
    const tasks = [
      task({
        id: 'A',
        owners: ['Alice'],
        downstream: ['B'],
        deadline: '2026-06-01',
      }),
      task({ id: 'B', owners: ['Bob'], status: 'open' }),
    ];
    const c = classify(tasks, NOW, DUE_SOON);
    const md = buildPmBrief(
      c,
      [{ person: 'Alice', taskId: 'A', reason: 'blocking' }],
      [{ person: 'Carol', taskId: 'Z', reason: 'overdue' }],
      NOW,
    );
    expect(md).toContain('Blocking others');
    expect(md).toContain('Overdue');
    expect(md).toContain('Per-owner load');
    expect(md).toContain('DM these people');
    expect(md).toContain('do NOT re-ping');
    expect(md).toContain('Carol');
  });
});

describe('pm_dm_log helpers', () => {
  beforeEach(() => _initTestDatabase());

  it('records and reads back recent follow-ups; idempotent on key', () => {
    recordPmDm('Alice', 'T1', 'blocking');
    recordPmDm('Alice', 'T1', 'blocking'); // same key → no dup
    const since = new Date(Date.parse('2000-01-01')).toISOString();
    const rows = getRecentPmDms(since);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      person: 'Alice',
      task_id: 'T1',
      reason: 'blocking',
    });
  });

  it('filters out follow-ups older than the cutoff', () => {
    recordPmDm('Bob', 'T2', 'overdue');
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(getRecentPmDms(future)).toEqual([]);
  });
});
