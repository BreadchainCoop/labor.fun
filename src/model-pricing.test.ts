import { describe, expect, it } from 'vitest';

import { estimateCostUsd, ratesForModel } from './model-pricing.js';

describe('ratesForModel', () => {
  it('matches by longest prefix (dated snapshots resolve to the base model)', () => {
    expect(ratesForModel('claude-opus-4-8-20260101').input).toBe(
      ratesForModel('claude-opus-4-8').input,
    );
  });

  it('falls back to Opus-tier default for an unknown model', () => {
    const unknown = ratesForModel('some-future-model');
    expect(unknown.input).toBe(5 / 1_000_000);
  });

  it('handles null/undefined model', () => {
    expect(ratesForModel(null).input).toBeGreaterThan(0);
    expect(ratesForModel(undefined).input).toBeGreaterThan(0);
  });
});

describe('estimateCostUsd', () => {
  it('applies per-dimension rates (Opus 4.8)', () => {
    // input $5/M, output $25/M, cacheRead 0.1x input, cacheWrite 1.25x input.
    const cost = estimateCostUsd({
      model: 'claude-opus-4-8',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    // 5 + 25 + 0.5 + 6.25 = 36.75
    expect(cost).toBeCloseTo(36.75, 6);
  });

  it('returns 0 for empty usage', () => {
    expect(estimateCostUsd({ model: 'claude-opus-4-8' })).toBe(0);
  });

  it('never returns negative', () => {
    expect(estimateCostUsd({ inputTokens: 0 })).toBe(0);
  });
});
