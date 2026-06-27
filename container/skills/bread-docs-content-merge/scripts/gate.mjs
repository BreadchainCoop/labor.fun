#!/usr/bin/env node
/**
 * bread-docs-content-merge — gate script
 *
 * Cheap, deterministic detector for the bread-docs-content-merge skill. Run as a
 * scheduled-task `script` gate: it polls GitHub via `gh api` (the container
 * has GH_TOKEN injected) and prints a single JSON line:
 *
 *   { "wakeAgent": <bool>, "mode": ..., "candidates": [...], ... }
 *
 * The agent is only woken when there is something to act on. The agent then
 * does the authoritative re-checks and the side-effecting actions
 * (merge / update-branch / DM / escalate) per SKILL.md.
 *
 * Modes:
 *   --mode=idle-branches   keystatic/* branches that are idle (>idleMinutes),
 *                          have no open PR, and haven't been nudged at this HEAD
 *   --mode=content-prs     open PRs that touch ONLY content (src/content/**.{md,mdx})
 *
 * Config: JSON at $BREAD_DOCS_CONTENT_MERGE_CONFIG, else ../config.json beside this
 * script, else the built-in DEFAULTS below (which target bread-docs).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in ../tests/gate.test.mjs)
// ---------------------------------------------------------------------------

/** True only if every path is a content document (md/mdx under a content dir). */
export function isContentOnly(
  paths,
  { contentPaths = ['src/content/'], contentExtensions = ['.md', '.mdx'] } = {},
) {
  if (!Array.isArray(paths) || paths.length === 0) return false;
  return paths.every(
    (p) =>
      contentPaths.some((base) => p.startsWith(base)) &&
      contentExtensions.some((ext) => p.endsWith(ext)),
  );
}

/** True if the last commit is at least idleMinutes old. */
export function isIdle(lastCommitIso, nowMs, idleMinutes) {
  const last = Date.parse(lastCommitIso);
  if (Number.isNaN(last)) return false;
  return nowMs - last >= idleMinutes * 60_000;
}

/** Evaluate required status checks. Missing/failing/pending => not all pass. */
export function requiredChecksState(contextStates, requiredContexts) {
  const PASS = new Set(['success', 'neutral', 'skipped']);
  const details = requiredContexts.map((ctx) => ({
    context: ctx,
    state: contextStates[ctx] ?? 'missing',
  }));
  return { allPass: details.every((d) => PASS.has(d.state)), details };
}

/** Best-effort author from a `keystatic/<user>/...` branch name (fallback only). */
export function parseBranchUser(branchName, branchPrefix = 'keystatic/') {
  if (!branchName.startsWith(branchPrefix)) return null;
  return branchName.slice(branchPrefix.length).split('/')[0] || null;
}

// ---------------------------------------------------------------------------
// Config + state
// ---------------------------------------------------------------------------
const HERE = path.dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  repo: 'BreadchainCoop/bread-docs',
  mode: 'watch', // 'watch' (detect + report only) | 'live' (act)
  contentPaths: ['src/content/'],
  contentExtensions: ['.md', '.mdx'],
  requiredChecks: [
    'netlify/bread-docs/deploy-preview',
    'Redirect rules - bread-docs',
    'Header rules - bread-docs',
  ],
  mergeMethod: 'merge', // ruleset on main allows merge-commit only
  branchPrefix: 'keystatic/',
  idleMinutes: 60,
  maintainer: 'rathermercurial',
  statePath: '.bread-docs-content-merge-state.json',
};

function loadConfig() {
  const envPath = process.env.BREAD_DOCS_CONTENT_MERGE_CONFIG;
  const local = path.join(HERE, '..', 'config.json');
  let fileCfg = {};
  if (envPath && existsSync(envPath)) fileCfg = JSON.parse(readFileSync(envPath, 'utf8'));
  else if (existsSync(local)) fileCfg = JSON.parse(readFileSync(local, 'utf8'));
  return { ...DEFAULTS, ...fileCfg };
}

