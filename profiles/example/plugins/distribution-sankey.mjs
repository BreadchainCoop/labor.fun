// distribution-sankey.mjs — per-cycle yield-distribution reporter, as a profile
// plugin. After each new on-chain distribution it posts a Mermaid Sankey of
// THAT cycle (not cumulative) to a channel.
//
// How it derives a cycle, straight from events (no subgraph dependency):
//   * polls the chain for new `YieldDistributed` logs on the YieldDistributor
//   * for each new cycle block, reads the BREAD ERC-20 `Transfer` logs emitted
//     FROM the distributor in that block — authoritative recipient + amount,
//     no positional project-array guessing (which is exactly what keeps
//     breaking the subgraph)
//   * renders `sankey-beta`: `Yield Distributor, <recipient>, <BREAD>`
//
// Uses plain `fetch` + minimal hex decoding so it adds NO new dependency
// (Node 18+ global fetch; the app runs Node 22). Config + state live in the KB
// (`groups/<sharedKb>/context/distribution-sankey/config.md`); the flow is a
// no-op until that file exists. Mirrors sd-kickoff.mjs / weekly-agenda.mjs:
// nothing imported from the framework, all I/O via the KB + IPC contracts.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import matter from 'gray-matter';

// keccak256 of the event signatures (hardcoded so we need no keccak lib).
const YIELD_DISTRIBUTED_TOPIC =
  '0x55e2b5d29dcbc85ecdd3693bcf2d9822f9ca49d32c11c9c64e2a3f707bff23d7';
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const DEFAULT_RPCS = [
  'https://rpc.gnosischain.com',
  'https://rpc.gnosis.gateway.fm',
  'https://gnosis.drpc.org',
];

/** Parse context/distribution-sankey/config.md (frontmatter-driven). */
export function parseConfig(mdText) {
  const fm = matter(mdText).data ?? {};
  const names = {};
  if (fm.names && typeof fm.names === 'object' && !Array.isArray(fm.names)) {
    for (const [addr, name] of Object.entries(fm.names)) {
      if (typeof name === 'string' && name.trim()) names[String(addr).toLowerCase()] = String(name);
    }
  }
  return {
    channelJid: typeof fm.channel_jid === 'string' ? fm.channel_jid : '',
    distributor: typeof fm.distributor === 'string' ? fm.distributor.toLowerCase() : '',
    breadToken: typeof fm.bread_token === 'string' ? fm.bread_token.toLowerCase() : '',
    startBlock: Number(fm.start_block) || 0,
    decimals: Number.isInteger(fm.decimals) ? fm.decimals : 18,
    rpcs: Array.isArray(fm.rpcs) && fm.rpcs.length ? fm.rpcs.map(String) : DEFAULT_RPCS,
    names,
  };
}

const hexToBigInt = (h) => (h && h !== '0x' ? BigInt(h) : 0n);
/** Topic is 32 bytes; an address is the low 20 bytes. */
export function addrFromTopic(topic) {
  return '0x' + String(topic).slice(-40).toLowerCase();
}

/** Format an integer amount of `decimals`-decimal token to a Number. */
export function formatUnits(value, decimals) {
  const neg = value < 0n;
  let s = (neg ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return Number((neg ? '-' : '') + whole + (frac ? '.' + frac : ''));
}

const round = (n) => Math.round(n * 100) / 100;

/**
 * Aggregate one cycle's Transfer logs (already filtered to from=distributor at
 * the cycle block) into recipient → amount. Pure. `names` maps lc-address →
 * label. Returns rows sorted desc with a display label + raw bigint.
 */
export function aggregateCycle(transferLogs, names) {
  const per = new Map();
  for (const log of transferLogs) {
    const to = addrFromTopic(log.topics[2]);
    const value = hexToBigInt(log.data);
    per.set(to, (per.get(to) ?? 0n) + value);
  }
  return [...per.entries()]
    .filter(([, v]) => v > 0n)
    .sort((a, b) => (b[1] > a[1] ? 1 : -1))
    .map(([addr, v]) => ({ addr, label: names[addr] || addr, value: v }));
}

/** Render a per-cycle Mermaid Sankey + a one-line caption. Pure. */
export function renderSankey({ rows, decimals, blockNumber, cycleIndex }) {
  const total = rows.reduce((a, r) => a + r.value, 0n);
  let body = '```mermaid\nsankey-beta\n';
  for (const r of rows) body += `Yield Distributor,${r.label},${round(formatUnits(r.value, decimals))}\n`;
  body += '```';
  const idx = cycleIndex != null ? ` #${cycleIndex}` : '';
  const caption =
    `🍞 Bread yield distribution${idx} — ${round(formatUnits(total, decimals)).toLocaleString()} BREAD ` +
    `to ${rows.length} projects (block ${blockNumber}).`;
  return `${caption}\n\n${body}`;
}

// ---- RPC (plain fetch JSON-RPC; tries each endpoint until one answers) ----

async function rpc(rpcs, method, params) {
  let lastErr;
  for (const url of rpcs) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message || 'rpc error');
      return json.result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('all RPCs failed');
}

