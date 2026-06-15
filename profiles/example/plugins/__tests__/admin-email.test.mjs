import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parseConfig,
  planSync,
  tick,
  triagePrompt,
} from '../admin-email.mjs';

describe('parseConfig', () => {
  it('reads fields and defaults the cron; presence = enabled', () => {
    const c = parseConfig(
      [
        '---',
        'github_repo: org/admin',
        'notify_channel_jid: dc:9',
        '---',
        'grant-action → gil',
      ].join('\n'),
    );
    expect(c.enabled).toBe(true);
    expect(c.githubRepo).toBe('org/admin');
    expect(c.notifyChannelJid).toBe('dc:9');
    expect(c.triageCron).toBe('0 */2 * * *');
  });

  it('honours enabled:false and a custom cron', () => {
    const c = parseConfig(
      '---\nenabled: false\ntriage_cron: "*/30 * * * *"\nnotify_channel_jid: dc:1\n---',
    );
    expect(c.enabled).toBe(false);
    expect(c.triageCron).toBe('*/30 * * * *');
  });
});

describe('triagePrompt', () => {
  it('names the repo and the skill', () => {
    const p = triagePrompt({ githubRepo: 'org/admin', notifyChannelJid: 'dc:1' });
    expect(p).toContain('admin-email skill');
    expect(p).toContain('org/admin');
    expect(p).toContain('triaged'); // idempotency instruction
  });
});

describe('planSync', () => {
  const cfg = {
    enabled: true,
    triageCron: '0 */2 * * *',
    githubRepo: 'org/admin',
    notifyChannelJid: 'dc:9',
  };

  it('schedules a recurring task when enabled and nothing is scheduled', () => {
    const p = planSync({ config: cfg, state: {}, nowMs: 1000 });
    expect(p.cancel).toBeUndefined();
    expect(p.schedule).toMatchObject({
      cron: '0 */2 * * *',
      targetJid: 'dc:9',
    });
    expect(p.schedule.taskId).toBe('admin-email-triage-1000');
    expect(p.nextState).toMatchObject({
      taskId: 'admin-email-triage-1000',
      cron: '0 */2 * * *',
      repo: 'org/admin',
      channel: 'dc:9',
    });
  });

  it('is a no-op when already scheduled with the same config', () => {
    const state = {
      taskId: 't1',
      cron: '0 */2 * * *',
      repo: 'org/admin',
      channel: 'dc:9',
    };
    const p = planSync({ config: cfg, state, nowMs: 2000 });
    expect(p.schedule).toBeUndefined();
    expect(p.cancel).toBeUndefined();
    expect(p.nextState).toBe(state);
  });

  it('reschedules (cancel old + schedule new id) when the cron changes', () => {
    const state = {
      taskId: 't1',
      cron: '0 */2 * * *',
      repo: 'org/admin',
      channel: 'dc:9',
    };
    const p = planSync({
      config: { ...cfg, triageCron: '*/30 * * * *' },
      state,
      nowMs: 3000,
    });
    expect(p.cancel).toBe('t1');
    expect(p.schedule.cron).toBe('*/30 * * * *');
    expect(p.schedule.taskId).toBe('admin-email-triage-3000');
    expect(p.nextState.taskId).toBe('admin-email-triage-3000');
  });

  it('cancels and clears state when disabled', () => {
    const state = { taskId: 't1', cron: 'x', repo: 'r', channel: 'c' };
    const p = planSync({
      config: { ...cfg, enabled: false },
      state,
      nowMs: 4000,
    });
    expect(p.cancel).toBe('t1');
    expect(p.schedule).toBeUndefined();
    expect(p.nextState).toEqual({});
  });

  it('cancels when config disappears (null) and a task was scheduled', () => {
    const p = planSync({ config: null, state: { taskId: 't1' }, nowMs: 5000 });
    expect(p.cancel).toBe('t1');
    expect(p.nextState).toEqual({});
  });

  it('warns and does nothing when notify_channel_jid is missing', () => {
    const p = planSync({
      config: { ...cfg, notifyChannelJid: '' },
      state: {},
      nowMs: 6000,
    });
    expect(p.warn).toMatch(/notify_channel_jid/);
    expect(p.schedule).toBeUndefined();
  });
});

describe('tick — filesystem integration', () => {
  let profileDir;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const ctxDir = () => path.join(profileDir, 'groups', 'kb_main', 'context');
  const tasksDir = () =>
    path.join(profileDir, 'data', 'ipc', 'kb_main', 'tasks');
  const readTasks = () =>
    fs.existsSync(tasksDir())
      ? fs
          .readdirSync(tasksDir())
          .filter((f) => f.endsWith('.json'))
          .map((f) => JSON.parse(fs.readFileSync(path.join(tasksDir(), f), 'utf-8')))
      : [];
  const readState = () =>
    JSON.parse(
      fs.readFileSync(
        path.join(ctxDir(), 'admin-email', 'state.json'),
        'utf-8',
      ),
    );
  const writeConfig = (body) => {
    fs.mkdirSync(path.join(ctxDir(), 'admin-email'), { recursive: true });
    fs.writeFileSync(path.join(ctxDir(), 'admin-email', 'config.md'), body);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-email-'));
    fs.writeFileSync(
      path.join(profileDir, 'profile.config.json'),
      JSON.stringify({ sharedKbGroup: 'kb_main' }),
    );
  });
  afterEach(() => fs.rmSync(profileDir, { recursive: true, force: true }));

  it('fully dormant (no config, no state) writes nothing', () => {
    tick({ profileDir, logger, nowMs: 1000 });
    expect(readTasks()).toHaveLength(0);
    expect(fs.existsSync(path.join(ctxDir(), 'admin-email', 'state.json'))).toBe(
      false,
    );
  });

  it('schedules on enable, then is idempotent, then cancels on disable', () => {
    writeConfig('---\nnotify_channel_jid: dc:9\ngithub_repo: org/admin\n---');

    tick({ profileDir, logger, nowMs: 1000 });
    let tasks = readTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      type: 'schedule_task',
      schedule_type: 'cron',
      targetJid: 'dc:9',
    });
    const scheduledId = readState().taskId;
    expect(scheduledId).toBe(tasks[0].taskId);

    // Second tick, unchanged config → no new IPC.
    tick({ profileDir, logger, nowMs: 2000 });
    expect(readTasks()).toHaveLength(1);

    // Disable → a cancel for the scheduled id, state cleared.
    writeConfig('---\nenabled: false\nnotify_channel_jid: dc:9\n---');
    tick({ profileDir, logger, nowMs: 3000 });
    const cancels = readTasks().filter((t) => t.type === 'cancel_task');
    expect(cancels).toHaveLength(1);
    expect(cancels[0].taskId).toBe(scheduledId);
    expect(readState()).toEqual({});
  });
});
