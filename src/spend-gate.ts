/**
 * spend-gate — "classify cheaply, wake the paid agent only when non-empty."
 *
 * The LLM-cost-minimization primitive: before an expensive agent run, do a
 * CHEAP classification pass — pure deterministic code where possible, the
 * model router's cheap tier where a model is genuinely needed — and invoke
 * the paid agent only when that pass finds actionable work. An empty
 * classification costs (at most) one cheap-tier run; the strong/default-tier
 * agent never starts.
 *
 * STATUS: tested library infrastructure staged ahead of its first consumer
 * (TaskKind 'classifier' already reserved in model-router.ts). Not wired to
 * any live job yet; that is intentional, mirroring how tiered-agent.ts
 * landed before its consumers. NOTHING imports this module from the runtime
 * path — an unconfigured deploy is byte-for-byte unaffected.
 *
 * Two pieces:
 *
 *  - runSpendGated(): the gate itself. Fully injection-based (classify /
 *    isEmpty / invoke are caller-supplied), so the cheap pass can be pure
 *    code (a deterministic classify() — zero LLM) or a cheap-tier model
 *    call via tieredClassifier() below.
 *
 *  - tieredClassifier(): adapts runTieredAgent into a classify function, so
 *    an LLM-backed cheap pass rides the EXISTING model-router seam — cheap
 *    tier first, escalating only on schema-invalid output. No new model
 *    plumbing.
 *
 * Failure semantics: a classify error propagates and the paid agent is NOT
 * invoked — the gate fails closed on spend. An invoke error propagates after
 * the classification succeeded (the caller sees which side failed by when).
 */

import type { Database } from 'better-sqlite3';

import { logger } from './logger.js';
import type { TaskKind } from './model-router.js';
import {
  runTieredAgent,
  type RunAgent,
  type TieredAgentArgs,
} from './tiered-agent.js';

// ── Daily estimated-spend cap ────────────────────────────────────────────────
//
// A conservative, non-refundable ESTIMATED-USD daily reservation ledger (no
// runner/proxy token telemetry assumed). ContainerOutput carries no cost data,
// so this measures a conservative estimated ceiling, not actual spend.
// Reservations are NOT refunded after a spawn attempt, so a run of failures
// cannot evade the ceiling by "spending then rolling back."
//
// Injection-testable: takes an explicit `db` + `now` rather than importing the
// global handle, so tests drive a fixed clock and an in-memory DB.

export interface ReserveDailySpendResult {
  /** True iff the estimate was reserved (the caller may spawn). */
  allowed: boolean;
  /** UTC calendar day (YYYY-MM-DD) the reservation was booked against. */
  spendDate: string;
  /** reserved_usd AFTER this call. */
  reservedUsd: number;
  /** Why a denial happened (for ops logging; never surfaced to users). */
  reason?:
    | 'ok'
    | 'invalid-cap'
    | 'invalid-estimate'
    | 'cap-exhausted'
    | 'db-error';
}

/** The UTC calendar day key (YYYY-MM-DD) for a timestamp. */
function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Atomically reserve `estimateUsd` against today's (UTC) budget, allowing only
 * when `reserved_usd + estimate <= capUsd`. Uses one BEGIN IMMEDIATE (write-lock)
 * transaction so concurrent callers cannot both slip past the ceiling.
 *
 * FAIL CLOSED: a non-positive/NaN cap or estimate, a DB error/lock, or an
 * exhausted cap all DENY (allowed=false) without reserving. The reservation is
 * non-refundable (booked before the spawn attempt).
 *
 * @param db          the messages.db handle (owns passive_monitor_spend)
 * @param capUsd      the daily ceiling (0/negative/NaN ⇒ deny)
 * @param estimateUsd the per-batch estimate to reserve (0/negative/NaN ⇒ deny)
 * @param now         current time in ms (injectable for tests)
 */
