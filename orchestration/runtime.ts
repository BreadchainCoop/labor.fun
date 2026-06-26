/**
 * runtime — binds the abstract RunStep port to this repo's runContainerAgent().
 *
 * The Smithers sidecar runs as its own Bun process. It needs to invoke the
 * framework's container runner without coupling the workflow files to the
 * framework build layout, so the binding is centralized here and injected.
 *
 * Two ways to wire it (pick during the pilot — see the design doc):
 *
 *  (A) In-process: import the built runner from the compiled framework and call
 *      it directly. Requires the sidecar to run alongside the orchestrator with
 *      access to dist/ and the same DB/state.
 *
 *  (B) Over IPC/HTTP: post a "run step" request to the orchestrator (a thin
 *      endpoint that calls runContainerAgent and returns the result). Keeps the
 *      sidecar fully decoupled and is the safer production shape.
 *
 * The stub below throws until wired so a misconfigured run fails loudly rather
 * than silently skipping container isolation.
 */

import type { RunStep } from './agents/container-agent.js';

let bound: RunStep | null = null;

/** Wire the real runner once, at sidecar startup. */
export function setRunStep(fn: RunStep): void {
  bound = fn;
}

export function getRunStep(): RunStep {
  if (!bound) {
    throw new Error(
      'RunStep not bound — call setRunStep() with a runContainerAgent-backed ' +
        'adapter before running a workflow. See orchestration/runtime.ts (A) or (B).',
    );
  }
  return bound;
}

/**
 * Reference adapter for binding option (A). Construct the ContainerInput/group
 * from the step args and call the framework's runContainerAgent. Left as a
 * sketch because the exact import path depends on how the sidecar is packaged.
 *
 *   import { runContainerAgent } from '<framework>/dist/container-runner.js';
 *   import { getGroup } from '<framework>/dist/...';
 *
 *   setRunStep(async ({ group, chatJid, prompt, modelOverride, allowedTools }) => {
 *     const reg = getGroup(group);                       // RegisteredGroup
 *     const out = await runContainerAgent(reg, {
 *       prompt, chatJid, groupFolder: group,
 *       isMain: false, isScheduledTask: true,
 *       modelOverride, allowedTools,                     // <- per-step routing
 *     }, () => {});
 *     return { status: out.status, result: out.result };
 *   });
 */
