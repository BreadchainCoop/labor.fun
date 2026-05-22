/**
 * Resolve a free-text DM target (name, handle, slug, or Discord ID) to a
 * known Discord member. Inputs come from two sources:
 *
 *   - `user_identities` table — populated by the Discord members sync.
 *   - `<sharedKb>/context/people/<slug>.md` — also populated by the sync,
 *     readable by humans and curated by them.
 *
 * The orchestrator pre-loads candidates and hands them to this pure
 * function so the matching logic stays testable and side-effect-free.
 *
 * Resolution is INTENTIONALLY restricted to candidates that already exist
 * in the system. Random Discord IDs that don't appear in either source
 * are rejected — the bot must never be able to spam-DM strangers, only
 * members the operator has already allowlisted.
 */

export interface PersonCandidate {
  /** KB filename stem, e.g. `josh-tbs`. */
  slug: string;
  /** Numeric Discord user id. */
  discordId: string;
  /** Frontmatter `title:` — typically the given name after manual rename. */
  title: string;
  /** Discord username (`@handle`), e.g. `theblockchainsocialist`. */
  discordUsername: string;
  /** Server nickname / global display name, e.g. `Josh | TBS`. */
  discordDisplayName: string;
}

export type ResolveDmResult =
  | { person: PersonCandidate }
  | { error: string; suggestions?: string[] };

const NUMERIC_ID = /^[0-9]{8,25}$/;

function normalize(s: string): string {
  return (s || '').trim().toLowerCase();
}

/**
 * Match priority:
 *   1. Numeric ID → exact `discordId` match.
 *   2. Otherwise: case-insensitive equality against slug, title,
 *      discord_username, discord_display_name (in that priority order).
 *      First level with exactly one match wins. Multiple matches at the
 *      same level → ambiguous error listing them. Zero matches across
 *      all levels → not-found error.
 */
export function resolveDmTarget(
  target: string,
  candidates: PersonCandidate[],
): ResolveDmResult {
  const t = (target || '').trim();
  if (!t) return { error: 'Empty target' };

  if (NUMERIC_ID.test(t)) {
    const hit = candidates.find((c) => c.discordId === t);
    if (hit) return { person: hit };
    return {
      error: `Discord ID "${t}" is not a known allowlisted member. Refusing to DM unknown users.`,
    };
  }

  const tn = normalize(t);
  const fields: Array<
    keyof Pick<
      PersonCandidate,
      'slug' | 'title' | 'discordUsername' | 'discordDisplayName'
    >
  > = ['slug', 'title', 'discordUsername', 'discordDisplayName'];

  for (const field of fields) {
    const hits = candidates.filter((c) => normalize(c[field]) === tn);
    if (hits.length === 1) return { person: hits[0] };
    if (hits.length > 1) {
      return {
        error: `Ambiguous DM target "${t}" — matches ${hits.length} members on ${field}. Use a slug or Discord ID.`,
        suggestions: hits.map((h) => `${h.slug} (${h.discordDisplayName})`),
      };
    }
  }

  // Fuzzy-suggest as a courtesy on a miss — pick up to 5 candidates whose
  // slug/title/username contains the target as a substring.
  const fuzzy = candidates
    .filter((c) =>
      [c.slug, c.title, c.discordUsername, c.discordDisplayName].some((v) =>
        normalize(v).includes(tn),
      ),
    )
    .slice(0, 5)
    .map((c) => `${c.slug} (${c.discordDisplayName})`);

  return {
    error: `No allowlisted member matches "${t}". Provide a slug, Discord ID, username, or display name.`,
    suggestions: fuzzy.length > 0 ? fuzzy : undefined,
  };
}
