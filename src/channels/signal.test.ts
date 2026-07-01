import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Mocks ---

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../config.js', () => ({ ASSISTANT_NAME: 'Breadbrich Engels' }));
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const storeOutboundMessage = vi.fn();
const logReaction = vi.fn();
vi.mock('../db.js', () => ({
  storeOutboundMessage: (...a: any[]) => storeOutboundMessage(...a),
  logReaction: (...a: any[]) => logReaction(...a),
}));

// --- net mock: a fake socket that captures writes and exposes data emission ---

type Handler = (...args: any[]) => any;

const socketRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('net', () => {
  class MockSocket {
    handlers = new Map<string, Handler[]>();
    writes: string[] = [];
    destroyed = false;
    setEncoding() {}
    on(event: string, h: Handler) {
      const list = this.handlers.get(event) || [];
      list.push(h);
      this.handlers.set(event, list);
      return this;
    }
    emit(event: string, ...args: any[]) {
      (this.handlers.get(event) || []).forEach((h) => h(...args));
    }
    write(data: string) {
      this.writes.push(data);
      return true;
    }
    destroy() {
      this.destroyed = true;
    }
    // Test helper: feed a JSON-RPC line as if from the daemon.
    feed(obj: any) {
      this.emit('data', JSON.stringify(obj) + '\n');
    }
    lastRequest() {
      return JSON.parse(this.writes[this.writes.length - 1]);
    }
  }
  return {
    default: {
      createConnection: (_opts: any, onConnect: () => void) => {
        const s = new MockSocket();
        socketRef.current = s;
        // signal-cli "connects" synchronously in the mock
        onConnect();
        return s;
      },
    },
  };
});

import {
  SignalChannel,
  SignalChannelOpts,
  parseSignalStyles,
} from './signal.js';

