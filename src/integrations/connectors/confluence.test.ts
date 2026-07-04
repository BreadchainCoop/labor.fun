import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// --- Mocks (must be wired before importing the module under test) ---

vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// confluence.ts reads ALL its config via readEnvFile (never config.js) per
// the post-hardening connector convention. Individual tests set the return
// value directly; process.env (set per-test) takes precedence over this in
// the module's own read order, matching notion.ts/google-drive.ts.
const readEnvFileMock = vi.hoisted(() =>
  vi.fn(() => ({}) as Record<string, string>),
);
vi.mock('../../env.js', () => ({ readEnvFile: readEnvFileMock }));

// In-memory router_state so runConnector's cursor plumbing works without a
// real DB (framework infra; confluence.ts's own sync logic doesn't use it).
const routerState = vi.hoisted(() => new Map<string, string>());
vi.mock('../../db.js', () => ({
  getRouterState: (k: string) => routerState.get(k),
  setRouterState: (k: string, v: string) => {
    routerState.set(k, v);
  },
}));

// config.js is intentionally NEVER imported by confluence.ts, so there is no
// config.js mock here — that's the point of this test file (see the "never
// touches config.js" assertion below).

// Import the module under test AFTER the mocks are wired.
import {
  confluenceConnector,
  storageToMarkdown,
  parseStorageHtml,
  renderBlocks,
  pageToDoc,
  confluencePageUrl,
  getConfluenceBaseUrl,
  getConfluenceEmail,
  getConfluenceApiToken,
  getConfluenceSpaceKeys,
  getConfluencePageIds,
  getConfluenceDefaultVisibility,
  getConfluenceSyncIntervalMs,
  ConfluenceError,
  type ConfluencePage,
} from './confluence.js';
import { runConnector, docPath, connectorDir } from './base.js';
import type { ConnectorContext } from './base.js';

const ALL_ENV = [
  'CONFLUENCE_BASE_URL',
  'CONFLUENCE_EMAIL',
  'CONFLUENCE_API_TOKEN',
  'CONFLUENCE_SPACE_KEYS',
  'CONFLUENCE_PAGE_IDS',
  'CONFLUENCE_DEFAULT_VISIBILITY',
  'CONNECTOR_SYNC_INTERVAL_MS',
];

function clearProcessEnv() {
  for (const k of ALL_ENV) delete process.env[k];
}

