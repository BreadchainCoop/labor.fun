/**
 * tiered-agent — run a structured-output agent job on the model-router's
 * escalation ladder: try the kind's base tier, validate the output, and
 * escalate to the next (stronger) tier when validation fails.
 *
 * STATUS: tested library infrastructure staged ahead of its first consumers
 * (the passive monitor and spend-gated classify passes — the cheap-tier
 * TaskKinds already reserved in model-router.ts). Not wired to any live job
 * yet; that is intentional, mirroring how the ContainerInput override seam
 * landed before this router did. NOTHING imports this module from the
 * runtime path — an unconfigured deploy is byte-for-byte unaffected.
 *
 * Flow per tier (chain from chainFor() in model-router.ts):
 *
 *   runContainerAgent(modelOverride = tier model) → JSON.parse(result text)
 *     → schema.safeParse → success? return { result, tierUsed, model }
 *                        : log + advance to the next tier
 *
 * A HARD container error (status 'error' or a thrown error) fails the whole
 * call immediately — escalating to a stronger model cannot fix broken
 * infrastructure and would silently burn cost hiding it. A success with a
 * null result (an agent that completed silently) is treated as a validation
 * failure and escalates: "produced no usable output" is exactly the failure
 * mode the ladder exists for.
 *
 * ── CONSUMER REQUIREMENT (container lifecycle) ─────────────────────────────
 * runContainerAgent alone does NOT close the container when the run is done:
 * in production the close is driven by GroupQueue (closeStdin → the _close
 * sentinel) via the orchestrator's idle/close timers. A consumer that calls
 * runTieredAgent with the default runner and a no-op onProcess would leave
 * each attempt running until the container hard timeout (~30 min) and get a
 * timeout error instead of its result. The first consumer MUST wire the same
 * close plumbing the dispatch sites use — register the process via onProcess
 * with its GroupQueue and schedule a prompt close after the result (see the
 * scheduled-task dispatch in task-scheduler.ts for the pattern) — or inject
 * a runAgent that handles the lifecycle itself.
 */
import type { ChildProcess } from 'child_process';

import {
  runContainerAgent,
  type ContainerInput,
  type ContainerOutput,
} from './container-runner.js';
import { logger } from './logger.js';
import { chainFor, type TaskKind } from './model-router.js';
import type { RegisteredGroup } from './types.js';

/**
 * Deterministic escalation test: with LABOR_FORCE_CHEAP_SCHEMA_FAIL=1 (or
 * =true) set, the cheap tier returns this deliberately unparseable text
 * INSTEAD of running a container (no container run, no model cost), so the
 * JSON.parse step fails — whatever the schema — and the chain provably
 * advances to the next tier. Inert in production: flag unset ⇒ zero
 * behavior change.
 *
 * Not valid JSON on purpose — do not wrap in braces/quotes.
 */
export const FORCED_SCHEMA_FAIL_TEXT =
  'FORCED SCHEMA FAILURE (LABOR_FORCE_CHEAP_SCHEMA_FAIL=1): deliberately ' +
  'schema-invalid output from the cheap tier to exercise cheap->strong ' +
  'escalation. This text is intentionally not JSON.';

/**
 * Read at call time (not module load) so tests can stub it per-case. NOTE:
 * deliberately a bare process.env read — this is a diagnostic flag set on the
 * process environment, not an operator tunable in the .env allowlist
 * (config.ts). "Fails" the cheap tier at the JSON.parse step by skipping the
 * container run entirely (no model cost), which fails any schema by
 * definition.
 */
function forceCheapSchemaFail(): boolean {
  const v = process.env.LABOR_FORCE_CHEAP_SCHEMA_FAIL;
  return v === '1' || v === 'true';
}

/**
 * Minimal zod-compatible validator shape. This repo deliberately does not
 * depend on zod in src/ (no heavy new dependency for a helper whose first
 * consumer hasn't landed), so the helper accepts anything with zod's
 * safeParse contract — a real zod schema satisfies this interface as-is
 * if/when zod is adopted; until then a hand-rolled validator works the same.
 */
export interface SchemaLike<T> {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error?: unknown };
}

