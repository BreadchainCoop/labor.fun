import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// --- Mocks ---

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const configMock = vi.hoisted(() => ({
  GITHUB_PROJECT_SYNC_ORGS: [] as string[],
  GITHUB_PROJECT_SYNC_INTERVAL_MS: 0,
  GITHUB_PROJECT_HIDE_TITLE_PATTERNS: [] as string[],
  GITHUB_SYNC_ISSUE_DEPS: true,
  GROUPS_DIR: '',
  SHARED_KB_GROUP: 'slack_main',
}));

vi.mock('../config.js', () => configMock);

vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Import the modules under test AFTER the mocks are wired.
import { normalizeItem, normalizeProject } from './github-projects.js';
import {
  applySyncResult,
  itemFrontmatter,
  projectFrontmatter,
  runGitHubProjectSync,
  shouldHideProject,
} from './github-project-sync.js';

// --- Helpers ---

function makeRawProject(over?: Partial<any>): any {
  return {
    id: 'P_1',
    number: 7,
    title: 'Cool Project',
    url: 'https://github.com/orgs/Org/projects/7',
    closed: false,
    readme: 'Project goals',
    updatedAt: '2026-05-20T00:00:00Z',
    items: { nodes: [] },
    ...over,
  };
}

function makeIssueItem(over?: Partial<any>): any {
  return {
    id: 'I_abc',
    type: 'ISSUE',
    content: {
      __typename: 'Issue',
      number: 42,
      title: 'Fix the thing',
      url: 'https://github.com/Org/repo/issues/42',
      state: 'OPEN',
      body: 'Detailed body',
      createdAt: '2026-05-01T00:00:00Z',
      closedAt: null,
      repository: { nameWithOwner: 'Org/repo' },
      assignees: { nodes: [{ login: 'alice' }, { login: 'bob' }] },
      labels: { nodes: [{ name: 'bug' }, { name: 'p1' }] },
    },
    fieldValues: {
      nodes: [
        {
          __typename: 'ProjectV2ItemFieldSingleSelectValue',
          name: 'In Progress',
          field: { name: 'Status' },
        },
        {
          __typename: 'ProjectV2ItemFieldSingleSelectValue',
          name: 'High',
          field: { name: 'Priority' },
        },
        {
          __typename: 'ProjectV2ItemFieldDateValue',
          date: '2026-05-10',
          field: { name: 'Start date' },
        },
        {
          __typename: 'ProjectV2ItemFieldDateValue',
          date: '2026-05-25',
          field: { name: 'Target date' },
        },
      ],
    },
    ...over,
  };
}

// --- Normalization ---

