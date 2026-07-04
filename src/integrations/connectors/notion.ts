/**
 * Notion knowledge connector.
 *
 * Mirrors a bounded slice of a Notion workspace into the per-group KB as one
 * markdown file per Notion **page** (doc-per-page → citations land on a
 * specific page, not a whole database). The framework (`base.ts`) does all KB
 * writes/deletes/cursor bookkeeping; this module only talks to the Notion REST
 * API and returns `ConnectorDoc[]` plus a `complete` flag.
 *
 * Scope is env-gated (`src/config.ts`):
 *   - `NOTION_DATABASE_IDS` — each database is queried and every result page is
 *     mirrored.
 *   - `NOTION_ROOT_PAGE_IDS` — each id is mirrored as a page, plus its DIRECT
 *     child pages (one level down only). We deliberately do NOT recurse the page
 *     tree arbitrarily deep: a single misconfigured root could otherwise pull an
 *     unbounded subtree. Deeper structure still lands because a page's own
 *     child_page blocks render as links in its markdown.
 *
 * Auth: `NOTION_API_KEY` (an internal integration token) read via `readEnvFile`
 * with a process.env fallback. Never logged.
 *
 * API client is plain `fetch` (via `ctx.fetchImpl` so tests inject a stub) —
 * no `@notionhq/client`. Mirrors the fetch/error-handling style of
 * `github-projects.ts`.
 */

import {
  CONNECTOR_SYNC_INTERVAL_MS,
  NOTION_DATABASE_IDS,
  NOTION_ROOT_PAGE_IDS,
} from '../../config.js';
import { readEnvFile } from '../../env.js';
import { logger } from '../../logger.js';

import { DEFAULT_CONNECTOR_VISIBILITY, escapeHtml } from './base.js';
import type {
  Connector,
  ConnectorContext,
  ConnectorDoc,
  ConnectorVisibility,
} from './base.js';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
/** Max depth we recurse into block children (toggles / list items). */
const MAX_BLOCK_DEPTH = 3;

const envCache = readEnvFile(['NOTION_API_KEY', 'NOTION_DEFAULT_VISIBILITY']);

/** Read the Notion integration token (process.env wins over .env). Never log it. */
export function getNotionToken(): string | null {
  return process.env.NOTION_API_KEY || envCache.NOTION_API_KEY || null;
}

const VALID_VISIBILITIES: ConnectorVisibility[] = [
  'open',
  'restricted',
  'private',
];

/**
 * Default visibility for docs this connector syncs. Overridable via
 * `NOTION_DEFAULT_VISIBILITY` (process.env wins over `.env`); falls back to
 * the framework default (`restricted`, see base.ts) when unset or set to an
 * unrecognized value — never silently widens access on a typo.
 */
export function getNotionDefaultVisibility(): ConnectorVisibility {
  const raw =
    process.env.NOTION_DEFAULT_VISIBILITY || envCache.NOTION_DEFAULT_VISIBILITY;
  return VALID_VISIBILITIES.includes(raw as ConnectorVisibility)
    ? (raw as ConnectorVisibility)
    : DEFAULT_CONNECTOR_VISIBILITY;
}

/** Thrown on a non-2xx Notion API response. Mirrors `GitHubProjectsError`. */
export class NotionError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'NotionError';
  }
}

// --- Notion API shapes (only the fields we read) ---------------------------

interface NotionRichText {
  type?: string;
  plain_text?: string;
  href?: string | null;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    code?: boolean;
  };
}

interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  // Each block type carries its own payload keyed by `type`; typed loosely
  // since Notion's block union is large and we only touch a subset.
  [key: string]: unknown;
}

interface NotionPage {
  id: string;
  url?: string;
  last_edited_time?: string;
  properties?: Record<string, unknown>;
}

interface NotionListResponse<T> {
  results: T[];
  has_more?: boolean;
  next_cursor?: string | null;
}

// --- Rich text → markdown --------------------------------------------------

/**
 * Convert a Notion rich-text array to inline markdown. Applies annotations
 * (code → italic → bold → strikethrough, innermost-first) then wraps in a link
 * when `href` is set. Order matters so `**_x_**` nests correctly.
 *
 * The raw `plain_text` is HTML-escaped (`escapeHtml`, base.ts) BEFORE any
 * markdown markers are applied, so untrusted source text (e.g. a Notion
 * paragraph containing literal `<img src=x onerror=...>`) can never inject
 * live HTML into the markdown the dashboard renders with `marked()`. The
 * markdown control characters added below (`**`, `` ` ``, `[...]()`) are ours,
 * not the source's, so they're left unescaped.
 */
