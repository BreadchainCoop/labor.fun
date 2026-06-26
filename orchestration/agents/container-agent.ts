/**
 * ContainerAgent — bridges a Smithers <Task agent={...}> to this repo's
 * runContainerAgent(). This is the linchpin of the whole integration.
 *
 * WHY IT EXISTS: Smithers' built-in agents (AnthropicAgent, OpenAIAgent) call
 * the model API *directly*. If a workflow used those, every step would bypass
 * everything that makes labor.fun valuable per group — the Docker sandbox,
 * volume mounts, per-group memory, the credential proxy, and RBAC. Instead,
 * each durable step is executed by a ContainerAgent that delegates to
 * runContainerAgent(), so the step runs in the group's container exactly like a
 * normal message would. Smithers contributes only the durable step graph,
 * checkpointing, and model routing *above* the container.
 *
 *   Smithers <Task>  ──run(messages)──▶  ContainerAgent  ──runContainerAgent──▶
 *      Docker(group) → Claude Agent SDK → credential proxy → model
 *
 * The model for the step is chosen by model-router.ts and passed straight
 * through as ContainerInput.modelOverride (the additive field added to
 * container-runner.ts), so per-step routing — and later local inference — is
 * just "which ModelSpec did the router hand us".
 *
 * ── VERIFY-ON-INSTALL ──────────────────────────────────────────────────────
 * The exact BaseAgent surface (constructor, the run() signature, how a
 * non-string/failed result signals "fall through to the next agent in the
 * chain") must be confirmed against the installed `smithers-orchestrator`
 * package once `bunx smithers-orchestrator init` has run. The shape below
 * matches the documented `SupportsAgentRun` protocol (a `run(messages, opts)`
 * method); adjust field/return names to the real types when wiring for real.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { BaseAgent } from 'smithers-orchestrator';

import type { ModelSpec } from '../model-router.js';

/**
 * Port for the host-side container runner. We inject it rather than importing
 * src/container-runner directly so this package stays decoupled from the
 * framework's build layout (same principle as the out-of-tree plugin API).
 * Wire it to a `runContainerAgent`-bound closure in the workflow entrypoint.
 */
export interface RunStep {
  (args: {
    /** Group folder whose sandbox/memory the step runs in. */
    group: string;
    chatJid: string;
    /** Fully-rendered prompt for this step. */
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

export class ContainerAgent extends BaseAgent {
  private readonly spec: ModelSpec;
  private readonly group: string;
  private readonly chatJid: string;
  private readonly runStep: RunStep;
  private readonly allowedTools?: string[];

  constructor(opts: ContainerAgentOpts) {
    // BaseAgent wants a stable name/label for inspect/logs output.
    super({ name: `container:${opts.group}:${opts.spec.label}` });
    this.spec = opts.spec;
    this.group = opts.group;
    this.chatJid = opts.chatJid;
    this.runStep = opts.runStep;
    this.allowedTools = opts.allowedTools;
  }

  /**
   * Smithers calls this with the rendered conversation for the step. We flatten
   * it to a single prompt, run it inside the group's container at this agent's
   * tier model, and hand the text back for Zod validation. A non-success result
   * THROWS so Smithers' fallback chain (`agent={[cheap, strong]}`) advances to
   * the next, stronger agent — that is the escalation mechanism.
   */
  async run(messages: Array<{ role: string; content: string }>): Promise<string> {
    const prompt = messages.map((m) => m.content).join('\n\n');

    const out = await this.runStep({
      group: this.group,
      chatJid: this.chatJid,
      prompt,
      modelOverride: this.spec.model,
      allowedTools: this.allowedTools,
    });

    if (out.status !== 'success' || out.result == null) {
      // Throwing is how we trigger escalation to the next agent in the chain.
      throw new Error(
        `ContainerAgent step failed at tier=${this.spec.label} model=${this.spec.model}`,
      );
    }
    return out.result;
  }
}
