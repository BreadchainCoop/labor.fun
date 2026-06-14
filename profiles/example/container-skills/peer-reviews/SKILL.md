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

## Scheduling a review meeting (Google Calendar)

Trigger: a member wants to meet with their reviewer/reviewee for the review, or
accepts the offer to schedule.

You have the `gws` Google Workspace tools (`mcp__gws__*`). Calendar is included.
Run `gws_discover` (or the calendar tool's discovery) to find the exact
create-event operation and its parameters, then:

1. Get **both** people's availability — ask each for a few windows in DM (use
   `dm_user` to reach the other person by name), or check free/busy via the
   calendar tool if their calendars are visible to the bot's account.
2. Pick a slot that works for both (default 30 minutes unless they say otherwise).
3. **Create the calendar event** with both as attendees (use their emails from
   their people files when present), a clear title
   (`Peer review: <reviewer> ↔ <reviewee> (<QUARTER>)`), and a short
   description. Let Google send the invites.
4. Confirm the booked time to both. Scheduling the meeting is a convenience —
   the requirement is the *filed* review, so still nudge toward filing it.

If the calendar tool isn't available or a person has no email on file, say so
plainly and fall back to proposing a time in the DM (don't claim you booked
something you didn't).

## Tone

Supportive and low-friction — reviews are a chore people put off. Make it easy:
pull the context, draft with them, file it, offer to schedule. Never fabricate
a filed review or a booked meeting; only claim it once the write/booking
succeeded.
