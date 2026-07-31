// hearts.mjs — house hearts (accountability), as a labor.fun profile plugin.
// Part of the house-governance suite (chores + hearts + things).
//
// Ports the MATH of Zaratan choreWheel's hearts app (src/core/hearts.js,
// AGPL-3.0, github.com/zaratanDotWorld/choreWheel — see plugins/README.md) onto
// the labor.fun plugin surface, following the exact patterns of chores.mjs:
// self-registering plugin, JSON state under the shared KB group, IPC messages
// for announcements, Slack Web API for poll posts, and reaction-POLLING as the
// peer-verification mechanism (the framework doesn't surface reaction events).
// ZERO framework-core edits.
//
// Mechanism (choreWheel-derived):
//   * Every resident carries a heart count. Baseline 5, max 10. Initialised
//     at 5 (HEART_REGEN "init" entry).
//   * Monthly regen: at each month start, hearts drift toward baseline —
//     +0.5 up toward 5 if below, -0.5 down toward 5 if above (fade). Exact
//     upstream math in getRegenAmount.
//   * Karma: residents give karma with "<@user> ++" in chat. The agent
//     records each karma grant as a file. Shortly after month start
//     (karmaDelay 3h), the top karma earners of the PREVIOUS month get +1
//     heart (capped at max). numWinners = min(floor(residents/3),
//     uniqueReceivers). Rankings weight each giver's influence by their own
//     hearts divided by how much karma they issued (upstream
//     getKarmaRankings).
//   * Challenges: a resident may challenge another over a conflict; the
//     house votes (3-day reaction poll). minVotes = 40% of residents,
//     or 70% when the challengee would drop to <= 2 hearts (critical).
//     valid = yays >= minVotes && yays > nays. Loser (challengee if valid,
//     challenger if not) loses the challenged hearts.
//   * Chore-hearts link: choreWheel docks hearts for missed chore budgets.
//     At month start + 30h (penaltyDelay), each resident's PREVIOUS month
//     chore points (read from the chores plugin's ledger.json — file-level
//     integration, no core hooks) are compared to the 100-point obligation:
//     deficiency <= 0 → +0.5 bonus heart; else -0.25 heart per full 5 points
//     short. (Upstream calculatePenalty; v1 assumes full-month obligation, no
//     breaks/working-percentage.)
//
// Data (under <profile>/groups/<sharedKbGroup>/hearts/):
//   hearts/config.json      — residents[], chatJid, challengePollHours
//   hearts/ledger.json      — plugin-owned: {entries:[{resident,type,value,at,key}]}
//   hearts/karma/*.json     — karma grants written by the agent
//   hearts/challenges/*.json— challenges written by the agent
//   hearts/status.md        — plugin-rendered balances + recent events
//
// DEFERRED (documented for the receipt): resident retirement/deactivation at
// 0 hearts (announce-only in v1), revives, vote anonymization, chore
// breaks/working-percentage proration, per-resident custom obligations.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const TICK_MS = 60_000;

export const PARAMS = {
  baselineAmount: 5, // choreWheel hearts params.baselineAmount
  max: 10, // params.max
  regenAmount: 0.5, // params.regenAmount
  fadeAmount: 0.5, // params.fadeAmount
  minPctInitial: 0.4, // params.minPctInitial
  minPctCritical: 0.7, // params.minPctCritical
  criticalNum: 2, // params.criticalNum
  pollLengthMs: 3 * DAY_MS, // params.pollLength
  karmaDelayMs: 3 * HOUR_MS, // params.karmaDelay
  karmaProportion: 3, // params.karmaProportion
  voteScalar: 0.2, // params.voteScalar
  // chore-penalty link (choreWheel chores params):
  penaltyDelayMs: DAY_MS + 6 * HOUR_MS, // chores params.penaltyDelay
  penaltyIncrement: 5, // chores params.penaltyIncrement
  penaltyUnit: 0.25, // chores params.penaltyUnit
  heartBonus: 0.5, // chores params.heartBonus
  pointsPerResident: 100, // chores params.pointsPerResident
};

// Heart entry types (mirrors upstream constants)
export const HEART_REGEN = 1;
export const HEART_CHALLENGE = 2;
export const HEART_KARMA = 3;
export const HEART_CHORE = 4;

// ---------------------------------------------------------------------------
// Pure math (exported for tests)

