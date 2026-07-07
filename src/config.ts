import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import {
  type McpServerConfig,
  validateMcpServerConfigs,
} from './mcp-servers.js';
import {
  PROJECT_ROOT,
  loadProfileConfig,
  resolveProfileDir,
} from './profile.js';
import { isValidTimezone } from './timezone.js';

export type {
  McpServerConfig,
  McpServerHttpConfig,
  McpServerStdioConfig,
} from './mcp-servers.js';
export { mcpServerEnvVarNames } from './mcp-servers.js';

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
  // systemd doesn't load the install's .env globally, so anything that
  // should be operator-configurable must be listed here for readEnvFile to
  // pick it up at process start.
  'FLAT_ACCESS',
  // Microsoft Teams channel (src/channels/teams.ts). Opt-in via TEAMS_ENABLED;
  // stays fully inert (no HTTP port opened) unless TEAMS_APP_ID +
  // TEAMS_APP_PASSWORD are also set. The secret (TEAMS_APP_PASSWORD) is
  // deliberately NOT listed here — it's read directly by teams.ts via its own
  // readEnvFile call (matching slack.ts's SLACK_BOT_TOKEN / discord.ts's
  // DISCORD_TOKEN), so it never flows through this module or gets exported.
  'TEAMS_ENABLED',
  'TEAMS_APP_ID',
  'TEAMS_APP_TENANT_ID',
  'TEAMS_MESSAGING_PORT',
  'TEAMS_HOST',
  'DISCORD_DM_ALLOWED_ROLE_IDS',
  'DISCORD_DM_ALLOWED_GUILD_IDS',
  'DISCORD_DM_ROLE_REFRESH_INTERVAL',
  'GITHUB_PROJECT_SYNC_ORGS',
  'GITHUB_PROJECT_SYNC_INTERVAL_MS',
  'GITHUB_PROJECT_HIDE_TITLE_PATTERNS',
  'DISCORD_MEMBERS_SYNC_INTERVAL_MS',
  'SLACK_MEMBERS_SYNC_INTERVAL_MS',
  'SHARED_KB_GROUP',
  'LABOR_PROFILE',
  'ENABLED_SKILLS',
  'GATED_ACTION_CLASSES',
  'APPROVAL_TIMEOUT_MINUTES',
  'APPROVAL_EXPIRY_TICK_MS',
  'GITHUB_ORG',
  'SERVICE_USER',
  'REMINDER_LADDER',
  'REMINDER_SWEEP_INTERVAL_MS',
  'REMINDER_TARGET_JID',
  'REMINDER_ESCALATION_CONTACT',
  'GITHUB_SYNC_ISSUE_DEPS',
  'PM_ORCHESTRATION_INTERVAL_MS',
  'PM_ORCHESTRATION_TARGET_GROUP',
  'PM_DUE_SOON_DAYS',
  'PM_DM_COOLDOWN_MS',
  'PM_LEAD',
  'OPS_REPORT_INTERVAL_MS',
  'OPS_REPORT_TARGET_GROUP',
  'OPS_REPORT_AUDIENCE',
  'OPS_REPORT_PERIOD',
  'OPS_REPORT_DUE_SOON_DAYS',
  'OPS_REPORT_OVERLOAD_RATIO',
  'OPS_REPORT_WEB_BASE_URL',
  'OPS_REPORT_PAGEDATA_DIR',
  // Smithers durable-workflow bridge (orchestration/). Inert unless enabled.
  'SMITHERS_BRIDGE_ENABLED',
  'SMITHERS_BRIDGE_PORT',
  'SMITHERS_BRIDGE_TOKEN',
  // Container runtime backend selection + Kubernetes-specific config.
  // See docs/KUBERNETES.md. Inert unless CONTAINER_RUNTIME=kubernetes.
  'CONTAINER_RUNTIME',
  'K8S_NAMESPACE',
  'K8S_VOLUME_MODE',
  'K8S_NODE_NAME',
  'K8S_DATA_PVC_NAME',
  'K8S_POD_IP',
  'AGENT_CONTAINER_MEMORY',
  'AGENT_CONTAINER_CPUS',
  'AGENT_CONTAINER_PIDS_LIMIT',
  // Knowledge connectors (src/integrations/connectors/). Env-gated + off by
  // default. Secrets (NOTION_API_KEY, Google creds file) are NOT read here —
  // they're loaded lazily via readEnvFile in the connector modules so tokens
  // never enter this module's cached config or any log.
  'CONNECTOR_SYNC_INTERVAL_MS',
  'NOTION_ROOT_PAGE_IDS',
  'NOTION_DATABASE_IDS',
  'GOOGLE_DRIVE_FOLDER_IDS',
  // Generic remote-MCP bridge (docs/MCP-SERVERS.md). A JSON array of MCP
  // server configs, additive to the active profile's `mcpServers`. Lets a
  // hosted/multi-tenant install inject servers without editing profile files.
  // Holds only NAMES of env vars for secrets, never secret values.
  'MCP_SERVERS',
]);

