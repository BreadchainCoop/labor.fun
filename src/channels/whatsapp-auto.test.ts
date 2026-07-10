import { describe, it, expect } from 'vitest';

import {
  autoAllowlistMatches,
  chooseWhatsAppSlug,
  deriveWhatsAppGroupFolder,
  parseAutoAllowlist,
  slugifyWhatsAppName,
} from './whatsapp-auto.js';

describe('slugifyWhatsAppName', () => {
  it('lowercases + hyphenates', () => {
    expect(slugifyWhatsAppName('Project Team')).toBe('project-team');
  });

  it('strips emoji + punctuation', () => {
    expect(slugifyWhatsAppName('🥖 Bread — Ops!')).toBe('bread-ops');
  });

  it('returns empty string on all-symbols input (caller handles fallback)', () => {
    expect(slugifyWhatsAppName('🤔🚀!@#')).toBe('');
  });

  it('is idempotent', () => {
    const once = slugifyWhatsAppName('Alice Wonderland');
    expect(slugifyWhatsAppName(once)).toBe(once);
  });
});

describe('deriveWhatsAppGroupFolder', () => {
  it('uses whatsapp_<slugified name> when free', () => {
    expect(
      deriveWhatsAppGroupFolder(
        '120363000000000000@g.us',
        'Project Team',
        new Set(),
      ),
    ).toBe('whatsapp_project-team');
  });

  it('falls back to whatsapp_<jid digits> when the name has no slug', () => {
    expect(
      deriveWhatsAppGroupFolder('120363000000000000@g.us', '🤔🚀', new Set()),
    ).toBe('whatsapp_120363000000000000');
    expect(
      deriveWhatsAppGroupFolder(
        '120363000000000000@g.us',
        undefined,
        new Set(),
      ),
    ).toBe('whatsapp_120363000000000000');
  });

  it('derives from a DM JID (@s.whatsapp.net) too', () => {
    expect(
      deriveWhatsAppGroupFolder('5551234@s.whatsapp.net', 'Alice', new Set()),
    ).toBe('whatsapp_alice');
    // A LID-suffixed / device-suffixed user part is stripped to bare digits.
    expect(
      deriveWhatsAppGroupFolder(
        '5551234:7@s.whatsapp.net',
        undefined,
        new Set(),
      ),
    ).toBe('whatsapp_5551234');
  });

  it('deconflicts a taken folder with the jid digits', () => {
    expect(
      deriveWhatsAppGroupFolder(
        '120363000000000000@g.us',
        'Project Team',
        new Set(['whatsapp_project-team']),
      ),
    ).toBe('whatsapp_project-team_120363000000000000');
  });

  it('deconflicts further with numeric suffixes', () => {
    const taken = new Set([
      'whatsapp_project-team',
      'whatsapp_project-team_120363000000000000',
    ]);
    const folder = deriveWhatsAppGroupFolder(
      '120363000000000000@g.us',
      'Project Team',
      taken,
    );
    expect(folder).not.toBe('whatsapp_project-team');
    expect(taken.has(folder)).toBe(false);
    expect(folder.endsWith('_2')).toBe(true);
  });

  it('always yields a valid group folder name', () => {
    const pattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
    const cases = [
      deriveWhatsAppGroupFolder('12345@g.us', 'x'.repeat(200), new Set()),
      deriveWhatsAppGroupFolder('12345@g.us', '— «Ünïcode» —', new Set()),
      deriveWhatsAppGroupFolder('42@s.whatsapp.net', undefined, new Set()),
    ];
    for (const folder of cases) {
      expect(folder).toMatch(pattern);
    }
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
    const parsed = parseAutoAllowlist(
      ' 120363000000000000@g.us , 120363111111111111@g.us ,, ',
    );
    expect(parsed.mode).toBe('list');
    if (parsed.mode === 'list') {
      expect(parsed.jids).toEqual(
        new Set(['120363000000000000@g.us', '120363111111111111@g.us']),
      );
    }
  });

  it('only separators → off', () => {
    expect(parseAutoAllowlist(', ,')).toEqual({ mode: 'off' });
  });
});

describe('autoAllowlistMatches', () => {
  it('off never matches', () => {
    expect(autoAllowlistMatches({ mode: 'off' }, '123@g.us', true)).toBe(false);
  });

  it("'all' matches group chats only", () => {
    expect(autoAllowlistMatches({ mode: 'all' }, '123@g.us', true)).toBe(true);
    expect(
      autoAllowlistMatches({ mode: 'all' }, '5551234@s.whatsapp.net', false),
    ).toBe(false);
  });

  it('list matches listed jids only (groups or DMs)', () => {
    const cfg = {
      mode: 'list' as const,
      jids: new Set(['120363000000000000@g.us']),
    };
    expect(autoAllowlistMatches(cfg, '120363000000000000@g.us', true)).toBe(
      true,
    );
    expect(autoAllowlistMatches(cfg, '120363999999999999@g.us', true)).toBe(
      false,
    );
  });
});

describe('chooseWhatsAppSlug', () => {
  const noFiles = {
    fileExists: () => false,
    readWhatsAppId: () => null,
  };

  it('returns the existing kb person when the identity is already bound', () => {
    expect(
      chooseWhatsAppSlug({
        whatsappId: '5551234@s.whatsapp.net',
        name: 'Alice',
        existingKbPerson: 'alice-wonderland',
        ...noFiles,
      }),
    ).toBe('alice-wonderland');
  });

  it('prefers push name, then jid-digit fallback', () => {
    expect(
      chooseWhatsAppSlug({
        whatsappId: '5551234@s.whatsapp.net',
        name: 'Alice Smith',
        existingKbPerson: null,
        ...noFiles,
      }),
    ).toBe('alice-smith');
    expect(
      chooseWhatsAppSlug({
        whatsappId: '9876543210@s.whatsapp.net',
        name: '🤔',
        existingKbPerson: null,
        ...noFiles,
      }),
    ).toBe('wa-user-543210');
    expect(
      chooseWhatsAppSlug({
        whatsappId: '9876543210@s.whatsapp.net',
        existingKbPerson: null,
        ...noFiles,
      }),
    ).toBe('wa-user-543210');
  });

  it('reuses an existing file that already belongs to this whatsapp id', () => {
    expect(
      chooseWhatsAppSlug({
        whatsappId: '5551234@s.whatsapp.net',
        name: 'alice',
        existingKbPerson: null,
        fileExists: (slug) => slug === 'alice',
        readWhatsAppId: (slug) =>
          slug === 'alice' ? '5551234@s.whatsapp.net' : null,
      }),
    ).toBe('alice');
  });

  it('deconflicts when the slug belongs to a different person', () => {
    expect(
      chooseWhatsAppSlug({
        whatsappId: '5551234@s.whatsapp.net',
        name: 'alice',
        existingKbPerson: null,
        fileExists: (slug) => slug === 'alice' || slug === 'alice-2',
        readWhatsAppId: (slug) =>
          slug === 'alice'
            ? '9999@s.whatsapp.net'
            : slug === 'alice-2'
              ? '8888@s.whatsapp.net'
              : null,
      }),
    ).toBe('alice-3');
  });
});
