/**
 * Google Calendar knowledge connector.
 *
 * Mirrors the events of the configured calendars (`GOOGLE_CALENDAR_IDS`,
 * defaulting to the already-configured `GOOGLE_WORKSPACE_CALENDAR_ID`) into
 * the per-group KB as one markdown file per **occurrence**, so per-doc RBAC,
 * full-text search, and the citations skill all apply to "what are we doing on
 * Thursday" exactly as they do to a wiki page. The source-agnostic half (KB
 * writes, reconcile, cursor state) lives in `base.ts`; this file only talks to
 * the Calendar REST API and hands back `ConnectorDoc[]` plus a `complete` flag.
 *
 * This is a MIRROR and nothing else. Turning calendar entries into KB tasks is
 * a separate concern with its own lifecycle questions (what reopens a task,
 * what closes it, what happens when the event moves) — see
 * `github-project-sync.ts` for where that engine belongs. Keeping it out of
 * here is what lets a reconcile pass delete freely: everything under this
 * connector's directory is derived state.
 *
 * Auth reuses the SAME credentials the bundled `gws` (Google Workspace CLI)
 * tool uses, via the shared `google-auth.ts` — there is exactly one Google
 * auth mechanism in the tree and no `googleapis` dependency.
 *
 * Three details here were learned the expensive way and are load-bearing:
 *  - **All-day dates never pass through a timestamp.** Google sends all-day
 *    events as a bare `start.date`; routing that through a Date and back
 *    prints the previous day in every negative-offset timezone. See
 *    `formatEventWhen`.
 *  - **`singleEvents=true`.** Without it a weekly meeting is a single entry
 *    carrying a recurrence rule, and the KB shows one event instead of twelve.
 *  - **A 401 re-reads the credential instead of failing the run**, and
 *    credential warnings are throttled, so a revoked refresh token degrades
 *    quietly instead of filling the log on every tick forever.
 *
 * Convention reference: `google-drive.ts` / `notion.ts` (fetch-based client,
 * typed errors, full pull per run, no client lib).
 */

import {
  CONNECTOR_SYNC_INTERVAL_MS,
  GOOGLE_CALENDAR_IDS,
  GOOGLE_CALENDAR_WINDOW_FUTURE_DAYS,
  GOOGLE_CALENDAR_WINDOW_PAST_DAYS,
} from '../../config.js';
import { readEnvFile } from '../../env.js';
import { DEFAULT_CONNECTOR_VISIBILITY, escapeHtml } from './base.js';
import type {
  Connector,
  ConnectorContext,
  ConnectorDoc,
  ConnectorVisibility,
} from './base.js';
import {
  GoogleApiError,
  googleApiGet,
  loadGoogleAccessToken,
  resolveGoogleWorkspaceCredsPath,
} from './google-auth.js';

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const DAY_MS = 86_400_000;
/** Page size for events.list — 2500 is the API maximum. */
const EVENTS_PAGE_SIZE = '2500';
/** Attendees listed in the body before the rest are summarized as a count. */
const MAX_LISTED_ATTENDEES = 25;
/** How often a credential failure may be logged. See `warnAuthFailure`. */
const AUTH_WARN_INTERVAL_MS = 3_600_000;
/**
 * Re-auth attempts allowed per sync. One covers the case this exists for (a
 * token that died before its stated expiry); the cap stops a permanently
 * rejecting credential from re-minting a token on every request of every page
 * of every calendar.
 */
const MAX_REAUTHS_PER_SYNC = 1;

const VALID_VISIBILITIES: ConnectorVisibility[] = [
  'open',
  'restricted',
  'private',
];

/**
 * Default visibility for docs this connector syncs. Overridable via
 * `GOOGLE_CALENDAR_DEFAULT_VISIBILITY` (process.env wins over `.env`); falls
 * back to the framework default (`restricted`, see base.ts) when unset or set
 * to an unrecognized value — never silently widens access on a typo.
 *
 * `restricted` matters more here than for a document connector: an event body
 * names who is meeting whom and when, which is exactly the kind of thing that
 * must not get folded into a channel-wide summary just because it was synced.
 */
