/**
 * Slack-members → KB people sync.
 *
 * Reads the Slack workspace roster (users.list) and, for every real human
 * member (not a bot, not deactivated, with an email), ensures:
 *
 *   1. A people file under `groups/<SHARED_KB_GROUP>/context/people/<slug>.md`
 *      with Slack-identifying frontmatter merged in. Existing body and any
 *      non-Slack frontmatter (role, `platforms.github`, manual notes, …) are
 *      preserved.
 *   2. A `user_identities` row binding their Slack user id → `<slug>` so the
 *      orchestrator's identity resolution can answer "who is this Slack
 *      message from?".
 *
 * Idempotent: re-runs only refresh `name` / `email` / `timezone` /
 * `platforms.slack` / `last_synced_at`; everything else is untouched.
 *
 * Requires the bot's `users:read` + `users:read.email` scopes. The Discord
 * equivalent (`discord-members-sync.ts`) is the model; the `slugify` and
 * `chooseSlug` helpers are reused from there.
 */

import fs from 'fs';
import path from 'path';

import matter from 'gray-matter';
import { WebClient } from '@slack/web-api';

import {
  GROUPS_DIR,
  SHARED_KB_GROUP,
  SLACK_MEMBERS_SYNC_INTERVAL_MS,
} from '../config.js';
import { initDatabase } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { addIdentity, resolveUser } from '../permissions.js';
import { chooseSlug } from './discord-members-sync.js';

export interface SlackMemberFields {
  slack_id: string;
  name: string;
  email: string;
  /** IANA timezone (e.g. `America/New_York`); '' when Slack reports none. */
  timezone: string;
  last_synced_at: string;
}

/** Minimal shape of a Slack `users.list` member we care about. */
export interface SlackRosterMember {
  id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  tz?: string;
  profile?: { real_name?: string; email?: string };
}

/**
 * A member is syncable when it's a real human with an email — bots, the
 * Slackbot, deactivated accounts, and app users are skipped, and an email is
 * required (it's the whole point: resolving a person to an address).
 */
export function isSyncableMember(m: SlackRosterMember): boolean {
  if (!m.id || m.id === 'USLACKBOT') return false;
  if (m.is_bot || m.is_app_user || m.deleted) return false;
  return !!m.profile?.email;
}

/**
 * Merge Slack-derived fields into existing frontmatter. Slack-owned fields
 * (`name`, `email`, `timezone`, `platforms.slack`, `last_synced_at`) always
 * refresh; everything else is preserved — notably `role` (so a manual `admin`
 * survives) and `platforms.github`. `created_by` / `visibility` are set only
 * when absent. The `team` and `slack-synced` tags are ensured.
 */
export function mergeSlackFrontmatter(
  existing: Record<string, unknown> | null,
  slack: SlackMemberFields,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(existing ?? {}) };
  out.name = slack.name;
  if (out.role === undefined || out.role === '') out.role = 'member';

  const tags = Array.isArray(out.tags) ? [...(out.tags as unknown[])] : [];
  if (!tags.includes('team')) tags.push('team');
  if (!tags.includes('slack-synced')) tags.push('slack-synced');
  out.tags = tags;

  out.email = slack.email;
  if (slack.timezone) out.timezone = slack.timezone;

  // Preserve other platforms (e.g. github); refresh slack.
  const platforms =
    out.platforms &&
    typeof out.platforms === 'object' &&
    !Array.isArray(out.platforms)
      ? { ...(out.platforms as Record<string, unknown>) }
      : {};
  platforms.slack = slack.slack_id;
  out.platforms = platforms;

  if (out.created_by === undefined) out.created_by = 'slack-sync';
  if (out.visibility === undefined) out.visibility = 'private';
  out.last_synced_at = slack.last_synced_at;
  return out;
}

/** Default body for a brand-new people file (preserved across re-syncs). */
export function defaultPersonBody(f: SlackMemberFields): string {
  return [
    `${f.name} — synced from Slack.`,
    '',
    '<!-- Notes below are preserved across syncs; only frontmatter is refreshed. -->',
    '',
  ].join('\n');
}

function peopleDir(): string {
  return path.join(GROUPS_DIR, SHARED_KB_GROUP, 'context', 'people');
}

/** Read the `platforms.slack` id recorded in a people file (if any). */
function readSlackIdFromFile(slug: string): string | null {
  const file = path.join(peopleDir(), `${slug}.md`);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = matter(fs.readFileSync(file, 'utf-8'));
    const platforms = (parsed.data as { platforms?: unknown }).platforms;
    const id =
      platforms && typeof platforms === 'object'
        ? (platforms as { slack?: unknown }).slack
        : undefined;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

function fileExistsAtSlug(slug: string): boolean {
  return fs.existsSync(path.join(peopleDir(), `${slug}.md`));
}

export interface SyncOutcome {
  added: number;
  updated: number;
  skipped: number;
  errors: number;
}

/** Write or refresh one person's KB file (atomic via tmp+rename). */
function writePersonFile(
  slug: string,
  fields: SlackMemberFields,
): 'added' | 'updated' {
  const file = path.join(peopleDir(), `${slug}.md`);
  fs.mkdirSync(peopleDir(), { recursive: true });
  let existing: Record<string, unknown> | null = null;
  let body: string = defaultPersonBody(fields);
  let isNew = true;
  if (fs.existsSync(file)) {
    isNew = false;
    const parsed = matter(fs.readFileSync(file, 'utf-8'));
    existing = parsed.data as Record<string, unknown>;
    body = parsed.content.replace(/^\n+/, '');
  }
  const fm = mergeSlackFrontmatter(existing, fields);
  fm.slug = slug;
  const serialized = matter.stringify(body, fm);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, serialized);
  fs.renameSync(tmp, file);
  return isNew ? 'added' : 'updated';
}

