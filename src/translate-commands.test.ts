import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _clearChatCommands,
  ChatCommandContext,
  dispatchChatCommand,
  matchChatCommand,
} from './chat-commands.js';
import {
  _initTestDatabase,
  clearTranslatePair,
  clearUserTranslateLang,
  getNewMessages,
  getTranslatePrefs,
  setTranslatePair,
  setUserTranslateLang,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { runPreAgentCommandPlane } from './index.js';
import { SenderAllowlistConfig } from './sender-allowlist.js';
import {
  _resetTranslateRateLimiter,
  maybeAutoTranslate,
  registerTranslateCommands,
} from './translate-commands.js';
import { isTranslationConfigured, translateText } from './translate-service.js';
import { NewMessage, RegisteredGroup } from './types.js';

vi.mock('./translate-service.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./translate-service.js')>();
  return {
    ...mod,
    translateText: vi.fn(async () => 'MOCK TRANSLATION'),
    isTranslationConfigured: vi.fn(() => true),
  };
});

const translateMock = vi.mocked(translateText);
const configuredMock = vi.mocked(isTranslationConfigured);

const JID = 'group@g.us';

function makeMsg(
  content: string,
  overrides: Partial<NewMessage> = {},
): NewMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    chat_jid: JID,
    sender: '+alice',
    sender_name: 'Alice',
    content,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeCtx(
  content: string,
  overrides: Partial<NewMessage> = {},
  ctxOverrides: Partial<ChatCommandContext> = {},
): ChatCommandContext & { reply: ReturnType<typeof vi.fn> } {
  const reply = vi.fn(async () => {});
  return {
    chatJid: JID,
    msg: makeMsg(content, overrides),
    isGroup: true,
    reply,
    ...ctxOverrides,
  } as ChatCommandContext & { reply: ReturnType<typeof vi.fn> };
}

/** Dispatch through the registry and await the (async) handler. */
async function runCommand(ctx: ChatCommandContext): Promise<boolean> {
  const text = ctx.msg.content.trim();
  const cmd = matchChatCommand(text);
  if (!cmd) return false;
  await cmd.handler(text.slice(cmd.prefix.length).trim(), ctx);
  return true;
}

beforeEach(() => {
  _initTestDatabase();
  _clearChatCommands();
  registerTranslateCommands();
  _resetTranslateRateLimiter();
  translateMock.mockClear();
  translateMock.mockResolvedValue('MOCK TRANSLATION');
  configuredMock.mockClear();
  configuredMock.mockReturnValue(true);
  delete process.env.TRANSLATE_RATE_LIMIT_PER_MIN;
});

afterEach(() => {
  delete process.env.TRANSLATE_RATE_LIMIT_PER_MIN;
});

// --- Prefs CRUD ---

describe('chat_translate_prefs CRUD', () => {
  it('sets and reads a group pair', () => {
    setTranslatePair(JID, 'es', 'en');
    const prefs = getTranslatePrefs(JID);
    expect(prefs?.enabled).toBe(true);
    expect(prefs?.lang1).toBe('es');
    expect(prefs?.lang2).toBe('en');
    expect(prefs?.userLangs).toEqual({});
  });

  it('clearTranslatePair reports whether a pair was active and prunes the row', () => {
    expect(clearTranslatePair(JID)).toBe(false);
    setTranslatePair(JID, 'es', 'en');
    expect(clearTranslatePair(JID)).toBe(true);
    expect(getTranslatePrefs(JID)).toBeUndefined();
  });

  it('per-user map survives pair clear and prunes when empty', () => {
    setTranslatePair(JID, 'es', 'en');
    setUserTranslateLang(JID, '+alice', 'en');
    setUserTranslateLang(JID, '+bob', 'fr');
    expect(clearTranslatePair(JID)).toBe(true);
    let prefs = getTranslatePrefs(JID);
    expect(prefs?.enabled).toBe(false);
    expect(prefs?.userLangs).toEqual({ '+alice': 'en', '+bob': 'fr' });

    expect(clearUserTranslateLang(JID, '+alice')).toBe(true);
    expect(clearUserTranslateLang(JID, '+alice')).toBe(false);
    prefs = getTranslatePrefs(JID);
    expect(prefs?.userLangs).toEqual({ '+bob': 'fr' });
    expect(clearUserTranslateLang(JID, '+bob')).toBe(true);
    expect(getTranslatePrefs(JID)).toBeUndefined();
  });

  it('pair set preserves existing per-user opt-ins', () => {
    setUserTranslateLang(JID, '+alice', 'en');
    setTranslatePair(JID, 'es', 'en');
    const prefs = getTranslatePrefs(JID);
    expect(prefs?.enabled).toBe(true);
    expect(prefs?.userLangs).toEqual({ '+alice': 'en' });
  });
});

