import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  computeAssignments,
  outstandingFor,
  parseConfig,
  planActions,
  reviewWindow,
  resolveDirectory,
  tick,
} from '../peer-reviews.mjs';

const DAY = 86_400_000;
const Q2_END = new Date(2026, 6, 1).getTime();
// June 20 2026, local noon — inside the Q2 review window (default: 3 weeks
// before July 1 → June 10, through 2 weeks after → July 15).
const JUNE_20 = new Date(2026, 5, 20, 12, 0, 0).getTime();

describe('reviewWindow', () => {
  it('reviews the quarter ending next, spanning before+after the boundary', () => {
    const w = reviewWindow(JUNE_20, 3, 2);
    expect(w.label).toBe('2026-Q2');
    expect(w.boundaryMs).toBe(Q2_END);
    expect(w.openMs).toBe(Q2_END - 21 * DAY);
    expect(w.closeMs).toBe(Q2_END + 14 * DAY);
  });

  it('keeps reviewing the just-ended quarter during the after-grace', () => {
    const july5 = new Date(2026, 6, 5).getTime(); // 4 days into Q3
    const w = reviewWindow(july5, 3, 2);
    expect(w.label).toBe('2026-Q2'); // still Q2, not Q3
    expect(w.boundaryMs).toBe(Q2_END);
    expect(july5 < w.closeMs).toBe(true);
  });

  it('rolls to the next boundary once the after-grace passes', () => {
    const july20 = new Date(2026, 6, 20).getTime();
    const w = reviewWindow(july20, 3, 2);
    expect(w.label).toBe('2026-Q3');
    expect(w.boundaryMs).toBe(new Date(2026, 9, 1).getTime());
  });

  it('labels a January boundary as the prior year Q4', () => {
    const dec20 = new Date(2026, 11, 20).getTime();
    const w = reviewWindow(dec20, 3, 2);
    expect(w.label).toBe('2026-Q4');
    expect(w.boundaryMs).toBe(new Date(2027, 0, 1).getTime());
  });
});

describe('parseConfig', () => {
  it('reads members, channel, cadence, and optional assignments', () => {
    const c = parseConfig(
      [
        '---',
        'members:',
        '  - alice',
        '  - bob',
        'channel_jid: dc:7',
        'reviews_required: 3',
        'nudge_every_days: 5',
        'assignments:',
        '  alice: [bob]',
        '  bob: [alice]',
        '---',
        'notes',
      ].join('\n'),
    );
    expect(c.members).toEqual(['alice', 'bob']);
    expect(c.channelJid).toBe('dc:7');
    expect(c.reviewsRequired).toBe(3);
    expect(c.nudgeEveryDays).toBe(5);
    expect(c.assignments).toEqual({ alice: ['bob'], bob: ['alice'] });
    // Defaults for unset knobs.
    expect(c.maxNudges).toBe(4);
    expect(c.windowWeeksBefore).toBe(3);
    expect(c.windowWeeksAfter).toBe(2);
    expect(c.activateOn).toBeNull();
    expect(c.summaryDaysBeforeEnd).toBe(7);
  });

  it('reads activate_on (stringifying a YAML date)', () => {
    const c = parseConfig(
      '---\nmembers: [a, b]\nchannel_jid: dc:1\nactivate_on: 2026-06-30\n---',
    );
    // gray-matter may parse the YAML date to a Date; parseConfig stringifies it.
    expect(typeof c.activateOn).toBe('string');
    expect(Date.parse(c.activateOn)).toBe(Date.parse('2026-06-30'));
  });

  it('leaves assignments null when not provided (→ round-robin later)', () => {
    const c = parseConfig('---\nmembers: [a, b, c]\nchannel_jid: dc:1\n---');
    expect(c.assignments).toBeNull();
  });

  it('reads the optional collaborators map, null when absent', () => {
    const c = parseConfig(
      [
        '---',
        'members: [a, b, c]',
        'channel_jid: dc:1',
        'collaborators:',
        '  a: [c]',
        '---',
      ].join('\n'),
    );
    expect(c.collaborators).toEqual({ a: ['c'] });
    const bare = parseConfig('---\nmembers: [a, b]\nchannel_jid: dc:1\n---');
    expect(bare.collaborators).toBeNull();
  });
});

