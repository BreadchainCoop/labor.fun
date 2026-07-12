import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', async () => {
  // Real (deps-free) env-var-name resolver so container-runner's MCP env
  // plumbing runs its actual logic; MCP_SERVERS defaults to [] and can be
  // overridden per-test via setMcpServers() for the generic-bridge cases.
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
    GROUPS_DIR: '/tmp/nanoclaw-test-groups',
    IDLE_TIMEOUT: 1800000, // 30min
    K8S_DATA_PVC_NAME: '',
    K8S_NAMESPACE: '',
    K8S_NODE_NAME: '',
    K8S_POD_IP: '',
    K8S_VOLUME_MODE: 'hostPath',
    KB_DASHBOARD_URL: 'https://kb.test.example',
    NANOCLAW_MODEL: undefined,
    NANOCLAW_SUBAGENT_MODEL: undefined,
    NANOCLAW_BACKEND: 'claude',
    LOCAL_LLM_BASE_URL: 'http://host.docker.internal:1234/v1',
    LOCAL_LLM_MODEL: undefined,
    LOCAL_LLM_API_KEY: undefined,
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

// Mutable holder so individual tests can inject configured MCP servers into
// the mocked config without re-mocking the module. Reset in beforeEach.
let mockMcpServers: unknown[] = [];
function setMcpServers(servers: unknown[]): void {
  mockMcpServers = servers;
}

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
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

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  resourceLimitArgs: vi.fn(() => []),
  stopContainer: vi.fn(),
}));

// Mock container-runtime-k8s (only exercised when CONTAINER_RUNTIME is
// mocked to 'kubernetes' in a specific describe block; harmless default here).
vi.mock('./container-runtime-k8s.js', () => ({
  buildK8sPodOverrides: vi.fn(() => ({})),
  buildKubectlRunArgs: vi.fn(() => ['run', 'test-pod']),
  warnPidsLimitUnsupported: vi.fn(),
}));

// Mock credential-proxy
vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
}));

// Mock env reader so .env on the host machine doesn't make tests
// nondeterministic — getGithubToken() then falls back to process.env.
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

// Create a controllable fake ChildProcess
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

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { spawn } from 'child_process';
import fs from 'fs';
import { logger } from './logger.js';
import { resourceLimitArgs } from './container-runtime.js';
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

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('container-runner GitHub PAT injection', () => {
  const SECRET = 'github_pat_TESTSECRET_do_not_log_0123456789abcdef';
  let savedToken: string | undefined;
  let savedLinear: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
    vi.mocked(logger.debug).mockClear();
    vi.mocked(logger.info).mockClear();
    savedToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    // The runtime env override is now shared across tokens (extraEnv), so the
    // "omits env entirely" assertion below depends on LINEAR_API_KEY being
    // absent too — isolate it from any ambient value.
    savedLinear = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedToken === undefined) {
      delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    } else {
      process.env.GITHUB_PERSONAL_ACCESS_TOKEN = savedToken;
    }
    if (savedLinear === undefined) {
      delete process.env.LINEAR_API_KEY;
    } else {
      process.env.LINEAR_API_KEY = savedLinear;
    }
  });

  // Run to completion so the returned promise resolves (no open handles).
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
    return calls[calls.length - 1] as unknown as [
      string,
      string[],
      { stdio: unknown; env?: NodeJS.ProcessEnv },
    ];
  }

  it('passes the PAT via the runtime env, never in argv, when set', async () => {
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN = SECRET;

    await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));

    const [, args, opts] = lastSpawnCall();

    // Passthrough flag present as name only (no `=value`)
    expect(args).toContain('GITHUB_PERSONAL_ACCESS_TOKEN');
    expect(args.some((a) => a.includes(`GITHUB_PERSONAL_ACCESS_TOKEN=`))).toBe(
      false,
    );

    // The secret value must not appear anywhere in argv
    expect(args.some((a) => a.includes(SECRET))).toBe(false);
    expect(args.join(' ')).not.toContain(SECRET);

    // The secret is delivered only through the spawned runtime's env
    expect(opts.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe(SECRET);

    // And it must not have leaked into any log line
    const logged = JSON.stringify([
      ...vi.mocked(logger.debug).mock.calls,
      ...vi.mocked(logger.info).mock.calls,
    ]);
    expect(logged).not.toContain(SECRET);
  });

  it('omits the GitHub env entirely when no PAT is set', async () => {
    await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));

    const [, args, opts] = lastSpawnCall();

    expect(args).not.toContain('GITHUB_PERSONAL_ACCESS_TOKEN');
    // No env override is applied at all when the token is absent
    expect(opts.env).toBeUndefined();
  });

  it('passes KB_DASHBOARD_URL by value in argv (non-secret, for citations)', async () => {
    await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));

    const [, args] = lastSpawnCall();

    // Mocked config sets KB_DASHBOARD_URL — it should reach the container so the
    // agent can deep-link internal-doc citations into the dashboard.
    expect(args).toContain('KB_DASHBOARD_URL=https://kb.test.example');
  });
});

