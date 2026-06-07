/**
 * KB-tasks adapter for the reminder engine (#25).
 *
 * Scans the shared KB `context/tasks/*.md` files and maps every task that
 * declares a deadline into a `DeadlineItem`. Keeping the source adapter
 * separate from the engine is what makes the reminder primitive reusable: a
 * second consumer just implements the same `() => DeadlineItem[]` shape.
 *
 * Deadline is read from frontmatter `deadline`, falling back to `end_date`
 * (the field GitHub-synced tasks use). Tasks with no machine-readable deadline
 * are simply not reminded about.
 */

import fs from 'fs';
import path from 'path';

import matter from 'gray-matter';

import { GROUPS_DIR, SHARED_KB_GROUP } from './config.js';
import { logger } from './logger.js';
import type { DeadlineItem } from './reminder-engine.js';

/** Coerce a frontmatter value that may be a YAML list or a scalar into string[]. */
function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    // gray-matter parses bare dates into Date objects.
    if (v instanceof Date && !Number.isNaN(v.getTime())) {
      return v.toISOString().slice(0, 10);
    }
  }
  return undefined;
}

/** Path to the shared KB tasks directory. */
export function sharedKbTasksDir(): string {
  return path.join(GROUPS_DIR, SHARED_KB_GROUP, 'context', 'tasks');
}

/**
 * Parse every `*.md` in `tasksDir` and return the ones with a deadline as
 * `DeadlineItem`s. Tolerates a missing dir and malformed files (skips them).
 */
export function loadDeadlineItemsFromKb(
  tasksDir: string = sharedKbTasksDir(),
): DeadlineItem[] {
  let files: string[];
  try {
    files = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.md'));
  } catch {
    return []; // dir absent — nothing to remind about
  }

  const items: DeadlineItem[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(tasksDir, file), 'utf-8');
      const fm = matter(raw).data as Record<string, unknown>;

      const deadline = firstString(fm.deadline, fm.end_date, fm.due_date);
      if (!deadline) continue; // no machine-readable deadline → skip

      const id = firstString(fm.id) || file.replace(/\.md$/, '');

      items.push({
        id,
        title: firstString(fm.title) || id,
        deadline,
        owners: toStringArray(fm.owners),
        escalationContact: firstString(fm.escalation_contact),
        status: firstString(fm.status),
        ref: `tasks/${file}`,
      });
    } catch (err) {
      logger.debug(
        { file, err },
        'Reminder: skipping unparseable KB task file',
      );
    }
  }
  return items;
}
