import { describe, it, expect, vi } from 'vitest';

// Pure helpers — no DB / no Discord / no fs access. The runDiscordMembersSync
// integration path is exercised manually against the live bot; tests here
// guard the slug + frontmatter merge contracts that determine on-disk
// stability across re-runs.

vi.mock('../config.js', () => ({
  DISCORD_DM_ALLOWED_GUILD_IDS: [] as string[],
  DISCORD_DM_ALLOWED_ROLE_IDS: [] as string[],
  DISCORD_MEMBERS_SYNC_INTERVAL_MS: 0,
  GROUPS_DIR: '/tmp/discord-members-test',
  SHARED_KB_GROUP: 'discord_main',
}));

vi.mock('../db.js', () => ({
  initDatabase: vi.fn(),
}));

vi.mock('../permissions.js', () => ({
  addIdentity: vi.fn(),
  resolveUser: vi.fn(),
}));

vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('discord.js', () => ({
  Client: class {},
  GatewayIntentBits: { Guilds: 1, GuildMembers: 2 },
  Partials: { GuildMember: 1 },
}));

import {
  chooseSlug,
  defaultPersonBody,
  mergeFrontmatter,
  slugify,
} from './discord-members-sync.js';

describe('slugify', () => {
  it('lowercases + hyphenates', () => {
    expect(slugify('Josh The Builder')).toBe('josh-the-builder');
  });

  it('strips emoji + punctuation', () => {
    expect(slugify('🎩 Ron — turetzky.eth')).toBe('ron-turetzky-eth');
  });

  it('returns empty string on all-symbols input (caller handles fallback)', () => {
    expect(slugify('🤔🚀!@#')).toBe('');
  });

  it('is idempotent', () => {
    const once = slugify('Alice Wonderland');
    expect(slugify(once)).toBe(once);
  });
});

describe('chooseSlug', () => {
  const base = {
    discordId: '123',
    displayName: 'Josh',
    username: 'theblockchainsocialist',
    fileExists: (_s: string) => false,
    readDiscordId: (_s: string) => null,
  };

  it('returns the existing kb_person mapping when one is present', () => {
    expect(chooseSlug({ ...base, existingKbPerson: 'josh-treasurer' })).toBe(
      'josh-treasurer',
    );
  });

  it('uses slugified display name when no mapping and no collision', () => {
    expect(chooseSlug({ ...base, existingKbPerson: null })).toBe('josh');
  });

  it('falls back to username, then to user-<id> tail, on empty display name', () => {
    expect(
      chooseSlug({
        ...base,
        existingKbPerson: null,
        displayName: '',
      }),
    ).toBe('theblockchainsocialist');
    expect(
      chooseSlug({
        ...base,
        existingKbPerson: null,
        displayName: '',
        username: '',
        discordId: '987654321098765432',
      }),
    ).toBe('user-765432');
  });

  it('reuses the existing file when it already belongs to the same Discord id', () => {
    const fileExists = (s: string) => s === 'josh';
    const readDiscordId = (s: string) => (s === 'josh' ? '123' : null);
    expect(
      chooseSlug({
        ...base,
        existingKbPerson: null,
        fileExists,
        readDiscordId,
      }),
    ).toBe('josh');
  });

  it('deconflicts to josh-2 when josh.md belongs to a DIFFERENT Discord id', () => {
    const fileExists = (s: string) => s === 'josh';
    const readDiscordId = (s: string) =>
      s === 'josh' ? '999_someone_else' : null;
    expect(
      chooseSlug({
        ...base,
        existingKbPerson: null,
        fileExists,
        readDiscordId,
      }),
    ).toBe('josh-2');
  });

  it('keeps incrementing through collisions', () => {
    const takenByOthers: Record<string, string> = {
      josh: '900',
      'josh-2': '901',
      'josh-3': '902',
    };
    const fileExists = (s: string) => s in takenByOthers;
    const readDiscordId = (s: string) => takenByOthers[s] ?? null;
    expect(
      chooseSlug({
        ...base,
        existingKbPerson: null,
        fileExists,
        readDiscordId,
      }),
    ).toBe('josh-4');
  });
});

describe('mergeFrontmatter', () => {
  const discord = {
    discord_id: '123',
    discord_username: 'jbuilder',
    discord_display_name: 'Josh',
    discord_roles: ['Member'],
    last_synced_at: '2026-05-21T11:00:00Z',
  };

  it('creates fresh frontmatter when existing is null', () => {
    const fm = mergeFrontmatter(null, discord, 'Josh');
    expect(fm.title).toBe('Josh');
    expect(fm.created_by).toBe('discord-sync');
    expect(fm.visibility).toBe('private');
    expect(fm.tags).toEqual(['discord-synced']);
    expect(fm.discord_id).toBe('123');
    expect(fm.last_synced_at).toBe('2026-05-21T11:00:00Z');
  });

  it('preserves a human-edited title across re-syncs', () => {
    const fm = mergeFrontmatter(
      { title: 'Josh (Treasurer)', visibility: 'private' },
      discord,
      'Josh',
    );
    expect(fm.title).toBe('Josh (Treasurer)');
  });

  it('preserves human-set non-Discord fields', () => {
    const fm = mergeFrontmatter(
      {
        title: 'Josh',
        visibility: 'private',
        skills: ['solidity', 'product'],
        contact: 'josh@example.com',
      },
      discord,
      'Josh',
    );
    expect(fm.skills).toEqual(['solidity', 'product']);
    expect(fm.contact).toBe('josh@example.com');
  });

  it('always refreshes Discord-derived fields', () => {
    const fm = mergeFrontmatter(
      {
        discord_id: '123',
        discord_username: 'old-handle',
        discord_display_name: 'OldName',
        discord_roles: ['OldRole'],
        last_synced_at: '2024-01-01T00:00:00Z',
      },
      discord,
      'Josh',
    );
    expect(fm.discord_username).toBe('jbuilder');
    expect(fm.discord_display_name).toBe('Josh');
    expect(fm.discord_roles).toEqual(['Member']);
    expect(fm.last_synced_at).toBe('2026-05-21T11:00:00Z');
  });

  it('does not duplicate the discord-synced tag on re-runs', () => {
    const fm = mergeFrontmatter(
      { tags: ['discord-synced', 'admin'] },
      discord,
      'Josh',
    );
    expect(fm.tags).toEqual(['discord-synced', 'admin']);
  });

  it('does not overwrite a human-edited visibility', () => {
    const fm = mergeFrontmatter({ visibility: 'open' }, discord, 'Josh');
    expect(fm.visibility).toBe('open');
  });
});

describe('defaultPersonBody', () => {
  it('includes the Discord ID + username, and a note that re-runs preserve edits', () => {
    const body = defaultPersonBody({
      discord_id: '123',
      discord_username: 'jbuilder',
      discord_display_name: 'Josh',
      discord_roles: [],
      last_synced_at: '2026-05-21T11:00:00Z',
    });
    expect(body).toContain('Discord ID: 123');
    expect(body).toContain('Discord Username: @jbuilder');
    expect(body).toContain('edits below are preserved');
  });
});
