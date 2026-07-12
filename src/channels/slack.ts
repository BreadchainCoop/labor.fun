import fs from 'fs';
import path from 'path';

import { App, LogLevel } from '@slack/bolt';
import type {
  GenericMessageEvent,
  BotMessageEvent,
  AssistantThreadStartedEvent,
} from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logReaction, storeOutboundMessage, updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { SlackHttpReceiver } from './slack-http-receiver.js';
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

// Slack's native AI Assistant surface (split-view assistant pane) is gated
// behind this env flag. Default OFF → existing behavior is byte-for-byte
// unchanged: no assistant_thread_started handler is registered, no
// assistant.threads.* Web API calls are made, and message.im events flow
// through the normal path exactly as before.
//   docs.slack.dev/ai — events: assistant_thread_started,
//   assistant_thread_context_changed, message.im; Web API methods:
//   assistant.threads.setStatus / setSuggestedPrompts / setTitle; scope:
//   assistant:write.
// `env` is the object already read from readEnvFile — process.env wins over it,
// matching the SLACK_* precedence used everywhere else in this file.
function assistantSurfaceEnabled(env: Record<string, string>): boolean {
  const raw =
    process.env.SLACK_ASSISTANT_ENABLED || env.SLACK_ASSISTANT_ENABLED;
  return String(raw).toLowerCase() === 'true';
}

