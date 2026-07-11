/**
 * Pure helpers for WhatsApp auto-registration + auto-allowlisting
 * (WHATSAPP_AUTO_REGISTER_GROUPS / WHATSAPP_AUTO_ALLOWLIST_GROUPS).
 *
 * Everything in this module is side-effect free (fs/db access is injected)
 * so the Baileys handlers in whatsapp.ts stay thin and the policy logic is
 * unit-testable without a socket, a database, or a filesystem.
 *
 * WhatsApp JIDs: DMs are `<number>@s.whatsapp.net`, groups are `<id>@g.us`.
 */

/** Lowercase, hyphenate, strip diacritics + non-alnum. Stable & idempotent. */
export function slugifyWhatsAppName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Bare digits of a WhatsApp JID's user part (e.g. `5551234@g.us` → `5551234`). */
function jidDigits(jid: string): string {
  const user = String(jid).split('@')[0].split(':')[0];
  return user.replace(/[^0-9]/g, '') || '0';
}

/**
 * Derive a group folder name for an auto-registered WhatsApp chat, consistent
 * with the manual convention (`whatsapp_<group-name>`).
 *
 * - `whatsapp_<slugified name>` when free,
 * - else `whatsapp_<slug>_<jid digits>` (JIDs are unique, so this deconflicts
 *   two chats with the same display name),
 * - else numeric suffixes (paranoia — e.g. a stale folder left behind by a
 *   deregistered chat with the same id).
 *
 * Always produces a name valid under the orchestrator's group-folder pattern
 * (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`): starts with 'w', contains only
 * lowercase alnum / '-' / '_', clipped to 64 chars.
 */
export function deriveWhatsAppGroupFolder(
  jid: string,
  name: string | undefined,
  existingFolders: ReadonlySet<string>,
): string {
  const idPart = jidDigits(jid);
  const slug = slugifyWhatsAppName(name || '');
  const base = (slug ? `whatsapp_${slug}` : `whatsapp_${idPart}`).slice(0, 64);
  if (!existingFolders.has(base)) return base;

  const withId =
    `whatsapp_${slug ? `${slug.slice(0, 40)}_` : ''}${idPart}`.slice(0, 64);
  if (!existingFolders.has(withId)) return withId;

  let n = 2;
  let candidate = `${withId.slice(0, 60)}_${n}`;
  while (existingFolders.has(candidate)) {
    n++;
    candidate = `${withId.slice(0, 60)}_${n}`;
    if (n > 1000) {
      throw new Error(`whatsapp folder deconflict runaway for jid=${jid}`);
    }
  }
  return candidate;
}

// --- Auto-allowlist config parsing / matching ---

export type WhatsAppAutoAllowlist =
  | { mode: 'off' }
  | { mode: 'all' }
  | { mode: 'list'; jids: Set<string> };

/**
 * Parse WHATSAPP_AUTO_ALLOWLIST_GROUPS: empty → off, 'all' → every registered
 * group, otherwise a comma-separated list of chat JIDs
 * (e.g. "123@g.us,456@g.us").
 */
export function parseAutoAllowlist(
  raw: string | undefined,
): WhatsAppAutoAllowlist {
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
  cfg: WhatsAppAutoAllowlist,
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
 * Choose the people-file slug for a WhatsApp user (mirrors the Telegram
 * chooseTelegramSlug contract):
 *
 * - If `user_identities` already binds this WhatsApp id to a kb_person,
 *   return that slug — keeps the file stable across name changes.
 * - Else slugify the push name; fall back to a suffix of the JID digits. If a
 *   file at `<base>.md` exists AND its frontmatter `whatsapp_id` differs from
 *   ours, deconflict with `<base>-2`, ... until a free filename (or one that
 *   already belongs to us) is found.
 *
 * `fileExists` / `readWhatsAppId` are injected for testability.
 */
export function chooseWhatsAppSlug(opts: {
  whatsappId: string;
  name?: string;
  existingKbPerson: string | null;
  fileExists: (slug: string) => boolean;
  readWhatsAppId: (slug: string) => string | null;
}): string {
  if (opts.existingKbPerson) return opts.existingKbPerson;
  const base =
    slugifyWhatsAppName(opts.name || '') ||
    `wa-user-${jidDigits(opts.whatsappId).slice(-6)}`;
  let candidate = base;
  let n = 2;
  while (opts.fileExists(candidate)) {
    if (opts.readWhatsAppId(candidate) === opts.whatsappId) return candidate;
    candidate = `${base}-${n}`;
    n++;
    if (n > 1000) {
      throw new Error(
        `whatsapp slug deconflict runaway for base="${base}" whatsappId=${opts.whatsappId}`,
      );
    }
  }
  return candidate;
}
