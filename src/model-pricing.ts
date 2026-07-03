/**
 * Rough per-model token pricing, used to estimate the USD cost of each observed
 * API call for usage metering and control-plane usage reporting. These are
 * best-effort estimates (public list prices per million tokens); they are NOT
 * billing-grade and drift as Anthropic updates pricing. The control plane is the
 * source of truth for actual billing — this only powers the local budget guard
 * and a per-row cost hint in reported usage.
 *
 * Cache reads bill at ~0.1x input; 5-minute cache writes at ~1.25x input.
 */

export interface ModelRates {
  /** USD per input token. */
  input: number;
  /** USD per output token. */
  output: number;
  /** USD per cache-read (cached input) token. */
  cacheRead: number;
  /** USD per cache-write (cache-creation) token. */
  cacheWrite: number;
}

const PER_MILLION = 1_000_000;

/** Build a rate table from per-million-token list prices. */
function rates(inputPerM: number, outputPerM: number): ModelRates {
  return {
    input: inputPerM / PER_MILLION,
    output: outputPerM / PER_MILLION,
    cacheRead: (inputPerM * 0.1) / PER_MILLION,
    cacheWrite: (inputPerM * 1.25) / PER_MILLION,
  };
}

// List prices as of the model catalog cached 2026-06. Keys match the leading
// segment of the model id; lookup is longest-prefix so dated snapshots resolve.
const RATES: Record<string, ModelRates> = {
  'claude-fable-5': rates(10, 50),
  'claude-mythos-5': rates(10, 50),
  'claude-opus-4-8': rates(5, 25),
  'claude-opus-4-7': rates(5, 25),
  'claude-opus-4-6': rates(5, 25),
  'claude-opus-4-5': rates(5, 25),
  'claude-opus-4-1': rates(15, 75),
  'claude-opus-4': rates(15, 75),
  'claude-opus': rates(5, 25),
  'claude-sonnet-5': rates(3, 15),
  'claude-sonnet-4-6': rates(3, 15),
  'claude-sonnet-4-5': rates(3, 15),
  'claude-sonnet-4': rates(3, 15),
  'claude-sonnet': rates(3, 15),
  'claude-haiku-4-5': rates(1, 5),
  'claude-haiku': rates(0.8, 4),
};

// A conservative default when the model is unknown (assume Opus-tier so budgets
// trip early rather than late).
const DEFAULT_RATES = rates(5, 25);

/** Resolve the rate table for a model id via longest-prefix match. */
export function ratesForModel(model: string | null | undefined): ModelRates {
  if (!model) return DEFAULT_RATES;
  const normalized = model.trim().toLowerCase();
  // Longest-prefix match so 'claude-opus-4-8-20260101' → 'claude-opus-4-8'.
  let best: ModelRates | undefined;
  let bestLen = -1;
  for (const [prefix, r] of Object.entries(RATES)) {
    if (normalized.startsWith(prefix) && prefix.length > bestLen) {
      best = r;
      bestLen = prefix.length;
    }
  }
  return best ?? DEFAULT_RATES;
}

/**
 * Estimate the USD cost of one request from its per-dimension token counts.
 * Any dimension may be 0/undefined. Returns a non-negative number.
 */
export function estimateCostUsd(usage: {
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): number {
  const r = ratesForModel(usage.model);
  const cost =
    (usage.inputTokens ?? 0) * r.input +
    (usage.outputTokens ?? 0) * r.output +
    (usage.cacheReadTokens ?? 0) * r.cacheRead +
    (usage.cacheWriteTokens ?? 0) * r.cacheWrite;
  return cost > 0 ? cost : 0;
}
