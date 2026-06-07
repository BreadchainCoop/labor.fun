import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  Partials,
  TextChannel,
  ThreadChannel,
} from 'discord.js';

import {
  ASSISTANT_NAME,
  DISCORD_DM_ALLOWED_GUILD_IDS,
  DISCORD_DM_ALLOWED_ROLE_IDS,
  DISCORD_DM_ROLE_REFRESH_INTERVAL,
  TRIGGER_PATTERN,
} from '../config.js';
import { storeOutboundMessage } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
  SendMessageOpts,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  deregisterGroup: (jid: string) => void;
}

const DM_FOLDER_PREFIX = 'discord_dm_';

/**
 * A single historical Discord message, flattened to the fields the agent
 * needs to read/tally a channel's backlog. Author display name is resolved
 * with the same precedence as inbound live messages (guild nick → global
 * display name → username) so attribution matches what users see in chat.
 */
export interface DiscordHistoryMessage {
  id: string;
  authorId: string;
  authorName: string;
  authorIsBot: boolean;
  content: string;
  timestamp: string; // ISO 8601
  attachments: string[]; // filename | url, one per attachment
  /**
   * Present when the message came from a thread/forum post — carries the
   * thread's id and title so a reader can attribute and group by post. Absent
   * for messages read directly from a text channel.
   */
  thread?: { id: string; name: string };
}

export interface FetchChannelHistoryOpts {
  /** Total messages to return. Default 200, hard-capped at 2000. */
  limit?: number;
  /** Message ID — fetch only messages older than this one (pagination). */
  before?: string;
  /**
   * ISO date/datetime. Pagination stops once messages predate this instant,
   * and older messages are excluded. Lets the agent bound a fetch by
   * quarter/month without knowing a message ID.
   */
  sinceIso?: string;
}

/** Hard ceiling on a single history fetch — bounds API calls and memory. */
const HISTORY_HARD_MAX = 2000;
/** Discord's per-request page size limit for channel.messages.fetch. */
const HISTORY_PAGE_SIZE = 100;
/**
 * Cap on archived-thread enumeration pages for a forum (100 threads/page).
 * Bounds work on forums with a deep archive; we log when the cap is hit.
 */
const FORUM_ARCHIVED_PAGE_CAP = 20;

/** Minimal shape of a discord.js message manager used for pagination. */
interface MessagesManagerLike {
  fetch: (q: {
    limit: number;
    before?: string;
  }) => Promise<Map<string, Parameters<typeof toHistoryMessage>[0]>>;
}

/** Minimal shape of a thread channel we read messages from. */
interface ThreadLike {
  id: string;
  name?: string | null;
  parentId?: string | null;
  archiveTimestamp?: number | null;
  archivedAt?: { getTime(): number } | null;
  messages: MessagesManagerLike;
}

/** Minimal shape of a forum/media channel's thread manager. */
interface ForumLike {
  id: string;
  threads: {
    fetchActive: () => Promise<{ threads: { values(): Iterable<ThreadLike> } }>;
    fetchArchived: (q: {
      type?: 'public' | 'private';
      limit?: number;
      before?: string;
    }) => Promise<{
      threads: { values(): Iterable<ThreadLike> };
      hasMore?: boolean;
    }>;
  };
}

/**
 * JID prefix for sending a Discord DM directly to a user by their Discord
 * user ID. Use `dc-dm:<userId>` (e.g. `"dc-dm:123456789"`) to reach a
 * specific user's DM channel without needing their DM channel ID.
 *
 * Distinct from `dc:<channelId>` which targets a specific channel (guild
 * text channel, thread, or existing DM channel) by its channel ID.
 * Discord user IDs and channel IDs share the same numeric format and
 * cannot be distinguished without an API call, so we use explicit prefixes.
 */
export const DISCORD_DM_JID_PREFIX = 'dc-dm:';

/**
 * Map Slack-style emoji names (which the orchestrator uses for the
 * seen/working ACK pattern) to Unicode codepoints Discord.js accepts.
 */
