import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Exercises the k8s dispatch (CONTAINER_RUNTIME=kubernetes) for a MAIN /
// cooperative group. The docker main path mounts the framework project root
// read-only at /workspace/project AND the writable store nested at
// /workspace/project/store. On kubernetes each becomes a separate subPath
// volumeMount, and the kubelet cannot create the /workspace/project/store
// mountpoint UNDER the read-only /workspace/project mount ("mkdirat
// .../workspace/project/store: read-only file system", exit 128) — every
// message is dropped. The fix SKIPS the project-root bind (and its now-pointless
// /dev/null .env shadow) on kubernetes, so the store is no longer nested under a
// read-only parent. These tests assert the resulting pod volumeMounts.
//
// K8S_VOLUME_MODE is a getter over a mutable holder so a single file can drive
// both hostPath (single-node) and pvc (hosted/multi-node) modes.
let mockVolumeMode: 'hostPath' | 'pvc' = 'hostPath';

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
    GITHUB_APP_MODE: false,
    // All roots nested under one PROFILE_DIR so the PVC subPath translator can
    // rewrite every produced host path to a `profile/…` subPath (matches the
    // container-runner-k8s-pvc.test.ts layout).
    DATA_DIR: '/tmp/nanoclaw-test-profile/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-profile/groups',
    IDLE_TIMEOUT: 1800000,
    K8S_DATA_PVC_NAME: 'nanoclaw-data',
    K8S_NAMESPACE: 'tenant-acme',
    K8S_NODE_NAME: 'node-1',
    K8S_POD_IP: '10.0.0.5',
    get K8S_VOLUME_MODE() {
      return mockVolumeMode;
    },
    KB_DASHBOARD_URL: '',
    NANOCLAW_MODEL: undefined,
    NANOCLAW_SUBAGENT_MODEL: undefined,
    PROFILE_DIR: '/tmp/nanoclaw-test-profile',
    SHARED_KB_GROUP: 'slack_main',
    STORE_DIR: '/tmp/nanoclaw-test-profile/store',
    TIMEZONE: 'America/Los_Angeles',
    get MCP_SERVERS() {
      return [];
    },
    mcpServerEnvVarNames,
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

// existsSync returns true ONLY for the host .env file (path.join(cwd, '.env')),
// false otherwise — so the /dev/null .env-shadow branch would fire on docker.
// This makes the "no /workspace/project/.env mount on k8s" assertion meaningful:
// the mount is dropped because of the runtime gate, not because .env is absent.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(
        (p: string) => typeof p === 'string' && p.endsWith('/.env'),
      ),
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

const mainInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: true,
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

function lastVolumeMountPaths(): string[] {
  const [, args] = lastSpawnCall();
  const idx = args.indexOf('--overrides');
  expect(idx).toBeGreaterThan(-1);
  const overrides = JSON.parse(args[idx + 1]);
  const volumeMounts = overrides.spec.containers[0].volumeMounts as Array<{
    mountPath: string;
  }>;
  return volumeMounts.map((v) => v.mountPath);
}

describe.each(['hostPath', 'pvc'] as const)(
  'container-runner k8s main-group mounts (K8S_VOLUME_MODE=%s)',
  (mode) => {
    beforeEach(() => {
      mockVolumeMode = mode;
      vi.useFakeTimers();
      fakeProc = createFakeProcess();
      vi.mocked(spawn).mockClear();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('spawns kubectl for a main group (no crash on the project-root nesting)', async () => {
      await drive(runContainerAgent(testGroup, mainInput, () => {}, vi.fn()));
      const [bin] = lastSpawnCall();
      expect(bin).toBe('kubectl');
    });

    it('does NOT mount the read-only project root or its .env shadow', async () => {
      await drive(runContainerAgent(testGroup, mainInput, () => {}, vi.fn()));
      const paths = lastVolumeMountPaths();
      expect(paths).not.toContain('/workspace/project');
      expect(paths).not.toContain('/workspace/project/.env');
    });

    it('DOES mount the writable store and the group folder', async () => {
      await drive(runContainerAgent(testGroup, mainInput, () => {}, vi.fn()));
      const paths = lastVolumeMountPaths();
      expect(paths).toContain('/workspace/project/store');
      expect(paths).toContain('/workspace/group');
    });

    it('keeps main-only read-only visibility into all groups', async () => {
      await drive(runContainerAgent(testGroup, mainInput, () => {}, vi.fn()));
      const paths = lastVolumeMountPaths();
      expect(paths).toContain('/workspace/all-groups');
    });

    it('the store mount is no longer nested under any read-only mount', async () => {
      await drive(runContainerAgent(testGroup, mainInput, () => {}, vi.fn()));
      const [, args] = lastSpawnCall();
      const overrides = JSON.parse(args[args.indexOf('--overrides') + 1]);
      const volumeMounts = overrides.spec.containers[0].volumeMounts as Array<{
        mountPath: string;
        readOnly?: boolean;
      }>;
      const store = volumeMounts.find(
        (v) => v.mountPath === '/workspace/project/store',
      );
      expect(store).toBeDefined();
      expect(store?.readOnly).not.toBe(true);
      // No read-only mount is a prefix-parent of the store mountpoint.
      const readonlyParents = volumeMounts.filter(
        (v) =>
          v.readOnly === true &&
          '/workspace/project/store'.startsWith(v.mountPath + '/'),
      );
      expect(readonlyParents).toEqual([]);
    });
  },
);
