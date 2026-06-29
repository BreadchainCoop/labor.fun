# Expense Rules

## Who Can Request

- Any member of the org, from any chat the assistant monitors.
- Required fields: amount, description.
- Retrospective requests additionally require: `justification`, `incurred_date`, `receipt_path`.

## Preferred Path: Prospective

1. Requester describes the intended expense to the assistant.
2. The assistant calls `request_expense` with the details.
3. Approver receives notification in the main group, decides: approve / deny / modify.
4. On approval, requester makes the purchase and attaches receipt via `submit_receipt`.
5. Finance reimburses via `process_reimbursement`.

## Discouraged Path: Retrospective

- Use ONLY for backlog cleanup — expenses already spent without prior approval.
- The assistant MUST surface a friction message: _"Prospective requests are preferred. Please loop in the approver before spending next time."_
- Receipt must be attached at submission time.
- Approver may still deny retrospective expenses.
- Retrospective expenses cannot be modified — only approved or denied as-submitted.

## Approval

Any allowlisted user may approve any expense — prospective or retrospective, any amount. The only structural constraint is that requesters cannot approve their own expenses.

## Notifications

- On request submission: notify the main group (approver queue).
- On approval (prospective): notify requester; state transitions to `receipt_pending`.
- On approval (retrospective): notify requester; notify main group (finance queue); state transitions to `approved_retro`.
- On denial: notify requester with approver's reason.
- On receipt submission: notify main group that expense is ready for reimbursement.
- On mismatched receipt amount vs approved amount: flag delta to main group.
- On reimbursement: notify requester.
- On cancellation: notify requester.

## Constraints

- Requesters cannot approve their own expenses.
- A modified amount does NOT re-enter approval — the requester either accepts the modified amount (by submitting a receipt) or cancels.
- Retrospective expenses cannot be modified.
- Receipts are required before reimbursement on all prospective expenses. No receipt = no payout.
- Expenses linked to an `event_id` should roll up into that event's budget artifact.
- Any allowlisted user can execute `process_reimbursement`.
- Only the requester can attach a receipt or cancel their own expense.

## Lifecycle

```
prospective:
  pending_approval ──▶ receipt_pending ──▶ receipt_submitted ──▶ reimbursed
                   └─▶ denied
                   └─▶ cancelled (requester, any non-terminal state)

retrospective:
  submitted_retro ──▶ approved_retro ──▶ reimbursed
                  └─▶ denied_retro
                  └─▶ cancelled
```

Terminal states: `reimbursed`, `denied`, `denied_retro`, `cancelled`.

## On-chain reimbursements (crypto)

Token reimbursements paid from the org's Safe{Wallet} multisig are a **separate
flow** with no approval tiers — the Safe signer threshold is the approval. See
[safe-payouts.md](safe-payouts.md). The off-chain lifecycle above is unchanged
by it.

## Cross-references

- On-chain payouts (crypto): `rules/finance/safe-payouts.md`
- Tool documentation: `container/skills/expense-helper/SKILL.md`
- Agent workflow: `groups/slack_main/CLAUDE.md` (Expenses section)
- DB schema: `schema/tables.md` (`expenses` table)
