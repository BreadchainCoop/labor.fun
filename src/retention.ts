/**
 * retention — opt-in message-retention sweeper (privacy toggle, layer 1).
 *
 * Bounds how long / how much chat content the SQLite messages table retains,
 * for sigstack-parity data retention (docs/TEE.md "Privacy posture"). OFF by
 * default: when MESSAGE_RETENTION_HOURS and MESSAGE_RETENTION_MAX_PER_CHAT are
 * both 0, startRetentionSweeper() is a true no-op (no timer is even created)
 * and behavior is byte-identical to today.
 *
 * The messages table is ALSO the queue driving the agent poller
 * (startMessageLoop → getNewMessages / getMessagesSince in src/index.ts), so
 * the sweeper must never delete a row the poller hasn't processed yet.
 *
 * SAFETY GUARD (composite — a row is deletable only when ALL hold):
 *   1. It is older than the retention window (age rule) OR beyond the newest-N
 *      per-chat cap (overflow rule) — whichever env var enables the rule.
 *   2. It is older than an absolute 1-hour floor: nothing from the last hour
 *      is EVER swept. This covers the startup-recovery window
 *      (recoverPendingMessages in src/index.ts runs first; the first sweep is
 *      additionally delayed ~1 min), in-flight batches between storeMessage
 *      and the 2s poll tick, and error-path cursor rollbacks mid-retry.
 *   3. For a REGISTERED group, it is at-or-below that chat's processed
 *      watermark — the persisted `last_agent_timestamp` cursor
 *      (router_state), falling back to the last bot reply's timestamp, which
 *      is EXACTLY the recovery rule the poller itself uses
 *      (getOrRecoverCursor). A registered chat with neither is skipped
 *      entirely (fail safe: everything there might still be owed to the
 *      agent). Unregistered chats have no poller owing them processing, so
 *      only rules 1–2 apply.
 *   4. It is at-or-below the chat's IN-FLIGHT FLOOR, if a run is currently
 *      dispatched for it. src/index.ts advances the persisted cursor at
 *      DISPATCH and rolls it back when the run errors without having sent
 *      output, so mid-run the persisted watermark over-reports what is truly
 *      processed. The floor (registerInFlightRetentionFloor, below) pins the
 *      pre-dispatch cursor for the lifetime of the run so a sweep firing
 *      mid-run cannot delete backlog a rollback would re-process. This closes
 *      the window guard 2's 1-hour floor does not cover (a retried batch can
 *      be arbitrarily old).
 *
 * Beyond `messages`, the sweep also age-prunes the two other content-bearing
 * tables — `agent_runs.trigger_content` (up to 500 chars of the trigger
 * message) and `assistant_events.question_text` — whenever the age rule is
 * enabled. Both are post-dispatch records that nothing reads back for
 * delivery, so they need no watermark/in-flight guard.
 *
 * VACUUM is intentionally NOT run: the DB uses SQLite's defaults (no WAL /
 * auto_vacuum configured in src/db.ts) and privileged agent containers mount
 * the store directory and may read messages.db concurrently — VACUUM needs an
 * exclusive lock and would block/fail against them. Deleted pages are simply
 * reused by SQLite, which is fine: under retention the table is size-bounded,
 * and in TEE-ephemeral mode the whole store is RAM-backed and wiped on
 * restart anyway.
 */

import {
  ASSISTANT_NAME,
  MESSAGE_RETENTION_HOURS,
  MESSAGE_RETENTION_MAX_PER_CHAT,
} from './config.js';
import {
  deleteAgentRunsBefore,
  deleteAssistantEventsBefore,
  deleteChatMessages,
  getAllRegisteredGroups,
  getLastBotMessageTimestamp,
  getMessageChatJids,
  getNthNewestMessageTimestamp,
  getRouterState,
} from './db.js';
import { logger } from './logger.js';

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly
const STARTUP_DELAY_MS = 60 * 1000; // let startup recovery enqueue first
const RECENT_FLOOR_MS = 60 * 60 * 1000; // never touch the last hour

/** Far-future ISO ceiling for chats with no watermark constraint. */
const NO_CEILING = '9999-12-31T23:59:59.999Z';

export interface RetentionSweepResult {
  deletedMessages: number;
  chatsSwept: number;
  deletedAgentRuns: number;
  deletedAssistantEvents: number;
}

// --- In-flight dispatch floor (guard 4 — see the module header) -------------
//
// chatJid → the cursor value as it stood BEFORE the currently dispatched run
// advanced it. In-process state only: it exists purely to make the sweeper and
// a same-process cursor rollback agree. A missing entry means "no run is
// holding a rollback claim on this chat", which is the state after a restart —
// and a restart also discards the rollback (recoverPendingMessages re-derives
// pending work from the persisted cursor), so the two stay consistent.
const inFlightFloors = new Map<string, string>();

/**
 * Pin a chat's retention ceiling to the pre-dispatch cursor for the duration
 * of a run. Call immediately after advancing `lastAgentTimestamp`; the caller
 * MUST pair it with clearInFlightRetentionFloor() on every exit path
 * (src/index.ts does this in processGroupMessages' finally, which wraps every
 * cursor-advancing dispatch path including chat flows and the pipe path).
 *
 * Lower-wins: a second advance within the same run (the message loop's pipe
 * path) can only keep the OLDER floor, never raise it. An empty string (no
 * prior cursor) therefore blocks deletion for that chat entirely while the run
 * is in flight — the safe direction, since a rollback to "" means the whole
 * backlog is owed.
 */
