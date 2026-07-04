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
 * tool uses — the JSON pointed at by `GOOGLE_WORKSPACE_CREDENTIALS_FILE`. We
 * do NOT introduce a new Google auth mechanism, import `googleapis`, or import
 * from `container-runner.ts` (heavy deps). `resolveGoogleWorkspaceCredsPath`
 * below is a minimal replica of the resolver in `src/container-runner.ts`
 * (~lines 443-494); keep the two in sync if the resolution rules change.
 *
 * Design choices:
 *  - Structured export: we fetch the Docs API document tree and convert it to
 *    markdown (`googleDocToMarkdown`) so headings/lists/bold/links become real
 *    markdown, rather than the flat `export?mimeType=text/plain` output.
 *  - Subfolder recursion is bounded to ONE level below each configured folder
 *    (configured folder + its immediate subfolders) to stay predictable and
 *    avoid unbounded traversal / cycles.
 *
 * Convention reference: `src/integrations/github-projects.ts` (fetch-based
 * client, typed errors, no client lib).
 */

import fs from 'fs';

import {
  CONNECTOR_SYNC_INTERVAL_MS,
  GOOGLE_DRIVE_FOLDER_IDS,
} from '../../config.js';
import { readEnvFile } from '../../env.js';
import type { Connector, ConnectorContext, ConnectorDoc } from './base.js';

const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files';
const DOCS_API = 'https://docs.googleapis.com/v1/documents';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DOC_MIME = 'application/vnd.google-apps.document';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Typed error for fatal connector failures (auth, malformed creds). Messages
 * are always non-secret — never interpolate token material. */
export class GoogleDriveError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'GoogleDriveError';
  }
}

// --- Creds path resolution --------------------------------------------------

/**
 * Resolve the host path to the Google Workspace CLI credentials file. Minimal
 * replica of `resolveGoogleWorkspaceCredsPath` in `src/container-runner.ts`
 * (we don't import it to avoid pulling that module's heavy deps). Reads
 * `GOOGLE_WORKSPACE_CREDENTIALS_FILE` from `.env` (process.env fallback) and
 * requires the path to exist and be a regular file. Returns undefined when
 * unset/invalid — the connector then reports itself unconfigured.
 */
export function resolveGoogleWorkspaceCredsPath(): string | undefined {
  const raw =
    readEnvFile(['GOOGLE_WORKSPACE_CREDENTIALS_FILE'])
      .GOOGLE_WORKSPACE_CREDENTIALS_FILE ||
    process.env.GOOGLE_WORKSPACE_CREDENTIALS_FILE;
  if (!raw) return undefined;

  let realPath: string;
  try {
    realPath = fs.realpathSync(raw);
  } catch {
    return undefined;
  }
  try {
    if (!fs.statSync(realPath).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return realPath;
}

// --- Access token loading ---------------------------------------------------

/** Shapes we accept in the gws creds JSON. Token material may live at the top
 * level, or be nested under a `tokens`/`credentials` object, or under a single
 * top-level account key (gws stores per-account entries keyed by email). */
interface RawTokenBundle {
  access_token?: string;
  token?: string;
  expiry?: string | number;
  expires_at?: string | number;
  expiry_date?: string | number;
  refresh_token?: string;
  client_id?: string;
  client_secret?: string;
}

/** Reads a creds file's parsed JSON. Injectable so tests need no real creds. */
export type CredsReader = () => unknown;

/** Default creds reader: resolve the path and parse the JSON off disk. */
function defaultCredsReader(): unknown {
  const credsPath = resolveGoogleWorkspaceCredsPath();
  if (!credsPath) {
    throw new GoogleDriveError(
      'GOOGLE_WORKSPACE_CREDENTIALS_FILE is not set or does not resolve to a file',
    );
  }
  let text: string;
  try {
    text = fs.readFileSync(credsPath, 'utf-8');
  } catch {
    throw new GoogleDriveError(
      'unable to read Google Workspace credentials file',
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GoogleDriveError(
      'Google Workspace credentials file is not valid JSON',
    );
  }
}

/** True when an access token has an expiry that is already in the past. A
 * missing expiry is treated as usable (many gws bundles omit it). */
function isExpired(bundle: RawTokenBundle): boolean {
  const raw = bundle.expiry ?? bundle.expires_at ?? bundle.expiry_date;
  if (raw == null) return false;
  const ms =
    typeof raw === 'number'
      ? // Heuristic: 10-digit values are unix seconds, 13-digit are ms.
        raw < 1e12
        ? raw * 1000
        : raw
      : Date.parse(String(raw));
  if (Number.isNaN(ms)) return false;
  // 60s skew so we don't hand back a token about to expire mid-request.
  return ms <= Date.now() + 60_000;
}

/** Pull the first plausible token bundle out of a parsed creds object,
 * tolerating the couple of nesting shapes gws is known to emit. */
function findTokenBundle(parsed: unknown): RawTokenBundle | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const obj = parsed as Record<string, unknown>;

  const looksLikeBundle = (v: unknown): v is RawTokenBundle => {
    if (!v || typeof v !== 'object') return false;
    const b = v as RawTokenBundle;
    return (
      typeof b.access_token === 'string' ||
      typeof b.token === 'string' ||
      typeof b.refresh_token === 'string'
    );
  };

  // (a) top-level bundle
  if (looksLikeBundle(obj)) return obj as RawTokenBundle;
  // (b) nested under a well-known key
  for (const key of ['tokens', 'credentials', 'token', 'installed', 'web']) {
    if (looksLikeBundle(obj[key])) return obj[key] as RawTokenBundle;
  }
  // (c) per-account map: pick the first value that looks like a bundle
  for (const v of Object.values(obj)) {
    if (looksLikeBundle(v)) return v as RawTokenBundle;
    // one more level down (e.g. { "user@x": { tokens: {...} } })
    if (v && typeof v === 'object') {
      for (const inner of Object.values(v as Record<string, unknown>)) {
        if (looksLikeBundle(inner)) return inner as RawTokenBundle;
      }
    }
  }
  return undefined;
}

/**
 * Load a usable Google API access token, reusing the gws credentials file.
 *
 * 1. Parse the creds JSON (via `readCreds`, injectable for tests).
 * 2. If it carries a usable, unexpired `access_token`/`token`, return it — no
 *    network.
 * 3. Otherwise, if it carries `refresh_token` + `client_id` + `client_secret`,
 *    POST a `grant_type=refresh_token` request to Google's OAuth token endpoint
 *    and return the minted access token.
 * 4. If no token material is found, throw a `GoogleDriveError` with a
 *    non-secret message.
 *
 * Never logs or interpolates token/secret values.
 */
export async function loadGoogleAccessToken(
  fetchImpl: typeof fetch,
  readCreds: CredsReader = defaultCredsReader,
): Promise<string> {
  const parsed = readCreds();
  const bundle = findTokenBundle(parsed);
  if (!bundle) {
    throw new GoogleDriveError(
      'no usable Google token material found in credentials file',
    );
  }

  const direct = bundle.access_token || bundle.token;
  if (direct && !isExpired(bundle)) return direct;

  if (bundle.refresh_token && bundle.client_id && bundle.client_secret) {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: bundle.refresh_token,
      client_id: bundle.client_id,
      client_secret: bundle.client_secret,
    });
    const res = await fetchImpl(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      // Body may echo the client_secret in an error — do NOT include it.
      throw new GoogleDriveError(
        `Google OAuth token refresh failed (HTTP ${res.status})`,
        res.status,
      );
    }
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) {
      throw new GoogleDriveError(
        'Google OAuth token refresh returned no access_token',
      );
    }
    return json.access_token;
  }

  // We had a bundle but it was expired with no way to refresh, or missing
  // client material — either way we can't produce a valid token.
  if (direct) {
    throw new GoogleDriveError(
      'Google access token is expired and no refresh material is available',
    );
  }
  throw new GoogleDriveError(
    'Google credentials file lacks a usable access_token or refresh_token+client_id+client_secret',
  );
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

