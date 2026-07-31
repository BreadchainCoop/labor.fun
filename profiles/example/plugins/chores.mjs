// chores.mjs — house chore wheel, as a labor.fun profile plugin. Part of the
// house-governance suite (chores + hearts + things) for coliving/coop houses.
//
// Ports the MATH of Zaratan's choreWheel (src/core/chores.js, AGPL-3.0,
// github.com/zaratanDotWorld/choreWheel — see the attribution note in
// plugins/README.md) onto the labor.fun plugin surface. Zero framework-core
// edits: the plugin acts only
// through (a) files in this profile, (b) the IPC message contract, and
// (c) the Slack Web API using the same SLACK_BOT_TOKEN the framework already
// reads (readEnvFile is part of the official PluginApi).
//
// Mechanism (choreWheel-derived):
//   * Each resident carries a 100 points/month budget concept
//     (pointsPerResident). The house's monthly point pool =
//     residents * 100.
//   * Each chore has a `speed` weight. The pool accrues LINEARLY over the
//     month and is split across chores proportional to speed — an undone
//     chore's claimable value grows over time and resets when a claim is
//     verified. (choreWheel derives weights from pairwise preferences via
//     PowerRanker; v1 uses explicit per-chore speed instead. See DEFERRED.)
//   * A claim triggers PEER VERIFICATION: the plugin posts a verification
//     message and counts emoji reactions (👍 yay / 👎 nay) from OTHER
//     residents within the window. choreWheel poll rule: minVotes = 2 when
//     value >= 10 and residents >= 4, else 1; valid = yays >= minVotes and
//     yays > nays. Verified → points credited to the claimant's ledger.
//   * Inbound reaction EVENTS aren't surfaced by the framework (the Slack
//     manifest subscribes to messages only), so the plugin POLLS
//     reactions.get on its own verification message. Plugin-only workaround;
//     suggested upstream ask: subscribe reaction_added + surface to plugins.
//
// Data (all under <profile>/groups/<sharedKbGroup>/chores/ so the agent can
// read state and write claims from its own /workspace/group mount):
//   chores/config.json   — residents[], slack channel id, window, params
//   chores/chores.json   — chore definitions {name, speed, description}
//   chores/claims/*.json — claims written by the agent (via the chores skill)
//   chores/ledger.json   — plugin-owned: credited points per resident/month
//   chores/status.md     — plugin-rendered: current values + leaderboard
//                          (the agent reads this to answer "list chores" /
//                          "points" instantly and consistently)
//
// DEFERRED (choreWheel parity not in v1) — documented for the receipt:
//   hearts app, things app, PowerRanker preference-based priority ranking,
//   penalties, special chores, breaks/working-ratio, vote anonymization.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DAY_MS = 86_400_000;
const TICK_MS = 60_000;

export const PARAMS = {
  pointsPerResident: 100, // choreWheel params.pointsPerResident
  inflationFactor: 1.02, // choreWheel params.inflationFactor
  valueThreshold: 10, // claims >= this need 2 yays (choreWheel)
  numResidentsThreshold: 4, // ...when the house has >= 4 residents
  pollLengthMs: DAY_MS, // choreWheel params.pollLength
  capMultiplier: 3, // choreWheel pointsCapMultiplier (per-chore value cap)
  displayThreshold: 0.5, // hide near-zero values in status
};

// ---------------------------------------------------------------------------
// Pure math (exported for tests)

