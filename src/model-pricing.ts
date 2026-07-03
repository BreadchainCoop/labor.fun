/**
 * Cost estimation for Anthropic API usage.
 *
 * A small per-model pricing table (USD per million tokens) used to turn raw
 * token counts captured by the credential proxy (src/credential-proxy.ts)
 * into an estimated dollar cost, persisted alongside each api_usage row
 * (src/db.ts) and enforced against by the usage-budget module
 * (src/usage-budget.ts).
 *
 * Pricing is necessarily a snapshot of Anthropic's published rates at the
 * time this was written and will drift as prices change or new models ship.
 * Operators can override/extend the table without a code change via the
 * MODEL_PRICING_JSON env var (see loadPricingOverrides below).
 */
import { logger } from './logger.js';

export interface ModelPricing {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** USD per million tokens written to the prompt cache. */
  cacheWrite: number;
  /** USD per million tokens read from the prompt cache. */
  cacheRead: number;
}

export interface UsageForCost {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// Published per-MTok USD pricing for current Claude model families. Matched
// against the model id via substring (see resolvePricing) so dated snapshots
// (e.g. "claude-opus-4-6-20260115") resolve without listing every date.
const BASE_PRICING: Record<string, ModelPricing> = {
  // Frontier tier ($10/$50 per MTok) — without these entries a fable/mythos
  // model id would fall through to the sonnet-priced default and
  // under-estimate by >3x.
  fable: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  mythos: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  opus: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
};

// Conservative default for unrecognized model ids — priced at Sonnet rates
// (a reasonable mid-point) so an unknown/future model still gets a non-zero
// cost estimate rather than silently reporting $0.
const DEFAULT_PRICING: ModelPricing = BASE_PRICING.sonnet;

/**
 * Optional operator override, e.g.:
 *   MODEL_PRICING_JSON='{"opus":{"input":15,"output":75,"cacheWrite":18.75,"cacheRead":1.5}}'
 * Keys are matched the same way as BASE_PRICING (substring match against the
 * model id), and override/extend the built-in table. Invalid JSON is logged
 * and ignored (falls back to the built-in table).
 */
function loadPricingOverrides(): Record<string, ModelPricing> {
  const raw = process.env.MODEL_PRICING_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<ModelPricing>>;
    const result: Record<string, ModelPricing> = {};
    for (const [key, val] of Object.entries(parsed)) {
      result[key.toLowerCase()] = {
        input: val.input ?? DEFAULT_PRICING.input,
        output: val.output ?? DEFAULT_PRICING.output,
        cacheWrite: val.cacheWrite ?? DEFAULT_PRICING.cacheWrite,
        cacheRead: val.cacheRead ?? DEFAULT_PRICING.cacheRead,
      };
    }
    return result;
  } catch (err) {
    logger.warn(
      { err },
      'Failed to parse MODEL_PRICING_JSON — ignoring overrides',
    );
    return {};
  }
}

const PRICING_OVERRIDES = loadPricingOverrides();

/** Resolve the pricing row for a model id (substring match, override-first). */
export function resolvePricing(model: string | null | undefined): ModelPricing {
  const m = (model || '').toLowerCase();
  const tables = [PRICING_OVERRIDES, BASE_PRICING];
  for (const table of tables) {
    for (const [key, pricing] of Object.entries(table)) {
      if (m.includes(key)) return pricing;
    }
  }
  return DEFAULT_PRICING;
}

/** Estimate USD cost for a usage event given its token breakdown. */
export function estimateCostUsd(usage: UsageForCost): number {
  const pricing = resolvePricing(usage.model);
  const MTOK = 1_000_000;
  const cost =
    (usage.inputTokens / MTOK) * pricing.input +
    (usage.outputTokens / MTOK) * pricing.output +
    ((usage.cacheReadTokens || 0) / MTOK) * pricing.cacheRead +
    ((usage.cacheWriteTokens || 0) / MTOK) * pricing.cacheWrite;
  return cost;
}
