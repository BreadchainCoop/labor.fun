import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// --- Mocks (must be wired before importing the module under test) ---

vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const configMock = vi.hoisted(() => ({
  GOOGLE_CALENDAR_IDS: [] as string[],
  GOOGLE_CALENDAR_WINDOW_PAST_DAYS: 90,
  GOOGLE_CALENDAR_WINDOW_FUTURE_DAYS: 180,
  CONNECTOR_SYNC_INTERVAL_MS: 1800000,
  GROUPS_DIR: '',
  SHARED_KB_GROUP: 'slack_main',
}));

vi.mock('../../config.js', () => configMock);

// readEnvFile is stubbed; individual tests override its return value so the
// creds-path resolver points at a temp file (no real Google creds needed).
// Its call log doubles as the credential-read counter — see `credReads`.
const readEnvFileMock = vi.hoisted(() =>
  vi.fn((_keys?: string[]) => ({}) as Record<string, string>),
);
vi.mock('../../env.js', () => ({ readEnvFile: readEnvFileMock }));

// In-memory router_state so runConnector's cursor plumbing works without a
// real DB. This connector keeps no incremental cursor, but it DOES persist the
// credential-warning throttle timestamp there (see warnAuthFailure).
const routerState = vi.hoisted(() => new Map<string, string>());
vi.mock('../../db.js', () => ({
  getRouterState: (k: string) => routerState.get(k),
  setRouterState: (k: string, v: string) => {
    routerState.set(k, v);
  },
}));

// Import AFTER the mocks are wired.
import {
  calendarEventToConnectorDoc,
  calendarEventToMarkdown,
  formatEventWhen,
  getGoogleCalendarDefaultVisibility,
  googleCalendarConnector,
  isAllDay,
  occurrenceKey,
  previousDate,
  syncWindow,
  type CalendarEvent,
  type CalendarRef,
} from './google-calendar.js';
import { runConnector } from './base.js';
import type { ConnectorContext } from './base.js';

// --- Helpers ---

/** Build a minimal ConnectorContext with a stubbed cursor + fetch. */
function makeCtx(over?: Partial<ConnectorContext>): {
  ctx: ConnectorContext;
  cursorValue: () => string | undefined;
} {
  let cursor: string | undefined;
  const ctx: ConnectorContext = {
    getCursor: () => cursor,
    setCursor: (v: string) => {
      cursor = v;
    },
    fetchImpl: vi.fn() as unknown as typeof fetch,
    syncStart: '2026-06-01T00:00:00.000Z',
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as ConnectorContext['logger'],
    ...over,
  };
  return { ctx, cursorValue: () => cursor };
}

/** The warnings a ctx's logger recorded, as their message strings. */
function warnings(ctx: ConnectorContext): string[] {
  const warn = ctx.logger.warn as unknown as ReturnType<typeof vi.fn>;
  return warn.mock.calls.map((c) => String(c[1]));
}

/** A JSON-returning fetch Response stub. */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** The subset of events.list we read back (the module's own shape is internal). */
interface EventsPage {
  items?: CalendarEvent[];
  nextPageToken?: string;
  timeZone?: string;
  summary?: string;
}

function page(items: CalendarEvent[], over?: Partial<EventsPage>): EventsPage {
  return {
    items,
    timeZone: 'America/Los_Angeles',
    summary: 'Team calendar',
    ...over,
  };
}

const CAL_A = 'team@group.calendar.example.com';
const CAL_B = 'projects@group.calendar.example.com';

/**
 * Build a fetch stub that answers the OAuth endpoint and routes every
 * events.list call to `handler(calendarId, nthCallForThatCalendar)`.
 */
function makeFetch(
  handler: (calendarId: string, call: number) => Response,
): typeof fetch {
  const counts = new Map<string, number>();
  return vi.fn(async (url: string) => {
    const u = String(url);
    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      return jsonResponse({ access_token: 'ya29.minted' });
    }
    const m = /\/calendars\/([^/]+)\/events/.exec(u);
    const id = decodeURIComponent(m?.[1] ?? '');
    const n = (counts.get(id) ?? 0) + 1;
    counts.set(id, n);
    return handler(id, n);
  }) as unknown as typeof fetch;
}

/** Serve one (or a sequence of paginated) events.list payload per calendar. */
function eventsFetch(byCalendar: Record<string, EventsPage[]>): typeof fetch {
  return makeFetch((id, call) => {
    const pages = byCalendar[id];
    if (!pages) return jsonResponse({ error: 'not found' }, false, 404);
    return jsonResponse(pages[Math.min(call - 1, pages.length - 1)]);
  });
}

/**
 * How many times the Google credential was read off disk this test.
 *
 * Every credential read goes through `resolveGoogleWorkspaceCredsPath`, which
 * asks `readEnvFile` for exactly that one key — so the mock's filtered call
 * log is an exact re-auth counter. (The per-doc visibility lookup also calls
 * readEnvFile, with a different key; it's filtered out here.)
 */
function credReads(): number {
  return readEnvFileMock.mock.calls.filter((c) =>
    c[0]?.includes('GOOGLE_WORKSPACE_CREDENTIALS_FILE'),
  ).length;
}

/** How many times the run resolved the configured default visibility. Each
 * resolution is a blocking `.env` read, so this must not scale with the number
 * of events in the window. */
function visibilityReads(): number {
  return readEnvFileMock.mock.calls.filter((c) =>
    c[0]?.includes('GOOGLE_CALENDAR_DEFAULT_VISIBILITY'),
  ).length;
}

/**
 * Run a SYNCHRONOUS body with process.env.TZ forced to `tz`, restoring it
 * afterwards. Node re-reads process.env.TZ on assignment, so this really does
 * move the host's local timezone for the duration.
 *
 * Deliberately not used for async bodies: `finally` would fire at the body's
 * first `await`, restoring TZ before the awaited work ran. Use
 * `withTimeZoneAsync` there.
 */