describe('container-runner placeholder API key composition', () => {
  let savedAuthToken: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
    savedAuthToken = process.env.CREDENTIAL_PROXY_AUTH_TOKEN;
    delete process.env.CREDENTIAL_PROXY_AUTH_TOKEN;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedAuthToken === undefined) {
      delete process.env.CREDENTIAL_PROXY_AUTH_TOKEN;
    } else {
      process.env.CREDENTIAL_PROXY_AUTH_TOKEN = savedAuthToken;
    }
  });

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

  function lastSpawnArgs(): string[] {
    const calls = vi.mocked(spawn).mock.calls;
    return calls[calls.length - 1][1] as unknown as string[];
  }

  it('encodes placeholder-<containerName> with no auth token configured', async () => {
    await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));

    const args = lastSpawnArgs();
    const apiKeyArg = args.find((a) => a.startsWith('ANTHROPIC_API_KEY='));
    expect(apiKeyArg).toBeDefined();
    const value = apiKeyArg!.slice('ANTHROPIC_API_KEY='.length);
    expect(value).toMatch(/^placeholder-nanoclaw-test-group-\d+$/);
  });

  it('encodes placeholder.<authToken>.<containerName> when CREDENTIAL_PROXY_AUTH_TOKEN is set', async () => {
    process.env.CREDENTIAL_PROXY_AUTH_TOKEN = 'shared-secret';

    await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));

    const args = lastSpawnArgs();
    const apiKeyArg = args.find((a) => a.startsWith('ANTHROPIC_API_KEY='));
    expect(apiKeyArg).toBeDefined();
    const value = apiKeyArg!.slice('ANTHROPIC_API_KEY='.length);
    expect(value).toMatch(
      /^placeholder\.shared-secret\.nanoclaw-test-group-\d+$/,
    );
  });
});

describe('container-runner resource limit args', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
    vi.mocked(resourceLimitArgs).mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(resourceLimitArgs).mockReturnValue([]);
  });

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

  function lastSpawnArgs(): string[] {
    const calls = vi.mocked(spawn).mock.calls;
    return calls[calls.length - 1][1] as unknown as string[];
  }

  it('includes no resource-limit flags by default', async () => {
    await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));
    const args = lastSpawnArgs();
    expect(args).not.toContain('--memory');
    expect(args).not.toContain('--cpus');
    expect(args).not.toContain('--pids-limit');
  });

  it('forwards resourceLimitArgs() output into the docker run args', async () => {
    vi.mocked(resourceLimitArgs).mockReturnValue([
      '--memory',
      '512m',
      '--memory-swap',
      '512m',
      '--cpus',
      '1.5',
      '--pids-limit',
      '256',
    ]);

    await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));

    const args = lastSpawnArgs();
    expect(args).toContain('--memory');
    expect(args).toContain('512m');
    expect(args).toContain('--cpus');
    expect(args).toContain('1.5');
    expect(args).toContain('--pids-limit');
    expect(args).toContain('256');
  });
});

