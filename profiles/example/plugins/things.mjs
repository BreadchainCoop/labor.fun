// things.mjs — house things (procurement), as a labor.fun profile plugin.
// Part of the house-governance suite (chores + hearts + things).
//
// Ports the MATH of Zaratan choreWheel's things app (src/core/things.js,
// AGPL-3.0, github.com/zaratanDotWorld/choreWheel — see plugins/README.md) onto
// the labor.fun plugin surface, following the exact patterns of chores.mjs:
// self-registering plugin, JSON state under the shared KB group, IPC messages
// for announcements, Slack Web API for poll posts, reaction-POLLING for
// approval votes. ZERO framework-core edits.
//
// Mechanism (choreWheel-derived):
//   * The house keeps a catalog of Things (name, type, unit price) and a
//     money account. Admins credit the account manually ("load"); buys
//     debit it.
//   * Regular buy: resident requests a catalog thing × quantity. 6h reaction
//     poll. minVotes = min(ceil(0.6 * residents), ceil(cost / $50)) — one
//     vote per $50, capped at 60% of the house. Scaled by the buyer's hearts
//     vote-scalar when the hearts ledger is present (fewer hearts = more
//     votes needed; upstream getHeartsVoteScalar).
//   * Special buy: off-catalog, title+details+price. 1-day poll. minVotes =
//     min(ceil(0.6 * residents), max(ceil(cost/$50), ceil(0.3 * residents))).
//   * valid = yays >= minVotes && yays > nays. Valid buys debit the account
//     and join the unfulfilled queue until someone marks them arrived.
//   * Catalog proposals (add/edit/delete a thing): 2-day poll, minVotes =
//     ceil(0.4 * residents). Admins may also edit the catalog file directly.
//
// Data (under <profile>/groups/<sharedKbGroup>/things/):
//   things/config.json     — residents[], chatJid, admins[], poll overrides
//   things/things.json     — catalog: [{name, type, value, unit, url, active}]
//   things/buys/*.json     — buy requests written by the agent
//   things/proposals/*.json— catalog proposals written by the agent
//   things/ledger.json     — plugin-owned: {txns: [...]} (loads + valid buys)
//   things/status.md       — plugin-rendered balance, catalog, queue
//
// DEFERRED: vote anonymization, per-account multi-fund support (v1 = single
// "general" account unless buys specify another), fulfillment statistics.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const TICK_MS = 60_000;

export const PARAMS = {
  pollLengthMs: 6 * HOUR_MS, // choreWheel things params.pollLength
  specialPollLengthMs: 1 * DAY_MS, // params.specialPollLength
  minVotesScalar: 50, // params.minVotesScalar (one vote per $50)
  minPctSpecial: 0.3, // params.minPctSpecial
  maxPct: 0.6, // params.maxPct
  proposalPollLengthMs: 2 * DAY_MS, // params.proposalPollLength
  proposalPct: 0.4, // params.proposalPct
  // hearts link (choreWheel hearts params):
  baselineAmount: 5,
  voteScalar: 0.2,
};

// ---------------------------------------------------------------------------
// Pure math (exported for tests)

/** upstream hearts.getHeartsVoteScalar. */
export function voteScalarFor(hearts) {
  const h = hearts === null || hearts === undefined ? PARAMS.baselineAmount : hearts;
  return 1 - (h - PARAMS.baselineAmount) * PARAMS.voteScalar;
}

/**
 * upstream getThingBuyMinVotes. isSpecial ⇔ upstream's "no thingId".
 * buyerHearts: number|null (null → baseline scalar of 1).
 */
export function buyMinVotes(residentCount, price, isSpecial, buyerHearts) {
  const maxVotes = Math.ceil(PARAMS.maxPct * residentCount);
  const minVotesSpecial = Math.ceil(PARAMS.minPctSpecial * residentCount);
  const minVotesScaled = Math.ceil(Math.abs(price) / PARAMS.minVotesScalar);
  const minVotes = isSpecial
    ? Math.min(maxVotes, Math.max(minVotesScaled, minVotesSpecial))
    : Math.min(maxVotes, minVotesScaled);
  return Math.ceil(minVotes * voteScalarFor(buyerHearts));
}

/** upstream getThingProposalMinVotes. */
export function proposalMinVotes(residentCount) {
  return Math.ceil(PARAMS.proposalPct * residentCount);
}

/** choreWheel isPollValid. */
export function pollValid(yays, nays, minVotes) {
  return yays >= minVotes && yays > nays;
}

/** upstream getAccountBalance: sum of valid txns for the account. */
export function accountBalance(ledger, account = 'general', asOfMs = Infinity) {
  return (ledger.txns || [])
    .filter((t) => (t.account || 'general') === account && t.valid !== false)
    .filter((t) => new Date(t.at).getTime() <= asOfMs)
    .reduce((s, t) => s + t.value, 0);
}