/**
 * Run one pass of the Slack-members sync. Returns counts. Throws on fatal
 * errors (missing token); per-member errors are logged and counted.
 */
export async function runSlackMembersSync(): Promise<SyncOutcome> {
  const env = readEnvFile(['SLACK_BOT_TOKEN']);
  const token = process.env.SLACK_BOT_TOKEN || env.SLACK_BOT_TOKEN || '';
  if (!token) throw new Error('SLACK_BOT_TOKEN is not set');

  initDatabase();
  fs.mkdirSync(peopleDir(), { recursive: true });

  const client = new WebClient(token);
  const outcome: SyncOutcome = { added: 0, updated: 0, skipped: 0, errors: 0 };
  const syncedAt = new Date().toISOString();
  const seen = new Set<string>();

  let cursor: string | undefined;
  do {
    const res = await client.users.list({ limit: 200, cursor });
    for (const raw of res.members ?? []) {
      const m = raw as SlackRosterMember;
      if (!isSyncableMember(m)) {
        outcome.skipped++;
        continue;
      }
      const id = m.id!;
      if (seen.has(id)) {
        outcome.skipped++;
        continue;
      }
      seen.add(id);
      try {
        const name =
          m.profile?.real_name ||
          m.real_name ||
          m.name ||
          `user-${id.slice(-6)}`;
        const fields: SlackMemberFields = {
          slack_id: id,
          name,
          email: m.profile!.email!,
          timezone: m.tz || '',
          last_synced_at: syncedAt,
        };
        const existingKbPerson = resolveUser(id, 'slack') ?? null;
        // chooseSlug is id-agnostic — pass the Slack id where it expects an id
        // and a Slack-aware reader for deconfliction.
        const slug = chooseSlug({
          discordId: id,
          displayName: name,
          username: m.name || name,
          existingKbPerson,
          fileExists: fileExistsAtSlug,
          readDiscordId: readSlackIdFromFile,
        });
        const result = writePersonFile(slug, fields);
        addIdentity(id, 'slack', slug);
        if (result === 'added') outcome.added++;
        else outcome.updated++;
      } catch (err) {
        logger.warn(
          { slackId: id, err: err instanceof Error ? err.message : err },
          'slack-members-sync: failed to sync member',
        );
        outcome.errors++;
      }
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return outcome;
}

let memberLoopRunning = false;
let memberLoopTimer: NodeJS.Timeout | null = null;

/**
 * Start the periodic Slack-members re-sync so KB people files stay fresh as
 * members join / leave / change name. No-op when the interval is 0 (the
 * default) or no SLACK_BOT_TOKEN is configured — opt-in via
 * SLACK_MEMBERS_SYNC_INTERVAL_MS. The one-shot `npm run sync-slack-members`
 * works regardless.
 */
export function startSlackMembersSyncLoop(opts?: {
  intervalMs?: number;
}): void {
  if (memberLoopRunning) {
    logger.debug('slack-members-sync loop already running');
    return;
  }
  const interval = opts?.intervalMs ?? SLACK_MEMBERS_SYNC_INTERVAL_MS;
  if (interval <= 0) {
    logger.info('slack-members-sync loop disabled (interval=0)');
    return;
  }
  const env = readEnvFile(['SLACK_BOT_TOKEN']);
  if (!(process.env.SLACK_BOT_TOKEN || env.SLACK_BOT_TOKEN)) {
    logger.info('slack-members-sync loop disabled (no SLACK_BOT_TOKEN)');
    return;
  }
  memberLoopRunning = true;

  const tick = async () => {
    try {
      const outcome = await runSlackMembersSync();
      logger.info(
        {
          added: outcome.added,
          updated: outcome.updated,
          skipped: outcome.skipped,
          errors: outcome.errors,
        },
        'slack-members-sync: periodic tick complete',
      );
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err },
        'slack-members-sync: periodic tick failed',
      );
    }
  };

  logger.info({ intervalMs: interval }, 'slack-members-sync loop started');
  memberLoopTimer = setInterval(tick, interval);
  memberLoopTimer.unref?.();
}

/** Stop the periodic loop (test cleanup / shutdown). */
export function stopSlackMembersSyncLoop(): void {
  if (memberLoopTimer) {
    clearInterval(memberLoopTimer);
    memberLoopTimer = null;
  }
  memberLoopRunning = false;
}