describe('container-runner Linear API key injection', () => {
  const SECRET = 'lin_api_TESTSECRET_do_not_log_0123456789abcdef';
  let savedLinear: string | undefined;
  let savedGithub: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
    vi.mocked(logger.debug).mockClear();
    vi.mocked(logger.info).mockClear();
    savedLinear = process.env.LINEAR_API_KEY;
    savedGithub = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    delete process.env.LINEAR_API_KEY;
    delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedLinear === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = savedLinear;
    if (savedGithub === undefined)
      delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    else process.env.GITHUB_PERSONAL_ACCESS_TOKEN = savedGithub;
  });

  // Run to completion so the returned promise resolves (no open handles).
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
    return calls[calls.length - 1] as unknown as [
      string,
      string[],
      { stdio: unknown; env?: NodeJS.ProcessEnv },
    ];
  }

  it('passes the API key via the runtime env, never in argv, when set', async () => {
    process.env.LINEAR_API_KEY = SECRET;

    await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));

    const [, args, opts] = lastSpawnCall();

    // Passthrough flag present as name only (no `=value`)
    expect(args).toContain('LINEAR_API_KEY');
    expect(args.some((a) => a.includes(`LINEAR_API_KEY=`))).toBe(false);

    // The secret value must not appear anywhere in argv
    expect(args.some((a) => a.includes(SECRET))).toBe(false);
    expect(args.join(' ')).not.toContain(SECRET);

    // The secret is delivered only through the spawned runtime's env
    expect(opts.env?.LINEAR_API_KEY).toBe(SECRET);

    // And it must not have leaked into any log line
    const logged = JSON.stringify([
      ...vi.mocked(logger.debug).mock.calls,
      ...vi.mocked(logger.info).mock.calls,
    ]);
    expect(logged).not.toContain(SECRET);
  });

  it('omits the Linear env entirely when no API key is set', async () => {
    await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));

    const [, args, opts] = lastSpawnCall();

    expect(args).not.toContain('LINEAR_API_KEY');
    // No env override is applied at all when neither token is set
    expect(opts.env).toBeUndefined();
  });
});

describe('container-runner generic remote-MCP bridge', () => {
  const SECRET = 'zapier-secret-TESTVALUE-do-not-log-0123456789';

  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
    vi.mocked(logger.debug).mockClear();
    vi.mocked(logger.info).mockClear();
    setMcpServers([]);
    delete process.env.ZAPIER_MCP_TOKEN;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.ZAPIER_MCP_TOKEN;
    setMcpServers([]);
  });

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
    return calls[calls.length - 1] as unknown as [
      string,
      string[],
      { stdio: unknown; env?: NodeJS.ProcessEnv },
    ];
  }

  it('passes the referenced env var by NAME only in argv, and by VALUE via the runtime env, when set', async () => {
    setMcpServers([
      {
        name: 'zapier',
        type: 'http',
        url: 'https://mcp.zapier.com/api/mcp/abc',
        bearerEnvVar: 'ZAPIER_MCP_TOKEN',
      },
    ]);
    process.env.ZAPIER_MCP_TOKEN = SECRET;

    await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));

    const [, args, opts] = lastSpawnCall();

    // Passthrough flag present as name only (no `=value`)
    expect(args).toContain('ZAPIER_MCP_TOKEN');
    expect(args.some((a) => a.includes('ZAPIER_MCP_TOKEN='))).toBe(false);
    expect(args.join(' ')).not.toContain(SECRET);

    // The secret is delivered only through the spawned runtime's env
    expect(opts.env?.ZAPIER_MCP_TOKEN).toBe(SECRET);

    // And it must not have leaked into any log line
    const logged = JSON.stringify([
      ...vi.mocked(logger.debug).mock.calls,
      ...vi.mocked(logger.info).mock.calls,
    ]);
    expect(logged).not.toContain(SECRET);
  });

  it('omits the env passthrough entirely when the referenced env var is unset', async () => {
    setMcpServers([
      {
        name: 'zapier',
        type: 'http',
        url: 'https://mcp.zapier.com/api/mcp/abc',
        bearerEnvVar: 'ZAPIER_MCP_TOKEN',
      },
    ]);

    await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));

    const [, args, opts] = lastSpawnCall();
    expect(args).not.toContain('ZAPIER_MCP_TOKEN');
    expect(opts.env).toBeUndefined();
  });

  it('injects the configured mcpServers into the stdin-JSON payload written to the container process', async () => {
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

  it('does not change docker args/env at all when no mcpServers are configured (no behavior change)', async () => {
    await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));
    const [, args, opts] = lastSpawnCall();
    expect(args.filter((a) => a === 'ZAPIER_MCP_TOKEN')).toHaveLength(0);
    expect(opts.env).toBeUndefined();
  });
});

