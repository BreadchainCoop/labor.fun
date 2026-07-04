/**
 * Confluence knowledge connector.
 *
 * Mirrors a bounded slice of a Confluence Cloud site into the per-group KB as
 * one markdown file per Confluence **page** (doc-per-page → citations land on
 * a specific page, not a whole space). The framework (`base.ts`) does all KB
 * writes/deletes/cursor bookkeeping; this module only talks to the Confluence
 * Cloud REST API (v2) and returns `ConnectorDoc[]` plus a `complete` flag.
 *
 * Confluence is the canonical company wiki in every competitor's connector
 * catalog (Dust / Glean / Cassidy / Albus / …) and a RAG "must-have" source —
 * see docs/CONNECTORS.md.
 *
 * Scope is configured entirely via env, read with `readEnvFile` INSIDE this
 * module (not `src/config.ts` — connector-specific config stays local to the
 * connector per the current framework convention):
 *   - `CONFLUENCE_BASE_URL` — the site's Confluence root, e.g.
 *     `https://your-org.atlassian.net/wiki`.
 *   - `CONFLUENCE_EMAIL` + `CONFLUENCE_API_TOKEN` — Atlassian API-token Basic
 *     auth (see docs/CONNECTORS.md for how to create one).
 *   - `CONFLUENCE_SPACE_KEYS` — comma-separated space keys; every page in each
 *     space is synced.
 *   - `CONFLUENCE_PAGE_IDS` — comma-separated page ids; each is synced
 *     individually (no descendant expansion — keeps scope bounded and
 *     predictable, same reasoning as Notion's root-page handling).
 *   - `CONFLUENCE_DEFAULT_VISIBILITY` — overrides the default `restricted`
 *     visibility (see base.ts's `DEFAULT_CONNECTOR_VISIBILITY`).
 * At least one of `CONFLUENCE_SPACE_KEYS` / `CONFLUENCE_PAGE_IDS` must be set,
 * plus the base URL + auth, or the connector reports itself unconfigured and
 * the framework never starts its loop (inert when unconfigured).
 *
 * API: Confluence Cloud REST API **v2** (`/wiki/api/v2/...`), the current
 * generation of the API (v1 `/wiki/rest/api/content` is legacy/maintenance
 * mode). Space keys are resolved to numeric space ids via `GET /spaces`, then
 * pages are listed per space via `GET /pages?space-id=...&body-format=storage`
 * with cursor-based pagination (`_links.next`). Individually-scoped page ids
 * are fetched via `GET /pages/{id}?body-format=storage`. The page body comes
 * back in Confluence **storage format** (an XHTML-ish dialect) which we
 * convert to markdown with a small tree-based converter (`storageToMarkdown`,
 * `parseStorageHtml`) — headings/paragraphs/lists/code/quotes/links/tables,
 * escaping raw text with `escapeHtml` (base.ts) before any markdown styling is
 * layered on, same stored-XSS defense as the Notion/Drive connectors.
 *
 * Sync model: a FULL pull every run (see `sync()`'s doc comment for the full
 * rationale, mirrored from notion.ts/google-drive.ts) — every configured
 * space/page id is re-listed/re-fetched on each tick, so `complete` is a
 * purely in-run flag (never persisted) and a fully-successful run always
 * reconciles (deletes) pages removed upstream, not just the first one ever.
 */

import { readEnvFile } from '../../env.js';
import { logger } from '../../logger.js';

import { DEFAULT_CONNECTOR_VISIBILITY, escapeHtml } from './base.js';
import type {
  Connector,
  ConnectorContext,
  ConnectorDoc,
  ConnectorVisibility,
} from './base.js';

const API_VERSION_PATH = '/api/v2';
/** Poll interval fallback if CONNECTOR_SYNC_INTERVAL_MS can't be read (kept
 * local — this module must not import from config.ts). Matches the shared
 * default documented in docs/CONNECTORS.md / .env.example. */
const DEFAULT_SYNC_INTERVAL_MS = 30 * 60 * 1000;

