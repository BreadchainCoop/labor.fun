// Unit tests for hearts.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'vitest';

import {
  PARAMS, HEART_REGEN, HEART_CHALLENGE, HEART_KARMA, HEART_CHORE,
  getRegenAmount, getCappedHearts, challengeMinVotes, getKarmaRecipients,
  karmaNumWinners, karmaRankings, chorePenalty, pollValid, heartsOf,
  voteScalarFor, monthWindow, prevMonthWindow, tick,
} from '../hearts.mjs';

const t = (name, fn) => it(name, fn);

// --- getRegenAmount (upstream closed-form) ---
t('regen: below baseline gains +0.5', () => assert.equal(getRegenAmount(3), 0.5));
t('regen: just under baseline caps at gap', () => assert.equal(getRegenAmount(4.75), 0.25));
t('regen: at baseline is 0', () => assert.equal(getRegenAmount(5), 0));
t('regen: above baseline fades -0.5', () => assert.equal(getRegenAmount(7), -0.5));
t('regen: just above baseline caps at gap', () =>
  assert.ok(Math.abs(getRegenAmount(5.2) - -0.2) < 1e-9));
t('regen: at zero gains +0.5 (not full gap)', () => assert.equal(getRegenAmount(0), 0.5));

// --- getCappedHearts ---
t('cap: at max gets 0', () => assert.equal(getCappedHearts(10, 1), 0));
t('cap: near max partial', () => assert.equal(getCappedHearts(9.5, 1), 0.5));
t('cap: normal grant passes through', () => assert.equal(getCappedHearts(5, 1), 1));
t('cap: negative (penalty) passes through', () => assert.equal(getCappedHearts(5, -0.5), -0.5));

// --- challengeMinVotes (both tiers) ---
// regular: challengee stays above criticalNum → 40%
t('challenge: regular tier 10 residents', () =>
  assert.equal(challengeMinVotes(10, 5, 1), Math.ceil(10 * 0.4))); // 4
t('challenge: regular tier 7 residents', () =>
  assert.equal(challengeMinVotes(7, 5, 2), Math.ceil(7 * 0.4))); // 3
// critical: challengee would drop to <= 2 → 70%
t('challenge: critical tier (5-3=2 <= 2)', () =>
  assert.equal(challengeMinVotes(10, 5, 3), Math.ceil(10 * 0.7))); // 7
t('challenge: critical tier low hearts', () =>
  assert.equal(challengeMinVotes(7, 3, 1), Math.ceil(7 * 0.7))); // 5
t('challenge: boundary — drop to exactly criticalNum+0.5 is regular', () =>
  assert.equal(challengeMinVotes(10, 3.5, 1), 4));

// --- karma parsing (upstream getKarmaRecipients) ---
t('karma parse: single', () =>
  assert.deepEqual(getKarmaRecipients('thanks <@U123>++'), ['U123']));
t('karma parse: space before ++', () =>
  assert.deepEqual(getKarmaRecipients('<@U123> ++ for dishes'), ['U123']));
t('karma parse: multiple', () =>
  assert.deepEqual(getKarmaRecipients('<@U1>++ and <@U2> ++'), ['U1', 'U2']));
t('karma parse: no match', () => assert.deepEqual(getKarmaRecipients('hello ++'), []));
t('karma parse: plain @name does not match', () =>
  assert.deepEqual(getKarmaRecipients('@alice ++'), []));

// --- karma winners (upstream getNumKarmaWinners) ---
t('karma winners: floor(residents/3) cap', () => assert.equal(karmaNumWinners(10, 5), 3));
t('karma winners: limited by unique receivers', () => assert.equal(karmaNumWinners(10, 2), 2));
t('karma winners: small house floor(2/3)=0', () => assert.equal(karmaNumWinners(2, 1), 0));
t('karma winners: 3 residents 1 winner', () => assert.equal(karmaNumWinners(3, 4), 1));

// --- karma rankings (upstream influence math) ---
t('karma rankings: influence = giverHearts / issued', () => {
  // A (6 hearts) gives 2 karma → influence 3 each; B (4 hearts) gives 1 → 4.
  const karma = [
    { giver: 'A', receiver: 'X' },
    { giver: 'A', receiver: 'Y' },
    { giver: 'B', receiver: 'X' },
  ];
  const r = karmaRankings(karma, { A: 6, B: 4 });
  assert.deepEqual(r, [
    { resident: 'X', ranking: 7 }, // 3 + 4
    { resident: 'Y', ranking: 3 },
  ]);
});
t('karma rankings: empty', () => assert.deepEqual(karmaRankings([], {}), []));

