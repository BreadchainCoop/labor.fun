/**
 * Tests for the orchestrator model-router registry (src/model-router.ts).
 *
 * The critical invariant: the `default` tier is anchored to the global
 * NANOCLAW_MODEL — set OR unset — so routing a default-tier kind through
 * modelForKind() resolves to exactly what the dispatch sites got before the
 * router existed. (The end-to-end byte-identical proof against the real
 * container runner lives in model-router-wiring.test.ts.)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mutable config state so individual tests can vary the mocked config.
// (vi.mock factories are hoisted, hence vi.hoisted for the shared object.)
const mockConfig = vi.hoisted(() => ({
  NANOCLAW_MODEL: undefined as string | undefined,
  LABOR_TIER_CHEAP_MODEL: undefined as string | undefined,
  LABOR_TIER_STRONG_MODEL: undefined as string | undefined,
}));

// Live getters — model-router's TIERS reads these at access time, so tests
// can vary them without re-importing the module.
vi.mock('./config.js', () => ({
  get NANOCLAW_MODEL() {
    return mockConfig.NANOCLAW_MODEL;
  },
  get LABOR_TIER_CHEAP_MODEL() {
    return mockConfig.LABOR_TIER_CHEAP_MODEL;
  },
  get LABOR_TIER_STRONG_MODEL() {
    return mockConfig.LABOR_TIER_STRONG_MODEL;
  },
}));

import {
  TIERS,
  chainFor,
  modelsFor,
  modelForKind,
  type TaskKind,
} from './model-router.js';

beforeEach(() => {
  mockConfig.NANOCLAW_MODEL = undefined;
  mockConfig.LABOR_TIER_CHEAP_MODEL = undefined;
  mockConfig.LABOR_TIER_STRONG_MODEL = undefined;
});

describe('default tier anchors to the global NANOCLAW_MODEL', () => {
  it.each(['message', 'scheduled_task'] as TaskKind[])(
    '%s resolves to the global model when it is set',
    (kind) => {
      mockConfig.NANOCLAW_MODEL = 'claude-global-model';
      expect(modelForKind(kind)).toBe('claude-global-model');
    },
  );

  it.each(['message', 'scheduled_task'] as TaskKind[])(
    '%s resolves to undefined (no per-run override) when the global is unset',
    (kind) => {
      expect(modelForKind(kind)).toBeUndefined();
    },
  );

  it('follows a change to the global (not a load-time snapshot)', () => {
    mockConfig.NANOCLAW_MODEL = 'model-a';
    expect(TIERS.default.model).toBe('model-a');
    mockConfig.NANOCLAW_MODEL = 'model-b';
    expect(TIERS.default.model).toBe('model-b');
  });
});

describe('cheap / strong tiers — concrete, env-overridable models', () => {
  it.each(['passive_monitor', 'classifier'] as TaskKind[])(
    '%s maps to the cheap tier default model',
    (kind) => {
      expect(modelForKind(kind)).toBe('claude-haiku-4-5');
    },
  );

  it('LABOR_TIER_CHEAP_MODEL overrides the cheap default', () => {
    mockConfig.LABOR_TIER_CHEAP_MODEL = 'local-llama-3.3-70b';
    expect(modelForKind('classifier')).toBe('local-llama-3.3-70b');
  });

  it('strong defaults to claude-opus-4-8', () => {
    expect(TIERS.strong.model).toBe('claude-opus-4-8');
  });

  it('LABOR_TIER_STRONG_MODEL overrides the strong default', () => {
    mockConfig.LABOR_TIER_STRONG_MODEL = 'claude-opus-next';
    expect(TIERS.strong.model).toBe('claude-opus-next');
  });

  it('cheap and strong tiers never depend on the global NANOCLAW_MODEL', () => {
    mockConfig.NANOCLAW_MODEL = 'claude-global-model';
    expect(modelForKind('classifier')).toBe('claude-haiku-4-5');
    expect(TIERS.strong.model).toBe('claude-opus-4-8');
  });
});

describe('escalation chains', () => {
  it('default-tier kinds escalate default → strong', () => {
    expect(chainFor('message').map((s) => s.label)).toEqual([
      'default',
      'strong',
    ]);
    expect(chainFor('scheduled_task').map((s) => s.label)).toEqual([
      'default',
      'strong',
    ]);
  });

  it('cheap-tier kinds jump straight to strong (never default)', () => {
    expect(chainFor('passive_monitor').map((s) => s.label)).toEqual([
      'cheap',
      'strong',
    ]);
    expect(chainFor('classifier').map((s) => s.label)).toEqual([
      'cheap',
      'strong',
    ]);
  });

  it('modelsFor returns the model ids along the chain', () => {
    mockConfig.NANOCLAW_MODEL = 'claude-global-model';
    expect(modelsFor('classifier')).toEqual([
      'claude-haiku-4-5',
      'claude-opus-4-8',
    ]);
    expect(modelsFor('message')).toEqual([
      'claude-global-model',
      'claude-opus-4-8',
    ]);
  });

  it('every chain terminates at strong (the ladder has a top)', () => {
    const kinds: TaskKind[] = [
      'message',
      'scheduled_task',
      'passive_monitor',
      'classifier',
    ];
    for (const kind of kinds) {
      const labels = chainFor(kind).map((s) => s.label);
      expect(labels[labels.length - 1]).toBe('strong');
      expect(labels.filter((l) => l === 'strong')).toHaveLength(1);
    }
  });
});
