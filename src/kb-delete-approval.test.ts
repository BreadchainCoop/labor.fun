import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { GROUPS_DIR, SHARED_KB_GROUP, isGatedActionClass } from './config.js';
import {
  _initTestDatabase,
  createPendingApproval,
  resolvePendingApproval,
  setRegisteredGroup,
} from './db.js';
import { checkKbDeleteApproval, processModifyKbFile, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

const KB_CONTEXT_DIR = path.join(GROUPS_DIR, SHARED_KB_GROUP, 'context');

// A unique subdir so the test never collides with real KB content and can be
// cleaned wholesale.
const TEST_SUBDIR = 'kb-delete-test';
const REL_PATH = `${TEST_SUBDIR}/doomed.md`;
const ABS_PATH = path.join(KB_CONTEXT_DIR, REL_PATH);

const GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'kb-delete-main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

let sent: Array<{ jid: string; text: string }>;
let deps: IpcDeps;

function seedFile(): void {
  fs.mkdirSync(path.dirname(ABS_PATH), { recursive: true });
  fs.writeFileSync(ABS_PATH, '# doomed doc\n');
}

function approvedKbDelete(pathInPayload: string) {
  const row = createPendingApproval({
    action_class: 'kb_delete',
    summary: `delete ${pathInPayload}`,
    payload: JSON.stringify({ filePath: pathInPayload }),
    chat_jid: 'main@g.us',
    group_folder: GROUP.folder,
    requested_by_user_id: 'alice',
  });
  resolvePendingApproval(row.id, 'approved', 'bob');
  return row.id;
}

beforeEach(() => {
  _initTestDatabase();
  setRegisteredGroup('main@g.us', GROUP);
  sent = [];
  deps = {
    sendMessage: async (jid, text) => {
      sent.push({ jid, text });
      return true;
    },
    canDeliver: () => true,
    deleteMessage: async () => {},
    editMessage: async () => {},
    registeredGroups: () => ({ 'main@g.us': GROUP }),
    registerGroup: () => {},
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
  };
  // Sanity: kb_delete must be in the gated set for these tests to be meaningful.
  expect(isGatedActionClass('kb_delete')).toBe(true);
  // Fresh disk state.
  try {
    fs.rmSync(path.join(KB_CONTEXT_DIR, TEST_SUBDIR), {
      recursive: true,
      force: true,
    });
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  try {
    fs.rmSync(path.join(KB_CONTEXT_DIR, TEST_SUBDIR), {
      recursive: true,
      force: true,
    });
  } catch {
    /* ignore */
  }
});

// --- checkKbDeleteApproval: branch coverage ---

describe('checkKbDeleteApproval', () => {
  it('refuses when no approval_id is provided', () => {
    const r = checkKbDeleteApproval(null, REL_PATH);
    expect(r.allowed).toBe(false);
  });

  it('refuses an unknown approval id', () => {
    const r = checkKbDeleteApproval('AP-nope', REL_PATH);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('not found');
  });

  it('refuses an approval for a different action_class', () => {
    const row = createPendingApproval({
      action_class: 'github_write',
      summary: 'x',
      payload: JSON.stringify({ filePath: REL_PATH }),
      chat_jid: 'main@g.us',
      group_folder: GROUP.folder,
      requested_by_user_id: 'alice',
    });
    resolvePendingApproval(row.id, 'approved', 'bob');
    const r = checkKbDeleteApproval(row.id, REL_PATH);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('not kb_delete');
  });

  it('refuses a still-pending (unapproved) row', () => {
    const row = createPendingApproval({
      action_class: 'kb_delete',
      summary: 'x',
      payload: JSON.stringify({ filePath: REL_PATH }),
      chat_jid: 'main@g.us',
      group_folder: GROUP.folder,
      requested_by_user_id: 'alice',
    });
    const r = checkKbDeleteApproval(row.id, REL_PATH);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('not approved');
  });

  it('refuses an expired approval', () => {
    const id = approvedKbDelete(REL_PATH);
    // Evaluate "now" far in the future relative to a short-lived expiry.
    const row = createPendingApproval({
      action_class: 'kb_delete',
      summary: 'x',
      payload: JSON.stringify({ filePath: REL_PATH }),
      chat_jid: 'main@g.us',
      group_folder: GROUP.folder,
      requested_by_user_id: 'alice',
      ttl_minutes: 60,
    });
    resolvePendingApproval(row.id, 'approved', 'bob');
    const future = new Date(Date.now() + 2 * 3600_000).toISOString();
    expect(checkKbDeleteApproval(row.id, REL_PATH, future).allowed).toBe(false);
    // The non-expiring one from approvedKbDelete still authorizes.
    expect(checkKbDeleteApproval(id, REL_PATH).allowed).toBe(true);
  });

  it('refuses when the approved payload references a DIFFERENT path', () => {
    const id = approvedKbDelete('other/thing.md');
    const r = checkKbDeleteApproval(id, REL_PATH);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('does not authorize');
  });

  it('allows an approved, unexpired approval whose payload matches the path', () => {
    const id = approvedKbDelete(REL_PATH);
    expect(checkKbDeleteApproval(id, REL_PATH).allowed).toBe(true);
  });

  it('matches even when the payload path has a leading slash', () => {
    const id = approvedKbDelete(`/${REL_PATH}`);
    expect(checkKbDeleteApproval(id, REL_PATH).allowed).toBe(true);
  });
});

// --- processModifyKbFile: real file deletion is gated ---

describe('processModifyKbFile — kb_delete enforcement', () => {
  it('does NOT delete the file without an approved approval', async () => {
    seedFile();
    expect(fs.existsSync(ABS_PATH)).toBe(true);
    await processModifyKbFile(
      { filePath: REL_PATH, action: 'delete' },
      GROUP.folder,
      true, // isMain — implicit allowlist, but delete still hard-gated
      deps,
    );
    // File survives; the agent is told to get approval.
    expect(fs.existsSync(ABS_PATH)).toBe(true);
    expect(sent.some((m) => m.text.includes('Refused to delete'))).toBe(true);
  });

  it('does NOT delete with a non-matching approval id', async () => {
    seedFile();
    const id = approvedKbDelete('some/other/file.md');
    await processModifyKbFile(
      { filePath: REL_PATH, action: 'delete', approval_id: id },
      GROUP.folder,
      true,
      deps,
    );
    expect(fs.existsSync(ABS_PATH)).toBe(true);
  });

  it('DELETES the file with a valid, matching, approved approval', async () => {
    seedFile();
    const id = approvedKbDelete(REL_PATH);
    await processModifyKbFile(
      { filePath: REL_PATH, action: 'delete', approval_id: id },
      GROUP.folder,
      true,
      deps,
    );
    expect(fs.existsSync(ABS_PATH)).toBe(false);
  });

  it('writes are NOT gated (unchanged behavior)', async () => {
    await processModifyKbFile(
      { filePath: REL_PATH, action: 'write', content: '# hello\n' },
      GROUP.folder,
      true,
      deps,
    );
    expect(fs.existsSync(ABS_PATH)).toBe(true);
    expect(fs.readFileSync(ABS_PATH, 'utf-8')).toContain('# hello');
  });
});
