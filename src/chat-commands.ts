/**
 * Lightweight chat-command plane.
 *
 * A minimal, channel-agnostic registry of `!command` handlers that run in the
 * orchestrator process BEFORE a message is stored and independent of the
 * trigger pattern — they never spawn an agent container. The onMessage hook
 * walks the registry first-match-wins (registration order matters: register
 * more specific prefixes before their proper prefixes, e.g. `!translate-on`
 * before `!translate`).
 *
 * This is intentionally tiny — other pre-agent features (translation today)
 * register here; keep it generic.
 */
import { logger } from './logger.js';
import { NewMessage } from './types.js';

export interface ChatCommandContext {
  chatJid: string;
  msg: NewMessage;
  /** Whether the chat is a group (vs a 1:1 DM). */
  isGroup: boolean;
  /** Send a reply directly via the owning channel (no agent involved). */
  reply: (text: string) => Promise<void>;
}

export type ChatCommandHandler = (
  args: string,
  ctx: ChatCommandContext,
) => Promise<void> | void;

interface RegisteredCommand {
  prefix: string;
  handler: ChatCommandHandler;
}

const commands: RegisteredCommand[] = [];

/** Register a command by prefix. First-match-wins in registration order. */
export function registerChatCommand(
  prefix: string,
  handler: ChatCommandHandler,
): void {
  commands.push({ prefix, handler });
}

/**
 * Find the first registered command whose prefix matches `text`.
 *
 * A prefix matches only when `text` equals it exactly OR the character right
 * after it is a token boundary (whitespace or any non-alphanumeric char). This
 * stops greedy matches like `!translate-offxyz` claiming the `!translate-off`
 * handler; that input instead falls through to the bare `!translate` handler
 * (the `-` after `!translate` is a boundary), mirroring sigstack's dispatch.
 */
export function matchChatCommand(text: string): RegisteredCommand | undefined {
  return commands.find((c) => {
    if (!text.startsWith(c.prefix)) return false;
    const next = text.charAt(c.prefix.length);
    return next === '' || !/[A-Za-z0-9]/.test(next);
  });
}

/**
 * Dispatch a message to the first matching command, if any.
 *
 * Returns true when a command claimed the message (the handler runs
 * asynchronously; errors are logged, never thrown to the message loop).
 * Returns false when no command matches — normal message flow continues.
 */
export function dispatchChatCommand(ctx: ChatCommandContext): boolean {
  const text = ctx.msg.content.trim();
  if (!text) return false;
  const cmd = matchChatCommand(text);
  if (!cmd) return false;

  const args = text.slice(cmd.prefix.length).trim();
  Promise.resolve(cmd.handler(args, ctx)).catch((err) => {
    logger.error(
      { err, chatJid: ctx.chatJid, prefix: cmd.prefix },
      'Chat command handler error',
    );
  });
  return true;
}

/** @internal - for tests only. */
export function _clearChatCommands(): void {
  commands.length = 0;
}
