#!/usr/bin/env tsx
/**
 * One-shot Discord-members sync.
 *
 * Usage:   npm run sync-discord-members
 *          (or: tsx scripts/sync-discord-members.ts)
 *
 * Reads DISCORD_BOT_TOKEN, DISCORD_DM_ALLOWED_GUILD_IDS,
 * DISCORD_DM_ALLOWED_ROLE_IDS, SHARED_KB_GROUP from the standard env path
 * (process.env first, /opt/breadbrich/.env as fallback via readEnvFile).
 * See src/integrations/discord-members-sync.ts for behavior + idempotency
 * guarantees.
 */
import { runDiscordMembersSync } from '../src/integrations/discord-members-sync.js';

async function main(): Promise<void> {
  const started = Date.now();
  const outcome = await runDiscordMembersSync();
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
  console.error('sync-discord-members failed:', err);
  process.exit(1);
});
