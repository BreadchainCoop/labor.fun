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
`meeting_day/hour`, and optionally `directives_doc`, `deadline_digest`,
`github_org`). Read it first — never hardcode IDs.

The build task prompt already spells out the exact sections and quality bar for
the week — follow it. This skill is the durable reference for *how* to do the
Google Docs work well; the prompt is the per-week source of truth for *what* to
put in. When they agree, do what they say; the goal is a polished,
decision-ready agenda, not a bare skeleton.

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
   agenda dated `<week>` with these sections, in order:
   - `🏁 Check In (5min)`
   - `✍️ Revise Agenda`
   - `🎯 Goals Review` — one sub-bullet **per numbered strategic priority** from
     the `directives_doc`; for each, a one-line read on where we stand vs its
     success metrics this week, citing the shipped work in Active Projects.
     Bold-flag any priority that looks behind.
   - `📅 Upcoming Deadlines` — from the `deadline_digest`, the items due **this
     week and next week that are still open** (skip ✅-done ones), with anything
     **overdue-and-still-open** at the top under a bold "Overdue". Each line is a
     hyperlink (to the GitHub issue/PR where it is one) + date + owner.
   - `🧑‍🏭 Contributor Pipeline`
   - `‼️ Urgent Topics`
   - `🌱 Active Projects — Updates` — one bold sub-heading per **owners** entry,
     labelled `• <Project> — <owner name>`, with the pre-fill below under each.
   - `🎉 Appreciations — 3 MINIMUM`
   - `💰 Other topics / Upcoming Time Off`
   Put the facilitator on the header line (`Facilitator: <name>`), or
   `Facilitator: TBD — claim it` when none is set.
4. **Pre-fill context** — make it rich, not a stub:
   - GitHub: read each owner's `github_username` from `people/<slug>.md`, then
     mine `github_org`'s repos for their **merged PRs and closed issues in the
     last 7 days**. Under each project, write a tight bullet list — every bullet
     a **real hyperlink** on `title (#num)` plus a 4–8 word summary of what it
     did. No activity → `— no merged PRs / closed issues this week —`.
   - Calendar: add upcoming events in the next 7 days to the relevant section
     (Community/Events) if a calendar is configured.
   Terse but informative — one line per bullet. This is the scaffolding + facts
   owners build their narrative on, so give them real signal, not placeholders.
5. **Formatting quality.** Use the Docs API to make **real** bulleted lists
   (`createParagraphBullets`) and **real hyperlinks** (`updateTextStyle` with a
   `link.url` over the title text — never paste raw URLs). Bold the project and
   priority labels. One line per bullet. It should read like a polished agenda a
   facilitator can run the meeting from.
6. **Verify, then mark done.** Re-read the **This Week** tab and confirm the
   real content landed — the dated header, the **Goals Review** bullets, the
   **Upcoming Deadlines** list, and the per-project activity (not just empty
   section headers). **Only if it did**, write the marker file
   `weekly-agenda/built/<week>.md` via `modify_kb_file` (a one-line note is
   enough). That marker is what tells the flow the agenda is ready — the flow
   then posts the kickoff and starts nudging owners. **Do not post a "ready"
   message yourself** (the flow does, only after the marker exists), and **do
   not** write the marker if the write didn't land.
7. **On failure, say so — don't go quiet.** If the Docs write or the verify
   failed (missing/empty tab, no Docs access, API error), do **not** write the
   marker. Post a short message in `channel_jid` explaining the build failed and
   why, so a human can fix it (and the flow will retry the build automatically).

## File-an-update routine

**When this fires.** Any time a project owner sends you something that reads
like their update on their project(s) during an active agenda cycle — a list of
what they shipped, a status, "for design: …", "my update:", a paragraph about
their work — that **is** a weekly update. Treat it as one even if they didn't
say "weekly agenda" and even if the flow didn't just nudge them. If you're
unsure whether a message counts, assume it does and file it; over-filing is
harmless, a silent drop is not.

**Discussing the update is NOT filing it.** Drafting agenda points back to them,
summarizing what they said, or saying "got it, I'll add that" does **nothing**
on its own — the flow only sees a reply once the marker file exists. So:

1. **Identify** the current `<week>` (next meeting date from the config) and the
   owner's slug (from their identity → `people/<slug>.md`).
2. **Write the marker FIRST** — before any Docs work. Write
   `weekly-agenda/inputs/<week>/<slug>.md` via `modify_kb_file`, containing the
   verbatim text they sent. **This is the only thing that stops their nudges**
   and records their contribution; do it first so a slow or failing Docs step
   can never cause a silent drop. (If the file already exists, append the new
   content — they may be adding more.)
3. **Then edit the doc.** Insert their bullets under the matching
   `• <Project> — <owner>` line(s) in the **This Week** tab (append, don't
   overwrite).
4. **Verify the marker landed** — re-read `weekly-agenda/inputs/<week>/<slug>.md`
   and confirm it contains their content. If the write didn't land, retry it;
   the marker is non-negotiable.
5. **Reply** confirming it's filed and where it landed — one sentence. If the
   doc edit failed but the marker is written, say so plainly ("recorded your
   update; the doc edit hit an error, I'll sort it") — never imply success you
   didn't achieve.

## Tone

Helpful and low-friction. The agenda is a shared scratchpad the team fills in,
never a finished document you author for them. Don't over-format, don't nag
beyond what the flow already does.
