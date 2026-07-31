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
import { SLASH_RL_MAX, SLASH_RL_WINDOW_MS } from './config.js';
import { logger } from './logger.js';
import { rateLimitKey, slashCommandLimiter } from './rate-limit.js';
import { NewMessage } from './types.js';

export interface ChatCommandContext {
  chatJid: string;
  msg: NewMessage;
  /** Whether the chat is a group (vs a 1:1 DM). */
  isGroup: boolean;
  /**
   * Skip rate limiting for this dispatch. Set for the main control group —
   * labor.fun's operator surface (the flat-permission equivalent of Salem's
   * admin exemption), so scripted command bursts by the operator are never
   * throttled.
   */
  exemptFromRateLimit?: boolean;
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

/** One-time notice sent on the allowed→denied transition of a rate-limit window. */
const RATE_LIMIT_NOTICE =
  'You are sending commands too quickly — please wait a moment and try again.';

/**
 * Dispatch a message to the first matching command, if any.
 *
 * Returns true when a command claimed the message (the handler runs
 * asynchronously; errors are logged, never thrown to the message loop).
 * Returns false when no command matches — normal message flow continues.
 *
 * Rate limiting: when SLASH_RL_MAX > 0 (default 0 = disabled), each
 * (chatJid, sender, command prefix) tuple is throttled through a sliding
 * window (src/rate-limit.ts). A denied command is still CLAIMED (returns
 * true) so the caller skips storage/trigger handling — a throttled command
 * must never fall through and spawn an agent container. The throttle notice
 * is sent once per over-limit window (firstDenial), not on every denial.
 */
export function dispatchChatCommand(ctx: ChatCommandContext): boolean {
  const text = ctx.msg.content.trim();
  if (!text) return false;
  const cmd = matchChatCommand(text);
  if (!cmd) return false;

  if (SLASH_RL_MAX > 0 && !ctx.exemptFromRateLimit) {
    const rl = slashCommandLimiter.check(
      rateLimitKey(ctx.chatJid, ctx.msg.sender, cmd.prefix),
      SLASH_RL_WINDOW_MS,
      SLASH_RL_MAX,
    );
    if (!rl.allowed) {
      logger.warn(
        {
          chatJid: ctx.chatJid,
          sender: ctx.msg.sender,
          prefix: cmd.prefix,
          count: rl.count,
        },
        'Chat command rate limited — dropping',
      );
      if (rl.firstDenial) {
        ctx.reply(RATE_LIMIT_NOTICE).catch((err) => {
          logger.error(
            { err, chatJid: ctx.chatJid },
            'Failed to send rate-limit notice',
          );
        });
      }
      // Consumed: never runs the handler, never falls through to the agent.
      return true;
    }
  }

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