const ENV_KEYS = [
  'CONFLUENCE_BASE_URL',
  'CONFLUENCE_EMAIL',
  'CONFLUENCE_API_TOKEN',
  'CONFLUENCE_SPACE_KEYS',
  'CONFLUENCE_PAGE_IDS',
  'CONFLUENCE_DEFAULT_VISIBILITY',
  'CONNECTOR_SYNC_INTERVAL_MS',
];

/** Read one config value: process.env wins over `.env` (mirrors the other
 * connectors' precedence). Re-reads `.env` each call — cheap, and avoids a
 * stale module-load-time snapshot in tests that mutate process.env. */
function readConfigValue(key: string): string | undefined {
  return process.env[key] || readEnvFile(ENV_KEYS)[key] || undefined;
}

/** Split a comma-separated env value into trimmed, non-empty tokens. */
function splitIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Comma-separated Confluence space keys to sync (every page in each). */
export function getConfluenceSpaceKeys(): string[] {
  return splitIds(readConfigValue('CONFLUENCE_SPACE_KEYS'));
}

/** Comma-separated individual Confluence page ids to sync. */
export function getConfluencePageIds(): string[] {
  return splitIds(readConfigValue('CONFLUENCE_PAGE_IDS'));
}

/** The Confluence site root, e.g. `https://your-org.atlassian.net/wiki`.
 * Trailing slash stripped so path joins below are predictable. */
export function getConfluenceBaseUrl(): string | null {
  const raw = readConfigValue('CONFLUENCE_BASE_URL');
  return raw ? raw.replace(/\/+$/, '') : null;
}

/** Atlassian account email used for Basic auth (paired with the API token). */
export function getConfluenceEmail(): string | null {
  return readConfigValue('CONFLUENCE_EMAIL') || null;
}

/** Atlassian API token (Basic auth password half). Never logged. */
export function getConfluenceApiToken(): string | null {
  return readConfigValue('CONFLUENCE_API_TOKEN') || null;
}

/** Shared connector poll interval (ms); local read so this module never
 * imports from config.ts. Falls back to the documented 30-minute default on
 * an unset/invalid value. */
export function getConfluenceSyncIntervalMs(): number {
  const raw = readConfigValue('CONNECTOR_SYNC_INTERVAL_MS');
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_SYNC_INTERVAL_MS;
}

const VALID_VISIBILITIES: ConnectorVisibility[] = [
  'open',
  'restricted',
  'private',
];

/**
 * Default visibility for docs this connector syncs. Overridable via
 * `CONFLUENCE_DEFAULT_VISIBILITY` (process.env wins over `.env`); falls back
 * to the framework default (`restricted`, see base.ts) when unset or set to an
 * unrecognized value — never silently widens access on a typo.
 */
export function getConfluenceDefaultVisibility(): ConnectorVisibility {
  const raw = readConfigValue('CONFLUENCE_DEFAULT_VISIBILITY');
  return VALID_VISIBILITIES.includes(raw as ConnectorVisibility)
    ? (raw as ConnectorVisibility)
    : DEFAULT_CONNECTOR_VISIBILITY;
}

/** Thrown on a non-2xx Confluence API response. Mirrors `NotionError` /
 * `GoogleDriveError`. Message never includes auth material. */
export class ConfluenceError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ConfluenceError';
  }
}

// --- Confluence API shapes (only the fields we read) ------------------------

export interface ConfluenceSpace {
  id: string;
  key: string;
}

export interface ConfluencePageBody {
  storage?: { value?: string; representation?: string };
}

export interface ConfluencePage {
  id: string;
  title?: string;
  spaceId?: string;
  status?: string;
  body?: ConfluencePageBody;
  version?: { createdAt?: string; number?: number };
  _links?: { webui?: string };
}

interface ConfluenceListResponse<T> {
  results?: T[];
  _links?: { next?: string };
}

// --- Storage format (XHTML-ish) → markdown ----------------------------------

/** Decode the handful of entities Confluence storage format actually emits.
 * `&amp;` is decoded LAST so a source `&amp;lt;` (a literal ampersand
 * followed by "lt;") doesn't get mistaken for a doubly-encoded `<`. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** A minimal parsed-HTML node: either an element (tag + attrs + children) or
 * a text leaf. Just enough structure to walk storage format recursively. */