export function getGoogleCalendarDefaultVisibility(): ConnectorVisibility {
  const raw =
    process.env.GOOGLE_CALENDAR_DEFAULT_VISIBILITY ||
    readEnvFile(['GOOGLE_CALENDAR_DEFAULT_VISIBILITY'])
      .GOOGLE_CALENDAR_DEFAULT_VISIBILITY;
  return VALID_VISIBILITIES.includes(raw as ConnectorVisibility)
    ? (raw as ConnectorVisibility)
    : DEFAULT_CONNECTOR_VISIBILITY;
}

// --- Calendar API shapes (only the fields we read) --------------------------

/** One end of an event's span. Exactly one of `date` / `dateTime` is set:
 * `date` for all-day events (a bare calendar date, no timezone at all),
 * `dateTime` for timed ones (RFC3339, offset included). */
export interface CalendarEventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

interface CalendarAttendee {
  email?: string;
  displayName?: string;
  resource?: boolean;
}

export interface CalendarEvent {
  id?: string;
  /** Shared by every instance of a recurring series — see `occurrenceKey`. */
  iCalUID?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  /** The human Calendar URL — the citation target. */
  htmlLink?: string;
  updated?: string;
  start?: CalendarEventTime;
  end?: CalendarEventTime;
  organizer?: { email?: string; displayName?: string };
  attendees?: CalendarAttendee[];
  /** Set on an expanded instance; the id of the series it belongs to. */
  recurringEventId?: string;
}

interface CalendarEventsResponse {
  items?: CalendarEvent[];
  nextPageToken?: string;
  /** The calendar's own default timezone, used to label timed events. */
  timeZone?: string;
  /** The calendar's display name. */
  summary?: string;
}

/** The calendar an event was found on, as recorded in the doc. */
export interface CalendarRef {
  id: string;
  timeZone?: string;
  summary?: string;
}

// --- Time formatting --------------------------------------------------------

/**
 * The day before a bare `YYYY-MM-DD`.
 *
 * Google's all-day `end.date` is **exclusive** — a one-day event on the 1st
 * ends on the 2nd — so the last day a reader cares about is one earlier.
 * The arithmetic goes through `Date.UTC` and is read back with `toISOString`,
 * both of which are UTC, so the value never touches a local-timezone
 * conversion in either direction. A string that isn't a bare date is returned
 * untouched rather than guessed at.
 */
export function previousDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Split an RFC3339 `dateTime` into its wall-clock date and `HH:MM`, by
 * STRING, so the event's own offset is honored and the host's is ignored. */
function wallClock(
  dateTime: string | undefined,
): { date: string; time: string } | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(dateTime ?? '');
  return m ? { date: m[1], time: m[2] } : undefined;
}

/** True when the event has no time of day (Google signals this with `date`). */
export function isAllDay(event: CalendarEvent): boolean {
  return Boolean(event.start?.date);
}

/**
 * Render an event's span as human-readable markdown.
 *
 * All-day events are formatted from the raw `start.date` / `end.date` STRINGS
 * and are never parsed into a Date. `new Date('2026-06-01')` is midnight UTC;
 * formatting that in any negative-offset zone prints `2026-05-31`, so an
 * all-day event silently moves a day earlier for roughly half the planet.
 * That exact bug reached production in the downstream board this connector
 * replaces, which is why the raw string is kept all the way to the markdown.
 *
 * Timed events are sliced out of the RFC3339 `dateTime` for the same reason:
 * that string already carries the event's own UTC offset, so its wall-clock
 * portion IS the local time everyone in the meeting will see. Reformatting it
 * through a Date would instead print whatever timezone the orchestrator
 * happens to run in, which is nobody's local time in particular. The zone is
 * named alongside it (the event's own `timeZone`, else the calendar's) so the
 * reading is unambiguous.
 */
