import { describe, expect, it } from 'vitest';

import {
  addrFromTopic,
  aggregateCycle,
  formatCycleDate,
  formatUnits,
  parseConfig,
  renderSankey,
} from '../distribution-sankey.mjs';

const pad32 = (addr) => '0x' + addr.replace(/^0x/, '').padStart(64, '0');
const u256 = (v) => '0x' + v.toString(16).padStart(64, '0');

describe('parseConfig', () => {
  it('reads channel, addresses, names; lowercases addresses', () => {
    const c = parseConfig(
      [
        '---',
        'channel_jid: dc:111',
        "distributor: '0xEE95A62b749d8a2520E0128D9b3aCa241269024b'",
        "bread_token: '0xA555d5344f6fb6c65DA19e403Cb4c1eC4a1a5Ee3'",
        'start_block: 34696259',
        'names:',
        '  "0x918def5d593f46735f74f9e2b280fe51af3a99ad": Bread Core',
        '---',
      ].join('\n'),
    );
    expect(c.channelJid).toBe('dc:111');
    expect(c.distributor).toBe('0xee95a62b749d8a2520e0128d9b3aca241269024b');
    expect(c.breadToken).toBe('0xa555d5344f6fb6c65da19e403cb4c1ec4a1a5ee3');
    expect(c.startBlock).toBe(34696259);
    expect(c.decimals).toBe(18);
    expect(c.names['0x918def5d593f46735f74f9e2b280fe51af3a99ad']).toBe('Bread Core');
    // enrichment defaults
    expect(c.usdPerBread).toBe(1);
    expect(c.explorerTxBase).toBe('https://gnosisscan.io/tx/');
  });

  it('honours overridden usd_per_bread and explorer_tx_base', () => {
    const c = parseConfig(
      [
        '---',
        'channel_jid: dc:1',
        "distributor: '0xee95a62b749d8a2520e0128d9b3aca241269024b'",
        "bread_token: '0xa555d5344f6fb6c65da19e403cb4c1ec4a1a5ee3'",
        'usd_per_bread: 1.02',
        'explorer_tx_base: https://blockscout.com/tx/',
        '---',
      ].join('\n'),
    );
    expect(c.usdPerBread).toBe(1.02);
    expect(c.explorerTxBase).toBe('https://blockscout.com/tx/');
  });
});

describe('formatCycleDate', () => {
  it('formats a unix-seconds timestamp as a UTC date', () => {
    const ts = Math.floor(Date.UTC(2026, 5, 10, 16, 0, 0) / 1000); // Wed, 10 Jun 2026
    expect(formatCycleDate(ts)).toBe('Wed, 10 Jun 2026');
  });
  it('returns empty string for a missing timestamp', () => {
    expect(formatCycleDate(0)).toBe('');
  });
});

describe('addrFromTopic', () => {
  it('extracts the low 20 bytes of a padded topic', () => {
    expect(addrFromTopic(pad32('0x918dEf5d593F46735f74F9E2B280Fe51AF3A99ad'))).toBe(
      '0x918def5d593f46735f74f9e2b280fe51af3a99ad',
    );
  });
});

describe('formatUnits', () => {
  it('formats 18-decimal values', () => {
    expect(formatUnits(10n ** 18n, 18)).toBe(1);
    expect(formatUnits(1500n * 10n ** 15n, 18)).toBe(1.5);
    expect(formatUnits(0n, 18)).toBe(0);
  });
});

describe('aggregateCycle', () => {
  const names = { '0x918def5d593f46735f74f9e2b280fe51af3a99ad': 'Bread Core' };
  const log = (to, value) => ({
    topics: [null, null, pad32(to)],
    data: u256(value),
  });

  it('sums per recipient, sorts desc, labels, drops zeros', () => {
    const rows = aggregateCycle(
      [
        log('0x918dEf5d593F46735f74F9E2B280Fe51AF3A99ad', 5n * 10n ** 18n),
        log('0x1111111111111111111111111111111111111111', 9n * 10n ** 18n),
        log('0x918dEf5d593F46735f74F9E2B280Fe51AF3A99ad', 1n * 10n ** 18n),
        log('0x2222222222222222222222222222222222222222', 0n),
      ],
      names,
    );
    // Bread Core total 6, other 9 → other first.
    expect(rows.map((r) => r.label)).toEqual([
      '0x1111111111111111111111111111111111111111',
      'Bread Core',
    ]);
    expect(rows[1].value).toBe(6n * 10n ** 18n);
    // zero-value recipient dropped
    expect(rows.find((r) => r.addr.startsWith('0x2222'))).toBeUndefined();
  });
});

describe('renderSankey', () => {
  const rows = [
    { addr: '0xa', label: 'Bread Core', value: 6n * 10n ** 18n },
    { addr: '0xb', label: 'Symbiota', value: 4n * 10n ** 18n },
  ];

  it('emits the sankey, cycle index, total BREAD, and a falls-back to block', () => {
    const out = renderSankey({ rows, decimals: 18, blockNumber: 46393177, cycleIndex: 23 });
    expect(out).toContain('```mermaid\nsankey-beta');
    expect(out).toContain('Yield Distributor,Bread Core,6');
    expect(out).toContain('Yield Distributor,Symbiota,4');
    expect(out).toContain('#23');
    expect(out).toContain('10 BREAD'); // 6 + 4
    expect(out).toContain('block 46393177'); // no txHash → block fallback
  });

  it('enriches with date, USD, tx link, and per-project % breakdown', () => {
    const ts = Math.floor(Date.UTC(2026, 5, 10, 16, 0, 0) / 1000);
    const out = renderSankey({
      rows, decimals: 18, blockNumber: 46393177, cycleIndex: 23,
      timestampSec: ts, txHash: '0xabc123', usdPerBread: 1.02,
      explorerTxBase: 'https://gnosisscan.io/tx/',
    });
    expect(out).toContain('Wed, 10 Jun 2026');              // human date
    expect(out).toContain('~$10.20');                       // 10 BREAD * 1.02
    expect(out).toContain('[tx](https://gnosisscan.io/tx/0xabc123)'); // explorer link
    expect(out).toContain('• Bread Core — 6 BREAD (60%)');  // per-project %
    expect(out).toContain('• Symbiota — 4 BREAD (40%)');
    expect(out).not.toContain('block 46393177');            // tx link replaces block
  });
});