export function richTextToMarkdown(
  richText: NotionRichText[] | undefined,
): string {
  if (!Array.isArray(richText)) return '';
  return richText
    .map((rt) => {
      let text = escapeHtml(rt.plain_text ?? '');
      if (text === '') return '';
      const a = rt.annotations ?? {};
      // Code wraps closest to the text; escape backticks minimally by leaving
      // as-is (Notion code spans rarely contain backticks).
      if (a.code) text = `\`${text}\``;
      if (a.italic) text = `*${text}*`;
      if (a.bold) text = `**${text}**`;
      if (a.strikethrough) text = `~~${text}~~`;
      const href = rt.href;
      if (href) text = `[${text}](${href})`;
      return text;
    })
    .join('');
}

/** Pull the rich-text array off a block's type payload (empty when absent). */
function blockRichText(block: NotionBlock): NotionRichText[] {
  const payload = block[block.type] as
    | { rich_text?: NotionRichText[] }
    | undefined;
  return payload?.rich_text ?? [];
}

// --- Blocks → markdown -----------------------------------------------------

/**
 * Convert an array of Notion blocks to markdown. Supported block types:
 * paragraph, heading_1/2/3, bulleted_list_item, numbered_list_item, to_do,
 * quote, code (fenced), divider, callout, toggle. Children of toggles/list
 * items are rendered recursively and indented, bounded by `MAX_BLOCK_DEPTH`.
 * Unknown block types are skipped gracefully (never throws).
 *
 * Pure over its inputs: `children` are expected to be pre-attached on each
 * block as `__children` (the sync layer fetches + attaches them); this keeps
 * the transform synchronous and directly unit-testable with canned payloads.
 */
export function notionBlocksToMarkdown(
  blocks: NotionBlock[] | undefined,
  depth = 0,
): string {
  if (!Array.isArray(blocks)) return '';
  const lines: string[] = [];
  const indent = '  '.repeat(depth);
  let numberedIndex = 0;

  for (const block of blocks) {
    // Track numbered-list position; reset when the run of numbered items breaks.
    if (block.type !== 'numbered_list_item') numberedIndex = 0;

    const rt = () => richTextToMarkdown(blockRichText(block));
    let rendered: string | null = null;

    switch (block.type) {
      case 'paragraph':
        rendered = `${indent}${rt()}`;
        break;
      case 'heading_1':
        rendered = `${indent}# ${rt()}`;
        break;
      case 'heading_2':
        rendered = `${indent}## ${rt()}`;
        break;
      case 'heading_3':
        rendered = `${indent}### ${rt()}`;
        break;
      case 'bulleted_list_item':
        rendered = `${indent}- ${rt()}`;
        break;
      case 'numbered_list_item':
        numberedIndex += 1;
        rendered = `${indent}${numberedIndex}. ${rt()}`;
        break;
      case 'to_do': {
        const payload = block.to_do as { checked?: boolean } | undefined;
        const box = payload?.checked ? '[x]' : '[ ]';
        rendered = `${indent}- ${box} ${rt()}`;
        break;
      }
      case 'quote':
        rendered = `${indent}> ${rt()}`;
        break;
      case 'callout':
        // Render callouts as blockquotes (closest markdown analog).
        rendered = `${indent}> ${rt()}`;
        break;
      case 'toggle':
        // Toggle summary as a plain line; its children follow (recursed below).
        rendered = `${indent}- ${rt()}`;
        break;
      case 'code': {
        const payload = block.code as
          | { rich_text?: NotionRichText[]; language?: string }
          | undefined;
        const lang =
          payload?.language && payload.language !== 'plain text'
            ? payload.language
            : '';
        const body = richTextToMarkdown(payload?.rich_text);
        rendered = `${indent}\`\`\`${lang}\n${body}\n${indent}\`\`\``;
        break;
      }
      case 'divider':
        rendered = `${indent}---`;
        break;
      case 'child_page': {
        // A nested page — surface its title as a line so structure isn't lost.
        const payload = block.child_page as { title?: string } | undefined;
        rendered = `${indent}- ${payload?.title ?? '(untitled page)'}`;
        break;
      }
      default:
        // Unknown/unsupported block type — skip gracefully.
        rendered = null;
    }

    if (rendered !== null) lines.push(rendered);

    // Recurse into attached children (toggles, list items, callouts, …).
    const children = block.__children as NotionBlock[] | undefined;
    if (children && children.length && depth < MAX_BLOCK_DEPTH - 1) {
      const childMd = notionBlocksToMarkdown(children, depth + 1);
      if (childMd) lines.push(childMd);
    }
  }

  return lines.join('\n');
}