export function formatEventWhen(
  event: CalendarEvent,
  calendarTimeZone?: string,
): string {
  if (isAllDay(event)) {
    const start = event.start?.date ?? '';
    const endExclusive = event.end?.date;
    const endInclusive = endExclusive ? previousDate(endExclusive) : undefined;
    // A single-day event's inclusive end equals its start — print one date.
    return endInclusive && endInclusive > start
      ? `${start} – ${endInclusive} (all day)`
      : `${start} (all day)`;
  }

  const zone = event.start?.timeZone || calendarTimeZone;
  const suffix = zone ? ` (${zone})` : '';
  const start = wallClock(event.start?.dateTime);
  const end = wallClock(event.end?.dateTime);
  if (!start) {
    // Neither shape present (or an unparseable stamp) — surface whatever the
    // API sent rather than inventing a time.
    return event.start?.dateTime || event.start?.date || '(no start time)';
  }
  if (!end) return `${start.date} ${start.time}${suffix}`;
  return start.date === end.date
    ? `${start.date} ${start.time}–${end.time}${suffix}`
    : `${start.date} ${start.time} – ${end.date} ${end.time}${suffix}`;
}

// --- Event → ConnectorDoc ---------------------------------------------------

/** One attendee as `Display Name (email)`, or whichever half exists. */
function formatAttendee(a: CalendarAttendee): string {
  const name = (a.displayName ?? '').trim();
  const email = (a.email ?? '').trim();
  if (name && email) return `${escapeHtml(name)} (${escapeHtml(email)})`;
  return escapeHtml(name || email);
}

/**
 * Convert one event to the markdown body of its KB doc.
 *
 * Every value that came from the calendar is run through `escapeHtml`
 * (base.ts) before it is woven in: an event description is free-form text that
 * Google itself allows HTML in, and the KB dashboard renders synced markdown
 * with `marked()` and no output sanitizer, so an unescaped description is a
 * stored-XSS vector. The `**`/`#` markers around the escaped values are ours,
 * not the source's, so they stay live.
 */
export function calendarEventToMarkdown(
  event: CalendarEvent,
  calendar: CalendarRef,
): string {
  const lines: string[] = [
    `# ${escapeHtml(event.summary || '(no title)')}`,
    '',
  ];

  lines.push(`**When:** ${formatEventWhen(event, calendar.timeZone)}`);
  if (event.location) lines.push(`**Where:** ${escapeHtml(event.location)}`);
  lines.push(`**Calendar:** ${escapeHtml(calendar.summary || calendar.id)}`);

  const organizer = event.organizer
    ? formatAttendee(event.organizer)
    : undefined;
  if (organizer) lines.push(`**Organizer:** ${organizer}`);

  // Rooms/equipment are attendees too; they're noise in a human agenda.
  const people = (event.attendees ?? []).filter((a) => !a.resource);
  if (people.length) {
    const shown = people.slice(0, MAX_LISTED_ATTENDEES).map(formatAttendee);
    const overflow = people.length - shown.length;
    lines.push(
      `**Attendees:** ${shown.join(', ')}${overflow > 0 ? `, +${overflow} more` : ''}`,
    );
  }

  const description = (event.description ?? '').trim();
  if (description) lines.push('', escapeHtml(description));

  return lines.join('\n');
}

/**
 * Build a `ConnectorDoc` for one event occurrence.
 *
 * The doc id is `event.id`, which is already per-occurrence and stable across
 * syncs: with `singleEvents=true` Google expands a recurring series into
 * instances with ids of the form `<seriesId>_<instance start>` (e.g.
 * `abc_20260601T130000Z`, or `abc_20260601` for an all-day instance), so each
 * occurrence upserts its own file week after week. `iCalUID` would be the
 * wrong choice — every instance of a series shares it, so the KB would keep
 * only whichever occurrence happened to be written last.
 *
 * The start/end/all-day values are copied into frontmatter as the raw strings
 * the API sent, so a reader (or a future query) gets the same shift-free
 * values the body shows.
 *
 * `visibility` defaults to reading the configured value, which is convenient
 * for callers holding a single event; `sync` passes it in instead, because
 * resolving it reads `.env` off disk and a calendar page is up to
 * `EVENTS_PAGE_SIZE` events — one blocking read per event, in the process that
 * also serves the chat channels, is not a thing worth doing 2500 times for an
 * answer that cannot change mid-run.
 */
