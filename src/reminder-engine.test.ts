import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _initTestDatabase, recordReminderFired } from './db.js';
import {
  parseDurationToMs,
  parseDeadline,
  parseLadder,
  selectRung,
  isDoneStatus,
  buildDeadlineDigest,
  runReminderSweep,
  type DeadlineItem,
} from './reminder-engine.js';

const DAY = 86_400_000;
const LADDER = parseLadder(['3w', '1w', '3d', '1d']);
const DEADLINE = Date.parse('2026-07-01T00:00:00Z');

function at(daysBeforeDeadline: number): number {
  return DEADLINE - daysBeforeDeadline * DAY;
}

describe('parseDurationToMs', () => {
  it('parses w/d/h/m units', () => {
    expect(parseDurationToMs('3w')).toBe(3 * 7 * DAY);
    expect(parseDurationToMs('1d')).toBe(DAY);
    expect(parseDurationToMs('12h')).toBe(12 * 3_600_000);
    expect(parseDurationToMs('30m')).toBe(30 * 60_000);
    expect(parseDurationToMs(' 2D ')).toBe(2 * DAY);
  });
  it('returns 0 for garbage', () => {
    expect(parseDurationToMs('')).toBe(0);
    expect(parseDurationToMs('soon')).toBe(0);
    expect(parseDurationToMs('3y')).toBe(0);
  });
});

describe('parseDeadline', () => {
  it('treats a bare date as end-of-day UTC, not start', () => {
    expect(parseDeadline('2026-07-01')).toBe(
      Date.parse('2026-07-01T23:59:59.999Z'),
    );
  });
  it('passes through full datetimes unchanged', () => {
    expect(parseDeadline('2026-07-01T08:30:00Z')).toBe(
      Date.parse('2026-07-01T08:30:00Z'),
    );
  });
  it('is NaN for garbage', () => {
    expect(Number.isNaN(parseDeadline('whenever'))).toBe(true);
  });
});

describe('parseLadder', () => {
  it('sorts ascending by ms and drops invalid specs', () => {
    const l = parseLadder(['1w', 'nope', '1d', '3w']);
    expect(l.map((r) => r.label)).toEqual(['1d', '1w', '3w']);
  });
});

describe('isDoneStatus', () => {
  it('recognizes terminal statuses case-insensitively', () => {
    for (const s of ['done', 'Completed', 'CANCELLED', 'ready', 'closed']) {
      expect(isDoneStatus(s)).toBe(true);
    }
    for (const s of ['open', 'in_progress', 'blocked', undefined]) {
      expect(isDoneStatus(s)).toBe(false);
    }
  });
});

describe('selectRung', () => {
  const cases: Array<
    [number, string | null, 'reminder' | 'escalation' | null]
  > = [
    [25, null, null], // beyond the widest rung
    [21, '3w', 'reminder'], // exactly T-3w
    [20, '3w', 'reminder'],
    [8, '3w', 'reminder'], // 1w window not yet reached (8d > 7d)
    [7, '1w', 'reminder'], // exactly T-1w
    [5, '1w', 'reminder'],
    [3, '3d', 'reminder'], // exactly T-3d
    [2, '3d', 'reminder'],
    [1, '1d', 'escalation'], // final rung loops in escalation
    [0.5, '1d', 'escalation'],
  ];

  for (const [days, rung, kind] of cases) {
    it(`T-${days}d → ${rung ?? 'null'}`, () => {
      const d = selectRung(at(days), DEADLINE, LADDER, false);
      if (rung === null) {
        expect(d).toBeNull();
      } else {
        expect(d).toEqual({ rung, kind });
      }
    });
  }

  it('escalates OVERDUE once the deadline passes', () => {
    expect(selectRung(DEADLINE + DAY, DEADLINE, LADDER, false)).toEqual({
      rung: 'OVERDUE',
      kind: 'escalation',
    });
  });

  it('never reminds about done items', () => {
    expect(selectRung(at(1), DEADLINE, LADDER, true)).toBeNull();
    expect(selectRung(DEADLINE + DAY, DEADLINE, LADDER, true)).toBeNull();
  });

  it('returns null for an empty ladder', () => {
    expect(selectRung(at(1), DEADLINE, [], false)).toBeNull();
  });
});

