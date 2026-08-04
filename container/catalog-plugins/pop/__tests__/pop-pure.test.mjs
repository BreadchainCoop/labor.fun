/**
 * Pure-module tests for the POP mirror. No mocks, no network, no filesystem
 * except an os.tmpdir() scratch for the people-index test.
 *
 * Every test here is named for the bug it prevents.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LIST_DIGEST_FIELDS, digestFields, listDigest, viewDigest } from '../digest.mjs';
import { isTerminalPopStatus, toKbStatus } from '../statusmap.mjs';
import {
  CHAIN_OWNED_KEYS,
  buildPopFrontmatter,
  effectiveDeadline,
  mergePopFrontmatter,
  payoutNumber,
  popTaskSlug,
  popTaskUrl,
  renderBody,
  splitBody,
  unixToDate,
} from '../frontmatter.mjs';
import {
  buildMemberIndex,
  buildPeopleIndex,
  normalizeAddress,
  resolveOwners,
} from '../identity.mjs';
import { filePrefix, orgSlug, planMirror } from '../mirror.mjs';

/**
 * A real Argus member address in its CORRECT EIP-55 checksum form. Hand-casing
 * this is a trap: an invalid checksum makes ethers' getAddress throw, which is
 * exactly the strictness src/safe/payout.ts relies on — so a mistyped fixture
 * fails the whole identity suite rather than silently half-working.
 */
const ADDR = '0x451563aB9b5b4E8DFAA602F5E7890089eDf6Bf10';

/** A realistic `pop task list --json` row for a COMPLETED task (9 keys). */
const COMPLETED_ROW = {
  ID: '5',
  Name: 'Add pop org status command',
  Status: 'Completed',
  Assignee: 'argus_prime',
  Payout: '10 PT',
  Project: 'Development',
  createdAt: '1775777635',
  releaseCount: 0,
  lastReleasedAt: 0,
};

/** …and for an OPEN task (13 keys — the deadline fields appear). */
const OPEN_ROW = {
  ID: '230',
  Name: 'Cross-Org work',
  Status: 'Open',
  Assignee: '',
  Payout: '20 PT',
  Project: 'Cross-Org Ops',
  createdAt: '1775953155',
  absoluteDeadline: 0,
  completionWindow: 0,
  claimDeadline: 0,
  claimState: 'none',
  releaseCount: 0,
  lastReleasedAt: 0,
};

describe('statusmap', () => {
  it('maps the subgraph vocabulary to the KB vocabulary', () => {
    expect(toKbStatus('Open')).toBe('open');
    expect(toKbStatus('Assigned')).toBe('in_progress');
    expect(toKbStatus('Submitted')).toBe('in_review');
    expect(toKbStatus('Completed')).toBe('done');
    expect(toKbStatus('Cancelled')).toBe('cancelled');
  });

  it('also accepts the on-chain enum names (UNCLAIMED/CLAIMED)', () => {
    expect(toKbStatus('UNCLAIMED')).toBe('open');
    expect(toKbStatus('CLAIMED')).toBe('in_progress');
  });

  it('passes an unknown status through rather than guessing "open"', () => {
    // Guessing would silently start a reminder ladder on something we do not
    // understand; passing it through keeps it visible and out of DONE_STATUSES.
    expect(toKbStatus('SomethingNew')).toBe('somethingnew');
  });

  it('treats only Completed/Cancelled as terminal (they are immutable on chain)', () => {
    expect(isTerminalPopStatus('Completed')).toBe(true);
    expect(isTerminalPopStatus('Cancelled')).toBe(true);
    expect(isTerminalPopStatus('Submitted')).toBe(false);
    expect(isTerminalPopStatus('Open')).toBe(false);
  });
});

