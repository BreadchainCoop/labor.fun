import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assignmentsBySlug,
  isoDate,
  meetingWindow,
  parseConfig,
  planActions,
  resolveDiscordIds,
  tick,
} from '../weekly-agenda.mjs';

const DAY = 86_400_000;
// Tue Jun 9 2026, local noon — inside the prep window for the Wed Jun 10
// meeting (16:00 local); the window opens Mon Jun 8 16:00 and closes at the
// meeting, so Tue noon sits comfortably within it.
const IN_WINDOW = new Date(2026, 5, 9, 12, 0, 0).getTime();

describe('meetingWindow', () => {
  it('targets the next weekly meeting and opens prep N days before', () => {
    const w = meetingWindow(IN_WINDOW, 3 /* Wed */, 16, 2);
    expect(w.weekKey).toBe('2026-06-10');
    expect(w.meetingMs).toBe(new Date(2026, 5, 10, 16, 0, 0).getTime());
    expect(w.windowStartMs).toBe(w.meetingMs - 2 * DAY);
  });

  it('rolls to next week once the meeting time has passed', () => {
    const afterMeeting = new Date(2026, 5, 10, 17, 0, 0).getTime();
    expect(meetingWindow(afterMeeting, 3, 16, 2).weekKey).toBe('2026-06-17');
  });
});

describe('parseConfig', () => {
  it('reads channel, doc/tab ids, cadence, owners and facilitators', () => {
    const c = parseConfig(
      [
        '---',
        'channel_jid: dc:111',
        'doc_id: DOC123',
        'this_week_tab_id: t.week',
        'archive_tab_id: t.arch',
        'meeting_day: 3',
        'prep_days_before: 2',
        'nudge_every_days: 1',
        'max_nudges: 3',
        'owners:',
        '  Design: ruben',
        '  Stacks: bren',
        '  Crowdstake.fun: ron',
        '  Sigstack: ron',
        'facilitators:',
        '  2026-06-10: josh',
        '---',
        'notes',
      ].join('\n'),
    );
    expect(c.channelJid).toBe('dc:111');
    expect(c.docId).toBe('DOC123');
    expect(c.thisWeekTabId).toBe('t.week');
    expect(c.archiveTabId).toBe('t.arch');
    expect(c.owners).toEqual({
      Design: 'ruben',
      Stacks: 'bren',
      'Crowdstake.fun': 'ron',
      Sigstack: 'ron',
    });
    expect(c.facilitators['2026-06-10']).toBe('josh');
    // defaults
    expect(c.meetingHour).toBe(16);
    expect(c.maxNudges).toBe(3);
  });
});

describe('assignmentsBySlug', () => {
  it('groups multiple projects under one owner', () => {
    const a = assignmentsBySlug({
      Design: 'ruben',
      'Crowdstake.fun': 'ron',
      Sigstack: 'ron',
      'Breadrich Engels': 'ron',
    });
    expect(a.ruben).toEqual(['Design']);
    expect(a.ron).toEqual(['Crowdstake.fun', 'Sigstack', 'Breadrich Engels']);
  });
});

