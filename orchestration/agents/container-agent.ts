/**
 * ContainerAgent — bridges a Smithers <Task agent={...}> to this repo's
 * runContainerAgent(). This is the linchpin of the whole integration.
 *
 * WHY IT EXISTS: Smithers' built-in agents (AnthropicAgent, ClaudeCodeAgent, …)
 * call a model API / CLI *directly*. If a workflow used those, every step would
 * bypass everything that makes labor.fun valuable per group — the Docker
 * sandbox, volume mounts, per-group memory, the credential proxy, and RBAC.
 * Instead each durable step is executed by a ContainerAgent that delegates to
 * runContainerAgent() (over the localhost bridge), so the step runs in the
 * group's container exactly like a normal message would. Smithers contributes
 * only the durable step graph, checkpointing, and model routing *above* it.
 *
 *   Smithers <Task> ──generate({prompt})──▶ ContainerAgent ──runStep/HTTP──▶
 *      bridge → runContainerAgent → Docker(group) → Claude Agent SDK → model
 *
 * ── PROTOCOL (pinned to smithers-orchestrator@0.25.x) ───────────────────────
 * A Smithers agent is the *structural* `AgentLike` type (agents/AgentLike.ts):
 * an object with a `generate(args)` method — NOT a class to extend. There is no
 * `BaseAgent` export (that was the documented-but-wrong name in the scaffold).
 *
 * The engine calls `generate({ prompt | messages, outputSchema, abortSignal,
 * onStdout, … })`. Two facts shape this bridge:
 *   1. The engine PREPENDS the output-schema guidance to `prompt` itself
 *      (engine.js: describeSchemaShape → effectivePrompt). So we just forward
 *      the prompt; the container is already told to emit JSON for the schema.
 *   2. The engine reads `result.text`, JSON-parses it, and validates it against
 *      the task's Zod schema. A parse/validation failure makes the engine
 *      advance the `agent={[cheap, strong]}` fallback chain — that IS the
 *      escalation mechanism. We only throw on a hard container error.
 * Return shape mirrors the `ai` SDK's GenerateTextResult: `text` is required;
 * `response.modelId` / `usage` are optional (used for metrics).
 * ────────────────────────────────────────────────────────────────────────────
 */

import type { ModelSpec } from '../model-router.js';

/**
 * Port for the host-side container runner. We inject it rather than importing
 * src/container-runner directly so this package stays decoupled from the
 * framework's build layout (same principle as the out-of-tree plugin API).
 * Wired (over HTTP to the orchestrator's Smithers bridge) in runtime.ts.
 */
export interface RunStep {
  (args: {
    /** Group folder whose sandbox/memory the step runs in. */
    group: string;
    chatJid: string;
    /** Fully-rendered prompt for this step (schema guidance already prepended). */
    prompt: string;
    /** Per-run model id — comes from the step's ModelSpec. */
    modelOverride: string;
    /** Restrict tools for sandboxed steps (read-only extraction, etc.). */
    allowedTools?: string[];
  }): Promise<{ status: 'success' | 'error'; result: string | null }>;
}

export interface ContainerAgentOpts {
  spec: ModelSpec;
  group: string;
  chatJid: string;
  runStep: RunStep;
  allowedTools?: string[];
}

/** Args the engine hands `generate` — only the fields this bridge consumes. */
interface GenerateArgs {
  prompt?: string;
  messages?: Array<{ role: string; content: string }>;
}

/**
 * A structural Smithers `AgentLike`: it just needs `generate()`. We expose `id`
 * for inspect/metrics output. Leaving `supportsNativeStructuredOutput` unset
 * keeps the engine's text→JSON parsing path (correct for a text-returning
 * container agent).
 */
export class ContainerAgent {
  readonly id: string;
  private readonly spec: ModelSpec;
  private readonly group: string;
  private readonly chatJid: string;
  private readonly runStep: RunStep;
  private readonly allowedTools?: string[];

  constructor(opts: ContainerAgentOpts) {
    this.id = `container:${opts.group}:${opts.spec.label}`;
    this.spec = opts.spec;
    this.group = opts.group;
    this.chatJid = opts.chatJid;
    this.runStep = opts.runStep;
    this.allowedTools = opts.allowedTools;
  }

  /**
   * Run the step inside the group's container at this agent's tier model and
   * hand the raw text back for the engine to JSON-parse + Zod-validate. A hard
   * container error THROWS so Smithers' fallback chain advances to the next,
   * stronger agent (a *schema* failure is detected by the engine and escalates
   * the same way — we don't need to handle that here).
   */
  async generate(
    args?: GenerateArgs,
  ): Promise<{ text: string; response: { modelId: string } }> {
    const prompt =
      args?.prompt ??
      (Array.isArray(args?.messages)
        ? args!.messages.map((m) => m.content).join('\n\n')
        : '');

    const out = await this.runStep({
      group: this.group,
      chatJid: this.chatJid,
      prompt,
      modelOverride: this.spec.model,
      allowedTools: this.allowedTools,
    });

    if (out.status !== 'success' || out.result == null) {
      throw new Error(
        `ContainerAgent step failed at tier=${this.spec.label} model=${this.spec.model}`,
      );
    }
    return { text: out.result, response: { modelId: this.spec.model } };
  }
}
