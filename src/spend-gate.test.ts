/**
 * Tests for the spend-gate primitive (src/spend-gate.ts).
 *
 * The core invariant under test: the paid agent is invoked ONLY when the
 * cheap classification is non-empty — an empty (or failed) cheap pass never
 * starts the expensive run. Plus the router-seam proof: tieredClassifier
 * rides runTieredAgent on the EXISTING cheap tier ('classifier' →
 * claude-haiku-4-5), no new model plumbing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockConfig = vi.hoisted(() => ({
  NANOCLAW_MODEL: undefined as string | undefined,
  LABOR_TIER_CHEAP_MODEL: undefined as string | undefined,
  LABOR_TIER_STRONG_MODEL: undefined as string | undefined,
}));

// Full config mock: spend-gate imports tiered-agent, which imports
// container-runner (for the default runner) — that needs the container
// config values at module load. Mirrors tiered-agent.test.ts.
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

import type { ContainerInput, ContainerOutput } from './container-runner.js';
import { runSpendGated, tieredClassifier } from './spend-gate.js';
import type { RunAgent, SchemaLike } from './tiered-agent.js';
import type { RegisteredGroup } from './types.js';

beforeEach(() => {
  mockConfig.NANOCLAW_MODEL = undefined;
  mockConfig.LABOR_TIER_CHEAP_MODEL = undefined;
  mockConfig.LABOR_TIER_STRONG_MODEL = undefined;
  delete process.env.LABOR_FORCE_CHEAP_SCHEMA_FAIL;
});

// --- runSpendGated: the gate itself ---

describe('runSpendGated', () => {
  it('empty classification does NOT invoke the paid agent', async () => {
    const invoke = vi.fn(async () => 'paid-result');
    const outcome = await runSpendGated({
      classify: () => [] as string[],
      isEmpty: (c) => c.length === 0,
      invoke,
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(outcome.invoked).toBe(false);
    expect(outcome.result).toBeNull();
    expect(outcome.classification).toEqual([]);
  });

  it('non-empty classification DOES invoke the paid agent, passing the classification', async () => {
    const invoke = vi.fn(async (c: string[]) => `paid:${c.join(',')}`);
    const outcome = await runSpendGated({
      classify: () => ['overdue:TASK-1'],
      isEmpty: (c) => c.length === 0,
      invoke,
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(['overdue:TASK-1']);
    expect(outcome.invoked).toBe(true);
    expect(outcome.result).toBe('paid:overdue:TASK-1');
    expect(outcome.classification).toEqual(['overdue:TASK-1']);
  });

  it('supports an async classify (awaited before the gate decision)', async () => {
    const invoke = vi.fn(async () => 'paid');
    const outcome = await runSpendGated({
      classify: async () => ['x'],
      isEmpty: (c) => c.length === 0,
      invoke,
    });
    expect(outcome.invoked).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('fails closed on spend: a classify error propagates and the paid agent never runs', async () => {
    const invoke = vi.fn(async () => 'paid');
    await expect(
      runSpendGated({
        classify: () => {
          throw new Error('classify blew up');
        },
        isEmpty: () => false,
        invoke,
      }),
    ).rejects.toThrow('classify blew up');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('an invoke error propagates (after a successful classification)', async () => {
    await expect(
      runSpendGated({
        classify: () => ['work'],
        isEmpty: (c) => c.length === 0,
        invoke: async () => {
          throw new Error('paid agent failed');
        },
      }),
    ).rejects.toThrow('paid agent failed');
  });
});

// --- tieredClassifier: the cheap pass rides the existing router seam ---

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Breadbrich Engels',
  added_at: new Date().toISOString(),
};

const baseInput = {
  prompt: 'Emit JSON: {"items": ["<string>"]}',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

/** Hand-rolled zod-shaped validator: `{ items: string[] }`. */
const itemsSchema: SchemaLike<{ items: string[] }> = {
  safeParse(value: unknown) {
    const v = value as { items?: unknown };
    if (
      typeof value === 'object' &&
      value !== null &&
      Array.isArray(v.items) &&
      v.items.every((i) => typeof i === 'string')
    ) {
      return { success: true as const, data: value as { items: string[] } };
    }
    return { success: false as const, error: 'expected { items: string[] }' };
  },
};

function mockRunner(result: string): {
  runAgent: RunAgent;
  calls: ContainerInput[];
} {
  const calls: ContainerInput[] = [];
  const runAgent: RunAgent = async (_group, input) => {
    calls.push(input);
    return {
      status: 'success',
      result,
    } as ContainerOutput;
  };
  return { runAgent, calls };
}

describe('tieredClassifier (rides runTieredAgent / the router seam)', () => {
  it("runs the classification on the CHEAP tier for kind 'classifier' (router default model)", async () => {
    const { runAgent, calls } = mockRunner('{"items": ["overdue:TASK-1"]}');
    const classify = tieredClassifier<{ items: string[] }>(
      'classifier',
      { group: testGroup, input: baseInput, schema: itemsSchema },
      { runAgent },
    );

    const c = await classify();

    expect(c).toEqual({ items: ['overdue:TASK-1'] });
    // Exactly one container run, and it carried the router's CHEAP model —
    // proof the classify pass rides the existing tier chain, not new plumbing.
    expect(calls).toHaveLength(1);
    expect(calls[0].modelOverride).toBe('claude-haiku-4-5');
  });

  it('honors LABOR_TIER_CHEAP_MODEL (the classify pass follows the router registry)', async () => {
    mockConfig.LABOR_TIER_CHEAP_MODEL = 'local-llama-3.3-70b';
    const { runAgent, calls } = mockRunner('{"items": []}');
    const classify = tieredClassifier<{ items: string[] }>(
      'classifier',
      { group: testGroup, input: baseInput, schema: itemsSchema },
      { runAgent },
    );

    await classify();
    expect(calls[0].modelOverride).toBe('local-llama-3.3-70b');
  });

  it('end-to-end: an EMPTY cheap classification costs one cheap run and never wakes the paid agent', async () => {
    const { runAgent, calls } = mockRunner('{"items": []}');
    const invoke = vi.fn(async () => 'expensive-run');

    const outcome = await runSpendGated({
      classify: tieredClassifier<{ items: string[] }>(
        'classifier',
        { group: testGroup, input: baseInput, schema: itemsSchema },
        { runAgent },
      ),
      isEmpty: (c) => c.items.length === 0,
      invoke,
    });

    expect(calls).toHaveLength(1); // the one cheap classify run
    expect(calls[0].modelOverride).toBe('claude-haiku-4-5'); // …on the cheap tier
    expect(invoke).not.toHaveBeenCalled(); // …and no paid run
    expect(outcome.invoked).toBe(false);
  });

  it('end-to-end: a NON-EMPTY cheap classification wakes the paid agent with the cheap result', async () => {
    const { runAgent } = mockRunner('{"items": ["blocking:TASK-9"]}');
    const invoke = vi.fn(async (c: { items: string[] }) => c.items.length);

    const outcome = await runSpendGated({
      classify: tieredClassifier<{ items: string[] }>(
        'classifier',
        { group: testGroup, input: baseInput, schema: itemsSchema },
        { runAgent },
      ),
      isEmpty: (c) => c.items.length === 0,
      invoke,
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith({ items: ['blocking:TASK-9'] });
    expect(outcome.invoked).toBe(true);
    expect(outcome.result).toBe(1);
  });
});
