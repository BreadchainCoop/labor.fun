/**
 * Generalized escalating-deadline reminder engine (#25).
 *
 * A single primitive any deadline-bearing item plugs into. Each item declares a
 * `deadline`, `owners`, and an optional `escalationContact`. A periodic sweep
 * walks the items and fires reminders on an escalation ladder whose cadence
 * tightens as the deadline approaches (default T-3w → T-1w → T-3d → T-1d). The
 * closest rung is the "final tick" that loops in the escalation contact; once
 * the deadline passes an OVERDUE rung escalates again. Items whose status is
 * already done/ready are skipped entirely.
 *
 * Idempotency lives in SQLite (`reminder_log`, keyed by item + rung), so the
 * sweep can run as often as it likes and each rung is sent at most once. The
 * ladder decision (`selectRung`) is a pure function of `now` vs the deadline so
 * it can be table-tested with literal timestamps.
 *
 * The first consumer is KB tasks (see src/kb-task-source.ts); the engine itself
 * is source-agnostic — any caller that yields `DeadlineItem`s reuses it.
 */

import { logger } from './logger.js';
import {
  hasReminderFired,
  recordReminderFired,
  resetRemindersOnDeadlineChange,
} from './db.js';

/** A deadline-bearing work item the engine can remind about. */
export interface DeadlineItem {
  /** Stable id, e.g. "TASK-001". Used as the dedup key in reminder_log. */
  id: string;
  title: string;
  /** ISO date or datetime. Items with an unparseable deadline are skipped. */
  deadline: string;
  owners: string[];
  /** Optional per-item escalation contact; falls back to the engine default. */
  escalationContact?: string;
  /** Source status (KB enum); done/ready/cancelled statuses suppress reminders. */
  status?: string;
  /** Optional human-facing reference for the digest (file path / URL). */
  ref?: string;
}

export interface LadderRung {
  label: string;
  ms: number;
}

export interface RungDecision {
  /** Ladder label (the duration spec, or 'OVERDUE'). */
  rung: string;
  kind: 'reminder' | 'escalation';
}

const DONE_STATUSES = new Set([
  'done',
  'completed',
  'complete',
  'cancelled',
  'canceled',
  'ready',
  'closed',
]);

/** Whether a status counts as "no longer needs reminding". */
export function isDoneStatus(status?: string): boolean {
  return !!status && DONE_STATUSES.has(status.trim().toLowerCase());
}

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parse a duration spec like "3w" / "1d" / "12h" / "30m" into milliseconds.
 * Returns 0 for anything unparseable so callers can filter it out.
 */
export function parseDurationToMs(spec: string): number {
  const m = /^(\d+)\s*([mhdw])$/.exec(spec.trim().toLowerCase());
  if (!m) return 0;
  return parseInt(m[1], 10) * UNIT_MS[m[2]];
}

