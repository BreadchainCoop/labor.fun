import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { loadMemberCapacitiesFromKb } from './member-profiles.js';

let dir: string;

function writePerson(name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadMemberCapacitiesFromKb', () => {
  it('returns [] when the directory is absent', () => {
    expect(loadMemberCapacitiesFromKb(path.join(dir, 'nope'))).toEqual([]);
  });

  it('parses capacity fields and skips README', () => {
    writePerson('README.md', '# People');
    writePerson(
      'jane-doe.md',
      `---
name: Jane Doe
slug: jane-doe
team: Operations
expected_hours_per_week: 20
capacity_points: 8
pay_parity_note: part-time
---
Ops lead.`,
    );
    const caps = loadMemberCapacitiesFromKb(dir);
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({
      name: 'Jane Doe',
      slug: 'jane-doe',
      team: 'Operations',
      expectedHoursPerWeek: 20,
      capacityPoints: 8,
      payParityNote: 'part-time',
    });
  });

  it('reads the display name from title: (framework convention) over name:', () => {
    writePerson(
      'jane-doe.md',
      `---\ntitle: Jane Doe\nname: ignored\ncapacity_points: 3\n---\nhi`,
    );
    const caps = loadMemberCapacitiesFromKb(dir);
    expect(caps[0].name).toBe('Jane Doe');
  });

  it('yields a profile with undefined capacity when fields are absent', () => {
    writePerson('bob.md', `---\nname: Bob\n---\nhi`);
    const caps = loadMemberCapacitiesFromKb(dir);
    expect(caps[0]).toMatchObject({ name: 'Bob' });
    expect(caps[0].capacityPoints).toBeUndefined();
    expect(caps[0].expectedHoursPerWeek).toBeUndefined();
  });

  it('coerces numeric strings and falls back name→slug→filename', () => {
    writePerson('carol.md', `---\ncapacity_points: "5"\n---\nhi`);
    const caps = loadMemberCapacitiesFromKb(dir);
    expect(caps[0].name).toBe('carol');
    expect(caps[0].capacityPoints).toBe(5);
  });
});
