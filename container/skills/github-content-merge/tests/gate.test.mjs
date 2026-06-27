import { describe, it, expect } from 'vitest';
import {
  isContentOnly,
  isIdle,
  requiredChecksState,
  parseBranchUser,
} from '../scripts/gate.mjs';

describe('isContentOnly', () => {
  it('accepts only .md/.mdx under src/content', () => {
    expect(isContentOnly(['src/content/docs/a.md'])).toBe(true);
    expect(
      isContentOnly(['src/content/member-projects/b.mdx', 'src/content/docs/c.md']),
    ).toBe(true);
  });

  it('rejects _meta.yml (nav/structure = code)', () => {
    expect(isContentOnly(['src/content/docs/_meta.yml'])).toBe(false);
    expect(isContentOnly(['src/content/docs/a.md', 'src/content/docs/_meta.yml'])).toBe(false);
  });

  it('rejects code/config/asset paths', () => {
    expect(isContentOnly(['astro.config.mjs'])).toBe(false);
    expect(isContentOnly(['keystatic.config.tsx'])).toBe(false);
    expect(isContentOnly(['public/images/x.png'])).toBe(false);
    expect(isContentOnly(['src/content/docs/a.md', 'package.json'])).toBe(false);
  });

  it('rejects an empty changeset', () => {
    expect(isContentOnly([])).toBe(false);
  });
});

describe('isIdle', () => {
  const now = Date.parse('2026-06-27T12:00:00Z');
  it('true when older than the threshold', () => {
    expect(isIdle('2026-06-27T10:30:00Z', now, 60)).toBe(true);
  });
  it('false when within the threshold', () => {
    expect(isIdle('2026-06-27T11:30:00Z', now, 60)).toBe(false);
  });
  it('false on an unparseable date', () => {
    expect(isIdle('not-a-date', now, 60)).toBe(false);
  });
});

describe('requiredChecksState', () => {
  const required = ['netlify/bread-docs/deploy-preview', 'Redirect rules - bread-docs'];
  it('passes when every required check is success/neutral', () => {
    expect(
      requiredChecksState(
        {
          'netlify/bread-docs/deploy-preview': 'success',
          'Redirect rules - bread-docs': 'neutral',
        },
        required,
      ).allPass,
    ).toBe(true);
  });
  it('fails when any required check is failing', () => {
    expect(
      requiredChecksState(
        {
          'netlify/bread-docs/deploy-preview': 'failure',
          'Redirect rules - bread-docs': 'success',
        },
        required,
      ).allPass,
    ).toBe(false);
  });
  it('fails when a required check is missing or still pending', () => {
    expect(
      requiredChecksState({ 'netlify/bread-docs/deploy-preview': 'success' }, required).allPass,
    ).toBe(false);
    expect(
      requiredChecksState(
        {
          'netlify/bread-docs/deploy-preview': 'success',
          'Redirect rules - bread-docs': 'pending',
        },
        required,
      ).allPass,
    ).toBe(false);
  });
});

describe('parseBranchUser', () => {
  it('extracts the user segment from a keystatic branch', () => {
    expect(parseBranchUser('keystatic/marv/edit-homepage')).toBe('marv');
  });
  it('returns null for a non-prefixed branch', () => {
    expect(parseBranchUser('feat/x')).toBe(null);
  });
});
