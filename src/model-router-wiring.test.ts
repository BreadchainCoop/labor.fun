/**
 * Backwards-compat proof for wiring the model-router into the dispatch sites
 * (src/index.ts message dispatch + src/task-scheduler.ts scheduled tasks).
 *
 * The wired call would be `modelOverride: modelForKind(kind)` on the
 * ContainerInput. Because `message` and `scheduled_task` map to the `default`
 * tier, which is anchored to the global NANOCLAW_MODEL, the wiring must be a
 * NO-OP today:
 *
 *  - the docker argv (including the emitted NANOCLAW_MODEL env var) must be
 *    BYTE-IDENTICAL with and without the wiring — for a set AND an unset
 *    global model;
 *  - with the global unset, the container stdin payload is also
 *    byte-identical (an undefined modelOverride is dropped by
 *    JSON.stringify);
 *  - with the global set, stdin additionally carries
 *    `modelOverride: <the same global model>` — inert, because the
 *    in-container agent-runner never reads modelOverride (it receives the
 *    model exclusively via the NANOCLAW_MODEL env var, which is identical).
 *
 * Mock scaffolding mirrors container-runner.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

const mockConfig = vi.hoisted(() => ({
  NANOCLAW_MODEL: undefined as string | undefined,
}));

vi.mock('./config.js', async () => {
  const { mcpServerEnvVarNames } =
    await vi.importActual<typeof import('./mcp-servers.js')>(
      './mcp-servers.js',
    );
  return {
    AGENT_CONTAINER_CPUS: '',
    AGENT_CONTAINER_MEMORY: '',
    AGENT_CONTAINER_PIDS_LIMIT: '',
    CONTAINER_IMAGE: 'nanoclaw-agent:latest',
    CONTAINER_MAX_OUTPUT_SIZE: 10485760,
    CONTAINER_RUNTIME: 'docker',
    DOCKER_SIBLING_MODE: false,
    CONTAINER_TIMEOUT: 1800000, // 30min
    CREDENTIAL_PROXY_PORT: 3001,
    DATA_DIR: '/tmp/nanoclaw-test-data',
    ENABLED_SKILLS: [],
    GITHUB_APP_MODE: false,
    GROUPS_DIR: '/tmp/nanoclaw-test-groups',
    IDLE_TIMEOUT: 1800000, // 30min
    K8S_DATA_PVC_NAME: '',
    K8S_NAMESPACE: '',
    K8S_NODE_NAME: '',
    K8S_POD_IP: '',
    K8S_VOLUME_MODE: 'hostPath',
    KB_DASHBOARD_URL: '',
    get NANOCLAW_MODEL() {
      return mockConfig.NANOCLAW_MODEL;
    },
    NANOCLAW_SUBAGENT_MODEL: undefined,
    NANOCLAW_BACKEND: 'claude',
    LOCAL_LLM_BASE_URL: 'http://host.docker.internal:1234/v1',
    LOCAL_LLM_MODEL: undefined,
    LOCAL_LLM_API_KEY: undefined,
    MCP_SERVERS: [],
    mcpServerEnvVarNames,
    PROFILE_DIR: '/tmp/nanoclaw-test-profile',
    SHARED_KB_GROUP: 'slack_main',
    STORE_DIR: '/tmp/nanoclaw-test-profile/store',
    TIMEZONE: 'America/Los_Angeles',
    // Read by model-router (unset = its built-in tier defaults).
    LABOR_TIER_CHEAP_MODEL: undefined,
    LABOR_TIER_STRONG_MODEL: undefined,
  };
});

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({
        isDirectory: () => false,
        isFile: () => false,
      })),
      realpathSync: vi.fn((p: string) => p),
      copyFileSync: vi.fn(),
      cpSync: vi.fn(),
    },
  };
});

vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  resourceLimitArgs: vi.fn(() => []),
  stopContainer: vi.fn(),
}));

vi.mock('./container-runtime-k8s.js', () => ({
  buildK8sPodOverrides: vi.fn(() => ({})),
  buildKubectlRunArgs: vi.fn(() => ['run', 'test-pod']),
  warnPidsLimitUnsupported: vi.fn(),
}));

vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
}));

// Mock env reader so .env on the host machine doesn't make the argv
// nondeterministic across the with/without-wiring captures.
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
  };
});

import { spawn } from 'child_process';
import {
  runContainerAgent,
  ContainerInput,
  ContainerOutput,
} from './container-runner.js';
import { modelForKind, type TaskKind } from './model-router.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Breadbrich Engels',
  added_at: new Date().toISOString(),
};

const baseInput: ContainerInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

// runContainerAgent injects the configured MCP servers (mocked: []) into the
// stdin payload for BOTH the wired and unwired capture — part of the baseline.
const baseStdinPayload = { ...baseInput, mcpServers: [] };

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

function modelArgs(args: string[]): string[] {
  return args.filter((a) => a.startsWith('NANOCLAW_MODEL='));
}

/**
 * Run one container invocation and capture the full docker argv + the stdin
 * payload. The system clock is pinned to the SAME instant for every call so
 * the timestamped container name (and therefore the whole argv) is
 * deterministic and comparable byte-for-byte across runs.
 */
