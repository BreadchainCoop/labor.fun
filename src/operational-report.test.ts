import { describe, it, expect } from 'vitest';

import {
  buildOperationalReport,
  renderOperationalReport,
  type OperationalReport,
} from './operational-report.js';
import type { PmTask } from './pm-orchestration.js';
import type { MemberCapacity } from './member-profiles.js';

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

function cap(over: Partial<MemberCapacity> = {}): MemberCapacity {
  return { name: 'Alice', ...over };
}

describe('buildOperationalReport', () => {
  it('sums per-member load from open task estimates', () => {
    const tasks = [
      task({ id: 'A', owners: ['Alice'], estimate: '3' }),
      task({ id: 'B', owners: ['Alice'], estimate: '2' }),
      task({ id: 'C', owners: ['Bob'], estimate: '5', status: 'done' }),
    ];
    const r = buildOperationalReport(tasks, [], NOW, DUE_SOON);
    const alice = r.members.find((m) => m.name === 'Alice')!;
    expect(alice.openCount).toBe(2);
    expect(alice.estimateSum).toBe(5);
    // Bob's only task is done → no open load, but no capacity either → absent.
    expect(r.members.find((m) => m.name === 'Bob')).toBeUndefined();
    expect(r.totalOpen).toBe(2);
  });

  it('computes a load ratio and soft-flags over-capacity members', () => {
    const tasks = [task({ owners: ['Alice'], estimate: '10' })];
    const r = buildOperationalReport(
      tasks,
      [cap({ capacityPoints: 5 })],
      NOW,
      DUE_SOON,
    );
    const alice = r.members[0];
    expect(alice.loadRatio).toBe(2);
    expect(alice.overloaded).toBe(true);
    expect(r.overloaded.map((m) => m.name)).toEqual(['Alice']);
  });

  it('never flags overload without a declared capacity', () => {
    const tasks = [task({ owners: ['Alice'], estimate: '99' })];
    const r = buildOperationalReport(tasks, [], NOW, DUE_SOON);
    expect(r.members[0].loadRatio).toBeUndefined();
    expect(r.members[0].overloaded).toBe(false);
    expect(r.overloaded).toEqual([]);
  });

  it('respects a custom overload ratio', () => {
    const tasks = [task({ owners: ['Alice'], estimate: '6' })];
    const within = buildOperationalReport(
      tasks,
      [cap({ capacityPoints: 5 })],
      NOW,
      DUE_SOON,
      { overloadRatio: 1.5 },
    );
    expect(within.overloaded).toEqual([]); // 6/5 = 1.2 < 1.5
  });

  it('includes idle members who declared a capacity', () => {
    const r = buildOperationalReport(
      [],
      [cap({ name: 'Carol', capacityPoints: 8 })],
      NOW,
      DUE_SOON,
    );
    const carol = r.members.find((m) => m.name === 'Carol')!;
    expect(carol.openCount).toBe(0);
    expect(carol.overloaded).toBe(false);
  });

  it('groups overdue tasks by team via member profiles', () => {
    const tasks = [
      task({ id: 'A', owners: ['Alice'], deadline: '2026-06-01' }),
      task({ id: 'B', owners: ['Bob'], deadline: '2026-06-02' }),
    ];
    const caps = [
      cap({ name: 'Alice', team: 'Ops' }),
      cap({ name: 'Bob', team: 'Eng' }),
    ];
    const r = buildOperationalReport(tasks, caps, NOW, DUE_SOON);
    expect(r.overdue.map((t) => t.id).sort()).toEqual(['A', 'B']);
    const ops = r.teams.find((t) => t.team === 'Ops')!;
    expect(ops.overdueTasks.map((t) => t.id)).toEqual(['A']);
    const eng = r.teams.find((t) => t.team === 'Eng')!;
    expect(eng.overdueTasks.map((t) => t.id)).toEqual(['B']);
  });

  it('falls back to "No team" for members without a team', () => {
    const tasks = [task({ owners: ['Alice'], deadline: '2026-06-01' })];
    const r = buildOperationalReport(tasks, [], NOW, DUE_SOON);
    const noTeam = r.teams.find((t) => t.team === 'No team')!;
    expect(noTeam.overdueTasks.map((t) => t.id)).toEqual(['T1']);
  });

  it('surfaces bottlenecks (blocking) and blocked from the PM classify', () => {
    const tasks = [
      task({ id: 'A', downstream: ['B'] }),
      task({ id: 'B', upstream: ['A'] }),
    ];
    const r = buildOperationalReport(tasks, [], NOW, DUE_SOON);
    expect(r.blocking.map((t) => t.id)).toEqual(['A']);
    expect(r.blocked.map((t) => t.id)).toEqual(['B']);
  });

  it('joins capacity by slug as well as display name', () => {
    // Owner is the SLUG, not the display name — only the slug key can match.
    const tasks = [task({ owners: ['alice-smith'], estimate: '10' })];
    const r = buildOperationalReport(
      tasks,
      [cap({ name: 'Alice Smith', slug: 'alice-smith', capacityPoints: 4 })],
      NOW,
      DUE_SOON,
    );
    const bySlug = r.members.find((m) => m.name === 'alice-smith')!;
    expect(bySlug.loadRatio).toBe(2.5);
    expect(bySlug.overloaded).toBe(true);
  });
});