// ---------------------------------------------------------------------------
// Plumbing (matches chores.mjs)

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function writeIpcMessage(profileDir, groupFolder, chatJid, text) {
  const dir = path.join(profileDir, 'data', 'ipc', groupFolder, 'messages');
  fs.mkdirSync(dir, { recursive: true });
  const name = `things-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const tmp = path.join(dir, `${name}.tmp`);
  fs.writeFileSync(
    tmp,
    JSON.stringify({ type: 'message', chatJid, text, timestamp: new Date().toISOString() }, null, 2),
  );
  fs.renameSync(tmp, path.join(dir, name));
}

async function slackApi(token, method, payload) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`slack ${method}: ${body.error}`);
  return body;
}

const money = (n) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;

// ---------------------------------------------------------------------------
// One scheduler tick (exported, injectable for tests)

export async function tick({
  profileDir, logger, nowMs, slackToken, fetchReactions, postMessage,
}) {
  const cfgPath = path.join(profileDir, 'profile.config.json');
  const sharedKb = readJson(cfgPath, {}).sharedKbGroup || 'slack_main';
  const base = path.join(profileDir, 'groups', sharedKb, 'things');
  const config = readJson(path.join(base, 'config.json'), null);
  if (!config || !Array.isArray(config.residents) || !config.residents.length) {
    return null; // unconfigured → silent no-op
  }
  const residentCount = config.residents.length;
  const chatJid = config.chatJid || '';
  const channelId = chatJid.replace(/^slack:/, '');
  const things = readJson(path.join(base, 'things.json'), []);
  const ledgerPath = path.join(base, 'ledger.json');
  const ledger = readJson(ledgerPath, { txns: [] });
  ledger.txns = ledger.txns || [];
  let dirty = false;
  const announce = (text) => { if (chatJid) writeIpcMessage(profileDir, sharedKb, chatJid, text); };
  const post = postMessage ||
    (async (payload) => slackApi(slackToken, 'chat.postMessage', payload));

  // Hearts link (file-level, optional): buyer's hearts scale minVotes.
  const heartsLedger = readJson(
    path.join(profileDir, 'groups', sharedKb, 'hearts', 'ledger.json'), null,
  );
  const heartsOf = (name) => {
    if (!heartsLedger || !Array.isArray(heartsLedger.entries)) return null;
    const entries = heartsLedger.entries.filter((e) => e.resident === name);
    if (!entries.length) return null;
    return entries.reduce((s, e) => s + e.value, 0);
  };

  // 1. New buy requests → validate funds, post approval poll.
  const buysDir = path.join(base, 'buys');
  fs.mkdirSync(buysDir, { recursive: true });
  for (const f of fs.readdirSync(buysDir).filter((f) => f.endsWith('.json'))) {
    const buyPath = path.join(buysDir, f);
    const buy = readJson(buyPath, null);
    if (!buy || buy.status !== 'new') continue;
    const account = buy.account || 'general';
    const isSpecial = !!buy.special;
    let title;
    let totalCost;
    if (isSpecial) {
      title = buy.title || 'special buy';
      totalCost = Number(buy.price) || 0;
    } else {
      const thing = things.find((t) => t.name === buy.thing && t.active !== false);
      if (!thing) {
        buy.status = 'rejected';
        buy.reason = 'unknown thing';
        atomicWrite(buyPath, JSON.stringify(buy, null, 2));
        continue;
      }
      const quantity = Math.max(1, Number(buy.quantity) || 1);
      buy.quantity = quantity;
      title = `${thing.name}${quantity > 1 ? ` × ${quantity}` : ''}`;
      totalCost = (Number(thing.value) || 0) * quantity;
    }
    const balance = accountBalance(ledger, account, nowMs);
    if (balance < totalCost) {
      buy.status = 'rejected';
      buy.reason = `insufficient funds (${money(balance)} < ${money(totalCost)})`;
      atomicWrite(buyPath, JSON.stringify(buy, null, 2));
      announce(`❌ Buy rejected: *${title}* — ${buy.reason}.`);
      continue;
    }
    const windowMs = isSpecial
      ? Number(config.specialPollMs) || PARAMS.specialPollLengthMs
      : Number(config.buyPollMs) || PARAMS.pollLengthMs;
    buy.cost = Math.round(totalCost * 100) / 100;
    buy.minVotes = buyMinVotes(residentCount, totalCost, isSpecial, heartsOf(buy.buyer));
    buy.expiresAt = nowMs + windowMs;
    if (!slackToken && !postMessage) {
      logger.warn('[things] buy pending — Slack not configured yet');
      continue;
    }
    try {
      const postRes = await post({
        channel: channelId,
        text:
          `*${isSpecial ? 'Special buy' : 'Buy'} request:* ${buy.buyer} wants ` +
          `*${title}* for ${money(totalCost)}` +
          (isSpecial && buy.details ? ` — ${buy.details}` : '') + `. ` +
          `React 👍 to approve or 👎 to reject — needs ${buy.minVotes} 👍 within ` +
          `${Math.round(windowMs / HOUR_MS)}h. ` +
          `House balance: ${money(balance)}.`,
      });
      buy.status = 'polling';
      buy.pollTs = postRes.ts;
      buy.pollChannel = channelId;
      atomicWrite(buyPath, JSON.stringify(buy, null, 2));
    } catch (err) {
      logger.warn({ err: String(err) }, '[things] failed to post buy poll');
    }
  }

  // 2. Resolve expired buy polls.
  for (const f of fs.readdirSync(buysDir).filter((f) => f.endsWith('.json'))) {
    const buyPath = path.join(buysDir, f);
    const buy = readJson(buyPath, null);
    if (!buy || buy.status !== 'polling') continue;
    if (nowMs < buy.expiresAt) continue;
    let yays = 0;
    let nays = 0;
    try {
      const getReactions =
        fetchReactions ||
        (async () => {
          const r = await slackApi(slackToken, 'reactions.get', {
            channel: buy.pollChannel,
            timestamp: buy.pollTs,
            full: true,
          });
          return r.message?.reactions || [];
        });
      const reactions = await getReactions(buy);
      const countFor = (rnames) =>
        reactions
          .filter((r) => rnames.includes(r.name))
          .flatMap((r) => r.users || []).length;
      yays = countFor(['thumbsup', '+1']);
      nays = countFor(['thumbsdown', '-1']);
    } catch (err) {
      logger.warn({ err: String(err) }, '[things] reactions.get failed; retrying next tick');
      continue;
    }
    const valid = pollValid(yays, nays, buy.minVotes);
    const title = buy.special
      ? buy.title || 'special buy'
      : `${buy.thing}${buy.quantity > 1 ? ` × ${buy.quantity}` : ''}`;
    buy.status = valid ? 'approved' : 'rejected';
    buy.yays = yays;
    buy.nays = nays;
    buy.resolvedAt = nowMs;
    if (valid) {
      buy.fulfilled = false;
      ledger.txns.push({
        type: 'buy',
        buyId: f,
        buyer: buy.buyer,
        account: buy.account || 'general',
        title,
        value: -buy.cost,
        at: new Date(nowMs).toISOString(),
      });
      dirty = true;
    }
    atomicWrite(buyPath, JSON.stringify(buy, null, 2));
    announce(
      valid
        ? `✅ Buy approved (${yays}👍/${nays}👎): *${title}* for ${money(buy.cost)} by ${buy.buyer}. ` +
          `New balance: ${money(accountBalance(ledger, buy.account || 'general', nowMs))}. ` +
          `It's in the to-buy queue — whoever picks it up, tell the assistant to mark it fulfilled.`
        : `❌ Buy rejected (${yays}👍/${nays}👎, needed ${buy.minVotes}👍): *${title}*. No funds spent.`,
    );
  }

  // 3. Catalog proposals (add/edit/delete) → 2-day poll → apply to things.json.
  const proposalsDir = path.join(base, 'proposals');
  fs.mkdirSync(proposalsDir, { recursive: true });
  for (const f of fs.readdirSync(proposalsDir).filter((f) => f.endsWith('.json'))) {
    const pPath = path.join(proposalsDir, f);
    const p = readJson(pPath, null);
    if (!p) continue;
    if (p.status === 'new') {
      if (!p.thing || !p.thing.name) {
        p.status = 'rejected';
        p.reason = 'proposal must include thing.name';
        atomicWrite(pPath, JSON.stringify(p, null, 2));
        continue;
      }
      p.minVotes = proposalMinVotes(residentCount);
      p.expiresAt = nowMs + (Number(config.proposalPollMs) || PARAMS.proposalPollLengthMs);
      if (!slackToken && !postMessage) {
        logger.warn('[things] proposal pending — Slack not configured yet');
        continue;
      }
      try {
        const action = p.thing.active === false ? 'REMOVE' : (p.edit ? 'EDIT' : 'ADD');
        const postRes = await post({
          channel: channelId,
          text:
            `*Catalog proposal:* ${p.proposedBy} wants to ${action} ` +
            `*${p.thing.name}*${p.thing.value ? ` at ${money(Number(p.thing.value))}` : ''}` +
            `${p.thing.type ? ` (${p.thing.type})` : ''}. ` +
            `React 👍 to approve or 👎 to reject — needs ${p.minVotes} 👍 within ` +
            `${Math.round((Number(config.proposalPollMs) || PARAMS.proposalPollLengthMs) / HOUR_MS)}h.`,
        });
        p.status = 'polling';
        p.pollTs = postRes.ts;
        p.pollChannel = channelId;
        atomicWrite(pPath, JSON.stringify(p, null, 2));
      } catch (err) {
        logger.warn({ err: String(err) }, '[things] failed to post proposal poll');
      }
      continue;
    }
    if (p.status !== 'polling' || nowMs < p.expiresAt) continue;
    let yays = 0;
    let nays = 0;
    try {
      const getReactions =
        fetchReactions ||
        (async () => {
          const r = await slackApi(slackToken, 'reactions.get', {
            channel: p.pollChannel,
            timestamp: p.pollTs,
            full: true,
          });
          return r.message?.reactions || [];
        });
      const reactions = await getReactions(p);
      const countFor = (rnames) =>
        reactions
          .filter((r) => rnames.includes(r.name))
          .flatMap((r) => r.users || []).length;
      yays = countFor(['thumbsup', '+1']);
      nays = countFor(['thumbsdown', '-1']);
    } catch (err) {
      logger.warn({ err: String(err) }, '[things] reactions.get failed; retrying next tick');
      continue;
    }
    const valid = pollValid(yays, nays, p.minVotes);
    p.status = valid ? 'approved' : 'rejected';
    p.yays = yays;
    p.nays = nays;
    p.resolvedAt = nowMs;
    if (valid) {
      const idx = things.findIndex((t) => t.name === p.thing.name);
      if (idx >= 0) things[idx] = { ...things[idx], ...p.thing };
      else things.push({ active: true, ...p.thing });
      atomicWrite(path.join(base, 'things.json'), JSON.stringify(things, null, 2));
    }
    atomicWrite(pPath, JSON.stringify(p, null, 2));
    announce(
      valid
        ? `✅ Catalog updated (${yays}👍/${nays}👎): *${p.thing.name}*.`
        : `❌ Catalog proposal rejected (${yays}👍/${nays}👎, needed ${p.minVotes}👍): *${p.thing.name}*.`,
    );
  }

  if (dirty) atomicWrite(ledgerPath, JSON.stringify(ledger, null, 2));

  // 4. Render status.md.
  const accounts = [...new Set(ledger.txns.map((t) => t.account || 'general'))];
  if (!accounts.length) accounts.push('general');
  const lines = [
    `# Things status (auto-generated ${new Date(nowMs).toISOString()})`,
    '',
    '## Balances',
    '',
  ];
  for (const a of accounts.sort()) {
    lines.push(`- ${a}: ${money(accountBalance(ledger, a, nowMs))}`);
  }
  lines.push('', '## Catalog', '');
  for (const t of things.filter((t) => t.active !== false)) {
    lines.push(`- **${t.name}**${t.type ? ` (${t.type})` : ''} — ${money(Number(t.value) || 0)}${t.unit ? ` per ${t.unit}` : ''}${t.url ? ` — ${t.url}` : ''}`);
  }
  lines.push('', '## To-buy queue (approved, unfulfilled)', '');
  for (const f of fs.readdirSync(buysDir).filter((f) => f.endsWith('.json'))) {
    const b = readJson(path.join(buysDir, f), null);
    if (!b || b.status !== 'approved' || b.fulfilled) continue;
    const title = b.special ? b.title : `${b.thing}${b.quantity > 1 ? ` × ${b.quantity}` : ''}`;
    lines.push(`- ${title} — ${money(b.cost)} (approved ${new Date(b.resolvedAt).toISOString().slice(0, 10)}, requested by ${b.buyer}) — file: buys/${f}`);
  }
  atomicWrite(path.join(base, 'status.md'), lines.join('\n') + '\n');
  return { things: things.length, residents: residentCount };
}

// ---------------------------------------------------------------------------
// Registration

export default function register({ registerIntegration, readEnvFile, logger }) {
  const profileDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '..',
  );
  let timer;
  registerIntegration({
    name: 'things',
    start: () => {
      logger.info('[things] things started');
      const run = () => {
        const slackToken =
          process.env.SLACK_BOT_TOKEN || readEnvFile(['SLACK_BOT_TOKEN']).SLACK_BOT_TOKEN;
        tick({ profileDir, logger, nowMs: Date.now(), slackToken }).catch(
          (err) => logger.warn({ err: String(err) }, '[things] tick failed'),
        );
      };
      run();
      timer = setInterval(run, TICK_MS);
    },
    stop: () => clearInterval(timer),
  });
}
