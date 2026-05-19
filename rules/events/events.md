# Events Rules

## Overview

Events are synced from the organization's Google Calendar. They are NOT manually created
or deleted. The agent's role is to help assign people to roles and answer questions
about upcoming events.

## Who Can Assign

- Any community member can assign anyone to an event role.
- No approval chain. Assignments are immediate.
- Self-assignment is allowed ("I'll host the open mic").

## Roles

| Role | Description |
|------|-------------|
| host | Primary person running the event |
| setup | Preparing the space before the event |
| cleanup | Cleaning up after the event |
| catering | Food and drink preparation/service |
| security | Door and safety during the event |
| other | Catch-all for unlisted duties |

Multiple people can share the same role on one event.

## Calendar Sync

- Events come from a public Google Calendar iCal feed.
- Sync happens automatically on page load with a 5-minute cache TTL.
- Only future events are imported. Past events remain in the DB but are not re-synced.
- The `google_calendar_id` field (iCal UID) is the deduplication key.

## What the Agent Should Do

- When asked about upcoming events: use `list_events` and summarize.
- When asked to assign someone: use `assign_event_role`. If the person doesn't exist yet, just pass their name -- the system will create them.
- When asked who is assigned: use `get_event_assignments` and list by role.
- When asked to remove someone: use `remove_event_assignment` with the assignment ID.

## What the Agent Should NOT Do

- Do NOT create, edit, or delete events. They come from Google Calendar.
- Do NOT assign roles that aren't in the valid set.
- Do NOT guess event IDs. Always look up events first with `list_events`.

## Notifications

- No automated notifications for assignments (managed via the dashboard UI).
- If someone asks to be notified, note it but explain the system doesn't auto-notify yet.

## Dashboard

- The Events dashboard is at `/events` on the KB UI (kb.example.com).
- It shows upcoming/past events, current assignments, and an assignment modal.
- Users can also manage assignments through the dashboard directly.
