import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _closeDatabase, _initTestDatabase } from './db.js';
import {
  buildFtsQuery,
  chunkMarkdown,
  kbIndexAvailable,
  reindexGroupKb,
  searchKb,
} from './kb-index.js';

const GROUP = 'kb_test_group';
let contextDir: string;

function writeKb(relPath: string, body: string): void {
  const full = path.join(contextDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

describe('kb-index', () => {
  beforeEach(() => {
    _initTestDatabase();
    contextDir = fs.mkdtempSync(path.join(os.tmpdir(), 'breadbrich-kb-'));
  });

  afterEach(() => {
    fs.rmSync(contextDir, { recursive: true, force: true });
    _closeDatabase();
  });

  it('has FTS5 available in the bundled SQLite', () => {
    expect(kbIndexAvailable()).toBe(true);
  });

  describe('chunkMarkdown', () => {
    it('splits by heading and folds frontmatter title/id into the first heading', () => {
      const frags = chunkMarkdown(
        [
          '---',
          'title: Alice Smith',
          'id: PERSON-001',
          '---',
          'Intro paragraph before any heading.',
          '',
          '## Role',
          'Treasury lead.',
          '',
          '## Contact',
          'alice@example.com',
        ].join('\n'),
      );
      expect(frags.length).toBe(3);
      expect(frags[0].heading).toContain('Alice Smith');
      expect(frags[0].heading).toContain('PERSON-001');
      expect(frags[1].heading).toBe('Role');
      expect(frags[2].content).toContain('alice@example.com');
    });

    it('splits oversized sections on paragraph boundaries', () => {
      const para = 'x'.repeat(800);
      const frags = chunkMarkdown(`## Big\n\n${para}\n\n${para}\n\n${para}`);
      expect(frags.length).toBeGreaterThan(1);
      expect(frags.every((f) => f.heading === 'Big')).toBe(true);
    });
  });

  describe('buildFtsQuery', () => {
    it('quotes tokens and strips FTS operators', () => {
      expect(buildFtsQuery('treasury lead')).toBe('"treasury" "lead"');
      // Raw FTS operators must not survive into the MATCH expression.
      expect(buildFtsQuery('NEAR(a b) OR *')).toBe('"NEAR" "a" "b" "OR"');
    });

    it('returns empty string when there are no usable tokens', () => {
      expect(buildFtsQuery('   !!!  ')).toBe('');
    });
  });

  describe('reindexGroupKb + searchKb', () => {
    it('indexes files and returns ranked matches', () => {
      writeKb('people/alice.md', '## Role\nAlice runs the treasury.');
      writeKb('people/bob.md', '## Role\nBob handles design.');

      const r = reindexGroupKb(GROUP, contextDir);
      expect(r.indexed).toBe(2);
      expect(r.skipped).toBe(0);

      const hits = searchKb('treasury', { groupFolder: GROUP });
      expect(hits.length).toBe(1);
      expect(hits[0].sourcePath).toBe(path.join('people', 'alice.md'));
      expect(hits[0].snippet.toLowerCase()).toContain('treasury');
    });

    it('skips unchanged files on re-index (incremental by mtime)', () => {
      writeKb('a.md', '# A\ncontent one');
      expect(reindexGroupKb(GROUP, contextDir).indexed).toBe(1);

      const second = reindexGroupKb(GROUP, contextDir);
      expect(second.indexed).toBe(0);
      expect(second.skipped).toBe(1);
    });

    it('re-indexes a file after its content changes', () => {
      const file = 'note.md';
      writeKb(file, '# Note\noriginal apple');
      reindexGroupKb(GROUP, contextDir);
      expect(searchKb('apple', { groupFolder: GROUP }).length).toBe(1);
      expect(searchKb('banana', { groupFolder: GROUP }).length).toBe(0);

      // Bump mtime into the future so the change is detected deterministically.
      const full = path.join(contextDir, file);
      fs.writeFileSync(full, '# Note\nupdated banana');
      const future = new Date(Date.now() + 5000);
      fs.utimesSync(full, future, future);

      const r = reindexGroupKb(GROUP, contextDir);
      expect(r.indexed).toBe(1);
      expect(searchKb('apple', { groupFolder: GROUP }).length).toBe(0);
      expect(searchKb('banana', { groupFolder: GROUP }).length).toBe(1);
    });

    it('purges fragments for files deleted from disk', () => {
      writeKb('keep.md', '# Keep\nkeep this content');
      writeKb('gone.md', '# Gone\nephemeral content');
      reindexGroupKb(GROUP, contextDir);
      expect(searchKb('ephemeral', { groupFolder: GROUP }).length).toBe(1);

      fs.rmSync(path.join(contextDir, 'gone.md'));
      const r = reindexGroupKb(GROUP, contextDir);
      expect(r.removed).toBe(1);
      expect(searchKb('ephemeral', { groupFolder: GROUP }).length).toBe(0);
      expect(searchKb('keep', { groupFolder: GROUP }).length).toBe(1);
    });

    it('scopes search to a single group when groupFolder is given', () => {
      writeKb('x.md', '# X\nshared keyword here');
      reindexGroupKb(GROUP, contextDir);
      reindexGroupKb('other_group', contextDir);

      expect(searchKb('keyword').length).toBe(2); // both groups
      expect(searchKb('keyword', { groupFolder: GROUP }).length).toBe(1);
    });

    it('returns empty for a query with no usable tokens', () => {
      writeKb('x.md', '# X\nanything');
      reindexGroupKb(GROUP, contextDir);
      expect(searchKb('   ', { groupFolder: GROUP })).toEqual([]);
    });

    it('handles a missing context directory without throwing', () => {
      const missing = path.join(contextDir, 'does-not-exist');
      const r = reindexGroupKb(GROUP, missing);
      expect(r).toEqual({ indexed: 0, skipped: 0, removed: 0 });
    });
  });
});
