/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, execFileSync, spawn } from 'child_process';
import { createHash } from 'crypto';
import os from 'os';
import fs from 'fs';
import path from 'path';

import {
  AGENT_CONTAINER_CPUS,
  AGENT_CONTAINER_MEMORY,
  AGENT_CONTAINER_PIDS_LIMIT,
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_RUNTIME,
  DOCKER_SIBLING_MODE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  ENABLED_SKILLS,
  GITHUB_APP_MODE,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  K8S_NAMESPACE,
  K8S_NODE_NAME,
  K8S_POD_IP,
  K8S_VOLUME_MODE,
  K8S_DATA_PVC_NAME,
  KB_DASHBOARD_URL,
  MCP_SERVERS,
  mcpServerEnvVarNames,
  LOCAL_LLM_API_KEY,
  LOCAL_LLM_BASE_URL,
  LOCAL_LLM_MODEL,
  NANOCLAW_BACKEND,
  NANOCLAW_MODEL,
  NANOCLAW_SUBAGENT_MODEL,
  PROFILE_DIR,
  SHARED_KB_GROUP,
  STORE_DIR,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  resourceLimitArgs,
  stopContainer,
} from './container-runtime.js';
import {
  buildK8sPodOverrides,
  buildKubectlRunArgs,
  warnPidsLimitUnsupported,
  type K8sEnvVar,
  type PvcRootMapping,
} from './container-runtime-k8s.js';
import { detectAuthMode } from './credential-proxy.js';
import { readEnvFile } from './env.js';
import type { McpServerConfig } from './mcp-servers.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

/**
 * Whether a container skill loads by default. A skill opts out by setting
 * `default: false` in its SKILL.md YAML frontmatter; such skills only sync
 * into containers whose install lists them in ENABLED_SKILLS. Any skill
 * without the flag (or without a readable SKILL.md) loads by default, keeping
 * existing skills backwards-compatible.
 */
function skillEnabledByDefault(skillDir: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
  } catch {
    return true;
  }
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return true;
  const m = fm[1].match(/^\s*default:\s*(\S+)\s*$/im);
  if (!m) return true;
  return m[1].toLowerCase() !== 'false';
}

/**
 * Newest file mtime (ms) anywhere under `dir`, recursively; 0 if the dir is
 * missing/empty. Used to decide whether the per-group agent-runner source
 * cache is stale against the live source — comparing whole trees rather than a
 * single sentinel file so a change to any file invalidates the cache.
 */
function latestMtimeMs(dir: string): number {
  let latest = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return latest;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        latest = Math.max(latest, latestMtimeMs(p));
      } else {
        latest = Math.max(latest, fs.statSync(p).mtimeMs);
      }
    } catch {
      // Skip files that vanish mid-scan; they don't affect staleness.
    }
  }
  return latest;
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  /**
   * Restrict the agent to exactly these tools (replaces the default allowlist).
   * Used to sandbox external chat flows (src/chat-flows/) to read-only tools.
   */
  allowedTools?: string[];
  /**
   * Extra text appended to the system prompt (e.g. a chat flow's persona),
   * in addition to the global CLAUDE.md.
   */
  systemPromptAppend?: string;
  /**
   * Override the orchestrator model for this single run, taking precedence
   * over the global NANOCLAW_MODEL. Lets a durable-workflow step (see
   * orchestration/) route an individual task to a cheaper/local or stronger
   * model without changing global config. Unset = current global behavior.
   */
  modelOverride?: string;
  /**
   * The caller will stop this container itself (docker kill/stop by name) once
   * the result marker has streamed — the Smithers bridge does this because the
   * agent-runner lingers after its one-shot result. A non-zero exit after
   * streamed output is then expected teardown, logged at info instead of the
   * usual 'Container exited with error'. Unset = current behavior.
   */
  expectExternalStop?: boolean;
  /**
   * Config-driven MCP servers (generic remote-MCP bridge). The NON-SECRET
   * shape (name/type/url/command/args + env var NAMES) is threaded to the
   * container via this stdin-JSON payload; the referenced secret VALUES flow
   * separately through the container's env (docker `-e NAME` passthrough /
   * kubernetes resolved pod env — see buildContainerArgs / buildK8sEnvVars).
   * Sourced from MCP_SERVERS in config.ts. See docs/MCP-SERVERS.md.
   */
  mcpServers?: McpServerConfig[];
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

/**
 * Build the per-run agent container/pod name. It must be valid for BOTH docker
 * and Kubernetes, and k8s is the strict one: an RFC 1123 label — lowercase
 * alphanumeric + '-', start/end alphanumeric, ≤63 chars. Group folders derived
 * from a Signal base64 group id are mixed-case AND long (e.g.
 * `signal_Inemj-Z44SEhClgLNmmZz_9VssUy41snEdmP0BcPSrg`), which the old
 * `nanoclaw-<folder>-<ts>` produced as an invalid pod name → the agent spawn
 * failed with "Invalid value ... must be no more than 63 characters". Lowercase
 * the folder and, when the full name would overflow 63 chars, truncate it and
 * append a short stable hash for uniqueness. Pure — unit-tested.
 */