const EMOJI_MAP: Record<string, string> = {
  eyes: '👀',
  thinking_face: '🤔',
  white_check_mark: '✅',
  thumbsup: '👍',
  heart: '❤️',
  fire: '🔥',
  pray: '🙏',
};

/**
 * Build a concise Discord thread name from an inbound message: strip
 * @-mentions, collapse whitespace, cap at 80 chars. Falls back to the
 * author's username when the message is empty (e.g. attachment only).
 */
export function threadNameFromMessage(msg: Message): string {
  const raw = (msg.content || '')
    .replace(/<@[!&]?\d+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (raw) return raw.length > 80 ? `${raw.slice(0, 77)}...` : raw;
  const who =
    msg.member?.displayName ||
    msg.author?.displayName ||
    msg.author?.username ||
    'message';
  return `Reply to ${who}`;
}

/**
 * Check whether a Discord user holds any of the configured allowlist role IDs
 * in any of the configured (or all) guilds the bot can see. Returns true on
 * the first matching role/guild combination.
 */
export async function userHasAllowedRole(
  client: Client,
  userId: string,
  allowedRoleIds: string[] = DISCORD_DM_ALLOWED_ROLE_IDS,
  allowedGuildIds: string[] = DISCORD_DM_ALLOWED_GUILD_IDS,
): Promise<boolean> {
  if (allowedRoleIds.length === 0) return false;
  const roleSet = new Set(allowedRoleIds);
  const guilds =
    allowedGuildIds.length > 0
      ? allowedGuildIds
          .map((id) => client.guilds.cache.get(id))
          .filter((g): g is NonNullable<typeof g> => Boolean(g))
      : [...client.guilds.cache.values()];
  for (const guild of guilds) {
    try {
      const member = await guild.members.fetch(userId);
      for (const roleId of member.roles.cache.keys()) {
        if (roleSet.has(roleId)) return true;
      }
    } catch {
      // User isn't a member of this guild — try the next one.
    }
  }
  return false;
}

/**
 * Flatten a discord.js Message into a DiscordHistoryMessage. Tolerant of the
 * partial shapes returned by `messages.fetch` (and easy to construct in
 * tests) — every field has a safe fallback.
 */
export function toHistoryMessage(
  m: {
    id: string;
    content?: string | null;
    createdTimestamp?: number;
    author?: {
      id?: string;
      bot?: boolean;
      username?: string;
      displayName?: string;
    } | null;
    member?: { displayName?: string } | null;
    attachments?: {
      values(): Iterable<{ name?: string | null; url?: string }>;
    };
  },
  thread?: { id: string; name: string },
): DiscordHistoryMessage {
  const attachments = m.attachments
    ? [...m.attachments.values()].map((a) => a.name || a.url || 'attachment')
    : [];
  return {
    id: m.id,
    authorId: m.author?.id ?? '',
    authorName:
      m.member?.displayName ||
      m.author?.displayName ||
      m.author?.username ||
      'unknown',
    authorIsBot: Boolean(m.author?.bot),
    content: m.content ?? '',
    timestamp: new Date(m.createdTimestamp ?? 0).toISOString(),
    attachments,
    ...(thread ? { thread } : {}),
  };
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private dmRefreshTimer: NodeJS.Timeout | null = null;
  // Latest inbound message per chatJid — used to anchor a thread on the
  // next outbound reply, so every bot response goes into a thread.
  private lastReplyAnchor = new Map<string, Message>();
  // messageId → inbound Message, so a reply can be anchored to the exact
  // message that triggered the agent run rather than whatever arrived last
  // on this jid. Under concurrent traffic (e.g. a second question in another
  // thread while the agent is still working) the per-jid lastReplyAnchor gets
  // overwritten, which posted replies in the wrong thread (#46). Capped LRU.
  private inboundById = new Map<string, Message>();
  private static readonly INBOUND_BY_ID_MAX = 500;
  // messageId → actual Discord channel id, populated when we route a
  // thread-originated inbound under its parent's jid. Reactions and other
  // per-message operations need the real channel that owns the message,
  // not the parent the agent sees. Capped to avoid unbounded growth.
  private messageChannelOverride = new Map<string, string>();
  private static readonly MESSAGE_CHANNEL_OVERRIDE_MAX = 500;

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      // discord.js v14 silently discards DM messageCreate events unless
      // the Channel partial is enabled — DM channels aren't part of the
      // standard guild-channel cache. Message + Reaction partials cover
      // the same gap for replies and reactions on uncached DM messages.
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      // If the message is in a Discord thread whose parent channel is a
      // registered group, route it through the parent's jid so the agent
      // sees a stable chat identity across the thread and its parent.
      let effectiveChannelId = channelId;
      const inboundChannel = message.channel as {
        isThread?: () => boolean;
        parentId?: string | null;
      };
      const inboundIsThread =
        typeof inboundChannel.isThread === 'function' &&
        inboundChannel.isThread();
      if (inboundIsThread && inboundChannel.parentId) {
        const parentJid = `dc:${inboundChannel.parentId}`;
        if (this.opts.registeredGroups()[parentJid]) {
          effectiveChannelId = inboundChannel.parentId;
        }
      }
      const chatJid = `dc:${effectiveChannelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name. When the inbound message is in a thread but
      // we're routing it under the parent's jid, use the parent's name so
      // onChatMetadata's name upsert doesn't overwrite the parent group's
      // stored name with the thread's transient title.
      let chatName: string;
      if (message.guild) {
        if (inboundIsThread && effectiveChannelId !== channelId) {
          const parent = (
            inboundChannel as { parent?: { name?: string } | null }
          ).parent;
          const parentName = parent?.name ?? 'unknown';
          chatName = `${message.guild.name} #${parentName}`;
        } else {
          const textChannel = message.channel as TextChannel;
          chatName = `${message.guild.name} #${textChannel.name}`;
        }
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord encodes mentions as <@userId> (user), <@!userId> (nick
      // variant) and <@&roleId> (role). We treat any of these as a bot
      // mention when they resolve to the bot's user OR to a role the bot
      // itself holds — Discord's autocomplete will frequently pick a
      // role mention when a role shares the bot's display name.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const botRoleIds = new Set<string>();
        const me = message.guild?.members?.me;
        if (me) {
          for (const roleId of me.roles.cache.keys()) {
            botRoleIds.add(roleId);
          }
        }
        const roleKeys = message.mentions.roles?.keys
          ? [...message.mentions.roles.keys()]
          : [];
        const mentionedBotRoleIds = roleKeys.filter((roleId) =>
          botRoleIds.has(roleId),
        );
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`) ||
          mentionedBotRoleIds.length > 0;

        if (isBotMentioned) {
          // Strip both user and bot-role mention tokens to avoid clutter.
          content = content.replace(new RegExp(`<@!?${botId}>`, 'g'), '');
          for (const roleId of mentionedBotRoleIds) {
            content = content.replace(new RegExp(`<@&${roleId}>`, 'g'), '');
          }
          content = content.trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle attachments — include the CDN URL alongside the filename so
      // the agent can fetch and read file contents (RTF, TXT, PDF, CSV, etc.)
      // via WebFetch. Images include the URL for potential vision processing.
      // Video and audio are noted by name only since they cannot be fetched
      // and processed as text.
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map(
          (att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('image/')) {
              return `[Image: ${att.name || 'image'} | ${att.url}]`;
            } else if (contentType.startsWith('video/')) {
              return `[Video: ${att.name || 'video'}]`;
            } else if (contentType.startsWith('audio/')) {
              return `[Audio: ${att.name || 'audio'}]`;
            } else {
              return `[File: ${att.name || 'file'} | ${att.url}]`;
            }
          },
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — annotate at the END so any @-mention trigger
      // at the start of the user's message is still detected by the
      // anchored trigger regex (`^@Breadbrich Engels`). Prepending here
      // would silently block any reply that also @-mentions the bot.
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `${content}\n[In reply to ${replyAuthor}]`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Only deliver full message for registered groups. If this is a DM
      // from an as-yet-unregistered chat AND the sender holds an allowlisted
      // Discord role in a shared guild, auto-register the DM and continue.
      let group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        const isDm = message.guild === null;
        if (
          isDm &&
          this.client &&
          DISCORD_DM_ALLOWED_ROLE_IDS.length > 0 &&
          (await userHasAllowedRole(this.client, sender))
        ) {
          const folder = `${DM_FOLDER_PREFIX}${channelId}`;
          const newGroup: RegisteredGroup = {
            name: `DM @${senderName}`,
            folder,
            trigger: `@${ASSISTANT_NAME}`,
            added_at: new Date().toISOString(),
            requiresTrigger: false,
          };
          this.opts.registerGroup(chatJid, newGroup);
          group = this.opts.registeredGroups()[chatJid];
          logger.info(
            { chatJid, senderName, sender, folder },
            'Auto-allowlisted DM via Discord role',
          );
        }
        if (!group) {
          logger.debug(
            { chatJid, chatName },
            'Message from unregistered Discord channel',
          );
          return;
        }
      }

      // Remember this message so the next outbound reply lands in a thread:
      // either the thread it already lives in, or a new thread started on it.
      this.lastReplyAnchor.set(chatJid, message);
      // Also index by message id so a reply can be pinned to the exact
      // triggering message (concurrency-safe), with simple LRU eviction.
      this.inboundById.set(msgId, message);
      if (this.inboundById.size > DiscordChannel.INBOUND_BY_ID_MAX) {
        const oldestKey = this.inboundById.keys().next().value;
        if (oldestKey !== undefined) this.inboundById.delete(oldestKey);
      }
      // If we re-routed this thread message under its parent's jid, record
      // the message's real channel so reactions/typing target the thread,
      // not the parent. (Map.set re-inserts to the end, giving us oldest-
      // first iteration for the simple LRU eviction below.)
      if (inboundIsThread && effectiveChannelId !== channelId) {
        this.messageChannelOverride.set(msgId, channelId);
        if (
          this.messageChannelOverride.size >
          DiscordChannel.MESSAGE_CHANNEL_OVERRIDE_MAX
        ) {
          const oldestKey = this.messageChannelOverride.keys().next().value;
          if (oldestKey !== undefined) {
            this.messageChannelOverride.delete(oldestKey);
          }
        }
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        // Start the DM-role refresh loop (deregisters allowlisted DMs whose
        // owner has since lost the required Discord role).
        if (
          DISCORD_DM_ALLOWED_ROLE_IDS.length > 0 &&
          DISCORD_DM_ROLE_REFRESH_INTERVAL > 0
        ) {
          this.dmRefreshTimer = setInterval(
            () => this.refreshDmAllowlist(),
            DISCORD_DM_ROLE_REFRESH_INTERVAL,
          );
          // Don't keep the process alive purely for this timer.
          this.dmRefreshTimer.unref?.();
        }
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  /**
   * Re-verify every auto-allowlisted DM group. If the owning user no longer
   * holds an allowlisted role in any shared guild, deregister the group.
   * Folder + persisted state is preserved so re-allowlisting later picks up
   * where things left off.
   */
  private async refreshDmAllowlist(): Promise<void> {
    if (!this.client) return;
    const groups = this.opts.registeredGroups();
    for (const [jid, group] of Object.entries(groups)) {
      if (!jid.startsWith('dc:')) continue;
      if (!group.folder.startsWith(DM_FOLDER_PREFIX)) continue;
      const channelId = jid.slice(3);
      try {
        const channel = await this.client.channels.fetch(channelId);
        const ownerId =
          channel && 'recipientId' in channel
            ? (channel as { recipientId: string | null }).recipientId
            : null;
        if (!ownerId) {
          logger.warn(
            { jid, folder: group.folder },
            'DM refresh: could not resolve channel owner, leaving group as-is',
          );
          continue;
        }
        const stillAllowed = await userHasAllowedRole(this.client, ownerId);
        if (!stillAllowed) {
          logger.info(
            { jid, folder: group.folder, ownerId },
            'DM refresh: owner no longer holds allowlisted role — deregistering',
          );
          this.opts.deregisterGroup(jid);
        }
      } catch (err) {
        logger.debug(
          { jid, folder: group.folder, err },
          'DM refresh: channel fetch failed, skipping this tick',
        );
      }
    }
  }

  /**
   * Open (or fetch) a DM channel with the given Discord user and send a
   * message. Returns the DM channel id so the caller can route follow-up
   * messages there via the normal `sendMessage("dc:<channelId>", ...)`
   * path.
   *
   * Use `sendMessage("dc-dm:<userId>", text)` to reach this from the
   * standard `send_message` MCP path — the `dc-dm:` prefix routes here
   * directly without going through channel resolution.
   *
   * Handles Discord's 2000-char limit inline with the same chunking
   * sendMessage() uses.
   */
  async dmUser(userId: string, text: string): Promise<string> {
    if (!this.client) throw new Error('Discord client not initialized');
    const user = await this.client.users.fetch(userId);
    const dm = await user.createDM();
    const MAX_LENGTH = 2000;
    // Log outbound under the DM channel's jid (`dc:<channelId>`), the same key
    // a registered DM group uses, so proactive DMs are recorded too.
    const dmJid = `dc:${dm.id}`;
    const storeSent = (id: string, chunk: string) => {
      try {
        storeOutboundMessage(dmJid, id, chunk, ASSISTANT_NAME);
      } catch (err) {
        logger.warn(
          { err, jid: dmJid },
          'storeOutboundMessage failed (continuing)',
        );
      }
    };
    if (text.length <= MAX_LENGTH) {
      const sent = await dm.send(text);
      if (sent?.id) storeSent(sent.id, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        const chunk = text.slice(i, i + MAX_LENGTH);
        const sent = await dm.send(chunk);
        if (sent?.id) storeSent(sent.id, chunk);
      }
    }
    logger.info(
      { userId, channelId: dm.id, length: text.length },
      'Discord DM sent',
    );
    return dm.id;
  }

  async sendMessage(
    jid: string,
    text: string,
    opts?: SendMessageOpts,
  ): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    // `dc-dm:<userId>` — send a DM directly to a Discord user by their user ID.
    // Discord user IDs and channel IDs share the same numeric format and
    // channels.fetch() silently fails on a user ID, so we use an explicit
    // prefix rather than a fallback heuristic.
    if (jid.startsWith(DISCORD_DM_JID_PREFIX)) {
      const userId = jid.slice(DISCORD_DM_JID_PREFIX.length);
      try {
        await this.dmUser(userId, text);
      } catch (err) {
        logger.error({ jid, err }, 'Failed to send Discord message');
      }
      return;
    }

    try {
      // Prefer the exact message that triggered this reply (concurrency-safe);
      // fall back to the per-jid anchor for proactive/agent-initiated sends.
      const anchorMessage = opts?.replyToMessageId
        ? this.inboundById.get(opts.replyToMessageId)
        : undefined;
      const target = await this.resolveReplyTarget(jid, anchorMessage);
      if (!target || typeof target !== 'object' || !('send' in target)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }
      const textChannel = target as TextChannel | ThreadChannel;

      // Discord has a 2000 character limit per message — split if needed.
      // Each sent message is recorded with is_from_me=1 so the bot's own
      // replies land in the messages table (the single source of truth used
      // for context, dedup, and the KB rule that every outbound message is
      // logged). Discord was the only channel not doing this — Slack and
      // Telegram already call storeOutboundMessage in their send paths — which
      // left the table with zero outbound rows on Discord-only installs. The
      // store is wrapped so a DB hiccup never blocks delivery.
      const MAX_LENGTH = 2000;
      const storeSent = (id: string, chunk: string) => {
        try {
          storeOutboundMessage(jid, id, chunk, ASSISTANT_NAME);
        } catch (err) {
          logger.warn({ err, jid }, 'storeOutboundMessage failed (continuing)');
        }
      };
      if (text.length <= MAX_LENGTH) {
        const sent = await textChannel.send(text);
        if (sent?.id) storeSent(sent.id, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          const chunk = text.slice(i, i + MAX_LENGTH);
          const sent = await textChannel.send(chunk);
          if (sent?.id) storeSent(sent.id, chunk);
        }
      }
      // Clear the anchor so scheduled/proactive messages with no fresh
      // inbound trigger fall back to the channel rather than reviving a
      // stale thread the user has since moved on from.
      this.lastReplyAnchor.delete(jid);
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  /**
   * Pick where an outbound message should go so every bot reply lands in a
   * thread when possible:
   *   1. If the last inbound message is already in a thread, send to that
   *      thread channel directly.
   *   2. Otherwise, start a new thread on that message (guild text only).
   *   3. Fall back to the parent channel for DMs or when (2) fails.
   *
   * `anchorMessage`, when provided, pins resolution to that specific inbound
   * message (the one being replied to) instead of the per-jid last-inbound
   * anchor — concurrency-safe so a reply isn't routed into an unrelated
   * thread that arrived mid-run.
   */
  private async resolveReplyTarget(
    jid: string,
    anchorMessage?: Message,
  ): Promise<unknown> {
    const anchor = anchorMessage ?? this.lastReplyAnchor.get(jid);
    if (anchor) {
      const anchorChannel = anchor.channel as { isThread?: () => boolean };
      const anchorIsThread =
        typeof anchorChannel.isThread === 'function' &&
        anchorChannel.isThread();
      if (anchorIsThread) {
        return anchor.channel;
      }
      if (anchor.guild && typeof anchor.startThread === 'function') {
        try {
          return await anchor.startThread({
            name: threadNameFromMessage(anchor),
            autoArchiveDuration: 1440,
          });
        } catch (err) {
          logger.warn(
            { jid, err },
            'Failed to start Discord thread — replying in channel',
          );
        }
      }
    }
    const channelId = jid.replace(/^dc:/, '');
    return await this.client!.channels.fetch(channelId);
  }

  /**
   * Fetch a channel's recent message history, returning messages oldest-first
   * so a reader can scan chronologically. Bounded by `limit` (hard cap
   * {@link HISTORY_HARD_MAX}) and, optionally, by `sinceIso` (stop once
   * messages predate that instant).
   *
   * **Forum / media channels** (which hold no messages of their own — content
   * lives in per-post threads) are handled transparently: the threads are
   * enumerated (active + archived) and their messages aggregated, each tagged
   * with its originating `thread`. For a plain text channel or thread, the
   * channel's own messages are paginated backward (from `before` if given).
   *
   * The bot must be able to see the channel (be in the guild and hold Read
   * Message History permission); otherwise discord.js throws and the caller
   * surfaces the error. Works on channels that are NOT registered groups —
   * this is the one read path that reaches beyond live, registered traffic.
   */
  async fetchChannelHistory(
    channelId: string,
    opts: FetchChannelHistoryOpts = {},
  ): Promise<DiscordHistoryMessage[]> {
    if (!this.client) throw new Error('Discord client not initialized');
    const limit = Math.min(
      Math.max(Math.floor(opts.limit ?? 200), 1),
      HISTORY_HARD_MAX,
    );
    const sinceMs = opts.sinceIso ? Date.parse(opts.sinceIso) : NaN;
    if (opts.sinceIso && Number.isNaN(sinceMs)) {
      throw new Error(`Invalid "since" date: ${opts.sinceIso}`);
    }

    const channel = await this.client.channels.fetch(channelId);
    if (!channel) {
      throw new Error(`Channel ${channelId} not found`);
    }

    // Forum / media channels carry no messages directly — their content lives
    // in threads (one per post). Enumerate and aggregate across those.
    const channelType = (channel as { type?: number }).type;
    if (
      channelType === ChannelType.GuildForum ||
      channelType === ChannelType.GuildMedia
    ) {
      return this.fetchForumHistory(
        channel as unknown as ForumLike,
        channelId,
        {
          limit,
          sinceMs,
          sinceIso: opts.sinceIso,
        },
      );
    }

    if (!('messages' in channel)) {
      throw new Error(`Channel ${channelId} has no readable message history`);
    }
    const messages = (channel as unknown as { messages: MessagesManagerLike })
      .messages;

    const out = await this.paginateMessages(messages, {
      limit,
      sinceMs,
      before: opts.before,
    });
    // Collected newest-first; hand back oldest-first.
    out.reverse();
    logger.info(
      { channelId, count: out.length, limit, since: opts.sinceIso },
      'Discord channel history fetched',
    );
    return out;
  }

  /**
   * Paginate one message manager (a text channel or a thread) backward from
   * the newest message (or `before`), newest-first, stopping at `limit` or
   * once messages predate `sinceMs`. Each message is tagged with `thread`
   * when supplied. Shared by the text-channel and forum-thread paths.
   */
  private async paginateMessages(
    messages: MessagesManagerLike,
    opts: {
      limit: number;
      sinceMs: number;
      before?: string;
      thread?: { id: string; name: string };
    },
  ): Promise<DiscordHistoryMessage[]> {
    const out: DiscordHistoryMessage[] = [];
    let before = opts.before;
    let reachedSince = false;

    while (out.length < opts.limit && !reachedSince) {
      const pageSize = Math.min(HISTORY_PAGE_SIZE, opts.limit - out.length);
      const batch = await messages.fetch({ limit: pageSize, before });
      // discord.js returns a Collection (Map subclass), newest-first.
      const page = [...batch.values()];
      if (page.length === 0) break;
      for (const m of page) {
        const ts = m.createdTimestamp ?? 0;
        if (!Number.isNaN(opts.sinceMs) && ts < opts.sinceMs) {
          reachedSince = true;
          break;
        }
        out.push(toHistoryMessage(m, opts.thread));
      }
      before = page[page.length - 1]?.id;
      // A short page means we've exhausted the channel.
      if (page.length < pageSize) break;
    }
    return out;
  }

  /**
   * Aggregate a forum/media channel's history by enumerating its threads
   * (active + archived public) and reading each thread's messages, newest
   * threads first, up to the shared `limit` budget. Results are returned
   * chronologically (oldest-first) with each message tagged by its thread.
   */
  private async fetchForumHistory(
    forum: ForumLike,
    channelId: string,
    opts: { limit: number; sinceMs: number; sinceIso?: string },
  ): Promise<DiscordHistoryMessage[]> {
    const threads = await this.collectForumThreads(forum, opts.sinceMs);

    const out: DiscordHistoryMessage[] = [];
    for (const thread of threads) {
      if (out.length >= opts.limit) break;
      const msgs = await this.paginateMessages(thread.messages, {
        limit: opts.limit - out.length,
        sinceMs: opts.sinceMs,
        thread: { id: thread.id, name: thread.name || 'thread' },
      });
      out.push(...msgs);
    }

    // Messages were gathered per-thread; sort the whole set chronologically so
    // a reader (e.g. tallying hours) sees one coherent timeline.
    out.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    logger.info(
      {
        channelId,
        threads: threads.length,
        count: out.length,
        limit: opts.limit,
        since: opts.sinceIso,
      },
      'Discord forum history fetched',
    );
    return out;
  }

  /**
   * Collect a forum's candidate threads: all active threads, then archived
   * public threads paginated newest-archived-first until we pass the `sinceMs`
   * window or hit {@link FORUM_ARCHIVED_PAGE_CAP}. Threads are de-duplicated by
   * id and filtered to this forum (defensive — fetchActive is channel-scoped).
   */
  private async collectForumThreads(
    forum: ForumLike,
    sinceMs: number,
  ): Promise<ThreadLike[]> {
    const byId = new Map<string, ThreadLike>();
    const add = (t: ThreadLike) => {
      if (t.parentId && t.parentId !== forum.id) return;
      if (!byId.has(t.id)) byId.set(t.id, t);
    };

    const active = await forum.threads.fetchActive();
    for (const t of active.threads.values()) add(t);

    let before: string | undefined;
    let capped = false;
    for (let page = 0; page < FORUM_ARCHIVED_PAGE_CAP; page++) {
      const archived = await forum.threads.fetchArchived({
        type: 'public',
        limit: HISTORY_PAGE_SIZE,
        before,
      });
      const batch = [...archived.threads.values()];
      if (batch.length === 0) break;

      let allBeforeWindow = true;
      let oldestTs: number | undefined;
      for (const t of batch) {
        add(t);
        const archiveTs =
          t.archiveTimestamp ?? t.archivedAt?.getTime() ?? undefined;
        if (archiveTs !== undefined) {
          oldestTs =
            oldestTs === undefined ? archiveTs : Math.min(oldestTs, archiveTs);
        }
        if (
          Number.isNaN(sinceMs) ||
          archiveTs === undefined ||
          archiveTs >= sinceMs
        ) {
          allBeforeWindow = false;
        }
      }

      // Past the requested window — older archived threads can't contribute.
      if (!Number.isNaN(sinceMs) && allBeforeWindow) break;
      if (!archived.hasMore) break;
      if (oldestTs === undefined) break;
      before = new Date(oldestTs).toISOString();
      if (page === FORUM_ARCHIVED_PAGE_CAP - 1) capped = true;
    }

    if (capped) {
      logger.warn(
        { forumId: forum.id, pageCap: FORUM_ARCHIVED_PAGE_CAP },
        'Forum archived-thread enumeration hit page cap — older posts may be omitted; narrow with "since"',
      );
    }
    return [...byId.values()];
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:') || jid.startsWith(DISCORD_DM_JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    if (this.dmRefreshTimer) {
      clearInterval(this.dmRefreshTimer);
      this.dmRefreshTimer = null;
    }
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  /**
   * Add an emoji reaction to a message. Used by the orchestrator's ACK
   * pattern: 👀 on receipt, 🤔 while working. Slack-style names are mapped
   * to Unicode; raw Unicode emojis pass through.
   */
  async addReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    if (!this.client) return;
    const resolved = EMOJI_MAP[emoji] || emoji;
    try {
      const channelId = this.resolveMessageChannelId(jid, messageId);
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return;
      const message = await (channel as TextChannel).messages.fetch(messageId);
      await message.react(resolved);
    } catch (err) {
      logger.warn(
        { jid, messageId, emoji, err },
        'Failed to add Discord reaction',
      );
    }
  }

  /**
   * Remove the bot's own reaction with the given emoji from a message.
   * No-op if the reaction isn't present.
   */
  async removeReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    if (!this.client || !this.client.user) return;
    const resolved = EMOJI_MAP[emoji] || emoji;
    const botId = this.client.user.id;
    try {
      const channelId = this.resolveMessageChannelId(jid, messageId);
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return;
      const message = await (channel as TextChannel).messages.fetch(messageId);
      const reaction = message.reactions.cache.get(resolved);
      if (reaction) await reaction.users.remove(botId);
    } catch (err) {
      logger.warn(
        { jid, messageId, emoji, err },
        'Failed to remove Discord reaction',
      );
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      // Prefer the channel the most recent inbound message arrived in —
      // for thread-routed messages that's the thread itself, where the
      // user is actually watching for the typing indicator.
      const anchorChannelId = this.lastReplyAnchor.get(jid)?.channelId;
      const channelId = anchorChannelId ?? jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }

  /**
   * Discord channel id where a given message actually lives. Returns the
   * recorded thread channel id when the message was routed under a parent
   * jid, otherwise strips the prefix off the jid.
   */
  private resolveMessageChannelId(jid: string, messageId: string): string {
    return (
      this.messageChannelOverride.get(messageId) ?? jid.replace(/^dc:/, '')
    );
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
