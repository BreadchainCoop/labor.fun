---
name: weekly-agenda
description: Build and maintain the Weekly Core Meeting agenda Google Doc — archive last week, write a fresh dated skeleton pre-filled with the facilitator and recent GitHub/calendar context, and file each owner's update when they reply in DM. Use when handed a "weekly-agenda build" task or when a project owner sends their weekly update.
---

# Weekly Core Meeting agenda

You maintain the team's weekly agenda Google Doc on behalf of the `weekly-agenda`
profile flow. The flow handles *scheduling and nudging*; you do the *Google Docs
work* and *file owner updates*. You're invoked two ways:

1. **Build task** (scheduled, isolated): a prompt that says
   "Weekly Core Meeting agenda build for `<week>`". Do the **Build** routine.
2. **Owner reply** (in a DM): a project owner sends their update for the week.
   Do the **File an update** routine.

Config lives in the KB at
`/workspace/shared-kb/weekly-agenda/config.md` (frontmatter: `doc_id`,
`this_week_tab_id`, `archive_tab_id`, `channel_jid`, `owners`, `facilitators`,
`meeting_day/hour`). Read it first — never hardcode IDs.

## Hard rule: never create a tab

The Google Docs API **cannot create tabs**. You only ever **read** tabs and
**write into the two existing ones** named in the config (`this_week_tab_id`,
`archive_tab_id`). If a tab ID is missing or wrong, post in the channel asking an
admin to create the tab and add its ID to the config — do **not** try to work
around it by restructuring the doc.

All Docs writes target a specific tab: in `documents.batchUpdate`, every
`location`/`range` must carry the `tabId`. Read with
`documents.get?includeTabsContent=true` and pull the tab whose
`tabProperties.tabId` matches.

## Build routine

Given a build task for `<week>` (a `YYYY-MM-DD` meeting date):

1. **Read config** and resolve `doc_id`, the two tab IDs, the `owners` map
   (project → person), and the `facilitators[<week>]` slug (may be empty).
2. **Archive last week.** Read the current text of the **This Week** tab. If it
   has real content (more than the bare skeleton), prepend it to the **Archive**
   tab under a `### <previous date>` heading — insert at the Archive tab's start
   so newest is on top. Use its existing title line for the date if present.
3. **Reset the This Week tab.** Delete its body content range and insert a fresh
   skeleton dated `<week>`:
   - `🏁 Check In (5min)`
   - `✍️ Revise Agenda`
   - `🎯 Goals review`
   - `🧑‍🏭 Contributor Pipeline`
   - `‼️ Urgent Topics`
   - `🌱 Active Projects — Updates` with one sub-bullet per **owners** entry,
     labelled `• <Project> (<owner name>)`
   - `🎉 Appreciations — 3 MINIMUM`
   - `💰 Other topics / Upcoming Time Off`
   Put the facilitator on the header line (`Facilitator: <name>`), or
   `Facilitator: TBD — claim it` when none is set.
4. **Pre-fill context** under each Active Projects bullet:
   - GitHub: for the repos in the config's org, list that owner's **merged PRs
     and closed issues from the last 7 days** (use the GitHub tools; keep it to
     titles + numbers). If you can't map a project to a repo, skip silently.
   - Calendar: add upcoming events in the next 7 days to the relevant section
     (Community/Events) if a calendar is configured.
   Keep pre-fill terse — it's a memory aid, not a report. Owners flesh it out.
5. **Announce.** The flow already posts the kickoff message, so you only need to
   confirm completion if something went wrong (missing tab, no GitHub access) —
   post that in the `channel_jid` so a human can fix it.

## File-an-update routine

When a project owner replies in DM with their weekly update:

1. Identify the current `<week>` (next meeting date from the config) and the
   owner's slug.
2. Insert their bullets under the matching `• <Project> (<owner>)` line(s) in the
   **This Week** tab (append, don't overwrite — they may add more later).
3. Write the marker file `weekly-agenda/inputs/<week>/<slug>.md` via
   `modify_kb_file` containing what they sent. **This is what stops their
   nudges** — the flow treats the file's existence as "responded", so always
   write it, even if the doc edit partially failed (note any failure in your
   reply).
4. Reply confirming where it landed. Light touch — a sentence is enough.

## Tone

Helpful and low-friction. The agenda is a shared scratchpad the team fills in,
never a finished document you author for them. Don't over-format, don't nag
beyond what the flow already does.