describe('computeAssignments (round-robin)', () => {
  it('gives each member the next `count`, wrapping; everyone gives & receives count', () => {
    const a = computeAssignments(['a', 'b', 'c', 'd'], 2);
    expect(a).toEqual({
      a: ['b', 'c'],
      b: ['c', 'd'],
      c: ['d', 'a'],
      d: ['a', 'b'],
    });
    // Every member is reviewed exactly twice.
    const received = {};
    for (const reviewees of Object.values(a)) {
      for (const r of reviewees) received[r] = (received[r] ?? 0) + 1;
    }
    expect(received).toEqual({ a: 2, b: 2, c: 2, d: 2 });
  });

  it('degrades gracefully when there are too few members for `count`', () => {
    expect(computeAssignments(['a', 'b'], 2)).toEqual({ a: ['b'], b: ['a'] });
    expect(computeAssignments(['a'], 2)).toEqual({ a: [] });
  });

  it('with no collaboration data, hybrid output is EXACTLY the old round-robin', () => {
    const members = ['a', 'b', 'c', 'd', 'e', 'f'];
    const legacy = {
      a: ['b', 'c'],
      b: ['c', 'd'],
      c: ['d', 'e'],
      d: ['e', 'f'],
      e: ['f', 'a'],
      f: ['a', 'b'],
    };
    expect(computeAssignments(members, 2)).toEqual(legacy);
    expect(computeAssignments(members, 2, null)).toEqual(legacy);
    expect(computeAssignments(members, 2, {})).toEqual(legacy);
  });
});

describe('computeAssignments (collaboration-seeded hybrid, issue #135)', () => {
  // Invariants that must hold for ANY input: everyone reviews exactly
  // min(count, n-1) people, is reviewed the same number of times, never
  // themselves, never the same pair twice.
  function checkBalance(asg, members, count) {
    const per = Math.min(count, members.length - 1);
    const received = Object.fromEntries(members.map((m) => [m, 0]));
    for (const [reviewer, reviewees] of Object.entries(asg)) {
      expect(reviewees).toHaveLength(per);
      expect(new Set(reviewees).size).toBe(reviewees.length); // no dup pairs
      expect(reviewees).not.toContain(reviewer); // no self
      for (const r of reviewees) received[r] += 1;
    }
    for (const m of members) expect(received[m]).toBe(per);
  }

  it('assigns collaborators instead of alphabetical neighbors (issue #135 case)', () => {
    // Mirrors the mispairing from the issue: rathermercurial-eth got roloide +
    // ron purely by alphabet, while their actual collaborators (unai-mettodo,
    // marv) weren't assigned at all.
    const members = [
      'marv',
      'otreblig',
      'rade',
      'rathermercurial-eth',
      'roloide',
      'ron',
      'unai-mettodo',
    ];
    const collaborators = { 'rathermercurial-eth': ['unai-mettodo', 'marv'] };
    const asg = computeAssignments(members, 2, collaborators);
    expect(asg['rathermercurial-eth'].sort()).toEqual(['marv', 'unai-mettodo']);
    checkBalance(asg, members, 2);
  });

  it('treats collaboration edges as symmetric (one direction listed is enough)', () => {
    const members = ['a', 'b', 'c', 'd'];
    // Only a lists d — d should still prefer a right back.
    const asg = computeAssignments(members, 2, { a: ['d'] });
    expect(asg.a).toContain('d');
    expect(asg.d).toContain('a');
    checkBalance(asg, members, 2);
  });

  it('fills non-collaborator slots round-robin without losing balance', () => {
    const members = ['a', 'b', 'c', 'd', 'e'];
    const asg = computeAssignments(members, 2, { a: ['c'] });
    // a's collab slot is honored (both directions); the rest is roster fill.
    expect(asg.a).toContain('c');
    expect(asg.c).toContain('a');
    checkBalance(asg, members, 2);
  });

  it('ignores unknown slugs and self-edges in the collaborators map', () => {
    const members = ['a', 'b', 'c', 'd'];
    const asg = computeAssignments(members, 2, {
      a: ['a', 'zed', 'c'],
      ghost: ['b'],
    });
    expect(asg.a).toContain('c');
    checkBalance(asg, members, 2);
  });

  it('keeps balance invariants on odd-sized and small cohorts', () => {
    const cases = [
      { members: ['a', 'b', 'c'], collab: { a: ['c'] } },
      { members: ['a', 'b', 'c', 'd'], collab: { a: ['c'], b: ['d'] } },
      {
        members: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
        // Two tight cliques — everyone's preferences point inward.
        collab: {
          a: ['b', 'c', 'd'],
          b: ['c', 'd'],
          c: ['d'],
          e: ['f', 'g', 'h'],
          f: ['g', 'h'],
          g: ['h'],
        },
      },
    ];
    for (const { members, collab } of cases) {
      checkBalance(computeAssignments(members, 2, collab), members, 2);
    }
  });

  it('is deterministic for a given input', () => {
    const members = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const collab = { a: ['e', 'f'], b: ['g'], c: ['a'] };
    const first = computeAssignments(members, 2, collab);
    for (let i = 0; i < 5; i++) {
      expect(computeAssignments(members, 2, collab)).toEqual(first);
    }
  });
});