// --- Page → title ----------------------------------------------------------

/**
 * Extract a page title from its properties. Notion stores the title under a
 * property whose `type === 'title'` (commonly named `Name` or `title`). Falls
 * back to a plain-text join of the title rich-text, else '(untitled)'.
 */
export function pageTitle(page: NotionPage): string {
  const props = page.properties ?? {};
  for (const value of Object.values(props)) {
    const prop = value as { type?: string; title?: NotionRichText[] };
    if (prop?.type === 'title' && Array.isArray(prop.title)) {
      const text = prop.title
        .map((t) => t.plain_text ?? '')
        .join('')
        .trim();
      if (text) return text;
    }
  }
  return '(untitled)';
}

// --- API calls -------------------------------------------------------------

function notionHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

async function notionRequest<T>(
  fetchImpl: typeof fetch,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetchImpl(`${NOTION_API}${path}`, {
    ...init,
    headers: { ...notionHeaders(token), ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new NotionError(
      `Notion API HTTP ${res.status}: ${text.slice(0, 200)}`,
      res.status,
    );
  }
  return (await res.json()) as T;
}

/** Query one database, paging to the end. Returns every result page. */
async function queryDatabase(
  fetchImpl: typeof fetch,
  token: string,
  databaseId: string,
): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let cursor: string | undefined;
  do {
    const body: Record<string, unknown> = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notionRequest<NotionListResponse<NotionPage>>(
      fetchImpl,
      token,
      `/databases/${databaseId}/query`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    pages.push(...(data.results ?? []));
    cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return pages;
}

/** Retrieve a single page's metadata (properties, url, last_edited_time). */
async function retrievePage(
  fetchImpl: typeof fetch,
  token: string,
  pageId: string,
): Promise<NotionPage> {
  return notionRequest<NotionPage>(fetchImpl, token, `/pages/${pageId}`, {
    method: 'GET',
  });
}

/**
 * Fetch a page/block's children, paginating, and recursively attach the
 * children of any child that `has_children` (bounded by `MAX_BLOCK_DEPTH`).
 * The attached children live on `__children` so `notionBlocksToMarkdown` stays
 * a pure sync transform.
 */
async function fetchBlockChildren(
  fetchImpl: typeof fetch,
  token: string,
  blockId: string,
  depth = 0,
): Promise<NotionBlock[]> {
  const blocks: NotionBlock[] = [];
  let cursor: string | undefined;
  do {
    const qs = cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : '';
    const data = await notionRequest<NotionListResponse<NotionBlock>>(
      fetchImpl,
      token,
      `/blocks/${blockId}/children?page_size=100${qs}`,
      { method: 'GET' },
    );
    blocks.push(...(data.results ?? []));
    cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined;
  } while (cursor);

  if (depth < MAX_BLOCK_DEPTH - 1) {
    for (const block of blocks) {
      if (block.has_children && block.type !== 'child_page') {
        block.__children = await fetchBlockChildren(
          fetchImpl,
          token,
          block.id,
          depth + 1,
        );
      }
    }
  }
  return blocks;
}

/** Direct child_page ids of a page (one level), for bounded root-page expansion. */
function childPageIds(blocks: NotionBlock[]): string[] {
  return blocks.filter((b) => b.type === 'child_page').map((b) => b.id);
}

// --- Page → ConnectorDoc ---------------------------------------------------

/**
 * Build a `ConnectorDoc` from a page's metadata + already-converted markdown.
 * `id` is the page id as Notion returns it (dashed) — the framework sanitizes
 * it into a filename. `parentId` records the originating database/root page.
 */
export function pageToDoc(
  page: NotionPage,
  markdown: string,
  parentId: string,
): ConnectorDoc {
  return {
    id: page.id,
    title: pageTitle(page),
    sourceUrl: page.url ?? `https://www.notion.so/${page.id.replace(/-/g, '')}`,
    markdown,
    updatedAt: page.last_edited_time,
    // Not-world-open by default (see base.ts); overridable via
    // NOTION_DEFAULT_VISIBILITY.
    visibility: getNotionDefaultVisibility(),
    extraFrontmatter: {
      notion_id: page.id,
      notion_parent: parentId,
    },
  };
}

// --- Connector -------------------------------------------------------------

export const notionConnector: Connector = {
  name: 'notion',
  syncInterval: CONNECTOR_SYNC_INTERVAL_MS,

  isConfigured(): boolean {
    const hasScope =
      NOTION_ROOT_PAGE_IDS.length > 0 || NOTION_DATABASE_IDS.length > 0;
    return !!getNotionToken() && hasScope;
  },

  /**
   * Pull changed Notion pages.
   *
   * Incremental via `last_edited_time`:
   *   - `ctx.getCursor()` is the newest `last_edited_time` seen last run.
   *   - Pages with `last_edited_time <= cursor` are skipped (blocks not
   *     refetched) — only changed pages come back.
   *   - After the run, the cursor advances to the max `last_edited_time` seen.
   *
   * Complete-flag semantics (gates the framework's delete-reconcile):
   *   - `complete: true` ONLY when there was NO cursor (a full pull from
   *     scratch) AND every database/page/block query paginated to the end with
   *     no per-page error. Only then may the framework delete files it didn't
   *     re-write this run.
   *   - Any incremental run (cursor present) reports `complete: false`: it
   *     intentionally skips unchanged pages, so those files are untouched and
   *     must NOT be swept as stale.
   *   - A partial/errored full pull also reports `complete: false`.
   */
  async sync(
    ctx: ConnectorContext,
  ): Promise<{ docs: ConnectorDoc[]; complete: boolean }> {
    const token = getNotionToken();
    if (!token) return { docs: [], complete: false };

    const cursor = ctx.getCursor();
    const isFullPull = !cursor;
    const fetchImpl = ctx.fetchImpl;

    const docs: ConnectorDoc[] = [];
    let maxEdited = cursor ?? '';
    // Only a from-scratch pull with zero errors may be complete.
    let complete = isFullPull;

    // Collect (page, parentId) targets from databases and root pages.
    const targets: Array<{ page: NotionPage; parentId: string }> = [];

    for (const dbId of NOTION_DATABASE_IDS) {
      try {
        const pages = await queryDatabase(fetchImpl, token, dbId);
        for (const page of pages) targets.push({ page, parentId: dbId });
      } catch (err) {
        complete = false;
        ctx.logger.warn(
          {
            source: 'notion',
            dbId,
            err: err instanceof Error ? err.message : err,
          },
          'notion connector: database query failed, skipping',
        );
      }
    }

    for (const rootId of NOTION_ROOT_PAGE_IDS) {
      try {
        const page = await retrievePage(fetchImpl, token, rootId);
        targets.push({ page, parentId: rootId });
        // Bounded expansion: direct child pages one level down only.
        const rootBlocks = await fetchBlockChildren(fetchImpl, token, rootId);
        for (const childId of childPageIds(rootBlocks)) {
          const childPage = await retrievePage(fetchImpl, token, childId);
          targets.push({ page: childPage, parentId: rootId });
        }
      } catch (err) {
        complete = false;
        ctx.logger.warn(
          {
            source: 'notion',
            rootId,
            err: err instanceof Error ? err.message : err,
          },
          'notion connector: root page fetch failed, skipping',
        );
      }
    }

    for (const { page, parentId } of targets) {
      const edited = page.last_edited_time ?? '';
      // Skip unchanged pages on an incremental run (don't refetch their blocks).
      if (cursor && edited && edited <= cursor) continue;

      try {
        const blocks = await fetchBlockChildren(fetchImpl, token, page.id);
        const markdown = notionBlocksToMarkdown(blocks);
        docs.push(pageToDoc(page, markdown, parentId));
        if (edited > maxEdited) maxEdited = edited;
      } catch (err) {
        // A partial pull must not trigger deletes.
        complete = false;
        ctx.logger.warn(
          {
            source: 'notion',
            pageId: page.id,
            err: err instanceof Error ? err.message : err,
          },
          'notion connector: page block fetch failed, skipping',
        );
      }
    }

    if (maxEdited && maxEdited !== cursor) ctx.setCursor(maxEdited);

    logger.debug(
      { source: 'notion', docs: docs.length, complete, isFullPull },
      'notion connector: sync pass complete',
    );

    return { docs, complete };
  },
};
