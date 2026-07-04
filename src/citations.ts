/**
 * Citation helpers — turn the sources an agent actually used into a compact,
 * channel-native "Sources" block appended to answers that draw on retrieved
 * knowledge. Verifiable/cited answers are core trust behavior; see
 * `container/skills/citations/SKILL.md` and `rules/messaging/citations.md`.
 *
 * These are pure formatters. Deciding *whether* to cite (skip trivial
 * chit-chat) and *what* was used lives in the agent's judgment per the skill;
 * this module only renders a consistent block once the agent has the list.
 */

/** A channel's link-rendering dialect. Derived from the group folder prefix. */
export type CitationChannel =
  | 'slack'
  | 'telegram'
  | 'whatsapp'
  | 'discord'
  | 'cli';

/** One source the agent used to answer. */
export interface Citation {
  /** Human-readable label (doc title, page title, or issue title). */
  title: string;
  /**
   * Where it points. For internal KB docs this may be omitted — pass `kbPath`
   * instead and the deep-link is derived when a dashboard URL is configured.
   */
  url?: string;
  /**
   * KB context-relative path for an internal doc, e.g. `people/jane-doe.md` or
   * `tasks/TASK-123.md` (with or without a leading `context/`). Used to build a
   * dashboard deep-link; falls back to showing the path when no URL is set.
   */
  kbPath?: string;
}

/**
 * Map the group folder prefix (`slack_`, `telegram_`, …) to a link dialect.
 * Defaults to `cli` (standard Markdown) for anything unrecognized.
 */
export function channelFromFolder(folder: string | undefined): CitationChannel {
  const f = (folder || '').toLowerCase();
  if (f.startsWith('slack_')) return 'slack';
  if (f.startsWith('telegram_')) return 'telegram';
  if (f.startsWith('whatsapp_')) return 'whatsapp';
  if (f.startsWith('discord_')) return 'discord';
  return 'cli';
}

/**
 * Categories the KB dashboard serves under `/doc/:category/:file`
 * (see kb-ui/server.mjs — the `/doc/:category/:file` route). A path is only
 * deep-linkable when its first segment is one of these.
 */
const KB_CATEGORIES = new Set([
  'people',
  'tasks',
  'calendar',
  'artifacts',
  'financials',
  'dashboards',
]);

/**
 * Build a KB dashboard deep-link for an internal doc path, or `null` when it
 * can't be linked (no dashboard configured, or the path isn't under a served
 * category). URL scheme verified against kb-ui/server.mjs:
 *   GET /doc/:category/:file   where :file is the URL-encoded relative path
 *   within the category (nested segments encode their separators).
 *
 * `context/people/jane-doe.md`  -> `<base>/doc/people/jane-doe.md`
 * `artifacts/equipment/x.md`    -> `<base>/doc/artifacts/equipment%2Fx.md`
 */
export function kbDeepLink(
  kbPath: string,
  dashboardUrl: string | undefined,
): string | null {
  if (!dashboardUrl) return null;
  const clean = kbPath.replace(/^\/+/, '').replace(/^context\//, '');
  const slash = clean.indexOf('/');
  if (slash < 0) return null;
  const category = clean.slice(0, slash);
  const rest = clean.slice(slash + 1);
  if (!KB_CATEGORIES.has(category) || !rest) return null;
  const base = dashboardUrl.replace(/\/+$/, '');
  return `${base}/doc/${category}/${encodeURIComponent(rest)}`;
}

/**
 * Resolve the effective URL for a citation: an explicit web/integration `url`
 * wins; otherwise derive a KB deep-link from `kbPath`; otherwise `null`
 * (render the bare path/title).
 */
export function resolveCitationUrl(
  c: Citation,
  dashboardUrl: string | undefined,
): string | null {
  if (c.url) return c.url;
  if (c.kbPath) return kbDeepLink(c.kbPath, dashboardUrl);
  return null;
}

/** Render a single link in the target channel's native syntax. */
function renderLink(
  title: string,
  url: string | null,
  channel: CitationChannel,
  fallbackLabel: string,
): string {
  const label = title || fallbackLabel;
  if (!url) return label;
  // Slack mrkdwn uses <url|text>; WhatsApp has no link markup (show
  // "Title (url)"); Telegram Markdown v1, Discord, and CLI all render the
  // standard [text](url) form natively (see src/channels/telegram.ts).
  if (channel === 'slack') return `<${url}|${label}>`;
  if (channel === 'whatsapp') return `${label} (${url})`;
  return `[${label}](${url})`;
}

/**
 * Build a compact "Sources" block for the given channel, or `''` when there is
 * nothing to cite. Deduplicates by resolved URL (or title when no URL).
 * The caller decides whether to append it — this never guesses at relevance.
 */
export function formatSources(
  citations: Citation[],
  channel: CitationChannel,
  dashboardUrl?: string,
): string {
  if (!citations || citations.length === 0) return '';

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const c of citations) {
    const url = resolveCitationUrl(c, dashboardUrl);
    const kbPath = c.kbPath
      ? c.kbPath.replace(/^\/+/, '').replace(/^context\//, '')
      : '';
    const fallback = kbPath || c.title || 'source';
    const dedupeKey = (url || c.title || fallback).toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    // When there's no link but we have both a title and a KB path, keep the
    // path visible so the citation stays traceable: "Title (path)".
    let label = renderLink(c.title, url, channel, fallback);
    if (!url && kbPath && c.title && c.title !== kbPath) {
      label = `${c.title} (${kbPath})`;
    }
    lines.push(`${bullet(channel)} ${label}`);
  }
  if (lines.length === 0) return '';

  // Discord/CLI use standard-markdown bold; Slack/Telegram/WhatsApp use single-*.
  const heading =
    channel === 'discord' || channel === 'cli' ? '**Sources**' : '*Sources*';
  return `${heading}\n${lines.join('\n')}`;
}

/** Bullet character per channel (all use `•` except Discord/CLI markdown). */
function bullet(channel: CitationChannel): string {
  return channel === 'discord' || channel === 'cli' ? '-' : '•';
}