// --- Command parsing / dispatch ---

describe('!translate-on / !translate-off', () => {
  it('enables the pair and confirms with the flag labels', async () => {
    const ctx = makeCtx('!translate-on es en');
    await runCommand(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      'Group translate enabled: 🇪🇸 Spanish ↔ 🇺🇸 English',
    );
    expect(getTranslatePrefs(JID)?.lang1).toBe('es');
  });

  it('supports the !translation-on alias', async () => {
    const ctx = makeCtx('!translation-on es en');
    await runCommand(ctx);
    expect(getTranslatePrefs(JID)?.enabled).toBe(true);
  });

  it('rejects bare and over-specified invocations', async () => {
    for (const text of [
      '!translate-on',
      '!translate-on es',
      '!translate-on es en fr',
    ]) {
      const ctx = makeCtx(text);
      await runCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(
        'Please specify two languages. Example: !translate-on es en',
      );
      expect(getTranslatePrefs(JID)).toBeUndefined();
    }
  });

  it('rejects unknown and duplicate languages', async () => {
    const unknown = makeCtx('!translate-on klingon en');
    await runCommand(unknown);
    expect(unknown.reply).toHaveBeenCalledWith(
      'Unknown language: klingon. Use !list-langs for supported codes.',
    );

    const dupe = makeCtx('!translate-on es spanish');
    await runCommand(dupe);
    expect(dupe.reply).toHaveBeenCalledWith(
      'Choose two different languages. Example: !translate-on es en',
    );
  });

  it('is group-only', async () => {
    const ctx = makeCtx('!translate-on es en', {}, { isGroup: false });
    await runCommand(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      '!translate-on is only available in group chats',
    );
  });

  it('!translate-off disables and reports inactive state', async () => {
    setTranslatePair(JID, 'es', 'en');
    const off = makeCtx('!translate-off');
    await runCommand(off);
    expect(off.reply).toHaveBeenCalledWith('Group translate disabled');

    const again = makeCtx('!translation-off');
    await runCommand(again);
    expect(again.reply).toHaveBeenCalledWith(
      'Group translate was not active in this chat.',
    );
  });

  it('refuses to enable the group pair when translation is unconfigured', async () => {
    configuredMock.mockReturnValue(false);
    const ctx = makeCtx('!translate-on es en');
    await runCommand(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      'Translation is not configured for this deployment.',
    );
    expect(getTranslatePrefs(JID)).toBeUndefined();
  });
});

