import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// --- Mocks ---

vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const configMock = vi.hoisted(() => ({
  CONNECTOR_SYNC_INTERVAL_MS: 1800000,
  NOTION_ROOT_PAGE_IDS: [] as string[],
  NOTION_DATABASE_IDS: [] as string[],
  GROUPS_DIR: '',
  SHARED_KB_GROUP: 'slack_main',
}));

vi.mock('../../config.js', () => configMock);

vi.mock('../../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// In-memory router_state so runConnector's cursor plumbing works without a
// real DB (unused by notion.ts's own sync logic post-Fix-4, but base.ts's
// runConnector() still reads/writes it as framework infra).
const routerState = vi.hoisted(() => new Map<string, string>());
vi.mock('../../db.js', () => ({
  getRouterState: (k: string) => routerState.get(k),
  setRouterState: (k: string, v: string) => {
    routerState.set(k, v);
  },
}));

// Import the module under test AFTER the mocks are wired.
import {
  notionConnector,
  richTextToMarkdown,
  notionBlocksToMarkdown,
  pageToDoc,
  pageTitle,
  getNotionToken,
  getNotionDefaultVisibility,
  NotionError,
} from './notion.js';
import { runConnector } from './base.js';
import type { ConnectorContext } from './base.js';

// --- Helpers ---

/* eslint-disable @typescript-eslint/no-explicit-any */

function rt(
  text: string,
  annotations?: Record<string, boolean>,
  href?: string,
): any {
  return {
    type: 'text',
    plain_text: text,
    href: href ?? null,
    annotations: annotations ?? {},
  };
}

function block(type: string, extra: any = {}): any {
  return { id: `blk-${type}`, type, has_children: false, ...extra };
}

/** Build a fetch stub that dispatches on URL + method to canned responses. */
function makeFetch(
  handler: (
    url: string,
    init: any,
  ) => { ok?: boolean; status?: number; body: any },
): any {
  return vi.fn(async (url: string, init: any = {}) => {
    const { ok = true, status = 200, body } = handler(String(url), init);
    return {
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  });
}

function makeCtx(over?: Partial<ConnectorContext>): ConnectorContext {
  return {
    getCursor: () => undefined,
    setCursor: vi.fn(),
    fetchImpl: makeFetch(() => ({ body: { results: [] } })),
    syncStart: '2026-07-04T00:00:00Z',
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as any,
    ...over,
  };
}

// --- Auth / config ---

describe('getNotionToken', () => {
  afterEach(() => {
    delete process.env.NOTION_API_KEY;
  });

  it('reads the token from process.env', () => {
    process.env.NOTION_API_KEY = 'secret_abc';
    expect(getNotionToken()).toBe('secret_abc');
  });

  it('returns null when unset', () => {
    expect(getNotionToken()).toBeNull();
  });
});

describe('isConfigured', () => {
  afterEach(() => {
    delete process.env.NOTION_API_KEY;
    configMock.NOTION_ROOT_PAGE_IDS = [];
    configMock.NOTION_DATABASE_IDS = [];
  });

  it('false without a token', () => {
    configMock.NOTION_DATABASE_IDS = ['db1'];
    expect(notionConnector.isConfigured()).toBe(false);
  });

  it('false with a token but no scope', () => {
    process.env.NOTION_API_KEY = 'secret';
    expect(notionConnector.isConfigured()).toBe(false);
  });

  it('true with a token and a database id', () => {
    process.env.NOTION_API_KEY = 'secret';
    configMock.NOTION_DATABASE_IDS = ['db1'];
    expect(notionConnector.isConfigured()).toBe(true);
  });

  it('true with a token and a root page id', () => {
    process.env.NOTION_API_KEY = 'secret';
    configMock.NOTION_ROOT_PAGE_IDS = ['pg1'];
    expect(notionConnector.isConfigured()).toBe(true);
  });
});

// --- richTextToMarkdown ---

describe('richTextToMarkdown', () => {
  it('renders plain text unchanged', () => {
    expect(richTextToMarkdown([rt('hello world')])).toBe('hello world');
  });

  it('applies bold / italic / strikethrough / code', () => {
    expect(richTextToMarkdown([rt('b', { bold: true })])).toBe('**b**');
    expect(richTextToMarkdown([rt('i', { italic: true })])).toBe('*i*');
    expect(richTextToMarkdown([rt('s', { strikethrough: true })])).toBe(
      '~~s~~',
    );
    expect(richTextToMarkdown([rt('c', { code: true })])).toBe('`c`');
  });

  it('nests bold + italic', () => {
    // italic applied first, then bold wraps it → ***x***
    expect(richTextToMarkdown([rt('x', { bold: true, italic: true })])).toBe(
      '***x***',
    );
  });

  it('renders links', () => {
    expect(
      richTextToMarkdown([rt('Anthropic', undefined, 'https://anthropic.com')]),
    ).toBe('[Anthropic](https://anthropic.com)');
  });

  it('wraps a formatted, linked span correctly', () => {
    expect(
      richTextToMarkdown([rt('go', { bold: true }, 'https://x.com')]),
    ).toBe('[**go**](https://x.com)');
  });

  it('concatenates mixed spans', () => {
    const out = richTextToMarkdown([
      rt('plain '),
      rt('bold', { bold: true }),
      rt(' and '),
      rt('code', { code: true }),
    ]);
    expect(out).toBe('plain **bold** and `code`');
  });

  it('handles empty / non-array input', () => {
    expect(richTextToMarkdown(undefined)).toBe('');
    expect(richTextToMarkdown([])).toBe('');
  });

  // --- stored-XSS defense: escape raw HTML in untrusted source text ---

  it('escapes literal HTML in plain text so a markdown renderer emits inert text', () => {
    expect(richTextToMarkdown([rt('<img src=x onerror=alert(1)>')])).toBe(
      '&lt;img src=x onerror=alert(1)&gt;',
    );
  });

  it('escapes stray angle brackets and ampersands mixed with normal text', () => {
    expect(richTextToMarkdown([rt('a<b && c>d')])).toBe(
      'a&lt;b &amp;&amp; c&gt;d',
    );
  });

  it('escapes source text even when annotated, without escaping our own markdown markers', () => {
    // Source text containing a raw tag, made bold — the ** markers we add must
    // stay intact while the source's <...> is neutralized.
    expect(
      richTextToMarkdown([rt('<script>alert(1)</script>', { bold: true })]),
    ).toBe('**&lt;script&gt;alert(1)&lt;/script&gt;**');
  });

  it('normal text round-trips unescaped', () => {
    expect(richTextToMarkdown([rt('plain safe text, 100% fine')])).toBe(
      'plain safe text, 100% fine',
    );
  });
});

// --- notionBlocksToMarkdown ---

describe('notionBlocksToMarkdown', () => {
  it('renders a paragraph', () => {
    const md = notionBlocksToMarkdown([
      block('paragraph', { paragraph: { rich_text: [rt('hi')] } }),
    ]);
    expect(md).toBe('hi');
  });

  it('renders headings 1/2/3', () => {
    const md = notionBlocksToMarkdown([
      block('heading_1', { heading_1: { rich_text: [rt('H1')] } }),
      block('heading_2', { heading_2: { rich_text: [rt('H2')] } }),
      block('heading_3', { heading_3: { rich_text: [rt('H3')] } }),
    ]);
    expect(md).toBe('# H1\n## H2\n### H3');
  });

  it('renders bulleted and numbered lists', () => {
    const md = notionBlocksToMarkdown([
      block('bulleted_list_item', {
        bulleted_list_item: { rich_text: [rt('a')] },
      }),
      block('numbered_list_item', {
        numbered_list_item: { rich_text: [rt('one')] },
      }),
      block('numbered_list_item', {
        numbered_list_item: { rich_text: [rt('two')] },
      }),
    ]);
    expect(md).toBe('- a\n1. one\n2. two');
  });

  it('renders to_do checkboxes (checked + unchecked)', () => {
    const md = notionBlocksToMarkdown([
      block('to_do', { to_do: { rich_text: [rt('done')], checked: true } }),
      block('to_do', { to_do: { rich_text: [rt('todo')], checked: false } }),
    ]);
    expect(md).toBe('- [x] done\n- [ ] todo');
  });

  it('renders quotes, callouts, dividers', () => {
    const md = notionBlocksToMarkdown([
      block('quote', { quote: { rich_text: [rt('quoted')] } }),
      block('callout', { callout: { rich_text: [rt('note')] } }),
      block('divider', { divider: {} }),
    ]);
    expect(md).toBe('> quoted\n> note\n---');
  });

  it('renders fenced code with language', () => {
    const md = notionBlocksToMarkdown([
      block('code', {
        code: { rich_text: [rt('console.log(1)')], language: 'javascript' },
      }),
    ]);
    expect(md).toBe('```javascript\nconsole.log(1)\n```');
  });

  it('omits the language for plain-text code', () => {
    const md = notionBlocksToMarkdown([
      block('code', {
        code: { rich_text: [rt('raw')], language: 'plain text' },
      }),
    ]);
    expect(md).toBe('```\nraw\n```');
  });

  it('skips unknown block types without throwing', () => {
    const md = notionBlocksToMarkdown([
      block('paragraph', { paragraph: { rich_text: [rt('keep')] } }),
      block('unsupported_widget', { unsupported_widget: { foo: 1 } }),
      block('image', { image: { external: { url: 'x' } } }),
      block('paragraph', { paragraph: { rich_text: [rt('also')] } }),
    ]);
    expect(md).toBe('keep\nalso');
  });

  it('renders nested list children indented', () => {
    const parent = block('bulleted_list_item', {
      bulleted_list_item: { rich_text: [rt('outer')] },
      has_children: true,
      __children: [
        block('bulleted_list_item', {
          bulleted_list_item: { rich_text: [rt('inner')] },
        }),
      ],
    });
    const md = notionBlocksToMarkdown([parent]);
    expect(md).toBe('- outer\n  - inner');
  });

  it('renders toggle children', () => {
    const toggle = block('toggle', {
      toggle: { rich_text: [rt('Summary')] },
      has_children: true,
      __children: [
        block('paragraph', { paragraph: { rich_text: [rt('hidden')] } }),
      ],
    });
    expect(notionBlocksToMarkdown([toggle])).toBe('- Summary\n  hidden');
  });

  it('handles empty input', () => {
    expect(notionBlocksToMarkdown(undefined)).toBe('');
    expect(notionBlocksToMarkdown([])).toBe('');
  });
});

// --- pageTitle + pageToDoc mapping ---

describe('pageTitle', () => {
  it('reads the title property (named Name)', () => {
    const page: any = {
      id: 'p',
      properties: {
        Name: { type: 'title', title: [rt('My Page')] },
        Status: { type: 'select', select: { name: 'Done' } },
      },
    };
    expect(pageTitle(page)).toBe('My Page');
  });

  it('falls back to (untitled) when no title property', () => {
    expect(pageTitle({ id: 'p', properties: {} } as any)).toBe('(untitled)');
  });
});

describe('pageToDoc', () => {
  it('maps id/title/sourceUrl/updatedAt/extraFrontmatter', () => {
    const page: any = {
      id: 'abc-123',
      url: 'https://www.notion.so/My-Page-abc123',
      last_edited_time: '2026-07-01T12:00:00.000Z',
      properties: { Name: { type: 'title', title: [rt('My Page')] } },
    };
    const doc = pageToDoc(page, '# Body', 'db-parent');
    expect(doc.id).toBe('abc-123');
    expect(doc.title).toBe('My Page');
    expect(doc.sourceUrl).toBe('https://www.notion.so/My-Page-abc123');
    expect(doc.markdown).toBe('# Body');
    expect(doc.updatedAt).toBe('2026-07-01T12:00:00.000Z');
    expect(doc.extraFrontmatter).toEqual({
      notion_id: 'abc-123',
      notion_parent: 'db-parent',
    });
  });

  it('synthesizes a notion.so url when the page has none', () => {
    const doc = pageToDoc({ id: 'aaa-bbb' } as any, '', 'root');
    expect(doc.sourceUrl).toBe('https://www.notion.so/aaabbb');
  });

  it('defaults synced docs to a non-open visibility', () => {
    const doc = pageToDoc({ id: 'p1' } as any, '', 'root');
    expect(doc.visibility).toBe('restricted');
    expect(doc.visibility).not.toBe('open');
  });
});

// --- Default visibility (Fix 2: don't flatten upstream ACLs to open) ---

describe('getNotionDefaultVisibility', () => {
  afterEach(() => {
    delete process.env.NOTION_DEFAULT_VISIBILITY;
  });

  it('defaults to restricted when unset', () => {
    expect(getNotionDefaultVisibility()).toBe('restricted');
  });

  it('is overridable via NOTION_DEFAULT_VISIBILITY', () => {
    process.env.NOTION_DEFAULT_VISIBILITY = 'private';
    expect(getNotionDefaultVisibility()).toBe('private');
  });

  it('honors an explicit open override', () => {
    process.env.NOTION_DEFAULT_VISIBILITY = 'open';
    expect(getNotionDefaultVisibility()).toBe('open');
  });

  it('falls back to restricted on an unrecognized value (never silently widens access)', () => {
    process.env.NOTION_DEFAULT_VISIBILITY = 'public'; // not a valid KB visibility level
    expect(getNotionDefaultVisibility()).toBe('restricted');
  });

  it('flows through to pageToDoc', () => {
    process.env.NOTION_DEFAULT_VISIBILITY = 'private';
    const doc = pageToDoc({ id: 'p1' } as any, '', 'root');
    expect(doc.visibility).toBe('private');
  });
});

// --- NotionError on non-2xx ---

describe('sync error handling', () => {
  afterEach(() => {
    delete process.env.NOTION_API_KEY;
    configMock.NOTION_ROOT_PAGE_IDS = [];
    configMock.NOTION_DATABASE_IDS = [];
  });

  it('skips a database whose query errors and reports complete=false', async () => {
    process.env.NOTION_API_KEY = 'secret';
    configMock.NOTION_DATABASE_IDS = ['db-bad'];
    const fetchImpl = makeFetch(() => ({
      ok: false,
      status: 403,
      body: { message: 'forbidden' },
    }));
    const ctx = makeCtx({ fetchImpl });
    const res = await notionConnector.sync(ctx);
    expect(res.docs).toEqual([]);
    expect(res.complete).toBe(false);
  });

  it('NotionError carries the status', () => {
    const err = new NotionError('boom', 429);
    expect(err.name).toBe('NotionError');
    expect(err.status).toBe(429);
  });
});

// --- Incremental sync + complete flag ---

/**
 * Canned fetch for a single database with two pages. The database query
 * returns page metadata; the block-children endpoint returns one paragraph
 * each and no further children (has_more:false).
 */
function dbFetch(pages: any[]): any {
  return makeFetch((url, init) => {
    if (url.includes('/databases/') && init.method === 'POST') {
      return { body: { results: pages, has_more: false, next_cursor: null } };
    }
    if (url.includes('/children')) {
      return {
        body: {
          results: [
            block('paragraph', { paragraph: { rich_text: [rt('content')] } }),
          ],
          has_more: false,
          next_cursor: null,
        },
      };
    }
    return { body: { results: [] } };
  });
}

/** Run the real notionConnector through base.ts's runConnector() against a
 * scratch KB dir, so reconcile-delete behavior is exercised end-to-end. */
async function runConnectorForTest(
  fetchImpl: any,
  dir: string,
  now: string,
): Promise<{ upserted: number; deleted: number; complete: boolean }> {
  return runConnector(
    { ...notionConnector, syncInterval: 0 },
    { fetchImpl, dir, now: () => now },
  );
}

describe('full-pull-every-run + complete flag (Fixes 3/4/5)', () => {
  beforeEach(() => {
    process.env.NOTION_API_KEY = 'secret';
    configMock.NOTION_DATABASE_IDS = ['db1'];
    configMock.NOTION_ROOT_PAGE_IDS = [];
  });

  afterEach(() => {
    delete process.env.NOTION_API_KEY;
    configMock.NOTION_DATABASE_IDS = [];
  });

  const pageA = {
    id: 'page-a',
    url: 'https://www.notion.so/a',
    last_edited_time: '2026-06-01T00:00:00.000Z',
    properties: { Name: { type: 'title', title: [rt('A')] } },
  };
  const pageB = {
    id: 'page-b',
    url: 'https://www.notion.so/b',
    last_edited_time: '2026-06-10T00:00:00.000Z',
    properties: { Name: { type: 'title', title: [rt('B')] } },
  };

  it('pulls every page every run and reports complete=true on a clean pull', async () => {
    const ctx = makeCtx({ fetchImpl: dbFetch([pageA, pageB]) });
    const res = await notionConnector.sync(ctx);
    expect(res.complete).toBe(true);
    expect(res.docs.map((d) => d.id).sort()).toEqual(['page-a', 'page-b']);
    // Body was converted from blocks.
    expect(res.docs[0].markdown).toBe('content');
  });

  it('fetches blocks for every page every run, not just "changed" ones', async () => {
    const fetchImpl = dbFetch([pageA, pageB]);
    const ctx = makeCtx({ fetchImpl });
    await notionConnector.sync(ctx);
    const blockCalls = fetchImpl.mock.calls.filter((c: any[]) =>
      String(c[0]).includes('/children'),
    );
    // Both pages' blocks are fetched — there is no cursor to skip against.
    expect(blockCalls).toHaveLength(2);
  });

  it('repeated runs each pull the full set again (no persisted cursor gates it)', async () => {
    const ctx1 = makeCtx({ fetchImpl: dbFetch([pageA, pageB]) });
    const res1 = await notionConnector.sync(ctx1);
    const ctx2 = makeCtx({ fetchImpl: dbFetch([pageA, pageB]) });
    const res2 = await notionConnector.sync(ctx2);
    expect(res1.complete).toBe(true);
    expect(res2.complete).toBe(true);
    expect(res2.docs.map((d) => d.id).sort()).toEqual(['page-a', 'page-b']);
  });

  // --- Fix 5: same-timestamp docs are never dropped (no boundary at all now) ---

  it('two pages sharing the exact same last_edited_time are both synced', async () => {
    const sameTime = '2026-06-05T00:00:00.000Z';
    const pageC = {
      id: 'page-c',
      url: 'https://www.notion.so/c',
      last_edited_time: sameTime,
      properties: { Name: { type: 'title', title: [rt('C')] } },
    };
    const pageD = {
      id: 'page-d',
      url: 'https://www.notion.so/d',
      last_edited_time: sameTime,
      properties: { Name: { type: 'title', title: [rt('D')] } },
    };
    const ctx = makeCtx({ fetchImpl: dbFetch([pageC, pageD]) });
    const res = await notionConnector.sync(ctx);
    expect(res.docs.map((d) => d.id).sort()).toEqual(['page-c', 'page-d']);
  });

  // --- Fix 3: a page whose block-fetch fails isn't skipped forever ---

  it('a page whose block fetch fails this run is retried (and picked up) next run', async () => {
    let failPageA = true;
    const flakyFetch = makeFetch((url, init) => {
      if (url.includes('/databases/') && init.method === 'POST') {
        return {
          body: { results: [pageA, pageB], has_more: false, next_cursor: null },
        };
      }
      if (url.includes('/children')) {
        if (url.includes(pageA.id) && failPageA) {
          return { ok: false, status: 500, body: { message: 'boom' } };
        }
        return {
          body: {
            results: [
              block('paragraph', { paragraph: { rich_text: [rt('content')] } }),
            ],
            has_more: false,
            next_cursor: null,
          },
        };
      }
      return { body: { results: [] } };
    });

    // Run 1: page-a's block fetch fails.
    const res1 = await notionConnector.sync(makeCtx({ fetchImpl: flakyFetch }));
    expect(res1.complete).toBe(false);
    expect(res1.docs.map((d) => d.id)).toEqual(['page-b']);

    // Run 2: page-a succeeds this time — because there's no cursor, it's
    // retried rather than skipped forever (the Fix 3 bug this dissolves).
    failPageA = false;
    const res2 = await notionConnector.sync(makeCtx({ fetchImpl: flakyFetch }));
    expect(res2.complete).toBe(true);
    expect(res2.docs.map((d) => d.id).sort()).toEqual(['page-a', 'page-b']);
  });

  // --- Fix 4: deletions reconcile on every complete run, not just the first ---

  it('a page removed upstream is deleted from the KB on a later complete run', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-reconcile-'));
    try {
      // Run 1: both pages present.
      const run1 = await runConnectorForTest(
        dbFetch([pageA, pageB]),
        dir,
        '2026-06-01T00:00:00.000Z',
      );
      expect(run1.upserted).toBe(2);
      expect(
        fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.md'))
          .sort(),
      ).toEqual(['page-a.md', 'page-b.md']);

      // Run 2 (later): page-a removed upstream — only page-b comes back.
      const run2 = await runConnectorForTest(
        dbFetch([pageB]),
        dir,
        '2026-06-02T00:00:00.000Z',
      );
      // The SECOND complete run reconciles the deletion, proving reconcile
      // isn't a one-time-ever event gated on a persisted cursor.
      expect(run2.deleted).toBe(1);
      expect(fs.readdirSync(dir).filter((f) => f.endsWith('.md'))).toEqual([
        'page-b.md',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
