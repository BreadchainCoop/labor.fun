---
name: expense-helper
description: Guide users through expense requests, receipt submission, approvals, and reimbursement. Use whenever a user mentions money, spending, purchases, receipts, or reimbursement.
---

# Expense Helper

## Choosing the right path

- **Prospective** is always preferred. If the user says *"I'm planning to..."*, *"I need funds for..."*, *"Can I expense..."*, use `request_expense`.
- **Retrospective** only when they've already spent. Before calling `submit_retrospective_expense`, always say: *"The preferred flow is to request approval before spending. Please try to do that next time."* Then proceed.

## Disambiguation examples

| User says | Path | Why |
|-----------|------|-----|
| "I need $200 for supplies this week" | prospective | hasn't spent yet |
| "I spent $38 on ink last Tuesday, need reimbursement" | retrospective | past tense, already out of pocket |
| "Can I expense a new chair?" | prospective | asking permission, not reporting |
| "Here's the receipt for the catering you approved" | `submit_receipt` | pre-approved expense in `receipt_pending` |

## Amount formatting

- Accept user input in dollars ($45.50, "forty-five fifty", etc.)
- Convert to cents before calling the tool: 45.50 → 4550
- Always echo the parsed amount back to the user for confirmation before submitting

## Available tools

| Tool | When to use |
|------|-------------|
| `request_expense` | New prospective request (preferred) |
| `submit_retrospective_expense` | Backlog submission for already-spent money (discouraged) |
| `approve_expense` | Approver accepts as-submitted |
| `deny_expense` | Approver rejects — requires reason |
| `modify_expense` | Approver accepts at a different amount (prospective only) |
| `submit_receipt` | Requester attaches receipt after a purchase |
| `process_reimbursement` | Finance executes the payout |
| `cancel_expense` | Requester withdraws before reimbursement |

## Event linking

If the user mentions an event by name or the conversation context includes an event project, look up the `event_id` via `list_events` and attach it. Event budgets roll up through this field.

## Receipts

- Accept any image or PDF attachment as a receipt.
- Store under the expense's KB doc directory if applicable, or accept an external URL.
- Pass the path/URL as `receipt_path`.

## Edge cases

- **Amount disputes**: if an approver modified the amount, explain clearly to the requester what changed and why. They can either accept (submit receipt) or cancel.
- **Duplicate submissions**: before submitting, check if the requester already has a similar recent expense; if a match exists, ask if they want to reference the existing one.
- **Cross-group**: expenses can be requested from any group, but approval notifications go to the main group. Tell the user where the request is going.
- **Self-approval blocked**: the orchestrator rejects approvals by the requester.
- **Unknown senders blocked**: the orchestrator requires an allowlisted sender (a `sender_context`) for any approval. Any allowlisted user can approve any amount, prospective or retrospective.

## Status vocabulary (for rendering/responses)

- `pending_approval` — new prospective request awaiting decision
- `submitted_retro` — new retrospective request awaiting review
- `receipt_pending` — approved prospective, waiting on receipt
- `receipt_submitted` — receipt in, ready for finance
- `approved_retro` — retrospective approved, ready for finance
- `reimbursed` — paid (terminal)
- `denied` / `denied_retro` / `cancelled` — terminal non-payment
