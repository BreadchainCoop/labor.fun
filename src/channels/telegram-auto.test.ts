import { describe, it, expect } from 'vitest';

import {
  autoAllowlistMatches,
  buildJoinGreeting,
  chooseTelegramSlug,
  deriveTelegramGroupFolder,
  parseAutoAllowlist,
  slugifyTelegramName,
} from './telegram-auto.js';

describe('slugifyTelegramName', () => {
  it('lowercases + hyphenates', () => {
    expect(slugifyTelegramName('Project Team')).toBe('project-team');
  });

  it('strips emoji + punctuation', () => {
    expect(slugifyTelegramName('🥖 Bread — Ops!')).toBe('bread-ops');
  });

  it('returns empty string on all-symbols input (caller handles fallback)', () => {
    expect(slugifyTelegramName('🤔🚀!@#')).toBe('');
  });

  it('is idempotent', () => {
    const once = slugifyTelegramName('Alice Wonderland');
    expect(slugifyTelegramName(once)).toBe(once);
  });
});

describe('deriveTelegramGroupFolder', () => {
  it('uses telegram_<slugified title> when free', () => {
    expect(
      deriveTelegramGroupFolder(-1001234567890, 'Project Team', new Set()),
    ).toBe('telegram_project-team');
  });

  it('falls back to telegram_<id digits> when the title has no slug', () => {
    expect(deriveTelegramGroupFolder(-1001234567890, '🤔🚀', new Set())).toBe(
      'telegram_1001234567890',
    );
    expect(
      deriveTelegramGroupFolder(-1001234567890, undefined, new Set()),
    ).toBe('telegram_1001234567890');
  });

  it('deconflicts a taken folder with the chat id', () => {
    expect(
      deriveTelegramGroupFolder(
        -1001234567890,
        'Project Team',
        new Set(['telegram_project-team']),
      ),
    ).toBe('telegram_project-team_1001234567890');
  });

  it('deconflicts further with numeric suffixes', () => {
    const taken = new Set([
      'telegram_project-team',
      'telegram_project-team_1001234567890',
    ]);
    const folder = deriveTelegramGroupFolder(
      -1001234567890,
      'Project Team',
      taken,
    );
    expect(folder).not.toBe('telegram_project-team');
    expect(taken.has(folder)).toBe(false);
    expect(folder.endsWith('_2')).toBe(true);
  });

  it('always yields a valid group folder name', () => {
    const pattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
    const cases = [
      deriveTelegramGroupFolder(-100123, 'x'.repeat(200), new Set()),
      deriveTelegramGroupFolder(-100123, '— «Ünïcode» —', new Set()),
      deriveTelegramGroupFolder(42, undefined, new Set()),
    ];
    for (const folder of cases) {
      expect(folder).toMatch(pattern);
    }
  });
});

describe('buildJoinGreeting', () => {
  it('mentions the assistant name and how to trigger it', () => {
    const text = buildJoinGreeting('Breadbrich Engels', true);
    expect(text).toContain('Breadbrich Engels');
    expect(text).toContain('@Breadbrich Engels');
  });

  it('adds the privacy-mode hint when can_read_all_group_messages is false', () => {
    const text = buildJoinGreeting('Breadbrich Engels', false);
    expect(text).toContain('privacy mode');
    expect(text).toContain('admin');
  });

  it('omits the privacy hint when the bot can read all messages', () => {
    expect(buildJoinGreeting('Breadbrich Engels', true)).not.toContain(
      'privacy mode',
    );
  });

  it('omits the privacy hint when privacy state is unknown', () => {
    expect(buildJoinGreeting('Breadbrich Engels', undefined)).not.toContain(
      'privacy mode',
    );
  });
});

describe('parseAutoAllowlist', () => {
  it('empty / undefined → off', () => {
    expect(parseAutoAllowlist(undefined)).toEqual({ mode: 'off' });
    expect(parseAutoAllowlist('')).toEqual({ mode: 'off' });
    expect(parseAutoAllowlist('   ')).toEqual({ mode: 'off' });
  });

  it("'all' (any case) → all mode", () => {
    expect(parseAutoAllowlist('all')).toEqual({ mode: 'all' });
    expect(parseAutoAllowlist(' ALL ')).toEqual({ mode: 'all' });
  });

  it('comma-separated jids → list mode, whitespace-tolerant', () => {
    const parsed = parseAutoAllowlist(' tg:-1001234 , tg:-1005678 ,, ');
    expect(parsed.mode).toBe('list');
    if (parsed.mode === 'list') {
      expect(parsed.jids).toEqual(new Set(['tg:-1001234', 'tg:-1005678']));
    }
  });

  it('only separators → off', () => {
    expect(parseAutoAllowlist(', ,')).toEqual({ mode: 'off' });
  });
});

describe('autoAllowlistMatches', () => {
  it('off never matches', () => {
    expect(autoAllowlistMatches({ mode: 'off' }, 'tg:-100', true)).toBe(false);
  });

  it("'all' matches group chats only", () => {
    expect(autoAllowlistMatches({ mode: 'all' }, 'tg:-100', true)).toBe(true);
    expect(autoAllowlistMatches({ mode: 'all' }, 'tg:123', false)).toBe(false);
  });

  it('list matches listed jids only', () => {
    const cfg = {
      mode: 'list' as const,
      jids: new Set(['tg:-1001234']),
    };
    expect(autoAllowlistMatches(cfg, 'tg:-1001234', true)).toBe(true);
    expect(autoAllowlistMatches(cfg, 'tg:-1009999', true)).toBe(false);
  });
});

describe('chooseTelegramSlug', () => {
  const noFiles = {
    fileExists: () => false,
    readTelegramId: () => null,
  };

  it('returns the existing kb person when the identity is already bound', () => {
    expect(
      chooseTelegramSlug({
        telegramId: '111',
        username: 'alice',
        firstName: 'Alice',
        existingKbPerson: 'alice-wonderland',
        ...noFiles,
      }),
    ).toBe('alice-wonderland');
  });

  it('prefers username, then first name, then id fallback', () => {
    expect(
      chooseTelegramSlug({
        telegramId: '111',
        username: 'Alice_User',
        firstName: 'Alice',
        existingKbPerson: null,
        ...noFiles,
      }),
    ).toBe('alice-user');
    expect(
      chooseTelegramSlug({
        telegramId: '111',
        firstName: 'Alice Smith',
        existingKbPerson: null,
        ...noFiles,
      }),
    ).toBe('alice-smith');
    expect(
      chooseTelegramSlug({
        telegramId: '9876543210',
        firstName: '🤔',
        existingKbPerson: null,
        ...noFiles,
      }),
    ).toBe('tg-user-543210');
  });

  it('reuses an existing file that already belongs to this telegram id', () => {
    expect(
      chooseTelegramSlug({
        telegramId: '111',
        username: 'alice',
        existingKbPerson: null,
        fileExists: (slug) => slug === 'alice',
        readTelegramId: (slug) => (slug === 'alice' ? '111' : null),
      }),
    ).toBe('alice');
  });

  it('deconflicts when the slug belongs to a different person', () => {
    expect(
      chooseTelegramSlug({
        telegramId: '111',
        username: 'alice',
        existingKbPerson: null,
        fileExists: (slug) => slug === 'alice' || slug === 'alice-2',
        readTelegramId: (slug) =>
          slug === 'alice' ? '999' : slug === 'alice-2' ? '888' : null,
      }),
    ).toBe('alice-3');
  });
});
