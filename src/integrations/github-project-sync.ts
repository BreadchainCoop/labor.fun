/**
 * GitHub Projects V2 → KB sync engine.
 *
 * Writes synced project items as `<sharedKbDir>/tasks/<id>.md` and project
 * boards as `<sharedKbDir>/projects/<id>.md`, sharing the frontmatter shape
 * the existing `/projects` page reads (id, title, status, priority, owners,
 * project, tags, created_at, start_date, end_date) plus GitHub-specific
 * fields (gh_org, gh_url, gh_project_number, gh_item_type, gh_synced_at, ...).
 *
 * On each run, every written file is tagged with the current `gh_synced_at`
 * timestamp. After all configured orgs are pulled, files prefixed `GH-`,
 * `GHD-`, or `GHP-` whose `gh_synced_at` is older than the run start are
 * deleted — that's how we reconcile items removed from a project. The delete
 * pass is checkpointed per org (#112): it only covers orgs whose pull this
 * run was complete (no fetch error, no truncated page window).
 *
 * Hand-authored `TASK-NNN.md` / `PROJECT-*.md` files are never touched.
 */

import fs from 'fs';
import path from 'path';

import {
  GITHUB_PROJECT_HIDE_TITLE_PATTERNS,
  GITHUB_PROJECT_SYNC_INTERVAL_MS,
  GITHUB_PROJECT_SYNC_ORGS,
  GROUPS_DIR,
  SHARED_KB_GROUP,
} from '../config.js';
import { logger } from '../logger.js';
import {
  fetchOrgProjects,
  getGitHubToken,
  NormalizedProject,
  NormalizedProjectItem,
  OrgSyncResult,
  slug,
} from './github-projects.js';

const ITEM_ID_PREFIXES = ['GH-', 'GHD-'];
const PROJECT_ID_PREFIX = 'GHP-';

/**
 * Skip projects (and their items) whose title is empty/missing or contains
 * any configured hide-list pattern (case-insensitive substring match).
 */
export function shouldHideProject(
  title: string | undefined | null,
  patterns: string[] = GITHUB_PROJECT_HIDE_TITLE_PATTERNS,
): boolean {
  if (!title || !title.trim()) return true;
  const t = title.toLowerCase();
  return patterns.some((p) => t.includes(p));
}

export interface SyncStats {
  org: string;
  projectsWritten: number;
  itemsWritten: number;
  itemsDeleted: number;
  projectsDeleted: number;
  error?: string;
  /** Pull succeeded but was truncated (more pages upstream than fetched). */
  incomplete?: boolean;
}

/**
 * Quote a scalar value for YAML frontmatter. Strings are JSON-quoted when
 * they contain characters that would otherwise need escaping; arrays use
 * JSON-style flow sequences which YAML accepts.
 */
function yamlValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (Array.isArray(v))
    return '[' + v.map((x) => yamlValue(x)).join(', ') + ']';
  if (typeof v === 'object') return yamlValue(JSON.stringify(v));
  // string
  const s = String(v);
  if (/^[\w./@:+-]+$/.test(s) && !/^(yes|no|true|false|null|on|off)$/i.test(s))
    return s;
  return JSON.stringify(s);
}

function buildFrontmatter(record: Record<string, unknown>): string {
  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(record)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) {
      lines.push(`${k}: []`);
      continue;
    }
    lines.push(`${k}: ${yamlValue(v)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

export function itemFrontmatter(
  item: NormalizedProjectItem,
  syncedAt: string,
): Record<string, unknown> {
  // The frontmatter shape used by kb-ui /projects + the agent's KB rules.
  return {
    id: item.id,
    title: item.title,
    status: item.status ?? 'open',
    priority: item.priority ?? 'medium',
    owners: item.assignees,
    project: item.projectTitle,
    tags: ['gh-synced', ...item.labels],
    created_at: item.createdAt ?? '',
    start_date: item.startDate ?? '',
    end_date: item.endDate ?? '',
    // Dependency edges mapped onto the hand-authored task schema's keys so the
    // PM orchestrator sees one unified graph across synced + hand-authored
    // tasks (#31). upstream = "blocked by" (must finish first); downstream =
    // "blocks" (others depend on this). `estimate` surfaces a ProjectV2 number
    // field (Estimate / Story Points / ...).
    upstream: item.blockedBy,
    downstream: item.blocks,
    estimate: item.estimate ?? '',
    visibility: 'open',
    // GitHub-specific. Used by the upcoming kanban/swimlane/gantt views and
    // by the reconcile-on-stale deletion logic.
    gh_org: item.org,
    gh_project_number: item.projectNumber,
    gh_project_title: item.projectTitle,
    gh_url: item.url ?? '',
    gh_repo: item.repoNameWithOwner ?? '',
    gh_issue_number: item.issueNumber ?? '',
    gh_item_type: item.itemType,
    gh_state: item.state ?? '',
    gh_iteration: item.iteration ?? '',
    gh_iteration_start: item.iterationStartDate ?? '',
    gh_parent: item.parent ?? '',
    gh_sub_issues: item.subIssues,
    gh_synced_at: syncedAt,
  };
}

export function projectFrontmatter(
  proj: NormalizedProject,
  syncedAt: string,
): Record<string, unknown> {
  return {
    id: proj.id,
    title: proj.title,
    status: proj.closed ? 'closed' : 'active',
    owner: proj.org,
    created_at: proj.updatedAt,
    tags: ['gh-synced'],
    visibility: 'open',
    gh_org: proj.org,
    gh_project_number: proj.number,
    gh_url: proj.url,
    gh_synced_at: syncedAt,
  };
}

function writeMarkdown(
  filePath: string,
  frontmatter: Record<string, unknown>,
  body: string,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${buildFrontmatter(frontmatter)}\n\n${body}\n`);
  fs.renameSync(tmp, filePath);
}

