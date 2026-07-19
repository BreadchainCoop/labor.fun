import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _clearChatCommands,
  ChatCommandContext,
  dispatchChatCommand,
  matchChatCommand,
  registerChatCommand,
} from './chat-commands.js';
import { NewMessage } from './types.js';

function makeCtx(content: string): ChatCommandContext {
  const msg: NewMessage = {
    id: 'm1',
    chat_jid: 'group@g.us',
    sender: '+alice',
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

beforeEach(() => {
  _clearChatCommands();
});

describe('chat-command registry', () => {
  it('dispatches first-match-wins in registration order', async () => {
    const calls: string[] = [];
    registerChatCommand('!translate-on', (args) => {
      calls.push(`on:${args}`);
    });
    registerChatCommand('!translate', (args) => {
      calls.push(`bare:${args}`);
    });

    expect(dispatchChatCommand(makeCtx('!translate-on es en'))).toBe(true);
    expect(dispatchChatCommand(makeCtx('!translate es'))).toBe(true);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls).toEqual(['on:es en', 'bare:es']);
  });

  it('a more specific prefix registered later loses to the earlier proper prefix', () => {
    registerChatCommand('!translate', () => {});
    registerChatCommand('!translate-on', () => {});
    expect(matchChatCommand('!translate-on es en')?.prefix).toBe('!translate');
  });

  it('returns false when no command matches', () => {
    registerChatCommand('!translate', () => {});
    expect(dispatchChatCommand(makeCtx('hola a todos'))).toBe(false);
    expect(dispatchChatCommand(makeCtx('!help'))).toBe(false);
    expect(dispatchChatCommand(makeCtx(''))).toBe(false);
  });

  it('passes trimmed args and the context to the handler', async () => {
    const handler = vi.fn();
    registerChatCommand('!echo', handler);
    const ctx = makeCtx('  !echo   hello world  ');
    expect(dispatchChatCommand(ctx)).toBe(true);
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());
    expect(handler).toHaveBeenCalledWith('hello world', ctx);
  });

  it('contains handler errors instead of throwing into the message loop', async () => {
    registerChatCommand('!boom', async () => {
      throw new Error('kaboom');
    });
    expect(() => dispatchChatCommand(makeCtx('!boom'))).not.toThrow();
    // Give the rejected promise a tick to be handled.
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe('token-boundary prefix matching', () => {
  // Registration order mirrors registerTranslateCommands: specific -on/-off/-me
  // variants before the bare !translate catch-all.
  beforeEach(() => {
    for (const p of [
      '!translate-on',
      '!translate-off',
      '!translate-me',
      '!translate',
    ]) {
      registerChatCommand(p, () => {});
    }
  });

  it('matches on exact text or a whitespace boundary', () => {
    expect(matchChatCommand('!translate-off')?.prefix).toBe('!translate-off');
    expect(matchChatCommand('!translate-off ')?.prefix).toBe('!translate-off');
    expect(matchChatCommand('!translate-on es en')?.prefix).toBe(
      '!translate-on',
    );
    expect(matchChatCommand('!translate es')?.prefix).toBe('!translate');
  });

  it('does not let a longer word greedily claim a shorter command prefix', () => {
    // startsWith used to route these to -off / -me; now they fall through to
    // the bare !translate handler (the `-` after !translate is a boundary).
    expect(matchChatCommand('!translate-offxyz')?.prefix).toBe('!translate');
    expect(matchChatCommand('!translate-meow')?.prefix).toBe('!translate');
  });
});