describe('outstandingFor', () => {
  const asg = { alice: ['bob', 'carol'] };
  it('lists self-eval + each unfiled assigned review', () => {
    const items = outstandingFor('alice', asg, new Set(), new Set());
    expect(items).toEqual([
      { type: 'self-eval' },
      { type: 'review', reviewee: 'bob' },
      { type: 'review', reviewee: 'carol' },
    ]);
  });
  it('drops items that are filed', () => {
    const items = outstandingFor(
      'alice',
      asg,
      new Set(['alice']),
      new Set(['alice--bob']),
    );
    expect(items).toEqual([{ type: 'review', reviewee: 'carol' }]);
  });
  it('is empty when everything is filed', () => {
    expect(
      outstandingFor(
        'alice',
        asg,
        new Set(['alice']),
        new Set(['alice--bob', 'alice--carol']),
      ),
    ).toEqual([]);
  });
});

describe('planActions — nudge + tracking state machine', () => {
  const members = ['alice', 'bob', 'carol'];
  const assignments = computeAssignments(members, 2);
  const cfg = {
    label: '2026-Q2',
    quarterEndMs: Q2_END,
    nudgeEveryDays: 4,
    maxNudges: 2,
    summaryDaysBeforeEnd: 7,
  };
  const dir = {
    alice: { id: '1', name: 'Alice' },
    bob: { id: '2', name: 'Bob' },
    carol: { id: '3', name: 'Carol' },
  };
  const none = new Set();

  it('first tick: announces (with mentions) and DMs everyone their items', () => {
    const p = planActions({
      nowMs: JUNE_20,
      cfg,
      members,
      assignments,
      state: {},
      selfEvalDone: none,
      reviewsDone: none,
      dir,
    });
    expect(p.posts).toHaveLength(1);
    expect(p.posts[0]).toContain('<@1> (Alice)');
    expect(p.dms.map((d) => d.slug).sort()).toEqual(['alice', 'bob', 'carol']);
    // DM lists self-eval + the two assigned reviews by readable name.
    const aliceDm = p.dms.find((d) => d.slug === 'alice').text;
    expect(aliceDm).toContain('your self-evaluation');
    expect(aliceDm).toContain('a peer review of Bob');
    expect(aliceDm).toContain('a peer review of Carol');
    // Assignments are frozen into state.
    expect(p.state.assignments).toEqual(assignments);
  });

  it('does not re-DM inside the nudge interval', () => {
    const first = planActions({
      nowMs: JUNE_20,
      cfg,
      members,
      assignments,
      state: {},
      selfEvalDone: none,
      reviewsDone: none,
      dir,
    });
    const soon = planActions({
      nowMs: JUNE_20 + DAY,
      cfg,
      members,
      assignments,
      state: first.state,
      selfEvalDone: none,
      reviewsDone: none,
      dir,
    });
    expect(soon.dms).toHaveLength(0);
  });

  it('stops nudging a member once all their items are filed', () => {
    const first = planActions({
      nowMs: JUNE_20,
      cfg,
      members,
      assignments,
      state: {},
      selfEvalDone: none,
      reviewsDone: none,
      dir,
    });
    // alice completes everything: self-eval + reviews of bob and carol.
    const later = planActions({
      nowMs: JUNE_20 + 4 * DAY,
      cfg,
      members,
      assignments,
      state: first.state,
      selfEvalDone: new Set(['alice']),
      reviewsDone: new Set(['alice--bob', 'alice--carol']),
      dir,
    });
    expect(later.dms.map((d) => d.slug)).not.toContain('alice');
    // bob still owes things → still nudged.
    expect(later.dms.map((d) => d.slug)).toContain('bob');
  });

  it('escalates a stuck member once in the channel, then goes quiet', () => {
    let state = {};
    let now = JUNE_20;
    for (let i = 0; i < 2; i++) {
      state = planActions({
        nowMs: now,
        cfg,
        members: ['alice'],
        assignments: { alice: ['bob'] },
        state,
        selfEvalDone: none,
        reviewsDone: none,
        dir,
      }).state;
      now += 4 * DAY;
    }
    const esc = planActions({
      nowMs: now,
      cfg,
      members: ['alice'],
      assignments: { alice: ['bob'] },
      state,
      selfEvalDone: none,
      reviewsDone: none,
      dir,
    });
    expect(esc.dms).toHaveLength(0);
    expect(esc.posts.some((x) => x.includes('<@1> (Alice)'))).toBe(true);
    const after = planActions({
      nowMs: now + 4 * DAY,
      cfg,
      members: ['alice'],
      assignments: { alice: ['bob'] },
      state: esc.state,
      selfEvalDone: none,
      reviewsDone: none,
      dir,
    });
    expect(after.dms).toHaveLength(0);
    expect(after.posts).toHaveLength(0);
  });

  it('posts an all-clear summary exactly once when everyone is complete', () => {
    const allSelf = new Set(members);
    const allReviews = new Set(
      Object.entries(assignments).flatMap(([r, rs]) =>
        rs.map((re) => `${r}--${re}`),
      ),
    );
    const first = planActions({
      nowMs: JUNE_20,
      cfg,
      members,
      assignments,
      state: {},
      selfEvalDone: allSelf,
      reviewsDone: allReviews,
      dir,
    });
    expect(first.posts.some((p) => p.includes('complete'))).toBe(true);
    expect(first.dms).toHaveLength(0);
    const again = planActions({
      nowMs: JUNE_20 + DAY,
      cfg,
      members,
      assignments,
      state: first.state,
      selfEvalDone: allSelf,
      reviewsDone: allReviews,
      dir,
    });
    expect(again.posts).toHaveLength(0);
  });

  it('posts a status summary at the deadline listing who is missing what', () => {
    const nearEnd = Q2_END - 6 * DAY; // inside summary_days_before_end=7
    const p = planActions({
      nowMs: nearEnd,
      cfg,
      members,
      assignments,
      state: { announcedAt: 'x', members: {} }, // skip announce noise
      selfEvalDone: new Set(['alice', 'bob', 'carol']),
      reviewsDone: new Set(['alice--bob', 'alice--carol', 'bob--carol']),
      dir,
    });
    const summary = p.posts.find((x) => x.includes('status'));
    expect(summary).toBeDefined();
    expect(summary).toContain('✅ complete'); // alice fully done
    expect(summary).toMatch(/<@2> \(Bob\): still to file/); // bob owes a review
  });
});

