/**
 * approval-expiry — sweeps stale pending approvals to `expired`.
 *
 * The reusable approval primitive (src/ipc.ts `request_approval` /
 * `resolve_approval`, `pending_approvals` table) records a per-row deadline
 * (`expires_at`, from APPROVAL_TIMEOUT_MINUTES). This background flow — a
 * config-gated self-registered integration, exactly like safe-payouts —
 * flips any pending row past its deadline to `expired` and posts a one-shot
 * "this approval request expired" mirror into the requesting group's outbox so
 * the proposing agent (and humans) learn the action will not be taken.
 *
 * Durability comes from the table + this idempotent sweep, not a sidecar: each
 * tick re-derives from the row's own `expires_at`, so a crash/restart loses
 * nothing and an already-expired row is never re-swept or double-notified.
 *
 * Dormant when APPROVAL_TIMEOUT_MINUTES is 0 (approvals never auto-expire).
 */

import fs from 'fs';
import path from 'path';

import { APPROVAL_TIMEOUT_MINUTES, DATA_DIR } from '../config.js';
import { expireStalePendingApprovals, type PendingApproval } from '../db.js';
import { logger } from '../logger.js';

const TICK_MS = Number(process.env.APPROVAL_EXPIRY_TICK_MS) || 60_000;
let timer: ReturnType<typeof setInterval> | null = null;

/** Atomic-write a chat-mirror message into the group's IPC outbox. */
function postMirror(row: PendingApproval, text: string): void {
  if (!row.chat_jid) return;
  const dir = path.join(DATA_DIR, 'ipc', row.group_folder, 'messages');
  fs.mkdirSync(dir, { recursive: true });
  const name = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const tmp = path.join(dir, `${name}.tmp`);
  fs.writeFileSync(
    tmp,
    JSON.stringify(
      {
        type: 'message',
        chatJid: row.chat_jid,
        text,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  fs.renameSync(tmp, path.join(dir, name));
}

export function sweepExpiredApprovals(): void {
  const expired = expireStalePendingApprovals();
  for (const row of expired) {
    postMirror(
      row,
      `⌛ Approval request ${row.id} (\`${row.action_class}\`) expired without a decision. ` +
        `The action was NOT taken. Re-request it if it's still needed.`,
    );
  }
  if (expired.length > 0) {
    logger.info(
      { count: expired.length },
      'approval-expiry: swept expired approvals',
    );
  }
}

export function startApprovalExpiryLoop(): void {
  if (APPROVAL_TIMEOUT_MINUTES <= 0) {
    logger.info(
      'approval-expiry: APPROVAL_TIMEOUT_MINUTES=0 — approvals never expire, loop dormant',
    );
    return;
  }
  const run = () => {
    try {
      sweepExpiredApprovals();
    } catch (err) {
      logger.error({ err }, 'approval-expiry: sweep tick failed');
    }
  };
  const first = setTimeout(run, 30_000);
  first.unref?.();
  timer = setInterval(run, TICK_MS);
  timer.unref?.();
  logger.info(
    { tickMs: TICK_MS, timeoutMinutes: APPROVAL_TIMEOUT_MINUTES },
    'approval-expiry loop started',
  );
}

export function stopApprovalExpiryLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
