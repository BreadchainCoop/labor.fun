# Human-in-the-Loop Approval Primitive

A reusable, action-class-agnostic gate for consequential agent actions. Any
container agent can propose an action; if its class is gated (declared in
config, never hardcoded), a human approves/rejects/revises it in chat before
the agent proceeds.

This generalizes the bespoke approve/reject queues that already existed
(transcript task approval, expense decisions) into one shape any new feature
can reuse instead of growing its own ad-hoc approval table. It is a **chat-reply
gate** — distinct from, and complementary to, the Safe{Wallet} on-chain
multisig approval used by [safe-payouts](../finance/safe-payouts.md); see
"Relationship to other approval flows" below.

## The model

```
[container agent]                [orchestrator]                 [chat]
  request_approval  ────────────▶  gated?
                                     no  → reply "proceed"  ─────▶ (nothing posted)
                                     yes → pending_approvals row
                                           post prompt        ────▶ 🔐 Approval needed …
                                                                       ↓
                                                              human replies "approve AP-…"
  resolve_approval  ◀──────────────────────────────────────── (agent translates the reply)
    (called by the agent after
     it sees the human's reply)
       │
       ▼
  orchestrator validates the approver,
  resolves the row, notifies the
  requesting chat (payload included
  on approval)                    ────▶ ✅ Approved … / 🚫 Rejected … / ✏️ Revision …
```

The **agent**, not the orchestrator, executes the approved action. The host
only gates and records the decision — it has no idea how to "do" an arbitrary
action_class. On approval, the notification includes the original `payload`
so the proposing agent (which may be a fresh container invocation by then)
knows exactly what it asked to do and can carry it out — e.g. calling
`modify_kb_file` after a `kb_write` approval, or opening the PR after a
`github_write` approval.

## Which action classes are gated

Declared in config/rules, **never hardcoded** in `src/`:

- `GATED_ACTION_CLASSES` (`src/config.ts`) merges the active profile's
  `gatedActionClasses` array with the `GATED_ACTION_CLASSES` env var
  (comma-separated). When **neither** is set, a conservative default applies
  (`DEFAULT_GATED_ACTION_CLASSES`):

  | action_class | Meaning |
  |---|---|
  | `outbound_external_message` | A message/DM/email leaving the org |
  | `github_write` | Opening/merging PRs, pushing, editing issues |
  | `linear_write` | Creating/closing Linear issues/projects |
  | `kb_delete` | Deleting a knowledge-base document |
  | `payout` | Moving money / on-chain value (off-chain flows only — see below) |

