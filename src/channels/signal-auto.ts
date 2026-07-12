/**
 * Pure helpers for Signal auto-registration (SIGNAL_AUTO_REGISTER_GROUPS).
 *
 * Everything in this module is side-effect free (no fs/db/socket access) so the
 * signal-cli receive handler in signal.ts stays thin and the folder-derivation
 * policy is unit-testable without a daemon, a database, or a filesystem.
 *
 * Signal JIDs (see signal.ts):
 *   DM    → `signal:+15551234567`        (E.164 phone number)
 *   group → `signal:group:<base64GroupId>`
 */

/** Lowercase, hyphenate, strip diacritics + non-alnum. Stable & idempotent. */
export function slugifySignalName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Filesystem-safe id token for a Signal chat JID, kept unique per chat.
 *
 * - DMs (`signal:+15551234567`) → the bare phone digits (`15551234567`),
 *   mirroring WhatsApp's `jidDigits`.
 * - Groups (`signal:group:<base64>`) → the base64 group id remapped to the
 *   base64url alphabet (`+`→`-`, `/`→`_`, `=` padding dropped) so it stays
 *   unique AND valid under the orchestrator's group-folder charset
 *   (`[A-Za-z0-9_-]`). Any residual out-of-charset byte is stripped.
 */
function signalIdToken(chatJid: string): string {
  const rest = String(chatJid).replace(/^signal:/, '');
  if (rest.startsWith('group:')) {
    const id = rest.slice('group:'.length);
    const token = id
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '')
      .replace(/[^A-Za-z0-9_-]/g, '');
    return token || '0';
  }
  return rest.replace(/[^0-9]/g, '') || '0';
}

/**
 * Derive a group folder name for an auto-registered Signal chat, consistent
 * with the manual `signal_<name>` convention.
 *
 * - `signal_<slugified name>` when free,
 * - else `signal_<slug>_<id token>` (chat ids are unique, so this deconflicts
 *   two chats with the same display name),
 * - else numeric suffixes (paranoia — e.g. a stale folder left behind by a
 *   deregistered chat with the same id).
 *
 * Always produces a name valid under the orchestrator's group-folder pattern
 * (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`): starts with 's', contains only
 * lowercase alnum / '-' / '_' (plus base64url group-id chars), clipped to 64.
 */
export function deriveSignalGroupFolder(
  chatJid: string,
  name: string | undefined,
  existingFolders: ReadonlySet<string>,
): string {
  const idPart = signalIdToken(chatJid);
  const slug = slugifySignalName(name || '');
  const base = (slug ? `signal_${slug}` : `signal_${idPart}`).slice(0, 64);
  if (!existingFolders.has(base)) return base;

  const withId = `signal_${slug ? `${slug.slice(0, 40)}_` : ''}${idPart}`.slice(
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
      throw new Error(`signal folder deconflict runaway for jid=${chatJid}`);
    }
  }
  return candidate;
}
