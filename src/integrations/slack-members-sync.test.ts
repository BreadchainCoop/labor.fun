import { describe, it, expect, vi } from 'vitest';

// Pure helpers — no DB / no Slack / no fs access. runSlackMembersSync's network
// path is exercised against the live workspace; tests here guard the member
// filter and the frontmatter-merge contract that keeps on-disk files stable
// (and, crucially, non-destructive to manually-added fields like github) across
// re-runs.

vi.mock('../config.js', () => ({
  GROUPS_DIR: '/tmp/slack-members-test',
  SHARED_KB_GROUP: 'slack_main',
  SLACK_MEMBERS_SYNC_INTERVAL_MS: 0,
}));
vi.mock('../db.js', () => ({ initDatabase: vi.fn() }));
vi.mock('../permissions.js', () => ({
  addIdentity: vi.fn(),
  resolveUser: vi.fn(),
}));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@slack/web-api', () => ({ WebClient: class {} }));
vi.mock('./discord-members-sync.js', () => ({
  chooseSlug: vi.fn(() => 'stub-slug'),
}));

import {
  isSyncableMember,
  mergeSlackFrontmatter,
  defaultPersonBody,
  type SlackMemberFields,
} from './slack-members-sync.js';

const FIELDS: SlackMemberFields = {
  slack_id: 'U07FFTZEMPX',
  name: 'Ron Turetzky',
  email: 'ron@opacitylabs.com',
  timezone: 'America/New_York',
  last_synced_at: '2026-06-29T00:00:00Z',
};

describe('isSyncableMember', () => {
  const human = { id: 'U1', profile: { email: 'a@b.com' } };
  it('accepts a real human with an email', () => {
    expect(isSyncableMember(human)).toBe(true);
  });
  it('rejects bots', () => {
    expect(isSyncableMember({ ...human, is_bot: true })).toBe(false);
  });
  it('rejects deactivated accounts', () => {
    expect(isSyncableMember({ ...human, deleted: true })).toBe(false);
  });
  it('rejects app users', () => {
    expect(isSyncableMember({ ...human, is_app_user: true })).toBe(false);
  });
  it('rejects Slackbot', () => {
    expect(
      isSyncableMember({ id: 'USLACKBOT', profile: { email: 'x@y.com' } }),
    ).toBe(false);
  });
  it('rejects members with no email', () => {
    expect(isSyncableMember({ id: 'U1', profile: {} })).toBe(false);
  });
});

describe('mergeSlackFrontmatter', () => {
  it('builds full frontmatter for a brand-new person', () => {
    const fm = mergeSlackFrontmatter(null, FIELDS);
    expect(fm.name).toBe('Ron Turetzky');
    expect(fm.email).toBe('ron@opacitylabs.com');
    expect(fm.timezone).toBe('America/New_York');
    expect((fm.platforms as { slack?: string }).slack).toBe('U07FFTZEMPX');
    expect(fm.role).toBe('member');
    expect(fm.tags).toEqual(expect.arrayContaining(['team', 'slack-synced']));
    expect(fm.created_by).toBe('slack-sync');
    expect(fm.last_synced_at).toBe('2026-06-29T00:00:00Z');
  });

  it('preserves role, github handle, and manual fields on re-sync', () => {
    const existing = {
      role: 'admin',
      tags: ['team'],
      platforms: { slack: 'U07FFTZEMPX', github: 'RonTuretzky' },
      pay_parity_note: 'lead',
      created_by: 'manual',
      visibility: 'open',
    };
    const fm = mergeSlackFrontmatter(existing, FIELDS);
    expect(fm.role).toBe('admin'); // preserved (not forced to 'member')
    expect((fm.platforms as { github?: string }).github).toBe('RonTuretzky'); // preserved
    expect((fm.platforms as { slack?: string }).slack).toBe('U07FFTZEMPX'); // refreshed
    expect(fm.pay_parity_note).toBe('lead'); // preserved
    expect(fm.created_by).toBe('manual'); // set-if-absent, not overwritten
    expect(fm.visibility).toBe('open'); // set-if-absent, not overwritten
    expect(fm.email).toBe('ron@opacitylabs.com'); // refreshed
  });

  it('keeps the existing timezone when Slack reports none', () => {
    const fm = mergeSlackFrontmatter(
      { timezone: 'America/New_York' },
      { ...FIELDS, timezone: '' },
    );
    expect(fm.timezone).toBe('America/New_York');
  });
});

describe('defaultPersonBody', () => {
  it('includes the name and a preserve note', () => {
    const body = defaultPersonBody(FIELDS);
    expect(body).toContain('Ron Turetzky');
    expect(body).toContain('preserved across syncs');
  });
});
