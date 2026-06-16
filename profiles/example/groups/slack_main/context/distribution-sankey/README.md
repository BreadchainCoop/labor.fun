# Yield distribution Sankey (per-cycle auto-report)

KB home of the `distribution-sankey` profile plugin
(`<profile>/plugins/distribution-sankey.mjs`). After each new on-chain yield
distribution, it posts a **per-cycle** Mermaid Sankey to a channel.

## How it works

It derives each cycle straight from events — **no subgraph dependency**:

1. polls the chain for new `YieldDistributed` logs on the YieldDistributor,
2. for each new cycle block, reads the BREAD `Transfer` logs emitted **from** the
   distributor in that block (authoritative recipient + amount — no positional
   project-array guessing, the thing that keeps breaking the subgraph),
3. renders a `sankey-beta` diagram of that cycle and posts it.

Plain `fetch` JSON-RPC + minimal hex decoding, so it adds **no dependency**.

## Layout

| Path | What | Written by |
|------|------|-----------|
| `config.md` | Flow config (below) | humans |
| `state.json` | `{ lastBlock, cycleIndex }` bookkeeping | the plugin |

On first run the plugin **anchors to the current chain head and does not
backfill** — it reports only cycles that land after it starts watching. Reset by
deleting `state.json` (it will re-anchor, not replay history).

## config.md format

```markdown
---
channel_jid: dc:703206477392773171        # where to post; must be a REGISTERED group
distributor: '0xeE95A62b749d8a2520E0128D9b3aCa241269024b'   # YieldDistributor (Gnosis) — QUOTE it
bread_token: '0xa555d5344f6fb6c65da19e403cb4c1ec4a1a5ee3'   # BREAD token (Gnosis) — QUOTE it
start_block: 34696259
decimals: 18
# optional — defaults to public Gnosis RPCs
rpcs:
  - https://rpc.gnosischain.com
  - https://rpc.gnosis.gateway.fm
names:                                      # recipient address (quoted) -> label
  "0x7e1367998e1fe8fab8f0bbf41e97cd6e0c891b64": Labor DAO
  "0x5405e2d4d12aadb57579e780458c9a1151b560f1": Symbiota
  "0x5c22b3f03b3d8fff56c9b2e90151512cb3f3de0f": Crypto Commons Assoc.
  "0xa232f16ab37c9a646f91ba901e92ed1ba4b7b544": Citizen Wallet
  "0x918def5d593f46735f74f9e2b280fe51af3a99ad": Bread Core
  "0x6a148b997e6651237f2fcfc9e30330a6480519f0": Bread Treasury
  "0x68060388c7d97b4bf779a2ead46c86e5588f073f": ReFi DAO
  "0x1bd2212c9aa332d22d61a0be6bcc55b2a1de6c63": Gardens
  "0xfcb81c1b0e0d4fea01e5a0fbf0aebb91e78a67e1": Regen Coordination
---

Free text: who maintains the recipient name map.
```

Notes:
- **Quote every address** (`distributor`, `bread_token`, and the `names` keys).
  Unquoted, YAML parses a `0x…` value as a hexadecimal *number* and silently
  loses precision — the plugin then treats `distributor`/`bread_token` as unset
  and no-ops. Addresses are matched case-insensitively.
- Unmapped recipients render with their raw address (a nudge to add a name).
- The flow is a **no-op until `config.md` exists** with `channel_jid`,
  `distributor`, and `bread_token`.
- Poll cadence defaults to 6h; override with `DISTRIBUTION_SANKEY_TICK_MS`.
