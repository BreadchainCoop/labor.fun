/**
 * Google Drive knowledge connector.
 *
 * Mirrors every Google **Doc** inside the configured Drive folders
 * (`GOOGLE_DRIVE_FOLDER_IDS`) into the per-group KB as markdown, so per-doc
 * RBAC, full-text search, and the citations skill all apply for free. The
 * source-agnostic half (KB writes, reconcile, cursor state) lives in
 * `base.ts`; this file only talks to the Drive + Docs REST APIs and hands
 * back `ConnectorDoc[]` plus a `complete` flag.
 *
 * Auth reuses the SAME credentials the bundled `gws` (Google Workspace CLI)
 * tool uses — the JSON pointed at by `GOOGLE_WORKSPACE_CREDENTIALS_FILE`. That
 * mechanism lives in `google-auth.ts`, shared with every other Google
 * connector; we do NOT introduce a second Google auth mechanism, import
 * `googleapis`, or import from `container-runner.ts` (heavy deps). The auth
 * symbols are re-exported below under their historical `GoogleDrive*` names so
 * existing importers keep working after the extraction.
 *
 * Design choices:
 *  - Structured export: we fetch the Docs API document tree and convert it to
 *    markdown (`googleDocToMarkdown`) so headings/lists/bold/links become real
 *    markdown, rather than the flat `export?mimeType=text/plain` output.
 *  - Subfolder recursion is bounded to ONE level below each configured folder
 *    (configured folder + its immediate subfolders) to stay predictable and
 *    avoid unbounded traversal / cycles.
 *  - Sync model: a FULL pull every run (see `sync()`'s doc comment for why) —
 *    every configured folder is re-listed and every Doc re-exported on each
 *    tick, so `complete` is a per-run flag (never a persisted cursor) and a
 *    fully-successful run always reconciles (deletes) docs removed upstream,
 *    not just the first one ever.
 *
 * Convention reference: `src/integrations/github-projects.ts` (fetch-based
 * client, typed errors, no client lib).
 */

import {
  CONNECTOR_SYNC_INTERVAL_MS,
  GOOGLE_DRIVE_FOLDER_IDS,
} from '../../config.js';
import { readEnvFile } from '../../env.js';
import { DEFAULT_CONNECTOR_VISIBILITY, escapeHtml } from './base.js';
import type {
  Connector,
  ConnectorContext,
  ConnectorDoc,
  ConnectorVisibility,
} from './base.js';
import {
  GoogleApiError,
  googleApiGet,
  loadGoogleAccessToken,
  resolveGoogleWorkspaceCredsPath,
} from './google-auth.js';

// The Google auth primitives now live in `google-auth.ts` (shared with the
// other Google connectors). Re-exported here under the names this module has
// always exported them as, so importers and tests are unaffected by the move.
export {
  GoogleApiError as GoogleDriveError,
  loadGoogleAccessToken,
  resolveGoogleWorkspaceCredsPath,
};
export type { CredsReader } from './google-auth.js';

const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files';
const DOCS_API = 'https://docs.googleapis.com/v1/documents';
const DOC_MIME = 'application/vnd.google-apps.document';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

const VALID_VISIBILITIES: ConnectorVisibility[] = [
  'open',
  'restricted',
  'private',
];

/**
 * Default visibility for docs this connector syncs. Overridable via
 * `GOOGLE_DRIVE_DEFAULT_VISIBILITY` (process.env wins over `.env`); falls back
 * to the framework default (`restricted`, see base.ts) when unset or set to an
 * unrecognized value — never silently widens access on a typo.
 */
export function getGoogleDriveDefaultVisibility(): ConnectorVisibility {
  const raw =
    process.env.GOOGLE_DRIVE_DEFAULT_VISIBILITY ||
    readEnvFile(['GOOGLE_DRIVE_DEFAULT_VISIBILITY'])
      .GOOGLE_DRIVE_DEFAULT_VISIBILITY;
  return VALID_VISIBILITIES.includes(raw as ConnectorVisibility)
    ? (raw as ConnectorVisibility)
    : DEFAULT_CONNECTOR_VISIBILITY;
}

// --- Docs → markdown --------------------------------------------------------

/** Minimal shapes of the Docs API document we consume (see docs.googleapis.com
 * `documents.get`). Only the structural bits we convert are typed. */
