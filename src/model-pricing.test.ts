import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('model-pricing', () => {
  const originalEnv = process.env.MODEL_PRICING_JSON;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MODEL_PRICING_JSON;
    } else {
      process.env.MODEL_PRICING_JSON = originalEnv;
    }
  });

  describe('resolvePricing', () => {
    it('matches opus models by substring', async () => {
      const { resolvePricing } = await import('./model-pricing.js');
      const pricing = resolvePricing('claude-opus-4-6-20260115');
      expect(pricing.input).toBe(15);
      expect(pricing.output).toBe(75);
    });

    it('matches sonnet models by substring', async () => {
      const { resolvePricing } = await import('./model-pricing.js');
      const pricing = resolvePricing('claude-sonnet-5-20260201');
      expect(pricing.input).toBe(3);
      expect(pricing.output).toBe(15);
    });

    it('matches fable/mythos frontier models by substring', async () => {
      const { resolvePricing } = await import('./model-pricing.js');
      const fable = resolvePricing('claude-fable-5');
      expect(fable.input).toBe(10);
      expect(fable.output).toBe(50);
      expect(resolvePricing('claude-mythos-5')).toEqual(fable);
    });

    it('matches haiku models by substring', async () => {
      const { resolvePricing } = await import('./model-pricing.js');
      const pricing = resolvePricing('claude-haiku-4-5');
      expect(pricing.input).toBe(0.8);
      expect(pricing.output).toBe(4);
    });

    it('falls back to a conservative default for unknown models', async () => {
      const { resolvePricing } = await import('./model-pricing.js');
      const pricing = resolvePricing('some-future-model-xyz');
      expect(pricing).toEqual(resolvePricing('claude-sonnet-5'));
    });

    it('handles null/undefined model', async () => {
      const { resolvePricing } = await import('./model-pricing.js');
      expect(() => resolvePricing(undefined)).not.toThrow();
      expect(() => resolvePricing(null)).not.toThrow();
    });
  });

  describe('estimateCostUsd', () => {
    it('computes cost from input/output tokens', async () => {
      const { estimateCostUsd } = await import('./model-pricing.js');
      const cost = estimateCostUsd({
        model: 'claude-sonnet-5',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      });
      expect(cost).toBeCloseTo(3 + 15, 5);
    });

    it('includes cache read/write costs', async () => {
      const { estimateCostUsd } = await import('./model-pricing.js');
      const cost = estimateCostUsd({
        model: 'claude-sonnet-5',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      });
      expect(cost).toBeCloseTo(0.3 + 3.75, 5);
    });

    it('returns 0 for zero usage', async () => {
      const { estimateCostUsd } = await import('./model-pricing.js');
      const cost = estimateCostUsd({
        model: 'claude-opus-4',
        inputTokens: 0,
        outputTokens: 0,
      });
      expect(cost).toBe(0);
    });
  });

  describe('MODEL_PRICING_JSON override', () => {
    beforeEach(() => {
      vi.resetModules();
    });

    it('overrides pricing for a matched key via env var', async () => {
      process.env.MODEL_PRICING_JSON = JSON.stringify({
        opus: { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 },
      });
      // Fresh module instance so the module-level override load re-reads env.
      const { resolvePricing } = await import('./model-pricing.js');
      const pricing = resolvePricing('claude-opus-4-6');
      expect(pricing).toEqual({
        input: 1,
        output: 2,
        cacheWrite: 3,
        cacheRead: 4,
      });
    });

    it('ignores invalid JSON and falls back to built-in pricing', async () => {
      process.env.MODEL_PRICING_JSON = '{not valid json';
      const { resolvePricing } = await import('./model-pricing.js');
      const pricing = resolvePricing('claude-opus-4-6');
      expect(pricing.input).toBe(15);
    });
  });
});
