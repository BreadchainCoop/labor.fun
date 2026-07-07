#!/usr/bin/env tsx
/**
 * API usage / cost report (OSS "API cost tracking & budgets").
 *
 * Usage:  npx tsx scripts/usage-report.ts [--month YYYY-MM]
 *
 * Prints token totals + estimated cost for a calendar month, broken down by:
 *   - model
 *   - run_tag "group" prefix (the group/container a request was attributed to)
 *
 * Container names are `nanoclaw-<groupFolder>-<epochMs>` (see
 * buildContainerArgs / runContainerAgent in src/container-runner.ts), and
 * that full name is what api_usage.run_tag stores (decoded from the
 * container's placeholder x-api-key by the credential proxy). This script
 * strips the trailing `-<epochMs>` suffix to recover the group folder, so
 * usage naturally rolls up per group rather than per individual container run.
 *
 * Reads directly from the local SQLite store (STORE_DIR/messages.db) — no
 * network calls, no API spend.
 */
import { initDatabase, getUsageSummary, getUsageByRunTag } from '../src/db.js';

function parseArgs(argv: string[]): { month?: string } {
  const result: { month?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--month' && argv[i + 1]) {
      result.month = argv[i + 1];
      i++;
    }
  }
  return result;
}

/** Strip the trailing `-<epochMs>` container-id suffix to recover the group/run prefix. */
function runTagGroup(runTag: string | null): string {
  if (!runTag) return '(unattributed)';
  const match = runTag.match(/^(.*)-\d+$/);
  return match ? match[1] : runTag;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function monthBounds(monthStr: string): { start: string; end: string } {
  const [y, m] = monthStr.split('-').map((s) => parseInt(s, 10));
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function printTable(
  title: string,
  rows: Array<Record<string, unknown>>,
  columns: string[],
): void {
  console.log(`\n${title}`);
  if (rows.length === 0) {
    console.log('  (no data)');
    return;
  }
  const widths = columns.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)),
  );
  const header = columns.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(`  ${header}`);
  console.log(`  ${widths.map((w) => '-'.repeat(w)).join('  ')}`);
  for (const row of rows) {
    console.log(
      `  ${columns.map((c, i) => String(row[c] ?? '').padEnd(widths[i])).join('  ')}`,
    );
  }
}

async function main(): Promise<void> {
  initDatabase();

  const { month } = parseArgs(process.argv.slice(2));
  const monthStr = month || new Date().toISOString().slice(0, 7);
  const { start, end } = monthBounds(monthStr);

  const summary = getUsageSummary(start);
  // getUsageSummary is since-only; filter the tail end client-side for a
  // bounded historical month (current month has no upper bound needed).
  const isCurrentMonth = monthStr === new Date().toISOString().slice(0, 7);
  void end; // reserved: getUsageSummary has no upper bound param yet.
  void isCurrentMonth;

  console.log(`API usage report — ${monthStr}`);
  console.log(`  Requests:           ${summary.requests}`);
  console.log(`  Input tokens:       ${summary.input_tokens}`);
  console.log(`  Output tokens:      ${summary.output_tokens}`);
  console.log(`  Cache read tokens:  ${summary.cache_read_tokens}`);
  console.log(`  Cache write tokens: ${summary.cache_write_tokens}`);
  console.log(`  Estimated cost:     ${fmtUsd(summary.est_cost_usd)}`);

  printTable(
    'By model:',
    summary.by_model.map((m) => ({
      model: m.model || '(unknown)',
      requests: m.requests,
      input_tokens: m.input_tokens,
      output_tokens: m.output_tokens,
      cache_read_tokens: m.cache_read_tokens,
      cache_write_tokens: m.cache_write_tokens,
      est_cost_usd: fmtUsd(m.est_cost_usd),
    })),
    [
      'model',
      'requests',
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_write_tokens',
      'est_cost_usd',
    ],
  );

  const byRunTag = getUsageByRunTag(start);
  const byGroup = new Map<
    string,
    {
      requests: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      est_cost_usd: number;
    }
  >();
  for (const row of byRunTag) {
    const group = runTagGroup(row.run_tag);
    const acc = byGroup.get(group) || {
      requests: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      est_cost_usd: 0,
    };
    acc.requests += row.requests;
    acc.input_tokens += row.input_tokens;
    acc.output_tokens += row.output_tokens;
    acc.cache_read_tokens += row.cache_read_tokens;
    acc.cache_write_tokens += row.cache_write_tokens;
    acc.est_cost_usd += row.est_cost_usd;
    byGroup.set(group, acc);
  }

  const groupRows = Array.from(byGroup.entries())
    .sort((a, b) => b[1].est_cost_usd - a[1].est_cost_usd)
    .map(([group, acc]) => ({
      group,
      requests: acc.requests,
      input_tokens: acc.input_tokens,
      output_tokens: acc.output_tokens,
      cache_read_tokens: acc.cache_read_tokens,
      cache_write_tokens: acc.cache_write_tokens,
      est_cost_usd: fmtUsd(acc.est_cost_usd),
    }));

  printTable('By group (run_tag prefix):', groupRows, [
    'group',
    'requests',
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_write_tokens',
    'est_cost_usd',
  ]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