describe('normalizeItem', () => {
  it('builds stable GH-<org>-<repo>-<number> id for issues', () => {
    const proj = makeRawProject();
    const raw = makeIssueItem();
    const norm = normalizeItem('Org', proj, raw)!;
    expect(norm.id).toBe('GH-Org-repo-42');
    expect(norm.itemType).toBe('Issue');
    expect(norm.repoNameWithOwner).toBe('Org/repo');
    expect(norm.issueNumber).toBe(42);
  });

  it('flattens custom fields into status/priority/start/end', () => {
    const norm = normalizeItem('Org', makeRawProject(), makeIssueItem())!;
    expect(norm.status).toBe('In Progress');
    expect(norm.priority).toBe('High');
    expect(norm.startDate).toBe('2026-05-10');
    expect(norm.endDate).toBe('2026-05-25');
  });

  it('falls back to issue state when there is no Status field', () => {
    const raw = makeIssueItem({
      fieldValues: { nodes: [] },
    });
    const norm = normalizeItem('Org', makeRawProject(), raw)!;
    expect(norm.status).toBe('open');
  });

  it('derives end_date from iteration window when no explicit end is set', () => {
    const raw = makeIssueItem({
      fieldValues: {
        nodes: [
          {
            __typename: 'ProjectV2ItemFieldIterationValue',
            title: 'Iter 3',
            startDate: '2026-05-12',
            duration: 14,
            field: { name: 'Iteration' },
          },
        ],
      },
    });
    const norm = normalizeItem('Org', makeRawProject(), raw)!;
    expect(norm.iteration).toBe('Iter 3');
    expect(norm.startDate).toBe('2026-05-12');
    expect(norm.endDate).toBe('2026-05-26');
  });

  it('maps blockedBy/blocking issue relations to upstream/downstream KB ids', () => {
    const raw = makeIssueItem({
      content: {
        ...makeIssueItem().content,
        blockedBy: {
          totalCount: 1,
          nodes: [{ number: 7, repository: { nameWithOwner: 'Org/repo' } }],
        },
        blocking: {
          totalCount: 1,
          nodes: [{ number: 9, repository: { nameWithOwner: 'Org/repo' } }],
        },
      },
    });
    const norm = normalizeItem('Org', makeRawProject(), raw)!;
    expect(norm.blockedBy).toEqual(['GH-Org-repo-7']);
    expect(norm.blocks).toEqual(['GH-Org-repo-9']);
  });

  it('derives edge ids from the TARGET repo (cross-repo / cross-org)', () => {
    const raw = makeIssueItem({
      content: {
        ...makeIssueItem().content,
        blockedBy: {
          totalCount: 2,
          nodes: [
            { number: 5, repository: { nameWithOwner: 'Org/other' } },
            { number: 3, repository: { nameWithOwner: 'OtherOrg/repo' } },
          ],
        },
      },
    });
    const norm = normalizeItem('Org', makeRawProject(), raw)!;
    expect(norm.blockedBy).toEqual(['GH-Org-other-5', 'GH-OtherOrg-repo-3']);
  });

  it('drops edges whose target repo is unreadable, and dedupes/self-refs', () => {
    const raw = makeIssueItem({
      content: {
        ...makeIssueItem().content,
        blockedBy: {
          totalCount: 3,
          nodes: [
            { number: 8 }, // no repository → dropped
            { number: 7, repository: { nameWithOwner: 'Org/repo' } },
            { number: 7, repository: { nameWithOwner: 'Org/repo' } }, // dup
            { number: 42, repository: { nameWithOwner: 'Org/repo' } }, // self
          ],
        },
      },
    });
    const norm = normalizeItem('Org', makeRawProject(), raw)!;
    expect(norm.blockedBy).toEqual(['GH-Org-repo-7']);
  });

  it('maps parent and subIssues hierarchy edges', () => {
    const raw = makeIssueItem({
      content: {
        ...makeIssueItem().content,
        parent: { number: 1, repository: { nameWithOwner: 'Org/repo' } },
        subIssues: {
          totalCount: 1,
          nodes: [{ number: 50, repository: { nameWithOwner: 'Org/repo' } }],
        },
      },
    });
    const norm = normalizeItem('Org', makeRawProject(), raw)!;
    expect(norm.parent).toBe('GH-Org-repo-1');
    expect(norm.subIssues).toEqual(['GH-Org-repo-50']);
  });

  it('defaults edges to empty/null when absent', () => {
    const norm = normalizeItem('Org', makeRawProject(), makeIssueItem())!;
    expect(norm.blockedBy).toEqual([]);
    expect(norm.blocks).toEqual([]);
    expect(norm.subIssues).toEqual([]);
    expect(norm.parent).toBeNull();
  });

  it('picks a numeric estimate from a custom number field (case-insensitive)', () => {
    const raw = makeIssueItem({
      fieldValues: {
        nodes: [
          {
            __typename: 'ProjectV2ItemFieldNumberValue',
            number: 5,
            field: { name: 'Story Points' },
          },
        ],
      },
    });
    const norm = normalizeItem('Org', makeRawProject(), raw)!;
    expect(norm.estimate).toBe(5);
  });

  it('returns null for REDACTED items (private repos the PAT cannot see)', () => {
    const raw = {
      id: 'X',
      type: 'REDACTED',
      content: null,
      fieldValues: { nodes: [] },
    };
    expect(normalizeItem('Org', makeRawProject(), raw as any)).toBeNull();
  });

  it('namespaces draft items with GHD- to avoid colliding with issues', () => {
    const raw = {
      id: 'PVTI_x_abc999',
      type: 'DRAFT_ISSUE',
      content: {
        __typename: 'DraftIssue',
        title: 'Note to self',
        body: '',
        assignees: { nodes: [] },
      },
      fieldValues: { nodes: [] },
    };
    const norm = normalizeItem(
      'Org',
      makeRawProject({ number: 7 }),
      raw as any,
    )!;
    expect(norm.id.startsWith('GHD-Org-7-')).toBe(true);
    expect(norm.itemType).toBe('DraftIssue');
  });
});

