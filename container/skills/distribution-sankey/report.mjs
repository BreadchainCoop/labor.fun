#!/usr/bin/env node
// report.mjs — on-demand Bread yield-distribution report (Mermaid Sankey + table).
//
// Usage:
//   node report.mjs                 # latest cycle (default)
//   node report.mjs latest
//   node report.mjs all             # cumulative all-time totals per project
//   node report.mjs month 2026-06   # aggregate all cycles in that UTC month
//
// Derives everything from chain events — no subgraph: reads YieldDistributed
// cycles on the YieldDistributor and the BREAD ERC-20 Transfers emitted FROM it
// (authoritative recipient + amount). Plain `fetch` JSON-RPC, no dependencies.
// Recipient names come from the KB config (if present) layered over built-ins.

import { readFileSync } from 'node:fs';

const YIELD_DISTRIBUTED_TOPIC =
  '0x55e2b5d29dcbc85ecdd3693bcf2d9822f9ca49d32c11c9c64e2a3f707bff23d7';
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const CFG = {
  distributor: '0xee95a62b749d8a2520e0128d9b3aca241269024b',
  breadToken: '0xa555d5344f6fb6c65da19e403cb4c1ec4a1a5ee3',
  startBlock: 34696259,
  decimals: 18,
  usdPerBread: 1, // BREAD is 1:1 with DAI
  explorerTxBase: 'https://gnosisscan.io/tx/',
  rpcs: ['https://rpc.gnosischain.com', 'https://rpc.gnosis.gateway.fm', 'https://gnosis.drpc.org'],
  names: {
    '0x7e1367998e1fe8fab8f0bbf41e97cd6e0c891b64': 'Labor DAO',
    '0x5405e2d4d12aadb57579e780458c9a1151b560f1': 'Symbiota',
    '0x5c22b3f03b3d8fff56c9b2e90151512cb3f3de0f': 'Crypto Commons Assoc.',
    '0xa232f16ab37c9a646f91ba901e92ed1ba4b7b544': 'Citizen Wallet',
    '0x918def5d593f46735f74f9e2b280fe51af3a99ad': 'Bread Core',
    '0x6a148b997e6651237f2fcfc9e30330a6480519f0': 'Bread Treasury',
    '0x68060388c7d97b4bf779a2ead46c86e5588f073f': 'ReFi DAO',
    '0x1bd2212c9aa332d22d61a0be6bcc55b2a1de6c63': 'Gardens',
    '0xfcb81c1b0e0d4fea01e5a0fbf0aebb91e78a67e1': 'Regen Coordination',
    '0xb3da7e85be62460c867e059d42c434e2a53f5498': 'Traditional Dream Factory (TDF)',
  },
};

// Layer name overrides from the KB config (simple, dependency-free parse).
for (const p of ['/workspace/shared-kb/distribution-sankey/config.md']) {
  try {
    const txt = readFileSync(p, 'utf8');
    const re = /'(0x[0-9a-fA-F]{40})'\s*:\s*(.+)/g;
    let m;
    while ((m = re.exec(txt))) CFG.names[m[1].toLowerCase()] = m[2].trim();
  } catch {
    /* no KB config — built-ins are fine */
  }
}

