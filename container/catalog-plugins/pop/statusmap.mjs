/**
 * statusmap.mjs — POP status vocabulary → the KB's status vocabulary.
 *
 * PURE: no I/O, no clock. Unit-tested with no mocks.
 *
 * THREE VOCABULARIES EXIST and confusing them is the classic POP integration
 * bug, so they are spelled out here once:
 *
 *   on-chain enum  UNCLAIMED(0) CLAIMED(1) SUBMITTED(2) COMPLETED(3) CANCELLED(4)
 *   subgraph/CLI   Open         Assigned   Submitted    Completed    Cancelled
 *   labor.fun KB   open         in_progress in_review   done         cancelled
 *
 * The CLI/subgraph strings are what `pop task list --json` and `pop task view
 * --json` actually emit — verified live against a real org — so those are what
 * we map FROM. `UNCLAIMED↔Open` and `CLAIMED↔Assigned` are the two renames that
 * catch people out. The CLI itself defensively accepts both vocabularies
 * (src/commands/task/list.ts), which is why both are accepted below.
 *
 * WHY `Submitted → in_review` rather than something in DONE_STATUSES: a
 * submitted task is awaiting review and is still live work. `in_review` is not
 * in `DONE_STATUSES` (src/reminder-engine.ts), so the deadline ladder keeps
 * running on it and the PM orchestrator keeps counting it as load — which is
 * the behaviour we want. `Completed`/`Cancelled` map to `done`/`cancelled`,
 * both of which ARE in DONE_STATUSES, so reminders stop.
 *
 * There is deliberately no mapping to `blocked`: nothing on chain expresses it.
 * `blocked` stays a purely local, human-owned status.
 */

/** Canonical POP (subgraph/CLI) status → KB status. */
const TO_KB = new Map([
  // Subgraph / CLI vocabulary — the one we actually receive.
  ['open', 'open'],
  ['assigned', 'in_progress'],
  ['submitted', 'in_review'],
  ['completed', 'done'],
  ['cancelled', 'cancelled'],
  // On-chain enum names, accepted because the CLI accepts them too and a
  // future read path (or the on-chain probe fallback) may surface them.
  ['unclaimed', 'open'],
  ['claimed', 'in_progress'],
  ['canceled', 'cancelled'], // single-l spelling, seen in some payloads
]);

/**
 * Map a POP status string to the KB vocabulary.
 *
 * An UNKNOWN status is passed through lowercased rather than coerced to a
 * guess: inventing `open` for a status we do not recognise would silently
 * start a reminder ladder on something we do not understand. Passing it
 * through keeps it visible (and out of DONE_STATUSES, so it stays active and
 * someone notices).
 */
export function toKbStatus(popStatus) {
  return TO_KB.get(normalizePopStatus(popStatus)) ?? normalizePopStatus(popStatus) ?? 'open';
}

/**
 * Strip the CLI's DECORATED status back to the raw subgraph value.
 *
 * `pop task list --json` does not emit the raw status. Verified in the bundled
 * CLI (dist/commands/task/list.js):
 *
 *   status: rejCount > 0 && task.status === 'Assigned'
 *     ? `Rejected(${rejCount})` : task.status,
 *   statusRaw: task.status,          // <- computed, but NOT emitted in --json
 *
 * The JSON projection maps `Status: r.status`, so an assigned task that has
 * been rejected arrives as `Rejected(2)`. Left alone that falls through
 * toKbStatus's passthrough and becomes the bogus KB status `rejected(2)`,
 * which is outside the KB vocabulary and outside DONE_STATUSES.
 *
 * The decoration only ever wraps `Assigned`, so unwrapping it is exact, not a
 * guess. The rejection COUNT is not lost — it is carried separately in
 * `pop_rejection_count`.
 */
export function normalizePopStatus(popStatus) {
  if (typeof popStatus !== 'string') return 'open';
  const raw = popStatus.trim();
  if (!raw) return 'open';
  if (/^rejected\(\d+\)$/i.test(raw)) return 'assigned';
  return raw.toLowerCase();
}

/**
 * Terminal on chain: COMPLETED and CANCELLED. `pop task update` and
 * `pop task edit-meta` both REFUSE terminal tasks, so a terminal task is
 * immutable — which is what lets the mirror deep-read each one exactly once,
 * ever, and never re-read it. That property is the entire reason mirroring a
 * 575-task archive is affordable.
 */
export function isTerminalPopStatus(popStatus) {
  if (typeof popStatus !== 'string') return false;
  const key = normalizePopStatus(popStatus);
  return key === 'completed' || key === 'cancelled' || key === 'canceled';
}