interface DocsTextStyle {
  bold?: boolean;
  italic?: boolean;
  link?: { url?: string };
}
interface DocsTextRun {
  content?: string;
  textStyle?: DocsTextStyle;
}
interface DocsParagraphElement {
  textRun?: DocsTextRun;
}
interface DocsBullet {
  listId?: string;
  nestingLevel?: number;
}
interface DocsParagraph {
  elements?: DocsParagraphElement[];
  paragraphStyle?: { namedStyleType?: string };
  bullet?: DocsBullet;
}
interface DocsTableCell {
  content?: DocsStructuralElement[];
}
interface DocsTableRow {
  tableCells?: DocsTableCell[];
}
interface DocsTable {
  tableRows?: DocsTableRow[];
}
interface DocsStructuralElement {
  paragraph?: DocsParagraph;
  table?: DocsTable;
}
export interface DocsDocument {
  title?: string;
  body?: { content?: DocsStructuralElement[] };
}

/** Named-style → markdown heading prefix. Unknown styles → body paragraph. */
const HEADING_PREFIX: Record<string, string> = {
  TITLE: '# ',
  SUBTITLE: '## ',
  HEADING_1: '# ',
  HEADING_2: '## ',
  HEADING_3: '### ',
  HEADING_4: '#### ',
  HEADING_5: '##### ',
  HEADING_6: '###### ',
};

/**
 * Convert one text run to inline markdown (bold/italic/link).
 *
 * The raw run `content` is HTML-escaped (`escapeHtml`, base.ts) BEFORE any
 * markdown styling is applied, so untrusted source text (e.g. a Google Doc
 * run containing literal `<img src=x onerror=...>`) can never inject live
 * HTML into the markdown the dashboard renders with `marked()`. The markdown
 * markers added below (`**`, `[...]()`) are ours, not the source's, so they're
 * left unescaped.
 */
function renderTextRun(run: DocsTextRun): string {
  // Docs runs include the trailing "\n"; strip it — line breaks are handled by
  // paragraph joining so styling markers don't wrap the newline.
  let text = escapeHtml((run.content ?? '').replace(/\n$/, ''));
  if (!text) return '';
  const style = run.textStyle ?? {};
  // Preserve leading/trailing whitespace OUTSIDE the emphasis markers so
  // markdown like "a **b** c" renders (markers must hug non-space chars).
  const leadingWs = text.match(/^\s*/)?.[0] ?? '';
  const trailingWs = text.match(/\s*$/)?.[0] ?? '';
  let core = text.slice(leadingWs.length, text.length - trailingWs.length);
  if (core) {
    if (style.bold) core = `**${core}**`;
    if (style.italic) core = `*${core}*`;
    const url = style.link?.url;
    if (url) core = `[${core}](${url})`;
  }
  text = `${leadingWs}${core}${trailingWs}`;
  return text;
}

/** Render a paragraph's runs to a single inline markdown string. */
function renderParagraphText(para: DocsParagraph): string {
  return (para.elements ?? [])
    .map((el) => (el.textRun ? renderTextRun(el.textRun) : ''))
    .join('')
    .trimEnd();
}

/** Convert a single structural element (paragraph/table) to markdown lines. */
function renderStructuralElement(el: DocsStructuralElement): string[] {
  if (el.paragraph) {
    const para = el.paragraph;
    const text = renderParagraphText(para);
    if (!text) return []; // skip empty paragraphs
    const styleType = para.paragraphStyle?.namedStyleType;
    const headingPrefix = styleType ? HEADING_PREFIX[styleType] : undefined;
    if (headingPrefix) return [`${headingPrefix}${text}`];
    if (para.bullet) {
      const indent = '  '.repeat(para.bullet.nestingLevel ?? 0);
      return [`${indent}- ${text}`];
    }
    return [text];
  }
  if (el.table) {
    // Tables are rendered as flattened bullet rows — pragmatic, keeps the text
    // searchable without a full GFM table conversion.
    const lines: string[] = [];
    for (const row of el.table.tableRows ?? []) {
      const cells = (row.tableCells ?? [])
        .map((cell) =>
          (cell.content ?? [])
            .flatMap(renderStructuralElement)
            .join(' ')
            .trim(),
        )
        .filter(Boolean);
      if (cells.length) lines.push(`- ${cells.join(' | ')}`);
    }
    return lines;
  }
  // Unknown structural element (sectionBreak, tableOfContents, …) — skip.
  return [];
}

