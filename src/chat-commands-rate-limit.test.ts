/**
 * Rate-limit integration for the pre-agent command plane
 * (dispatchChatCommand + src/rate-limit.ts).
 *
 * Invariants under test:
 *  - DISABLED BY DEFAULT: SLASH_RL_MAX=0 (the config default) means the
 *    limiter never engages — no denial, no notice, no behavior change.
 *  - Sliding window: at most SLASH_RL_MAX commands per SLASH_RL_WINDOW_MS
 *    per (chatJid, sender, prefix); a denied command is CLAIMED (returns
 *    true) but its handler never runs — nothing falls through to the agent.
 *  - firstDenial: the throttle notice is sent exactly once per over-limit
 *    window, not on every denied command.
 *  - Denied events are NOT recorded, so an offender cannot push the window
 *    forward by spamming.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Live getters so tests can vary the knobs without re-importing the module.
const mockConfig = vi.hoisted(() => ({
  SLASH_RL_MAX: 0,
  SLASH_RL_WINDOW_MS: 60000,
}));

vi.mock('./config.js', () => ({
  get SLASH_RL_MAX() {
    return mockConfig.SLASH_RL_MAX;
  },
  get SLASH_RL_WINDOW_MS() {
    return mockConfig.SLASH_RL_WINDOW_MS;
  },
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  _clearChatCommands,
  ChatCommandContext,
  dispatchChatCommand,
  registerChatCommand,
} from './chat-commands.js';
import { slashCommandLimiter } from './rate-limit.js';
import { NewMessage } from './types.js';

const WINDOW = 1000;
const MAX = 2;

function makeCtx(content: string, sender = '+alice'): ChatCommandContext {
  const msg: NewMessage = {
    id: 'm1',
    chat_jid: 'group@g.us',
    sender,
    sender_name: 'Alice',
    content,
    timestamp: new Date().toISOString(),
  };
  return {
    chatJid: 'group@g.us',
    msg,
    isGroup: true,
    reply: vi.fn(async () => {}),
  };
}

let handler: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  _clearChatCommands();
  slashCommandLimiter.clear();
  mockConfig.SLASH_RL_MAX = 0;
  mockConfig.SLASH_RL_WINDOW_MS = 60000;
  handler = vi.fn();
  registerChatCommand('!echo', handler);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('disabled by default (SLASH_RL_MAX=0) — provable no-op', () => {
  it('never throttles, never notifies, and never touches the limiter', async () => {
    const replies: ChatCommandContext[] = [];
    for (let i = 0; i < 50; i++) {
      const ctx = makeCtx('!echo hi');
      replies.push(ctx);
      expect(dispatchChatCommand(ctx)).toBe(true);
    }
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(50));
    for (const ctx of replies) expect(ctx.reply).not.toHaveBeenCalled();
    // The limiter map stays empty — check() was never called.
    expect(slashCommandLimiter.size()).toBe(0);
  });
});

describe('sliding-window throttling (SLASH_RL_MAX > 0)', () => {
  beforeEach(() => {
    mockConfig.SLASH_RL_MAX = MAX;
    mockConfig.SLASH_RL_WINDOW_MS = WINDOW;
  });

  it('allows up to max commands, then denies while still claiming the message', async () => {
    for (let i = 0; i < MAX; i++) {
      expect(dispatchChatCommand(makeCtx('!echo hi'))).toBe(true);
    }
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(MAX));

    const denied = makeCtx('!echo hi');
    // Claimed (true) so the caller skips storage/trigger handling — the
    // throttled command must never spawn anything.
    expect(dispatchChatCommand(denied)).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(handler).toHaveBeenCalledTimes(MAX); // handler did NOT run
    expect(denied.reply).toHaveBeenCalledTimes(1); // one-time notice
  });

  it('sends the throttle notice once per over-limit window (firstDenial)', async () => {
    for (let i = 0; i < MAX; i++) dispatchChatCommand(makeCtx('!echo hi'));

    const first = makeCtx('!echo hi');
    dispatchChatCommand(first);
    await vi.advanceTimersByTimeAsync(10);
    expect(first.reply).toHaveBeenCalledTimes(1);

    // Subsequent denials in the same window stay silent.
    for (let i = 0; i < 5; i++) {
      const ctx = makeCtx('!echo hi');
      expect(dispatchChatCommand(ctx)).toBe(true);
      await vi.advanceTimersByTimeAsync(10);
      expect(ctx.reply).not.toHaveBeenCalled();
    }
    expect(handler).toHaveBeenCalledTimes(MAX);
  });

  it('does not record denied events — the offender cannot push the window forward', async () => {
    for (let i = 0; i < MAX; i++) dispatchChatCommand(makeCtx('!echo hi'));
    // Spam denials right up to the window edge.
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(50);
      dispatchChatCommand(makeCtx('!echo hi'));
    }
    // Cross the window boundary relative to the ALLOWED events: budget resets.
    await vi.advanceTimersByTimeAsync(WINDOW);
    const ctx = makeCtx('!echo hi');
    expect(dispatchChatCommand(ctx)).toBe(true);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(MAX + 1));
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('re-arms the notice after the window resets and is exceeded again', async () => {
    for (let i = 0; i < MAX; i++) dispatchChatCommand(makeCtx('!echo hi'));
    const firstDenied = makeCtx('!echo hi');
    dispatchChatCommand(firstDenied);
    await vi.advanceTimersByTimeAsync(10);
    expect(firstDenied.reply).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(WINDOW + 1);
    for (let i = 0; i < MAX; i++) dispatchChatCommand(makeCtx('!echo hi'));
    const secondDenied = makeCtx('!echo hi');
    dispatchChatCommand(secondDenied);
    await vi.advanceTimersByTimeAsync(10);
    expect(secondDenied.reply).toHaveBeenCalledTimes(1);
  });

  it('keys on (chatJid, sender, prefix): another sender keeps a fresh budget', async () => {
    for (let i = 0; i < MAX; i++)
      dispatchChatCommand(makeCtx('!echo hi', '+alice'));
    expect(dispatchChatCommand(makeCtx('!echo hi', '+alice'))).toBe(true); // denied
    // Bob is unaffected.
    const bob = makeCtx('!echo hi', '+bob');
    expect(dispatchChatCommand(bob)).toBe(true);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(MAX + 1));
    expect(bob.reply).not.toHaveBeenCalled();
  });

  it('exemptFromRateLimit (main-group operator surface) is never throttled', async () => {
    for (let i = 0; i < MAX * 5; i++) {
      const ctx = makeCtx('!echo hi');
      ctx.exemptFromRateLimit = true;
      expect(dispatchChatCommand(ctx)).toBe(true);
      expect(ctx.reply).not.toHaveBeenCalled();
    }
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(MAX * 5));
    // Exempt dispatches never touch the limiter map.
    expect(slashCommandLimiter.size()).toBe(0);
  });

  it('non-command messages are untouched (no limiter interaction)', () => {
    expect(dispatchChatCommand(makeCtx('hello everyone'))).toBe(false);
    expect(slashCommandLimiter.size()).toBe(0);
  });
});
