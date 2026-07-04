import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach } from 'vitest';

import {
  DEFAULT_GATED_ACTION_CLASSES,
  GATED_ACTION_CLASSES,
  isGatedActionClass,
  DATA_DIR,
} from './config.js';
import {
  _initTestDatabase,
  createPendingApproval,
  getPendingApproval,
  getPendingApprovals,
  resolvePendingApproval,
  expireStalePendingApprovals,
  setRegisteredGroup,
  createExpense,
  getExpense,
  storeChatMetadata,
} from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

// --- helpers (mirror src/ipc-auth.test.ts) ---

function writeSenderContext(
  sourceGroup: string,
  ctx: { user_id: string; display_name?: string; tags?: string[] },
): void {
  const inputDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'input');
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(
    path.join(inputDir, 'sender_context.json'),
    JSON.stringify({
      user_id: ctx.user_id,
      display_name: ctx.display_name ?? ctx.user_id,
      tags: ctx.tags ?? [],
    }),
  );
}

function clearSenderContext(sourceGroup: string): void {
  const ctxPath = path.join(
    DATA_DIR,
    'ipc',
    sourceGroup,
    'input',
    'sender_context.json',
  );
  if (fs.existsSync(ctxPath)) fs.unlinkSync(ctxPath);
}

/**
 * Write a MULTI-sender batch sender_context (the shape the orchestrator now
 * produces when several people spoke in one run). Each entry carries the
 * platform id the host verifies an `actor_sender_id` against. The top-level
 * identity is the last roster entry (back-compat), matching the batch-last
 * behavior that the finding-1 exploit abused.
 */
function writeBatchSenderContext(
  sourceGroup: string,
  senders: Array<{
    user_id: string;
    platform_sender_id: string;
    display_name?: string;
    tags?: string[];
  }>,
): void {
  const inputDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'input');
  fs.mkdirSync(inputDir, { recursive: true });
  const norm = senders.map((s) => ({
    user_id: s.user_id,
    display_name: s.display_name ?? s.user_id,
    tags: s.tags ?? [],
    platform_sender_id: s.platform_sender_id,
  }));
  const last = norm[norm.length - 1];
  fs.writeFileSync(
    path.join(inputDir, 'sender_context.json'),
    JSON.stringify({
      user_id: last.user_id,
      display_name: last.display_name,
      tags: last.tags,
      senders: norm,
    }),
  );
}

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'approval-test-main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'approval-test-other',
  trigger: '@Breadbrich Engels',
  added_at: '2024-01-01T00:00:00.000Z',
};

// A gated class from the default conservative set, and a non-gated one.
const GATED = 'github_write';
const NOT_GATED = 'totally_benign_read_only_thing';

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;
let sent: Array<{ jid: string; text: string }>;

beforeEach(() => {
  _initTestDatabase();
  groups = { 'main@g.us': MAIN_GROUP, 'other@g.us': OTHER_GROUP };
  setRegisteredGroup('main@g.us', MAIN_GROUP);
  setRegisteredGroup('other@g.us', OTHER_GROUP);
  sent = [];
  deps = {
    sendMessage: async (jid, text) => {
      sent.push({ jid, text });
    },
    canDeliver: () => true,
    deleteMessage: async () => {},
    editMessage: async () => {},
    registeredGroups: () => groups,
    registerGroup: () => {},
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
  };
  clearSenderContext('approval-test-main');
  clearSenderContext('approval-test-other');
});

// --- config-driven action-class gating ---

describe('action-class gating (config-driven)', () => {
  it('the conservative default set is gated when nothing is declared', () => {
    // The test profile declares no gatedActionClasses → defaults apply.
    expect(GATED_ACTION_CLASSES).toEqual(DEFAULT_GATED_ACTION_CLASSES);
    for (const c of DEFAULT_GATED_ACTION_CLASSES) {
      expect(isGatedActionClass(c)).toBe(true);
    }
  });

  it('the default set is conservative (write/external/payout only)', () => {
    expect(DEFAULT_GATED_ACTION_CLASSES).toContain('outbound_external_message');
    expect(DEFAULT_GATED_ACTION_CLASSES).toContain('github_write');
    expect(DEFAULT_GATED_ACTION_CLASSES).toContain('linear_write');
    expect(DEFAULT_GATED_ACTION_CLASSES).toContain('kb_delete');
    expect(DEFAULT_GATED_ACTION_CLASSES).toContain('payout');
  });

  it('an undeclared class is NOT gated', () => {
    expect(isGatedActionClass(NOT_GATED)).toBe(false);
  });
});