describe('!translate-me', () => {
  it('enables per-user translation with "on <lang>"', async () => {
    const ctx = makeCtx('!translate-me on en');
    await runCommand(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      'Translation on: your messages will be translated to 🇺🇸 English.',
    );
    expect(getTranslatePrefs(JID)?.userLangs).toEqual({ '+alice': 'en' });
  });

  it('supports the convenience form without "on"', async () => {
    const ctx = makeCtx('!translate-me es');
    await runCommand(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      'Translation on: your messages will be translated to 🇪🇸 Spanish.',
    );
    expect(getTranslatePrefs(JID)?.userLangs).toEqual({ '+alice': 'es' });
  });

  it('supports the !translation-me alias and off', async () => {
    setUserTranslateLang(JID, '+alice', 'en');
    const off = makeCtx('!translation-me off');
    await runCommand(off);
    expect(off.reply).toHaveBeenCalledWith(
      'Translation off: your messages will no longer be translated.',
    );

    const again = makeCtx('!translate-me off');
    await runCommand(again);
    expect(again.reply).toHaveBeenCalledWith(
      'Translation was not active for you in this chat.',
    );
  });

  it('shows usage on bare invocation and rejects unknown languages', async () => {
    const bare = makeCtx('!translate-me');
    await runCommand(bare);
    expect(bare.reply).toHaveBeenCalledWith(
      'Usage: !translate-me on <lang> (e.g. !translate-me on en), or !translate-me off',
    );

    const unknown = makeCtx('!translate-me on klingon');
    await runCommand(unknown);
    expect(unknown.reply).toHaveBeenCalledWith(
      'Unknown language: klingon. Use !list-langs for supported codes.',
    );
    expect(getTranslatePrefs(JID)).toBeUndefined();
  });

  it('is group-only', async () => {
    const ctx = makeCtx('!translate-me on en', {}, { isGroup: false });
    await runCommand(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      '!translate-me is only available in group chats',
    );
  });

  it('refuses to enable per-user translation when unconfigured', async () => {
    configuredMock.mockReturnValue(false);
    const ctx = makeCtx('!translate-me on en');
    await runCommand(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      'Translation is not configured for this deployment.',
    );
    expect(getTranslatePrefs(JID)).toBeUndefined();
  });

  it('still lets an opted-in user turn translation off when unconfigured', async () => {
    setUserTranslateLang(JID, '+alice', 'en');
    configuredMock.mockReturnValue(false);
    const ctx = makeCtx('!translate-me off');
    await runCommand(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      'Translation off: your messages will no longer be translated.',
    );
    expect(getTranslatePrefs(JID)).toBeUndefined();
  });
});

describe('!list-langs', () => {
  it('lists the supported language table', async () => {
    const ctx = makeCtx('!list-langs');
    await runCommand(ctx);
    const reply = ctx.reply.mock.calls[0][0] as string;
    expect(reply).toContain(
      '**Supported languages** (use code with !translate):',
    );
    expect(reply).toContain('🇪🇸 es — Spanish');
    expect(reply).toContain('🇺🇸 en — English');
  });
});

describe('dispatch precedence', () => {
  it('!translate-on / !translate-me / !list-langs are not captured by !translate', async () => {
    for (const text of [
      '!translate-on es en',
      '!translation-on es en',
      '!translate-off',
      '!translate-me on en',
      '!list-langs',
    ]) {
      const ctx = makeCtx(text);
      expect(dispatchChatCommand(ctx)).toBe(true);
    }
    await vi.waitFor(() => expect(translateMock).not.toHaveBeenCalled());
  });

  it('plain text and non-registered commands are not claimed', () => {
    expect(dispatchChatCommand(makeCtx('hola a todos'))).toBe(false);
    expect(dispatchChatCommand(makeCtx('!help'))).toBe(false);
  });
});

// --- One-shot !translate ---

