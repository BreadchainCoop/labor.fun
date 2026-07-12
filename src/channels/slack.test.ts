import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Jonesy',
  TRIGGER_PATTERN: /^@Jonesy\b/i,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock db
vi.mock('../db.js', () => ({
  updateChatName: vi.fn(),
}));

// --- @slack/bolt mock ---

type Handler = (...args: any[]) => any;

const appRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('@slack/bolt', () => ({
  App: class MockApp {
    eventHandlers = new Map<string, Handler>();
    token: string;
    appToken: string;

    client = {
      auth: {
        test: vi.fn().mockResolvedValue({ user_id: 'U_BOT_123' }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      // Native AI Assistant surface (assistant.threads.*) — scope assistant:write.
      assistant: {
        threads: {
          setStatus: vi.fn().mockResolvedValue(undefined),
          setSuggestedPrompts: vi.fn().mockResolvedValue(undefined),
          setTitle: vi.fn().mockResolvedValue(undefined),
        },
      },
      conversations: {
        list: vi.fn().mockResolvedValue({
          channels: [],
          response_metadata: {},
        }),
      },
      users: {
        info: vi.fn().mockResolvedValue({
          user: { real_name: 'Alice Smith', name: 'alice' },
        }),
      },
    };

    constructor(opts: any) {
      this.token = opts.token;
      this.appToken = opts.appToken;
      appRef.current = this;
    }

    event(name: string, handler: Handler) {
      this.eventHandlers.set(name, handler);
    }

    async start() {}
    async stop() {}
  },
  LogLevel: { ERROR: 'error' },
}));

// Mock env
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({
    SLACK_BOT_TOKEN: 'xoxb-test-token',
    SLACK_APP_TOKEN: 'xapp-test-token',
  }),
}));

import { SlackChannel, SlackChannelOpts } from './slack.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<SlackChannelOpts>,
): SlackChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'slack:C0123456789': {
        name: 'Test Channel',
        folder: 'test-channel',
        trigger: '@Jonesy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createMessageEvent(overrides: {
  channel?: string;
  channelType?: string;
  user?: string;
  text?: string;
  ts?: string;
  threadTs?: string;
  subtype?: string;
  botId?: string;
}) {
  return {
    channel: overrides.channel ?? 'C0123456789',
    channel_type: overrides.channelType ?? 'channel',
    user: overrides.user ?? 'U_USER_456',
    text: 'text' in overrides ? overrides.text : 'Hello everyone',
    ts: overrides.ts ?? '1704067200.000000',
    thread_ts: overrides.threadTs,
    subtype: overrides.subtype,
    bot_id: overrides.botId,
  };
}

function currentApp() {
  return appRef.current;
}

async function triggerMessageEvent(
  event: ReturnType<typeof createMessageEvent>,
) {
  const handler = currentApp().eventHandlers.get('message');
  if (handler) await handler({ event });
}

function createAssistantThreadStartedEvent(overrides?: {
  channelId?: string;
  threadTs?: string;
  userId?: string;
}) {
  return {
    type: 'assistant_thread_started' as const,
    assistant_thread: {
      user_id: overrides?.userId ?? 'U_USER_456',
      context: { channel_id: overrides?.channelId ?? 'D_ASSISTANT_1' },
      channel_id: overrides?.channelId ?? 'D_ASSISTANT_1',
      thread_ts: overrides?.threadTs ?? '1704067100.000000',
    },
    event_ts: '1704067100.000100',
  };
}

async function triggerAssistantThreadStarted(
  event: ReturnType<typeof createAssistantThreadStartedEvent>,
) {
  const handler = currentApp().eventHandlers.get('assistant_thread_started');
  if (handler) await handler({ event });
}

// --- Tests ---