// --- request_approval ---

describe('request_approval', () => {
  it('records a pending row and posts an approve/reject prompt for a gated class', async () => {
    writeSenderContext('approval-test-other', { user_id: 'alice' });
    await processTaskIpc(
      {
        type: 'request_approval',
        action_class: GATED,
        summary: 'Open PR #42 to merge the fix',
        payload: { pr: 42 },
        chatJid: 'other@g.us',
      },
      'approval-test-other',
      false,
      deps,
    );

    const pending = getPendingApprovals();
    expect(pending.length).toBe(1);
    expect(pending[0].action_class).toBe(GATED);
    expect(pending[0].summary).toBe('Open PR #42 to merge the fix');
    expect(pending[0].requested_by_user_id).toBe('alice');
    expect(JSON.parse(pending[0].payload!)).toEqual({ pr: 42 });

    // Prompt goes to the control (main) channel.
    const prompt = sent.find((m) => m.jid === 'main@g.us');
    expect(prompt).toBeTruthy();
    expect(prompt!.text).toContain('Approval needed');
    expect(prompt!.text).toContain(pending[0].id);
  });

  it('does NOT gate an undeclared class — tells the agent to proceed', async () => {
    writeSenderContext('approval-test-other', { user_id: 'alice' });
    await processTaskIpc(
      {
        type: 'request_approval',
        action_class: NOT_GATED,
        summary: 'read a public file',
        chatJid: 'other@g.us',
      },
      'approval-test-other',
      false,
      deps,
    );

    expect(getPendingApprovals().length).toBe(0);
    const proceed = sent.find((m) => m.text.includes('No approval required'));
    expect(proceed).toBeTruthy();
  });

  it('is idempotent on dedupe_key — a live pending row is reused', async () => {
    writeSenderContext('approval-test-other', { user_id: 'alice' });
    for (let i = 0; i < 2; i++) {
      await processTaskIpc(
        {
          type: 'request_approval',
          action_class: GATED,
          summary: 'merge PR #7',
          dedupe_key: 'pr-7-merge',
          chatJid: 'other@g.us',
        },
        'approval-test-other',
        false,
        deps,
      );
    }
    expect(getPendingApprovals().length).toBe(1);
  });
});

// --- resolve_approval lifecycle ---

