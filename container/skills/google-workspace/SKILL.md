---
name: google-workspace
description: Use Google Workspace for the organization — create/read/update Google Calendar events, send/read Gmail, and work with Google Docs, Drive, Sheets, and Tasks. Use whenever someone asks to schedule an event, invite people, share a calendar/event link, email someone, or create/find a doc/sheet. Acts as the org's service account via the bundled `gws` MCP server (mcp__gws__* tools).
---

# Google Workspace (gws MCP server)

The organization's Google Workspace is available through the bundled **`gws`
MCP server** — NOT a raw CLI. It runs in compact tool-mode: one tool per
service (`mcp__gws__calendar`, `mcp__gws__gmail`, `mcp__gws__drive`,
`mcp__gws__docs`, `mcp__gws__sheets`, `mcp__gws__tasks`) plus a
**`mcp__gws__gws_discover`** meta-tool for drilling into a service's exact
methods and fields. It acts as the org's Google Workspace service account.

## Availability check

Run `printenv GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` (Bash). If it prints a
path, Google Workspace is configured and the `mcp__gws__*` tools are loaded —
just call them. If it's empty, tell the user Google Workspace isn't set up on
this deployment (don't pretend to create things).

## Tool shape

- Each service tool takes the target **method** (e.g. `events.insert`,
  `users.messages.send`) plus that method's parameters: path/query params
  (`calendarId`, `sendUpdates`, `eventId`, …) and the request body (the
  resource you're creating/patching) as structured JSON.
- Not sure of a method's name or fields? Call **`mcp__gws__gws_discover`**
  first (e.g. discover `calendar` → `events.insert`) instead of guessing.
- Responses are structured JSON — read ids/links (`id`, `htmlLink`,
  `documentId`, …) directly from the response.

## HARD RULES for calendar

- **Dedicated calendar only.** Read it with `printenv GOOGLE_WORKSPACE_CALENDAR_ID`
  and pass it as `calendarId`. **Never use `primary`** — that's the service
  account's personal calendar. If `GOOGLE_WORKSPACE_CALENDAR_ID` is empty,
  stop and tell the user it isn't configured.
- **Always invite by email.** Whenever the event has attendees, set
  `sendUpdates: "all"` in the request params so Google actually emails them.
  Omitting it silently adds people with no notification — never do that.
- **Share the link = the event's `htmlLink`.** Return the `htmlLink` from the
  insert response **verbatim** — that is the real, live event (RSVP, updates,
  attendee list). Do not rebuild or re-encode it.
  - It resolves for: invited attendees, anyone in the org's Google Workspace,
    and — **only if the events calendar is public** ("see all event
    details") — for everyone. If a recipient outside the domain gets "event
    not found", the calendar is not public; that's a calendar setting, not a
    link you can work around.
- **Never pass off a `render?action=TEMPLATE` / `r/eventedit` link as "the
  event."** Those only **prefill a NEW copy** in the recipient's own calendar —
  no RSVP, no live updates, not the shared event. Only send one if the person
  explicitly asks for an "add a copy to my calendar" link, and label it exactly
  that — never as the event/share link.
- **For a guaranteed working invite (no public calendar needed):** add the person
  as an **attendee by email** with `sendUpdates:"all"` — Google emails them the
  invite with the real, working link and RSVP. Collect emails in the KB people
  files to invite people directly.
- Prefer adding a Google Meet link for virtual/hybrid events.

## Create a calendar event

Call `mcp__gws__calendar` with method `events.insert`:

- params: `calendarId` = the value of `GOOGLE_WORKSPACE_CALENDAR_ID`,
  `sendUpdates` = `"all"`
- body:

```json
{
  "summary": "Community Dinner",
  "description": "Monthly dinner.",
  "location": "Organization HQ",
  "start": { "dateTime": "2026-07-10T18:00:00", "timeZone": "America/New_York" },
  "end": { "dateTime": "2026-07-10T21:00:00", "timeZone": "America/New_York" },
  "attendees": [{ "email": "guest@example.com" }]
}
```

The response includes `id` (the Google event id) and `htmlLink` — return
`htmlLink` verbatim as the event link.

## Other common operations

- **List upcoming events** — `mcp__gws__calendar` `events.list` with
  `calendarId` = `GOOGLE_WORKSPACE_CALENDAR_ID`, `timeMin`,
  `singleEvents: true`, `orderBy: "startTime"`.
- **Update an event** — `mcp__gws__calendar` `events.patch` with
  `calendarId`, `eventId`, `sendUpdates: "all"`, and only the fields to change
  in the body.
- **Cancel/delete an event** (notifies attendees) — `mcp__gws__calendar`
  `events.delete` with `calendarId`, `eventId`, `sendUpdates: "all"`.
- **Create a Google Doc** — `mcp__gws__docs` `documents.create` with
  `{"title": "Meeting Notes"}` (returns `documentId`).
- **Send an email** — `mcp__gws__gmail` `users.messages.send` with
  `userId: "me"` and a base64url RFC822 `raw` body.

## Tips

- Times: always include `timeZone` so events land at the right local time
  (check the deployment's `TZ` env or ask the user).
- Discover a method's exact fields with `mcp__gws__gws_discover` before
  composing an unfamiliar call.
- Read `id`, `htmlLink`, `documentId`, etc. from the structured response —
  never fabricate links.
- If a call fails with an auth/permission error, report it — don't silently
  pretend it worked or fall back to only recording locally.
