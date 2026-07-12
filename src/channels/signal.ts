import net from 'net';

import {
  ASSISTANT_NAME,
  INGRESS_HTTP_PORT,
  SIGNAL_AUTO_REGISTER_GROUPS,
} from '../config.js';
import { logReaction, storeOutboundMessage } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  attestNonce,
  DEFAULT_DSTACK_SOCKET,
  DEFAULT_VERIFY_URL,
  formatAttestationReply,
  parseVerifyCommand,
} from '../tee-attest.js';
import {
  getIngressHttpServer,
  type IngressHttpServer,
} from './ingress-http-server.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { deriveSignalGroupFolder } from './signal-auto.js';
import { SignalSender, signalSenderConfig } from './signal-sender.js';
import { verifyIngressSignature } from './slack-http-receiver.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
  SendMessageOpts,
} from '../types.js';

/**
 * Signal has no official bot API. We talk to a locally-running `signal-cli`
 * daemon over its JSON-RPC interface (newline-delimited JSON over a TCP
 * socket). Start the daemon once per registered account, e.g.:
 *
 *   signal-cli -a "$SIGNAL_ACCOUNT" daemon --tcp 127.0.0.1:7583
 *
 * The same socket carries both directions: we write JSON-RPC `send` requests
 * and read `receive` notifications that signal-cli pushes for every inbound
 * envelope. No extra npm dependency — Node's `net` module is enough.
 *
 * JID scheme:
 *   DM    → `signal:+15551234567`        (E.164 phone number)
 *   group → `signal:group:<base64GroupId>`
 */

/** Map Slack-style emoji names to Unicode for the ACK reaction pattern. */
const EMOJI_MAP: Record<string, string> = {
  eyes: '👀',
  thinking_face: '🤔',
  white_check_mark: '✅',
  thumbsup: '👍',
  heart: '❤️',
  fire: '🔥',
  pray: '🙏',
};

// Signal messages can be long, but very large bodies risk rejection — chunk
// conservatively. Styled ranges are only attached to single-chunk sends, since
// splitting plain text would invalidate the (start, length) offsets.
const MAX_LENGTH = 2000;

export interface SignalTextStyle {
  style: 'BOLD' | 'ITALIC' | 'STRIKETHROUGH' | 'MONOSPACE' | 'SPOILER';
  start: number;
  length: number;
}

// Each alternative captures the inner (unmarked) text; index → Signal style.
const STYLE_TOKEN =
  /```([\s\S]*?)```|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\|\|([^|]+)\|\||\*([^*\n]+)\*|_([^_\n]+)_/g;
const GROUP_STYLE: SignalTextStyle['style'][] = [
  'MONOSPACE', // ```fenced```
  'MONOSPACE', // `inline`
  'BOLD', //     **bold**
  'BOLD', //     __bold__
  'STRIKETHROUGH', // ~~strike~~
  'SPOILER', //  ||spoiler||
  'ITALIC', //   *italic*
  'ITALIC', //   _italic_
];

/**
 * Convert Claude's Markdown into Signal's plain text + native `textStyle`
 * ranges. Single-level only (no nesting), which covers the vast majority of
 * assistant output. Returns `{ text, textStyle }`; `textStyle` is empty when no
 * markers are present. If the channel-formatting skill ships a richer
 * `parseSignalStyles` in `src/text-styles.ts`, this stays as a self-contained
 * fallback so the Signal channel builds with or without that skill.
 */
export function parseSignalStyles(input: string): {
  text: string;
  textStyle: SignalTextStyle[];
} {
  let out = '';
  let last = 0;
  const textStyle: SignalTextStyle[] = [];
  STYLE_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STYLE_TOKEN.exec(input)) !== null) {
    out += input.slice(last, m.index);
    const groupIdx = m.slice(1).findIndex((g) => g !== undefined);
    const inner = m[groupIdx + 1];
    textStyle.push({
      style: GROUP_STYLE[groupIdx],
      start: out.length,
      length: inner.length,
    });
    out += inner;
    last = m.index + m[0].length;
  }
  out += input.slice(last);
  return { text: out, textStyle };
}

