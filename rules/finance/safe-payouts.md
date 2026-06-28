# On-chain Payout Rules (Safe{Wallet} multisig)

On-chain reimbursements are paid as an ERC-20 transfer from the org's
**Safe{Wallet} multisig**. This is a **separate flow** from the off-chain
[expenses](expenses.md) lifecycle — its own `safe_payouts` table, its own
`safe-payouts` integration. The two never share state.

## The model: the Safe threshold IS the approval

- There are **no approval tiers**. Whether a payout happens is decided **entirely
  on-chain** by the Safe's signer threshold — not by the assistant, and not by any
  amount-based rule. The assistant does not gate, rank, or veto payouts.
- Members confirm a proposed payout **in their own wallets** (the Safe{Wallet} UI
  or their own tooling). The assistant only **mirrors** the confirmation state
  into chat ("N/threshold confirmed", "executed").
- Execution happens on-chain once the threshold is met. The assistant never
  pushes it.

## Trust boundary — the assistant is a PROPOSER ONLY

- The assistant holds a dedicated **proposer key** (non-owner). It can
  `proposeTransaction` but **can never `confirmTransaction` or
  `executeTransaction`**. Its signature does not count toward the threshold and
  cannot move funds.
- Worst case if the proposer key leaks: **spam proposals** that signers reject —
  never an unauthorized payout.
- The proposer key comes from the env/vault (`SAFE_PROPOSER_KEY`), never from
  config or git.

## Recipient address

- The payout address is read from the recipient's KB profile frontmatter
  (`address:` in `context/people/<slug>.md`), validated as a checksummed EVM
  address.
- A **missing or malformed address is refused** — the assistant asks the member
  for a checksummed wallet address rather than guessing. Funds are never sent to
  an unverified target.

## Lifecycle (`safe_payouts.status`)

```
requested ──▶ proposed ──▶ confirming ──▶ executed   (terminal)
                  └────────────┴─────────▶ rejected   (signers replaced the nonce)
requested ──▶ failed   (propose error; retryable)
requested ──▶ cancelled
```

The reconcile loop only ever moves a row **forward by observation**; it never
represents a decision. Terminal rows are immutable, so a replayed on-chain event
can't double-pay (idempotency).

## Configuration (per-org, in `profile.config.json` → `safe`)

| Field                           | Meaning                                                     |
| ------------------------------- | ----------------------------------------------------------- |
| `chainId`                       | EVM chain id (Gnosis = `100`)                               |
| `safeAddress`                   | the multisig address                                        |
| `tokenAddress`                  | ERC-20 reimbursement token (e.g. BREAD)                     |
| `tokenSymbol` / `tokenDecimals` | display + precision (default `tokens` / `18`)               |
| `rpcUrl`                        | JSON-RPC endpoint                                           |
| `txServiceUrl`                  | Safe Transaction Service base URL                           |
| `safeWalletBaseUrl`             | Safe{Wallet} UI base, for the "confirm in your wallet" link |

The proposer key is **not** config — set `SAFE_PROPOSER_KEY` in the env/vault.
Absent `safe` config → the integration stays dormant.

**Transaction Service auth (verified against api-kit v5):** the SDK requires
**either** an explicit `txServiceUrl` **or** a Safe API key
(`SAFE_TX_SERVICE_API_KEY`, from developer.safe.global). For **Gnosis Chain**,
set `txServiceUrl` to `https://safe-transaction-gnosis-chain.safe.global/api` —
validated to propose + read keyless. (The api-kit default `api.safe.global`
gateway demands a key.)

## Cross-references

- Off-chain expenses (fiat): [expenses.md](expenses.md)
- Agent tool: `request_safe_payout` (container MCP) + `container/skills/safe-payout/`
- Code: `src/integrations/safe-payouts.ts`, `src/safe/`, `src/db.ts` (`safe_payouts`)
- Issue: #108 (epic #114, Smithers durable workflows)
