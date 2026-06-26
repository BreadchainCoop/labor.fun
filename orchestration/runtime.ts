/**
 * runtime — binds the abstract RunStep port to the orchestrator's Smithers
 * bridge (src/smithers-bridge.ts) over localhost HTTP.
 *
 * The sidecar runs as its own Bun process and does NOT import the framework.
 * Instead it POSTs each step to the orchestrator's bridge, which executes it
 * through runContainerAgent — so every step keeps the container sandbox,
 * credential proxy, per-group memory, and RBAC. This is "Option B" from the
 * design doc, the prod-preferred decoupled wiring.
 *
 * Config (env):
 *   SMITHERS_BRIDGE_URL    default http://127.0.0.1:3002
 *   SMITHERS_BRIDGE_TOKEN  shared bearer token (must match the orchestrator)
 *
 * The bridge must be enabled on the orchestrator side: SMITHERS_BRIDGE_ENABLED=true
 * with the same SMITHERS_BRIDGE_TOKEN. See orchestration/deploy/README.md.
 */

import type { RunStep } from './agents/container-agent.js';

let bound: RunStep | null = null;

/** Wire a specific RunStep (tests, or a non-HTTP transport). */
export function setRunStep(fn: RunStep): void {
  bound = fn;
}

/**
 * Build an HTTP RunStep that posts to the orchestrator's Smithers bridge.
 */
export function makeHttpRunStep(opts?: { url?: string; token?: string }): RunStep {
  const url =
    opts?.url ?? process.env.SMITHERS_BRIDGE_URL ?? 'http://127.0.0.1:3002';
  const token = opts?.token ?? process.env.SMITHERS_BRIDGE_TOKEN ?? '';

  return async ({ group, chatJid, prompt, modelOverride, allowedTools }) => {
    const res = await fetch(`${url}/run-step`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        group,
        chatJid,
        prompt,
        modelOverride,
        allowedTools,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`bridge ${res.status}: ${text || res.statusText}`);
    }
    const json = (await res.json()) as {
      status: 'success' | 'error';
      result: string | null;
    };
    return { status: json.status, result: json.result };
  };
}

export function getRunStep(): RunStep {
  // Default to the HTTP bridge transport if nothing was explicitly bound.
  if (!bound) bound = makeHttpRunStep();
  return bound;
}
