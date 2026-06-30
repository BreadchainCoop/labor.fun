#!/usr/bin/env tsx
/**
 * One-shot Slack-members sync.
 *
 * Usage:   npm run sync-slack-members
 *          (or: tsx scripts/sync-slack-members.ts)
 *
 * Reads SLACK_BOT_TOKEN and SHARED_KB_GROUP from the standard env path
 * (process.env first, the install's .env as fallback via readEnvFile).
 * Requires the bot's `users:read` + `users:read.email` scopes. See
 * src/integrations/slack-members-sync.ts for behavior + idempotency.
 */
import { runSlackMembersSync } from '../src/integrations/slack-members-sync.js';

async function main(): Promise<void> {
  const started = Date.now();
  const outcome = await runSlackMembersSync();
  const elapsedMs = Date.now() - started;
  console.log('---');
  console.log(`added:    ${outcome.added}`);
  console.log(`updated:  ${outcome.updated}`);
  console.log(`skipped:  ${outcome.skipped}`);
  console.log(`errors:   ${outcome.errors}`);
  console.log(`elapsed:  ${elapsedMs} ms`);
  process.exit(outcome.errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('sync-slack-members failed:', err);
  process.exit(1);
});
