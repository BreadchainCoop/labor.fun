/**
 * mirror.mjs — the DOWN leg: chain → KB.
 *
 * Shaped after src/integrations/github-project-sync.ts (prefixed ids, atomic
 * tmp+rename, a delete pass that only runs on a complete successful pull) and
 * src/safe/payout.ts (a PURE planner that decides what should happen, and an
 * I/O function that only carries it out). The pure half is where the tests
 * live.
 *
 * THE FILE IS THE STATE. There is no mirror table. Each POP-*.md carries its
 * own `pop_digest`, so the KB is self-describing, survives a DB restore, and
 * Phase 1 adds no schema at all. (Phase 3's intent ledger DOES need a table —
 * that is a different concern and gets one then.)
 *
 * ABSENCE IS NOT DELETION. The subgraph is documented to fall 30+ task ids
 * behind chain, and the task query has hard caps (50 projects, 1000 tasks per
 * project). So a task vanishing from one `task list` is far more likely to be
 * lag than a real removal. We therefore TOMBSTONE: a file that goes unseen
 * increments `pop_missing_ticks` and is only removed once it has been missing
 * for `missingTicksBeforeDelete` consecutive COMPLETE pulls. Seeing it again
 * resets the counter. github-project-sync gets to delete on the first miss
 * because the GitHub API is authoritative and immediate; a lagging indexer is
 * not.
 *
 * THIS MODULE CANNOT WRITE TO THE CHAIN. It imports nothing that can — see
 * the structural test in __tests__. The up leg is an explicit intent queue,
 * never a diff, which is what makes echo loops impossible by construction.
 */

import fs from 'fs';
import path from 'path';

import matter from 'gray-matter';

import { listDigest, viewDigest } from './digest.mjs';
import {
  buildPopFrontmatter,
  mergePopFrontmatter,
  popTaskSlug,
  renderBody,
  renderDoc,
  renderManagedBody,
  splitBody,
} from './frontmatter.mjs';
import { buildMemberIndex, buildPeopleIndex, resolveOwners } from './identity.mjs';
import { isTerminalPopStatus } from './statusmap.mjs';

/** Consecutive complete pulls a task must be missing before we remove it. */
export const DEFAULT_MISSING_TICKS = 3;

/**
 * The hard caps baked into the CLI's task query. Verified verbatim in the
 * bundled package (node_modules/@poa-box/cli/dist/queries/task.js):
 *
 *   projects(where: { deleted: false }, first: 50) {
 *     tasks(first: 1000, orderBy: taskId, orderDirection: desc) {
 *
 * There is NO pagination and NO truncation signal — a capped response is
 * byte-indistinguishable from a complete one. So we infer it.
 */
export const PROJECT_CAP = 50;
export const TASKS_PER_PROJECT_CAP = 1000;

/**
 * Could this listing have been truncated by the query caps?
 *
 * Conservative by construction: hitting a cap EXACTLY is treated as "possibly
 * truncated" even though it might be an exact fit, because the cost of being
 * wrong is asymmetric. A false "truncated" costs one deferred delete pass; a
 * false "complete" silently deletes live tasks and the human notes attached to
 * them.
 *
 * Note the task cap orders `taskId desc`, so truncation drops the OLDEST tasks
 * in a project — which is precisely the archive we are asked to mirror.
 */
export function detectTruncation(rows) {
  const perProject = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String(row?.Project ?? '');
    perProject.set(key, (perProject.get(key) || 0) + 1);
  }
  const projectCount = perProject.size;
  const maxTasks = perProject.size ? Math.max(...perProject.values()) : 0;
  const atProjectCap = projectCount >= PROJECT_CAP;
  const atTaskCap = maxTasks >= TASKS_PER_PROJECT_CAP;
  return {
    truncated: atProjectCap || atTaskCap,
    projectCount,
    maxTasksInProject: maxTasks,
    atProjectCap,
    atTaskCap,
  };
}

/**
 * Deep reads per org per tick. 40 × ~2.0s ≈ 80s, comfortably inside a 15-minute
 * tick, and drains a 575-task backfill in ~15 ticks (~4 hours) without ever
 * blocking the cheap tier-1 pass.
 */
export const DEFAULT_VIEW_BUDGET = 40;

