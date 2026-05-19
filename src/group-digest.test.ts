import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GROUPS_DIR } from './config.js';
import {
  _initTestDatabase,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessageDirect,
} from './db.js';
import {
  _resetDigestLoopForTests,
  writeAllGroupDigests,
} from './group-digest.js';

const MAIN_FOLDER = 'digest_test_main';
const NON_MAIN_FOLDER = 'digest_test_other';
const MAIN_JID = 'digest-test-main@g.us';
const NON_MAIN_JID = 'digest-test-other@g.us';

let digestRoot: string;
const createdGroupDirs: string[] = [];

function ensureGroupDir(folder: string): string {
  const dir = path.join(GROUPS_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  if (!createdGroupDirs.includes(dir)) createdGroupDirs.push(dir);
  return dir;
}

describe('group-digest', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetDigestLoopForTests();
    digestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'breadbrich-digest-'));
  });

  afterEach(() => {
    fs.rmSync(digestRoot, { recursive: true, force: true });
    while (createdGroupDirs.length) {
      const dir = createdGroupDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes nothing and skips main when no non-main groups exist', async () => {
    setRegisteredGroup(MAIN_JID, {
      name: 'Main',
      folder: MAIN_FOLDER,
      trigger: '',
      added_at: new Date().toISOString(),
      isMain: true,
    });

    const result = await writeAllGroupDigests(digestRoot);

    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
    expect(fs.readdirSync(digestRoot)).toEqual([]);
  });

  it('writes a digest with stats for a non-main group with recent messages', async () => {
    setRegisteredGroup(NON_MAIN_JID, {
      name: 'Other Group',
      folder: NON_MAIN_FOLDER,
      trigger: '',
      added_at: new Date().toISOString(),
    });

    // IMPORTANT: prod channels store timestamps as ISO 8601 strings via
    // new Date(...).toISOString() — see src/channels/{slack,telegram}.ts.
    // Test fixtures MUST mirror that shape so the time-window filter is
    // actually exercised. Using numeric-ms-as-string would mask bugs in
    // the SQL filter (regression test for the CAST-as-REAL bug caught
    // in PR #55 review).
    const now = Date.now();
    const tsIso = (offsetMs: number) => new Date(now - offsetMs).toISOString();
    storeChatMetadata(NON_MAIN_JID, tsIso(10_000), 'Other Group');
    storeMessageDirect({
      id: 'm1',
      chat_jid: NON_MAIN_JID,
      sender: 'u1',
      sender_name: 'Alice',
      content: 'hello from alice',
      timestamp: tsIso(5_000),
      is_from_me: false,
    });
    storeMessageDirect({
      id: 'm2',
      chat_jid: NON_MAIN_JID,
      sender: 'bot',
      sender_name: 'Breadbrich Engels',
      content: 'bot reply',
      timestamp: tsIso(4_000),
      is_from_me: true,
      is_bot_message: true,
    });
    // Outside-window message — must NOT count toward last-hour stats
    storeMessageDirect({
      id: 'm0_old',
      chat_jid: NON_MAIN_JID,
      sender: 'u1',
      sender_name: 'Alice',
      content: 'old message from yesterday',
      timestamp: tsIso(2 * 60 * 60 * 1000), // 2 hours ago
      is_from_me: false,
    });

    const result = await writeAllGroupDigests(digestRoot);

    expect(result.written).toBe(1);
    const body = fs.readFileSync(
      path.join(digestRoot, `${NON_MAIN_FOLDER}.md`),
      'utf8',
    );
    expect(body).toContain('messages_last_hour: 2');
    expect(body).toContain('from_users_last_hour: 1');
    expect(body).toContain('from_bot_last_hour: 1');
    expect(body).toContain('Alice');
    expect(body).toContain('hello from alice');
  });

  it('writes a digest with placeholder text when group has no messages', async () => {
    setRegisteredGroup(NON_MAIN_JID, {
      name: 'Quiet Group',
      folder: NON_MAIN_FOLDER,
      trigger: '',
      added_at: new Date().toISOString(),
    });

    const result = await writeAllGroupDigests(digestRoot);

    expect(result.written).toBe(1);
    const body = fs.readFileSync(
      path.join(digestRoot, `${NON_MAIN_FOLDER}.md`),
      'utf8',
    );
    expect(body).toContain('messages_last_hour: 0');
    expect(body).toContain('_no recent messages_');
    expect(body).toContain('claude_md_changed_in_window: false');
  });

  it('flags claude_md_changed_in_window when CLAUDE.md was touched in the last hour', async () => {
    setRegisteredGroup(NON_MAIN_JID, {
      name: 'Touched Group',
      folder: NON_MAIN_FOLDER,
      trigger: '',
      added_at: new Date().toISOString(),
    });
    const groupDir = ensureGroupDir(NON_MAIN_FOLDER);
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), '# group memory\n');

    const result = await writeAllGroupDigests(digestRoot);

    expect(result.written).toBe(1);
    const body = fs.readFileSync(
      path.join(digestRoot, `${NON_MAIN_FOLDER}.md`),
      'utf8',
    );
    expect(body).toContain('claude_md_changed_in_window: true');
  });
});
