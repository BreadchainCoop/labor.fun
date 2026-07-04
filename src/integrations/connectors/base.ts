/**
 * Knowledge-connector framework.
 *
 * A **connector** pulls documents from an external source (Notion, Google
 * Drive, …) and writes them as markdown files INTO the existing per-group KB,
 * so per-doc RBAC, full-text search, and the citations skill's `source_url`
 * rendering all come for free. Synced docs land under:
 *
 *     groups/<sharedKbGroup>/context/connectors/<source>/<docId>.md
 *
 * Each file carries YAML frontmatter recording `source`, `source_url` (for
 * citations), `synced_at`, and a stable `id` so re-syncs are idempotent upserts
 * and docs removed upstream are reconciled (deleted) on a complete pull.
 *
 * This module is the source-agnostic half: it defines the `Connector`
 * interface, the KB write/upsert/delete plumbing, path-safety, cursor state
 * (reusing `router_state`), and the self-registering background loop. A
 * connector implementation only has to talk to its API and hand back
 * `ConnectorDoc`s. See `notion.ts` / `google-drive.ts` for the two reference
 * connectors, and docs/CONNECTORS.md for how to write your own.
 *
 * Mirrors the shape of `github-project-sync.ts` (frontmatter builder, atomic
 * tmp+rename writes, stale-file reconcile) but generalized across sources.
 */

import fs from 'fs';
import path from 'path';

import matter from 'gray-matter';

import { GROUPS_DIR, SHARED_KB_GROUP } from '../../config.js';
import { getRouterState, setRouterState } from '../../db.js';
import { logger } from '../../logger.js';

/** A single document pulled from an external source, ready to write to the KB. */
export interface ConnectorDoc {
  /**
   * Stable, source-unique identifier. Combined with the connector name it
   * yields the KB filename; it MUST be stable across syncs for a given
   * upstream document so re-syncs upsert rather than duplicate. Sanitized
   * before use as a filename — see `docPath`.
   */
  id: string;
  /** Human title (goes into frontmatter `title`, used by citations). */
  title: string;
  /** Canonical URL of the source doc — the citation target. */
  sourceUrl: string;
  /** Markdown body (already converted from the source's native format). */
  markdown: string;
  /**
   * Upstream last-edited timestamp (ISO 8601 when available). Recorded as
   * `source_updated_at`; connectors may also use it to drive incremental
   * cursors.
   */
  updatedAt?: string;
  /** Extra source-specific frontmatter (e.g. notion_id, drive_folder). */
  extraFrontmatter?: Record<string, unknown>;
  /** Default `open`; a connector may down-scope a doc to `restricted`/`private`. */
  visibility?: 'open' | 'restricted' | 'private';
  /** Extra tags to add alongside the automatic `connector`/`<source>-synced`. */
  tags?: string[];
}

/** Result of one connector sync pass. */
export interface ConnectorSyncResult {
  /** Docs written or refreshed this run. */
  upserted: number;
  /** Stale docs removed this run (only when `complete`). */
  deleted: number;
  /**
   * Whether the pull captured EVERYTHING for this connector's scope. Only a
   * complete pull may trigger the delete-reconcile pass — deleting after a
   * partial/paged/errored pull would wrongly remove docs that still exist
   * upstream but weren't touched this run (same rule as github-project-sync).
   */
  complete: boolean;
  /** The docs returned by the connector (surfaced for tests/logging). */
  docs?: ConnectorDoc[];
}

/**
 * Context handed to a connector's `sync()`. Gives it a persisted cursor
 * (for incremental sync), a `fetch` impl (injectable for tests), and the run's
 * start timestamp (the reconcile boundary).
 */
export interface ConnectorContext {
  /** Read this connector's persisted incremental cursor (undefined on first run). */
  getCursor: () => string | undefined;
  /** Persist this connector's incremental cursor (survives restarts). */
  setCursor: (value: string) => void;
  /** Injected fetch (defaults to global fetch); tests pass a stub. */
  fetchImpl: typeof fetch;
  /** ISO timestamp captured at the start of the run — the reconcile boundary. */
  syncStart: string;
  logger: typeof logger;
}

/**
 * A knowledge connector. `sync()` pulls documents and returns them; the
 * framework does the KB writes/deletes/cursor bookkeeping, so implementations
 * stay small and testable.
 */
export interface Connector {
  /** Stable short id, used as the KB subdir and in logs (e.g. `notion`). */
  name: string;
  /** Poll interval in ms. 0 disables the loop (one-shot still works). */
  syncInterval: number;
  /**
   * True when the connector's required config (token, scope ids) is present.
   * Used to no-op the loop cleanly when unconfigured. Never reads secrets into
   * anything logged.
   */
  isConfigured: () => boolean;
  /**
   * Pull documents. Returns the docs plus a `complete` flag (whether the pull
   * captured the entire scope — gates deletion). Should be idempotent and
   * throw only on fatal errors.
   */
  sync: (
    ctx: ConnectorContext,
  ) => Promise<{ docs: ConnectorDoc[]; complete: boolean }>;
}

