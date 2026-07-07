/**
 * Telegram auto-allowlist seeding (TELEGRAM_AUTO_ALLOWLIST_GROUPS).
 *
 * For a sender in a matching registered Telegram group who does NOT already
 * resolve to a KB person, seed everything the permissions layer needs:
 *
 *   1. A people file under `groups/<SHARED_KB_GROUP>/context/people/<slug>.md`
 *      with `telegram_id` / `telegram_username` frontmatter and
 *      `created_by: telegram-auto-allowlist`.
 *   2. A `user_identities` (platform_id, 'telegram', kb_person) row so
 *      `resolveUser()` finds them.
 *   3. A people-cache reload so `getSenderContext()` resolves them on the
 *      very message that triggered the seeding.
 *
 * SECURITY: an allowlisted sender has FULL access. This module is only
 * invoked for chats matched by TELEGRAM_AUTO_ALLOWLIST_GROUPS — enable that
 * flag only for groups whose entire membership you trust.
 *
 * Idempotent: an already-resolvable sender is a no-op, and an in-process
 * cache keeps the steady-state cost per message at one Set lookup.
 */

import fs from 'fs';
import path from 'path';

import matter from 'gray-matter';

import { GROUPS_DIR, SHARED_KB_GROUP } from '../config.js';
import { logger } from '../logger.js';
import { addIdentity, loadPeopleFromKB, resolveUser } from '../permissions.js';
import { chooseTelegramSlug } from './telegram-auto.js';

export interface TelegramSender {
  telegramId: string;
  username?: string;
  firstName?: string;
}

/** Injectable side effects — defaults hit the real KB/db. */
export interface AllowlistSeedDeps {
  peopleDir: () => string;
  resolveUser: (platformId: string, platform: string) => string | undefined;
  addIdentity: (
    platformId: string,
    platform: string,
    kbPerson: string,
  ) => void;
  reloadPeople: () => void;
}

function defaultPeopleDir(): string {
  return path.join(GROUPS_DIR, SHARED_KB_GROUP, 'context', 'people');
}

function defaultReloadPeople(): void {
  loadPeopleFromKB(path.join(GROUPS_DIR, SHARED_KB_GROUP, 'context'));
}

// Senders confirmed allowlisted since this process started — avoids a db
// lookup on every single group message.
const seededThisProcess = new Set<string>();

/** @internal - exported for testing */
export function _resetSeededCacheForTests(): void {
  seededThisProcess.clear();
}

/**
 * Ensure a Telegram sender is allowlisted, seeding a KB person + identity
 * row when they aren't. Returns what happened (mostly for tests/logging).
 */
export function ensureTelegramSenderAllowlisted(
  sender: TelegramSender,
  deps: Partial<AllowlistSeedDeps> = {},
): 'created' | 'existing' | 'skipped' {
  if (!sender.telegramId) return 'skipped';
  if (seededThisProcess.has(sender.telegramId)) return 'existing';

  const d: AllowlistSeedDeps = {
    peopleDir: deps.peopleDir ?? defaultPeopleDir,
    resolveUser: deps.resolveUser ?? resolveUser,
    addIdentity: deps.addIdentity ?? addIdentity,
    reloadPeople: deps.reloadPeople ?? defaultReloadPeople,
  };

  if (d.resolveUser(sender.telegramId, 'telegram')) {
    seededThisProcess.add(sender.telegramId);
    return 'existing';
  }

  const dir = d.peopleDir();
  const fileExists = (slug: string) =>
    fs.existsSync(path.join(dir, `${slug}.md`));
  const readTelegramId = (slug: string): string | null => {
    try {
      const parsed = matter(
        fs.readFileSync(path.join(dir, `${slug}.md`), 'utf-8'),
      );
      const id = (parsed.data as { telegram_id?: unknown }).telegram_id;
      return id === undefined || id === null ? null : String(id);
    } catch {
      return null;
    }
  };

  const slug = chooseTelegramSlug({
    telegramId: sender.telegramId,
    username: sender.username,
    firstName: sender.firstName,
    existingKbPerson: null,
    fileExists,
    readTelegramId,
  });

  const file = path.join(dir, `${slug}.md`);
  fs.mkdirSync(dir, { recursive: true });
  // chooseTelegramSlug only returns an existing filename when its
  // telegram_id already matches ours (identity row was lost) — keep the
  // file, just restore the identity mapping below.
  if (!fs.existsSync(file)) {
    const displayName =
      sender.firstName || sender.username || `Telegram user ${sender.telegramId}`;
    const frontmatter: Record<string, unknown> = {
      title: displayName,
      created_by: 'telegram-auto-allowlist',
      visibility: 'private',
      tags: ['telegram-auto-allowlist'],
      telegram_id: sender.telegramId,
      ...(sender.username ? { telegram_username: sender.username } : {}),
    };
    const bodyLines = [
      `Telegram ID: ${sender.telegramId}`,
      ...(sender.username ? [`Telegram Username: @${sender.username}`] : []),
      '',
      '<!-- Auto-created by TELEGRAM_AUTO_ALLOWLIST_GROUPS the first time this',
      '     person spoke in an auto-allowlisted Telegram group. -->',
      '',
    ];
    const serialized = matter.stringify(bodyLines.join('\n'), frontmatter);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, serialized);
    fs.renameSync(tmp, file);
  }

  d.addIdentity(sender.telegramId, 'telegram', slug);
  d.reloadPeople();
  seededThisProcess.add(sender.telegramId);
  logger.info(
    { telegramId: sender.telegramId, slug },
    'Telegram sender auto-allowlisted',
  );
  return 'created';
}
