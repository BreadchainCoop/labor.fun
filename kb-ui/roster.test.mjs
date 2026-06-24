import { describe, it, expect } from 'vitest';

import { buildUserRoster, readPeopleDir } from './roster.mjs';

const DASH = '\u2014';

describe('buildUserRoster', () => {
  const roles = {
    isAdmin: (u) => ['alice', 'bob'].includes(u.toLowerCase()),
    isSuperAdmin: (u) => u.toLowerCase() === 'alice',
    isCoordinator: (u) => u.toLowerCase() === 'lana',
  };

  it('derives identity/tags from people files, status from role predicates', () => {
    const people = {
      alice: {
        display: 'Alice Example',
        tags: ['admin', 'leadership'],
        slack: 'U999',
        telegram: '111',
      },
    };
    const roster = buildUserRoster(['alice'], people, roles);
    expect(roster.alice).toEqual({
      display: 'Alice Example',
      tags: ['admin', 'leadership'],
      admin: true,
      superadmin: true,
      slack: 'U999',
      telegram: '111',
      kb: 'All docs',
      crossSend: 'Yes',
    });
  });

  it('does not invent members — only the usernames passed in appear', () => {
    const roster = buildUserRoster(['onlyme'], {}, roles);
    expect(Object.keys(roster)).toEqual(['onlyme']);
    // No alice/bob/carol/ops/dave leaking in from anywhere.
    expect(roster.alice).toBeUndefined();
  });

  it('falls back to role-derived tags and dashes when no people file exists', () => {
    const roster = buildUserRoster(['bob', 'lana', 'guest'], {}, roles);
    expect(roster.bob).toMatchObject({
      display: 'bob',
      tags: ['admin'],
      admin: true,
      superadmin: false,
      slack: DASH,
      telegram: DASH,
      kb: 'All docs',
      crossSend: 'Yes',
    });
    expect(roster.lana).toMatchObject({
      tags: ['coordinator'],
      admin: false,
      kb: 'Non-private',
      crossSend: 'Yes',
    });
    expect(roster.guest).toMatchObject({
      display: 'guest',
      tags: [],
      admin: false,
      superadmin: false,
      kb: 'Open only',
      crossSend: 'No',
    });
  });

  it('matches a people file case-insensitively by slug', () => {
    const people = { sam: { display: 'Sam Stone', tags: ['member'] } };
    const roster = buildUserRoster(['Sam'], people, {});
    expect(roster.Sam.display).toBe('Sam Stone');
    expect(roster.Sam.tags).toEqual(['member']);
  });

  it('tolerates missing role predicates (everything non-privileged)', () => {
    const roster = buildUserRoster(['x'], {});
    expect(roster.x).toMatchObject({
      admin: false,
      superadmin: false,
      kb: 'Open only',
      crossSend: 'No',
    });
  });
});

describe('readPeopleDir', () => {
  it('returns an empty map when the directory is absent', () => {
    expect(readPeopleDir('/tmp/this-path-does-not-exist-12345/people')).toEqual(
      {},
    );
  });
});
