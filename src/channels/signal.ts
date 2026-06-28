import net from 'net';

import { ASSISTANT_NAME } from '../config.js';
import { logReaction, storeOutboundMessage } from '../db.js';
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

    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid }, 'Message from unregistered Signal chat');
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
  const envVars = readEnvFile(['SIGNAL_ACCOUNT', 'SIGNAL_RPC_TCP']);
  const account = process.env.SIGNAL_ACCOUNT || envVars.SIGNAL_ACCOUNT || '';
  if (!account) {
    logger.warn('Signal: SIGNAL_ACCOUNT not set');
    return null;
  }
  const rpcAddr =
    process.env.SIGNAL_RPC_TCP || envVars.SIGNAL_RPC_TCP || '127.0.0.1:7583';
  return new SignalChannel(account, rpcAddr, opts);
});