export function buildAgentContainerName(folder: string, nowMs: number): string {
  const prefix = 'nanoclaw-';
  const suffix = `-${nowMs}`;
  const budget = 63 - prefix.length - suffix.length;
  let base = folder
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .toLowerCase()
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (base.length > budget) {
    const h = createHash('sha1').update(folder).digest('hex').slice(0, 8);
    base = base.slice(0, budget - 9).replace(/-+$/, '') + '-' + h;
  }
  if (!base) base = '0';
  return `${prefix}${base}${suffix}`;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/** One entry of the orchestrator's own container mount table (docker inspect). */
interface SelfMount {
  dest: string;
  src: string;
}

/**
 * Parse `docker inspect --format '{{json .Mounts}}'` output into a
 * container-destination → host-source map, sorted longest-destination-first so
 * the deepest matching prefix wins (e.g. /app/profiles/<org>/store, a separate
 * volume, is chosen over /app/profiles). Pure — unit-tested without a daemon.
 */
export function parseSelfMounts(inspectJson: string): SelfMount[] {
  let raw: Array<{ Destination?: string; Source?: string }>;
  try {
    raw = JSON.parse(inspectJson);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m.Destination && m.Source)
    .map((m) => ({
      dest: m.Destination!.replace(/\/+$/, ''),
      src: m.Source!.replace(/\/+$/, ''),
    }))
    .sort((a, b) => b.dest.length - a.dest.length);
}

/**
 * Translate an orchestrator-internal bind-mount source (e.g.
 * /app/profiles/<org>/groups/<folder>) to the real HOST path, using the
 * orchestrator's own mount table. Longest-destination-prefix wins. Paths not
 * under any mounted destination (and the /dev/null stub) pass through
 * unchanged. Pure — unit-tested. See DOCKER_SIBLING_MODE.
 */
export function translateSiblingHostPath(
  hostPath: string,
  selfMounts: SelfMount[],
): string {
  if (hostPath === '/dev/null') return hostPath;
  for (const { dest, src } of selfMounts) {
    if (hostPath === dest) return src;
    if (hostPath.startsWith(dest + '/')) {
      return src + hostPath.slice(dest.length);
    }
  }
  return hostPath;
}

// Cached self mount table — resolved once per process (the orchestrator's own
// mounts don't change while it runs). Empty array => translation is a no-op.
let selfMountsCache: SelfMount[] | null = null;

/**
 * Resolve the orchestrator's own container mount table via `docker inspect`
 * (used only in DOCKER_SIBLING_MODE). The container's hostname is its short id,
 * which `docker inspect` accepts; DOCKER_SELF_CONTAINER overrides it. On any
 * failure this returns [] and every mount passes through unchanged (so a
 * misconfigured deploy degrades to today's behavior instead of crashing).
 */
function getSelfMounts(): SelfMount[] {
  if (selfMountsCache) return selfMountsCache;
  const selfRef = process.env.DOCKER_SELF_CONTAINER || os.hostname();
  try {
    const out = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['inspect', selfRef, '--format', '{{json .Mounts}}'],
      { encoding: 'utf-8' },
    );
    const parsed = parseSelfMounts(out);
    if (parsed.length === 0) {
      logger.warn(
        { selfRef },
        'docker-sibling: self mount table empty — agent mounts will not be host-translated',
      );
    }
    selfMountsCache = parsed;
  } catch (err) {
    logger.error(
      { selfRef, err },
      'docker-sibling: failed to inspect self container; agent mounts left untranslated',
    );
    selfMountsCache = [];
  }
  return selfMountsCache;
}

/**
 * Decide the host-resolvable source for a mount under DOCKER_SIBLING_MODE, or
 * signal that it must be SKIPPED. Off (default) → return the path unchanged.
 *
 * On:
 *  - /dev/null and volume-backed paths (translatable) → their real host path;
 *  - a path under the orchestrator's OWN image dir (process.cwd(), e.g. /app)
 *    that does NOT map to a mounted volume → null (SKIP): it's framework code
 *    baked into the image, which the host daemon can't bind and the sibling
 *    agent doesn't need — it ships its own copy. This is the `mkdir /app:
 *    read-only file system` case for cooperative/main groups (the project-root
 *    read-only mount);
 *  - any other (genuine external host) path → unchanged.
 * Pure given the self-mount table; the null-skip branch is unit-tested.
 */
export function siblingMountSource(
  hostPath: string,
  selfMounts: SelfMount[],
  imageRoot: string,
): string | null {
  if (hostPath === '/dev/null') return hostPath;
  const translated = translateSiblingHostPath(hostPath, selfMounts);
  if (translated !== hostPath) return translated;
  const root = imageRoot.replace(/\/+$/, '');
  if (root && (hostPath === root || hostPath.startsWith(root + '/'))) {
    return null;
  }
  return hostPath;
}

/**
 * Map a mount's source to a host-resolvable path when DOCKER_SIBLING_MODE is
 * on, or null to skip it; otherwise return it unchanged (host-based docker +
 * kubernetes paths are untouched).
 */
