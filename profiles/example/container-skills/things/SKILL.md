---
name: things
description: House things — house procurement. Check the house fund balance, list the buyable catalog, file buy requests (regular or special), propose catalog changes, mark deliveries fulfilled. Use whenever someone mentions buying supplies, the house fund, or restocking.
---

# Things — the house procurement layer

The house keeps a money account and a catalog of buyable Things (companion
plugin: `plugins/things.mjs`). Buys are approved by reaction poll and debit
the fund. All state lives at `things/` (relative to `/workspace/group/`):

- `things/config.json` — residents, Slack channel
- `things/things.json` — catalog: `[{name, type, value, unit, url, active}]`
- `things/status.md` — auto-rendered balance + catalog + to-buy queue
- `things/buys/` — buy request files (you write these)
- `things/proposals/` — catalog proposal files (you write these)
- `things/ledger.json` — money txns (plugin-owned; read-only for you,
  EXCEPT admin loads, below)

## Commands

### "balance" / "what can we buy" / "catalog"

Read `things/status.md` and present the relevant section.

### "buy <thing>" — regular buy (catalog item)

Fuzzy-match the thing in `things/things.json`, then write
`things/buys/<timestamp>-<slug>.json`:

```json
{
  "status": "new",
  "thing": "<exact catalog name>",
  "quantity": 1,
  "buyer": "<resident name>"
}
```

The plugin checks funds, posts a 👍/👎 poll (6h). Votes needed = 1 per $50
of total cost, capped at 60% of the house. Approved buys debit the fund
and join the to-buy queue.

### "special buy" — off-catalog purchase

```json
{
  "status": "new",
  "special": true,
  "title": "<what>",
  "details": "<why>",
  "price": 150,
  "buyer": "<resident name>"
}
```

1-day poll; votes needed = max(1 per $50, 30% of house), capped at 60%.

### "add <thing> to the catalog" / edit / remove

Write `things/proposals/<timestamp>-<slug>.json` (2-day poll, 40% of house):

```json
{
  "status": "new",
  "proposedBy": "<resident name>",
  "thing": { "name": "dish soap", "type": "household", "value": 6 }
}
```

To edit, use the existing name with new fields; to remove, include
`"active": false`. Admins may also edit `things/things.json` directly.

### "the paper towels arrived" — fulfillment

Find the matching approved buy in `things/buys/` (the status.md queue lists
the file name), set `"fulfilled": true` and `"fulfilledBy": "<name>"` in
that file. It leaves the queue on the next tick.

### Loading the fund (ADMIN ONLY)

Only on explicit admin instruction, append a txn to `things/ledger.json`:

```json
{ "type": "load", "account": "general", "value": 500, "by": "alice", "at": "<ISO>" }
```

Never load funds for a non-admin. Never edit or remove existing txns.

## Setup

Create `things/config.json`:

```json
{ "residents": ["alice", "bob"], "chatJid": "slack:C..." }
```

Then seed `things/things.json` with a starter catalog and have an admin
load the fund.