export function monthWindow(nowMs) {
  const d = new Date(nowMs);
  const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  return { start, end, key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` };
}

/**
 * Current claimable value of a chore: its speed-share of the monthly pool,
 * accrued linearly since the later of (month start, last verified claim).
 * choreWheel: getCurrentChoreValue = integral of pointsPerSecond * ranking
 * since last claim; ranking here = speed / sum(speeds).
 */
export function choreValue(chore, chores, residents, lastClaimMs, nowMs) {
  const { start, end } = monthWindow(nowMs);
  const totalSpeed = chores.reduce((s, c) => s + (Number(c.speed) || 1), 0);
  if (totalSpeed <= 0 || residents <= 0) return 0;
  const monthlyPoints =
    residents * PARAMS.pointsPerResident * PARAMS.inflationFactor;
  const perMs = monthlyPoints / (end - start);
  const share = (Number(chore.speed) || 1) / totalSpeed;
  const since = Math.max(start, lastClaimMs || 0);
  const value = perMs * share * Math.max(0, nowMs - since);
  const cap =
    ((PARAMS.capMultiplier * monthlyPoints) / chores.length) || Infinity;
  return Math.min(value, cap);
}

/** choreWheel createChoresPoll: how many yays a claim of `value` needs. */
export function minVotesFor(value, residentCount) {
  return value >= PARAMS.valueThreshold &&
    residentCount >= PARAMS.numResidentsThreshold
    ? 2
    : 1;
}

/** choreWheel isPollValid: yays >= minVotes && yays > nays. */
export function pollValid(yays, nays, minVotes) {
  return yays >= minVotes && yays > nays;
}

// ---------------------------------------------------------------------------
// Plumbing

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
  const name = `chores-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
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

// ---------------------------------------------------------------------------
// One scheduler tick (exported, injectable for tests)

export async function tick({ profileDir, logger, nowMs, slackToken, fetchReactions }) {
  const cfgPath = path.join(profileDir, 'profile.config.json');
  const sharedKb = readJson(cfgPath, {}).sharedKbGroup || 'slack_main';
  const base = path.join(profileDir, 'groups', sharedKb, 'chores');
  const config = readJson(path.join(base, 'config.json'), null);
  if (!config || !Array.isArray(config.residents) || !config.residents.length) {
    return null; // unconfigured → silent no-op (same convention as sd-kickoff)
  }
  const chores = readJson(path.join(base, 'chores.json'), []);
  const ledger = readJson(path.join(base, 'ledger.json'), {
    credits: [],
    lastVerified: {},
  });
  const residents = config.residents.length;
  const windowMs = (Number(config.pollHours) || 24) * 3_600_000;
  const chatJid = config.chatJid || '';
  const channelId = chatJid.replace(/^slack:/, '');

  // 1. Pick up new claims the agent filed, post their verification message.
  const claimsDir = path.join(base, 'claims');
  fs.mkdirSync(claimsDir, { recursive: true });
  for (const f of fs.readdirSync(claimsDir).filter((f) => f.endsWith('.json'))) {
    const claimPath = path.join(claimsDir, f);
    const claim = readJson(claimPath, null);
    if (!claim || claim.status !== 'new') continue;
    const chore = chores.find((c) => c.name === claim.chore);
    if (!chore) {
      claim.status = 'rejected';
      claim.reason = 'unknown chore';
      atomicWrite(claimPath, JSON.stringify(claim, null, 2));
      continue;
    }
    const value = choreValue(
      chore, chores, residents, ledger.lastVerified[chore.name], nowMs,
    );
    claim.value = Math.round(value);
    claim.minVotes = minVotesFor(value, residents);
    claim.expiresAt = nowMs + windowMs;
    if (!slackToken || !channelId) {
      // Tokens not present yet — leave the claim as 'new'; it will be
      // announced on a later tick once Slack is configured.
      logger.warn('[chores] claim pending — Slack not configured yet');
      continue;
    }
    try {
      const post = await slackApi(slackToken, 'chat.postMessage', {
        channel: channelId,
        text:
          `*Chore claim:* ${claim.claimant} says they did *${chore.name}* ` +
          `(${claim.value} pts). React 👍 to verify or 👎 to dispute — ` +
          `needs ${claim.minVotes} 👍 within ${Math.round(windowMs / 3_600_000)}h. ` +
          `(Claimant's own reaction doesn't count.)`,
      });
      claim.status = 'polling';
      claim.pollTs = post.ts;
      claim.pollChannel = channelId;
      atomicWrite(claimPath, JSON.stringify(claim, null, 2));
    } catch (err) {
      logger.warn({ err: String(err) }, '[chores] failed to post verification');
    }
  }

  // 2. Resolve claims whose window has expired: count reactions.
  for (const f of fs.readdirSync(claimsDir).filter((f) => f.endsWith('.json'))) {
    const claimPath = path.join(claimsDir, f);
    const claim = readJson(claimPath, null);
    if (!claim || claim.status !== 'polling') continue;
    if (nowMs < claim.expiresAt) continue;
    let yays = 0;
    let nays = 0;
    try {
      const getReactions =
        fetchReactions ||
        (async () => {
          const r = await slackApi(slackToken, 'reactions.get', {
            channel: claim.pollChannel,
            timestamp: claim.pollTs,
            full: true,
          });
          return r.message?.reactions || [];
        });
      const reactions = await getReactions(claim);
      const claimantId = (claim.claimantId || '').trim();
      const countFor = (names) =>
        reactions
          .filter((r) => names.includes(r.name))
          .flatMap((r) => r.users || [])
          .filter((u) => !claimantId || u !== claimantId).length;
      yays = countFor(['thumbsup', '+1']);
      nays = countFor(['thumbsdown', '-1']);
    } catch (err) {
      logger.warn({ err: String(err) }, '[chores] reactions.get failed; retrying next tick');
      continue;
    }
    const valid = pollValid(yays, nays, claim.minVotes);
    claim.status = valid ? 'verified' : 'rejected';
    claim.yays = yays;
    claim.nays = nays;
    claim.resolvedAt = nowMs;
    atomicWrite(claimPath, JSON.stringify(claim, null, 2));
    if (valid) {
      ledger.credits.push({
        resident: claim.claimant,
        chore: claim.chore,
        value: claim.value,
        at: new Date(nowMs).toISOString(),
        month: monthWindow(nowMs).key,
      });
      ledger.lastVerified[claim.chore] = nowMs;
      atomicWrite(path.join(base, 'ledger.json'), JSON.stringify(ledger, null, 2));
    }
    if (chatJid) {
      writeIpcMessage(
        profileDir, sharedKb, chatJid,
        valid
          ? `✅ Verified: ${claim.claimant} +${claim.value} pts for *${claim.chore}* (${yays}👍/${nays}👎).`
          : `❌ Not verified: ${claim.claimant}'s claim on *${claim.chore}* (${yays}👍/${nays}👎, needed ${claim.minVotes}👍). Points not credited.`,
      );
    }
  }

  // 3. Render status.md (agent reads this for list/points commands).
  const { key } = monthWindow(nowMs);
  const totals = {};
  for (const r of config.residents) totals[r] = 0;
  for (const c of ledger.credits.filter((c) => c.month === key)) {
    totals[c.resident] = (totals[c.resident] || 0) + c.value;
  }
  const lines = [
    `# Chore status (auto-generated ${new Date(nowMs).toISOString()})`,
    '',
    '## Current chore values',
    '',
  ];
  for (const c of chores) {
    const v = choreValue(c, chores, residents, ledger.lastVerified[c.name], nowMs);
    if (v < PARAMS.displayThreshold) continue;
    lines.push(`- **${c.name}** — ${Math.round(v)} pts (speed ${c.speed || 1})${c.description ? ` — ${c.description}` : ''}`);
  }
  lines.push('', `## Points this month (${key}, budget ${PARAMS.pointsPerResident}/resident)`, '');
  for (const [r, v] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${r}: ${Math.round(v)} / ${PARAMS.pointsPerResident}`);
  }
  atomicWrite(path.join(base, 'status.md'), lines.join('\n') + '\n');
  return { chores: chores.length, residents };
}

// ---------------------------------------------------------------------------
// Registration

export default function register({ registerIntegration, readEnvFile, logger }) {
  const profileDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '..',
  );
  let timer;
  registerIntegration({
    name: 'chore-wheel',
    start: () => {
      logger.info('[chores] chore wheel started');
      const run = () => {
        const slackToken =
          process.env.SLACK_BOT_TOKEN || readEnvFile(['SLACK_BOT_TOKEN']).SLACK_BOT_TOKEN;
        tick({ profileDir, logger, nowMs: Date.now(), slackToken }).catch(
          (err) => logger.warn({ err: String(err) }, '[chores] tick failed'),
        );
      };
      run();
      timer = setInterval(run, TICK_MS);
    },
    stop: () => clearInterval(timer),
  });
}