const toHex = (n) => '0x' + Number(n).toString(16);

async function getLogs(rpcs, { address, topics, fromBlock, toBlock }) {
  return rpc(rpcs, 'eth_getLogs', [
    { address, topics, fromBlock: toHex(fromBlock), toBlock: toHex(toBlock) },
  ]);
}

function atomicWrite(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function writeIpcFile(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  const name = `ds-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const tmp = path.join(dir, `${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, path.join(dir, name));
}

/**
 * One poll: find new YieldDistributed cycles since the last reported block and
 * post a per-cycle Sankey for each. Network I/O lives here; the decode/render
 * helpers above are pure and unit-tested. Returns the posts it emitted.
 */
export async function poll({ profileDir, logger, nowMs = Date.now() }) {
  let sharedKb = 'slack_main';
  try {
    const pc = JSON.parse(fs.readFileSync(path.join(profileDir, 'profile.config.json'), 'utf-8'));
    if (typeof pc.sharedKbGroup === 'string' && pc.sharedKbGroup) sharedKb = pc.sharedKbGroup;
  } catch {
    /* default */
  }

  const ctxDir = path.join(profileDir, 'groups', sharedKb, 'context', 'distribution-sankey');
  const configPath = path.join(ctxDir, 'config.md');
  if (!fs.existsSync(configPath)) return null; // not configured → no-op

  const cfg = parseConfig(fs.readFileSync(configPath, 'utf-8'));
  if (!cfg.channelJid || !cfg.distributor || !cfg.breadToken) {
    logger.warn({ configPath }, 'distribution-sankey: config needs channel_jid, distributor, bread_token');
    return null;
  }

  const statePath = path.join(ctxDir, 'state.json');
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch {
    /* fresh */
  }

  const latestHex = await rpc(cfg.rpcs, 'eth_blockNumber', []);
  const latest = Number(BigInt(latestHex));

  // First run: anchor to the chain head and don't backfill history (avoids a
  // wall of past cycles). Report only cycles that land after we start watching.
  if (!state.lastBlock) {
    atomicWrite(statePath, JSON.stringify({ lastBlock: latest, cycleIndex: state.cycleIndex ?? 0 }, null, 2));
    logger.info({ latest }, 'distribution-sankey: anchored to chain head (no backfill)');
    return { posts: [] };
  }

  const from = Math.max(state.lastBlock + 1, cfg.startBlock || 0);
  if (from > latest) return { posts: [] };

  const cycleLogs = await getLogs(cfg.rpcs, {
    address: cfg.distributor,
    topics: [YIELD_DISTRIBUTED_TOPIC],
    fromBlock: from,
    toBlock: latest,
  });

  const posts = [];
  let cycleIndex = state.cycleIndex ?? 0;
  const fromTopic = '0x' + cfg.distributor.replace(/^0x/, '').padStart(64, '0');
  // Oldest first so reports are chronological.
  const blocks = [...new Set(cycleLogs.map((l) => Number(BigInt(l.blockNumber))))].sort((a, b) => a - b);
  for (const block of blocks) {
    const transfers = await getLogs(cfg.rpcs, {
      address: cfg.breadToken,
      topics: [TRANSFER_TOPIC, fromTopic],
      fromBlock: block,
      toBlock: block,
    });
    const rows = aggregateCycle(transfers, cfg.names);
    if (rows.length === 0) continue;
    cycleIndex += 1;
    posts.push(renderSankey({ rows, decimals: cfg.decimals, blockNumber: block, cycleIndex }));
  }

  const ipcDir = path.join(profileDir, 'data', 'ipc', sharedKb, 'messages');
  for (const text of posts) {
    writeIpcFile(ipcDir, { type: 'message', chatJid: cfg.channelJid, text, timestamp: new Date(nowMs).toISOString() });
  }

  atomicWrite(statePath, JSON.stringify({ lastBlock: latest, cycleIndex }, null, 2));
  if (posts.length) logger.info({ posts: posts.length, latest }, 'distribution-sankey: cycles reported');
  return { posts };
}

export default function register({ registerIntegration, logger }) {
  let timer = null;
  registerIntegration({
    name: 'distribution-sankey',
    start: () => {
      const profileDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
      const tickMs = Number(process.env.DISTRIBUTION_SANKEY_TICK_MS) || 6 * 3600_000;
      const run = () => {
        poll({ profileDir, logger }).catch((err) =>
          logger.error({ err }, 'distribution-sankey: poll failed'),
        );
      };
      const first = setTimeout(run, 90_000);
      first.unref?.();
      timer = setInterval(run, tickMs);
      timer.unref?.();
      logger.info({ tickMs }, 'distribution-sankey flow started');
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  });
}