type StorageNode =
  | { kind: 'element'; tag: string; attrs: string; children: StorageNode[] }
  | { kind: 'text'; text: string };

const VOID_TAGS = new Set(['br', 'hr', 'img', 'ac:image']);

/**
 * Parse a Confluence storage-format (XHTML-ish) string into a tiny node tree.
 * Not a general HTML parser — just enough of a recursive-descent tag walker
 * to handle the bounded, well-formed element set Confluence's storage format
 * actually emits (p/h1-6/ul/ol/li/strong/em/code/a/pre/blockquote/table/tr/
 * td/th/br, plus `ac:*` / `ri:*` macro tags). Unknown/malformed tags degrade
 * to being treated as plain containers rather than throwing.
 */
export function parseStorageHtml(html: string): StorageNode[] {
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9:._-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;
  type RawTok =
    | { kind: 'open'; tag: string; attrs: string; selfClose: boolean }
    | { kind: 'close'; tag: string }
    | { kind: 'text'; text: string };

  const toks: RawTok[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    if (m.index > lastIndex) {
      toks.push({ kind: 'text', text: html.slice(lastIndex, m.index) });
    }
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const rawAttrs = m[3] ?? '';
    const selfClose = /\/\s*$/.test(rawAttrs) || VOID_TAGS.has(tag);
    if (closing) {
      toks.push({ kind: 'close', tag });
    } else {
      toks.push({ kind: 'open', tag, attrs: rawAttrs, selfClose });
    }
    lastIndex = tagRe.lastIndex;
  }
  if (lastIndex < html.length) {
    toks.push({ kind: 'text', text: html.slice(lastIndex) });
  }

  // CDATA sections (used inside ac:plain-text-body) are emitted by the regex
  // above as ordinary text since `<![CDATA[` doesn't match the tag pattern;
  // strip the wrapper markers back out of any text token that carries them.
  for (const t of toks) {
    if (t.kind === 'text' && t.text.includes('<![CDATA[')) {
      t.text = t.text.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '');
    }
  }

  let pos = 0;

  function parseChildren(stopTag?: string): StorageNode[] {
    const nodes: StorageNode[] = [];
    while (pos < toks.length) {
      const t = toks[pos];
      if (t.kind === 'close') {
        if (t.tag === stopTag) {
          pos++; // consume the matching close
          return nodes;
        }
        // A close with no matching open in scope (malformed/unbalanced
        // markup) — skip it rather than throwing.
        pos++;
        continue;
      }
      if (t.kind === 'text') {
        if (t.text) nodes.push({ kind: 'text', text: t.text });
        pos++;
        continue;
      }
      // open
      pos++;
      if (t.selfClose) {
        nodes.push({ kind: 'element', tag: t.tag, attrs: t.attrs, children: [] });
      } else {
        const children = parseChildren(t.tag);
        nodes.push({ kind: 'element', tag: t.tag, attrs: t.attrs, children });
      }
    }
    return nodes;
  }

  return parseChildren(undefined);
}

/** Pull an attribute value (e.g. `href`, `ac:name`) out of a raw attrs string. */
function getAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i');
  const m = re.exec(attrs);
  return m ? decodeEntities(m[1]) : undefined;
}

/** Find the first descendant element matching `tag` (shallow BFS-ish scan,
 * used to pull a macro's parameter/body children out by name). */
function findChild(
  nodes: StorageNode[],
  tag: string,
): Extract<StorageNode, { kind: 'element' }> | undefined {
  for (const n of nodes) {
    if (n.kind === 'element' && n.tag === tag) return n;
  }
  return undefined;
}

/** Concatenate the raw text of a node subtree (used for CDATA code bodies). */
function rawText(nodes: StorageNode[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.kind === 'text') out += n.text;
    else out += rawText(n.children);
  }
  return out;
}

/**
 * Render an inline run of nodes (text + strong/em/code/a/br) to markdown.
 * Raw text is HTML-escaped (`escapeHtml`, base.ts) BEFORE any markdown
 * styling is applied, so untrusted page text containing literal
 * `<img src=x onerror=...>` (e.g. pasted as plain text into a paragraph, or
 * smuggled through storage format as an entity) can never survive as live
 * HTML in the markdown the KB dashboard renders with `marked()`. Only OUR
 * OWN emitted markdown control characters (`**`, `` ` ``, `[...]()`) are left
 * unescaped.
 */
