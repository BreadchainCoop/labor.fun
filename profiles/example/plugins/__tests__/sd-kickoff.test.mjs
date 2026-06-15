import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parseCommittee,
  planActions,
  quarterWindow,
  resolveDiscordIds,
  tick,
} from '../sd-kickoff.mjs';

const DAY = 86_400_000;
// June 15 2026, local noon — inside the Q3 kickoff window (June 3 → July 1).
const JUNE_15 = new Date(2026, 5, 15, 12, 0, 0).getTime();

describe('quarterWindow', () => {
  it('plans the NEXT quarter and opens N weeks before quarter end', () => {
    const w = quarterWindow(JUNE_15, 4);
    expect(w.label).toBe('2026-Q3');
    expect(w.quarterEndMs).toBe(new Date(2026, 6, 1).getTime());
    expect(w.windowStartMs).toBe(w.quarterEndMs - 28 * DAY);
  });

  it('rolls the label into next year from Q4', () => {
    const dec = new Date(2026, 11, 20).getTime();
    expect(quarterWindow(dec, 4).label).toBe('2027-Q1');
  });

  it('honours a custom window size', () => {
    const w = quarterWindow(JUNE_15, 2);
    expect(w.windowStartMs).toBe(w.quarterEndMs - 14 * DAY);
  });
});

describe('parseCommittee', () => {
  it('reads roster, channel, and cadence knobs from frontmatter', () => {
    const c = parseCommittee(
      [
        '---',
        'members:',
        '  - alice',
        '  - bob',
        'channel_jid: dc:111',
        'nudge_every_days: 2',
        'max_nudges: 3',
        '---',
        'Roster notes.',
      ].join('\n'),
    );
    expect(c.members).toEqual(['alice', 'bob']);
    expect(c.channelJid).toBe('dc:111');
    expect(c.nudgeEveryDays).toBe(2);
    expect(c.maxNudges).toBe(3);
    // Defaults applied for unspecified knobs.
    expect(c.kickoffWeeksBefore).toBe(4);
    expect(c.draftDaysBeforeEnd).toBe(7);
  });
});