describe('normalizeProject', () => {
  it('builds GHP-<org>-<number> id', () => {
    const proj = normalizeProject('Org', makeRawProject({ number: 9 }));
    expect(proj.id).toBe('GHP-Org-9');
  });
});

// --- Frontmatter shape (the contract /projects relies on) ---

describe('frontmatter shape', () => {
  it('item frontmatter matches the /projects-page contract', () => {
    const norm = normalizeItem('Org', makeRawProject(), makeIssueItem())!;
    const fm = itemFrontmatter(norm, '2026-05-20T10:00:00Z');
    expect(fm.id).toBe('GH-Org-repo-42');
    expect(fm.status).toBe('In Progress');
    expect(fm.priority).toBe('High');
    expect(fm.owners).toEqual(['alice', 'bob']);
    expect(fm.project).toBe('Cool Project');
    expect(fm.start_date).toBe('2026-05-10');
    expect(fm.end_date).toBe('2026-05-25');
    expect(fm.tags).toContain('gh-synced');
    expect(fm.tags).toContain('bug');
    expect(fm.gh_synced_at).toBe('2026-05-20T10:00:00Z');
    expect(fm.gh_url).toBe('https://github.com/Org/repo/issues/42');
  });

  it('emits dependency edges as upstream/downstream + estimate (#31)', () => {
    const raw = makeIssueItem({
      content: {
        ...makeIssueItem().content,
        blockedBy: {
          totalCount: 1,
          nodes: [{ number: 7, repository: { nameWithOwner: 'Org/repo' } }],
        },
        blocking: {
          totalCount: 1,
          nodes: [{ number: 9, repository: { nameWithOwner: 'Org/repo' } }],
        },
        parent: { number: 1, repository: { nameWithOwner: 'Org/repo' } },
      },
      fieldValues: {
        nodes: [
          {
            __typename: 'ProjectV2ItemFieldNumberValue',
            number: 3,
            field: { name: 'Estimate' },
          },
        ],
      },
    });
    const fm = itemFrontmatter(
      normalizeItem('Org', makeRawProject(), raw)!,
      '2026-05-20T10:00:00Z',
    );
    expect(fm.upstream).toEqual(['GH-Org-repo-7']);
    expect(fm.downstream).toEqual(['GH-Org-repo-9']);
    expect(fm.estimate).toBe(3);
    expect(fm.gh_parent).toBe('GH-Org-repo-1');
  });

  it('emits empty edge arrays when there are no dependencies', () => {
    const fm = itemFrontmatter(
      normalizeItem('Org', makeRawProject(), makeIssueItem())!,
      '2026-05-20T10:00:00Z',
    );
    expect(fm.upstream).toEqual([]);
    expect(fm.downstream).toEqual([]);
    expect(fm.estimate).toBe('');
  });

  it('project frontmatter marks closed projects correctly', () => {
    const proj = normalizeProject('Org', makeRawProject({ closed: true }));
    const fm = projectFrontmatter(proj, '2026-05-20T10:00:00Z');
    expect(fm.status).toBe('closed');
  });
});

// --- applySyncResult writes files to a temp dir ---