function loadState(statePath) {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// GitHub (gh api — token already in the container env)
// ---------------------------------------------------------------------------
function gh(endpoint) {
  const out = execFileSync('gh', ['api', endpoint], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(out);
}

const owner = (repo) => repo.split('/')[0];

function checkStates(repo, sha) {
  const map = {};
  try {
    const st = gh(`repos/${repo}/commits/${sha}/status`);
    for (const s of st.statuses ?? []) map[s.context] = s.state;
  } catch {
    /* ignore — treated as missing */
  }
  try {
    const cr = gh(`repos/${repo}/commits/${sha}/check-runs`);
    for (const c of cr.check_runs ?? [])
      map[c.name] = c.status === 'completed' ? (c.conclusion ?? 'pending') : 'pending';
  } catch {
    /* ignore */
  }
  return map;
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------
function detectIdleBranches(cfg, state) {
  const now = Date.now();
  let branches;
  try {
    branches = gh(`repos/${cfg.repo}/branches?per_page=100`);
  } catch (e) {
    return { error: `list branches failed: ${e.message}` };
  }
  const candidates = [];
  for (const b of branches.filter((x) => x.name.startsWith(cfg.branchPrefix))) {
    let info;
    try {
      info = gh(`repos/${cfg.repo}/branches/${encodeURIComponent(b.name)}`);
    } catch {
      continue;
    }
    const sha = info.commit.sha;
    const date = info.commit.commit.author.date;
    const author = info.commit.author?.login ?? parseBranchUser(b.name, cfg.branchPrefix);
    if (!isIdle(date, now, cfg.idleMinutes)) continue;
    let prs = [];
    try {
      prs = gh(
        `repos/${cfg.repo}/pulls?state=open&head=${owner(cfg.repo)}:${encodeURIComponent(b.name)}`,
      );
    } catch {
      /* ignore */
    }
    if (prs.length > 0) continue; // a PR already exists — Workflow B's job
    if (state.nudged?.[b.name] === sha) continue; // already nudged at this HEAD
    candidates.push({ branch: b.name, author, lastCommit: date, sha });
  }
  return { candidates };
}

function detectContentPRs(cfg, state) {
  let prs;
  try {
    prs = gh(`repos/${cfg.repo}/pulls?state=open&per_page=100`);
  } catch (e) {
    return { error: `list pulls failed: ${e.message}` };
  }
  const candidates = [];
  for (const pr of prs) {
    let files;
    try {
      files = gh(`repos/${cfg.repo}/pulls/${pr.number}/files?per_page=100`);
    } catch {
      continue;
    }
    const paths = files.map((f) => f.filename);
    if (!isContentOnly(paths, cfg)) continue; // touches code — out of scope, ignored
    const sha = pr.head.sha;
    if (state.handled?.[pr.number] === sha) continue; // merged/escalated already at this HEAD
    const checks = requiredChecksState(checkStates(cfg.repo, sha), cfg.requiredChecks);
    candidates.push({
      number: pr.number,
      title: pr.title,
      author: pr.user?.login,
      head: pr.head.ref,
      sha,
      url: pr.html_url,
      fileCount: paths.length,
      checks,
    });
  }
  return { candidates };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function main() {
  const modeArg = process.argv.find((a) => a.startsWith('--mode='));
  const mode = modeArg ? modeArg.split('=')[1] : null;
  const cfg = loadConfig();
  const state = loadState(cfg.statePath);

  let result;
  if (mode === 'idle-branches') result = detectIdleBranches(cfg, state);
  else if (mode === 'content-prs') result = detectContentPRs(cfg, state);
  else result = { error: `unknown or missing --mode (got: ${mode})` };

  if (result.error) {
    // Don't wake the agent on a transient gate error; surface it in the run log.
    console.log(JSON.stringify({ wakeAgent: false, mode, error: result.error }));
    return;
  }
  const candidates = result.candidates ?? [];
  console.log(
    JSON.stringify({
      wakeAgent: candidates.length > 0,
      mode,
      repo: cfg.repo,
      dryRun: cfg.mode !== 'live',
      maintainer: cfg.maintainer,
      mergeMethod: cfg.mergeMethod,
      requiredChecks: cfg.requiredChecks,
      candidates,
    }),
  );
}

// Only run the CLI when executed directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
