import { describe, expect, it } from 'vitest';

import {
  buildTransferTx,
  encodeTransfer,
  formatAmount,
  parseAmount,
  reconcile,
  safeWalletTxUrl,
  validateAddress,
  type OnchainTxState,
} from './payout.js';

const TOKEN = '0xa555d5344f6FB6c65da19e403Cb4c1eC4a1a5Ee3'; // BREAD
const RECIPIENT = '0x918dEf5d593F46735f74F9E2B280Fe51AF3A99ad';

describe('validateAddress', () => {
  it('returns the checksummed form for a valid address', () => {
    expect(validateAddress(RECIPIENT.toLowerCase())).toBe(RECIPIENT);
  });
  it('trims surrounding whitespace', () => {
    expect(validateAddress(`  ${RECIPIENT}  `)).toBe(RECIPIENT);
  });
  it('throws on garbage, wrong length, and empty', () => {
    expect(() => validateAddress('0x123')).toThrow();
    expect(() => validateAddress('not-an-address')).toThrow();
    expect(() => validateAddress('')).toThrow();
  });
  it('throws on a mistyped EIP-55 checksum', () => {
    // flip one char's case in a valid checksummed address
    const bad = RECIPIENT.replace('918dEf', '918dEF');
    expect(() => validateAddress(bad)).toThrow();
  });
});

describe('amount parse/format', () => {
  it('round-trips 18-decimal amounts', () => {
    expect(parseAmount('100', 18)).toBe(100_000000000000000000n);
    expect(formatAmount(100_000000000000000000n, 18, 'BREAD')).toBe(
      '100.0 BREAD',
    );
  });
  it('handles fractional amounts', () => {
    expect(parseAmount('0.5', 18)).toBe(500000000000000000n);
  });
});

describe('encodeTransfer / buildTransferTx', () => {
  it('emits the ERC-20 transfer selector + padded args', () => {
    const data = encodeTransfer(RECIPIENT, 1n);
    expect(data.startsWith('0xa9059cbb')).toBe(true); // transfer(address,uint256)
    expect(data.toLowerCase()).toContain(
      '918def5d593f46735f74f9e2b280fe51af3a99ad',
    );
    expect(data.length).toBe(2 + 8 + 64 + 64); // 0x + selector + 2 words
  });
  it('builds a token-transfer Safe tx (to=token, value=0)', () => {
    const tx = buildTransferTx(TOKEN, RECIPIENT, 5n);
    expect(tx.to).toBe(TOKEN);
    expect(tx.value).toBe('0');
    expect(tx.data.startsWith('0xa9059cbb')).toBe(true);
  });
  it('refuses to encode to a bad recipient', () => {
    expect(() => encodeTransfer('0xnope', 1n)).toThrow();
  });
});

const base = {
  status: 'proposed' as const,
  confirmations: 0,
  threshold: 2,
  exec_tx_hash: null,
};

describe('reconcile state machine', () => {
  it('no-ops when the tx is not on the service yet', () => {
    expect(reconcile(base, null).event).toBe('none');
  });

  it('emits a confirmation event when a signer confirms', () => {
    const on: OnchainTxState = {
      confirmations: 1,
      threshold: 2,
      isExecuted: false,
      executionTxHash: null,
    };
    const r = reconcile(base, on);
    expect(r.status).toBe('confirming');
    expect(r.confirmations).toBe(1);
    expect(r.event).toBe('confirmation');
  });

  it('stays quiet when confirmation count is unchanged', () => {
    const cur = { ...base, status: 'confirming' as const, confirmations: 1 };
    const on: OnchainTxState = {
      confirmations: 1,
      threshold: 2,
      isExecuted: false,
      executionTxHash: null,
    };
    expect(reconcile(cur, on).event).toBe('none');
  });

  it('flips to executed and emits once', () => {
    const on: OnchainTxState = {
      confirmations: 2,
      threshold: 2,
      isExecuted: true,
      executionTxHash: '0xexec',
    };
    const r = reconcile({ ...base, status: 'confirming' }, on);
    expect(r.status).toBe('executed');
    expect(r.execTxHash).toBe('0xexec');
    expect(r.event).toBe('executed');
  });

  it('is idempotent — a replayed execution does not re-fire', () => {
    const cur = {
      status: 'executed' as const,
      confirmations: 2,
      threshold: 2,
      exec_tx_hash: '0xexec',
    };
    const on: OnchainTxState = {
      confirmations: 2,
      threshold: 2,
      isExecuted: true,
      executionTxHash: '0xexec',
    };
    expect(reconcile(cur, on).event).toBe('none');
  });

  it('detects a rejected/replaced proposal', () => {
    const on: OnchainTxState = {
      confirmations: 0,
      threshold: 2,
      isExecuted: false,
      executionTxHash: null,
      isRejected: true,
    };
    expect(reconcile(base, on).event).toBe('rejected');
    expect(reconcile(base, on).status).toBe('rejected');
  });
});

describe('safeWalletTxUrl', () => {
  it('builds a Gnosis deep link', () => {
    const url = safeWalletTxUrl(
      {
        safeWalletBaseUrl: 'https://app.safe.global',
        chainId: 100,
        safeAddress: RECIPIENT,
      },
      '0xhash',
    );
    expect(url).toContain('gno:' + RECIPIENT);
    expect(url).toContain('0xhash');
  });
  it('returns null without a base url or for an unknown chain', () => {
    expect(
      safeWalletTxUrl({ chainId: 100, safeAddress: RECIPIENT }, '0xh'),
    ).toBeNull();
    expect(
      safeWalletTxUrl(
        {
          safeWalletBaseUrl: 'https://x',
          chainId: 99999,
          safeAddress: RECIPIENT,
        },
        '0xh',
      ),
    ).toBeNull();
  });
});
