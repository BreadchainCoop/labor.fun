/**
 * recipient.ts — resolve a payout recipient's on-chain address from the KB.
 *
 * Source of truth is the member profile's frontmatter `address` field (the same
 * merge-preserving people files the Discord sync maintains). The flow REFUSES
 * on a missing or malformed address rather than guessing — never send funds to
 * an unverified target. Pure file read + EIP-55 validation, no network.
 */

import fs from 'fs';
import path from 'path';

import matter from 'gray-matter';

import { validateAddress } from './payout.js';

export interface ResolvedRecipient {
  slug: string;
  address: string;
}

/**
 * Read `context/people/<slug>.md` frontmatter `address` and validate it.
 * Throws a clear, user-facing error if the file/field is missing or the address
 * is malformed — the caller surfaces that and asks the requester to supply one.
 */
export function resolveRecipient(
  profileDir: string,
  sharedKbGroup: string,
  slug: string,
): ResolvedRecipient {
  const file = path.join(
    profileDir,
    'groups',
    sharedKbGroup,
    'context',
    'people',
    `${slug}.md`,
  );
  if (!fs.existsSync(file)) {
    throw new Error(
      `no member profile for "${slug}" — add context/people/${slug}.md with an \`address\``,
    );
  }
  const fm = matter(fs.readFileSync(file, 'utf-8')).data as {
    address?: unknown;
  };
  if (typeof fm.address !== 'string' || !fm.address.trim()) {
    throw new Error(
      `member "${slug}" has no payout \`address\` in their profile — ask them for a checksummed wallet address`,
    );
  }
  return { slug, address: validateAddress(fm.address) };
}
