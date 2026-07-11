import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Backend-mode selection matrix for src/config.ts.
 *
 * config.ts resolves the inference backend at module load from process.env
 * (and, in production, the install .env — absent in tests). We reset the module
 * registry and re-import for each env scenario. readEnvFile reads a real .env
 * from cwd; the repo root has none, so these tests exercise process.env +
 * hardcoded defaults + the NEAR AI convenience layer only.
 */

const BACKEND_ENV_KEYS = [
  'NANOCLAW_BACKEND',
  'LOCAL_LLM_BASE_URL',
  'LOCAL_LLM_MODEL',
  'LOCAL_LLM_API_KEY',
  'NEAR_AI_API_KEY',
  'NEAR_AI_MODEL',
  'NEAR_AI_BASE_URL',
] as const;

type ConfigModule = typeof import('./config.js');

async function loadConfig(
  env: Partial<Record<(typeof BACKEND_ENV_KEYS)[number], string>>,
): Promise<ConfigModule> {
  for (const k of BACKEND_ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v as string;
  vi.resetModules();
  return import('./config.js');
}

describe('config backend selection', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of BACKEND_ENV_KEYS) saved[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of BACKEND_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    vi.resetModules();
  });

  it('defaults to the claude backend with nothing set', async () => {
    const c = await loadConfig({});
    expect(c.NANOCLAW_BACKEND).toBe('claude');
    expect(c.NEAR_AI_MODE).toBe(false);
    // claude mode leaves LOCAL_LLM_* at their generic local-endpoint defaults
    expect(c.LOCAL_LLM_BASE_URL).toBe('http://host.docker.internal:1234/v1');
    expect(c.LOCAL_LLM_API_KEY).toBeUndefined();
  });

  it('explicit NANOCLAW_BACKEND=local selects local (generic OpenAI-compatible)', async () => {
    const c = await loadConfig({
      NANOCLAW_BACKEND: 'local',
      LOCAL_LLM_BASE_URL: 'http://host.docker.internal:1234/v1',
      LOCAL_LLM_MODEL: 'qwen2.5-coder-32b-instruct',
    });
    expect(c.NANOCLAW_BACKEND).toBe('local');
    expect(c.NEAR_AI_MODE).toBe(false);
    expect(c.LOCAL_LLM_MODEL).toBe('qwen2.5-coder-32b-instruct');
    // No NEAR AI key → no NEAR AI-derived key
    expect(c.LOCAL_LLM_API_KEY).toBeUndefined();
  });

  it('NANOCLAW_BACKEND normalizes case and unknown values fall back to claude', async () => {
    expect(
      (await loadConfig({ NANOCLAW_BACKEND: 'LOCAL' })).NANOCLAW_BACKEND,
    ).toBe('local');
    expect(
      (await loadConfig({ NANOCLAW_BACKEND: 'gpt4' })).NANOCLAW_BACKEND,
    ).toBe('claude');
  });

  describe('NEAR AI convenience default', () => {
    it('NEAR_AI_API_KEY alone selects local + NEAR AI Cloud URL/key/default model', async () => {
      const c = await loadConfig({ NEAR_AI_API_KEY: 'near-secret-abc' });
      expect(c.NEAR_AI_MODE).toBe(true);
      expect(c.NANOCLAW_BACKEND).toBe('local');
      expect(c.LOCAL_LLM_BASE_URL).toBe('https://cloud-api.near.ai/v1');
      expect(c.LOCAL_LLM_API_KEY).toBe('near-secret-abc');
      expect(c.LOCAL_LLM_MODEL).toBe(c.NEAR_AI_DEFAULT_MODEL);
      expect(c.LOCAL_LLM_MODEL).toBe('deepseek-ai/DeepSeek-V3.1');
    });

    it('NEAR_AI_MODEL overrides the default model in NEAR AI mode', async () => {
      const c = await loadConfig({
        NEAR_AI_API_KEY: 'near-secret-abc',
        NEAR_AI_MODEL: 'Qwen/Qwen3-235B-A22B',
      });
      expect(c.NANOCLAW_BACKEND).toBe('local');
      expect(c.LOCAL_LLM_MODEL).toBe('Qwen/Qwen3-235B-A22B');
    });

    it('NEAR_AI_BASE_URL overrides the NEAR AI base URL', async () => {
      const c = await loadConfig({
        NEAR_AI_API_KEY: 'near-secret-abc',
        NEAR_AI_BASE_URL: 'https://regional.cloud-api.near.ai/v1',
      });
      expect(c.LOCAL_LLM_BASE_URL).toBe(
        'https://regional.cloud-api.near.ai/v1',
      );
    });

    it('explicit NANOCLAW_BACKEND=claude wins over a NEAR_AI_API_KEY (no auto-flip)', async () => {
      const c = await loadConfig({
        NEAR_AI_API_KEY: 'near-secret-abc',
        NANOCLAW_BACKEND: 'claude',
      });
      expect(c.NEAR_AI_MODE).toBe(false);
      expect(c.NANOCLAW_BACKEND).toBe('claude');
      // NEAR AI defaults must NOT leak into LOCAL_LLM_* when claude is forced
      expect(c.LOCAL_LLM_BASE_URL).toBe('http://host.docker.internal:1234/v1');
      expect(c.LOCAL_LLM_API_KEY).toBeUndefined();
    });

    it('explicit LOCAL_LLM_* override NEAR AI-derived values while staying in NEAR AI mode', async () => {
      const c = await loadConfig({
        NEAR_AI_API_KEY: 'near-secret-abc',
        LOCAL_LLM_MODEL: 'meta-llama/Llama-3.3-70B-Instruct',
        LOCAL_LLM_BASE_URL: 'https://proxy.example/v1',
      });
      // Still NEAR AI mode (key set, backend not explicitly overridden) → local
      expect(c.NEAR_AI_MODE).toBe(true);
      expect(c.NANOCLAW_BACKEND).toBe('local');
      // …but explicit LOCAL_LLM_* win over the NEAR AI-derived defaults
      expect(c.LOCAL_LLM_MODEL).toBe('meta-llama/Llama-3.3-70B-Instruct');
      expect(c.LOCAL_LLM_BASE_URL).toBe('https://proxy.example/v1');
      // key still comes from NEAR AI (no explicit LOCAL_LLM_API_KEY)
      expect(c.LOCAL_LLM_API_KEY).toBe('near-secret-abc');
    });
  });
});