describe('!translate one-shot', () => {
  it('requires a language token', async () => {
    const ctx = makeCtx('!translate');
    await runCommand(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      'Specify a language: !translate <language> (e.g. !translate es)',
    );
  });

  it('rejects unknown languages', async () => {
    const ctx = makeCtx('!translate klingon');
    await runCommand(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      'Unknown language: klingon. Use !list-langs for supported codes.',
    );
  });

  it('translates the quoted message when the channel exposes one', async () => {
    const ctx = makeCtx('!translate es', {
      reply_to_message_content: 'Hello world',
    });
    await runCommand(ctx);
    expect(translateMock).toHaveBeenCalledWith(
      'Hello world',
      expect.objectContaining({ code: 'es' }),
    );
    expect(ctx.reply).toHaveBeenCalledWith('🇪🇸 MOCK TRANSLATION');
  });

  it('strips the voice-transcript prefix from quoted text', async () => {
    const ctx = makeCtx('!translate es', {
      reply_to_message_content: '📝 Transcript:\nHola a todos',
    });
    await runCommand(ctx);
    expect(translateMock).toHaveBeenCalledWith(
      'Hola a todos',
      expect.objectContaining({ code: 'es' }),
    );
  });

  it('falls back to the most recent prior non-command text message', async () => {
    storeChatMetadata(
      JID,
      new Date().toISOString(),
      'Test Group',
      'whatsapp',
      true,
    );
    storeMessage(makeMsg('!translate fr', { id: 'old-cmd' }));
    storeMessage(makeMsg('[Photo]', { id: 'media' }));
    storeMessage(makeMsg('the actual last message', { id: 'target' }));

    const ctx = makeCtx('!translate es');
    await runCommand(ctx);
    expect(translateMock).toHaveBeenCalledWith(
      'the actual last message',
      expect.objectContaining({ code: 'es' }),
    );
    expect(ctx.reply).toHaveBeenCalledWith('🇪🇸 MOCK TRANSLATION');
  });

  it('fallback skips bot own / failure / translation-reply rows and picks the human message', async () => {
    storeChatMetadata(
      JID,
      new Date().toISOString(),
      'Test Group',
      'whatsapp',
      true,
    );
    const ts = (n: number) =>
      new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
    storeMessage(makeMsg('hola mundo', { id: 'human', timestamp: ts(1) }));
    storeMessage(
      makeMsg('🇺🇸 hello world', {
        id: 'bot-translation',
        is_from_me: true,
        timestamp: ts(2),
      }),
    );
    storeMessage(
      makeMsg('Could not translate. Try again later.', {
        id: 'bot-fail',
        timestamp: ts(3),
      }),
    );

    const ctx = makeCtx('!translate es');
    await runCommand(ctx);
    expect(translateMock).toHaveBeenCalledWith(
      'hola mundo',
      expect.objectContaining({ code: 'es' }),
    );
  });

  it('asks for a quote when there is nothing to translate', async () => {
    const ctx = makeCtx('!translate es');
    await runCommand(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      'Reply to the message you want translated with: !translate <language>',
    );
  });

  it('replies with the not-configured message when no provider exists', async () => {
    configuredMock.mockReturnValue(false);
    const ctx = makeCtx('!translate es', {
      reply_to_message_content: 'Hello world',
    });
    await runCommand(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      'Translation is not configured for this deployment.',
    );
    expect(translateMock).not.toHaveBeenCalled();
  });

  it('apologizes when the provider call fails', async () => {
    translateMock.mockResolvedValue(null);
    const ctx = makeCtx('!translate es', {
      reply_to_message_content: 'Hello world',
    });
    await runCommand(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      'Could not translate. Try again later.',
    );
  });
});

// --- Auto-translate middleware ---