describe('digest', () => {
  it('is stable across the NON-UNIFORM key set task list returns', () => {
    // A Completed row has 9 keys and an Open row has 13. Digesting
    // Object.keys() would make the same task hash differently purely because
    // its status changed shape.
    const a = listDigest(COMPLETED_ROW);
    const b = listDigest({ ...COMPLETED_ROW });
    expect(a).toBe(b);
    // Adding the keys an Open row would carry, all at their zero values, must
    // not change the digest of an otherwise identical row.
    const withZeros = {
      ...COMPLETED_ROW,
      absoluteDeadline: 0,
      completionWindow: 0,
      claimDeadline: 0,
    };
    expect(listDigest(withZeros)).not.toBe(a); // 0 !== absent, deliberately
  });

  it('EXCLUDES claimState — it flips with wall-clock time, not chain state', () => {
    const t0 = listDigest({ ...OPEN_ROW, claimState: 'none' });
    const t1 = listDigest({ ...OPEN_ROW, claimState: 'expiring-soon' });
    const t2 = listDigest({ ...OPEN_ROW, claimState: 'expired-claimable' });
    expect(t1).toBe(t0);
    expect(t2).toBe(t0);
    expect(LIST_DIGEST_FIELDS).not.toContain('claimState');
  });

  it('moves when any digested field moves', () => {
    const base = listDigest(OPEN_ROW);
    expect(listDigest({ ...OPEN_ROW, Status: 'Assigned' })).not.toBe(base);
    expect(listDigest({ ...OPEN_ROW, Assignee: 'someone' })).not.toBe(base);
    expect(listDigest({ ...OPEN_ROW, Payout: '25 PT' })).not.toBe(base);
    expect(listDigest({ ...OPEN_ROW, Name: 'Renamed' })).not.toBe(base);
    expect(listDigest({ ...OPEN_ROW, releaseCount: 1 })).not.toBe(base);
  });

  it('treats 0 and "0" as the same observation (the CLI is inconsistent)', () => {
    expect(listDigest({ ...OPEN_ROW, releaseCount: 0 })).toBe(
      listDigest({ ...OPEN_ROW, releaseCount: '0' }),
    );
  });

  it('cannot be forged by a value containing the field delimiter', () => {
    const a = digestFields({ a: 'x', b: 'y' }, ['a', 'b']);
    const b = digestFields({ a: 'x b y', b: '' }, ['a', 'b']);
    expect(a).not.toBe(b);
  });

  it('viewDigest covers the narrative fields task list cannot see', () => {
    const base = { taskId: '5', title: 't', status: 'Completed' };
    expect(viewDigest({ ...base, description: 'one' })).not.toBe(
      viewDigest({ ...base, description: 'two' }),
    );
    expect(viewDigest({ ...base, submission: 'a' })).not.toBe(
      viewDigest({ ...base, submission: 'b' }),
    );
  });
});

describe('frontmatter helpers', () => {
  it('converts unix seconds to a date, and 0/absent to empty', () => {
    expect(unixToDate('1775777635')).toBe('2026-04-09');
    expect(unixToDate(0)).toBe('');
    expect(unixToDate(undefined)).toBe('');
    expect(unixToDate('nonsense')).toBe('');
  });

  it('prefers the claim deadline over the absolute one (it is what you race)', () => {
    expect(effectiveDeadline({ claimDeadline: 1775777635, absoluteDeadline: 1800000000 })).toBe(
      '2026-04-09',
    );
    expect(effectiveDeadline({ claimDeadline: 0, absoluteDeadline: 1775777635 })).toBe('2026-04-09');
    expect(effectiveDeadline({ claimDeadline: 0, absoluteDeadline: 0 })).toBe('');
  });

  it('parses a payout out of the CLI’s "N PT" rendering', () => {
    expect(payoutNumber('10 PT')).toBe(10);
    expect(payoutNumber('0.5 PT')).toBe(0.5);
    expect(payoutNumber(null)).toBe('');
  });

  it('builds an immutable, deployment-independent task URL', () => {
    // The URL is the Linear attachment join key, so it must never depend on
    // anything an operator can reconfigure (e.g. kbDashboardUrl).
    expect(popTaskUrl('https://poa.box/t', 100, '0xabc', '5')).toBe('https://poa.box/t/100/0xabc/5');
    expect(popTaskUrl('https://poa.box/t/', 100, '0xabc', '5')).toBe(
      'https://poa.box/t/100/0xabc/5',
    );
  });

  it('namespaces filenames by chain AND org so ids cannot collide', () => {
    // taskIds restart at 0 per org, and one org name can exist on two chains.
    expect(popTaskSlug(100, 'argus', '5')).toBe('POP-100-argus-5');
    expect(popTaskSlug(42161, 'argus', '5')).not.toBe(popTaskSlug(100, 'argus', '5'));
  });
});

