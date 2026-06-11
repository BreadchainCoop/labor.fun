import { logger } from '../logger.js';
import type { NewMessage } from '../types.js';

/**
 * A **chat flow** takes over message processing for the chats it claims,
 * suppressing the general assistant there. This registry mirrors the channel
 * and integration registries (see docs/PLUGINS.md): modules self-register at
 * import time via a barrel (src/chat-flows/index.ts), or a profile plugin
 * registers one through the PluginApi.
 *
 * Flow chats are treated as **external/untrusted** by the orchestrator:
 * - the agent run is forced non-privileged (sandboxed mounts, no DB),
 *   restricted to the flow's tool allowlist, with the flow's persona appended
 *   to the system prompt;
 * - the chat is exempt from the sender allowlist (public by design);
 * - ALL IPC from the chat's group folder is ignored (defense in depth).
 *
 * Side effects (KB writes, notifications) happen on the privileged
 * orchestrator side in {@link ChatFlow.onAgentResult} — the sandboxed
 * container has no write path of its own.
 */

/** Privileged operations the orchestrator lends to a flow's onAgentResult. */
export interface ChatFlowHost {
  /** Send a message (formatted per channel) to any registered chat. */
  notify(jid: string, text: string): Promise<void>;
  /** The shared-KB group's chat JID, if registered. */
  sharedKbChatJid(): string | null;
}

export interface ChatFlow {
  /** Stable identifier, also used in logs. */
  name: string;
  /** Claim a chat JID. Claimed chats run this flow instead of the assistant. */
  matches(chatJid: string): boolean;
  /** Tools the sandboxed agent may use (replaces the default allowlist). */
  allowedTools: string[];
  /** Persona appended to the system prompt for this flow's runs. */
  systemPrompt: string;
  /**
   * Post-process the agent's output (internal tags already stripped) and
   * return the user-facing reply ('' = stay silent). Runs privileged; this is
   * where records get filed and notifications sent. `triggerMsg` carries the
   * REAL sender identity from message metadata — attribute to it, never to
   * anything the agent claims.
   */
  onAgentResult(
    output: string,
    triggerMsg: NewMessage,
    chatJid: string,
    host: ChatFlowHost,
  ): Promise<string>;
}

const registry: ChatFlow[] = [];

export function registerChatFlow(flow: ChatFlow): void {
  const existing = registry.findIndex((f) => f.name === flow.name);
  if (existing !== -1) {
    logger.warn(
      { flow: flow.name },
      'Chat flow name already registered — overwriting the previous one',
    );
    registry[existing] = flow;
    return;
  }
  registry.push(flow);
}

/** The flow claiming this chat, if any (first registered wins). */
export function findChatFlow(chatJid: string): ChatFlow | undefined {
  return registry.find((f) => f.matches(chatJid));
}

/** @internal - for tests */
export function _clearChatFlows(): void {
  registry.length = 0;
}