// --- chore penalty (upstream calculatePenalty) ---
t('chore penalty: no deficiency → +0.5 bonus', () => assert.equal(chorePenalty(0), 0.5));
t('chore penalty: surplus → +0.5 bonus', () => assert.equal(chorePenalty(-20), 0.5));
t('chore penalty: 4 short → 0 (under increment)', () => assert.equal(chorePenalty(4), -0));
t('chore penalty: 5 short → -0.25', () => assert.equal(chorePenalty(5), -0.25));
t('chore penalty: 27 short → -1.25', () => assert.equal(chorePenalty(27), -1.25));
t('chore penalty: 100 short (did nothing) → -5', () => assert.equal(chorePenalty(100), -5));

// --- pollValid ---
t('poll: yays must meet minVotes', () => assert.equal(pollValid(3, 0, 4), false));
t('poll: yays must beat nays', () => assert.equal(pollValid(4, 4, 4), false));
t('poll: valid', () => assert.equal(pollValid(4, 3, 4), true));

// --- voteScalarFor (upstream getHeartsVoteScalar) ---
t('vote scalar: baseline → 1', () => assert.equal(voteScalarFor(5), 1));
t('vote scalar: 10 hearts → 0 (trusted)', () => assert.equal(voteScalarFor(10), 0));
t('vote scalar: 3 hearts → 1.4', () => assert.equal(voteScalarFor(3), 1.4));
t('vote scalar: null → 1', () => assert.equal(voteScalarFor(null), 1));

// --- heartsOf ledger sum ---
t('heartsOf: null when no entries', () =>
  assert.equal(heartsOf({ entries: [] }, 'alice'), null));
t('heartsOf: sums entries', () => {
  const ledger = { entries: [
    { resident: 'alice', value: 5, at: '2026-07-01T00:00:00Z' },
    { resident: 'alice', value: -1, at: '2026-07-10T00:00:00Z' },
    { resident: 'ann', value: 5, at: '2026-07-01T00:00:00Z' },
  ] };
  assert.equal(heartsOf(ledger, 'alice'), 4);
});
t('heartsOf: respects asOf cutoff', () => {
  const ledger = { entries: [
    { resident: 'alice', value: 5, at: '2026-07-01T00:00:00Z' },
    { resident: 'alice', value: -1, at: '2026-07-10T00:00:00Z' },
  ] };
  assert.equal(heartsOf(ledger, 'alice', Date.parse('2026-07-05T00:00:00Z')), 5);
});

// --- month windows ---
t('prevMonthWindow', () => {
  const p = prevMonthWindow(new Date(2026, 6, 31).getTime()); // July → June
  assert.equal(p.key, '2026-06');
});

