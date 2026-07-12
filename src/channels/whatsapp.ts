import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  makeWASocket,
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import type {
  GroupMetadata,
  WAMessageKey,
  WASocket,
  proto as ProtoTypes,
} from '@whiskeysockets/baileys';
// proto is not statically analyzable as a named ESM export from this CJS module
import { createRequire } from 'module';
const { proto } = createRequire(import.meta.url)('@whiskeysockets/baileys') as {
  proto: typeof ProtoTypes;
};

import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  INGRESS_HTTP_PORT,
  STORE_DIR,
  WHATSAPP_AUTO_ALLOWLIST_GROUPS,
  WHATSAPP_AUTO_REGISTER_GROUPS,
} from '../config.js';
import {
  getLastGroupSync,
  getMessageContentById,
  setLastGroupSync,
  updateChatName,
} from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import pino from 'pino';

// Baileys requires a pino-compatible logger instance
const baileysLogger = pino({ level: 'silent' });
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import {
  getIngressHttpServer,
  type IngressHttpServer,
} from './ingress-http-server.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { verifyIngressSignature } from './slack-http-receiver.js';
import { whatsappCredsExist } from '../integrations/whatsapp-pairing-broker.js';
import { ensureWhatsAppSenderAllowlisted } from './whatsapp-allowlist.js';
import {
  autoAllowlistMatches,
  deriveWhatsAppGroupFolder,
  parseAutoAllowlist,
  WhatsAppAutoAllowlist,
} from './whatsapp-auto.js';
import { WhatsAppSender, whatsappSenderConfig } from './whatsapp-sender.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  // Needed for WHATSAPP_AUTO_REGISTER_GROUPS; auto-registration is silently
  // disabled when the orchestrator doesn't provide it.
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
  // WHATSAPP_AUTO_REGISTER_GROUPS — register a chat the moment the first
  // inbound message from a still-unregistered chat reaches the bot (the only
  // hook WhatsApp gives us — there is no join event). Default: off.
  autoRegisterGroups?: boolean;
  // WHATSAPP_AUTO_ALLOWLIST_GROUPS raw value ('all' or comma-separated jids) —
  // auto-seed unknown senders in matching groups as KB people.
  // SECURITY: grants full access; trusted groups only. Default: off.
  autoAllowlistGroups?: string;
  // --- Shared-bot INGRESS mode (hosted SaaS) ---
  // When set, the channel runs WITHOUT a Baileys socket: the control plane owns
  // the ONE platform WhatsApp account (a Baileys client the CP runs, linked to
  // the platform number) and POSTs each org's forwarded messages to
  // /whatsapp/messages (HMAC-signed with ingressSecret). All outbound is proxied
  // back through the CP (WhatsAppSender). The tenant never holds WhatsApp creds.
  // Baileys (BYO/per-org pairing) mode leaves this unset.
  ingressSecret?: string;
}

/**
 * The forwarded WhatsApp message payload the control plane POSTs to
 * /whatsapp/messages in ingress mode. The CP forwards ONE org's Baileys
 * `messages.upsert` message verbatim (the same `proto.IWebMessageInfo` shape the
 * BYO socket handler consumes), so the ingress path can adapt it into the SAME
 * transport-agnostic core (processInboundMessage) the Baileys handler uses. This
 * keeps trigger / auto-register / auto-allowlist / formatting identical across
 * both transports.
 *
 * The CP has already resolved LID→phone on its shared socket (it owns the signal
 * repository), so `chatJid` is the phone/group JID to route by. `rawChatJid` is
 * the original remoteJid (kept only for the parity log line the Baileys handler
 * emits when a translated JID matches no registered group).
 */
