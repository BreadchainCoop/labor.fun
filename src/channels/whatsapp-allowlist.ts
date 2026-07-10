/**
 * WhatsApp auto-allowlist seeding (WHATSAPP_AUTO_ALLOWLIST_GROUPS).
 *
 * For a sender in a matching registered WhatsApp group who does NOT already
 * resolve to a KB person, seed everything the permissions layer needs:
 *
 *   1. A people file under `groups/<SHARED_KB_GROUP>/context/people/<slug>.md`
 *      with `whatsapp_id` frontmatter and `created_by: whatsapp-auto-allowlist`.
 *   2. A `user_identities` (platform_id, 'whatsapp', kb_person) row so
 *      `resolveUser()` finds them.
 *   3. A people-cache reload so `getSenderContext()` resolves them on the
 *      very message that triggered the seeding.
 *
 * The `whatsappId` stored is the full participant JID (e.g.
 * `<number>@s.whatsapp.net`) — exactly what the orchestrator later passes to
 * `resolveUser(msg.sender, 'whatsapp')`, so the mapping round-trips.
 *
 * SECURITY: an allowlisted sender has FULL access. This module is only
 * invoked for chats matched by WHATSAPP_AUTO_ALLOWLIST_GROUPS — enable that
 * flag only for groups whose entire membership you trust.
 *
 * Idempotent: an already-resolvable sender is a no-op, and an in-process
 * cache keeps the steady-state cost per message at one Set lookup.
 */

import fs from 'fs';
import path from 'path';

import matter from 'gray-matter';

import { GROUPS_DIR, SHARED_KB_GROUP } from '../config.js';
import { logger } from '../logger.js';
import { addIdentity, loadPeopleFromKB, resolveUser } from '../permissions.js';
import { chooseWhatsAppSlug } from './whatsapp-auto.js';

export interface WhatsAppSender {
  whatsappId: string;
  name?: string;
}

/** Injectable side effects — defaults hit the real KB/db. */
export interface AllowlistSeedDeps {
  peopleDir: () => string;
  resolveUser: (platformId: string, platform: string) => string | undefined;
  addIdentity: (platformId: string, platform: string, kbPerson: string) => void;
  reloadPeople: () => void;
}

function defaultPeopleDir(): string {
  return path.join(GROUPS_DIR, SHARED_KB_GROUP, 'context', 'people');
}

function defaultReloadPeople(): void {
  loadPeopleFromKB(path.join(GROUPS_DIR, SHARED_KB_GROUP, 'context'));
}

// Senders confirmed allowlisted since this process started — avoids a db
// lookup on every single group message.
const seededThisProcess = new Set<string>();

/** @internal - exported for testing */
export function _resetSeededCacheForTests(): void {
  seededThisProcess.clear();
}

/**
 * Ensure a WhatsApp sender is allowlisted, seeding a KB person + identity
 * row when they aren't. Returns what happened (mostly for tests/logging).
 */
export function ensureWhatsAppSenderAllowlisted(
  sender: WhatsAppSender,
  deps: Partial<AllowlistSeedDeps> = {},
): 'created' | 'existing' | 'skipped' {
  if (!sender.whatsappId) return 'skipped';
  if (seededThisProcess.has(sender.whatsappId)) return 'existing';

  const d: AllowlistSeedDeps = {
    peopleDir: deps.peopleDir ?? defaultPeopleDir,
    resolveUser: deps.resolveUser ?? resolveUser,
    addIdentity: deps.addIdentity ?? addIdentity,
    reloadPeople: deps.reloadPeople ?? defaultReloadPeople,
  };

  if (d.resolveUser(sender.whatsappId, 'whatsapp')) {
    seededThisProcess.add(sender.whatsappId);
    return 'existing';
  }

  const dir = d.peopleDir();
  const fileExists = (slug: string) =>
    fs.existsSync(path.join(dir, `${slug}.md`));
  const readWhatsAppId = (slug: string): string | null => {
    try {
      const parsed = matter(
        fs.readFileSync(path.join(dir, `${slug}.md`), 'utf-8'),
      );
      const id = (parsed.data as { whatsapp_id?: unknown }).whatsapp_id;
      return id === undefined || id === null ? null : String(id);
    } catch {
      return null;
    }
  };

  const slug = chooseWhatsAppSlug({
    whatsappId: sender.whatsappId,
    name: sender.name,
    existingKbPerson: null,
    fileExists,
    readWhatsAppId,
  });

  const file = path.join(dir, `${slug}.md`);
  fs.mkdirSync(dir, { recursive: true });
  // chooseWhatsAppSlug only returns an existing filename when its whatsapp_id
  // already matches ours (identity row was lost) — keep the file, just restore
  // the identity mapping below.
  if (!fs.existsSync(file)) {
    const displayName = sender.name || `WhatsApp user ${sender.whatsappId}`;
    const frontmatter: Record<string, unknown> = {
      title: displayName,
      created_by: 'whatsapp-auto-allowlist',
      visibility: 'private',
      tags: ['whatsapp-auto-allowlist'],
      whatsapp_id: sender.whatsappId,
    };
    const bodyLines = [
      `WhatsApp ID: ${sender.whatsappId}`,
      '',
      '<!-- Auto-created by WHATSAPP_AUTO_ALLOWLIST_GROUPS the first time this',
      '     person spoke in an auto-allowlisted WhatsApp group. -->',
      '',
    ];
    const serialized = matter.stringify(bodyLines.join('\n'), frontmatter);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, serialized);
    fs.renameSync(tmp, file);
  }

  d.addIdentity(sender.whatsappId, 'whatsapp', slug);
  d.reloadPeople();
  seededThisProcess.add(sender.whatsappId);
  logger.info(
    { whatsappId: sender.whatsappId, slug },
    'WhatsApp sender auto-allowlisted',
  );
  return 'created';
}