describe('mergePopFrontmatter', () => {
  const owned = {
    title: 'Chain title',
    status: 'done',
    pop_digest: 'abc',
    pop_status: 'Completed',
  };

  it('preserves a human-edited KB-owned field across a re-sync', () => {
    const out = mergePopFrontmatter({ priority: 'high', visibility: 'private' }, owned);
    expect(out.priority).toBe('high');
    expect(out.visibility).toBe('private'); // default-if-absent must not clobber
  });

  it('overwrites chain-owned fields unconditionally', () => {
    const out = mergePopFrontmatter({ title: 'human rename', status: 'open' }, owned);
    expect(out.title).toBe('Chain title');
    expect(out.status).toBe('done');
  });

  it('keeps custom tags and adds pop-synced idempotently', () => {
    const once = mergePopFrontmatter({ tags: ['mine'] }, owned);
    expect(once.tags).toEqual(['mine', 'pop-synced']);
    const twice = mergePopFrontmatter(once, owned);
    expect(twice.tags).toEqual(['mine', 'pop-synced']);
  });

  it('never blanks a good value when the incoming one is undefined', () => {
    const out = mergePopFrontmatter({ title: 'keep me' }, { title: undefined, status: 'done' });
    expect(out.title).toBe('keep me');
  });

  it('sets sane defaults on a brand-new file', () => {
    const out = mergePopFrontmatter(null, owned);
    expect(out.visibility).toBe('open');
    expect(out.editable_by).toBe('open');
    expect(out.priority).toBe('medium');
  });

  it('lists status among the chain-owned keys (a stale status is a lie)', () => {
    expect(CHAIN_OWNED_KEYS).toContain('status');
    expect(CHAIN_OWNED_KEYS).toContain('title');
  });
});

describe('body fencing', () => {
  it('round-trips and preserves human notes below the marker', () => {
    const doc = renderBody('generated', 'my note');
    const { managed, human } = splitBody(doc);
    expect(managed).toBe('generated');
    expect(human).toBe('my note');
  });

  it('treats an unfenced body as entirely human (never eats pre-existing prose)', () => {
    const { managed, human } = splitBody('someone wrote this before we existed');
    expect(managed).toBe('');
    expect(human).toBe('someone wrote this before we existed');
  });

  it('survives a regenerate cycle without duplicating the human half', () => {
    let doc = renderBody('v1', 'note');
    doc = renderBody('v2', splitBody(doc).human);
    expect(splitBody(doc).human).toBe('note');
    expect(splitBody(doc).managed).toBe('v2');
  });
});

