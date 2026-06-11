# Strategic Directives (SD) kickoff

KB home of the quarterly Strategic Directives flow, driven by the
`sd-kickoff` profile plugin (`<profile>/plugins/sd-kickoff.mjs`) and the
`sd-kickoff` container skill.

## Layout

| Path | What | Written by |
|------|------|-----------|
| `committee.md` | Flow config: committee roster + channel + cadence (see below) | humans |
| `template.md` | Optional draft skeleton the agent uses | humans |
| `inputs/<quarter>/<slug>.md` | One member's filed input (existence = "responded", stops their nudges) | the assistant (DM), or humans by hand |
| `drafts/<quarter>.md` | The AI-composed first draft | the assistant |
| `state/<quarter>.json` | Plugin bookkeeping (nudge counts, draft-requested flag) | the plugin |

## committee.md format

```markdown
---
members:            # KB people slugs (people/<slug>.md must exist with a discord_id)
  - alice
  - bob
channel_jid: dc:123456789012345678   # committee channel; must be a REGISTERED group
kickoff_weeks_before: 4              # optional — window opens N weeks before quarter end
nudge_every_days: 3                  # optional — re-ask cadence per member
max_nudges: 4                        # optional — then escalate once in the channel
draft_days_before_end: 7             # optional — draft even if inputs are missing
---

Free text: what this committee is, who maintains the roster.
```

The flow is a **silent no-op until `committee.md` exists** — creating that
file (with the plugin installed) is what turns it on. Delete it to turn the
flow off. State is per-quarter, so a misfire can be reset by deleting
`state/<quarter>.json`.
