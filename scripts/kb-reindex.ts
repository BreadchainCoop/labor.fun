/**
 * Host CLI: rebuild the KB full-text search index for all registered groups.
 *
 *   npm run kb-reindex
 *
 * Useful after bulk-editing KB files on the droplet, or to seed the index on
 * first deploy. Indexing is incremental, so re-running is cheap.
 */
import { initDatabase } from '../src/db.js';
import { reindexAllGroups } from '../src/kb-index.js';
import { logger } from '../src/logger.js';

initDatabase();
const result = reindexAllGroups();
logger.info(result, 'KB reindex complete');
// eslint-disable-next-line no-console
console.log(
  `KB reindex: ${result.indexed} indexed, ${result.skipped} unchanged, ${result.removed} removed`,
);
