# Quarterly peer reviews & self-evaluations

KB home of the peer-review flow, driven by the `peer-reviews` profile plugin
(`<profile>/plugins/peer-reviews.mjs`) and the `peer-reviews` container skill.
Tracks the two-peer-review requirement for next-quarter payment eligibility,
nudges members until done, and (via the agent) schedules review meetings.

## Layout

| Path | What | Written by |
|------|------|-----------|
| `config.md` | Flow config: members + channel + cadence + assignments (see below) | humans |
| `<quarter>/self-eval/<slug>.md` | A member's filed self-evaluation (existence = self-eval done) | the assistant (DM), or humans |
| `<quarter>/reviews/<reviewer>--<reviewee>.md` | A completed peer review (existence = that review done) | the assistant (DM), or humans |
| `<quarter>/availability/<slug>.md` | A member's free windows this week (auto-schedule only) | the assistant (DM) |
| `<quarter>/meetings/<a>--<b>.md` | A booked/coordinated review meeting for a pair (auto-schedule only) | the assistant (task) |
| `state/<quarter>.json` | Plugin bookkeeping (frozen assignments, nudge counts, announced/summary/match flags) | the plugin |

`<quarter>` is the quarter being closed out, e.g. `2026-Q2`.

## config.md format

```markdown
---
members:                 # KB people slugs (people/<slug>.md must exist)
  - jane-doe
  - john-doe
  - sam-roe
channel_jid: dc:123456789012345678   # where the cycle is announced / summarized; a REGISTERED group
reviews_required: 2                  # peer reviews each member must give/receive (round-robin)
window_weeks_before: 3               # optional — window opens N weeks before quarter end
window_weeks_after: 2                # optional — and stays open N weeks INTO next quarter (reviews finish there)
activate_on: 2026-06-30              # optional — stay dormant until this date even if the window is open ("queue" a cycle)
auto_schedule: true                  # optional — also collect availability and auto-book the review meetings (Google Calendar)
nudge_every_days: 4                  # optional — re-nudge cadence per member
max_nudges: 4                        # optional — then escalate once in the channel
summary_days_before_end: 7           # optional — post a status summary this many days before quarter end
# Optional explicit pairing instead of round-robin (ops owns the "valid peer /
# anonymity" policy). Omit to auto-assign each member the next two in the list.
# assignments:
#   jane-doe: [john-doe, sam-roe]
#   john-doe: [sam-roe, jane-doe]
#   sam-roe:  [jane-doe, john-doe]
---

Free text: notes on the review policy, what "valid peer" means here, etc.
```

The flow is a **silent no-op until `config.md` exists**, and only acts inside
the review window: `window_weeks_before` before the quarter end through
`window_weeks_after` into the next quarter (so a cycle that starts near quarter
end has runway to finish — reviews evaluate the quarter being closed out). Set
`activate_on` to keep it dormant until a chosen date even while the window is
open — handy to queue a cycle. Assignments are frozen in `state/<quarter>.json`
on the first tick so nudges stay consistent; to re-roll a quarter, delete that
state file. Reset/disable by editing or removing
`config.md`.

## Round-robin assignment

With no `assignments` block, member *i* (in listed order) reviews the next
`reviews_required` members, wrapping — so everyone gives and receives exactly
that many. Needs at least `reviews_required + 1` members to give everyone
distinct reviewers; with fewer it assigns as many as possible.

## Auto-scheduling (`auto_schedule: true`)

The first nudge also asks each member for their availability this week; the
assistant files it to `availability/<slug>.md`. Once **both** people in an
assigned pair have answered, the flow kicks a one-shot agent task that matches
a common 30-minute slot, books a Google Calendar event with both as attendees
(via the `gws` calendar tool), DMs them the time, and records it at
`meetings/<a>--<b>.md`. One meeting covers a mutual pairing. If no overlap is
found (or a calendar invite can't be sent), the assistant asks the pair to
coordinate directly and still records the meeting file so it stops retrying;
otherwise it re-attempts about daily until a meeting is recorded. The *filed
review* is the requirement — the meeting is assistance toward it.
