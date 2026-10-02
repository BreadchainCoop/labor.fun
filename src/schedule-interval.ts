/**
 * Parser for `schedule_type: 'interval'` values.
 *
 * Why this exists: every interval call site used to do `parseInt(value, 10)`.
 * `parseInt('6h', 10) === 6` — no error, just a silent 6 MILLISECONDS. The
 * guards were all `isNaN(ms) || ms <= 0`, which `6` sails through, so a task
 * written as "6h" rescheduled itself 6ms later, forever. On production that
 * burned ~1,224 agent runs/day on a single task.
 */

/**
 * Floor for any interval schedule. A single agent run takes roughly 50
 * seconds, so a sub-minute interval is a runaway by definition — the task
 * would be re-triggered before the previous run finished. This floor alone
 * would have prevented the incident even if the unit suffix had parsed.
 */
export const MIN_INTERVAL_MS = 60_000;

/**
 * Ceiling for any interval schedule: one year. Two reasons, both real:
 *   - Nobody legitimately schedules a recurring task further out than a year;
 *     a bigger number is a typo or a nonsense unit combination.
 *   - The unit multiplier makes Date-range overflow reachable. "100000000d"
 *     multiplies out to 8_640_000_000_000_000 — still a safe integer, so the
 *     Number.isSafeInteger guards pass — but the maximum representable Date is
 *     exactly 8.64e15 ms from the epoch, so `new Date(Date.now() + ms)` is an
 *     Invalid Date and `.toISOString()` THROWS. In computeNextRun that throw
 *     lands outside any try/catch and before updateTaskAfterRun, so next_run is
 *     never written, the row stays due, and the scheduler re-enqueues it every
 *     poll — the same back-to-back runaway this parser exists to prevent.
 */
export const MAX_INTERVAL_MS = 365 * 86_400_000;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Bare integer, or integer + unit suffix. Nothing else, no trailing garbage. */
const INTERVAL_RE = /^(\d+)\s*(ms|s|m|h|d)?$/i;

/**
 * Parse an interval schedule value into milliseconds.
 *
 * Accepted forms (case-insensitive, surrounding whitespace ignored):
 *   - a bare integer count of MILLISECONDS: "21600000" (the existing contract)
 *   - an integer with a unit suffix: "500ms", "45s", "30m", "6h", "2d"
 *
 * The unit suffix is deliberate rather than merely tolerated: agents naturally
 * write "6h", and accepting it means every task already broken in the wild
 * SELF-HEALS to its intended period on the next deploy instead of erroring out
 * and needing manual repair.
 *
 * Returns null — never throws — for anything unparseable ("", "abc", "6hh",
 * "6 h x", "-5", "0", "1e3", non-string input) and for any positive value
 * outside [MIN_INTERVAL_MS, MAX_INTERVAL_MS].
 */
export function parseIntervalMs(value: string): number | null {
  if (typeof value !== 'string') return null;

  const match = INTERVAL_RE.exec(value.trim());
  if (!match) return null;

  const count = Number(match[1]);
  if (!Number.isSafeInteger(count) || count <= 0) return null;

  const ms = count * UNIT_MS[(match[2] || 'ms').toLowerCase()];
  if (!Number.isSafeInteger(ms)) return null;
  if (ms < MIN_INTERVAL_MS || ms > MAX_INTERVAL_MS) return null;

  return ms;
}
