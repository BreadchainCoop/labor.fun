/**
 * Permissions module — reads KB people files + SQLite identity table
 * to enforce admin checks, tag hierarchy, and user resolution.
 *
 * The KB files (groups/{name}/context/people/{name}.md) are the source of truth
 * for user data and tags. This module reads them and caches the results.
 */

import fs from 'fs';
import path from 'path';

import { getDb } from './db.js';
import { logger } from './logger.js';

// --- Types ---

export interface Person {
  id: string; // filename without .md (e.g., 'alice')
  displayName: string;
  tags: string[];
  isAdmin: boolean;
}

export interface SenderContext {
  user_id: string;
  display_name: string;
  tags: string[];
  is_admin: boolean;
}

// --- In-memory cache ---

let people: Map<string, Person> = new Map();
let adminSet: Set<string> = new Set();

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
 * Parse the admin list from the KB index.md file.
 * Looks for the "## Admins" section and extracts names.
 */
function parseAdmins(indexContent: string): string[] {
  const adminsSection = indexContent.match(
    /## Admins\n([\s\S]*?)(?=\n##|\n$|$)/,
  );
  if (!adminsSection) return [];

  const admins: string[] = [];
  const lines = adminsSection[1].split('\n');
  for (const line of lines) {
    // Match "- Name" or "- Name (Role)" or "- **Name**"
    const match = line.match(/^-\s+\*?\*?([^*(]+)/);
    if (match) {
      admins.push(match[1].trim());
    }
  }
  return admins;
}

/**
 * Load people from KB context directory.
 * Reads people/*.md files and index.md for admin list.
 */
export function loadPeopleFromKB(contextDir: string): void {
  const newPeople = new Map<string, Person>();
  const newAdminSet = new Set<string>();

  // Parse index.md for admin names
  const indexPath = path.join(contextDir, 'index.md');
  let adminNames: string[] = [];
  if (fs.existsSync(indexPath)) {
    const indexContent = fs.readFileSync(indexPath, 'utf-8');
    adminNames = parseAdmins(indexContent);
  }

  // Parse people files
  const peopleDir = path.join(contextDir, 'people');
  if (!fs.existsSync(peopleDir)) {
    logger.warn({ peopleDir }, 'People directory not found');
    people = newPeople;
    adminSet = newAdminSet;
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

    // Check if this person is in the admin list (match by display name)
    const isAdmin = adminNames.some(
      (name) => name.toLowerCase() === displayName.toLowerCase(),
    );

    const person: Person = { id, displayName, tags: tags || [], isAdmin };
    newPeople.set(id, person);

    if (isAdmin) {
      newAdminSet.add(id);
      // Ensure admin tag is in their tags list
      if (!person.tags.includes('admin')) {
        person.tags.push('admin');
      }
    }
  }

  people = newPeople;
  adminSet = newAdminSet;

  logger.info(
    { peopleCount: people.size, adminCount: adminSet.size },
    'Loaded KB people',
  );
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
 * Check if a KB person is an admin.
 */
export function isAdmin(kbPerson: string): boolean {
  return adminSet.has(kbPerson);
}

/**
 * Check if a KB person has a specific tag.
 */
export function hasTag(kbPerson: string, tag: string): boolean {
  const person = people.get(kbPerson);
  if (!person) return false;
  return person.tags.includes(tag);
}

/**
 * Check if a user (identified by platform ID) has admin privileges.
 * Resolves platform ID → KB person → admin check.
 */
export function isSenderAdmin(platformId: string, platform: string): boolean {
  const kbPerson = resolveUser(platformId, platform);
  if (!kbPerson) return false;
  return isAdmin(kbPerson);
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
    is_admin: person.isAdmin,
  };
}

// --- Tag Hierarchy ---

/**
 * Check if a user can assign a given tag to someone.
 * Uses the tag_hierarchy table: the user must have a tag that is
 * a parent of the target tag.
 */
export function canAssignTag(
  assignerPerson: string,
  targetTag: string,
): boolean {
  const person = people.get(assignerPerson);
  if (!person) return false;

  const db = getDb();
  const placeholders = person.tags.map(() => '?').join(',');
  if (placeholders.length === 0) return false;

  const row = db
    .prepare(
      `SELECT 1 FROM tag_hierarchy WHERE parent_tag IN (${placeholders}) AND child_tag = ? LIMIT 1`,
    )
    .get(...person.tags, targetTag) as { 1: number } | undefined;

  return row !== undefined;
}

/**
 * Get all tags that a person can assign.
 */
export function getAssignableTags(kbPerson: string): string[] {
  const person = people.get(kbPerson);
  if (!person || person.tags.length === 0) return [];

  const db = getDb();
  const placeholders = person.tags.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT DISTINCT child_tag FROM tag_hierarchy WHERE parent_tag IN (${placeholders})`,
    )
    .all(...person.tags) as { child_tag: string }[];

  return rows.map((r) => r.child_tag);
}

// --- Utility ---

/**
 * Get all loaded people.
 */
export function getAllPeople(): Person[] {
  return Array.from(people.values());
}

/**
 * Get all admin person IDs.
 */
export function getAdmins(): string[] {
  return Array.from(adminSet);
}
