import fs from 'fs';
import https from 'https';
import path from 'path';

import { Bot } from 'grammy';

import {
  ASSISTANT_NAME,
  INGRESS_HTTP_PORT,
  TELEGRAM_AUTO_ALLOWLIST_GROUPS,
  TELEGRAM_AUTO_REGISTER_GROUPS,
  TRIGGER_PATTERN,
} from '../config.js';
import { logReaction, storeOutboundMessage } from '../db.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import {
  getIngressHttpServer,
  type IngressHttpServer,
} from './ingress-http-server.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { verifyIngressSignature } from './slack-http-receiver.js';
import { ensureTelegramSenderAllowlisted } from './telegram-allowlist.js';
import {
  autoAllowlistMatches,
  buildJoinGreeting,
  deriveTelegramGroupFolder,
  parseAutoAllowlist,
  TelegramAutoAllowlist,
} from './telegram-auto.js';
import {
  TelegramSender,
  telegramSenderConfig,
  type TelegramApiResult,
} from './telegram-sender.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
  SendMessageOpts,
} from '../types.js';

/** Map Slack-style emoji names to Unicode for Telegram Bot API compatibility. */
const EMOJI_MAP: Record<string, string> = {
  eyes: '👀',
  thinking_face: '🤔',
  white_check_mark: '✅',
  thumbsup: '👍',
  heart: '❤',
  fire: '🔥',
  pray: '🙏',
};

/**
 * The subset of the Telegram Bot API the channel uses for OUTBOUND calls.
 * Polling mode passes grammy's `Bot#api` (which already satisfies this shape);
 * ingress mode passes an adapter backed by the control-plane proxy
 * (TelegramSender). Parameterizing the "send-like" surface this way keeps the
 * send/reaction/typing/edit methods transport-agnostic — polling behavior stays
 * bit-identical (it's still `this.bot.api` under the hood).
 *
 * The signatures mirror the exact call shapes telegram.ts already makes on
 * grammy's api, so the polling path is unchanged.
 */
interface TelegramApiLike {
  sendMessage(
    chatId: string | number,
    text: string,
    options?: { message_thread_id?: number; parse_mode?: 'Markdown' },
  ): Promise<{ message_id: number }>;
  sendChatAction(chatId: string | number, action: 'typing'): Promise<unknown>;
  editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
    options?: { parse_mode?: 'Markdown' },
  ): Promise<unknown>;
  deleteMessage(chatId: string | number, messageId: number): Promise<unknown>;
  setMessageReaction(
    chatId: string | number,
    messageId: number,
    reaction: Array<{ type: 'emoji'; emoji: string }>,
  ): Promise<unknown>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 *
 * Works over any TelegramApiLike: grammy's api throws on failure (its catch
 * drives the plain-text retry), and the ingress adapter throws a synthetic
 * error on a Telegram `ok:false`, so the SAME Markdown→plain fallback applies
 * to both transports.
 */
