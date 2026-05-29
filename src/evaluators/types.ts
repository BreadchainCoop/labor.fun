/**
 * Post-turn evaluators.
 *
 * Lifted from elizaOS's evaluator concept: a small, declarative unit that
 * runs AFTER the agent has responded and performs follow-up bookkeeping on
 * the conversation — extracting facts, updating summaries, logging, indexing.
 *
 * In Eliza these are `{ name, validate, handler }` objects sorted by priority
 * and run sequentially with errors isolated. We adopt the same shape here so
 * behaviour that the rules currently ask the *agent* to remember (e.g. the
 * mandatory request log) can instead be enforced deterministically by the
 * orchestrator, regardless of what the model did inside the container.
 *
 * Evaluators run in the host orchestrator process (not the container), so
 * they have direct filesystem + DB access and never spend API credits.
 */
import { NewMessage, RegisteredGroup } from '../types.js';

export interface EvaluatorContext {
  /** The group whose turn just completed. */
  group: RegisteredGroup;
  chatJid: string;
  /** Routing channel: 'slack' | 'telegram' | 'discord' | 'unknown'. */
  channel: string;
  /** The user messages that triggered this turn (oldest → newest). */
  userMessages: NewMessage[];
  /** Concatenated agent output that was actually sent to the user. */
  responseText: string;
  /** Absolute path to the group's folder (groups/<folder>). */
  groupDir: string;
  /** Absolute path to the group's KB context dir (may not exist yet). */
  contextDir: string;
  /** agent_runs row id for this turn, for correlation. */
  runId: number;
  /** ISO timestamp captured when the turn completed. */
  timestamp: string;
}

export interface Evaluator {
  /** Stable identifier, used in logs and ordering tiebreaks. */
  name: string;
  /** Lower runs first. Defaults to 100 when omitted (Eliza convention). */
  priority?: number;
  /** Cheap gate: return false to skip handler() for this turn. */
  validate(ctx: EvaluatorContext): boolean | Promise<boolean>;
  /** Side-effecting follow-up work. Throwing is isolated and logged. */
  handler(ctx: EvaluatorContext): Promise<void>;
}