/** Read the `gh_synced_at` value out of a markdown file's frontmatter. */
function readSyncedAt(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const match = content.match(/^gh_synced_at:\s*"?([^\n"]+)"?\s*$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function reconcile(dir: string, prefixes: string[], syncStart: string): number {
  if (!fs.existsSync(dir)) return 0;
  let deleted = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    if (!prefixes.some((p) => f.startsWith(p))) continue;
    const full = path.join(dir, f);
    const synced = readSyncedAt(full);
    if (synced && synced < syncStart) {
      try {
        fs.unlinkSync(full);
        deleted++;
        logger.info({ file: f }, 'GH sync: removed stale KB file');
      } catch (err) {
        logger.warn({ file: f, err }, 'GH sync: failed to remove stale file');
      }
    }
  }
  return deleted;
}

function resolveKbDirs(): { tasksDir: string; projectsDir: string } {
  const ctx = path.join(GROUPS_DIR, SHARED_KB_GROUP, 'context');
  return {
    tasksDir: path.join(ctx, 'tasks'),
    projectsDir: path.join(ctx, 'projects'),
  };
}

/**
 * Prepend a clickable GitHub link to the markdown body so /doc/tasks/<file>
 * (and any agent reading the file) gets a direct way to open the source.
 */
function bodyWithGhLink(
  url: string | null | undefined,
  body: string,
  label: string,
): string {
  const trimmed = (body || '').trim();
  if (!url) return trimmed ? `${trimmed}\n` : '';
  const header = `[${label}](${url})\n\n`;
  return trimmed ? `${header}${trimmed}\n` : header;
}

/** Write one normalized sync result to disk and report counts. */
export function applySyncResult(
  result: OrgSyncResult,
  syncedAt: string,
  dirs: { tasksDir: string; projectsDir: string } = resolveKbDirs(),
): {
  projectsWritten: number;
  itemsWritten: number;
  projectsHidden: number;
  itemsHidden: number;
} {
  let projectsWritten = 0;
  let itemsWritten = 0;
  let projectsHidden = 0;
  let itemsHidden = 0;
  const hiddenProjectTitles = new Set<string>();
  for (const proj of result.projects) {
    if (shouldHideProject(proj.title)) {
      hiddenProjectTitles.add(proj.title);
      projectsHidden++;
      continue;
    }
    const file = path.join(dirs.projectsDir, `${proj.id}.md`);
    writeMarkdown(
      file,
      projectFrontmatter(proj, syncedAt),
      bodyWithGhLink(proj.url, proj.readme, 'View board on GitHub'),
    );
    projectsWritten++;
  }
  for (const item of result.items) {
    if (hiddenProjectTitles.has(item.projectTitle)) {
      itemsHidden++;
      continue;
    }
    const file = path.join(dirs.tasksDir, `${item.id}.md`);
    writeMarkdown(
      file,
      itemFrontmatter(item, syncedAt),
      bodyWithGhLink(item.url, item.body, 'View on GitHub'),
    );
    itemsWritten++;
  }
  return { projectsWritten, itemsWritten, projectsHidden, itemsHidden };
}

