/**
 * digest.mjs — per-task change detection for the POP mirror.
 *
 * PURE: no I/O, no clock. Unit-tested with no mocks.
 *
 * WHY A DIGEST AT ALL: a POP task has NO monotonic change cursor. There is no
 * `updatedAt`, no `version` and no `blockNumber` on the Task entity, and —
 * verified against the CLI source — `updateTask`, `updateTaskMetadata`
 * (`edit-meta`), `cancelTask` and `claimTask` bump NONE of the lifecycle
 * timestamps. So a metadata edit or a cancellation is invisible to a
 * timestamp diff. `org activity --since` does not help either: `--since` is
 * never passed to the subgraph, it is filtered client-side on `createdAt`
 * only. A content digest is therefore the only complete change detector.
 *
 * TWO TRAPS THIS MODULE EXISTS TO AVOID (both verified live):
 *
 *  1. `pop task list --json` has a NON-UNIFORM KEY SET. A `Completed` row comes
 *     back with 9 keys; an `Open` row comes back with 13 (it gains
 *     absoluteDeadline / completionWindow / claimDeadline / claimState).
 *     Digesting `Object.keys()` would therefore produce a different digest for
 *     the same task purely because its status changed shape. We digest an
 *     EXPLICIT ORDERED FIELD LIST with explicit defaults instead.
 *
 *  2. `claimState` MUST BE EXCLUDED. It is a pure function of `claimDeadline`
 *     and wall-clock now (`none` / `on-track` / `expiring-soon` /
 *     `expired-claimable`, with a 24h window), so it flips on its own with no
 *     chain change at all. Including it would mark every deadline-bearing task
 *     as changed on every tick, and the mirror would rewrite the whole KB
 *     forever.
 */

import crypto from 'crypto';

/**
 * Fields digested from a `pop task list --json` row (tier 1, one subgraph
 * query for the whole org). Order is part of the contract — changing it
 * invalidates every stored digest and forces a full re-mirror, which is
 * correct but expensive, so treat this list as a schema.
 *
 * `claimState` is deliberately ABSENT. See the header.
 */
export const LIST_DIGEST_FIELDS = Object.freeze([
  'ID',
  'Name',
  'Status',
  'Assignee',
  'Payout',
  'Project',
  'createdAt',
  'absoluteDeadline',
  'completionWindow',
  'claimDeadline',
  'releaseCount',
  'lastReleasedAt',
]);

/**
 * Fields digested from a `pop task view --json` record (tier 2, one subprocess
 * per task). These are the narrative fields that only the deep read carries.
 * `metadataHash` would be the natural "body changed" signal but `task view`
 * does not emit it, so we digest the RESOLVED CONTENT instead — equivalent for
 * change detection and available from the frozen CLI surface.
 *
 * `claimState` excluded here for the same reason as above.
 */
export const VIEW_DIGEST_FIELDS = Object.freeze([
  'taskId',
  'title',
  'description',
  'status',
  'project',
  'payout',
  'bountyToken',
  'bountyPayout',
  'assignee',
  'assigneeUsername',
  'completer',
  'difficulty',
  'estHours',
  'location',
  'submission',
  'rejectionCount',
  'requiresApplication',
  'createdAt',
  'assignedAt',
  'submittedAt',
  'completedAt',
  'absoluteDeadline',
  'completionWindow',
  'claimDeadline',
  'releaseCount',
  'lastReleasedAt',
]);

/**
 * Canonicalise one value so that shape differences that are not semantic
 * differences do not move the digest:
 *   - absent / null / undefined all collapse to the empty string, so a row
 *     that simply OMITS `absoluteDeadline` digests the same as one that
 *     reports `0`... no — see below. Absent collapses to '', numeric 0 stays
 *     '0'. They are NOT conflated, because "the subgraph did not report this
 *     field" and "the field is zero" are genuinely different observations and
 *     conflating them would hide a real transition.
 *   - numbers and numeric strings both render via String(), so `0` and `'0'`
 *     agree (the CLI is inconsistent about this between rows).
 *   - arrays/objects go through stable JSON.
 */
function canon(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'object') {
    // Stable key order so an upstream reordering is not a false change.
    const keys = Object.keys(value).sort();
    return JSON.stringify(keys.map((k) => [k, canon(value[k])]));
  }
  return String(value);
}

/**
 * sha256 over an explicit ordered field list. Returns a hex string.
 *
 * Exported separately from the two convenience wrappers so a caller can digest
 * an arbitrary field list (used by the tests to prove ordering matters).
 */
export function digestFields(record, fields) {
  const src = record && typeof record === 'object' ? record : {};
  // Control-character delimiters (U+0000 between a field name and its value,
  // U+0001 between fields) so a value cannot forge a neighbouring field's
  // boundary — chain-authored titles and descriptions flow through here.
  //
  // Written as ESCAPES, never as literal bytes: embedding the raw characters
  // makes git classify the whole file as binary and stop diffing it.
  const payload = fields.map((f) => `${f}\u0000${canon(src[f])}`).join('\u0001');
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/** Digest of a `pop task list --json` row. */
export function listDigest(row) {
  return digestFields(row, LIST_DIGEST_FIELDS);
}

/**
 * Normalise a rendered collection down to exactly the parts the body shows.
 *
 * ANYTHING THE BODY RENDERS MUST BE IN THE DIGEST, or the mirror computes an
 * unchanged digest, discards the fresh view, and the rendered body never
 * updates. Two real cases this closes:
 *
 *  - A rejection REASON arriving late. The CLI resolves the newest rejection's
 *    reason from IPFS when the subgraph has not indexed it yet, so the same
 *    task legitimately returns `reason: null` and then `reason: "…"` with
 *    `rejectionCount` unchanged at 1.
 *  - A new APPLICATION. `applications` grows but there is no application count
 *    among the scalar fields, so nothing else moves.
 *
 * We digest a projection rather than the raw objects so that upstream key
 * reordering or additive fields we do not render cannot cause false rewrites.
 */
export function normalizeCollections(view) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    __rejections: arr(view?.rejections).map((r) => [
      r?.rejector ?? r?.rejectorUsername ?? '',
      r?.reason ?? r?.metadata?.rejection ?? '',
      r?.rejectedAt ?? '',
    ]),
    __applications: arr(view?.applications).map((a) => [
      a?.applicantUsername ?? a?.applicant ?? '',
      a?.metadata?.notes ?? '',
      a?.approved ? '1' : '0',
    ]),
    __releases: arr(view?.releases).map((r) => [
      r?.previousClaimerUsername ?? r?.previousClaimer ?? '',
      r?.callerUsername ?? '',
      r?.selfRelease ? '1' : '0',
      r?.releasedAt ?? '',
    ]),
  };
}

/** The collection keys appended to every view digest. */
export const VIEW_COLLECTION_FIELDS = Object.freeze([
  '__rejections',
  '__applications',
  '__releases',
]);

/** Digest of a `pop task view --json` record, collections included. */
export function viewDigest(view) {
  const src = { ...(view && typeof view === 'object' ? view : {}), ...normalizeCollections(view) };
  return digestFields(src, [...VIEW_DIGEST_FIELDS, ...VIEW_COLLECTION_FIELDS]);
}
