import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { _initTestDatabase } from './db.js';
import {
  loadPeopleFromKB,
  resolveUser,
  addIdentity,
  isAllowlisted,
  getSenderContext,
  getPerson,
  getAllPeople,
} from './permissions.js';

let tmpDir: string;

function writeFile(relPath: string, content: string) {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function setupTestKB() {
  writeFile(
    'people/alice.md',
    `---
title: Alice Adams
visibility: private
tags: [leadership]
---

# Alice Adams
`,
  );

  writeFile(
    'people/ops.md',
    `---
title: Ops
visibility: private
tags: [engineering]
---

# Ops
`,
  );

  writeFile(
    'people/bob.md',
    `---
title: Bob Smith
visibility: open
tags: [community]
---

# Bob Smith
`,
  );

  writeFile('people/README.md', '# People directory');
}

beforeEach(() => {
  // Seed identities for the test — db.ts only seeds when SEED_IDENTITIES is
  // set; scope to this suite so other suites aren't affected.
  process.env.SEED_IDENTITIES = JSON.stringify([
    { platform_id: 'cli:ops', platform: 'cli', kb_person: 'ops' },
  ]);
  _initTestDatabase();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permissions-test-'));
  setupTestKB();
  loadPeopleFromKB(tmpDir);
});

afterEach(() => {
  delete process.env.SEED_IDENTITIES;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('KB Loading', () => {
  it('loads people from KB files', () => {
    const all = getAllPeople();
    // README.md should be excluded
    expect(all).toHaveLength(3);
    expect(all.map((p) => p.id).sort()).toEqual(['alice', 'bob', 'ops']);
  });

  it('parses tags from frontmatter as descriptive labels', () => {
    expect(getPerson('alice')?.tags).toEqual(['leadership']);
    expect(getPerson('bob')?.tags).toEqual(['community']);
    expect(getPerson('ops')?.tags).toEqual(['engineering']);
  });
});

describe('Identity Resolution', () => {
  it('resolves seeded identity (cli:ops)', () => {
    expect(resolveUser('cli:ops', 'cli')).toBe('ops');
  });

  it('returns undefined for unknown sender', () => {
    expect(resolveUser('UNKNOWN123', 'slack')).toBeUndefined();
  });

  it('adds and resolves new identity', () => {
    addIdentity('U_ALICE_SLACK', 'slack', 'alice');
    expect(resolveUser('U_ALICE_SLACK', 'slack')).toBe('alice');
  });

  it('same platform_id on different platforms maps separately', () => {
    addIdentity('12345', 'slack', 'alice');
    addIdentity('12345', 'telegram', 'bob');
    expect(resolveUser('12345', 'slack')).toBe('alice');
    expect(resolveUser('12345', 'telegram')).toBe('bob');
  });
});

describe('Allowlist Checks (flat model)', () => {
  it('isAllowlisted is true for any resolved sender', () => {
    addIdentity('U_ALEX', 'slack', 'alice');
    expect(isAllowlisted('U_ALEX', 'slack')).toBe(true);
  });

  it('isAllowlisted is true regardless of tags (no tier distinction)', () => {
    addIdentity('U_BOB', 'slack', 'bob');
    expect(isAllowlisted('U_BOB', 'slack')).toBe(true);
  });

  it('isAllowlisted is false for unknown sender', () => {
    expect(isAllowlisted('UNKNOWN', 'slack')).toBe(false);
  });

  it('getSenderContext returns user_id/display_name/tags for known sender', () => {
    addIdentity('U_ALEX', 'slack', 'alice');
    const ctx = getSenderContext('U_ALEX', 'slack');
    expect(ctx).toBeDefined();
    expect(ctx!.user_id).toBe('alice');
    expect(ctx!.display_name).toBe('Alice Adams');
    expect(ctx!.tags).toEqual(['leadership']);
  });

  it('getSenderContext returns undefined for unknown sender', () => {
    expect(getSenderContext('UNKNOWN', 'slack')).toBeUndefined();
  });
});
