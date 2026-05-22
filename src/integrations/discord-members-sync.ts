/**
 * Discord-members → KB people sync.
 *
 * Reads the bot's Discord guild membership, filters to anyone holding one
 * of the DISCORD_DM_ALLOWED_ROLE_IDS roles, and ensures each match has:
 *
 *   1. A people file under `groups/<SHARED_KB_GROUP>/context/people/<slug>.md`
 *      with Discord-identifying frontmatter merged in (existing body and
 *      non-Discord frontmatter fields are preserved).
 *   2. A `user_identities` row binding their Discord user id to the
 *      `<slug>` so the orchestrator's `getKbPersonByPlatformId(...)` can
 *      resolve "who is this Discord message from?".
 *
 * Idempotent: re-runs only refresh Discord ID / username / display name /
 * roles / last_synced_at; everything else is untouched.
 *
 * Designed to run as a one-shot (`scripts/sync-discord-members.ts`) or
 * later as part of a periodic loop alongside the DM-allowlist refresh.
 *
 * Intent footprint: the orchestrator's main Discord client does NOT
 * request `GuildMembers` (a privileged intent), so this sync uses its
 * own short-lived client which DOES request it. The bot user must have
 * "Server Members Intent" enabled in the Discord Developer Portal.
 */

import fs from 'fs';
import path from 'path';

import matter from 'gray-matter';
import { Client, GatewayIntentBits, GuildMember, Partials } from 'discord.js';

import {
  DISCORD_DM_ALLOWED_GUILD_IDS,
  DISCORD_DM_ALLOWED_ROLE_IDS,
  DISCORD_MEMBERS_SYNC_INTERVAL_MS,
  GROUPS_DIR,
  SHARED_KB_GROUP,
} from '../config.js';
import { initDatabase } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { addIdentity, resolveUser } from '../permissions.js';

/** Lowercase, hyphenate, strip ascii control + non-alnum. Stable & idempotent. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Choose the people-file slug for a Discord user.
 *
 * - If `user_identities` already binds this Discord id to a kb_person,
 *   return that slug — keeps the file stable across display-name changes.
 * - Else slugify the display name. If a file at `<base>.md` already exists
 *   AND its frontmatter `discord_id` differs from ours, deconflict with
 *   `<base>-2`, `<base>-3`, ... until we find a free filename or one that
 *   already belongs to us.
 *
 * `fileExists` / `readDiscordId` are injected for testability.
 */
export function chooseSlug(opts: {
  discordId: string;
  displayName: string;
  username: string;
  existingKbPerson: string | null;
  fileExists: (slug: string) => boolean;
  readDiscordId: (slug: string) => string | null;
}): string {
  if (opts.existingKbPerson) return opts.existingKbPerson;
  const base =
    slugify(opts.displayName) ||
    slugify(opts.username) ||
    `user-${opts.discordId.slice(-6)}`;
  let candidate = base;
  let n = 2;
  while (opts.fileExists(candidate)) {
    const owner = opts.readDiscordId(candidate);
    if (owner === opts.discordId) return candidate; // already ours — reuse
    candidate = `${base}-${n}`;
    n++;
    if (n > 1000) {
      throw new Error(
        `slug deconflict runaway for base="${base}" discordId=${opts.discordId}`,
      );
    }
  }
  return candidate;
}

interface DiscordMemberFields {
  discord_id: string;
  discord_username: string;
  discord_display_name: string;
  discord_roles: string[];
  last_synced_at: string;
}

/**
 * Merge Discord-derived fields into existing frontmatter. Discord fields
 * always overwrite; any pre-existing non-Discord field is preserved. Sets
 * `created_by: discord-sync` and `visibility: private` only when those keys
 * are absent (so a human override survives re-syncs). Adds the
 * `discord-synced` tag if not already present.
 */
export function mergeFrontmatter(
  existing: Record<string, unknown> | null,
  discord: DiscordMemberFields,
  displayName: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(existing ?? {}) };
  // Title defaults to display name only when absent — preserves a manual
  // rename like "Josh (Treasurer)".
  if (out.title === undefined || out.title === '') out.title = displayName;
  if (out.created_by === undefined) out.created_by = 'discord-sync';
  if (out.visibility === undefined) out.visibility = 'private';
  // Tags: keep existing, ensure 'discord-synced' is present.
  const tags = Array.isArray(out.tags) ? [...out.tags] : [];
  if (!tags.includes('discord-synced')) tags.push('discord-synced');
  out.tags = tags;
  // Discord fields — always refresh.
  out.discord_id = discord.discord_id;
  out.discord_username = discord.discord_username;
  out.discord_display_name = discord.discord_display_name;
  out.discord_roles = discord.discord_roles;
  out.last_synced_at = discord.last_synced_at;
  return out;
}