describe('planActions — build + nudge ladder', () => {
  const cfg = { weekKey: '2026-06-10', nudgeEveryDays: 1, maxNudges: 2 };
  const owners = { Design: 'ruben', Stacks: 'bren' };
  const assignments = assignmentsBySlug(owners);
  const slugs = Object.keys(assignments);

  it('first tick: requests the build, posts kickoff, DMs every owner', () => {
    const p = planActions({
      nowMs: IN_WINDOW,
      cfg,
      slugs,
      assignments,
      facilitator: 'josh',
      state: {},
      filled: new Set(),
      mentions: {},
      docUrl: 'https://docs.google.com/document/d/DOC123/edit',
    });
    expect(p.requestBuild).toBe(true);
    expect(p.posts).toHaveLength(1);
    expect(p.posts[0]).toContain('2026-06-10');
    expect(p.dms.map((d) => d.slug).sort()).toEqual(['bren', 'ruben']);
    expect(p.state.members.ruben.asks).toBe(1);
  });

  it('within the nudge interval: no repeat build, no repeat DMs', () => {
    const first = planActions({
      nowMs: IN_WINDOW,
      cfg,
      slugs,
      assignments,
      facilitator: 'josh',
      state: {},
      filled: new Set(),
      mentions: {},
    });
    const second = planActions({
      nowMs: IN_WINDOW + 3600_000, // 1h later, < 1 day
      cfg,
      slugs,
      assignments,
      facilitator: 'josh',
      state: first.state,
      filled: new Set(),
      mentions: {},
    });
    expect(second.requestBuild).toBe(false);
    expect(second.dms).toHaveLength(0);
  });

  it('a filled owner is not nudged', () => {
    const p = planActions({
      nowMs: IN_WINDOW,
      cfg,
      slugs,
      assignments,
      facilitator: 'josh',
      state: {},
      filled: new Set(['ruben']),
      mentions: {},
    });
    expect(p.dms.map((d) => d.slug)).toEqual(['bren']);
  });

  it('escalates once after max_nudges, then stops DMing', () => {
    let state = {};
    let now = IN_WINDOW;
    const empty = new Set();
    const run = () => {
      const p = planActions({
        nowMs: now,
        cfg,
        slugs: ['ruben'],
        assignments: { ruben: ['Design'] },
        facilitator: 'josh',
        state,
        filled: empty,
        mentions: {},
      });
      state = p.state;
      now += DAY;
      return p;
    };
    // maxNudges = 2: ticks 1 and 2 DM (asks → 1, then 2); tick 3 escalates.
    expect(run().dms).toHaveLength(1);
    expect(run().dms).toHaveLength(1);
    const esc = run();
    expect(esc.dms).toHaveLength(0);
    expect(esc.posts.some((t) => /hasn't filled/.test(t))).toBe(true);
    expect(esc.state.members.ruben.escalated).toBe(true);
    // A 4th tick: already escalated → nothing emitted for ruben.
    const after = run();
    expect(after.dms).toHaveLength(0);
    expect(after.posts).toHaveLength(0);
  });
});

describe('tick — end to end against a temp profile', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const logger = { info() {}, warn() {}, error() {} };

  function writeConfig(extra = '') {
    const ctx = path.join(dir, 'groups', 'slack_main', 'context', 'weekly-agenda');
    fs.mkdirSync(ctx, { recursive: true });
    fs.writeFileSync(
      path.join(ctx, 'config.md'),
      [
        '---',
        'channel_jid: dc:999',
        'doc_id: DOC123',
        'this_week_tab_id: t.week',
        'archive_tab_id: t.arch',
        'owners:',
        '  Design: ruben',
        '  Stacks: bren',
        'facilitators:',
        '  2026-06-10: josh',
        extra,
        '---',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'profile.config.json'),
      JSON.stringify({ sharedKbGroup: 'slack_main' }),
    );
  }

  function ipcFiles(kind) {
    const d = path.join(dir, 'data', 'ipc', 'slack_main', kind);
    return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')) : [];
  }

  it('no-op when config.md is absent', () => {
    expect(tick({ profileDir: dir, logger, nowMs: IN_WINDOW })).toBeNull();
  });

  it('inside the prep window: emits a build task, DMs, and a channel post', () => {
    writeConfig();
    const plan = tick({ profileDir: dir, logger, nowMs: IN_WINDOW });
    expect(plan).not.toBeNull();
    expect(plan.requestBuild).toBe(true);
    // One build task + two owner DMs all land in tasks/.
    const tasks = ipcFiles('tasks');
    expect(tasks.length).toBe(3);
    const kinds = tasks.map((f) =>
      JSON.parse(fs.readFileSync(path.join(dir, 'data/ipc/slack_main/tasks', f))).type,
    );
    expect(kinds.filter((t) => t === 'schedule_task')).toHaveLength(1);
    expect(kinds.filter((t) => t === 'dm_user')).toHaveLength(2);
    expect(ipcFiles('messages')).toHaveLength(1);
    // State persisted for the week.
    expect(
      fs.existsSync(path.join(dir, 'groups/slack_main/context/weekly-agenda/state/2026-06-10.json')),
    ).toBe(true);
  });

  it('outside the prep window: no-op', () => {
    writeConfig();
    // Fri before the window opens (window opens Mon Jun 8 16:00).
    const farBefore = new Date(2026, 5, 5, 12, 0, 0).getTime();
    expect(tick({ profileDir: dir, logger, nowMs: farBefore })).toBeNull();
  });

  it('a filled owner stops getting DMs on the next tick', () => {
    writeConfig();
    tick({ profileDir: dir, logger, nowMs: IN_WINDOW });
    // Mark ruben as filled.
    const inDir = path.join(dir, 'groups/slack_main/context/weekly-agenda/inputs/2026-06-10');
    fs.mkdirSync(inDir, { recursive: true });
    fs.writeFileSync(path.join(inDir, 'ruben.md'), 'update');
    // A day later, only bren should still be nudged.
    const plan = tick({ profileDir: dir, logger, nowMs: IN_WINDOW + DAY });
    expect(plan.dms.map((d) => d.slug)).toEqual(['bren']);
  });
});

describe('resolveDiscordIds', () => {
  it('maps slugs to discord_id from people files, skipping missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ppl-'));
    const ppl = path.join(dir, 'people');
    fs.mkdirSync(ppl, { recursive: true });
    fs.writeFileSync(path.join(ppl, 'ruben.md'), '---\ndiscord_id: "123"\n---\n');
    try {
      const m = resolveDiscordIds(dir, ['ruben', 'ghost']);
      expect(m).toEqual({ ruben: '123' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isoDate', () => {
  it('formats local Y-M-D', () => {
    expect(isoDate(new Date(2026, 5, 10, 9, 0, 0).getTime())).toBe('2026-06-10');
  });
});
