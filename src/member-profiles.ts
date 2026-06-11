/**
 * Member-profile capacity loader (issue #34).
 *
 * The operational report compares each member's open task load against the
 * hours/points they are *meant* to work. That capacity lives on the person's
 * KB profile (`context/people/<slug>.md`) — the same files that already act as
 * the allowlist (see src/permissions.ts) — under a few optional frontmatter
 * fields:
 *
 *   ---
 *   title: Jane Doe
 *   slug: jane-doe
 *   team: Operations              # optional — groups members in the report
 *   expected_hours_per_week: 20   # optional — declared, NOT verified hours
 *   capacity_points: 8            # optional — declared sprint capacity (same
 *                                 #            unit as task `estimate`)
 *   pay_parity_note: part-time    # optional — free-text caveat surfaced so the
 *                                 #            report never implies everyone is
 *                                 #            paid/works the same
 *   ---
 *
 * All fields are optional. A member with no capacity declared still appears in
 * the report (by load), just without an over-/under-load ratio — we never
 * fabricate hours we don't have (issue #34's "hours verification" decision:
 * capacity is self-declared and labelled as such, not inferred).
 *
 * Keying: the report joins capacities to tasks by the person's **display
 * name**, because that's what task `owners` frontmatter uses. The display name
 * is read from `title:` (the framework's people-file convention — what
 * src/permissions.ts reads and the Discord members sync writes), falling back
 * to `name:` (used by some hand-authored profiles). A `slug` alias is kept too
 * so either form resolves.
 */

import fs from 'fs';
import path from 'path';

import matter from 'gray-matter';

import { GROUPS_DIR, SHARED_KB_GROUP } from './config.js';
import { logger } from './logger.js';

/** Declared (self-reported, unverified) capacity for one member. */
export interface MemberCapacity {
  /** Display name — matches task `owners` entries. */
  name: string;
  /** File slug, kept as an alternate join key. */
  slug?: string;
  /** Team the member belongs to (drives the "by team" report section). */
  team?: string;
  /** Hours/week the member is meant to work. Declared, not verified. */
  expectedHoursPerWeek?: number;
  /** Declared sprint capacity in story points (same unit as task `estimate`). */
  capacityPoints?: number;
  /** Free-text caveat (e.g. "part-time", "volunteer") surfaced in the report. */
  payParityNote?: string;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim()) {
      const n = Number(v.trim());
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/** Path to the shared KB people directory. */
export function sharedKbPeopleDir(): string {
  return path.join(GROUPS_DIR, SHARED_KB_GROUP, 'context', 'people');
}

/**
 * Parse every `*.md` in `peopleDir` into a `MemberCapacity`. Tolerates a missing
 * dir and malformed files (skips them). Files with no capacity fields still
 * yield a profile — capacity is simply undefined.
 */
export function loadMemberCapacitiesFromKb(
  peopleDir: string = sharedKbPeopleDir(),
): MemberCapacity[] {
  let files: string[];
  try {
    files = fs
      .readdirSync(peopleDir)
      .filter((f) => f.endsWith('.md') && f !== 'README.md');
  } catch {
    return []; // dir absent — no capacity data
  }

  const out: MemberCapacity[] = [];
  for (const file of files) {
    try {
      const fm = matter(fs.readFileSync(path.join(peopleDir, file), 'utf-8'))
        .data as Record<string, unknown>;
      const slug = firstString(fm.slug) || file.replace(/\.md$/, '');
      const name = firstString(fm.title, fm.name) || slug;
      out.push({
        name,
        slug,
        team: firstString(fm.team),
        expectedHoursPerWeek: firstNumber(fm.expected_hours_per_week),
        capacityPoints: firstNumber(fm.capacity_points),
        payParityNote: firstString(fm.pay_parity_note),
      });
    } catch (err) {
      logger.debug(
        { file, err },
        'Member profiles: skipping unparseable person file',
      );
    }
  }
  return out;
}
