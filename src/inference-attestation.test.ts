import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Attestation surface tests. config.js is mocked per-scenario so we control
 * the active backend without touching real env; global fetch is mocked to
 * assert the NEAR AI attestation request shape and error handling.
 */

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type ConfigShape = {
  NANOCLAW_BACKEND: 'claude' | 'local';
  NEAR_AI_MODE: boolean;
  NEAR_AI_API_KEY: string | undefined;
  LOCAL_LLM_BASE_URL: string;
  LOCAL_LLM_MODEL: string | undefined;
};

async function withConfig(cfg: ConfigShape) {
  vi.resetModules();
  vi.doMock('./config.js', () => cfg);
  return import('./inference-attestation.js');
}

const NEAR_CFG: ConfigShape = {
  NANOCLAW_BACKEND: 'local',
  NEAR_AI_MODE: true,
  NEAR_AI_API_KEY: 'near-secret-xyz',
  LOCAL_LLM_BASE_URL: 'https://cloud-api.near.ai/v1',
  LOCAL_LLM_MODEL: 'deepseek-ai/DeepSeek-V3.1',
};

describe('inference attestation surface', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  describe('getInferenceProviderInfo (static, no network)', () => {
    it('reports hosted Anthropic for the claude backend', async () => {
      const m = await withConfig({
        NANOCLAW_BACKEND: 'claude',
        NEAR_AI_MODE: false,
        NEAR_AI_API_KEY: undefined,
        LOCAL_LLM_BASE_URL: 'http://host.docker.internal:1234/v1',
        LOCAL_LLM_MODEL: undefined,
      });
      const info = m.getInferenceProviderInfo();
      expect(info.provider).toBe('anthropic');
      expect(info.tee).toBe(false);
      expect(info.openSource).toBe(false);
    });

    it('reports NEAR AI (TEE, open-source) in NEAR AI mode', async () => {
      const m = await withConfig(NEAR_CFG);
      const info = m.getInferenceProviderInfo();
      expect(info.provider).toBe('near-ai');
      expect(info.tee).toBe(true);
      expect(info.openSource).toBe(true);
      expect(info.model).toBe('deepseek-ai/DeepSeek-V3.1');
      expect(info.baseUrl).toBe('https://cloud-api.near.ai/v1');
    });

    it('reports a generic openai-compatible endpoint (open, not TEE)', async () => {
      const m = await withConfig({
        NANOCLAW_BACKEND: 'local',
        NEAR_AI_MODE: false,
        NEAR_AI_API_KEY: undefined,
        LOCAL_LLM_BASE_URL: 'http://host.docker.internal:1234/v1',
        LOCAL_LLM_MODEL: 'qwen2.5-coder-32b-instruct',
      });
      const info = m.getInferenceProviderInfo();
      expect(info.provider).toBe('openai-compatible');
      expect(info.tee).toBe(false);
      expect(info.openSource).toBe(true);
    });
  });

  describe('fetchNearAiAttestation', () => {
    it('returns undefined (no network) when not in NEAR AI mode', async () => {
      const m = await withConfig({
        NANOCLAW_BACKEND: 'claude',
        NEAR_AI_MODE: false,
        NEAR_AI_API_KEY: undefined,
        LOCAL_LLM_BASE_URL: 'http://host.docker.internal:1234/v1',
        LOCAL_LLM_MODEL: undefined,
      });
      expect(m.isAttestationAvailable()).toBe(false);
      expect(await m.fetchNearAiAttestation()).toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('queries the report endpoint with Bearer auth, model, ecdsa + a 64-hex nonce', async () => {
      const report = {
        signing_address: '0xabc',
        nvidia_payload: { x: 1 },
        intel_quote: 'deadbeef',
      };
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => report,
      } as unknown as Response);

      const m = await withConfig(NEAR_CFG);
      const out = await m.fetchNearAiAttestation();
      expect(out).toEqual(report);

      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, opts] = vi.mocked(fetch).mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(url).toContain('https://cloud-api.near.ai/v1/attestation/report');
      expect(url).toContain('model=deepseek-ai%2FDeepSeek-V3.1');
      expect(url).toContain('signing_algo=ecdsa');
      const nonce = new URL(url).searchParams.get('nonce') || '';
      expect(nonce).toMatch(/^[0-9a-f]{64}$/);
      expect((opts.headers as Record<string, string>).Authorization).toBe(
        'Bearer near-secret-xyz',
      );
    });

    it('returns undefined on a non-ok response', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({}),
      } as unknown as Response);
      const m = await withConfig(NEAR_CFG);
      expect(await m.fetchNearAiAttestation()).toBeUndefined();
    });

    it('returns undefined (never throws) on a network error', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));
      const m = await withConfig(NEAR_CFG);
      await expect(m.fetchNearAiAttestation()).resolves.toBeUndefined();
    });
  });

  describe('getInferenceVerification', () => {
    it('combines static info + a live attestation report in NEAR AI mode', async () => {
      const report = { signing_address: '0xabc' };
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => report,
      } as unknown as Response);
      const m = await withConfig(NEAR_CFG);
      const v = await m.getInferenceVerification();
      expect(v.provider).toBe('near-ai');
      expect(v.attestation).toEqual(report);
      expect(v.attestationError).toBeUndefined();
    });

    it('records attestationError when the report is unavailable', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('down'));
      const m = await withConfig(NEAR_CFG);
      const v = await m.getInferenceVerification();
      expect(v.provider).toBe('near-ai');
      expect(v.attestation).toBeUndefined();
      expect(v.attestationError).toBeTruthy();
    });

    it('skips the network with fetchAttestation:false', async () => {
      const m = await withConfig(NEAR_CFG);
      const v = await m.getInferenceVerification({ fetchAttestation: false });
      expect(v.provider).toBe('near-ai');
      expect(v.attestation).toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('returns static info only for non-attested providers', async () => {
      const m = await withConfig({
        NANOCLAW_BACKEND: 'claude',
        NEAR_AI_MODE: false,
        NEAR_AI_API_KEY: undefined,
        LOCAL_LLM_BASE_URL: 'http://host.docker.internal:1234/v1',
        LOCAL_LLM_MODEL: undefined,
      });
      const v = await m.getInferenceVerification();
      expect(v.provider).toBe('anthropic');
      expect(v.attestation).toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
