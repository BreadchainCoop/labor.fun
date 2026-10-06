/**
 * identity.mjs — the address ⇄ KB-person bridge.
 *
 * The repo already goes slug → address (`resolveRecipient` in
 * src/safe/recipient.ts, for Safe payouts). It has NO reverse direction, and a
 * mirror needs one: the chain tells us an assignee's ADDRESS and POP username,
 * and the KB wants a display name in `owners`.
 *
 * We read the SAME `address` frontmatter key that resolveRecipient relies on,
 * and normalise BOTH sides through ethers' checksum — so the forward and
 * reverse directions agree by construction and a hand-authored lowercase
 * address still matches. (This plugin runs host-side, so `ethers` here is
 * labor.fun's own v6; `getAddress` is the v6 spelling and is exactly what
 * src/safe/payout.ts:validateAddress uses.)
 *
 * DELIBERATELY TOLERANT. A malformed person file is skipped, not thrown on —
 * matching loadMemberCapacitiesFromKb and loadDiscordCandidates, which both
 * log at debug and move on. A POP member with no KB person simply does not
 * resolve and we fall back to their POP username. That is the same
 * silent-miss behaviour `owners` already has everywhere else (GH-synced tasks
 * put GitHub logins in `owners` while hand-authored tasks use display names,
 * so the two populations already fail to join and nothing breaks).
 *
 * NOT CACHED ACROSS TICKS. A live org has ~3-25 people files; gray-matter over
 * that is sub-millisecond, and loadDiscordCandidates makes the same call with
 * the same reasoning ("the periodic members sync rewrites files in place and
 * we want a fresh view each call").
 */

import fs from 'fs';
import path from 'path';

import matter from 'gray-matter';
import { getAddress } from 'ethers';

/** Checksum-normalise, returning null for anything that is not an address. */
export function normalizeAddress(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return getAddress(value.trim());
  } catch {
    return null;
  }
}

/**
 * Build the reverse index from a `context/people` directory.
 *
 * @returns {{byAddress: Map<string,{slug:string,displayName:string}>, count:number}}
 *   keyed by CHECKSUMMED address.
 */
export function buildPeopleIndex(peopleDir, { logger } = {}) {
  const byAddress = new Map();
  let count = 0;
  let entries;
  try {
    entries = fs.readdirSync(peopleDir);
  } catch {
    return { byAddress, count: 0 };
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md') || entry === 'README.md') continue;
    const slug = entry.slice(0, -3);
    let fm;
    try {
      fm = matter(fs.readFileSync(path.join(peopleDir, entry), 'utf-8')).data || {};
    } catch (err) {
      logger?.debug?.({ err, entry }, 'pop: unreadable person file, skipped');
      continue;
    }
    count += 1;
    const addr = normalizeAddress(fm.address);
    if (!addr) continue;
    // `title` then `name` then slug — the same precedence member-profiles.ts
    // uses, so a person resolves to the same display name in both places.
    const displayName =
      (typeof fm.title === 'string' && fm.title.trim()) ||
      (typeof fm.name === 'string' && fm.name.trim()) ||
      slug;
    // First writer wins: if two people files claim one address, keeping the
    // first (readdir is sorted by the caller's fs order, so make it stable)
    // is arbitrary but at least deterministic per run. Log it — it is a
    // genuine KB data error worth surfacing.
    if (byAddress.has(addr)) {
      logger?.warn?.(
        { address: addr, kept: byAddress.get(addr).slug, ignored: slug },
        'pop: two KB people declare the same address',
      );
      continue;
    }
    byAddress.set(addr, { slug, displayName });
  }
  return { byAddress, count };
}

/**
 * Fold `pop org members --json` into a POP-username → address map. This is the
 * chain-authoritative half of the bridge and costs no credentials.
 *
 * @param membersJson the parsed `{ totalSupply, members: [...] }` payload
 */
export function buildMemberIndex(membersJson) {
  const byUsername = new Map();
  const members = membersJson && Array.isArray(membersJson.members) ? membersJson.members : [];
  for (const m of members) {
    const addr = normalizeAddress(m?.address);
    const username = typeof m?.username === 'string' ? m.username.trim() : '';
    if (!addr || !username) continue;
    byUsername.set(username.toLowerCase(), addr);
  }
  return byUsername;
}

/**
 * Resolve the `owners` array for a task.
 *
 * Precedence: the assignee's on-chain ADDRESS (most reliable — it is what the
 * KB actually stores) → their POP username mapped through the member index →
 * the raw POP username as a last resort so the field is never empty for a
 * task that genuinely has an assignee.
 *
 * Returns [] for an unassigned task, which is correct: `owners: []` means the
 * PM orchestrator counts it as unowned rather than inventing a person.
 */
export function resolveOwners({ assigneeAddress, assigneeUsername, peopleIndex, memberIndex }) {
  const username = typeof assigneeUsername === 'string' ? assigneeUsername.trim() : '';
  let addr = normalizeAddress(assigneeAddress);
  if (!addr && username && memberIndex) {
    addr = memberIndex.get(username.toLowerCase()) || null;
  }
  if (addr && peopleIndex?.has(addr)) return [peopleIndex.get(addr).displayName];
  if (username) return [username];
  return [];
}
