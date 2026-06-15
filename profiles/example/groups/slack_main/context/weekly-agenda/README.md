# Weekly Core Meeting agenda automation

KB home of the weekly-meeting prep flow, driven by the `weekly-agenda` profile
plugin (`<profile>/plugins/weekly-agenda.mjs`) and the `weekly-agenda` container
skill.

## What it does

Each week, `prep_days_before` the meeting, the flow:

1. Fires a one-shot agent task that **rebuilds the agenda's "This Week" tab** —
   it first **archives** the previous week's contents into the doc's permanent
   **Archive tab**, then writes a fresh dated skeleton pre-filled with the
   week's facilitator and auto-pulled context (recent merged PRs / closed issues
   per project, upcoming calendar events).
2. **DMs every project owner** (and the facilitator) to fill in their section,
   re-nudging on a cadence until they do, and **escalating once** in the core
   channel if someone stays silent past `max_nudges`.

> **Why two permanent tabs, not a new tab per week:** the Google Docs API can
> read tabs and write into existing ones, but **cannot create a tab
> programmatically** (open, unshipped feature request). So the bot owns two
> tabs it only ever *writes into* — "This Week" (rewritten each cycle) and
> "Archive" (appended to). Create those two tabs by hand once and paste their
> tab IDs into the config.

## Layout

| Path | What | Written by |
|------|------|-----------|
| `config.md` | Flow config: channel, doc + tab IDs, cadence, owners, facilitators (below) | humans |
| `inputs/<week>/<slug>.md` | One owner's filed update (existence = "responded", stops their nudges) | the assistant (DM), or humans by hand |
| `state/<week>.json` | Plugin bookkeeping (build-requested flag, nudge counts) | the plugin |

`<week>` is the meeting's local date, `YYYY-MM-DD`.

## config.md format

```markdown
---
channel_jid: dc:1291131577874514001   # core-team channel; must be a REGISTERED group
doc_id: 1A0XLTzzfxIoUSAw_xRi-k1pD854ZEx2YkBZAO6sjdrc   # the agenda Google Doc
this_week_tab_id: t.xxxxxxxxxxxx       # permanent "This Week" tab (bot rewrites it)
archive_tab_id:  t.yyyyyyyyyyyy        # permanent "Archive" tab (bot appends to it)
meeting_day: 3                         # 0=Sun … 3=Wed (default 3)
meeting_hour: 16                       # local hour of the meeting (default 16)
prep_days_before: 2                    # build + start nudging N days before (default 2)
nudge_every_days: 1                    # re-ask cadence per owner (default 1)
max_nudges: 3                          # then escalate once in the channel (default 3)
directives_doc: artifacts/breadchain-strategy-directives-q2-2026.md  # optional — KB path to the quarter's strategic directives; drives the agenda's "Goals Review"
deadline_digest: deadline-digest.md    # optional — KB path to the auto-maintained deadline list (default deadline-digest.md); drives "Upcoming Deadlines"
github_org: BreadchainCoop             # optional — GitHub org to mine for each owner's recent merged PRs / closed issues (else the agent's profile org)
owners:                                # project label -> KB people slug
  Design: ruben
  Stacks: bren
  Operations / BD: josh
  Marketing: marv
  Community: gilberto
  Information pathways: rather
  CoopStable: ruben
  Crowdstake.fun: ron
  Sigstack: ron
  Breadrich Engels: ron
  Solidarity Fund: blessing
facilitators:                          # meeting date -> KB people slug. QUOTE the dates!
  '2026-06-17': marv
  '2026-06-24': gilberto
---

Free text: who maintains this config, the meeting link, etc.
```

Notes:

- **Quote the facilitator dates** (`'2026-06-17'`). Unquoted, YAML parses them
  as timestamps; the plugin defends against this but quoting is clearer.
- Every `owners`/`facilitators` slug should have a `people/<slug>.md` with a
  `discord_id`, so channel posts actually ping them — and a `github_username`,
  so the build agent can attribute each person's merged PRs / closed issues.
- The flow is a **no-op until `config.md` exists** with a `channel_jid` and a
  non-empty `owners` map — creating that file (with the plugin installed) turns
  it on. Delete it to turn the flow off. State is per-week, so a misfire can be
  reset by deleting `state/<week>.json`.