export async function runGitHubProjectSync(
  fetchImpl: typeof fetch = fetch,
): Promise<SyncStats[]> {
  const token = getGitHubToken();
  if (!token) {
    logger.warn('GH sync: GITHUB_PERSONAL_ACCESS_TOKEN not set — skipping');
    return [];
  }
  if (GITHUB_PROJECT_SYNC_ORGS.length === 0) {
    logger.debug('GH sync: no orgs configured — skipping');
    return [];
  }

  const dirs = resolveKbDirs();
  const syncStart = new Date().toISOString();
  const stats: SyncStats[] = [];

  for (const org of GITHUB_PROJECT_SYNC_ORGS) {
    const orgStat: SyncStats = {
      org,
      projectsWritten: 0,
      itemsWritten: 0,
      itemsDeleted: 0,
      projectsDeleted: 0,
    };
    try {
      const result = await fetchOrgProjects(org, token, fetchImpl);
      // Additive writes always land — completeness only gates deletion below.
      const { projectsWritten, itemsWritten, projectsHidden, itemsHidden } =
        applySyncResult(result, syncStart, dirs);
      orgStat.projectsWritten = projectsWritten;
      orgStat.itemsWritten = itemsWritten;
      if (!result.complete) {
        orgStat.incomplete = true;
        logger.warn(
          { org },
          'GH sync: pull truncated — skipping reconcile for this org to avoid false deletes',
        );
      }
      logger.info(
        {
          org,
          projects: projectsWritten,
          items: itemsWritten,
          projectsHidden,
          itemsHidden,
        },
        'GH sync: org synced',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      orgStat.error = msg;
      logger.warn({ org, err: msg }, 'GH sync: org failed');
    }
    stats.push(orgStat);
  }

  // Reconcile, checkpointed per org (#112): the delete pass for a scope only
  // runs when that org's pull this run was COMPLETE — fetch succeeded and no
  // page was left unfetched. Deleting after a partial pull would wrongly
  // remove items that still exist upstream but weren't touched this run.
  // Completeness is an in-run flag, not persisted state: reconcile only ever
  // compares files against THIS run's syncStart, so a mid-run crash simply
  // means no delete pass happens (additive writes from earlier in the run are
  // still correct) — a cross-run checkpoint would add nothing.
  const complete = (s: SyncStats) => !s.error && !s.incomplete;
  if (stats.every(complete)) {
    // Every configured org pulled fully — sweep all GH-prefixed files, which
    // also cleans up files from orgs that were removed from the config.
    const itemsDeleted = reconcile(dirs.tasksDir, ITEM_ID_PREFIXES, syncStart);
    const projectsDeleted = reconcile(
      dirs.projectsDir,
      [PROJECT_ID_PREFIX],
      syncStart,
    );
    if (stats[0]) {
      stats[0].itemsDeleted = itemsDeleted;
      stats[0].projectsDeleted = projectsDeleted;
    }
  } else {
    logger.warn(
      { skipped: stats.filter((s) => !complete(s)).map((s) => s.org) },
      'GH sync: incomplete pulls — reconciling only fully-pulled orgs',
    );
    // Per-org checkpoint: files are namespaced GH-<org>-/GHD-<org>-/GHP-<org>-
    // (ids embed slug(org)), so a scoped prefix sweep is safe per org.
    for (const stat of stats) {
      if (!complete(stat)) continue;
      const orgSlug = slug(stat.org);
      stat.itemsDeleted = reconcile(
        dirs.tasksDir,
        ITEM_ID_PREFIXES.map((p) => `${p}${orgSlug}-`),
        syncStart,
      );
      stat.projectsDeleted = reconcile(
        dirs.projectsDir,
        [`${PROJECT_ID_PREFIX}${orgSlug}-`],
        syncStart,
      );
    }
  }

  return stats;
}

let loopRunning = false;
let loopTimer: NodeJS.Timeout | null = null;

export function startGitHubProjectSyncLoop(opts?: {
  intervalMs?: number;
}): void {
  if (loopRunning) {
    logger.debug('GH sync loop already running');
    return;
  }
  const interval = opts?.intervalMs ?? GITHUB_PROJECT_SYNC_INTERVAL_MS;
  if (interval <= 0) {
    logger.info('GH sync loop disabled (interval=0)');
    return;
  }
  if (GITHUB_PROJECT_SYNC_ORGS.length === 0) {
    logger.info('GH sync loop disabled (no orgs configured)');
    return;
  }
  loopRunning = true;

  const tick = async () => {
    try {
      const stats = await runGitHubProjectSync();
      logger.info(
        {
          orgs: stats.length,
          projects: stats.reduce((a, s) => a + s.projectsWritten, 0),
          items: stats.reduce((a, s) => a + s.itemsWritten, 0),
          itemsDeleted: stats.reduce((a, s) => a + s.itemsDeleted, 0),
        },
        'GH sync tick complete',
      );
    } catch (err) {
      logger.error({ err }, 'GH sync tick failed');
    }
  };

  logger.info(
    { intervalMs: interval, orgs: GITHUB_PROJECT_SYNC_ORGS },
    'GH project sync loop started',
  );
  // Fire one immediately on startup so the KB reflects current state without
  // waiting a full interval.
  void tick();
  loopTimer = setInterval(tick, interval);
  loopTimer.unref?.();
}

export function stopGitHubProjectSyncLoop(): void {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
  loopRunning = false;
}