describe('planActions — auto-scheduling pass', () => {
  const members = ['alice', 'bob', 'carol'];
  const assignments = computeAssignments(members, 2); // mutual pairs (a↔b etc.)
  const cfg = {
    label: '2026-Q2',
    quarterEndMs: Q2_END,
    nudgeEveryDays: 4,
    maxNudges: 4,
    summaryDaysBeforeEnd: 7,
  };
  const dir = {
    alice: { id: '1', name: 'Alice' },
    bob: { id: '2', name: 'Bob' },
    carol: { id: '3', name: 'Carol' },
  };
  const base = {
    nowMs: JUNE_20,
    cfg,
    members,
    assignments,
    selfEvalDone: new Set(),
    reviewsDone: new Set(),
    dir,
    autoSchedule: true,
  };

  it('off by default: no matchTasks and no availability prompt', () => {
    const p = planActions({
      ...base,
      autoSchedule: false,
      state: {},
      availability: new Set(),
      meetings: new Set(),
    });
    expect(p.matchTasks).toEqual([]);
    expect(p.dms[0].text).not.toContain('free **this week**');
  });

  it('first DM asks for availability when auto-scheduling is on', () => {
    const p = planActions({
      ...base,
      state: {},
      availability: new Set(),
      meetings: new Set(),
    });
    expect(p.dms[0].text).toContain('free **this week**');
    // No one has filed availability yet → nothing to match.
    expect(p.matchTasks).toEqual([]);
  });

  it('kicks a match task once both in a pair have filed availability', () => {
    const p = planActions({
      ...base,
      state: {},
      availability: new Set(['alice', 'bob']), // carol hasn't answered
      meetings: new Set(),
    });
    const keys = p.matchTasks.map((m) => m.key);
    expect(keys).toContain('alice--bob');
    // Pairs needing carol can't match yet.
    expect(keys).not.toContain('alice--carol');
    expect(keys).not.toContain('bob--carol');
    expect(p.state.matchKicked['alice--bob']).toBeTruthy();
  });

  it('schedules ONE meeting per unordered pair (mutual reviews dedup)', () => {
    // a→b and b→a both outstanding → a single alice--bob meeting.
    const p = planActions({
      ...base,
      state: {},
      availability: new Set(['alice', 'bob', 'carol']),
      meetings: new Set(),
    });
    const ab = p.matchTasks.filter((m) => m.key === 'alice--bob');
    expect(ab).toHaveLength(1);
  });

  it('does not re-kick a pair within the retry window, nor when booked', () => {
    const first = planActions({
      ...base,
      state: {},
      availability: new Set(['alice', 'bob', 'carol']),
      meetings: new Set(),
    });
    // Same day → no re-kick.
    const soon = planActions({
      ...base,
      nowMs: JUNE_20 + 3600_000,
      state: first.state,
      availability: new Set(['alice', 'bob', 'carol']),
      meetings: new Set(),
    });
    expect(soon.matchTasks).toEqual([]);
    // Once the meeting file exists, never again.
    const booked = planActions({
      ...base,
      nowMs: JUNE_20 + 5 * DAY,
      state: first.state,
      availability: new Set(['alice', 'bob', 'carol']),
      meetings: new Set(['alice--bob', 'alice--carol', 'bob--carol']),
    });
    expect(booked.matchTasks).toEqual([]);
  });

  it('re-kicks after the retry window if no meeting got recorded (self-heal)', () => {
    const first = planActions({
      ...base,
      state: {},
      availability: new Set(['alice', 'bob']),
      meetings: new Set(),
    });
    const later = planActions({
      ...base,
      nowMs: JUNE_20 + 2 * DAY, // > 1-day retry, still no meetings/alice--bob.md
      state: first.state,
      availability: new Set(['alice', 'bob']),
      meetings: new Set(),
    });
    expect(later.matchTasks.map((m) => m.key)).toContain('alice--bob');
  });

  it('skips a pair whose review is already filed', () => {
    const p = planActions({
      ...base,
      state: {},
      availability: new Set(['alice', 'bob', 'carol']),
      // both directions of alice--bob filed → no meeting needed for that pair
      reviewsDone: new Set(['alice--bob', 'bob--alice']),
      meetings: new Set(),
    });
    expect(p.matchTasks.map((m) => m.key)).not.toContain('alice--bob');
  });
});

