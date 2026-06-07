import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleRequestIpc, IpcDeps } from './ipc.js';

// handleRequestIpc only touches the filesystem under the ipcBaseDir it's
// handed, so each test runs against an isolated temp dir — no DB or global
// state required.

let baseDir: string;
const SOURCE_GROUP = 'discord_fetch_test';

function setSenderCtx(): void {
  const inputDir = path.join(baseDir, SOURCE_GROUP, 'input');
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(
    path.join(inputDir, 'sender_context.json'),
    JSON.stringify({
      user_id: 'dc:1234@user',
      display_name: 'Ron',
      tags: [],
    }),
  );
}

function readResponse(requestId: string): Record<string, unknown> {
  const p = path.join(baseDir, SOURCE_GROUP, 'responses', `${requestId}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function makeDeps(fetchImpl: IpcDeps['fetchDiscordHistory']): IpcDeps {
  // Only fetchDiscordHistory is exercised by these tests; the rest are stubs.
  return {
    sendMessage: vi.fn(),
    deleteMessage: vi.fn(),
    editMessage: vi.fn(),
    registeredGroups: () => ({}),
    registerGroup: vi.fn(),
    syncGroups: vi.fn(),
    getAvailableGroups: () => [],
    writeGroupsSnapshot: vi.fn(),
    onTasksChanged: vi.fn(),
    fetchDiscordHistory: fetchImpl,
  } as unknown as IpcDeps;
}

describe('handleRequestIpc — fetch_discord_history', () => {
  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-fetch-'));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('serves history for an allowlisted sender, clamping limit and stripping dc:', async () => {
    setSenderCtx();
    const fetchImpl = vi.fn().mockResolvedValue([
      {
        id: 'a',
        authorId: 'u1',
        authorName: 'Alice',
        authorIsBot: false,
        content: 'worked 3h',
        timestamp: '2026-04-02T00:00:00.000Z',
        attachments: [],
      },
    ]);
    const deps = makeDeps(fetchImpl);

    await handleRequestIpc(
      {
        type: 'fetch_discord_history',
        requestId: 'req-1',
        channelId: 'dc:1291129091440902165',
        limit: 9999,
        sinceIso: '2026-04-01',
      },
      { sourceGroup: SOURCE_GROUP, isMain: false, ipcBaseDir: baseDir },
      deps,
    );

    // dc: prefix stripped, limit clamped to the 2000 hard cap
    expect(fetchImpl).toHaveBeenCalledWith('1291129091440902165', {
      limit: 2000,
      before: undefined,
      sinceIso: '2026-04-01',
    });

    const res = readResponse('req-1');
    expect(res.ok).toBe(true);
    expect(res.count).toBe(1);
    expect(res.channelId).toBe('1291129091440902165');
    expect((res.messages as unknown[]).length).toBe(1);
  });

  it('authorizes the main group even without a sender context', async () => {
    const fetchImpl = vi.fn().mockResolvedValue([]);
    const deps = makeDeps(fetchImpl);

    await handleRequestIpc(
      {
        type: 'fetch_discord_history',
        requestId: 'req-main',
        channelId: '123',
      },
      { sourceGroup: SOURCE_GROUP, isMain: true, ipcBaseDir: baseDir },
      deps,
    );

    expect(fetchImpl).toHaveBeenCalled();
    expect(readResponse('req-main').ok).toBe(true);
  });

  it('rejects an unauthenticated non-main request without calling Discord', async () => {
    const fetchImpl = vi.fn().mockResolvedValue([]);
    const deps = makeDeps(fetchImpl);

    await handleRequestIpc(
      {
        type: 'fetch_discord_history',
        requestId: 'req-unauth',
        channelId: '123',
      },
      { sourceGroup: SOURCE_GROUP, isMain: false, ipcBaseDir: baseDir },
      deps,
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    const res = readResponse('req-unauth');
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/Unauthorized/);
  });

  it('reports when Discord is not connected (dep returns null)', async () => {
    setSenderCtx();
    const deps = makeDeps(vi.fn().mockResolvedValue(null));

    await handleRequestIpc(
      {
        type: 'fetch_discord_history',
        requestId: 'req-noconn',
        channelId: '123',
      },
      { sourceGroup: SOURCE_GROUP, isMain: false, ipcBaseDir: baseDir },
      deps,
    );

    const res = readResponse('req-noconn');
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/not connected/i);
  });

  it('rejects a missing channel_id', async () => {
    setSenderCtx();
    const fetchImpl = vi.fn();
    const deps = makeDeps(fetchImpl);

    await handleRequestIpc(
      { type: 'fetch_discord_history', requestId: 'req-nochan' },
      { sourceGroup: SOURCE_GROUP, isMain: false, ipcBaseDir: baseDir },
      deps,
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readResponse('req-nochan').ok).toBe(false);
  });

  it('writes an error response when the fetch throws', async () => {
    setSenderCtx();
    const deps = makeDeps(
      vi.fn().mockRejectedValue(new Error('Missing Access')),
    );

    await handleRequestIpc(
      {
        type: 'fetch_discord_history',
        requestId: 'req-throw',
        channelId: '123',
      },
      { sourceGroup: SOURCE_GROUP, isMain: false, ipcBaseDir: baseDir },
      deps,
    );

    const res = readResponse('req-throw');
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/Missing Access/);
  });

  it('rejects an unknown request type', async () => {
    setSenderCtx();
    const deps = makeDeps(vi.fn());

    await handleRequestIpc(
      { type: 'something_else', requestId: 'req-unknown' },
      { sourceGroup: SOURCE_GROUP, isMain: true, ipcBaseDir: baseDir },
      deps,
    );

    const res = readResponse('req-unknown');
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/Unknown request type/);
  });
});