describe('planActions — nudge ladder state machine', () => {
  const cfg = {
    label: '2026-Q3',
    quarterEndMs: new Date(2026, 6, 1).getTime(),
    nudgeEveryDays: 3,
    maxNudges: 2,
    draftDaysBeforeEnd: 7,
  };
  const members = ['alice', 'bob'];

  it('first tick: announces kickoff and DMs every member', () => {
    const p = planActions({
      nowMs: JUNE_15,
      cfg,
      members,
      state: {},
      inputs: new Set(),
    });
    expect(p.posts).toHaveLength(1);
    expect(p.posts[0]).toContain('2026-Q3');
    expect(p.dms.map((d) => d.slug)).toEqual(['alice', 'bob']);
    expect(p.state.members.alice.asks).toBe(1);
    expect(p.requestDraft).toBe(false);
  });

  it('within the nudge interval: no repeat DMs', () => {
    const first = planActions({
      nowMs: JUNE_15,
      cfg,
      members,
      state: {},
      inputs: new Set(),
    });
    const second = planActions({
      nowMs: JUNE_15 + DAY,
      cfg,
      members,
      state: first.state,
      inputs: new Set(),
    });
    expect(second.dms).toHaveLength(0);
    expect(second.posts).toHaveLength(0);
  });

  it('after the interval: re-nudges only members without input', () => {
    const first = planActions({
      nowMs: JUNE_15,
      cfg,
      members,
      state: {},
      inputs: new Set(),
    });
    const later = planActions({
      nowMs: JUNE_15 + 3 * DAY,
      cfg,
      members,
      state: first.state,
      inputs: new Set(['alice']),
    });
    expect(later.dms.map((d) => d.slug)).toEqual(['bob']);
    expect(later.dms[0].text).toMatch(/Reminder 1/);
    expect(later.state.members.bob.asks).toBe(2);
    // alice responded — her ask counter is untouched.
    expect(later.state.members.alice.asks).toBe(1);
  });

  it('escalates once in the channel after max nudges, then goes quiet', () => {
    let state = {};
    let now = JUNE_15;
    for (let i = 0; i < 2; i++) {
      state = planActions({
        nowMs: now,
        cfg,
        members: ['alice'],
        state,
        inputs: new Set(),
      }).state;
      now += 3 * DAY;
    }
    const escalation = planActions({
      nowMs: now,
      cfg,
      members: ['alice'],
      state,
      inputs: new Set(),
    });
    expect(escalation.dms).toHaveLength(0);
    expect(escalation.posts.some((p) => p.includes('alice'))).toBe(true);
    const after = planActions({
      nowMs: now + 3 * DAY,
      cfg,
      members: ['alice'],
      state: escalation.state,
      inputs: new Set(),
    });
    expect(after.dms).toHaveLength(0);
    expect(after.posts).toHaveLength(0);
  });

  it('requests the draft exactly once when everyone has filed input', () => {
    const first = planActions({
      nowMs: JUNE_15,
      cfg,
      members,
      state: {},
      inputs: new Set(['alice', 'bob']),
    });
    expect(first.requestDraft).toBe(true);
    const again = planActions({
      nowMs: JUNE_15 + DAY,
      cfg,
      members,
      state: first.state,
      inputs: new Set(['alice', 'bob']),
    });
    expect(again.requestDraft).toBe(false);
  });

  it('requests the draft at the deadline even with inputs missing', () => {
    const nearEnd = cfg.quarterEndMs - 6 * DAY; // inside draft_days_before_end=7
    const p = planActions({
      nowMs: nearEnd,
      cfg,
      members,
      state: {},
      inputs: new Set(['alice']),
    });
    expect(p.requestDraft).toBe(true);
  });

  it('tags members with Discord mentions in channel posts when ids resolve', () => {
    const mentions = { alice: '111', bob: '222' };
    const kickoff = planActions({
      nowMs: JUNE_15,
      cfg,
      members,
      state: {},
      inputs: new Set(),
      mentions,
    });
    // Kickoff post pings both committee members (with readable name appended).
    expect(kickoff.posts[0]).toContain('<@111> (alice)');
    expect(kickoff.posts[0]).toContain('<@222> (bob)');

    // Escalation pings the specific non-responsive member.
    let state = {};
    let now = JUNE_15;
    for (let i = 0; i < 2; i++) {
      state = planActions({
        nowMs: now,
        cfg,
        members: ['alice'],
        state,
        inputs: new Set(),
        mentions,
      }).state;
      now += 3 * DAY;
    }
    const esc = planActions({
      nowMs: now,
      cfg,
      members: ['alice'],
      state,
      inputs: new Set(),
      mentions,
    });
    expect(esc.posts[0]).toContain('<@111> (alice)');
  });

  it('falls back to the slug when a member has no resolved id', () => {
    const p = planActions({
      nowMs: JUNE_15,
      cfg,
      members,
      state: {},
      inputs: new Set(),
      mentions: { alice: '111' }, // bob unmapped
    });
    expect(p.posts[0]).toContain('<@111> (alice)');
    expect(p.posts[0]).toContain('bob');
    expect(p.posts[0]).not.toContain('<@undefined>');
  });
});

describe('resolveDiscordIds', () => {
  let ctxDir;
  beforeEach(() => {
    ctxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-people-'));
    fs.mkdirSync(path.join(ctxDir, 'people'), { recursive: true });
    fs.writeFileSync(
      path.join(ctxDir, 'people', 'alice.md'),
      "---\ndiscord_id: '12345'\n---\nAlice.",
    );
    // bob.md intentionally has no discord_id; carol has no file at all.
    fs.writeFileSync(
      path.join(ctxDir, 'people', 'bob.md'),
      '---\ntitle: Bob\n---\nBob.',
    );
  });
  afterEach(() => fs.rmSync(ctxDir, { recursive: true, force: true }));

  it('maps slugs with a discord_id and omits the rest', () => {
    const m = resolveDiscordIds(ctxDir, ['alice', 'bob', 'carol']);
    expect(m).toEqual({ alice: '12345' });
  });
});