describe('resolve_approval lifecycle', () => {
  function seedApproval(requester = 'alice') {
    return createPendingApproval({
      action_class: GATED,
      summary: 'merge PR #99',
      payload: JSON.stringify({ pr: 99 }),
      chat_jid: 'other@g.us',
      group_folder: 'approval-test-other',
      requested_by_user_id: requester,
    });
  }

  it('an authorized approver (different user) approves → status approved', async () => {
    const a = seedApproval('alice');
    writeSenderContext('approval-test-main', { user_id: 'bob' });
    await processTaskIpc(
      { type: 'resolve_approval', approval_id: a.id, decision: 'approve' },
      'approval-test-main',
      true,
      deps,
    );
    const row = getPendingApproval(a.id)!;
    expect(row.status).toBe('approved');
    expect(row.resolved_by_user_id).toBe('bob');
    expect(sent.some((m) => m.text.includes('Approved'))).toBe(true);
  });

  it('round-trips the recorded payload back to the proposer on approval', async () => {
    const a = seedApproval('alice');
    writeSenderContext('approval-test-main', { user_id: 'bob' });
    await processTaskIpc(
      { type: 'resolve_approval', approval_id: a.id, decision: 'approve' },
      'approval-test-main',
      true,
      deps,
    );
    // The proposing agent can't execute a gated action without seeing back
    // what it proposed — the approval notification must carry the payload.
    const note = sent.find(
      (m) => m.jid === 'other@g.us' && m.text.includes('Approved'),
    );
    expect(note).toBeTruthy();
    expect(note!.text).toContain(JSON.stringify({ pr: 99 }));
  });

  it('reject carries the reason back to the requesting chat', async () => {
    const a = seedApproval('alice');
    writeSenderContext('approval-test-main', { user_id: 'bob' });
    await processTaskIpc(
      {
        type: 'resolve_approval',
        approval_id: a.id,
        decision: 'reject',
        reason: 'wrong branch',
      },
      'approval-test-main',
      true,
      deps,
    );
    const row = getPendingApproval(a.id)!;
    expect(row.status).toBe('rejected');
    expect(row.revision_notes).toBe('wrong branch');
    const note = sent.find((m) => m.jid === 'other@g.us');
    expect(note!.text).toContain('wrong branch');
  });

  it('revise records revise status + notes', async () => {
    const a = seedApproval('alice');
    writeSenderContext('approval-test-main', { user_id: 'bob' });
    await processTaskIpc(
      {
        type: 'resolve_approval',
        approval_id: a.id,
        decision: 'revise',
        reason: 'tighten the summary',
      },
      'approval-test-main',
      true,
      deps,
    );
    const row = getPendingApproval(a.id)!;
    expect(row.status).toBe('revise');
    expect(row.revision_notes).toBe('tighten the summary');
  });

  it('rejects an unauthorized approver (no sender_context) — row stays pending', async () => {
    const a = seedApproval('alice');
    clearSenderContext('approval-test-main'); // no allowlisted identity
    await processTaskIpc(
      { type: 'resolve_approval', approval_id: a.id, decision: 'approve' },
      'approval-test-main',
      true, // isMain alone is NOT enough — fail closed
      deps,
    );
    expect(getPendingApproval(a.id)!.status).toBe('pending');
    expect(sent.some((m) => m.text.includes('allowlisted sender'))).toBe(true);
  });

  it('rejects self-approval by the original requester', async () => {
    const a = seedApproval('alice');
    writeSenderContext('approval-test-main', { user_id: 'alice' });
    await processTaskIpc(
      { type: 'resolve_approval', approval_id: a.id, decision: 'approve' },
      'approval-test-main',
      true,
      deps,
    );
    expect(getPendingApproval(a.id)!.status).toBe('pending');
    expect(sent.some((m) => m.text.includes('cannot approve your own'))).toBe(
      true,
    );
  });

  it('the requester may still reject/withdraw their own request', async () => {
    const a = seedApproval('alice');
    writeSenderContext('approval-test-main', { user_id: 'alice' });
    await processTaskIpc(
      {
        type: 'resolve_approval',
        approval_id: a.id,
        decision: 'reject',
        reason: 'never mind',
      },
      'approval-test-main',
      true,
      deps,
    );
    expect(getPendingApproval(a.id)!.status).toBe('rejected');
  });

  it('guards against double-resolution (already resolved)', async () => {
    const a = seedApproval('alice');
    writeSenderContext('approval-test-main', { user_id: 'bob' });
    await processTaskIpc(
      { type: 'resolve_approval', approval_id: a.id, decision: 'approve' },
      'approval-test-main',
      true,
      deps,
    );
    sent = [];
    await processTaskIpc(
      { type: 'resolve_approval', approval_id: a.id, decision: 'reject' },
      'approval-test-main',
      true,
      deps,
    );
    // Stays approved; second decision is refused.
    expect(getPendingApproval(a.id)!.status).toBe('approved');
    expect(sent.some((m) => m.text.includes('already approved'))).toBe(true);
  });

  it('reports an unknown approval id', async () => {
    writeSenderContext('approval-test-main', { user_id: 'bob' });
    await processTaskIpc(
      { type: 'resolve_approval', approval_id: 'AP-nope', decision: 'approve' },
      'approval-test-main',
      true,
      deps,
    );
    expect(sent.some((m) => m.text.includes('No approval found'))).toBe(true);
  });
});

// --- Finding 1 (HIGH): approver identity must be verified against the batch
// roster, not the batch-last sender. ---

