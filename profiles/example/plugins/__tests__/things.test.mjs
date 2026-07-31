// Unit tests for things.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'vitest';

import {
  PARAMS, buyMinVotes, proposalMinVotes, pollValid, accountBalance,
  voteScalarFor, tick,
} from '../things.mjs';

const t = (name, fn) => it(name, fn);

// --- buyMinVotes: regular buys (one vote per $50, capped at 60%) ---
t('buy: $20 regular → 1 vote', () => assert.equal(buyMinVotes(10, 20, false, 5), 1));
t('buy: $50 regular → 1 vote', () => assert.equal(buyMinVotes(10, 50, false, 5), 1));
t('buy: $51 regular → 2 votes', () => assert.equal(buyMinVotes(10, 51, false, 5), 2));
t('buy: $200 regular → 4 votes', () => assert.equal(buyMinVotes(10, 200, false, 5), 4));
t('buy: $1000 regular capped at ceil(0.6*10)=6', () =>
  assert.equal(buyMinVotes(10, 1000, false, 5), 6));
t('buy: $1000 with 5 residents capped at 3', () =>
  assert.equal(buyMinVotes(5, 1000, false, 5), 3));
t('buy: negative price uses abs', () => assert.equal(buyMinVotes(10, -120, false, 5), 3));

// --- buyMinVotes: special buys (floor of 30% of house) ---
t('special: cheap buy still needs 30% → 3 of 10', () =>
  assert.equal(buyMinVotes(10, 10, true, 5), 3));
t('special: $200 → max(4, 3) = 4', () => assert.equal(buyMinVotes(10, 200, true, 5), 4));
t('special: capped at 60%', () => assert.equal(buyMinVotes(10, 5000, true, 5), 6));
t('special: 5 residents cheap → ceil(0.3*5)=2', () =>
  assert.equal(buyMinVotes(5, 10, true, 5), 2));

// --- hearts vote scalar link ---
t('scalar: 3 hearts inflates votes (2 → ceil(2*1.4)=3)', () =>
  assert.equal(buyMinVotes(10, 100, false, 3), 3));
t('scalar: 10 hearts → 0 votes needed (fully trusted)', () =>
  assert.equal(buyMinVotes(10, 100, false, 10), 0));
t('scalar: null hearts → baseline scalar 1', () =>
  assert.equal(buyMinVotes(10, 100, false, null), 2));
t('voteScalarFor parity with hearts', () => {
  assert.equal(voteScalarFor(5), 1);
  assert.equal(voteScalarFor(7), 0.6);
});

// --- proposalMinVotes ---
t('proposal: ceil(0.4*10)=4', () => assert.equal(proposalMinVotes(10), 4));
t('proposal: ceil(0.4*5)=2', () => assert.equal(proposalMinVotes(5), 2));
t('proposal: ceil(0.4*3)=2', () => assert.equal(proposalMinVotes(3), 2));

// --- pollValid ---
t('poll: needs min votes', () => assert.equal(pollValid(2, 0, 3), false));
t('poll: needs majority', () => assert.equal(pollValid(3, 3, 3), false));
t('poll: valid', () => assert.equal(pollValid(3, 2, 3), true));

// --- accountBalance arithmetic ---
t('balance: loads minus buys', () => {
  const ledger = { txns: [
    { account: 'general', value: 500, at: '2026-07-01T00:00:00Z' },
    { account: 'general', value: -120, at: '2026-07-05T00:00:00Z' },
    { account: 'special', value: 100, at: '2026-07-02T00:00:00Z' },
  ] };
  assert.equal(accountBalance(ledger, 'general'), 380);
  assert.equal(accountBalance(ledger, 'special'), 100);
});
t('balance: default account is general', () => {
  const ledger = { txns: [{ value: 50, at: '2026-07-01T00:00:00Z' }] };
  assert.equal(accountBalance(ledger), 50);
});
t('balance: respects asOf cutoff', () => {
  const ledger = { txns: [
    { value: 500, at: '2026-07-01T00:00:00Z' },
    { value: -100, at: '2026-07-10T00:00:00Z' },
  ] };
  assert.equal(accountBalance(ledger, 'general', Date.parse('2026-07-05T00:00:00Z')), 500);
});
t('balance: empty ledger is 0', () => assert.equal(accountBalance({ txns: [] }), 0));

