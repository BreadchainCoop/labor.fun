/**
 * Knowledge-base full-text search index.
 *
 * Breadbrich Engels stores organizational knowledge as markdown files under
 * each group's `context/` directory (people, tasks, calendar, artifacts).
 * Retrieval was previously grep + read-the-file, which is brittle once a KB
 * grows: no ranking, no stemming, no cross-file relevance.
 *
 * This module maintains a SQLite FTS5 index (`kb_fragments`, created in
 * db.ts) over chunked markdown so the agent — or the kb-ui dashboard, or a
 * host CLI — can do ranked (BM25) keyword search across the whole KB. The
 * markdown files remain the source of truth and stay git-tracked; this index
 * is a disposable, rebuildable accelerator.
 *
 * Design notes:
 * - Indexing is incremental: per-file mtime is tracked in `kb_indexed_files`,
 *   so re-indexing after a turn only touches files that actually changed.
 * - We deliberately do NOT use vector embeddings. Anthropic exposes no
 *   embeddings endpoint, so that would mean a new external provider key and a
 *   per-turn embedding spend — at odds with this project's API-credit
 *   conservation stance. FTS5 buys ranking + stemming + phrase queries with
 *   zero new dependencies. Vector search can be layered on later if needed.
 */
import fs from 'fs';
import path from 'path';

import matter from 'gray-matter';

import { getAllRegisteredGroups, getDb } from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';

/** Largest fragment we store before splitting a section further. */
const MAX_FRAGMENT_CHARS = 1500;

export interface KbFragment {
  heading: string;
  content: string;
}

export interface KbSearchResult {
  groupFolder: string;
  sourcePath: string;
  heading: string;
  snippet: string;
  /** BM25 score — lower (more negative) is a better match. */
  rank: number;
}

export interface ReindexResult {
  /** Files (re)indexed because they were new or changed. */
  indexed: number;
  /** Files skipped because their mtime was unchanged. */
  skipped: number;
  /** Files removed from the index because they no longer exist on disk. */
  removed: number;
}

/**
 * Whether the FTS5 index table exists. False when SQLite was built without
 * FTS5 (see db.ts) — callers should degrade to a no-op rather than throw.
 */
export function kbIndexAvailable(): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kb_fragments' LIMIT 1`,
    )
    .get();
  return row !== undefined;
}

/**
 * Split a markdown document into searchable fragments. Frontmatter is parsed
 * out (its title/id are folded into the first heading so name lookups hit),
 * then the body is segmented by markdown headings. Oversized sections are
 * further split on paragraph boundaries so a single huge file can't produce
 * one unwieldy fragment.
 */
export function chunkMarkdown(raw: string): KbFragment[] {
  let body = raw;
  let frontmatterHeading = '';
  try {
    const parsed = matter(raw);
    body = parsed.content;
    const data = parsed.data as Record<string, unknown>;
    const labelParts = [data.title, data.id, data.name]
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      .map((v) => v.trim());
    frontmatterHeading = labelParts.join(' · ');
  } catch {
    // Malformed frontmatter — index the raw text as-is.
    body = raw;
  }

  const lines = body.split('\n');
  const sections: KbFragment[] = [];
  let heading = frontmatterHeading;
  let buf: string[] = [];

  const flush = () => {
    const content = buf.join('\n').trim();
    if (content) sections.push({ heading: heading.trim(), content });
    buf = [];
  };

  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      heading = m[2].trim();
    } else {
      buf.push(line);
    }
  }
  flush();

  // Split any section whose content exceeds the size cap, preserving heading.
  const fragments: KbFragment[] = [];
  for (const section of sections) {
    if (section.content.length <= MAX_FRAGMENT_CHARS) {
      fragments.push(section);
      continue;
    }
    const paragraphs = section.content.split(/\n\s*\n/);
    let chunk = '';
    for (const para of paragraphs) {
      if (chunk && chunk.length + para.length + 2 > MAX_FRAGMENT_CHARS) {
        fragments.push({ heading: section.heading, content: chunk.trim() });
        chunk = '';
      }
      chunk += (chunk ? '\n\n' : '') + para;
    }
    if (chunk.trim()) {
      fragments.push({ heading: section.heading, content: chunk.trim() });
    }
  }

  return fragments;
}

/** Recursively collect markdown files under a directory (relative paths). */
function listMarkdownFiles(rootDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        out.push(path.relative(rootDir, full));
      }
    }
  };
  walk(rootDir);
  return out;
}

/**
 * Incrementally (re)index one group's KB. Only files whose mtime changed
 * since the last index are re-chunked; files deleted on disk are purged from
 * the index. Safe to call after every turn — unchanged KBs cost a few stats.
 */