describe('renderOperationalReport', () => {
  const tasks = [
    task({
      id: 'A',
      owners: ['Alice'],
      estimate: '10',
      deadline: '2026-06-01',
    }),
    task({ id: 'B', owners: ['Bob'], estimate: '1', downstream: ['A'] }),
  ];
  const caps = [
    cap({
      name: 'Alice',
      team: 'Ops',
      capacityPoints: 5,
      expectedHoursPerWeek: 20,
    }),
    cap({ name: 'Bob', team: 'Eng', capacityPoints: 8 }),
  ];
  const report: OperationalReport = buildOperationalReport(
    tasks,
    caps,
    NOW,
    DUE_SOON,
  );

  it('leaders view shows per-person hours and the unverified caveat', () => {
    const md = renderOperationalReport(report, { audience: 'leaders' });
    expect(md).toContain('declared, not verified');
    expect(md).toContain('| Alice |');
    expect(md).toContain('20h'); // expected hours surfaced
    expect(md).toContain("What's late");
    expect(md).toContain('Bottlenecks');
  });

  it('coop view drops per-person hours for team aggregates', () => {
    const md = renderOperationalReport(report, { audience: 'coop' });
    expect(md).toContain('Load by team');
    expect(md).not.toContain('20h');
    expect(md).not.toContain('declared, not verified');
  });

  it('coop view carries no individual-level signals in the late/bottleneck lists', () => {
    const md = renderOperationalReport(report, { audience: 'coop' });
    expect(md).not.toContain('By person');
    // Owner names appear nowhere — not on overdue lines, not on bottleneck lines.
    expect(md).not.toContain('Alice');
    expect(md).not.toContain('Bob');
    // The leaders view of the same report does name owners.
    const leadersMd = renderOperationalReport(report, { audience: 'leaders' });
    expect(leadersMd).toContain('By person');
    expect(leadersMd).toContain('Alice');
  });

  it('escapes pipes/newlines in free-text table cells', () => {
    const r = buildOperationalReport(
      [task({ owners: ['Eve | DROP'], estimate: '1' })],
      [
        cap({
          name: 'Eve | DROP',
          team: 'A|B',
          capacityPoints: 2,
          payParityNote: 'line1\nline2',
        }),
      ],
      NOW,
      DUE_SOON,
    );
    const md = renderOperationalReport(r, { audience: 'leaders' });
    expect(md).toContain('Eve \\| DROP');
    expect(md).toContain('A\\|B');
    expect(md).toContain('line1 line2');
  });

  it('renders a due-soon section when tasks approach their deadline', () => {
    const r = buildOperationalReport(
      [task({ id: 'SOON', deadline: '2026-06-18' })], // 3 days out from NOW
      [],
      NOW,
      DUE_SOON,
    );
    const md = renderOperationalReport(r);
    expect(md).toContain('## Due soon');
    expect(md).toContain('SOON');
  });

  it('reports a clean slate when nothing is overdue', () => {
    const clean = buildOperationalReport(
      [task({ deadline: '2027-01-01' })],
      [],
      NOW,
      DUE_SOON,
    );
    const md = renderOperationalReport(clean);
    expect(md).toContain('Nothing overdue');
  });
});