export function registerInFlightRetentionFloor(
  chatJid: string,
  preDispatchCursor: string,
): void {
  const existing = inFlightFloors.get(chatJid);
  if (existing === undefined || preDispatchCursor < existing) {
    inFlightFloors.set(chatJid, preDispatchCursor);
  }
}

/** Release a chat's in-flight floor (run finished — rollback window closed). */
export function clearInFlightRetentionFloor(chatJid: string): void {
  inFlightFloors.delete(chatJid);
}

/** The chat's in-flight floor, or undefined when no run holds one. */
export function getInFlightRetentionFloor(chatJid: string): string | undefined {
  return inFlightFloors.get(chatJid);
}

/**
 * One retention sweep over every chat holding messages. Pure DB work — safe
 * to call directly (tests) or from the timer. Parameters are explicit so
 * tests don't have to fake the env-derived config.
 */
export function runRetentionSweep(opts: {
  retentionHours: number;
  maxPerChat: number;
  now?: number;
}): RetentionSweepResult {
  const { retentionHours, maxPerChat } = opts;
  if (retentionHours <= 0 && maxPerChat <= 0) {
    return {
      deletedMessages: 0,
      chatsSwept: 0,
      deletedAgentRuns: 0,
      deletedAssistantEvents: 0,
    };
  }
  const now = opts.now ?? Date.now();
  const floorIso = new Date(now - RECENT_FLOOR_MS).toISOString();
  const ageCutoff =
    retentionHours > 0
      ? new Date(now - retentionHours * 60 * 60 * 1000).toISOString()
      : '';

  const registered = getAllRegisteredGroups();
  let watermarks: Record<string, string> = {};
  try {
    watermarks = JSON.parse(getRouterState('last_agent_timestamp') || '{}');
  } catch {
    watermarks = {}; // corrupted state → rely on the bot-reply fallback
  }

  let deletedMessages = 0;
  let chatsSwept = 0;
  for (const chatJid of getMessageChatJids()) {
    // Overflow rule: everything strictly older than the Nth-newest row is
    // beyond the cap (undefined when the chat holds fewer than N rows).
    const capCutoff =
      maxPerChat > 0
        ? (getNthNewestMessageTimestamp(chatJid, maxPerChat) ?? '')
        : '';
    // Union of the two delete rules = strictly older than the LATER cutoff.
    // (ISO-8601 UTC strings compare lexicographically, matching the string
    // comparisons the poller itself uses on these timestamps.)
    const base = ageCutoff > capCutoff ? ageCutoff : capCutoff;
    if (!base) continue;
    // Guard 2: absolute recent-history floor.
    const cutoff = base < floorIso ? base : floorIso;

    // Guard 3: processed watermark for registered groups (see module doc).
    let ceiling = NO_CEILING;
    if (registered[chatJid]) {
      const watermark =
        watermarks[chatJid] ||
        getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
      if (!watermark) continue; // never processed → everything may be owed
      ceiling = watermark;
    }

    // Guard 4: a dispatched run may still roll the cursor back to here.
    const inFlight = getInFlightRetentionFloor(chatJid);
    if (inFlight !== undefined && inFlight < ceiling) ceiling = inFlight;

    const deleted = deleteChatMessages(chatJid, cutoff, ceiling);
    if (deleted > 0) {
      deletedMessages += deleted;
      chatsSwept++;
    }
  }

  // Content-bearing side tables: age rule only (post-dispatch records — see
  // the module header). Same absolute recent-history floor as the messages.
  let deletedAgentRuns = 0;
  let deletedAssistantEvents = 0;
  if (ageCutoff) {
    const logCutoff = ageCutoff < floorIso ? ageCutoff : floorIso;
    deletedAgentRuns = deleteAgentRunsBefore(logCutoff);
    deletedAssistantEvents = deleteAssistantEventsBefore(logCutoff);
  }

  if (
    deletedMessages > 0 ||
    deletedAgentRuns > 0 ||
    deletedAssistantEvents > 0
  ) {
    // Counts only — NEVER message content (CVM logs can be public).
    logger.info(
      { deletedMessages, chatsSwept, deletedAgentRuns, deletedAssistantEvents },
      'retention: swept expired messages',
    );
  }
  return {
    deletedMessages,
    chatsSwept,
    deletedAgentRuns,
    deletedAssistantEvents,
  };
}

/**
 * Start the hourly retention sweeper. TRUE no-op (no timers created) when
 * both env knobs are 0/unset. The first sweep is delayed ~1 minute so the
 * startup recovery of unprocessed messages (recoverPendingMessages in
 * src/index.ts) runs first; the processed-watermark guard makes this a
 * belt-and-suspenders measure, not the safety mechanism itself.
 *
 * Returns the interval handle (null when disabled) for tests.
 */
export function startRetentionSweeper(): ReturnType<typeof setInterval> | null {
  if (MESSAGE_RETENTION_HOURS <= 0 && MESSAGE_RETENTION_MAX_PER_CHAT <= 0) {
    return null;
  }
  const sweep = () => {
    try {
      runRetentionSweep({
        retentionHours: MESSAGE_RETENTION_HOURS,
        maxPerChat: MESSAGE_RETENTION_MAX_PER_CHAT,
      });
    } catch (err) {
      logger.error({ err }, 'retention: sweep failed');
    }
  };
  logger.info(
    {
      retentionHours: MESSAGE_RETENTION_HOURS,
      maxPerChat: MESSAGE_RETENTION_MAX_PER_CHAT,
    },
    'retention: sweeper enabled',
  );
  setTimeout(sweep, STARTUP_DELAY_MS).unref?.();
  const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
