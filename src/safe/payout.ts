/**
 * payout.ts — the DETERMINISTIC core of the Safe{Wallet} payout flow (#108).
 *
 * Everything here is pure and unit-tested: ERC-20 transfer encoding, EIP-55
 * address validation, amount parsing/formatting, the confirmation-mirror state
 * machine, and the Safe{Wallet} deep link. None of it touches the network, a
 * private key, or the DB — so it can't move funds and is trivial to test. The
 * network/SDK side (signing + proposing + reading the Tx Service) is isolated
 * in proposer.ts; the orchestration is in src/integrations/safe-payouts.ts.
 */

import { ethers } from 'ethers';

import type { SafePayoutStatus } from '../db.js';

/** Minimal ERC-20 ABI fragment — only `transfer` is needed for a payout. */
const ERC20 = new ethers.Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
]);

/**
 * Validate + checksum a recipient address. Throws on anything that isn't a
 * well-formed EVM address (wrong length, bad hex, or a mis-typed EIP-55
 * checksum). Returns the canonical checksummed form. The flow REFUSES rather
 * than guesses on a bad address — never send funds to an unparseable target.
 */
export function validateAddress(addr: string): string {
  if (typeof addr !== 'string' || !addr.trim()) {
    throw new Error('recipient address is empty');
  }
  try {
    return ethers.getAddress(addr.trim());
  } catch {
    throw new Error(`not a valid EVM address: ${addr}`);
  }
}

/** Parse a human amount ("100", "0.5") into base units (wei) for `decimals`. */
export function parseAmount(human: string, decimals = 18): bigint {
  return ethers.parseUnits(String(human).trim(), decimals);
}

/** Render base units back to a human display string, e.g. "100 BREAD". */
export function formatAmount(
  raw: bigint | string,
  decimals = 18,
  symbol = 'tokens',
): string {
  return `${ethers.formatUnits(BigInt(raw), decimals)} ${symbol}`.trim();
}

/** The ERC-20 `transfer(to, amount)` calldata for the reimbursement. */
export function encodeTransfer(to: string, amountRaw: bigint | string): string {
  return ERC20.encodeFunctionData('transfer', [
    validateAddress(to),
    BigInt(amountRaw),
  ]);
}

/**
 * Build the Safe transaction payload for a token reimbursement. `to` is the
 * TOKEN contract (not the recipient); value is 0; the recipient + amount are
 * encoded in `data`. This is exactly what gets handed to the Protocol Kit.
 */
export function buildTransferTx(
  tokenAddress: string,
  recipient: string,
  amountRaw: bigint | string,
): { to: string; value: string; data: string } {
  return {
    to: validateAddress(tokenAddress),
    value: '0',
    data: encodeTransfer(recipient, amountRaw),
  };
}

/** What the proposer reads back from the Transaction Service for a tx. */
export interface OnchainTxState {
  confirmations: number;
  threshold: number;
  isExecuted: boolean;
  executionTxHash: string | null;
  /** The Safe's nonce was consumed by a DIFFERENT executed tx → this is dead. */
  isRejected?: boolean;
}

export type SafePayoutEvent = 'none' | 'confirmation' | 'executed' | 'rejected';

export interface ReconcileResult {
  status: SafePayoutStatus;
  confirmations: number;
  threshold: number | null;
  execTxHash: string | null;
  /** The state-change that happened this tick (drives whether we post a mirror). */
  event: SafePayoutEvent;
}

const TERMINAL: ReadonlySet<SafePayoutStatus> = new Set([
  'executed',
  'cancelled',
  'rejected',
  'failed',
]);

/**
 * Pure mirror state machine. Given the current row state and the latest
 * on-chain observation, decide the next status and whether a chat mirror is
 * warranted. Status only ever ADVANCES, and terminal rows are immutable — so a
 * replayed execution event can never double-transition (idempotency).
 */
export function reconcile(
  current: {
    status: SafePayoutStatus;
    confirmations: number;
    threshold: number | null;
    exec_tx_hash: string | null;
  },
  onchain: OnchainTxState | null,
): ReconcileResult {
  const unchanged: ReconcileResult = {
    status: current.status,
    confirmations: current.confirmations,
    threshold: current.threshold,
    execTxHash: current.exec_tx_hash,
    event: 'none',
  };

  // Terminal rows never move again; not-yet-found tx → nothing to mirror.
  if (TERMINAL.has(current.status) || onchain == null) return unchanged;

  if (onchain.isRejected) {
    return {
      status: 'rejected',
      confirmations: onchain.confirmations,
      threshold: onchain.threshold,
      execTxHash: current.exec_tx_hash,
      event: 'rejected',
    };
  }

  if (onchain.isExecuted) {
    return {
      status: 'executed',
      confirmations: onchain.confirmations,
      threshold: onchain.threshold,
      execTxHash: onchain.executionTxHash,
      event: current.status === 'executed' ? 'none' : 'executed',
    };
  }

  const status: SafePayoutStatus =
    onchain.confirmations > 0 ? 'confirming' : 'proposed';
  const event: SafePayoutEvent =
    onchain.confirmations !== current.confirmations ? 'confirmation' : 'none';

  return {
    status,
    confirmations: onchain.confirmations,
    threshold: onchain.threshold,
    execTxHash: current.exec_tx_hash,
    event,
  };
}

/** Short EIP-3770 chain prefixes for the Safe{Wallet} deep link. */
const CHAIN_PREFIX: Record<number, string> = {
  1: 'eth',
  100: 'gno',
  10: 'oeth',
  137: 'matic',
  42161: 'arb1',
  8453: 'base',
};

/**
 * Best-effort Safe{Wallet} UI link so signers can open the proposal and confirm
 * in their own wallet. Returns null if we can't build one (no base URL / hash).
 */
export function safeWalletTxUrl(
  cfg: { safeWalletBaseUrl?: string; chainId: number; safeAddress: string },
  safeTxHash: string | null,
): string | null {
  if (!cfg.safeWalletBaseUrl || !safeTxHash) return null;
  const prefix = CHAIN_PREFIX[cfg.chainId];
  if (!prefix) return null;
  const base = cfg.safeWalletBaseUrl.replace(/\/+$/, '');
  const safe = `${prefix}:${cfg.safeAddress}`;
  const id = `multisig_${cfg.safeAddress}_${safeTxHash}`;
  return `${base}/transactions/tx?safe=${safe}&id=${id}`;
}