/** signal-cli JSON-RPC `textStyles` wire format: ["start:length:STYLE", ...]. */
function toWireStyles(styles: SignalTextStyle[]): string[] {
  return styles.map((s) => `${s.start}:${s.length}:${s.style}`);
}

export interface SignalChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  // Needed for SIGNAL_AUTO_REGISTER_GROUPS; auto-registration is silently
  // disabled when the orchestrator doesn't provide it.
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
  // SIGNAL_AUTO_REGISTER_GROUPS — register a chat the moment the first inbound
  // message from a still-unregistered chat reaches the bot (Signal, like
  // WhatsApp, has no join event, so the message IS the hook). Applies to both
  // group chats (`signal:group:<id>`) and 1:1 DMs (`signal:<e164>`).
  // Default: off.
  autoRegisterGroups?: boolean;
  // Auto-register a 1:1 DM whose sender is a known KB person, so any teammate
  // can DM the bot without a per-DM admin step (fallback when
  // autoRegisterGroups is off). Returns true when the DM is (now) registered
  // and the message should be processed; false for unknown senders (dropped).
  ensureDmRegistered?: (
    jid: string,
    platform: string,
    senderId: string,
  ) => boolean;
  /**
   * TEE attestation config for the `!verify <nonce>` command. When `enabled`
   * is false (default — non-TEE deployments), `!verify` is not intercepted and
   * flows through to the agent like any other message. When enabled, an inbound
   * `!verify <nonce>` in a registered chat is answered locally with a dstack
   * TDX attestation (see src/tee-attest.ts) and NOT forwarded to the agent.
   */
  tee?: {
    enabled: boolean;
    socketPath?: string;
    verifyUrl?: string;
  };
  // --- Shared-bot INGRESS mode (hosted SaaS) ---
  // When set, the channel runs WITHOUT a signal-cli socket: the control plane
  // owns the ONE platform Signal number (a real signal-cli account it drives via
  // the bbernhard/signal-cli-rest-api gateway) and POSTs each org's forwarded
  // group messages to /signal/messages (HMAC-signed with ingressSecret). All
  // outbound is proxied back through the CP (SignalSender). The tenant never
  // holds Signal creds. Native (BYO signal-cli) mode leaves this unset.
  ingressSecret?: string;
}

interface PendingRequest {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
}

export class SignalChannel implements Channel {
  name = 'signal';

  private account: string;
  private host: string;
  private port: number;
  private opts: SignalChannelOpts;
  private tee: SignalChannelOpts['tee'];

  private socket: net.Socket | null = null;
  private connected = false;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Resolver for the pending connect() promise; called on first connect. */
  private connectResolve?: () => void;
  private reconnectDelay = 1000;
  private closing = false;

  // --- Ingress mode state ---
  /** True when running in shared-bot ingress mode (no signal-cli socket). */
  private readonly ingress: boolean;
  private readonly ingressSecret: string | undefined;
  private sender: SignalSender | null = null;
  private ingressServer: IngressHttpServer | null = null;
  private ingressConnected = false;

  // Reactions target a message by (author, timestamp). Inbound message ids are
  // the envelope timestamp, so remember each one's author to reply with a
  // reaction. Capped LRU — only recent messages get ACK reactions anyway.
  private authorByMsgId = new Map<string, string>();
  private static readonly AUTHOR_MAP_MAX = 500;

  constructor(account: string, rpcAddr: string, opts: SignalChannelOpts) {
    this.account = account;
    const [host, port] = rpcAddr.split(':');
    this.host = host || '127.0.0.1';
    this.port = parseInt(port || '7583', 10);
    this.opts = opts;
    this.tee = opts.tee;
    // Ingress mode iff an ingress secret is provided. The factory only passes
    // one when there is NO native signal-cli account, so the two modes never
    // collide on a single instance.
    this.ingress = !!opts.ingressSecret;
    this.ingressSecret = opts.ingressSecret;
  }