/** Look up an env value, preferring process.env, falling back to .env. */
function envVal(key: string): string | undefined {
  return process.env[key] ?? envConfig[key];
}

// --- Active profile (org instance) ---
// The framework is org-agnostic; identity, KB content, and runtime state come
// from the active profile under profiles/<name>/. See src/profile.ts.
export const PROFILE_DIR = resolveProfileDir();
export const PROFILE = loadProfileConfig(PROFILE_DIR);
export { PROJECT_ROOT };

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME ||
  envConfig.ASSISTANT_NAME ||
  PROFILE.assistantName;
export const ORG_NAME = PROFILE.orgName;
export const ORG_SHORT_NAME = PROFILE.orgShortName || PROFILE.orgName;
export const ORG_WEBSITE = PROFILE.orgWebsite;
export const GITHUB_ORG = envVal('GITHUB_ORG') || PROFILE.githubOrg;
export const GITHUB_REPO = PROFILE.githubRepo;
export const KB_DASHBOARD_URL = PROFILE.kbDashboardUrl;

// Container skills that ship disabled by default (SKILL.md frontmatter
// `default: false`) but should be enabled for this install. Merged from the
// active profile's `enabledSkills` and the `ENABLED_SKILLS` env var
// (comma-separated). Skills without the opt-in flag always load and need not
// be listed. Consumed by container-runner.ts when syncing skills into each
// container. See docs/PLUGINS.md → "Opt-in (off-by-default) skills".
export const ENABLED_SKILLS: string[] = (() => {
  const fromEnv = (envVal('ENABLED_SKILLS') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const fromProfile = Array.isArray(PROFILE.enabledSkills)
    ? PROFILE.enabledSkills.map((s) => String(s).trim()).filter(Boolean)
    : [];
  return Array.from(new Set([...fromProfile, ...fromEnv]));
})();

// --- Generic remote-MCP bridge (docs/MCP-SERVERS.md) ---
// The configured MCP servers (remote/HTTP or local/stdio) to wire into every
// agent container, beyond the built-ins (nanoclaw, gws, github, linear).
// Merged from the active profile's `mcpServers` and the `MCP_SERVERS` env var
// (a JSON array, appended after the profile's list — for hosted/multi-tenant
// injection). Validated loudly at startup: a bad name / shape / reserved
// collision throws rather than silently disabling the integration. The
// non-secret shape (name/type/url/command/args + env var NAMES) is threaded to
// the container via ContainerInput; secret VALUES flow only through the
// container's env (see container-runner.ts). See src/mcp-servers.ts.
export const MCP_SERVERS: McpServerConfig[] = (() => {
  const fromProfile = Array.isArray(PROFILE.mcpServers)
    ? PROFILE.mcpServers
    : [];
  const envRaw = envVal('MCP_SERVERS');
  let fromEnv: unknown[] = [];
  if (envRaw && envRaw.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(envRaw);
    } catch (err) {
      throw new Error(
        `MCP_SERVERS env var is not valid JSON: ${(err as Error).message}`,
        { cause: err },
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error('MCP_SERVERS env var must be a JSON array.');
    }
    fromEnv = parsed;
  }
  return validateMcpServerConfigs([...fromProfile, ...fromEnv]);
})();

// --- Human-in-the-loop approval gate (reusable primitive) ---
// Which classes of consequential action require a human approval before the
// agent proceeds. Declared in config/rules, never hardcoded per-op. Merged from
// the active profile's `gatedActionClasses` and the `GATED_ACTION_CLASSES` env
// var (comma-separated); when NEITHER is set, a conservative default set
// applies. See rules/approvals/README.md and src/ipc.ts (request_approval).
//
// Default gated set (conservative — write actions that are hard to undo or that
// reach outside the org). Each token is a stable `action_class` an agent tags
// its proposal with:
//   outbound_external_message — a message/DM/email leaving the org
//   github_write              — opening/merging PRs, pushing, editing issues
//   linear_write              — creating/closing Linear issues/projects
//   kb_delete                 — deleting a knowledge-base document
//   payout                    — moving money / on-chain value
export const DEFAULT_GATED_ACTION_CLASSES: string[] = [
  'outbound_external_message',
  'github_write',
  'linear_write',
  'kb_delete',
  'payout',
];

export const GATED_ACTION_CLASSES: string[] = (() => {
  const fromEnv = (envVal('GATED_ACTION_CLASSES') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const fromProfile = Array.isArray(PROFILE.gatedActionClasses)
    ? PROFILE.gatedActionClasses.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const merged = Array.from(new Set([...fromProfile, ...fromEnv]));
  // Neither profile nor env declared anything → conservative default.
  return merged.length > 0 ? merged : [...DEFAULT_GATED_ACTION_CLASSES];
})();

/** True when the given action_class must go through the human approval gate. */
export function isGatedActionClass(actionClass: string): boolean {
  return GATED_ACTION_CLASSES.includes(actionClass);
}

// KB people-slugs allowed to approve gated actions. Empty → ANY allowlisted
// sender may approve (today's flat model). When non-empty, approval is narrowed
// to these slugs.
export const APPROVER_SLUGS: string[] = Array.isArray(
  PROFILE.approvals?.approverSlugs,
)
  ? PROFILE.approvals!.approverSlugs!.map((s) => String(s).trim()).filter(
      Boolean,
    )
  : [];

// Minutes a pending approval stays open before auto-expiry. 0 → never expires.
export const APPROVAL_TIMEOUT_MINUTES: number = (() => {
  const raw = envVal('APPROVAL_TIMEOUT_MINUTES');
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  if (
    PROFILE.approvals &&
    typeof PROFILE.approvals.timeoutMinutes === 'number'
  ) {
    return Math.max(0, Math.floor(PROFILE.approvals.timeoutMinutes));
  }
  // Present-but-unset block, or no block at all → 24h default.
  return 1440;
})();

export const SERVICE_USER =
  envVal('SERVICE_USER') || PROFILE.serviceUser || 'breadbrich';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
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
// Runtime state lives under the active profile so multiple orgs can coexist
// in one checkout (one active at a time, selected via LABOR_PROFILE).
export const STORE_DIR = path.resolve(PROFILE_DIR, 'store');
export const GROUPS_DIR = path.resolve(PROFILE_DIR, 'groups');
export const DATA_DIR = path.resolve(PROFILE_DIR, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);

// --- Container runtime backend ---
// 'docker' (default, self-hosters) or 'kubernetes' (hosted SaaS — one
// namespace per tenant, orchestrator as a Deployment, agent runs as Pods in
// the same namespace). See docs/KUBERNETES.md and src/container-runtime-k8s.ts.
export type ContainerRuntimeKind = 'docker' | 'kubernetes';
export const CONTAINER_RUNTIME: ContainerRuntimeKind =
  envVal('CONTAINER_RUNTIME') === 'kubernetes' ? 'kubernetes' : 'docker';

// Namespace kubectl targets. Empty = use the current kubeconfig context's
// default namespace (kubectl's own behavior when --namespace is omitted).
export const K8S_NAMESPACE = envVal('K8S_NAMESPACE') || '';

// How agent pods get the same filesystem view as the orchestrator:
// 'hostPath' (default) pins agent pods to the orchestrator's node via
// K8S_NODE_NAME and bind-mounts host paths directly, matching Docker's
// single-host trust model. 'pvc' mounts a shared RWX PersistentVolumeClaim
// (K8S_DATA_PVC_NAME) with subPaths mirroring the profile's relative layout,
// for real multi-node clusters. See docs/KUBERNETES.md "Volumes".
export type K8sVolumeMode = 'hostPath' | 'pvc';
export const K8S_VOLUME_MODE: K8sVolumeMode =
  envVal('K8S_VOLUME_MODE') === 'pvc' ? 'pvc' : 'hostPath';

// Downward-API env vars the orchestrator Deployment must inject (see
// deploy/k8s/tenant-example/deployment.yaml). Read here, not computed, so a
// missing value fails loudly (undefined) rather than guessing.
export const K8S_NODE_NAME = envVal('K8S_NODE_NAME') || '';
export const K8S_POD_IP = envVal('K8S_POD_IP') || '';

// PVC claim name shared by the orchestrator Deployment and every agent Pod
// when K8S_VOLUME_MODE=pvc. Required in that mode; unused in hostPath mode.
export const K8S_DATA_PVC_NAME = envVal('K8S_DATA_PVC_NAME') || '';

// Agent container resource limits — shared between the docker and kubernetes
// backends. Empty = no limit applied (current behavior, unchanged default).
export const AGENT_CONTAINER_MEMORY = envVal('AGENT_CONTAINER_MEMORY') || '';
export const AGENT_CONTAINER_CPUS = envVal('AGENT_CONTAINER_CPUS') || '';
export const AGENT_CONTAINER_PIDS_LIMIT =
  envVal('AGENT_CONTAINER_PIDS_LIMIT') || '';
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
// When an agent session is FRESH (no prior transcript — first run, or the
// session was cleared/expired), the per-turn "messages since cursor" prompt can
// be as little as one message, leaving the agent with no idea what the user is
// referring to ("this", "that one"). On a fresh session we instead backfill the
// last N messages of the chat for continuity. Resumed sessions are unaffected.
export const FRESH_SESSION_BACKFILL_MESSAGES = Math.max(
  1,
  parseInt(process.env.FRESH_SESSION_BACKFILL_MESSAGES || '40', 10) || 40,
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

// --- Microsoft Teams channel (src/channels/teams.ts) ---
// Non-secret feature flags, exported for anything outside the channel module
// that needs to know Teams is configured (e.g. setup/status tooling). The App
// ID is not a secret (it's a public GUID identifying the Azure AD app
// registration) but TEAMS_APP_PASSWORD (the app's client secret) is — that one
// is intentionally read only inside teams.ts itself and never exported here.
export const TEAMS_ENABLED = envVal('TEAMS_ENABLED') === 'true';
export const TEAMS_APP_ID = envVal('TEAMS_APP_ID') || '';
export const TEAMS_APP_TENANT_ID = envVal('TEAMS_APP_TENANT_ID') || '';
export const TEAMS_MESSAGING_PORT = parseInt(
  envVal('TEAMS_MESSAGING_PORT') || '3978',
  10,
);
export const TEAMS_HOST = envVal('TEAMS_HOST') || '0.0.0.0';
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
// Case-insensitive **substring** patterns: any project whose title contains
// one of these strings is skipped at sync time (and so are its items). Empty
// titles are always skipped. Default catches GitHub's auto-named
// "@<user>'s untitled project" boards plus the Micro/Macro categorization
// boards. Override with a comma-separated list; set to a single comma to
// disable filtering.
export const GITHUB_PROJECT_HIDE_TITLE_PATTERNS = (
  envVal('GITHUB_PROJECT_HIDE_TITLE_PATTERNS') ?? 'untitled,micro,macro'
)
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
// How often the sync loop fires. Default 15 minutes. Set to 0 to disable
// even when GITHUB_PROJECT_SYNC_ORGS is non-empty.
export const GITHUB_PROJECT_SYNC_INTERVAL_MS = Math.max(
  0,
  parseInt(envVal('GITHUB_PROJECT_SYNC_INTERVAL_MS') || '900000', 10) || 900000,
);

// Whether the GitHub sync pulls issue dependency (blocked-by/blocking) and
// sub-issue (parent/child) edges into synced task frontmatter (#31). Default on;
// the sync degrades gracefully (retries without edges) if an instance lacks the
// GraphQL fields, but this lets an operator disable the attempt entirely.
export const GITHUB_SYNC_ISSUE_DEPS =
  (envVal('GITHUB_SYNC_ISSUE_DEPS') ?? 'true') !== 'false';

// --- PM orchestration (#31) ---
// Periodic loop that reviews the GitHub-synced + hand-authored task graph and
// wakes the agent to re-estimate/re-plan and DM blockers/overdue owners.
// Default weekly; 0 disables the loop entirely.
export const PM_ORCHESTRATION_INTERVAL_MS = Math.max(
  0,
  parseInt(envVal('PM_ORCHESTRATION_INTERVAL_MS') || '604800000', 10) ||
    604800000,
);
// Group whose chat receives the PM run / agent context. Empty → SHARED_KB_GROUP.
export const PM_ORCHESTRATION_TARGET_GROUP =
  envVal('PM_ORCHESTRATION_TARGET_GROUP') || '';
// A task is "due soon" (flagged in the brief) within this many days of its deadline.
export const PM_DUE_SOON_DAYS = Math.max(
  0,
  parseInt(envVal('PM_DUE_SOON_DAYS') || '7', 10) || 7,
);
// Don't re-DM the same person about the same task+reason within this window.
// Default ~6 days (shorter than the weekly cadence).
export const PM_DM_COOLDOWN_MS = Math.max(
  0,
  parseInt(envVal('PM_DM_COOLDOWN_MS') || '518400000', 10) || 518400000,
);
// Fallback contact for overdue/blocking items that have no assignee — the agent
// raises unowned work to this person (and the channel) instead of dropping it.
// Empty = post unowned items to the channel only.
export const PM_LEAD = envVal('PM_LEAD') || '';

// --- Operational reports (#34) ---
// Recurring leadership readout of operational state (what's late by team/person,
// per-member load vs. declared capacity with a soft over-capacity flag, and a
// bottleneck digest). Deterministic — no agent run, no API spend. Default
// weekly; 0 disables the loop. Sweeps more often than it posts (idempotent
// per-period via ops_report_log), so a daily sweep still posts once a week.
export const OPS_REPORT_INTERVAL_MS = Math.max(
  0,
  parseInt(envVal('OPS_REPORT_INTERVAL_MS') || '86400000', 10) || 86400000,
);
// Group whose chat receives the report. Empty → SHARED_KB_GROUP. Point this at a
// private leadership channel when the audience is 'leaders'.
export const OPS_REPORT_TARGET_GROUP = envVal('OPS_REPORT_TARGET_GROUP') || '';
// 'leaders' → full per-person hours/load detail (private channel).
// 'coop'    → team-level aggregates + gentler framing, no per-person hours.
export const OPS_REPORT_AUDIENCE: 'leaders' | 'coop' =
  (envVal('OPS_REPORT_AUDIENCE') || 'leaders') === 'coop' ? 'coop' : 'leaders';
// Idempotency / cadence bucket: at most one post per 'weekly' (ISO week) or
// 'monthly' period.
export const OPS_REPORT_PERIOD: 'weekly' | 'monthly' =
  (envVal('OPS_REPORT_PERIOD') || 'weekly') === 'monthly'
    ? 'monthly'
    : 'weekly';
// A task counts as "due soon" within this many days of its deadline.
export const OPS_REPORT_DUE_SOON_DAYS = Math.max(
  0,
  parseInt(envVal('OPS_REPORT_DUE_SOON_DAYS') || '7', 10) || 7,
);
// Soft-flag a member as over capacity when open estimate / declared capacity
// exceeds this ratio. Default 1.0 (any over-capacity). Parsed as a float.
export const OPS_REPORT_OVERLOAD_RATIO = (() => {
  const v = parseFloat(envVal('OPS_REPORT_OVERLOAD_RATIO') || '1');
  return Number.isFinite(v) && v > 0 ? v : 1;
})();
// Web delivery (#34): when set, the report is published as a StatiCrypt-encrypted
// HTML page (reusing the agenda-web service, serve.mjs) and the leader is DM'd a
// LINK instead of raw markdown. Empty → falls back to the markdown DM.
//   OPS_REPORT_WEB_BASE_URL  — public base URL (no trailing slash), e.g.
//                              https://host:8091. The page is <base>/ops-<id>.html.
//   OPS_REPORT_PAGEDATA_DIR  — directory to write ops-<id>.json into; the running
//                              agenda-web service must be pointed at (watch) this
//                              dir so it renders + encrypts the page. The StatiCrypt
//                              password is the existing AGENDA_WEB_PASSWORD (reused).
export const OPS_REPORT_WEB_BASE_URL = (envVal('OPS_REPORT_WEB_BASE_URL') || '')
  .trim()
  .replace(/\/$/, '');
export const OPS_REPORT_PAGEDATA_DIR = (
  envVal('OPS_REPORT_PAGEDATA_DIR') || ''
).trim();

// Source group whose `context/` directory holds the canonical shared KB
// (people, tasks, calendar, projects, …). Mounted into every container at
// `/workspace/shared-kb` (read-only) by container-runner.ts, and used by
// the GitHub Projects V2 sync as the write target for synced files.
// Must match the systemd unit's CONTEXT_DIR for the kb-ui dashboard or
// the page won't see synced data. Default: slack_main.
export const SHARED_KB_GROUP =
  envVal('SHARED_KB_GROUP') || PROFILE.sharedKbGroup || 'slack_main';

// How often the Discord-members → KB people sync re-runs in the background
// (alongside the DM-allowlist refresh, but on its own cadence). Default 1
// hour. Set to 0 to disable the periodic loop; the one-shot
// `npm run sync-discord-members` still works.
export const DISCORD_MEMBERS_SYNC_INTERVAL_MS = Math.max(
  0,
  parseInt(envVal('DISCORD_MEMBERS_SYNC_INTERVAL_MS') || '3600000', 10) ||
    3600000,
);

// How often the Slack-members → KB people sync re-runs in the background.
// Default 0 (disabled — opt-in): blanket-syncing every workspace member is
// opinionated, so installs enable it explicitly. The one-shot
// `npm run sync-slack-members` works regardless of this setting.
export const SLACK_MEMBERS_SYNC_INTERVAL_MS = Math.max(
  0,
  parseInt(envVal('SLACK_MEMBERS_SYNC_INTERVAL_MS') || '0', 10) || 0,
);

// How often to re-verify role membership for already-registered DM groups.
// Default 10 min. Set to 0 to disable refresh (allowlist stays sticky).
export const DISCORD_DM_ROLE_REFRESH_INTERVAL = Math.max(
  0,
  parseInt(envVal('DISCORD_DM_ROLE_REFRESH_INTERVAL') || '600000', 10) ||
    600000,
);

// --- Escalating-deadline reminder engine (#25) ---
// The escalation ladder: offsets-before-deadline at which a reminder fires,
// each as a duration string (`w`/`d`/`h`/`m`). The closest (smallest) rung is
// the "final tick" that loops in the escalation contact; an OVERDUE rung fires
// once the deadline passes if the item still isn't done. Comma-separated;
// default T-3w → T-1w → T-3d → T-1d.
export const REMINDER_LADDER = (envVal('REMINDER_LADDER') || '3w,1w,3d,1d')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// How often the reminder sweep runs. Rungs are day-scale, so 1h is plenty.
// Set to 0 to disable the engine entirely.
export const REMINDER_SWEEP_INTERVAL_MS = Math.max(
  0,
  parseInt(envVal('REMINDER_SWEEP_INTERVAL_MS') || '3600000', 10) || 3600000,
);
// Where reminders are delivered. Defaults to the shared-KB group's chat (the
// channel the team already watches) when unset; set to a specific `slack:` /
// `dc:` / `tg:` JID to override. Owners/escalation contacts are named in the
// message text since per-person DM isn't available on every channel.
export const REMINDER_TARGET_JID = envVal('REMINDER_TARGET_JID') || '';
// Org-wide fallback escalation contact, used for items that don't declare an
// `escalation_contact` of their own.
export const REMINDER_ESCALATION_CONTACT =
  envVal('REMINDER_ESCALATION_CONTACT') || '';

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
    PROFILE.timezone,
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

// Smithers durable-workflow bridge (orchestration/). Off by default; when
// enabled, exposes a localhost-only, token-authed endpoint that runs one
// workflow step through runContainerAgent. See docs/SMITHERS-ORCHESTRATION.md.
export const SMITHERS_BRIDGE_ENABLED =
  envVal('SMITHERS_BRIDGE_ENABLED') === 'true';
export const SMITHERS_BRIDGE_PORT = Number(
  envVal('SMITHERS_BRIDGE_PORT') || 3002,
);
export const SMITHERS_BRIDGE_TOKEN = envVal('SMITHERS_BRIDGE_TOKEN') || '';

// --- Knowledge connectors (RAG) ---
// External sources (Notion, Google Drive, …) synced INTO the per-group KB as
// markdown so RBAC, search, and citations apply. Each connector self-registers
// (src/integrations/connectors/) and is env-gated. See docs/CONNECTORS.md.
//
// Shared poll interval for all connectors unless a connector overrides it.
// Default 30 min. Set to 0 to disable every connector loop at once.
export const CONNECTOR_SYNC_INTERVAL_MS = Math.max(
  0,
  parseInt(envVal('CONNECTOR_SYNC_INTERVAL_MS') || '1800000', 10) || 1800000,
);
// Notion scope: comma-separated page ids (subtrees) and/or database ids to
// mirror. Empty (both) → Notion connector off. The API key itself is a secret,
// read lazily via readEnvFile (NOTION_API_KEY), never here.
export const NOTION_ROOT_PAGE_IDS = splitIds(envVal('NOTION_ROOT_PAGE_IDS'));
export const NOTION_DATABASE_IDS = splitIds(envVal('NOTION_DATABASE_IDS'));
// Google Drive scope: comma-separated Drive folder ids whose Google Docs are
// mirrored. Empty → Drive connector off. Auth reuses the existing
// GOOGLE_WORKSPACE_CREDENTIALS_FILE (the same OAuth creds the `gws` tool uses).
export const GOOGLE_DRIVE_FOLDER_IDS = splitIds(
  envVal('GOOGLE_DRIVE_FOLDER_IDS'),
);
