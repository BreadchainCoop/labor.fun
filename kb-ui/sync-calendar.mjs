/**
 * Google Calendar iCal sync.
 * Fetches a public Google Calendar iCal feed, parses VEVENT entries,
 * and upserts them into the events table via apps-db.
 */
import { syncCalendarEvents } from './apps-db.mjs';

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;

// TTL cache: avoid re-fetching if synced within last 5 minutes
let _lastSyncTime = 0;
let _lastSyncResult = null;
const SYNC_TTL_MS = 5 * 60 * 1000;

export async function syncGoogleCalendar() {
  try {
    if (!CALENDAR_ID) {
      return { synced: 0, updated: 0, error: 'GOOGLE_CALENDAR_ID not set in .env' };
    }
    const now = Date.now();
    if (_lastSyncResult && (now - _lastSyncTime) < SYNC_TTL_MS) {
      return _lastSyncResult;
    }
    const icalUrl = `https://calendar.google.com/calendar/ical/${encodeURIComponent(CALENDAR_ID)}/public/basic.ics`;
    const response = await fetch(icalUrl, { cache: 'no-store' });

    if (!response.ok) {
      return { synced: 0, updated: 0, error: 'Failed to fetch calendar' };
    }

    const icalData = await response.text();
    const events = parseICalEvents(icalData);
    const result = syncCalendarEvents(events);
    _lastSyncTime = Date.now();
    _lastSyncResult = result;
    return result;
  } catch (error) {
    console.error('Calendar sync error:', error);
    return { synced: 0, updated: 0, error: 'Failed to sync calendar' };
  }
}

function parseICalEvents(icalData) {
  const events = [];
  const lines = icalData.split(/\r?\n/);

  let currentEvent = null;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Handle line continuations
    while (i + 1 < lines.length && (lines[i + 1].startsWith(' ') || lines[i + 1].startsWith('\t'))) {
      i++;
      line += lines[i].substring(1);
    }

    if (line.startsWith('BEGIN:VEVENT')) {
      currentEvent = {};
    } else if (line.startsWith('END:VEVENT') && currentEvent) {
      if (currentEvent.uid && currentEvent.summary && currentEvent.start && currentEvent.end) {
        // Only keep future events
        if (new Date(currentEvent.end) > new Date()) {
          events.push(currentEvent);
        }
      }
      currentEvent = null;
    } else if (currentEvent) {
      const colonIndex = line.indexOf(':');
      if (colonIndex > -1) {
        const keyPart = line.substring(0, colonIndex);
        const value = line.substring(colonIndex + 1);
        const key = keyPart.split(';')[0];

        switch (key) {
          case 'UID':
            currentEvent.uid = value;
            break;
          case 'SUMMARY':
            currentEvent.summary = unescapeICalText(value);
            break;
          case 'DESCRIPTION':
            currentEvent.description = unescapeICalText(value);
            break;
          case 'LOCATION':
            currentEvent.location = unescapeICalText(value);
            break;
          case 'DTSTART':
            currentEvent.start = parseICalDate(value).toISOString();
            break;
          case 'DTEND':
            currentEvent.end = parseICalDate(value).toISOString();
            break;
        }
      }
    }
  }

  return events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
}

function parseICalDate(value) {
  // Date only: YYYYMMDD
  if (value.length === 8) {
    const year = parseInt(value.substring(0, 4));
    const month = parseInt(value.substring(4, 6)) - 1;
    const day = parseInt(value.substring(6, 8));
    return new Date(year, month, day);
  }

  // Date-time: YYYYMMDDTHHMMSS or YYYYMMDDTHHMMSSZ
  if (value.includes('T')) {
    const year = parseInt(value.substring(0, 4));
    const month = parseInt(value.substring(4, 6)) - 1;
    const day = parseInt(value.substring(6, 8));
    const hour = parseInt(value.substring(9, 11));
    const minute = parseInt(value.substring(11, 13));
    const second = parseInt(value.substring(13, 15)) || 0;

    if (value.endsWith('Z')) {
      return new Date(Date.UTC(year, month, day, hour, minute, second));
    }

    return new Date(year, month, day, hour, minute, second);
  }

  return new Date(value);
}

function unescapeICalText(text) {
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}