export function calendarEventToConnectorDoc(
  event: CalendarEvent,
  calendar: CalendarRef,
  visibility: ConnectorVisibility = getGoogleCalendarDefaultVisibility(),
): ConnectorDoc {
  const id = event.id ?? '';
  return {
    id,
    title: event.summary || '(no title)',
    sourceUrl:
      event.htmlLink ||
      `https://calendar.google.com/calendar/u/0/r/eventedit/${encodeURIComponent(id)}`,
    markdown: calendarEventToMarkdown(event, calendar),
    updatedAt: event.updated,
    // Not-world-open by default (see base.ts); overridable via
    // GOOGLE_CALENDAR_DEFAULT_VISIBILITY.
    visibility,
    extraFrontmatter: {
      calendar_id: calendar.id,
      event_id: id,
      event_start: event.start?.date ?? event.start?.dateTime ?? '',
      event_end: event.end?.date ?? event.end?.dateTime ?? '',
      all_day: isAllDay(event),
      ...(event.recurringEventId
        ? { recurring_event_id: event.recurringEventId }
        : {}),
    },
  };
}

/**
 * Key identifying the real-world occurrence an event represents, used to drop
 * the duplicate copies that appear when two configured calendars both carry
 * the same meeting.
 *
 * `iCalUID` alone is NOT enough: `singleEvents=true` gives every instance of a
 * recurring series the same `iCalUID` (only `id` differs), so keying on it
 * would collapse a weekly meeting down to a single occurrence. Pairing it with
 * the start instant identifies the occurrence precisely.
 */
export function occurrenceKey(event: CalendarEvent): string {
  const start = event.start?.date ?? event.start?.dateTime ?? '';
  return event.iCalUID ? `${event.iCalUID}::${start}` : `id::${event.id ?? ''}`;
}

// --- Time window ------------------------------------------------------------

/**
 * The `timeMin`/`timeMax` bounds for one run. A calendar is unbounded in both
 * directions, so unlike a Drive folder its scope needs an explicit horizon.
 *
 * The window is anchored to `ctx.syncStart` rather than `Date.now()` so the
 * bounds are a pure function of the run — which keeps tests deterministic and
 * keeps every page of every calendar in a run asking for the same interval.
 */
export function syncWindow(
  syncStart: string,
  pastDays: number = GOOGLE_CALENDAR_WINDOW_PAST_DAYS,
  futureDays: number = GOOGLE_CALENDAR_WINDOW_FUTURE_DAYS,
): { timeMin: string; timeMax: string } {
  const parsed = Date.parse(syncStart);
  const baseMs = Number.isFinite(parsed) ? parsed : Date.now();
  return {
    timeMin: new Date(baseMs - pastDays * DAY_MS).toISOString(),
    timeMax: new Date(baseMs + futureDays * DAY_MS).toISOString(),
  };
}

// --- Auth session (401 → re-read the credential) ----------------------------

/**
 * Holds the run's access token and allows a bounded number of re-reads.
 *
 * `loadGoogleAccessToken` is stateless, so "re-auth" is simply calling it
 * again: it re-reads the credentials file off disk and mints a fresh token.
 * That matters because a cached token can die before its stated expiry
 * (revocation, rotation, clock skew) and the API answers 401 — throwing away
 * every remaining calendar over one stale token is a far worse outcome than
 * spending one extra request.
 */
class CalendarAuth {
  private token: string | null = null;
  private reauthsLeft = MAX_REAUTHS_PER_SYNC;

  constructor(private readonly fetchImpl: typeof fetch) {}

  async get(): Promise<string> {
    if (this.token === null) {
      this.token = await loadGoogleAccessToken(this.fetchImpl);
    }
    return this.token;
  }

  /** Drop the cached token so the next `get()` re-reads the credential.
   * Returns false once this run's re-auth budget is spent. */
  invalidate(): boolean {
    if (this.reauthsLeft <= 0) return false;
    this.reauthsLeft -= 1;
    this.token = null;
    return true;
  }
}

/** Authenticated GET that retries once on 401 with a freshly-read credential. */
async function calendarGet<T>(
  url: string,
  auth: CalendarAuth,
  fetchImpl: typeof fetch,
): Promise<T> {
  try {
    return await googleApiGet<T>(url, await auth.get(), fetchImpl);
  } catch (err) {
    if (
      err instanceof GoogleApiError &&
      err.status === 401 &&
      auth.invalidate()
    ) {
      return await googleApiGet<T>(url, await auth.get(), fetchImpl);
    }
    throw err;
  }
}