function renderInline(nodes: StorageNode[]): string {
  return nodes
    .map((n) => {
      if (n.kind === 'text') return escapeHtml(decodeEntities(n.text));
      switch (n.tag) {
        case 'strong':
        case 'b':
          return `**${renderInline(n.children)}**`;
        case 'em':
        case 'i':
          return `*${renderInline(n.children)}*`;
        case 'code':
          return `\`${renderInline(n.children)}\``;
        case 'br':
          return '\n';
        case 'a': {
          const href = getAttr(n.attrs, 'href') ?? '';
          const text = renderInline(n.children);
          return href ? `[${text}](${href})` : text;
        }
        default:
          // Unknown inline wrapper — keep its rendered text, drop the tag.
          return renderInline(n.children);
      }
    })
    .join('');
}

/** Render a `<table>` element's rows as one markdown bullet line per row
 * (`cell | cell | …`) — pragmatic, keeps content searchable without a full
 * GFM table conversion (same tradeoff google-drive.ts makes for Docs tables). */
function renderTable(table: Extract<StorageNode, { kind: 'element' }>): string[] {
  const lines: string[] = [];
  const rows = table.children.filter(
    (n): n is Extract<StorageNode, { kind: 'element' }> =>
      n.kind === 'element' && n.tag === 'tr',
  );
  for (const row of rows) {
    const cells = row.children
      .filter(
        (n): n is Extract<StorageNode, { kind: 'element' }> =>
          n.kind === 'element' && (n.tag === 'td' || n.tag === 'th'),
      )
      .map((cell) => renderInline(cell.children).replace(/\n/g, ' ').trim());
    if (cells.length) lines.push(`- ${cells.join(' | ')}`);
  }
  return lines;
}

/** Render a `<ul>`/`<ol>` element's `<li>` children, recursing into nested
 * lists (indented two spaces per level). Numbered lists restart per `<ol>`. */
function renderList(
  list: Extract<StorageNode, { kind: 'element' }>,
  depth: number,
): string[] {
  const ordered = list.tag === 'ol';
  const lines: string[] = [];
  let n = 0;
  const indent = '  '.repeat(depth);
  for (const item of list.children) {
    if (item.kind !== 'element' || item.tag !== 'li') continue;
    // Split each <li>'s children into inline content vs. nested list blocks,
    // so "Parent item\n  - Child item" renders instead of losing the nesting.
    const nestedLists = item.children.filter(
      (c): c is Extract<StorageNode, { kind: 'element' }> =>
        c.kind === 'element' && (c.tag === 'ul' || c.tag === 'ol'),
    );
    const inlineChildren = item.children.filter(
      (c) => !(c.kind === 'element' && (c.tag === 'ul' || c.tag === 'ol')),
    );
    const text = renderInline(inlineChildren).trim();
    if (ordered) {
      n += 1;
      if (text) lines.push(`${indent}${n}. ${text}`);
    } else if (text) {
      lines.push(`${indent}- ${text}`);
    }
    for (const nested of nestedLists) {
      lines.push(...renderList(nested, depth + 1));
    }
  }
  return lines;
}

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** Render a Confluence `ac:structured-macro` (code block, info/panel/note,
 * expand, etc.) to markdown. Code macros render as a fenced code block using
 * the raw (unescaped-markdown, HTML-escaped) CDATA body; every other macro
 * falls back to rendering its `ac:rich-text-body` inline so the surrounding
 * prose isn't silently dropped, just loses its special panel styling. */
function renderMacro(macro: Extract<StorageNode, { kind: 'element' }>): string[] {
  const name = getAttr(macro.attrs, 'ac:name');
  if (name === 'code') {
    const langParam = macro.children
      .filter(
        (n): n is Extract<StorageNode, { kind: 'element' }> =>
          n.kind === 'element' && n.tag === 'ac:parameter',
      )
      .find((p) => getAttr(p.attrs, 'ac:name') === 'language');
    const lang = langParam ? rawText(langParam.children).trim() : '';
    const plainBody = findChild(macro.children, 'ac:plain-text-body');
    const code = decodeEntities(rawText(plainBody ? plainBody.children : []));
    return [`\`\`\`${lang}\n${escapeHtml(code)}\n\`\`\``];
  }
  const richBody = findChild(macro.children, 'ac:rich-text-body');
  return richBody ? renderBlocks(richBody.children) : [];
}