function createOpts(overrides?: Partial<SignalChannelOpts>): SignalChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'signal:+15550001111': {
        name: 'Test DM',
        folder: 'signal_dm',
        trigger: '@Breadbrich Engels',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

beforeEach(() => {
  socketRef.current = null;
  storeOutboundMessage.mockClear();
  logReaction.mockClear();
});

describe('parseSignalStyles', () => {
  it('strips markers and records ranges', () => {
    const { text, textStyle } = parseSignalStyles(
      'a **bold** and _it_ and `code`',
    );
    expect(text).toBe('a bold and it and code');
    expect(textStyle).toEqual([
      { style: 'BOLD', start: 2, length: 4 },
      { style: 'ITALIC', start: 11, length: 2 },
      { style: 'MONOSPACE', start: 18, length: 4 },
    ]);
  });

  it('returns plain text unchanged when there are no markers', () => {
    const { text, textStyle } = parseSignalStyles('just plain text');
    expect(text).toBe('just plain text');
    expect(textStyle).toEqual([]);
  });
});

describe('SignalChannel', () => {
  it('owns only signal: JIDs', async () => {
    const ch = new SignalChannel(
      '+15559990000',
      '127.0.0.1:7583',
      createOpts(),
    );
    expect(ch.ownsJid('signal:+15550001111')).toBe(true);
    expect(ch.ownsJid('signal:group:abc==')).toBe(true);
    expect(ch.ownsJid('tg:123')).toBe(false);
  });

  it('delivers inbound DM messages for registered chats', async () => {
    const opts = createOpts();
    const ch = new SignalChannel('+15559990000', '127.0.0.1:7583', opts);
    await ch.connect();

    socketRef.current.feed({
      jsonrpc: '2.0',
      method: 'receive',
      params: {
        account: '+15559990000',
        envelope: {
          source: '+15550001111',
          sourceNumber: '+15550001111',
          sourceName: 'Jane',
          timestamp: 1700000000000,
          dataMessage: { message: 'hello there' },
        },
      },
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      'signal:+15550001111',
      expect.objectContaining({
        chat_jid: 'signal:+15550001111',
        sender: '+15550001111',
        sender_name: 'Jane',
        content: 'hello there',
        id: '1700000000000',
      }),
    );
  });

  it('routes group messages under signal:group:<id>', async () => {
    const onMessage = vi.fn();
    const opts = createOpts({
      onMessage,
      registeredGroups: vi.fn(() => ({
        'signal:group:R0lE': {
          name: 'Grp',
          folder: 'signal_grp',
          trigger: '@Breadbrich Engels',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      })),
    });
    const ch = new SignalChannel('+15559990000', '127.0.0.1:7583', opts);
    await ch.connect();

    socketRef.current.feed({
      jsonrpc: '2.0',
      method: 'receive',
      params: {
        envelope: {
          source: '+15550002222',
          sourceName: 'Bob',
          timestamp: 1700000000001,
          dataMessage: {
            message: 'group hi',
            groupInfo: { groupId: 'R0lE', type: 'DELIVER' },
          },
        },
      },
    });

    expect(onMessage).toHaveBeenCalledWith(
      'signal:group:R0lE',
      expect.objectContaining({ content: 'group hi' }),
    );
    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'signal:group:R0lE',
      expect.any(String),
      undefined,
      'signal',
      true,
    );
  });

  it('ignores messages from unregistered chats', async () => {
    const opts = createOpts({ registeredGroups: vi.fn(() => ({})) });
    const ch = new SignalChannel('+15559990000', '127.0.0.1:7583', opts);
    await ch.connect();
    socketRef.current.feed({
      jsonrpc: '2.0',
      method: 'receive',
      params: {
        envelope: {
          source: '+15550009999',
          timestamp: 1,
          dataMessage: { message: 'hi' },
        },
      },
    });
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('sends a DM as a JSON-RPC send with text styles', async () => {
    const ch = new SignalChannel(
      '+15559990000',
      '127.0.0.1:7583',
      createOpts(),
    );
    await ch.connect();

    const p = ch.sendMessage('signal:+15550001111', 'say **hi**');
    const req = socketRef.current.lastRequest();
    expect(req.method).toBe('send');
    expect(req.params).toMatchObject({
      account: '+15559990000',
      recipient: ['+15550001111'],
      message: 'say hi',
      textStyles: ['4:2:BOLD'],
    });

    // Daemon acknowledges with a timestamp → stored as the outbound id.
    socketRef.current.feed({
      jsonrpc: '2.0',
      id: req.id,
      result: { timestamp: 42 },
    });
    await p;
    expect(storeOutboundMessage).toHaveBeenCalledWith(
      'signal:+15550001111',
      '42',
      'say hi',
      'Breadbrich Engels',
    );
  });

  it('sends to a group using groupId', async () => {
    const ch = new SignalChannel(
      '+15559990000',
      '127.0.0.1:7583',
      createOpts(),
    );
    await ch.connect();
    const p = ch.sendMessage('signal:group:R0lE', 'plain');
    const req = socketRef.current.lastRequest();
    expect(req.params).toMatchObject({ groupId: 'R0lE', message: 'plain' });
    socketRef.current.feed({
      jsonrpc: '2.0',
      id: req.id,
      result: { timestamp: 7 },
    });
    await p;
  });

  it('reacts to a known inbound message via sendReaction', async () => {
    const ch = new SignalChannel(
      '+15559990000',
      '127.0.0.1:7583',
      createOpts(),
    );
    await ch.connect();
    // Inbound first so the author is remembered.
    socketRef.current.feed({
      jsonrpc: '2.0',
      method: 'receive',
      params: {
        envelope: {
          source: '+15550001111',
          sourceNumber: '+15550001111',
          sourceName: 'Jane',
          timestamp: 555,
          dataMessage: { message: 'hi' },
        },
      },
    });

    const p = ch.addReaction('signal:+15550001111', '555', 'eyes');
    const req = socketRef.current.lastRequest();
    expect(req.method).toBe('sendReaction');
    expect(req.params).toMatchObject({
      emoji: '👀',
      targetAuthor: '+15550001111',
      targetTimestamp: 555,
      remove: false,
    });
    socketRef.current.feed({ jsonrpc: '2.0', id: req.id, result: {} });
    await p;
    expect(logReaction).toHaveBeenCalled();
  });

  it('skips reactions for unknown messages', async () => {
    const ch = new SignalChannel(
      '+15559990000',
      '127.0.0.1:7583',
      createOpts(),
    );
    await ch.connect();
    await ch.addReaction('signal:+15550001111', '999', 'eyes');
    // No write should have gone out (only the request() path writes).
    expect(socketRef.current.writes.length).toBe(0);
  });
});