/** Build the default body for a brand-new people file. */
export function defaultPersonBody(d: DiscordMemberFields): string {
  return [
    `Discord ID: ${d.discord_id}`,
    `Discord Username: @${d.discord_username}`,
    '',
    '<!-- Add notes about this person below. Re-running the Discord sync',
    '     refreshes the frontmatter only — your edits below are preserved. -->',
    '',
  ].join('\n');
}

function peopleDir(): string {
  return path.join(GROUPS_DIR, SHARED_KB_GROUP, 'context', 'people');
}

/** Read existing discord_id from a people file (if it exists). */
function readDiscordIdFromFile(slug: string): string | null {
  const file = path.join(peopleDir(), `${slug}.md`);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = matter(fs.readFileSync(file, 'utf-8'));
    const id = (parsed.data as { discord_id?: unknown }).discord_id;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

function fileExistsAtSlug(slug: string): boolean {
  return fs.existsSync(path.join(peopleDir(), `${slug}.md`));
}

interface SyncOutcome {
  added: number;
  updated: number;
  skipped: number;
  errors: number;
}

/** Write or refresh one person's KB file. Returns 'added' | 'updated' | 'skipped'. */
function writePersonFile(
  slug: string,
  discord: DiscordMemberFields,
  displayName: string,
): 'added' | 'updated' {
  const file = path.join(peopleDir(), `${slug}.md`);
  fs.mkdirSync(peopleDir(), { recursive: true });
  let existing: Record<string, unknown> | null = null;
  let body: string = defaultPersonBody(discord);
  let isNew = true;
  if (fs.existsSync(file)) {
    isNew = false;
    const parsed = matter(fs.readFileSync(file, 'utf-8'));
    existing = parsed.data as Record<string, unknown>;
    body = parsed.content.replace(/^\n+/, '');
  }
  const fm = mergeFrontmatter(existing, discord, displayName);
  const serialized = matter.stringify(body, fm);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, serialized);
  fs.renameSync(tmp, file);
  return isNew ? 'added' : 'updated';
}

function selectAllowedMembers(
  members: Iterable<GuildMember>,
  allowedRoleIds: Set<string>,
): GuildMember[] {
  const out: GuildMember[] = [];
  for (const m of members) {
    if (m.user.bot) continue;
    for (const roleId of m.roles.cache.keys()) {
      if (allowedRoleIds.has(roleId)) {
        out.push(m);
        break;
      }
    }
  }
  return out;
}

/**
 * Run one pass of the Discord-members sync. Returns counts. Throws on
 * fatal errors (missing token, no guilds resolvable); per-member errors
 * are logged and counted as `errors`.
 */
