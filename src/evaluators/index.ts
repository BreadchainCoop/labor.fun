/**
 * Evaluator registry + runner.
 *
 * Mirrors elizaOS's post-response evaluator pipeline: evaluators are sorted
 * by priority (lower first; name breaks ties), each is gated by validate(),
 * and handlers run sequentially with errors isolated so one failing evaluator
 * never blocks the others or the message loop.
 *
 * To add an evaluator: implement the Evaluator interface in a sibling file
 * and add it to DEFAULT_EVALUATORS below. See README.md in this directory.
 */
import { logger } from '../logger.js';
import { kbReindexEvaluator } from './kb-reindex.js';
import { requestLogEvaluator } from './request-log.js';
import { Evaluator, EvaluatorContext } from './types.js';

export type { Evaluator, EvaluatorContext } from './types.js';

/** Evaluators that run after every successful turn, in priority order. */
export const DEFAULT_EVALUATORS: Evaluator[] = [
  requestLogEvaluator,
  kbReindexEvaluator,
];

export interface RunEvaluatorsSummary {
  ran: string[];
  skipped: string[];
  failed: string[];
}

/**
 * Run the evaluator pipeline for one completed turn. Never throws — every
 * failure is caught and reported in the returned summary and the log.
 */
export async function runEvaluators(
  ctx: EvaluatorContext,
  evaluators: Evaluator[] = DEFAULT_EVALUATORS,
): Promise<RunEvaluatorsSummary> {
  const summary: RunEvaluatorsSummary = { ran: [], skipped: [], failed: [] };

  const sorted = [...evaluators].sort(
    (a, b) =>
      (a.priority ?? 100) - (b.priority ?? 100) || a.name.localeCompare(b.name),
  );

  for (const evaluator of sorted) {
    try {
      const ok = await evaluator.validate(ctx);
      if (!ok) {
        summary.skipped.push(evaluator.name);
        continue;
      }
      await evaluator.handler(ctx);
      summary.ran.push(evaluator.name);
    } catch (err) {
      summary.failed.push(evaluator.name);
      logger.warn(
        { err, evaluator: evaluator.name, group: ctx.group.folder },
        'Evaluator failed (isolated)',
      );
    }
  }

  return summary;
}