describe('applySyncResult', () => {
  let tmpRoot: string;
  let tasksDir: string;
  let projectsDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-sync-test-'));
    tasksDir = path.join(tmpRoot, 'tasks');
    projectsDir = path.join(tmpRoot, 'projects');
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writes one project file and one item file', () => {
    const proj = makeRawProject();
    const item = makeIssueItem();
    const result = {
      org: 'Org',
      projects: [normalizeProject('Org', proj)],
      items: [normalizeItem('Org', proj, item)!],
      complete: true,
    };
    const stats = applySyncResult(result, '2026-05-20T10:00:00Z', {
      tasksDir,
      projectsDir,
    });
    expect(stats.projectsWritten).toBe(1);
    expect(stats.itemsWritten).toBe(1);
    const projFile = path.join(projectsDir, 'GHP-Org-7.md');
    const itemFile = path.join(tasksDir, 'GH-Org-repo-42.md');
    expect(fs.existsSync(projFile)).toBe(true);
    expect(fs.existsSync(itemFile)).toBe(true);
    const itemContent = fs.readFileSync(itemFile, 'utf-8');
    expect(itemContent).toMatch(/^---/);
    expect(itemContent).toContain('id: GH-Org-repo-42');
    expect(itemContent).toContain('status: "In Progress"');
    expect(itemContent).toContain(
      'gh_url: https://github.com/Org/repo/issues/42',
    );
    expect(itemContent).toContain('Detailed body');
  });
});

// --- Hide-list filtering ---

describe('shouldHideProject', () => {
  it('skips empty / missing titles', () => {
    expect(shouldHideProject(undefined, ['untitled'])).toBe(true);
    expect(shouldHideProject('', ['untitled'])).toBe(true);
    expect(shouldHideProject('   ', ['untitled'])).toBe(true);
  });

  it("matches case-insensitive substring (covers @user's untitled project)", () => {
    expect(
      shouldHideProject("@RonTuretzky's untitled project", ['untitled']),
    ).toBe(true);
    expect(
      shouldHideProject("@subject026's untitled template", ['untitled']),
    ).toBe(true);
    expect(shouldHideProject('UNTITLED', ['untitled'])).toBe(true);
  });

  it('matches Breadchain Micro / Breadchain Macro', () => {
    expect(shouldHideProject('Breadchain Micro', ['micro', 'macro'])).toBe(
      true,
    );
    expect(shouldHideProject('Breadchain Macro', ['micro', 'macro'])).toBe(
      true,
    );
  });

  it('does not hide unrelated titles', () => {
    const patterns = ['untitled', 'micro', 'macro'];
    expect(shouldHideProject('Gas Killer', patterns)).toBe(false);
    expect(shouldHideProject('Crowdstake.fun', patterns)).toBe(false);
    expect(shouldHideProject('Stacks', patterns)).toBe(false);
  });

  it('empty patterns list keeps everything (except empty titles)', () => {
    expect(shouldHideProject('Anything', [])).toBe(false);
    expect(shouldHideProject('', [])).toBe(true);
  });
});

