/**
 * cli.mjs — the ONLY place this plugin talks to the POP protocol.
 *
 * We shell out to the `pop` binary rather than importing @poa-box/core, for
 * two independent reasons:
 *
 *  1. DEPENDENCY ISOLATION. `@poa-box/cli` declares `ethers` as a DIRECT
 *     dependency (5.7.2), so npm nests it under
 *     node_modules/@poa-box/cli/node_modules/ethers and labor.fun keeps its own
 *     ethers v6 — verified. `@poa-box/core` declares ethers as a PEER dep, so
 *     npm would hoist our v6 and silently break its 427 v5-only call sites.
 *  2. SAFETY INHERITANCE. A subprocess inherits POP_READONLY, the confirmWrite
 *     consent policy, the idempotency cache, decoded contract errors and the
 *     stable exit-code contract for free. Importing internals bypasses all of
 *     it. This is the same reasoning poa's own `pop mcp serve` gives for
 *     shelling out to itself.
 *
 * THE ENV IS EXPLICIT AND MINIMAL — NEVER `...process.env`.
 * `pop`'s own env loader (src/lib/env-load.ts) reads `./.env` from CWD at
 * HIGHEST precedence. Spawning with cwd = the labor.fun repo root would pull
 * labor.fun's entire .env into the pop process. So we pass a hand-built env and
 * point cwd at an isolated directory.
 *
 * READS CANNOT SIGN. `POP_READONLY=1` is hardwired on the read path. Inside the
 * CLI that is checked in createSigner() and the IPFS pin helpers, so it refuses
 * to sign or broadcast *even if a key were present in the environment* — that
 * is capability removal, not policy, and it is what makes the mirror safe to
 * run against untrusted chat input.
 *
 * ERROR CONTRACT (verified live): on failure stdout is EMPTY, the JSON error is
 * on STDERR, and the exit code is non-zero. So we branch on the exit code and
 * never on "did stdout parse". Exit codes: 0 OK, 1 USAGE, 2 TX_FAILED,
 * 3 INFRA, 4 PRECONDITION, 5 ABORTED.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);

/** Default per-call timeout. A `task list` over 575 tasks measures ~1.8s. */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** Generous: a full task list for a large org is ~140 KB. */
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Absolute path to the `pop` executable, resolved through node's own module
 * resolution so it works from the repo, from the orchestrator image, and from
 * a nested install alike. Returns null when @poa-box/cli is not installed, so
 * the caller can stay dormant instead of throwing at startup.
 */
export function resolvePopBin() {
  try {
    // The package's exports map blocks deep imports but always exposes
    // ./package.json, so resolve that and walk to the bin.
    const pkgPath = require_.resolve('@poa-box/cli/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const rel =
      typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin && pkg.bin.pop) || null;
    if (!rel) return null;
    const full = path.join(path.dirname(pkgPath), rel);
    return fs.existsSync(full) ? full : null;
  } catch {
    return null;
  }
}

/**
 * Build the explicit env for a `pop` invocation.
 *
 * `POP_AGENT_HOME` is the multi-tenancy lever: it isolates BOTH the idempotency
 * cache and the subgraph tier-state file, so two orgs on one host never share
 * either. Point it inside the profile's store dir.
 *
 * Nothing from labor.fun's own environment leaks in beyond PATH/HOME, which
 * node needs to spawn at all.
 */
export function buildEnv({ chainId, org, agentHome, graphApiKey, readOnly = true, extra = {} }) {
  const env = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: agentHome,
    POP_AGENT_HOME: agentHome,
  };
  if (readOnly) env.POP_READONLY = '1';
  if (chainId != null) env.POP_DEFAULT_CHAIN = String(chainId);
  if (org) env.POP_DEFAULT_ORG = String(org);
  if (graphApiKey) env.GRAPH_API_KEY = graphApiKey;
  for (const [k, v] of Object.entries(extra)) {
    if (v != null && v !== '') env[k] = String(v);
  }
  return env;
}

/**
 * Run one `pop` command.
 *
 * Always resolves — never rejects — so a reconcile tick can decide what to do
 * with a failure rather than having an unhandled rejection kill the loop.
 *
 * @returns {{ok: boolean, exitCode: number, json: any, error: string|null, stdout: string, stderr: string}}
 *   `ok` is true ONLY on exit 0. `json` is the parsed stdout on success, or
 *   null. `error` is the CLI's own message when it emitted a structured error
 *   on stderr, else a summary.
 */
export function runPop(args, { bin, env, cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const popBin = bin || resolvePopBin();
  if (!popBin) {
    return Promise.resolve({
      ok: false,
      exitCode: -1,
      json: null,
      error: '@poa-box/cli is not installed — the pop plugin stays dormant',
      stdout: '',
      stderr: '',
    });
  }

  return new Promise((resolve) => {
    execFile(
      process.execPath, // run through node explicitly; the bin has no shebang guarantee
      [popBin, ...args],
      { env, cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        const out = String(stdout || '');
        const errOut = String(stderr || '');
        // execFile surfaces a non-zero exit as an Error carrying `.code`.
        const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;

        if (exitCode === 0) {
          let json = null;
          try {
            json = out.trim() ? JSON.parse(out) : null;
          } catch {
            // Exit 0 with unparseable stdout should not be silently treated as
            // "no data" — that is exactly how a mirror deletes a whole org.
            return resolve({
              ok: false,
              exitCode: 0,
              json: null,
              error: 'pop exited 0 but stdout was not valid JSON',
              stdout: out,
              stderr: errOut,
            });
          }
          return resolve({ ok: true, exitCode: 0, json, error: null, stdout: out, stderr: errOut });
        }

        // Failure: the structured error lives on stderr.
        let message = null;
        try {
          const parsed = JSON.parse(errOut.trim());
          if (parsed && typeof parsed.message === 'string') message = parsed.message;
        } catch {
          /* not structured — fall through to the raw text */
        }
        resolve({
          ok: false,
          exitCode,
          json: null,
          error: message || errOut.trim().slice(0, 500) || `pop exited ${exitCode}`,
          stdout: out,
          stderr: errOut,
        });
      },
    );
  });
}

/** `pop task list --org X --json` — one subgraph query for the whole org. */
export function listTasks(org, opts) {
  return runPop(['task', 'list', '--org', org, '--json'], opts);
}

/** `pop task view --task N --org X --json` — the deep, per-task record. */
export function viewTask(org, taskId, opts) {
  return runPop(['task', 'view', '--task', String(taskId), '--org', org, '--json'], opts);
}

/** `pop org members --org X --json` — the authoritative username↔address map. */
export function listMembers(org, opts) {
  return runPop(['org', 'members', '--org', org, '--json'], opts);
}