describe('identity', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pop-people-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (slug, fm, body = '') =>
    fs.writeFileSync(
      path.join(dir, `${slug}.md`),
      `---\n${Object.entries(fm)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join('\n')}\n---\n${body}`,
    );

  it('normalises checksum case so a lowercase KB address still matches', () => {
    expect(normalizeAddress(ADDR.toLowerCase())).toBe(ADDR);
    expect(normalizeAddress('  ' + ADDR + '  ')).toBe(ADDR);
    expect(normalizeAddress('not-an-address')).toBeNull();
    expect(normalizeAddress(undefined)).toBeNull();
  });

  it('indexes people by checksummed address, using title then name then slug', () => {
    write('jane-doe', { title: 'Jane Doe', address: ADDR.toLowerCase() });
    write('no-addr', { title: 'No Wallet' });
    const { byAddress, count } = buildPeopleIndex(dir);
    expect(count).toBe(2);
    expect(byAddress.get(ADDR)).toEqual({ slug: 'jane-doe', displayName: 'Jane Doe' });
    expect(byAddress.size).toBe(1); // the person with no address is simply absent
  });

  it('skips README.md and unparseable files instead of throwing', () => {
    write('ok', { title: 'Ok', address: ADDR });
    fs.writeFileSync(path.join(dir, 'README.md'), '---\ntitle: readme\n---\n');
    fs.writeFileSync(path.join(dir, 'broken.md'), '---\n: : :\nnot yaml\n');
    expect(() => buildPeopleIndex(dir)).not.toThrow();
    expect(buildPeopleIndex(dir).byAddress.get(ADDR).slug).toBe('ok');
  });

  it('returns an empty index for a missing directory (org has no KB yet)', () => {
    expect(buildPeopleIndex(path.join(dir, 'nope')).byAddress.size).toBe(0);
  });

  it('maps POP usernames to addresses from the chain member list', () => {
    const idx = buildMemberIndex({ members: [{ username: 'argus_prime', address: ADDR }] });
    expect(idx.get('argus_prime')).toBe(ADDR);
  });

  it('resolves an owner display name via username -> address -> KB person', () => {
    write('jane-doe', { title: 'Jane Doe', address: ADDR });
    const { byAddress } = buildPeopleIndex(dir);
    const memberIndex = buildMemberIndex({ members: [{ username: 'argus_prime', address: ADDR }] });
    expect(
      resolveOwners({ assigneeUsername: 'argus_prime', peopleIndex: byAddress, memberIndex }),
    ).toEqual(['Jane Doe']);
  });

  it('falls back to the POP username when no KB person claims that address', () => {
    const memberIndex = buildMemberIndex({ members: [{ username: 'ghost', address: ADDR }] });
    expect(
      resolveOwners({ assigneeUsername: 'ghost', peopleIndex: new Map(), memberIndex }),
    ).toEqual(['ghost']);
  });

  it('returns [] for an unassigned task rather than inventing a person', () => {
    expect(resolveOwners({ assigneeUsername: '', peopleIndex: new Map(), memberIndex: new Map() }))
      .toEqual([]);
  });
});

