/**
 * Translation command suite + auto-translate middleware.
 *
 * Ported at parity from sigstack-bot (translate.rs, translate_all.rs,
 * translate_me.rs, translate_langs.rs). Channel-agnostic and pre-agent: the
 * commands register into the lightweight chat-command plane
 * (src/chat-commands.ts) and the middleware runs in the shared onMessage hook
 * before storage/trigger handling — no agent container is ever spawned.
 *
 * Command surface:
 *   !translate <lang>              one-shot translation of the quoted message
 *                                  (falls back to the last non-command message)
 *   !translate-on <l1> <l2>        group bidirectional auto-translate
 *   !translation-on <l1> <l2>      (alias)
 *   !translate-off / !translation-off
 *   !translate-me on <lang>        per-user opt-in (also `!translate-me <lang>`)
 *   !translate-me off              (aliases: !translation-me …)
 *   !list-langs                    supported language table
 */
import { ChatCommandContext, registerChatCommand } from './chat-commands.js';
import {
  clearTranslatePair,
  clearUserTranslateLang,
  getRecentMessages,
  getTranslatePrefs,
  setTranslatePair,
  setUserTranslateLang,
} from './db.js';
import { logger } from './logger.js';
import {
  detectLanguage,
  displayPair,
  formatLanguageList,
  formatTranslationReply,
  isTranslationConfigured,
  isTranslationReply,
  Language,
  resolveLanguage,
  resolvePairForText,
  translateText,
} from './translate-service.js';

// --- Messages (ported verbatim where sigstack defines them) ---

const BARE_ON_MSG =
  'Please specify two languages. Example: !translate-on es en';
const GROUP_ONLY_ON_MSG = '!translate-on is only available in group chats';
const GROUP_ONLY_ME_MSG = '!translate-me is only available in group chats';
const ME_USAGE_MSG =
  'Usage: !translate-me on <lang> (e.g. !translate-me on en), or !translate-me off';
const TRANSLATE_FAILED_MSG = 'Could not translate. Try again later.';
const NOT_CONFIGURED_MSG = 'Translation is not configured for this deployment.';
const TRANSCRIPT_PREFIX = '📝 Transcript:';

function unknownLanguageMsg(token: string): string {
  return `Unknown language: ${token}. Use !list-langs for supported codes.`;
}

// --- Rate limiting (default 30 translations/min per chat, rolling window) ---

const RATE_WINDOW_MS = 60_000;
const rateLog = new Map<string, number[]>();

