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

const configMock = vi.hoisted(() => ({
  GOOGLE_DRIVE_FOLDER_IDS: [] as string[],
  CONNECTOR_SYNC_INTERVAL_MS: 1800000,
  GROUPS_DIR: '',
  SHARED_KB_GROUP: 'slack_main',
}));

vi.mock('../../config.js', () => configMock);

// readEnvFile is stubbed; individual tests override its return value so the
// creds-path resolver points at a temp file (no real Google creds needed).
const readEnvFileMock = vi.hoisted(() =>
  vi.fn(() => ({}) as Record<string, string>),
);
vi.mock('../../env.js', () => ({ readEnvFile: readEnvFileMock }));

// In-memory router_state so runConnector's cursor plumbing works without a
// real DB (unused by google-drive.ts's own sync logic post-Fix-4, but
// base.ts's runConnector() still reads/writes it as framework infra).
const routerState = vi.hoisted(() => new Map<string, string>());
vi.mock('../../db.js', () => ({
  getRouterState: (k: string) => routerState.get(k),
  setRouterState: (k: string, v: string) => {
    routerState.set(k, v);
  },
}));

// Import AFTER the mocks are wired.
import {
  googleDocToMarkdown,
  driveFileToConnectorDoc,
  loadGoogleAccessToken,
  GoogleDriveError,
  googleDriveConnector,
  getGoogleDriveDefaultVisibility,
  type DocsDocument,
} from './google-drive.js';
import { runConnector } from './base.js';
import type { ConnectorContext } from './base.js';

// --- Helpers ---

/** Build a minimal ConnectorContext with a stubbed cursor + fetch. */
function makeCtx(over?: Partial<ConnectorContext>): {
  ctx: ConnectorContext;
  cursorValue: () => string | undefined;
} {
  let cursor: string | undefined;
  const ctx: ConnectorContext = {
    getCursor: () => cursor,
    setCursor: (v: string) => {
      cursor = v;
    },
    fetchImpl: vi.fn() as unknown as typeof fetch,
    syncStart: '2026-06-01T00:00:00Z',
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as ConnectorContext['logger'],
    ...over,
  };
  return { ctx, cursorValue: () => cursor };
}

/** A Docs API response helper for a text/heading/bullet document. */
function makeDocsDoc(over?: Partial<DocsDocument>): DocsDocument {
  return {
    title: 'Sample',
    body: {
      content: [
        {
          paragraph: {
            paragraphStyle: { namedStyleType: 'TITLE' },
            elements: [{ textRun: { content: 'Big Title\n' } }],
          },
        },
        {
          paragraph: {
            paragraphStyle: { namedStyleType: 'HEADING_2' },
            elements: [{ textRun: { content: 'Section\n' } }],
          },
        },
        {
          paragraph: {
            paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
            elements: [
              { textRun: { content: 'Plain ' } },
              { textRun: { content: 'bold', textStyle: { bold: true } } },
              { textRun: { content: ' and ' } },
              { textRun: { content: 'italic', textStyle: { italic: true } } },
              {
                textRun: {
                  content: ' link',
                  textStyle: { link: { url: 'https://example.com' } },
                },
              },
              { textRun: { content: '\n' } },
            ],
          },
        },
        {
          paragraph: {
            bullet: { listId: 'l1' },
            elements: [{ textRun: { content: 'first item\n' } }],
          },
        },
        {
          paragraph: {
            bullet: { listId: 'l1', nestingLevel: 1 },
            elements: [{ textRun: { content: 'nested item\n' } }],
          },
        },
        // Unknown structural element — must be skipped without throwing.
        { table: undefined, paragraph: undefined } as never,
      ],
    },
    ...over,
  };
}

/** A JSON-returning fetch Response stub. */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// --- googleDocToMarkdown ---

