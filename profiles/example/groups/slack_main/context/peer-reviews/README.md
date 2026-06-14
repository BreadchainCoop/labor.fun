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
| `state/<quarter>.json` | Plugin bookkeeping (frozen assignments, nudge counts, announced/summary flags) | the plugin |

`<quarter>` is the quarter being closed out, e.g. `2026-Q2`.

## config.md format

```markdown
---
members:                 # KB people slugs (people/<slug>.md must exist)
  - alice
  - bob
  - carol
channel_jid: dc:123456789012345678   # where the cycle is announced / summarized; a REGISTERED group
reviews_required: 2                  # peer reviews each member must give/receive (round-robin)
window_weeks_before: 6               # optional — cycle opens N weeks before quarter end
nudge_every_days: 4                  # optional — re-nudge cadence per member
max_nudges: 4                        # optional — then escalate once in the channel
summary_days_before_end: 7           # optional — post a status summary this many days before quarter end
# Optional explicit pairing instead of round-robin (ops owns the "valid peer /
# anonymity" policy). Omit to auto-assign each member the next two in the list.
# assignments:
#   alice: [bob, carol]
#   bob:   [carol, alice]
#   carol: [alice, bob]
---

Free text: notes on the review policy, what "valid peer" means here, etc.
```

The flow is a **silent no-op until `config.md` exists**, and only acts inside
the window (`window_weeks_before` → quarter end). Assignments are frozen in
`state/<quarter>.json` on the first tick so nudges stay consistent; to re-roll a
quarter, delete that state file. Reset/disable by editing or removing
`config.md`.

## Round-robin assignment

With no `assignments` block, member *i* (in listed order) reviews the next
`reviews_required` members, wrapping — so everyone gives and receives exactly
that many. Needs at least `reviews_required + 1` members to give everyone
distinct reviewers; with fewer it assigns as many as possible.