/**
 * Convert a Google Docs API document into markdown. Pure and exported for
 * tests. Handles headings (`namedStyleType`), bullet lists (`bullet`), and
 * inline bold/italic/link styling; unknown structural elements are skipped.
 */
export function googleDocToMarkdown(doc: DocsDocument): string {
  const content = doc.body?.content ?? [];
  const blocks: string[] = [];
  let pendingList = false;

  for (const el of content) {
    const lines = renderStructuralElement(el);
    if (lines.length === 0) continue;
    const isList = lines[0].trimStart().startsWith('- ');
    // Group consecutive list items into one block; separate other blocks with
    // a blank line for readable markdown.
    if (isList && pendingList && blocks.length > 0) {
      blocks[blocks.length - 1] += `\n${lines.join('\n')}`;
    } else {
      blocks.push(lines.join('\n'));
    }
    pendingList = isList;
  }
  return blocks.join('\n\n').trim();
}

// --- Drive listing + Docs fetch ---------------------------------------------

interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

interface DriveFilesResponse {
  files?: DriveFile[];
  nextPageToken?: string;
}

/** Escape a Drive folder id for safe embedding inside a Drive `q` string
 * (ids are alphanumeric+`-`/`_`, but be defensive against a stray quote). */
function escapeDriveQueryValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * List all files of a given mimeType directly inside `folderId`, paginating to
 * the end. Returns the accumulated files; throws (fatal) on auth errors.
 */
