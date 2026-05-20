import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'TZ',
  'NANOCLAW_MODEL',
  'NANOCLAW_SUBAGENT_MODEL',
  // Feature-flag / integration env vars defined further down in this file.
  // systemd doesn't load /opt/breadbrich/.env globally, so anything that
  // should be operator-configurable must be listed here for readEnvFile to
  // pick it up at process start.
  'FLAT_ACCESS',
  'DISCORD_DM_ALLOWED_ROLE_IDS',
  'DISCORD_DM_ALLOWED_GUILD_IDS',
  'DISCORD_DM_ROLE_REFRESH_INTERVAL',
  'GITHUB_PROJECT_SYNC_ORGS',
  'GITHUB_PROJECT_SYNC_INTERVAL_MS',
  'SHARED_KB_GROUP',
]);

/** Look up an env value, preferring process.env, falling back to .env. */
function envVal(key: string): string | undefined {
  return process.env[key] ?? envConfig[key];
}

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Breadbrich Engels';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

// Cooperative mode (flat access). When enabled, EVERY registered group is
// treated as a privileged "main" group: read-write KB + SQLite store mounts
// and full IPC authorization in every container, with no main/non-main
// distinction. This intentionally removes the prompt-injection trust
// boundary — every channel can read and mutate org-wide data and the RBAC
// tables — so it is only safe when every channel is trusted-internal.
//
// Default ON (this install is a cooperative with equal access for all
// members). Set FLAT_ACCESS=false to restore the sandboxed main/non-main
// model. See docs/COOPERATIVE-MODE.md.
export const FLAT_ACCESS = envVal('FLAT_ACCESS') !== 'false';

/**
 * Whether a group runs with elevated (main-equivalent) privileges for the
 * data-access plane: container mounts, IPC authorization, and snapshots.
 * True for the designated main group always, and for every group when
 * FLAT_ACCESS (cooperative mode) is enabled.
 *
 * NOTE: This governs data access only. Message-trigger behaviour (when the
 * agent wakes up) and the host remote-control plane are deliberately NOT
 * keyed off this — see docs/COOPERATIVE-MODE.md.
 */
export function isPrivilegedGroup(group: { isMain?: boolean }): boolean {
  return group.isMain === true || FLAT_ACCESS;
}

// --- Discord DM role-based allowlist ---
// When DISCORD_DM_ALLOWED_ROLE_IDS is set, the bot will auto-register a DM
// as a group (requires_trigger=0) the first time it receives a message from
// a user who holds any of the listed Discord role IDs in a shared guild.
// Allowlisting is re-checked periodically; if the role is later revoked the
// DM group is auto-deregistered (folder/data preserved).
//
// Default: empty (feature off — DMs from unregistered users are dropped).
function splitIds(raw: string | undefined): string[] {
  return (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
export const DISCORD_DM_ALLOWED_ROLE_IDS = splitIds(
  envVal('DISCORD_DM_ALLOWED_ROLE_IDS'),
);
// Optional: scope role lookup to specific guild IDs. Empty = check every
// guild the bot is in.
export const DISCORD_DM_ALLOWED_GUILD_IDS = splitIds(
  envVal('DISCORD_DM_ALLOWED_GUILD_IDS'),
);
// --- GitHub Projects V2 → KB sync ---
// Comma-separated org slugs whose ProjectsV2 boards should be mirrored into
// the KB. Empty = feature off. Synced items land as
// `context/tasks/GH-<org>-<repo>-<issue#>.md` and synced projects land as
// `context/projects/GHP-<org>-<projectNumber>.md`, sharing the frontmatter
// shape the existing `/projects` page already reads (Option A — single
// unified namespace).
export const GITHUB_PROJECT_SYNC_ORGS = splitIds(
  envVal('GITHUB_PROJECT_SYNC_ORGS'),
);
// How often the sync loop fires. Default 15 minutes. Set to 0 to disable
// even when GITHUB_PROJECT_SYNC_ORGS is non-empty.
export const GITHUB_PROJECT_SYNC_INTERVAL_MS = Math.max(
  0,
  parseInt(envVal('GITHUB_PROJECT_SYNC_INTERVAL_MS') || '900000', 10) || 900000,
);

// Source group whose `context/` directory holds the canonical shared KB
// (people, tasks, calendar, projects, …). Mounted into every container at
// `/workspace/shared-kb` (read-only) by container-runner.ts, and used by
// the GitHub Projects V2 sync as the write target for synced files.
// Must match the systemd unit's CONTEXT_DIR for the kb-ui dashboard or
// the page won't see synced data. Default: slack_main.
export const SHARED_KB_GROUP = envVal('SHARED_KB_GROUP') || 'slack_main';

// How often to re-verify role membership for already-registered DM groups.
// Default 10 min. Set to 0 to disable refresh (allowlist stays sticky).
export const DISCORD_DM_ROLE_REFRESH_INTERVAL = Math.max(
  0,
  parseInt(envVal('DISCORD_DM_ROLE_REFRESH_INTERVAL') || '600000', 10) ||
    600000,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();

// Model routing: orchestrator model and subagent model
export const NANOCLAW_MODEL =
  process.env.NANOCLAW_MODEL || envConfig.NANOCLAW_MODEL || undefined;
export const NANOCLAW_SUBAGENT_MODEL =
  process.env.NANOCLAW_SUBAGENT_MODEL ||
  envConfig.NANOCLAW_SUBAGENT_MODEL ||
  undefined;