describe('googleDocToMarkdown', () => {
  it('converts headings, inline styles, links, and nested bullets', () => {
    const md = googleDocToMarkdown(makeDocsDoc());
    expect(md).toContain('# Big Title');
    expect(md).toContain('## Section');
    expect(md).toContain(
      'Plain **bold** and *italic* [link](https://example.com)',
    );
    expect(md).toContain('- first item');
    expect(md).toContain('  - nested item');
  });

  it('maps every named heading style to the right heading level', () => {
    const md = googleDocToMarkdown({
      body: {
        content: [
          {
            paragraph: {
              paragraphStyle: { namedStyleType: 'HEADING_1' },
              elements: [{ textRun: { content: 'H1\n' } }],
            },
          },
          {
            paragraph: {
              paragraphStyle: { namedStyleType: 'HEADING_3' },
              elements: [{ textRun: { content: 'H3\n' } }],
            },
          },
        ],
      },
    });
    expect(md).toContain('# H1');
    expect(md).toContain('### H3');
  });

  it('skips empty paragraphs and unknown elements without throwing', () => {
    const md = googleDocToMarkdown({
      body: {
        content: [
          { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
          {} as never,
          { sectionBreak: {} } as never,
          { paragraph: { elements: [{ textRun: { content: 'kept\n' } }] } },
        ],
      },
    });
    expect(md).toBe('kept');
  });

  it('returns empty string for an empty document', () => {
    expect(googleDocToMarkdown({})).toBe('');
    expect(googleDocToMarkdown({ body: { content: [] } })).toBe('');
  });

  // --- stored-XSS defense: escape raw HTML in untrusted run content ---

  it('escapes literal HTML in a run so a markdown renderer emits inert text', () => {
    const md = googleDocToMarkdown({
      body: {
        content: [
          {
            paragraph: {
              elements: [
                { textRun: { content: '<img src=x onerror=alert(1)>\n' } },
              ],
            },
          },
        ],
      },
    });
    expect(md).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes stray angle brackets and ampersands mixed with normal text', () => {
    const md = googleDocToMarkdown({
      body: {
        content: [
          {
            paragraph: { elements: [{ textRun: { content: 'a<b && c>d\n' } }] },
          },
        ],
      },
    });
    expect(md).toBe('a&lt;b &amp;&amp; c&gt;d');
  });

  it('escapes source text even when bold/linked, without escaping our own markdown markers', () => {
    const md = googleDocToMarkdown({
      body: {
        content: [
          {
            paragraph: {
              elements: [
                {
                  textRun: {
                    content: '<script>bad</script>',
                    textStyle: { bold: true, link: { url: 'https://x.com' } },
                  },
                },
              ],
            },
          },
        ],
      },
    });
    expect(md).toBe('[**&lt;script&gt;bad&lt;/script&gt;**](https://x.com)');
  });

  it('normal text round-trips unescaped', () => {
    const md = googleDocToMarkdown({
      body: {
        content: [
          {
            paragraph: {
              elements: [
                { textRun: { content: 'plain safe text, 100% fine\n' } },
              ],
            },
          },
        ],
      },
    });
    expect(md).toBe('plain safe text, 100% fine');
  });
});

// --- driveFileToConnectorDoc mapping ---

describe('driveFileToConnectorDoc', () => {
  it('maps id/title/sourceUrl(webViewLink)/updatedAt/extraFrontmatter', () => {
    const file = {
      id: 'DOC123',
      name: 'Meeting Notes',
      modifiedTime: '2026-05-20T12:00:00Z',
      webViewLink: 'https://docs.google.com/document/d/DOC123/edit',
    };
    const doc = driveFileToConnectorDoc(file, 'FOLDER_A', '# hello');
    expect(doc.id).toBe('DOC123');
    expect(doc.title).toBe('Meeting Notes');
    expect(doc.sourceUrl).toBe(
      'https://docs.google.com/document/d/DOC123/edit',
    );
    expect(doc.markdown).toBe('# hello');
    expect(doc.updatedAt).toBe('2026-05-20T12:00:00Z');
    expect(doc.extraFrontmatter).toEqual({
      drive_id: 'DOC123',
      drive_folder: 'FOLDER_A',
    });
  });

  it('falls back to a docs URL when webViewLink is missing', () => {
    const doc = driveFileToConnectorDoc({ id: 'X9', name: '' }, 'F1', '');
    expect(doc.title).toBe('(untitled)');
    expect(doc.sourceUrl).toBe('https://docs.google.com/document/d/X9/edit');
  });

  it('defaults synced docs to a non-open visibility', () => {
    const doc = driveFileToConnectorDoc({ id: 'X9', name: 'n' }, 'F1', '');
    expect(doc.visibility).toBe('restricted');
    expect(doc.visibility).not.toBe('open');
  });
});

// --- Default visibility (Fix 2: don't flatten upstream ACLs to open) ---

describe('getGoogleDriveDefaultVisibility', () => {
  afterEach(() => {
    delete process.env.GOOGLE_DRIVE_DEFAULT_VISIBILITY;
    readEnvFileMock.mockReturnValue({});
  });

  it('defaults to restricted when unset', () => {
    expect(getGoogleDriveDefaultVisibility()).toBe('restricted');
  });

  it('is overridable via GOOGLE_DRIVE_DEFAULT_VISIBILITY in .env', () => {
    readEnvFileMock.mockReturnValue({
      GOOGLE_DRIVE_DEFAULT_VISIBILITY: 'private',
    });
    expect(getGoogleDriveDefaultVisibility()).toBe('private');
  });

  it('process.env takes precedence over .env', () => {
    readEnvFileMock.mockReturnValue({
      GOOGLE_DRIVE_DEFAULT_VISIBILITY: 'private',
    });
    process.env.GOOGLE_DRIVE_DEFAULT_VISIBILITY = 'open';
    expect(getGoogleDriveDefaultVisibility()).toBe('open');
  });

  it('falls back to restricted on an unrecognized value (never silently widens access)', () => {
    readEnvFileMock.mockReturnValue({
      GOOGLE_DRIVE_DEFAULT_VISIBILITY: 'public', // not a valid KB visibility level
    });
    expect(getGoogleDriveDefaultVisibility()).toBe('restricted');
  });

  it('flows through to driveFileToConnectorDoc', () => {
    readEnvFileMock.mockReturnValue({
      GOOGLE_DRIVE_DEFAULT_VISIBILITY: 'private',
    });
    const doc = driveFileToConnectorDoc({ id: 'X9', name: 'n' }, 'F1', '');
    expect(doc.visibility).toBe('private');
  });
});

// --- loadGoogleAccessToken ---

describe('loadGoogleAccessToken', () => {
  it('returns a direct access_token without any fetch', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const token = await loadGoogleAccessToken(fetchImpl, () => ({
      access_token: 'ya29.direct',
    }));
    expect(token).toBe('ya29.direct');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('finds a token nested under a per-account key', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const token = await loadGoogleAccessToken(fetchImpl, () => ({
      'user@example.com': { tokens: { access_token: 'ya29.nested' } },
    }));
    expect(token).toBe('ya29.nested');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('mints a token from refresh material via the OAuth endpoint', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ access_token: 'ya29.minted', expires_in: 3600 }),
      ) as unknown as typeof fetch;
    const token = await loadGoogleAccessToken(fetchImpl, () => ({
      refresh_token: 'rt',
      client_id: 'cid',
      client_secret: 'secret',
    }));
    expect(token).toBe('ya29.minted');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect((init as { body: string }).body).toContain(
      'grant_type=refresh_token',
    );
  });

  it('refreshes when the direct access_token is expired', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ access_token: 'ya29.fresh' }),
      ) as unknown as typeof fetch;
    const token = await loadGoogleAccessToken(fetchImpl, () => ({
      access_token: 'ya29.stale',
      expiry: '2000-01-01T00:00:00Z',
      refresh_token: 'rt',
      client_id: 'cid',
      client_secret: 'secret',
    }));
    expect(token).toBe('ya29.fresh');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws GoogleDriveError (non-secret) on malformed creds', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      loadGoogleAccessToken(fetchImpl, () => ({ nothing: 'useful' })),
    ).rejects.toBeInstanceOf(GoogleDriveError);
    await expect(
      loadGoogleAccessToken(fetchImpl, () => ({ nothing: 'useful' })),
    ).rejects.toThrow(/no usable Google token material/i);
  });

  it('throws (non-secret) on an OAuth refresh HTTP failure and never leaks the secret', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: 'invalid_client' }, false, 401),
      ) as unknown as typeof fetch;
    const err = await loadGoogleAccessToken(fetchImpl, () => ({
      refresh_token: 'rt',
      client_id: 'cid',
      client_secret: 'super-secret-value',
    })).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleDriveError);
    expect(String(err.message)).not.toContain('super-secret-value');
  });
});