export interface TieredAgentArgs<T> {
  /** Group whose container/sandbox/memory the runs execute in. */
  group: RegisteredGroup;
  /**
   * Container input reused for every attempt; the router sets modelOverride
   * per tier. The prompt should instruct the agent to emit raw JSON matching
   * `schema` — the helper does a plain JSON.parse of the result text (no
   * code-fence stripping).
   */
  input: Omit<ContainerInput, 'modelOverride'>;
  /** Validator for the expected structured (JSON) output. */
  schema: SchemaLike<T>;
  /**
   * Process-registration hook. Defaults to a no-op, but see CONSUMER
   * REQUIREMENT in the file header: with the default no-op the container is
   * never closed and the run rides to the ~30-min hard timeout. A real
   * consumer must register the process here and schedule a prompt close
   * (the task-scheduler pattern), or inject a lifecycle-owning `runAgent`.
   */
  onProcess?: (proc: ChildProcess, containerName: string) => void;
}

export interface TieredAgentResult<T> {
  /** The parsed, schema-validated output. */
  result: T;
  /** Label of the tier that produced the accepted output. */
  tierUsed: string;
  /** Model id of that tier (`undefined` = the container's default model). */
  model: string | undefined;
}

/** Injectable runner — tests pass a mock; production uses runContainerAgent. */
export type RunAgent = (
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
) => Promise<ContainerOutput>;

/**
 * Run `kind` on its tier chain until a tier returns output that JSON-parses
 * and passes `schema`. Escalates on validation failure; throws on a hard
 * container error or when the chain is exhausted.
 *
 * CONSUMER REQUIREMENT (see the file-header block): the default runner does
 * NOT close the container. A consumer must own the container lifecycle via
 * `args.onProcess` + a prompt close, or an injected lifecycle-owning
 * `deps.runAgent`, otherwise every run rides to the ~30-min hard timeout.
 */
export async function runTieredAgent<T>(
  kind: TaskKind,
  args: TieredAgentArgs<T>,
  deps: { runAgent?: RunAgent } = {},
): Promise<TieredAgentResult<T>> {
  const runAgent = deps.runAgent ?? runContainerAgent;
  const onProcess = args.onProcess ?? (() => {});
  const chain = chainFor(kind);
  const failures: string[] = [];

  for (const spec of chain) {
    let text: string;

    if (spec.label === 'cheap' && forceCheapSchemaFail()) {
      // Deterministic escalation test — short-circuit the cheap tier with
      // unparseable output (no container run) so validation below fails and
      // the chain advances to the next tier.
      logger.warn(
        { kind, tier: spec.label, model: spec.model },
        'tiered-agent: LABOR_FORCE_CHEAP_SCHEMA_FAIL is set — returning schema-invalid output to exercise escalation',
      );
      text = FORCED_SCHEMA_FAIL_TEXT;
    } else {
      const out = await runAgent(
        args.group,
        { ...args.input, modelOverride: spec.model },
        onProcess,
      );
      if (out.status !== 'success') {
        // Hard container/infra error: fail the whole call immediately.
        throw new Error(
          `tiered-agent(${kind}): container run failed at tier=${spec.label} ` +
            `model=${spec.model ?? '(container default)'}: ${out.error ?? 'unknown error'}`,
        );
      }
      if (out.result == null) {
        // Silent completion (a routine agent-runner outcome) — the tier
        // produced no usable output, which is a validation failure, not an
        // infra error: escalate.
        failures.push(`tier=${spec.label}: agent returned no output`);
        logger.warn(
          { kind, tier: spec.label, model: spec.model },
          'tiered-agent: agent returned no output — escalating to next tier',
        );
        continue;
      }
      text = out.result;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text.trim());
    } catch (err) {
      // Invalid JSON from the model is the expected failure mode here;
      // anything else is a real bug and must surface.
      if (!(err instanceof SyntaxError)) throw err;
      failures.push(`tier=${spec.label}: output is not valid JSON`);
      logger.warn(
        { kind, tier: spec.label, model: spec.model },
        'tiered-agent: JSON parse failed — escalating to next tier',
      );
      continue;
    }

    const validated = args.schema.safeParse(parsed);
    if (validated.success) {
      return {
        result: validated.data,
        tierUsed: spec.label,
        model: spec.model,
      };
    }
    const detail =
      validated.error === undefined
        ? ''
        : ` (${String(validated.error).slice(0, 200)})`;
    failures.push(
      `tier=${spec.label}: output failed schema validation${detail}`,
    );
    logger.warn(
      {
        kind,
        tier: spec.label,
        model: spec.model,
        validationError: detail || undefined,
      },
      'tiered-agent: schema validation failed — escalating to next tier',
    );
  }

  throw new Error(
    `tiered-agent(${kind}): all tiers exhausted without schema-valid output ` +
      `(${failures.join('; ')})`,
  );
}
