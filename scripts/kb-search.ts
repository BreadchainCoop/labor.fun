/**
 * Host CLI: ranked keyword search over the KB index.
 *
 *   npm run kb-search -- "who manages the treasury"
 *   npm run kb-search -- --group slack_main "shape rotator event"
 *
 * Prints the top matches with their source file and a highlighted snippet.
 */
import { initDatabase } from '../src/db.js';
import { searchKb } from '../src/kb-index.js';

const argv = process.argv.slice(2);
let groupFolder: string | undefined;
const terms: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--group') {
    groupFolder = argv[++i];
  } else {
    terms.push(argv[i]);
  }
}

const query = terms.join(' ').trim();
if (!query) {
  // eslint-disable-next-line no-console
  console.error('Usage: npm run kb-search -- [--group <folder>] <query>');
  process.exit(1);
}

initDatabase();
const results = searchKb(query, { groupFolder, limit: 10 });

if (results.length === 0) {
  // eslint-disable-next-line no-console
  console.log('No matches.');
} else {
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(
      `\n[${r.groupFolder}] ${r.sourcePath}${r.heading ? ` › ${r.heading}` : ''}\n  ${r.snippet}`,
    );
  }
}
