import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  computeAssignments,
  outstandingFor,
  parseConfig,
  planActions,
  quarterWindow,
  resolveDirectory,
  tick,
} from '../peer-reviews.mjs';

const DAY = 86_400_000;
// May 28 2026, local noon — inside the Q2 review window (Q2 ends July 1; a
// 6-week window opens ~May 20).
const MAY_28 = new Date(2026, 4, 28, 12, 0, 0).getTime();
const Q2_END = new Date(2026, 6, 1).getTime();

describe('quarterWindow', () => {
  it('labels the quarter being closed out and opens N weeks before its end', () => {
    const w = quarterWindow(MAY_28, 6);
    expect(w.label).toBe('2026-Q2');
    expect(w.quarterEndMs).toBe(Q2_END);
    expect(w.windowStartMs).toBe(Q2_END - 42 * DAY);
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
    expect(c.windowWeeksBefore).toBe(6);
    expect(c.summaryDaysBeforeEnd).toBe(7);
  });

  it('leaves assignments null when not provided (→ round-robin later)', () => {
    const c = parseConfig('---\nmembers: [a, b, c]\nchannel_jid: dc:1\n---');
    expect(c.assignments).toBeNull();
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
      nowMs: MAY_28,
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
      nowMs: MAY_28,
      cfg,
      members,
      assignments,
      state: {},
      selfEvalDone: none,
      reviewsDone: none,
      dir,
    });
    const soon = planActions({
      nowMs: MAY_28 + DAY,
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
      nowMs: MAY_28,
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
      nowMs: MAY_28 + 4 * DAY,
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
    let now = MAY_28;
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
      nowMs: MAY_28,
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
      nowMs: MAY_28 + DAY,
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
    expect(summary).toMatch(/<@2> \(Bob\): missing/); // bob owes a review
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
    expect(tick({ profileDir, logger, nowMs: MAY_28 })).toBeNull();
  });

  it('no-ops outside the window', () => {
    const jan = new Date(2026, 0, 10).getTime();
    expect(tick({ profileDir, logger, nowMs: jan })).toBeNull();
  });

  it('announces, DMs assignments, persists frozen assignments, is idempotent', () => {
    tick({ profileDir, logger, nowMs: MAY_28 });

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
    tick({ profileDir, logger, nowMs: MAY_28 });
    expect(readIpc('tasks').filter((t) => t.type === 'dm_user')).toHaveLength(3);
    expect(readIpc('messages')).toHaveLength(1);
  });

  it('a filed self-eval + reviews drop those items from the next nudge', () => {
    tick({ profileDir, logger, nowMs: MAY_28 });

    const q = path.join(ctxDir(), 'peer-reviews', '2026-Q2');
    fs.mkdirSync(path.join(q, 'self-eval'), { recursive: true });
    fs.mkdirSync(path.join(q, 'reviews'), { recursive: true });
    fs.writeFileSync(path.join(q, 'self-eval', 'alice.md'), '# self');
    fs.writeFileSync(path.join(q, 'reviews', 'alice--bob.md'), '# review');
    fs.writeFileSync(path.join(q, 'reviews', 'alice--carol.md'), '# review');

    tick({ profileDir, logger, nowMs: MAY_28 + 4 * DAY });
    const second = readIpc('tasks')
      .filter((t) => t.type === 'dm_user')
      .filter((t) => t.target === 'alice');
    // alice was DM'd once (kickoff) and is now complete → no second DM.
    expect(second).toHaveLength(1);
  });
});
