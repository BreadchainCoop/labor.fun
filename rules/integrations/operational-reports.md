# Operational Reports (#34)

A recurring, leadership-facing readout of operational state so it stops being
asked for ad-hoc. Built **on top of** the PM orchestration layer (#31) and the
KB task graph — it's a read-only *report*, not an actor.

Implementation: `src/operational-report.ts` (pure analysis + markdown render),
`src/integrations/operational-report.ts` (the scheduled loop),
`src/member-profiles.ts` (declared capacity loader). Tunable via `OPS_REPORT_*`
env vars (see `.env.example`).

## What the report contains

- **What's late** — overdue tasks grouped **by team** and **by person**.
- **Bottlenecks** — tasks blocking downstream work, pulled straight from the PM
  layer's `classify()` (the same analysis the PM loop acts on, so they never
  disagree).
- **Load vs. capacity** — per member, open-task count and summed `estimate`
  (story points) against the hours/points they're *declared* to work, with a
  **soft** over-capacity flag.

## Decisions taken (the issue's open questions)

These were the "decisions required before building". The choices below are the
defaults; each is configurable.

### Audience — configurable, defaults to leadership-private

`OPS_REPORT_AUDIENCE` toggles rendering granularity:

- **`leaders`** (default) — full per-person hours/load table, the over-capacity
  check-in list, and pay-parity notes. Point `OPS_REPORT_TARGET_GROUP` at a
  **private leadership channel**.
- **`coop`** — team-level aggregates only: **no per-person hours**, no
  per-person overdue breakdown, and no owner names on task lines. Gentler
  framing; safe to post co-op-wide.

The same data builds either view; only the render changes. Respect the
[privacy policy](../access-control/privacy-policy.md) when choosing the target
channel.

### Hours verification — self-declared, never fabricated

We have **no verified time tracking**. So capacity is *self-declared* on member
profiles, and every hours/load figure in the report is labelled **"declared,
not verified"**. The system never invents hours it doesn't have:

- A member with **no** declared capacity still appears (by load) but gets **no**
  load ratio and is **never** flagged.
- Over-capacity is always a **soft** flag — a prompt to check in, not a verdict —
  and the report explicitly notes members work different amounts and are not all
  paid the same (the `pay_parity_note` field surfaces here).

### Effort estimation — route (a): AI-optimistic, human-corrected

Consistent with PM orchestration's "act first, then ask" philosophy. Load is
summed from each task's `estimate` (the AI/ProjectV2 optimistic estimate);
humans correct estimates after the fact via the normal task-edit flow, and the
next report reflects the correction.

## Member-profile capacity fields

Capacity lives on the person's KB profile (`context/people/<slug>.md`) — the
same files that act as the allowlist. All fields are **optional**:

```yaml
---
title: Jane Doe
slug: jane-doe
team: Operations            # groups the member in the report's "by team" view
expected_hours_per_week: 20 # declared, NOT verified
capacity_points: 8          # declared sprint capacity (same unit as task estimate)
pay_parity_note: part-time  # free-text caveat surfaced next to any flag
---
```

The report joins capacity to tasks by **display name**, matching task `owners`
frontmatter. The display name is read from `title:` (the framework's people-file
convention), falling back to `name:`; the `slug` also resolves.

## Cadence & idempotency

The loop **sweeps** on `OPS_REPORT_INTERVAL_MS` (default daily) but **posts at
most once per period** (`OPS_REPORT_PERIOD`: `weekly` ISO-week, default, or
`monthly`), tracked in the `ops_report_log` table. A restart or a tighter sweep
interval can't double-post. A rolling copy is always written to
`context/operational-report.md` for on-demand reading, even between posts.

This loop is **deterministic** — it never wakes the container agent, so it costs
no API spend (contrast the PM-orchestration loop, which does act and DM).

## Related Rules

- [Task Management](../knowledge-base/tasks.md) — task schema, `estimate`,
  dependency edges, and the PM-orchestration loop this report reads from.
- [Identity & RBAC](../identity/README.md) — people files / display-name
  resolution.
- [Privacy Policy](../access-control/privacy-policy.md) — before choosing where
  the report is delivered.
