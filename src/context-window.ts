import { NewMessage } from './types.js';

/**
 * Choose which messages to render into a newly-spawned container's prompt.
 *
 * A **resumed** session already carries every prior turn in its Claude
 * transcript, so the prompt only needs the new (since-cursor) messages — sending
 * more would be redundant and waste tokens.
 *
 * A **fresh** session (first run, or the session was cleared/expired) has no
 * memory at all: the since-cursor slice can be a single message, so the agent
 * can't resolve references like "this" / "that one" / "nominate one or multiple"
 * without the user replying to a specific message. For a fresh session we
 * backfill a rolling window of recent history (which already includes the
 * new messages) so the recent conversation is in context.
 *
 * Pure and deterministic so the fresh-vs-resume decision is unit-tested.
 *
 * @param hasSession   whether an existing session transcript will be resumed
 * @param sinceCursor  messages accumulated since the last agent run (chronological)
 * @param recentHistory the last N messages of the chat (chronological); only
 *                      meaningful for a fresh session — pass [] when resuming
 */
export function selectPromptMessages(
  hasSession: boolean,
  sinceCursor: NewMessage[],
  recentHistory: NewMessage[],
): NewMessage[] {
  if (hasSession) return sinceCursor;
  // Fresh session: use the richer history, but never fewer than the messages we
  // were about to send (guards against an empty/short backfill dropping the
  // very messages that triggered this turn).
  return recentHistory.length > sinceCursor.length
    ? recentHistory
    : sinceCursor;
}