describe('matchTaskIpc', () => {
  it('builds a once schedule_task targeting the channel with the pair paths', async () => {
    const { matchTaskIpc } = await import('../peer-reviews.mjs');
    const t = matchTaskIpc({
      label: '2026-Q2',
      pair: { a: 'alice', b: 'bob', key: 'alice--bob' },
      channelJid: 'dc:9',
      nowMs: Date.parse('2026-06-20T12:00:00Z'),
    });
    expect(t).toMatchObject({
      type: 'schedule_task',
      schedule_type: 'once',
      context_mode: 'isolated',
      targetJid: 'dc:9',
    });
    expect(t.prompt).toContain('availability/alice.md');
    expect(t.prompt).toContain('meetings/alice--bob.md');
    expect(t.schedule_value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });
});

describe('resolveDirectory', () => {
  let ctxDir;
  beforeEach(() => {
    ctxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-people-'));
    fs.mkdirSync(path.join(ctxDir, 'people'), { recursive: true });
    fs.writeFileSync(
      path.join(ctxDir, 'people', 'alice.md'),
      "---\ndiscord_id: '111'\ntitle: Alice A\n---\n",
    );
    fs.writeFileSync(
      path.join(ctxDir, 'people', 'bob.md'),
      '---\ntitle: Bob\n---\n', // no discord_id
    );
  });
  afterEach(() => fs.rmSync(ctxDir, { recursive: true, force: true }));

  it('maps id + readable name, falling back to the slug', () => {
    const d = resolveDirectory(ctxDir, ['alice', 'bob', 'carol']);
    expect(d.alice).toEqual({ id: '111', name: 'Alice A' });
    expect(d.bob).toEqual({ id: null, name: 'Bob' });
    expect(d.carol).toEqual({ id: null, name: 'carol' });
  });
});

describe('tick — filesystem integration against a temp profile', () => {
  let profileDir;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const ctxDir = () =>
    path.join(profileDir, 'groups', 'kb_main', 'context');
  const ipcDir = (sub) =>
    path.join(profileDir, 'data', 'ipc', 'kb_main', sub);
  const readIpc = (sub) => {
    const d = ipcDir(sub);
    return fs.existsSync(d)
      ? fs
          .readdirSync(d)
          .filter((f) => f.endsWith('.json'))
          .map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf-8')))
      : [];
  };

  beforeEach(() => {
    vi.clearAllMocks();
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-reviews-'));
    fs.writeFileSync(
      path.join(profileDir, 'profile.config.json'),
      JSON.stringify({ sharedKbGroup: 'kb_main' }),
    );
    fs.mkdirSync(path.join(ctxDir(), 'peer-reviews'), { recursive: true });
    fs.writeFileSync(
      path.join(ctxDir(), 'peer-reviews', 'config.md'),
      [
        '---',
        'members:',
        '  - alice',
        '  - bob',
        '  - carol',
        'channel_jid: dc:999',
        '---',
      ].join('\n'),
    );
    fs.mkdirSync(path.join(ctxDir(), 'people'), { recursive: true });
    fs.writeFileSync(
      path.join(ctxDir(), 'people', 'alice.md'),
      "---\ndiscord_id: '111'\ntitle: Alice\n---\n",
    );
  });

  afterEach(() => fs.rmSync(profileDir, { recursive: true, force: true }));

  it('no-ops without config.md', () => {
    fs.rmSync(path.join(ctxDir(), 'peer-reviews', 'config.md'));
    expect(tick({ profileDir, logger, nowMs: JUNE_20 })).toBeNull();
  });

  it('no-ops outside the window (mid-quarter, far from any boundary)', () => {
    const feb15 = new Date(2026, 1, 15).getTime();
    expect(tick({ profileDir, logger, nowMs: feb15 })).toBeNull();
  });

  it('stays dormant until activate_on, then runs', () => {
    fs.writeFileSync(
      path.join(ctxDir(), 'peer-reviews', 'config.md'),
      [
        '---',
        'members: [alice, bob, carol]',
        'channel_jid: dc:999',
        'activate_on: 2026-06-25',
        '---',
      ].join('\n'),
    );
    // In-window but before activate_on → dormant, no IPC.
    expect(tick({ profileDir, logger, nowMs: JUNE_20 })).toBeNull();
    expect(readIpc('messages')).toHaveLength(0);
    // After activate_on → runs.
    const june26 = new Date(2026, 5, 26, 12).getTime();
    tick({ profileDir, logger, nowMs: june26 });
    expect(readIpc('messages').length).toBeGreaterThan(0);
  });

  it('announces, DMs assignments, persists frozen assignments, is idempotent', () => {
    tick({ profileDir, logger, nowMs: JUNE_20 });

    const dms = readIpc('tasks').filter((t) => t.type === 'dm_user');
    expect(dms.map((d) => d.target).sort()).toEqual(['alice', 'bob', 'carol']);
    expect(dms[0].sourceJid).toBe('dc:999');

    const posts = readIpc('messages');
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain('<@111> (Alice)'); // alice mention-tagged

    const state = JSON.parse(
      fs.readFileSync(
        path.join(ctxDir(), 'peer-reviews', 'state', '2026-Q2.json'),
        'utf-8',
      ),
    );
    expect(state.assignments).toEqual(
      computeAssignments(['alice', 'bob', 'carol'], 2),
    );

    // Same instant again → no duplicate IPC.
    tick({ profileDir, logger, nowMs: JUNE_20 });
    expect(readIpc('tasks').filter((t) => t.type === 'dm_user')).toHaveLength(3);
    expect(readIpc('messages')).toHaveLength(1);
  });

  it('uses collaborators from config.md when computing assignments', () => {
    fs.writeFileSync(
      path.join(ctxDir(), 'peer-reviews', 'config.md'),
      [
        '---',
        'members: [alice, bob, carol, dave]',
        'channel_jid: dc:999',
        'collaborators:',
        '  alice: [carol]',
        '---',
      ].join('\n'),
    );
    tick({ profileDir, logger, nowMs: JUNE_20 });
    const state = JSON.parse(
      fs.readFileSync(
        path.join(ctxDir(), 'peer-reviews', 'state', '2026-Q2.json'),
        'utf-8',
      ),
    );
    expect(state.assignments).toEqual(
      computeAssignments(['alice', 'bob', 'carol', 'dave'], 2, {
        alice: ['carol'],
      }),
    );
    expect(state.assignments.alice).toContain('carol');
  });

  it('a filed self-eval + reviews drop those items from the next nudge', () => {
    tick({ profileDir, logger, nowMs: JUNE_20 });

    const q = path.join(ctxDir(), 'peer-reviews', '2026-Q2');
    fs.mkdirSync(path.join(q, 'self-eval'), { recursive: true });
    fs.mkdirSync(path.join(q, 'reviews'), { recursive: true });
    fs.writeFileSync(path.join(q, 'self-eval', 'alice.md'), '# self');
    fs.writeFileSync(path.join(q, 'reviews', 'alice--bob.md'), '# review');
    fs.writeFileSync(path.join(q, 'reviews', 'alice--carol.md'), '# review');

    tick({ profileDir, logger, nowMs: JUNE_20 + 4 * DAY });
    const second = readIpc('tasks')
      .filter((t) => t.type === 'dm_user')
      .filter((t) => t.target === 'alice');
    // alice was DM'd once (kickoff) and is now complete → no second DM.
    expect(second).toHaveLength(1);
  });

  it('with auto_schedule: emits a meeting schedule_task once a pair has availability', () => {
    fs.writeFileSync(
      path.join(ctxDir(), 'peer-reviews', 'config.md'),
      [
        '---',
        'members: [alice, bob, carol]',
        'channel_jid: dc:999',
        'auto_schedule: true',
        '---',
      ].join('\n'),
    );
    tick({ profileDir, logger, nowMs: JUNE_20 });
    // Kickoff DMs ask for availability.
    expect(
      readIpc('tasks').find((t) => t.type === 'dm_user').text,
    ).toContain('free **this week**');
    // No availability filed yet → no meeting task.
    expect(
      readIpc('tasks').filter((t) => t.type === 'schedule_task'),
    ).toHaveLength(0);

    // alice + bob file availability.
    const avail = path.join(ctxDir(), 'peer-reviews', '2026-Q2', 'availability');
    fs.mkdirSync(avail, { recursive: true });
    fs.writeFileSync(path.join(avail, 'alice.md'), '# a');
    fs.writeFileSync(path.join(avail, 'bob.md'), '# b');

    tick({ profileDir, logger, nowMs: JUNE_20 + 4 * DAY });
    const meet = readIpc('tasks').filter((t) => t.type === 'schedule_task');
    expect(meet).toHaveLength(1);
    expect(meet[0].prompt).toContain('alice--bob');
    expect(meet[0].targetJid).toBe('dc:999');
  });
});
