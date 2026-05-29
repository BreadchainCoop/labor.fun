/**
 * kb-reindex evaluator.
 *
 * Keeps the FTS5 KB search index (src/kb-index.ts) fresh. A turn frequently
 * mutates the KB — the agent writes a new TASK file, updates a person, and
 * the request-log evaluator above appends a row. Re-indexing here means a
 * subsequent `searchKb()` reflects those edits immediately.
 *
 * Indexing is incremental (mtime-gated per file), so on turns that didn't
 * touch the KB this is just a directory walk + a handful of stats.
 */
import fs from 'fs';

import { reindexGroupKb, kbIndexAvailable } from '../kb-index.js';
import { logger } from '../logger.js';
import { EvaluatorContext, Evaluator } from './types.js';

export const kbReindexEvaluator: Evaluator = {
  name: 'kb-reindex',
  priority: 90, // after content-producing evaluators (e.g. request-log)

  validate(ctx: EvaluatorContext): boolean {
    return kbIndexAvailable() && fs.existsSync(ctx.contextDir);
  },

  async handler(ctx: EvaluatorContext): Promise<void> {
    const result = reindexGroupKb(ctx.group.folder, ctx.contextDir);
    if (result.indexed > 0 || result.removed > 0) {
      logger.debug(
        { group: ctx.group.folder, ...result },
        'kb-reindex: KB index updated',
      );
    }
  },
};