function mountSource(hostPath: string): string | null {
  if (!DOCKER_SIBLING_MODE) return hostPath;
  const src = siblingMountSource(hostPath, getSelfMounts(), process.cwd());
  if (src === null) {
    logger.debug(
      { hostPath },
      'docker-sibling: skipping image-dir mount (agent uses its own image copy)',
    );
  }
  return src;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // The read-only project-root bind (framework code at /workspace/project)
    // and its /dev/null .env shadow are DOCKER-ONLY. Under docker each bind is
    // independent, so nesting the writable store at /workspace/project/store
    // under the read-only /workspace/project bind is fine (docker creates the
    // nested mountpoint leniently). Under CONTAINER_RUNTIME=kubernetes every
    // bind becomes a SEPARATE subPath volumeMount: mounting projectRoot
    // read-only at /workspace/project and then the store at
    // /workspace/project/store makes the kubelet try to create the
    // /workspace/project/store mountpoint UNDER the read-only /workspace/project
    // mount, which fails with
    // "mkdirat .../workspace/project/store: read-only file system" (exit 128)
    // and drops every message. So on kubernetes we SKIP the project-root bind
    // (and, with nothing mounted there, its now-pointless .env shadow) —
    // mirroring the DOCKER_SIBLING_MODE/TEE image-dir skip: the agent pod ships
    // its OWN image with the framework code and reads guidance from the synced
    // container skills, its own /workspace/group CLAUDE.md, /workspace/global,
    // /workspace/all-groups and /workspace/shared-kb. With /workspace/project
    // gone the store below is no longer nested under a read-only parent, so the
    // kubelet creates /workspace/project(/store) cleanly on the writable
    // rootfs. Docker (host + sibling/TEE) is byte-for-byte unchanged.
    // See docs/KUBERNETES.md ("Cooperative / main groups under kubernetes").
    if (CONTAINER_RUNTIME !== 'kubernetes') {
      // Main gets the project root read-only. Writable paths the agent needs
      // (store, group folder, IPC, .claude/) are mounted separately below.
      // Read-only prevents the agent from modifying host application code
      // (src/, dist/, package.json, etc.) which would bypass the sandbox
      // entirely on next restart.
      mounts.push({
        hostPath: projectRoot,
        containerPath: '/workspace/project',
        readonly: true,
      });

      // Shadow .env so the agent cannot read secrets from the mounted project
      // root. Credentials are injected by the credential proxy, never exposed
      // to containers.
      const envFile = path.join(projectRoot, '.env');
      if (fs.existsSync(envFile)) {
        mounts.push({
          hostPath: '/dev/null',
          containerPath: '/workspace/project/.env',
          readonly: true,
        });
      }
    }

    // Main gets writable access to the store (SQLite DB) so it can
    // query and write to the database directly. The DB lives under the
    // active profile (STORE_DIR), surfaced at the same container path.
    //
    // The mount target /workspace/project/store sits UNDER the read-only
    // /workspace/project bind (= projectRoot). Docker can only create that
    // nested mountpoint if projectRoot/store exists on the host. In the
    // profile layout the real store is STORE_DIR (profiles/<name>/store),
    // so projectRoot/store is otherwise absent — the deploy migration moves
    // the legacy root-level store/ into the profile. Without a stub the
    // container dies at startup with "mkdirat .../store: read-only file
    // system" (code 125) and every message is dropped. Ensure an empty stub
    // mountpoint exists so the writable store bind can mount over it.
    // Idempotent, and a no-op in the legacy root layout (STORE_DIR == stub).
    //
    // This stub is a Docker nested-bind-mount workaround only. Under
    // CONTAINER_RUNTIME=kubernetes the store is a separate volumeMount and the
    // read-only /workspace/project bind is not created at all (see above), so
    // /workspace/project/store is no longer nested under a read-only parent —
    // the kubelet creates /workspace/project(/store) on the writable rootfs and
    // no stub is needed. Creating the stub on host would also throw EACCES
    // (projectRoot is the read-only image dir, not writable by the non-root
    // orchestrator user) and drop every run. Skip it under kubernetes, and
    // treat a failure elsewhere as non-fatal (best-effort) rather than
    // crashing the run.
    if (CONTAINER_RUNTIME !== 'kubernetes') {
      const storeMountpoint = path.join(projectRoot, 'store');
      if (!fs.existsSync(storeMountpoint)) {
        try {
          fs.mkdirSync(storeMountpoint, { recursive: true });
        } catch (err) {
          logger.warn(
            { storeMountpoint, err },
            'Could not create project-root store stub mountpoint (continuing)',
          );
        }
      }
    }
    mounts.push({
      hostPath: STORE_DIR,
      containerPath: '/workspace/project/store',
      readonly: false,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Main also gets read-only visibility into every other group folder
    // (per-group CLAUDE.md, conversation logs, context, attachments) so the
    // orchestrator can answer "what is the personal assistant dealing with in X chat?".
    // Symmetric counterpart to /workspace/shared-kb (which goes the other
    // direction). Read-only — main cannot mutate other groups' state via
    // this mount; a separate privileged IPC op handles writes.
    mounts.push({
      hostPath: GROUPS_DIR,
      containerPath: '/workspace/all-groups',
      readonly: true,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Shared KB — slack_main is the canonical location for cross-group
  // KB content (people, calendar, tasks, artifacts). Mount it
  // read-only at /workspace/shared-kb so every group container can
  // resolve "who is X" / "what's on the calendar" lookups without
  // needing the files duplicated under their own group folder.
  // Set SHARED_KB_GROUP in .env to override the source group (default: slack_main).
  const sharedKbDir = path.join(GROUPS_DIR, SHARED_KB_GROUP, 'context');
  if (fs.existsSync(sharedKbDir)) {
    mounts.push({
      hostPath: sharedKbDir,
      containerPath: '/workspace/shared-kb',
      readonly: true,
    });
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  // Always regenerate settings to pick up model config changes
  const settingsObj: Record<string, unknown> = {
    env: {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    },
  };
  // Route sub-agents (Task/TeamCreate) to a different model than the orchestrator
  if (NANOCLAW_SUBAGENT_MODEL) {
    (settingsObj as Record<string, Record<string, string>>).agents = {
      model: NANOCLAW_SUBAGENT_MODEL,
    };
  }
  fs.writeFileSync(settingsFile, JSON.stringify(settingsObj, null, 2) + '\n');

  // Sync skills into each group's .claude/skills/. Core framework skills from
  // container/skills/ first, then the active profile's container-skills/ on
  // top — so an org can add or override agent skills without forking core.
  const skillsDst = path.join(groupSessionsDir, 'skills');
  const skillSources = [
    path.join(process.cwd(), 'container', 'skills'),
    path.join(PROFILE_DIR, 'container-skills'),
  ];
  for (const skillsSrc of skillSources) {
    if (!fs.existsSync(skillsSrc)) continue;
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      // Opt-in skills (SKILL.md frontmatter `default: false`) only sync when
      // this install enables them by folder name (profile.enabledSkills or the
      // ENABLED_SKILLS env var). Clear any stale copy so disabling a skill in
      // config removes it from the container on the next run.
      if (
        !skillEnabledByDefault(srcDir) &&
        !ENABLED_SKILLS.includes(skillDir)
      ) {
        fs.rmSync(dstDir, { recursive: true, force: true });
        continue;
      }
      // Clear the destination first so a profile overlay fully replaces a
      // same-named core skill (and stale files from a prior run never linger).
      fs.rmSync(dstDir, { recursive: true, force: true });
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  // Request/response channel (e.g. fetch_discord_history): the agent writes
  // to requests/, the orchestrator writes replies to responses/.
  fs.mkdirSync(path.join(groupIpcDir, 'requests'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'responses'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    // Re-copy when ANY source file is newer than the cached copy — not just
    // index.ts. Keying only on index.ts (the previous behavior) meant a change
    // to e.g. ipc-mcp-stdio.ts (an MCP tool) deployed to the host but never
    // reached running containers, because index.ts's mtime hadn't moved. We
    // compare the newest mtime across each tree instead. cpSync stamps the
    // cache files at copy time, so right after a copy the cache is newer and
    // no redundant re-copy happens.
    const needsCopy =
      !fs.existsSync(groupAgentRunnerDir) ||
      latestMtimeMs(agentRunnerSrc) > latestMtimeMs(groupAgentRunnerDir);
    if (needsCopy) {
      fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  // Google Workspace credentials file for the bundled `gws` MCP server.
  // Mounted read-only at a fixed in-container path so its contents (refresh
  // token + access token) never appear in argv or env values. Container env
  // var GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE points the MCP server at it.
  const gwsCredsHostPath = resolveGoogleWorkspaceCredsPath();
  if (gwsCredsHostPath) {
    mounts.push({
      hostPath: gwsCredsHostPath,
      containerPath: CONTAINER_GWS_CREDS_PATH,
      readonly: true,
    });
  }

  return mounts;
}

/**
 * Breadbrich's GitHub PAT for the bundled github-mcp-server, read from
 * .env (with process.env fallback). Returns undefined when unset, which
 * leaves the GitHub MCP server unloaded inside the container.
 *
 * Docker path: the value is NEVER placed in the container argv — it is
 * passed through the spawned runtime's process environment instead (bare
 * `-e NAME` passthrough), so it cannot leak via the debug log of
 * containerArgs or host process args.
 *
 * Kubernetes path: kubectl run has no equivalent of "read this var from my
 * own process env," so buildK8sEnvVars resolves the value directly into the
 * pod spec's env list (part of the --overrides argv). redactSecretsInArgs
 * strips it back out before that argv is written to the debug log.
 */
function getGithubToken(): string | undefined {
  return (
    readEnvFile(['GITHUB_PERSONAL_ACCESS_TOKEN'])
      .GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN
  );
}

// --- Hosted GitHub App token broker (GITHUB_APP_MODE) ---------------------
//
// In hosted/app mode the GitHub token injected into an agent container is a
// short-lived GitHub App INSTALLATION token minted on demand by the control
// plane, instead of a static PAT. The control-plane contract:
//
//   POST {CONTROL_PLANE_URL}/api/instance/github/token
//   Authorization: Bearer {CONTROL_PLANE_TOKEN}
//   200 -> { token, expiresAt (ISO), mode: 'app' }
//   404 -> { error: 'github_not_installed' }   (org hasn't installed the App)
//   502 -> mint failure
//
// The minted token is cached module-wide and reused across spawns until it is
// within GITHUB_APP_TOKEN_REFRESH_SKEW_MS of expiry, then re-minted. Any broker
// failure (network, non-200, malformed body) logs a warning and falls back to
// the static env PAT (getGithubToken()) — which itself may be undefined, in
// which case the agent simply runs without GitHub (spawn is NOT aborted).
const GITHUB_BROKER_TIMEOUT_MS = 20_000;
const GITHUB_APP_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh under 5 min

interface CachedGithubAppToken {
  token: string;
  expiresAtMs: number;
}
let cachedGithubAppToken: CachedGithubAppToken | undefined;

/**
 * Read CONTROL_PLANE_URL / CONTROL_PLANE_TOKEN (process.env, then .env),
 * mirroring the shared-bot send proxies (telegram-sender.ts etc.). Returns null
 * when either is missing — the broker can't function without both.
 */
function controlPlaneConfig(): { url: string; token: string } | null {
  const env = readEnvFile(['CONTROL_PLANE_URL', 'CONTROL_PLANE_TOKEN']);
  const url = (process.env.CONTROL_PLANE_URL || env.CONTROL_PLANE_URL || '')
    .trim()
    .replace(/\/$/, '');
  const token = (
    process.env.CONTROL_PLANE_TOKEN ||
    env.CONTROL_PLANE_TOKEN ||
    ''
  ).trim();
  if (!url || !token) return null;
  return { url, token };
}

/** For tests: drop the cached app-mode installation token. */
export function _resetGithubAppTokenCache(): void {
  cachedGithubAppToken = undefined;
}

/**
 * Resolve the GitHub token to inject into an agent container for THIS spawn.
 *
 * - Not app mode (default / self-hosters): return the static env PAT
 *   (getGithubToken()), unchanged behavior.
 * - App mode WITHOUT a control plane configured: fall back to the static PAT.
 * - App mode WITH a control plane: return a cached installation token if still
 *   comfortably valid; otherwise mint a fresh one from the broker, cache it, and
 *   return it. On ANY broker failure, log a warning and fall back to the static
 *   PAT (possibly undefined — the agent then runs without GitHub).
 *
 * Never throws; never aborts the spawn.
 */
export async function resolveGithubToken(): Promise<string | undefined> {
  if (!GITHUB_APP_MODE) return getGithubToken();

  const cp = controlPlaneConfig();
  if (!cp) {
    // App mode requested but no control plane wired up — degrade to static PAT.
    return getGithubToken();
  }

  const now = Date.now();
  if (
    cachedGithubAppToken &&
    cachedGithubAppToken.expiresAtMs - now > GITHUB_APP_TOKEN_REFRESH_SKEW_MS
  ) {
    return cachedGithubAppToken.token;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_BROKER_TIMEOUT_MS);
  try {
    const res = await fetch(`${cp.url}/api/instance/github/token`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cp.token}`,
        'content-type': 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      // 404 github_not_installed / 502 mint failure / anything else.
      logger.warn(
        { status: res.status },
        'github app-mode: token broker returned non-200 — falling back to static PAT',
      );
      return getGithubToken();
    }
    const body = (await res.json()) as {
      token?: unknown;
      expiresAt?: unknown;
      mode?: unknown;
    };
    if (typeof body?.token !== 'string' || !body.token) {
      logger.warn(
        'github app-mode: token broker returned no token — falling back to static PAT',
      );
      return getGithubToken();
    }
    const parsedExpiry =
      typeof body.expiresAt === 'string' ? Date.parse(body.expiresAt) : NaN;
    cachedGithubAppToken = {
      token: body.token,
      // No / unparseable expiry → treat as expiring at the refresh skew so the
      // next spawn re-mints rather than trusting a token of unknown lifetime.
      expiresAtMs: Number.isFinite(parsedExpiry)
        ? parsedExpiry
        : now + GITHUB_APP_TOKEN_REFRESH_SKEW_MS,
    };
    return body.token;
  } catch (err) {
    logger.warn(
      { err },
      'github app-mode: token broker request failed — falling back to static PAT',
    );
    return getGithubToken();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Linear personal API key for the bundled Linear MCP server, read from .env
 * (with process.env fallback). Returns undefined when unset, which leaves the
 * Linear MCP server unloaded inside the container. Same docker-vs-kubernetes
 * distinction as getGithubToken() above.
 */
function getLinearApiKey(): string | undefined {
  return (
    readEnvFile(['LINEAR_API_KEY']).LINEAR_API_KEY || process.env.LINEAR_API_KEY
  );
}

/**
 * Resolve the env vars referenced by the configured generic MCP servers
 * (bearerEnvVar / headerEnvVars / stdio envVars — see docs/MCP-SERVERS.md) to
 * their real values, reading from .env (with process.env fallback) exactly like
 * getGithubToken()/getLinearApiKey(). Only NAMES that resolve to a non-empty
 * value are returned; unset ones are omitted (the corresponding server then
 * stays unloaded inside the container, same gating as hasLinear).
 *
 * Same docker-vs-kubernetes distinction as the other secret getters: the docker
 * path passes only the NAME (`-e NAME`) so values stay out of argv; the
 * kubernetes path embeds the resolved value in the pod spec (redacted from the
 * debug log by redactSecretsInArgs).
 */
function getMcpServerEnvVars(): Record<string, string> {
  const names = mcpServerEnvVarNames(MCP_SERVERS);
  if (names.length === 0) return {};
  const fromFile = readEnvFile(names);
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = fromFile[name] || process.env[name];
    if (value) out[name] = value;
  }
  return out;
}

/**
 * Redacts known secret values (GitHub PAT, Linear API key) out of a joined
 * argv string before it's written to the debug log. No-op for the docker
 * backend (those values never appear in argv there); needed for the
 * kubernetes backend, whose --overrides JSON embeds them — see
 * getGithubToken()/getLinearApiKey() docs above.
 */
function redactSecretsInArgs(
  joined: string,
  resolvedGithubToken?: string,
): string {
  let result = joined;
  // Prefer the per-spawn resolved token (which may be an app-mode installation
  // token, invisible to getGithubToken()); fall back to the static PAT.
  const githubToken = resolvedGithubToken || getGithubToken();
  if (githubToken) {
    result = result.split(githubToken).join('***REDACTED***');
  }
  const linearApiKey = getLinearApiKey();
  if (linearApiKey) {
    result = result.split(linearApiKey).join('***REDACTED***');
  }
  // Generic remote-MCP bridge: the kubernetes pod spec embeds every configured
  // MCP server's referenced secret value (docs/MCP-SERVERS.md) — scrub them all
  // out of the logged argv, same as the github/linear tokens above.
  for (const value of Object.values(getMcpServerEnvVars())) {
    result = result.split(value).join('***REDACTED***');
  }
  // The kubernetes pod spec embeds the run-tagged auth placeholder, which
  // carries CREDENTIAL_PROXY_AUTH_TOKEN when set — see composeAuthPlaceholder.
  const proxyAuthToken =
    readEnvFile(['CREDENTIAL_PROXY_AUTH_TOKEN']).CREDENTIAL_PROXY_AUTH_TOKEN ||
    process.env.CREDENTIAL_PROXY_AUTH_TOKEN;
  if (proxyAuthToken) {
    result = result.split(proxyAuthToken).join('***REDACTED***');
  }
  return result;
}

// Fixed in-container path for the mounted gws credentials file. The host
// path comes from GOOGLE_WORKSPACE_CREDENTIALS_FILE (.env or process.env).
const CONTAINER_GWS_CREDS_PATH = '/run/secrets/gws-credentials.json';

// Paths that have no business being mounted as a Workspace credentials file —
// matched against the resolved realpath. Catches accidents (e.g. env var set
// to ~/.ssh/id_rsa or /etc/passwd), not adversarial operators (who already
// control .env). A rejected path skips the mount and logs a warning.
const GWS_CREDS_BLOCKED_PATTERNS = [
  '.ssh',
  '.gnupg',
  '.gpg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.netrc',
  'id_rsa',
  'id_ed25519',
  '/etc/passwd',
  '/etc/shadow',
];

/**
 * Resolve and validate the host path to the Google Workspace CLI credentials
 * file. Reads from .env (with process.env fallback); when set, the file must
 * (a) exist, (b) be a regular file, and (c) not resolve to a path matching
 * any blocked pattern. On any validation failure, logs a warning and returns
 * undefined — which leaves Google Workspace tools disabled inside the
 * container rather than mounting an unintended host file.
 */
function resolveGoogleWorkspaceCredsPath(): string | undefined {
  const raw =
    readEnvFile(['GOOGLE_WORKSPACE_CREDENTIALS_FILE'])
      .GOOGLE_WORKSPACE_CREDENTIALS_FILE ||
    process.env.GOOGLE_WORKSPACE_CREDENTIALS_FILE;
  if (!raw) return undefined;

  let realPath: string;
  try {
    realPath = fs.realpathSync(raw);
  } catch {
    logger.warn(
      { path: raw },
      'GOOGLE_WORKSPACE_CREDENTIALS_FILE set but path does not exist — gws MCP disabled',
    );
    return undefined;
  }

  let isFile = false;
  try {
    isFile = fs.statSync(realPath).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    logger.warn(
      { path: raw, realPath },
      'GOOGLE_WORKSPACE_CREDENTIALS_FILE is not a regular file — gws MCP disabled',
    );
    return undefined;
  }

  for (const pattern of GWS_CREDS_BLOCKED_PATTERNS) {
    if (realPath.includes(pattern)) {
      logger.warn(
        { path: raw, realPath, blockedPattern: pattern },
        'GOOGLE_WORKSPACE_CREDENTIALS_FILE resolves to a path matching a blocked pattern — gws MCP disabled',
      );
      return undefined;
    }
  }

  return realPath;
}

/**
 * Placeholder ANTHROPIC_API_KEY value the container sends to the credential
 * proxy in api-key mode: encodes the container name (runTag) for usage
 * attribution, and the CREDENTIAL_PROXY_AUTH_TOKEN shared secret when set.
 * Shared by the docker (-e flag) and kubernetes (pod-spec env) paths — see
 * parsePlaceholderApiKey in credential-proxy.ts for the decode side.
 */
function composeAuthPlaceholder(containerName: string): string {
  const proxyAuthToken =
    readEnvFile(['CREDENTIAL_PROXY_AUTH_TOKEN']).CREDENTIAL_PROXY_AUTH_TOKEN ||
    process.env.CREDENTIAL_PROXY_AUTH_TOKEN;
  return proxyAuthToken
    ? `placeholder.${proxyAuthToken}.${containerName}`
    : `placeholder-${containerName}`;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  modelOverride?: string,
  githubToken?: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Route API traffic through the credential proxy (containers never see real secrets).
  // Skipped in local-LLM mode — no Anthropic traffic, no proxy required.
  if (NANOCLAW_BACKEND !== 'local') {
    args.push(
      '-e',
      `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
    );

    // Mirror the host's auth method with a placeholder value.
    // API key mode: SDK sends x-api-key, proxy replaces with real key. The
    //               placeholder encodes the container name (runTag) so the
    //               proxy can attribute usage to this run — and, when
    //               CREDENTIAL_PROXY_AUTH_TOKEN is set, a shared secret the
    //               proxy checks before forwarding (multi-tenant hardening).
    //               Format: placeholder-<runTag>, or with an auth token:
    //               placeholder.<authToken>.<runTag>. See parsePlaceholderApiKey
    //               in credential-proxy.ts for the matching decode logic and why
    //               '.' is a safe separator (never appears in a container name).
    // OAuth mode:   SDK exchanges placeholder token for temp API key,
    //               proxy injects real OAuth token on that exchange request.
    //               The exchange request carries the placeholder via
    //               `authorization`, not `x-api-key`, so there's no placeholder
    //               value to attach run attribution/auth-token to — OAuth mode
    //               intentionally skips both (see credential-proxy.ts).
    const authMode = detectAuthMode();
    if (authMode === 'api-key') {
      args.push(
        '-e',
        `ANTHROPIC_API_KEY=${composeAuthPlaceholder(containerName)}`,
      );
    } else {
      args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
    }
  }

  // Backend selection (consumed by container/agent-runner)
  args.push('-e', `NANOCLAW_BACKEND=${NANOCLAW_BACKEND}`);
  if (NANOCLAW_BACKEND === 'local') {
    args.push('-e', `LOCAL_LLM_BASE_URL=${LOCAL_LLM_BASE_URL}`);
    if (LOCAL_LLM_MODEL) {
      args.push('-e', `LOCAL_LLM_MODEL=${LOCAL_LLM_MODEL}`);
    }
    // API key: passthrough flag only (no value) so the secret is never in
    // argv or the containerArgs debug log. The actual value is injected
    // through the runtime's process env in runContainerAgent.spawn().
    if (LOCAL_LLM_API_KEY) {
      args.push('-e', 'LOCAL_LLM_API_KEY');
    }
  }

  // Model routing: pass orchestrator and subagent models to container.
  // A per-run modelOverride (from a durable-workflow step) wins over the
  // global NANOCLAW_MODEL; falling back to it preserves current behavior.
  const orchestratorModel = modelOverride || NANOCLAW_MODEL;
  if (orchestratorModel) {
    args.push('-e', `NANOCLAW_MODEL=${orchestratorModel}`);
  }
  if (NANOCLAW_SUBAGENT_MODEL) {
    args.push('-e', `NANOCLAW_SUBAGENT_MODEL=${NANOCLAW_SUBAGENT_MODEL}`);
  }

  // KB dashboard base URL (non-secret, from profile.config.json). The agent
  // reads $KB_DASHBOARD_URL to render internal-doc citations as deep-links into
  // the dashboard (`/doc/:category/:file`). See the `citations` container skill.
  // Safe to pass by value — it's a public URL, not a credential.
  if (KB_DASHBOARD_URL) {
    args.push('-e', `KB_DASHBOARD_URL=${KB_DASHBOARD_URL}`);
  }

  // GitHub MCP server: enable the env passthrough WITHOUT putting the
  // secret in argv. `-e NAME` (no value) makes the runtime read the value
  // from its own process environment, which runContainerAgent populates.
  // This keeps the token out of the containerArgs debug log and host
  // process args. Repo scope is enforced by the token itself (static PAT, or
  // — in GITHUB_APP_MODE — a short-lived App installation token resolved once
  // per spawn by resolveGithubToken() and threaded in here).
  //
  // GH_TOKEN is the env var the gh CLI uses for authentication. We pass
  // both so that task script gates can use `gh api` directly without any
  // extra configuration — GITHUB_PERSONAL_ACCESS_TOKEN alone is not
  // recognised by gh CLI.
  if (githubToken) {
    args.push('-e', 'GITHUB_PERSONAL_ACCESS_TOKEN');
    args.push('-e', 'GH_TOKEN');
  }

  // Linear MCP: only the env var name is passed through (value comes from the
  // runtime's process env, kept out of argv). Its presence flips hasLinear
  // inside agent-runner, which loads the official hosted Linear MCP server.
  if (getLinearApiKey()) {
    args.push('-e', 'LINEAR_API_KEY');
  }

  // Generic remote-MCP bridge (docs/MCP-SERVERS.md): pass through, by NAME
  // only, every env var referenced by a configured MCP server whose value is
  // set. Same secret-safe pattern as Linear/GitHub — the value comes from the
  // spawned runtime's process env (populated in runContainerAgent), never argv.
  for (const name of Object.keys(getMcpServerEnvVars())) {
    args.push('-e', name);
  }

  // Google Workspace MCP: only the in-container path goes in argv (not a
  // secret); actual credentials live in the read-only mounted file. The
  // env var presence is what flips hasGoogleWorkspace inside agent-runner.
  // Validation happens inside resolveGoogleWorkspaceCredsPath() — keep the
  // two call sites in sync by reusing the same resolver.
  if (resolveGoogleWorkspaceCredsPath()) {
    args.push(
      '-e',
      `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=${CONTAINER_GWS_CREDS_PATH}`,
    );
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Optional resource limits (AGENT_CONTAINER_MEMORY / _CPUS / _PIDS_LIMIT).
  // Unset by default — no behavior change for existing installs.
  args.push(...resourceLimitArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    // In DOCKER_SIBLING_MODE the orchestrator's own /app/... source paths are
    // rewritten to real host paths so the host daemon can bind them (a no-op
    // otherwise); image-dir mounts return null and are skipped.
    const src = mountSource(mount.hostPath);
    if (src === null) continue;
    if (mount.readonly) {
      args.push(...readonlyMountArgs(src, mount.containerPath));
    } else {
      args.push('-v', `${src}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

/**
 * Same env vars buildContainerArgs derives (TZ, auth placeholder, model
 * routing, GitHub/Linear/GWS passthrough), reshaped as {name, value} pairs
 * for the Kubernetes pod spec instead of docker `-e` flags. Kept as its own
 * function (not folded into buildContainerArgs) so the docker arg-building
 * code path is untouched — see docs/KUBERNETES.md for why this is a
 * parallel builder rather than a shared one.
 */
function buildK8sEnvVars(
  containerName: string,
  modelOverride?: string,
  githubToken?: string,
): K8sEnvVar[] {
  const env: K8sEnvVar[] = [{ name: 'TZ', value: TIMEZONE }];

  env.push({
    name: 'ANTHROPIC_BASE_URL',
    value: `http://${K8S_POD_IP}:${CREDENTIAL_PROXY_PORT}`,
  });

  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    // Same run-tagged placeholder as the docker path, so usage attribution
    // and CREDENTIAL_PROXY_AUTH_TOKEN enforcement work identically under k8s.
    env.push({
      name: 'ANTHROPIC_API_KEY',
      value: composeAuthPlaceholder(containerName),
    });
  } else {
    env.push({ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'placeholder' });
  }

  const orchestratorModel = modelOverride || NANOCLAW_MODEL;
  if (orchestratorModel) {
    env.push({ name: 'NANOCLAW_MODEL', value: orchestratorModel });
  }
  if (NANOCLAW_SUBAGENT_MODEL) {
    env.push({
      name: 'NANOCLAW_SUBAGENT_MODEL',
      value: NANOCLAW_SUBAGENT_MODEL,
    });
  }

  // Non-secret: lets the citations skill render internal-doc deep-links into
  // the KB dashboard under the kubernetes runtime too (mirrors the docker
  // `-e KB_DASHBOARD_URL` passthrough in buildContainerArgs).
  if (KB_DASHBOARD_URL) {
    env.push({ name: 'KB_DASHBOARD_URL', value: KB_DASHBOARD_URL });
  }

  // Secrets: resolved to their real value here (unlike the docker path's bare
  // `-e NAME` passthrough) because kubectl run has no equivalent of "read
  // this var from my own process env" — the pod spec is a self-contained
  // JSON document handed to the API server, not a child process inheriting
  // the parent's environment. The value still never touches this file's
  // *logged* debug output (callers log containerArgs/mounts, not the
  // resolved env list) but it IS present in the --overrides JSON passed as a
  // kubectl argv, which is a real difference from the docker passthrough —
  // documented in docs/KUBERNETES.md. The value is the token resolved ONCE per
  // spawn (static PAT, or a GITHUB_APP_MODE installation token) and threaded in.
  if (githubToken) {
    env.push({ name: 'GITHUB_PERSONAL_ACCESS_TOKEN', value: githubToken });
    env.push({ name: 'GH_TOKEN', value: githubToken });
  }
  const linearApiKey = getLinearApiKey();
  if (linearApiKey) {
    env.push({ name: 'LINEAR_API_KEY', value: linearApiKey });
  }
  // Generic remote-MCP bridge (docs/MCP-SERVERS.md): resolve each configured
  // server's referenced secret into the pod spec's env list (kubectl run has no
  // name-only passthrough). redactSecretsInArgs strips these values back out
  // before the argv is logged.
  for (const [name, value] of Object.entries(getMcpServerEnvVars())) {
    env.push({ name, value });
  }
  if (resolveGoogleWorkspaceCredsPath()) {
    env.push({
      name: 'GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE',
      value: CONTAINER_GWS_CREDS_PATH,
    });
  }

  return env;
}

/**
 * PVC-mode subPath roots: every host path buildVolumeMounts() can produce
 * falls under one of these (PROFILE_DIR for the profile/store/groups tree,
 * DATA_DIR for sessions/IPC/agent-runner-src). The process.cwd() → `project`
 * root is retained as a defensive mapping but is now dormant on the kubernetes
 * path: the read-only project-root mount it used to translate is skipped for
 * main/cooperative groups under kubernetes (see buildVolumeMounts — it nested
 * the writable store under a read-only mount and crashed the pod). See
 * docs/KUBERNETES.md "Cooperative / main groups under kubernetes" and "Path
 * translation is the hard part" — a host path outside every known root (e.g.
 * an additionalMounts entry pointing elsewhere) fails loudly in
 * translateMountForK8s rather than mounting silently wrong.
 */
function pvcRootMappings(): PvcRootMapping[] {
  return [
    { hostRoot: PROFILE_DIR, subPathPrefix: 'profile' },
    { hostRoot: DATA_DIR, subPathPrefix: 'data' },
    { hostRoot: process.cwd(), subPathPrefix: 'project' },
  ];
}

/**
 * The spawn seam: returns the binary + argv to invoke for this run, branching
 * on CONTAINER_RUNTIME. Docker path is a thin wrapper around the unchanged
 * buildContainerArgs; Kubernetes path builds a pod spec (buildK8sPodOverrides)
 * and a `kubectl run` invocation (buildKubectlRunArgs). This is the ONE place
 * container-runner.ts branches on runtime kind — see docs/KUBERNETES.md.
 */
function buildSpawnCommand(
  mounts: VolumeMount[],
  containerName: string,
  modelOverride?: string,
  githubToken?: string,
): { bin: string; args: string[] } {
  if (CONTAINER_RUNTIME === 'kubernetes') {
    if (AGENT_CONTAINER_PIDS_LIMIT) {
      warnPidsLimitUnsupported(AGENT_CONTAINER_PIDS_LIMIT);
    }
    const hostUid = process.getuid?.();
    const hostGid = process.getgid?.();
    const runAsRoot = hostUid == null || hostUid === 0 || hostUid === 1000;
    // The gid the pod's process actually runs as: when we override, it's the
    // host gid; otherwise the agent image's baked-in `node` user (uid/gid
    // 1000) applies. Used for fsGroup below so mounted PVC volumes are
    // writable by that gid.
    const effectiveGid = runAsRoot ? 1000 : hostGid;
    // Pod-level fsGroup only matters for a PVC-backed volume whose backing
    // block storage mounts root-owned (the hosted/multi-node case): without
    // it, a non-root agent gets EACCES writing to the tenant PVC and the run
    // fails silently (bot receives the message, never replies). hostPath
    // volumes resolve on the shared node with normal ownership, so they need
    // no remap. Skip entirely when the pod runs as true root (uid 0).
    const fsGroup =
      K8S_VOLUME_MODE === 'pvc' && hostUid !== 0 ? effectiveGid : undefined;
    const overrides = buildK8sPodOverrides({
      podName: containerName,
      image: CONTAINER_IMAGE,
      mounts: mounts.map((m) => ({
        hostPath: m.hostPath,
        containerPath: m.containerPath,
        readonly: m.readonly,
      })),
      env: buildK8sEnvVars(containerName, modelOverride, githubToken),
      volumeMode: K8S_VOLUME_MODE,
      nodeName: K8S_VOLUME_MODE === 'hostPath' ? K8S_NODE_NAME : undefined,
      pvcName: K8S_VOLUME_MODE === 'pvc' ? K8S_DATA_PVC_NAME : undefined,
      pvcRoots: K8S_VOLUME_MODE === 'pvc' ? pvcRootMappings() : undefined,
      resources: {
        memory: AGENT_CONTAINER_MEMORY || undefined,
        cpus: AGENT_CONTAINER_CPUS || undefined,
      },
      runAsUser: runAsRoot ? undefined : hostUid,
      runAsGroup: runAsRoot ? undefined : hostGid,
      fsGroup,
    });
    const args = buildKubectlRunArgs({
      podName: containerName,
      image: CONTAINER_IMAGE,
      namespace: K8S_NAMESPACE,
      overrides,
    });
    return { bin: 'kubectl', args };
  }

  return {
    bin: CONTAINER_RUNTIME_BIN,
    args: buildContainerArgs(mounts, containerName, modelOverride, githubToken),
  };
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Generic remote-MCP bridge (docs/MCP-SERVERS.md): thread the configured MCP
  // servers' NON-SECRET shape into the container via the stdin-JSON payload so
  // agent-runner can build the SDK `mcpServers` map + allowlist. The referenced
  // secret VALUES travel separately through the container env (see
  // buildContainerArgs / buildK8sEnvVars / extraEnv below). Injected here from
  // config so no call site can forget it; an explicit input.mcpServers wins.
  input = { ...input, mcpServers: input.mcpServers ?? MCP_SERVERS };

  // Resolve the GitHub token for this spawn ONCE, before building env/argv.
  // In GITHUB_APP_MODE this may mint (or reuse a cached) short-lived App
  // installation token from the control plane; otherwise it's the static PAT.
  // Threaded into both spawn paths (docker passthrough value + k8s pod-spec
  // value) so the two never diverge. Never throws — undefined just means the
  // agent runs without GitHub.
  const githubToken = await resolveGithubToken();

  const mounts = buildVolumeMounts(group, input.isMain);
  const containerName = buildAgentContainerName(group.folder, Date.now());
  const { bin: runtimeBin, args: containerArgs } = buildSpawnCommand(
    mounts,
    containerName,
    input.modelOverride,
    githubToken,
  );

  // The docker argv never contains secret values (bare `-e NAME` passthrough
  // — see buildContainerArgs). The kubernetes argv DOES embed resolved
  // secret values inside the --overrides JSON (kubectl run has no
  // name-only env passthrough — see buildK8sEnvVars), so redact known
  // secret values before this hits the debug log. Pass the per-spawn github
  // token explicitly so an app-mode token (which getGithubToken() wouldn't
  // return) is redacted too.
  const loggedContainerArgs = redactSecretsInArgs(
    containerArgs.join(' '),
    githubToken,
  );

  logger.debug(
    {
      group: group.name,
      containerName,
      runtimeBin,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: loggedContainerArgs,
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    // Inject the GitHub PAT into the runtime's process environment (never
    // argv), matching the `-e GITHUB_PERSONAL_ACCESS_TOKEN` and `-e GH_TOKEN`
    // passthrough flags added in buildContainerArgs. Docker-only: the
    // kubernetes backend resolves these directly into the pod spec's env
    // list instead (see buildK8sEnvVars) since `kubectl run` has no
    // equivalent of "read this var from my own process env."
    //
    // GITHUB_PERSONAL_ACCESS_TOKEN — used by the GitHub MCP server.
    // GH_TOKEN                     — used by the gh CLI (different name,
    //                                same value). Without this, `gh api`
    //                                calls in task script gates fail silently.
    //
    // Uses the per-spawn resolved token (githubToken) — the static PAT, or a
    // GITHUB_APP_MODE installation token — NOT a fresh getGithubToken() call,
    // so the value matches the passthrough flags built above.
    const extraEnv: Record<string, string> = {};
    if (CONTAINER_RUNTIME !== 'kubernetes') {
      const linearApiKey = getLinearApiKey();
      if (githubToken) {
        extraEnv.GITHUB_PERSONAL_ACCESS_TOKEN = githubToken;
        extraEnv.GH_TOKEN = githubToken;
      }
      if (linearApiKey) {
        extraEnv.LINEAR_API_KEY = linearApiKey;
      }
      // Local-LLM backend: inject the OpenAI-compatible endpoint's API key
      // (secret) into the runtime's process env, matching the bare
      // `-e LOCAL_LLM_API_KEY` passthrough flag in buildContainerArgs. Only
      // in local mode; kept out of argv and the containerArgs debug log.
      const llmApiKey =
        NANOCLAW_BACKEND === 'local' ? LOCAL_LLM_API_KEY : undefined;
      if (llmApiKey) {
        extraEnv.LOCAL_LLM_API_KEY = llmApiKey;
      }
      // Generic remote-MCP bridge (docs/MCP-SERVERS.md): inject each configured
      // server's referenced secret VALUE into the runtime's process env,
      // matching the bare `-e NAME` passthrough flags in buildContainerArgs.
      for (const [name, value] of Object.entries(getMcpServerEnvVars())) {
        extraEnv[name] = value;
      }
    }
    const container = spawn(runtimeBin, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(Object.keys(extraEnv).length
        ? { env: { ...process.env, ...extraEnv } }
        : {}),
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      try {
        stopContainer(containerName);
      } catch (err) {
        logger.warn(
          { group: group.name, containerName, err },
          'Graceful stop failed, force killing',
        );
        container.kill('SIGKILL');
      }
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        // On error, log input metadata only — not the full prompt.
        // Full input is only included at verbose level to avoid
        // persisting user conversation content on every non-zero exit.
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        logLines.push(
          `=== Container Args ===`,
          loggedContainerArgs,
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        // A caller that stops its own container (Smithers bridge) makes a
        // non-zero exit after streamed output expected teardown, not a fault.
        if (input.expectExternalStop && hadStreamingOutput) {
          logger.info(
            { group: group.name, code, duration },
            'Container stopped externally after output (expected)',
          );
        } else {
          logger.error(
            {
              group: group.name,
              code,
              duration,
              stderr,
              stdout,
              logFile,
            },
            'Container exited with error',
          );
        }

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    script?: string | null;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export function writeOutboundSnapshot(
  groupFolder: string,
  messages: Array<{ id: string; content: string; timestamp: string }>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const file = path.join(groupIpcDir, 'recent_outbound.json');
  fs.writeFileSync(file, JSON.stringify(messages, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