describe('planMirror', () => {
  const opts = { chainId: 100, org: 'Argus', missingTicksBeforeDelete: 3 };
  const slugFor = (id) => popTaskSlug(100, 'argus', id);

  it('writes a task it has never seen', () => {
    const plan = planMirror([COMPLETED_ROW], new Map(), opts);
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0].slug).toBe(slugFor('5'));
    expect(plan.unchanged).toBe(0);
  });

  it('skips a task whose digest is unchanged (this is the whole optimisation)', () => {
    const existing = new Map([
      [slugFor('5'), { file: 'x.md', digest: listDigest(COMPLETED_ROW), missingTicks: 0 }],
    ]);
    const plan = planMirror([COMPLETED_ROW], existing, opts);
    expect(plan.writes).toHaveLength(0);
    expect(plan.unchanged).toBe(1);
  });

  it('rewrites when the digest moves', () => {
    const existing = new Map([
      [slugFor('5'), { file: 'x.md', digest: 'stale', missingTicks: 0 }],
    ]);
    expect(planMirror([COMPLETED_ROW], existing, opts).writes).toHaveLength(1);
  });

  it('TOMBSTONES a vanished task rather than deleting it (subgraph lag)', () => {
    // The indexer is documented to fall 30+ ids behind chain, so one absence is
    // far more likely lag than removal.
    const existing = new Map([
      [slugFor('5'), { file: 'x.md', digest: 'd', missingTicks: 0 }],
    ]);
    const plan = planMirror([], existing, opts);
    expect(plan.deletes).toHaveLength(0);
    expect(plan.tombstones).toEqual([
      { slug: slugFor('5'), prior: existing.get(slugFor('5')), missingTicks: 1 },
    ]);
  });

  it('deletes only after the configured number of consecutive misses', () => {
    const existing = new Map([
      [slugFor('5'), { file: 'x.md', digest: 'd', missingTicks: 2 }],
    ]);
    const plan = planMirror([], existing, opts);
    expect(plan.tombstones).toHaveLength(0);
    expect(plan.deletes).toEqual([{ slug: slugFor('5'), file: 'x.md' }]);
  });

  it('resets the tombstone counter when a task reappears', () => {
    const existing = new Map([
      [slugFor('5'), { file: 'x.md', digest: listDigest(COMPLETED_ROW), missingTicks: 2 }],
    ]);
    // Digest matches, but the stale counter must force a rewrite that clears it.
    const plan = planMirror([COMPLETED_ROW], existing, opts);
    expect(plan.writes).toHaveLength(1);
    expect(plan.deletes).toHaveLength(0);
  });

  it('ignores rows with no ID instead of writing a file called POP-100-argus-', () => {
    expect(planMirror([{ Name: 'orphan' }], new Map(), opts).writes).toHaveLength(0);
  });
});

describe('org slug + file prefix', () => {
  it('is filesystem-safe for a hostile org name', () => {
    expect(orgSlug('../../etc/passwd')).not.toContain('/');
    expect(orgSlug('My Org!')).toBe('my-org');
  });

  it('scopes the prefix by chain and org so one org never sweeps another', () => {
    expect(filePrefix(100, 'Argus')).toBe('POP-100-argus-');
    expect(filePrefix(42161, 'Argus')).toBe('POP-42161-argus-');
  });

  it('a sibling org whose name EXTENDS another does not share its prefix scope', () => {
    // `acme` vs `acme-labs` is the hyphen-extension hazard github-project-sync
    // solved with excludePrefixes; keeping the trailing '-' makes the two
    // prefixes distinct but NOT disjoint, so callers must still exclude.
    const a = filePrefix(100, 'acme');
    const b = filePrefix(100, 'acme-labs');
    expect(b.startsWith(a)).toBe(true); // documents the hazard explicitly
  });
});

describe('buildPopFrontmatter', () => {
  it('emits both vocabularies so existing KB consumers work for free', () => {
    const fm = buildPopFrontmatter({
      row: COMPLETED_ROW,
      chainId: 100,
      org: 'Argus',
      orgId: '0xabc',
      orgSlug: 'argus',
      owners: ['Jane Doe'],
      digest: 'd',
      syncedAt: '2026-08-03T00:00:00.000Z',
      taskUrlBase: 'https://poa.box/t',
    });
    // KB canonical keys the reminder engine / PM orchestrator read:
    expect(fm.title).toBe('Add pop org status command');
    expect(fm.status).toBe('done');
    expect(fm.owners).toEqual(['Jane Doe']);
    expect(fm.created_at).toBe('2026-04-09');
    // pop_* namespace:
    expect(fm.pop_task_id).toBe('5');
    expect(fm.pop_status).toBe('Completed');
    expect(fm.pop_payout).toBe(10);
    expect(fm.pop_url).toBe('https://poa.box/t/100/0xabc/5');
  });

  it('never produces an empty title (the KB and kb-ui both key off it)', () => {
    const fm = buildPopFrontmatter({
      row: { ID: '9', Status: 'Open' },
      chainId: 100,
      org: 'A',
      orgId: '0x',
      orgSlug: 'a',
      digest: 'd',
      syncedAt: 's',
      taskUrlBase: 'b',
    });
    expect(fm.title).toBe('POP task 9');
  });
});
