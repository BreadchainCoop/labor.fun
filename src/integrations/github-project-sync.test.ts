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
});
