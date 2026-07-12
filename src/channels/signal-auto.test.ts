import { describe, it, expect } from 'vitest';

import { deriveSignalGroupFolder, slugifySignalName } from './signal-auto.js';

describe('slugifySignalName', () => {
  it('lowercases + hyphenates', () => {
    expect(slugifySignalName('Project Team')).toBe('project-team');
  });

  it('strips emoji + punctuation', () => {
    expect(slugifySignalName('🥖 Bread — Ops!')).toBe('bread-ops');
  });

  it('returns empty string on all-symbols input (caller handles fallback)', () => {
    expect(slugifySignalName('🤔🚀!@#')).toBe('');
  });

  it('is idempotent', () => {
    const once = slugifySignalName('Alice Wonderland');
    expect(slugifySignalName(once)).toBe(once);
  });
});

describe('deriveSignalGroupFolder', () => {
  it('uses signal_<slugified name> when free (DM with profile name)', () => {
    expect(
      deriveSignalGroupFolder('signal:+15551234567', 'Alice Smith', new Set()),
    ).toBe('signal_alice-smith');
  });

  it('falls back to signal_<phone digits> for a DM with no usable name', () => {
    expect(
      deriveSignalGroupFolder('signal:+15551234567', undefined, new Set()),
    ).toBe('signal_15551234567');
    expect(
      deriveSignalGroupFolder('signal:+15551234567', '🤔🚀', new Set()),
    ).toBe('signal_15551234567');
  });

  it('derives from a group JID, mapping base64 group ids to a safe token', () => {
    // Base64 group ids may contain '+', '/', '=' — remapped to base64url so the
    // folder stays within the [A-Za-z0-9_-] group-folder charset.
    expect(
      deriveSignalGroupFolder('signal:group:aB+c/dE=', undefined, new Set()),
    ).toBe('signal_aB-c_dE');
  });

  it('prefers a group name slug when one is available', () => {
    expect(
      deriveSignalGroupFolder('signal:group:aB+c/dE=', 'Bread Ops', new Set()),
    ).toBe('signal_bread-ops');
  });

  it('deconflicts a taken folder with the id token', () => {
    expect(
      deriveSignalGroupFolder(
        'signal:+15551234567',
        'Alice Smith',
        new Set(['signal_alice-smith']),
      ),
    ).toBe('signal_alice-smith_15551234567');
  });

  it('deconflicts further with numeric suffixes', () => {
    const taken = new Set([
      'signal_alice-smith',
      'signal_alice-smith_15551234567',
    ]);
    const folder = deriveSignalGroupFolder(
      'signal:+15551234567',
      'Alice Smith',
      taken,
    );
    expect(folder).not.toBe('signal_alice-smith');
    expect(taken.has(folder)).toBe(false);
    expect(folder.endsWith('_2')).toBe(true);
  });

  it('always yields a valid group folder name', () => {
    const pattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
    const cases = [
      deriveSignalGroupFolder(
        'signal:group:aB+c/dE=',
        'x'.repeat(200),
        new Set(),
      ),
      deriveSignalGroupFolder(
        'signal:+15551234567',
        '— «Ünïcode» —',
        new Set(),
      ),
      deriveSignalGroupFolder('signal:+15551234567', undefined, new Set()),
      deriveSignalGroupFolder(
        'signal:group:' + 'A'.repeat(80) + '==',
        undefined,
        new Set(),
      ),
    ];
    for (const folder of cases) {
      expect(folder).toMatch(pattern);
    }
  });
});