function withTimeZone<T>(tz: string, body: () => T): T {
  const original = process.env.TZ;
  process.env.TZ = tz;
  try {
    return body();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

/** `withTimeZone` for an async body — TZ stays forced until it settles. */
async function withTimeZoneAsync<T>(
  tz: string,
  body: () => Promise<T>,
): Promise<T> {
  const original = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await body();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

/** A negative-offset zone: the one where the all-day bug used to show up. */
const TZ_BEHIND_UTC = 'America/Los_Angeles';
/** A positive-offset zone, to prove the fix isn't just "works west of UTC". */
const TZ_AHEAD_OF_UTC = 'Asia/Tokyo';

const CALENDAR: CalendarRef = {
  id: CAL_A,
  timeZone: 'America/Los_Angeles',
  summary: 'Team calendar',
};

/** An all-day event on 2026-06-01 (Google's `end.date` is EXCLUSIVE). */
function allDayEvent(over?: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: 'allday1',
    iCalUID: 'allday1@example.com',
    summary: 'Company holiday',
    htmlLink: 'https://calendar.google.com/calendar/event?eid=allday1',
    updated: '2026-05-20T12:00:00Z',
    start: { date: '2026-06-01' },
    end: { date: '2026-06-02' },
    ...over,
  };
}

/** A timed event, 09:30–10:15 local to a zone seven hours behind UTC. */
function timedEvent(over?: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: 'timed1',
    iCalUID: 'timed1@example.com',
    summary: 'Team standup',
    htmlLink: 'https://calendar.google.com/calendar/event?eid=timed1',
    updated: '2026-05-21T12:00:00Z',
    start: {
      dateTime: '2026-06-01T09:30:00-07:00',
      timeZone: 'America/Los_Angeles',
    },
    end: {
      dateTime: '2026-06-01T10:15:00-07:00',
      timeZone: 'America/Los_Angeles',
    },
    ...over,
  };
}

beforeEach(() => {
  routerState.clear();
  readEnvFileMock.mockClear();
  readEnvFileMock.mockReturnValue({});
  configMock.GOOGLE_CALENDAR_IDS = [];
  configMock.GOOGLE_CALENDAR_WINDOW_PAST_DAYS = 90;
  configMock.GOOGLE_CALENDAR_WINDOW_FUTURE_DAYS = 180;
});

// --- previousDate (Google's exclusive all-day end) --------------------------

describe('previousDate', () => {
  it('steps back one calendar day', () => {
    expect(previousDate('2026-06-02')).toBe('2026-06-01');
  });

  it('crosses a month boundary', () => {
    expect(previousDate('2026-03-01')).toBe('2026-02-28');
  });

  it('crosses a year boundary', () => {
    expect(previousDate('2026-01-01')).toBe('2025-12-31');
  });

  it('handles a leap day', () => {
    expect(previousDate('2024-03-01')).toBe('2024-02-29');
  });

  it('returns a non-date string untouched rather than guessing', () => {
    expect(previousDate('2026-06-01T10:00:00Z')).toBe('2026-06-01T10:00:00Z');
    expect(previousDate('')).toBe('');
    expect(previousDate('tomorrow')).toBe('tomorrow');
  });

  it('gives the same answer either side of UTC (no local-time arithmetic)', () => {
    const behind = withTimeZone(TZ_BEHIND_UTC, () =>
      previousDate('2026-06-02'),
    );
    const ahead = withTimeZone(TZ_AHEAD_OF_UTC, () =>
      previousDate('2026-06-02'),
    );
    expect(behind).toBe('2026-06-01');
    expect(ahead).toBe('2026-06-01');
  });
});

// --- isAllDay ---------------------------------------------------------------

describe('isAllDay', () => {
  it('is true for a bare start.date and false for a start.dateTime', () => {
    expect(isAllDay(allDayEvent())).toBe(true);
    expect(isAllDay(timedEvent())).toBe(false);
    expect(isAllDay({})).toBe(false);
  });
});

// --- THE BUG: an all-day date must never shift a day -----------------------

describe('formatEventWhen (all-day events)', () => {
  it('renders start.date UNSHIFTED in a zone behind UTC', () => {
    withTimeZone(TZ_BEHIND_UTC, () => {
      // Control: this is exactly the bug. Routing the bare date through a Date
      // and reading it back locally lands on the PREVIOUS day here.
      expect(new Date('2026-06-01').getDate()).toBe(31);

      const when = formatEventWhen(allDayEvent());
      expect(when).toBe('2026-06-01 (all day)');
      expect(when).not.toContain('2026-05-31');
      expect(when).not.toContain('05-31');
    });
  });

  it('renders start.date UNSHIFTED in a zone ahead of UTC too', () => {
    withTimeZone(TZ_AHEAD_OF_UTC, () => {
      expect(formatEventWhen(allDayEvent())).toBe('2026-06-01 (all day)');
    });
  });

  it('is byte-identical across both zones', () => {
    const behind = withTimeZone(TZ_BEHIND_UTC, () =>
      formatEventWhen(allDayEvent()),
    );
    const ahead = withTimeZone(TZ_AHEAD_OF_UTC, () =>
      formatEventWhen(allDayEvent()),
    );
    expect(behind).toBe(ahead);
  });

  it("treats Google's end.date as EXCLUSIVE: a one-day event is one day", () => {
    // start 06-01, end 06-02 means "the 1st", not "the 1st and the 2nd".
    const when = formatEventWhen(allDayEvent());
    expect(when).toBe('2026-06-01 (all day)');
    expect(when).not.toContain('–');
    expect(when).not.toContain('2026-06-02');
  });

  it('renders a multi-day all-day event with its INCLUSIVE last day', () => {
    // 06-01 through 06-03 inclusive; Google sends end.date = 06-04.
    expect(
      formatEventWhen(
        allDayEvent({
          start: { date: '2026-06-01' },
          end: { date: '2026-06-04' },
        }),
      ),
    ).toBe('2026-06-01 – 2026-06-03 (all day)');
  });

  it('falls back to the start date when end.date is missing', () => {
    expect(formatEventWhen(allDayEvent({ end: undefined }))).toBe(
      '2026-06-01 (all day)',
    );
  });

  it('never renders a backwards span when end.date precedes start.date', () => {
    expect(
      formatEventWhen(
        allDayEvent({
          start: { date: '2026-06-01' },
          end: { date: '2026-06-01' },
        }),
      ),
    ).toBe('2026-06-01 (all day)');
  });
});

// --- Timed events render their own wall clock ------------------------------

describe('formatEventWhen (timed events)', () => {
  it("renders the event's wall-clock times, not the host's", () => {
    withTimeZone(TZ_AHEAD_OF_UTC, () => {
      // Control: the host would print 2026-06-02 01:30 for this instant.
      expect(
        new Date('2026-06-01T09:30:00-07:00').toLocaleString('en-CA'),
      ).toContain('2026-06-02');

      expect(formatEventWhen(timedEvent())).toBe(
        '2026-06-01 09:30–10:15 (America/Los_Angeles)',
      );
    });
  });

  it("labels with the calendar's zone when the event carries none", () => {
    const ev = timedEvent({
      start: { dateTime: '2026-06-01T09:30:00-07:00' },
      end: { dateTime: '2026-06-01T10:15:00-07:00' },
    });
    expect(formatEventWhen(ev, 'America/Los_Angeles')).toBe(
      '2026-06-01 09:30–10:15 (America/Los_Angeles)',
    );
  });

  it('omits the zone suffix when no zone is known anywhere', () => {
    const ev = timedEvent({
      start: { dateTime: '2026-06-01T09:30:00-07:00' },
      end: { dateTime: '2026-06-01T10:15:00-07:00' },
    });
    expect(formatEventWhen(ev)).toBe('2026-06-01 09:30–10:15');
  });

  it('spells out both dates for an event that crosses midnight', () => {
    const ev = timedEvent({
      start: { dateTime: '2026-06-01T23:30:00-07:00', timeZone: 'UTC' },
      end: { dateTime: '2026-06-02T00:30:00-07:00', timeZone: 'UTC' },
    });
    expect(formatEventWhen(ev)).toBe(
      '2026-06-01 23:30 – 2026-06-02 00:30 (UTC)',
    );
  });

  it('renders just the start when the end is missing', () => {
    expect(formatEventWhen(timedEvent({ end: undefined }))).toBe(
      '2026-06-01 09:30 (America/Los_Angeles)',
    );
  });

  it('surfaces an unparseable stamp verbatim instead of inventing a time', () => {
    expect(formatEventWhen({ start: { dateTime: 'not-a-timestamp' } })).toBe(
      'not-a-timestamp',
    );
  });

  it('says so plainly when there is no start at all', () => {
    expect(formatEventWhen({})).toBe('(no start time)');
  });
});

// --- calendarEventToMarkdown ----------------------------------------------

describe('calendarEventToMarkdown', () => {
  it('renders title, when, where, calendar, organizer, attendees, description', () => {
    const md = calendarEventToMarkdown(
      timedEvent({
        location: 'Room 2',
        description: 'Agenda: ship the thing.',
        organizer: { email: 'alice@example.com', displayName: 'Alice' },
        attendees: [
          { email: 'alice@example.com', displayName: 'Alice' },
          { email: 'bob@example.com' },
        ],
      }),
      CALENDAR,
    );
    expect(md).toContain('# Team standup');
    expect(md).toContain(
      '**When:** 2026-06-01 09:30–10:15 (America/Los_Angeles)',
    );
    expect(md).toContain('**Where:** Room 2');
    expect(md).toContain('**Calendar:** Team calendar');
    expect(md).toContain('**Organizer:** Alice (alice@example.com)');
    expect(md).toContain(
      '**Attendees:** Alice (alice@example.com), bob@example.com',
    );
    expect(md).toContain('Agenda: ship the thing.');
  });

  it('keeps the unshifted date in the body of an all-day event', () => {
    withTimeZone(TZ_BEHIND_UTC, () => {
      const md = calendarEventToMarkdown(allDayEvent(), CALENDAR);
      expect(md).toContain('**When:** 2026-06-01 (all day)');
      expect(md).not.toContain('2026-05-31');
    });
  });

  it('falls back to a placeholder title and the calendar id', () => {
    const md = calendarEventToMarkdown(
      { start: { date: '2026-06-01' } },
      {
        id: CAL_A,
      },
    );
    expect(md).toContain('# (no title)');
    expect(md).toContain(`**Calendar:** ${CAL_A}`);
  });

  it('leaves rooms/equipment out of the human attendee list', () => {
    const md = calendarEventToMarkdown(
      timedEvent({
        attendees: [
          { email: 'alice@example.com' },
          { email: 'room-2@resource.example.com', resource: true },
        ],
      }),
      CALENDAR,
    );
    expect(md).toContain('**Attendees:** alice@example.com');
    expect(md).not.toContain('room-2@resource.example.com');
  });

  it('summarizes attendees past the listed cap as a count', () => {
    const md = calendarEventToMarkdown(
      timedEvent({
        attendees: Array.from({ length: 30 }, (_, i) => ({
          email: `person${i}@example.com`,
        })),
      }),
      CALENDAR,
    );
    expect(md).toContain('person0@example.com');
    expect(md).toContain('person24@example.com');
    expect(md).not.toContain('person25@example.com');
    expect(md).toContain('+5 more');
  });

  it('omits optional sections entirely when the event has nothing for them', () => {
    const md = calendarEventToMarkdown(timedEvent(), CALENDAR);
    expect(md).not.toContain('**Where:**');
    expect(md).not.toContain('**Organizer:**');
    expect(md).not.toContain('**Attendees:**');
  });

  // --- stored-XSS defense: event text is attacker-influenced free text ---

  it('escapes raw HTML in a description so the dashboard renders inert text', () => {
    const md = calendarEventToMarkdown(
      timedEvent({ description: '<img src=x onerror=alert(1)>' }),
      CALENDAR,
    );
    expect(md).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(md).not.toContain('<img');
  });

  it('escapes the summary, location, and attendee names too', () => {
    const md = calendarEventToMarkdown(
      timedEvent({
        summary: '<b>bold</b>',
        location: '<i>nowhere</i>',
        attendees: [
          { displayName: '<script>x</script>', email: 'a@example.com' },
        ],
      }),
      CALENDAR,
    );
    expect(md).toContain('# &lt;b&gt;bold&lt;/b&gt;');
    expect(md).toContain('**Where:** &lt;i&gt;nowhere&lt;/i&gt;');
    expect(md).toContain('&lt;script&gt;x&lt;/script&gt; (a@example.com)');
    expect(md).not.toContain('<script>');
  });
});

// --- calendarEventToConnectorDoc -----------------------------------------

describe('calendarEventToConnectorDoc', () => {
  it('maps id/title/sourceUrl/updatedAt and records raw, unshifted times', () => {
    const doc = calendarEventToConnectorDoc(allDayEvent(), CALENDAR);
    expect(doc.id).toBe('allday1');
    expect(doc.title).toBe('Company holiday');
    expect(doc.sourceUrl).toBe(
      'https://calendar.google.com/calendar/event?eid=allday1',
    );
    expect(doc.updatedAt).toBe('2026-05-20T12:00:00Z');
    expect(doc.extraFrontmatter).toEqual({
      calendar_id: CAL_A,
      event_id: 'allday1',
      // The strings Google sent, byte for byte — no Date round-trip.
      event_start: '2026-06-01',
      event_end: '2026-06-02',
      all_day: true,
    });
  });

  it('records a timed event as all_day:false with its RFC3339 stamps', () => {
    const doc = calendarEventToConnectorDoc(timedEvent(), CALENDAR);
    expect(doc.extraFrontmatter).toMatchObject({
      all_day: false,
      event_start: '2026-06-01T09:30:00-07:00',
      event_end: '2026-06-01T10:15:00-07:00',
    });
  });

  it('records the series id only for an expanded recurring instance', () => {
    const plain = calendarEventToConnectorDoc(timedEvent(), CALENDAR);
    expect(plain.extraFrontmatter).not.toHaveProperty('recurring_event_id');
    const instance = calendarEventToConnectorDoc(
      timedEvent({
        id: 'series1_20260601T163000Z',
        recurringEventId: 'series1',
      }),
      CALENDAR,
    );
    expect(instance.extraFrontmatter).toMatchObject({
      recurring_event_id: 'series1',
    });
  });

  it('falls back to an eventedit URL when htmlLink is missing', () => {
    const doc = calendarEventToConnectorDoc(
      timedEvent({ htmlLink: undefined, summary: undefined }),
      CALENDAR,
    );
    expect(doc.title).toBe('(no title)');
    expect(doc.sourceUrl).toBe(
      'https://calendar.google.com/calendar/u/0/r/eventedit/timed1',
    );
  });

  it('defaults synced events to a non-open visibility', () => {
    const doc = calendarEventToConnectorDoc(timedEvent(), CALENDAR);
    expect(doc.visibility).toBe('restricted');
    expect(doc.visibility).not.toBe('open');
  });
});

// --- Default visibility ---------------------------------------------------

describe('getGoogleCalendarDefaultVisibility', () => {
  afterEach(() => {
    delete process.env.GOOGLE_CALENDAR_DEFAULT_VISIBILITY;
    readEnvFileMock.mockReturnValue({});
  });

  it('defaults to restricted when unset', () => {
    expect(getGoogleCalendarDefaultVisibility()).toBe('restricted');
  });

  it('is overridable via GOOGLE_CALENDAR_DEFAULT_VISIBILITY in .env', () => {
    readEnvFileMock.mockReturnValue({
      GOOGLE_CALENDAR_DEFAULT_VISIBILITY: 'private',
    });
    expect(getGoogleCalendarDefaultVisibility()).toBe('private');
  });

  it('process.env takes precedence over .env', () => {
    readEnvFileMock.mockReturnValue({
      GOOGLE_CALENDAR_DEFAULT_VISIBILITY: 'private',
    });
    process.env.GOOGLE_CALENDAR_DEFAULT_VISIBILITY = 'open';
    expect(getGoogleCalendarDefaultVisibility()).toBe('open');
  });

  it('falls back to restricted on an unrecognized value (never silently widens)', () => {
    readEnvFileMock.mockReturnValue({
      GOOGLE_CALENDAR_DEFAULT_VISIBILITY: 'public',
    });
    expect(getGoogleCalendarDefaultVisibility()).toBe('restricted');
  });

  it('flows through to calendarEventToConnectorDoc', () => {
    readEnvFileMock.mockReturnValue({
      GOOGLE_CALENDAR_DEFAULT_VISIBILITY: 'private',
    });
    expect(calendarEventToConnectorDoc(timedEvent(), CALENDAR).visibility).toBe(
      'private',
    );
  });
});

// --- occurrenceKey (dedupe without collapsing a series) -------------------

describe('occurrenceKey', () => {
  it('keeps the instances of one recurring series DISTINCT', () => {
    // Every expanded instance shares iCalUID — only the start differs.
    const a = occurrenceKey({
      id: 'series1_20260601T163000Z',
      iCalUID: 'series1@example.com',
      start: { dateTime: '2026-06-01T09:30:00-07:00' },
    });
    const b = occurrenceKey({
      id: 'series1_20260608T163000Z',
      iCalUID: 'series1@example.com',
      start: { dateTime: '2026-06-08T09:30:00-07:00' },
    });
    expect(a).not.toBe(b);
  });

  it('collapses the same occurrence seen on two calendars', () => {
    const ev = timedEvent();
    expect(occurrenceKey(ev)).toBe(
      occurrenceKey({ ...ev, id: 'copy-on-cal-b' }),
    );
  });

  it('falls back to the event id when there is no iCalUID', () => {
    expect(occurrenceKey({ id: 'e1' })).toBe('id::e1');
    expect(occurrenceKey({ id: 'e1' })).not.toBe(occurrenceKey({ id: 'e2' }));
  });
});

// --- syncWindow ----------------------------------------------------------

describe('syncWindow', () => {
  it('anchors the window on the run start using the configured day counts', () => {
    const { timeMin, timeMax } = syncWindow('2026-06-01T00:00:00.000Z');
    expect(timeMin).toBe('2026-03-03T00:00:00.000Z'); // 90 days before
    expect(timeMax).toBe('2026-11-28T00:00:00.000Z'); // 180 days after
  });

  it('honors an explicit 0 as "no history" / "no look-ahead"', () => {
    const { timeMin, timeMax } = syncWindow('2026-06-01T00:00:00.000Z', 0, 0);
    expect(timeMin).toBe('2026-06-01T00:00:00.000Z');
    expect(timeMax).toBe('2026-06-01T00:00:00.000Z');
  });

  it('reads the window size from config, not a hardcoded constant', () => {
    configMock.GOOGLE_CALENDAR_WINDOW_PAST_DAYS = 1;
    configMock.GOOGLE_CALENDAR_WINDOW_FUTURE_DAYS = 2;
    const { timeMin, timeMax } = syncWindow('2026-06-10T00:00:00.000Z');
    expect(timeMin).toBe('2026-06-09T00:00:00.000Z');
    expect(timeMax).toBe('2026-06-12T00:00:00.000Z');
  });

  it('falls back to now for an unparseable syncStart rather than throwing', () => {
    const before = Date.now();
    const { timeMin, timeMax } = syncWindow('not-a-timestamp', 1, 1);
    expect(Date.parse(timeMin)).toBeGreaterThanOrEqual(
      before - 86_400_000 - 5000,
    );
    expect(Date.parse(timeMax)).toBeGreaterThan(Date.parse(timeMin));
  });
});

// --- isConfigured --------------------------------------------------------

describe('googleCalendarConnector.isConfigured', () => {
  it('is false when no calendar id is configured', () => {
    configMock.GOOGLE_CALENDAR_IDS = [];
    expect(googleCalendarConnector.isConfigured()).toBe(false);
  });

  it('is false when a calendar is configured but the creds file does not resolve', () => {
    configMock.GOOGLE_CALENDAR_IDS = [CAL_A];
    readEnvFileMock.mockReturnValue({
      GOOGLE_WORKSPACE_CREDENTIALS_FILE: '/nonexistent/creds.json',
    });
    expect(googleCalendarConnector.isConfigured()).toBe(false);
  });

  it('is true when both a calendar and a resolvable creds file are present', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcal-cfg-'));
    try {
      const credsPath = path.join(dir, 'creds.json');
      fs.writeFileSync(credsPath, JSON.stringify({ access_token: 'ya29.x' }));
      configMock.GOOGLE_CALENDAR_IDS = [CAL_A];
      readEnvFileMock.mockReturnValue({
        GOOGLE_WORKSPACE_CREDENTIALS_FILE: credsPath,
      });
      expect(googleCalendarConnector.isConfigured()).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('performs no network at all', () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    configMock.GOOGLE_CALENDAR_IDS = [CAL_A];
    googleCalendarConnector.isConfigured();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// --- Unconfigured no-op --------------------------------------------------

describe('googleCalendarConnector.sync (unconfigured)', () => {
  it('no-ops without touching the network when no calendar is configured', async () => {
    configMock.GOOGLE_CALENDAR_IDS = [];
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { ctx } = makeCtx({ fetchImpl });

    const res = await googleCalendarConnector.sync(ctx);

    expect(res.docs).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(credReads()).toBe(0);
  });

  it('reports complete:false so an empty pull can never reconcile the KB away', async () => {
    configMock.GOOGLE_CALENDAR_IDS = [];
    const { ctx } = makeCtx();
    // complete:true here would delete every previously-synced event file.
    expect((await googleCalendarConnector.sync(ctx)).complete).toBe(false);
  });
});

// --- sync (configured) ---------------------------------------------------

describe('googleCalendarConnector.sync', () => {
  let credsDir: string;
  let credsPath: string;

  beforeEach(() => {
    configMock.GOOGLE_CALENDAR_IDS = [CAL_A];
    // A temp gws-style creds file holding a direct access token, with the
    // mocked readEnvFile pointed at it — no real Google creds required.
    credsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcal-creds-'));
    credsPath = path.join(credsDir, 'creds.json');
    fs.writeFileSync(credsPath, JSON.stringify({ access_token: 'ya29.test' }));
    readEnvFileMock.mockReturnValue({
      GOOGLE_WORKSPACE_CREDENTIALS_FILE: credsPath,
    });
  });

  afterEach(() => {
    fs.rmSync(credsDir, { recursive: true, force: true });
    readEnvFileMock.mockReturnValue({});
  });

  it('carries an all-day event through to its doc without shifting the date', async () => {
    await withTimeZoneAsync(TZ_BEHIND_UTC, async () => {
      const { ctx } = makeCtx({
        fetchImpl: eventsFetch({ [CAL_A]: [page([allDayEvent()])] }),
      });

      const res = await googleCalendarConnector.sync(ctx);

      // Guard: the forced timezone is STILL in effect here, so the assertions
      // below really are running where the naive-Date bug would show up.
      expect(new Date('2026-06-01').getDate()).toBe(31);
      expect(res.complete).toBe(true);
      expect(res.docs).toHaveLength(1);
      expect(res.docs[0].markdown).toContain('**When:** 2026-06-01 (all day)');
      expect(res.docs[0].markdown).not.toContain('2026-05-31');
      expect(res.docs[0].extraFrontmatter?.event_start).toBe('2026-06-01');
    });
  });

  it("renders a timed event's wall-clock times", async () => {
    await withTimeZoneAsync(TZ_AHEAD_OF_UTC, async () => {
      const { ctx } = makeCtx({
        fetchImpl: eventsFetch({ [CAL_A]: [page([timedEvent()])] }),
      });

      const res = await googleCalendarConnector.sync(ctx);

      // Guard: the host would call this instant 2026-06-02 01:30.
      expect(
        new Date('2026-06-01T09:30:00-07:00').toLocaleString('en-CA'),
      ).toContain('2026-06-02');
      expect(res.docs[0].markdown).toContain(
        '**When:** 2026-06-01 09:30–10:15 (America/Los_Angeles)',
      );
    });
  });

  it('asks for expanded instances (singleEvents) inside the configured window', async () => {
    const fetchImpl = eventsFetch({ [CAL_A]: [page([])] });
    const { ctx } = makeCtx({ fetchImpl });

    await googleCalendarConnector.sync(ctx);

    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const q = new URL(String(url)).searchParams;
    // Without singleEvents a weekly meeting is ONE entry with a rule attached.
    expect(q.get('singleEvents')).toBe('true');
    expect(q.get('orderBy')).toBe('startTime');
    expect(q.get('timeMin')).toBe('2026-03-03T00:00:00.000Z');
    expect(q.get('timeMax')).toBe('2026-11-28T00:00:00.000Z');
    expect(String(url)).toContain(encodeURIComponent(CAL_A));
  });

  it('expands recurring instances into one doc each, with stable ids across syncs', async () => {
    const instances = [
      timedEvent({
        id: 'series1_20260601T163000Z',
        iCalUID: 'series1@example.com',
        recurringEventId: 'series1',
        summary: 'Team standup',
        start: {
          dateTime: '2026-06-01T09:30:00-07:00',
          timeZone: 'America/Los_Angeles',
        },
        end: {
          dateTime: '2026-06-01T10:00:00-07:00',
          timeZone: 'America/Los_Angeles',
        },
      }),
      timedEvent({
        id: 'series1_20260608T163000Z',
        iCalUID: 'series1@example.com',
        recurringEventId: 'series1',
        summary: 'Team standup',
        start: {
          dateTime: '2026-06-08T09:30:00-07:00',
          timeZone: 'America/Los_Angeles',
        },
        end: {
          dateTime: '2026-06-08T10:00:00-07:00',
          timeZone: 'America/Los_Angeles',
        },
      }),
    ];

    const { ctx: ctx1 } = makeCtx({
      fetchImpl: eventsFetch({ [CAL_A]: [page(instances)] }),
    });
    const run1 = await googleCalendarConnector.sync(ctx1);
    const { ctx: ctx2 } = makeCtx({
      fetchImpl: eventsFetch({ [CAL_A]: [page(instances)] }),
    });
    const run2 = await googleCalendarConnector.sync(ctx2);

    // Both occurrences survive the shared-iCalUID dedupe key…
    expect(run1.docs.map((d) => d.id)).toEqual([
      'series1_20260601T163000Z',
      'series1_20260608T163000Z',
    ]);
    // …and the ids are identical next sync, so each upserts its own file.
    expect(run2.docs.map((d) => d.id)).toEqual(run1.docs.map((d) => d.id));
    expect(new Set(run2.docs.map((d) => d.id)).size).toBe(2);
    expect(run1.docs[0].markdown).toContain('2026-06-01 09:30');
    expect(run1.docs[1].markdown).toContain('2026-06-08 09:30');
  });

  it('skips a cancelled instance instead of writing it as a doc', async () => {
    const { ctx } = makeCtx({
      fetchImpl: eventsFetch({
        [CAL_A]: [
          page([
            timedEvent({ id: 'live1' }),
            // A deleted occurrence of a series comes back as a cancelled
            // placeholder; letting it through would resurrect a file the
            // reconcile pass just removed.
            { id: 'gone1', status: 'cancelled', summary: 'Team standup' },
          ]),
        ],
      }),
    });

    const res = await googleCalendarConnector.sync(ctx);

    expect(res.docs.map((d) => d.id)).toEqual(['live1']);
    expect(res.complete).toBe(true);
  });

  it('skips an event with no id', async () => {
    const { ctx } = makeCtx({
      fetchImpl: eventsFetch({
        [CAL_A]: [
          page([{ summary: 'Team standup', start: { date: '2026-06-01' } }]),
        ],
      }),
    });
    expect((await googleCalendarConnector.sync(ctx)).docs).toEqual([]);
  });

  it('paginates to the end of the calendar', async () => {
    const fetchImpl = eventsFetch({
      [CAL_A]: [
        page([timedEvent({ id: 'p1', iCalUID: 'p1@example.com' })], {
          nextPageToken: 'tok2',
        }),
        page([timedEvent({ id: 'p2', iCalUID: 'p2@example.com' })]),
      ],
    });
    const { ctx } = makeCtx({ fetchImpl });

    const res = await googleCalendarConnector.sync(ctx);

    expect(res.docs.map((d) => d.id).sort()).toEqual(['p1', 'p2']);
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(new URL(String(calls[1][0])).searchParams.get('pageToken')).toBe(
      'tok2',
    );
  });

  it('keeps one doc when the same meeting sits on two configured calendars', async () => {
    configMock.GOOGLE_CALENDAR_IDS = [CAL_A, CAL_B];
    const shared = timedEvent();
    const { ctx } = makeCtx({
      fetchImpl: eventsFetch({
        [CAL_A]: [page([shared], { summary: 'Team calendar' })],
        [CAL_B]: [
          page([{ ...shared, id: 'copy-on-b' }], {
            summary: 'Projects calendar',
          }),
        ],
      }),
    });

    const res = await googleCalendarConnector.sync(ctx);

    expect(res.docs).toHaveLength(1);
    // GOOGLE_CALENDAR_IDS is an explicit precedence order: first listed wins.
    expect(res.docs[0].id).toBe('timed1');
    expect(res.docs[0].markdown).toContain('**Calendar:** Team calendar');
  });

  it('resolves the configured visibility ONCE per run, not once per event', async () => {
    readEnvFileMock.mockReturnValue({
      GOOGLE_WORKSPACE_CREDENTIALS_FILE: credsPath,
      GOOGLE_CALENDAR_DEFAULT_VISIBILITY: 'private',
    });
    const { ctx } = makeCtx({
      fetchImpl: eventsFetch({
        [CAL_A]: [
          page([
            timedEvent({ id: 'v1', iCalUID: 'v1@example.com' }),
            timedEvent({ id: 'v2', iCalUID: 'v2@example.com' }),
            timedEvent({ id: 'v3', iCalUID: 'v3@example.com' }),
          ]),
        ],
      }),
    });

    const res = await googleCalendarConnector.sync(ctx);

    // Every doc still gets the configured value...
    expect(res.docs.map((d) => d.visibility)).toEqual([
      'private',
      'private',
      'private',
    ]);
    // ...resolved once for the run, not once per event. A page holds up to
    // EVENTS_PAGE_SIZE (2500) events and each read is a blocking readFileSync
    // in the process that also serves the chat channels.
    expect(visibilityReads()).toBe(1);
  });

  it('one unreachable calendar forces complete:false and keeps the others', async () => {
    configMock.GOOGLE_CALENDAR_IDS = [CAL_A, CAL_B];
    const { ctx } = makeCtx({
      fetchImpl: makeFetch((id) =>
        id === CAL_B
          ? jsonResponse({ error: 'boom' }, false, 500)
          : jsonResponse(page([timedEvent()])),
      ),
    });

    const res = await googleCalendarConnector.sync(ctx);

    expect(res.complete).toBe(false);
    expect(res.docs.map((d) => d.id)).toEqual(['timed1']);
    expect(warnings(ctx)).toEqual([
      'google-calendar: calendar fetch failed, skipping',
    ]);
  });

  it('warns per calendar on 403 — a per-calendar permission problem is not throttled', async () => {
    configMock.GOOGLE_CALENDAR_IDS = [CAL_A, CAL_B];
    const { ctx } = makeCtx({
      fetchImpl: makeFetch(() =>
        jsonResponse({ error: 'forbidden' }, false, 403),
      ),
    });

    const res = await googleCalendarConnector.sync(ctx);

    expect(res.complete).toBe(false);
    expect(warnings(ctx)).toEqual([
      'google-calendar: calendar fetch failed, skipping',
      'google-calendar: calendar fetch failed, skipping',
    ]);
  });

  // --- 401 → re-read the credential once, then carry on ---

  it('re-reads the credential exactly once on a 401 and finishes the sync', async () => {
    const { ctx } = makeCtx({
      fetchImpl: makeFetch((_id, call) =>
        call === 1
          ? jsonResponse({ error: 'unauthorized' }, false, 401)
          : jsonResponse(page([timedEvent()])),
      ),
    });

    const res = await googleCalendarConnector.sync(ctx);

    // One read for the pre-flight token, one for the post-401 re-auth.
    expect(credReads()).toBe(2);
    expect(res.complete).toBe(true);
    expect(res.docs.map((d) => d.id)).toEqual(['timed1']);
    expect(warnings(ctx)).toEqual([]);
  });

  it('caps re-auths at MAX_REAUTHS_PER_SYNC=1 across the whole run', async () => {
    configMock.GOOGLE_CALENDAR_IDS = [CAL_A, CAL_B];
    const { ctx } = makeCtx({
      // Every request 401s: a credential Google has revoked outright.
      fetchImpl: makeFetch(() =>
        jsonResponse({ error: 'unauthorized' }, false, 401),
      ),
    });

    const res = await googleCalendarConnector.sync(ctx);

    // Pre-flight + ONE re-auth, and the budget is per-SYNC: the second
    // calendar gets no re-read of its own.
    expect(credReads()).toBe(2);
    expect(res.docs).toEqual([]);
    expect(res.complete).toBe(false);
  });

  it('a 401 that survives the re-auth is a throttled credential warning, not an error', async () => {
    configMock.GOOGLE_CALENDAR_IDS = [CAL_A, CAL_B];
    const { ctx } = makeCtx({
      fetchImpl: makeFetch(() =>
        jsonResponse({ error: 'unauthorized' }, false, 401),
      ),
    });

    await expect(googleCalendarConnector.sync(ctx)).resolves.toBeTruthy();

    // Two failing calendars, ONE warning — the cause is one broken credential.
    expect(warnings(ctx)).toEqual([
      'google-calendar: Google credential rejected — further credential warnings suppressed for an hour',
    ]);
  });

  it('degrades quietly when there is no readable credential at all', async () => {
    readEnvFileMock.mockReturnValue({}); // creds path no longer resolves
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { ctx } = makeCtx({ fetchImpl });

    const res = await googleCalendarConnector.sync(ctx);

    // A standing misconfiguration, not an incident: no throw, no reconcile.
    expect(res).toEqual({ docs: [], complete: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warnings(ctx)).toHaveLength(1);
  });

  it('does not throw when the creds file is unparseable', async () => {
    fs.writeFileSync(credsPath, 'not json');
    const { ctx } = makeCtx({
      fetchImpl: eventsFetch({ [CAL_A]: [page([])] }),
    });
    await expect(googleCalendarConnector.sync(ctx)).resolves.toEqual({
      docs: [],
      complete: false,
    });
  });
});

// --- Credential-warning throttle (AUTH_WARN_INTERVAL_MS) -----------------

describe('google-calendar credential warning throttle', () => {
  let credsDir: string;

  /** A sync whose every request 401s, over `calendars` calendars. */
  function brokenCredentialCtx(
    syncStart: string,
    cursor: { value?: string },
  ): ConnectorContext {
    const { ctx } = makeCtx({
      syncStart,
      getCursor: () => cursor.value,
      setCursor: (v: string) => {
        cursor.value = v;
      },
      fetchImpl: makeFetch(() =>
        jsonResponse({ error: 'unauthorized' }, false, 401),
      ),
    });
    return ctx;
  }

  beforeEach(() => {
    configMock.GOOGLE_CALENDAR_IDS = [
      CAL_A,
      CAL_B,
      'third@group.calendar.example.com',
    ];
    credsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcal-throttle-'));
    const credsPath = path.join(credsDir, 'creds.json');
    fs.writeFileSync(credsPath, JSON.stringify({ access_token: 'ya29.test' }));
    readEnvFileMock.mockReturnValue({
      GOOGLE_WORKSPACE_CREDENTIALS_FILE: credsPath,
    });
  });

  afterEach(() => {
    fs.rmSync(credsDir, { recursive: true, force: true });
    readEnvFileMock.mockReturnValue({});
  });

  it('warns once per sync, not once per failing calendar', async () => {
    const cursor: { value?: string } = {};
    const ctx = brokenCredentialCtx('2026-06-01T00:00:00.000Z', cursor);

    await googleCalendarConnector.sync(ctx);

    expect(warnings(ctx)).toHaveLength(1);
  });

  it('stays silent on a second sync inside the warn interval', async () => {
    const cursor: { value?: string } = {};
    const first = brokenCredentialCtx('2026-06-01T00:00:00.000Z', cursor);
    await googleCalendarConnector.sync(first);
    // 5 minutes later — well inside AUTH_WARN_INTERVAL_MS (1h).
    const second = brokenCredentialCtx('2026-06-01T00:05:00.000Z', cursor);
    await googleCalendarConnector.sync(second);

    expect(warnings(first)).toHaveLength(1);
    expect(warnings(second)).toHaveLength(0);
  });

  it('warns again once the interval has elapsed', async () => {
    const cursor: { value?: string } = {};
    const first = brokenCredentialCtx('2026-06-01T00:00:00.000Z', cursor);
    await googleCalendarConnector.sync(first);
    // 2 hours later — past the 1h interval, so the condition is re-reported.
    const second = brokenCredentialCtx('2026-06-01T02:00:00.000Z', cursor);
    await googleCalendarConnector.sync(second);

    expect(warnings(second)).toHaveLength(1);
  });

  it('survives a restart: the throttle marker is persisted, not in-memory', async () => {
    const cursor: { value?: string } = {};
    await googleCalendarConnector.sync(
      brokenCredentialCtx('2026-06-01T00:00:00.000Z', cursor),
    );
    // The marker lives in the connector's persisted state slot, so a
    // crash-looping orchestrator cannot reset the throttle by restarting.
    expect(Number(cursor.value)).toBe(Date.parse('2026-06-01T00:00:00.000Z'));
  });

  it('a garbage marker never silences the warning', async () => {
    const cursor: { value?: string } = { value: 'not-a-number' };
    const ctx = brokenCredentialCtx('2026-06-01T00:00:00.000Z', cursor);
    await googleCalendarConnector.sync(ctx);
    expect(warnings(ctx)).toHaveLength(1);
  });

  it('a future-dated marker never silences the warning indefinitely', async () => {
    const cursor: { value?: string } = {
      value: String(Date.parse('2030-01-01T00:00:00.000Z')),
    };
    const ctx = brokenCredentialCtx('2026-06-01T00:00:00.000Z', cursor);
    await googleCalendarConnector.sync(ctx);
    expect(warnings(ctx)).toHaveLength(1);
  });
});

// --- runConnector: KB writes + reconcile --------------------------------

describe('google-calendar KB writes and reconcile', () => {
  let credsDir: string;
  let kbDir: string;

  beforeEach(() => {
    configMock.GOOGLE_CALENDAR_IDS = [CAL_A];
    credsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcal-rc-creds-'));
    const credsPath = path.join(credsDir, 'creds.json');
    fs.writeFileSync(credsPath, JSON.stringify({ access_token: 'ya29.test' }));
    readEnvFileMock.mockReturnValue({
      GOOGLE_WORKSPACE_CREDENTIALS_FILE: credsPath,
    });
    kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcal-kb-'));
  });

  afterEach(() => {
    fs.rmSync(credsDir, { recursive: true, force: true });
    fs.rmSync(kbDir, { recursive: true, force: true });
    readEnvFileMock.mockReturnValue({});
  });

  function run(items: CalendarEvent[], now: string) {
    return runConnector(
      { ...googleCalendarConnector, syncInterval: 0 },
      {
        fetchImpl: eventsFetch({ [CAL_A]: [page(items)] }),
        dir: kbDir,
        now: () => now,
      },
    );
  }

  function mdFiles(): string[] {
    return fs
      .readdirSync(kbDir)
      .filter((f) => f.endsWith('.md'))
      .sort();
  }

  const E1 = timedEvent({ id: 'E1', iCalUID: 'e1@example.com' });
  const E2 = allDayEvent({ id: 'E2', iCalUID: 'e2@example.com' });

  it('writes one file per occurrence and re-upserts the same files next run', async () => {
    const r1 = await run([E1, E2], '2026-06-01T01:00:00.000Z');
    expect(r1.upserted).toBe(2);
    expect(mdFiles()).toEqual(['E1.md', 'E2.md']);

    const r2 = await run([E1, E2], '2026-06-01T02:00:00.000Z');
    // Stable ids mean idempotent upserts — no duplicates, nothing swept.
    expect(r2.upserted).toBe(2);
    expect(r2.deleted).toBe(0);
    expect(mdFiles()).toEqual(['E1.md', 'E2.md']);
  });

  it('writes the all-day date unshifted into the KB file', async () => {
    await withTimeZoneAsync(TZ_BEHIND_UTC, async () => {
      await run([E2], '2026-06-01T01:00:00.000Z');
      const text = fs.readFileSync(path.join(kbDir, 'E2.md'), 'utf-8');
      expect(new Date('2026-06-01').getDate()).toBe(31); // guard, see above
      expect(text).toContain('2026-06-01 (all day)');
      expect(text).toContain("event_start: '2026-06-01'");
      expect(text).toContain('all_day: true');
      expect(text).not.toContain('2026-05-31');
    });
  });

  it('deletes an event removed upstream on a later complete run', async () => {
    await run([E1, E2], '2026-06-01T01:00:00.000Z');
    const r2 = await run([E1], '2026-06-01T02:00:00.000Z');
    // The SECOND complete run reconciles — reconcile isn't a first-run-only
    // event, which is also how events scrolling off the window leave the KB.
    expect(r2.deleted).toBe(1);
    expect(mdFiles()).toEqual(['E1.md']);
  });

  it('treats a cancelled instance as a deletion, not a doc', async () => {
    await run([E1, E2], '2026-06-01T01:00:00.000Z');
    expect(mdFiles()).toEqual(['E1.md', 'E2.md']);

    const r2 = await run(
      [E1, { ...E2, status: 'cancelled' }],
      '2026-06-01T02:00:00.000Z',
    );

    expect(r2.upserted).toBe(1);
    expect(r2.deleted).toBe(1);
    expect(mdFiles()).toEqual(['E1.md']);
  });

  it('an incomplete pull never reconciles', async () => {
    configMock.GOOGLE_CALENDAR_IDS = [CAL_A, CAL_B];
    await runConnector(
      { ...googleCalendarConnector, syncInterval: 0 },
      {
        fetchImpl: eventsFetch({
          [CAL_A]: [page([E1])],
          [CAL_B]: [page([E2])],
        }),
        dir: kbDir,
        now: () => '2026-06-01T01:00:00.000Z',
      },
    );
    expect(mdFiles()).toEqual(['E1.md', 'E2.md']);

    // CAL_B now fails: E2 isn't re-written, but it must NOT be swept.
    const r2 = await runConnector(
      { ...googleCalendarConnector, syncInterval: 0 },
      {
        fetchImpl: makeFetch((id) =>
          id === CAL_B
            ? jsonResponse({ error: 'boom' }, false, 500)
            : jsonResponse(page([E1])),
        ),
        dir: kbDir,
        now: () => '2026-06-01T02:00:00.000Z',
      },
    );

    expect(r2.complete).toBe(false);
    expect(r2.deleted).toBe(0);
    expect(mdFiles()).toEqual(['E1.md', 'E2.md']);
  });

  it('records the citable frontmatter the KB and citations skill need', async () => {
    await run([E1], '2026-06-01T01:00:00.000Z');
    const text = fs.readFileSync(path.join(kbDir, 'E1.md'), 'utf-8');
    expect(text).toContain('source: google-calendar');
    expect(text).toContain('title: Team standup');
    expect(text).toContain(
      "source_url: 'https://calendar.google.com/calendar/event?eid=timed1'",
    );
    expect(text).toContain(
      '[View source](https://calendar.google.com/calendar/event?eid=timed1)',
    );
    expect(text).toContain('visibility: restricted');
    expect(text).toContain('synced_at:');
    expect(text).toContain(`calendar_id: ${CAL_A}`);
  });
});