// --- tick integration ---
async function tickTests() {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'things-test-'));
  const base = path.join(profileDir, 'groups', 'slack_main', 'things');
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'profile.config.json'),
    JSON.stringify({ sharedKbGroup: 'slack_main' }));
  fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({
    residents: ['alice', 'bea', 'carol', 'dave', 'erin'],
    chatJid: 'slack:C123',
  }));
  fs.writeFileSync(path.join(base, 'things.json'), JSON.stringify([
    { name: 'paper towels', type: 'household', value: 25, active: true },
    { name: 'olive oil', type: 'pantry', value: 18, active: true },
  ]));
  // Load the account: manual admin credit = txn with positive value.
  fs.writeFileSync(path.join(base, 'ledger.json'), JSON.stringify({
    txns: [{ type: 'load', account: 'general', value: 300, by: 'alice', at: '2026-07-01T00:00:00Z' }],
  }));
  const logger = { info: () => {}, warn: () => {} };
  const posts = [];
  const postMessage = async (p) => { posts.push(p); return { ts: `${posts.length}.0` }; };
  const t0 = Date.parse('2026-07-15T12:00:00Z');

  // Buy: 4 × paper towels = $100 → minVotes ceil(100/50)=2.
  const buysDir = path.join(base, 'buys');
  fs.mkdirSync(buysDir, { recursive: true });
  fs.writeFileSync(path.join(buysDir, 'b1.json'), JSON.stringify({
    status: 'new', thing: 'paper towels', quantity: 4, buyer: 'bea',
  }));
  await tick({ profileDir, logger, nowMs: t0, postMessage });
  let b1 = JSON.parse(fs.readFileSync(path.join(buysDir, 'b1.json')));
  assert.equal(b1.status, 'polling');
  assert.equal(b1.cost, 100);
  assert.equal(b1.minVotes, 2, 'ceil(100/50)=2, under 60% cap of 3');
  assert.ok(posts.some((p) => p.text.includes('Buy request')));

  // Resolve valid: 2 yays.
  await tick({
    profileDir, logger, nowMs: b1.expiresAt + 1, postMessage,
    fetchReactions: async () => [{ name: '+1', users: ['U1', 'U2'] }],
  });
  b1 = JSON.parse(fs.readFileSync(path.join(buysDir, 'b1.json')));
  assert.equal(b1.status, 'approved');
  let ledger = JSON.parse(fs.readFileSync(path.join(base, 'ledger.json')));
  assert.equal(accountBalance(ledger), 200, '300 - 100');

  // Insufficient funds: special buy over balance rejected without poll.
  fs.writeFileSync(path.join(buysDir, 'b2.json'), JSON.stringify({
    status: 'new', special: true, title: 'hot tub', price: 5000, buyer: 'erin',
  }));
  await tick({ profileDir, logger, nowMs: b1.expiresAt + 60_000, postMessage });
  const b2 = JSON.parse(fs.readFileSync(path.join(buysDir, 'b2.json')));
  assert.equal(b2.status, 'rejected');
  assert.match(b2.reason, /insufficient funds/);

  // Special buy within funds: minVotes = max(ceil(150/50), ceil(0.3*5)) = 3.
  fs.writeFileSync(path.join(buysDir, 'b3.json'), JSON.stringify({
    status: 'new', special: true, title: 'blender', details: 'for smoothies',
    price: 150, buyer: 'carol',
  }));
  await tick({ profileDir, logger, nowMs: b1.expiresAt + 120_000, postMessage });
  let b3 = JSON.parse(fs.readFileSync(path.join(buysDir, 'b3.json')));
  assert.equal(b3.status, 'polling');
  assert.equal(b3.minVotes, 3);
  // Fails: only 2 yays.
  await tick({
    profileDir, logger, nowMs: b3.expiresAt + 1, postMessage,
    fetchReactions: async () => [{ name: 'thumbsup', users: ['U1', 'U2'] }],
  });
  b3 = JSON.parse(fs.readFileSync(path.join(buysDir, 'b3.json')));
  assert.equal(b3.status, 'rejected');
  ledger = JSON.parse(fs.readFileSync(path.join(base, 'ledger.json')));
  assert.equal(accountBalance(ledger), 200, 'rejected buy spends nothing');

  // Proposal: add a thing. minVotes ceil(0.4*5)=2.
  const propDir = path.join(base, 'proposals');
  fs.mkdirSync(propDir, { recursive: true });
  fs.writeFileSync(path.join(propDir, 'p1.json'), JSON.stringify({
    status: 'new', proposedBy: 'dave',
    thing: { name: 'dish soap', type: 'household', value: 6 },
  }));
  const t1 = b3.expiresAt + 60_000;
  await tick({ profileDir, logger, nowMs: t1, postMessage });
  let p1 = JSON.parse(fs.readFileSync(path.join(propDir, 'p1.json')));
  assert.equal(p1.status, 'polling');
  assert.equal(p1.minVotes, 2);
  await tick({
    profileDir, logger, nowMs: p1.expiresAt + 1, postMessage,
    fetchReactions: async () => [{ name: 'thumbsup', users: ['U1', 'U3'] }],
  });
  p1 = JSON.parse(fs.readFileSync(path.join(propDir, 'p1.json')));
  assert.equal(p1.status, 'approved');
  const things = JSON.parse(fs.readFileSync(path.join(base, 'things.json')));
  assert.ok(things.some((t) => t.name === 'dish soap' && t.active === true));

  // status.md rendered with queue containing the approved unfulfilled buy.
  const status = fs.readFileSync(path.join(base, 'status.md'), 'utf-8');
  assert.ok(status.includes('paper towels × 4'));
  assert.ok(status.includes('$200.00'));

  // Fulfillment: agent marks fulfilled=true; queue empties next tick.
  b1.fulfilled = true;
  b1.fulfilledBy = 'alice';
  fs.writeFileSync(path.join(buysDir, 'b1.json'), JSON.stringify(b1));
  await tick({ profileDir, logger, nowMs: p1.expiresAt + 120_000, postMessage });
  const status2 = fs.readFileSync(path.join(base, 'status.md'), 'utf-8');
  assert.ok(!status2.includes('paper towels × 4 —'), 'fulfilled buy leaves queue');

  fs.rmSync(profileDir, { recursive: true, force: true });
}

it('tick integration', tickTests);
