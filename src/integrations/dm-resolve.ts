/**
 * Resolve a free-text DM target (name, handle, slug, or Discord ID) to a
 * known Discord member.
 *
 * This module is intentionally pure: candidate-list in, match out, no DB
 * or filesystem access. The orchestrator (`src/ipc.ts`) pre-loads
 * candidates from `<sharedKb>/context/people/<slug>.md` frontmatter —
 * the people files written by the Discord-members sync — and passes
 * them in. The `user_identities` table is the same sync's secondary
 * backing store; we don't read it here because the people files have
 * the same `discord_id` mapping plus the human-readable fields the
 * resolver needs.
 *
 * Resolution is INTENTIONALLY restricted to candidates that already
 * exist in the system. Random Discord IDs that don't appear in the
 * provided list are rejected — the bot must never be able to spam-DM
 * strangers, only members the operator has already allowlisted.
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
 * Nickname / given-name forms derived from a candidate's human-facing fields.
 *
 * Real people files routinely keep the full display form in `title` /
 * `discordDisplayName` — `"Josh | TBS"`, `"Unai | Mettodo"`, `"Liron 💖"` — so a
 * bare first name (`"josh"`) never *exactly* matches any field and resolution
 * fails even though the intent is obvious. This derives the leading name by
 * splitting on common display separators (`|`, `(`, `/`, en/em dash) and also
 * taking that segment's first whitespace token, so `"Josh | TBS"` yields
 * `"josh"`. Used as a matching tier below (after exact matches, so exact always
 * wins; multiple people sharing a given name still surface as ambiguous).
 */
function givenNameForms(c: PersonCandidate): string[] {
  const out = new Set<string>();
  for (const raw of [c.title, c.discordDisplayName]) {
    const segment = (raw || '').split(/[|(/\u2013\u2014]/)[0].trim();
    if (!segment) continue;
    out.add(normalize(segment));
    const firstWord = segment.split(/\s+/)[0];
    if (firstWord) out.add(normalize(firstWord));
  }
  return [...out];
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
  type MatchField = 'slug' | 'title' | 'discordUsername' | 'discordDisplayName';
  const fields: MatchField[] = [
    'slug',
    'title',
    'discordUsername',
    'discordDisplayName',
  ];
  // Human-readable labels used in user-facing ambiguity messages (these
  // strings get surfaced into Discord chats by the IPC handler).
  const fieldLabel: Record<MatchField, string> = {
    slug: 'KB slug',
    title: 'name (KB title)',
    discordUsername: 'Discord username',
    discordDisplayName: 'Discord display name',
  };

  for (const field of fields) {
    const hits = candidates.filter((c) => normalize(c[field]) === tn);
    if (hits.length === 1) return { person: hits[0] };
    if (hits.length > 1) {
      return {
        error: `Ambiguous DM target "${t}" — matches ${hits.length} members on ${fieldLabel[field]}. Use a slug or Discord ID.`,
        suggestions: hits.map((h) => `${h.slug} (${h.discordDisplayName})`),
      };
    }
  }

  // Tier 2: leading given-name derived from the display form (handles
  // "Josh | TBS" → "josh"). Runs only after every exact tier missed, so it
  // never overrides a precise match; multiple people sharing a given name are
  // surfaced as ambiguous rather than silently picking one.
  const nameHits = candidates.filter((c) => givenNameForms(c).includes(tn));
  if (nameHits.length === 1) return { person: nameHits[0] };
  if (nameHits.length > 1) {
    return {
      error: `Ambiguous DM target "${t}" — matches ${nameHits.length} members by given name. Use a slug or Discord ID.`,
      suggestions: nameHits.map((h) => `${h.slug} (${h.discordDisplayName})`),
    };
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
