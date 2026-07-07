/**
 * Pure helpers for Telegram auto-registration + auto-allowlisting
 * (TELEGRAM_AUTO_REGISTER_GROUPS / TELEGRAM_AUTO_ALLOWLIST_GROUPS).
 *
 * Everything in this module is side-effect free (fs/db access is injected)
 * so the grammy handlers in telegram.ts stay thin and the policy logic is
 * unit-testable without a bot, a database, or a filesystem.
 */

/** Lowercase, hyphenate, strip diacritics + non-alnum. Stable & idempotent. */
export function slugifyTelegramName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Derive a group folder name for an auto-registered Telegram chat,
 * consistent with the manual convention documented in the add-telegram
 * skill (`telegram_<group-name>`).
 *
 * - `telegram_<slugified title>` when free,
 * - else `telegram_<slug>_<chat id digits>` (chat IDs are unique, so this
 *   deconflicts two groups with the same title),
 * - else numeric suffixes (paranoia — e.g. a stale folder left behind by a
 *   deregistered group with the same id).
 *
 * Always produces a name valid under the orchestrator's group-folder
 * pattern (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`): starts with 't', contains
 * only lowercase alnum / '-' / '_', clipped to 64 chars.
 */
export function deriveTelegramGroupFolder(
  chatId: number | string,
  title: string | undefined,
  existingFolders: ReadonlySet<string>,
): string {
  const idPart = String(chatId).replace(/[^0-9]/g, '') || '0';
  const slug = slugifyTelegramName(title || '');
  const base = (slug ? `telegram_${slug}` : `telegram_${idPart}`).slice(0, 64);
  if (!existingFolders.has(base)) return base;

  const withId = `telegram_${slug ? `${slug.slice(0, 40)}_` : ''}${idPart}`.slice(
    0,
    64,
  );
  if (!existingFolders.has(withId)) return withId;

  let n = 2;
  let candidate = `${withId.slice(0, 60)}_${n}`;
  while (existingFolders.has(candidate)) {
    n++;
    candidate = `${withId.slice(0, 60)}_${n}`;
    if (n > 1000) {
      throw new Error(
        `telegram folder deconflict runaway for chatId=${chatId}`,
      );
    }
  }
  return candidate;
}

/**
 * Greeting posted when the bot is added to a group and auto-registers it.
 * Adapts to the bot's privacy mode: `can_read_all_group_messages === false`
 * means Telegram only delivers /commands, @-mentions, and replies to the
 * bot until it's promoted to admin (or privacy mode is disabled in
 * BotFather) — say so, actionably, without a wall of text.
 */
export function buildJoinGreeting(
  assistantName: string,
  canReadAllGroupMessages: boolean | undefined,
): string {
  const intro = `Hi, I'm ${assistantName} — this group is now set up. Mention @${assistantName} or reply to one of my messages whenever you need me.`;
  if (canReadAllGroupMessages === false) {
    return (
      `${intro} Heads up: Telegram privacy mode is on, so I only see /commands, @-mentions, and replies — ` +
      `make me a group admin (or disable privacy mode in @BotFather) if you want me to see every message.`
    );
  }
  return intro;
}

// --- Auto-allowlist config parsing / matching ---

export type TelegramAutoAllowlist =
  | { mode: 'off' }
  | { mode: 'all' }
  | { mode: 'list'; jids: Set<string> };

/**
 * Parse TELEGRAM_AUTO_ALLOWLIST_GROUPS: empty → off, 'all' → every
 * registered group, otherwise a comma-separated list of chat JIDs
 * (e.g. "tg:-1001234,tg:-1005678").
 */
export function parseAutoAllowlist(
  raw: string | undefined,
): TelegramAutoAllowlist {
  const trimmed = (raw || '').trim();
  if (!trimmed) return { mode: 'off' };
  if (trimmed.toLowerCase() === 'all') return { mode: 'all' };
  const jids = new Set(
    trimmed
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (jids.size === 0) return { mode: 'off' };
  return { mode: 'list', jids };
}

/**
 * Should senders in this (registered) chat be auto-allowlisted?
 * 'all' applies to group chats only — a stray registered DM never
 * auto-allowlists; an explicit JID in the list is always honored.
 */
export function autoAllowlistMatches(
  cfg: TelegramAutoAllowlist,
  chatJid: string,
  isGroup: boolean,
): boolean {
  switch (cfg.mode) {
    case 'off':
      return false;
    case 'all':
      return isGroup;
    case 'list':
      return cfg.jids.has(chatJid);
  }
}

/**
 * Choose the people-file slug for a Telegram user (mirrors the Discord
 * members-sync chooseSlug contract):
 *
 * - If `user_identities` already binds this Telegram id to a kb_person,
 *   return that slug — keeps the file stable across name changes.
 * - Else slugify username, then first name; fall back to a suffix of the
 *   numeric id. If a file at `<base>.md` exists AND its frontmatter
 *   `telegram_id` differs from ours, deconflict with `<base>-2`, ... until
 *   a free filename (or one that already belongs to us) is found.
 *
 * `fileExists` / `readTelegramId` are injected for testability.
 */
export function chooseTelegramSlug(opts: {
  telegramId: string;
  username?: string;
  firstName?: string;
  existingKbPerson: string | null;
  fileExists: (slug: string) => boolean;
  readTelegramId: (slug: string) => string | null;
}): string {
  if (opts.existingKbPerson) return opts.existingKbPerson;
  const base =
    slugifyTelegramName(opts.username || '') ||
    slugifyTelegramName(opts.firstName || '') ||
    `tg-user-${opts.telegramId.slice(-6)}`;
  let candidate = base;
  let n = 2;
  while (opts.fileExists(candidate)) {
    if (opts.readTelegramId(candidate) === opts.telegramId) return candidate;
    candidate = `${base}-${n}`;
    n++;
    if (n > 1000) {
      throw new Error(
        `telegram slug deconflict runaway for base="${base}" telegramId=${opts.telegramId}`,
      );
    }
  }
  return candidate;
}