/**
 * True for failures caused by the CREDENTIAL rather than by one calendar: a
 * 401 that survived the re-auth above, and any `GoogleApiError` carrying no
 * HTTP status (those come from credential handling — unreadable file, no token
 * material, a refresh that produced nothing). They share one throttled warning
 * because they share one cause and one fix.
 *
 * 403 is deliberately NOT in this set: on the Calendar API it usually means
 * "this credential may not read THIS calendar" or a rate limit, which is
 * per-calendar information worth seeing every time.
 */
function isAuthFailure(err: unknown): boolean {
  return (
    err instanceof GoogleApiError &&
    (err.status === undefined || err.status === 401)
  );
}

/**
 * Log a credential failure at most once per `AUTH_WARN_INTERVAL_MS`.
 *
 * A revoked refresh token fails on every calendar of every tick; unthrottled
 * that is one identical warning per calendar per 30 minutes, forever, burying
 * everything else in the log. The throttle is per-connector rather than
 * per-calendar because the cause is one broken credential, not N broken
 * calendars.
 *
 * The timestamp lives in the connector's persisted state slot
 * (`ctx.getCursor`/`setCursor`, backed by `router_state`). This connector has
 * no incremental cursor to keep there (see `sync`), and persisting the
 * timestamp means a crash-looping orchestrator can't reset the throttle by
 * restarting. Comparing against `ctx.syncStart` — constant for a whole run —
 * also means a single run warns at most once no matter how many calendars
 * fail, without any module-level state for a test to leak into the next one.
 */
function warnAuthFailure(ctx: ConnectorContext, detail: unknown): void {
  const nowMs = Date.parse(ctx.syncStart);
  const lastMs = Number(ctx.getCursor() ?? NaN);
  const sinceMs = nowMs - lastMs;
  // Suppress only for a sane forward-moving interval; a missing/garbage/
  // future-dated marker must never silence the warning indefinitely.
  if (
    Number.isFinite(sinceMs) &&
    sinceMs >= 0 &&
    sinceMs < AUTH_WARN_INTERVAL_MS
  ) {
    return;
  }
  if (Number.isFinite(nowMs)) ctx.setCursor(String(nowMs));
  ctx.logger.warn(
    {
      source: 'google-calendar',
      err: detail instanceof Error ? detail.message : detail,
    },
    'google-calendar: Google credential rejected — further credential warnings suppressed for an hour',
  );
}

// --- Listing ----------------------------------------------------------------

/**
 * List every event of one calendar inside the window, paginating to the end.
 *
 * `singleEvents=true` is what makes a recurring series usable: without it the
 * API returns ONE entry carrying a recurrence rule, and a weekly meeting would
 * appear in the KB exactly once. With it, Google expands the series into the
 * individual occurrences that fall inside the window, each with its own stable
 * id. `orderBy=startTime` is only accepted alongside it.
 *
 * We deliberately do NOT pass a `timeZone` parameter. Doing so would force
 * every calendar's `dateTime` strings into one zone, which requires the
 * framework to have an opinion about which zone that is; letting each calendar
 * answer in its own and labelling the result (see `formatEventWhen`) keeps
 * this org-agnostic and keeps the rendered time the one the attendees see.
 */
async function listCalendarEvents(
  calendarId: string,
  auth: CalendarAuth,
  fetchImpl: typeof fetch,
  timeMin: string,
  timeMax: string,
): Promise<{ events: CalendarEvent[]; calendar: CalendarRef }> {
  const events: CalendarEvent[] = [];
  const calendar: CalendarRef = { id: calendarId };
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      timeMin,
      timeMax,
      maxResults: EVENTS_PAGE_SIZE,
    });
    if (pageToken) params.set('pageToken', pageToken);
    const resp = await calendarGet<CalendarEventsResponse>(
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
      auth,
      fetchImpl,
    );
    calendar.timeZone = resp.timeZone ?? calendar.timeZone;
    calendar.summary = resp.summary ?? calendar.summary;
    for (const event of resp.items ?? []) {
      // `singleEvents` expansion still reports deleted occurrences of a series
      // as cancelled placeholders; they are not events, and letting them
      // through would resurrect a file the reconcile pass just removed.
      if (event?.id && event.status !== 'cancelled') events.push(event);
    }
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return { events, calendar };
}