/**
 * Render a sequence of block-level storage-format nodes to markdown lines
 * (one block per array element; caller joins with blank lines). Recurses for
 * containers (div/span/ac:layout-cell/…) and macros so nothing nested is
 * silently dropped. This is the block-level counterpart to `renderInline` —
 * mirrors the structure of `notionBlocksToMarkdown` in notion.ts.
 */
export function renderBlocks(nodes: StorageNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.kind === 'text') {
      const t = escapeHtml(decodeEntities(n.text)).trim();
      if (t) out.push(t);
      continue;
    }
    if (HEADING_TAGS.has(n.tag)) {
      const level = Number(n.tag[1]);
      const text = renderInline(n.children).trim();
      if (text) out.push(`${'#'.repeat(level)} ${text}`);
      continue;
    }
    switch (n.tag) {
      case 'p': {
        const text = renderInline(n.children).trim();
        if (text) out.push(text);
        break;
      }
      case 'blockquote': {
        const text = renderInline(n.children).trim();
        if (text) out.push(text.split('\n').map((l) => `> ${l}`).join('\n'));
        break;
      }
      case 'pre': {
        const text = decodeEntities(rawText(n.children));
        out.push(`\`\`\`\n${escapeHtml(text)}\n\`\`\``);
        break;
      }
      case 'ul':
      case 'ol': {
        const lines = renderList(n, 0);
        if (lines.length) out.push(lines.join('\n'));
        break;
      }
      case 'hr':
        out.push('---');
        break;
      case 'table': {
        const lines = renderTable(n);
        if (lines.length) out.push(lines.join('\n'));
        break;
      }
      case 'ac:structured-macro': {
        const lines = renderMacro(n);
        if (lines.length) out.push(...lines);
        break;
      }
      case 'ac:image':
      case 'ac:link':
        // No useful text content to surface for these on their own.
        break;
      default:
        // Unknown/container tag (div, span, ac:layout, ac:layout-section,
        // ac:layout-cell, …) — recurse into its children so nested block
        // content isn't silently dropped, just loses this wrapper's meaning.
        out.push(...renderBlocks(n.children));
        break;
    }
  }
  return out;
}

/**
 * Convert Confluence **storage format** (an XHTML dialect used by the v2
 * `body-format=storage` page body) to markdown. Parses the string into a
 * small node tree (`parseStorageHtml`) and walks it block-by-block
 * (`renderBlocks`), joining blocks with a blank line for readable markdown.
 *
 * All raw text content passes through `escapeHtml` (base.ts) before any
 * markdown styling is applied (see `renderInline`/`renderBlocks`), so a
 * literal `<img src=x onerror=...>` in an upstream page's text can never
 * survive as live HTML in the markdown the KB dashboard renders with
 * `marked()`. Only our own emitted markdown control characters
 * (`#`, `-`, `**`, `` ` ``, `[...]()`) are left unescaped.
 *
 * Unsupported/unknown tags (layout macros, panels, status lozenges, etc.)
 * degrade gracefully — their text content still surfaces via `renderBlocks`'s
 * default case, just without special formatting.
 */
export function storageToMarkdown(storageHtml: string | undefined): string {
  const html = storageHtml ?? '';
  if (!html.trim()) return '';
  const nodes = parseStorageHtml(html);
  return renderBlocks(nodes).join('\n\n').trim();
}

// --- API calls ---------------------------------------------------------------

function authHeader(email: string, token: string): string {
  const encoded = Buffer.from(`${email}:${token}`).toString('base64');
  return `Basic ${encoded}`;
}