describe('applySyncResult hide + body link', () => {
  let tmpRoot: string;
  let tasksDir: string;
  let projectsDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-sync-test-'));
    tasksDir = path.join(tmpRoot, 'tasks');
    projectsDir = path.join(tmpRoot, 'projects');
    configMock.GITHUB_PROJECT_HIDE_TITLE_PATTERNS = ['untitled', 'micro'];
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    configMock.GITHUB_PROJECT_HIDE_TITLE_PATTERNS = [];
  });

  it('skips hidden projects AND their items; keeps untouched ones', () => {
    const keepRaw = makeRawProject({ number: 1, title: 'Gas Killer' });
    const hideRaw = makeRawProject({
      number: 2,
      title: "@user's untitled project",
    });
    const keepItem = normalizeItem('Org', keepRaw, makeIssueItem())!;
    const hiddenItem = {
      ...normalizeItem('Org', keepRaw, makeIssueItem({ id: 'I_other' }))!,
      id: 'GH-Org-other-99',
      projectTitle: "@user's untitled project",
    };
    const result = {
      org: 'Org',
      projects: [
        normalizeProject('Org', keepRaw),
        normalizeProject('Org', hideRaw),
      ],
      items: [keepItem, hiddenItem],
      complete: true,
    };
    const stats = applySyncResult(result, '2026-05-20T10:00:00Z', {
      tasksDir,
      projectsDir,
    });
    expect(stats.projectsWritten).toBe(1);
    expect(stats.projectsHidden).toBe(1);
    expect(stats.itemsWritten).toBe(1);
    expect(stats.itemsHidden).toBe(1);
    expect(fs.existsSync(path.join(projectsDir, 'GHP-Org-1.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectsDir, 'GHP-Org-2.md'))).toBe(false);
  });

  it("prepends a 'View on GitHub' link to the item body", () => {
    configMock.GITHUB_PROJECT_HIDE_TITLE_PATTERNS = [];
    const result = {
      org: 'Org',
      projects: [],
      items: [normalizeItem('Org', makeRawProject(), makeIssueItem())!],
      complete: true,
    };
    applySyncResult(result, '2026-05-20T10:00:00Z', { tasksDir, projectsDir });
    const body = fs.readFileSync(
      path.join(tasksDir, 'GH-Org-repo-42.md'),
      'utf-8',
    );
    expect(body).toContain(
      '[View on GitHub](https://github.com/Org/repo/issues/42)',
    );
    expect(body).toContain('Detailed body');
  });
});

// --- runGitHubProjectSync end-to-end with reconcile ---

describe('runGitHubProjectSync reconcile', () => {
  let tmpRoot: string;
  let tasksDir: string;
  let projectsDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-sync-test-'));
    configMock.GROUPS_DIR = tmpRoot;
    fs.mkdirSync(path.join(tmpRoot, 'slack_main', 'context'), {
      recursive: true,
    });
    tasksDir = path.join(tmpRoot, 'slack_main', 'context', 'tasks');
    projectsDir = path.join(tmpRoot, 'slack_main', 'context', 'projects');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.mkdirSync(projectsDir, { recursive: true });
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN = 'test-token';
    configMock.GITHUB_PROJECT_SYNC_ORGS = ['Org'];
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    configMock.GITHUB_PROJECT_SYNC_ORGS = [];
  });

  it('deletes a stale GH item that was not present in the latest sync', async () => {
    // Pre-seed a stale item from a previous sync.
    const stalePath = path.join(tasksDir, 'GH-Org-repo-99.md');
    fs.writeFileSync(
      stalePath,
      `---\nid: GH-Org-repo-99\ngh_synced_at: 2024-01-01T00:00:00Z\n---\nold\n`,
    );
    // Pre-seed a hand-authored TASK that must never be touched.
    const handPath = path.join(tasksDir, 'TASK-001.md');
    fs.writeFileSync(handPath, `---\nid: TASK-001\n---\nhandwritten\n`);

    // Fake fetch returns one project, one item (not the stale one).
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          organization: {
            projectsV2: {
              nodes: [
                {
                  ...makeRawProject(),
                  items: { nodes: [makeIssueItem()] },
                },
              ],
            },
          },
        },
      }),
    });

    await runGitHubProjectSync(fakeFetch as unknown as typeof fetch);

    expect(fs.existsSync(stalePath)).toBe(false);
    expect(fs.existsSync(handPath)).toBe(true);
    expect(fs.existsSync(path.join(tasksDir, 'GH-Org-repo-42.md'))).toBe(true);
  });

  it('skips reconcile entirely if any org failed (avoids false deletes)', async () => {
    // Pre-seed a stale item.
    const stalePath = path.join(tasksDir, 'GH-Org-repo-99.md');
    fs.writeFileSync(
      stalePath,
      `---\nid: GH-Org-repo-99\ngh_synced_at: 2024-01-01T00:00:00Z\n---\nold\n`,
    );

    const fakeFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    });

    const stats = await runGitHubProjectSync(
      fakeFetch as unknown as typeof fetch,
    );

    expect(stats[0].error).toBeTruthy();
    // Stale file is preserved because the org failed.
    expect(fs.existsSync(stalePath)).toBe(true);
  });

  it('still reconciles a complete pull when pageInfo reports no further pages', async () => {
    const stalePath = path.join(tasksDir, 'GH-Org-repo-99.md');
    fs.writeFileSync(
      stalePath,
      `---\nid: GH-Org-repo-99\ngh_synced_at: 2024-01-01T00:00:00Z\n---\nold\n`,
    );

    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          organization: {
            projectsV2: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  ...makeRawProject(),
                  items: {
                    pageInfo: { hasNextPage: false },
                    nodes: [makeIssueItem()],
                  },
                },
              ],
            },
          },
        },
      }),
    });

    const stats = await runGitHubProjectSync(
      fakeFetch as unknown as typeof fetch,
    );

    expect(stats[0].incomplete).toBeUndefined();
    expect(stats[0].itemsDeleted).toBe(1);
    expect(fs.existsSync(stalePath)).toBe(false);
    expect(fs.existsSync(path.join(tasksDir, 'GH-Org-repo-42.md'))).toBe(true);
  });

  it('a truncated pull (hasNextPage) applies writes but never deletes (#112)', async () => {
    const stalePath = path.join(tasksDir, 'GH-Org-repo-99.md');
    fs.writeFileSync(
      stalePath,
      `---\nid: GH-Org-repo-99\ngh_synced_at: 2024-01-01T00:00:00Z\n---\nold\n`,
    );
    const staleProjPath = path.join(projectsDir, 'GHP-Org-99.md');
    fs.writeFileSync(
      staleProjPath,
      `---\nid: GHP-Org-99\ngh_synced_at: 2024-01-01T00:00:00Z\n---\nold\n`,
    );

    // Simulate a mid-pull failure/truncation: the item connection reports a
    // page we never fetched, so GH-Org-repo-99 may still exist upstream.
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          organization: {
            projectsV2: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  ...makeRawProject(),
                  items: {
                    pageInfo: { hasNextPage: true },
                    nodes: [makeIssueItem()],
                  },
                },
              ],
            },
          },
        },
      }),
    });

    const stats = await runGitHubProjectSync(
      fakeFetch as unknown as typeof fetch,
    );

    expect(stats[0].incomplete).toBe(true);
    expect(stats[0].itemsDeleted).toBe(0);
    expect(stats[0].projectsDeleted).toBe(0);
    // Additive write from the partial pull still landed.
    expect(stats[0].itemsWritten).toBe(1);
    expect(fs.existsSync(path.join(tasksDir, 'GH-Org-repo-42.md'))).toBe(true);
    // But nothing was deleted for the incomplete scope.
    expect(fs.existsSync(stalePath)).toBe(true);
    expect(fs.existsSync(staleProjPath)).toBe(true);
  });

  it('a truncated projects page also blocks the delete pass', async () => {
    const stalePath = path.join(projectsDir, 'GHP-Org-99.md');
    fs.writeFileSync(
      stalePath,
      `---\nid: GHP-Org-99\ngh_synced_at: 2024-01-01T00:00:00Z\n---\nold\n`,
    );

    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          organization: {
            projectsV2: {
              pageInfo: { hasNextPage: true },
              nodes: [
                { ...makeRawProject(), items: { nodes: [makeIssueItem()] } },
              ],
            },
          },
        },
      }),
    });

    const stats = await runGitHubProjectSync(
      fakeFetch as unknown as typeof fetch,
    );

    expect(stats[0].incomplete).toBe(true);
    expect(fs.existsSync(stalePath)).toBe(true);
  });

  it('checkpoints per org: a failed org keeps its files while a complete org reconciles', async () => {
    configMock.GITHUB_PROJECT_SYNC_ORGS = ['Org', 'BrokenOrg'];
    const staleOk = path.join(tasksDir, 'GH-Org-repo-99.md');
    fs.writeFileSync(
      staleOk,
      `---\nid: GH-Org-repo-99\ngh_synced_at: 2024-01-01T00:00:00Z\n---\nold\n`,
    );
    const staleBroken = path.join(tasksDir, 'GH-BrokenOrg-repo-99.md');
    fs.writeFileSync(
      staleBroken,
      `---\nid: GH-BrokenOrg-repo-99\ngh_synced_at: 2024-01-01T00:00:00Z\n---\nold\n`,
    );
    const staleBrokenProj = path.join(projectsDir, 'GHP-BrokenOrg-99.md');
    fs.writeFileSync(
      staleBrokenProj,
      `---\nid: GHP-BrokenOrg-99\ngh_synced_at: 2024-01-01T00:00:00Z\n---\nold\n`,
    );

    const fakeFetch = vi.fn(async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body);
      if (body.variables.org === 'BrokenOrg') {
        return { ok: false, status: 500, text: async () => 'mid-pull crash' };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            organization: {
              projectsV2: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  {
                    ...makeRawProject(),
                    items: {
                      pageInfo: { hasNextPage: false },
                      nodes: [makeIssueItem()],
                    },
                  },
                ],
              },
            },
          },
        }),
      };
    });

    const stats = await runGitHubProjectSync(
      fakeFetch as unknown as typeof fetch,
    );

    const okStat = stats.find((s) => s.org === 'Org')!;
    const brokenStat = stats.find((s) => s.org === 'BrokenOrg')!;
    expect(brokenStat.error).toBeTruthy();
    // The complete org's scope reconciled…
    expect(okStat.itemsDeleted).toBe(1);
    expect(fs.existsSync(staleOk)).toBe(false);
    expect(fs.existsSync(path.join(tasksDir, 'GH-Org-repo-42.md'))).toBe(true);
    // …the failed org's scope was untouched.
    expect(fs.existsSync(staleBroken)).toBe(true);
    expect(fs.existsSync(staleBrokenProj)).toBe(true);
  });

  it('a complete org never sweeps a hyphen-extending sibling org scope', async () => {
    // "Org" completes while "Org-Sub" fails. GH-Org-Sub-* files start with the
    // GH-Org- prefix, so without the sibling guard the complete Org sweep
    // would false-delete the failed sibling's stale files.
    configMock.GITHUB_PROJECT_SYNC_ORGS = ['Org', 'Org-Sub'];
    const staleOk = path.join(tasksDir, 'GH-Org-repo-99.md');
    fs.writeFileSync(
      staleOk,
      `---\nid: GH-Org-repo-99\ngh_synced_at: 2024-01-01T00:00:00Z\n---\nold\n`,
    );
    const staleSibling = path.join(tasksDir, 'GH-Org-Sub-repo-99.md');
    fs.writeFileSync(
      staleSibling,
      `---\nid: GH-Org-Sub-repo-99\ngh_synced_at: 2024-01-01T00:00:00Z\n---\nold\n`,
    );
    const staleSiblingProj = path.join(projectsDir, 'GHP-Org-Sub-99.md');
    fs.writeFileSync(
      staleSiblingProj,
      `---\nid: GHP-Org-Sub-99\ngh_synced_at: 2024-01-01T00:00:00Z\n---\nold\n`,
    );

    const fakeFetch = vi.fn(async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body);
      if (body.variables.org === 'Org-Sub') {
        return { ok: false, status: 500, text: async () => 'mid-pull crash' };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            organization: {
              projectsV2: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  {
                    ...makeRawProject(),
                    items: {
                      pageInfo: { hasNextPage: false },
                      nodes: [makeIssueItem()],
                    },
                  },
                ],
              },
            },
          },
        }),
      };
    });

    await runGitHubProjectSync(fakeFetch as unknown as typeof fetch);

    // Org's own stale file went…
    expect(fs.existsSync(staleOk)).toBe(false);
    // …but the failed sibling's files survived despite the shared prefix.
    expect(fs.existsSync(staleSibling)).toBe(true);
    expect(fs.existsSync(staleSiblingProj)).toBe(true);
  });
});