describe('resolve_approval — multi-sender batch identity verification', () => {
  function seedApproval(requester = 'alice') {
    return createPendingApproval({
      action_class: GATED,
      summary: 'merge PR #99',
      payload: JSON.stringify({ pr: 99 }),
      chat_jid: 'other@g.us',
      group_folder: 'approval-test-other',
      requested_by_user_id: requester,
    });
  }

  it('EXPLOIT BLOCKED: proposer self-approves in a two-sender batch → rejected (no actor_sender_id)', async () => {
    // Batch: Alice (proposer) spoke, then Bob (an approver) spoke last. The old
    // code derived the approver from the batch-LAST sender (Bob), so Alice's
    // self-approval of her OWN request passed the guard and was recorded as Bob.
    const a = seedApproval('alice');
    writeBatchSenderContext('approval-test-main', [
      { user_id: 'alice', platform_sender_id: 'U_ALICE' },
      { user_id: 'bob', platform_sender_id: 'U_BOB' },
    ]);
    // Agent forwards the decision without disambiguating who approved.
    await processTaskIpc(
      { type: 'resolve_approval', approval_id: a.id, decision: 'approve' },
      'approval-test-main',
      true,
      deps,
    );
    // Fail closed: ambiguous → still pending, nothing attributed to Bob.
    expect(getPendingApproval(a.id)!.status).toBe('pending');
    expect(getPendingApproval(a.id)!.resolved_by_user_id).toBeNull();
    expect(sent.some((m) => m.text.includes("Couldn't tell who approved"))).toBe(
      true,
    );
  });

  it('EXPLOIT BLOCKED: even when actor_sender_id points at the proposer, self-approval is refused', async () => {
    const a = seedApproval('alice');
    writeBatchSenderContext('approval-test-main', [
      { user_id: 'alice', platform_sender_id: 'U_ALICE' },
      { user_id: 'bob', platform_sender_id: 'U_BOB' },
    ]);
    // Agent (honestly or maliciously) names Alice as the approver — she IS the
    // requester, so the self-approval guard must fire against the verified id.
    await processTaskIpc(
      {
        type: 'resolve_approval',
        approval_id: a.id,
        decision: 'approve',
        actor_sender_id: 'U_ALICE',
      },
      'approval-test-main',
      true,
      deps,
    );
    expect(getPendingApproval(a.id)!.status).toBe('pending');
    expect(sent.some((m) => m.text.includes('cannot approve your own'))).toBe(
      true,
    );
  });

  it('HAPPY PATH: actor_sender_id identifies the real third-party approver → approved and attributed to them', async () => {
    const a = seedApproval('alice');
    writeBatchSenderContext('approval-test-main', [
      { user_id: 'alice', platform_sender_id: 'U_ALICE' },
      { user_id: 'bob', platform_sender_id: 'U_BOB' },
    ]);
    await processTaskIpc(
      {
        type: 'resolve_approval',
        approval_id: a.id,
        decision: 'approve',
        actor_sender_id: 'U_BOB',
      },
      'approval-test-main',
      true,
      deps,
    );
    const row = getPendingApproval(a.id)!;
    expect(row.status).toBe('approved');
    // Attributed to the VERIFIED approver (Bob), regardless of batch order.
    expect(row.resolved_by_user_id).toBe('bob');
  });

  it('a non-matching actor_sender_id in a multi-sender batch fails closed', async () => {
    const a = seedApproval('alice');
    writeBatchSenderContext('approval-test-main', [
      { user_id: 'alice', platform_sender_id: 'U_ALICE' },
      { user_id: 'bob', platform_sender_id: 'U_BOB' },
    ]);
    await processTaskIpc(
      {
        type: 'resolve_approval',
        approval_id: a.id,
        decision: 'approve',
        actor_sender_id: 'U_SOMEONE_ELSE',
      },
      'approval-test-main',
      true,
      deps,
    );
    expect(getPendingApproval(a.id)!.status).toBe('pending');
  });

  it('single-sender batch: actor_sender_id is unnecessary and approval works (back-compat)', async () => {
    const a = seedApproval('alice');
    // Only Bob spoke this batch → unambiguous, no actor_sender_id needed.
    writeBatchSenderContext('approval-test-main', [
      { user_id: 'bob', platform_sender_id: 'U_BOB' },
    ]);
    await processTaskIpc(
      { type: 'resolve_approval', approval_id: a.id, decision: 'approve' },
      'approval-test-main',
      true,
      deps,
    );
    const row = getPendingApproval(a.id)!;
    expect(row.status).toBe('approved');
    expect(row.resolved_by_user_id).toBe('bob');
  });
});

