---
name: distribution-sankey
description: On-demand Bread yield-distribution report — a Mermaid Sankey + per-project breakdown of where BREAD went, derived live from Gnosis events (no subgraph). Use when someone asks to see/post the distribution, the yield split, "where the yield went", a monthly distribution summary, or runs /distribution-sankey. Complements the scheduled distribution-sankey plugin (this is the manual, call-it-anytime path).
---

# Distribution Sankey — on demand

The `distribution-sankey` **plugin** posts a per-cycle Sankey automatically after
each on-chain distribution. This **skill** is the manual path: generate the
report whenever someone asks — e.g. when Marv sits down to write the monthly
post, or anyone wants the current split — without waiting for the routine.

## When to use

Trigger on requests like: "post the distribution sankey", "where did the yield
go", "show the yield split", "monthly distribution report for May",
"all-time distribution", or `/distribution-sankey`.

## How to run

A self-contained script does the chain work (no dependencies — plain `fetch`
JSON-RPC against Gnosis). Run it and post its stdout verbatim (it's already
formatted: a caption, a `mermaid sankey-beta` block, and a per-project % table).

```
node ${CLAUDE_SKILL_DIR}/report.mjs              # latest cycle (default)
node ${CLAUDE_SKILL_DIR}/report.mjs latest
node ${CLAUDE_SKILL_DIR}/report.mjs all          # cumulative all-time
node ${CLAUDE_SKILL_DIR}/report.mjs month 2026-05  # aggregate one UTC month
```

Pick the mode from the request:
- **default / "latest"** → the most recent distribution cycle.
- **"all-time" / "total" / "cumulative"** → `all`.
- **"monthly" / "for <month>" / "this month"** → `month YYYY-MM` (resolve the
  month to `YYYY-MM`; "this month" = the current UTC month).

## Posting

- The script's output is ready to send — post it as-is to the channel the user
  asked for (default: the current chat). Each `Yield Distributor,<project>,<n>`
  line is a Sankey flow; the caption carries the total BREAD + ~USD and a
  gnosisscan tx link (for `latest`).
- Mermaid renders on GitHub, Discord (where enabled), and mermaid.live; in chats
  that don't render it, the text + the `•` breakdown still read fine.
- If the user wants an **image** for socials, render the `mermaid` block at
  https://mermaid.live or with the mermaid CLI and attach the PNG (the script
  gives you the diagram source).

## Data source & notes

- Reads `YieldDistributed` cycles on the YieldDistributor
  (`0xeE95…024b`, Gnosis) and the BREAD `Transfer` logs **from** it —
  authoritative recipient + amount, no positional project-array guessing.
- Recipient names load from the KB config
  (`/workspace/shared-kb/distribution-sankey/config.md`) layered over built-in
  defaults, so naming stays in one place. An unnamed recipient shows its raw
  address — a nudge to add it to the config.
- BREAD is valued ~$1 (1:1 with DAI). All amounts are 18-decimal.
