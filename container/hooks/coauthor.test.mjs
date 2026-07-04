import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { appendCoauthor, readGithubUsername } from './coauthor.mjs';

const TRAILER =
  'Co-Authored-By: hudsonhrh <hudsonhrh@users.noreply.github.com>';

describe('appendCoauthor', () => {
  it('extends an existing trailer block with the requester (single newline)', () => {
    const msg =
      'feat: x\n\nbody line\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n';
    const out = appendCoauthor(msg, 'hudsonhrh', 'message');
    expect(out).toContain('Co-Authored-By: Claude <noreply@anthropic.com>');
    expect(out).toContain(TRAILER);
    expect(out).toMatch(
      /Claude <noreply@anthropic\.com>\nCo-Authored-By: hudsonhrh/,
    );
  });

  it('starts a trailer block (blank line) when the message has none', () => {
    expect(appendCoauthor('fix: y', 'hudsonhrh', 'message')).toBe(
      `fix: y\n\n${TRAILER}\n`,
    );
  });

  it('is idempotent — does not double-credit the same human', () => {
    const msg = `fix: y\n\n${TRAILER}\n`;
    expect(appendCoauthor(msg, 'hudsonhrh', 'message')).toBe(msg);
  });

  it('dedups against the id-linked email form too', () => {
    const msg =
      'fix: y\n\nCo-Authored-By: hudsonhrh <76409831+hudsonhrh@users.noreply.github.com>\n';
    expect(appendCoauthor(msg, 'hudsonhrh', 'message')).toBe(msg);
  });

  it('does not credit on merge or squash commits', () => {
    expect(appendCoauthor('Merge branch main', 'hudsonhrh', 'merge')).toBe(
      'Merge branch main',
    );
    expect(appendCoauthor('squash! x', 'hudsonhrh', 'squash')).toBe(
      'squash! x',
    );
  });

  it('no-ops when there is no github username', () => {
    expect(appendCoauthor('fix: y', '', 'message')).toBe('fix: y');
    expect(appendCoauthor('fix: y', undefined, 'message')).toBe('fix: y');
  });
});

describe('readGithubUsername', () => {
  it('reads github_username from a sender_context file', () => {
    const f = path.join(os.tmpdir(), `sc-${Date.now()}.json`);
    fs.writeFileSync(
      f,
      JSON.stringify({ user_id: 'x', github_username: 'me' }),
    );
    expect(readGithubUsername(f)).toBe('me');
    fs.unlinkSync(f);
  });

  it('returns undefined when missing or unparseable', () => {
    expect(readGithubUsername('/no/such/file.json')).toBeUndefined();
    const f = path.join(os.tmpdir(), `sc-${Date.now()}-2.json`);
    fs.writeFileSync(f, JSON.stringify({ user_id: 'x' }));
    expect(readGithubUsername(f)).toBeUndefined();
    fs.unlinkSync(f);
  });
});