export interface IngressWhatsAppMessage {
  /** Resolved chat JID (`<id>@g.us` or `<number>@s.whatsapp.net`). */
  chatJid: string;
  /** Original remoteJid before any LID translation (for the no-match log). */
  rawChatJid?: string;
  /** Full participant/sender JID, stored as-is so resolveUser round-trips. */
  sender: string;
  /** WhatsApp push name (display name), if present. */
  senderName?: string;
  /** Extracted message text (conversation/extendedText/caption). */
  content: string;
  /** Message id (`key.id`). */
  id: string;
  /** Unix seconds (Baileys `messageTimestamp`). */
  messageTimestamp: number;
  /** True when the message is the platform account's own outbound (`key.fromMe`). */
  fromMe?: boolean;
}

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';

  private sock!: WASocket;
  private connected = false;
  /** Set when the channel stops itself (invalid/revoked session) — suppresses
   * the reconnect loop so a dead session can't churn the socket forever. */
  private stopped = false;
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;
  /** Cache of recently sent messages for retry requests (max 256 entries). */
  private sentMessageCache = new Map<string, ProtoTypes.IMessage>();
  /** Short-lived cache of phone-normalized group metadata for outbound sends. */
  private groupMetadataCache = new Map<
    string,
    { metadata: GroupMetadata; expiresAt: number }
  >();
  /** Bot's LID user ID (e.g. "80355281346633") for normalizing group mentions. */
  private botLidUser?: string;
  /** Resolve the initial connect() once the first successful open happens. */
  private pendingFirstOpen?: () => void;
  /** Group JID → last-known subject, populated by syncGroupMetadata. Lets
   * auto-registration name a new group without an extra socket round-trip. */
  private groupNameCache = new Map<string, string>();
  private autoAllowlist: WhatsAppAutoAllowlist;

  private opts: WhatsAppChannelOpts;

  // --- Ingress mode state ---
  /** True when running in shared-bot ingress mode (no Baileys socket). */
  private readonly ingress: boolean;
  private readonly ingressSecret: string | undefined;
  private sender: WhatsAppSender | null = null;
  private ingressServer: IngressHttpServer | null = null;
  private ingressConnected = false;

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
    this.autoAllowlist = parseAutoAllowlist(opts.autoAllowlistGroups);
    // Ingress mode iff an ingress secret is provided. The factory only passes
    // one when there is NO linked Baileys session, so the two modes never
    // collide on a single instance.
    this.ingress = !!opts.ingressSecret;
    this.ingressSecret = opts.ingressSecret;
  }

  /**
   * Auto-register a WhatsApp chat when WHATSAPP_AUTO_REGISTER_GROUPS is on.
   * Returns the registered group (existing or newly created), or undefined when
   * the feature is off or registration was rejected. Idempotent.
   *
   * Unlike Telegram (which only auto-registers groups, via a join event),
   * WhatsApp's only hook is the inbound message, so DMs auto-register too —
   * useful for letting a teammate start a 1:1 without a manual step.
   */
  private maybeAutoRegisterGroup(
    chatJid: string,
    isGroup: boolean,
    senderName: string | undefined,
  ): RegisteredGroup | undefined {
    const existing = this.opts.registeredGroups()[chatJid];
    if (existing) return existing;
    if (!this.opts.autoRegisterGroups || !this.opts.registerGroup) {
      return undefined;
    }

    const existingFolders = new Set(
      Object.values(this.opts.registeredGroups()).map((g) => g.folder),
    );
    // Groups: prefer the synced subject; DMs: the sender's push name.
    const name = isGroup
      ? this.groupNameCache.get(chatJid)
      : senderName || undefined;
    const folder = deriveWhatsAppGroupFolder(chatJid, name, existingFolders);
    this.opts.registerGroup(chatJid, {
      name: name || chatJid,
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
        'WhatsApp chat auto-registered',
      );
    }
    return registered;
  }

  /**
   * Auto-seed an unknown sender as an allowlisted KB person when this
   * registered group matches WHATSAPP_AUTO_ALLOWLIST_GROUPS. Failures are
   * logged and never block message delivery.
   *
   * `sender` is the full participant JID (e.g. `<number>@s.whatsapp.net`) —
   * stored as-is so resolveUser(msg.sender, 'whatsapp') round-trips.
   */
  private maybeAutoAllowlistSender(
    chatJid: string,
    isGroup: boolean,
    sender: string,
    senderName: string | undefined,
  ): void {
    if (this.autoAllowlist.mode === 'off') return;
    // Empty, the bot's own JID, or self-chat → nothing to seed.
    if (!sender) return;
    if (
      this.botLidUser &&
      sender.split('@')[0].split(':')[0] === this.botLidUser
    )
      return;
    if (!autoAllowlistMatches(this.autoAllowlist, chatJid, isGroup)) return;
    try {
      ensureWhatsAppSenderAllowlisted({
        whatsappId: sender,
        name: senderName,
      });
    } catch (err) {
      logger.warn({ chatJid, err }, 'WhatsApp auto-allowlist seeding failed');
    }
  }

  async connect(): Promise<void> {
    if (this.ingress) {
      return this.connectIngress();
    }
    return new Promise<void>((resolve, reject) => {
      this.pendingFirstOpen = resolve;
      this.connectInternal().catch(reject);
    });
  }

  // ─── Shared-bot INGRESS transport ────────────────────────────────────────

  /**
   * Connect in ingress mode: register POST /whatsapp/messages on the shared
   * ingress HTTP server (same port as the slack receiver + telegram ingress) and
   * wire up the outbound control-plane proxy. No Baileys socket is constructed —
   * the control plane owns the ONE shared platform WhatsApp account and forwards
   * this org's messages here (signed), receiving our outbound over the proxy.
   */
  private async connectIngress(): Promise<void> {
    const cfg = whatsappSenderConfig();
    if (cfg) {
      this.sender = new WhatsAppSender(cfg);
    } else {
      // Inbound still works; outbound no-ops until CONTROL_PLANE_* is set.
      logger.warn(
        'WhatsApp ingress: CONTROL_PLANE_URL/TOKEN not set — outbound sends will be dropped',
      );
    }

    const secret = this.ingressSecret!;
    const server = getIngressHttpServer(INGRESS_HTTP_PORT, logger);
    this.ingressServer = server;
    server.registerRoute('POST', '/whatsapp/messages', (rawBody, req, res) => {
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
          'WhatsApp ingress rejected request (signature verification failed)',
        );
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        res.writeHead(400);
        res.end('Bad Request');
        return;
      }

      // Ack immediately (200), THEN process — fire-and-forget so slow handlers
      // never delay the ack (mirrors the slack receiver + telegram ingress).
      res.writeHead(200);
      res.end();
      this.processRawMessage(payload);
    });

    await server.start();
    this.ingressConnected = true;
    logger.info(
      { port: INGRESS_HTTP_PORT },
      'WhatsApp ingress connected (shared-bot mode)',
    );
  }

  /**
   * Parse a CP-forwarded WhatsApp message payload and feed the SAME
   * trigger / auto-register / auto-allowlist / onMessage path the Baileys handler
   * uses (processInboundMessage). Accepts either our normalized
   * IngressWhatsAppMessage shape OR a raw Baileys `messages.upsert` message
   * (`{ key, message, pushName, messageTimestamp }`), so the CP can forward
   * verbatim. Never throws — malformed payloads are logged and dropped.
   */
  processRawMessage(payload: unknown): void {
    try {
      const parsed = this.parseIngressMessage(payload);
      if (!parsed) return;
      this.processInboundMessage(parsed);
    } catch (err) {
      logger.error({ err }, 'WhatsApp ingress: failed to process message');
    }
  }

  /**
   * Coerce a forwarded payload into IngressWhatsAppMessage. Supports two shapes:
   *  1. Our normalized shape ({ chatJid, sender, content, id, ... }).
   *  2. A raw Baileys IWebMessageInfo ({ key, message, pushName,
   *     messageTimestamp }) — extracted the same way the Baileys handler does.
   * Returns null when neither yields a routable chat JID (so the caller drops
   * status broadcasts, empty payloads, etc.).
   */
  private parseIngressMessage(payload: unknown): IngressWhatsAppMessage | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as Record<string, any>;

    // Shape 1: already-normalized (preferred v1 contract).
    if (typeof p.chatJid === 'string' && p.chatJid) {
      if (p.chatJid === 'status@broadcast') return null;
      return {
        chatJid: p.chatJid,
        rawChatJid: typeof p.rawChatJid === 'string' ? p.rawChatJid : undefined,
        sender: typeof p.sender === 'string' ? p.sender : '',
        senderName: typeof p.senderName === 'string' ? p.senderName : undefined,
        content: typeof p.content === 'string' ? p.content : '',
        id: typeof p.id === 'string' ? p.id : '',
        messageTimestamp: Number(p.messageTimestamp) || 0,
        fromMe: !!p.fromMe,
      };
    }

    // Shape 2: raw Baileys message forwarded verbatim.
    const key = p.key as Record<string, any> | undefined;
    const rawJid: string | undefined = key?.remoteJid;
    if (!rawJid || rawJid === 'status@broadcast') return null;
    const message = normalizeMessageContent(p.message);
    if (!message) return null;
    const sender: string = key?.participant || key?.remoteJid || '';
    const content =
      message.conversation ||
      message.extendedTextMessage?.text ||
      message.imageMessage?.caption ||
      message.videoMessage?.caption ||
      '';
    return {
      // The CP resolves LID→phone on its shared socket, so remoteJid is the
      // routable JID here.
      chatJid: rawJid,
      rawChatJid: rawJid,
      sender,
      senderName:
        typeof p.pushName === 'string' ? p.pushName : sender.split('@')[0],
      content,
      id: key?.id || '',
      messageTimestamp: Number(p.messageTimestamp) || 0,
      fromMe: !!key?.fromMe,
    };
  }

  private async connectInternal(): Promise<void> {
    const authDir = path.join(STORE_DIR, 'auth');
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const { version } = await fetchLatestWaWebVersion({}).catch((err) => {
      logger.warn(
        { err },
        'Failed to fetch latest WA Web version, using default',
      );
      return { version: undefined };
    });
    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      printQRInTerminal: false,
      logger: baileysLogger,
      browser: Browsers.macOS('Chrome'),
      markOnlineOnConnect: false,
      cachedGroupMetadata: async (jid: string) =>
        this.getNormalizedGroupMetadata(jid),
      getMessage: async (key: WAMessageKey) => {
        const cached = this.sentMessageCache.get(key.id || '');
        if (cached) {
          logger.debug(
            { id: key.id },
            'getMessage: returning cached message for retry',
          );
          return cached;
        }
        // Fall back to DB lookup so WhatsApp can re-encrypt on retry.
        // Without this, self-chat messages show "waiting for this message".
        const content =
          key.id && key.remoteJid
            ? getMessageContentById(key.id, key.remoteJid)
            : undefined;
        if (content) {
          logger.debug(
            { id: key.id },
            'getMessage: returning DB message for retry',
          );
          return proto.Message.fromObject({ conversation: content });
        }
        // Return empty message rather than undefined — prevents indefinite
        // "waiting for this message" when we genuinely don't have the content.
        return proto.Message.fromObject({});
      },
    });

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // The socket wants a fresh QR scan — the stored session is missing or
        // invalid. Upstream nanoclaw exited the process here (WhatsApp was its
        // only channel); in this multi-channel orchestrator that would kill
        // Telegram/Slack/etc. too, so stop ONLY this channel. Re-pair via the
        // dashboard (hosted pairing broker) or /setup (local).
        const msg =
          'WhatsApp session missing or invalid — stopping the WhatsApp channel. ' +
          'Re-pair via the dashboard (hosted) or run /setup (local).';
        logger.error(msg);
        if (process.platform === 'darwin') {
          exec(
            `osascript -e 'display notification "WhatsApp re-auth needed. Run /setup." with title "NanoClaw" sound name "Basso"'`,
          );
        }
        this.stopped = true;
        try {
          this.sock.end(undefined);
        } catch {
          // socket may already be closing — nothing to do
        }
        return;
      }

      if (connection === 'close') {
        this.connected = false;
        // Intentional stop (bad session / logged out): suppress the reconnect
        // loop, otherwise end() -> close -> reconnect -> qr -> end() churns.
        if (this.stopped) return;
        const reason = (
          lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        logger.info(
          {
            reason,
            shouldReconnect,
            queuedMessages: this.outgoingQueue.length,
          },
          'Connection closed',
        );

        if (shouldReconnect) {
          logger.info('Reconnecting...');
          this.connectInternal().catch((err) => {
            logger.error({ err }, 'Failed to reconnect, retrying in 5s');
            setTimeout(() => {
              this.connectInternal().catch((err2) => {
                logger.error({ err: err2 }, 'Reconnection retry failed');
              });
            }, 5000);
          });
        } else {
          // Logged out = session revoked on the phone. Stop this channel only;
          // the rest of the orchestrator keeps running (upstream exited here).
          this.stopped = true;
          logger.error(
            'WhatsApp logged out — session revoked. Re-pair via the dashboard (hosted) or /setup (local).',
          );
        }
      } else if (connection === 'open') {
        this.connected = true;
        logger.info('Connected to WhatsApp');

        // Build LID to phone mapping from auth state for self-chat translation
        if (this.sock.user) {
          const phoneUser = this.sock.user.id.split(':')[0];
          const lidUser = this.sock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            this.setLidPhoneMapping(lidUser, `${phoneUser}@s.whatsapp.net`);
            this.botLidUser = lidUser;
            logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
          }
        }

        // Flush any messages queued while disconnected
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush outgoing queue'),
        );

        // Sync group metadata on startup (respects 24h cache)
        this.syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Initial group sync failed'),
        );
        // Set up daily sync timer (only once)
        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncGroupMetadata().catch((err) =>
              logger.error({ err }, 'Periodic group sync failed'),
            );
          }, GROUP_SYNC_INTERVAL_MS);
        }

        // Signal first connection to caller
        if (this.pendingFirstOpen) {
          this.pendingFirstOpen();
          this.pendingFirstOpen = undefined;
        }
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
      const lidUser = lid?.split('@')[0].split(':')[0];
      if (lidUser && jid) {
        this.setLidPhoneMapping(lidUser, jid);
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        try {
          if (!msg.message) continue;
          // Unwrap container types (viewOnceMessageV2, ephemeralMessage,
          // editedMessage, etc.) so that conversation, extendedTextMessage,
          // imageMessage, etc. are accessible at the top level.
          const normalized = normalizeMessageContent(msg.message);
          if (!normalized) continue;
          const rawJid = msg.key.remoteJid;
          if (!rawJid || rawJid === 'status@broadcast') continue;

          // Translate LID JID to phone JID if applicable.
          // Prefer senderPn from the message key (available in newer WA protocol)
          // since translateJid may fail to resolve LID→phone via signalRepository.
          let chatJid = await this.translateJid(rawJid);
          if (chatJid.endsWith('@lid') && (msg.key as any).senderPn) {
            const pn = (msg.key as any).senderPn as string;
            const phoneJid = pn.includes('@') ? pn : `${pn}@s.whatsapp.net`;
            this.setLidPhoneMapping(
              rawJid.split('@')[0].split(':')[0],
              phoneJid,
            );
            chatJid = phoneJid;
            logger.info(
              { lidJid: rawJid, phoneJid },
              'Translated LID via senderPn',
            );
          }

          const sender = msg.key.participant || msg.key.remoteJid || '';
          const senderName = msg.pushName || sender.split('@')[0];

          const content =
            normalized.conversation ||
            normalized.extendedTextMessage?.text ||
            normalized.imageMessage?.caption ||
            normalized.videoMessage?.caption ||
            '';

          // Feed the SAME transport-agnostic core the ingress path uses. All
          // trigger / metadata / auto-register / auto-allowlist / bot-detection /
          // onMessage logic lives there, so both transports behave identically.
          this.processInboundMessage({
            chatJid,
            rawChatJid: rawJid,
            sender,
            senderName,
            content,
            id: msg.key.id || '',
            messageTimestamp: Number(msg.messageTimestamp),
            fromMe: msg.key.fromMe || false,
          });
        } catch (err) {
          logger.error(
            { err, remoteJid: msg.key?.remoteJid },
            'Error processing incoming message',
          );
        }
      }
    });
  }

  // ─── Transport-agnostic per-message core ─────────────────────────────────
  // Takes a plain structural payload (NOT a Baileys message). The Baileys
  // messages.upsert handler adapts its events into this (after LID translation
  // and text extraction); the ingress path adapts the CP-forwarded JSON into it
  // (processRawMessage). This is what keeps metadata / auto-register /
  // auto-allowlist / trigger-normalization / bot-detection / onMessage IDENTICAL
  // across the Baileys and shared-bot transports.
  private processInboundMessage(m: IngressWhatsAppMessage): void {
    const { chatJid, sender } = m;
    const timestamp = new Date(m.messageTimestamp * 1000).toISOString();

    // Always notify about chat metadata for group discovery.
    const isGroup = chatJid.endsWith('@g.us');
    this.opts.onChatMetadata(
      chatJid,
      timestamp,
      undefined,
      'whatsapp',
      isGroup,
    );

    const senderName = m.senderName || sender.split('@')[0];

    // Only deliver full message for registered chats. With
    // WHATSAPP_AUTO_REGISTER_GROUPS on, the first message from an unregistered
    // chat self-registers it (the only hook WhatsApp gives us — there's no join
    // event) and is then processed.
    const groups = this.opts.registeredGroups();
    let group: RegisteredGroup | undefined = groups[chatJid];
    if (!group) {
      group = this.maybeAutoRegisterGroup(chatJid, isGroup, senderName);
      if (group) {
        logger.info(
          { chatJid, isGroup },
          'WhatsApp chat auto-registered on inbound message',
        );
      }
    }
    if (group) {
      let content = m.content;

      // WhatsApp group mentions use the LID in raw text (e.g. "@80355281346633")
      // instead of the display name. Normalize to @AssistantName for trigger
      // matching. In ingress mode botLidUser is unset (no local socket), so this
      // is a no-op — the CP is expected to normalize mentions upstream, and
      // trigger-word (@AssistantName) mentions still match regardless.
      if (this.botLidUser && content.includes(`@${this.botLidUser}`)) {
        content = content.replace(`@${this.botLidUser}`, `@${ASSISTANT_NAME}`);
      }

      // Skip protocol messages with no text content (encryption keys, read
      // receipts, etc.).
      if (!content) return;

      // Auto-allowlist the sender when this chat matches
      // WHATSAPP_AUTO_ALLOWLIST_GROUPS (no-op for known senders).
      this.maybeAutoAllowlistSender(chatJid, isGroup, sender, senderName);

      const fromMe = m.fromMe || false;
      // Detect bot messages: with own number, fromMe is reliable since only the
      // bot sends from that number. With shared number, bot messages carry the
      // assistant name prefix (even in DMs/self-chat) so we check for that.
      const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
        ? fromMe
        : content.startsWith(`${ASSISTANT_NAME}:`);

      this.opts.onMessage(chatJid, {
        id: m.id,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: fromMe,
        is_bot_message: isBotMessage,
      });
    } else if (m.rawChatJid && chatJid !== m.rawChatJid) {
      // LID translation produced a JID that doesn't match any registered group.
      logger.warn(
        {
          rawJid: m.rawChatJid,
          translatedJid: chatJid,
          registeredJids: Object.keys(groups),
        },
        'Message JID not found in registered groups after translation',
      );
    }
  }

  async sendMessage(jid: string, text: string): Promise<boolean> {
    // Prefix bot messages with assistant name so users know who's speaking.
    // On a shared number, prefix is also needed in DMs (including self-chat)
    // to distinguish bot output from user messages.
    // Skip only when the assistant has its own dedicated phone number.
    const prefixed = ASSISTANT_HAS_OWN_NUMBER
      ? text
      : `${ASSISTANT_NAME}: ${text}`;

    // Ingress mode: route every send through the control-plane proxy. The
    // hosted shared account is always a shared number, so the same prefixing
    // above applies. WhatsAppSender never throws (mirrors the queue-on-failure
    // degradation of the Baileys path — a CP outage logs a warn, not a crash).
    if (this.ingress) {
      if (!this.sender) {
        logger.warn(
          { jid },
          'WhatsApp ingress: no control-plane proxy configured — dropping send',
        );
        return false;
      }
      // The CP sender resolves false on a proxy failure — propagate it so the
      // cross-channel path can surface a non-delivery instead of a false ok.
      return await this.sender.send(jid, prefixed);
    }

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.info(
        { jid, length: prefixed.length, queueSize: this.outgoingQueue.length },
        'WA disconnected, message queued',
      );
      // Accepted for guaranteed delivery on reconnect (queue is drained), so
      // this is a success, not a drop.
      return true;
    }
    try {
      const sent = await this.sock.sendMessage(jid, { text: prefixed });
      // Cache for retry requests (recipient may ask us to re-encrypt)
      if (sent?.key?.id && sent.message) {
        this.sentMessageCache.set(sent.key.id, sent.message);
        if (this.sentMessageCache.size > 256) {
          const oldest = this.sentMessageCache.keys().next().value!;
          this.sentMessageCache.delete(oldest);
        }
      }
      logger.info({ jid, length: prefixed.length }, 'Message sent');
      return true;
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send, message queued',
      );
      // Re-queued for retry on reconnect — treat as accepted, not dropped.
      return true;
    }
  }

  isConnected(): boolean {
    if (this.ingress) return this.ingressConnected;
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net');
  }

  async disconnect(): Promise<void> {
    if (this.ingress) {
      if (this.ingressServer) {
        await this.ingressServer.stop();
        this.ingressServer = null;
      }
      this.ingressConnected = false;
      logger.info('WhatsApp ingress stopped');
      return;
    }
    this.connected = false;
    this.sock?.end(undefined);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    // DEGRADATION (ingress): presence/typing is a Baileys socket capability with
    // no v1 CP proxy method ({ jid, text } only), so typing indicators are a
    // no-op in shared-bot mode. Baileys mode is unchanged.
    if (this.ingress) return;
    try {
      const status = isTyping ? 'composing' : 'paused';
      logger.debug({ jid, status }, 'Sending presence update');
      await this.sock.sendPresenceUpdate(status, jid);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  async syncGroups(force: boolean): Promise<void> {
    return this.syncGroupMetadata(force);
  }

  /**
   * Sync group metadata from WhatsApp.
   * Fetches all participating groups and stores their names in the database.
   * Called on startup, daily, and on-demand via IPC.
   */
  async syncGroupMetadata(force = false): Promise<void> {
    // DEGRADATION (ingress): group metadata is fetched over the Baileys socket
    // (groupFetchAllParticipating), which the tenant doesn't have in shared-bot
    // mode. The CP owns group-name discovery; here it's a no-op.
    if (this.ingress) return;
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping group sync - synced recently');
          return;
        }
      }
    }

    try {
      logger.info('Syncing group metadata from WhatsApp...');
      const groups = await this.sock.groupFetchAllParticipating();

      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          updateChatName(jid, metadata.subject);
          // Keep an in-memory name for auto-registration (no extra socket hit).
          this.groupNameCache.set(jid, metadata.subject);
          count++;
        }
      }

      setLastGroupSync();
      logger.info({ count }, 'Group metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync group metadata');
    }
  }

  private async translateJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];

    // Check local cache first
    const cached = this.lidToPhoneMap[lidUser];
    if (cached) {
      logger.debug(
        { lidJid: jid, phoneJid: cached },
        'Translated LID to phone JID (cached)',
      );
      return cached;
    }

    // Query Baileys' signal repository for the mapping
    try {
      const pn = await (
        this.sock.signalRepository as any
      )?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        this.setLidPhoneMapping(lidUser, phoneJid);
        logger.info(
          { lidJid: jid, phoneJid },
          'Translated LID to phone JID (signalRepository)',
        );
        return phoneJid;
      }
    } catch (err) {
      logger.debug({ err, jid }, 'Failed to resolve LID via signalRepository');
    }

    return jid;
  }

  private setLidPhoneMapping(lidUser: string, phoneJid: string): void {
    if (this.lidToPhoneMap[lidUser] === phoneJid) return;
    this.lidToPhoneMap[lidUser] = phoneJid;
    // Participant IDs in cached group metadata depend on this mapping.
    this.groupMetadataCache.clear();
  }

  private async getNormalizedGroupMetadata(
    jid: string,
    forceRefresh = false,
  ): Promise<GroupMetadata | undefined> {
    if (!jid.endsWith('@g.us')) return undefined;

    const cached = this.groupMetadataCache.get(jid);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return cached.metadata;
    }

    const metadata = await this.sock.groupMetadata(jid);
    const participants = await Promise.all(
      metadata.participants.map(async (participant) => ({
        ...participant,
        id: await this.translateJid(participant.id),
      })),
    );
    const normalized = { ...metadata, participants };
    const mappedCount = participants.filter(
      (participant, index) =>
        participant.id !== metadata.participants[index]?.id,
    ).length;

    logger.info(
      { jid, participantCount: participants.length, mappedCount },
      'Prepared normalized group metadata for send',
    );

    this.groupMetadataCache.set(jid, {
      metadata: normalized,
      expiresAt: Date.now() + 60_000,
    });
    return normalized;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing outgoing message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        // Send directly — queued items are already prefixed by sendMessage
        const sent = await this.sock.sendMessage(item.jid, { text: item.text });
        if (sent?.key?.id && sent.message) {
          this.sentMessageCache.set(sent.key.id, sent.message);
        }
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued message sent',
        );
      }
    } finally {
      this.flushing = false;
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

registerChannel('whatsapp', (opts: ChannelOpts) => {
  // Mode 1: existing linked session (auth/creds.json present) → normal Baileys
  // mode, UNCHANGED (BYO / per-org pairing). WhatsApp's "credential" is a
  // linked-device session on disk (there is no bot token). In hosted BYO mode
  // the pairing broker (runWhatsAppPairingBroker, started from index.ts) creates
  // the session first, then the orchestrator restarts and this factory finds the
  // creds. A live session ALWAYS wins over ingress — a paired org keeps its own
  // socket.
  if (whatsappCredsExist()) {
    return new WhatsAppChannel({
      ...opts,
      autoRegisterGroups: WHATSAPP_AUTO_REGISTER_GROUPS,
      autoAllowlistGroups: WHATSAPP_AUTO_ALLOWLIST_GROUPS,
    });
  }

  // Mode 2: no linked session but WHATSAPP_INGRESS_SECRET is set → shared-bot
  // INGRESS mode (hosted SaaS). The control plane owns the ONE platform WhatsApp
  // account (a Baileys client the CP runs) and forwards this org's messages to
  // POST /whatsapp/messages (signed); outbound proxies back through the CP. No
  // Baileys socket, no pairing. Config is sourced from process.env first (hosted
  // Kubernetes tenant pods inject via envFrom secretRef), falling back to .env.
  const envVars = readEnvFile(['WHATSAPP_INGRESS_SECRET']);
  const ingressSecret =
    process.env.WHATSAPP_INGRESS_SECRET ||
    envVars.WHATSAPP_INGRESS_SECRET ||
    '';
  if (ingressSecret) {
    return new WhatsAppChannel({
      ...opts,
      autoRegisterGroups: WHATSAPP_AUTO_REGISTER_GROUPS,
      autoAllowlistGroups: WHATSAPP_AUTO_ALLOWLIST_GROUPS,
      ingressSecret,
    });
  }

  // Mode 3: neither → not configured. Skip (return null), like every other
  // unconfigured channel.
  logger.warn(
    'WhatsApp: no linked session (auth/creds.json missing) and no WHATSAPP_INGRESS_SECRET — pair via the dashboard or /setup, or set the ingress secret for shared-bot mode',
  );
  return null;
});