/** Build a fetch stub that dispatches on URL to canned responses. */
function makeFetch(
  handler: (url: string) => { ok?: boolean; status?: number; body: unknown },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  return vi.fn(async (url: string) => {
    const { ok = true, status = 200, body } = handler(String(url));
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
    fetchImpl: makeFetch(() => ({ body: {} })),
    syncStart: '2026-07-04T00:00:00Z',
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    ...over,
  };
}

beforeEach(() => {
  clearProcessEnv();
  readEnvFileMock.mockReturnValue({});
  routerState.clear();
});

afterEach(() => {
  clearProcessEnv();
  vi.clearAllMocks();
});

// --- Config reading (readEnvFile, never config.js) --------------------------

describe('config reading', () => {
  it('never imports config.js (all config comes from readEnvFile/process.env)', () => {
    // This module only mocks env.js/db.js/logger.js above; if confluence.ts
    // imported config.js it would either throw (real config.js pulls in
    // real GROUPS_DIR/paths) or silently rely on real env vars. The fact
    // these tests pass with no config.js mock at all demonstrates the
    // module never touches it.
    expect(getConfluenceSyncIntervalMs()).toBe(30 * 60 * 1000);
  });

  it('reads scope/auth via readEnvFile when process.env is unset', () => {
    readEnvFileMock.mockReturnValue({
      CONFLUENCE_BASE_URL: 'https://acme.atlassian.net/wiki',
      CONFLUENCE_EMAIL: 'bot@acme.com',
      CONFLUENCE_API_TOKEN: 'tok_123',
      CONFLUENCE_SPACE_KEYS: 'ENG, HR ,',
      CONFLUENCE_PAGE_IDS: '111,222',
    });
    expect(getConfluenceBaseUrl()).toBe('https://acme.atlassian.net/wiki');
    expect(getConfluenceEmail()).toBe('bot@acme.com');
    expect(getConfluenceApiToken()).toBe('tok_123');
    expect(getConfluenceSpaceKeys()).toEqual(['ENG', 'HR']);
    expect(getConfluencePageIds()).toEqual(['111', '222']);
  });

  it('process.env takes precedence over readEnvFile', () => {
    readEnvFileMock.mockReturnValue({
      CONFLUENCE_BASE_URL: 'https://from-dotenv.atlassian.net/wiki',
    });
    process.env.CONFLUENCE_BASE_URL = 'https://from-process-env.atlassian.net/wiki';
    expect(getConfluenceBaseUrl()).toBe(
      'https://from-process-env.atlassian.net/wiki',
    );
  });

  it('strips a trailing slash from the base URL', () => {
    process.env.CONFLUENCE_BASE_URL = 'https://acme.atlassian.net/wiki/';
    expect(getConfluenceBaseUrl()).toBe('https://acme.atlassian.net/wiki');
  });

  it('returns null/empty when unset', () => {
    expect(getConfluenceBaseUrl()).toBeNull();
    expect(getConfluenceEmail()).toBeNull();
    expect(getConfluenceApiToken()).toBeNull();
    expect(getConfluenceSpaceKeys()).toEqual([]);
    expect(getConfluencePageIds()).toEqual([]);
  });

  it('parses CONNECTOR_SYNC_INTERVAL_MS, falling back to 30min default on invalid', () => {
    process.env.CONNECTOR_SYNC_INTERVAL_MS = '5000';
    expect(getConfluenceSyncIntervalMs()).toBe(5000);
    process.env.CONNECTOR_SYNC_INTERVAL_MS = 'not-a-number';
    expect(getConfluenceSyncIntervalMs()).toBe(30 * 60 * 1000);
  });
});

// --- isConfigured -------------------------------------------------------------

describe('isConfigured', () => {
  it('false with nothing set', () => {
    expect(confluenceConnector.isConfigured()).toBe(false);
  });

  it('false with auth but no scope', () => {
    process.env.CONFLUENCE_BASE_URL = 'https://acme.atlassian.net/wiki';
    process.env.CONFLUENCE_EMAIL = 'bot@acme.com';
    process.env.CONFLUENCE_API_TOKEN = 'tok';
    expect(confluenceConnector.isConfigured()).toBe(false);
  });

  it('false with scope but missing auth', () => {
    process.env.CONFLUENCE_SPACE_KEYS = 'ENG';
    expect(confluenceConnector.isConfigured()).toBe(false);
  });

  it('true with auth + space key scope', () => {
    process.env.CONFLUENCE_BASE_URL = 'https://acme.atlassian.net/wiki';
    process.env.CONFLUENCE_EMAIL = 'bot@acme.com';
    process.env.CONFLUENCE_API_TOKEN = 'tok';
    process.env.CONFLUENCE_SPACE_KEYS = 'ENG';
    expect(confluenceConnector.isConfigured()).toBe(true);
  });

  it('true with auth + page-id scope', () => {
    process.env.CONFLUENCE_BASE_URL = 'https://acme.atlassian.net/wiki';
    process.env.CONFLUENCE_EMAIL = 'bot@acme.com';
    process.env.CONFLUENCE_API_TOKEN = 'tok';
    process.env.CONFLUENCE_PAGE_IDS = '123';
    expect(confluenceConnector.isConfigured()).toBe(true);
  });
});

// --- Default visibility -------------------------------------------------------

describe('getConfluenceDefaultVisibility', () => {
  it('defaults to restricted when unset', () => {
    expect(getConfluenceDefaultVisibility()).toBe('restricted');
  });

  it('is overridable to open/private', () => {
    process.env.CONFLUENCE_DEFAULT_VISIBILITY = 'private';
    expect(getConfluenceDefaultVisibility()).toBe('private');
    process.env.CONFLUENCE_DEFAULT_VISIBILITY = 'open';
    expect(getConfluenceDefaultVisibility()).toBe('open');
  });

  it('falls back to restricted on an unrecognized value (never silently widens access)', () => {
    process.env.CONFLUENCE_DEFAULT_VISIBILITY = 'public';
    expect(getConfluenceDefaultVisibility()).toBe('restricted');
  });

  it('flows through to pageToDoc', () => {
    process.env.CONFLUENCE_DEFAULT_VISIBILITY = 'open';
    const page: ConfluencePage = { id: 'p1', title: 'T' };
    const doc = pageToDoc('https://acme.atlassian.net/wiki', page, '');
    expect(doc.visibility).toBe('open');
  });

  it('defaults new docs to a non-open visibility when unset', () => {
    const page: ConfluencePage = { id: 'p1', title: 'T' };
    const doc = pageToDoc('https://acme.atlassian.net/wiki', page, '');
    expect(doc.visibility).toBe('restricted');
    expect(doc.visibility).not.toBe('open');
  });
});

// --- confluencePageUrl / pageToDoc --------------------------------------------

describe('confluencePageUrl', () => {
  it('joins the webui link onto the base URL', () => {
    const page: ConfluencePage = {
      id: '123',
      _links: { webui: '/spaces/ENG/pages/123/Runbook' },
    };
    expect(confluencePageUrl('https://acme.atlassian.net/wiki', page)).toBe(
      'https://acme.atlassian.net/wiki/spaces/ENG/pages/123/Runbook',
    );
  });

  it('falls back to a generic pages URL when webui is absent', () => {
    const page: ConfluencePage = { id: '999' };
    expect(confluencePageUrl('https://acme.atlassian.net/wiki', page)).toBe(
      'https://acme.atlassian.net/wiki/pages/999',
    );
  });
});

describe('pageToDoc', () => {
  it('maps id/title/sourceUrl/updatedAt/extraFrontmatter', () => {
    const page: ConfluencePage = {
      id: '456',
      title: 'Onboarding Guide',
      spaceId: '789',
      version: { createdAt: '2026-06-01T12:00:00.000Z' },
      _links: { webui: '/spaces/ENG/pages/456/Onboarding' },
    };
    const doc = pageToDoc(
      'https://acme.atlassian.net/wiki',
      page,
      '# Onboarding',
    );
    expect(doc.id).toBe('456');
    expect(doc.title).toBe('Onboarding Guide');
    expect(doc.sourceUrl).toBe(
      'https://acme.atlassian.net/wiki/spaces/ENG/pages/456/Onboarding',
    );
    expect(doc.markdown).toBe('# Onboarding');
    expect(doc.updatedAt).toBe('2026-06-01T12:00:00.000Z');
    expect(doc.extraFrontmatter).toEqual({
      confluence_page_id: '456',
      confluence_space_id: '789',
    });
  });

  it('titles an untitled page (untitled)', () => {
    const doc = pageToDoc('https://acme.atlassian.net/wiki', { id: '1' }, '');
    expect(doc.title).toBe('(untitled)');
  });
});

// --- storageToMarkdown: structural conversion --------------------------------

describe('storageToMarkdown', () => {
  it('renders paragraphs', () => {
    expect(storageToMarkdown('<p>Hello world</p>')).toBe('Hello world');
  });

  it('renders headings 1-3', () => {
    const md = storageToMarkdown(
      '<h1>Title</h1><h2>Section</h2><h3>Sub</h3>',
    );
    expect(md).toBe('# Title\n\n## Section\n\n### Sub');
  });

  it('renders bold/italic/code inline', () => {
    expect(storageToMarkdown('<p><strong>bold</strong> and <em>italic</em> and <code>code</code></p>')).toBe(
      '**bold** and *italic* and `code`',
    );
  });

  it('renders links', () => {
    expect(
      storageToMarkdown('<p><a href="https://example.com">a link</a></p>'),
    ).toBe('[a link](https://example.com)');
  });

  it('renders unordered and ordered lists, including nesting', () => {
    const md = storageToMarkdown(
      '<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>',
    );
    expect(md).toBe('- one\n- two\n  - nested');
  });

  it('renders an ordered list with sequential numbers', () => {
    const md = storageToMarkdown('<ol><li>first</li><li>second</li></ol>');
    expect(md).toBe('1. first\n2. second');
  });

  it('renders blockquotes', () => {
    expect(storageToMarkdown('<blockquote>quoted text</blockquote>')).toBe(
      '> quoted text',
    );
  });

  it('renders a plain <pre> code block', () => {
    expect(storageToMarkdown('<pre>raw code</pre>')).toBe(
      '```\nraw code\n```',
    );
  });

  it('renders a table as bullet rows', () => {
    const md = storageToMarkdown(
      '<table><tr><th>Name</th><th>Role</th></tr><tr><td>Ada</td><td>Eng</td></tr></table>',
    );
    expect(md).toBe('- Name | Role\n- Ada | Eng');
  });

  it('renders a horizontal rule', () => {
    expect(storageToMarkdown('<p>a</p><hr/><p>b</p>')).toBe('a\n\n---\n\nb');
  });

  it('handles empty/whitespace-only input', () => {
    expect(storageToMarkdown('')).toBe('');
    expect(storageToMarkdown('   ')).toBe('');
    expect(storageToMarkdown(undefined)).toBe('');
  });

  it('decodes storage-format entities in text', () => {
    expect(storageToMarkdown('<p>Ben &amp; Jerry&#39;s &quot;deal&quot;</p>')).toBe(
      'Ben & Jerry\'s "deal"',
    );
  });

  // --- Confluence macros ---

  it('renders a code macro as a fenced code block with language', () => {
    const storage =
      '<ac:structured-macro ac:name="code">' +
      '<ac:parameter ac:name="language">javascript</ac:parameter>' +
      '<ac:plain-text-body><![CDATA[console.log("hi");]]></ac:plain-text-body>' +
      '</ac:structured-macro>';
    expect(storageToMarkdown(storage)).toBe(
      '```javascript\nconsole.log("hi");\n```',
    );
  });

  it('falls back to rendering rich-text-body inline for a non-code macro (e.g. info panel)', () => {
    const storage =
      '<ac:structured-macro ac:name="info">' +
      '<ac:rich-text-body><p>Heads up: read this</p></ac:rich-text-body>' +
      '</ac:structured-macro>';
    expect(storageToMarkdown(storage)).toBe('Heads up: read this');
  });

  it('drops ac:image macros without throwing', () => {
    const storage =
      '<p>before</p><ac:image><ri:attachment ri:filename="x.png" /></ac:image><p>after</p>';
    expect(storageToMarkdown(storage)).toBe('before\n\nafter');
  });

  it('descends into unknown container tags (div/span) so nested content is not lost', () => {
    expect(storageToMarkdown('<div><p>inside a div</p></div>')).toBe(
      'inside a div',
    );
  });

  // --- stored-XSS defense: escape raw HTML in untrusted page text ---

  it('escapes literal HTML text so a markdown renderer emits inert text', () => {
    // A page whose stored text is the LITERAL characters <img ...> (i.e. a
    // user pasted that as plain text, or the API returned already-decoded
    // text inside a text node — not a real tag our parser would consume).
    const storage = '<p>' + '&lt;img src=x onerror=alert(1)&gt;' + '</p>';
    expect(storageToMarkdown(storage)).toBe(
      '&lt;img src=x onerror=alert(1)&gt;',
    );
  });

  it('escapes ampersands/angle-brackets mixed with normal text', () => {
    expect(storageToMarkdown('<p>a &lt;b &amp;&amp; c&gt;d</p>')).toBe(
      'a &lt;b &amp;&amp; c&gt;d',
    );
  });

  it('escapes text inside a code macro body', () => {
    const storage =
      '<ac:structured-macro ac:name="code">' +
      '<ac:plain-text-body><![CDATA[<script>alert(1)</script>]]></ac:plain-text-body>' +
      '</ac:structured-macro>';
    expect(storageToMarkdown(storage)).toBe(
      '```\n&lt;script&gt;alert(1)&lt;/script&gt;\n```',
    );
  });

  it('does not escape our own emitted markdown control characters', () => {
    const md = storageToMarkdown(
      '<p><strong>bold</strong></p><ul><li>item</li></ul>',
    );
    expect(md).toContain('**bold**');
    expect(md).toContain('- item');
  });
});

// --- parseStorageHtml / renderBlocks (structural building blocks) -----------

describe('parseStorageHtml + renderBlocks', () => {
  it('parses nested elements into a node tree renderBlocks can walk', () => {
    const nodes = parseStorageHtml('<p>a <strong>b</strong> c</p>');
    expect(renderBlocks(nodes)).toEqual(['a **b** c']);
  });

  it('tolerates unbalanced/malformed markup without throwing', () => {
    expect(() => parseStorageHtml('<p>oops<p>no close')).not.toThrow();
  });
});

// --- API pagination + sync ----------------------------------------------------

function spacesFetch(spaces: Array<{ id: string; key: string }>) {
  return { results: spaces };
}

describe('sync: space scope + pagination', () => {
  beforeEach(() => {
    process.env.CONFLUENCE_BASE_URL = 'https://acme.atlassian.net/wiki';
    process.env.CONFLUENCE_EMAIL = 'bot@acme.com';
    process.env.CONFLUENCE_API_TOKEN = 'tok_123';
    process.env.CONFLUENCE_SPACE_KEYS = 'ENG';
  });

  it('resolves the space key, paginates pages via _links.next, and converts bodies', async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes('/spaces?')) {
        return { body: spacesFetch([{ id: 'space-1', key: 'ENG' }]) };
      }
      if (url.includes('/pages?') && !url.includes('cursor=')) {
        return {
          body: {
            results: [
              {
                id: 'p1',
                title: 'Page One',
                spaceId: 'space-1',
                body: { storage: { value: '<p>first page</p>' } },
                version: { createdAt: '2026-06-01T00:00:00.000Z' },
                _links: { webui: '/spaces/ENG/pages/p1/Page-One' },
              },
            ],
            _links: {
              next: '/wiki/api/v2/pages?space-id=space-1&cursor=abc',
            },
          },
        };
      }
      if (url.includes('cursor=abc')) {
        return {
          body: {
            results: [
              {
                id: 'p2',
                title: 'Page Two',
                spaceId: 'space-1',
                body: { storage: { value: '<p>second page</p>' } },
                version: { createdAt: '2026-06-02T00:00:00.000Z' },
                _links: { webui: '/spaces/ENG/pages/p2/Page-Two' },
              },
            ],
            _links: {},
          },
        };
      }
      return { body: { results: [] } };
    });

    const res = await confluenceConnector.sync(makeCtx({ fetchImpl }));
    expect(res.complete).toBe(true);
    expect(res.docs.map((d) => d.id).sort()).toEqual(['p1', 'p2']);
    expect(res.docs.find((d) => d.id === 'p1')?.markdown).toBe('first page');
    expect(res.docs.find((d) => d.id === 'p1')?.sourceUrl).toBe(
      'https://acme.atlassian.net/wiki/spaces/ENG/pages/p1/Page-One',
    );

    // The paginated next-page request was actually followed.
    const urls = fetchImpl.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(urls.some((u: string) => u.includes('cursor=abc'))).toBe(true);
  });

  it('reports complete=false and skips a space whose key is not found', async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes('/spaces?')) return { body: spacesFetch([]) };
      return { body: { results: [] } };
    });
    const res = await confluenceConnector.sync(makeCtx({ fetchImpl }));
    expect(res.complete).toBe(false);
    expect(res.docs).toEqual([]);
  });

  it('reports complete=false when a space page listing fails', async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes('/spaces?')) {
        return { body: spacesFetch([{ id: 'space-1', key: 'ENG' }]) };
      }
      if (url.includes('/pages?')) {
        return { ok: false, status: 500, body: { message: 'boom' } };
      }
      return { body: { results: [] } };
    });
    const res = await confluenceConnector.sync(makeCtx({ fetchImpl }));
    expect(res.complete).toBe(false);
    expect(res.docs).toEqual([]);
  });
});

