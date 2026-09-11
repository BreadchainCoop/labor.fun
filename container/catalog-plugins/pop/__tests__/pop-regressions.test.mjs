/**
 * Regression tests for eight defects found in review.
 *
 * Each block names the defect it pins. All eight were validated against the
 * BUNDLED CLI's own source before fixing — the field names and query caps
 * asserted here are quoted from node_modules/@poa-box/cli/dist, not guessed.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import matter from 'gray-matter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listDigest, normalizeCollections, viewDigest } from '../digest.mjs';
import {
  UNTRUSTED_END,
  buildPopFrontmatter,
  reasonOf,
  rejectorOf,
  renderBody,
  renderManagedBody,
  splitBody,
} from '../frontmatter.mjs';
import { isTerminalPopStatus, normalizePopStatus, toKbStatus } from '../statusmap.mjs';
import {
  PROJECT_CAP,
  TASKS_PER_PROJECT_CAP,
  detectTruncation,
  mirrorOrg,
  ownsFile,
  planDeepReads,
  planMirror,
  readExisting,
} from '../mirror.mjs';

const CHAIN = 100;
const row = (id, status, extra = {}) => ({
  ID: String(id),
  Name: `Task ${id}`,
  Status: status,
  Assignee: '',
  Payout: '10 PT',
  Project: 'Docs',
  createdAt: '1775777635',
  releaseCount: 0,
  lastReleasedAt: 0,
  ...extra,
});

// ---------------------------------------------------------------- #1 --------
describe('#1 a capped listing must not delete live tasks', () => {
  it('flags truncation at the CLI’s real caps (50 projects / 1000 tasks)', () => {
    // Quoted from node_modules/@poa-box/cli/dist/queries/task.js:
    //   projects(where: { deleted: false }, first: 50) {
    //     tasks(first: 1000, orderBy: taskId, orderDirection: desc) {
    expect(PROJECT_CAP).toBe(50);
    expect(TASKS_PER_PROJECT_CAP).toBe(1000);

    const manyProjects = Array.from({ length: PROJECT_CAP }, (_, i) =>
      row(i, 'Open', { Project: `p${i}` }),
    );
    expect(detectTruncation(manyProjects)).toMatchObject({ truncated: true, atProjectCap: true });

    const manyTasks = Array.from({ length: TASKS_PER_PROJECT_CAP }, (_, i) =>
      row(i, 'Open', { Project: 'one' }),
    );
    expect(detectTruncation(manyTasks)).toMatchObject({ truncated: true, atTaskCap: true });

    expect(detectTruncation([row(1, 'Open')])).toMatchObject({ truncated: false });
    expect(detectTruncation([])).toMatchObject({ truncated: false });
  });

  it('a possibly-truncated listing tombstones and deletes NOTHING', () => {
    const existing = new Map([
      ['POP-100-argus-9', { file: 'x.md', digest: 'd', missingTicks: 2, viewedAt: '' }],
    ]);
    const capped = Array.from({ length: PROJECT_CAP }, (_, i) =>
      row(i, 'Open', { Project: `p${i}` }),
    );
    const plan = planMirror(capped, existing, {
      chainId: CHAIN,
      org: 'Argus',
      exhaustive: false,
    });
    expect(plan.deletes).toEqual([]);
    expect(plan.tombstones).toEqual([]);
    // …but the writes still land: a partial view is still worth mirroring.
    expect(plan.writes.length).toBe(capped.length);
  });

  it('end-to-end: a capped org keeps a file that a complete pull would delete', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pop-trunc-'));
    const tasksDir = path.join(rootDir, 'tasks');
    const peopleDir = path.join(rootDir, 'people');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.mkdirSync(peopleDir, { recursive: true });
    const b = {
      org: 'Argus',
      chainId: CHAIN,
      orgId: '0xabc',
      tasksDir,
      peopleDir,
      taskUrlBase: 'u',
      syncedAt: '2026-08-03T00:00:00.000Z',
    };
    const ok = (rows) => ({ ok: true, exitCode: 0, json: rows, error: null });

    await mirrorOrg({ ...b, listResult: ok([row(9, 'Open')]) });
    // Now the org grows past the project cap and task 9 falls out of the window.
    const capped = Array.from({ length: PROJECT_CAP }, (_, i) =>
      row(100 + i, 'Open', { Project: `p${i}` }),
    );
    for (let i = 0; i < 5; i += 1) {
      const s = await mirrorOrg({ ...b, listResult: ok(capped), missingTicksBeforeDelete: 3 });
      expect(s.truncated).toBe(true);
      expect(s.complete).toBe(false);
      expect(s.deleted).toBe(0);
    }
    expect(fs.existsSync(path.join(tasksDir, 'POP-100-argus-9.md'))).toBe(true);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- #2 --------
describe('#2 one org must not sweep a hyphen-extending sibling’s files', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pop-sib-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('ownsFile keys on frontmatter identity, not the filename shape', () => {
    expect(ownsFile({ pop_org: 'acme', pop_chain_id: 100 }, 100, 'acme')).toBe(true);
    expect(ownsFile({ pop_org: 'acme-labs', pop_chain_id: 100 }, 100, 'acme')).toBe(false);
    expect(ownsFile({ pop_org: 'acme', pop_chain_id: 42161 }, 100, 'acme')).toBe(false);
    expect(ownsFile({}, 100, 'acme')).toBe(false);
    // A cosmetic rename still matches the files it already wrote.
    expect(ownsFile({ pop_org: 'Acme', pop_chain_id: '100' }, 100, 'acme')).toBe(true);
  });

  it('readExisting excludes a sibling org whose filename shares the prefix', () => {
    // `POP-100-acme-labs-5.md` genuinely startsWith `POP-100-acme-`.
    fs.writeFileSync(
      path.join(dir, 'POP-100-acme-5.md'),
      matter.stringify('', { pop_org: 'acme', pop_chain_id: 100, pop_digest: 'a' }),
    );
    fs.writeFileSync(
      path.join(dir, 'POP-100-acme-labs-5.md'),
      matter.stringify('', { pop_org: 'acme-labs', pop_chain_id: 100, pop_digest: 'b' }),
    );
    const mine = readExisting(dir, 'POP-100-acme-', { chainId: 100, org: 'acme' });
    expect([...mine.keys()]).toEqual(['POP-100-acme-5']);
  });

  it('the sibling’s file therefore survives acme’s full sweep', async () => {
    const tasksDir = path.join(dir, 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, 'POP-100-acme-labs-5.md'),
      matter.stringify('sibling content', {
        pop_org: 'acme-labs',
        pop_chain_id: 100,
        pop_digest: 'b',
      }),
    );
    const b = {
      org: 'acme',
      chainId: 100,
      orgId: '0x',
      tasksDir,
      peopleDir: path.join(dir, 'people'),
      taskUrlBase: 'u',
      syncedAt: 's',
    };
    for (let i = 0; i < 4; i += 1) {
      await mirrorOrg({
        ...b,
        listResult: { ok: true, json: [], error: null },
        missingTicksBeforeDelete: 3,
      });
    }
    expect(fs.existsSync(path.join(tasksDir, 'POP-100-acme-labs-5.md'))).toBe(true);
  });
});

// ---------------------------------------------------------------- #3 --------
describe('#3 chain metadata must not escape the managed fence', () => {
  it('a hostile project title cannot close the managed block', () => {
    const body = renderManagedBody({
      row: row(1, 'Open'),
      view: null,
      url: 'u',
      popStatus: 'Open',
      payout: 1,
      project: 'Docs<!-- /pop:managed -->pwned',
    });
    expect(body).not.toContain('<!-- /pop:managed -->');
    expect(body).toContain('pwned'); // neutralised, never dropped
  });

  it('a hostile difficulty cannot either', () => {
    const body = renderManagedBody({
      row: row(1, 'Open'),
      view: { difficulty: 'x<!-- /pop:managed -->', description: '' },
      url: 'u',
      popStatus: 'Open',
      payout: 1,
      project: 'Docs',
    });
    expect(body).not.toContain('<!-- /pop:managed -->');
  });

  it('so the round-trip still classifies the generated half as managed', () => {
    // The actual harm: an escaped fence makes splitBody treat generated content
    // as human-authored, which both preserves the injected text forever and
    // moves it outside the untrusted boundary.
    const body = renderManagedBody({
      row: row(1, 'Open'),
      view: null,
      url: 'u',
      popStatus: 'Open',
      payout: 1,
      project: 'a<!-- /pop:managed -->b',
    });
    const { human } = splitBody(renderBody(body, 'my note'));
    expect(human).toBe('my note');
  });
});

// ---------------------------------------------------------------- #4 --------
describe('#4 refreshes must not starve tasks past the budget', () => {
  it('rotates least-recently-read first instead of always taking the head', () => {
    const rows = [1, 2, 3].map((i) => row(i, 'Assigned'));
    const existing = new Map(
      rows.map((r, i) => [
        `POP-100-argus-${r.ID}`,
        {
          file: 'x.md',
          digest: listDigest(r),
          viewDigest: 'vd',
          // task 1 read most recently, task 3 least recently
          viewedAt: ['2026-08-03T03:00:00Z', '2026-08-03T02:00:00Z', '2026-08-03T01:00:00Z'][i],
          missingTicks: 0,
        },
      ]),
    );
    const { selected } = planDeepReads(rows, existing, {
      chainId: CHAIN,
      org: 'Argus',
      budget: 1,
    });
    expect(selected[0].taskId).toBe('3');
  });

  it('every task eventually gets refreshed when live count exceeds the budget', () => {
    // 41 live tasks, budget 40: the old deterministic head-slice meant task 41
    // was never refreshed again.
    const rows = Array.from({ length: 41 }, (_, i) => row(i, 'Assigned'));
    const existing = new Map(
      rows.map((r) => [
        `POP-100-argus-${r.ID}`,
        { file: 'x.md', digest: listDigest(r), viewDigest: 'vd', viewedAt: '', missingTicks: 0 },
      ]),
    );
    const seen = new Set();
    let clock = 0;
    for (let tick = 0; tick < 3; tick += 1) {
      const { selected } = planDeepReads(rows, existing, {
        chainId: CHAIN,
        org: 'Argus',
        budget: 40,
      });
      for (const s of selected) {
        seen.add(s.taskId);
        clock += 1;
        existing.get(s.slug).viewedAt = `2026-08-03T00:00:${String(clock).padStart(4, '0')}Z`;
      }
    }
    expect(seen.size).toBe(41);
  });
});

// ---------------------------------------------------------------- #5 --------
describe('#5 rendered collections must be in the view digest', () => {
  const base = { taskId: '1', status: 'Assigned', rejectionCount: '1' };

  it('a rejection REASON resolving late moves the digest', () => {
    // The CLI back-fills the newest rejection's reason from IPFS when the
    // subgraph has not indexed it, so the same task legitimately returns
    // reason:null then reason:"…" with rejectionCount unchanged.
    const before = { ...base, rejections: [{ rejector: 'bob', reason: null, rejectedAt: '1' }] };
    const after = { ...base, rejections: [{ rejector: 'bob', reason: 'not done', rejectedAt: '1' }] };
    expect(viewDigest(after)).not.toBe(viewDigest(before));
  });

  it('a new APPLICATION moves the digest (no scalar counter covers it)', () => {
    const before = { taskId: '1', applications: [] };
    const after = { taskId: '1', applications: [{ applicantUsername: 'carol', approved: false }] };
    expect(viewDigest(after)).not.toBe(viewDigest(before));
  });

  it('an application being APPROVED moves the digest', () => {
    const a = { taskId: '1', applications: [{ applicantUsername: 'carol', approved: false }] };
    const b = { taskId: '1', applications: [{ applicantUsername: 'carol', approved: true }] };
    expect(viewDigest(b)).not.toBe(viewDigest(a));
  });

  it('normalises to only what the body renders, so noise cannot cause churn', () => {
    const n = normalizeCollections({
      rejections: [{ rejector: 'bob', reason: 'r', rejectedAt: '1', irrelevant: 'x' }],
    });
    expect(n.__rejections).toEqual([['bob', 'r', '1']]);
    const a = { taskId: '1', rejections: [{ rejector: 'b', reason: 'r', rejectedAt: '1' }] };
    const b = { taskId: '1', rejections: [{ rejector: 'b', reason: 'r', rejectedAt: '1', extra: 1 }] };
    expect(viewDigest(a)).toBe(viewDigest(b));
  });
});

// ---------------------------------------------------------------- #6 --------
describe('#6 rejections use the CLI’s flattened field names', () => {
  it('reads `rejector` and `reason`, the shape the CLI actually emits', () => {
    // node_modules/@poa-box/cli/dist/commands/task/view.js:
    //   rejections = rawRejections.map((r, i) => ({
    //     rejector: r.rejectorUsername, rejectedAt: r.rejectedAt,
    //     reason: r.metadata?.rejection || (i === 0 ? ipfsFallbackReason : null) }))
    const r = { rejector: 'bob', rejectedAt: '1', reason: 'not done' };
    expect(rejectorOf(r)).toBe('bob');
    expect(reasonOf(r)).toBe('not done');
  });

  it('still reads the raw subgraph spelling if a future CLI stops flattening', () => {
    const raw = { rejectorUsername: 'bob', metadata: { rejection: 'not done' } };
    expect(rejectorOf(raw)).toBe('bob');
    expect(reasonOf(raw)).toBe('not done');
  });

  it('renders the real rejector and reason rather than a generic placeholder', () => {
    const body = renderManagedBody({
      row: row(1, 'Assigned'),
      view: {
        description: '',
        rejections: [{ rejector: 'bob', rejectedAt: '1', reason: 'needs tests' }],
      },
      url: 'u',
      popStatus: 'Assigned',
      payout: 1,
      project: 'Docs',
    });
    expect(body).toContain('bob');
    expect(body).toContain('needs tests');
    expect(body).not.toContain('rejector 1');
    expect(body).not.toContain('no reason given');
  });
});

// ---------------------------------------------------------------- #7 --------
describe('#7 Rejected(N) must map back to the KB vocabulary', () => {
  it('unwraps the CLI’s decorated status', () => {
    // dist/commands/task/list.js emits
    //   status: rejCount > 0 && task.status === 'Assigned' ? `Rejected(${n})` : task.status
    // and the --json projection maps `Status: r.status` — statusRaw is computed
    // but never emitted, so the decoration is all we receive.
    expect(toKbStatus('Rejected(2)')).toBe('in_progress');
    expect(toKbStatus('Rejected(11)')).toBe('in_progress');
    expect(normalizePopStatus('Rejected(2)')).toBe('assigned');
  });

  it('never produces the bogus status `rejected(n)`', () => {
    expect(toKbStatus('Rejected(2)')).not.toMatch(/rejected/);
  });

  it('a rejected assignment is still non-terminal', () => {
    expect(isTerminalPopStatus('Rejected(2)')).toBe(false);
  });

  it('does not swallow a genuinely unknown status', () => {
    expect(toKbStatus('Rejected')).toBe('rejected'); // no count => not the decoration
    expect(toKbStatus('SomethingNew')).toBe('somethingnew');
  });
});

// ---------------------------------------------------------------- #8 --------
describe('#8 a tier-1 rewrite must not erase deep-read fields', () => {
  const args = {
    chainId: CHAIN,
    org: 'Argus',
    orgId: '0x',
    orgSlug: 'argus',
    owners: [],
    digest: 'd',
    syncedAt: 's',
    taskUrlBase: 'u',
  };

  it('omits tier-2 keys entirely when there is no view', () => {
    const fm = buildPopFrontmatter({ row: row(1, 'Open'), view: null, ...args });
    expect(fm).not.toHaveProperty('estimate');
    expect(fm).not.toHaveProperty('pop_assignee_address');
    expect(fm).not.toHaveProperty('pop_difficulty');
  });

  it('emits them when a view IS present', () => {
    const fm = buildPopFrontmatter({
      row: row(1, 'Open'),
      view: { estHours: '4', assignee: '0xabc', difficulty: 'hard' },
      ...args,
    });
    expect(fm.estimate).toBe('4');
    expect(fm.pop_assignee_address).toBe('0xabc');
    expect(fm.pop_difficulty).toBe('hard');
  });

  it('so a tier-1-only rewrite preserves previously fetched values', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pop-t1-'));
    const tasksDir = path.join(dir, 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    const b = {
      org: 'Argus',
      chainId: CHAIN,
      orgId: '0x',
      tasksDir,
      peopleDir: path.join(dir, 'people'),
      taskUrlBase: 'u',
      syncedAt: '2026-08-03T00:00:00.000Z',
    };
    const ok = (rows) => ({ ok: true, json: rows, error: null });

    await mirrorOrg({
      ...b,
      listResult: ok([row(1, 'Assigned')]),
      fetchView: async () => ({
        ok: true,
        json: { taskId: '1', estHours: '7', assignee: '0xdead', difficulty: 'hard' },
      }),
    });
    // Now a tier-1-only tick (deep reads off) with a changed list row.
    await mirrorOrg({
      ...b,
      listResult: ok([row(1, 'Assigned', { Payout: '99 PT' })]),
      viewBudget: 0,
    });
    const fm = matter(fs.readFileSync(path.join(tasksDir, 'POP-100-argus-1.md'), 'utf-8')).data;
    expect(fm.pop_payout).toBe(99); // tier 1 updated
    expect(fm.estimate).toBe('7'); // tier 2 preserved
    expect(fm.pop_assignee_address).toBe('0xdead');
    expect(fm.pop_difficulty).toBe('hard');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
