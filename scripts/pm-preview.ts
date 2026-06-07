#!/usr/bin/env tsx
/**
 * Read-only PM-orchestration preview, scoped to the crowdstake.fun project.
 *
 * Usage:   npm run pm-preview
 *          (or: tsx scripts/pm-preview.ts [projectFilter])
 *
 * Fetches live GitHub Projects data for the configured org(s) using the NEW
 * dependency-edge sync code (`fetchOrgProjects` — pulls blocked-by/blocking +
 * sub-issue + estimate), filters to the crowdstake.fun project/repo, runs the
 * deterministic PM pre-pass, and prints the brief + who-I'd-DM list.
 *
 * Side-effect-free: it does NOT write the KB, enqueue an agent run, send any
 * DM, or spend API credits. It only reads GitHub. This is how you validate the
 * PM feature (#31) against real crowdstake data before turning the loop on.
 *
 * Env: GITHUB_PERSONAL_ACCESS_TOKEN (read access to the org's Projects/issues),
 * GITHUB_PROJECT_SYNC_ORGS (which org[s] to fetch), PM_DUE_SOON_DAYS. Read from
 * process.env first, then the standard .env path.
 */

import { GITHUB_PROJECT_SYNC_ORGS, PM_DUE_SOON_DAYS } from '../src/config.js';
import {
  fetchOrgProjects,
  getGitHubToken,
  type NormalizedProjectItem,
} from '../src/integrations/github-projects.js';
import {
  buildPmBrief,
  classify,
  dmCandidates,
  type PmTask,
} from '../src/pm-orchestration.js';

const DAY_MS = 86_400_000;

/** Default scope: anything whose project title / repo / id mentions crowdstake. */
const projectFilter = (process.argv[2] || 'crowdstake').toLowerCase();

function matchesFilter(item: NormalizedProjectItem): boolean {
  const hay = [
    item.projectTitle,
    item.repoNameWithOwner ?? '',
    item.id,
  ]
    .join(' ')
    .toLowerCase();
  return hay.includes(projectFilter);
}

function toPmTask(item: NormalizedProjectItem): PmTask {
  return {
    id: item.id,
    title: item.title,
    deadline: item.endDate ?? undefined,
    owners: item.assignees,
    status: item.status ?? undefined,
    estimate: item.estimate != null ? String(item.estimate) : undefined,
    upstream: item.blockedBy,
    downstream: item.blocks,
    ref: item.url ?? undefined,
  };
}

async function main(): Promise<void> {
  const token = getGitHubToken();
  if (!token) {
    console.error('GITHUB_PERSONAL_ACCESS_TOKEN not set — cannot fetch GitHub.');
    process.exit(1);
  }
  if (GITHUB_PROJECT_SYNC_ORGS.length === 0) {
    console.error('GITHUB_PROJECT_SYNC_ORGS not set — nothing to fetch.');
    process.exit(1);
  }

  // Fetch every configured org (live, read-only) using the new edge-aware sync.
  const allItems: NormalizedProjectItem[] = [];
  for (const org of GITHUB_PROJECT_SYNC_ORGS) {
    const res = await fetchOrgProjects(org, token);
    allItems.push(...res.items);
  }

  const scoped = allItems.filter(matchesFilter);
  const tasks = scoped.map(toPmTask);
  const nowMs = Date.now();
  const c = classify(tasks, nowMs, PM_DUE_SOON_DAYS * DAY_MS);
  const candidates = dmCandidates(c);

  const withEdges = tasks.filter(
    (t) => t.upstream.length > 0 || t.downstream.length > 0,
  ).length;
  const withEstimate = tasks.filter((t) => t.estimate).length;
  const withDeadline = tasks.filter((t) => t.deadline).length;

  console.log(`\n=== PM preview — filter: "${projectFilter}" ===`);
  console.log(`items matched:   ${tasks.length}`);
  console.log(`  with deadline: ${withDeadline}`);
  console.log(`  with edges:    ${withEdges} (blocked-by/blocking)`);
  console.log(`  with estimate: ${withEstimate}`);
  console.log(
    `classified:      blocked=${c.blocked.length} blocking=${c.blocking.length} overdue=${c.overdue.length} dueSoon=${c.dueSoon.length}`,
  );
  console.log(`DM candidates:   ${candidates.length}`);
  console.log('\n--- BRIEF (what the agent would receive) ---\n');
  console.log(buildPmBrief(c, candidates, [], nowMs));
  console.log('\n--- END (no DMs sent, no KB written, no agent run) ---');
}

main().catch((err) => {
  console.error('pm-preview failed:', err);
  process.exit(1);
});