describe('tick — filesystem integration against a temp profile', () => {
  let profileDir;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  function ctxDir() {
    return path.join(profileDir, 'groups', 'kb_main', 'context');
  }
  function ipcDir(sub) {
    return path.join(profileDir, 'data', 'ipc', 'kb_main', sub);
  }
  function readIpc(sub) {
    const dir = ipcDir(sub);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-kickoff-'));
    fs.writeFileSync(
      path.join(profileDir, 'profile.config.json'),
      JSON.stringify({ sharedKbGroup: 'kb_main' }),
    );
    fs.mkdirSync(path.join(ctxDir(), 'sd'), { recursive: true });
    fs.writeFileSync(
      path.join(ctxDir(), 'sd', 'committee.md'),
      [
        '---',
        'members:',
        '  - alice',
        '  - bob',
        'channel_jid: dc:999',
        '---',
      ].join('\n'),
    );
    // People files so channel posts can resolve mentions (alice has an id, bob
    // doesn't — exercises both the mention and the slug-fallback path).
    fs.mkdirSync(path.join(ctxDir(), 'people'), { recursive: true });
    fs.writeFileSync(
      path.join(ctxDir(), 'people', 'alice.md'),
      "---\ndiscord_id: '12345'\n---\nAlice.",
    );
    fs.writeFileSync(
      path.join(ctxDir(), 'people', 'bob.md'),
      '---\ntitle: Bob\n---\nBob.',
    );
  });

  afterEach(() => {
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it('no-ops silently when committee.md is absent', () => {
    fs.rmSync(path.join(ctxDir(), 'sd', 'committee.md'));
    expect(tick({ profileDir, logger, nowMs: JUNE_15 })).toBeNull();
    expect(fs.existsSync(ipcDir('tasks'))).toBe(false);
  });

  it('no-ops outside the kickoff window', () => {
    const may1 = new Date(2026, 4, 1).getTime();
    expect(tick({ profileDir, logger, nowMs: may1 })).toBeNull();
  });

  it('emits kickoff post + member DMs and persists state', () => {
    tick({ profileDir, logger, nowMs: JUNE_15 });

    const dms = readIpc('tasks');
    expect(
      dms
        .map((d) => ({ type: d.type, target: d.target }))
        .sort((a, b) => a.target.localeCompare(b.target)),
    ).toEqual([
      { type: 'dm_user', target: 'alice' },
      { type: 'dm_user', target: 'bob' },
    ]);
    expect(dms[0].sourceJid).toBe('dc:999');

    const posts = readIpc('messages');
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ type: 'message', chatJid: 'dc:999' });
    // Kickoff pings alice via her resolved id; bob (no id) falls back to slug.
    expect(posts[0].text).toContain('<@12345> (alice)');
    expect(posts[0].text).toContain('bob');

    const state = JSON.parse(
      fs.readFileSync(
        path.join(ctxDir(), 'sd', 'state', '2026-Q3.json'),
        'utf-8',
      ),
    );
    expect(state.members.alice.asks).toBe(1);

    // Same instant again — fully idempotent, no duplicate IPC files.
    tick({ profileDir, logger, nowMs: JUNE_15 });
    expect(readIpc('tasks')).toHaveLength(2);
    expect(readIpc('messages')).toHaveLength(1);
  });

  it('a filed input stops that member’s nudges; full inputs schedule the draft', () => {
    tick({ profileDir, logger, nowMs: JUNE_15 });

    const inputsDir = path.join(ctxDir(), 'sd', 'inputs', '2026-Q3');
    fs.mkdirSync(inputsDir, { recursive: true });
    fs.writeFileSync(path.join(inputsDir, 'alice.md'), '# input');

    tick({ profileDir, logger, nowMs: JUNE_15 + 3 * DAY });
    const dmTargets = readIpc('tasks')
      .filter((t) => t.type === 'dm_user')
      .map((t) => t.target);
    // alice asked once (kickoff), bob twice (kickoff + reminder).
    expect(dmTargets.filter((t) => t === 'alice')).toHaveLength(1);
    expect(dmTargets.filter((t) => t === 'bob')).toHaveLength(2);

    fs.writeFileSync(path.join(inputsDir, 'bob.md'), '# input');
    tick({ profileDir, logger, nowMs: JUNE_15 + 4 * DAY });

    const draft = readIpc('tasks').find((t) => t.type === 'schedule_task');
    expect(draft).toBeDefined();
    expect(draft.taskId).toBe('sd-draft-2026-q3');
    expect(draft.targetJid).toBe('dc:999');
    expect(draft.context_mode).toBe('isolated');
    expect(draft.prompt).toContain('sd/inputs/2026-Q3');
    // `once` schedule value must be local time WITHOUT a timezone suffix.
    expect(draft.schedule_value).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/,
    );
  });
});
