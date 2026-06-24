/**
 * Permissions module — identity resolution only.
 *
 * After the flat-permissions refactor there is exactly one tier: a sender
 * either resolves to a known KB person (allowlisted) and gets full access,
 * or doesn't and gets nothing. KB files under
 * groups/{name}/context/people/{slug}.md remain the source of truth for
 * display name and descriptive tags. Tags are metadata only — they no
 * longer grant any permissions.
 */

import fs from 'fs';
import path from 'path';

import { getDb } from './db.js';
import { logger } from './logger.js';

// --- Types ---

export interface Person {
  id: string; // filename without .md (e.g., 'jane-doe')
  displayName: string;
  tags: string[];
}

export interface SenderContext {
  user_id: string;
  display_name: string;
  tags: string[];
}

// --- In-memory cache ---

let people: Map<string, Person> = new Map();

// --- KB Loading ---

/**
 * Parse YAML frontmatter from a markdown file.
 * Extracts title and tags fields.
 */
function parseFrontmatter(content: string): {
  title?: string;
  tags?: string[];
} {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const yaml = match[1];
  const title = yaml.match(/^title:\s*(.+)$/m)?.[1]?.trim();
  const tagsMatch = yaml.match(/^tags:\s*\[([^\]]*)\]$/m);
  const tags = tagsMatch
    ? tagsMatch[1]
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : [];

  return { title, tags };
}

/**
 * Load people from KB context directory.
 * Reads people/*.md files; populates the in-memory cache.
 */
export function loadPeopleFromKB(contextDir: string): void {
  const newPeople = new Map<string, Person>();

  const peopleDir = path.join(contextDir, 'people');
  if (!fs.existsSync(peopleDir)) {
    logger.warn({ peopleDir }, 'People directory not found');
    people = newPeople;
    return;
  }

  const files = fs
    .readdirSync(peopleDir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md');

  for (const file of files) {
    const id = file.replace(/\.md$/, '');
    const content = fs.readFileSync(path.join(peopleDir, file), 'utf-8');
    const { title, tags } = parseFrontmatter(content);
    const displayName = title || id;
    newPeople.set(id, { id, displayName, tags: tags || [] });
  }

  people = newPeople;

  logger.info({ peopleCount: people.size }, 'Loaded KB people');
}

// --- Identity Resolution ---

/**
 * Resolve a platform sender ID to a KB person ID.
 * Returns undefined if no mapping exists.
 */
export function resolveUser(
  platformId: string,
  platform: string,
): string | undefined {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT kb_person FROM user_identities WHERE platform_id = ? AND platform = ?`,
    )
    .get(platformId, platform) as { kb_person: string } | undefined;
  return row?.kb_person;
}

/**
 * Add a platform identity mapping.
 */
export function addIdentity(
  platformId: string,
  platform: string,
  kbPerson: string,
): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO user_identities (platform_id, platform, kb_person) VALUES (?, ?, ?)`,
  ).run(platformId, platform, kbPerson);
  logger.info({ platformId, platform, kbPerson }, 'Identity mapping added');
}

// --- Permission Checks ---

/**
 * Get a person by KB ID. Returns undefined if not loaded.
 */
export function getPerson(kbPerson: string): Person | undefined {
  return people.get(kbPerson);
}

/**
 * The one and only permission predicate: is this sender a known/allowlisted
 * user? Anyone who resolves to a KB person has full access; anyone who
 * doesn't is rejected. Intake-layer filtering (sender-allowlist.json) and
 * the Discord-members sync together ensure that only allowlisted humans
 * ever get a `user_identities` row.
 */
export function isAllowlisted(platformId: string, platform: string): boolean {
  return resolveUser(platformId, platform) !== undefined;
}

/**
 * Build sender context for the container agent.
 */
export function getSenderContext(
  platformId: string,
  platform: string,
): SenderContext | undefined {
  const kbPerson = resolveUser(platformId, platform);
  if (!kbPerson) return undefined;

  const person = people.get(kbPerson);
  if (!person) return undefined;

  return {
    user_id: person.id,
    display_name: person.displayName,
    tags: person.tags,
  };
}

// --- Utility ---

/**
 * Get all loaded people.
 */
export function getAllPeople(): Person[] {
  return Array.from(people.values());
}
