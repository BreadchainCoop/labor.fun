/**
 * safe-payouts — the #108 reconcile loop. A background flow (registered like
 * any other integration) that drives `safe_payouts` rows forward:
 *
 *   requested  → propose the BREAD transfer to the Safe (proposer key), pin the
 *                safe_tx_hash, post the "proposed / confirm in your wallet" mirror.
 *   proposed/  → read the Transaction Service, mirror "N/threshold confirmed",
 *   confirming   and on observed execution flip the row to `executed`.
 *
 * Durability comes from the table + this idempotent reconcile, not a sidecar:
 * each tick re-derives state from chain truth, so a crash/restart loses nothing
 * and a replayed event can't double-transition (the pure `reconcile` guards
 * terminal rows). The agent is a PROPOSER ONLY — it never confirms or executes.
 *
 * Dormant unless `safe` is configured in profile.config.json. The propose step
 * additionally needs `SAFE_PROPOSER_KEY` in the env/vault; without it, requested
 * rows simply wait (reads still work) and we warn once.
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR, PROFILE, PROFILE_DIR } from '../config.js';
import {
  getActiveSafePayouts,
  markSafePayoutFailed,
  markSafePayoutProposed,
  updateSafePayoutMirror,
  type SafePayout,
} from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  buildTransferTx,
  formatAmount,
  reconcile,
  safeWalletTxUrl,
} from '../safe/payout.js';
import {
  fetchTxState,
  proposeTransfer,
  type SafeConfig,
} from '../safe/proposer.js';

const TICK_MS = Number(process.env.SAFE_PAYOUTS_TICK_MS) || 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let warnedNoKey = false;

function safeConfig(): SafeConfig | null {
  const s = PROFILE.safe;
  if (!s || !s.safeAddress || !s.tokenAddress || !s.rpcUrl) return null;
  return {
    chainId: s.chainId,
    safeAddress: s.safeAddress,
    tokenAddress: s.tokenAddress,
    rpcUrl: s.rpcUrl,
    txServiceUrl: s.txServiceUrl,
  };
}

function proposerKey(): string | undefined {
  return (
    process.env.SAFE_PROPOSER_KEY ||
    readEnvFile(['SAFE_PROPOSER_KEY']).SAFE_PROPOSER_KEY ||
    undefined
  );
}

/** Atomic-write a chat-mirror message into the group's IPC outbox. */
function postMirror(row: SafePayout, text: string): void {
  const dir = path.join(DATA_DIR, 'ipc', row.group_folder, 'messages');
  fs.mkdirSync(dir, { recursive: true });
  const name = `safepay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
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

function amountLabel(row: SafePayout): string {
  return (
    row.amount_display ||
    formatAmount(
      row.amount_raw,
      PROFILE.safe?.tokenDecimals ?? 18,
      PROFILE.safe?.tokenSymbol ?? 'tokens',
    )
  );
}

async function proposeRow(
  cfg: SafeConfig,
  key: string,
  row: SafePayout,
): Promise<void> {
  // Idempotency backstop: never re-propose a row that already has a hash.
  if (row.safe_tx_hash) return;
  try {
    const tx = buildTransferTx(
      cfg.tokenAddress,
      row.recipient_address,
      row.amount_raw,
    );
    const res = await proposeTransfer(cfg, key, tx);
    markSafePayoutProposed(row.id, {
      safe_tx_hash: res.safeTxHash,
      safe_nonce: res.nonce,
      threshold: res.threshold,
    });
    const link = safeWalletTxUrl(
      { ...cfg, safeWalletBaseUrl: PROFILE.safe?.safeWalletBaseUrl },
      res.safeTxHash,
    );
    postMirror(
      { ...row, safe_tx_hash: res.safeTxHash },
      `💸 ${row.id}: proposed a ${amountLabel(row)} payout to ${row.recipient_slug ?? row.recipient_address}. ` +
        `This is now a Safe proposal — it pays out only once signers reach the threshold` +
        `${res.threshold ? ` (0/${res.threshold} confirmed)` : ''}. ` +
        `Confirm in your wallet${link ? `: ${link}` : '.'}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    markSafePayoutFailed(row.id, msg);
    logger.error({ err, id: row.id }, 'safe-payouts: propose failed');
  }
}

async function mirrorRow(cfg: SafeConfig, row: SafePayout): Promise<void> {
  if (!row.safe_tx_hash) return;
  const state = await fetchTxState(cfg, row.safe_tx_hash, row.safe_nonce);
  const r = reconcile(row, state);
  if (r.event === 'none') return;

  updateSafePayoutMirror(row.id, {
    status: r.status,
    confirmations: r.confirmations,
    threshold: r.threshold,
    exec_tx_hash: r.execTxHash,
    executed_at: r.event === 'executed' ? new Date().toISOString() : null,
  });

  if (r.event === 'confirmation') {
    postMirror(
      row,
      `🖊️ ${row.id}: ${r.confirmations}/${r.threshold ?? '?'} signers have confirmed the ${amountLabel(row)} payout.`,
    );
  } else if (r.event === 'executed') {
    postMirror(
      row,
      `✅ ${row.id}: the ${amountLabel(row)} payout to ${row.recipient_slug ?? row.recipient_address} executed on-chain.` +
        (r.execTxHash ? ` Tx: ${r.execTxHash}` : ''),
    );
  } else if (r.event === 'rejected') {
    postMirror(
      row,
      `🚫 ${row.id}: this proposal was replaced/rejected on-chain (its Safe nonce was used by another transaction). No payout was made.`,
    );
  }
}

export async function reconcileSafePayouts(): Promise<void> {
  const cfg = safeConfig();
  if (!cfg) return; // not configured → dormant
  const rows = getActiveSafePayouts();
  if (rows.length === 0) return;

  const key = proposerKey();
  for (const row of rows) {
    if (row.status === 'requested') {
      if (!key) {
        if (!warnedNoKey) {
          logger.warn(
            'safe-payouts: SAFE_PROPOSER_KEY not set — requested payouts will wait',
          );
          warnedNoKey = true;
        }
        continue;
      }
      await proposeRow(cfg, key, row);
    } else {
      await mirrorRow(cfg, row);
    }
  }
}

export function startSafePayoutsLoop(): void {
  if (!safeConfig()) {
    logger.info('safe-payouts: no `safe` config — integration dormant');
    return;
  }
  const run = () => {
    reconcileSafePayouts().catch((err) =>
      logger.error({ err }, 'safe-payouts: reconcile tick failed'),
    );
  };
  const first = setTimeout(run, 30_000);
  first.unref?.();
  timer = setInterval(run, TICK_MS);
  timer.unref?.();
  logger.info(
    { tickMs: TICK_MS, profileDir: PROFILE_DIR },
    'safe-payouts loop started',
  );
}

export function stopSafePayoutsLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