const hexToBigInt = (h) => (h && h !== '0x' ? BigInt(h) : 0n);
const addrFromTopic = (t) => '0x' + String(t).slice(-40).toLowerCase();
const toHex = (n) => '0x' + Number(n).toString(16);
const round = (n) => Math.round(n * 100) / 100;
const usd = (n) => `$${round(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function formatUnits(value, decimals) {
  const s = value.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return Number(whole + (frac ? '.' + frac : ''));
}
function fmtDate(tsSec) {
  if (!tsSec) return '';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(tsSec * 1000));
}

async function rpc(method, params) {
  let lastErr;
  for (const url of CFG.rpcs) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
      return json.result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('all RPCs failed');
}

async function getLogsChunked(filter, fromBlock, toBlock) {
  const out = [];
  let span = 1_000_000;
  let from = fromBlock;
  while (from <= toBlock) {
    const to = Math.min(from + span - 1, toBlock);
    try {
      out.push(...(await rpc('eth_getLogs', [{ ...filter, fromBlock: toHex(from), toBlock: toHex(to) }])));
      from = to + 1;
    } catch (e) {
      if (span > 25_000) { span = Math.floor(span / 2); continue; }
      throw e;
    }
  }
  return out;
}

const blockOf = (log) => Number(BigInt(log.blockNumber));

/** Sum BREAD transfers from the distributor across the given cycle blocks. */
async function tallyBlocks(blocks) {
  const fromTopic = '0x' + CFG.distributor.replace(/^0x/, '').padStart(64, '0');
  const per = new Map();
  let total = 0n;
  for (const block of blocks) {
    const transfers = await getLogsChunked(
      { address: CFG.breadToken, topics: [TRANSFER_TOPIC, fromTopic] }, block, block,
    );
    for (const log of transfers) {
      const to = addrFromTopic(log.topics[2]);
      const v = hexToBigInt(log.data);
      per.set(to, (per.get(to) ?? 0n) + v);
      total += v;
    }
  }
  const rows = [...per.entries()]
    .filter(([, v]) => v > 0n)
    .sort((a, b) => (b[1] > a[1] ? 1 : -1))
    .map(([addr, v]) => ({ addr, label: CFG.names[addr] || addr, value: v }));
  return { rows, total };
}

function render(title, { rows, total }, extra = '') {
  const totalBread = formatUnits(total, CFG.decimals);
  let body = '```mermaid\nsankey-beta\n';
  for (const r of rows) body += `Yield Distributor,${r.label},${round(formatUnits(r.value, CFG.decimals))}\n`;
  body += '```';
  const breakdown = rows
    .map((r) => {
      const b = formatUnits(r.value, CFG.decimals);
      const pct = totalBread > 0 ? round((b / totalBread) * 100) : 0;
      return `• ${r.label} — ${round(b).toLocaleString()} BREAD (${pct}%)`;
    })
    .join('\n');
  const head = `🍞 ${title} — ${round(totalBread).toLocaleString()} BREAD (~${usd(totalBread * CFG.usdPerBread)}) to ${rows.length} projects`;
  return `${head}${extra ? '\n' + extra : ''}\n\n${body}\n\n${breakdown}`;
}

async function main() {
  const mode = (process.argv[2] || 'latest').toLowerCase();
  const latest = Number(BigInt(await rpc('eth_blockNumber', [])));
  const cycleLogs = await getLogsChunked(
    { address: CFG.distributor, topics: [YIELD_DISTRIBUTED_TOPIC] }, CFG.startBlock, latest,
  );
  if (cycleLogs.length === 0) { console.log('No distribution cycles found.'); return; }
  const blocks = [...new Set(cycleLogs.map(blockOf))].sort((a, b) => a - b);

  if (mode === 'latest') {
    const block = blocks[blocks.length - 1];
    const tx = cycleLogs.find((l) => blockOf(l) === block)?.transactionHash;
    let tsSec = 0;
    try { tsSec = Number(BigInt((await rpc('eth_getBlockByNumber', [toHex(block), false])).timestamp)); } catch { /* optional */ }
    const data = await tallyBlocks([block]);
    const link = tx ? ` · [tx](${CFG.explorerTxBase}${tx})` : ` · block ${block}`;
    console.log(render(`Latest distribution${tsSec ? ' — ' + fmtDate(tsSec) : ''}`, data, `Cycle ${blocks.length}${link}`));
    return;
  }

  if (mode === 'all') {
    const data = await tallyBlocks(blocks);
    console.log(render(`All-time distribution (${blocks.length} cycles)`, data));
    return;
  }

  if (mode === 'month') {
    const ym = process.argv[3];
    if (!/^\d{4}-\d{2}$/.test(ym || '')) { console.error('Usage: node report.mjs month YYYY-MM'); process.exit(1); }
    // Filter cycle blocks by timestamp month (UTC).
    const inMonth = [];
    for (const block of blocks) {
      let ts = 0;
      try { ts = Number(BigInt((await rpc('eth_getBlockByNumber', [toHex(block), false])).timestamp)); } catch { /* skip */ }
      if (!ts) continue;
      const d = new Date(ts * 1000);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      if (key === ym) inMonth.push(block);
    }
    if (inMonth.length === 0) { console.log(`No distribution cycles in ${ym}.`); return; }
    const data = await tallyBlocks(inMonth);
    console.log(render(`Distribution — ${ym} (${inMonth.length} cycle${inMonth.length > 1 ? 's' : ''})`, data));
    return;
  }

  console.error(`Unknown mode "${mode}". Use: latest | all | month YYYY-MM`);
  process.exit(1);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