export function reindexGroupKb(
  groupFolder: string,
  contextDir: string,
): ReindexResult {
  const result: ReindexResult = { indexed: 0, skipped: 0, removed: 0 };
  if (!kbIndexAvailable()) return result;

  const db = getDb();

  const getFile = db.prepare(
    `SELECT mtime_ms FROM kb_indexed_files WHERE group_folder = ? AND source_path = ?`,
  );
  const upsertFile = db.prepare(
    `INSERT INTO kb_indexed_files (group_folder, source_path, mtime_ms, fragment_count, indexed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(group_folder, source_path) DO UPDATE SET
       mtime_ms = excluded.mtime_ms,
       fragment_count = excluded.fragment_count,
       indexed_at = excluded.indexed_at`,
  );
  const deleteFragments = db.prepare(
    `DELETE FROM kb_fragments WHERE group_folder = ? AND source_path = ?`,
  );
  const insertFragment = db.prepare(
    `INSERT INTO kb_fragments (group_folder, source_path, heading, content) VALUES (?, ?, ?, ?)`,
  );
  const deleteFileRow = db.prepare(
    `DELETE FROM kb_indexed_files WHERE group_folder = ? AND source_path = ?`,
  );
  const listKnown = db.prepare(
    `SELECT source_path FROM kb_indexed_files WHERE group_folder = ?`,
  );

  const onDisk = fs.existsSync(contextDir) ? listMarkdownFiles(contextDir) : [];
  const onDiskSet = new Set(onDisk);

  const run = db.transaction(() => {
    for (const relPath of onDisk) {
      const abs = path.join(contextDir, relPath);
      let mtimeMs: number;
      try {
        mtimeMs = Math.floor(fs.statSync(abs).mtimeMs);
      } catch {
        continue;
      }
      const existing = getFile.get(groupFolder, relPath) as
        | { mtime_ms: number }
        | undefined;
      if (existing && existing.mtime_ms === mtimeMs) {
        result.skipped++;
        continue;
      }

      let fragments: KbFragment[];
      try {
        fragments = chunkMarkdown(fs.readFileSync(abs, 'utf-8'));
      } catch {
        continue;
      }

      deleteFragments.run(groupFolder, relPath);
      for (const f of fragments) {
        insertFragment.run(groupFolder, relPath, f.heading, f.content);
      }
      upsertFile.run(
        groupFolder,
        relPath,
        mtimeMs,
        fragments.length,
        new Date().toISOString(),
      );
      result.indexed++;
    }

    // Purge files that were indexed before but are now gone from disk.
    const known = listKnown.all(groupFolder) as Array<{ source_path: string }>;
    for (const row of known) {
      if (!onDiskSet.has(row.source_path)) {
        deleteFragments.run(groupFolder, row.source_path);
        deleteFileRow.run(groupFolder, row.source_path);
        result.removed++;
      }
    }
  });

  run();
  return result;
}

/**
 * (Re)index every registered group's `context/` directory. Called once at
 * orchestrator startup to warm the index; per-turn freshness is handled by
 * the kb-reindex evaluator. Failures are isolated per group and logged.
 */
export function reindexAllGroups(): ReindexResult {
  const totals: ReindexResult = { indexed: 0, skipped: 0, removed: 0 };
  if (!kbIndexAvailable()) return totals;

  for (const group of Object.values(getAllRegisteredGroups())) {
    let contextDir: string;
    try {
      contextDir = path.join(resolveGroupFolderPath(group.folder), 'context');
    } catch {
      continue;
    }
    try {
      const r = reindexGroupKb(group.folder, contextDir);
      totals.indexed += r.indexed;
      totals.skipped += r.skipped;
      totals.removed += r.removed;
    } catch (err) {
      logger.warn({ err, folder: group.folder }, 'KB reindex failed for group');
    }
  }
  return totals;
}

/**
 * Build a safe FTS5 MATCH expression from free-form user text. We tokenize to
 * word characters and quote each term, which neutralizes FTS5 operators
 * (AND/OR/NEAR/*, quotes, parens) that would otherwise throw on raw input.
 * Terms are implicitly ANDed. Returns '' when the query has no usable tokens.
 */
export function buildFtsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu);
  if (!tokens || tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' ');
}

/**
 * Ranked keyword search over the KB index. Pass groupFolder to scope to a
 * single group's KB, or omit to search across all indexed groups.
 */
export function searchKb(
  query: string,
  opts: { groupFolder?: string; limit?: number } = {},
): KbSearchResult[] {
  if (!kbIndexAvailable()) return [];
  const match = buildFtsQuery(query);
  if (!match) return [];

  const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));
  const params: unknown[] = [match];
  let scope = '';
  if (opts.groupFolder) {
    scope = 'AND group_folder = ?';
    params.push(opts.groupFolder);
  }
  params.push(limit);

  try {
    const rows = getDb()
      .prepare(
        `SELECT group_folder, source_path, heading,
                snippet(kb_fragments, 3, '[', ']', '…', 16) AS snippet,
                bm25(kb_fragments) AS rank
         FROM kb_fragments
         WHERE kb_fragments MATCH ? ${scope}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(...params) as Array<{
      group_folder: string;
      source_path: string;
      heading: string;
      snippet: string;
      rank: number;
    }>;
    return rows.map((r) => ({
      groupFolder: r.group_folder,
      sourcePath: r.source_path,
      heading: r.heading,
      snippet: r.snippet,
      rank: r.rank,
    }));
  } catch (err) {
    logger.warn({ err, query }, 'KB search query failed');
    return [];
  }
}
