/**
 * Tests for runTieredAgent (src/tiered-agent.ts) — the cheap→strong
 * escalation helper — against a mocked container runner (injected via deps).
 *
 * Matrix: base-tier success / schema-fail escalation / parse-fail escalation /
 * chain exhausted / LABOR_FORCE_CHEAP_SCHEMA_FAIL deterministic escalation /
 * hard container error (no escalation) / input passthrough.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockConfig = vi.hoisted(() => ({
  NANOCLAW_MODEL: undefined as string | undefined,
  LABOR_TIER_CHEAP_MODEL: undefined as string | undefined,
  LABOR_TIER_STRONG_MODEL: undefined as string | undefined,
}));

// Full config mock: tiered-agent imports container-runner (for the default
// runner), which needs the container config values at module load.
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
    CONTAINER_TIMEOUT: 1800000,
    CREDENTIAL_PROXY_PORT: 3001,
    DATA_DIR: '/tmp/nanoclaw-test-data',
    ENABLED_SKILLS: [],
    GITHUB_APP_MODE: false,
    GROUPS_DIR: '/tmp/nanoclaw-test-groups',
    IDLE_TIMEOUT: 1800000,
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
    get LABOR_TIER_CHEAP_MODEL() {
      return mockConfig.LABOR_TIER_CHEAP_MODEL;
    },
    get LABOR_TIER_STRONG_MODEL() {
      return mockConfig.LABOR_TIER_STRONG_MODEL;
    },
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

import type { ContainerOutput } from './container-runner.js';
import {
  runTieredAgent,
  FORCED_SCHEMA_FAIL_TEXT,
  type RunAgent,
  type SchemaLike,
} from './tiered-agent.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Breadbrich Engels',
  added_at: new Date().toISOString(),
};

const baseInput = {
  prompt: 'Emit JSON: {"answer": "<string>"}',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

/** Hand-rolled zod-shaped validator: `{ answer: string }`. */
const answerSchema: SchemaLike<{ answer: string }> = {
  safeParse(value: unknown) {
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { answer?: unknown }).answer === 'string'
    ) {
      return { success: true as const, data: value as { answer: string } };
    }
    return { success: false as const, error: 'expected { answer: string }' };
  },
};

function ok(result: string): ContainerOutput {
  return { status: 'success', result };
}

function mockRunner(...outputs: ContainerOutput[]) {
  const fn = vi.fn<RunAgent>();
  for (const out of outputs) fn.mockResolvedValueOnce(out);
  return fn;
}

/** modelOverride of the i-th runner call. */
function overrideAt(fn: ReturnType<typeof mockRunner>, i: number) {
  return fn.mock.calls[i][1].modelOverride;
}