async function capture(
  input: ContainerInput,
): Promise<{ args: string[]; stdin: string }> {
  vi.setSystemTime(1700000000000);
  fakeProc = createFakeProcess();
  const p = runContainerAgent(testGroup, input, () => {}, vi.fn());
  emitOutputMarker(fakeProc, {
    status: 'success',
    result: 'ok',
    newSessionId: 's',
  });
  await vi.advanceTimersByTimeAsync(10);
  fakeProc.emit('close', 0);
  await vi.advanceTimersByTimeAsync(10);
  await p;
  const calls = vi.mocked(spawn).mock.calls;
  const args = calls[calls.length - 1][1] as string[];
  const buf = fakeProc.stdin.read();
  return { args, stdin: buf ? buf.toString() : '' };
}

const kinds: TaskKind[] = ['message', 'scheduled_task'];

const ENV_VARS_TO_ISOLATE = [
  'GITHUB_PERSONAL_ACCESS_TOKEN',
  'LINEAR_API_KEY',
  'GOOGLE_WORKSPACE_CREDENTIALS_FILE',
  'GOOGLE_WORKSPACE_CALENDAR_ID',
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(spawn).mockClear();
  mockConfig.NANOCLAW_MODEL = undefined;
  for (const name of ENV_VARS_TO_ISOLATE) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  vi.useRealTimers();
  for (const name of ENV_VARS_TO_ISOLATE) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

describe('router wiring is a no-op — global NANOCLAW_MODEL SET', () => {
  it.each(kinds)(
    '%s: full docker argv is byte-identical with and without the wiring',
    async (kind) => {
      mockConfig.NANOCLAW_MODEL = 'claude-global-model';

      const unwired = await capture(baseInput);
      const wired = await capture({
        ...baseInput,
        modelOverride: modelForKind(kind),
      });

      expect(wired.args).toEqual(unwired.args);
      expect(modelArgs(wired.args)).toEqual([
        'NANOCLAW_MODEL=claude-global-model',
      ]);
    },
  );

  it.each(kinds)(
    '%s: stdin carries modelOverride equal to the global (inert — agent-runner reads only the env var)',
    async (kind) => {
      mockConfig.NANOCLAW_MODEL = 'claude-global-model';

      const wired = await capture({
        ...baseInput,
        modelOverride: modelForKind(kind),
      });

      expect(JSON.parse(wired.stdin)).toEqual({
        ...baseStdinPayload,
        modelOverride: 'claude-global-model',
      });
    },
  );
});

describe('router wiring is a no-op — global NANOCLAW_MODEL UNSET', () => {
  it.each(kinds)(
    '%s: full docker argv is byte-identical and emits no NANOCLAW_MODEL env',
    async (kind) => {
      const unwired = await capture(baseInput);
      const wired = await capture({
        ...baseInput,
        modelOverride: modelForKind(kind),
      });

      expect(wired.args).toEqual(unwired.args);
      expect(modelArgs(wired.args)).toEqual([]);
    },
  );

  it.each(kinds)(
    '%s: stdin payload is byte-identical (undefined override is dropped)',
    async (kind) => {
      const unwired = await capture(baseInput);
      const wired = await capture({
        ...baseInput,
        modelOverride: modelForKind(kind),
      });

      expect(wired.stdin).toBe(unwired.stdin);
      expect(wired.stdin).toBe(JSON.stringify(baseStdinPayload));
      expect(wired.stdin).not.toContain('modelOverride');
    },
  );
});
