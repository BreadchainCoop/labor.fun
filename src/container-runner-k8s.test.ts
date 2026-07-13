import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Same config mock as container-runner.test.ts, EXCEPT CONTAINER_RUNTIME is
// 'kubernetes' — this file exercises the k8s dispatch branch of
// buildSpawnCommand (container-runner.ts) end to end via runContainerAgent,
// without a live cluster (spawn itself is mocked).
vi.mock('./config.js', async () => {
  // Real (deps-free) env-var-name resolver so container-runner's MCP env
  // plumbing runs its actual logic; MCP_SERVERS defaults to [] and is
  // overridden per-test via setMcpServers() for the generic-bridge cases.
  const { mcpServerEnvVarNames } =
    await vi.importActual<typeof import('./mcp-servers.js')>(
      './mcp-servers.js',
    );
  return {
    AGENT_CONTAINER_CPUS: '2',
    AGENT_CONTAINER_MEMORY: '2g',
    AGENT_CONTAINER_PIDS_LIMIT: '',
    CONTAINER_IMAGE: 'nanoclaw-agent:latest',
    CONTAINER_MAX_OUTPUT_SIZE: 10485760,
    CONTAINER_RUNTIME: 'kubernetes',
    CONTAINER_TIMEOUT: 1800000,
    CREDENTIAL_PROXY_PORT: 3001,
    DATA_DIR: '/tmp/nanoclaw-test-data',
    GITHUB_APP_MODE: false,
    GROUPS_DIR: '/tmp/nanoclaw-test-groups',
    IDLE_TIMEOUT: 1800000,
    K8S_DATA_PVC_NAME: 'nanoclaw-data',
    K8S_NAMESPACE: 'tenant-acme',
    K8S_NODE_NAME: 'node-1',
    K8S_POD_IP: '10.0.0.5',
    K8S_VOLUME_MODE: 'hostPath',
    KB_DASHBOARD_URL: '',
    NANOCLAW_MODEL: undefined,
    NANOCLAW_SUBAGENT_MODEL: undefined,
    PROFILE_DIR: '/tmp/nanoclaw-test-profile',
    SHARED_KB_GROUP: 'slack_main',
    STORE_DIR: '/tmp/nanoclaw-test-profile/store',
    TIMEZONE: 'America/Los_Angeles',
    get MCP_SERVERS() {
      return mockMcpServers;
    },
    mcpServerEnvVarNames,
  };
});

// Mutable holder so individual tests can inject configured MCP servers into the
// mocked config without re-mocking the module. Reset in beforeEach.
let mockMcpServers: unknown[] = [];
function setMcpServers(servers: unknown[]): void {
  mockMcpServers = servers;
}

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
  stopContainer: vi.fn(),
}));

vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
}));

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
import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Breadbrich Engels',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

async function drive(p: Promise<unknown>) {
  emitOutputMarker(fakeProc, {
    status: 'success',
    result: 'ok',
    newSessionId: 's',
  });
  await vi.advanceTimersByTimeAsync(10);
  fakeProc.emit('close', 0);
  await vi.advanceTimersByTimeAsync(10);
  await p;
}

function lastSpawnCall() {
  const calls = vi.mocked(spawn).mock.calls;
  return calls[calls.length - 1] as unknown as [string, string[], unknown];
}

