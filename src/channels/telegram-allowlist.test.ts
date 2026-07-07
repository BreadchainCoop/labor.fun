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
  GROUPS_DIR: '/tmp/telegram-allowlist-test-groups',
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
  ensureTelegramSenderAllowlisted,
} from './telegram-allowlist.js';

describe('ensureTelegramSenderAllowlisted', () => {
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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-allowlist-'));
    resolveUser = vi.fn(() => undefined);
    addIdentity = vi.fn();
    reloadPeople = vi.fn();
    _resetSeededCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the person file + identity for an unknown sender', () => {
    const result = ensureTelegramSenderAllowlisted(
      { telegramId: '111', username: 'alice_user', firstName: 'Alice' },
      deps(),
    );

    expect(result).toBe('created');
    const file = path.join(dir, 'alice-user.md');
    expect(fs.existsSync(file)).toBe(true);
    const parsed = matter(fs.readFileSync(file, 'utf-8'));
    expect(parsed.data.title).toBe('Alice');
    expect(String(parsed.data.telegram_id)).toBe('111');
    expect(parsed.data.telegram_username).toBe('alice_user');
    expect(parsed.data.created_by).toBe('telegram-auto-allowlist');
    expect(addIdentity).toHaveBeenCalledWith('111', 'telegram', 'alice-user');
    expect(reloadPeople).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for a sender who already resolves to a KB person', () => {
    resolveUser = vi.fn(() => 'alice-wonderland');

    const result = ensureTelegramSenderAllowlisted(
      { telegramId: '111', username: 'alice_user' },
      deps(),
    );

    expect(result).toBe('existing');
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(addIdentity).not.toHaveBeenCalled();
  });

  it('seeds exactly once — second call short-circuits without touching fs/db', () => {
    ensureTelegramSenderAllowlisted(
      { telegramId: '111', username: 'alice_user' },
      deps(),
    );
    const second = ensureTelegramSenderAllowlisted(
      { telegramId: '111', username: 'alice_user' },
      deps(),
    );

    expect(second).toBe('existing');
    expect(resolveUser).toHaveBeenCalledTimes(1); // only the first call hit the db
    expect(addIdentity).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(dir)).toEqual(['alice-user.md']);
  });

  it('deconflicts the slug when the file belongs to a different person', () => {
    fs.writeFileSync(
      path.join(dir, 'alice-user.md'),
      matter.stringify('someone else', { telegram_id: '999' }),
    );

    ensureTelegramSenderAllowlisted(
      { telegramId: '111', username: 'alice_user' },
      deps(),
    );

    expect(fs.existsSync(path.join(dir, 'alice-user-2.md'))).toBe(true);
    expect(addIdentity).toHaveBeenCalledWith('111', 'telegram', 'alice-user-2');
    // The pre-existing file is untouched.
    const original = matter(
      fs.readFileSync(path.join(dir, 'alice-user.md'), 'utf-8'),
    );
    expect(String(original.data.telegram_id)).toBe('999');
  });

  it('reuses + preserves an existing file already owned by this telegram id', () => {
    fs.writeFileSync(
      path.join(dir, 'alice-user.md'),
      matter.stringify('hand-written notes', {
        telegram_id: '111',
        title: 'Alice (Treasurer)',
      }),
    );

    ensureTelegramSenderAllowlisted(
      { telegramId: '111', username: 'alice_user' },
      deps(),
    );

    // Identity row restored, file content untouched.
    expect(addIdentity).toHaveBeenCalledWith('111', 'telegram', 'alice-user');
    const parsed = matter(
      fs.readFileSync(path.join(dir, 'alice-user.md'), 'utf-8'),
    );
    expect(parsed.data.title).toBe('Alice (Treasurer)');
    expect(parsed.content).toContain('hand-written notes');
  });

  it('falls back to first name, then id-based slug', () => {
    ensureTelegramSenderAllowlisted(
      { telegramId: '222', firstName: 'Bob Smith' },
      deps(),
    );
    expect(fs.existsSync(path.join(dir, 'bob-smith.md'))).toBe(true);

    ensureTelegramSenderAllowlisted({ telegramId: '9876543210' }, deps());
    expect(fs.existsSync(path.join(dir, 'tg-user-543210.md'))).toBe(true);
  });

  it('skips senders with no telegram id', () => {
    expect(ensureTelegramSenderAllowlisted({ telegramId: '' }, deps())).toBe(
      'skipped',
    );
    expect(addIdentity).not.toHaveBeenCalled();
  });
});
