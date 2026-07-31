---
name: hearts
description: House hearts — the house accountability layer. Check heart balances, record karma ("@user ++"), file heart challenges, explain monthly regen and chore-heart bonuses/penalties. Use whenever someone mentions hearts, karma, challenges, or accountability.
---

# Hearts — the house accountability layer

Every resident carries hearts (companion plugin: `plugins/hearts.mjs`).
Baseline **5**, max **10**. Hearts drift **±0.5/month toward baseline**,
karma winners gain them, upheld challenges and missed chore budgets cost
them. All state lives at `hearts/` (relative to `/workspace/group/`):

- `hearts/config.json` — residents (with slackIds), Slack channel
- `hearts/status.md` — auto-rendered balances + recent events (refreshed
  every minute by the plugin)
- `hearts/karma/` — karma grant files (you write these)
- `hearts/challenges/` — challenge files (you write these; the plugin polls)
- `hearts/ledger.json` — heart entries (plugin-owned; read-only for you)

## Commands

### "hearts" / "heart balances" / "how many hearts do I have"

Read `hearts/status.md` and present the Balances section. ⚠️ marks
residents at or below 2 hearts (critical). If the file is missing, hearts
isn't configured yet — say so and offer setup.

### Karma — someone writes "<@user> ++" or "props to X"

When a message contains `<@USERID> ++` (or someone clearly gives props and
you can identify giver + receiver), record it by writing
`hearts/karma/<timestamp>-<slug>.json`:

```json
{
  "giver": "<giver resident name>",
  "receiver": "<receiver resident name>",
  "givenAt": "<ISO timestamp>"
}
```

Names must match `config.json` resident names. Acknowledge briefly (a
reaction is enough). Shortly after each month starts, the plugin awards
+1 heart to the top karma earner(s) of the previous month
(max winners = floor(residents/3); rankings weight each giver's influence
by their own hearts divided by karma issued).

### "challenge <resident>" / heart challenge

Challenges are serious: the house votes, and the LOSER loses hearts. If the
challenge fails, the CHALLENGER loses the hearts instead. Confirm the
challenger really wants this, then write
`hearts/challenges/<timestamp>-<slug>.json`:

```json
{
  "status": "new",
  "challenger": "<resident name>",
  "challengee": "<resident name>",
  "value": 1,
  "circumstance": "<short reason>"
}
```

The plugin posts a 👍/👎 poll (3 days). Approval needs 40% of residents,
or 70% if the challengee would drop to ≤2 hearts. One active challenge per
challengee at a time. Do NOT adjust hearts yourself — the plugin owns the
ledger.

### Monthly automation (no action needed from you)

- Regen: +0.5 toward baseline (or -0.5 fade if above) at month start.
- Karma hearts: ~3h after month start.
- Chore hearts: ~30h after month start, from the chores ledger —
  full 100-pt month → +0.5 bonus; each full 5 pts short → -0.25.

## Setup

Create `hearts/config.json`:

```json
{
  "residents": [{ "name": "alice", "slackId": "U..." }],
  "chatJid": "slack:C..."
}
```

Residents initialise at 5 hearts on the next plugin tick (≤1 min).
