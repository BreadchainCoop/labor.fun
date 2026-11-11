/**
 * Approval-gate verdict for the request_approval tool.
 *
 * The orchestrator decides which action classes are gated (profile
 * `gatedActionClasses` / `GATED_ACTION_CLASSES` env, else a default set) and
 * passes the resolved list into the agent container as
 * NANOCLAW_GATED_ACTION_CLASSES. The tool uses it to tell the agent right away
 * whether to proceed or wait, instead of a reply that commits to neither.
 * Without that, an ungated request looked pending: the host's "proceed" goes
 * out as a chat message the agent never receives.
 *
 * Pure (env in, string out) so the repo's vitest can test it.
 */

export const GATED_ACTION_CLASSES_ENV = 'NANOCLAW_GATED_ACTION_CLASSES';

/**
 * Env entry forwarding the gated-class list from the container env to the
 * nanoclaw MCP server process. Empty when the orchestrator didn't set it (an
 * older host), so the tool falls back to its non-committal reply.
 */
export function gatedActionClassesEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const v = env[GATED_ACTION_CLASSES_ENV];
  return v === undefined ? {} : { [GATED_ACTION_CLASSES_ENV]: v };
}

/** Parsed gated-class list, or null when the host didn't provide one. */
export function parseGatedActionClasses(
  raw: string | undefined,
): string[] | null {
  if (raw === undefined) return null;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Text the request_approval tool returns to the agent. */
export function approvalRequestResult(
  actionClass: string,
  gated: string[] | null,
): string {
  const cls = actionClass.trim();
  if (gated === null) {
    return `Approval requested for a ${cls} action. If this class is gated, wait for a human's approve/reject before proceeding; if not, the orchestrator will tell you to proceed.`;
  }
  if (!gated.includes(cls)) {
    return `No approval needed: ${cls} is not a gated action class for this org. Proceed with the action now; do not wait for, or ask anyone for, sign-off.`;
  }
  return `${cls} is a gated action class. The request is recorded and an approve/reject prompt is posted to the control channel. STOP: do not perform the action until you are told it was approved. The requester cannot approve their own request; another allowlisted approver must.`;
}
