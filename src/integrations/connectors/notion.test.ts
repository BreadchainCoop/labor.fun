import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
}));

vi.mock('../../config.js', () => configMock);

vi.mock('../../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Import the module under test AFTER the mocks are wired.
import {
  notionConnector,
  richTextToMarkdown,
  notionBlocksToMarkdown,
  pageToDoc,
  pageTitle,
  getNotionToken,
  NotionError,
} from './notion.js';
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

describe('incremental sync + complete flag', () => {
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

  it('full pull (no cursor) reports complete=true and advances cursor to max', async () => {
    const setCursor = vi.fn();
    const ctx = makeCtx({
      getCursor: () => undefined,
      setCursor,
      fetchImpl: dbFetch([pageA, pageB]),
    });
    const res = await notionConnector.sync(ctx);
    expect(res.complete).toBe(true);
    expect(res.docs.map((d) => d.id).sort()).toEqual(['page-a', 'page-b']);
    // Body was converted from blocks.
    expect(res.docs[0].markdown).toBe('content');
    // Cursor advances to the newest last_edited_time seen.
    expect(setCursor).toHaveBeenCalledWith('2026-06-10T00:00:00.000Z');
  });

  it('incremental pull (with cursor) reports complete=false and skips unchanged', async () => {
    const setCursor = vi.fn();
    const ctx = makeCtx({
      // Cursor between A and B → only B is newer.
      getCursor: () => '2026-06-05T00:00:00.000Z',
      setCursor,
      fetchImpl: dbFetch([pageA, pageB]),
    });
    const res = await notionConnector.sync(ctx);
    // Incremental runs must NEVER be complete (framework must not delete).
    expect(res.complete).toBe(false);
    // Only the changed page comes back; A (<= cursor) is skipped.
    expect(res.docs.map((d) => d.id)).toEqual(['page-b']);
    expect(setCursor).toHaveBeenCalledWith('2026-06-10T00:00:00.000Z');
  });

  it('does not fetch blocks for skipped (unchanged) pages', async () => {
    const fetchImpl = dbFetch([pageA, pageB]);
    const ctx = makeCtx({
      getCursor: () => '2026-06-05T00:00:00.000Z',
      setCursor: vi.fn(),
      fetchImpl,
    });
    await notionConnector.sync(ctx);
    const blockCalls = fetchImpl.mock.calls.filter((c: any[]) =>
      String(c[0]).includes('/children'),
    );
    // Only page-b's blocks fetched, not page-a's.
    expect(blockCalls).toHaveLength(1);
    expect(String(blockCalls[0][0])).toContain('page-b');
  });

  it('does not advance the cursor when nothing changed', async () => {
    const setCursor = vi.fn();
    const ctx = makeCtx({
      // Cursor at/after the newest page → nothing to do.
      getCursor: () => '2026-06-10T00:00:00.000Z',
      setCursor,
      fetchImpl: dbFetch([pageA, pageB]),
    });
    const res = await notionConnector.sync(ctx);
    expect(res.docs).toEqual([]);
    expect(res.complete).toBe(false);
    expect(setCursor).not.toHaveBeenCalled();
  });
});
