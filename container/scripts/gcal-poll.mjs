#!/usr/bin/env node
/**
 * Google Calendar poll script gate.
 * Checks for event changes since last sync and outputs script-gate JSON.
 *
 * Reads credentials from GOOGLE_OAUTH_CREDENTIALS env var (mounted config dir).
 * Stores last sync timestamp in /workspace/group/.gcal-sync-state.json.
 *
 * Output: { "wakeAgent": true/false, "data": { "changes": [...] } }
 */

import fs from 'fs';
import path from 'path';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

const STATE_FILE = '/workspace/group/.gcal-sync-state.json';
const accountMode = process.env.GOOGLE_ACCOUNT_MODE || 'breadbrich';
const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';

function loadCredentials() {
  const credsPath = process.env.GOOGLE_OAUTH_CREDENTIALS;
  if (!credsPath) throw new Error('GOOGLE_OAUTH_CREDENTIALS not set');

  const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
  const tokensPath = path.join(path.dirname(credsPath), 'tokens.json');
  const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));

  const account = tokens[accountMode];
  if (!account) throw new Error(`No token for account "${accountMode}"`);

  return {
    clientId: creds.installed.client_id,
    clientSecret: creds.installed.client_secret,
    refreshToken: account.refresh_token,
  };
}

async function getAccessToken(clientId, clientSecret, refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function pollChanges(accessToken, lastSync) {
  const params = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
  });

  if (lastSync) {
    // Only get events updated since last sync
    params.set('updatedMin', lastSync);
    // Include cancelled events so we can detect deletions
    params.set('showDeleted', 'true');
  } else {
    // First sync: get upcoming events from now
    params.set('timeMin', new Date().toISOString());
  }

  const url = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) throw new Error(`Calendar API error: ${res.status}`);
  const data = await res.json();
  return (data.items || []).map((e) => ({
    id: e.id,
    summary: e.summary || '(no title)',
    description: e.description || null,
    start: e.start?.dateTime || e.start?.date || null,
    end: e.end?.dateTime || e.end?.date || null,
    location: e.location || null,
    status: e.status, // "confirmed", "tentative", "cancelled"
    updated: e.updated,
    htmlLink: e.htmlLink,
    attendees: e.attendees?.map((a) => ({
      email: a.email,
      name: a.displayName,
      status: a.responseStatus,
    })),
    recurrence: e.recurrence || null,
  }));
}

async function main() {
  try {
    const { clientId, clientSecret, refreshToken } = loadCredentials();
    const accessToken = await getAccessToken(clientId, clientSecret, refreshToken);
    const state = loadState();

    const changes = await pollChanges(accessToken, state.lastSync);
    const now = new Date().toISOString();

    // Save sync timestamp for next run
    saveState({ lastSync: now, lastCheckEvents: changes.length });

    if (changes.length === 0) {
      console.log(JSON.stringify({ wakeAgent: false }));
    } else {
      console.log(
        JSON.stringify({
          wakeAgent: true,
          data: {
            calendarId,
            syncedAt: now,
            isFirstSync: !state.lastSync,
            changes,
          },
        }),
      );
    }
  } catch (err) {
    console.error(`gcal-poll error: ${err.message}`);
    console.log(JSON.stringify({ wakeAgent: false }));
  }
}

main();