// --- tick integration (temp profile, injected slack) ---
async function tickTests() {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearts-test-'));
  const base = path.join(profileDir, 'groups', 'slack_main', 'hearts');
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'profile.config.json'),
    JSON.stringify({ sharedKbGroup: 'slack_main' }));
  fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({
    residents: [
      { name: 'alice', slackId: 'U1' },
      { name: 'bea', slackId: 'U2' },
      { name: 'carol', slackId: 'U3' },
      { name: 'dave', slackId: 'U4' },
      { name: 'erin', slackId: 'U5' },
    ],
    chatJid: 'slack:C123',
  }));
  const logger = { info: () => {}, warn: () => {} };
  const posts = [];
  const postMessage = async (p) => { posts.push(p); return { ts: `${posts.length}.0` }; };

  // Tick 1: initialise everyone at 5.
  const t0 = new Date(2026, 6, 15).getTime(); // mid-July, past karma+penalty delays
  await tick({ profileDir, logger, nowMs: t0, postMessage });
  let ledger = JSON.parse(fs.readFileSync(path.join(base, 'ledger.json')));
  assert.equal(heartsOf(ledger, 'alice'), 5, 'init at baseline');
  assert.equal(ledger.entries.length, 5, 'one init entry per resident');

  // Tick again: idempotent (no double init, no regen for just-initialised).
  await tick({ profileDir, logger, nowMs: t0 + 60_000, postMessage });
  ledger = JSON.parse(fs.readFileSync(path.join(base, 'ledger.json')));
  assert.equal(ledger.entries.length, 5, 'no duplicate entries on second tick');

  // Challenge flow: file a challenge, poll posts, resolve.
  const chDir = path.join(base, 'challenges');
  fs.mkdirSync(chDir, { recursive: true });
  fs.writeFileSync(path.join(chDir, 'c1.json'), JSON.stringify({
    status: 'new', challenger: 'alice', challengee: 'carol', value: 1,
    circumstance: 'left dishes for a week',
  }));
  await tick({ profileDir, logger, nowMs: t0 + 120_000, postMessage });
  let ch = JSON.parse(fs.readFileSync(path.join(chDir, 'c1.json')));
  assert.equal(ch.status, 'polling');
  assert.equal(ch.minVotes, 2, 'regular tier: ceil(5*0.4)=2');
  assert.ok(posts.some((p) => p.text.includes('Heart challenge')));

  // Resolve: 3 yays 0 nays → valid → carol loses 1.
  const fetchReactions = async () => [
    { name: 'thumbsup', users: ['U1', 'U2', 'U4'] },
  ];
  await tick({ profileDir, logger, nowMs: ch.expiresAt + 1, postMessage, fetchReactions });
  ch = JSON.parse(fs.readFileSync(path.join(chDir, 'c1.json')));
  assert.equal(ch.status, 'resolved');
  assert.equal(ch.valid, true);
  assert.equal(ch.loser, 'carol');
  ledger = JSON.parse(fs.readFileSync(path.join(base, 'ledger.json')));
  assert.equal(heartsOf(ledger, 'carol'), 4, 'challengee lost a heart');

  // Failed challenge: challenger loses instead.
  fs.writeFileSync(path.join(chDir, 'c2.json'), JSON.stringify({
    status: 'new', challenger: 'bea', challengee: 'erin', value: 1,
  }));
  const t1 = ch.expiresAt + 120_000;
  await tick({ profileDir, logger, nowMs: t1, postMessage });
  let c2 = JSON.parse(fs.readFileSync(path.join(chDir, 'c2.json')));
  await tick({
    profileDir, logger, nowMs: c2.expiresAt + 1, postMessage,
    fetchReactions: async () => [{ name: 'thumbsup', users: ['U1'] }],
  });
  c2 = JSON.parse(fs.readFileSync(path.join(chDir, 'c2.json')));
  assert.equal(c2.valid, false);
  assert.equal(c2.loser, 'bea', 'failed challenge penalizes challenger');
  ledger = JSON.parse(fs.readFileSync(path.join(base, 'ledger.json')));
  assert.equal(heartsOf(ledger, 'bea'), 4);

  // Karma: grants in July, winners awarded after Aug 1 + 3h.
  const karmaDir = path.join(base, 'karma');
  fs.mkdirSync(karmaDir, { recursive: true });
  const julyGrant = (giver, receiver, i) =>
    fs.writeFileSync(path.join(karmaDir, `k${i}.json`), JSON.stringify({
      giver, receiver, givenAt: new Date(2026, 6, 10 + i).toISOString(),
    }));
  julyGrant('alice', 'bea', 1);
  julyGrant('carol', 'bea', 2);
  julyGrant('erin', 'alice', 3);
  const aug = new Date(2026, 7, 1).getTime() + PARAMS.karmaDelayMs + 60_000;
  await tick({ profileDir, logger, nowMs: aug, postMessage });
  ledger = JSON.parse(fs.readFileSync(path.join(base, 'ledger.json')));
  const karmaEntries = ledger.entries.filter((e) => e.key === 'karma-2026-08');
  // floor(5/3) = 1 winner; bea has most influence.
  assert.equal(karmaEntries.length, 1, 'one karma winner for 5 residents');
  assert.equal(karmaEntries[0].resident, 'bea');
  assert.equal(karmaEntries[0].value, 1);
  // regen also fired for Aug: everyone drifts toward baseline.
  const regenEntries = ledger.entries.filter((e) => e.key === 'regen-2026-08');
  assert.equal(regenEntries.length, 5, 'regen for all residents in Aug');
  const carolRegen = regenEntries.find((e) => e.resident === 'carol');
  assert.equal(carolRegen.value, 0.5, 'carol at 4 regens +0.5');

  // Chore-hearts link: chores ledger says alice earned 100, erin earned 73.
  const choresBase = path.join(profileDir, 'groups', 'slack_main', 'chores');
  fs.mkdirSync(choresBase, { recursive: true });
  fs.writeFileSync(path.join(choresBase, 'config.json'), JSON.stringify({ residents: ['x'] }));
  fs.writeFileSync(path.join(choresBase, 'ledger.json'), JSON.stringify({
    credits: [
      { resident: 'alice', value: 100, month: '2026-07' },
      { resident: 'erin', value: 73, month: '2026-07' },
    ],
    lastVerified: {},
  }));
  const augPenalty = new Date(2026, 7, 1).getTime() + PARAMS.penaltyDelayMs + 60_000;
  await tick({ profileDir, logger, nowMs: augPenalty, postMessage });
  ledger = JSON.parse(fs.readFileSync(path.join(base, 'ledger.json')));
  const choreEntries = ledger.entries.filter((e) => e.key === 'chore-2026-08');
  assert.equal(choreEntries.length, 5, 'chore hearts for all eligible residents');
  assert.equal(choreEntries.find((e) => e.resident === 'alice').value, 0.5, 'full completion → bonus');
  // erin: deficiency 27 → -floor(27/5)*0.25 = -1.25
  assert.equal(choreEntries.find((e) => e.resident === 'erin').value, -1.25);
  // bea: deficiency 100 → -5
  assert.equal(choreEntries.find((e) => e.resident === 'bea').value, -5);

  // status.md rendered
  assert.ok(fs.readFileSync(path.join(base, 'status.md'), 'utf-8').includes('## Balances'));

  fs.rmSync(profileDir, { recursive: true, force: true });
}

it('tick integration', tickTests);