function rateLimitPerMin(): number {
  const raw = parseInt(process.env.TRANSLATE_RATE_LIMIT_PER_MIN || '30', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30;
}

/** Returns false when the chat exceeded the per-minute translation budget. */
export function allowTranslation(
  chatJid: string,
  now: number = Date.now(),
): boolean {
  const limit = rateLimitPerMin();
  if (limit === 0) return true;
  const entries = (rateLog.get(chatJid) ?? []).filter(
    (t) => now - t < RATE_WINDOW_MS,
  );
  if (entries.length >= limit) {
    rateLog.set(chatJid, entries);
    return false;
  }
  entries.push(now);
  rateLog.set(chatJid, entries);
  return true;
}

/** @internal - for tests only. */
export function _resetTranslateRateLimiter(): void {
  rateLog.clear();
}

// --- Command handlers ---

async function handleTranslateOn(
  args: string,
  ctx: ChatCommandContext,
): Promise<void> {
  if (!ctx.isGroup) {
    await ctx.reply(GROUP_ONLY_ON_MSG);
    return;
  }
  const tokens = args.split(/\s+/).filter(Boolean);
  if (tokens.length !== 2) {
    await ctx.reply(BARE_ON_MSG);
    return;
  }
  const [tokenA, tokenB] = tokens;
  const langA = resolveLanguage(tokenA);
  if (!langA) {
    await ctx.reply(unknownLanguageMsg(tokenA));
    return;
  }
  const langB = resolveLanguage(tokenB);
  if (!langB) {
    await ctx.reply(unknownLanguageMsg(tokenB));
    return;
  }
  if (langA.code === langB.code) {
    await ctx.reply(
      'Choose two different languages. Example: !translate-on es en',
    );
    return;
  }
  // Refuse to enable auto-translate on a deployment with no provider — otherwise
  // every subsequent message would fail and spam TRANSLATE_FAILED_MSG.
  if (!isTranslationConfigured()) {
    await ctx.reply(NOT_CONFIGURED_MSG);
    return;
  }
  setTranslatePair(ctx.chatJid, langA.code, langB.code);
  const pairLabel = displayPair({ langA: langA.code, langB: langB.code });
  logger.info(
    { chatJid: ctx.chatJid, pair: pairLabel },
    'translate-all mode enabled',
  );
  await ctx.reply(`Group translate enabled: ${pairLabel}`);
}

async function handleTranslateOff(
  _args: string,
  ctx: ChatCommandContext,
): Promise<void> {
  if (!ctx.isGroup) {
    await ctx.reply(GROUP_ONLY_ON_MSG);
    return;
  }
  if (clearTranslatePair(ctx.chatJid)) {
    logger.info({ chatJid: ctx.chatJid }, 'translate-all mode disabled');
    await ctx.reply('Group translate disabled');
  } else {
    await ctx.reply('Group translate was not active in this chat.');
  }
}

async function handleTranslateMe(
  args: string,
  ctx: ChatCommandContext,
): Promise<void> {
  if (!ctx.isGroup) {
    await ctx.reply(GROUP_ONLY_ME_MSG);
    return;
  }
  const tokens = args.split(/\s+/).filter(Boolean);
  const first = tokens[0]?.toLowerCase();

  if (first === 'off') {
    if (clearUserTranslateLang(ctx.chatJid, ctx.msg.sender)) {
      logger.info(
        { chatJid: ctx.chatJid, sender: ctx.msg.sender },
        'translate-me disabled',
      );
      await ctx.reply(
        'Translation off: your messages will no longer be translated.',
      );
    } else {
      await ctx.reply('Translation was not active for you in this chat.');
    }
    return;
  }

  // `!translate-me on <lang>` or the convenience form `!translate-me <lang>`.
  let langToken: string | undefined;
  if (first === 'on') {
    langToken = tokens[1];
  } else if (first && resolveLanguage(first)) {
    langToken = first;
  } else {
    await ctx.reply(ME_USAGE_MSG);
    return;
  }

  if (!langToken) {
    await ctx.reply(ME_USAGE_MSG);
    return;
  }
  const lang = resolveLanguage(langToken);
  if (!lang) {
    await ctx.reply(unknownLanguageMsg(langToken));
    return;
  }
  // Refuse to enable on a deployment with no provider (the off path above is
  // still allowed so an already-opted-in user can always turn it back off).
  if (!isTranslationConfigured()) {
    await ctx.reply(NOT_CONFIGURED_MSG);
    return;
  }
  setUserTranslateLang(ctx.chatJid, ctx.msg.sender, lang.code);
  logger.info(
    { chatJid: ctx.chatJid, sender: ctx.msg.sender, target: lang.code },
    'translate-me enabled',
  );
  await ctx.reply(
    `Translation on: your messages will be translated to ${lang.flag} ${lang.name}.`,
  );
}

async function handleListLangs(
  _args: string,
  ctx: ChatCommandContext,
): Promise<void> {
  await ctx.reply(
    `**Supported languages** (use code with !translate):\n\n${formatLanguageList()}`,
  );
}

/** Strip the voice-transcript prefix from a quoted message (port of extract_quoted_text). */
function extractQuotedText(raw: string): string | null {
  let text = raw.trim();
  if (!text) return null;
  if (text.startsWith(TRANSCRIPT_PREFIX)) {
    text = text.slice(TRANSCRIPT_PREFIX.length).replace(/^\n+/, '').trim();
  }
  return text || null;
}

function isMediaPlaceholder(text: string): boolean {
  return /^\[.+\]$/.test(text);
}

/**
 * Fallback source for `!translate` when the channel exposed no quote: the
 * most recent prior non-command text message in the chat.
 */
function lastTranslatableMessage(chatJid: string): string | null {
  const recent = getRecentMessages(chatJid, 20);
  for (let i = recent.length - 1; i >= 0; i--) {
    const row = recent[i];
    // Never fall back to our own output: bot-sent rows (is_from_me), prior
    // translation replies (flag-prefixed), or the failure notice — otherwise
    // `!translate` could translate the bot instead of the last human message.
    if (row.is_from_me) continue;
    const content = (row.content || '').trim();
    if (!content) continue;
    if (content.startsWith('!') || content.startsWith('/')) continue;
    if (isMediaPlaceholder(content)) continue;
    if (isTranslationReply(content)) continue;
    if (content === TRANSLATE_FAILED_MSG) continue;
    return content;
  }
  return null;
}

async function handleTranslateOneShot(
  args: string,
  ctx: ChatCommandContext,
): Promise<void> {
  const langToken = args.split(/\s+/).filter(Boolean)[0];
  if (!langToken) {
    await ctx.reply(
      'Specify a language: !translate <language> (e.g. !translate es)',
    );
    return;
  }
  const lang = resolveLanguage(langToken);
  if (!lang) {
    await ctx.reply(unknownLanguageMsg(langToken));
    return;
  }

  // Quoted message when the channel provides it (Signal quote, Telegram
  // reply_to_message, Discord reference — all populate
  // reply_to_message_content); otherwise fall back to the last stored
  // non-command text message in this chat.
  let source: string | null = null;
  if (ctx.msg.reply_to_message_content) {
    source = extractQuotedText(ctx.msg.reply_to_message_content);
    if (!source) {
      await ctx.reply('Could not read the quoted message text.');
      return;
    }
  } else {
    source = lastTranslatableMessage(ctx.chatJid);
    if (!source) {
      await ctx.reply(
        'Reply to the message you want translated with: !translate <language>',
      );
      return;
    }
  }

  if (!isTranslationConfigured()) {
    await ctx.reply(NOT_CONFIGURED_MSG);
    return;
  }

  const translation = await translateText(source, lang);
  if (translation) {
    logger.info(
      { chatJid: ctx.chatJid, targetLang: lang.code },
      '!translate completed',
    );
    await ctx.reply(formatTranslationReply(lang, translation));
  } else {
    await ctx.reply(TRANSLATE_FAILED_MSG);
  }
}

/**
 * Register the translation command set into the chat-command plane.
 * Registration order implements sigstack's first-match-wins dispatch: the
 * -on/-off/-me variants and !list-langs must win over bare !translate.
 */
export function registerTranslateCommands(): void {
  registerChatCommand('!translate-on', handleTranslateOn);
  registerChatCommand('!translation-on', handleTranslateOn);
  registerChatCommand('!translate-off', handleTranslateOff);
  registerChatCommand('!translation-off', handleTranslateOff);
  registerChatCommand('!translate-me', handleTranslateMe);
  registerChatCommand('!translation-me', handleTranslateMe);
  registerChatCommand('!list-langs', handleListLangs);
  registerChatCommand('!translate', handleTranslateOneShot);
}

// --- Auto-translate middleware ---

async function sendTranslation(
  ctx: ChatCommandContext,
  text: string,
  target: Language,
): Promise<boolean> {
  const translation = await translateText(text, target);
  if (!translation) {
    // Auto mode failure is a quality-of-life feature — apologize like
    // sigstack's intercept does, but never throw.
    await ctx.reply(TRANSLATE_FAILED_MSG);
    return false;
  }
  await ctx.reply(formatTranslationReply(target, translation));
  return true;
}

/**
 * Auto-translate middleware for the shared onMessage hook. Runs pre-store,
 * fire-and-forget; the normal message flow (storage, trigger handling)
 * continues regardless. Never throws.
 *
 * Two modes, per the ported semantics:
 *  - Group pair mode (!translate-on l1 l2): every normal text message is
 *    detected and translated to the other side of the pair.
 *  - Per-user mode (!translate-me on <lang>): the opted-in sender's messages
 *    are translated into their chosen language (in addition to the group
 *    pair, deduped when both resolve to the same target).
 */
export async function maybeAutoTranslate(
  ctx: ChatCommandContext,
): Promise<void> {
  try {
    const { msg } = ctx;
    // Loop guards: never translate the bot's own outbound, commands, media
    // placeholders, or a message that is itself a translation reply.
    if (msg.is_from_me || msg.is_bot_message) return;
    const text = msg.content.trim();
    if (!text) return;
    if (text.startsWith('!') || text.startsWith('/')) return;
    if (isMediaPlaceholder(text)) return;
    if (isTranslationReply(text)) return;
    // Silently skip when no provider is configured — belt-and-suspenders for
    // prefs that were enabled before the deployment lost its translation
    // backend (avoids spamming TRANSLATE_FAILED_MSG on every message).
    if (!isTranslationConfigured()) return;

    const prefs = getTranslatePrefs(ctx.chatJid);
    if (!prefs) return;

    let pairTargetCode: string | undefined;

    // Group pair mode.
    if (prefs.enabled && prefs.lang1 && prefs.lang2) {
      if (!allowTranslation(ctx.chatJid)) {
        logger.warn(
          { chatJid: ctx.chatJid },
          'translate-all rate limited — skipping text message',
        );
        return;
      }
      const pair = { langA: prefs.lang1, langB: prefs.lang2 };
      const resolved = resolvePairForText(pair, text);
      if (resolved) {
        pairTargetCode = resolved.target.code;
        // If the pair-mode send failed it already apologized once; bail so the
        // per-user branch below can't produce a second failure reply.
        const ok = await sendTranslation(ctx, text, resolved.target);
        if (!ok) return;
      } else {
        logger.debug(
          { chatJid: ctx.chatJid, textChars: text.length },
          'translate-all skipped text (language not in pair or undetected)',
        );
      }
    }

    // Per-user opt-in (translate-me).
    const userLangCode = prefs.userLangs[msg.sender];
    if (!userLangCode) return;
    const target = resolveLanguage(userLangCode);
    if (!target) return;
    // Dedupe: the pair mode already produced this exact target.
    if (pairTargetCode === target.code) return;
    // Skip if the message already looks like the target language.
    const detected = detectLanguage(text);
    if (detected === target.code) {
      logger.debug(
        { chatJid: ctx.chatJid, target: target.code },
        'translate-me skipped (message already in target language)',
      );
      return;
    }
    if (!allowTranslation(ctx.chatJid)) {
      logger.warn(
        { chatJid: ctx.chatJid },
        'translate-me rate limited — skipping text message',
      );
      return;
    }
    await sendTranslation(ctx, text, target);
  } catch (err) {
    logger.warn({ err, chatJid: ctx.chatJid }, 'auto-translate failed');
  }
}
