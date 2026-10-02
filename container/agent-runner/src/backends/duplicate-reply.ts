/**
 * Detects a turn-ending reply that only repeats a same-chat send_message.
 *
 * Gateway models (GLM via Z.ai) sometimes deliver their answer with a
 * same-chat send_message and then end the turn with the same text, which
 * would post it twice. Only an actual repeat is dropped: a missed duplicate is
 * a visible extra message, but a wrong suppression is a reply that silently
 * never arrives.
 */

const SEND_MESSAGE_TOOL = 'mcp__nanoclaw__send_message';

interface ContentBlock {
  type?: string;
  name?: string;
  input?: unknown;
}

/** Text of a same-chat send_message call, or null for any other block. */
export function sameChatSendText(
  block: ContentBlock | undefined,
): string | null {
  if (block?.type !== 'tool_use' || block.name !== SEND_MESSAGE_TOOL) {
    return null;
  }
  const input = block.input as
    | { text?: unknown; target_jid?: unknown }
    | undefined;
  if (input?.target_jid) return null;
  return typeof input?.text === 'string' ? input.text : null;
}

/** Mirrors the cleanup the orchestrator applies before delivery (src/index.ts). */
export function normalizeReply(text: string): string {
  return text
    .replace(/<internal>[\s\S]*?<\/internal>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when delivering `finalText` would only repeat a same-chat send_message
 * from this turn. Empty output is never a duplicate: it delivers nothing.
 */
export function isDuplicateOfSentText(
  finalText: string | null | undefined,
  sentTexts: readonly string[],
): boolean {
  const final = normalizeReply(finalText ?? '');
  if (!final) return false;
  return sentTexts.some((sent) => normalizeReply(sent) === final);
}
