import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { loadDeadlineItemsFromKb } from './kb-task-source.js';

let dir: string;

function writeTask(name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-tasks-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadDeadlineItemsFromKb', () => {
  it('returns [] when the directory is absent', () => {
    expect(loadDeadlineItemsFromKb(path.join(dir, 'nope'))).toEqual([]);
  });

  it('maps tasks with a frontmatter deadline', () => {
    writeTask(
      'TASK-001.md',
      `---
title: Ship it
id: TASK-001
status: open
owners: [Alice, Bob]
deadline: 2026-07-01
escalation_contact: Carol
---
body`,
    );
    const items = loadDeadlineItemsFromKb(dir);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'TASK-001',
      title: 'Ship it',
      deadline: '2026-07-01',
      owners: ['Alice', 'Bob'],
      escalationContact: 'Carol',
      status: 'open',
    });
  });

  it('falls back to end_date (GitHub-synced tasks)', () => {
    writeTask(
      'GH-1.md',
      `---
title: Synced
id: GH-1
status: open
owners: [Dana]
end_date: 2026-08-15
---
body`,
    );
    const items = loadDeadlineItemsFromKb(dir);
    expect(items[0].deadline).toBe('2026-08-15');
  });

  it('skips tasks with no machine-readable deadline', () => {
    writeTask(
      'TASK-002.md',
      `---
title: No deadline
id: TASK-002
status: open
owners: [Alice]
---
body`,
    );
    expect(loadDeadlineItemsFromKb(dir)).toEqual([]);
  });

  it('coerces a scalar owner into an array', () => {
    writeTask(
      'TASK-003.md',
      `---
title: Solo
id: TASK-003
owners: Alice
deadline: 2026-07-01
---
body`,
    );
    expect(loadDeadlineItemsFromKb(dir)[0].owners).toEqual(['Alice']);
  });

  it('derives id from filename when frontmatter omits it', () => {
    writeTask(
      'TASK-004.md',
      `---
title: No id
deadline: 2026-07-01
---
body`,
    );
    expect(loadDeadlineItemsFromKb(dir)[0].id).toBe('TASK-004');
  });

  it('skips malformed files without throwing', () => {
    writeTask('good.md', `---\ntitle: Good\ndeadline: 2026-07-01\n---\n`);
    // Unterminated frontmatter / invalid YAML — must not crash the scan.
    writeTask('bad.md', `---\ntitle: [unterminated\ndeadline: 2026-07-01`);
    const items = loadDeadlineItemsFromKb(dir);
    expect(items.some((i) => i.title === 'Good')).toBe(true);
  });
});
