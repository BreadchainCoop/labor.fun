/**
 * expense.tsx — pilot of the OTHER Smithers pattern: a long-lived,
 * human-in-the-loop state machine.
 *
 * The transcript workflow is "Pattern A": one agent run, internally multi-step,
 * Smithers adds checkpoint/resume + model escalation. THIS is "Pattern B": a
 * workflow that **suspends at a human-approval gate** and resumes days later
 * when a *different* person acts. Today this lives as scattered IPC handlers in
 * src/ipc.ts (expense_request → expense_decision → expense_receipt →
 * expense_reimburse) with state in the `expenses` DB table. As a Smithers
 * workflow it becomes ONE durable definition with the gates explicit.
 *
 * The durability win here isn't crash-recovery of a single run — that DB state
 * already survives. It's expressing the whole multi-actor chain (with its tier
 * rules and gates) as one inspectable, resumable graph instead of five handlers
 * that each re-derive "what state are we in".
 *
 * ── HOW APPROVAL RESUMES ────────────────────────────────────────────────────
 * `needsApproval` suspends the run. The approver's chat message ("approve
 * EXP-123") is turned into a Smithers approve() call against this run id by a
 * thin bridge in the orchestrator (the same place src/ipc.ts handles
 * expense_decision today). Self-approval and tier limits are enforced there
 * before the approval is accepted — keep that authority on the privileged side,
 * never inside the agent. See docs/SMITHERS-ORCHESTRATION.md § "Pattern B".
 *
 * VERIFY-ON-INSTALL: `needsApproval`, `<Branch>` and the approval/resume API
 * names against the installed `smithers-orchestrator`.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { createSmithers, Sequence, Branch } from 'smithers-orchestrator';
import { z } from 'zod';

import { ContainerAgent } from '../agents/container-agent';
import { chainFor } from '../model-router';
import { getRunStep } from '../runtime';

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: z.object({
    group: z.string(),
    chatJid: z.string(),
    expenseId: z.string(), // EXP-NNN, the row in the expenses table
    amountCents: z.number(),
    requesterId: z.string(),
    description: z.string(),
  }),
  // The agent only ever drafts human-facing notices; the privileged side owns
  // the DB transitions. Each step's output is the notice it posted.
  notice: z.object({ posted: z.string() }),
});

/** Mechanical notices run cheap; nothing here needs heavy reasoning. */
function notifier(group: string, chatJid: string) {
  const runStep = getRunStep();
  return chainFor('render').map(
    (spec) =>
      new ContainerAgent({
        spec,
        group,
        chatJid,
        runStep,
        allowedTools: ['Read'],
      }),
  );
}

export default smithers((ctx) => {
  const { group, chatJid, expenseId, amountCents, description } = ctx.input;
  const agent = notifier(group, chatJid);
  // Tier rule mirrors src/ipc.ts: a coordinator may approve under $500; larger
  // amounts require an admin. The actual identity/tier check is enforced by the
  // approval bridge, not here — this only selects which gate copy to post.
  const needsAdmin = amountCents >= 500_00;

  return (
    <Workflow name="expense">
      <Sequence>
        {/* 1. Announce the pending request to the approval channel. */}
        <Task id="announce" output={outputs.notice} agent={agent}>
          {`Post to the approvals channel: ${expenseId} — ${description} for $${(
            amountCents / 100
          ).toFixed(2)} is pending ${needsAdmin ? 'ADMIN' : 'coordinator'} approval.`}
        </Task>

        {/* 2. APPROVAL GATE — suspends until the approval bridge resumes it. */}
        <Task id="approval" output={outputs.notice} agent={agent} needsApproval>
          {`Awaiting ${needsAdmin ? 'admin' : 'coordinator'} decision on ${expenseId}. ` +
            `On resume, post the recorded decision (approved/denied) to the channel.`}
        </Task>

        {/* 3. On approval: collect receipt, then reimburse — each its own gate. */}
        <Branch if={(c) => c.outputMaybe(outputs.notice, { nodeId: 'approval' }) != null}>
          <Sequence>
            <Task id="receipt" output={outputs.notice} agent={agent} needsApproval>
              {`Receipt pending for ${expenseId}. On resume (receipt submitted), ` +
                `notify finance that reimbursement is due.`}
            </Task>
            <Task id="reimburse" output={outputs.notice} agent={agent} needsApproval>
              {`Reimbursement pending for ${expenseId}. On resume (marked reimbursed), ` +
                `confirm to the requester and close the workflow.`}
            </Task>
          </Sequence>
        </Branch>
      </Sequence>
    </Workflow>
  );
});