export async function runDiscordMembersSync(): Promise<SyncOutcome> {
  const env = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token = process.env.DISCORD_BOT_TOKEN || env.DISCORD_BOT_TOKEN || '';
  if (!token) {
    throw new Error('DISCORD_BOT_TOKEN is not set');
  }
  if (DISCORD_DM_ALLOWED_ROLE_IDS.length === 0) {
    throw new Error(
      'DISCORD_DM_ALLOWED_ROLE_IDS is empty — no allowlist roles configured',
    );
  }

  initDatabase();
  fs.mkdirSync(peopleDir(), { recursive: true });

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    partials: [Partials.GuildMember],
  });

  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve());
    client.once('error', reject);
    client.login(token).catch(reject);
  });

  const outcome: SyncOutcome = { added: 0, updated: 0, skipped: 0, errors: 0 };
  const allowedRoleSet = new Set(DISCORD_DM_ALLOWED_ROLE_IDS);
  type GuildEntry = NonNullable<ReturnType<typeof client.guilds.cache.get>>;
  let guildsToScan: GuildEntry[];
  if (DISCORD_DM_ALLOWED_GUILD_IDS.length > 0) {
    const found: GuildEntry[] = [];
    const missing: string[] = [];
    for (const id of DISCORD_DM_ALLOWED_GUILD_IDS) {
      const g = client.guilds.cache.get(id);
      if (g) found.push(g);
      else missing.push(id);
    }
    if (missing.length > 0) {
      logger.warn(
        {
          missing,
          configured: DISCORD_DM_ALLOWED_GUILD_IDS,
          found: found.length,
        },
        'discord-members-sync: configured guild IDs not visible to the bot — check invites + intent',
      );
    }
    if (found.length === 0) {
      client.destroy();
      throw new Error(
        `DISCORD_DM_ALLOWED_GUILD_IDS resolved to zero guilds. ` +
          `Configured: [${DISCORD_DM_ALLOWED_GUILD_IDS.join(', ')}]. ` +
          `Bot must be invited to at least one of these.`,
      );
    }
    guildsToScan = found;
  } else {
    guildsToScan = [...client.guilds.cache.values()];
  }

  const syncedAt = new Date().toISOString();
  // Dedupe on Discord ID — the source of truth. A member visible in
  // multiple guilds the bot shares would otherwise be written twice.
  // (chooseSlug's deconflict makes same-slug-different-id impossible, so
  // this is the right key.)
  const seenDiscordIds = new Set<string>();

  for (const guild of guildsToScan) {
    let members;
    try {
      members = await guild.members.fetch();
    } catch (err) {
      logger.warn(
        { guild: guild.id, err: err instanceof Error ? err.message : err },
        'discord-members-sync: members.fetch() failed (GuildMembers intent enabled in Developer Portal?)',
      );
      outcome.errors++;
      continue;
    }
    const matches = selectAllowedMembers(members.values(), allowedRoleSet);
    logger.info(
      { guild: guild.id, name: guild.name, matched: matches.length },
      'discord-members-sync: matched members in guild',
    );

    for (const member of matches) {
      if (seenDiscordIds.has(member.id)) {
        // Same person reachable through multiple guilds the bot shares.
        // Already written this run — skip the redundant write.
        outcome.skipped++;
        continue;
      }
      seenDiscordIds.add(member.id);
      try {
        const displayName =
          member.displayName || member.user.displayName || member.user.username;
        const fields: DiscordMemberFields = {
          discord_id: member.id,
          discord_username: member.user.username,
          discord_display_name: displayName,
          discord_roles: [...member.roles.cache.values()]
            .filter((r) => allowedRoleSet.has(r.id))
            .map((r) => r.name),
          last_synced_at: syncedAt,
        };
        const existingKbPerson = resolveUser(member.id, 'discord') ?? null;
        const slug = chooseSlug({
          discordId: member.id,
          displayName,
          username: member.user.username,
          existingKbPerson,
          fileExists: fileExistsAtSlug,
          readDiscordId: readDiscordIdFromFile,
        });
        const result = writePersonFile(slug, fields, displayName);
        addIdentity(member.id, 'discord', slug);
        if (result === 'added') outcome.added++;
        else outcome.updated++;
      } catch (err) {
        logger.warn(
          {
            discordId: member.id,
            err: err instanceof Error ? err.message : err,
          },
          'discord-members-sync: failed to sync member',
        );
        outcome.errors++;
      }
    }
  }

  client.destroy();
  return outcome;
}

let memberLoopRunning = false;
let memberLoopTimer: NodeJS.Timeout | null = null;

/**
 * Start the periodic Discord-members re-sync so KB people files stay
 * fresh as members change names / roles / leave / join. Each tick spins
 * up a short-lived Discord client (with the `GuildMembers` intent that
 * the main orchestrator does NOT carry), runs one sync, and exits — so
 * the orchestrator's persistent intent footprint is unchanged.
 *
 * No-op when DISCORD_DM_ALLOWED_ROLE_IDS is empty or the interval is 0.
 */
export function startDiscordMembersSyncLoop(opts?: {
  intervalMs?: number;
}): void {
  if (memberLoopRunning) {
    logger.debug('discord-members-sync loop already running');
    return;
  }
  const interval = opts?.intervalMs ?? DISCORD_MEMBERS_SYNC_INTERVAL_MS;
  if (interval <= 0) {
    logger.info('discord-members-sync loop disabled (interval=0)');
    return;
  }
  if (DISCORD_DM_ALLOWED_ROLE_IDS.length === 0) {
    logger.info(
      'discord-members-sync loop disabled (DISCORD_DM_ALLOWED_ROLE_IDS empty)',
    );
    return;
  }
  memberLoopRunning = true;

  const tick = async () => {
    try {
      const outcome = await runDiscordMembersSync();
      logger.info(
        {
          added: outcome.added,
          updated: outcome.updated,
          skipped: outcome.skipped,
          errors: outcome.errors,
        },
        'discord-members-sync: periodic tick complete',
      );
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err },
        'discord-members-sync: periodic tick failed',
      );
    }
  };

  logger.info({ intervalMs: interval }, 'discord-members-sync loop started');
  memberLoopTimer = setInterval(tick, interval);
  memberLoopTimer.unref?.();
  // No immediate tick on startup — the one-shot npm script handles
  // bootstrap, and we don't want every orchestrator restart to spin up
  // a second Discord client unnecessarily.
}

export function stopDiscordMembersSyncLoop(): void {
  if (memberLoopTimer) {
    clearInterval(memberLoopTimer);
    memberLoopTimer = null;
  }
  memberLoopRunning = false;
}
