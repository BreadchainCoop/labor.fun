import fs from 'fs';
import path from 'path';

import matter from 'gray-matter';

/**
 * Display-only roster for the admin dashboard, derived from real inputs — the
 * active profile's people files + the env-driven role lists. No org's members
 * are ever hardcoded here (issue #95: the dashboard used to ship a fictional
 * `alice`/`bob`/`carol`/`ops`/`dave` map, which leaked into every deployment's
 * dashboard regardless of who the org actually was).
 */

const DASH = '\u2014';

/**
 * Parse `people/<slug>.md` frontmatter into a `slug → profile` map. Returns an
 * empty map when the directory is absent (e.g. the dev/example layout, where
 * real people files are gitignored). Unparseable files are skipped, not fatal.
 */
export function readPeopleDir(peopleDir) {
  const out = {};
  let items;
  try {
    items = fs.readdirSync(peopleDir);
  } catch {
    return out;
  }
  for (const item of items) {
    if (!item.endsWith('.md') || item.toLowerCase() === 'readme.md') continue;
    let data;
    try {
      ({ data } = matter(fs.readFileSync(path.join(peopleDir, item), 'utf-8')));
    } catch {
      continue;
    }
    const slug = String(data.slug || path.basename(item, '.md')).toLowerCase();
    const platforms =
      data && typeof data.platforms === 'object' && data.platforms
        ? data.platforms
        : {};
    out[slug] = {
      display: data.name ? String(data.name) : slug,
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      slack: platforms.slack != null ? String(platforms.slack) : null,
      telegram: platforms.telegram != null ? String(platforms.telegram) : null,
    };
  }
  return out;
}

/**
 * Build the per-user display roster keyed by the actual usernames (from
 * users.json). Identity/display come from the matching people file (by slug);
 * admin/superadmin/coordinator status and the derived KB-access / cross-send
 * columns come from the env-driven role predicates. Pure — all IO is injected.
 *
 * @param {string[]} usernames
 * @param {Record<string, {display?:string,tags?:string[],slack?:string|null,telegram?:string|null}>} people
 * @param {{isAdmin?:(u:string)=>boolean,isSuperAdmin?:(u:string)=>boolean,isCoordinator?:(u:string)=>boolean}} roles
 */
export function buildUserRoster(usernames, people = {}, roles = {}) {
  const isAdmin = roles.isAdmin || (() => false);
  const isSuperAdmin = roles.isSuperAdmin || (() => false);
  const isCoordinator = roles.isCoordinator || (() => false);

  const roster = {};
  for (const uname of usernames) {
    const key = String(uname).toLowerCase();
    const p = people[key] || {};
    const admin = isAdmin(uname);
    const superadmin = isSuperAdmin(uname);
    const coordinator = isCoordinator(uname);

    // Prefer tags declared in the person's KB file; otherwise fall back to a
    // single role-derived tag so the table isn't blank for env-only users.
    let tags = Array.isArray(p.tags) && p.tags.length ? p.tags : [];
    if (tags.length === 0) {
      if (admin) tags = ['admin'];
      else if (coordinator) tags = ['coordinator'];
    }

    roster[uname] = {
      display: p.display || uname,
      tags,
      admin,
      superadmin,
      slack: p.slack || DASH,
      telegram: p.telegram || DASH,
      kb: admin ? 'All docs' : coordinator ? 'Non-private' : 'Open only',
      crossSend: admin || coordinator ? 'Yes' : 'No',
    };
  }
  return roster;
}