  async connect(): Promise<void> {
    if (this.ingress) {
      return this.connectIngress();
    }
    return new Promise<void>((resolve) => {
      // Resolve on the FIRST successful connection — even if it arrives via a
      // reconnect rather than this initial dial. signal-cli is often not
      // listening yet when the orchestrator first connects (notably TEE mode,
      // where signal-cli links as a device on boot and only starts its daemon
      // afterwards). The initial openSocket() then fails and scheduleReconnect()
      // reopens the socket without this resolver; storing it here means the
      // eventual success still unblocks `await channel.connect()` in main().
      // Without this, main() hangs before startMessageLoop() and inbound
      // messages are stored but never processed.
      this.connectResolve = resolve;
      this.openSocket();
    });
  }

  // ─── Shared-bot INGRESS transport ────────────────────────────────────────

  /**
   * Connect in ingress mode: register POST /signal/messages on the shared
   * ingress HTTP server (same port as the slack receiver + telegram/whatsapp
   * ingress) and wire up the outbound control-plane proxy. No signal-cli socket
   * is opened — the control plane owns the ONE shared platform Signal number and
   * forwards this org's bound-group messages here (signed), receiving our
   * outbound over the proxy.
   */
  private async connectIngress(): Promise<void> {
    const cfg = signalSenderConfig();
    if (cfg) {
      this.sender = new SignalSender(cfg);
    } else {
      // Inbound still works; outbound no-ops until CONTROL_PLANE_* is set.
      logger.warn(
        'Signal ingress: CONTROL_PLANE_URL/TOKEN not set — outbound sends will be dropped',
      );
    }

    const secret = this.ingressSecret!;
    const server = getIngressHttpServer(INGRESS_HTTP_PORT, logger);
    this.ingressServer = server;
    server.registerRoute('POST', '/signal/messages', (rawBody, req, res) => {
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
          'Signal ingress rejected request (signature verification failed)',
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
      // never delay the ack (mirrors the slack receiver + telegram/whatsapp
      // ingress).
      res.writeHead(200);
      res.end();
      this.processRawMessage(payload);
    });

    await server.start();
    this.ingressConnected = true;
    logger.info(
      { port: INGRESS_HTTP_PORT },
      'Signal ingress connected (shared-bot mode)',
    );
  }

  /**
   * Feed a CP-forwarded Signal payload into the SAME inbound core the native
   * signal-cli receive loop uses (handleReceive). The control plane forwards the
   * RAW single-envelope wrapper verbatim — `{ envelope: { dataMessage, source,
   * timestamp, ... } }` — which is byte-for-byte the shape signal-cli pushes as a
   * JSON-RPC `receive` notification's params, so the same core drives chatJid
   * derivation, auto-register, `!verify`, and onMessage identically across both
   * transports. Never throws — malformed payloads are logged and dropped.
   */
  processRawMessage(payload: unknown): void {
    try {
      this.handleReceive(payload);
    } catch (err) {
      logger.error({ err }, 'Signal ingress: failed to process message');
    }
  }