describe('container-runner Kubernetes dispatch (CONTAINER_RUNTIME=kubernetes)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
    setMcpServers([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.ZAPIER_MCP_TOKEN;
  });

  it('spawns kubectl instead of docker', async () => {
    await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));
    const [bin] = lastSpawnCall();
    expect(bin).toBe('kubectl');
  });

  it('builds a "run --rm -i --restart=Never" invocation with the pod name, image, and namespace', async () => {
    await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));
    const [, args] = lastSpawnCall();
    expect(args[0]).toBe('run');
    expect(args).toContain('--image');
    expect(args).toContain('nanoclaw-agent:latest');
    expect(args).toContain('--rm');
    expect(args).toContain('-i');
    expect(args).toContain('--restart=Never');
    expect(args).toContain('--namespace');
    expect(args).toContain('tenant-acme');
  });

  it('embeds a pod spec with nodeName (hostPath mode) in --overrides', async () => {
    await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));
    const [, args] = lastSpawnCall();
    const overridesIdx = args.indexOf('--overrides');
    expect(overridesIdx).toBeGreaterThan(-1);
    const overrides = JSON.parse(args[overridesIdx + 1]);
    expect(overrides.spec.nodeName).toBe('node-1');
    expect(overrides.spec.restartPolicy).toBe('Never');
  });

  it('maps AGENT_CONTAINER_MEMORY/CPUS onto pod resources.limits', async () => {
    await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));
    const [, args] = lastSpawnCall();
    const overrides = JSON.parse(args[args.indexOf('--overrides') + 1]);
    const container = overrides.spec.containers[0];
    expect(container.resources.limits).toEqual({ memory: '2Gi', cpu: '2' });
  });

  it('injects ANTHROPIC_BASE_URL pointing at K8S_POD_IP, not host.docker.internal', async () => {
    await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));
    const [, args] = lastSpawnCall();
    const overrides = JSON.parse(args[args.indexOf('--overrides') + 1]);
    const env = overrides.spec.containers[0].env as Array<{
      name: string;
      value: string;
    }>;
    const baseUrl = env.find((e) => e.name === 'ANTHROPIC_BASE_URL');
    expect(baseUrl?.value).toBe('http://10.0.0.5:3001');
    expect(JSON.stringify(env)).not.toContain('host.docker.internal');
  });

  it('does not put GitHub/Linear secrets in the extraEnv passed to spawn (they are resolved into --overrides instead)', async () => {
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN = 'gh-secret-value';
    try {
      await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));
      const [, , opts] = lastSpawnCall() as unknown as [
        string,
        string[],
        { env?: NodeJS.ProcessEnv },
      ];
      // container-runner only special-cases extraEnv for the docker path;
      // under kubernetes it should stay empty (undefined opts.env override).
      expect(opts.env).toBeUndefined();
    } finally {
      delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    }
  });

  describe('generic remote-MCP bridge', () => {
    it('resolves a configured MCP server env var into the pod spec env, and redacts it from the logged argv', async () => {
      setMcpServers([
        {
          name: 'zapier',
          type: 'http',
          url: 'https://mcp.zapier.com/api/mcp/abc',
          bearerEnvVar: 'ZAPIER_MCP_TOKEN',
        },
      ]);
      process.env.ZAPIER_MCP_TOKEN = 'zapier-secret-value';
      await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));
      const [, args] = lastSpawnCall();
      const overrides = JSON.parse(args[args.indexOf('--overrides') + 1]);
      const env = overrides.spec.containers[0].env as Array<{
        name: string;
        value: string;
      }>;
      const tokenEnv = env.find((e) => e.name === 'ZAPIER_MCP_TOKEN');
      expect(tokenEnv?.value).toBe('zapier-secret-value');

      // The logged (debug) argv is a separate, redacted rendering built by
      // redactSecretsInArgs — assert the secret value never lands there.
      const { logger } = await import('./logger.js');
      const debugCalls = vi.mocked(logger.debug).mock.calls;
      const loggedText = JSON.stringify(debugCalls);
      expect(loggedText).not.toContain('zapier-secret-value');
    });

    it('omits the server from the pod env and passes no --overrides env entry when its env var is unset', async () => {
      setMcpServers([
        {
          name: 'zapier',
          type: 'http',
          url: 'https://mcp.zapier.com/api/mcp/abc',
          bearerEnvVar: 'ZAPIER_MCP_TOKEN',
        },
      ]);
      await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));
      const [, args] = lastSpawnCall();
      const overrides = JSON.parse(args[args.indexOf('--overrides') + 1]);
      const env = overrides.spec.containers[0].env as Array<{
        name: string;
        value: string;
      }>;
      expect(env.find((e) => e.name === 'ZAPIER_MCP_TOKEN')).toBeUndefined();
    });

    it('injects mcpServers into the stdin-JSON payload written to the container process', async () => {
      const configured = [
        {
          name: 'zapier',
          type: 'http' as const,
          url: 'https://mcp.zapier.com/api/mcp/abc',
          bearerEnvVar: 'ZAPIER_MCP_TOKEN',
        },
      ];
      setMcpServers(configured);
      const writeSpy = vi.spyOn(fakeProc.stdin, 'write');
      await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));
      const written = writeSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(written);
      expect(parsed.mcpServers).toEqual(configured);
    });
  });
});
