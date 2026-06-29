/**
 * proposer.ts — the ONLY part of the payout flow that touches a key or the
 * network. It is a thin adapter over the Safe SDK so the deterministic core
 * (payout.ts) and the reconcile loop stay testable and SDK-agnostic.
 *
 * TRUST BOUNDARY: this signs with the PROPOSER key and calls
 * `apiKit.proposeTransaction`. The proposer is a non-owner delegate — its
 * signature does NOT count toward the Safe threshold and it can never call
 * `confirmTransaction` / `executeTransaction`. Worst case if this key leaks is
 * spam proposals the signers reject; it can never move funds. The proposer key
 * comes from the env/vault (`SAFE_PROPOSER_KEY`), never from config or git.
 *
 * ── VERIFIED against protocol-kit v8 / api-kit v5 (live Gnosis test Safe) ────
 * The Safe packages are dynamically imported so this file does not gate the
 * core build. Confirmed end-to-end (propose + read) against a real Gnosis Safe:
 *   • Safe.init({ provider, signer, safeAddress }) → createTransaction →
 *     getTransactionHash → signHash → apiKit.proposeTransaction. ✓
 *   • A non-owner proposer's senderSignature IS accepted. ✓
 *   • api-kit v5 requires EITHER an explicit `txServiceUrl` OR a Safe API key
 *     (apiKey/SAFE_TX_SERVICE_API_KEY). For Gnosis, set txServiceUrl to
 *     https://safe-transaction-gnosis-chain.safe.global/api (validated keyless).
 *   • getTransaction(...) fields used: confirmations[], confirmationsRequired,
 *     isExecuted, transactionHash, nonce. ✓
 * See rules/finance/safe-payouts.md.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { ethers } from 'ethers';

import { logger } from '../logger.js';
import type { OnchainTxState } from './payout.js';

export interface SafeConfig {
  chainId: number;
  safeAddress: string;
  tokenAddress: string;
  rpcUrl: string;
  txServiceUrl?: string;
}

export interface ProposeResult {
  safeTxHash: string;
  nonce: number;
  threshold: number | null;
}

/** Lazily resolve the Tx Service API key from env/vault (optional on some nets). */
function txServiceApiKey(): string | undefined {
  return process.env.SAFE_TX_SERVICE_API_KEY || undefined;
}

/**
 * Dynamic-import a class constructor from an ESM-only Safe package, tolerating
 * either default-export or namespace interop. Typed `any` on purpose — see the
 * VERIFY-ON-INSTALL note above. Uses a computed specifier so tsc treats the
 * import as runtime-only (these packages have no CJS entry to type-resolve).
 */
async function loadDefault(spec: string): Promise<any> {
  const mod: any = await import(/* @vite-ignore */ spec);
  return mod?.default ?? mod;
}

/**
 * Build, sign (proposer key), and propose a Safe transaction. Idempotency is
 * the caller's job: never call this for a row that already has a safe_tx_hash.
 * Returns the deterministic safeTxHash + assigned nonce + the Safe threshold.
 */
export async function proposeTransfer(
  cfg: SafeConfig,
  proposerKey: string,
  tx: { to: string; value: string; data: string },
): Promise<ProposeResult> {
  // Dynamic import keeps the heavy, ESM-only SDK out of the core build/test
  // path. Typed `any`: the exact v8/v5 surface is VERIFY-ON-INSTALL — we pin
  // behavior with runtime guards, not the compiler. `default ?? mod` tolerates
  // either default-export or namespace interop shapes.
  const Safe = await loadDefault('@safe-global/protocol-kit');
  const SafeApiKit = await loadDefault('@safe-global/api-kit');

  const senderAddress = new ethers.Wallet(proposerKey).address;

  const protocolKit = await Safe.init({
    provider: cfg.rpcUrl,
    signer: proposerKey,
    safeAddress: cfg.safeAddress,
  });

  const safeTransaction = await protocolKit.createTransaction({
    transactions: [tx],
  });
  const safeTxHash = await protocolKit.getTransactionHash(safeTransaction);
  const signature = await protocolKit.signHash(safeTxHash);
  const threshold = await protocolKit.getThreshold().catch(() => null);

  const apiKit = new SafeApiKit({
    chainId: BigInt(cfg.chainId),
    ...(cfg.txServiceUrl ? { txServiceUrl: cfg.txServiceUrl } : {}),
    ...(txServiceApiKey() ? { apiKey: txServiceApiKey() } : {}),
  });

  await apiKit.proposeTransaction({
    safeAddress: cfg.safeAddress,
    safeTransactionData: safeTransaction.data,
    safeTxHash,
    senderAddress,
    senderSignature: signature.data,
  });

  logger.info(
    { safeTxHash, nonce: safeTransaction.data.nonce, senderAddress },
    'safe-payouts: proposed transaction',
  );

  return {
    safeTxHash,
    nonce: Number(safeTransaction.data.nonce),
    threshold,
  };
}

/**
 * Read the current confirmation/execution state for a proposed tx. Returns null
 * if the Tx Service doesn't know it yet (just-proposed race / indexing lag) so
 * the reconcile loop simply tries again next tick. Read-only: no key needed.
 */
export async function fetchTxState(
  cfg: SafeConfig,
  safeTxHash: string,
  ourNonce?: number | null,
): Promise<OnchainTxState | null> {
  const SafeApiKit = await loadDefault('@safe-global/api-kit');
  const apiKit = new SafeApiKit({
    chainId: BigInt(cfg.chainId),
    ...(cfg.txServiceUrl ? { txServiceUrl: cfg.txServiceUrl } : {}),
    ...(txServiceApiKey() ? { apiKey: txServiceApiKey() } : {}),
  });

  let tx: {
    confirmations?: unknown[];
    confirmationsRequired?: number;
    isExecuted?: boolean;
    transactionHash?: string | null;
    nonce?: number;
  };
  try {
    tx = await apiKit.getTransaction(safeTxHash);
  } catch (err) {
    logger.debug({ err, safeTxHash }, 'safe-payouts: tx not on service yet');
    return null;
  }

  // Rejection heuristic: the Safe consumed our nonce with a DIFFERENT executed
  // tx. Detect by comparing the Safe's current on-chain nonce to ours — if the
  // chain has moved past our nonce but our tx never executed, it's dead.
  let isRejected = false;
  if (ourNonce != null && !tx.isExecuted) {
    try {
      const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
      // Safe `nonce()` selector 0xaffed0e0, returns uint256.
      const raw = await provider.call({
        to: cfg.safeAddress,
        data: '0xaffed0e0',
      });
      const currentNonce = Number(BigInt(raw));
      if (currentNonce > ourNonce) isRejected = true;
    } catch (err) {
      logger.debug({ err }, 'safe-payouts: could not read current Safe nonce');
    }
  }

  return {
    confirmations: Array.isArray(tx.confirmations)
      ? tx.confirmations.length
      : 0,
    threshold: tx.confirmationsRequired ?? 0,
    isExecuted: Boolean(tx.isExecuted),
    executionTxHash: tx.transactionHash ?? null,
    isRejected,
  };
}