// The same misattribution defense applies to the pre-existing expense
// self-approval guard (`expense_decision`).
describe('expense_decision — multi-sender batch identity verification', () => {
  function seedExpense(requester = 'alice') {
    const id = 'exp-test-1';
    // expenses.chat_jid has a FK to chats(jid) — seed the chat row first.
    storeChatMetadata('other@g.us', '2024-01-01T00:00:00.000Z', 'Other');
    createExpense({
      id,
      chat_jid: 'other@g.us',
      requester_user_id: requester,
      request_type: 'prospective',
      amount_cents: 5000,
      description: 'coffee for the offsite',
      status: 'pending_approval',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    return id;
  }

  it('EXPLOIT BLOCKED: requester self-approves in a two-sender batch → refused', async () => {
    const id = seedExpense('alice');
    // Alice (requester) then Bob spoke; batch-last is Bob. Agent forwards the
    // approve without an actor id → ambiguous → refused, expense unchanged.
    writeBatchSenderContext('approval-test-main', [
      { user_id: 'alice', platform_sender_id: 'U_ALICE' },
      { user_id: 'bob', platform_sender_id: 'U_BOB' },
    ]);
    await processTaskIpc(
      { type: 'expense_decision', expense_id: id, decision: 'approve' },
      'approval-test-main',
      true,
      deps,
    );
    expect(getExpense(id)!.status).toBe('pending_approval');
    expect(getExpense(id)!.approver_user_id).toBeNull();
  });

  it('EXPLOIT BLOCKED: actor_sender_id pointing at the requester still hits the self-approval guard', async () => {
    const id = seedExpense('alice');
    writeBatchSenderContext('approval-test-main', [
      { user_id: 'alice', platform_sender_id: 'U_ALICE' },
      { user_id: 'bob', platform_sender_id: 'U_BOB' },
    ]);
    await processTaskIpc(
      {
        type: 'expense_decision',
        expense_id: id,
        decision: 'approve',
        actor_sender_id: 'U_ALICE',
      },
      'approval-test-main',
      true,
      deps,
    );
    expect(getExpense(id)!.status).toBe('pending_approval');
    expect(
      sent.some((m) => m.text.includes('cannot approve your own expense')),
    ).toBe(true);
  });

  it('HAPPY PATH: a verified third-party approver decides → expense advances', async () => {
    const id = seedExpense('alice');
    writeBatchSenderContext('approval-test-main', [
      { user_id: 'alice', platform_sender_id: 'U_ALICE' },
      { user_id: 'bob', platform_sender_id: 'U_BOB' },
    ]);
    await processTaskIpc(
      {
        type: 'expense_decision',
        expense_id: id,
        decision: 'approve',
        actor_sender_id: 'U_BOB',
      },
      'approval-test-main',
      true,
      deps,
    );
    const exp = getExpense(id)!;
    // prospective + approve → receipt_pending, attributed to Bob.
    expect(exp.status).toBe('receipt_pending');
    expect(exp.approver_user_id).toBe('bob');
  });
});

// --- expiry ---

describe('approval expiry', () => {
  it('creates a row with expires_at when ttl is set', () => {
    const a = createPendingApproval({
      action_class: GATED,
      summary: 'x',
      chat_jid: 'other@g.us',
      group_folder: 'approval-test-other',
      requested_by_user_id: 'alice',
      ttl_minutes: 60,
    });
    expect(a.expires_at).toBeTruthy();
    expect(new Date(a.expires_at!).getTime()).toBeGreaterThan(Date.now());
  });

  it('expireStalePendingApprovals flips a past-deadline pending row to expired', () => {
    const a = createPendingApproval({
      action_class: GATED,
      summary: 'stale one',
      chat_jid: 'other@g.us',
      group_folder: 'approval-test-other',
      requested_by_user_id: 'alice',
      ttl_minutes: 60,
    });
    // Sweep with a "now" far in the future.
    const future = new Date(Date.now() + 2 * 3600_000).toISOString();
    const expired = expireStalePendingApprovals(future);
    expect(expired.map((r) => r.id)).toContain(a.id);
    expect(getPendingApproval(a.id)!.status).toBe('expired');
  });

  it('does not expire a row before its deadline, and is idempotent', () => {
    const a = createPendingApproval({
      action_class: GATED,
      summary: 'fresh',
      chat_jid: 'other@g.us',
      group_folder: 'approval-test-other',
      requested_by_user_id: 'alice',
      ttl_minutes: 60,
    });
    // Now is before the deadline → no expiry.
    expect(expireStalePendingApprovals(new Date().toISOString())).toEqual([]);
    expect(getPendingApproval(a.id)!.status).toBe('pending');

    // Once expired, a second sweep does not re-report it.
    const future = new Date(Date.now() + 2 * 3600_000).toISOString();
    expect(expireStalePendingApprovals(future).length).toBe(1);
    expect(expireStalePendingApprovals(future).length).toBe(0);
  });

  it('an expired row cannot then be resolved', () => {
    const a = createPendingApproval({
      action_class: GATED,
      summary: 'expired then approved?',
      chat_jid: 'other@g.us',
      group_folder: 'approval-test-other',
      requested_by_user_id: 'alice',
      ttl_minutes: 60,
    });
    expireStalePendingApprovals(
      new Date(Date.now() + 2 * 3600_000).toISOString(),
    );
    // resolvePendingApproval only moves 'pending' rows.
    const result = resolvePendingApproval(a.id, 'approved', 'bob');
    expect(result).toBeUndefined();
    expect(getPendingApproval(a.id)!.status).toBe('expired');
  });
});