describe('SlackChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Assistant surface is opt-in; keep it OFF for every existing test so the
    // default (existing) behavior is exercised unchanged. Assistant tests set
    // it explicitly.
    delete process.env.SLACK_ASSISTANT_ENABLED;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SLACK_ASSISTANT_ENABLED;
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when app starts', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('registers message event handler on construction', () => {
      const opts = createTestOpts();
      new SlackChannel(opts);

      expect(currentApp().eventHandlers.has('message')).toBe(true);
    });

    it('gets bot user ID on connect', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.connect();

      expect(currentApp().client.auth.test).toHaveBeenCalled();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Message handling ---

  describe('message handling', () => {
    it('delivers message for registered channel', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ text: 'Hello everyone' });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.any(String),
        undefined,
        'slack',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          id: '1704067200.000000',
          chat_jid: 'slack:C0123456789',
          sender: 'U_USER_456',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered channels', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ channel: 'C9999999999' });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:C9999999999',
        expect.any(String),
        undefined,
        'slack',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips non-text subtypes (channel_join, etc.)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ subtype: 'channel_join' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('allows bot_message subtype through', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        subtype: 'bot_message',
        botId: 'B_OTHER_BOT',
        text: 'Bot message',
      });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalled();
    });

    it('skips messages with no text', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ text: undefined as any });
      await triggerMessageEvent(event);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('detects bot messages by bot_id', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        subtype: 'bot_message',
        botId: 'B_MY_BOT',
        text: 'Bot response',
      });
      await triggerMessageEvent(event);

      // Has bot_id so should be marked as bot message
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          is_from_me: true,
          is_bot_message: true,
          sender_name: 'Jonesy',
        }),
      );
    });

    it('detects bot messages by matching bot user ID', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        user: 'U_BOT_123',
        text: 'Self message',
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          is_from_me: true,
          is_bot_message: true,
        }),
      );
    });

    it('identifies IM channel type as non-group', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'slack:D0123456789': {
            name: 'DM',
            folder: 'dm',
            trigger: '@Jonesy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        channel: 'D0123456789',
        channelType: 'im',
      });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:D0123456789',
        expect.any(String),
        undefined,
        'slack',
        false, // IM is not a group
      );
    });

    it('converts ts to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ ts: '1704067200.000000' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });

    it('resolves user name from Slack API', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ user: 'U_USER_456', text: 'Hello' });
      await triggerMessageEvent(event);

      expect(currentApp().client.users.info).toHaveBeenCalledWith({
        user: 'U_USER_456',
      });
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          sender_name: 'Alice Smith',
        }),
      );
    });

    it('resolves <@U…> mentions in the message text to readable names', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await triggerMessageEvent(
        createMessageEvent({
          user: 'U_USER_456',
          text: 'set up a biweekly with <@U08J28F8FL5> please',
        }),
      );

      expect(currentApp().client.users.info).toHaveBeenCalledWith({
        user: 'U08J28F8FL5',
      });
      // The mock resolves every user to "Alice Smith", so the raw mention ID
      // is replaced by a readable @name the agent can act on.
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'set up a biweekly with @Alice Smith please',
        }),
      );
    });

    it('leaves a mention untouched when the user cannot be resolved', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();
      currentApp().client.users.info.mockRejectedValue(new Error('no scope'));

      await triggerMessageEvent(
        createMessageEvent({
          user: 'U_USER_456',
          text: 'ping <@U08J28F8FL5>',
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({ content: 'ping <@U08J28F8FL5>' }),
      );
    });

    it('auto-registers an unregistered DM from a known sender and processes it', async () => {
      const ensureDmRegistered = vi.fn(() => true);
      const opts = createTestOpts({ ensureDmRegistered });
      const channel = new SlackChannel(opts);
      await channel.connect();

      await triggerMessageEvent(
        createMessageEvent({
          channel: 'D999',
          channelType: 'im',
          user: 'U_KNOWN',
          text: 'hello vinny',
        }),
      );

      expect(ensureDmRegistered).toHaveBeenCalledWith(
        'slack:D999',
        'slack',
        'U_KNOWN',
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:D999',
        expect.objectContaining({ sender: 'U_KNOWN' }),
      );
    });

    it('drops an unregistered DM from an unknown sender', async () => {
      const ensureDmRegistered = vi.fn(() => false);
      const opts = createTestOpts({ ensureDmRegistered });
      const channel = new SlackChannel(opts);
      await channel.connect();

      await triggerMessageEvent(
        createMessageEvent({
          channel: 'D999',
          channelType: 'im',
          user: 'U_STRANGER',
          text: 'hi',
        }),
      );

      expect(ensureDmRegistered).toHaveBeenCalledWith(
        'slack:D999',
        'slack',
        'U_STRANGER',
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('never auto-registers an unregistered non-DM (group) channel', async () => {
      const ensureDmRegistered = vi.fn(() => true);
      const opts = createTestOpts({ ensureDmRegistered });
      const channel = new SlackChannel(opts);
      await channel.connect();

      await triggerMessageEvent(
        createMessageEvent({
          channel: 'C_UNREG',
          channelType: 'channel',
          user: 'U_KNOWN',
          text: 'hi',
        }),
      );

      expect(ensureDmRegistered).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('caches user names to avoid repeated API calls', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // First message — API call
      await triggerMessageEvent(
        createMessageEvent({ user: 'U_USER_456', text: 'First' }),
      );
      // Second message — should use cache
      await triggerMessageEvent(
        createMessageEvent({
          user: 'U_USER_456',
          text: 'Second',
          ts: '1704067201.000000',
        }),
      );

      expect(currentApp().client.users.info).toHaveBeenCalledTimes(1);
    });

    it('falls back to user ID when API fails', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.users.info.mockRejectedValueOnce(
        new Error('API error'),
      );

      const event = createMessageEvent({ user: 'U_UNKNOWN', text: 'Hi' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          sender_name: 'U_UNKNOWN',
        }),
      );
    });

    it('delivers threaded replies with thread_id', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        ts: '1704067201.000000',
        threadTs: '1704067200.000000', // parent message ts — this is a reply
        text: 'Thread reply',
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Thread reply',
          thread_id: '1704067200.000000',
        }),
      );
    });

    it('delivers thread parent messages without thread_id', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        ts: '1704067200.000000',
        threadTs: '1704067200.000000', // same as ts — this IS the parent
        text: 'Thread parent',
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Thread parent',
          thread_id: undefined,
        }),
      );
    });

    it('delivers messages without thread_ts normally', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ text: 'Normal message' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          thread_id: undefined,
        }),
      );
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('prepends trigger when bot is @mentioned via Slack format', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect(); // sets botUserId to 'U_BOT_123'

      const event = createMessageEvent({
        text: 'Hey <@U_BOT_123> what do you think?',
        user: 'U_USER_456',
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: '@Jonesy Hey <@U_BOT_123> what do you think?',
        }),
      );
    });

    it('does not prepend trigger when trigger pattern already matches', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        text: '@Jonesy <@U_BOT_123> hello',
        user: 'U_USER_456',
      });
      await triggerMessageEvent(event);

      // Content should be unchanged since it already matches TRIGGER_PATTERN
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: '@Jonesy <@U_BOT_123> hello',
        }),
      );
    });

    it('does not translate mentions in bot messages', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        text: 'Echo: <@U_BOT_123>',
        subtype: 'bot_message',
        botId: 'B_MY_BOT',
      });
      await triggerMessageEvent(event);

      // Bot messages skip mention translation
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Echo: <@U_BOT_123>',
        }),
      );
    });

    it('does not translate mentions for other users', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        text: 'Hey <@U_OTHER_USER> look at this',
        user: 'U_USER_456',
      });
      await triggerMessageEvent(event);

      // Mention is for a different user, not the bot
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Hey <@U_OTHER_USER> look at this',
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via Slack client', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage('slack:C0123456789', 'Hello');

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Hello',
      });
    });

    it('strips slack: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage('slack:D9876543210', 'DM message');

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'D9876543210',
        text: 'DM message',
      });
    });

    it('queues message when disconnected', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // Don't connect — should queue
      await channel.sendMessage('slack:C0123456789', 'Queued message');

      expect(currentApp().client.chat.postMessage).not.toHaveBeenCalled();
    });

    it('queues message on send failure', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.chat.postMessage.mockRejectedValueOnce(
        new Error('Network error'),
      );

      // Should not throw
      await expect(
        channel.sendMessage('slack:C0123456789', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('splits long messages at 4000 character boundary', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // Create a message longer than 4000 chars
      const longText = 'A'.repeat(4500);
      await channel.sendMessage('slack:C0123456789', longText);

      // Should be split into 2 messages: 4000 + 500
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(2);
      expect(currentApp().client.chat.postMessage).toHaveBeenNthCalledWith(1, {
        channel: 'C0123456789',
        text: 'A'.repeat(4000),
      });
      expect(currentApp().client.chat.postMessage).toHaveBeenNthCalledWith(2, {
        channel: 'C0123456789',
        text: 'A'.repeat(500),
      });
    });

    it('sends exactly-4000-char messages as a single message', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const text = 'B'.repeat(4000);
      await channel.sendMessage('slack:C0123456789', text);

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(1);
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text,
      });
    });

    it('splits messages into 3 parts when over 8000 chars', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const longText = 'C'.repeat(8500);
      await channel.sendMessage('slack:C0123456789', longText);

      // 4000 + 4000 + 500 = 3 messages
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(3);
    });

    it('flushes queued messages on connect', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // Queue messages while disconnected
      await channel.sendMessage('slack:C0123456789', 'First queued');
      await channel.sendMessage('slack:C0123456789', 'Second queued');

      expect(currentApp().client.chat.postMessage).not.toHaveBeenCalled();

      // Connect triggers flush
      await channel.connect();

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'First queued',
      });
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Second queued',
      });
    });
  });

  // --- message_changed (edits) ---

  describe('message edits', () => {
    it('delivers edited messages with [edited] prefix', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = {
        subtype: 'message_changed',
        channel: 'C0123456789',
        channel_type: 'channel',
        message: {
          user: 'U_USER_456',
          text: 'Updated text',
          ts: '1704067200.000000',
        },
        previous_message: {
          text: 'Original text',
        },
        ts: '1704067201.000000',
      };
      await triggerMessageEvent(event as any);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: '[edited] Updated text',
          id: '1704067200.000000',
          sender: 'U_USER_456',
        }),
      );
    });

    it('skips edits with no text', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = {
        subtype: 'message_changed',
        channel: 'C0123456789',
        channel_type: 'channel',
        message: { user: 'U_USER_456', ts: '1704067200.000000' },
        ts: '1704067201.000000',
      };
      await triggerMessageEvent(event as any);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips edits for unregistered channels', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({})),
      });
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = {
        subtype: 'message_changed',
        channel: 'C0123456789',
        channel_type: 'channel',
        message: {
          user: 'U_USER_456',
          text: 'Edited',
          ts: '1704067200.000000',
        },
        ts: '1704067201.000000',
      };
      await triggerMessageEvent(event as any);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('translates @mentions in edited messages', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = {
        subtype: 'message_changed',
        channel: 'C0123456789',
        channel_type: 'channel',
        message: {
          user: 'U_USER_456',
          text: 'Hey <@U_BOT_123> help me',
          ts: '1704067200.000000',
        },
        ts: '1704067201.000000',
      };
      await triggerMessageEvent(event as any);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: '[edited] @Jonesy Hey <@U_BOT_123> help me',
        }),
      );
    });
  });

  // --- Thread-aware sending ---

  describe('thread-aware sending', () => {
    it('sends reply in thread when last inbound was threaded', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // Receive a threaded message
      const event = createMessageEvent({
        ts: '1704067201.000000',
        threadTs: '1704067200.000000',
        text: '@Jonesy help',
      });
      await triggerMessageEvent(event);

      // Send a reply — should go to the thread
      await channel.sendMessage('slack:C0123456789', 'Here to help');

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Here to help',
        thread_ts: '1704067200.000000',
      });
    });

    it('sends to channel when no thread context', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage('slack:C0123456789', 'Channel message');

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Channel message',
      });
    });

    it('clears thread context after sending', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // Receive threaded message
      const event = createMessageEvent({
        ts: '1704067201.000000',
        threadTs: '1704067200.000000',
        text: 'Thread msg',
      });
      await triggerMessageEvent(event);

      // First send goes to thread
      await channel.sendMessage('slack:C0123456789', 'Reply 1');
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ thread_ts: '1704067200.000000' }),
      );

      vi.mocked(currentApp().client.chat.postMessage).mockClear();

      // Second send goes to channel (thread context cleared)
      await channel.sendMessage('slack:C0123456789', 'Reply 2');
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Reply 2',
      });
    });

    it('does not set thread context for thread parent messages', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // Thread parent: thread_ts === ts
      const event = createMessageEvent({
        ts: '1704067200.000000',
        threadTs: '1704067200.000000',
        text: 'Thread parent',
      });
      await triggerMessageEvent(event);

      await channel.sendMessage('slack:C0123456789', 'Response');
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Response',
      });
    });

    // Regression for #46: a reply must land in the thread of the message it
    // answers, even when a later message in a *different* thread arrived first
    // and overwrote the per-channel "last thread" anchor.
    it('replies in the triggering message thread, not the last-seen one', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // First request, in thread A
      await triggerMessageEvent(
        createMessageEvent({
          ts: '1704067201.000000',
          threadTs: '1704067200.000000', // thread A
          text: '@Jonesy question A',
        }),
      );
      // Second request arrives in thread B before A is answered — this
      // overwrites lastThreadTs for the channel.
      await triggerMessageEvent(
        createMessageEvent({
          ts: '1704067301.000000',
          threadTs: '1704067300.000000', // thread B
          text: '@Jonesy question B',
        }),
      );

      // Reply to request A — must go to thread A despite B being most recent.
      await channel.sendMessage('slack:C0123456789', 'Answer to A', {
        replyToMessageId: '1704067201.000000',
      });

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Answer to A',
        thread_ts: '1704067200.000000', // thread A, not B
      });
    });

    // The bot's reply to a user should land as a threaded reply to that user's
    // original message, even when the message was posted at the channel root
    // (no pre-existing thread). The reply roots a new thread on the triggering
    // message by using its own ts as thread_ts.
    it('roots a new thread on a top-level triggering message', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // Top-level message: no thread_ts.
      await triggerMessageEvent(
        createMessageEvent({
          ts: '1704067400.000000',
          text: '@Jonesy hello',
        }),
      );

      await channel.sendMessage('slack:C0123456789', 'Hi there', {
        replyToMessageId: '1704067400.000000',
      });

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Hi there',
        thread_ts: '1704067400.000000', // threaded under the user's message
      });
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns slack: JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('slack:C0123456789')).toBe(true);
    });

    it('owns slack: DM JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('slack:D0123456789')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own WhatsApp DM JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- syncChannelMetadata ---

  describe('syncChannelMetadata', () => {
    it('calls conversations.list and updates chat names', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      currentApp().client.conversations.list.mockResolvedValue({
        channels: [
          { id: 'C001', name: 'general', is_member: true },
          { id: 'C002', name: 'random', is_member: true },
          { id: 'C003', name: 'external', is_member: false },
        ],
        response_metadata: {},
      });

      await channel.connect();

      // connect() calls syncChannelMetadata internally
      expect(updateChatName).toHaveBeenCalledWith('slack:C001', 'general');
      expect(updateChatName).toHaveBeenCalledWith('slack:C002', 'random');
      // Non-member channels are skipped
      expect(updateChatName).not.toHaveBeenCalledWith('slack:C003', 'external');
    });

    it('handles API errors gracefully', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      currentApp().client.conversations.list.mockRejectedValue(
        new Error('API error'),
      );

      // Should not throw
      await expect(channel.connect()).resolves.toBeUndefined();
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('resolves without error (no-op)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // Should not throw — Slack has no bot typing indicator API
      await expect(
        channel.setTyping('slack:C0123456789', true),
      ).resolves.toBeUndefined();
    });

    it('accepts false without error', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await expect(
        channel.setTyping('slack:C0123456789', false),
      ).resolves.toBeUndefined();
    });
  });

  // --- Constructor error handling ---

  describe('constructor', () => {
    it('throws when SLACK_BOT_TOKEN is missing', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        SLACK_BOT_TOKEN: '',
        SLACK_APP_TOKEN: 'xapp-test-token',
      });

      expect(() => new SlackChannel(createTestOpts())).toThrow(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    });

    it('throws when SLACK_APP_TOKEN is missing', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        SLACK_BOT_TOKEN: 'xoxb-test-token',
        SLACK_APP_TOKEN: '',
      });

      expect(() => new SlackChannel(createTestOpts())).toThrow(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    });
  });

  // --- syncChannelMetadata pagination ---

  describe('syncChannelMetadata pagination', () => {
    it('paginates through multiple pages of channels', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // First page returns a cursor; second page returns no cursor
      currentApp()
        .client.conversations.list.mockResolvedValueOnce({
          channels: [{ id: 'C001', name: 'general', is_member: true }],
          response_metadata: { next_cursor: 'cursor_page2' },
        })
        .mockResolvedValueOnce({
          channels: [{ id: 'C002', name: 'random', is_member: true }],
          response_metadata: {},
        });

      await channel.connect();

      // Should have called conversations.list twice (once per page)
      expect(currentApp().client.conversations.list).toHaveBeenCalledTimes(2);
      expect(currentApp().client.conversations.list).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ cursor: 'cursor_page2' }),
      );

      // Both channels from both pages stored
      expect(updateChatName).toHaveBeenCalledWith('slack:C001', 'general');
      expect(updateChatName).toHaveBeenCalledWith('slack:C002', 'random');
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "slack"', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.name).toBe('slack');
    });
  });

  // --- Native AI Assistant surface (SLACK_ASSISTANT_ENABLED) ---

  describe('AI Assistant surface', () => {
    const ASSISTANT_JID = 'slack:D_ASSISTANT_1';
    const ASSISTANT_THREAD_TS = '1704067100.000000';

    // Registered opts including the assistant DM channel so its messages are
    // delivered to onMessage (and thus reach the status-setting path).
    function assistantOpts(
      overrides?: Partial<SlackChannelOpts>,
    ): SlackChannelOpts {
      return createTestOpts({
        registeredGroups: vi.fn(() => ({
          [ASSISTANT_JID]: {
            name: 'Assistant DM',
            folder: 'assistant-dm',
            trigger: '@Jonesy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
        ...overrides,
      });
    }

    it('registers the assistant_thread_started handler only when enabled', () => {
      new SlackChannel(createTestOpts());
      expect(
        currentApp().eventHandlers.has('assistant_thread_started'),
      ).toBe(false);

      process.env.SLACK_ASSISTANT_ENABLED = 'true';
      new SlackChannel(createTestOpts());
      expect(
        currentApp().eventHandlers.has('assistant_thread_started'),
      ).toBe(true);
    });

    it('on assistant_thread_started: greets and sets suggested prompts', async () => {
      process.env.SLACK_ASSISTANT_ENABLED = 'true';
      const channel = new SlackChannel(assistantOpts());
      await channel.connect();

      await triggerAssistantThreadStarted(
        createAssistantThreadStartedEvent({
          channelId: 'D_ASSISTANT_1',
          threadTs: ASSISTANT_THREAD_TS,
        }),
      );

      // Greeting posted into the assistant thread.
      const posts = currentApp().client.chat.postMessage.mock.calls;
      const greeting = posts.find(
        (c: any[]) => c[0].thread_ts === ASSISTANT_THREAD_TS,
      );
      expect(greeting).toBeDefined();
      expect(greeting[0].channel).toBe('D_ASSISTANT_1');
      expect(String(greeting[0].text)).toContain('Jonesy');

      // Suggested prompts set (2–4 on-brand prompts) via assistant.threads.
      const setPrompts =
        currentApp().client.assistant.threads.setSuggestedPrompts;
      expect(setPrompts).toHaveBeenCalledTimes(1);
      const promptArg = setPrompts.mock.calls[0][0];
      expect(promptArg.channel_id).toBe('D_ASSISTANT_1');
      expect(promptArg.thread_ts).toBe(ASSISTANT_THREAD_TS);
      expect(promptArg.prompts.length).toBeGreaterThanOrEqual(2);
      expect(promptArg.prompts.length).toBeLessThanOrEqual(4);
      for (const p of promptArg.prompts) {
        expect(typeof p.title).toBe('string');
        expect(typeof p.message).toBe('string');
      }

      // Optional title set.
      expect(
        currentApp().client.assistant.threads.setTitle,
      ).toHaveBeenCalled();
    });

    it('on an assistant-thread user message: sets thinking status, delivers to onMessage, clears status on reply', async () => {
      process.env.SLACK_ASSISTANT_ENABLED = 'true';
      const onMessage = vi.fn();
      const channel = new SlackChannel(assistantOpts({ onMessage }));
      await channel.connect();

      // Open the assistant thread so the channel learns its thread_ts.
      await triggerAssistantThreadStarted(
        createAssistantThreadStartedEvent({
          channelId: 'D_ASSISTANT_1',
          threadTs: ASSISTANT_THREAD_TS,
        }),
      );

      // User replies inside the assistant thread (message.im with thread_ts).
      await triggerMessageEvent(
        createMessageEvent({
          channel: 'D_ASSISTANT_1',
          channelType: 'im',
          user: 'U_USER_456',
          text: "What's on our agenda?",
          ts: '1704067200.000000',
          threadTs: ASSISTANT_THREAD_TS,
        }),
      );

      // Status set to "is thinking…".
      const setStatus = currentApp().client.assistant.threads.setStatus;
      expect(setStatus).toHaveBeenCalled();
      const thinkingCall = setStatus.mock.calls.find(
        (c: any[]) => c[0].status && c[0].status.length > 0,
      );
      expect(thinkingCall).toBeDefined();
      expect(thinkingCall[0].channel_id).toBe('D_ASSISTANT_1');
      expect(thinkingCall[0].thread_ts).toBe(ASSISTANT_THREAD_TS);

      // Message delivered through the existing agent path (onMessage).
      expect(onMessage).toHaveBeenCalledTimes(1);
      const [jid, delivered] = onMessage.mock.calls[0];
      expect(jid).toBe(ASSISTANT_JID);
      expect(delivered.content).toContain("What's on our agenda?");

      // Agent reply comes back through sendMessage, anchored to the message.
      await channel.sendMessage(ASSISTANT_JID, 'Here is the agenda.', {
        replyToMessageId: '1704067200.000000',
      });

      // Status cleared (empty string) exactly once when the reply lands.
      const clearCall = setStatus.mock.calls.find(
        (c: any[]) => c[0].status === '',
      );
      expect(clearCall).toBeDefined();
      expect(clearCall[0].thread_ts).toBe(ASSISTANT_THREAD_TS);

      // Reply actually posted into the assistant thread.
      const replyPost = currentApp().client.chat.postMessage.mock.calls.find(
        (c: any[]) =>
          c[0].text === 'Here is the agenda.' &&
          c[0].thread_ts === ASSISTANT_THREAD_TS,
      );
      expect(replyPost).toBeDefined();
    });

    it('flag OFF: no assistant handler, no assistant.threads.* calls, normal path preserved', async () => {
      // SLACK_ASSISTANT_ENABLED unset (default) — see beforeEach.
      const onMessage = vi.fn();
      const channel = new SlackChannel(assistantOpts({ onMessage }));
      await channel.connect();

      // No assistant_thread_started handler is even registered.
      expect(
        currentApp().eventHandlers.has('assistant_thread_started'),
      ).toBe(false);

      // A DM that (were the flag on) would be an assistant-thread message still
      // flows through the normal path and touches NONE of the assistant APIs.
      await triggerMessageEvent(
        createMessageEvent({
          channel: 'D_ASSISTANT_1',
          channelType: 'im',
          user: 'U_USER_456',
          text: 'Hello there',
          ts: '1704067200.000000',
          threadTs: ASSISTANT_THREAD_TS,
        }),
      );

      // Normal delivery preserved.
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage.mock.calls[0][1].content).toContain('Hello there');

      // Zero assistant.threads.* calls.
      expect(
        currentApp().client.assistant.threads.setStatus,
      ).not.toHaveBeenCalled();
      expect(
        currentApp().client.assistant.threads.setSuggestedPrompts,
      ).not.toHaveBeenCalled();
      expect(
        currentApp().client.assistant.threads.setTitle,
      ).not.toHaveBeenCalled();

      // A normal reply still sends, without any status calls.
      await channel.sendMessage(ASSISTANT_JID, 'Hi back', {
        replyToMessageId: '1704067200.000000',
      });
      expect(
        currentApp().client.assistant.threads.setStatus,
      ).not.toHaveBeenCalled();
    });
  });
});