describe('sync: individual page-id scope', () => {
  beforeEach(() => {
    process.env.CONFLUENCE_BASE_URL = 'https://acme.atlassian.net/wiki';
    process.env.CONFLUENCE_EMAIL = 'bot@acme.com';
    process.env.CONFLUENCE_API_TOKEN = 'tok_123';
    process.env.CONFLUENCE_PAGE_IDS = '111,222';
  });

  it('fetches each configured page id individually', async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes('/pages/111')) {
        return {
          body: {
            id: '111',
            title: 'Runbook',
            body: { storage: { value: '<p>runbook body</p>' } },
            _links: { webui: '/spaces/OPS/pages/111/Runbook' },
          },
        };
      }
      if (url.includes('/pages/222')) {
        return {
          body: {
            id: '222',
            title: 'Playbook',
            body: { storage: { value: '<p>playbook body</p>' } },
            _links: { webui: '/spaces/OPS/pages/222/Playbook' },
          },
        };
      }
      return { body: {} };
    });
    const res = await confluenceConnector.sync(makeCtx({ fetchImpl }));
    expect(res.complete).toBe(true);
    expect(res.docs.map((d) => d.id).sort()).toEqual(['111', '222']);
  });

  it('a page fetch failure is skipped and forces complete=false, other pages still sync', async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes('/pages/111')) {
        return { ok: false, status: 404, body: { message: 'not found' } };
      }
      if (url.includes('/pages/222')) {
        return {
          body: {
            id: '222',
            title: 'Playbook',
            body: { storage: { value: '<p>ok</p>' } },
          },
        };
      }
      return { body: {} };
    });
    const res = await confluenceConnector.sync(makeCtx({ fetchImpl }));
    expect(res.complete).toBe(false);
    expect(res.docs.map((d) => d.id)).toEqual(['222']);
  });
});