- An org adds more classes (e.g. `kb_write`, for the [living-FAQ](#living-faq-capture)
  capture skill) by setting `gatedActionClasses` in `profile.config.json` or the
  `GATED_ACTION_CLASSES` env var. Setting either one **replaces** the default
  set rather than adding to it — include the defaults you still want alongside
  any additions.
- `isGatedActionClass(actionClass)` is the single source of truth an agent's
  proposal is checked against. Action classes not in the set are **not**
  gated — `request_approval` replies "not gated, proceeding" immediately and
  nothing is persisted.

Action classes are free-form strings — a new feature can introduce its own
(e.g. `slack_channel_create`) without any host code change; it only needs to
be added to the gated set for orgs that want it reviewed.

## Who can approve

Fail-closed, same posture as expense/transcript approval:

- Resolving an approval **requires** a real `sender_context` (an allowlisted
  sender). A scheduled-task or otherwise identity-less call is refused —
  `isMain` alone is never sufficient.
- **Approver tier** (optional, stricter than the flat default): set
  `approvals.approverSlugs` in the profile to a list of KB people-slugs. When
  set, only those slugs may resolve a pending approval. Left empty/omitted,
  any allowlisted sender may approve (today's flat access model).
- **Self-approval is blocked** for `approve` — the original requester cannot
  approve their own request (another approver must). They **can** `reject` or
  `revise` their own request (withdraw/amend it).
- Double-resolution is refused: only a still-`pending` row transitions; a
  second decision on an already-resolved row is a no-op (logged, and the
  approver is told the row is already `<status>`).

## Lifecycle (`pending_approvals.status`)

```
pending ──▶ approved   (terminal)
pending ──▶ rejected   (terminal)
pending ──▶ revise     (terminal — the agent redoes the proposal under a
                         fresh request_approval call; "revise" itself does
                         not reopen the same row)
pending ──▶ expired    (terminal — auto-swept once past expires_at)
```

No other transitions. `resolvePendingApproval` only updates rows still in
`pending`, so a race between two humans resolving the same id is resolved
first-write-wins; the loser gets "already `<status>`".

## Expiry

- `expires_at` is set from `APPROVAL_TIMEOUT_MINUTES` (config: env var, else
  `approvals.timeoutMinutes` in the profile, else a 24h/1440-minute default;
  `0` disables expiry entirely).
- The `approval-expiry` background integration (`src/integrations/approval-expiry.ts`,
  self-registered like `safe-payouts`) sweeps stale `pending` rows to `expired`
  on a tick (`APPROVAL_EXPIRY_TICK_MS`, default 60s) and posts a one-shot
  "this approval expired" mirror to the requesting group. Idempotent: an
  already-expired row is never re-swept or double-notified, and the loop stays
  dormant entirely when `APPROVAL_TIMEOUT_MINUTES` is `0`.
- An expired row cannot subsequently be resolved (`resolvePendingApproval`
  only moves `pending` rows).

## Idempotency (`dedupe_key`)

`request_approval` accepts an optional `dedupe_key`. If a still-`pending` row
already exists with that key, it's returned unchanged instead of creating a
duplicate — so an agent that retries the same proposal (e.g. after a
container restart) doesn't spam a second prompt. Once the original row leaves
`pending` (approved/rejected/expired), a new `request_approval` with the same
key creates a fresh row — dedup only suppresses **live** duplicates.

## Agent-facing tools

- **`request_approval`**`(action_class, summary, payload?, dedupe_key?, approver_hint?)`
  — propose a consequential action. Returns "not gated, proceed" or "pending,
  wait for a human." Never perform the action before seeing the outcome.
- **`resolve_approval`**`(approval_id, decision, reason?)` — call only when an
  allowlisted human in the chat clearly approved/rejected/asked to revise a
  specific approval id (translate their natural-language reply into this
  call, same pattern as `approve_proposed_tasks` / `expense_decision`).

Both are implemented in `container/agent-runner/src/ipc-mcp-stdio.ts` and
handled host-side in `src/ipc.ts` (`case 'request_approval'` /
`case 'resolve_approval'`).

## Relationship to other approval flows

- **[Safe-payout on-chain reimbursement](../finance/safe-payouts.md)** is
  **not** built on this primitive and is not being migrated onto it. Its
  "approval" is the Safe multisig's on-chain signer threshold — a
  fundamentally different trust model (wallet confirmations, not chat
  replies) that this primitive doesn't represent. The two are complementary:
  a `payout` action_class exists in the default gated set for **off-chain**
  reimbursement-adjacent asks that do need a chat sign-off; on-chain payouts
  keep using `request_safe_payout` / the Safe threshold exclusively.
- **[Transcript task approval](../transcripts/task-approval.md)** and
  **expense decisions** predate this primitive and keep their own
  purpose-built tables/tools (`proposed_tasks`, `expenses`) — narrower
  lifecycles with fields (assignee, due date, amount, receipts) that don't
  generalize cleanly into `{action_class, summary, payload}`. New
  consequential-action features should use this primitive rather than growing
  another bespoke queue.

## Living-FAQ capture

The first consumer of this primitive beyond the built-in default classes: the
opt-in `faq-capture` container skill turns a resolved chat question into a KB
card, gated by a `kb_write` action_class (an org must add `kb_write` to
`gatedActionClasses` to require review — it is not in the default set). See
`container/skills/faq-capture/SKILL.md` for the full capture flow (slug
derivation, idempotent update-not-duplicate check, approval request, then the
write via `modify_kb_file`) and `src/faq-capture.ts` for the deterministic
slug/render/diff helpers that make it idempotent regardless of how the
question was phrased.

## Related files

- `src/db.ts` — `pending_approvals` table + accessors
  (`createPendingApproval`, `resolvePendingApproval`, `expireStalePendingApprovals`, …)
- `src/ipc.ts` — `request_approval`, `resolve_approval` IPC handlers
- `src/config.ts` — `GATED_ACTION_CLASSES`, `DEFAULT_GATED_ACTION_CLASSES`,
  `isGatedActionClass`, `APPROVER_SLUGS`, `APPROVAL_TIMEOUT_MINUTES`
- `src/profile.ts` — `gatedActionClasses` / `approvals` profile config shape
- `src/integrations/approval-expiry.ts` — expiry sweep background flow
- `container/agent-runner/src/ipc-mcp-stdio.ts` — agent-facing MCP tools
- `src/approval.test.ts` — lifecycle tests (propose, resolve, auth, expiry)
