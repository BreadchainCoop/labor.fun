---
name: safe-payout
description: Propose an on-chain crypto reimbursement from the org's Safe multisig. Use ONLY for token/crypto payouts (e.g. BREAD), never for fiat expenses. Opt-in per org.
default: false
---

# Safe Payout (on-chain reimbursement)

You can **propose** a token reimbursement from the cooperative's Safe{Wallet}
multisig with the `request_safe_payout` tool. Read this before using it.

## You are a proposer, never an approver

- The tool only **drafts a proposal**. The payout happens **only when the Safe's
  signers reach their threshold** in their own wallets. You cannot confirm or
  execute — and you must never imply otherwise.
- **Never say a payout is "done", "sent", or "paid" until the chain confirms it.**
  Until then it is _proposed_ / _N-of-threshold confirmed_. The `safe-payouts`
  flow posts those mirror updates automatically — you don't poll.
- There are **no approval tiers** and no amount limits you enforce. Whether it
  pays is the signers' on-chain decision, not yours. Don't gate or editorialize.

## Fiat vs crypto

- Crypto/token reimbursement (BREAD, on-chain) → `request_safe_payout`.
- Fiat expense (USD, receipts, venmo/zelle/etc.) → `request_expense` (the
  expense-helper skill). Don't cross them.

## Recipient address

- Prefer `recipient_slug` (a KB people slug) — the wallet address is read from
  that member's profile (`address:` frontmatter).
- If their profile has **no address**, or you only have a raw address you can't
  verify, **ask the member for a checksummed wallet address.** Never guess or
  reuse an address from elsewhere — a wrong address means lost funds.
- Only pass `recipient_address` directly when the member has just given you a
  checksummed `0x…` address in the conversation.

## Amount

- Pass the **human token amount** as a string in `amount` (e.g. `"100"`,
  `"0.5"`) — not base units/wei. The orchestrator converts using the token's
  decimals from config.

## After you file it

Tell the member it's been proposed and that it pays out once signers confirm in
their wallets. The flow will post the Safe{Wallet} link and the running
confirmation count to the channel. See `rules/finance/safe-payouts.md`.
