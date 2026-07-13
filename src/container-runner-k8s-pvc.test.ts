import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Same shape as container-runner-k8s.test.ts, but K8S_VOLUME_MODE is 'pvc'.
// This exercises the multi-node / hosted-SaaS path of buildSpawnCommand
// (container-runner.ts) end to end via runContainerAgent, where the agent pod
// mounts a shared PersistentVolumeClaim. That PVC's backing block storage
// mounts root-owned, so a non-root agent (the image's uid/gid 1000 `node`
// user) needs a pod-level securityContext.fsGroup to write to it — otherwise
// EACCES and the run fails silently. These tests assert that fsGroup is set.
//
// All mount roots are nested under one PROFILE_DIR so the PVC subPath
// translator (pvcRootMappings) can rewrite every produced host path to a
// `profile/…` subPath instead of throwing "does not fall under any known PVC
// root".
// NOTE: string literals are inlined below (not a shared const) because the
// vi.mock factory is hoisted above any top-level variable initialization.
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
    CONTAINER_RUNTIME: 'kubernetes',
    CONTAINER_TIMEOUT: 1800000,
    CREDENTIAL_PROXY_PORT: 3001,
    DATA_DIR: '/tmp/nanoclaw-test-profile/data',
    GITHUB_APP_MODE: false,
    GROUPS_DIR: '/tmp/nanoclaw-test-profile/groups',
    IDLE_TIMEOUT: 1800000,
    K8S_DATA_PVC_NAME: 'nanoclaw-data',
    K8S_NAMESPACE: 'tenant-acme',
    K8S_NODE_NAME: 'node-1',
    K8S_POD_IP: '10.0.0.5',
    K8S_VOLUME_MODE: 'pvc',
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

let mockMcpServers: unknown[] = [];

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

function lastOverrides(): any {
  const [, args] = lastSpawnCall();
  const idx = args.indexOf('--overrides');
  expect(idx).toBeGreaterThan(-1);
  return JSON.parse(args[idx + 1]);
}

describe('container-runner Kubernetes PVC dispatch (K8S_VOLUME_MODE=pvc)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
    mockMcpServers = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a PVC-backed pod spec (no nodeName, claimName volumes)', async () => {
    await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));
    const overrides = lastOverrides();
    expect(overrides.spec.nodeName).toBeUndefined();
    expect(overrides.spec.volumes[0]).toMatchObject({
      persistentVolumeClaim: { claimName: 'nanoclaw-data' },
    });
  });

  it('sets pod-level securityContext.fsGroup so the non-root agent can write the root-owned PVC', async () => {
    await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));
    const overrides = lastOverrides();
    // In the test process (typically uid !== 0), the pod runs as the image's
    // node user (gid 1000) — the "runAsRoot" (don't-override) branch — so
    // fsGroup defaults to 1000. If the test happens to run as an unusual host
    // uid/gid, buildSpawnCommand still emits a numeric fsGroup; assert it is a
    // number and matches the group the container runs as (or 1000 default).
    expect(overrides.spec.securityContext).toBeDefined();
    expect(typeof overrides.spec.securityContext.fsGroup).toBe('number');

    const hostUid = process.getuid?.();
    const hostGid = process.getgid?.();
    const runAsRoot = hostUid == null || hostUid === 0 || hostUid === 1000;
    const expectedGid = runAsRoot ? 1000 : hostGid;
    if (hostUid !== 0) {
      expect(overrides.spec.securityContext.fsGroup).toBe(expectedGid);
    }

    // fsGroup is pod-scoped (applies to volumes); the container-level
    // securityContext only carries runAsUser/runAsGroup when overriding.
    const containerSc = overrides.spec.containers[0].securityContext;
    if (containerSc) {
      expect(containerSc.fsGroup).toBeUndefined();
    }
  });

  it('fsGroup matches the container runAsGroup when the host uid/gid is overridden', async () => {
    // Simulate the orchestrator running as a non-node, non-root uid (e.g. a
    // dev host or a custom SecurityContext): buildSpawnCommand then sets
    // container runAsUser/runAsGroup AND a matching pod fsGroup.
    const uidSpy = vi.spyOn(process, 'getuid').mockReturnValue(1234);
    const gidSpy = vi.spyOn(process, 'getgid').mockReturnValue(1234);
    try {
      await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));
      const overrides = lastOverrides();
      expect(overrides.spec.securityContext).toEqual({ fsGroup: 1234 });
      expect(overrides.spec.containers[0].securityContext).toMatchObject({
        runAsUser: 1234,
        runAsGroup: 1234,
      });
    } finally {
      uidSpy.mockRestore();
      gidSpy.mockRestore();
    }
  });

  it('omits fsGroup when the orchestrator runs as true root (uid 0)', async () => {
    // As uid 0 the pod would run as root and needs no fsGroup volume-chown.
    const uidSpy = vi.spyOn(process, 'getuid').mockReturnValue(0);
    const gidSpy = vi.spyOn(process, 'getgid').mockReturnValue(0);
    try {
      await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));
      const overrides = lastOverrides();
      expect(overrides.spec.securityContext).toBeUndefined();
    } finally {
      uidSpy.mockRestore();
      gidSpy.mockRestore();
    }
  });
});