/** Convert one text run to inline markdown (bold/italic/link). */
function renderTextRun(run: DocsTextRun): string {
  // Docs runs include the trailing "\n"; strip it — line breaks are handled by
  // paragraph joining so styling markers don't wrap the newline.
  let text = (run.content ?? '').replace(/\n$/, '');
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

/** Authenticated GET against a Google API endpoint returning parsed JSON. */
async function driveGet<T>(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<T> {
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // 401/403 are fatal auth problems — surface as typed errors so the loop
    // logs them clearly; callers decide whether to abort the whole run.
    throw new GoogleDriveError(
      `Google API HTTP ${res.status}: ${text.slice(0, 200)}`,
      res.status,
    );
  }
  return (await res.json()) as T;
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
    const resp = await driveGet<DriveFilesResponse>(
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
  const doc = await driveGet<DocsDocument>(
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
 * Sync implementation. Incremental via `modifiedTime`:
 *  - Files with `modifiedTime <= cursor` are skipped (not exported).
 *  - After the run, the cursor advances to the max `modifiedTime` seen.
 *
 * `complete` semantics (drives base.ts's delete-reconcile): we report
 * `complete: true` ONLY when there was NO cursor (a full pull from scratch)
 * AND every folder listing + doc export succeeded. Any incremental run (cursor
 * present) reports `complete: false` so the framework does NOT delete unchanged
 * files that this run intentionally skipped. Per-file export failures also
 * force `complete: false` (that file wasn't refreshed, so it must not be swept).
 */
async function sync(
  ctx: ConnectorContext,
): Promise<{ docs: ConnectorDoc[]; complete: boolean }> {
  const cursor = ctx.getCursor();
  const token = await loadGoogleAccessToken(ctx.fetchImpl);

  const { files, listedOk } = await collectDocs(token, ctx.fetchImpl);

  const docs: ConnectorDoc[] = [];
  let maxModified = cursor ?? '';
  let allExportsOk = true;

  for (const { file, folderId } of files) {
    const modified = file.modifiedTime ?? '';
    if (modified > maxModified) maxModified = modified;
    // Incremental skip: unchanged since the last cursor.
    if (cursor && modified && modified <= cursor) continue;
    try {
      const markdown = await fetchDocMarkdown(file.id, token, ctx.fetchImpl);
      docs.push(driveFileToConnectorDoc(file, folderId, markdown));
    } catch (err) {
      // A fatal auth error should abort the whole run, not be swallowed.
      if (
        err instanceof GoogleDriveError &&
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

  if (maxModified) ctx.setCursor(maxModified);

  // Only a from-scratch, fully-successful pull may trigger deletes.
  const complete = !cursor && listedOk && allExportsOk;
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