// --- sync incremental + complete flag ---

describe('googleDriveConnector.sync', () => {
  let credsPath: string;

  beforeEach(() => {
    configMock.GOOGLE_DRIVE_FOLDER_IDS = ['FOLDER_A'];
    // Write a temp gws-style creds file with a direct access token and point
    // the mocked readEnvFile at it (so resolveGoogleWorkspaceCredsPath finds
    // it) — no real Google creds required.
    credsPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'gdrive-creds-')),
      'creds.json',
    );
    fs.writeFileSync(credsPath, JSON.stringify({ access_token: 'ya29.test' }));
    readEnvFileMock.mockReturnValue({
      GOOGLE_WORKSPACE_CREDENTIALS_FILE: credsPath,
    });
  });

  afterEach(() => {
    fs.rmSync(path.dirname(credsPath), { recursive: true, force: true });
    readEnvFileMock.mockReturnValue({});
  });

  /**
   * Build a fetch stub that answers Google's endpoints from mocked payloads:
   *  - Drive docs listing -> the provided files
   *  - Drive subfolder listing -> none
   *  - Docs API get -> a simple document
   *  - OAuth token -> a minted token
   */
  function makeFetch(files: Array<Record<string, unknown>>) {
    return vi.fn(async (url: string) => {
      const u = String(url);
      if (u.startsWith('https://oauth2.googleapis.com/token')) {
        return jsonResponse({ access_token: 'ya29.x' });
      }
      if (u.startsWith('https://docs.googleapis.com/v1/documents')) {
        return jsonResponse(makeDocsDoc());
      }
      if (u.includes('mimeType%3D%27application%2Fvnd.google-apps.folder%27')) {
        return jsonResponse({ files: [] });
      }
      // Drive docs listing.
      return jsonResponse({ files });
    }) as unknown as typeof fetch;
  }

  it('pulls every doc every run and reports complete:true on a clean pull', async () => {
    const { ctx } = makeCtx({
      fetchImpl: makeFetch([
        {
          id: 'D1',
          name: 'Doc One',
          modifiedTime: '2026-05-10T00:00:00Z',
          webViewLink: 'https://docs.google.com/document/d/D1/edit',
        },
        {
          id: 'D2',
          name: 'Doc Two',
          modifiedTime: '2026-05-20T00:00:00Z',
          webViewLink: 'https://docs.google.com/document/d/D2/edit',
        },
      ]),
    });

    const res = await googleDriveConnector.sync(ctx);
    expect(res.complete).toBe(true);
    expect(res.docs.map((d) => d.id).sort()).toEqual(['D1', 'D2']);
  });

  it('repeated runs each re-export the full set again (no persisted cursor gates it)', async () => {
    const files = [
      {
        id: 'D1',
        name: 'Doc One',
        modifiedTime: '2026-05-10T00:00:00Z',
        webViewLink: 'https://docs.google.com/document/d/D1/edit',
      },
      {
        id: 'D2',
        name: 'Doc Two',
        modifiedTime: '2026-05-10T00:00:00Z', // same timestamp as D1
        webViewLink: 'https://docs.google.com/document/d/D2/edit',
      },
    ];
    const { ctx: ctx1 } = makeCtx({ fetchImpl: makeFetch(files) });
    const res1 = await googleDriveConnector.sync(ctx1);
    const { ctx: ctx2 } = makeCtx({ fetchImpl: makeFetch(files) });
    const res2 = await googleDriveConnector.sync(ctx2);
    expect(res1.complete).toBe(true);
    expect(res2.complete).toBe(true);
    // Fix 5 dissolved: both docs sync every run even though they share a
    // modifiedTime — there is no cursor boundary to drop one of them at.
    expect(res2.docs.map((d) => d.id).sort()).toEqual(['D1', 'D2']);
  });

  it('a per-file export failure forces complete:false and skips that file', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.startsWith('https://oauth2.googleapis.com/token')) {
        return jsonResponse({ access_token: 'ya29.x' });
      }
      if (u.includes('/documents/D2')) {
        // Non-auth failure for one doc -> skipped, run marked incomplete.
        return jsonResponse({ error: 'boom' }, false, 500);
      }
      if (u.startsWith('https://docs.googleapis.com/v1/documents')) {
        return jsonResponse(makeDocsDoc());
      }
      if (u.includes('mimeType%3D%27application%2Fvnd.google-apps.folder%27')) {
        return jsonResponse({ files: [] });
      }
      return jsonResponse({
        files: [
          { id: 'D1', name: 'Ok', modifiedTime: '2026-05-10T00:00:00Z' },
          { id: 'D2', name: 'Bad', modifiedTime: '2026-05-11T00:00:00Z' },
        ],
      });
    }) as unknown as typeof fetch;

    const { ctx } = makeCtx({ fetchImpl });
    const res = await googleDriveConnector.sync(ctx);
    expect(res.complete).toBe(false);
    expect(res.docs.map((d) => d.id)).toEqual(['D1']);
  });

  // --- Fix 3: a file whose export fails isn't skipped forever ---

  it('a file whose export fails this run is retried (and picked up) next run', async () => {
    let failD2 = true;
    const flakyFetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.startsWith('https://oauth2.googleapis.com/token')) {
        return jsonResponse({ access_token: 'ya29.x' });
      }
      if (u.includes('/documents/D2') && failD2) {
        return jsonResponse({ error: 'boom' }, false, 500);
      }
      if (u.startsWith('https://docs.googleapis.com/v1/documents')) {
        return jsonResponse(makeDocsDoc());
      }
      if (u.includes('mimeType%3D%27application%2Fvnd.google-apps.folder%27')) {
        return jsonResponse({ files: [] });
      }
      return jsonResponse({
        files: [
          { id: 'D1', name: 'Ok', modifiedTime: '2026-05-10T00:00:00Z' },
          { id: 'D2', name: 'Bad', modifiedTime: '2026-05-11T00:00:00Z' },
        ],
      });
    }) as unknown as typeof fetch;

    // Run 1: D2's export fails.
    const { ctx: ctx1 } = makeCtx({ fetchImpl: flakyFetch });
    const res1 = await googleDriveConnector.sync(ctx1);
    expect(res1.complete).toBe(false);
    expect(res1.docs.map((d) => d.id)).toEqual(['D1']);

    // Run 2: D2 succeeds — because there's no cursor to have advanced past
    // it, it's retried rather than skipped forever (the Fix 3 bug dissolved).
    failD2 = false;
    const { ctx: ctx2 } = makeCtx({ fetchImpl: flakyFetch });
    const res2 = await googleDriveConnector.sync(ctx2);
    expect(res2.complete).toBe(true);
    expect(res2.docs.map((d) => d.id).sort()).toEqual(['D1', 'D2']);
  });

  // --- Fix 4: deletions reconcile on every complete run, not just the first ---

  it('a doc removed upstream is deleted from the KB on a later run', async () => {
    const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdrive-reconcile-'));
    try {
      const filesRun1 = [
        {
          id: 'D1',
          name: 'Doc One',
          modifiedTime: '2026-05-10T00:00:00Z',
          webViewLink: 'https://docs.google.com/document/d/D1/edit',
        },
        {
          id: 'D2',
          name: 'Doc Two',
          modifiedTime: '2026-05-10T00:00:00Z',
          webViewLink: 'https://docs.google.com/document/d/D2/edit',
        },
      ];
      const { ctx: ctx1 } = makeCtx({ fetchImpl: makeFetch(filesRun1) });
      const run1 = await runConnector(
        { ...googleDriveConnector, syncInterval: 0 },
        {
          fetchImpl: ctx1.fetchImpl,
          dir: kbDir,
          now: () => '2026-05-10T01:00:00Z',
        },
      );
      expect(run1.upserted).toBe(2);
      expect(
        fs.readdirSync(kbDir).filter((f) => f.endsWith('.md')).sort(),
      ).toEqual(['D1.md', 'D2.md']);

      // Run 2 (later): D2 removed upstream — only D1 comes back.
      const { ctx: ctx2 } = makeCtx({ fetchImpl: makeFetch([filesRun1[0]]) });
      const run2 = await runConnector(
        { ...googleDriveConnector, syncInterval: 0 },
        {
          fetchImpl: ctx2.fetchImpl,
          dir: kbDir,
          now: () => '2026-05-10T02:00:00Z',
        },
      );
      // The SECOND complete run reconciles the deletion, proving reconcile
      // isn't a one-time-ever event gated on a persisted cursor.
      expect(run2.deleted).toBe(1);
      expect(fs.readdirSync(kbDir).filter((f) => f.endsWith('.md'))).toEqual([
        'D1.md',
      ]);
    } finally {
      fs.rmSync(kbDir, { recursive: true, force: true });
    }
  });

  it('propagates a fatal auth (401) error from the Drive listing', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.startsWith('https://oauth2.googleapis.com/token')) {
        return jsonResponse({ access_token: 'ya29.x' });
      }
      return jsonResponse({ error: 'unauthorized' }, false, 401);
    }) as unknown as typeof fetch;

    const { ctx } = makeCtx({ fetchImpl });
    await expect(googleDriveConnector.sync(ctx)).rejects.toBeInstanceOf(
      GoogleDriveError,
    );
  });
});

// --- isConfigured ---

describe('googleDriveConnector.isConfigured', () => {
  it('is false when no folder ids are configured', () => {
    configMock.GOOGLE_DRIVE_FOLDER_IDS = [];
    expect(googleDriveConnector.isConfigured()).toBe(false);
  });
});