beforeEach(() => {
  mockConfig.NANOCLAW_MODEL = 'claude-global-model';
  mockConfig.LABOR_TIER_CHEAP_MODEL = undefined;
  mockConfig.LABOR_TIER_STRONG_MODEL = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('base-tier success', () => {
  it('default-tier kind: returns the validated result at tier=default', async () => {
    const runAgent = mockRunner(ok('{"answer":"hi"}'));

    const res = await runTieredAgent(
      'message',
      { group: testGroup, input: baseInput, schema: answerSchema },
      { runAgent },
    );

    expect(res).toEqual({
      result: { answer: 'hi' },
      tierUsed: 'default',
      model: 'claude-global-model',
    });
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(overrideAt(runAgent, 0)).toBe('claude-global-model');
  });

  it('cheap-tier kind: returns at tier=cheap with the cheap model', async () => {
    const runAgent = mockRunner(ok('{"answer":"cheap did it"}'));

    const res = await runTieredAgent(
      'classifier',
      { group: testGroup, input: baseInput, schema: answerSchema },
      { runAgent },
    );

    expect(res.tierUsed).toBe('cheap');
    expect(res.model).toBe('claude-haiku-4-5');
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it('tolerates surrounding whitespace in the result text', async () => {
    const runAgent = mockRunner(ok('  \n{"answer":"hi"}\n  '));

    const res = await runTieredAgent(
      'message',
      { group: testGroup, input: baseInput, schema: answerSchema },
      { runAgent },
    );

    expect(res.result).toEqual({ answer: 'hi' });
  });

  it('returns the schema-produced data (not the raw parse)', async () => {
    const upperSchema: SchemaLike<{ answer: string }> = {
      safeParse(value: unknown) {
        const base = answerSchema.safeParse(value);
        if (!base.success) return base;
        return {
          success: true as const,
          data: { answer: base.data.answer.toUpperCase() },
        };
      },
    };
    const runAgent = mockRunner(ok('{"answer":"hi"}'));

    const res = await runTieredAgent(
      'message',
      { group: testGroup, input: baseInput, schema: upperSchema },
      { runAgent },
    );

    expect(res.result).toEqual({ answer: 'HI' });
  });
});

describe('escalation on validation failure', () => {
  it('cheap schema-fail → strong success (cheap→strong ladder)', async () => {
    const runAgent = mockRunner(
      ok('{"wrong":"shape"}'),
      ok('{"answer":"strong did it"}'),
    );

    const res = await runTieredAgent(
      'classifier',
      { group: testGroup, input: baseInput, schema: answerSchema },
      { runAgent },
    );

    expect(res).toEqual({
      result: { answer: 'strong did it' },
      tierUsed: 'strong',
      model: 'claude-opus-4-8',
    });
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(overrideAt(runAgent, 0)).toBe('claude-haiku-4-5');
    expect(overrideAt(runAgent, 1)).toBe('claude-opus-4-8');
  });

  it('non-JSON output also escalates (parse-failure path)', async () => {
    const runAgent = mockRunner(
      ok('Sorry, I cannot produce JSON right now.'),
      ok('{"answer":"ok"}'),
    );

    const res = await runTieredAgent(
      'classifier',
      { group: testGroup, input: baseInput, schema: answerSchema },
      { runAgent },
    );

    expect(res.tierUsed).toBe('strong');
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it('default-tier kind escalates default → strong', async () => {
    const runAgent = mockRunner(ok('not json'), ok('{"answer":"ok"}'));

    const res = await runTieredAgent(
      'message',
      { group: testGroup, input: baseInput, schema: answerSchema },
      { runAgent },
    );

    expect(res.tierUsed).toBe('strong');
    expect(overrideAt(runAgent, 0)).toBe('claude-global-model');
    expect(overrideAt(runAgent, 1)).toBe('claude-opus-4-8');
  });

  it('all tiers exhausted → throws with per-tier failure detail', async () => {
    const runAgent = mockRunner(ok('not json'), ok('{"wrong":"shape"}'));

    await expect(
      runTieredAgent(
        'classifier',
        { group: testGroup, input: baseInput, schema: answerSchema },
        { runAgent },
      ),
    ).rejects.toThrow(
      /all tiers exhausted.*tier=cheap: output is not valid JSON.*tier=strong: output failed schema validation/,
    );
    expect(runAgent).toHaveBeenCalledTimes(2);
  });
});

describe('LABOR_FORCE_CHEAP_SCHEMA_FAIL — deterministic escalation test flag', () => {
  it.each(['1', 'true'])(
    'flag=%s: cheap tier short-circuits (no container run) and escalates to strong',
    async (flagValue) => {
      vi.stubEnv('LABOR_FORCE_CHEAP_SCHEMA_FAIL', flagValue);
      const runAgent = mockRunner(ok('{"answer":"strong"}'));

      const res = await runTieredAgent(
        'classifier',
        { group: testGroup, input: baseInput, schema: answerSchema },
        { runAgent },
      );

      expect(res.tierUsed).toBe('strong');
      // The cheap tier never reached the container — only strong ran.
      expect(runAgent).toHaveBeenCalledTimes(1);
      expect(overrideAt(runAgent, 0)).toBe('claude-opus-4-8');
    },
  );

  it('flag does not affect non-cheap tiers (default runs normally)', async () => {
    vi.stubEnv('LABOR_FORCE_CHEAP_SCHEMA_FAIL', '1');
    const runAgent = mockRunner(ok('{"answer":"hi"}'));

    const res = await runTieredAgent(
      'message',
      { group: testGroup, input: baseInput, schema: answerSchema },
      { runAgent },
    );

    expect(res.tierUsed).toBe('default');
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it('flag unset: cheap tier runs its container normally (inert default)', async () => {
    const runAgent = mockRunner(ok('{"answer":"cheap"}'));

    const res = await runTieredAgent(
      'classifier',
      { group: testGroup, input: baseInput, schema: answerSchema },
      { runAgent },
    );

    expect(res.tierUsed).toBe('cheap');
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it('the forced text is intentionally not parseable as JSON', () => {
    expect(() => JSON.parse(FORCED_SCHEMA_FAIL_TEXT)).toThrow();
  });
});

describe('hard container errors fail immediately; silent completions escalate', () => {
  it('error status at the base tier throws without trying the next tier', async () => {
    const runAgent = mockRunner({
      status: 'error',
      result: null,
      error: 'docker exploded',
    });

    await expect(
      runTieredAgent(
        'classifier',
        { group: testGroup, input: baseInput, schema: answerSchema },
        { runAgent },
      ),
    ).rejects.toThrow(/container run failed at tier=cheap.*docker exploded/);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it('a silent completion (success + null result) escalates instead of throwing', async () => {
    const runAgent = mockRunner(
      { status: 'success', result: null },
      ok('{"answer":"strong"}'),
    );

    const res = await runTieredAgent(
      'message',
      { group: testGroup, input: baseInput, schema: answerSchema },
      { runAgent },
    );

    expect(res.tierUsed).toBe('strong');
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it('all tiers silent → exhausted error names the no-output failures', async () => {
    const runAgent = mockRunner(
      { status: 'success', result: null },
      { status: 'success', result: null },
    );

    await expect(
      runTieredAgent(
        'classifier',
        { group: testGroup, input: baseInput, schema: answerSchema },
        { runAgent },
      ),
    ).rejects.toThrow(
      /all tiers exhausted.*tier=cheap: agent returned no output.*tier=strong: agent returned no output/,
    );
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it('a thrown runner error propagates unchanged', async () => {
    const boom = new Error('spawn ENOENT');
    const runAgent = vi.fn<RunAgent>().mockRejectedValueOnce(boom);

    await expect(
      runTieredAgent(
        'classifier',
        { group: testGroup, input: baseInput, schema: answerSchema },
        { runAgent },
      ),
    ).rejects.toThrow('spawn ENOENT');
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it('a hard error at the escalated tier throws (not "exhausted")', async () => {
    const runAgent = mockRunner(ok('not json'), {
      status: 'error',
      result: null,
      error: 'strong tier infra down',
    });

    await expect(
      runTieredAgent(
        'classifier',
        { group: testGroup, input: baseInput, schema: answerSchema },
        { runAgent },
      ),
    ).rejects.toThrow(/container run failed at tier=strong/);
    expect(runAgent).toHaveBeenCalledTimes(2);
  });
});

describe('input passthrough', () => {
  it('forwards the group and input fields verbatim, adding only modelOverride', async () => {
    const runAgent = mockRunner(ok('{"answer":"hi"}'));
    const input = { ...baseInput, sessionId: 'sess-1', isScheduledTask: true };

    await runTieredAgent(
      'message',
      { group: testGroup, input, schema: answerSchema },
      { runAgent },
    );

    const [group, sentInput] = runAgent.mock.calls[0];
    expect(group).toBe(testGroup);
    expect(sentInput).toEqual({
      ...input,
      modelOverride: 'claude-global-model',
    });
    // The caller's input object is not mutated.
    expect('modelOverride' in input).toBe(false);
  });

  it('uses the provided onProcess hook', async () => {
    const runAgent = mockRunner(ok('{"answer":"hi"}'));
    const onProcess = vi.fn();

    await runTieredAgent(
      'message',
      { group: testGroup, input: baseInput, schema: answerSchema, onProcess },
      { runAgent },
    );

    expect(runAgent.mock.calls[0][2]).toBe(onProcess);
  });
});