describe('runReminderSweep', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  function item(overrides: Partial<DeadlineItem> = {}): DeadlineItem {
    return {
      id: 'TASK-001',
      title: 'Ship the thing',
      // Explicit datetime so the rung math here is independent of the
      // date-only "end of day" normalization (covered separately below).
      deadline: '2026-07-01T00:00:00Z',
      owners: ['Alice'],
      status: 'open',
      ...overrides,
    };
  }

  const base = {
    ladder: LADDER,
    targetJid: 'dc:team',
    escalationDefault: 'Boss',
  };

  it('fires a due rung exactly once across repeated sweeps', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const input = { ...base, nowMs: at(2), items: [item()], sendMessage: send };

    const r1 = await runReminderSweep(input);
    expect(r1.fired).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe('dc:team');
    expect(send.mock.calls[0][1]).toContain('TASK-001');

    const r2 = await runReminderSweep(input);
    expect(r2.fired).toBe(0);
    expect(send).toHaveBeenCalledTimes(1); // not re-sent
  });

  it('advances to the next rung as the deadline approaches', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await runReminderSweep({
      ...base,
      nowMs: at(2),
      items: [item()],
      sendMessage: send,
    }); // 3d
    await runReminderSweep({
      ...base,
      nowMs: at(1),
      items: [item()],
      sendMessage: send,
    }); // 1d escalation
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1]).toMatch(/imminent/i);
  });

  it('names the escalation contact on the final tick', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await runReminderSweep({
      ...base,
      nowMs: at(1),
      items: [item({ escalationContact: 'Carol' })],
      sendMessage: send,
    });
    expect(send.mock.calls[0][1]).toContain('Carol');
  });

  it('does not send or record when no target JID is resolved', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const r = await runReminderSweep({
      ...base,
      targetJid: null,
      nowMs: at(2),
      items: [item()],
      sendMessage: send,
    });
    expect(send).not.toHaveBeenCalled();
    expect(r.fired).toBe(0);
    // A later sweep with a target should still fire (nothing was recorded).
    const r2 = await runReminderSweep({
      ...base,
      nowMs: at(2),
      items: [item()],
      sendMessage: send,
    });
    expect(r2.fired).toBe(1);
  });

  it('retries on the next sweep after a transient send failure', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(undefined);
    await runReminderSweep({
      ...base,
      nowMs: at(2),
      items: [item()],
      sendMessage: send,
    });
    // Failed → not recorded → retried next sweep and succeeds.
    const r2 = await runReminderSweep({
      ...base,
      nowMs: at(2),
      items: [item()],
      sendMessage: send,
    });
    expect(r2.fired).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('skips items with an unparseable deadline', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const r = await runReminderSweep({
      ...base,
      nowMs: at(2),
      items: [item({ deadline: 'whenever' })],
      sendMessage: send,
    });
    expect(r.checked).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('re-fires after a deadline moves later', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    // Pretend the 1d rung already fired against the original deadline.
    recordReminderFired('TASK-001', '1d', '2026-07-01T00:00:00Z');
    // Deadline moved out a month; now we're 2 days before the NEW deadline.
    const newDeadline = '2026-08-01T00:00:00Z';
    const newMs = Date.parse(newDeadline);
    await runReminderSweep({
      ...base,
      nowMs: newMs - 2 * DAY,
      items: [item({ deadline: newDeadline })],
      sendMessage: send,
    });
    expect(send).toHaveBeenCalledTimes(1); // old rung reset → 3d fires anew
  });
});

describe('buildDeadlineDigest', () => {
  it('groups by week and by owner', () => {
    const now = Date.parse('2026-06-15T00:00:00Z'); // a Monday
    const items: DeadlineItem[] = [
      {
        id: 'T1',
        title: 'Overdue one',
        deadline: '2026-06-10',
        owners: ['Al'],
      },
      { id: 'T2', title: 'This week', deadline: '2026-06-17', owners: ['Bo'] },
      {
        id: 'T3',
        title: 'Later',
        deadline: '2026-07-20',
        owners: ['Al', 'Bo'],
      },
      { id: 'T4', title: 'No date', deadline: 'nope', owners: ['Al'] },
    ];
    const md = buildDeadlineDigest(items, now);
    expect(md).toContain('## By week');
    expect(md).toContain('### Overdue');
    expect(md).toContain('### This week');
    expect(md).toContain('## By owner');
    expect(md).toContain('### Al');
    expect(md).toContain('### Bo');
    // Unparseable deadline excluded from the count line and listings.
    expect(md).toContain('3 item(s)');
    expect(md).not.toContain('No date');
  });
});
