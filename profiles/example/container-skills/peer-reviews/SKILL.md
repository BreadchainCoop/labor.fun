---
name: peer-reviews
description: Quarterly peer-review + self-evaluation support. Use when (a) a member replies in DM to a peer-review/self-eval nudge — help them write and FILE their self-evaluation or a peer review to the KB; or (b) they want to schedule a peer-review meeting — book it on Google Calendar with both people.
---

# Quarterly peer reviews & self-evaluations

The `peer-reviews` flow (a profile plugin) DMs each member their quarterly
assignment — write a self-evaluation, and review two assigned peers — and
nudges until done. You are the receiving end: you **help members complete and
file** these, and you **schedule the review meetings**.

The quarter label looks like `2026-Q2` (the quarter being closed out). Take it
from the nudge message in the DM; if unsure, ask.

## Filing a self-evaluation

Trigger: a member replies wanting to do their self-eval, or says "file my
self-eval".

1. **Pull their last-quarter goals** so they evaluate against what they set,
   not from a blank page. Look in the shared KB (read-only at
   `/workspace/shared-kb/`): the prior quarter's self-eval
   (`peer-reviews/<prev-quarter>/self-eval/<slug>.md`), their people file, and
   any goals/`directives` docs. If you genuinely can't find goals, say so and
   ask them to restate the goals they set.
2. Help them reflect: progress against each goal, what landed, what slipped,
   what they want next quarter. Keep their voice — don't rewrite it into
   corporate tone.
3. **File it** via `modify_kb_file`:
   - path: `peer-reviews/<QUARTER>/self-eval/<slug>.md`
   - content: frontmatter (`author: <slug>`, `date: <ISO date>`,
     `quarter: <QUARTER>`) then the self-evaluation.
4. Confirm it's filed (the flow reads file existence to stop nudging).

## Filing a peer review

Trigger: a member is writing one of their assigned peer reviews (the nudge
told them whom — e.g. "a peer review of Marv"), or says "record my review of X".

1. Resolve the reviewee to their KB slug (match against
   `/workspace/shared-kb/people/`).
2. Help the reviewer write a fair, specific review of that peer's quarter.
3. **File it** via `modify_kb_file`:
   - path: `peer-reviews/<QUARTER>/reviews/<reviewer-slug>--<reviewee-slug>.md`
     (double hyphen separates the two slugs — match it exactly; the flow keys
     completion off this filename).
   - content: frontmatter (`reviewer: <slug>`, `reviewee: <slug>`,
     `date: <ISO date>`, `quarter: <QUARTER>`) then the review.
4. Confirm filed. Two filed reviews of a member = their requirement met.

> Reviewer ≠ reviewee. Never let someone file a "review" of themselves into the
> reviews/ directory — that's a self-eval.

## Auto-scheduling review meetings

When auto-scheduling is on, the flow asks each member for their availability and
then has *you* match partners and book the meetings. Two halves:

### A. Filing a member's availability (DM)

Trigger: a member's DM reply includes when they're free this week (the first
nudge asked for it), or they say "here's my availability".

1. Parse their free windows for **this week** into concrete day+time ranges
   (resolve "Tue afternoon" / "after 2pm" against the current week and the
   server timezone). Ask a quick clarifying question only if it's truly
   ambiguous.
2. **File it** via `modify_kb_file`:
   - path: `peer-reviews/<QUARTER>/availability/<slug>.md`
   - content: frontmatter (`slug`, `quarter`, `week_of: <ISO date>`) and a
     `windows:` YAML list of `{ start: <ISO datetime>, end: <ISO datetime> }`,
     followed by their words verbatim.
3. Confirm filed. Existence of this file is how the flow knows they've answered.

### B. Booking a meeting for a pair (scheduled task)

Trigger: a scheduled task asks you to schedule the meeting between two people
for a quarter. This fires once **both** have filed availability.

You have the `gws` Google Workspace tools (`mcp__gws__*`, calendar included).
Run `gws_discover` (or the calendar tool's discovery) to find the create-event
operation, then:

1. **Stop if already done** — if `peer-reviews/<QUARTER>/meetings/<a>--<b>.md`
   exists, do nothing (avoids double-booking).
2. Read both availability files; intersect the windows to find a slot that
   works for both (default **30 minutes**). One meeting covers both review
   directions if the pair reviews each other.
3. **Create the calendar event** with both as attendees (emails from their
   people files; if one is missing, ask that person in DM and pause), title
   `Peer review: <a> ↔ <b> (<QUARTER>)`, short description. Let Google send the
   invites.
4. DM both the booked time.
5. **Record it**: write `peer-reviews/<QUARTER>/meetings/<a>--<b>.md` (the same
   `<a>--<b>` sorted-slug key from the task) via `modify_kb_file` with the
   booked time. **If you can't find an overlap or can't book**, DM both asking
   them to coordinate directly — and **still write that file** noting "manual
   coordination", so the flow stops retrying.

Scheduling is a convenience — the requirement is the *filed review*, so keep
nudging toward that regardless of the meeting. Never claim you booked something
you didn't; only after the calendar event and the `meetings/` file are written.

## Tone

Supportive and low-friction — reviews are a chore people put off. Make it easy:
pull the context, draft with them, file it, offer to schedule. Never fabricate
a filed review or a booked meeting; only claim it once the write/booking
succeeded.