async function sendTelegramMessage(
  api: Pick<TelegramApiLike, 'sendMessage'>,
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<number> {
  try {
    const msg = await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
    return msg.message_id;
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    const msg = await api.sendMessage(chatId, text, options);
    return msg.message_id;
  }
}

/**
 * Adapter that presents the control-plane proxy (TelegramSender) as a
 * TelegramApiLike so the transport-agnostic send/edit/react methods work
 * unchanged in ingress mode.
 *
 * Failure semantics: grammy throws on API errors; to preserve the exact
 * Markdown→plain fallback logic in sendTelegramMessage/updateStatus, this
 * adapter THROWS when the proxy returns a Telegram `ok:false` (or the CP is
 * unreachable). The outer methods already try/catch, so a persistent failure
 * ends in a logged warning/error exactly as the polling path would.
 */
class ProxyTelegramApi implements TelegramApiLike {
  constructor(private readonly sender: TelegramSender) {}

  private static unwrap(r: TelegramApiResult): void {
    if (!r.ok) {
      throw new Error(
        `telegram proxy call failed: ${r.description || 'ok:false'}`,
      );
    }
  }

  async sendMessage(
    chatId: string | number,
    text: string,
    options: { message_thread_id?: number; parse_mode?: 'Markdown' } = {},
  ): Promise<{ message_id: number }> {
    const params: Record<string, unknown> = { chat_id: chatId, text };
    if (options.message_thread_id !== undefined) {
      params.message_thread_id = options.message_thread_id;
    }
    if (options.parse_mode) params.parse_mode = options.parse_mode;
    const r = await this.sender.call<{ message_id: number }>(
      'sendMessage',
      params,
    );
    ProxyTelegramApi.unwrap(r);
    // The CP echoes Telegram's result verbatim; message_id is present on ok.
    return { message_id: r.result?.message_id ?? 0 };
  }

  async sendChatAction(
    chatId: string | number,
    action: 'typing',
  ): Promise<unknown> {
    return this.sender.call('sendChatAction', { chat_id: chatId, action });
  }

  async editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
    options: { parse_mode?: 'Markdown' } = {},
  ): Promise<unknown> {
    const params: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
    };
    if (options.parse_mode) params.parse_mode = options.parse_mode;
    const r = await this.sender.call('editMessageText', params);
    ProxyTelegramApi.unwrap(r);
    return r.result;
  }

  async deleteMessage(
    chatId: string | number,
    messageId: number,
  ): Promise<unknown> {
    const r = await this.sender.call('deleteMessage', {
      chat_id: chatId,
      message_id: messageId,
    });
    ProxyTelegramApi.unwrap(r);
    return r.result;
  }

  async setMessageReaction(
    chatId: string | number,
    messageId: number,
    reaction: Array<{ type: 'emoji'; emoji: string }>,
  ): Promise<unknown> {
    const r = await this.sender.call('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction,
    });
    ProxyTelegramApi.unwrap(r);
    return r.result;
  }
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  // Needed for TELEGRAM_AUTO_REGISTER_GROUPS; auto-registration is silently
  // disabled when the orchestrator doesn't provide it.
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
  // TELEGRAM_AUTO_REGISTER_GROUPS — register a group the moment the bot is
  // added to it (my_chat_member) or when an unregistered group's message
  // reaches the bot. Default: off.
  autoRegisterGroups?: boolean;
  // TELEGRAM_AUTO_ALLOWLIST_GROUPS raw value ('all' or comma-separated
  // jids) — auto-seed unknown senders in matching groups as KB people.
  // SECURITY: grants full access; trusted groups only. Default: off.
  autoAllowlistGroups?: string;
  // --- Shared-bot INGRESS mode (hosted SaaS) ---
  // When set, the channel runs WITHOUT a bot token: the control plane POSTs raw
  // Telegram Updates to /telegram/updates (HMAC-signed with ingressSecret) and
  // all outbound is proxied back through the CP. Polling mode leaves these unset.
  ingressSecret?: string;
  // Optional bot identity hints for ingress mode. Without a token there is no
  // getMe, so @mention-by-handle translation and reply-to-bot detection need
  // these to work; when absent, those features degrade to OFF (see
  // processRawUpdate / handleTextUpdate). Trigger-word (ASSISTANT_NAME)
  // mentions still work regardless.
  botUsername?: string;
  botId?: number;
}

/**
 * Transport-agnostic view of the fields the per-event logic needs off an
 * inbound message. Polling adapters pull these from a grammy `ctx`; the ingress
 * path fills them from the raw Telegram `Update` JSON. Keeping the handler
 * methods keyed off THIS shape (not a grammy ctx) is what lets both transports
 * share the exact same trigger/auto-register/auto-allowlist/naming logic.
 */
interface InboundChat {
  id: number;
  type: string;
  title?: string;
}
interface InboundFrom {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
}
interface InboundReplyTo {
  message_id?: number;
  text?: string;
  caption?: string;
  from?: { id?: number; first_name?: string; username?: string };
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  // "<jid>:<message id>" → forum topic (message_thread_id), so a reply can be
  // pinned to the topic of the exact message that triggered the run. Without
  // this a concurrent message in another topic would misroute the reply (#46).
  // Keyed by jid + message id (not message id alone) because a Telegram
  // message_id is only unique within a chat and one bot serves many chats.
  // Since outbound only carried the jid before, replies didn't target a topic
  // at all; this also wires that up. Capped LRU.
  private threadIdById = new Map<string, string>();
  private static readonly THREAD_ID_BY_ID_MAX = 500;
  private autoAllowlist: TelegramAutoAllowlist;

  // --- Ingress mode state ---
  private readonly ingress: boolean;
  private readonly ingressSecret: string | undefined;
  private readonly ingressBotUsername: string | undefined;
  private readonly ingressBotId: number | undefined;
  private sender: TelegramSender | null = null;
  private proxyApi: ProxyTelegramApi | null = null;
  private ingressServer: IngressHttpServer | null = null;
  private ingressConnected = false;