// On-brand suggested prompts shown when a user opens the assistant pane.
// Slack allows up to four; each needs a title (button label) and a message
// (the text sent as if the user typed it). Kept generic/framework-level — no
// hardcoded org identity (see CLAUDE.md: derive brand from profile/config).
const ASSISTANT_SUGGESTED_PROMPTS: Array<{ title: string; message: string }> = [
  { title: "What's on our agenda?", message: "What's on our agenda?" },
  {
    title: 'Summarize this channel',
    message: 'Summarize the recent activity in this channel.',
  },
  {
    title: 'Open a GitHub issue',
    message: 'Open a GitHub issue for me.',
  },
];

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
  // Auto-register a 1:1 DM whose sender is a known KB person. Returns true when
  // the channel is (now) registered and the message should be processed.
  ensureDmRegistered?: (
    jid: string,
    platform: string,
    senderId: string,
  ) => boolean;
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
  // "<jid>:<message ts>" → its thread_ts, so a reply can be pinned to the
  // thread of the exact message that triggered the run rather than whatever
  // arrived last on this channel. The per-channel lastThreadTs gets overwritten
  // by a concurrent message in another thread, which posted replies in the
  // wrong thread (#46). Keyed by jid + ts (not ts alone) since a ts is only
  // meaningful within its channel. Capped LRU.
  private threadTsById = new Map<string, string>();
  private static readonly THREAD_TS_BY_ID_MAX = 500;

  // Native AI Assistant surface (SLACK_ASSISTANT_ENABLED=true).
  private assistantEnabled = false;
  // Assistant thread roots we've seen, keyed by jid (`slack:<channel>`) → the
  // assistant thread's thread_ts. A message.im whose thread_ts is in here is an
  // assistant-pane message (vs a plain DM); we set a thinking status for it and
  // clear that status when the agent's reply is posted.
  private assistantThreads = new Map<string, string>();
  private static readonly ASSISTANT_THREADS_MAX = 500;
  // Assistant threads with an active "is thinking…" status, keyed
  // `<jid>:<threadTs>`. The agent runner streams its reply as one or more
  // discrete text segments (each a separate sendMessage — the framework has no
  // token-level deltas), so the status is set once when the turn starts and
  // cleared once when the first reply segment lands. Tracking membership here
  // makes clearing idempotent across multi-segment (streamed) replies.
  private assistantPendingStatus = new Set<string>();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Config is sourced from process.env first (hosted: Kubernetes tenant pods
    // inject these via envFrom secretRef, with no .env file present), falling
    // back to .env for self-hosted/dev. process.env wins over .env. Matches the
    // control-plane-sync / container-runner `process.env.X || env.X` convention.
    const env = readEnvFile([
      'SLACK_BOT_TOKEN',
      'SLACK_APP_TOKEN',
      'SLACK_RECEIVER_MODE',
      'SLACK_HTTP_PORT',
      'SLACK_INGRESS_SECRET',
      'SLACK_SIGNING_SECRET',
      'SLACK_ASSISTANT_ENABLED',
    ]);
    this.assistantEnabled = assistantSurfaceEnabled(env);
    const botToken = process.env.SLACK_BOT_TOKEN || env.SLACK_BOT_TOKEN;
    const appToken = process.env.SLACK_APP_TOKEN || env.SLACK_APP_TOKEN;
    const receiverMode =
      process.env.SLACK_RECEIVER_MODE || env.SLACK_RECEIVER_MODE;
    const httpPort = process.env.SLACK_HTTP_PORT || env.SLACK_HTTP_PORT;
    const ingressSecret =
      process.env.SLACK_INGRESS_SECRET || env.SLACK_INGRESS_SECRET;
    const signingSecret =
      process.env.SLACK_SIGNING_SECRET || env.SLACK_SIGNING_SECRET;
    const mode = (receiverMode || 'socket').toLowerCase();

    if (mode === 'http') {
      // HTTP receiver mode: Slack Events API over HTTP POST /slack/events.
      // Used by the hosted control-plane ingress (one multi-workspace Slack
      // app forwarding events per tenant) or for direct Events API exposure.
      // No app-level token needed — outbound still uses the bot token, and
      // app.start()/stop() delegate to the receiver, so connect()/disconnect()
      // work unchanged. All event handlers below are shared with socket mode.
      if (!botToken) {
        throw new Error('SLACK_BOT_TOKEN must be set in .env');
      }
      if (!ingressSecret && !signingSecret) {
        const msg =
          'SLACK_RECEIVER_MODE=http requires SLACK_INGRESS_SECRET ' +
          '(forwarded-from-ingress) or SLACK_SIGNING_SECRET (direct Slack ' +
          'exposure) to be set in .env';
        logger.error(msg);
        throw new Error(msg);
      }
      const receiver = new SlackHttpReceiver({
        port: Number(httpPort) || 3012,
        ingressSecret,
        signingSecret,
      });
      this.app = new App({
        token: botToken,
        receiver,
        logLevel: LogLevel.ERROR,
      });
    } else {
      // Socket Mode (default): unchanged behavior.
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
    }

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Native AI Assistant surface — only wired when SLACK_ASSISTANT_ENABLED=true.
    // When off, this handler is never registered, so the app's event surface is
    // identical to before (message handler only) and no assistant.threads.* Web
    // API calls can ever fire. We use the raw Web API client (app.client.
    // assistant.threads.*) rather than Bolt's Assistant class on purpose: the
    // Assistant class strips next() and swallows assistant-thread message.im
    // events before they reach app.event('message'), which would force us to
    // duplicate the whole onMessage pipeline. Handling assistant_thread_started
    // here and letting message.im flow through the existing handler keeps a
    // single message entry point and reuses the agent path unchanged.
    if (this.assistantEnabled) {
      this.app.event(
        'assistant_thread_started',
        async ({ event }: { event: AssistantThreadStartedEvent }) => {
          await this.onAssistantThreadStarted(event);
        },
      );
    }

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
        // Resolve any remaining <@U…> mentions to readable names so the agent
        // can identify who was mentioned (e.g. for calendar invitees).
        content = await this.resolveMentions(content);

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

      // Only deliver full messages for registered groups. An unregistered
      // 1:1 DM (channel_type 'im') from a known KB person is auto-registered so
      // any teammate can DM the bot without a per-DM admin step; groups, bot
      // messages, and unknown senders are still dropped.
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) {
        const fromBot = !!msg.bot_id || msg.user === this.botUserId;
        if (
          isGroup ||
          fromBot ||
          !msg.user ||
          !this.opts.ensureDmRegistered?.(jid, 'slack', msg.user)
        ) {
          return;
        }
      }

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
      // Resolve any remaining <@U…> mentions to readable names so the agent
      // can identify who was mentioned (e.g. for calendar invitees).
      content = await this.resolveMentions(content);

      // Track thread context so replies go back to the thread.
      // thread_ts === ts means this IS the parent; only track actual replies.
      const threadTs = (msg as GenericMessageEvent).thread_ts;
      if (threadTs && threadTs !== msg.ts) {
        this.lastThreadTs.set(jid, threadTs);
        // Index by jid + message id (ts) so a reply can be pinned to this exact
        // message's thread regardless of what else arrives concurrently, and
        // without colliding with an identical ts in another channel.
        this.threadTsById.set(`${jid}:${msg.ts}`, threadTs);
        if (this.threadTsById.size > SlackChannel.THREAD_TS_BY_ID_MAX) {
          const oldestKey = this.threadTsById.keys().next().value;
          if (oldestKey !== undefined) this.threadTsById.delete(oldestKey);
        }
      }

      // Native AI Assistant surface: if this real user message lands in an
      // assistant thread we opened, show the "is thinking…" status while the
      // existing agent path runs. The status is cleared when sendMessage posts
      // the reply (which threads back into this same assistant thread via
      // threadTsById → replyToMessageId). Best-effort: never block delivery.
      if (
        this.assistantEnabled &&
        !isBotMessage &&
        threadTs &&
        this.assistantThreads.get(jid) === threadTs
      ) {
        this.assistantPendingStatus.add(`${jid}:${threadTs}`);
        void this.setAssistantStatus(
          jid,
          msg.channel,
          threadTs,
          'is thinking…',
        );
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

  /**
   * Handle `assistant_thread_started`: greet the user in the assistant pane,
   * offer on-brand suggested prompts, and set a friendly thread title. All
   * calls are best-effort — a failure here must never break the assistant.
   *
   * Uses the Web API directly (assistant.threads.setSuggestedPrompts,
   * assistant.threads.setTitle) — scope: assistant:write. Posting the greeting
   * reuses the existing chat.postMessage path (thread_ts pins it into the pane).
   */
  private async onAssistantThreadStarted(
    event: AssistantThreadStartedEvent,
  ): Promise<void> {
    const { channel_id: channelId, thread_ts: threadTs } =
      event.assistant_thread;
    const jid = `slack:${channelId}`;

    // Remember this thread so the message handler can distinguish assistant-pane
    // messages from plain DMs and set a thinking status for them.
    this.assistantThreads.set(jid, threadTs);
    if (this.assistantThreads.size > SlackChannel.ASSISTANT_THREADS_MAX) {
      const oldest = this.assistantThreads.keys().next().value;
      if (oldest !== undefined) this.assistantThreads.delete(oldest);
    }
    // Pin replies for this thread to the assistant thread root.
    this.threadTsById.set(`${jid}:${threadTs}`, threadTs);

    try {
      await this.app.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Hi! I'm ${ASSISTANT_NAME}. Ask me anything, or pick a prompt below to get started.`,
      });
    } catch (err) {
      logger.warn({ jid, err }, 'Assistant greeting failed');
    }

    try {
      await this.app.client.assistant.threads.setSuggestedPrompts({
        channel_id: channelId,
        thread_ts: threadTs,
        prompts: ASSISTANT_SUGGESTED_PROMPTS,
      });
    } catch (err) {
      logger.warn({ jid, err }, 'Assistant setSuggestedPrompts failed');
    }

    try {
      await this.app.client.assistant.threads.setTitle({
        channel_id: channelId,
        thread_ts: threadTs,
        title: `Chat with ${ASSISTANT_NAME}`,
      });
    } catch (err) {
      logger.debug({ jid, err }, 'Assistant setTitle failed (non-fatal)');
    }
  }

  /**
   * Set (or clear, with an empty string) the assistant thread status shown in
   * the pane. assistant.threads.setStatus — scope: assistant:write.
   */
  private async setAssistantStatus(
    jid: string,
    channelId: string,
    threadTs: string,
    status: string,
  ): Promise<void> {
    try {
      await this.app.client.assistant.threads.setStatus({
        channel_id: channelId,
        thread_ts: threadTs,
        status,
      });
    } catch (err) {
      logger.debug({ jid, err }, 'Assistant setStatus failed (non-fatal)');
    }
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
  ): Promise<boolean> {
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      // Accepted for guaranteed delivery on reconnect (the queue is drained
      // when the socket comes back), so this is a success, not a drop.
      return true;
    }

    // Reply in-thread, anchored to the message that triggered this run.
    // If that message was itself inside a thread, reply into that same thread
    // (threadTsById holds its parent thread_ts). Otherwise root a new thread on
    // the triggering message by using its own ts as thread_ts — so the bot's
    // reply always lands as a threaded reply to the user's original message,
    // even when that message was posted at the channel root. Anchoring to the
    // exact triggering message (not the per-channel last-seen thread) keeps this
    // concurrency-safe. For proactive/agent-initiated sends (no replyToMessageId)
    // there is no originating message, so fall back to the last-seen thread.
    const threadTs = opts?.replyToMessageId
      ? this.threadTsById.get(`${jid}:${opts.replyToMessageId}`) ||
        opts.replyToMessageId
      : this.lastThreadTs.get(jid);
    const baseOpts: { channel: string; text?: string; thread_ts?: string } = {
      channel: channelId,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    };

    // Native AI Assistant surface: clear the "is thinking…" status just before
    // the first reply segment lands, if this reply threads into a known
    // assistant thread that still has an active status. Empty string removes the
    // indicator. The agent may stream several segments (each its own
    // sendMessage); we only clear once (the set makes this idempotent) so later
    // segments don't re-clear/flicker. Best-effort.
    if (
      this.assistantEnabled &&
      threadTs &&
      this.assistantThreads.get(jid) === threadTs &&
      this.assistantPendingStatus.delete(`${jid}:${threadTs}`)
    ) {
      await this.setAssistantStatus(jid, channelId, threadTs, '');
    }

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
      return true;
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
      // Re-queued for retry on reconnect — treat as accepted, not dropped.
      return true;
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

  /**
   * Replace Slack user mentions (`<@U123>` or `<@U123|handle>`) in message text
   * with a readable `@Name`, so the agent sees who was mentioned instead of an
   * opaque ID it cannot map. The bot's own mention resolves to ASSISTANT_NAME;
   * others resolve via users.info (cached). IDs that don't resolve are left
   * untouched. Brings Slack to parity with Discord/Telegram, which already hand
   * the agent display names rather than raw IDs.
   */
  private async resolveMentions(content: string): Promise<string> {
    if (!content) return content;
    // User mentions are `<@U…>` (or `<@W…>` on Enterprise Grid), optionally
    // `<@U…|handle>`. Channel (`<#C…>`) and special (`<!here>`) mentions are
    // intentionally left untouched.
    const MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]+)?>/g;
    const ids = new Set<string>();
    for (const m of content.matchAll(MENTION_RE)) ids.add(m[1]);
    if (ids.size === 0) return content;

    const names = new Map<string, string>();
    for (const id of ids) {
      if (id === this.botUserId) {
        names.set(id, ASSISTANT_NAME);
        continue;
      }
      const name = await this.resolveUserName(id);
      if (name) names.set(id, name);
    }

    return content.replace(MENTION_RE, (full, id) => {
      const name = names.get(id);
      return name ? `@${name}` : full;
    });
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
  // Config is sourced from process.env first (hosted: envFrom secretRef),
  // falling back to .env for self-hosted/dev; process.env wins over .env.
  const envVars = readEnvFile([
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'SLACK_RECEIVER_MODE',
    'SLACK_INGRESS_SECRET',
    'SLACK_SIGNING_SECRET',
  ]);
  const botToken = process.env.SLACK_BOT_TOKEN || envVars.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN || envVars.SLACK_APP_TOKEN;
  const receiverMode =
    process.env.SLACK_RECEIVER_MODE || envVars.SLACK_RECEIVER_MODE;
  const ingressSecret =
    process.env.SLACK_INGRESS_SECRET || envVars.SLACK_INGRESS_SECRET;
  const signingSecret =
    process.env.SLACK_SIGNING_SECRET || envVars.SLACK_SIGNING_SECRET;
  const mode = (receiverMode || 'socket').toLowerCase();
  if (mode === 'http') {
    // HTTP mode needs the bot token plus one verification secret — the
    // app-level (Socket Mode) token is NOT required.
    if (!botToken || (!ingressSecret && !signingSecret)) {
      logger.warn(
        'Slack (http mode): SLACK_BOT_TOKEN plus SLACK_INGRESS_SECRET or ' +
          'SLACK_SIGNING_SECRET must be set',
      );
      return null;
    }
  } else if (!botToken || !appToken) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