describe('container-runner Google Workspace credentials mount', () => {
  const HOST_CREDS_PATH = '/home/test/.config/gws/credentials.json';
  const CONTAINER_CREDS_PATH = '/run/secrets/gws-credentials.json';
  let savedEnv: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
    vi.mocked(logger.debug).mockClear();
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.warn).mockClear();
    savedEnv = process.env.GOOGLE_WORKSPACE_CREDENTIALS_FILE;
    delete process.env.GOOGLE_WORKSPACE_CREDENTIALS_FILE;
    // Reset fs mocks back to the "nothing exists" defaults
    vi.mocked(fs.realpathSync).mockImplementation(((p: string) => p) as never);
    vi.mocked(fs.statSync).mockImplementation((() => ({
      isDirectory: () => false,
      isFile: () => false,
    })) as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedEnv === undefined) {
      delete process.env.GOOGLE_WORKSPACE_CREDENTIALS_FILE;
    } else {
      process.env.GOOGLE_WORKSPACE_CREDENTIALS_FILE = savedEnv;
    }
  });

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

  it('mounts creds file and injects env var when path is valid', async () => {
    process.env.GOOGLE_WORKSPACE_CREDENTIALS_FILE = HOST_CREDS_PATH;
    vi.mocked(fs.realpathSync).mockImplementation(((p: string) => p) as never);
    vi.mocked(fs.statSync).mockImplementation((() => ({
      isDirectory: () => false,
      isFile: () => true,
    })) as never);

    await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));

    const [, args] = lastSpawnCall();

    // Read-only bind-mount: hostPath:containerPath:ro (matches readonlyMountArgs mock)
    expect(args).toContain(`${HOST_CREDS_PATH}:${CONTAINER_CREDS_PATH}:ro`);

    // Env var carries the in-container path, not the host path
    expect(args).toContain(
      `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=${CONTAINER_CREDS_PATH}`,
    );
    expect(
      args.some(
        (a) =>
          a.includes('GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE') &&
          a.includes(HOST_CREDS_PATH),
      ),
    ).toBe(false);
  });

  it('omits mount and env var when GOOGLE_WORKSPACE_CREDENTIALS_FILE is unset', async () => {
    await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));

    const [, args] = lastSpawnCall();

    expect(args.some((a) => a.includes(CONTAINER_CREDS_PATH))).toBe(false);
    expect(
      args.some((a) => a.startsWith('GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=')),
    ).toBe(false);
  });

  it('omits mount and logs a warning when the path does not exist', async () => {
    process.env.GOOGLE_WORKSPACE_CREDENTIALS_FILE = HOST_CREDS_PATH;
    vi.mocked(fs.realpathSync).mockImplementation((() => {
      throw new Error('ENOENT');
    }) as never);

    await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));

    const [, args] = lastSpawnCall();
    expect(args.some((a) => a.includes(CONTAINER_CREDS_PATH))).toBe(false);
    expect(
      args.some((a) => a.startsWith('GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=')),
    ).toBe(false);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ path: HOST_CREDS_PATH }),
      expect.stringContaining('does not exist'),
    );
  });

  it('omits mount and logs a warning when the path is a directory, not a file', async () => {
    process.env.GOOGLE_WORKSPACE_CREDENTIALS_FILE = HOST_CREDS_PATH;
    vi.mocked(fs.realpathSync).mockImplementation(((p: string) => p) as never);
    vi.mocked(fs.statSync).mockImplementation((() => ({
      isDirectory: () => true,
      isFile: () => false,
    })) as never);

    await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));

    const [, args] = lastSpawnCall();
    expect(args.some((a) => a.includes(CONTAINER_CREDS_PATH))).toBe(false);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ path: HOST_CREDS_PATH }),
      expect.stringContaining('not a regular file'),
    );
  });

  it('rejects paths that resolve under blocked patterns (e.g. ~/.ssh)', async () => {
    const sshPath = '/home/test/.ssh/id_rsa';
    process.env.GOOGLE_WORKSPACE_CREDENTIALS_FILE = sshPath;
    vi.mocked(fs.realpathSync).mockImplementation(((p: string) => p) as never);
    vi.mocked(fs.statSync).mockImplementation((() => ({
      isDirectory: () => false,
      isFile: () => true,
    })) as never);

    await drive(runContainerAgent(testGroup, testInput, () => {}, vi.fn()));

    const [, args] = lastSpawnCall();
    expect(args.some((a) => a.includes(CONTAINER_CREDS_PATH))).toBe(false);
    expect(
      args.some((a) => a.startsWith('GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=')),
    ).toBe(false);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({
        path: sshPath,
        blockedPattern: expect.stringMatching(/\.ssh|id_rsa/),
      }),
      expect.stringContaining('blocked pattern'),
    );
  });
});