// --- Path safety -----------------------------------------------------------

/**
 * Sanitize a source doc id into a safe filename stem. Path separators, `..`,
 * NUL, and other filesystem-hostile characters are collapsed to `-`; the
 * result can NEVER escape the connector's KB subdir. Empty/degenerate ids fall
 * back to a hash-like token so a write always lands somewhere deterministic.
 */
export function sanitizeDocId(id: string): string {
  const cleaned = String(id)
    // Anything outside a conservative filename allowlist becomes '-'.
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    // No leading dots (hidden files) or leading/trailing dashes.
    .replace(/^[.-]+/, '')
    .replace(/-+$/, '')
    // Collapse any '..' that survived (can't, given the allowlist, but belt+braces).
    .replace(/\.\.+/g, '.');
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    // Deterministic fallback so identical ids map to identical files.
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return `doc-${(h >>> 0).toString(36)}`;
  }
  // Cap length to keep well under filesystem limits (leaving room for `.md`).
  return cleaned.slice(0, 180);
}

/** Directory a connector's synced docs live in: context/connectors/<source>/. */
export function connectorDir(
  source: string,
  groupsDir: string = GROUPS_DIR,
  sharedKbGroup: string = SHARED_KB_GROUP,
): string {
  return path.join(
    groupsDir,
    sharedKbGroup,
    'context',
    'connectors',
    sanitizeDocId(source),
  );
}

/**
 * Resolve the absolute file path for a doc and assert it stays inside the
 * connector dir (defense in depth against a hostile/broken id). Throws if the
 * resolved path would escape — a synced id must never write outside the KB.
 */
export function docPath(source: string, id: string, dir?: string): string {
  const base = dir ?? connectorDir(source);
  const stem = sanitizeDocId(id);
  const file = path.resolve(base, `${stem}.md`);
  const baseResolved = path.resolve(base);
  if (file !== path.join(baseResolved, `${stem}.md`)) {
    throw new Error(`Unsafe connector doc id escaped KB dir: ${id}`);
  }
  if (!file.startsWith(baseResolved + path.sep)) {
    throw new Error(`Unsafe connector doc path outside KB dir: ${id}`);
  }
  return file;
}

// --- Frontmatter + KB writes ----------------------------------------------

/**
 * Build the frontmatter for a synced doc. Every doc carries a citable
 * `title` + `source_url` (the citations skill renders `source_url` as a link),
 * a `visibility` for RBAC, and a `synced_at` used by the reconcile pass to
 * detect stale files.
 */
export function connectorFrontmatter(
  source: string,
  doc: ConnectorDoc,
  syncedAt: string,
): Record<string, unknown> {
  const baseTags = ['connector', `${source}-synced`, ...(doc.tags ?? [])];
  return {
    id: doc.id,
    title: doc.title || '(untitled)',
    // Citation fields — required so the parallel citations skill can render a
    // link. Both title and source_url are always present.
    source,
    source_url: doc.sourceUrl,
    source_updated_at: doc.updatedAt ?? '',
    // Standard KB frontmatter so RBAC + the doc-format rules apply uniformly.
    created_by: `${source}-connector`,
    created_at: (doc.updatedAt ?? syncedAt).slice(0, 10),
    visibility: doc.visibility ?? 'open',
    editable_by: 'admins',
    tags: [...new Set(baseTags)],
    // Reconcile marker — files older than the run's syncStart are swept.
    synced_at: syncedAt,
    ...(doc.extraFrontmatter ?? {}),
  };
}

/**
 * Prepend a clickable source link to the body so any reader (and the citations
 * skill's fallback) gets a direct way to open the origin document.
 */
function bodyWithSourceLink(url: string, markdown: string): string {
  const trimmed = (markdown || '').trim();
  const header = `[View source](${url})\n\n`;
  return trimmed ? `${header}${trimmed}\n` : header;
}

/** Write one synced doc to disk atomically (tmp + rename). */
export function writeConnectorDoc(
  source: string,
  doc: ConnectorDoc,
  syncedAt: string,
  dir?: string,
): string {
  const targetDir = dir ?? connectorDir(source);
  const file = docPath(source, doc.id, targetDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fm = connectorFrontmatter(source, doc, syncedAt);
  const serialized = matter.stringify(
    bodyWithSourceLink(doc.sourceUrl, doc.markdown),
    fm,
  );
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, serialized);
  fs.renameSync(tmp, file);
  return file;
}