export function monthWindow(nowMs) {
  const d = new Date(nowMs);
  const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  return { start, end, key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` };
}

export function prevMonthWindow(nowMs) {
  return monthWindow(monthWindow(nowMs).start - 1);
}

/** upstream getRegenAmount: drift toward baseline from either side. */
export function getRegenAmount(currentHearts) {
  const baselineGap = PARAMS.baselineAmount - currentHearts;
  return baselineGap >= 0
    ? Math.min(PARAMS.regenAmount, baselineGap)
    : Math.max(-PARAMS.fadeAmount, baselineGap);
}

/** upstream getCappedHearts: never exceed max. */
export function getCappedHearts(currentHearts, requestedHearts) {
  const margin = Math.max(0, PARAMS.max - (currentHearts || 0));
  return Math.min(requestedHearts, margin);
}

/** upstream getChallengeMinVotes (counts, not db). */
export function challengeMinVotes(residentCount, challengeeHearts, value) {
  return challengeeHearts - value <= PARAMS.criticalNum
    ? Math.ceil(residentCount * PARAMS.minPctCritical)
    : Math.ceil(residentCount * PARAMS.minPctInitial);
}

/** upstream getKarmaRecipients: matches `<@user> ++`. */
export function getKarmaRecipients(text) {
  let match;
  const matches = [];
  const regex = /<@(\w+)>\s*\+\+/g;
  while ((match = regex.exec(text || ''))) { matches.push(match[1]); }
  return matches;
}

/** upstream getNumKarmaWinners (counts, not db). */
export function karmaNumWinners(residentCount, uniqueReceivers) {
  return Math.min(Math.floor(residentCount / PARAMS.karmaProportion), uniqueReceivers);
}

/**
 * upstream getKarmaRankings: giver influence = giverHearts / karmaIssued;
 * receiver ranking = sum of giver influences. Descending.
 * karma: [{giver, receiver}], heartsByGiver: {giver: hearts}
 */
export function karmaRankings(karma, heartsByGiver) {
  if (!karma.length) return [];
  const issued = {};
  for (const k of karma) issued[k.giver] = (issued[k.giver] || 0) + 1;
  const influence = {};
  for (const [giver, count] of Object.entries(issued)) {
    const hearts = heartsByGiver[giver] ?? PARAMS.baselineAmount;
    influence[giver] = hearts / count;
  }
  const rankings = {};
  for (const k of karma) {
    rankings[k.receiver] = (rankings[k.receiver] || 0) + influence[k.giver];
  }
  return Object.entries(rankings)
    .map(([resident, ranking]) => ({ resident, ranking }))
    .sort((a, b) => b.ranking - a.ranking);
}

/** upstream chores.calculatePenalty (deficiency precomputed). */
export function chorePenalty(deficiency) {
  return deficiency <= 0
    ? PARAMS.heartBonus
    : -Math.floor(deficiency / PARAMS.penaltyIncrement) * PARAMS.penaltyUnit;
}

/** choreWheel isPollValid. */
export function pollValid(yays, nays, minVotes) {
  return yays >= minVotes && yays > nays;
}

/** Sum a resident's heart entries effective at or before asOfMs. */
export function heartsOf(ledger, resident, asOfMs = Infinity) {
  const entries = (ledger.entries || []).filter(
    (e) => e.resident === resident && new Date(e.at).getTime() <= asOfMs,
  );
  if (!entries.length) return null; // uninitialised (upstream: hearts === null)
  return entries.reduce((s, e) => s + e.value, 0);
}

/** upstream getHeartsVoteScalar: 1 - (hearts - baseline) * 0.2. */
export function voteScalarFor(hearts) {
  const h = hearts === null || hearts === undefined ? PARAMS.baselineAmount : hearts;
  return 1 - (h - PARAMS.baselineAmount) * PARAMS.voteScalar;
}

export function residentNames(config) {
  return (config.residents || []).map((r) => (typeof r === 'string' ? r : r.name));
}

export function residentByAny(config, idOrName) {
  for (const r of config.residents || []) {
    const name = typeof r === 'string' ? r : r.name;
    const slackId = typeof r === 'string' ? '' : r.slackId || '';
    if (name === idOrName || (slackId && slackId === idOrName)) return { name, slackId };
  }
  return null;
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
  const name = `hearts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
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

function hasEntry(ledger, resident, key) {
  return (ledger.entries || []).some((e) => e.resident === resident && e.key === key);
}

function addEntry(ledger, resident, type, value, atMs, key, note) {
  ledger.entries.push({
    resident, type, value: Math.round(value * 100) / 100,
    at: new Date(atMs).toISOString(), key, ...(note ? { note } : {}),
  });
}

// ---------------------------------------------------------------------------
// One scheduler tick (exported, injectable for tests)

export async function tick({
  profileDir, logger, nowMs, slackToken, fetchReactions, postMessage,
}) {
  const cfgPath = path.join(profileDir, 'profile.config.json');
  const sharedKb = readJson(cfgPath, {}).sharedKbGroup || 'slack_main';
  const base = path.join(profileDir, 'groups', sharedKb, 'hearts');
  const config = readJson(path.join(base, 'config.json'), null);
  if (!config || !Array.isArray(config.residents) || !config.residents.length) {
    return null; // unconfigured → silent no-op
  }
  const names = residentNames(config);
  const residentCount = names.length;
  const chatJid = config.chatJid || '';
  const channelId = chatJid.replace(/^slack:/, '');
  const pollWindowMs = (Number(config.challengePollHours) || 72) * HOUR_MS;
  const ledgerPath = path.join(base, 'ledger.json');
  const ledger = readJson(ledgerPath, { entries: [] });
  ledger.entries = ledger.entries || [];
  let dirty = false;
  const announce = (text) => { if (chatJid) writeIpcMessage(profileDir, sharedKb, chatJid, text); };
  const post = postMessage ||
    (async (payload) => slackApi(slackToken, 'chat.postMessage', payload));

  const { start: monthStart, key: monthKey } = monthWindow(nowMs);
  const prev = prevMonthWindow(nowMs);

  // 1. Initialise residents at baseline (upstream initialiseResident).
  for (const name of names) {
    if (heartsOf(ledger, name) === null) {
      addEntry(ledger, name, HEART_REGEN, PARAMS.baselineAmount, nowMs, 'init');
      dirty = true;
    }
  }

  // 2. Monthly regen/fade (upstream regenerateHearts). Only for residents
  //    initialised before this month started (upstream: skip if null).
  for (const name of names) {
    if (hasEntry(ledger, name, `regen-${monthKey}`)) continue;
    const asOfStart = heartsOf(ledger, name, monthStart);
    if (asOfStart === null) continue;
    addEntry(
      ledger, name, HEART_REGEN, getRegenAmount(asOfStart), monthStart, `regen-${monthKey}`,
    );
    dirty = true;
  }

  // 3. Karma hearts for last month's winners (upstream generateKarmaHearts).
  const karmaDir = path.join(base, 'karma');
  fs.mkdirSync(karmaDir, { recursive: true });
  if (nowMs >= monthStart + PARAMS.karmaDelayMs &&
      !ledger.entries.some((e) => e.key === `karma-${monthKey}`)) {
    const karma = fs.readdirSync(karmaDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson(path.join(karmaDir, f), null))
      .filter((k) => k && k.giver && k.receiver)
      .filter((k) => {
        const t = new Date(k.givenAt || 0).getTime();
        return t >= prev.start && t < prev.end;
      });
    const unique = new Set(karma.map((k) => k.receiver)).size;
    const numWinners = karmaNumWinners(residentCount, unique);
    if (numWinners > 0) {
      const heartsByGiver = {};
      for (const name of names) heartsByGiver[name] = heartsOf(ledger, name, nowMs) ?? PARAMS.baselineAmount;
      const winners = karmaRankings(karma, heartsByGiver).slice(0, numWinners);
      const awarded = [];
      for (const w of winners) {
        const current = heartsOf(ledger, w.resident, nowMs) ?? 0;
        const value = getCappedHearts(current, 1);
        addEntry(ledger, w.resident, HEART_KARMA, value, monthStart + PARAMS.karmaDelayMs, `karma-${monthKey}`);
        awarded.push(`${w.resident} +${value}❤️`);
        dirty = true;
      }
      if (awarded.length) {
        announce(`🌟 Karma winners for ${prev.key}: ${awarded.join(', ')}. Thanks for being appreciated!`);
      }
    }
  }

  // 4. Chore-hearts link (upstream chores.addChorePenalty, via the chores
  //    plugin's ledger file — no core hooks). Applies at monthStart + 30h.
  const choresBase = path.join(profileDir, 'groups', sharedKb, 'chores');
  const choresConfig = readJson(path.join(choresBase, 'config.json'), null);
  const choresLedger = readJson(path.join(choresBase, 'ledger.json'), null);
  if (nowMs >= monthStart + PARAMS.penaltyDelayMs && choresConfig && choresLedger) {
    const results = [];
    for (const name of names) {
      if (hasEntry(ledger, name, `chore-${monthKey}`)) continue;
      // upstream gate: skip if not initialised as of penaltyTime. (Upstream
      // prorates obligations via workingPercentage/breaks; v1 defers that —
      // new residents should be added to config near a month boundary.)
      if (heartsOf(ledger, name, monthStart + PARAMS.penaltyDelayMs) === null) continue;
      const earned = (choresLedger.credits || [])
        .filter((c) => c.resident === name && c.month === prev.key)
        .reduce((s, c) => s + (Number(c.value) || 0), 0);
      const deficiency = PARAMS.pointsPerResident - earned;
      const penalty = chorePenalty(deficiency);
      const current = heartsOf(ledger, name, nowMs) ?? 0;
      const value = getCappedHearts(current, penalty);
      addEntry(ledger, name, HEART_CHORE, value, monthStart + PARAMS.penaltyDelayMs,
        `chore-${monthKey}`, `chores ${prev.key}: ${Math.round(earned)}/${PARAMS.pointsPerResident}`);
      dirty = true;
      if (value !== 0) {
        results.push(`${name} ${value > 0 ? '+' : ''}${value}❤️ (${Math.round(earned)}/${PARAMS.pointsPerResident} pts)`);
      }
    }
    if (results.length) {
      announce(`💜 Chore hearts for ${prev.key}: ${results.join(', ')}.`);
    }
  }

  // 5. Challenges — claim → reaction-poll pattern (same workaround as chores).
  const challengesDir = path.join(base, 'challenges');
  fs.mkdirSync(challengesDir, { recursive: true });
  const challengeFiles = fs.readdirSync(challengesDir).filter((f) => f.endsWith('.json'));

  for (const f of challengeFiles) {
    const chPath = path.join(challengesDir, f);
    const ch = readJson(chPath, null);
    if (!ch || ch.status !== 'new') continue;
    const challengee = residentByAny(config, ch.challengee);
    const challenger = residentByAny(config, ch.challenger);
    if (!challengee || !challenger) {
      ch.status = 'rejected';
      ch.reason = 'unknown resident';
      atomicWrite(chPath, JSON.stringify(ch, null, 2));
      continue;
    }
    // upstream: only one unresolved challenge per challengee.
    const active = challengeFiles.some((g) => {
      if (g === f) return false;
      const other = readJson(path.join(challengesDir, g), null);
      return other && other.status === 'polling' && other.challengee === ch.challengee;
    });
    if (active) {
      ch.status = 'rejected';
      ch.reason = 'active challenge exists';
      atomicWrite(chPath, JSON.stringify(ch, null, 2));
      continue;
    }
    const value = Math.max(1, Math.round(Number(ch.value) || 1));
    const challengeeHearts = heartsOf(ledger, challengee.name, nowMs) ?? PARAMS.baselineAmount;
    ch.value = value;
    ch.minVotes = challengeMinVotes(residentCount, challengeeHearts, value);
    ch.expiresAt = nowMs + pollWindowMs;
    if (!slackToken && !postMessage) {
      logger.warn('[hearts] challenge pending — Slack not configured yet');
      continue;
    }
    try {
      const postRes = await post({
        channel: channelId,
        text:
          `*Heart challenge:* ${challenger.name} challenges *${challengee.name}* ` +
          `for ${value} heart${value === 1 ? '' : 's'}` +
          (ch.circumstance ? ` — "${ch.circumstance}"` : '') + `. ` +
          `React 👍 to support the challenge or 👎 to reject it. ` +
          `Needs ${ch.minVotes} 👍 (and more 👍 than 👎) within ` +
          `${Math.round(pollWindowMs / HOUR_MS)}h. If it fails, the challenger ` +
          `loses the hearts instead.`,
      });
      ch.status = 'polling';
      ch.pollTs = postRes.ts;
      ch.pollChannel = channelId;
      atomicWrite(chPath, JSON.stringify(ch, null, 2));
    } catch (err) {
      logger.warn({ err: String(err) }, '[hearts] failed to post challenge');
    }
  }

  for (const f of challengeFiles) {
    const chPath = path.join(challengesDir, f);
    const ch = readJson(chPath, null);
    if (!ch || ch.status !== 'polling') continue;
    if (nowMs < ch.expiresAt) continue;
    let yays = 0;
    let nays = 0;
    try {
      const getReactions =
        fetchReactions ||
        (async () => {
          const r = await slackApi(slackToken, 'reactions.get', {
            channel: ch.pollChannel,
            timestamp: ch.pollTs,
            full: true,
          });
          return r.message?.reactions || [];
        });
      const reactions = await getReactions(ch);
      const countFor = (rnames) =>
        reactions
          .filter((r) => rnames.includes(r.name))
          .flatMap((r) => r.users || []).length;
      yays = countFor(['thumbsup', '+1']);
      nays = countFor(['thumbsdown', '-1']);
    } catch (err) {
      logger.warn({ err: String(err) }, '[hearts] reactions.get failed; retrying next tick');
      continue;
    }
    const valid = pollValid(yays, nays, ch.minVotes);
    const loser = valid ? ch.challengee : ch.challenger;
    const loserRec = residentByAny(config, loser) || { name: loser };
    addEntry(ledger, loserRec.name, HEART_CHALLENGE, -ch.value, nowMs, `challenge-${f}`);
    dirty = true;
    ch.status = 'resolved';
    ch.valid = valid;
    ch.yays = yays;
    ch.nays = nays;
    ch.loser = loserRec.name;
    ch.resolvedAt = nowMs;
    atomicWrite(chPath, JSON.stringify(ch, null, 2));
    const remaining = heartsOf(ledger, loserRec.name, nowMs);
    announce(
      (valid
        ? `💔 Challenge upheld (${yays}👍/${nays}👎): *${loserRec.name}* loses ${ch.value} heart${ch.value === 1 ? '' : 's'}`
        : `💔 Challenge failed (${yays}👍/${nays}👎, needed ${ch.minVotes}👍): challenger *${loserRec.name}* loses ${ch.value} heart${ch.value === 1 ? '' : 's'}`) +
      ` (now at ${remaining}).` +
      (remaining <= 0 ? ` ⚠️ ${loserRec.name} is at zero hearts — house should discuss next steps.` : ''),
    );
  }

  if (dirty) atomicWrite(ledgerPath, JSON.stringify(ledger, null, 2));

  // 6. Render status.md.
  const lines = [
    `# Hearts status (auto-generated ${new Date(nowMs).toISOString()})`,
    '',
    `Baseline ${PARAMS.baselineAmount}, max ${PARAMS.max}. Monthly drift toward baseline: +${PARAMS.regenAmount}/-${PARAMS.fadeAmount}.`,
    '',
    '## Balances',
    '',
  ];
  const balances = names
    .map((n) => [n, heartsOf(ledger, n, nowMs) ?? 0])
    .sort((a, b) => b[1] - a[1]);
  for (const [n, v] of balances) {
    lines.push(`- ${n}: ${v} ❤️${v <= PARAMS.criticalNum ? ' ⚠️' : ''}`);
  }
  lines.push('', '## Recent events', '');
  for (const e of ledger.entries.slice(-10).reverse()) {
    lines.push(`- ${e.at} — ${e.resident} ${e.value >= 0 ? '+' : ''}${e.value} (${e.key}${e.note ? `: ${e.note}` : ''})`);
  }
  atomicWrite(path.join(base, 'status.md'), lines.join('\n') + '\n');
  return { residents: residentCount, entries: ledger.entries.length };
}

// ---------------------------------------------------------------------------
// Registration

export default function register({ registerIntegration, readEnvFile, logger }) {
  const profileDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '..',
  );
  let timer;
  registerIntegration({
    name: 'hearts',
    start: () => {
      logger.info('[hearts] hearts started');
      const run = () => {
        const slackToken =
          process.env.SLACK_BOT_TOKEN || readEnvFile(['SLACK_BOT_TOKEN']).SLACK_BOT_TOKEN;
        tick({ profileDir, logger, nowMs: Date.now(), slackToken }).catch(
          (err) => logger.warn({ err: String(err) }, '[hearts] tick failed'),
        );
      };
      run();
      timer = setInterval(run, TICK_MS);
    },
    stop: () => clearInterval(timer),
  });
}
