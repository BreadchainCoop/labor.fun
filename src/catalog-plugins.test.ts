import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The catalog plugins are plain .mjs modules (they load at runtime with no build
// step), so we import them by relative path from src/. They live at
// container/catalog-plugins/ under the repo root.
const CATALOG_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'container',
  'catalog-plugins',
);

type LoggerLike = { info: () => void; warn: () => void; error: () => void };
const silentLogger: LoggerLike = { info() {}, warn() {}, error() {} };

/**
 * Import a catalog plugin by absolute path. The catalog modules are plain .mjs
 * with no type declarations, so we import them through a runtime-only helper
 * (the specifier is a variable) — tsc never tries to resolve their types, and
 * the module's exported functions come back as `any`, which is what we want for
 * driving a config-parameterized plugin from a test.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function importCatalog(file: string): Promise<any> {
  return import(path.join(CATALOG_DIR, file));
}

// --- weekly-agenda -----------------------------------------------------------

describe('catalog/weekly-agenda', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let wa: any;
  beforeEach(async () => {
    wa = await importCatalog('weekly-agenda.mjs');
  });

  it('declares the manifest (id + kind) the loader gates on', () => {
    expect(wa.id).toBe('weekly-agenda');
    expect(wa.kind).toBe('integration');
    expect(typeof wa.default).toBe('function');
  });

  describe('resolvePluginConfig — defaults vs custom', () => {
    it('default config yields sensible built-in defaults', () => {
      const pc = wa.resolvePluginConfig();
      expect(pc.tickMs).toBe(6 * 3_600_000);
      expect(pc.firstTickDelayMs).toBe(60_000);
      expect(pc.sharedKbGroup).toBe('');
      expect(pc.defaults).toEqual({
        meetingDay: 3,
        meetingHour: 16,
        prepDaysBefore: 2,
        nudgeEveryDays: 1,
        maxNudges: 3,
        refreshHoursBefore: 0,
        facilitatorPool: [],
      });
    });

    it('custom config overrides tick cadence, group, and cadence defaults', () => {
      const pc = wa.resolvePluginConfig({
        tickMs: 3_600_000,
        firstTickDelayMs: 5_000,
        sharedKbGroup: 'discord_main',
        meetingDay: 1, // Monday
        meetingHour: 10,
        prepDaysBefore: 3,
        nudgeEveryDays: 2,
        maxNudges: 5,
        refreshHoursBefore: 6,
        facilitatorPool: [' alice ', 'bob', ''],
      });
      expect(pc.tickMs).toBe(3_600_000);
      expect(pc.firstTickDelayMs).toBe(5_000);
      expect(pc.sharedKbGroup).toBe('discord_main');
      expect(pc.defaults.meetingDay).toBe(1);
      expect(pc.defaults.meetingHour).toBe(10);
      expect(pc.defaults.prepDaysBefore).toBe(3);
      expect(pc.defaults.nudgeEveryDays).toBe(2);
      expect(pc.defaults.maxNudges).toBe(5);
      expect(pc.defaults.refreshHoursBefore).toBe(6);
      expect(pc.defaults.facilitatorPool).toEqual(['alice', 'bob']); // trimmed, dropped ''
    });
  });

  describe('parseConfig — plugin-config defaults fill KB omissions; KB wins', () => {
    it('applies config defaults when config.md omits cadence/pool', () => {
      const defaults = wa.resolvePluginConfig({
        meetingDay: 1,
        meetingHour: 9,
        maxNudges: 7,
        facilitatorPool: ['x', 'y'],
      }).defaults;
      const c = wa.parseConfig(
        ['---', 'channel_jid: dc:1', 'owners:', '  P: alice', '---'].join('\n'),
        defaults,
      );
      expect(c.meetingDay).toBe(1); // from config default
      expect(c.meetingHour).toBe(9);
      expect(c.maxNudges).toBe(7);
      expect(c.facilitatorPool).toEqual(['x', 'y']); // config-default pool
    });

    it('KB config.md values win over the plugin-config defaults', () => {
      const defaults = wa.resolvePluginConfig({
        meetingDay: 1,
        facilitatorPool: ['x', 'y'],
      }).defaults;
      const c = wa.parseConfig(
        [
          '---',
          'channel_jid: dc:1',
          'meeting_day: 5', // Friday — overrides the config default
          'facilitator_pool:',
          '  - josh',
          '  - marv',
          'owners:',
          '  P: alice',
          '---',
        ].join('\n'),
        defaults,
      );
      expect(c.meetingDay).toBe(5);
      expect(c.facilitatorPool).toEqual(['josh', 'marv']);
    });
  });

  describe('pickFacilitator — rotation logic (org-agnostic pool)', () => {
    it('explicit override wins over the pool', () => {
      expect(
        wa.pickFacilitator('2026-06-10', { '2026-06-10': 'josh' }, ['a', 'b']),
      ).toBe('josh');
    });
    it('returns "" (TBD) with no override and no pool', () => {
      expect(wa.pickFacilitator('2026-06-10', {}, [])).toBe('');
    });
    it('auto-rotates deterministically, advancing by one each week, wrapping', () => {
      const pool = ['ron', 'marv', 'bren'];
      const w1 = wa.pickFacilitator('2026-06-17', {}, pool);
      const w2 = wa.pickFacilitator('2026-06-24', {}, pool);
      const w3 = wa.pickFacilitator('2026-07-01', {}, pool);
      const w4 = wa.pickFacilitator('2026-07-08', {}, pool);
      const i1 = pool.indexOf(w1);
      expect(i1).toBeGreaterThanOrEqual(0);
      expect(w2).toBe(pool[(i1 + 1) % 3]);
      expect(w3).toBe(pool[(i1 + 2) % 3]);
      expect(w4).toBe(w1); // wraps after pool length
      expect(new Set([w1, w2, w3]).size).toBe(3);
    });
    it('is resilient to a malformed weekKey', () => {
      expect(wa.pickFacilitator('not-a-date', {}, ['a', 'b'])).toBe('');
    });
  });

  describe('tick — end to end against a temp profile (profileDir from api)', () => {
    const IN_WINDOW = new Date(2026, 5, 9, 12, 0, 0).getTime(); // Tue before Wed
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-wa-'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    function writeConfig(group = 'slack_main', extra = '') {
      const ctx = path.join(dir, 'groups', group, 'context', 'weekly-agenda');
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
        JSON.stringify({ sharedKbGroup: group }),
      );
    }
    const tasksDir = (group: string) =>
      path.join(dir, 'data', 'ipc', group, 'tasks');
    const taskTypes = (group = 'slack_main') =>
      fs.existsSync(tasksDir(group))
        ? fs
            .readdirSync(tasksDir(group))
            .filter((f) => f.endsWith('.json'))
            .map(
              (f) =>
                JSON.parse(
                  fs.readFileSync(path.join(tasksDir(group), f), 'utf-8'),
                ).type,
            )
        : [];

    it('inside window, not built → emits ONE build task, no DMs, no post', () => {
      writeConfig();
      const plan = wa.tick({
        profileDir: dir,
        logger: silentLogger,
        nowMs: IN_WINDOW,
      });
      expect(plan.requestBuild).toBe(true);
      expect(
        taskTypes().filter((t: string) => t === 'schedule_task'),
      ).toHaveLength(1);
      expect(taskTypes().filter((t: string) => t === 'dm_user')).toHaveLength(
        0,
      );
    });

    it('sharedKbGroup from PLUGIN CONFIG overrides the profile group', () => {
      // Config.md lives under discord_main, and the profile says slack_main —
      // the plugin CONFIG override points the flow at discord_main.
      writeConfig('discord_main');
      fs.writeFileSync(
        path.join(dir, 'profile.config.json'),
        JSON.stringify({ sharedKbGroup: 'slack_main' }),
      );
      const plan = wa.tick({
        profileDir: dir,
        logger: silentLogger,
        nowMs: IN_WINDOW,
        pluginConfig: { sharedKbGroup: 'discord_main' },
      });
      expect(plan.requestBuild).toBe(true);
      // IPC landed in discord_main's namespace, not slack_main.
      expect(
        taskTypes('discord_main').filter((t: string) => t === 'schedule_task'),
      ).toHaveLength(1);
      expect(taskTypes('slack_main')).toHaveLength(0);
    });

    it('no-op when config.md is absent', () => {
      fs.writeFileSync(
        path.join(dir, 'profile.config.json'),
        JSON.stringify({ sharedKbGroup: 'slack_main' }),
      );
      expect(
        wa.tick({ profileDir: dir, logger: silentLogger, nowMs: IN_WINDOW }),
      ).toBeNull();
    });
  });

  describe('register — wires an integration and passes config through', () => {
    it('registers a weekly-agenda integration; start() is callable', () => {
      const registered: Array<{
        name: string;
        start: () => void;
        stop?: () => void;
      }> = [];
      const api = {
        registerIntegration: (i: {
          name: string;
          start: () => void;
          stop?: () => void;
        }) => registered.push(i),
        logger: silentLogger,
        profileDir: '/nonexistent/profile',
      };
      wa.default(api as never, { tickMs: 1000 });
      expect(registered).toHaveLength(1);
      expect(registered[0].name).toBe('weekly-agenda');
      // start() must not throw even though the profile dir has no config.md.
      expect(() => registered[0].start()).not.toThrow();
      registered[0].stop?.();
    });
  });
});

// --- admin-email -------------------------------------------------------------

describe('catalog/admin-email', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ae: any;
  beforeEach(async () => {
    ae = await importCatalog('admin-email.mjs');
  });

  it('declares the manifest (id + kind)', () => {
    expect(ae.id).toBe('admin-email');
    expect(ae.kind).toBe('integration');
    expect(typeof ae.default).toBe('function');
  });

  describe('resolvePluginConfig — defaults vs custom', () => {
    it('default config yields built-in defaults (every-2h cron)', () => {
      const pc = ae.resolvePluginConfig();
      expect(pc.tickMs).toBe(6 * 3_600_000);
      expect(pc.firstTickDelayMs).toBe(90_000);
      expect(pc.sharedKbGroup).toBe('');
      expect(pc.defaults).toEqual({
        triageCron: '0 */2 * * *',
        githubRepo: '',
        notifyChannelJid: '',
      });
    });

    it('custom config sets cron/repo/channel defaults + runtime knobs', () => {
      const pc = ae.resolvePluginConfig({
        tickMs: 3_600_000,
        firstTickDelayMs: 1_000,
        sharedKbGroup: 'ops',
        triageCron: '*/30 * * * *',
        githubRepo: 'acme/admin',
        notifyChannelJid: 'slack:C123',
      });
      expect(pc.tickMs).toBe(3_600_000);
      expect(pc.firstTickDelayMs).toBe(1_000);
      expect(pc.sharedKbGroup).toBe('ops');
      expect(pc.defaults.triageCron).toBe('*/30 * * * *');
      expect(pc.defaults.githubRepo).toBe('acme/admin');
      expect(pc.defaults.notifyChannelJid).toBe('slack:C123');
    });
  });

  describe('parseConfig — config defaults fill KB omissions; KB wins', () => {
    it('applies config defaults when config.md omits repo/cron/channel', () => {
      const defaults = ae.resolvePluginConfig({
        triageCron: '0 9 * * *',
        githubRepo: 'acme/admin',
        notifyChannelJid: 'slack:C1',
      }).defaults;
      const c = ae.parseConfig('---\n---', defaults);
      expect(c.enabled).toBe(true);
      expect(c.triageCron).toBe('0 9 * * *');
      expect(c.githubRepo).toBe('acme/admin');
      expect(c.notifyChannelJid).toBe('slack:C1');
    });

    it('KB values win over config defaults; enabled:false honoured', () => {
      const defaults = ae.resolvePluginConfig({
        githubRepo: 'acme/admin',
        notifyChannelJid: 'slack:default',
      }).defaults;
      const c = ae.parseConfig(
        '---\nenabled: false\ngithub_repo: acme/other\nnotify_channel_jid: dc:9\n---',
        defaults,
      );
      expect(c.enabled).toBe(false);
      expect(c.githubRepo).toBe('acme/other');
      expect(c.notifyChannelJid).toBe('dc:9'); // KB channel wins over default
    });
  });

  describe('triagePrompt — recipient/repo handling', () => {
    it('names the configured repo and the skill', () => {
      const p = ae.triagePrompt({
        githubRepo: 'acme/admin',
        notifyChannelJid: 'dc:1',
      });
      expect(p).toContain('admin-email skill');
      expect(p).toContain('acme/admin');
      expect(p).toContain('triaged'); // idempotency instruction
    });
    it('falls back to the default issues repo when none configured', () => {
      const p = ae.triagePrompt({ githubRepo: '', notifyChannelJid: 'dc:1' });
      expect(p).toContain("org's default issues repo");
    });
  });

  describe('planSync — schedule/cancel/reschedule on the notify channel', () => {
    const cfg = {
      enabled: true,
      triageCron: '0 */2 * * *',
      githubRepo: 'acme/admin',
      notifyChannelJid: 'dc:9',
    };
    it('schedules on enable, targeting the configured channel', () => {
      const p = ae.planSync({ config: cfg, state: {}, nowMs: 1000 });
      expect(p.schedule).toMatchObject({
        cron: '0 */2 * * *',
        targetJid: 'dc:9',
      });
      expect(p.schedule.taskId).toBe('admin-email-triage-1000');
    });
    it('warns and does nothing when the notify channel is missing', () => {
      const p = ae.planSync({
        config: { ...cfg, notifyChannelJid: '' },
        state: {},
        nowMs: 6000,
      });
      expect(p.warn).toMatch(/notify_channel_jid/);
      expect(p.schedule).toBeUndefined();
    });
    it('cancels + clears state when disabled', () => {
      const p = ae.planSync({
        config: { ...cfg, enabled: false },
        state: { taskId: 't1' },
        nowMs: 4000,
      });
      expect(p.cancel).toBe('t1');
      expect(p.nextState).toEqual({});
    });
  });

  describe('tick — config-only setup (no KB config.md) via plugin CONFIG', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-ae-'));
      fs.writeFileSync(
        path.join(dir, 'profile.config.json'),
        JSON.stringify({ sharedKbGroup: 'kb_main' }),
      );
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const readTasks = (group = 'kb_main') => {
      const d = path.join(dir, 'data', 'ipc', group, 'tasks');
      return fs.existsSync(d)
        ? fs
            .readdirSync(d)
            .filter((f) => f.endsWith('.json'))
            .map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf-8')))
        : [];
    };

    it('fully dormant (no config.md, no CONFIG channel) writes nothing', () => {
      const plan = ae.tick({
        profileDir: dir,
        logger: silentLogger,
        nowMs: 1000,
      });
      expect(plan.nextState).toEqual({});
      expect(readTasks()).toHaveLength(0);
    });

    it('schedules from plugin CONFIG alone when notifyChannelJid is set', () => {
      const plan = ae.tick({
        profileDir: dir,
        logger: silentLogger,
        nowMs: 1000,
        pluginConfig: {
          notifyChannelJid: 'slack:C777',
          githubRepo: 'acme/admin',
          triageCron: '*/15 * * * *',
        },
      });
      expect(plan.schedule).toBeTruthy();
      const tasks = readTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        type: 'schedule_task',
        schedule_type: 'cron',
        schedule_value: '*/15 * * * *',
        targetJid: 'slack:C777',
      });
      expect(tasks[0].prompt).toContain('acme/admin');
    });

    it('CONFIG sharedKbGroup redirects the IPC namespace', () => {
      const plan = ae.tick({
        profileDir: dir,
        logger: silentLogger,
        nowMs: 1000,
        pluginConfig: {
          notifyChannelJid: 'dc:1',
          sharedKbGroup: 'other_group',
        },
      });
      expect(plan.schedule).toBeTruthy();
      expect(readTasks('other_group')).toHaveLength(1);
      expect(readTasks('kb_main')).toHaveLength(0);
    });
  });

  describe('register — wires an integration and is start-safe', () => {
    it('registers an admin-email integration; start() does not throw', () => {
      const registered: Array<{
        name: string;
        start: () => void;
        stop?: () => void;
      }> = [];
      const api = {
        registerIntegration: (i: {
          name: string;
          start: () => void;
          stop?: () => void;
        }) => registered.push(i),
        logger: silentLogger,
        profileDir: '/nonexistent/profile',
      };
      ae.default(api as never, { tickMs: 1000 });
      expect(registered).toHaveLength(1);
      expect(registered[0].name).toBe('admin-email');
      expect(() => registered[0].start()).not.toThrow();
      registered[0].stop?.();
    });
  });
});
