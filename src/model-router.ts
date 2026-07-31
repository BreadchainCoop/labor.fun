/**
 * model-router — the single place that decides which model an orchestrator
 * run gets. (Distinct from orchestration/model-router.ts, which routes
 * Smithers durable-workflow steps; this one routes the orchestrator's own
 * dispatch kinds and is anchored to the global NANOCLAW_MODEL.)
 *
 * Dispatch sites never name a model directly; they name a TaskKind and ask
 * the router. That indirection is what makes cost-tiering (and, later, local
 * inference) a one-line registry change instead of a call-site hunt.
 *
 * ┌─ TIERS ──────────────────────────────────────────────────────────────┐
 * │  cheap   → bulk / mechanical runs (classifier passes, monitors)       │
 * │  default → ordinary reasoning — the global NANOCLAW_MODEL             │
 * │  strong  → hard reasoning, and the escalation target for a cheaper    │
 * │            tier whose output fails validation (see tiered-agent.ts)   │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * BACKWARDS COMPAT: the `default` tier is anchored to the global
 * NANOCLAW_MODEL — including when it is unset (buildContainerArgs then omits
 * the env var, exactly the pre-router behavior). Wiring modelForKind() into
 * a default-tier dispatch site is therefore a no-op today; the byte-identical
 * proof lives in model-router-wiring.test.ts.
 *
 * LOCAL-INFERENCE SEAM: to route the `cheap` tier at a local model, change
 * exactly one TIERS entry below (model + baseUrl). NOTE: per-tier baseUrl
 * routing is a future container-runner change — today only `model` is wired
 * end-to-end, via ContainerInput.modelOverride.
 */

import {
  LABOR_TIER_CHEAP_MODEL,
  LABOR_TIER_STRONG_MODEL,
  NANOCLAW_MODEL,
} from './config.js';

export type Tier = 'cheap' | 'default' | 'strong';

export interface ModelSpec {
  /**
   * Model id passed to the container as NANOCLAW_MODEL via
   * ContainerInput.modelOverride. `undefined` (possible only for the
   * `default` tier, when the global NANOCLAW_MODEL is unset) means "no
   * per-run override" — the container keeps its own default model, exactly
   * the pre-router behavior.
   */
  model: string | undefined;
  /**
   * Optional inference endpoint for this tier. `undefined` = the default
   * Anthropic credential proxy (current behavior). A non-default value
   * (e.g. a local llama.cpp/vLLM server speaking the Anthropic /v1/messages
   * shape) is the local-inference hook. NOTE: per-tier baseUrl routing is a
   * future container-runner change — today only `model` is wired end-to-end
   * via ContainerInput.modelOverride.
   */
  baseUrl?: string;
  /** Human label for logs. */
  label: string;
}

/**
 * The tier → model registry. Edit THIS to change cost/quality globally or to
 * introduce local inference. `cheap`/`strong` are overridable via
 * LABOR_TIER_CHEAP_MODEL / LABOR_TIER_STRONG_MODEL (see config.ts); the
 * `default` tier always follows the global NANOCLAW_MODEL.
 *
 * The `model` fields are getters so they read the config live: config values
 * are constants at runtime (zero behavior difference), but tests can vary the
 * mocked config per-test without re-importing this module.
 */
export const TIERS: Record<Tier, ModelSpec> = {
  cheap: {
    // FUTURE (local inference): swap to e.g.
    //   model: LOCAL_MODEL ?? 'llama-3.3-70b',
    //   baseUrl: LOCAL_INFERENCE_URL, // http://host.docker.internal:11434
    get model() {
      return LABOR_TIER_CHEAP_MODEL ?? 'claude-haiku-4-5';
    },
    label: 'cheap',
  },
  default: {
    get model() {
      return NANOCLAW_MODEL;
    },
    label: 'default',
  },
  strong: {
    get model() {
      return LABOR_TIER_STRONG_MODEL ?? 'claude-opus-4-8';
    },
    label: 'strong',
  },
};

/**
 * Run kinds. Each maps to a base tier; the router appends the escalation
 * target automatically so callers never hand-build chains.
 */
export type TaskKind =
  | 'message' // inbound user/channel message (src/index.ts dispatch)
  | 'scheduled_task' // scheduled task — arbitrary user-authored prompts (src/task-scheduler.ts)
  | 'passive_monitor' // UNWIRED — reserved for the passive watched-chat monitor (later wave)
  | 'classifier'; // UNWIRED — reserved for cheap spend-gate classify passes (src/spend-gate.ts)

const TASK_TIER: Record<TaskKind, Tier> = {
  message: 'default',
  scheduled_task: 'default', // arbitrary prompts want real reasoning — stays on default
  passive_monitor: 'cheap', // mechanical watched-chat classification — ideal cheap/local work
  classifier: 'cheap', // spend-gate classify pass — cheap by design
};

/**
 * Escalation ladder. A run whose structured output fails validation falls
 * through to the next tier (materialized by chainFor(); walked by
 * runTieredAgent in tiered-agent.ts).
 */
const NEXT_TIER: Record<Tier, Tier | null> = {
  cheap: 'strong', // a cheap miss jumps straight to strong, not default
  default: 'strong',
  strong: null, // top of the ladder — nothing left to escalate to
};

/** The ordered tier chain for a task kind: base tier, then its escalations. */
export function chainFor(kind: TaskKind): ModelSpec[] {
  const chain: ModelSpec[] = [];
  let tier: Tier | null = TASK_TIER[kind];
  while (tier) {
    chain.push(TIERS[tier]);
    tier = NEXT_TIER[tier];
  }
  return chain;
}

/** Just the model ids for a task kind (handy for logs / dry-run inspection). */
export function modelsFor(kind: TaskKind): (string | undefined)[] {
  return chainFor(kind).map((s) => s.model);
}

/**
 * The base-tier model id for a kind — what a plain (non-escalating) dispatch
 * site passes as ContainerInput.modelOverride. For default-tier kinds this is
 * exactly the global NANOCLAW_MODEL (or undefined when that is unset), so
 * wiring it into an existing dispatch is behavior-preserving.
 */
export function modelForKind(kind: TaskKind): string | undefined {
  return TIERS[TASK_TIER[kind]].model;
}