  private openSocket(): void {
    const socket = net.createConnection(
      { host: this.host, port: this.port },
      () => {
        this.connected = true;
        this.reconnectDelay = 1000;
        logger.info(
          { account: this.account, host: this.host, port: this.port },
          'Signal JSON-RPC daemon connected',
        );
        console.log(`\n  Signal account: ${this.account}`);
        console.log(
          `  Register a chat ID like \`signal:${this.account}\` (DM) or \`signal:group:<id>\`\n`,
        );
        this.connectResolve?.();
        this.connectResolve = undefined;
      },
    );
    socket.setEncoding('utf8');
    this.socket = socket;

    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', (err) => {
      logger.error({ err: err.message }, 'Signal socket error');
    });
    socket.on('close', () => {
      this.connected = false;
      this.socket = null;
      // Fail any in-flight requests so callers don't hang.
      for (const { reject } of this.pending.values()) {
        reject(new Error('Signal socket closed'));
      }
      this.pending.clear();
      if (!this.closing) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    logger.warn({ delay }, 'Signal daemon disconnected — reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this.openSocket();
    }, delay);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    // signal-cli emits one JSON object per line.
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        logger.warn({ line, err }, 'Signal: unparseable JSON-RPC line');
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'RPC error'));
        else p.resolve(msg.result);
      } else if (msg.method === 'receive') {
        this.handleReceive(msg.params);
      }
    }
  }

  private request(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('Signal socket not connected'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.socket.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
      );
    });
  }

  private rememberAuthor(msgId: string, author: string): void {
    this.authorByMsgId.set(msgId, author);
    if (this.authorByMsgId.size > SignalChannel.AUTHOR_MAP_MAX) {
      const oldest = this.authorByMsgId.keys().next().value;
      if (oldest !== undefined) this.authorByMsgId.delete(oldest);
    }
  }

  /**
   * Auto-register a Signal chat when SIGNAL_AUTO_REGISTER_GROUPS is on.
   * Returns the registered group (existing or newly created), or undefined when
   * the feature is off or registration was rejected. Idempotent.
   *
   * Signal's only hook is the inbound message (there is no join event), so this
   * covers both group chats and DMs — mirroring WhatsApp. Groups keep the
   * default (trigger required); DMs are registered with `requiresTrigger:false`
   * so a 1:1 behaves like a solo chat.
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
    // Groups carry no subject in the receive envelope; DMs use the sender's
    // profile name. Fall back to the JID when neither is available.
    const name = isGroup ? undefined : senderName || undefined;
    const folder = deriveSignalGroupFolder(chatJid, name, existingFolders);
    this.opts.registerGroup(chatJid, {
      name: name || chatJid,
      folder,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
      // Groups require the trigger word; DMs don't (matches WhatsApp's choice).
      requiresTrigger: isGroup,
    });
    // Re-read instead of trusting our input: registerGroup validates the folder
    // and may reject the registration.
    const registered = this.opts.registeredGroups()[chatJid];
    if (registered) {
      logger.info(
        { chatJid, name: registered.name, folder: registered.folder },
        'Signal chat auto-registered',
      );
    }
    return registered;
  }

  /**
   * Transport-agnostic inbound core: envelope → chatJid → metadata →
   * auto-register → `!verify` intercept → onMessage. Consumes a signal-cli
   * `receive` params object (`{ envelope, account? }`). BOTH transports drive
   * this SAME method, so triggers / auto-register / `!verify` behave identically:
   *   - native  → onData() calls handleReceive(msg.params) for each JSON-RPC line;
   *   - ingress → processRawMessage() calls handleReceive(<CP-forwarded wrapper>),
   *     which the control plane forwards verbatim as the same `{ envelope }` shape.
   */
  private handleReceive(params: any): void {
    const envelope = params?.envelope;
    const data = envelope?.dataMessage;
    if (!envelope || !data) return; // receipts, typing, sync — ignore

    const author = envelope.sourceNumber || envelope.source || '';
    const senderName = envelope.sourceName || author || 'Unknown';
    const groupId = data.groupInfo?.groupId;
    const chatJid = groupId ? `signal:group:${groupId}` : `signal:${author}`;
    const isGroup = !!groupId;
    const timestamp = new Date(envelope.timestamp || Date.now()).toISOString();
    const msgId = String(envelope.timestamp);

    let content: string = data.message || '';
    if (
      !content &&
      Array.isArray(data.attachments) &&
      data.attachments.length
    ) {
      const names = data.attachments
        .map((a: any) => a.filename || a.contentType || 'file')
        .join(', ');
      content = `[Attachment: ${names}]`;
    }
    if (!content) return; // nothing actionable (e.g. reaction-only envelope)

    this.rememberAuthor(msgId, author);

    // Chat name: DMs carry the sender's profile name; groups don't in receive.
    this.opts.onChatMetadata(
      chatJid,
      timestamp,
      isGroup ? undefined : senderName,
      'signal',
      isGroup,
    );

    // Only deliver full messages for registered chats. When the chat is
    // unregistered we try two self-heal paths before dropping (mirrors
    // WhatsApp + Slack):
    //   1. SIGNAL_AUTO_REGISTER_GROUPS (autoRegisterGroups): register the chat
    //      on its first inbound message — groups AND DMs — then process it.
    //   2. ensureDmRegistered: fall back for a DM whose sender resolves to a
    //      known KB person, so a teammate can start a 1:1 without enabling the
    //      blanket auto-register flag.
    // Neither enabled → drop (unchanged behavior).
    let group: RegisteredGroup | undefined =
      this.opts.registeredGroups()[chatJid];
    if (!group) {
      group = this.maybeAutoRegisterGroup(chatJid, isGroup, senderName);
      if (
        !group &&
        !isGroup &&
        this.opts.ensureDmRegistered?.(chatJid, 'signal', author)
      ) {
        // ensureDmRegistered registered the DM out-of-band — re-read the row so
        // the just-registered chat flows through the rest of handleReceive.
        group = this.opts.registeredGroups()[chatJid];
      }
      if (group) {
        logger.info(
          { chatJid, isGroup },
          'Signal chat auto-registered on inbound message',
        );
      }
    }
    if (!group) {
      logger.debug({ chatJid }, 'Message from unregistered Signal chat');
      return;
    }

    // TEE attestation: intercept `!verify <nonce>` locally (never forwarded to
    // the agent). Gated on tee.enabled so non-TEE deployments are unaffected.
    if (this.opts.tee?.enabled && parseVerifyCommand(content) !== null) {
      void this.handleVerify(chatJid, content);
      return;
    }

    const quote = data.quote;
    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender: author,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      reply_to_message_id: quote?.id ? String(quote.id) : undefined,
      reply_to_message_content: quote?.text || undefined,
      reply_to_sender_name: quote?.author || quote?.authorNumber || undefined,
    });

    logger.info({ chatJid, sender: senderName }, 'Signal message stored');
  }

  /**
   * Answer a `!verify <nonce>` command with a dstack TDX attestation. Runs
   * only when TEE mode is enabled (gated by the caller). Never throws — a
   * missing socket, bad nonce, or failed dstack call all produce a helpful
   * reply instead of crashing the receive loop.
   */
  private async handleVerify(jid: string, text: string): Promise<void> {
    const parsed = parseVerifyCommand(text);
    if (!parsed) return; // not a verify command (defensive; caller pre-checks)

    if (parsed.kind === 'missing') {
      await this.sendMessage(
        jid,
        'Usage: `!verify <nonce>` — the nonce is 8–64 url-safe characters ' +
          '([A-Za-z0-9_-]). It gets embedded in a fresh TDX quote so you can ' +
          'confirm the attestation is bound to your challenge.',
      );
      return;
    }
    if (parsed.kind === 'invalid') {
      await this.sendMessage(
        jid,
        'That nonce is not valid. Use 8–64 url-safe characters ' +
          '([A-Za-z0-9_-]), e.g. `!verify my-random-1234`.',
      );
      return;
    }

    logger.info({ jid, nonce: parsed.nonce }, 'Signal !verify requested');
    try {
      const result = await attestNonce(parsed.nonce, {
        socketPath: this.tee?.socketPath,
        verifyUrl: this.tee?.verifyUrl,
      });
      await this.sendMessage(jid, formatAttestationReply(result));
    } catch (err) {
      // attestNonce is designed not to throw, but never let the receive loop
      // die on an unexpected failure.
      logger.error({ jid, err }, 'Signal !verify failed unexpectedly');
      await this.sendMessage(
        jid,
        'Attestation failed unexpectedly. Please try again.',
      );
    }
  }

  /** Build the recipient/group selector for a JID. */
  private target(jid: string): { recipient?: string[]; groupId?: string } {
    const rest = jid.replace(/^signal:/, '');
    if (rest.startsWith('group:'))
      return { groupId: rest.slice('group:'.length) };
    return { recipient: [rest] };
  }

  async sendMessage(
    jid: string,
    text: string,
    _opts?: SendMessageOpts,
  ): Promise<void> {
    // Ingress mode: route every send through the control-plane proxy. The CP
    // gateway renders `text_mode:styled` from the raw text, so we forward it
    // verbatim (no local textStyle parsing/chunking — mirrors WhatsApp ingress).
    // SignalSender never throws (a CP outage logs a warn, not a crash), matching
    // the native path's log-and-drop on a failed socket send.
    if (this.ingress) {
      if (!this.sender) {
        logger.warn(
          { jid },
          'Signal ingress: no control-plane proxy configured — dropping send',
        );
        return;
      }
      await this.sender.send(jid, text);
      return;
    }

    if (!this.connected) {
      logger.warn({ jid }, 'Signal not connected — dropping message');
      return;
    }
    const target = this.target(jid);
    try {
      if (text.length <= MAX_LENGTH) {
        const { text: plain, textStyle } = parseSignalStyles(text);
        const result = await this.request('send', {
          account: this.account,
          ...target,
          message: plain,
          ...(textStyle.length ? { textStyles: toWireStyles(textStyle) } : {}),
        });
        this.store(jid, result, plain);
      } else {
        // Overflow: split plain text; drop styles to keep offsets valid.
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          const chunk = text.slice(i, i + MAX_LENGTH);
          const result = await this.request('send', {
            account: this.account,
            ...target,
            message: chunk,
          });
          this.store(jid, result, chunk);
        }
      }
      logger.info({ jid, length: text.length }, 'Signal message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Signal message');
    }
  }

  private store(jid: string, result: any, text: string): void {
    const msgId = result?.timestamp ? String(result.timestamp) : '';
    if (!msgId) return;
    try {
      storeOutboundMessage(jid, msgId, text, ASSISTANT_NAME);
    } catch (err) {
      logger.warn({ err, jid }, 'storeOutboundMessage failed (continuing)');
    }
  }

  isConnected(): boolean {
    if (this.ingress) return this.ingressConnected;
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('signal:');
  }

  async disconnect(): Promise<void> {
    if (this.ingress) {
      if (this.ingressServer) {
        await this.ingressServer.stop();
        this.ingressServer = null;
      }
      this.ingressConnected = false;
      logger.info('Signal ingress stopped');
      return;
    }
    this.closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    logger.info('Signal daemon connection closed');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    // DEGRADATION (ingress): typing is a signal-cli capability with no v1 CP
    // proxy method ({ groupId, message } only), so typing indicators are a no-op
    // in shared-bot mode. Native mode is unchanged.
    if (this.ingress) return;
    if (!this.connected) return;
    try {
      await this.request('sendTyping', {
        account: this.account,
        ...this.target(jid),
        stop: !isTyping,
      });
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Signal typing indicator');
    }
  }

  async addReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    await this.react(jid, messageId, emoji, false);
  }

  async removeReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    await this.react(jid, messageId, emoji, true);
  }

  private async react(
    jid: string,
    messageId: string,
    emoji: string,
    remove: boolean,
  ): Promise<void> {
    // DEGRADATION (ingress): reactions are a signal-cli capability with no v1 CP
    // proxy method ({ groupId, message } only), so reactions are a no-op in
    // shared-bot mode. Native mode is unchanged.
    if (this.ingress) return;
    if (!this.connected) return;
    const author = this.authorByMsgId.get(messageId);
    if (!author) {
      logger.debug(
        { jid, messageId },
        'Signal: no known author for message — skipping reaction',
      );
      return;
    }
    const resolved = EMOJI_MAP[emoji] || emoji;
    try {
      await this.request('sendReaction', {
        account: this.account,
        ...this.target(jid),
        emoji: resolved,
        targetAuthor: author,
        targetTimestamp: parseInt(messageId, 10),
        remove,
      });
      logReaction(jid, messageId, resolved, remove ? 'remove' : 'add');
    } catch (err) {
      logger.warn({ jid, messageId, emoji, err }, 'Failed Signal reaction');
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

registerChannel('signal', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'SIGNAL_ACCOUNT',
    'SIGNAL_RPC_TCP',
    'SIGNAL_INGRESS_SECRET',
    'TEE_MODE',
    'DSTACK_SOCKET_PATH',
    'TEE_VERIFY_URL',
  ]);
  const account = process.env.SIGNAL_ACCOUNT || envVars.SIGNAL_ACCOUNT || '';

  // TEE mode: enable the `!verify <nonce>` attestation command. The command is
  // only intercepted when TEE_MODE=true; even then, tee-attest.ts checks the
  // dstack socket exists before attesting, so a misset flag on a non-TEE host
  // replies "not running in a TEE" rather than crashing. Shared by both modes —
  // a TEE-hosted tenant can run ingress and still answer `!verify` locally.
  const teeEnabled =
    (process.env.TEE_MODE || envVars.TEE_MODE || '').toLowerCase() === 'true';
  const tee = teeEnabled
    ? {
        enabled: true,
        socketPath:
          process.env.DSTACK_SOCKET_PATH ||
          envVars.DSTACK_SOCKET_PATH ||
          DEFAULT_DSTACK_SOCKET,
        verifyUrl:
          process.env.TEE_VERIFY_URL ||
          envVars.TEE_VERIFY_URL ||
          DEFAULT_VERIFY_URL,
      }
    : undefined;

  // Mode 1: a native signal-cli account (SIGNAL_ACCOUNT) → BYO native mode,
  // UNCHANGED. Signal's "credential" is a linked/registered signal-cli account
  // reachable over its JSON-RPC daemon. A live account ALWAYS wins over ingress.
  // ...opts already carries registerGroup + ensureDmRegistered from ChannelOpts;
  // add the Signal auto-register flag so an unregistered chat's first message
  // can self-register instead of being silently dropped.
  if (account) {
    const rpcAddr =
      process.env.SIGNAL_RPC_TCP || envVars.SIGNAL_RPC_TCP || '127.0.0.1:7583';
    return new SignalChannel(account, rpcAddr, {
      ...opts,
      autoRegisterGroups: SIGNAL_AUTO_REGISTER_GROUPS,
      tee,
    });
  }

  // Mode 2: no native account but SIGNAL_INGRESS_SECRET is set → shared-bot
  // INGRESS mode (hosted SaaS). The control plane owns the ONE platform Signal
  // number (a real signal-cli account it drives via the bbernhard gateway) and
  // forwards this org's bound-group messages to POST /signal/messages (signed);
  // outbound proxies back through the CP. No signal-cli socket, no account.
  // Config is sourced from process.env first (hosted Kubernetes tenant pods
  // inject via envFrom secretRef), falling back to .env.
  const ingressSecret =
    process.env.SIGNAL_INGRESS_SECRET || envVars.SIGNAL_INGRESS_SECRET || '';
  if (ingressSecret) {
    // account/rpcAddr are unused in ingress mode (no local daemon); pass empty.
    return new SignalChannel('', '', {
      ...opts,
      autoRegisterGroups: SIGNAL_AUTO_REGISTER_GROUPS,
      tee,
      ingressSecret,
    });
  }

  // Mode 3: neither → not configured. Skip (return null), like every other
  // unconfigured channel.
  logger.warn(
    'Signal: SIGNAL_ACCOUNT not set (nor SIGNAL_INGRESS_SECRET for shared-bot ingress mode)',
  );
  return null;
});
