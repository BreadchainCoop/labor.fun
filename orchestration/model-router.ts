/**
 * model-router — the "which model, and when to escalate" brain.
 *
 * This is the SINGLE place that decides which model a durable-workflow step
 * runs on. Smithers workflows never name a model directly; they ask the router
 * for a tier and get back a fallback chain of agents. That indirection is what
 * makes local inference a one-line change instead of a workflow rewrite.
 *
 * ┌─ TIERS ──────────────────────────────────────────────────────────────┐
 * │  cheap   → bulk / mechanical steps (parse, dedupe, format)            │
 * │  default → ordinary reasoning (most extraction)                       │
 * │  strong  → hard reasoning / final-quality steps, and the escalation   │
 * │            target for any cheaper tier that fails validation          │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * LOCAL-INFERENCE SEAM:  to route the `cheap` tier at a local model, change
 * exactly one TIERS entry below (model + baseUrl). Nothing in any workflow
 * changes. See docs/SMITHERS-ORCHESTRATION.md § "Plugging in local inference".
 */

export type Tier = 'cheap' | 'default' | 'strong';

export interface ModelSpec {
  /** Model id passed to the container as NANOCLAW_MODEL (per-run override). */
  model: string;
  /**
   * Optional inference endpoint for this tier. `undefined` = the default
   * Anthropic credential proxy (current behavior). A non-default value (e.g. a
   * local llama.cpp/vLLM server speaking the Anthropic /v1/messages shape) is
   * the local-inference hook. NOTE: per-tier baseUrl routing is the *next*
   * enabling change in the container-runner — see the design doc. Today only
   * `model` is wired end-to-end via ContainerInput.modelOverride.
   */
  baseUrl?: string;
  /** Human label for logs/inspect output. */
  label: string;
}

/**
 * The tier → model registry. Edit THIS to change cost/quality globally or to
 * introduce local inference. Defaults reflect the models this org runs today.
 */
export const TIERS: Record<Tier, ModelSpec> = {
  cheap: {
    // FUTURE (local inference): swap to e.g.
    //   model: process.env.LOCAL_MODEL ?? 'llama-3.3-70b',
    //   baseUrl: process.env.LOCAL_INFERENCE_URL, // http://host.docker.internal:11434
    model: process.env.LABOR_TIER_CHEAP_MODEL ?? 'claude-haiku-4-5',
    label: 'cheap',
  },
  default: {
    model: process.env.LABOR_TIER_DEFAULT_MODEL ?? 'claude-sonnet-4-6',
    label: 'default',
  },
  strong: {
    model: process.env.LABOR_TIER_STRONG_MODEL ?? 'claude-opus-4-8',
    label: 'strong',
  },
};

/**
 * Workflow step kinds. Each maps to a base tier; the router appends the
 * escalation target automatically so callers never hand-build chains.
 */
export type TaskKind =
  | 'parse' // mechanical: split transcript into speakers/topics
  | 'extract' // reasoning: pull action items / events / people
  | 'reconcile' // reasoning + KB lookups: match against existing people/tasks
  | 'render' // mechanical: produce the HTML slideshow
  | 'availability' // mechanical: fetch one participant's calendar free/busy
  | 'schedule'; // reasoning: match timezones + rank candidate meeting slots

const TASK_TIER: Record<TaskKind, Tier> = {
  parse: 'cheap',
  extract: 'default',
  reconcile: 'strong',
  render: 'cheap',
  availability: 'cheap', // a free/busy read is mechanical — ideal local-model work
  schedule: 'default', // timezone math + slot ranking wants real reasoning
};

/**
 * Escalation ladder. A task that fails its Zod output schema (or whose scorer
 * confidence is too low) falls through to the next tier. Smithers expresses
 * this as `agent={[primary, fallback]}` — the chain below is materialized into
 * that array by the workflow via `chainFor()`.
 */
const NEXT_TIER: Record<Tier, Tier | null> = {
  cheap: 'strong', // a cheap/local miss jumps straight to strong, not default
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
export function modelsFor(kind: TaskKind): string[] {
  return chainFor(kind).map((s) => s.model);
}
