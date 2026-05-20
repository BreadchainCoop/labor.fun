import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';

import {
  ASSISTANT_NAME,
  DISCORD_DM_ALLOWED_GUILD_IDS,
  DISCORD_DM_ALLOWED_ROLE_IDS,
  DISCORD_DM_ROLE_REFRESH_INTERVAL,
  TRIGGER_PATTERN,
} from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
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

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private dmRefreshTimer: NodeJS.Timeout | null = null;

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
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle attachments — store placeholders so the agent knows something was sent
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map(
          (att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('image/')) {
              return `[Image: ${att.name || 'image'}]`;
            } else if (contentType.startsWith('video/')) {
              return `[Video: ${att.name || 'video'}]`;
            } else if (contentType.startsWith('audio/')) {
              return `[Audio: ${att.name || 'audio'}]`;
            } else {
              return `[File: ${att.name || 'file'}]`;
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

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
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

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
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
