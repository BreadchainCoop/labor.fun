import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from 'vitest';
import matter from 'gray-matter';

// Import-safety shims — every side effect is injected via deps below.
vi.mock('../config.js', () => ({
  GROUPS_DIR: '/tmp/whatsapp-allowlist-test-groups',
  SHARED_KB_GROUP: 'main',
}));
vi.mock('../permissions.js', () => ({
  addIdentity: vi.fn(),
  resolveUser: vi.fn(),
  loadPeopleFromKB: vi.fn(),
}));
vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  _resetSeededCacheForTests,
  ensureWhatsAppSenderAllowlisted,
} from './whatsapp-allowlist.js';

describe('ensureWhatsAppSenderAllowlisted', () => {
  let dir: string;
  let resolveUser: Mock<
    (platformId: string, platform: string) => string | undefined
  >;
  let addIdentity: Mock<
    (platformId: string, platform: string, kbPerson: string) => void
  >;
  let reloadPeople: Mock<() => void>;

  const deps = () => ({
    peopleDir: () => dir,
    resolveUser,
    addIdentity,
    reloadPeople,
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-allowlist-'));
    resolveUser = vi.fn(() => undefined);
    addIdentity = vi.fn();
    reloadPeople = vi.fn();
    _resetSeededCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the person file + identity for an unknown sender', () => {
    const result = ensureWhatsAppSenderAllowlisted(
      { whatsappId: '5551234@s.whatsapp.net', name: 'Alice' },
      deps(),
    );

    expect(result).toBe('created');
    const file = path.join(dir, 'alice.md');
    expect(fs.existsSync(file)).toBe(true);
    const parsed = matter(fs.readFileSync(file, 'utf-8'));
    expect(parsed.data.title).toBe('Alice');
    expect(String(parsed.data.whatsapp_id)).toBe('5551234@s.whatsapp.net');
    expect(parsed.data.created_by).toBe('whatsapp-auto-allowlist');
    expect(parsed.data.visibility).toBe('private');
    expect(parsed.data.tags).toEqual(['whatsapp-auto-allowlist']);
    expect(addIdentity).toHaveBeenCalledWith(
      '5551234@s.whatsapp.net',
      'whatsapp',
      'alice',
    );
    expect(reloadPeople).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for a sender who already resolves to a KB person', () => {
    resolveUser = vi.fn(() => 'alice-wonderland');

    const result = ensureWhatsAppSenderAllowlisted(
      { whatsappId: '5551234@s.whatsapp.net', name: 'Alice' },
      deps(),
    );

    expect(result).toBe('existing');
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(addIdentity).not.toHaveBeenCalled();
  });

  it('seeds exactly once — second call short-circuits without touching fs/db', () => {
    ensureWhatsAppSenderAllowlisted(
      { whatsappId: '5551234@s.whatsapp.net', name: 'Alice' },
      deps(),
    );
    const second = ensureWhatsAppSenderAllowlisted(
      { whatsappId: '5551234@s.whatsapp.net', name: 'Alice' },
      deps(),
    );

    expect(second).toBe('existing');
    expect(resolveUser).toHaveBeenCalledTimes(1); // only the first call hit the db
    expect(addIdentity).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(dir)).toEqual(['alice.md']);
  });

  it('deconflicts the slug when the file belongs to a different person', () => {
    fs.writeFileSync(
      path.join(dir, 'alice.md'),
      matter.stringify('someone else', {
        whatsapp_id: '9999@s.whatsapp.net',
      }),
    );

    ensureWhatsAppSenderAllowlisted(
      { whatsappId: '5551234@s.whatsapp.net', name: 'Alice' },
      deps(),
    );

    expect(fs.existsSync(path.join(dir, 'alice-2.md'))).toBe(true);
    expect(addIdentity).toHaveBeenCalledWith(
      '5551234@s.whatsapp.net',
      'whatsapp',
      'alice-2',
    );
    // The pre-existing file is untouched.
    const original = matter(
      fs.readFileSync(path.join(dir, 'alice.md'), 'utf-8'),
    );
    expect(String(original.data.whatsapp_id)).toBe('9999@s.whatsapp.net');
  });

  it('reuses + preserves an existing file already owned by this whatsapp id', () => {
    fs.writeFileSync(
      path.join(dir, 'alice.md'),
      matter.stringify('hand-written notes', {
        whatsapp_id: '5551234@s.whatsapp.net',
        title: 'Alice (Treasurer)',
      }),
    );

    ensureWhatsAppSenderAllowlisted(
      { whatsappId: '5551234@s.whatsapp.net', name: 'Alice' },
      deps(),
    );

    // Identity row restored, file content untouched.
    expect(addIdentity).toHaveBeenCalledWith(
      '5551234@s.whatsapp.net',
      'whatsapp',
      'alice',
    );
    const parsed = matter(fs.readFileSync(path.join(dir, 'alice.md'), 'utf-8'));
    expect(parsed.data.title).toBe('Alice (Treasurer)');
    expect(parsed.content).toContain('hand-written notes');
  });

  it('falls back to a jid-based slug when there is no push name', () => {
    ensureWhatsAppSenderAllowlisted(
      { whatsappId: '9876543210@s.whatsapp.net' },
      deps(),
    );
    expect(fs.existsSync(path.join(dir, 'wa-user-543210.md'))).toBe(true);
  });

  it('skips senders with no whatsapp id', () => {
    expect(ensureWhatsAppSenderAllowlisted({ whatsappId: '' }, deps())).toBe(
      'skipped',
    );
    expect(addIdentity).not.toHaveBeenCalled();
  });
});
