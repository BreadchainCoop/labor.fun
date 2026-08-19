import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { discardSandboxedIpc, _resetSandboxedWarnCache } from './ipc.js';

// Regression test for the production log-flood: a sandboxed external chat-flow
// group's IPC is discarded on every watcher poll. That discard is expected,
// benign behaviour, so it must NOT emit a WARN each time (it grew a droplet's
// error log to 682MB and filled the disk). It must still (a) surface a NEW
// source once at WARN, and (b) delete the files on EVERY poll.

const SOURCE = 'chatflow-sandboxed-src';

function writeIpcFiles(sourceGroup: string): { messages: string; tasks: string } {
  const messagesDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'messages');
  const tasksDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'tasks');
  fs.mkdirSync(messagesDir, { recursive: true });
  fs.mkdirSync(tasksDir, { recursive: true });
  const msg = path.join(messagesDir, 'm.json');
  const tsk = path.join(tasksDir, 't.json');
  fs.writeFileSync(msg, JSON.stringify({ type: 'message', text: 'hi' }));
  fs.writeFileSync(tsk, JSON.stringify({ type: 'schedule_task' }));
  return { messages: msg, tasks: tsk };
}

describe('sandboxed IPC discard logging (log-flood regression)', () => {
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');

  beforeEach(() => {
    _resetSandboxedWarnCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(path.join(ipcBaseDir, SOURCE), { recursive: true, force: true });
    fs.rmSync(path.join(ipcBaseDir, `${SOURCE}-2`), {
      recursive: true,
      force: true,
    });
  });

  it('emits at most one WARN across many polls from the same source while deleting files every time', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    const N = 50;
    for (let i = 0; i < N; i++) {
      // Fresh IPC files arrive each poll (as they would on a busy chat-flow).
      const { messages, tasks } = writeIpcFiles(SOURCE);
      discardSandboxedIpc(ipcBaseDir, SOURCE);
      // Discard behaviour is UNCHANGED: files gone on every single poll.
      expect(fs.existsSync(messages)).toBe(false);
      expect(fs.existsSync(tasks)).toBe(false);
    }

    // The steady stream must not re-log at WARN (this was the flood).
    expect(warn).toHaveBeenCalledTimes(1);
    // Everything after the first surfaces at debug (stays out of error log).
    expect(debug).toHaveBeenCalledTimes(N - 1);
  });

  it('a genuinely new source still surfaces exactly once at WARN', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    writeIpcFiles(SOURCE);
    discardSandboxedIpc(ipcBaseDir, SOURCE);
    writeIpcFiles(SOURCE);
    discardSandboxedIpc(ipcBaseDir, SOURCE);
    expect(warn).toHaveBeenCalledTimes(1);

    // A different (new/misbehaving) source gets its own single WARN.
    writeIpcFiles(`${SOURCE}-2`);
    discardSandboxedIpc(ipcBaseDir, `${SOURCE}-2`);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toMatchObject({ sourceGroup: `${SOURCE}-2` });
  });
});