  // Telegram bot commands handled locally — skip them in the general handler
  // so they don't also get stored as messages. All other /commands flow through.
  private static readonly TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
    this.autoAllowlist = parseAutoAllowlist(opts.autoAllowlistGroups);
    // Ingress mode iff no token and an ingress secret is provided.
    this.ingress = !botToken && !!opts.ingressSecret;
    this.ingressSecret = opts.ingressSecret;
    this.ingressBotUsername = opts.botUsername;
    this.ingressBotId = opts.botId;
  }

  /**
   * The outbound API surface for the current transport: grammy's `bot.api` in
   * polling mode, the control-plane proxy adapter in ingress mode. Returns null
   * when not connected (no bot / no proxy yet).
   */
  private api(): TelegramApiLike | null {
    if (this.ingress) return this.proxyApi;
    return (this.bot?.api as unknown as TelegramApiLike) ?? null;
  }

  /**
   * Auto-register a Telegram group/supergroup when
   * TELEGRAM_AUTO_REGISTER_GROUPS is on. Returns the registered group
   * (existing or newly created), or undefined when the feature is off, the
   * chat isn't a group, or registration was rejected. Idempotent.
   */
  private maybeAutoRegisterGroup(chat: {
    id: number;
    type: string;
    title?: string;
  }): RegisteredGroup | undefined {
    const chatJid = `tg:${chat.id}`;
    const existing = this.opts.registeredGroups()[chatJid];
    if (existing) return existing;
    if (!this.opts.autoRegisterGroups || !this.opts.registerGroup) {
      return undefined;
    }
    if (chat.type !== 'group' && chat.type !== 'supergroup') return undefined;

    const existingFolders = new Set(
      Object.values(this.opts.registeredGroups()).map((g) => g.folder),
    );
    const folder = deriveTelegramGroupFolder(
      chat.id,
      chat.title,
      existingFolders,
    );
    this.opts.registerGroup(chatJid, {
      name: chat.title || chatJid,
      folder,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
    });
    // Re-read instead of trusting our input: registerGroup validates the
    // folder and may reject the registration.
    const registered = this.opts.registeredGroups()[chatJid];
    if (registered) {
      logger.info(
        { chatJid, name: registered.name, folder: registered.folder },
        'Telegram group auto-registered',
      );
    }
    return registered;
  }

  /**
   * Auto-seed an unknown sender as an allowlisted KB person when this
   * registered group matches TELEGRAM_AUTO_ALLOWLIST_GROUPS. Failures are
   * logged and never block message delivery.
   */
  private maybeAutoAllowlistSender(
    chatJid: string,
    isGroup: boolean,
    from: InboundFrom | undefined,
  ): void {
    if (this.autoAllowlist.mode === 'off') return;
    if (!from?.id || from.is_bot) return;
    if (!autoAllowlistMatches(this.autoAllowlist, chatJid, isGroup)) return;
    try {
      ensureTelegramSenderAllowlisted({
        telegramId: from.id.toString(),
        username: from.username,
        firstName: from.first_name,
      });
    } catch (err) {
      logger.warn({ chatJid, err }, 'Telegram auto-allowlist seeding failed');
    }
  }

  /**
   * Download a Telegram file to the group's attachments directory.
   * Returns the container-relative path (e.g. /workspace/group/attachments/photo_123.jpg)
   * or null if the download fails.
   *
   * POLLING ONLY. In ingress mode the tenant has no bot token, getFile is not
   * an allowed proxy method, and file download URLs embed the token — so ingress
   * media handling degrades to the placeholder (this returns null immediately,
   * and processRawUpdate never even calls it).
   */
  private async downloadFile(
    fileId: string,
    groupFolder: string,
    filename: string,
  ): Promise<string | null> {
    if (!this.bot) return null;

    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) {
        logger.warn({ fileId }, 'Telegram getFile returned no file_path');
        return null;
      }

      const groupDir = resolveGroupFolderPath(groupFolder);
      const attachDir = path.join(groupDir, 'attachments');
      fs.mkdirSync(attachDir, { recursive: true });

      // Sanitize filename and add extension from Telegram's file_path if missing
      const tgExt = path.extname(file.file_path);
      const localExt = path.extname(filename);
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const finalName = localExt ? safeName : `${safeName}${tgExt}`;
      const destPath = path.join(attachDir, finalName);

      const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const resp = await fetch(fileUrl);
      if (!resp.ok) {
        logger.warn(
          { fileId, status: resp.status },
          'Telegram file download failed',
        );
        return null;
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(destPath, buffer);

      logger.info({ fileId, dest: destPath }, 'Telegram file downloaded');
      return `/workspace/group/attachments/${finalName}`;
    } catch (err) {
      logger.error({ fileId, err }, 'Failed to download Telegram file');
      return null;
    }
  }

  // ─── Transport-agnostic per-event logic ──────────────────────────────────
  // These methods take plain structural params (NOT a grammy ctx). Polling
  // handlers adapt `ctx` → these; the ingress path adapts raw Update JSON →
  // these. This is what keeps trigger-matching / auto-register / auto-allowlist
  // / naming / media placeholders identical across both transports.

  /**
   * The bot's own username (lowercased) for @mention-by-handle translation.
   * Polling: from ctx.me. Ingress: from the botUsername hint, else undefined
   * (translation degrades to off — trigger-word mentions still work).
   */
  private botUsername(ctxMeUsername?: string): string | undefined {
    return (ctxMeUsername || this.ingressBotUsername)?.toLowerCase();
  }

  /** The bot's own id for reply-to-bot detection. Ingress: from the botId hint. */
  private botId(ctxMeId?: number): number | undefined {
    return ctxMeId ?? this.ingressBotId;
  }

  /** Core text-message handling. Returns nothing; delivers via onMessage. */
  private handleTextUpdate(params: {
    chat: InboundChat;
    from: InboundFrom | undefined;
    text: string;
    messageId: number;
    date: number;
    entities: Array<{ type: string; offset: number; length: number }>;
    threadId: number | undefined;
    replyTo: InboundReplyTo | undefined;
    // Bot identity for THIS transport (ctx.me on polling; hints on ingress).
    meUsername?: string;
    meId?: number;
  }): void {
    const {
      chat,
      from,
      messageId,
      date,
      entities,
      threadId,
      replyTo,
      meUsername,
      meId,
    } = params;

    // Skip locally-handled bot commands so they aren't stored as messages.
    if (params.text.startsWith('/')) {
      const cmd = params.text.slice(1).split(/[\s@]/)[0].toLowerCase();
      if (TelegramChannel.TELEGRAM_BOT_COMMANDS.has(cmd)) return;
    }

    const chatJid = `tg:${chat.id}`;
    let content = params.text;
    const timestamp = new Date(date * 1000).toISOString();
    const senderName =
      from?.first_name || from?.username || from?.id.toString() || 'Unknown';
    const sender = from?.id.toString() || '';
    const msgId = messageId.toString();
    if (threadId !== undefined) {
      this.threadIdById.set(`${chatJid}:${msgId}`, threadId.toString());
      if (this.threadIdById.size > TelegramChannel.THREAD_ID_BY_ID_MAX) {
        const oldestKey = this.threadIdById.keys().next().value;
        if (oldestKey !== undefined) this.threadIdById.delete(oldestKey);
      }
    }

    const replyToMessageId = replyTo?.message_id?.toString();
    const replyToContent = replyTo?.text || replyTo?.caption;
    const replyToSenderName = replyTo
      ? replyTo.from?.first_name ||
        replyTo.from?.username ||
        replyTo.from?.id?.toString() ||
        'Unknown'
      : undefined;

    // Determine chat name
    const chatName =
      chat.type === 'private' ? senderName : chat.title || chatJid;

    // Detect @bot_username mentions.
    // When the bot is @mentioned anywhere in the message, prepend the
    // configured trigger word so the orchestrator's TRIGGER_PATTERN matches.
    // In ingress mode without a botUsername hint this resolves to undefined and
    // handle-based translation is skipped (documented degradation).
    const botUsername = this.botUsername(meUsername);
    if (botUsername) {
      const isBotMentioned = entities.some((entity) => {
        if (entity.type === 'mention') {
          const mentionText = content
            .substring(entity.offset, entity.offset + entity.length)
            .toLowerCase();
          return mentionText === `@${botUsername}`;
        }
        return false;
      });
      if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
        // Prepend the configured trigger word (e.g. "@Breadbrich Engels") so the
        // orchestrator's ^TRIGGER_PATTERN\b matcher catches the message,
        // even when the user @-mentions the bot via its handle
        // (e.g. "@your_bot_username") rather than the assistant name.
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    // Detect replies to bot's own messages for auto-trigger. Ingress without a
    // botId hint → meId undefined → this is false (documented degradation).
    const meIdResolved = this.botId(meId);
    const isReplyToBot = !!(
      replyTo &&
      meIdResolved &&
      replyTo.from?.id === meIdResolved
    );

    // Store chat metadata for discovery
    const isGroup = chat.type === 'group' || chat.type === 'supergroup';
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'telegram', isGroup);

    // Only deliver full messages for registered groups. With
    // TELEGRAM_AUTO_REGISTER_GROUPS on, an unregistered group's message
    // self-heal-registers the chat and is processed (covers bots added
    // before auto-registration existed and privacy-mode bots that only
    // start seeing messages after an admin promotion).
    let group: RegisteredGroup | undefined =
      this.opts.registeredGroups()[chatJid];
    if (!group) {
      group = this.maybeAutoRegisterGroup(chat);
      if (group) {
        logger.info(
          { chatJid, chatName },
          'Telegram group late-registered on inbound message',
        );
      }
    }
    if (!group) {
      logger.debug(
        { chatJid, chatName },
        'Message from unregistered Telegram chat',
      );
      return;
    }

    // Auto-allowlist the sender when this group matches
    // TELEGRAM_AUTO_ALLOWLIST_GROUPS (no-op for known senders).
    this.maybeAutoAllowlistSender(chatJid, isGroup, from);

    // Deliver message — startMessageLoop() will pick it up
    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      thread_id: threadId ? threadId.toString() : undefined,
      reply_to_message_id: replyToMessageId,
      reply_to_message_content: replyToContent,
      reply_to_sender_name: replyToSenderName,
      is_reply_to_bot: isReplyToBot,
    });

    logger.info(
      { chatJid, chatName, sender: senderName },
      'Telegram message stored',
    );
  }

  /**
   * Core media-message handling. Downloads the file when a fileId is present
   * AND we're in polling mode; otherwise (or in ingress mode) delivers the
   * placeholder + caption. In ingress mode `downloadInPolling` is false so
   * media always degrades to the placeholder (no token → no download).
   */
  private handleMediaUpdate(params: {
    chat: InboundChat;
    from: InboundFrom | undefined;
    messageId: number;
    date: number;
    caption: string | undefined;
    placeholder: string;
    fileId?: string;
    filename?: string;
  }): void {
    const { chat, from, messageId, date, placeholder } = params;
    const chatJid = `tg:${chat.id}`;
    // Same self-heal registration as the text handler (no-op unless
    // TELEGRAM_AUTO_REGISTER_GROUPS is on).
    const group =
      this.opts.registeredGroups()[chatJid] ??
      this.maybeAutoRegisterGroup(chat);
    if (!group) return;

    const timestamp = new Date(date * 1000).toISOString();
    const senderName =
      from?.first_name || from?.username || from?.id?.toString() || 'Unknown';
    const caption = params.caption ? ` ${params.caption}` : '';

    const isGroup = chat.type === 'group' || chat.type === 'supergroup';
    this.opts.onChatMetadata(
      chatJid,
      timestamp,
      undefined,
      'telegram',
      isGroup,
    );

    const deliver = (content: string) => {
      this.opts.onMessage(chatJid, {
        id: messageId.toString(),
        chat_jid: chatJid,
        sender: from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    };

    // Download only in polling mode. Ingress has no token → placeholder only.
    if (params.fileId && !this.ingress) {
      const msgId = messageId.toString();
      const filename =
        params.filename ||
        `${placeholder.replace(/[[\] ]/g, '').toLowerCase()}_${msgId}`;
      this.downloadFile(params.fileId, group.folder, filename).then(
        (filePath) => {
          if (filePath) {
            deliver(`${placeholder} (${filePath})${caption}`);
          } else {
            deliver(`${placeholder}${caption}`);
          }
        },
      );
      return;
    }

    deliver(`${placeholder}${caption}`);
  }

  /**
   * Core my_chat_member handling: auto-register the group the moment the bot
   * is added, and greet. No-op unless TELEGRAM_AUTO_REGISTER_GROUPS is on.
   */
  private async handleMyChatMember(params: {
    chat: InboundChat;
    newChatMemberUserId: number | undefined;
    newStatus: string | undefined;
    meId: number | undefined;
    canReadAllGroupMessages: boolean | undefined;
  }): Promise<void> {
    // Fully inert unless the flag is on — flag-off installs behave exactly as
    // before this handler existed.
    if (!this.opts.autoRegisterGroups) return;
    const { chat } = params;
    if (!chat) return;
    // my_chat_member updates always concern the bot itself, but check anyway —
    // we only care about the bot being added, as member or admin.
    const meId = this.botId(params.meId);
    if (meId && params.newChatMemberUserId !== meId) return;
    const newStatus = params.newStatus;
    if (newStatus !== 'member' && newStatus !== 'administrator') return;
    if (chat.type !== 'group' && chat.type !== 'supergroup') return;

    const chatJid = `tg:${chat.id}`;
    this.opts.onChatMetadata(
      chatJid,
      new Date().toISOString(),
      chat.title,
      'telegram',
      true,
    );

    const alreadyRegistered = !!this.opts.registeredGroups()[chatJid];
    const group = this.maybeAutoRegisterGroup(chat);
    if (!group || alreadyRegistered) return; // off, rejected, or known chat

    // Fresh registration — greet, adapting to the bot's privacy mode
    // (privacy on ⇒ Telegram only delivers /commands, mentions, replies). In
    // ingress mode canReadAllGroupMessages is undefined (no getMe), which yields
    // the non-privacy-warning greeting (documented degradation).
    const greeting = buildJoinGreeting(
      ASSISTANT_NAME,
      params.canReadAllGroupMessages,
    );
    const api = this.api();
    if (!api) return;
    try {
      await sendTelegramMessage(api, chat.id, greeting);
    } catch (err) {
      logger.warn({ chatJid, err }, 'Failed to send Telegram join greeting');
    }
  }

  /**
   * Core /chatid handling. `reply` sends the response over the current
   * transport (polling: ctx.reply; ingress: outbound proxy sendMessage to the
   * chat). Also self-heal-registers the group when auto-registration is on.
   */
  private async handleChatIdCommand(
    chat: { id: number; type: string; title?: string },
    fromFirstName: string | undefined,
    reply: (text: string) => void | Promise<void>,
  ): Promise<void> {
    const chatType = chat.type;
    const chatName =
      chatType === 'private'
        ? fromFirstName || 'Private'
        : chat.title || 'Unknown';

    await reply(
      `Chat ID: \`tg:${chat.id}\`\nName: ${chatName}\nType: ${chatType}`,
    );

    // Self-heal path: with auto-registration on, /chatid in an unregistered
    // group registers it on the spot (covers bots added before the feature
    // existed — no my_chat_member event to replay).
    this.maybeAutoRegisterGroup(chat);
  }

  async connect(): Promise<void> {
    if (this.ingress) {
      return this.connectIngress();
    }

    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration). Thin adapter → shared
    // handleChatIdCommand.
    this.bot.command('chatid', (ctx) => {
      void this.handleChatIdCommand(ctx.chat, ctx.from?.first_name, (text) => {
        ctx.reply(text, { parse_mode: 'Markdown' });
      });
    });

    // Auto-register the group the moment the bot itself is added
    // (TELEGRAM_AUTO_REGISTER_GROUPS). No-op when the flag is off.
    this.bot.on('my_chat_member', async (ctx) => {
      const update = ctx.myChatMember;
      await this.handleMyChatMember({
        chat: ctx.chat,
        newChatMemberUserId: update?.new_chat_member?.user?.id,
        newStatus: update?.new_chat_member?.status,
        meId: ctx.me?.id,
        canReadAllGroupMessages: ctx.me?.can_read_all_group_messages,
      });
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      this.handleTextUpdate({
        chat: ctx.chat,
        from: ctx.from,
        text: ctx.message.text,
        messageId: ctx.message.message_id,
        date: ctx.message.date,
        entities: ctx.message.entities || [],
        threadId: ctx.message.message_thread_id,
        replyTo: ctx.message.reply_to_message,
        meUsername: ctx.me?.username,
        meId: ctx.me?.id,
      });
    });

    // Handle non-text messages: download files when possible, fall back to
    // placeholders. Thin adapters → shared handleMediaUpdate.
    const media = (
      ctx: any,
      placeholder: string,
      opts?: { fileId?: string; filename?: string },
    ) =>
      this.handleMediaUpdate({
        chat: ctx.chat,
        from: ctx.from,
        messageId: ctx.message.message_id,
        date: ctx.message.date,
        caption: ctx.message.caption,
        placeholder,
        fileId: opts?.fileId,
        filename: opts?.filename,
      });

    this.bot.on('message:photo', (ctx) => {
      // Telegram sends multiple sizes; last is largest
      const photos = ctx.message.photo;
      const largest = photos?.[photos.length - 1];
      media(ctx, '[Photo]', {
        fileId: largest?.file_id,
        filename: `photo_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:video', (ctx) => {
      media(ctx, '[Video]', {
        fileId: ctx.message.video?.file_id,
        filename: `video_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:voice', (ctx) => {
      media(ctx, '[Voice message]', {
        fileId: ctx.message.voice?.file_id,
        filename: `voice_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:audio', (ctx) => {
      const name =
        ctx.message.audio?.file_name || `audio_${ctx.message.message_id}`;
      media(ctx, '[Audio]', {
        fileId: ctx.message.audio?.file_id,
        filename: name,
      });
    });
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      media(ctx, `[Document: ${name}]`, {
        fileId: ctx.message.document?.file_id,
        filename: name,
      });
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      media(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => media(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => media(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  // ─── Shared-bot INGRESS transport ────────────────────────────────────────

  /**
   * Connect in ingress mode: register /telegram/updates on the shared ingress
   * HTTP server (same port as the slack receiver) and wire up the outbound
   * control-plane proxy. No grammy Bot is constructed.
   */
  private async connectIngress(): Promise<void> {
    const cfg = telegramSenderConfig();
    if (cfg) {
      this.sender = new TelegramSender(cfg);
      this.proxyApi = new ProxyTelegramApi(this.sender);
    } else {
      // Inbound still works; outbound will no-op until CONTROL_PLANE_* is set.
      logger.warn(
        'Telegram ingress: CONTROL_PLANE_URL/TOKEN not set — outbound sends will be dropped',
      );
    }

    const secret = this.ingressSecret!;
    const server = getIngressHttpServer(INGRESS_HTTP_PORT, logger);
    this.ingressServer = server;
    server.registerRoute('POST', '/telegram/updates', (rawBody, req, res) => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const verified = verifyIngressSignature({
        ingressSecret: secret,
        rawBody,
        timestamp: header(req, 'x-labor-ingress-timestamp'),
        signature: header(req, 'x-labor-ingress-signature'),
        nowSeconds,
      });
      if (!verified) {
        logger.warn(
          { url: req.url },
          'Telegram ingress rejected request (signature verification failed)',
        );
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }

      let update: Record<string, unknown>;
      try {
        update = JSON.parse(rawBody);
      } catch {
        res.writeHead(400);
        res.end('Bad Request');
        return;
      }

      // Ack immediately (200), THEN process async — fire-and-forget so slow
      // handlers never delay the ack (mirrors the slack receiver).
      res.writeHead(200);
      res.end();
      void this.processRawUpdate(update);
    });

    await server.start();
    this.ingressConnected = true;
    logger.info(
      { port: INGRESS_HTTP_PORT, botUsername: this.ingressBotUsername },
      'Telegram ingress connected (shared-bot mode)',
    );
  }

  /**
   * Translate a raw Telegram `Update` object into the transport-agnostic
   * handler methods. Mirrors the polling grammy handlers: text → handleTextUpdate,
   * media → handleMediaUpdate (placeholder only — no download without a token),
   * my_chat_member → handleMyChatMember, and the local /chatid + /ping commands.
   */
  private async processRawUpdate(
    update: Record<string, unknown>,
  ): Promise<void> {
    try {
      const myChatMember = update.my_chat_member as any;
      if (myChatMember) {
        await this.handleMyChatMember({
          chat: myChatMember.chat,
          newChatMemberUserId: myChatMember.new_chat_member?.user?.id,
          newStatus: myChatMember.new_chat_member?.status,
          // No getMe in ingress; rely on the botId hint (may be undefined).
          meId: undefined,
          // No getMe → no privacy-mode signal → non-warning greeting.
          canReadAllGroupMessages: undefined,
        });
        return;
      }

      const message = update.message as any;
      if (!message) return;
      const chat = message.chat as InboundChat | undefined;
      if (!chat) return;
      const from = message.from as InboundFrom | undefined;

      // Text (and text-based bot commands).
      if (typeof message.text === 'string') {
        const text: string = message.text;
        if (text.startsWith('/')) {
          const cmd = text.slice(1).split(/[\s@]/)[0].toLowerCase();
          if (cmd === 'chatid') {
            // /chatid can't ctx.reply without a token — send via the proxy.
            await this.handleChatIdCommand(
              chat,
              from?.first_name,
              (replyText) => this.sendRawText(chat.id, replyText),
            );
            return; // not stored (matches polling)
          }
          if (cmd === 'ping') {
            await this.sendRawText(chat.id, `${ASSISTANT_NAME} is online.`);
            return; // not stored (matches polling)
          }
        }
        this.handleTextUpdate({
          chat,
          from,
          text,
          messageId: message.message_id,
          date: message.date,
          entities: message.entities || [],
          threadId: message.message_thread_id,
          replyTo: message.reply_to_message,
          // No getMe in ingress; identity comes from the hints (may be off).
          meUsername: undefined,
          meId: undefined,
        });
        return;
      }

      // Media — placeholder only in ingress (no token → no download), with the
      // same placeholder + fileId mapping as the polling handlers.
      const dispatchMedia = (
        placeholder: string,
        fileId?: string,
        filename?: string,
      ) =>
        this.handleMediaUpdate({
          chat,
          from,
          messageId: message.message_id,
          date: message.date,
          caption: message.caption,
          placeholder,
          fileId,
          filename,
        });

      if (Array.isArray(message.photo)) {
        const largest = message.photo[message.photo.length - 1];
        dispatchMedia(
          '[Photo]',
          largest?.file_id,
          `photo_${message.message_id}`,
        );
      } else if (message.video) {
        dispatchMedia(
          '[Video]',
          message.video.file_id,
          `video_${message.message_id}`,
        );
      } else if (message.voice) {
        dispatchMedia(
          '[Voice message]',
          message.voice.file_id,
          `voice_${message.message_id}`,
        );
      } else if (message.audio) {
        dispatchMedia(
          '[Audio]',
          message.audio.file_id,
          message.audio.file_name || `audio_${message.message_id}`,
        );
      } else if (message.document) {
        const name = message.document.file_name || 'file';
        dispatchMedia(`[Document: ${name}]`, message.document.file_id, name);
      } else if (message.sticker) {
        dispatchMedia(`[Sticker ${message.sticker.emoji || ''}]`);
      } else if (message.location) {
        dispatchMedia('[Location]');
      } else if (message.contact) {
        dispatchMedia('[Contact]');
      }
    } catch (err) {
      logger.error({ err }, 'Telegram ingress: failed to process update');
    }
  }

  /**
   * Send a plain (non-stored) text message over the current transport. Used for
   * the ingress /chatid + /ping replies (which are NOT stored as messages).
   * Markdown→plain fallback applies via sendTelegramMessage.
   */
  private async sendRawText(chatId: number, text: string): Promise<void> {
    const api = this.api();
    if (!api) return;
    try {
      await sendTelegramMessage(api, chatId, text);
    } catch (err) {
      logger.warn({ chatId, err }, 'Telegram: failed to send command reply');
    }
  }

  async sendMessage(
    jid: string,
    text: string,
    opts?: SendMessageOpts,
  ): Promise<void> {
    const api = this.api();
    if (!api) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      // Pin the reply to the forum topic of the message that triggered it
      // (concurrency-safe); proactive sends with no replyToMessageId go to the
      // chat's general area.
      const threadId = opts?.replyToMessageId
        ? this.threadIdById.get(`${jid}:${opts.replyToMessageId}`)
        : undefined;
      const options = threadId
        ? { message_thread_id: parseInt(threadId, 10) }
        : {};

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        const msgId = await sendTelegramMessage(api, numericId, text, options);
        try {
          storeOutboundMessage(jid, msgId.toString(), text, ASSISTANT_NAME);
        } catch (err) {
          logger.warn({ err, jid }, 'storeOutboundMessage failed (continuing)');
        }
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          const chunk = text.slice(i, i + MAX_LENGTH);
          const msgId = await sendTelegramMessage(
            api,
            numericId,
            chunk,
            options,
          );
          try {
            storeOutboundMessage(jid, msgId.toString(), chunk, ASSISTANT_NAME);
          } catch (err) {
            logger.warn(
              { err, jid },
              'storeOutboundMessage failed (continuing)',
            );
          }
        }
      }
      logger.info(
        { jid, length: text.length, threadId },
        'Telegram message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    if (this.ingress) return this.ingressConnected;
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.ingress) {
      if (this.ingressServer) {
        await this.ingressServer.stop();
        this.ingressServer = null;
      }
      this.ingressConnected = false;
      logger.info('Telegram ingress stopped');
      return;
    }
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const api = this.api();
    if (!api || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }

  async sendMessageWithId(
    jid: string,
    text: string,
  ): Promise<string | undefined> {
    const api = this.api();
    if (!api) return undefined;
    try {
      const numericId = jid.replace(/^tg:/, '');
      const msgId = await sendTelegramMessage(api, numericId, text);
      const id = msgId.toString();
      storeOutboundMessage(jid, id, text, ASSISTANT_NAME);
      return id;
    } catch (err) {
      logger.warn({ jid, err }, 'Failed to send Telegram message with ID');
      return undefined;
    }
  }

  async updateStatus(
    jid: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    const api = this.api();
    if (!api) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await api.editMessageText(numericId, parseInt(messageId, 10), text, {
        parse_mode: 'Markdown',
      });
    } catch {
      // Fallback: try without Markdown if parsing fails
      try {
        const numericId = jid.replace(/^tg:/, '');
        await api.editMessageText(numericId, parseInt(messageId, 10), text);
      } catch (fallbackErr) {
        logger.warn(
          { jid, messageId, err: fallbackErr },
          'Failed to update Telegram message',
        );
      }
    }
  }

  /**
   * Add an emoji reaction to a message.
   * Telegram uses Unicode emoji directly (e.g. '👀', '🤔', '✅').
   * Also accepts Slack-style names for compatibility with the ACK pattern.
   */
  async addReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    const api = this.api();
    if (!api) return;
    const numericId = jid.replace(/^tg:/, '');
    const resolved = EMOJI_MAP[emoji] || emoji;
    try {
      await api.setMessageReaction(numericId, parseInt(messageId, 10), [
        { type: 'emoji', emoji: resolved },
      ]);
      logReaction(jid, messageId, resolved, 'add');
    } catch (err) {
      logger.warn(
        { jid, messageId, emoji, err },
        'Failed to add Telegram reaction',
      );
    }
  }

  /**
   * Remove an emoji reaction from a message.
   * Sends an empty reaction array to clear all bot reactions.
   */
  async removeReaction(
    jid: string,
    messageId: string,
    _emoji: string,
  ): Promise<void> {
    const api = this.api();
    if (!api) return;
    const numericId = jid.replace(/^tg:/, '');
    const resolved = EMOJI_MAP[_emoji] || _emoji;
    try {
      await api.setMessageReaction(numericId, parseInt(messageId, 10), []);
      logReaction(jid, messageId, resolved, 'remove');
    } catch (err) {
      logger.warn(
        { jid, messageId, err },
        'Failed to remove Telegram reaction',
      );
    }
  }

  async deleteMessage(jid: string, messageId: string): Promise<void> {
    const api = this.api();
    if (!api) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await api.deleteMessage(numericId, parseInt(messageId, 10));
    } catch (err) {
      logger.warn({ jid, messageId, err }, 'Failed to delete Telegram message');
    }
  }
}

function header(
  req: { headers: Record<string, string | string[] | undefined> },
  name: string,
): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

registerChannel('telegram', (opts: ChannelOpts) => {
  // Config is sourced from process.env first (hosted: Kubernetes tenant pods
  // inject these via envFrom secretRef), falling back to .env for
  // self-hosted/dev; process.env wins over .env. Matches slack.ts.
  const envVars = readEnvFile([
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_INGRESS_SECRET',
    'TELEGRAM_BOT_USERNAME',
    'TELEGRAM_BOT_ID',
  ]);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  const ingressSecret =
    process.env.TELEGRAM_INGRESS_SECRET ||
    envVars.TELEGRAM_INGRESS_SECRET ||
    '';

  // Mode 1: BYO bot token → polling mode (UNCHANGED behavior).
  if (token) {
    return new TelegramChannel(token, {
      ...opts,
      autoRegisterGroups: TELEGRAM_AUTO_REGISTER_GROUPS,
      autoAllowlistGroups: TELEGRAM_AUTO_ALLOWLIST_GROUPS,
    });
  }

  // Mode 2: no token but an ingress secret → shared-bot ingress mode (hosted).
  // The control plane owns the token; the tenant receives signed Updates and
  // proxies outbound back through the CP. Optional bot identity hints let
  // @mention-by-handle translation + reply-to-bot detection work.
  if (ingressSecret) {
    const botUsername =
      process.env.TELEGRAM_BOT_USERNAME || envVars.TELEGRAM_BOT_USERNAME;
    const botIdRaw =
      process.env.TELEGRAM_BOT_ID || envVars.TELEGRAM_BOT_ID || '';
    const botId = botIdRaw ? Number(botIdRaw) : undefined;
    return new TelegramChannel('', {
      ...opts,
      autoRegisterGroups: TELEGRAM_AUTO_REGISTER_GROUPS,
      autoAllowlistGroups: TELEGRAM_AUTO_ALLOWLIST_GROUPS,
      ingressSecret,
      botUsername,
      botId: Number.isFinite(botId as number) ? botId : undefined,
    });
  }

  // Mode 3: neither → not configured (keep the existing warn intent, add a
  // hint about the ingress alternative).
  logger.warn(
    'Telegram: TELEGRAM_BOT_TOKEN not set (nor TELEGRAM_INGRESS_SECRET for shared-bot ingress mode)',
  );
  return null;
});
