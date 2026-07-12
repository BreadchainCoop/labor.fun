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

// Stub the TEE attestation module so `!verify` tests never touch a real socket.
// The channel still owns command routing + reply-sending, which is what we test.
const attestNonce = vi.fn(async (..._a: any[]) => ({
  inTee: true,
  nonce: 'stub',
  verifyUrl: 'https://proof.phala.network',
}));
vi.mock('../tee-attest.js', async () => {
  const actual =
    await vi.importActual<typeof import('../tee-attest.js')>(
      '../tee-attest.js',
    );
  return {
    ...actual,
    attestNonce: (...a: any[]) => attestNonce(...a),
    formatAttestationReply: () => 'ATTESTATION_REPLY',
  };
});

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
  attestNonce.mockClear();
});

/** Feed a DM into a channel and drain the fake socket's request writes. */
function feedDm(content: string) {
  socketRef.current.feed({
    jsonrpc: '2.0',
    method: 'receive',
    params: {
      envelope: {
        source: '+15550001111',
        sourceNumber: '+15550001111',
        sourceName: 'Jane',
        timestamp: 1700000009999,
        dataMessage: { message: content },
      },
    },
  });
}

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

  describe('!verify (TEE attestation)', () => {
    it('intercepts a valid !verify in TEE mode: attests and replies, never routes to the agent', async () => {
      const onMessage = vi.fn();
      const ch = new SignalChannel(
        '+15559990000',
        '127.0.0.1:7583',
        createOpts({
          onMessage,
          tee: { enabled: true, socketPath: '/tmp/x.sock' },
        }),
      );
      await ch.connect();

      feedDm('!verify my-nonce-1234');
      // Let the async handleVerify → sendMessage → request() run.
      await new Promise((r) => setTimeout(r, 0));

      // Agent never sees a !verify command.
      expect(onMessage).not.toHaveBeenCalled();
      // Attestation was requested with the parsed nonce.
      expect(attestNonce).toHaveBeenCalledWith(
        'my-nonce-1234',
        expect.objectContaining({ socketPath: '/tmp/x.sock' }),
      );
      // A `send` reply carrying the formatted attestation went out.
      const req = socketRef.current.lastRequest();
      expect(req.method).toBe('send');
      expect(req.params.message).toBe('ATTESTATION_REPLY');
    });

    it('replies with usage help for a bare !verify (no nonce), no attestation call', async () => {
      const onMessage = vi.fn();
      const ch = new SignalChannel(
        '+15559990000',
        '127.0.0.1:7583',
        createOpts({ onMessage, tee: { enabled: true } }),
      );
      await ch.connect();

      feedDm('!verify');
      await new Promise((r) => setTimeout(r, 0));

      expect(onMessage).not.toHaveBeenCalled();
      expect(attestNonce).not.toHaveBeenCalled();
      const req = socketRef.current.lastRequest();
      expect(req.method).toBe('send');
      // sendMessage strips backtick markers into Signal MONOSPACE ranges, so
      // the delivered plain text drops the backticks.
      expect(req.params.message).toContain('Usage: !verify <nonce>');
    });

    it('rejects a malformed nonce with guidance, no attestation call', async () => {
      const ch = new SignalChannel(
        '+15559990000',
        '127.0.0.1:7583',
        createOpts({ tee: { enabled: true } }),
      );
      await ch.connect();

      feedDm('!verify short'); // 5 chars, below the 8-char minimum
      await new Promise((r) => setTimeout(r, 0));

      expect(attestNonce).not.toHaveBeenCalled();
      const req = socketRef.current.lastRequest();
      expect(req.params.message).toContain('not valid');
    });

    it('does NOT intercept !verify when TEE mode is disabled — flows to the agent', async () => {
      const onMessage = vi.fn();
      const ch = new SignalChannel(
        '+15559990000',
        '127.0.0.1:7583',
        createOpts({ onMessage }), // no tee → disabled
      );
      await ch.connect();

      feedDm('!verify my-nonce-1234');
      await new Promise((r) => setTimeout(r, 0));

      expect(attestNonce).not.toHaveBeenCalled();
      // The message is routed to the agent like any other message.
      expect(onMessage).toHaveBeenCalledWith(
        'signal:+15550001111',
        expect.objectContaining({ content: '!verify my-nonce-1234' }),
      );
    });
  });
});

// ─── Auto-registration (SIGNAL_AUTO_REGISTER_GROUPS + ensureDmRegistered) ────

/**
 * A mutable registry so a registerGroup / ensureDmRegistered call is visible to
 * the channel's re-read of registeredGroups()[chatJid] within the same receive.
 */
function autoHarness(overrides?: Partial<SignalChannelOpts>): {
  opts: SignalChannelOpts;
  groups: Record<string, any>;
  registerGroup: ReturnType<typeof vi.fn>;
  onMessage: ReturnType<typeof vi.fn>;
} {
  const groups: Record<string, any> = {};
  const registerGroup = vi.fn((jid: string, g: any) => {
    groups[jid] = g;
  });
  const onMessage = vi.fn();
  const opts: SignalChannelOpts = {
    onMessage,
    onChatMetadata: vi.fn(),
    registeredGroups: () => groups,
    registerGroup,
    ...overrides,
  };
  return { opts, groups, registerGroup, onMessage };
}

