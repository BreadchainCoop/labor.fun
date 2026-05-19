import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { _initTestDatabase, getDb as getDbFn } from './db.js';
import {
  loadPeopleFromKB,
  resolveUser,
  addIdentity,
  isAdmin,
  hasTag,
  isSenderAdmin,
  getSenderContext,
  canAssignTag,
  getAssignableTags,
  getPerson,
  getAllPeople,
  getAdmins,
} from './permissions.js';

let tmpDir: string;

function writeFile(relPath: string, content: string) {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function setupTestKB() {
  writeFile(
    'index.md',
    `---
title: Test KB
---

# Test KB

## Admins

- Alice Adams (Owner)
- Ops (System)

## Groups

| Group | Description |
|-------|-------------|
| leadership | Leads |
| engineering | Engineers |
`,
  );

  writeFile(
    'people/alice.md',
    `---
title: Alice Adams
visibility: private
editable_by: admins
tags: [leadership]
---

# Alice Adams
- **Role**: Owner
`,
  );

  writeFile(
    'people/ops.md',
    `---
title: Ops
visibility: private
editable_by: admins
tags: [engineering]
---

# Ops
- **Role**: System Operator
`,
  );

  writeFile(
    'people/carol.md',
    `---
title: Carol Cole
visibility: private
editable_by: admins
tags: [leadership]
---

# Carol Cole
- **Role**: Member
`,
  );

  writeFile(
    'people/bob.md',
    `---
title: Bob Smith
visibility: open
editable_by: open
tags: [community]
---

# Bob Smith
- **Role**: Contributor
`,
  );

  writeFile('people/README.md', '# People directory');
}

beforeEach(() => {
  // Seed identities for the test — db.ts only seeds when SEED_IDENTITIES is set
  // (env-driven since PR #43); the test depends on cli:ops resolving to
  // 'ops'. Scope the env var to this suite so other tests aren't affected.
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
    expect(all).toHaveLength(4);
    expect(all.map((p) => p.id).sort()).toEqual([
      'alice',
      'bob',
      'carol',
      'ops',
    ]);
  });

  it('parses tags from frontmatter', () => {
    const alice = getPerson('alice');
    expect(alice?.tags).toContain('leadership');
    // admin tag added because listed in index.md
    expect(alice?.tags).toContain('admin');
  });

  it('identifies admins from index.md', () => {
    expect(getAdmins().sort()).toEqual(['alice', 'ops']);
  });

  it('non-admin users are not marked as admin', () => {
    expect(isAdmin('bob')).toBe(false);
    expect(isAdmin('carol')).toBe(false);
  });

  it('admin users are correctly identified', () => {
    expect(isAdmin('alice')).toBe(true);
    expect(isAdmin('ops')).toBe(true);
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
    addIdentity('12345', 'telegram', 'carol');
    expect(resolveUser('12345', 'slack')).toBe('alice');
    expect(resolveUser('12345', 'telegram')).toBe('carol');
  });
});

describe('Permission Checks', () => {
  it('isSenderAdmin resolves and checks', () => {
    addIdentity('U_ALEX', 'slack', 'alice');
    expect(isSenderAdmin('U_ALEX', 'slack')).toBe(true);
  });

  it('isSenderAdmin returns false for non-admin', () => {
    addIdentity('U_BOB', 'slack', 'bob');
    expect(isSenderAdmin('U_BOB', 'slack')).toBe(false);
  });

  it('isSenderAdmin returns false for unknown sender', () => {
    expect(isSenderAdmin('UNKNOWN', 'slack')).toBe(false);
  });

  it('hasTag checks tag from frontmatter', () => {
    expect(hasTag('alice', 'leadership')).toBe(true);
    expect(hasTag('bob', 'community')).toBe(true);
    expect(hasTag('bob', 'admin')).toBe(false);
  });

  it('getSenderContext returns full context for known user', () => {
    addIdentity('U_ALEX', 'slack', 'alice');
    const ctx = getSenderContext('U_ALEX', 'slack');
    expect(ctx).toBeDefined();
    expect(ctx!.user_id).toBe('alice');
    expect(ctx!.display_name).toBe('Alice Adams');
    expect(ctx!.is_admin).toBe(true);
    expect(ctx!.tags).toContain('leadership');
    expect(ctx!.tags).toContain('admin');
  });

  it('getSenderContext returns undefined for unknown sender', () => {
    expect(getSenderContext('UNKNOWN', 'slack')).toBeUndefined();
  });
});

describe('Tag Hierarchy', () => {
  it('admin can assign any tag', () => {
    expect(canAssignTag('alice', 'leadership')).toBe(true);
    expect(canAssignTag('alice', 'engineering')).toBe(true);
    expect(canAssignTag('alice', 'admin')).toBe(true);
    expect(canAssignTag('alice', 'community')).toBe(true);
  });

  it('leadership can assign engineering/creative/etc but not admin', () => {
    // Carol has leadership tag but is not admin
    expect(canAssignTag('carol', 'engineering')).toBe(true);
    expect(canAssignTag('carol', 'creative')).toBe(true);
    expect(canAssignTag('carol', 'admin')).toBe(false);
    expect(canAssignTag('carol', 'leadership')).toBe(false);
  });

  it('community member cannot assign any tag', () => {
    expect(canAssignTag('bob', 'engineering')).toBe(false);
    expect(canAssignTag('bob', 'community')).toBe(false);
    expect(canAssignTag('bob', 'admin')).toBe(false);
  });

  it('unknown person cannot assign tags', () => {
    expect(canAssignTag('nobody', 'admin')).toBe(false);
  });

  it('getAssignableTags returns correct tags for admin', () => {
    const tags = getAssignableTags('alice');
    expect(tags).toContain('admin');
    expect(tags).toContain('leadership');
    expect(tags).toContain('engineering');
    expect(tags).toContain('community');
  });

  it('getAssignableTags returns subset for leadership', () => {
    const tags = getAssignableTags('carol');
    expect(tags).toContain('engineering');
    expect(tags).toContain('creative');
    expect(tags).not.toContain('admin');
    expect(tags).not.toContain('leadership');
  });

  it('getAssignableTags returns empty for community', () => {
    expect(getAssignableTags('bob')).toHaveLength(0);
  });
});