async function listFolderChildren(
  folderId: string,
  mimeType: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const q =
      `'${escapeDriveQueryValue(folderId)}' in parents ` +
      `and mimeType='${mimeType}' and trashed=false`;
    const params = new URLSearchParams({
      q,
      fields: 'files(id,name,modifiedTime,webViewLink),nextPageToken',
      pageSize: '100',
      // Include shared drives so folders on a Team/Shared Drive resolve.
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const resp = await googleApiGet<DriveFilesResponse>(
      `${DRIVE_FILES_API}?${params.toString()}`,
      token,
      fetchImpl,
    );
    for (const f of resp.files ?? []) files.push(f);
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return files;
}

/** Fetch a Google Doc via the Docs API and convert its body to markdown. */
async function fetchDocMarkdown(
  docId: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const doc = await googleApiGet<DocsDocument>(
    `${DOCS_API}/${encodeURIComponent(docId)}`,
    token,
    fetchImpl,
  );
  return googleDocToMarkdown(doc);
}

/** Map a Drive file + its converted markdown into a ConnectorDoc. Exported
 * for tests. `folderId` is the folder the file was discovered in. */
export function driveFileToConnectorDoc(
  file: DriveFile,
  folderId: string,
  markdown: string,
): ConnectorDoc {
  return {
    id: file.id,
    title: file.name || '(untitled)',
    // webViewLink is the human Drive/Docs URL — the citation target.
    sourceUrl:
      file.webViewLink || `https://docs.google.com/document/d/${file.id}/edit`,
    markdown,
    updatedAt: file.modifiedTime,
    // Not-world-open by default (see base.ts); overridable via
    // GOOGLE_DRIVE_DEFAULT_VISIBILITY.
    visibility: getGoogleDriveDefaultVisibility(),
    extraFrontmatter: { drive_id: file.id, drive_folder: folderId },
  };
}

// --- Connector --------------------------------------------------------------

/**
 * Collect the Google Docs to sync across all configured folders, recursing one
 * level into subfolders. Returns the discovered docs (with the folder they were
 * found in) and whether every listing paginated to completion. Throws (fatal)
 * only on auth errors from Drive.
 */
async function collectDocs(
  token: string,
  fetchImpl: typeof fetch,
): Promise<{
  files: Array<{ file: DriveFile; folderId: string }>;
  listedOk: boolean;
}> {
  const out: Array<{ file: DriveFile; folderId: string }> = [];
  const seen = new Set<string>();

  for (const folderId of GOOGLE_DRIVE_FOLDER_IDS) {
    // Docs directly in the folder…
    for (const f of await listFolderChildren(
      folderId,
      DOC_MIME,
      token,
      fetchImpl,
    )) {
      if (!seen.has(f.id)) {
        seen.add(f.id);
        out.push({ file: f, folderId });
      }
    }
    // …plus docs in immediate subfolders (bounded to one level).
    const subfolders = await listFolderChildren(
      folderId,
      FOLDER_MIME,
      token,
      fetchImpl,
    );
    for (const sub of subfolders) {
      for (const f of await listFolderChildren(
        sub.id,
        DOC_MIME,
        token,
        fetchImpl,
      )) {
        if (!seen.has(f.id)) {
          seen.add(f.id);
          // Attribute to the top-level configured folder for stable frontmatter.
          out.push({ file: f, folderId });
        }
      }
    }
  }
  return { files: out, listedOk: true };
}

/**
 * Sync implementation: a FULL pull every run — every configured folder (and
 * its immediate subfolders) is re-listed and every Doc re-exported on each
 * tick. No incremental cursor.
 *
 * This mirrors the notion.ts connector's model (see its `sync()` doc comment
 * for the full rationale) and fixes the same three bugs an incremental,
 * cursor-persisted design had here:
 *   - `complete` gated delete-reconcile (base.ts) but was only ever true on
 *     the very first run (`!cursor`), since the cursor persists forever —
 *     every later run was incremental and so NEVER reconciled, meaning a
 *     file deleted upstream lingered in the KB forever.
 *   - `maxModified` advanced for every LISTED file regardless of whether its
 *     export actually succeeded, and was persisted unconditionally — a file
 *     whose export threw got skipped forever on the next incremental run
 *     (the cursor had already moved past its `modifiedTime`).
 *   - The `modified <= cursor` boundary check could drop a file sharing the
 *     cursor's exact timestamp with another file synced in the same run.
 * A full pull every tick removes the cursor entirely, so all three dissolve:
 * `complete` is computed fresh each run (never persisted), nothing can be
 * "advanced past," and there is no boundary to compare against. The cost is
 * re-exporting unchanged Docs every tick, which is acceptable for a
 * background KB sync on a multi-minute interval (default 30 min,
 * `CONNECTOR_SYNC_INTERVAL_MS`) against a bounded, admin-configured folder
 * scope; `writeConnectorDoc` upserts are idempotent by stable file id, so
 * re-writing an unchanged file is a harmless no-op write.
 *
 * `complete` is true only when every folder listing succeeded AND every
 * discovered Doc exported successfully this run — any failure forces
 * `complete: false` so the framework does not reconcile (delete) based on a
 * partial pull. A fatal auth error (401/403) aborts the whole run instead of
 * being swallowed per-file.
 */
async function sync(
  ctx: ConnectorContext,
): Promise<{ docs: ConnectorDoc[]; complete: boolean }> {
  const token = await loadGoogleAccessToken(ctx.fetchImpl);

  const { files, listedOk } = await collectDocs(token, ctx.fetchImpl);

  const docs: ConnectorDoc[] = [];
  let allExportsOk = true;

  for (const { file, folderId } of files) {
    try {
      const markdown = await fetchDocMarkdown(file.id, token, ctx.fetchImpl);
      docs.push(driveFileToConnectorDoc(file, folderId, markdown));
    } catch (err) {
      // A fatal auth error should abort the whole run, not be swallowed.
      if (
        err instanceof GoogleApiError &&
        (err.status === 401 || err.status === 403)
      ) {
        throw err;
      }
      allExportsOk = false;
      ctx.logger.warn(
        {
          source: 'google-drive',
          fileId: file.id,
          err: err instanceof Error ? err.message : err,
        },
        'google-drive: failed to export doc, skipping',
      );
    }
  }

  // Only a fully-successful pull may trigger deletes. Purely in-run — never
  // persisted — so every successful run reconciles, not just the first.
  const complete = listedOk && allExportsOk;
  return { docs, complete };
}

/**
 * The Google Drive connector. Configured when at least one folder id is set
 * AND the gws creds file resolves. `isConfigured` performs NO network — it only
 * checks the path resolves (token minting happens lazily inside `sync`).
 */
export const googleDriveConnector: Connector = {
  name: 'google-drive',
  syncInterval: CONNECTOR_SYNC_INTERVAL_MS,
  isConfigured: () =>
    GOOGLE_DRIVE_FOLDER_IDS.length > 0 &&
    resolveGoogleWorkspaceCredsPath() !== undefined,
  sync,
};