// --- Connector --------------------------------------------------------------

/**
 * Sync implementation: a FULL pull of the time window every run — every
 * configured calendar is re-listed on each tick, with no persisted cursor.
 *
 * This matches the other bundled connectors (see `notion.ts`'s `sync()` for
 * the full rationale: a persisted cursor made `complete` true only on the very
 * first run, so deletions never reconciled; it advanced past items whose fetch
 * had failed; and its boundary comparison dropped same-timestamp items). Both
 * incremental options Calendar offers are worse here on top of that:
 *
 *  - A `syncToken` cannot be combined with `timeMin`/`timeMax`, and this
 *    connector's scope IS a time window — one that slides forward every run,
 *    so events enter and leave scope without ever being edited. A token-based
 *    delta would never learn about either movement.
 *  - `updatedMin` returns only recently-edited events, which reintroduces
 *    exactly the three bugs above and still cannot express the sliding window.
 *
 * A full pull of a bounded window is cheap — one paginated list call per
 * calendar per tick (default 30 min, `CONNECTOR_SYNC_INTERVAL_MS`) — so
 * `complete` is a purely in-run flag and every clean run reconciles. That
 * reconcile is doing real work here, not just handling deletions: it is also
 * how events that have scrolled off the back of the window leave the KB.
 *
 * `complete` is true only when every configured calendar listed to the end
 * without error, so a partial pull can never trigger a reconcile that would
 * delete calendars' worth of still-live events.
 */
async function sync(
  ctx: ConnectorContext,
): Promise<{ docs: ConnectorDoc[]; complete: boolean }> {
  // Unconfigured is a no-op, never an error, and never `complete` — reporting
  // a complete pull of nothing would reconcile away a previously-synced KB.
  if (GOOGLE_CALENDAR_IDS.length === 0) return { docs: [], complete: false };

  const auth = new CalendarAuth(ctx.fetchImpl);
  try {
    await auth.get();
  } catch (err) {
    // No credential at all: warn (throttled) and report an incomplete pull
    // rather than throwing. A broken credential is a standing condition, not
    // an incident — the loop would otherwise log an error every single tick.
    warnAuthFailure(ctx, err);
    return { docs: [], complete: false };
  }

  const { timeMin, timeMax } = syncWindow(ctx.syncStart);
  // Keyed by occurrence so the same meeting present on two configured
  // calendars yields one doc; the first calendar listed wins, which makes
  // GOOGLE_CALENDAR_IDS an explicit precedence order.
  const byOccurrence = new Map<string, ConnectorDoc>();
  // Resolved once per run, not once per event — see
  // `calendarEventToConnectorDoc`.
  const visibility = getGoogleCalendarDefaultVisibility();
  let complete = true;

  for (const calendarId of GOOGLE_CALENDAR_IDS) {
    try {
      const { events, calendar } = await listCalendarEvents(
        calendarId,
        auth,
        ctx.fetchImpl,
        timeMin,
        timeMax,
      );
      for (const event of events) {
        const key = occurrenceKey(event);
        if (byOccurrence.has(key)) continue;
        byOccurrence.set(
          key,
          calendarEventToConnectorDoc(event, calendar, visibility),
        );
      }
    } catch (err) {
      // One unreachable calendar must not delete the others' events.
      complete = false;
      if (isAuthFailure(err)) {
        warnAuthFailure(ctx, err);
      } else {
        ctx.logger.warn(
          {
            source: 'google-calendar',
            calendarId,
            err: err instanceof Error ? err.message : err,
          },
          'google-calendar: calendar fetch failed, skipping',
        );
      }
    }
  }

  return { docs: [...byOccurrence.values()], complete };
}

/**
 * The Google Calendar connector. Configured when at least one calendar id is
 * set AND the gws creds file resolves. `isConfigured` performs NO network — it
 * only checks the path resolves (token minting happens lazily inside `sync`).
 */
export const googleCalendarConnector: Connector = {
  name: 'google-calendar',
  syncInterval: CONNECTOR_SYNC_INTERVAL_MS,
  isConfigured: () =>
    GOOGLE_CALENDAR_IDS.length > 0 &&
    resolveGoogleWorkspaceCredsPath() !== undefined,
  sync,
};
