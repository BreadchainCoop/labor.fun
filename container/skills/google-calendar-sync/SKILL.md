---
name: google-calendar-sync
description: Two-way Google Calendar sync. Handles inbound sync (Google → KB calendar files) when woken by the gcal-poll script gate. Also provides outbound calendar management via MCP tools.
---

# Google Calendar Sync

You have access to `mcp__google-calendar__*` tools for reading and writing Google Calendar events.

## Inbound sync (scheduled task)

When woken by the gcal-poll script gate, you receive a `data` object with:
- `calendarId`: the Google Calendar ID being synced
- `isFirstSync`: true if this is the first sync (no prior state)
- `changes`: array of event objects with fields: `id`, `summary`, `description`, `start`, `end`, `location`, `status`, `updated`, `htmlLink`, `attendees`, `recurrence`

### Sync procedure

1. Read the current KB calendar files from `/workspace/group/context/calendar/`
2. For each changed event:
   - **`status: "cancelled"`** → Mark the matching KB file as `status: cancelled` (or delete if it was never manually edited)
   - **New event** (no matching KB file by Google event ID) → Create a new KB file following the schema in `context/calendar/README.md`
   - **Updated event** (matching KB file exists) → Update the KB file fields to match Google Calendar
3. KB filename format: `YYYY-MM-DD-slug.md` where the date is the event start date and slug is derived from the summary
4. Store the Google event ID in the frontmatter as `google_event_id: <id>` so future syncs can match events
5. After syncing, send a brief summary message to the group listing what changed (e.g. "Synced 3 calendar changes: added 'Team Meeting', updated 'Sprint Review', cancelled 'Standup'")

### KB file format

```yaml
---
title: Event Title
id: EVT-NNN
google_event_id: google_calendar_event_id_here
status: upcoming | recurring | cancelled | completed
created_by: Google Calendar Sync
created_at: YYYY-MM-DD
last_edited: YYYY-MM-DD
linked_tasks: []
tags: [google-calendar]
visibility: open
editable_by: open
---

Event description from Google Calendar.

**Time:** Start - End
**Location:** Location (if any)
**Attendees:** List (if any)
**Link:** Google Calendar link
```

### EVT ID assignment

Read existing calendar files to find the highest `EVT-NNN` ID, then increment for new events.

## Outbound (agent-initiated)

When a user asks to create, update, or delete a calendar event:
1. Use the `mcp__google-calendar__*` tools to make the change on Google Calendar
2. Also update the corresponding KB calendar file to keep them in sync
3. If creating a new event, store the returned Google event ID in the KB file's `google_event_id` field

## Setting up the sync task

To register the inbound sync as a scheduled task, use the `schedule_task` tool:

```
prompt: "Google Calendar sync triggered. Review the script output for calendar changes and sync them to the KB calendar files following the google-calendar-sync skill instructions."
schedule_type: "cron"
schedule_value: "*/15 * * * *"
context_mode: "isolated"
script: "node /app/scripts/gcal-poll.mjs"
```

This polls every 15 minutes. The script gate checks for changes and only wakes the agent when something changed, saving API credits.
