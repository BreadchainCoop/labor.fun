---
name: sd-kickoff
description: Strategic Directives kickoff support. Use when (a) a user's DM contains their input for the quarterly Strategic Directives after the assistant asked for it — file it to the KB; or (b) a scheduled task asks you to draft the quarter's Strategic Directives from the collected inputs.
---

# Strategic Directives kickoff

The SD kickoff flow (a profile plugin) DMs each Strategic Directives committee
member asking for next quarter's input, and keeps nudging until they respond.
You are the receiving end: you **file the inputs** and, later, **compose the
first draft**.

## Filing a member's input (DM conversations)

Trigger: the conversation shows the assistant asked for "Strategic Directives
input for <QUARTER>" (e.g. `2026-Q3`) and the user has now replied with their
input — or says something like "file my SD input".

1. Identify the quarter label from the assistant's ask message in this DM.
2. Identify the member's KB slug: match the sender to a person file in
   `/workspace/shared-kb/people/` (frontmatter `discord_id` / platform ids).
   The slug is the filename without `.md`.
3. Save the input via `modify_kb_file`:
   - path: `sd/inputs/<QUARTER>/<slug>.md`
   - content: YAML frontmatter (`author: <slug>`, `date: <ISO date>`,
     `quarter: <QUARTER>`) followed by the member's input **verbatim** —
     do not summarize, do not edit their words.
4. Confirm to the member: their input is filed and the nudges stop.

If they reply but explicitly decline to give input ("nothing from me this
quarter"), file that too — a declared "no input" is a response; silence is
what gets nudged.

## Drafting the quarter's Strategic Directives (scheduled task)

Trigger: a scheduled task prompt referencing this skill's Drafting section.

1. Read every file in `/workspace/shared-kb/sd/inputs/<QUARTER>/`.
2. Use `/workspace/shared-kb/sd/template.md` as the skeleton when it exists;
   otherwise structure as: context → directives (3–6) → per-role hours →
   open questions.
3. Hours guidance: read `expected_hours_per_week` from
   `/workspace/shared-kb/people/*.md` frontmatter and recommend an hours
   **range and a ceiling** per role. Capacity is self-declared — label it as
   such; never present it as verified.
4. Note any committee members who filed no input, so the committee follows up.
5. Save the draft to the KB (`sd/drafts/<QUARTER>.md` via `modify_kb_file`),
   then post it — or a tight summary plus a pointer to the full draft — in
   the channel the task runs in.

Tone rules: **receptive, not pushy**. The draft is a starting point for the
committee to react to. Never auto-publish it beyond the committee channel,
never present it as decided.