/** Parse + normalize a ladder spec list into ascending-by-ms rungs. */
export function parseLadder(specs: string[]): LadderRung[] {
  return specs
    .map((s) => ({
      // Canonicalize the label (lowercased, trimmed) so it matches the parser
      // and stays stable as the dedup key in reminder_log — e.g. editing
      // REMINDER_LADDER from `1D` to `1d` must not be seen as a new rung.
      label: s.trim().toLowerCase(),
      ms: parseDurationToMs(s),
    }))
    .filter((r) => r.ms > 0)
    .sort((a, b) => a.ms - b.ms);
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a deadline string to epoch ms. A bare `YYYY-MM-DD` is treated as the
 * END of that day (23:59:59.999 UTC), so a task "due 2026-07-01" only goes
 * overdue once the 1st has fully passed — not at 00:00 when `Date.parse` would
 * otherwise place it. Full datetimes are parsed as given. Returns NaN for
 * unparseable input.
 */
export function parseDeadline(deadline: string): number {
  const s = deadline.trim();
  if (DATE_ONLY_RE.test(s)) return Date.parse(`${s}T23:59:59.999Z`);
  return Date.parse(s);
}

/**
 * Decide which ladder rung (if any) is currently due for an item.
 *
 * Pure: takes `now` and the deadline as epoch ms. Returns the single
 * most-urgent eligible rung, never a backlog — a freshly-added item that's
 * already past several rungs fires once at its current urgency, then escalates
 * on later ticks, instead of emitting a burst of stale reminders. The dedup
 * table upstream keeps each rung to one send.
 *
 * - done items → null (nothing to remind).
 * - deadline passed → OVERDUE escalation.
 * - within the closest ladder rung → that rung as an escalation (final tick:
 *   loops in the escalation contact).
 * - within a wider rung → that rung as a normal owner reminder.
 * - deadline still further out than the widest rung → null.
 */
export function selectRung(
  nowMs: number,
  deadlineMs: number,
  ladder: LadderRung[],
  isDone: boolean,
): RungDecision | null {
  if (isDone) return null;
  if (ladder.length === 0) return null;
  const msUntil = deadlineMs - nowMs;
  if (msUntil <= 0) return { rung: 'OVERDUE', kind: 'escalation' };
  // Ladder is ascending by ms; the first rung whose window contains msUntil is
  // the most urgent eligible one.
  const rung = ladder.find((r) => msUntil <= r.ms);
  if (!rung) return null;
  const isFinal = rung.label === ladder[0].label;
  return { rung: rung.label, kind: isFinal ? 'escalation' : 'reminder' };
}

function formatDaysLeft(nowMs: number, deadlineMs: number): string {
  const ms = deadlineMs - nowMs;
  if (ms <= 0) {
    const overdueDays = Math.ceil(-ms / UNIT_MS.d);
    return overdueDays <= 0 ? 'due today' : `${overdueDays}d overdue`;
  }
  const days = Math.ceil(ms / UNIT_MS.d);
  return days === 1 ? 'due tomorrow' : `due in ${days}d`;
}

/** Build the reminder message text for an item + decision. */
export function formatReminderMessage(
  item: DeadlineItem,
  decision: RungDecision,
  nowMs: number,
  deadlineMs: number,
  escalationContact?: string,
): string {
  const when = formatDaysLeft(nowMs, deadlineMs);
  const owners = item.owners.length ? item.owners.join(', ') : 'unassigned';
  const deadlineLabel = item.deadline;
  if (decision.kind === 'escalation') {
    const contact = item.escalationContact || escalationContact;
    const ccLine = contact ? `\nEscalation: ${contact}` : '';
    const head =
      decision.rung === 'OVERDUE'
        ? `🚨 *Overdue:* ${item.id} — ${item.title}`
        : `⚠️ *Deadline imminent:* ${item.id} — ${item.title}`;
    return `${head}\nDue ${deadlineLabel} (${when})\nOwners: ${owners}${ccLine}`;
  }
  return `⏰ *Reminder:* ${item.id} — ${item.title}\nDue ${deadlineLabel} (${when})\nOwners: ${owners}`;
}

// --- Digest ("everything with a deadline", by week + by owner) ---

function startOfWeek(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  // ISO week starts Monday (getUTCDay: 0=Sun..6=Sat).
  const day = (x.getUTCDay() + 6) % 7;
  x.setUTCDate(x.getUTCDate() - day);
  return x;
}

function weekBucket(nowMs: number, deadlineMs: number): string {
  if (deadlineMs < nowMs) return 'Overdue';
  const thisWeek = startOfWeek(new Date(nowMs)).getTime();
  const nextWeek = thisWeek + UNIT_MS.w;
  const weekAfter = nextWeek + UNIT_MS.w;
  if (deadlineMs < nextWeek) return 'This week';
  if (deadlineMs < weekAfter) return 'Next week';
  return 'Later';
}

const WEEK_ORDER = ['Overdue', 'This week', 'Next week', 'Later'];

/** Build a markdown digest grouped by week and by owner. Pure. */
export function buildDeadlineDigest(
  items: DeadlineItem[],
  nowMs: number,
): string {
  const dated = items
    .map((it) => ({ it, ms: parseDeadline(it.deadline) }))
    .filter((x) => !Number.isNaN(x.ms))
    .sort((a, b) => a.ms - b.ms);

  const lines: string[] = [
    '# Deadlines',
    '',
    `_Updated ${new Date(nowMs).toISOString()} • ${dated.length} item(s) with a deadline._`,
    '',
    '## By week',
    '',
  ];

  const byWeek = new Map<string, typeof dated>();
  for (const x of dated) {
    const bucket = weekBucket(nowMs, x.ms);
    const arr = byWeek.get(bucket) || [];
    arr.push(x);
    byWeek.set(bucket, arr);
  }
  for (const bucket of WEEK_ORDER) {
    const arr = byWeek.get(bucket);
    if (!arr || arr.length === 0) continue;
    lines.push(`### ${bucket}`, '');
    for (const { it } of arr) {
      const owners = it.owners.length ? it.owners.join(', ') : 'unassigned';
      const done = isDoneStatus(it.status) ? ' ✅' : '';
      lines.push(`- ${it.deadline} — ${it.id} ${it.title} (${owners})${done}`);
    }
    lines.push('');
  }

  lines.push('## By owner', '');
  const byOwner = new Map<string, typeof dated>();
  for (const x of dated) {
    const owners = x.it.owners.length ? x.it.owners : ['unassigned'];
    for (const owner of owners) {
      const arr = byOwner.get(owner) || [];
      arr.push(x);
      byOwner.set(owner, arr);
    }
  }
  for (const owner of [...byOwner.keys()].sort()) {
    lines.push(`### ${owner}`, '');
    for (const { it, ms } of byOwner.get(owner)!) {
      const done = isDoneStatus(it.status) ? ' ✅' : '';
      lines.push(
        `- ${it.deadline} — ${it.id} ${it.title} (${formatDaysLeft(nowMs, ms)})${done}`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

// --- Sweep ---

export interface ReminderSweepInput {
  nowMs: number;
  items: DeadlineItem[];
  ladder: LadderRung[];
  targetJid: string | null;
  escalationDefault?: string;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

export interface ReminderSweepResult {
  checked: number;
  fired: number;
}

/**
 * One pass over the items: fire any due-and-not-yet-sent rung. Idempotent via
 * the reminder_log table; safe to run repeatedly.
 */
export async function runReminderSweep(
  input: ReminderSweepInput,
): Promise<ReminderSweepResult> {
  const { nowMs, items, ladder, targetJid, escalationDefault, sendMessage } =
    input;
  let fired = 0;
  let checked = 0;

  for (const item of items) {
    const deadlineMs = parseDeadline(item.deadline);
    if (Number.isNaN(deadlineMs)) {
      logger.debug(
        { itemId: item.id, deadline: item.deadline },
        'Reminder: skipping item with unparseable deadline',
      );
      continue;
    }
    checked++;

    // A moved deadline resets the item's fired rungs so the new schedule fires.
    resetRemindersOnDeadlineChange(item.id, item.deadline);

    const decision = selectRung(
      nowMs,
      deadlineMs,
      ladder,
      isDoneStatus(item.status),
    );
    if (!decision) continue;
    if (hasReminderFired(item.id, decision.rung)) continue;

    if (!targetJid) {
      logger.warn(
        { itemId: item.id, rung: decision.rung },
        'Reminder due but no target JID resolved — not sending (will retry)',
      );
      continue;
    }

    const text = formatReminderMessage(
      item,
      decision,
      nowMs,
      deadlineMs,
      escalationDefault,
    );
    try {
      await sendMessage(targetJid, text);
      recordReminderFired(item.id, decision.rung, item.deadline);
      fired++;
      logger.info(
        { itemId: item.id, rung: decision.rung, kind: decision.kind },
        'Reminder sent',
      );
    } catch (err) {
      // Don't record on failure so the next sweep retries this rung.
      logger.error(
        { itemId: item.id, rung: decision.rung, err },
        'Reminder send failed — will retry next sweep',
      );
    }
  }

  return { checked, fired };
}

// --- Background loop ---

export interface ReminderEngineDeps {
  /** Deliver a reminder to a chat JID. */
  sendMessage: (jid: string, text: string) => Promise<void>;
  /** Resolve the delivery target lazily (groups may register after startup). */
  resolveTargetJid: () => string | null;
  /** Load the current deadline-bearing items. */
  loadItems: () => DeadlineItem[];
  /** Persist the digest markdown (optional; e.g. write to the shared KB). */
  writeDigest?: (markdown: string) => void;
  /**
   * Ladder specs (e.g. `['3w','1w','3d','1d']`). Required to do anything — an
   * empty/missing list disables the engine. The caller supplies the default
   * (the orchestrator passes config `REMINDER_LADDER`); the engine has no
   * config of its own.
   */
  ladderSpecs?: string[];
  /** Org-wide fallback escalation contact. */
  escalationDefault?: string;
  /** Sweep cadence in ms; <= 0 disables the engine. */
  intervalMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

let loopRunning = false;
let loopTimer: NodeJS.Timeout | null = null;
let tickInFlight = false;

/**
 * Run a single sweep + digest write. Exposed so the loop and tests share one
 * path; pulls live items/target each call so it reflects current state.
 */
export async function runReminderTick(
  deps: ReminderEngineDeps,
): Promise<ReminderSweepResult> {
  const nowMs = (deps.now ?? Date.now)();
  const ladder = parseLadder(deps.ladderSpecs ?? []);
  const items = deps.loadItems();
  const result = await runReminderSweep({
    nowMs,
    items,
    ladder,
    targetJid: deps.resolveTargetJid(),
    escalationDefault: deps.escalationDefault,
    sendMessage: deps.sendMessage,
  });
  if (deps.writeDigest) {
    try {
      deps.writeDigest(buildDeadlineDigest(items, nowMs));
    } catch (err) {
      logger.warn({ err }, 'Reminder: failed to write deadline digest');
    }
  }
  return result;
}

export function startReminderEngine(deps: ReminderEngineDeps): void {
  if (loopRunning) {
    logger.debug('Reminder engine already running');
    return;
  }
  const interval = deps.intervalMs ?? 0;
  if (interval <= 0) {
    logger.info('Reminder engine disabled (interval=0)');
    return;
  }
  if (!deps.ladderSpecs || parseLadder(deps.ladderSpecs).length === 0) {
    logger.info('Reminder engine disabled (empty ladder)');
    return;
  }
  loopRunning = true;

  const tick = async () => {
    // Serialize sweeps: if a slow sweep overruns the interval, skip the
    // overlapping tick rather than running two concurrently — concurrent
    // sweeps could both see hasReminderFired()===false for the same rung
    // before either records it, double-sending a reminder.
    if (tickInFlight) {
      logger.debug('Reminder sweep already in flight — skipping this tick');
      return;
    }
    tickInFlight = true;
    try {
      const result = await runReminderTick(deps);
      logger.info(
        { checked: result.checked, fired: result.fired },
        'Reminder sweep complete',
      );
    } catch (err) {
      logger.error({ err }, 'Reminder sweep failed');
    } finally {
      tickInFlight = false;
    }
  };

  logger.info(
    { intervalMs: interval, ladder: deps.ladderSpecs },
    'Reminder engine started',
  );
  void tick();
  loopTimer = setInterval(tick, interval);
  loopTimer.unref?.();
}

export function stopReminderEngine(): void {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
  loopRunning = false;
  tickInFlight = false;
}

/** @internal - for tests only. */
export function _resetReminderLoopForTests(): void {
  stopReminderEngine();
}
