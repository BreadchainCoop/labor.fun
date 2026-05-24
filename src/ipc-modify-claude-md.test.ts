import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GROUPS_DIR } from './config.js';
import { _initTestDatabase, getDb } from './db.js';
import { handleModifyGroupClaudeMd } from './ipc.js';

const TARGET_FOLDER = 'modclaude_test_target';
const TARGET_DIR = path.join(GROUPS_DIR, TARGET_FOLDER);
const TARGET_FILE = path.join(TARGET_DIR, 'CLAUDE.md');
const SOURCE_MAIN = 'telegram_modclaude_main';

function allowlistedCtx() {
  return {
    sourceGroup: SOURCE_MAIN,
    isMain: true,
    senderCtx: {
      user_id: 'tg:42@user',
      display_name: 'Test User',
      tags: [],
    },
  };
}

function readAuditRows(): Array<{
  file_path: string;
  action: string;
  changed_by: string;
  changes: string | null;
}> {
  return getDb()
    .prepare(
      `SELECT file_path, action, changed_by, changes FROM kb_audit_log ORDER BY id ASC`,
    )
    .all() as Array<{
    file_path: string;
    action: string;
    changed_by: string;
    changes: string | null;
  }>;
}

describe('handleModifyGroupClaudeMd', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    fs.rmSync(TARGET_DIR, { recursive: true, force: true });
  });

  it('writes the target CLAUDE.md and records an audit row on the happy path', () => {
    const result = handleModifyGroupClaudeMd(
      {
        target_folder: TARGET_FOLDER,
        new_content: '# Target\n\nFresh memory.\n',
        summary: 'initial seed',
      },
      allowlistedCtx(),
    );

    expect(result.status).toBe('ok');
    expect(result.bytesBefore).toBe(0);
    expect(result.bytesAfter).toBe(
      Buffer.byteLength('# Target\n\nFresh memory.\n', 'utf-8'),
    );

    expect(fs.existsSync(TARGET_FILE)).toBe(true);
    expect(fs.readFileSync(TARGET_FILE, 'utf-8')).toBe(
      '# Target\n\nFresh memory.\n',
    );

    const audit = readAuditRows();
    expect(audit.length).toBe(1);
    expect(audit[0].action).toBe('modify_group_claude_md');
    expect(audit[0].changed_by).toBe('tg:42@user');
    expect(audit[0].file_path).toBe(TARGET_FILE);
    const changes = JSON.parse(audit[0].changes!);
    expect(changes.targetFolder).toBe(TARGET_FOLDER);
    expect(changes.sourceGroup).toBe(SOURCE_MAIN);
    expect(changes.summary).toBe('initial seed');
    expect(changes.bytesBefore).toBe(0);
  });

  it('overwrites an existing CLAUDE.md and reports bytesBefore correctly', () => {
    fs.mkdirSync(TARGET_DIR, { recursive: true });
    fs.writeFileSync(TARGET_FILE, 'OLD CONTENT 12345');

    const result = handleModifyGroupClaudeMd(
      { target_folder: TARGET_FOLDER, new_content: 'NEW' },
      allowlistedCtx(),
    );

    expect(result.status).toBe('ok');
    expect(result.bytesBefore).toBe(17);
    expect(result.bytesAfter).toBe(3);
    expect(fs.readFileSync(TARGET_FILE, 'utf-8')).toBe('NEW');
  });

  it('allows a non-main source group when an allowlisted sender is attached', () => {
    const result = handleModifyGroupClaudeMd(
      { target_folder: TARGET_FOLDER, new_content: 'X' },
      { ...allowlistedCtx(), isMain: false },
    );

    expect(result.status).toBe('ok');
    expect(fs.existsSync(TARGET_FILE)).toBe(true);
  });

  it('rejects when there is no validated sender (even from a main group)', () => {
    const result = handleModifyGroupClaudeMd(
      { target_folder: TARGET_FOLDER, new_content: 'X' },
      { ...allowlistedCtx(), senderCtx: null },
    );

    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('unauthorized');
    expect(fs.existsSync(TARGET_FILE)).toBe(false);
    expect(readAuditRows().length).toBe(0);
  });

  it('rejects path-traversal target_folder', () => {
    const result = handleModifyGroupClaudeMd(
      { target_folder: '../../etc', new_content: 'X' },
      allowlistedCtx(),
    );

    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('invalid_target_folder');
    expect(readAuditRows().length).toBe(0);
  });

  it('rejects empty/reserved folder names', () => {
    const empty = handleModifyGroupClaudeMd(
      { target_folder: '', new_content: 'X' },
      allowlistedCtx(),
    );
    const global = handleModifyGroupClaudeMd(
      { target_folder: 'global', new_content: 'X' },
      allowlistedCtx(),
    );

    expect(empty.status).toBe('rejected');
    expect(empty.reason).toBe('invalid_target_folder');
    expect(global.status).toBe('rejected');
    expect(global.reason).toBe('invalid_target_folder');
    expect(readAuditRows().length).toBe(0);
  });

  it('rejects oversized new_content above the 200KB cap', () => {
    const tooBig = 'x'.repeat(200 * 1024 + 1);
    const result = handleModifyGroupClaudeMd(
      { target_folder: TARGET_FOLDER, new_content: tooBig },
      allowlistedCtx(),
    );

    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('oversized');
    expect(fs.existsSync(TARGET_FILE)).toBe(false);
    expect(readAuditRows().length).toBe(0);
  });

  it('accepts content right at the 200KB cap', () => {
    const atCap = 'y'.repeat(200 * 1024);
    const result = handleModifyGroupClaudeMd(
      { target_folder: TARGET_FOLDER, new_content: atCap },
      allowlistedCtx(),
    );

    expect(result.status).toBe('ok');
    expect(result.bytesAfter).toBe(200 * 1024);
  });

  it('records the sender user_id in the audit log', () => {
    handleModifyGroupClaudeMd(
      { target_folder: TARGET_FOLDER, new_content: 'X' },
      {
        ...allowlistedCtx(),
        senderCtx: {
          user_id: 'discord:99@alice',
          display_name: 'Alice',
          tags: ['ops'],
        },
      },
    );

    const audit = readAuditRows();
    expect(audit[0].changed_by).toBe('discord:99@alice');
  });
});