describe('sync: unconfigured / auth', () => {
  it('returns no docs and complete=false when unconfigured', async () => {
    const res = await confluenceConnector.sync(makeCtx());
    expect(res.docs).toEqual([]);
    expect(res.complete).toBe(false);
  });

  it('ConfluenceError carries the HTTP status', () => {
    const err = new ConfluenceError('boom', 403);
    expect(err.name).toBe('ConfluenceError');
    expect(err.status).toBe(403);
  });
});

// --- Full run through base.ts's runConnector (reconcile / deletion) ---------

describe('runConnector integration: reconcile deletions on a complete pull', () => {
  beforeEach(() => {
    process.env.CONFLUENCE_BASE_URL = 'https://acme.atlassian.net/wiki';
    process.env.CONFLUENCE_EMAIL = 'bot@acme.com';
    process.env.CONFLUENCE_API_TOKEN = 'tok_123';
    process.env.CONFLUENCE_SPACE_KEYS = 'ENG';
  });

  function pageFetch(pages: Array<{ id: string; title: string }>) {
    return makeFetch((url) => {
      if (url.includes('/spaces?')) {
        return { body: spacesFetch([{ id: 'space-1', key: 'ENG' }]) };
      }
      if (url.includes('/pages?')) {
        return {
          body: {
            results: pages.map((p) => ({
              id: p.id,
              title: p.title,
              spaceId: 'space-1',
              body: { storage: { value: `<p>${p.title}</p>` } },
              version: { createdAt: '2026-06-01T00:00:00.000Z' },
              _links: { webui: `/spaces/ENG/pages/${p.id}` },
            })),
            _links: {},
          },
        };
      }
      return { body: { results: [] } };
    });
  }

  it('a page removed upstream is deleted from the KB on a later complete run', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'confluence-reconcile-'));
    try {
      const run1 = await runConnector(
        { ...confluenceConnector, syncInterval: 0 },
        {
          fetchImpl: pageFetch([
            { id: 'p1', title: 'Alpha' },
            { id: 'p2', title: 'Beta' },
          ]),
          dir,
          now: () => '2026-06-01T00:00:00.000Z',
        },
      );
      expect(run1.upserted).toBe(2);
      expect(
        fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(),
      ).toEqual(['p1.md', 'p2.md']);

      // p1 removed upstream on the next run.
      const run2 = await runConnector(
        { ...confluenceConnector, syncInterval: 0 },
        {
          fetchImpl: pageFetch([{ id: 'p2', title: 'Beta' }]),
          dir,
          now: () => '2026-06-02T00:00:00.000Z',
        },
      );
      expect(run2.deleted).toBe(1);
      expect(fs.readdirSync(dir).filter((f) => f.endsWith('.md'))).toEqual([
        'p2.md',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not reconcile deletions on an incomplete pull', async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'confluence-no-reconcile-'),
    );
    try {
      await runConnector(
        { ...confluenceConnector, syncInterval: 0 },
        {
          fetchImpl: pageFetch([{ id: 'p1', title: 'Alpha' }]),
          dir,
          now: () => '2026-06-01T00:00:00.000Z',
        },
      );

      // Second run fails the space listing entirely -> complete:false.
      const failingFetch = makeFetch((url) => {
        if (url.includes('/spaces?')) {
          return { ok: false, status: 500, body: {} };
        }
        return { body: { results: [] } };
      });
      const run2 = await runConnector(
        { ...confluenceConnector, syncInterval: 0 },
        { fetchImpl: failingFetch, dir, now: () => '2026-06-02T00:00:00.000Z' },
      );
      expect(run2.complete).toBe(false);
      expect(run2.deleted).toBe(0);
      // p1 from run 1 must still be present — nothing was reconciled.
      expect(fs.readdirSync(dir).filter((f) => f.endsWith('.md'))).toEqual([
        'p1.md',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- Path safety: a hostile page id/title can't escape the connectors dir --

describe('path safety', () => {
  it('a hostile page id cannot escape the connector KB dir via docPath', () => {
    const dir = connectorDir('confluence', '/groups', 'kb');
    const hostileIds = [
      '../../../../etc/passwd',
      '..%2f..%2fetc%2fpasswd',
      '../../secrets',
      '/etc/passwd',
    ];
    for (const id of hostileIds) {
      const file = docPath('confluence', id, dir);
      expect(file.startsWith(path.resolve(dir) + path.sep)).toBe(true);
      expect(file).not.toContain('etc/passwd');
      expect(file).not.toContain('..');
    }
  });

  it('a hostile page title never influences the file path (only the id does)', () => {
    // pageToDoc/writeConnectorDoc key the filename off doc.id, not doc.title —
    // confirm a page whose TITLE contains traversal sequences still resolves
    // safely because the id (not title) drives the path.
    const dir = connectorDir('confluence', '/groups', 'kb');
    const page: ConfluencePage = {
      id: 'safe-id-1',
      title: '../../../../etc/passwd',
    };
    const doc = pageToDoc('https://acme.atlassian.net/wiki', page, 'body');
    expect(doc.title).toBe('../../../../etc/passwd'); // titles pass through (frontmatter, not a path)
    const file = docPath('confluence', doc.id, dir);
    expect(file.startsWith(path.resolve(dir) + path.sep)).toBe(true);
    expect(file.endsWith('safe-id-1.md')).toBe(true);
  });

  it('runConnector end-to-end: a page with a path-traversal id writes safely inside the dir', async () => {
    process.env.CONFLUENCE_BASE_URL = 'https://acme.atlassian.net/wiki';
    process.env.CONFLUENCE_EMAIL = 'bot@acme.com';
    process.env.CONFLUENCE_API_TOKEN = 'tok';
    process.env.CONFLUENCE_PAGE_IDS = 'irrelevant-because-fetch-is-stubbed';

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'confluence-pathsafe-'));
    try {
      const fetchImpl = makeFetch((url) => {
        if (url.includes('/pages/')) {
          return {
            body: {
              id: '../../../../etc/passwd',
              title: 'Hostile',
              body: { storage: { value: '<p>hostile body</p>' } },
            },
          };
        }
        return { body: { results: [] } };
      });
      const res = await runConnector(
        { ...confluenceConnector, syncInterval: 0 },
        { fetchImpl, dir, now: () => '2026-06-01T00:00:00.000Z' },
      );
      expect(res.upserted).toBe(1);
      const files = fs.readdirSync(dir);
      for (const f of files) {
        expect(f).not.toContain('..');
        expect(f).not.toContain('/');
      }
      // Nothing was written above/outside the scratch dir.
      expect(fs.existsSync(path.join(dir, '..', 'passwd'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
