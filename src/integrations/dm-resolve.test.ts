import { describe, it, expect } from 'vitest';

import { resolveDmTarget, PersonCandidate } from './dm-resolve.js';

const CANDIDATES: PersonCandidate[] = [
  {
    slug: 'josh-tbs',
    discordId: '511575159929438224',
    title: 'Josh',
    discordUsername: 'theblockchainsocialist',
    discordDisplayName: 'Josh | TBS',
  },
  {
    slug: '0xr',
    discordId: '499196313473122313',
    title: 'Ruben',
    discordUsername: '.pondivibe',
    discordDisplayName: '0xR',
  },
  {
    slug: 'ron',
    discordId: '207210803605012480',
    title: 'Ron',
    discordUsername: 'roncodes',
    discordDisplayName: 'Ron',
  },
];

describe('resolveDmTarget — Discord ID path', () => {
  it('resolves a known numeric ID', () => {
    const r = resolveDmTarget('511575159929438224', CANDIDATES);
    expect('person' in r && r.person.slug).toBe('josh-tbs');
  });

  it('rejects an unknown numeric ID (refuses to DM strangers)', () => {
    const r = resolveDmTarget('999000111222333444', CANDIDATES);
    expect('error' in r && r.error).toMatch(/not a known allowlisted member/);
  });
});

describe('resolveDmTarget — string matching', () => {
  it('matches by slug', () => {
    const r = resolveDmTarget('josh-tbs', CANDIDATES);
    expect('person' in r && r.person.discordId).toBe('511575159929438224');
  });

  it('matches by title (given-name override)', () => {
    const r = resolveDmTarget('Ruben', CANDIDATES);
    expect('person' in r && r.person.slug).toBe('0xr');
  });

  it('is case-insensitive', () => {
    const r = resolveDmTarget('RUBEN', CANDIDATES);
    expect('person' in r && r.person.slug).toBe('0xr');
  });

  it('matches by Discord username', () => {
    const r = resolveDmTarget('theblockchainsocialist', CANDIDATES);
    expect('person' in r && r.person.slug).toBe('josh-tbs');
  });

  it('matches by Discord display name', () => {
    const r = resolveDmTarget('Josh | TBS', CANDIDATES);
    expect('person' in r && r.person.slug).toBe('josh-tbs');
  });

  it('returns not-found error with fuzzy suggestions on a miss', () => {
    const r = resolveDmTarget('blockchain', CANDIDATES);
    expect('error' in r && r.error).toMatch(/No allowlisted member matches/);
    expect(
      'suggestions' in r &&
        r.suggestions?.some((s) => s.startsWith('josh-tbs')),
    ).toBe(true);
  });

  it('flags ambiguous matches with the candidate list', () => {
    // Two candidates whose TITLE is "Alex" but neither has slug "alex" —
    // slug-priority falls through, title-level then matches both → ambiguous.
    const dupes: PersonCandidate[] = [
      {
        slug: 'alex-eng',
        discordId: '111111111111111111',
        title: 'Alex',
        discordUsername: 'alex-e',
        discordDisplayName: 'Alex Engineer',
      },
      {
        slug: 'alex-design',
        discordId: '222222222222222222',
        title: 'Alex',
        discordUsername: 'alex-d',
        discordDisplayName: 'Alex Designer',
      },
    ];
    const r = resolveDmTarget('Alex', dupes);
    expect('error' in r && r.error).toMatch(/Ambiguous DM target/);
    expect('suggestions' in r && r.suggestions?.length).toBe(2);
  });

  it('prefers slug over title when both match different people', () => {
    const c: PersonCandidate[] = [
      {
        slug: 'ron',
        discordId: '1',
        title: 'Ron',
        discordUsername: 'ron-handle',
        discordDisplayName: 'Ron',
      },
      // someone whose slug happens to be the literal string "Ron" — extreme edge
      // case, but priority is slug-first so the first record should win.
      {
        slug: 'mystery',
        discordId: '2',
        title: 'Ron',
        discordUsername: 'other',
        discordDisplayName: 'Other',
      },
    ];
    const r = resolveDmTarget('ron', c);
    // Two records have title 'Ron'/'ron' but only one has slug 'ron' → slug
    // wins on the first iteration and we return early.
    expect('person' in r && r.person.discordId).toBe('1');
  });

  it('empty input returns clean error', () => {
    expect('error' in resolveDmTarget('', CANDIDATES)).toBe(true);
    expect('error' in resolveDmTarget('   ', CANDIDATES)).toBe(true);
  });
});
