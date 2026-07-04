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

**Enforcement level — read this before assuming "gated" means "blocked":**
for every action_class *except* `kb_delete`, this primitive is **advisory
defense-in-depth**. The host gates the *conversation* (records the request,
requires a verified human decision, notifies the outcome) but the agent
itself executes the underlying action after seeing an "approved" outcome —
the host has no idea how to open a PR, send a message, or move money, so it
cannot physically stop a compromised or buggy agent from acting without
waiting for that approval. The real backstop for those classes is the
upstream tool/credential boundary (e.g. GitHub token scope, outbound-message
allowlists, the Safe multisig threshold for on-chain payouts) — this gate
makes the intended flow "ask first," it does not make asking mandatory at
the code level for anything other than `kb_delete`.

**`kb_delete` is hard-enforced, not advisory.** `modify_kb_file`'s delete
branch (`processModifyKbFile` in `src/ipc.ts`) will not unlink a file unless
the call carries an `approval_id` that resolves to a `pending_approvals` row
that is *all* of: `action_class = 'kb_delete'`, `status = 'approved'`,
unexpired (`expires_at` not in the past), and whose recorded `payload`
references the exact same KB-relative path being deleted. Any miss — no id,
wrong class, still-pending, expired, or a path mismatch — fails closed: the
file is left in place, the gate is skipped entirely (no unauthorized delete
occurs), and the requesting chat is told to get a `kb_delete` approval first.
This is the one action_class in the default set where the host itself is the
backstop, independent of what the agent chooses to do — see
`checkKbDeleteApproval` / `processModifyKbFile` in `src/ipc.ts` and
`src/kb-delete-approval.test.ts`.

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

### Identity verification in multi-sender batches

The orchestrator processes messages in **batches** — a single agent run can
see messages from several distinct humans in a group chat (e.g. the proposer
and an approver both spoke before the container was invoked). This matters
because the approver-tier check and the self-approval guard above are only as
strong as the identity they're checked against.

**The vulnerability this closes:** `sender_context.json` used to carry only
the identity of the *last* message in the batch. If a proposer's own gated
request landed earlier in a batch and another allowlisted user's message
happened to land last, an agent forwarding "approve AP-…" would have that
decision attributed to whoever spoke last — not necessarily the person who
actually typed the approval. A proposer could exploit (or simply benefit
from) that ordering to get their own request approved under someone else's
identity.

**The fix — a verified roster, not a trusted claim:**

- `sender_context.json` now carries a `senders` array: every distinct human
  sender the orchestrator resolved from the batch's real inbound messages
  (deduped by platform id), each tagged with the `platform_sender_id` (Slack
  user id, Telegram id, …) the orchestrator used to resolve them
  (`buildBatchSenderContext` in `src/index.ts`). The top-level
  `user_id`/`display_name`/`tags` fields are kept for back-compat (equal to
  the *last* resolved sender) — non-decision consumers that only need "some
  allowlisted human triggered this" (`add_kb_user`, `fetch_discord_history`,
  KB write attribution, etc.) are unaffected.
- Per-decision MCP tools — `resolve_approval`, `approve_expense`/
  `deny_expense`/`modify_expense` (→ `expense_decision`), `submit_receipt`
  (→ `expense_receipt`), `cancel_expense` (→ `expense_cancel`) — accept an
  optional `actor_sender_id`: the platform id of the specific person whose
  message carried *this* decision. The agent can only point at a
  sender/message the orchestrator already resolved from real platform data —
  it can never assert an approver identity by free-text string.
- The host resolves the actual actor via `resolveActorFromSenderContext`
  (`src/ipc.ts`), never by trusting the agent's claim of who decided:
  - Roster has exactly **one** sender → that sender, unambiguous;
    `actor_sender_id` is optional and ignored (the common case, unaffected).
  - Roster has **more than one** sender and `actor_sender_id` matches one of
    their `platform_sender_id`s → that sender.
  - Roster has more than one sender and `actor_sender_id` is missing or
    doesn't match any roster entry → **fail closed**: the decision is refused
    as ambiguous (row stays `pending`/unchanged; the chat is told to re-issue
    the decision identifying the approver), never silently attributed to
    anyone.
- The self-approval guard and the `APPROVER_SLUGS` tier check both run
  against this **verified** actor identity — never against the batch-last
  sender and never against a name the agent supplies directly. This is what
  actually prevents the self-approval exploit: even if the agent (honestly or
  maliciously) passes `actor_sender_id` for the original requester, the
  self-approval guard still fires, because that identity was independently
  verified against the roster rather than asserted.

Tests: `src/batch-sender-context.test.ts` (roster construction) and the
"multi-sender batch identity verification" describe blocks in
`src/approval.test.ts` (`resolve_approval` and `expense_decision`), including
the blocked-exploit cases.

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
- **`resolve_approval`**`(approval_id, decision, reason?, actor_sender_id?)`
  — call only when an allowlisted human in the chat clearly
  approved/rejected/asked to revise a specific approval id (translate their
  natural-language reply into this call, same pattern as
  `approve_proposed_tasks` / `expense_decision`). Pass `actor_sender_id` (the
  platform id of whoever's message carried the decision) whenever more than
  one person spoke in the run — see "Identity verification in multi-sender
  batches" above; omitting it when required fails the decision closed rather
  than guessing.
- **`modify_kb_file`**`(file_path, content?, action?, approval_id?)` — when
  `action: "delete"` and the org gates `kb_delete`, `approval_id` must be an
  approved, unexpired `kb_delete` approval referencing the same `file_path`;
  the host refuses the delete otherwise (see "Enforcement level" above).
- The expense decision tools (`approve_expense`, `deny_expense`,
  `modify_expense`, `submit_receipt`, `cancel_expense`) accept the same
  optional `actor_sender_id`, required under the same multi-sender condition.

All are implemented in `container/agent-runner/src/ipc-mcp-stdio.ts` and
handled host-side in `src/ipc.ts` (`case 'request_approval'` /
`case 'resolve_approval'` / `processModifyKbFile` / `case 'expense_decision'`
/ `case 'expense_receipt'` / `case 'expense_cancel'`).

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
- `src/ipc.ts` — `request_approval`, `resolve_approval` IPC handlers;
  `resolveActorFromSenderContext` (verified multi-sender actor resolution);
  `checkKbDeleteApproval` / `processModifyKbFile` (hard `kb_delete` gate)
- `src/index.ts` — `buildBatchSenderContext` / `platformForChatJid` (builds
  the per-run `sender_context.json` roster from the processed message batch)
- `src/config.ts` — `GATED_ACTION_CLASSES`, `DEFAULT_GATED_ACTION_CLASSES`,
  `isGatedActionClass`, `APPROVER_SLUGS`, `APPROVAL_TIMEOUT_MINUTES`
- `src/profile.ts` — `gatedActionClasses` / `approvals` profile config shape
- `src/integrations/approval-expiry.ts` — expiry sweep background flow
- `container/agent-runner/src/ipc-mcp-stdio.ts` — agent-facing MCP tools
  (`resolve_approval`, expense decision tools, `modify_kb_file`), all
  accepting `actor_sender_id` where relevant
- `src/approval.test.ts` — lifecycle tests (propose, resolve, auth, expiry)
  plus the multi-sender identity verification / blocked-exploit tests
- `src/batch-sender-context.test.ts` — `buildBatchSenderContext` roster
  construction tests
- `src/kb-delete-approval.test.ts` — `kb_delete` hard-enforcement tests
