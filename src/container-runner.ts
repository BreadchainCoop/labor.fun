/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
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
  stopContainer,
} from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import { readEnvFile } from './env.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

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
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
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

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by the credential proxy, never exposed to containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
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
    const storeMountpoint = path.join(projectRoot, 'store');
    if (!fs.existsSync(storeMountpoint)) {
      fs.mkdirSync(storeMountpoint, { recursive: true });
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
 * The value is intentionally NEVER placed in the container argv — it is
 * passed through the spawned runtime's process environment instead, so it
 * cannot leak via the debug log of containerArgs or host process args.
 */
function getGithubToken(): string | undefined {
  return (
    readEnvFile(['GITHUB_PERSONAL_ACCESS_TOKEN'])
      .GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN
  );
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

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Route API traffic through the credential proxy (containers never see real secrets)
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );

  // Mirror the host's auth method with a placeholder value.
  // API key mode: SDK sends x-api-key, proxy replaces with real key.
  // OAuth mode:   SDK exchanges placeholder token for temp API key,
  //               proxy injects real OAuth token on that exchange request.
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }

  // Model routing: pass orchestrator and subagent models to container
  if (NANOCLAW_MODEL) {
    args.push('-e', `NANOCLAW_MODEL=${NANOCLAW_MODEL}`);
  }
  if (NANOCLAW_SUBAGENT_MODEL) {
    args.push('-e', `NANOCLAW_SUBAGENT_MODEL=${NANOCLAW_SUBAGENT_MODEL}`);
  }

  // GitHub MCP server: enable the env passthrough WITHOUT putting the
  // secret in argv. `-e NAME` (no value) makes the runtime read the value
  // from its own process environment, which runContainerAgent populates.
  // This keeps the PAT out of the containerArgs debug log and host
  // process args. Repo scope is enforced by the PAT itself (fine-grained,
  // all BreadchainCoop repos, read+write).
  //
  // GH_TOKEN is the env var the gh CLI uses for authentication. We pass
  // both so that task script gates can use `gh api` directly without any
  // extra configuration — GITHUB_PERSONAL_ACCESS_TOKEN alone is not
  // recognised by gh CLI.
  if (getGithubToken()) {
    args.push('-e', 'GITHUB_PERSONAL_ACCESS_TOKEN');
    args.push('-e', 'GH_TOKEN');
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
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
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

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
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
    // passthrough flags added in buildContainerArgs.
    //
    // GITHUB_PERSONAL_ACCESS_TOKEN — used by the GitHub MCP server.
    // GH_TOKEN                     — used by the gh CLI (different name,
    //                                same value). Without this, `gh api`
    //                                calls in task script gates fail silently.
    const githubToken = getGithubToken();
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(githubToken
        ? {
            env: {
              ...process.env,
              GITHUB_PERSONAL_ACCESS_TOKEN: githubToken,
              GH_TOKEN: githubToken,
            },
          }
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
          containerArgs.join(' '),
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