/** Read the `synced_at` marker out of a synced doc (null if unreadable). */
export function readSyncedAt(file: string): string | null {
  try {
    const parsed = matter(fs.readFileSync(file, 'utf-8'));
    const v = (parsed.data as { synced_at?: unknown }).synced_at;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Delete synced docs whose `synced_at` predates this run's `syncStart` — i.e.
 * docs that were NOT re-written this run because they no longer exist upstream.
 * Only call after a COMPLETE pull. Returns the number deleted. Files without a
 * readable `synced_at` are left alone (never delete what we can't verify).
 */
export function reconcileConnectorDir(
  source: string,
  syncStart: string,
  dir?: string,
): number {
  const targetDir = dir ?? connectorDir(source);
  if (!fs.existsSync(targetDir)) return 0;
  let deleted = 0;
  for (const f of fs.readdirSync(targetDir)) {
    if (!f.endsWith('.md')) continue;
    const full = path.join(targetDir, f);
    const synced = readSyncedAt(full);
    if (synced && synced < syncStart) {
      try {
        fs.unlinkSync(full);
        deleted++;
        logger.info({ source, file: f }, 'connector: removed stale KB doc');
      } catch (err) {
        logger.warn(
          { source, file: f, err },
          'connector: failed to remove stale doc',
        );
      }
    }
  }
  return deleted;
}

// --- Cursor state (reuses router_state) ------------------------------------

const cursorKey = (source: string): string => `connector_cursor:${source}`;

/** Read the persisted incremental cursor for a connector. */
export function getConnectorCursor(source: string): string | undefined {
  return getRouterState(cursorKey(source));
}

/** Persist the incremental cursor for a connector. */
export function setConnectorCursor(source: string, value: string): void {
  setRouterState(cursorKey(source), value);
}

// --- Run one connector ------------------------------------------------------

/**
 * Run a single connector once: pull docs, upsert them into the KB, and (only
 * on a complete pull) reconcile-delete docs removed upstream. Cursor advance is
 * left to the connector via `ctx.setCursor` so it controls the incremental
 * boundary semantics. Returns write/delete counts.
 */
export async function runConnector(
  connector: Connector,
  opts?: {
    fetchImpl?: typeof fetch;
    dir?: string;
    now?: () => string;
  },
): Promise<ConnectorSyncResult> {
  const now = opts?.now ?? (() => new Date().toISOString());
  const syncStart = now();
  const dir = opts?.dir ?? connectorDir(connector.name);

  const ctx: ConnectorContext = {
    getCursor: () => getConnectorCursor(connector.name),
    setCursor: (v: string) => setConnectorCursor(connector.name, v),
    fetchImpl: opts?.fetchImpl ?? fetch,
    syncStart,
    logger,
  };

  const { docs, complete } = await connector.sync(ctx);

  let upserted = 0;
  for (const doc of docs) {
    try {
      writeConnectorDoc(connector.name, doc, syncStart, dir);
      upserted++;
    } catch (err) {
      logger.warn(
        {
          source: connector.name,
          id: doc.id,
          err: err instanceof Error ? err.message : err,
        },
        'connector: failed to write doc',
      );
    }
  }

  // Deletion only after a fully-captured pull. An incremental pull (cursor
  // present) does NOT touch unchanged files, so it is never "complete" for
  // reconcile purposes — the connector must report complete=false there.
  let deleted = 0;
  if (complete) {
    deleted = reconcileConnectorDir(connector.name, syncStart, dir);
  }

  return { upserted, deleted, complete, docs };
}

// --- Background loop --------------------------------------------------------

const loops = new Map<
  string,
  { running: boolean; timer: NodeJS.Timeout | null }
>();

/**
 * Start a connector's polling loop. No-ops (with a log line) when the interval
 * is 0 or the connector is unconfigured. Fires once immediately so the KB
 * reflects current state without waiting a full interval. Idempotent per
 * connector name.
 */
export function startConnectorLoop(
  connector: Connector,
  opts?: { intervalMs?: number },
): void {
  const state = loops.get(connector.name) ?? { running: false, timer: null };
  if (state.running) {
    logger.debug({ source: connector.name }, 'connector loop already running');
    return;
  }
  const interval = opts?.intervalMs ?? connector.syncInterval;
  if (interval <= 0) {
    logger.info(
      { source: connector.name },
      'connector loop disabled (interval=0)',
    );
    return;
  }
  if (!connector.isConfigured()) {
    logger.info(
      { source: connector.name },
      'connector loop disabled (not configured)',
    );
    return;
  }
  state.running = true;
  loops.set(connector.name, state);

  const tick = async () => {
    try {
      const res = await runConnector(connector);
      logger.info(
        {
          source: connector.name,
          upserted: res.upserted,
          deleted: res.deleted,
          complete: res.complete,
        },
        'connector sync tick complete',
      );
    } catch (err) {
      logger.error(
        {
          source: connector.name,
          err: err instanceof Error ? err.message : err,
        },
        'connector sync tick failed',
      );
    }
  };

  logger.info(
    { source: connector.name, intervalMs: interval },
    'connector loop started',
  );
  void tick();
  state.timer = setInterval(tick, interval);
  state.timer.unref?.();
}

/** Stop a connector's loop (test cleanup / shutdown). */
export function stopConnectorLoop(connector: Connector | string): void {
  const name = typeof connector === 'string' ? connector : connector.name;
  const state = loops.get(name);
  if (state?.timer) {
    clearInterval(state.timer);
  }
  loops.set(name, { running: false, timer: null });
}
