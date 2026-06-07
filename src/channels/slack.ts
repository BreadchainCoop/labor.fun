import fs from 'fs';
import path from 'path';

import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logReaction, storeOutboundMessage, updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
  SendMessageOpts,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined), bot messages
// (BotMessageEvent, subtype 'bot_message'), and message edits ('message_changed').
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

// Slack's message_changed event wraps the edited message in event.message
interface MessageChangedEvent {
  subtype: 'message_changed';
  channel: string;
  channel_type?: string;
  message: {
    user?: string;
    text?: string;
    ts: string;
    thread_ts?: string;
    bot_id?: string;
  };
  previous_message?: {
    text?: string;
  };
  ts: string;
}

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  // Track the latest thread_ts per channel so outbound messages reply in-thread
  private lastThreadTs = new Map<string, string>();
  // message ts → its thread_ts, so a reply can be pinned to the thread of the
  // exact message that triggered the run rather than whatever arrived last on
  // this channel. The per-channel lastThreadTs gets overwritten by a
  // concurrent message in another thread, which posted replies in the wrong
  // thread (#46). Capped LRU.
  private threadTsById = new Map<string, string>();
  private static readonly THREAD_TS_BY_ID_MAX = 500;

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    // and message_changed (edits).
    this.app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the types we handle.
      const subtype = (event as { subtype?: string }).subtype;

      // Handle message edits: extract the edited message from event.message
      if (subtype === 'message_changed') {
        const changed = event as unknown as MessageChangedEvent;
        const inner = changed.message;
        if (!inner?.text) return;

        const jid = `slack:${changed.channel}`;
        const timestamp = new Date(parseFloat(inner.ts) * 1000).toISOString();
        const isGroup =
          (changed as { channel_type?: string }).channel_type !== 'im';

        this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

        const groups = this.opts.registeredGroups();
        if (!groups[jid]) return;

        const isBotMessage = !!inner.bot_id || inner.user === this.botUserId;

        let senderName: string;
        if (isBotMessage) {
          senderName = ASSISTANT_NAME;
        } else {
          senderName =
            (inner.user ? await this.resolveUserName(inner.user) : undefined) ||
            inner.user ||
            'unknown';
        }

        let content = inner.text;
        if (this.botUserId && !isBotMessage) {
          const mentionPattern = `<@${this.botUserId}>`;
          if (
            content.includes(mentionPattern) &&
            !TRIGGER_PATTERN.test(content)
          ) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }

        // Track thread context for edited messages too
        const threadTs = inner.thread_ts;
        if (threadTs && threadTs !== inner.ts) {
          this.lastThreadTs.set(jid, threadTs);
        }

        this.opts.onMessage(jid, {
          id: inner.ts,
          chat_jid: jid,
          sender: inner.user || inner.bot_id || '',
          sender_name: senderName,
          content: `[edited] ${content}`,
          timestamp,
          is_from_me: isBotMessage,
          is_bot_message: isBotMessage,
          thread_id: threadTs && threadTs !== inner.ts ? threadTs : undefined,
        });
        return;
      }

      if (subtype && subtype !== 'bot_message' && subtype !== 'file_share')
        return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;

      // Handle file uploads — download and include paths in content
      const files = (msg as any).files as any[] | undefined;
      let fileContent = '';
      if (files?.length) {
        const jid = `slack:${msg.channel}`;
        const group = this.opts.registeredGroups()[jid];
        if (group) {
          const groupDir = resolveGroupFolderPath(group.folder);
          const attachDir = path.join(groupDir, 'attachments');
          fs.mkdirSync(attachDir, { recursive: true });

          for (const file of files) {
            const filename = (file.name || `file_${file.id}`).replace(
              /[^a-zA-Z0-9._-]/g,
              '_',
            );
            const fileMode = file.mode || 'hosted'; // hosted, external, snippet, etc.

            logger.debug(
              {
                filename,
                mode: fileMode,
                mimetype: file.mimetype,
                id: file.id,
              },
              'Processing Slack file',
            );

            // External files (Google Drive, etc.) can't be downloaded via Slack API —
            // url_private_download returns a Slack preview page, not the real file.
            if (fileMode === 'external') {
              const externalUrl = file.url_private || file.permalink;
              fileContent += ` [External file: ${file.name || filename}] (${externalUrl || 'no URL'})`;
              logger.info(
                { filename, mode: fileMode },
                'External file — linked, not downloaded',
              );
              continue;
            }

            // For hosted files, download via url_private_download
            const downloadUrl = file.url_private_download || file.url_private;
            if (downloadUrl) {
              try {
                const env = readEnvFile(['SLACK_BOT_TOKEN']);
                const token =
                  process.env.SLACK_BOT_TOKEN || env.SLACK_BOT_TOKEN;
                const resp = await fetch(downloadUrl, {
                  headers: { Authorization: `Bearer ${token}` },
                });
                if (resp.ok) {
                  const contentType = resp.headers.get('content-type') || '';
                  // Guard: if Slack returns HTML instead of the actual file, treat as external
                  if (
                    contentType.includes('text/html') &&
                    !file.mimetype?.includes('html')
                  ) {
                    logger.warn(
                      { filename, contentType },
                      'Slack returned HTML instead of file — treating as external',
                    );
                    fileContent += ` [File: ${file.name || filename}] (could not download — try sharing the file directly)`;
                    continue;
                  }
                  const buffer = Buffer.from(await resp.arrayBuffer());
                  const destPath = path.join(attachDir, filename);
                  fs.writeFileSync(destPath, buffer);
                  fileContent += ` [File: ${file.name || filename}] (/workspace/group/attachments/${filename})`;
                  logger.info(
                    { filename, jid, size: buffer.length },
                    'Slack file downloaded',
                  );
                }
              } catch (err) {
                logger.warn({ filename, err }, 'Failed to download Slack file');
                fileContent += ` [File: ${file.name || filename}]`;
              }
            } else {
              fileContent += ` [File: ${file.name || filename}]`;
            }
          }
        }
      }

      if (!msg.text && !fileContent) return;

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) return;

      const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
      let content = (msg.text || '') + fileContent;
      if (this.botUserId && !isBotMessage) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (
          content.includes(mentionPattern) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Track thread context so replies go back to the thread.
      // thread_ts === ts means this IS the parent; only track actual replies.
      const threadTs = (msg as GenericMessageEvent).thread_ts;
      if (threadTs && threadTs !== msg.ts) {
        this.lastThreadTs.set(jid, threadTs);
        // Index by message id (ts) so a reply can be pinned to this exact
        // message's thread regardless of what else arrives concurrently.
        this.threadTsById.set(msg.ts, threadTs);
        if (this.threadTsById.size > SlackChannel.THREAD_TS_BY_ID_MAX) {
          const oldestKey = this.threadTsById.keys().next().value;
          if (oldestKey !== undefined) this.threadTsById.delete(oldestKey);
        }
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
        thread_id: threadTs && threadTs !== msg.ts ? threadTs : undefined,
      });
    });
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(
    jid: string,
    text: string,
    opts?: SendMessageOpts,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    // Reply in-thread. Prefer the thread of the exact message being replied to
    // (concurrency-safe); fall back to the per-channel last-seen thread for
    // proactive/agent-initiated sends. A top-level trigger has no thread entry,
    // so the reply correctly posts at the channel root.
    const threadTs = opts?.replyToMessageId
      ? this.threadTsById.get(opts.replyToMessageId)
      : this.lastThreadTs.get(jid);
    const baseOpts: { channel: string; text?: string; thread_ts?: string } = {
      channel: channelId,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    };

    try {
      // Slack limits messages to ~4000 characters; split if needed.
      // Guard res?.ts and wrap storeOutboundMessage so that DB or response
      // edge cases don't abort the splitting loop or skip lastThreadTs.delete.
      if (text.length <= MAX_MESSAGE_LENGTH) {
        const res = await this.app.client.chat.postMessage({
          ...baseOpts,
          text,
        });
        if (res?.ts) {
          try {
            storeOutboundMessage(jid, res.ts as string, text, ASSISTANT_NAME);
          } catch (err) {
            logger.warn(
              { err, jid },
              'storeOutboundMessage failed (continuing)',
            );
          }
        }
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          const chunk = text.slice(i, i + MAX_MESSAGE_LENGTH);
          const res = await this.app.client.chat.postMessage({
            ...baseOpts,
            text: chunk,
          });
          if (res?.ts) {
            try {
              storeOutboundMessage(
                jid,
                res.ts as string,
                chunk,
                ASSISTANT_NAME,
              );
            } catch (err) {
              logger.warn(
                { err, jid },
                'storeOutboundMessage failed (continuing)',
              );
            }
          }
        }
      }
      // Clear thread context after responding so subsequent scheduled/proactive
      // messages go to the channel, not a stale thread
      this.lastThreadTs.delete(jid);
      logger.info(
        { jid, length: text.length, inThread: !!threadTs },
        'Slack message sent',
      );
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  // Slack does not expose a typing indicator API for bots.
  // This no-op satisfies the Channel interface so the orchestrator
  // doesn't need channel-specific branching.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Slack Bot API has no typing indicator endpoint
  }

  /**
   * Send a message and return its timestamp (Slack's message ID) for later editing/deletion.
   */
  async sendMessageWithId(
    jid: string,
    text: string,
  ): Promise<string | undefined> {
    const channelId = jid.replace(/^slack:/, '');
    const threadTs = this.lastThreadTs.get(jid);
    try {
      const result = await this.app.client.chat.postMessage({
        channel: channelId,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      return result.ts;
    } catch (err) {
      logger.warn({ jid, err }, 'Failed to send Slack message with ID');
      return undefined;
    }
  }

  /**
   * Edit a previously sent message in place.
   */
  async updateStatus(
    jid: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    try {
      await this.app.client.chat.update({
        channel: channelId,
        ts: messageId,
        text,
      });
    } catch (err) {
      logger.warn({ jid, messageId, err }, 'Failed to update Slack message');
    }
  }

  /**
   * Delete a previously sent message.
   */
  async deleteMessage(jid: string, messageId: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    try {
      await this.app.client.chat.delete({ channel: channelId, ts: messageId });
    } catch (err) {
      logger.warn({ jid, messageId, err }, 'Failed to delete Slack message');
    }
  }

  /**
   * Add an emoji reaction to a message.
   */
  async addReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    try {
      await this.app.client.reactions.add({
        channel: channelId,
        timestamp: messageId,
        name: emoji,
      });
      logReaction(jid, messageId, emoji, 'add');
    } catch (err) {
      logger.warn(
        { jid, messageId, emoji, err },
        'Failed to add Slack reaction',
      );
    }
  }

  /**
   * Remove an emoji reaction from a message.
   */
  async removeReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    try {
      await this.app.client.reactions.remove({
        channel: channelId,
        timestamp: messageId,
        name: emoji,
      });
      logReaction(jid, messageId, emoji, 'remove');
    } catch (err) {
      logger.warn(
        { jid, messageId, emoji, err },
        'Failed to remove Slack reaction',
      );
    }
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(/^slack:/, '');
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