/** Feed an inbound message from an arbitrary sender / optional group. */
function feed(opts: {
  source: string;
  sourceName?: string;
  message: string;
  groupId?: string;
  timestamp?: number;
}): void {
  socketRef.current.feed({
    jsonrpc: '2.0',
    method: 'receive',
    params: {
      envelope: {
        source: opts.source,
        sourceNumber: opts.source,
        sourceName: opts.sourceName,
        timestamp: opts.timestamp ?? 1700000012345,
        dataMessage: {
          message: opts.message,
          ...(opts.groupId
            ? { groupInfo: { groupId: opts.groupId, type: 'DELIVER' } }
            : {}),
        },
      },
    },
  });
}

describe('SignalChannel auto-registration', () => {
  it('auto-registers an unregistered GROUP and then processes the message (requiresTrigger true)', async () => {
    const { opts, registerGroup, onMessage } = autoHarness({
      autoRegisterGroups: true,
    });
    const ch = new SignalChannel('+15559990000', '127.0.0.1:7583', opts);
    await ch.connect();

    feed({
      source: '+15550002222',
      sourceName: 'Bob',
      message: 'hi team',
      groupId: 'R0lE',
    });

    expect(registerGroup).toHaveBeenCalledTimes(1);
    expect(registerGroup).toHaveBeenCalledWith(
      'signal:group:R0lE',
      expect.objectContaining({
        folder: 'signal_R0lE',
        requiresTrigger: true,
      }),
    );
    // The just-registered group's message flows through to onMessage.
    expect(onMessage).toHaveBeenCalledWith(
      'signal:group:R0lE',
      expect.objectContaining({ content: 'hi team' }),
    );
  });

  it('auto-registers an unregistered DM (requiresTrigger false) and processes it', async () => {
    const { opts, registerGroup, onMessage } = autoHarness({
      autoRegisterGroups: true,
    });
    const ch = new SignalChannel('+15559990000', '127.0.0.1:7583', opts);
    await ch.connect();

    feed({ source: '+15550009999', sourceName: 'Zed', message: 'hello' });

    expect(registerGroup).toHaveBeenCalledWith(
      'signal:+15550009999',
      expect.objectContaining({
        name: 'Zed',
        folder: 'signal_zed',
        requiresTrigger: false,
      }),
    );
    expect(onMessage).toHaveBeenCalledWith(
      'signal:+15550009999',
      expect.objectContaining({ content: 'hello' }),
    );
  });

  it('drops an unregistered chat when auto-register is OFF and no ensureDmRegistered match', async () => {
    const { opts, registerGroup, onMessage } = autoHarness({
      autoRegisterGroups: false,
    });
    const ch = new SignalChannel('+15559990000', '127.0.0.1:7583', opts);
    await ch.connect();

    feed({ source: '+15550009999', sourceName: 'Zed', message: 'hello' });

    expect(registerGroup).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('registers a DM from a known KB person via ensureDmRegistered even with auto-register off', async () => {
    const groups: Record<string, any> = {};
    const ensureDmRegistered = vi.fn((jid: string) => {
      groups[jid] = {
        name: 'Known Person DM',
        folder: 'signal_dm_known',
        trigger: '@Breadbrich Engels',
        added_at: '2024-01-01T00:00:00.000Z',
        requiresTrigger: false,
      };
      return true;
    });
    const onMessage = vi.fn();
    const opts: SignalChannelOpts = {
      onMessage,
      onChatMetadata: vi.fn(),
      registeredGroups: () => groups,
      autoRegisterGroups: false,
      ensureDmRegistered,
    };
    const ch = new SignalChannel('+15559990000', '127.0.0.1:7583', opts);
    await ch.connect();

    feed({ source: '+15550007777', sourceName: 'Known', message: 'yo' });

    expect(ensureDmRegistered).toHaveBeenCalledWith(
      'signal:+15550007777',
      'signal',
      '+15550007777',
    );
    expect(onMessage).toHaveBeenCalledWith(
      'signal:+15550007777',
      expect.objectContaining({ content: 'yo' }),
    );
  });

  it('does NOT use ensureDmRegistered for group chats', async () => {
    const ensureDmRegistered = vi.fn(() => true);
    const { opts, onMessage } = autoHarness({
      autoRegisterGroups: false,
      ensureDmRegistered,
    });
    const ch = new SignalChannel('+15559990000', '127.0.0.1:7583', opts);
    await ch.connect();

    feed({ source: '+15550002222', message: 'group hi', groupId: 'R0lE' });

    expect(ensureDmRegistered).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('still intercepts !verify after a chat auto-registers (never routes to the agent)', async () => {
    const { opts, onMessage } = autoHarness({
      autoRegisterGroups: true,
      tee: { enabled: true, socketPath: '/tmp/x.sock' },
    });
    const ch = new SignalChannel('+15559990000', '127.0.0.1:7583', opts);
    await ch.connect();

    feed({
      source: '+15550009999',
      sourceName: 'Zed',
      message: '!verify my-nonce-1234',
    });
    await new Promise((r) => setTimeout(r, 0));

    // Auto-registered, but the verify command is answered locally, not routed.
    expect(onMessage).not.toHaveBeenCalled();
    expect(attestNonce).toHaveBeenCalledWith(
      'my-nonce-1234',
      expect.objectContaining({ socketPath: '/tmp/x.sock' }),
    );
    const req = socketRef.current.lastRequest();
    expect(req.method).toBe('send');
    expect(req.params.message).toBe('ATTESTATION_REPLY');
  });
});
