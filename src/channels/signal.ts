import net from 'net';

import { ASSISTANT_NAME, SIGNAL_AUTO_REGISTER_GROUPS } from '../config.js';
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
import { registerChannel, ChannelOpts } from './registry.js';
import { deriveSignalGroupFolder } from './signal-auto.js';
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
  private reconnectDelay = 1000;
  private closing = false;

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
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.openSocket(resolve);
    });
  }

  private openSocket(onReady?: () => void): void {
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
        onReady?.();
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
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('signal:');
  }

  async disconnect(): Promise<void> {
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

registerChannel('signal', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'SIGNAL_ACCOUNT',
    'SIGNAL_RPC_TCP',
    'TEE_MODE',
    'DSTACK_SOCKET_PATH',
    'TEE_VERIFY_URL',
  ]);
  const account = process.env.SIGNAL_ACCOUNT || envVars.SIGNAL_ACCOUNT || '';
  if (!account) {
    logger.warn('Signal: SIGNAL_ACCOUNT not set');
    return null;
  }
  const rpcAddr =
    process.env.SIGNAL_RPC_TCP || envVars.SIGNAL_RPC_TCP || '127.0.0.1:7583';

  // TEE mode: enable the `!verify <nonce>` attestation command. The command is
  // only intercepted when TEE_MODE=true; even then, tee-attest.ts checks the
  // dstack socket exists before attesting, so a misset flag on a non-TEE host
  // replies "not running in a TEE" rather than crashing.
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

  // ...opts already carries registerGroup + ensureDmRegistered from ChannelOpts;
  // add the Signal auto-register flag so an unregistered chat's first message
  // can self-register instead of being silently dropped.
  return new SignalChannel(account, rpcAddr, {
    ...opts,
    autoRegisterGroups: SIGNAL_AUTO_REGISTER_GROUPS,
    tee,
  });
});
