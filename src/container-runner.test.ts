import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  NANOCLAW_MODEL: undefined,
  NANOCLAW_SUBAGENT_MODEL: undefined,
  NANOCLAW_BACKEND: 'claude',
  LOCAL_LLM_BASE_URL: 'http://host.docker.internal:1234/v1',
  LOCAL_LLM_MODEL: undefined,
  LOCAL_LLM_API_KEY: undefined,
  SHARED_KB_GROUP: 'slack_main',
  TIMEZONE: 'America/Los_Angeles',
}));

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
      statSync: vi.fn(() => ({ isDirectory: () => false })),
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
  stopContainer: vi.fn(),
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
import { logger } from './logger.js';
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

  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
    vi.mocked(logger.debug).mockClear();
    vi.mocked(logger.info).mockClear();
    savedToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedToken === undefined) {
      delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    } else {
      process.env.GITHUB_PERSONAL_ACCESS_TOKEN = savedToken;
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
    vi.doMock('./config.js', () => ({
      CONTAINER_IMAGE: 'nanoclaw-agent:latest',
      CONTAINER_MAX_OUTPUT_SIZE: 10485760,
      CONTAINER_TIMEOUT: 1800000,
      CREDENTIAL_PROXY_PORT: 3001,
      DATA_DIR: '/tmp/nanoclaw-test-data',
      GROUPS_DIR: '/tmp/nanoclaw-test-groups',
      IDLE_TIMEOUT: 1800000,
      NANOCLAW_MODEL: undefined,
      NANOCLAW_SUBAGENT_MODEL: undefined,
      NANOCLAW_BACKEND: 'local',
      LOCAL_LLM_BASE_URL: 'http://host.docker.internal:1234/v1',
      LOCAL_LLM_MODEL: 'qwen2.5-coder-32b-instruct',
      LOCAL_LLM_API_KEY: LLM_SECRET,
      SHARED_KB_GROUP: 'slack_main',
      TIMEZONE: 'America/Los_Angeles',
    }));
    const { runContainerAgent: runLocal } = await import(
      './container-runner.js'
    );

    await drive(runLocal(testGroup, testInput, () => {}, vi.fn()));

    const [, args, opts] = lastSpawnCall();
    const flat = args.join(' ');

    // Backend selection is announced
    expect(args).toContain('NANOCLAW_BACKEND=local');

    // Local-LLM base URL + model are in argv (non-secret config)
    expect(args).toContain('LOCAL_LLM_BASE_URL=http://host.docker.internal:1234/v1');
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