async function confluenceRequest<T>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  email: string,
  token: string,
  urlOrPath: string,
): Promise<T> {
  const url = urlOrPath.startsWith('http')
    ? urlOrPath
    : `${baseUrl}${API_VERSION_PATH}${urlOrPath}`;
  const res = await fetchImpl(url, {
    headers: {
      Authorization: authHeader(email, token),
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ConfluenceError(
      `Confluence API HTTP ${res.status}: ${text.slice(0, 200)}`,
      res.status,
    );
  }
  return (await res.json()) as T;
}

/** Resolve space keys to numeric space ids via `GET /spaces?keys=...`. */
async function resolveSpaceIds(
  fetchImpl: typeof fetch,
  baseUrl: string,
  email: string,
  token: string,
  keys: string[],
): Promise<ConfluenceSpace[]> {
  if (keys.length === 0) return [];
  const qs = new URLSearchParams({
    keys: keys.join(','),
    limit: '250',
  });
  const data = await confluenceRequest<ConfluenceListResponse<ConfluenceSpace>>(
    fetchImpl,
    baseUrl,
    email,
    token,
    `/spaces?${qs.toString()}`,
  );
  return data.results ?? [];
}

/** List every page in a space, paginating via `_links.next` to the end. */
async function listSpacePages(
  fetchImpl: typeof fetch,
  baseUrl: string,
  email: string,
  token: string,
  spaceId: string,
): Promise<ConfluencePage[]> {
  const pages: ConfluencePage[] = [];
  const qs = new URLSearchParams({
    'space-id': spaceId,
    'body-format': 'storage',
    status: 'current',
    limit: '100',
  });
  let next: string | undefined = `/pages?${qs.toString()}`;
  while (next) {
    const data: ConfluenceListResponse<ConfluencePage> =
      await confluenceRequest<ConfluenceListResponse<ConfluencePage>>(
        fetchImpl,
        baseUrl,
        email,
        token,
        next,
      );
    pages.push(...(data.results ?? []));
    next = data._links?.next;
  }
  return pages;
}

/** Fetch a single page by id (used for `CONFLUENCE_PAGE_IDS` scope). */
async function fetchPageById(
  fetchImpl: typeof fetch,
  baseUrl: string,
  email: string,
  token: string,
  pageId: string,
): Promise<ConfluencePage> {
  const qs = new URLSearchParams({ 'body-format': 'storage' });
  return confluenceRequest<ConfluencePage>(
    fetchImpl,
    baseUrl,
    email,
    token,
    `/pages/${encodeURIComponent(pageId)}?${qs.toString()}`,
  );
}

// --- Page → ConnectorDoc -----------------------------------------------------

/**
 * Build the page's citation URL. `_links.webui` is a site-relative path
 * (e.g. `/spaces/ENG/pages/123456/Runbook`); joined onto the base URL. Falls
 * back to a generic `/wiki/pages/{id}` URL when webui is absent.
 */
export function confluencePageUrl(baseUrl: string, page: ConfluencePage): string {
  const webui = page._links?.webui;
  if (webui) {
    return `${baseUrl}${webui.startsWith('/') ? '' : '/'}${webui}`;
  }
  return `${baseUrl}/pages/${page.id}`;
}

/**
 * Build a `ConnectorDoc` from a Confluence page's metadata + already-converted
 * markdown. `id` is the page's numeric id as Confluence returns it — the
 * framework sanitizes it into a filename (see `sanitizeDocId`/`docPath` in
 * base.ts), so even a hostile/malformed id or title can never escape the
 * connector's KB subdir.
 */
export function pageToDoc(
  baseUrl: string,
  page: ConfluencePage,
  markdown: string,
): ConnectorDoc {
  return {
    id: page.id,
    title: page.title || '(untitled)',
    sourceUrl: confluencePageUrl(baseUrl, page),
    markdown,
    updatedAt: page.version?.createdAt,
    // Not-world-open by default (see base.ts); overridable via
    // CONFLUENCE_DEFAULT_VISIBILITY.
    visibility: getConfluenceDefaultVisibility(),
    extraFrontmatter: {
      confluence_page_id: page.id,
      ...(page.spaceId ? { confluence_space_id: page.spaceId } : {}),
    },
  };
}

// --- Connector ----------------------------------------------------------------

export const confluenceConnector: Connector = {
  name: 'confluence',
  get syncInterval(): number {
    return getConfluenceSyncIntervalMs();
  },

  isConfigured(): boolean {
    const hasAuth = !!(
      getConfluenceBaseUrl() &&
      getConfluenceEmail() &&
      getConfluenceApiToken()
    );
    const hasScope =
      getConfluenceSpaceKeys().length > 0 || getConfluencePageIds().length > 0;
    return hasAuth && hasScope;
  },

  /**
   * Pull every in-scope Confluence page, EVERY run — a full pull, not an
   * incremental one. Mirrors notion.ts / google-drive.ts (see their `sync()`
   * doc comments for the full three-bug rationale this dissolves): `complete`
   * is computed fresh each run and never persisted, so a fully-successful run
   * ALWAYS reconciles (deletes) pages removed upstream — not just the first
   * ever — and a transient per-page failure can never be "skipped forever"
   * the way a persisted cursor could cause.
   *
   * `complete` is true only when every configured space listing AND every
   * page fetch (space-scoped or individually-scoped) succeeded this run — a
   * single failure anywhere forces `complete: false` so the framework does
   * not reconcile (delete) based on a partial pull.
   */
  async sync(
    ctx: ConnectorContext,
  ): Promise<{ docs: ConnectorDoc[]; complete: boolean }> {
    const baseUrl = getConfluenceBaseUrl();
    const email = getConfluenceEmail();
    const token = getConfluenceApiToken();
    if (!baseUrl || !email || !token) return { docs: [], complete: false };

    const fetchImpl = ctx.fetchImpl;
    const docs: ConnectorDoc[] = [];
    // In-run only — never persisted. Any fetch failure below flips this to
    // false, which gates the framework's delete-reconcile for this run.
    let complete = true;

    const spaceKeys = getConfluenceSpaceKeys();
    const pageIds = getConfluencePageIds();

    const targets: ConfluencePage[] = [];
    const seen = new Set<string>();

    if (spaceKeys.length > 0) {
      try {
        const spaces = await resolveSpaceIds(
          fetchImpl,
          baseUrl,
          email,
          token,
          spaceKeys,
        );
        const foundKeys = new Set(spaces.map((s) => s.key));
        for (const key of spaceKeys) {
          if (!foundKeys.has(key)) {
            complete = false;
            ctx.logger.warn(
              { source: 'confluence', spaceKey: key },
              'confluence connector: space key not found, skipping',
            );
          }
        }
        for (const space of spaces) {
          try {
            const pages = await listSpacePages(
              fetchImpl,
              baseUrl,
              email,
              token,
              space.id,
            );
            for (const p of pages) {
              if (!seen.has(p.id)) {
                seen.add(p.id);
                targets.push(p);
              }
            }
          } catch (err) {
            complete = false;
            ctx.logger.warn(
              {
                source: 'confluence',
                spaceId: space.id,
                spaceKey: space.key,
                err: err instanceof Error ? err.message : err,
              },
              'confluence connector: space page listing failed, skipping',
            );
          }
        }
      } catch (err) {
        complete = false;
        ctx.logger.warn(
          {
            source: 'confluence',
            err: err instanceof Error ? err.message : err,
          },
          'confluence connector: space resolution failed, skipping all space scope',
        );
      }
    }

    for (const pageId of pageIds) {
      if (seen.has(pageId)) continue;
      try {
        const page = await fetchPageById(fetchImpl, baseUrl, email, token, pageId);
        seen.add(page.id);
        targets.push(page);
      } catch (err) {
        complete = false;
        ctx.logger.warn(
          {
            source: 'confluence',
            pageId,
            err: err instanceof Error ? err.message : err,
          },
          'confluence connector: page fetch failed, skipping',
        );
      }
    }

    for (const page of targets) {
      // body-format=storage was requested on every listing/fetch above, so
      // body.storage.value should be present; tolerate its absence gracefully
      // (empty page body) rather than treating it as a fetch failure.
      const markdown = storageToMarkdown(page.body?.storage?.value);
      docs.push(pageToDoc(baseUrl, page, markdown));
    }

    logger.debug(
      { source: 'confluence', docs: docs.length, complete },
      'confluence connector: sync pass complete',
    );

    return { docs, complete };
  },
};
