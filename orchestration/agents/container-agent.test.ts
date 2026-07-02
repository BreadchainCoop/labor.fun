/**
 * Deterministic schema-fail escalation (#123).
 *
 * The Smithers engine JSON-parses each agent's `result.text` and validates it
 * against the step's Zod schema; a parse/validation failure advances the
 * `agent={[cheap, strong]}` fallback chain. These tests pin the local half of
 * that contract:
 *   - LABOR_FORCE_CHEAP_SCHEMA_FAIL makes the cheap tier return text that can
 *     NEVER satisfy a schema (it isn't JSON), without running a container.
 *   - The flag is inert when unset, and never touches non-cheap tiers.
 *   - chainFor('parse') really is [cheap, strong], so the forced failure has a
 *     strong tier to land on.
 * The engine-side advance itself runs in the remote Smithers sidecar — see
 * docs/SMITHERS-ORCHESTRATION.md § "Deterministic escalation test".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { chainFor, TIERS } from '../model-router';
import {
  ContainerAgent,
  FORCED_SCHEMA_FAIL_TEXT,
  type RunStep,
} from './container-agent';

const ENV_FLAG = 'LABOR_FORCE_CHEAP_SCHEMA_FAIL';

function makeAgent(label: 'cheap' | 'strong', runStep: RunStep) {
  return new ContainerAgent({
    spec: { model: `model-${label}`, label },
    group: 'test-group',
    chatJid: 'jid@test',
    runStep,
  });
}

function okRunStep(text = '{"ok":true}'): RunStep {
  return vi.fn(async () => ({ status: 'success' as const, result: text }));
}

afterEach(() => {
  delete process.env[ENV_FLAG];
  vi.restoreAllMocks();
});

describe('chainFor (escalation ladder)', () => {
  it('parse (cheap) escalates straight to strong', () => {
    expect(chainFor('parse')).toEqual([TIERS.cheap, TIERS.strong]);
  });

  it('strong has nothing to escalate to', () => {
    expect(chainFor('reconcile')).toEqual([TIERS.strong]);
  });
});

describe('LABOR_FORCE_CHEAP_SCHEMA_FAIL', () => {
  it('flag unset: cheap tier runs the container normally', async () => {
    const runStep = okRunStep();
    const out = await makeAgent('cheap', runStep).generate({ prompt: 'p' });
    expect(runStep).toHaveBeenCalledOnce();
    expect(out.text).toBe('{"ok":true}');
  });

  it('flag set: cheap tier returns schema-invalid text WITHOUT running a container', async () => {
    process.env[ENV_FLAG] = '1';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const runStep = okRunStep();
    const out = await makeAgent('cheap', runStep).generate({ prompt: 'p' });
    expect(runStep).not.toHaveBeenCalled();
    expect(out.text).toBe(FORCED_SCHEMA_FAIL_TEXT);
    // The output must fail ANY Zod schema: the engine JSON-parses text first,
    // and this text is guaranteed unparseable.
    expect(() => JSON.parse(out.text)).toThrow();
  });

  it('flag set: the strong (escalation target) tier is unaffected', async () => {
    process.env[ENV_FLAG] = '1';
    const runStep = okRunStep('{"speakers":["a"]}');
    const out = await makeAgent('strong', runStep).generate({ prompt: 'p' });
    expect(runStep).toHaveBeenCalledOnce();
    expect(out.text).toBe('{"speakers":["a"]}');
  });

  it('fallback chain semantics: cheap fails validation, strong succeeds', async () => {
    process.env[ENV_FLAG] = '1';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const strongText = '{"speakers":["a"],"date":null,"topics":["t"]}';
    const agents = [
      makeAgent('cheap', okRunStep()),
      makeAgent('strong', okRunStep(strongText)),
    ];

    // Minimal stand-in for the engine's advance-on-validation-failure loop
    // (smithers-orchestrator@0.25 engine.js): parse text, advance on failure.
    let winner: string | undefined;
    let parsed: unknown;
    for (const agent of agents) {
      const { text } = await agent.generate({ prompt: 'p' });
      try {
        parsed = JSON.parse(text);
        winner = agent.id;
        break;
      } catch {
        continue; // schema/parse failure → next (stronger) agent
      }
    }

    expect(winner).toBe('container:test-group:strong');
    expect(parsed).toEqual({ speakers: ['a'], date: null, topics: ['t'] });
  });
});
