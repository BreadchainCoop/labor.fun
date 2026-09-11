/**
 * Integration + structural tests for the POP mirror.
 *
 * Drives the real mirrorOrg() against an os.tmpdir() KB with a STUBBED
 * `pop task list` result — no network, no subprocess, no chain. Mirrors the
 * house style of src/integrations/github-project-sync.test.ts, and each test is
 * named for the bug it prevents.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import matter from 'gray-matter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listDigest } from '../digest.mjs';
import { mirrorOrg } from '../mirror.mjs';

const ORG = 'Argus';
const CHAIN = 100;
const ADDR = '0x451563aB9b5b4E8DFAA602F5E7890089eDf6Bf10';

const ROW = {
  ID: '5',
  Name: 'Write the docs',
  Status: 'Assigned',
  Assignee: 'argus_prime',
  Payout: '10 PT',
  Project: 'Docs',
  createdAt: '1775777635',
  releaseCount: 0,
  lastReleasedAt: 0,
};

const okList = (rows) => ({ ok: true, exitCode: 0, json: rows, error: null });
const okMembers = () => ({
  ok: true,
  exitCode: 0,
  json: { members: [{ username: 'argus_prime', address: ADDR }] },
  error: null,
});

let root;
let tasksDir;
let peopleDir;

const base = () => ({
  org: ORG,
  chainId: CHAIN,
  orgId: '0xabc',
  tasksDir,
  peopleDir,
  taskUrlBase: 'https://poa.box/t',
  syncedAt: '2026-08-03T00:00:00.000Z',
  membersResult: okMembers(),
});

const readDoc = (slug) => matter(fs.readFileSync(path.join(tasksDir, `${slug}.md`), 'utf-8'));
const listFiles = () => fs.readdirSync(tasksDir).filter((f) => f.endsWith('.md')).sort();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pop-mirror-'));
  tasksDir = path.join(root, 'tasks');
  peopleDir = path.join(root, 'people');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(peopleDir, { recursive: true });
  fs.writeFileSync(
    path.join(peopleDir, 'jane-doe.md'),
    `---\ntitle: Jane Doe\naddress: "${ADDR}"\n---\nHi.\n`,
  );
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('mirrorOrg — happy path', () => {
  it('writes one file per task and resolves the owner through the chain+KB bridge', async () => {
    const stats = await mirrorOrg({ ...base(), listResult: okList([ROW]) });
    expect(stats).toMatchObject({ written: 1, deleted: 0, complete: true, error: null });
    const doc = readDoc('POP-100-argus-5');
    expect(doc.data.owners).toEqual(['Jane Doe']);
    expect(doc.data.status).toBe('in_progress'); // Assigned -> in_progress
    expect(doc.data.pop_status).toBe('Assigned');
  });

  it('is idempotent — a second identical pull writes nothing', async () => {
    await mirrorOrg({ ...base(), listResult: okList([ROW]) });
    const stats = await mirrorOrg({ ...base(), listResult: okList([ROW]) });
    expect(stats).toMatchObject({ written: 0, unchanged: 1 });
  });

  it('rewrites when chain state actually moves', async () => {
    await mirrorOrg({ ...base(), listResult: okList([ROW]) });
    const moved = { ...ROW, Status: 'Completed' };
    const stats = await mirrorOrg({ ...base(), listResult: okList([moved]) });
    expect(stats.written).toBe(1);
    expect(readDoc('POP-100-argus-5').data.status).toBe('done');
  });

  it('creates the tasks dir when the KB has never had one', async () => {
    fs.rmSync(tasksDir, { recursive: true, force: true });
    const stats = await mirrorOrg({ ...base(), listResult: okList([ROW]) });
    expect(stats.written).toBe(1);
  });
});

describe('mirrorOrg — the delete pass is gated on a successful pull', () => {
  it('a FAILED task list never deletes anything (subgraph outage != empty org)', async () => {
    await mirrorOrg({ ...base(), listResult: okList([ROW]) });
    const before = listFiles();
    const stats = await mirrorOrg({
      ...base(),
      listResult: { ok: false, exitCode: 3, json: null, error: 'NETWORK_ERROR' },
    });
    expect(stats).toMatchObject({ complete: false, deleted: 0, tombstoned: 0 });
    expect(listFiles()).toEqual(before);
  });

  it('an exit-0-with-unparseable-stdout pull is a FAILURE, not an empty org', async () => {
    // This is the difference between "the org has no tasks" and "we could not
    // read the org" — conflating them is how a mirror deletes everything.
    await mirrorOrg({ ...base(), listResult: okList([ROW]) });
    const before = listFiles();
    const stats = await mirrorOrg({
      ...base(),
      listResult: { ok: false, exitCode: 0, json: null, error: 'stdout was not valid JSON' },
    });
    expect(stats.complete).toBe(false);
    expect(listFiles()).toEqual(before);
  });

  it('a genuinely empty org tombstones rather than deleting on the first miss', async () => {
    await mirrorOrg({ ...base(), listResult: okList([ROW]) });
    const stats = await mirrorOrg({ ...base(), listResult: okList([]) });
    expect(stats).toMatchObject({ tombstoned: 1, deleted: 0 });
    expect(readDoc('POP-100-argus-5').data.pop_missing_ticks).toBe(1);
  });

  it('deletes only after N consecutive complete pulls that omit the task', async () => {
    await mirrorOrg({ ...base(), listResult: okList([ROW]) });
    for (let i = 0; i < 2; i += 1) {
      const s = await mirrorOrg({ ...base(), listResult: okList([]), missingTicksBeforeDelete: 3 });
      expect(s.deleted).toBe(0);
    }
    const final = await mirrorOrg({
      ...base(),
      listResult: okList([]),
      missingTicksBeforeDelete: 3,
    });
    expect(final.deleted).toBe(1);
    expect(listFiles()).toEqual([]);
  });

  it('a reappearing task clears its tombstone counter', async () => {
    await mirrorOrg({ ...base(), listResult: okList([ROW]) });
    await mirrorOrg({ ...base(), listResult: okList([]) });
    expect(readDoc('POP-100-argus-5').data.pop_missing_ticks).toBe(1);
    await mirrorOrg({ ...base(), listResult: okList([ROW]) });
    expect(readDoc('POP-100-argus-5').data.pop_missing_ticks).toBe(0);
  });

  it('never touches a file outside its own chain+org prefix', async () => {
    // A hand-authored task and another org's mirror file must both survive a
    // sweep that deletes everything this org owns.
    fs.writeFileSync(path.join(tasksDir, 'TASK-001.md'), '---\ntitle: Mine\n---\nhand-authored\n');
    fs.writeFileSync(
      path.join(tasksDir, 'POP-42161-argus-5.md'),
      '---\npop_digest: x\n---\nother chain\n',
    );
    await mirrorOrg({ ...base(), listResult: okList([ROW]) });
    for (let i = 0; i < 3; i += 1) {
      await mirrorOrg({ ...base(), listResult: okList([]), missingTicksBeforeDelete: 3 });
    }
    expect(listFiles()).toEqual(['POP-42161-argus-5.md', 'TASK-001.md']);
  });
});

describe('mirrorOrg — human edits survive', () => {
  it('preserves a KB-owned field and body notes through a real merge', async () => {
    await mirrorOrg({ ...base(), listResult: okList([ROW]) });
    const file = path.join(tasksDir, 'POP-100-argus-5.md');
    const doc = matter(fs.readFileSync(file, 'utf-8'));
    doc.data.priority = 'high';
    doc.data.tags = [...doc.data.tags, 'my-tag'];
    fs.writeFileSync(file, matter.stringify(`${doc.content}\n## My notes\nkeep me\n`, doc.data));

    // Force the merge path by moving chain state.
    await mirrorOrg({ ...base(), listResult: okList([{ ...ROW, Status: 'Submitted' }]) });

    const after = matter(fs.readFileSync(file, 'utf-8'));
    expect(after.data.priority).toBe('high');
    expect(after.data.tags).toContain('my-tag');
    expect(after.content).toContain('keep me');
    expect(after.data.status).toBe('in_review'); // chain still wins on its own fields
  });

  it('does not duplicate the pop-synced tag across repeated merges', async () => {
    await mirrorOrg({ ...base(), listResult: okList([ROW]) });
    await mirrorOrg({ ...base(), listResult: okList([{ ...ROW, Payout: '11 PT' }]) });
    await mirrorOrg({ ...base(), listResult: okList([{ ...ROW, Payout: '12 PT' }]) });
    const tags = readDoc('POP-100-argus-5').data.tags;
    expect(tags.filter((t) => t === 'pop-synced')).toHaveLength(1);
  });

  it('does not clobber a human-set visibility', async () => {
    await mirrorOrg({ ...base(), listResult: okList([ROW]) });
    const file = path.join(tasksDir, 'POP-100-argus-5.md');
    const doc = matter(fs.readFileSync(file, 'utf-8'));
    doc.data.visibility = 'private';
    fs.writeFileSync(file, matter.stringify(doc.content, doc.data));
    await mirrorOrg({ ...base(), listResult: okList([{ ...ROW, Payout: '99 PT' }]) });
    expect(readDoc('POP-100-argus-5').data.visibility).toBe('private');
  });
});

describe('frontmatter contract', () => {
  // Pins the keys existing labor.fun consumers read. Changing any of these is
  // a breaking change for the reminder engine, the PM orchestrator or kb-ui.
  it('emits every TIER-1 key the KB task pipeline depends on', async () => {
    await mirrorOrg({ ...base(), listResult: okList([ROW]) });
    const fm = readDoc('POP-100-argus-5').data;
    for (const key of [
      'id',
      'title',
      'status',
      'owners',
      'project',
      'created_at',
      'deadline',
      'tags',
      'visibility',
      'editable_by',
      'priority',
    ]) {
      expect(fm, `missing KB key: ${key}`).toHaveProperty(key);
    }
    for (const key of ['pop_org', 'pop_chain_id', 'pop_task_id', 'pop_status', 'pop_url', 'pop_digest']) {
      expect(fm, `missing pop key: ${key}`).toHaveProperty(key);
    }
  });

  it('omits TIER-2 keys until a deep read has happened', async () => {
    // Emitting these with an empty default on a tier-1 write is what used to
    // wipe values a previous deep read had established: they are chain-owned,
    // so the merge overwrites unconditionally, and '' beat the real value.
    // `estimate` is optional in PmTask and loadPmTasksFromKb is explicitly
    // tolerant of missing fields, so absence is safe.
    await mirrorOrg({ ...base(), listResult: okList([ROW]) });
    const fm = readDoc('POP-100-argus-5').data;
    for (const key of ['estimate', 'pop_assignee_address', 'pop_difficulty']) {
      expect(fm, `tier-2 key leaked into a tier-1 write: ${key}`).not.toHaveProperty(key);
    }
  });

  it('stores a digest that matches what the planner will compute next tick', async () => {
    await mirrorOrg({ ...base(), listResult: okList([ROW]) });
    expect(readDoc('POP-100-argus-5').data.pop_digest).toBe(listDigest(ROW));
  });

  it('quotes hostile titles safely rather than breaking out of YAML', async () => {
    const nasty = { ...ROW, ID: '7', Name: 'x\n---\ninjected: true\ntitle: pwned' };
    await mirrorOrg({ ...base(), listResult: okList([nasty]) });
    const doc = readDoc('POP-100-argus-7');
    expect(doc.data.injected).toBeUndefined();
    expect(doc.data.title).toContain('injected: true');
  });
});

describe('structural: the mirror cannot write to the chain', () => {
  it('does not import the CLI wrapper, so it cannot spawn a pop subprocess', () => {
    // The KB->chain edge is an explicit intent QUEUE, never a diff. Enforcing
    // that here means the day someone "just adds a quick write", this fails.
    const src = fs.readFileSync(new URL('../mirror.mjs', import.meta.url), 'utf-8');
    expect(src).not.toMatch(/from\s+['"]\.\/cli\.mjs['"]/);
    expect(src).not.toMatch(/child_process/);
    expect(src).not.toMatch(/execFile|spawn\(/);
  });
});
