---
name: chores
description: House chore wheel — list chores and their current point values, claim a chore, add or edit chores, show points/leaderboard. Use whenever someone mentions chores, cleaning, claiming a task, or house points.
---

# Chores — the house chore wheel

The house runs a point-based chore system (companion plugin:
`plugins/chores.mjs`). Each resident has a **100 points/month** budget
concept. Undone chores **accrue value linearly** over the month (weighted by
each chore's `speed`), and claims are **peer-verified with emoji reactions**
before points are credited.

All state lives in the group workspace at `chores/` (relative to
`/workspace/group/`):

- `chores/config.json` — residents, Slack channel, poll window
- `chores/chores.json` — chore definitions
- `chores/status.md` — auto-rendered current values + leaderboard (refreshed
  every minute by the plugin)
- `chores/claims/` — claim files (you write these; the plugin does the rest)
- `chores/ledger.json` — credited points (plugin-owned; read-only for you)

## Commands

### "list chores" / "what chores need doing"

Read `chores/status.md` and present the **Current chore values** section.
Higher value = been waiting longer / weightier chore. If the file is missing,
the wheel isn't configured yet — say so and offer to set it up (see Setup).

### "claim <chore>" / "I did the dishes"

1. Confirm the chore exists in `chores/chores.json` (fuzzy-match the name;
   if ambiguous, ask).
2. Identify the claimant: use the sender's name, and their Slack user ID from
   `/workspace/ipc/input` sender context or the shared KB `people/` record if
   available (the ID lets the plugin exclude self-votes).
3. Write `chores/claims/<timestamp>-<slug>.json`:

```json
{
  "status": "new",
  "chore": "<exact chore name>",
  "claimant": "<display name>",
  "claimantId": "<slack user id, empty string if unknown>",
  "claimedAt": "<ISO timestamp>"
}
```

4. Tell the claimant: their claim is filed, the house will be asked to verify
   with 👍 reactions, and points land once verified (within the poll window,
   default 24h). Do NOT credit points yourself — the plugin does that only
   after peer verification.

### "add chore <name>" / "edit chore"

Edit `chores/chores.json` — an array of:

```json
{ "name": "Dishes", "speed": 2, "description": "empty rack, wash pileup" }
```

`speed` is the chore's weight (relative share of the monthly point pool —
faster-accruing chores are worth more per day). Default 1. Confirm the change
back to the channel.

### "points" / "leaderboard" / "how am I doing"

Read `chores/status.md` and present the **Points this month** section.
Frame it as the house's shared game, never to shame anyone — an empty score
is an invitation, not a verdict.

## Setup (first run)

If `chores/config.json` doesn't exist, create it with the residents and the
main house channel:

```json
{
  "residents": ["alice", "bob"],
  "chatJid": "slack:C0123456789",
  "pollHours": 24
}
```

Then create `chores/chores.json` with the house's starting chore list (ask
the channel what the chores are).

## Rules

- Points are only credited by the plugin after peer verification. Never edit
  `ledger.json` yourself.
- Verification: 👍 = yay, 👎 = nay, from residents other than the claimant;
  claims worth ≥10 pts in a house of ≥4 need two 👍.
- Keep the tone light. It's a game to keep the house nice, not surveillance.