/** Filesystem-safe slug for an org name, matching github-projects.ts `slug()`. */
export function orgSlug(name) {
  return String(name || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/**
 * The filename prefix every file this org owns starts with.
 *
 * NOTE this prefix is a CHEAP PRE-FILTER, never a proof of ownership — see
 * readExisting. Org names `acme` and `acme-labs` on the same chain produce
 * `POP-100-acme-` and `POP-100-acme-labs-`, and every acme-labs filename also
 * starts with the acme prefix. github-project-sync.ts hit the identical
 * hyphen-extension hazard and solved it with an excludePrefixes list; we use
 * frontmatter identity instead, which is exact rather than a string-shape
 * heuristic and cannot be defeated by a future naming scheme.
 */
export function filePrefix(chainId, org) {
  return `POP-${chainId}-${orgSlug(org)}-`;
}

/**
 * Does this file's own frontmatter claim it belongs to this org on this chain?
 *
 * This is the ownership test. Only files that pass it are eligible to be
 * tombstoned or deleted by this org's pass.
 */
export function ownsFile(frontmatter, chainId, org) {
  const fm = frontmatter || {};
  if (typeof fm.pop_org !== 'string') return false;
  // Compare on the slug so a cosmetic rename ("Acme" -> "acme") still matches
  // the files it already wrote.
  if (orgSlug(fm.pop_org) !== orgSlug(org)) return false;
  return Number(fm.pop_chain_id) === Number(chainId);
}

/**
 * Read the existing mirror files for one org.
 *
 * A file matching the prefix but NOT claiming this org in its frontmatter is
 * skipped entirely: it is not in `existing`, so it is never tombstoned and
 * never deleted. It is also never seen as "already mirrored", so if it really
 * is ours-but-corrupt the next write repairs it. Both failure directions are
 * safe.
 *
 * @returns Map<slug, {file, digest, viewDigest, viewedAt, missingTicks, frontmatter, body}>
 */
export function readExisting(tasksDir, prefix, { logger, chainId, org } = {}) {
  const out = new Map();
  let entries;
  try {
    entries = fs.readdirSync(tasksDir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.md') || !entry.startsWith(prefix)) continue;
    try {
      const parsed = matter(fs.readFileSync(path.join(tasksDir, entry), 'utf-8'));
      const fm = parsed.data || {};
      if (chainId != null && org != null && !ownsFile(fm, chainId, org)) {
        logger?.debug?.(
          { entry, org, claimed: fm.pop_org },
          'pop: prefix matched but frontmatter belongs to another org — skipped',
        );
        continue;
      }
      out.set(entry.slice(0, -3), {
        file: entry,
        digest: typeof fm.pop_digest === 'string' ? fm.pop_digest : null,
        // Absent => this task has never had a deep read. That is the signal
        // the backfill selects on.
        viewDigest: typeof fm.pop_view_digest === 'string' ? fm.pop_view_digest : null,
        // When this task was last deep-read. Drives least-recently-refreshed
        // rotation so a task past the budget cannot starve forever.
        viewedAt: typeof fm.pop_viewed_at === 'string' ? fm.pop_viewed_at : '',
        missingTicks: Number(fm.pop_missing_ticks) || 0,
        frontmatter: fm,
        body: parsed.content || '',
      });
    } catch (err) {
      // Unreadable/corrupt: treat as absent so the next write repairs it, but
      // never as deletable (no digest → always rewritten, never swept).
      logger?.debug?.({ err, entry }, 'pop: unreadable mirror file');
    }
  }
  return out;
}

/**
 * PURE. Decide what the mirror should do this tick.
 *
 * @param rows       `pop task list --json` output for one org
 * @param existing   Map from readExisting()
 * @param opts       { chainId, org, missingTicksBeforeDelete }
 * @returns {{writes: Array, tombstones: Array, deletes: Array, unchanged: number}}
 */
export function planMirror(rows, existing, opts) {
  const {
    chainId,
    org,
    missingTicksBeforeDelete = DEFAULT_MISSING_TICKS,
    // A listing that may have been capped is not evidence of absence. When
    // false we still apply every write, but we neither tombstone nor delete —
    // the same posture as a failed pull.
    exhaustive = true,
  } = opts;
  const oSlug = orgSlug(org);
  const writes = [];
  const tombstones = [];
  const deletes = [];
  let unchanged = 0;
  const seen = new Set();

  for (const row of Array.isArray(rows) ? rows : []) {
    const taskId = String(row?.ID ?? '');
    if (!taskId) continue;
    const slug = popTaskSlug(chainId, oSlug, taskId);
    seen.add(slug);
    const digest = listDigest(row);
    const prior = existing.get(slug);

    // Unchanged AND not carrying a stale tombstone counter → nothing to do.
    if (prior && prior.digest === digest && !prior.missingTicks) {
      unchanged += 1;
      continue;
    }
    writes.push({ slug, row, digest, prior: prior || null });
  }

  // Absence only means anything if the listing was provably exhaustive.
  if (exhaustive) {
    for (const [slug, prior] of existing) {
      if (seen.has(slug)) continue;
      const next = (prior.missingTicks || 0) + 1;
      if (next >= missingTicksBeforeDelete) deletes.push({ slug, file: prior.file });
      else tombstones.push({ slug, prior, missingTicks: next });
    }
  }

  return { writes, tombstones, deletes, unchanged, exhaustive };
}

/**
 * PURE. Choose which tasks get an expensive `pop task view` this tick.
 *
 * WHY THIS IS BOUNDED AT ALL: a deep read is one subprocess per task, measured
 * at ~2.0s (of which ~1.1s is node startup). A 575-task org would be ~19
 * minutes if done in one pass. So we spend a fixed budget per tick and let the
 * backfill drain over several ticks.
 *
 * WHY IT TERMINATES: COMPLETED and CANCELLED are terminal on chain —
 * `pop task update` and `pop task edit-meta` both refuse terminal tasks — so
 * once a terminal task has been deep-read its narrative can never change again
 * and it is NEVER re-read. The steady-state cost is therefore the non-terminal
 * set only (10 of 575 on the live org), not the archive.
 *
 * Priority, highest first:
 *   1. non-terminal whose cheap list digest moved (something definitely happened)
 *   2. non-terminal never deep-read
 *   3. non-terminal unchanged — a metadata edit or an extra rejection moves NO
 *      list field and NO lifecycle timestamp, so the only way to see it is to
 *      look; this is cheap because the set is tiny
 *   4. terminal never deep-read — the one-time archive backfill, last because
 *      it is the only unbounded category and the least urgent
 */
export function planDeepReads(rows, existing, { chainId, org, budget = DEFAULT_VIEW_BUDGET } = {}) {
  const oSlug = orgSlug(org);
  // 0 live+changed · 1 live+unread · 2 live refresh · 3 just-went-terminal · 4 archive backfill
  const buckets = [[], [], [], [], []];

  for (const row of Array.isArray(rows) ? rows : []) {
    const taskId = String(row?.ID ?? '');
    if (!taskId) continue;
    const slug = popTaskSlug(chainId, oSlug, taskId);
    const prior = existing.get(slug);
    const terminal = isTerminalPopStatus(row.Status);
    const everRead = Boolean(prior?.viewDigest);
    const changed = !prior || prior.digest !== listDigest(row);

    // The whole affordability argument — but note the `!changed` guard. A task
    // TRANSITIONING into terminal (Submitted → Completed) has everRead=true and
    // is now terminal, yet its final record is exactly what we want to capture.
    // Skipping on `terminal && everRead` alone would freeze the body at its
    // pre-completion state forever.
    if (terminal && everRead && !changed) continue;

    // ORDER MATTERS, and the cold start is what proves it. On a first run there
    // is no prior state, so EVERY task is "changed" — bucketing on `changed`
    // alone put the budget into archive tasks 0..7 and left the 6 genuinely
    // live tasks unread. So NON-TERMINAL ALWAYS OUTRANKS TERMINAL: the live set
    // is tiny (10 of 575 on the real org) and is the only part anyone is
    // waiting on. A genuine transition INTO terminal still beats the archive,
    // because someone just finished work and got paid.
    const viewedAt = prior?.viewedAt || '';
    if (!terminal && changed) buckets[0].push({ slug, taskId, reason: 'changed', viewedAt });
    else if (!terminal && !everRead) buckets[1].push({ slug, taskId, reason: 'never-read', viewedAt });
    else if (!terminal) buckets[2].push({ slug, taskId, reason: 'refresh', viewedAt });
    else if (everRead) buckets[3].push({ slug, taskId, reason: 'changed', viewedAt });
    else buckets[4].push({ slug, taskId, reason: 'backfill', viewedAt });
  }

  // ROTATE THE REFRESH AND BACKFILL BUCKETS, least-recently-read first.
  //
  // Without this, both buckets are filled in subgraph row order and the budget
  // always takes the same head of the list. With 41 live tasks and a budget of
  // 40, task 41 would never be deep-read again — a metadata-only edit on it
  // would stay invisible forever. The changed/never-read buckets need no
  // rotation: they drain (a task leaves them once it is read).
  //
  // ISO-8601 sorts lexicographically, and a never-read task has '' which sorts
  // first — exactly the priority we want.
  const byOldest = (a, b) => (a.viewedAt < b.viewedAt ? -1 : a.viewedAt > b.viewedAt ? 1 : 0);
  buckets[2].sort(byOldest);
  buckets[4].sort(byOldest);

  const ordered = buckets.flat().map(({ slug, taskId, reason }) => ({ slug, taskId, reason }));
  const cap = Number.isFinite(budget) && budget >= 0 ? budget : DEFAULT_VIEW_BUDGET;
  return { selected: ordered.slice(0, cap), deferred: Math.max(0, ordered.length - cap) };
}

/** Atomic write: tmp + rename, so a crash never leaves a truncated file. */
function writeAtomic(filePath, contents) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

/**
 * Run one mirror tick for one org. I/O only — every decision came from
 * planMirror().
 *
 * Returns stats plus `complete`, which gates the delete pass exactly the way
 * github-project-sync's does: a failed or partial pull applies its writes but
 * NEVER deletes.
 */
export async function mirrorOrg({
  org,
  chainId,
  orgId,
  tasksDir,
  peopleDir,
  taskUrlBase,
  syncedAt,
  listResult,
  membersResult = null,
  missingTicksBeforeDelete = DEFAULT_MISSING_TICKS,
  fetchView = null,
  viewBudget = DEFAULT_VIEW_BUDGET,
  logger,
}) {
  const stats = {
    org,
    written: 0,
    unchanged: 0,
    tombstoned: 0,
    deleted: 0,
    viewed: 0,
    viewsDeferred: 0,
    viewErrors: 0,
    complete: false,
    truncated: false,
    error: null,
  };

  if (!listResult || !listResult.ok) {
    stats.error = listResult?.error || 'task list failed';
    logger?.warn?.({ org, err: stats.error }, 'pop: task list failed — no deletes this tick');
    return stats;
  }
  const rows = Array.isArray(listResult.json) ? listResult.json : [];

  // `complete` means "we can trust absence", not merely "the command exited 0".
  // The CLI's query is capped at 50 projects / 1000 tasks per project with no
  // pagination and no truncation flag, so a capped listing looks exactly like a
  // complete one — and every omitted live task would be tombstoned and then
  // deleted, taking its preserved human notes with it.
  const trunc = detectTruncation(rows);
  stats.truncated = trunc.truncated;
  stats.complete = !trunc.truncated;
  if (trunc.truncated) {
    logger?.warn?.(
      {
        org,
        projectCount: trunc.projectCount,
        maxTasksInProject: trunc.maxTasksInProject,
        atProjectCap: trunc.atProjectCap,
        atTaskCap: trunc.atTaskCap,
      },
      'pop: task listing may be truncated by the CLI query caps — writes applied, no deletes',
    );
  }

  const prefix = filePrefix(chainId, org);
  const existing = readExisting(tasksDir, prefix, { logger, chainId, org });
  const plan = planMirror(rows, existing, {
    chainId,
    org,
    missingTicksBeforeDelete,
    exhaustive: !trunc.truncated,
  });

  const { byAddress } = buildPeopleIndex(peopleDir, { logger });
  const memberIndex = membersResult?.ok ? buildMemberIndex(membersResult.json) : new Map();
  const oSlug = orgSlug(org);

  // --- tier 2: bounded deep reads -------------------------------------------
  // One subprocess per task, so this is budgeted and the remainder is REPORTED
  // rather than silently dropped — a capped sweep that looks complete is how
  // you end up trusting a partial picture.
  const views = new Map();
  if (fetchView && viewBudget > 0) {
    const deep = planDeepReads(rows, existing, { chainId, org, budget: viewBudget });
    stats.viewsDeferred = deep.deferred;
    for (const { taskId } of deep.selected) {
      try {
        const res = await fetchView(taskId);
        if (res?.ok && res.json) {
          views.set(String(taskId), res.json);
          stats.viewed += 1;
        } else {
          stats.viewErrors += 1;
          logger?.debug?.({ org, taskId, err: res?.error }, 'pop: deep read failed');
        }
      } catch (err) {
        stats.viewErrors += 1;
        logger?.debug?.({ err, org, taskId }, 'pop: deep read threw');
      }
    }
    if (deep.deferred) {
      logger?.info?.(
        { org, fetched: stats.viewed, deferred: deep.deferred },
        'pop: deep-read budget reached — remainder deferred to the next tick',
      );
    }
  }

  // A task whose cheap digest did not move can still need a rewrite: a
  // metadata edit or an extra rejection changes NO list field, so the deep read
  // is the only place that difference shows up.
  const extraWrites = [];
  const plannedSlugs = new Set(plan.writes.map((w) => w.slug));
  for (const row of rows) {
    const taskId = String(row?.ID ?? '');
    const view = views.get(taskId);
    if (!view) continue;
    const slug = popTaskSlug(chainId, oSlug, taskId);
    if (plannedSlugs.has(slug)) continue;
    const prior = existing.get(slug);
    if (prior && prior.viewDigest === viewDigest(view)) continue;
    extraWrites.push({ slug, row, digest: listDigest(row), prior: prior || null });
  }
  stats.unchanged = Math.max(0, plan.unchanged - extraWrites.length);

  fs.mkdirSync(tasksDir, { recursive: true });

  for (const { slug, row, digest, prior } of [...plan.writes, ...extraWrites]) {
    try {
      const view = views.get(String(row.ID)) || null;
      const owners = resolveOwners({
        // The deep read carries the assignee ADDRESS, which is the reliable
        // join; tier 1 only has the POP username and leans on the chain index.
        assigneeAddress: view?.assignee ?? null,
        assigneeUsername: row.Assignee || view?.assigneeUsername,
        peopleIndex: byAddress,
        memberIndex,
      });
      const owned = buildPopFrontmatter({
        row,
        view,
        chainId,
        org,
        orgId,
        orgSlug: oSlug,
        owners,
        digest,
        syncedAt,
        taskUrlBase,
      });
      // Clear any tombstone counter — the task is demonstrably alive.
      owned.pop_missing_ticks = 0;
      if (view) {
        owned.pop_view_digest = viewDigest(view);
        owned.pop_viewed_at = syncedAt; // drives least-recently-read rotation
      }
      const fm = mergePopFrontmatter(prior?.frontmatter || null, owned);
      fm.pop_missing_ticks = 0;
      // Carry the previous deep-read state forward when this rewrite had no
      // fresh view, so a budget-limited tick never makes a task look unread and
      // re-queue itself forever.
      if (!view && prior?.viewDigest) fm.pop_view_digest = prior.viewDigest;
      if (!view && prior?.viewedAt) fm.pop_viewed_at = prior.viewedAt;

      const { managed: priorManaged, human } = splitBody(prior?.body || '');
      // Without a fresh view, keep the narrative we already rendered rather
      // than regenerating a thinner body and dropping the description.
      const managed = view
        ? renderManagedBody({
            row,
            view,
            url: owned.pop_url,
            popStatus: owned.pop_status,
            payout: owned.pop_payout,
            project: owned.pop_project,
          })
        : priorManaged ||
          renderManagedBody({
            row,
            view: null,
            url: owned.pop_url,
            popStatus: owned.pop_status,
            payout: owned.pop_payout,
            project: owned.pop_project,
          });
      writeAtomic(path.join(tasksDir, `${slug}.md`), renderDoc(fm, renderBody(managed, human)));
      stats.written += 1;
    } catch (err) {
      // One bad task must not abort the org — connectors/base.ts takes the
      // same per-doc try/catch approach for the same reason.
      logger?.warn?.({ err, slug }, 'pop: failed to write mirror file');
    }
  }

  for (const { slug, prior, missingTicks } of plan.tombstones) {
    try {
      const fm = { ...prior.frontmatter, pop_missing_ticks: missingTicks };
      writeAtomic(path.join(tasksDir, `${slug}.md`), renderDoc(fm, prior.body));
      stats.tombstoned += 1;
    } catch (err) {
      logger?.debug?.({ err, slug }, 'pop: failed to tombstone');
    }
  }

  for (const { slug, file } of plan.deletes) {
    try {
      fs.unlinkSync(path.join(tasksDir, file));
      stats.deleted += 1;
      logger?.info?.({ org, slug }, 'pop: removed a task missing from chain for several ticks');
    } catch (err) {
      logger?.debug?.({ err, slug }, 'pop: failed to delete');
    }
  }

  return stats;
}