export function reserveDailySpend(
  db: Database,
  capUsd: number,
  estimateUsd: number,
  now: number = Date.now(),
): ReserveDailySpendResult {
  const spendDate = utcDay(now);
  // Fail closed on an unusable cap/estimate BEFORE touching the DB.
  if (!Number.isFinite(capUsd) || capUsd <= 0) {
    return { allowed: false, spendDate, reservedUsd: 0, reason: 'invalid-cap' };
  }
  if (!Number.isFinite(estimateUsd) || estimateUsd <= 0) {
    return {
      allowed: false,
      spendDate,
      reservedUsd: 0,
      reason: 'invalid-estimate',
    };
  }

  try {
    const nowIso = new Date(now).toISOString();
    const txn = db.transaction((): ReserveDailySpendResult => {
      const row = db
        .prepare(
          `SELECT reserved_usd FROM passive_monitor_spend WHERE spend_date = ?`,
        )
        .get(spendDate) as { reserved_usd: number } | undefined;
      const currentReserved = row ? row.reserved_usd : 0;
      const next = currentReserved + estimateUsd;
      if (next > capUsd) {
        // Cap would be exceeded — deny, reserve nothing.
        return {
          allowed: false,
          spendDate,
          reservedUsd: currentReserved,
          reason: 'cap-exhausted',
        };
      }
      db.prepare(
        `INSERT INTO passive_monitor_spend (spend_date, reserved_usd, batches, updated_at)
           VALUES (?, ?, 1, ?)
         ON CONFLICT(spend_date) DO UPDATE SET
           reserved_usd = reserved_usd + excluded.reserved_usd,
           batches = batches + 1,
           updated_at = excluded.updated_at`,
      ).run(spendDate, estimateUsd, nowIso);
      return { allowed: true, spendDate, reservedUsd: next, reason: 'ok' };
    });
    // Force IMMEDIATE so the read+decision happens under the write lock.
    return txn.immediate();
  } catch (err) {
    logger.error(
      { err, spendDate },
      'spend-gate: reserveDailySpend failed — denying (fail closed)',
    );
    return { allowed: false, spendDate, reservedUsd: 0, reason: 'db-error' };
  }
}

export interface SpendGateArgs<C, T> {
  /**
   * The cheap pass. Pure deterministic code where possible; otherwise a
   * cheap-tier model call (see tieredClassifier). A thrown error here
   * fails the whole call WITHOUT invoking the paid agent.
   */
  classify: () => C | Promise<C>;
  /** "Nothing actionable" test — true suppresses the paid agent entirely. */
  isEmpty: (classification: C) => boolean;
  /**
   * The expensive invocation (the paid/strong agent run). Only called when
   * isEmpty(classification) is false; receives the classification so the
   * cheap pass's work is reused, not recomputed.
   */
  invoke: (classification: C) => Promise<T>;
  /** Log label for the skip/invoke lines (e.g. 'pm-followup'). */
  label?: string;
}

export interface SpendGateOutcome<C, T> {
  /** Whether the paid agent ran. */
  invoked: boolean;
  /** What the cheap pass found (returned either way, for callers/logs). */
  classification: C;
  /** The paid agent's result; null when the gate suppressed the run. */
  result: T | null;
}

/**
 * Run the spend gate: classify cheaply, and invoke the paid agent only when
 * the classification is non-empty. See the file header for failure semantics.
 */
export async function runSpendGated<C, T>(
  args: SpendGateArgs<C, T>,
): Promise<SpendGateOutcome<C, T>> {
  const label = args.label ?? 'spend-gate';
  const classification = await args.classify();

  if (args.isEmpty(classification)) {
    logger.info(
      { gate: label },
      'spend-gate: classification empty — skipping paid agent run',
    );
    return { invoked: false, classification, result: null };
  }

  logger.info(
    { gate: label },
    'spend-gate: classification non-empty — invoking paid agent',
  );
  const result = await args.invoke(classification);
  return { invoked: true, classification, result };
}

/**
 * Adapt runTieredAgent into a spend-gate classify function: the
 * classification runs on `kind`'s tier chain (a cheap-tier kind starts on the
 * router's cheap model and escalates only when its output fails `schema`).
 * Use a cheap-tier TaskKind (e.g. 'classifier') — putting the CLASSIFY step
 * on an expensive tier would defeat the gate's purpose.
 *
 * CONSUMER REQUIREMENT: inherits tiered-agent's container-lifecycle contract
 * (see the header block in src/tiered-agent.ts) — a real consumer must own
 * the container close via args.onProcess + a prompt close, or an injected
 * lifecycle-owning deps.runAgent.
 */
export function tieredClassifier<C>(
  kind: TaskKind,
  args: TieredAgentArgs<C>,
  deps: { runAgent?: RunAgent } = {},
): () => Promise<C> {
  return async () => (await runTieredAgent(kind, args, deps)).result;
}
