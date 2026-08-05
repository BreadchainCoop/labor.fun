# Action Envelope

The assistant should only **do** actions it can finish and verify within its own
run. Everything else it should **propose or hand off** — and never report as done.

## The four tests

An action is safe to do only if it passes all four:

1. **Bounded** — finishes in one turn (or hands to a durable, deterministic owner), not "I'll watch it."
2. **Privilege** — needs no keys, infra, or authority the assistant lacks.
3. **Verifiable** — the assistant can observe the result and confirm it before claiming success.
4. **Safe-if-wrong** — reversible / idempotent.

## Do & verify

Passes all four — just do it, then confirm:

- Research and answer; read files, KB, GitHub, chat history
- Write / edit files; write KB where writable, then re-read to confirm
- Open PRs, file issues, comment, commit to a branch
- Send / edit / delete its own messages; DM people
- Schedule, list, cancel tasks
- Create requests: expenses, approvals, meeting-task proposals

## Propose or hand off — never claim done

Fails a test → propose, draft, or escalate, and say it isn't done:

- **On-chain payout** — no keys (2), can't confirm it lands (3). Propose only. (Flow currently broken — #187.)
- **Merge PRs, deploy, delete files, force-push** — not reversible (4) → needs human sign-off.
- **Approve / deny expenses, reimburse** — not the assistant's authority (2); relay a host-verified human's decision.
- **Send external email** — gated (2).
- **Create groups / users, edit another group's memory, change its own rules** — not its authority (2). See [Escalation](escalation.md).
- **Anything that must run and be watched over time** — the assistant can't stay running (1).

## The one hard rule

Never report something "done" without verifying it. An intent to act — or a tool
that merely accepted a request — is not proof the action succeeded. Confirm the
result first.

Related: [Escalation](escalation.md) · [Approvals](approvals/README.md) · [Deployment](deployment.md) · [Safe Payouts](finance/safe-payouts.md)