describe('maybeAutoTranslate (group pair mode)', () => {
  beforeEach(() => {
    setTranslatePair(JID, 'es', 'en');
  });

  it("translates 'hola' to the other side of the pair", async () => {
    translateMock.mockResolvedValue('hello, how are you?');
    const ctx = makeCtx('hola, cómo está?');
    await maybeAutoTranslate(ctx);
    expect(translateMock).toHaveBeenCalledWith(
      'hola, cómo está?',
      expect.objectContaining({ code: 'en' }),
    );
    expect(ctx.reply).toHaveBeenCalledWith('🇺🇸 hello, how are you?');
  });

  it('translates casual english to spanish (swap semantics)', async () => {
    const ctx = makeCtx('hello, how are you doing?');
    await maybeAutoTranslate(ctx);
    expect(translateMock).toHaveBeenCalledWith(
      'hello, how are you doing?',
      expect.objectContaining({ code: 'es' }),
    );
  });

  it('skips messages whose language is not in the pair', async () => {
    setTranslatePair(JID, 'de', 'fr');
    const ctx = makeCtx('Is anyone going to the meetup?');
    await maybeAutoTranslate(ctx);
    expect(translateMock).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("skips the bot's own messages", async () => {
    const own = makeCtx('hola, cómo está?', { is_from_me: true });
    await maybeAutoTranslate(own);
    const bot = makeCtx('hola, cómo está?', { is_bot_message: true });
    await maybeAutoTranslate(bot);
    expect(translateMock).not.toHaveBeenCalled();
  });

  it('skips !commands, media placeholders, and translation replies', async () => {
    for (const text of [
      '!help',
      '/remote-control',
      '[Photo]',
      '🇺🇸 already a translation',
      '   ',
    ]) {
      const ctx = makeCtx(text);
      await maybeAutoTranslate(ctx);
      expect(ctx.reply).not.toHaveBeenCalled();
    }
    expect(translateMock).not.toHaveBeenCalled();
  });

  it('does nothing when no prefs are active', async () => {
    clearTranslatePair(JID);
    const ctx = makeCtx('hola, cómo está?');
    await maybeAutoTranslate(ctx);
    expect(translateMock).not.toHaveBeenCalled();
  });

  it('enforces the per-chat rate limit', async () => {
    process.env.TRANSLATE_RATE_LIMIT_PER_MIN = '2';
    for (let i = 0; i < 3; i++) {
      await maybeAutoTranslate(makeCtx('hola, cómo está?'));
    }
    expect(translateMock).toHaveBeenCalledTimes(2);
  });

  it('apologizes when translation fails', async () => {
    translateMock.mockResolvedValue(null);
    const ctx = makeCtx('hola, cómo está?');
    await maybeAutoTranslate(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      'Could not translate. Try again later.',
    );
  });

  it('silently skips when translation is unconfigured', async () => {
    configuredMock.mockReturnValue(false);
    const ctx = makeCtx('hola, cómo está?');
    await maybeAutoTranslate(ctx);
    expect(translateMock).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});

describe('maybeAutoTranslate (per-user translate-me)', () => {
  it("translates the opted-in sender's messages into their language", async () => {
    setUserTranslateLang(JID, '+alice', 'en');
    translateMock.mockResolvedValue('good morning everyone');
    const ctx = makeCtx('buenos días a todos');
    await maybeAutoTranslate(ctx);
    expect(translateMock).toHaveBeenCalledWith(
      'buenos días a todos',
      expect.objectContaining({ code: 'en' }),
    );
    expect(ctx.reply).toHaveBeenCalledWith('🇺🇸 good morning everyone');
  });

  it('leaves other senders alone', async () => {
    setUserTranslateLang(JID, '+alice', 'en');
    const ctx = makeCtx('buenos días a todos', { sender: '+bob' });
    await maybeAutoTranslate(ctx);
    expect(translateMock).not.toHaveBeenCalled();
  });

  it('skips messages already in the target language', async () => {
    setUserTranslateLang(JID, '+alice', 'en');
    const ctx = makeCtx('Is anyone going to the meetup?');
    await maybeAutoTranslate(ctx);
    expect(translateMock).not.toHaveBeenCalled();
  });

  it('does not duplicate the pair-mode translation for the same target', async () => {
    setTranslatePair(JID, 'es', 'en');
    setUserTranslateLang(JID, '+alice', 'en');
    const ctx = makeCtx('hola, cómo está?');
    await maybeAutoTranslate(ctx);
    // Pair mode already produced es → en; translate-me must not send a second
    // reply for the same target.
    expect(translateMock).toHaveBeenCalledTimes(1);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
  });

  it('adds a second translation when the user target differs from the pair target', async () => {
    setTranslatePair(JID, 'es', 'en');
    setUserTranslateLang(JID, '+alice', 'fr');
    const ctx = makeCtx('hola, cómo está?');
    await maybeAutoTranslate(ctx);
    expect(translateMock).toHaveBeenCalledTimes(2);
    expect(translateMock).toHaveBeenNthCalledWith(
      1,
      'hola, cómo está?',
      expect.objectContaining({ code: 'en' }),
    );
    expect(translateMock).toHaveBeenNthCalledWith(
      2,
      'hola, cómo está?',
      expect.objectContaining({ code: 'fr' }),
    );
  });

  it('sends only one failure reply when pair-mode fails in additive mode', async () => {
    setTranslatePair(JID, 'es', 'en');
    setUserTranslateLang(JID, '+alice', 'fr');
    translateMock.mockResolvedValue(null); // provider outage
    const ctx = makeCtx('hola, cómo está?');
    await maybeAutoTranslate(ctx);
    // Pair-mode send failed and apologized once; the per-user branch must be
    // skipped so no second failure reply / rate slot is burned.
    expect(translateMock).toHaveBeenCalledTimes(1);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ctx.reply).toHaveBeenCalledWith(
      'Could not translate. Try again later.',
    );
  });
});

// --- Greedy-prefix fall-through (finding 6, dispatch level) ---

describe('greedy prefix fall-through', () => {
  it('!translate-offxyz reaches the bare !translate handler, not the off handler', async () => {
    setTranslatePair(JID, 'es', 'en');
    const ctx = makeCtx('!translate-offxyz');
    await runCommand(ctx);
    // Off handler would have cleared the pair; instead this falls through to
    // !translate and reports an unknown language ("-offxyz").
    expect(ctx.reply).toHaveBeenCalledWith(
      'Unknown language: -offxyz. Use !list-langs for supported codes.',
    );
    expect(getTranslatePrefs(JID)?.enabled).toBe(true);
  });
});

// --- Pre-agent command plane gate (index.ts findings 1 & 2) ---

const GROUP: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@bot',
  added_at: new Date().toISOString(),
};

function planeOpts(
  allow: '*' | string[],
  mode: 'trigger' | 'drop' = 'trigger',
  reply = vi.fn(async () => {}),
) {
  const allowlist: SenderAllowlistConfig = {
    default: { allow, mode },
    chats: {},
    logDenied: false,
  };
  return {
    reply,
    opts: {
      isGroup: true,
      reply,
      allowlist,
      registeredGroups: { [JID]: GROUP } as Record<string, RegisteredGroup>,
      findChatFlow: () => undefined,
    },
  };
}

describe('runPreAgentCommandPlane', () => {
  it('does NOT store a handled command (finding 1: no agent double-handling)', async () => {
    const { opts } = planeOpts('*');
    const msg = makeMsg('!translate-on es en');
    const result = runPreAgentCommandPlane(JID, msg, opts);
    // Mirror the onMessage caller: a claimed command is never stored.
    if (!result.claimed) storeMessage(msg);
    await vi.waitFor(() => expect(getTranslatePrefs(JID)?.enabled).toBe(true));

    expect(result.claimed).toBe(true);
    // The command message must not be visible to the DB poller.
    const { messages } = getNewMessages([JID], '0', 'bot', 50);
    expect(messages).toHaveLength(0);
  });

  it('ignores a denied sender in trigger mode (finding 2: no bypass)', async () => {
    // Allowlist names only +bob; +alice (the message sender) is denied.
    const { reply, opts } = planeOpts(['+bob'], 'trigger');
    const cmd = runPreAgentCommandPlane(
      JID,
      makeMsg('!translate-on es en'),
      opts,
    );
    expect(cmd.eligible).toBe(false);
    expect(cmd.claimed).toBe(false);
    expect(getTranslatePrefs(JID)).toBeUndefined();

    // A plain message from the denied sender is not auto-translated either.
    setTranslatePair(JID, 'es', 'en');
    const plain = runPreAgentCommandPlane(
      JID,
      makeMsg('hola, cómo está?'),
      opts,
    );
    expect(plain.eligible).toBe(false);
    await new Promise((r) => setTimeout(r, 10));
    expect(translateMock).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it('lets an allowed sender through the gate', async () => {
    const { opts } = planeOpts(['+alice'], 'trigger');
    const result = runPreAgentCommandPlane(
      JID,
      makeMsg('!translate-on es en'),
      opts,
    );
    expect(result.eligible).toBe(true);
    expect(result.claimed).toBe(true);
  });
});