describe('container-runner local-LLM backend wiring', () => {
  const LLM_SECRET = 'sk-local-TESTSECRET_must_not_leak_0123456789abcdef';

  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
    vi.mocked(logger.debug).mockClear();
    vi.mocked(logger.info).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

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
    return calls[calls.length - 1] as unknown as [
      string,
      string[],
      { stdio: unknown; env?: NodeJS.ProcessEnv },
    ];
  }

  it('local mode: omits Anthropic proxy env, passes LOCAL_LLM_* through, keeps API key out of argv/logs', async () => {
    vi.resetModules();
    const { mcpServerEnvVarNames } =
      await vi.importActual<typeof import('./mcp-servers.js')>(
        './mcp-servers.js',
      );
    vi.doMock('./config.js', () => ({
      AGENT_CONTAINER_CPUS: '',
      AGENT_CONTAINER_MEMORY: '',
      AGENT_CONTAINER_PIDS_LIMIT: '',
      CONTAINER_IMAGE: 'nanoclaw-agent:latest',
      CONTAINER_MAX_OUTPUT_SIZE: 10485760,
      CONTAINER_RUNTIME: 'docker',
      DOCKER_SIBLING_MODE: false,
      CONTAINER_TIMEOUT: 1800000,
      CREDENTIAL_PROXY_PORT: 3001,
      DATA_DIR: '/tmp/nanoclaw-test-data',
      GROUPS_DIR: '/tmp/nanoclaw-test-groups',
      IDLE_TIMEOUT: 1800000,
      K8S_DATA_PVC_NAME: '',
      K8S_NAMESPACE: '',
      K8S_NODE_NAME: '',
      K8S_POD_IP: '',
      K8S_VOLUME_MODE: 'hostPath',
      KB_DASHBOARD_URL: 'https://kb.test.example',
      MCP_SERVERS: [],
      NANOCLAW_MODEL: undefined,
      NANOCLAW_SUBAGENT_MODEL: undefined,
      NANOCLAW_BACKEND: 'local',
      LOCAL_LLM_BASE_URL: 'http://host.docker.internal:1234/v1',
      LOCAL_LLM_MODEL: 'qwen2.5-coder-32b-instruct',
      LOCAL_LLM_API_KEY: LLM_SECRET,
      PROFILE_DIR: '/tmp/nanoclaw-test-profile',
      SHARED_KB_GROUP: 'slack_main',
      STORE_DIR: '/tmp/nanoclaw-test-profile/store',
      TIMEZONE: 'America/Los_Angeles',
      mcpServerEnvVarNames,
    }));
    const { runContainerAgent: runLocal } =
      await import('./container-runner.js');

    await drive(runLocal(testGroup, testInput, () => {}, vi.fn()));

    const [, args, opts] = lastSpawnCall();
    const flat = args.join(' ');

    // Backend selection is announced
    expect(args).toContain('NANOCLAW_BACKEND=local');

    // Local-LLM base URL + model are in argv (non-secret config)
    expect(args).toContain(
      'LOCAL_LLM_BASE_URL=http://host.docker.internal:1234/v1',
    );
    expect(args).toContain('LOCAL_LLM_MODEL=qwen2.5-coder-32b-instruct');

    // API key is passed as a passthrough flag, not inline — and never raw
    expect(args).toContain('LOCAL_LLM_API_KEY');
    expect(args.some((a) => a.includes('LOCAL_LLM_API_KEY='))).toBe(false);
    expect(flat).not.toContain(LLM_SECRET);

    // The Anthropic proxy / placeholder auth must NOT be injected
    expect(args.some((a) => a.startsWith('ANTHROPIC_BASE_URL='))).toBe(false);
    expect(args).not.toContain('ANTHROPIC_API_KEY=placeholder');
    expect(args).not.toContain('CLAUDE_CODE_OAUTH_TOKEN=placeholder');

    // Secret travels via the spawned runtime's env override only
    expect(opts.env?.LOCAL_LLM_API_KEY).toBe(LLM_SECRET);

    // And it must not have leaked into any log line
    const logged = JSON.stringify([
      ...vi.mocked(logger.debug).mock.calls,
      ...vi.mocked(logger.info).mock.calls,
    ]);
    expect(logged).not.toContain(LLM_SECRET);
  });
});
