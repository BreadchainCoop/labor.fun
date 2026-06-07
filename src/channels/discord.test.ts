import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock env reader (used by the factory, not needed in unit tests)
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  DISCORD_DM_ALLOWED_ROLE_IDS: [] as string[],
  DISCORD_DM_ALLOWED_GUILD_IDS: [] as string[],
  DISCORD_DM_ROLE_REFRESH_INTERVAL: 0,
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

// --- discord.js mock ---

type Handler = (...args: any[]) => any;

const clientRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('discord.js', () => {
  const Events = {
    MessageCreate: 'messageCreate',
    ClientReady: 'ready',
    Error: 'error',
  };

  const GatewayIntentBits = {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    DirectMessages: 8,
  };

  class MockClient {
    eventHandlers = new Map<string, Handler[]>();
    user: any = { id: '999888777', tag: 'Andy#1234' };
    private _ready = false;

    constructor(_opts: any) {
      clientRef.current = this;
    }

    on(event: string, handler: Handler) {
      const existing = this.eventHandlers.get(event) || [];
      existing.push(handler);
      this.eventHandlers.set(event, existing);
      return this;
    }

    once(event: string, handler: Handler) {
      return this.on(event, handler);
    }

    async login(_token: string) {
      this._ready = true;
      // Fire the ready event
      const readyHandlers = this.eventHandlers.get('ready') || [];
      for (const h of readyHandlers) {
        h({ user: this.user });
      }
    }

    isReady() {
      return this._ready;
    }

    channels = {
      fetch: vi.fn().mockResolvedValue({
        send: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn().mockResolvedValue(undefined),
      }),
    };

    users = {
      fetch: vi.fn().mockResolvedValue({
        createDM: vi.fn().mockResolvedValue({
          id: 'dm-channel-123',
          send: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    };

    destroy() {
      this._ready = false;
    }
  }

  // Mock TextChannel and ThreadChannel types — discord.ts imports both
  // as runtime named imports; missing exports cause Vitest ESM to throw
  // before any test runs.
  class TextChannel {}
  class ThreadChannel {}

  const Partials = { Channel: 1, Message: 2, Reaction: 3 };

  return {
    Client: MockClient,
    Events,
    GatewayIntentBits,
    Partials,
    TextChannel,
    ThreadChannel,
  };
});

import {
  DiscordChannel,
  DiscordChannelOpts,
  threadNameFromMessage,
  toHistoryMessage,
  userHasAllowedRole,
} from './discord.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<DiscordChannelOpts>,
): DiscordChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'dc:1234567890123456': {
        name: 'Test Server #general',
        folder: 'test-server',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    registerGroup: vi.fn(),
    deregisterGroup: vi.fn(),
    ...overrides,
  };
}

// Build a fake discord.js client that exposes one guild with one member
// holding the given role IDs. Used for userHasAllowedRole unit tests.
function fakeClientWithMember(
  guildId: string,
  userId: string,
  roleIds: string[],
) {
  const member = {
    roles: {
      cache: new Map(roleIds.map((id) => [id, { id }])),
    },
  };
  const guild = {
    id: guildId,
    members: { fetch: vi.fn().mockResolvedValue(member) },
  };
  const guilds = new Map([[guildId, guild]]);
  return {
    guilds: {
      cache: {
        values: () => guilds.values(),
        get: (id: string) => guilds.get(id),
      },
    },
  } as any;
}

function createMessage(overrides: {
  channelId?: string;
  content?: string;
  authorId?: string;
  authorUsername?: string;
  authorDisplayName?: string;
  memberDisplayName?: string;
  isBot?: boolean;
  guildName?: string;
  channelName?: string;
  messageId?: string;
  createdAt?: Date;
  attachments?: Map<string, any>;
  reference?: { messageId?: string };
  mentionsBotId?: boolean;
}) {
  const channelId = overrides.channelId ?? '1234567890123456';
  const authorId = overrides.authorId ?? '55512345';
  const botId = '999888777'; // matches mock client user id

  const mentionsMap = new Map();
  if (overrides.mentionsBotId) {
    mentionsMap.set(botId, { id: botId });
  }

  return {
    channelId,
    id: overrides.messageId ?? 'msg_001',
    content: overrides.content ?? 'Hello everyone',
    createdAt: overrides.createdAt ?? new Date('2024-01-01T00:00:00.000Z'),
    author: {
      id: authorId,
      username: overrides.authorUsername ?? 'alice',
      displayName: overrides.authorDisplayName ?? 'Alice',
      bot: overrides.isBot ?? false,
    },
    member: overrides.memberDisplayName
      ? { displayName: overrides.memberDisplayName }
      : null,
    guild: overrides.guildName ? { name: overrides.guildName } : null,
    channel: {
      name: overrides.channelName ?? 'general',
      messages: {
        fetch: vi.fn().mockResolvedValue({
          author: { username: 'Bob', displayName: 'Bob' },
          member: { displayName: 'Bob' },
        }),
      },
    },
    mentions: {
      users: mentionsMap,
    },
    attachments: overrides.attachments ?? new Map(),
    reference: overrides.reference ?? null,
  };
}

function currentClient() {
  return clientRef.current;
}

async function triggerMessage(message: any) {
  const handlers = currentClient().eventHandlers.get('messageCreate') || [];
  for (const h of handlers) await h(message);
}

// --- Tests ---

describe('DiscordChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when client is ready', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('registers message handlers on connect', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      await channel.connect();

      expect(currentClient().eventHandlers.has('messageCreate')).toBe(true);
      expect(currentClient().eventHandlers.has('error')).toBe(true);
      expect(currentClient().eventHandlers.has('ready')).toBe(true);
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message for registered channel', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hello everyone',
        guildName: 'Test Server',
        channelName: 'general',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.any(String),
        'Test Server #general',
        'discord',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          id: 'msg_001',
          chat_jid: 'dc:1234567890123456',
          sender: '55512345',
          sender_name: 'Alice',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered channels', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        channelId: '9999999999999999',
        content: 'Unknown channel',
        guildName: 'Other Server',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:9999999999999999',
        expect.any(String),
        expect.any(String),
        'discord',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores bot messages', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({ isBot: true, content: 'I am a bot' });
      await triggerMessage(msg);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('uses member displayName when available (server nickname)', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hi',
        memberDisplayName: 'Alice Nickname',
        authorDisplayName: 'Alice Global',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({ sender_name: 'Alice Nickname' }),
      );
    });

    it('falls back to author displayName when no member', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hi',
        memberDisplayName: undefined,
        authorDisplayName: 'Alice Global',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({ sender_name: 'Alice Global' }),
      );
    });

    it('uses sender name for DM chats (no guild)', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'dc:1234567890123456': {
            name: 'DM',
            folder: 'dm',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hello',
        guildName: undefined,
        authorDisplayName: 'Alice',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.any(String),
        'Alice',
        'discord',
        false,
      );
    });

    it('uses guild name + channel name for server messages', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hello',
        guildName: 'My Server',
        channelName: 'bot-chat',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.any(String),
        'My Server #bot-chat',
        'discord',
        true,
      );
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('translates <@botId> mention to trigger format', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: '<@999888777> what time is it?',
        mentionsBotId: true,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '@Andy what time is it?',
        }),
      );
    });

    it('does not translate if message already matches trigger', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: '@Andy hello <@999888777>',
        mentionsBotId: true,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      // Should NOT prepend @Andy — already starts with trigger
      // But the <@botId> should still be stripped
      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '@Andy hello',
        }),
      );
    });

    it('does not translate when bot is not mentioned', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'hello everyone',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: 'hello everyone',
        }),
      );
    });

    it('treats role mention as bot mention when bot holds that role', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const botRoleId = 'role-bot-1506321455636549675';
      // Build a message where the user @-mentions a role the bot holds.
      const msg = {
        channelId: '1234567890123456',
        id: 'msg_role_001',
        content: `<@&${botRoleId}> review this PR`,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        author: {
          id: '55512345',
          username: 'ron',
          displayName: 'Ron',
          bot: false,
        },
        member: { displayName: 'Ron' },
        guild: {
          name: 'Server',
          members: {
            me: { roles: { cache: new Map([[botRoleId, { id: botRoleId }]]) } },
          },
        },
        channel: { name: 'general', messages: { fetch: vi.fn() } },
        mentions: {
          users: new Map(),
          roles: new Map([[botRoleId, { id: botRoleId }]]),
        },
        attachments: new Map(),
        reference: null,
      } as any;
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '@Andy review this PR',
        }),
      );
    });

    it('does NOT treat role mention as bot mention when bot lacks that role', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const otherRoleId = 'role-not-bot';
      const msg = {
        channelId: '1234567890123456',
        id: 'msg_role_002',
        content: `<@&${otherRoleId}> hello team`,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        author: {
          id: '55512345',
          username: 'ron',
          displayName: 'Ron',
          bot: false,
        },
        member: { displayName: 'Ron' },
        guild: {
          name: 'Server',
          members: { me: { roles: { cache: new Map() } } },
        },
        channel: { name: 'general', messages: { fetch: vi.fn() } },
        mentions: {
          users: new Map(),
          roles: new Map([[otherRoleId, { id: otherRoleId }]]),
        },
        attachments: new Map(),
        reference: null,
      } as any;
      await triggerMessage(msg);

      // Content is stored as-is; no @Andy prepend
      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: `<@&${otherRoleId}> hello team`,
        }),
      );
    });

    it('handles <@!botId> (nickname mention format)', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: '<@!999888777> check this',
        mentionsBotId: true,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '@Andy check this',
        }),
      );
    });
  });

  // --- Attachments ---

  describe('attachments', () => {
    it('stores image attachment with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        [
          'att1',
          {
            name: 'photo.png',
            contentType: 'image/png',
            url: 'https://cdn.discordapp.com/attachments/1/2/photo.png',
          },
        ],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content:
            '[Image: photo.png | https://cdn.discordapp.com/attachments/1/2/photo.png]',
        }),
      );
    });

    it('stores video attachment with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'clip.mp4', contentType: 'video/mp4' }],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[Video: clip.mp4]',
        }),
      );
    });

    it('stores file attachment with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        [
          'att1',
          {
            name: 'report.pdf',
            contentType: 'application/pdf',
            url: 'https://cdn.discordapp.com/attachments/1/2/report.pdf',
          },
        ],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content:
            '[File: report.pdf | https://cdn.discordapp.com/attachments/1/2/report.pdf]',
        }),
      );
    });

    it('includes text content with attachments', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        [
          'att1',
          {
            name: 'photo.jpg',
            contentType: 'image/jpeg',
            url: 'https://cdn.discordapp.com/attachments/1/2/photo.jpg',
          },
        ],
      ]);
      const msg = createMessage({
        content: 'Check this out',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content:
            'Check this out\n[Image: photo.jpg | https://cdn.discordapp.com/attachments/1/2/photo.jpg]',
        }),
      );
    });

    it('handles multiple attachments', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        [
          'att1',
          {
            name: 'a.png',
            contentType: 'image/png',
            url: 'https://cdn.discordapp.com/attachments/1/2/a.png',
          },
        ],
        [
          'att2',
          {
            name: 'b.txt',
            contentType: 'text/plain',
            url: 'https://cdn.discordapp.com/attachments/1/2/b.txt',
          },
        ],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content:
            '[Image: a.png | https://cdn.discordapp.com/attachments/1/2/a.png]\n[File: b.txt | https://cdn.discordapp.com/attachments/1/2/b.txt]',
        }),
      );
    });
  });

  // --- Reply context ---

  describe('reply context', () => {
    it('includes reply author in content', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'I agree with that',
        reference: { messageId: 'original_msg_id' },
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: 'I agree with that\n[In reply to Bob]',
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via channel', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('dc:1234567890123456', 'Hello');

      const fetchedChannel =
        await currentClient().channels.fetch('1234567890123456');
      expect(currentClient().channels.fetch).toHaveBeenCalledWith(
        '1234567890123456',
      );
    });

    it('strips dc: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('dc:9876543210', 'Test');

      expect(currentClient().channels.fetch).toHaveBeenCalledWith('9876543210');
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      currentClient().channels.fetch.mockRejectedValueOnce(
        new Error('Channel not found'),
      );

      // Should not throw
      await expect(
        channel.sendMessage('dc:1234567890123456', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when client is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      // Don't connect — client is null
      await channel.sendMessage('dc:1234567890123456', 'No client');

      // No error, no API call
    });

    it('splits messages exceeding 2000 characters', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const mockChannel = {
        send: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn(),
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      const longText = 'x'.repeat(3000);
      await channel.sendMessage('dc:1234567890123456', longText);

      expect(mockChannel.send).toHaveBeenCalledTimes(2);
      expect(mockChannel.send).toHaveBeenNthCalledWith(1, 'x'.repeat(2000));
      expect(mockChannel.send).toHaveBeenNthCalledWith(2, 'x'.repeat(1000));
    });

    it('sends a DM via users.fetch when jid has dc-dm: prefix', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const dmSend = vi.fn().mockResolvedValue(undefined);
      const createDM = vi
        .fn()
        .mockResolvedValue({ id: 'dm-channel-123', send: dmSend });
      currentClient().users.fetch.mockResolvedValueOnce({ createDM });

      await channel.sendMessage('dc-dm:987654321', 'Hello DM');

      expect(currentClient().users.fetch).toHaveBeenCalledWith('987654321');
      expect(createDM).toHaveBeenCalled();
      expect(dmSend).toHaveBeenCalledWith('Hello DM');
      // Must NOT attempt channel resolution for a dc-dm: JID
      expect(currentClient().channels.fetch).not.toHaveBeenCalled();
    });

    it('handles dc-dm: send failures gracefully', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      currentClient().users.fetch.mockRejectedValueOnce(
        new Error('Unknown User'),
      );

      // Should not throw — error is caught and logged
      await expect(
        channel.sendMessage('dc-dm:987654321', 'Will fail'),
      ).resolves.toBeUndefined();
    });
  });

  // --- Concurrent reply routing (#46) ---

  describe('concurrent reply routing (#46)', () => {
    // A guild (non-thread) message the bot replies to by starting a thread on
    // it. Spies let us assert which message's thread the reply used.
    function guildMessage(messageId: string) {
      const threadSend = vi.fn().mockResolvedValue({ id: `sent_${messageId}` });
      const startThread = vi.fn().mockResolvedValue({
        isThread: () => true,
        send: threadSend,
      });
      return {
        channelId: '1234567890123456',
        id: messageId,
        content: `question ${messageId}`,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        author: {
          id: '55512345',
          username: 'alice',
          displayName: 'Alice',
          bot: false,
        },
        member: null,
        guild: { name: 'Test Server' },
        startThread,
        channel: {
          name: 'general',
          isThread: () => false,
          messages: { fetch: vi.fn() },
        },
        mentions: { users: new Map() },
        attachments: new Map(),
        reference: null,
      };
    }

    it('replies in the triggering message thread, not the last-seen one', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msgA = guildMessage('msg_A');
      const msgB = guildMessage('msg_B');

      // Two questions land on the same channel jid before the first is
      // answered; msgB overwrites the per-jid lastReplyAnchor.
      await triggerMessage(msgA);
      await triggerMessage(msgB);

      // Reply to A — must start a thread on A, never on B.
      await channel.sendMessage('dc:1234567890123456', 'Answer to A', {
        replyToMessageId: 'msg_A',
      });

      expect(msgA.startThread).toHaveBeenCalledTimes(1);
      expect(msgB.startThread).not.toHaveBeenCalled();
    });

    it('falls back to channel resolution for proactive sends (no trigger id)', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('dc:1234567890123456', 'Proactive');

      expect(currentClient().channels.fetch).toHaveBeenCalledWith(
        '1234567890123456',
      );
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns dc: JIDs', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('dc:1234567890123456')).toBe(true);
    });

    it('owns dc-dm: JIDs', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('dc-dm:987654321')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:123456789')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing indicator when isTyping is true', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const mockChannel = {
        send: vi.fn(),
        sendTyping: vi.fn().mockResolvedValue(undefined),
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      await channel.setTyping('dc:1234567890123456', true);

      expect(mockChannel.sendTyping).toHaveBeenCalled();
    });

    it('does nothing when isTyping is false', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('dc:1234567890123456', false);

      // channels.fetch should NOT be called
      expect(currentClient().channels.fetch).not.toHaveBeenCalled();
    });

    it('does nothing when client is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      // Don't connect
      await channel.setTyping('dc:1234567890123456', true);

      // No error
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "discord"', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.name).toBe('discord');
    });
  });

  // --- Emoji reactions ---

  describe('addReaction', () => {
    it('maps eyes → 👀 and calls message.react', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const reactMock = vi.fn().mockResolvedValue(undefined);
      currentClient().channels.fetch.mockResolvedValueOnce({
        messages: { fetch: vi.fn().mockResolvedValue({ react: reactMock }) },
      });

      await channel.addReaction('dc:1234567890123456', 'msg_001', 'eyes');

      expect(reactMock).toHaveBeenCalledWith('👀');
    });

    it('passes raw Unicode through unchanged', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const reactMock = vi.fn().mockResolvedValue(undefined);
      currentClient().channels.fetch.mockResolvedValueOnce({
        messages: { fetch: vi.fn().mockResolvedValue({ react: reactMock }) },
      });

      await channel.addReaction('dc:1234567890123456', 'msg_001', '🚀');

      expect(reactMock).toHaveBeenCalledWith('🚀');
    });

    it('swallows fetch failures (deleted message, missing permission)', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      currentClient().channels.fetch.mockRejectedValueOnce(
        new Error('Unknown Message'),
      );

      await expect(
        channel.addReaction('dc:1234567890123456', 'msg_001', 'eyes'),
      ).resolves.toBeUndefined();
    });
  });

  describe('removeReaction', () => {
    it("removes the bot user's reaction for the mapped emoji", async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const usersRemove = vi.fn().mockResolvedValue(undefined);
      const reactionsCache = new Map([
        ['🤔', { users: { remove: usersRemove } }],
      ]);
      currentClient().channels.fetch.mockResolvedValueOnce({
        messages: {
          fetch: vi.fn().mockResolvedValue({
            reactions: { cache: reactionsCache },
          }),
        },
      });

      await channel.removeReaction(
        'dc:1234567890123456',
        'msg_001',
        'thinking_face',
      );

      expect(usersRemove).toHaveBeenCalledWith('999888777'); // mock bot id
    });

    it('is a no-op when the reaction is not present', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const usersRemove = vi.fn();
      currentClient().channels.fetch.mockResolvedValueOnce({
        messages: {
          fetch: vi.fn().mockResolvedValue({
            reactions: { cache: new Map() },
          }),
        },
      });

      await channel.removeReaction(
        'dc:1234567890123456',
        'msg_001',
        'thinking_face',
      );

      expect(usersRemove).not.toHaveBeenCalled();
    });

    it('swallows fetch failures', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      currentClient().channels.fetch.mockRejectedValueOnce(
        new Error('Unknown Message'),
      );

      await expect(
        channel.removeReaction('dc:1234567890123456', 'msg_001', 'eyes'),
      ).resolves.toBeUndefined();
    });
  });

  // --- DM role-based allowlist ---

  describe('userHasAllowedRole', () => {
    it('returns false when no allowed role IDs are configured', async () => {
      const client = fakeClientWithMember('g1', 'u1', ['r1']);
      const result = await userHasAllowedRole(client, 'u1', [], []);
      expect(result).toBe(false);
    });

    it('returns true when the user holds an allowed role in any guild', async () => {
      const client = fakeClientWithMember('g1', 'u1', ['r-allowed']);
      const result = await userHasAllowedRole(client, 'u1', ['r-allowed'], []);
      expect(result).toBe(true);
    });

    it('returns false when the user holds no allowed roles', async () => {
      const client = fakeClientWithMember('g1', 'u1', ['r-other']);
      const result = await userHasAllowedRole(client, 'u1', ['r-allowed'], []);
      expect(result).toBe(false);
    });

    it('returns false when the user is not in any visible guild', async () => {
      const client = fakeClientWithMember('g1', 'u1', ['r-allowed']);
      // Simulate user not in this guild — members.fetch rejects
      client.guilds.cache
        .get('g1')
        .members.fetch.mockRejectedValueOnce(new Error('Unknown Member'));
      const result = await userHasAllowedRole(
        client,
        'u-other',
        ['r-allowed'],
        [],
      );
      expect(result).toBe(false);
    });

    it('respects DISCORD_DM_ALLOWED_GUILD_IDS scoping', async () => {
      const client = fakeClientWithMember('g1', 'u1', ['r-allowed']);
      // Scope to a different guild — bot has g1 cached but not g-other.
      const result = await userHasAllowedRole(
        client,
        'u1',
        ['r-allowed'],
        ['g-other'],
      );
      expect(result).toBe(false);
    });
  });

  // --- Always reply in-thread ---

  describe('always-reply-in-thread', () => {
    // Build an inbound message that exposes the thread/startThread surface
    // our resolver duck-types against.
    function threadableMessage(opts: {
      channelId?: string;
      content?: string;
      messageId?: string;
      channelName?: string;
      channelIsThread?: boolean;
      channelParentId?: string;
      channelParentName?: string;
      startThread?: ReturnType<typeof vi.fn>;
      inGuild?: boolean;
    }) {
      const channelId = opts.channelId ?? '1234567890123456';
      const parent = opts.channelParentId
        ? {
            id: opts.channelParentId,
            name: opts.channelParentName ?? 'general',
          }
        : null;
      return {
        channelId,
        id: opts.messageId ?? 'msg_anchor',
        content: opts.content ?? '<@999888777> please help',
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        author: {
          id: '55512345',
          username: 'alice',
          displayName: 'Alice',
          bot: false,
        },
        member: { displayName: 'Alice' },
        guild: opts.inGuild === false ? null : { name: 'Test Server' },
        channel: {
          id: channelId,
          name: opts.channelName ?? 'thread-topic',
          isThread: () => opts.channelIsThread ?? false,
          parentId: opts.channelParentId ?? null,
          parent,
          messages: { fetch: vi.fn() },
        },
        mentions: { users: new Map([['999888777', { id: '999888777' }]]) },
        attachments: new Map(),
        reference: null,
        startThread: opts.startThread,
      } as any;
    }

    it('starts a thread on the inbound message for top-level replies', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const threadChannel = { send: vi.fn().mockResolvedValue(undefined) };
      const startThread = vi
        .fn()
        .mockResolvedValue({ id: 'thread-abc', send: threadChannel.send });
      const inbound = threadableMessage({ startThread });
      await triggerMessage(inbound);

      await channel.sendMessage('dc:1234567890123456', 'Hello');

      expect(startThread).toHaveBeenCalledTimes(1);
      expect(startThread.mock.calls[0][0]).toMatchObject({
        autoArchiveDuration: 1440,
      });
      expect(threadChannel.send).toHaveBeenCalledWith('Hello');
      // The bare channel fetch should NOT be used — we went through the thread
      expect(currentClient().channels.fetch).not.toHaveBeenCalledWith(
        '1234567890123456',
      );
    });

    it('sends to the existing thread when the inbound message is in one', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'dc:parent-channel': {
            name: 'Test Server #general',
            folder: 'test-server',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      // Capture the channel object so we can assert send was called on it.
      const inboundChannelSend = vi.fn().mockResolvedValue(undefined);
      const inbound = threadableMessage({
        channelId: 'thread-xyz',
        channelIsThread: true,
        channelParentId: 'parent-channel',
        // startThread should NOT be called when message is already in a thread
        startThread: vi.fn(),
      });
      inbound.channel.send = inboundChannelSend;
      await triggerMessage(inbound);

      // Effective chatJid should be the parent (registered group)
      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:parent-channel',
        expect.objectContaining({ chat_jid: 'dc:parent-channel' }),
      );

      await channel.sendMessage('dc:parent-channel', 'In-thread reply');

      expect(inbound.startThread).not.toHaveBeenCalled();
      expect(inboundChannelSend).toHaveBeenCalledWith('In-thread reply');
    });

    it('falls back to the channel when there is no recent inbound (proactive send)', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const mockChannel = { send: vi.fn().mockResolvedValue(undefined) };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      await channel.sendMessage('dc:1234567890123456', 'Scheduled ping');

      expect(currentClient().channels.fetch).toHaveBeenCalledWith(
        '1234567890123456',
      );
      expect(mockChannel.send).toHaveBeenCalledWith('Scheduled ping');
    });

    it('clears thread context after sending so the next proactive call uses the channel', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const threadSend = vi.fn().mockResolvedValue(undefined);
      const startThread = vi
        .fn()
        .mockResolvedValue({ id: 'thread-abc', send: threadSend });
      const inbound = threadableMessage({ startThread });
      await triggerMessage(inbound);

      await channel.sendMessage('dc:1234567890123456', 'First reply');
      expect(threadSend).toHaveBeenCalledWith('First reply');

      // Second send with no fresh inbound — must fall through to the channel
      const channelSend = vi.fn().mockResolvedValue(undefined);
      currentClient().channels.fetch.mockResolvedValue({ send: channelSend });
      await channel.sendMessage('dc:1234567890123456', 'Stale proactive');

      expect(channelSend).toHaveBeenCalledWith('Stale proactive');
      expect(startThread).toHaveBeenCalledTimes(1);
    });

    it('does not try to start a thread for DM messages (no guild)', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'dc:1234567890123456': {
            name: 'DM',
            folder: 'dm',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const startThread = vi.fn();
      const inbound = threadableMessage({ inGuild: false, startThread });
      await triggerMessage(inbound);

      const channelSend = vi.fn().mockResolvedValue(undefined);
      currentClient().channels.fetch.mockResolvedValue({ send: channelSend });
      await channel.sendMessage('dc:1234567890123456', 'DM reply');

      expect(startThread).not.toHaveBeenCalled();
      expect(channelSend).toHaveBeenCalledWith('DM reply');
    });

    it('falls back to the channel when startThread fails', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const startThread = vi
        .fn()
        .mockRejectedValue(new Error('Missing permissions'));
      const inbound = threadableMessage({ startThread });
      await triggerMessage(inbound);

      const channelSend = vi.fn().mockResolvedValue(undefined);
      currentClient().channels.fetch.mockResolvedValue({ send: channelSend });
      await channel.sendMessage('dc:1234567890123456', 'Reply');

      expect(startThread).toHaveBeenCalled();
      expect(channelSend).toHaveBeenCalledWith('Reply');
    });

    it('routes a thread message under its registered parent jid', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'dc:parent-channel': {
            name: 'Test Server #general',
            folder: 'test-server',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const inbound = threadableMessage({
        channelId: 'thread-xyz',
        channelName: 'thread-topic',
        channelIsThread: true,
        channelParentId: 'parent-channel',
        channelParentName: 'general',
        content: 'thread-only message',
      });
      await triggerMessage(inbound);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:parent-channel',
        expect.objectContaining({ chat_jid: 'dc:parent-channel' }),
      );
      // chatName must use the parent channel's name, not the thread title —
      // otherwise the parent group's stored name would get overwritten on
      // every thread message.
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:parent-channel',
        expect.any(String),
        'Test Server #general',
        'discord',
        true,
      );
    });

    it('keeps the original chatJid when the thread parent is not registered', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'dc:thread-xyz': {
            name: 'Thread Group',
            folder: 'thread-group',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const inbound = threadableMessage({
        channelId: 'thread-xyz',
        channelIsThread: true,
        channelParentId: 'unregistered-parent',
      });
      await triggerMessage(inbound);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:thread-xyz',
        expect.objectContaining({ chat_jid: 'dc:thread-xyz' }),
      );
    });

    it('addReaction targets the thread channel for thread-routed messages', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'dc:parent-channel': {
            name: 'Test Server #general',
            folder: 'test-server',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const inbound = threadableMessage({
        messageId: 'thread-msg-1',
        channelId: 'thread-xyz',
        channelIsThread: true,
        channelParentId: 'parent-channel',
        channelParentName: 'general',
      });
      await triggerMessage(inbound);

      const reactMock = vi.fn().mockResolvedValue(undefined);
      currentClient().channels.fetch.mockResolvedValueOnce({
        messages: { fetch: vi.fn().mockResolvedValue({ react: reactMock }) },
      });

      await channel.addReaction('dc:parent-channel', 'thread-msg-1', 'eyes');

      // Must hit the thread channel, not the parent
      expect(currentClient().channels.fetch).toHaveBeenLastCalledWith(
        'thread-xyz',
      );
      expect(reactMock).toHaveBeenCalledWith('👀');
    });

    it('removeReaction targets the thread channel for thread-routed messages', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'dc:parent-channel': {
            name: 'Test Server #general',
            folder: 'test-server',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const inbound = threadableMessage({
        messageId: 'thread-msg-2',
        channelId: 'thread-xyz',
        channelIsThread: true,
        channelParentId: 'parent-channel',
        channelParentName: 'general',
      });
      await triggerMessage(inbound);

      const usersRemove = vi.fn().mockResolvedValue(undefined);
      const reactionsCache = new Map([
        ['🤔', { users: { remove: usersRemove } }],
      ]);
      currentClient().channels.fetch.mockResolvedValueOnce({
        messages: {
          fetch: vi
            .fn()
            .mockResolvedValue({ reactions: { cache: reactionsCache } }),
        },
      });

      await channel.removeReaction(
        'dc:parent-channel',
        'thread-msg-2',
        'thinking_face',
      );

      expect(currentClient().channels.fetch).toHaveBeenLastCalledWith(
        'thread-xyz',
      );
      expect(usersRemove).toHaveBeenCalledWith('999888777');
    });

    it('setTyping targets the thread channel via the latest anchor', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'dc:parent-channel': {
            name: 'Test Server #general',
            folder: 'test-server',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const inbound = threadableMessage({
        channelId: 'thread-xyz',
        channelIsThread: true,
        channelParentId: 'parent-channel',
        channelParentName: 'general',
      });
      await triggerMessage(inbound);

      const sendTyping = vi.fn().mockResolvedValue(undefined);
      currentClient().channels.fetch.mockResolvedValueOnce({ sendTyping });

      await channel.setTyping('dc:parent-channel', true);

      expect(currentClient().channels.fetch).toHaveBeenLastCalledWith(
        'thread-xyz',
      );
      expect(sendTyping).toHaveBeenCalled();
    });
  });

  // --- Thread name helper ---

  describe('threadNameFromMessage', () => {
    it('strips bot @-mentions and trims', () => {
      const name = threadNameFromMessage({
        content: '<@999888777> what is the status?',
        author: { username: 'alice', displayName: 'Alice' },
        member: { displayName: 'Alice' },
      } as any);
      expect(name).toBe('what is the status?');
    });

    it('truncates long content with an ellipsis', () => {
      const long = 'a'.repeat(200);
      const name = threadNameFromMessage({
        content: long,
        author: { username: 'alice' },
        member: null,
      } as any);
      expect(name.length).toBeLessThanOrEqual(80);
      expect(name.endsWith('...')).toBe(true);
    });

    it('falls back to author name when content is empty', () => {
      const name = threadNameFromMessage({
        content: '',
        author: { username: 'alice', displayName: 'Alice' },
        member: { displayName: 'Alice in Server' },
      } as any);
      expect(name).toBe('Reply to Alice in Server');
    });
  });

  // --- Channel history fetch ---

  describe('fetchChannelHistory', () => {
    // Build a fake guild-text channel whose messages.fetch paginates a fixed
    // set of messages newest-first, honouring `limit` and `before` the way
    // discord.js does.
    function makeHistoryChannel(
      msgs: Array<{
        id: string;
        ts: number;
        author?: string;
        authorId?: string;
        content?: string;
        bot?: boolean;
      }>,
    ) {
      const fetch = vi.fn(
        async ({ limit, before }: { limit: number; before?: string }) => {
          const newestFirst = [...msgs].sort((a, b) => b.ts - a.ts);
          let start = 0;
          if (before) {
            const idx = newestFirst.findIndex((m) => m.id === before);
            start = idx === -1 ? newestFirst.length : idx + 1;
          }
          const page = newestFirst.slice(start, start + limit);
          return new Map(
            page.map((m) => [
              m.id,
              {
                id: m.id,
                content: m.content ?? `msg ${m.id}`,
                createdTimestamp: m.ts,
                author: {
                  id: m.authorId ?? 'u1',
                  bot: m.bot ?? false,
                  username: m.author ?? 'alice',
                  displayName: m.author ?? 'Alice',
                },
                member: { displayName: m.author ?? 'Alice' },
                attachments: undefined,
              },
            ]),
          );
        },
      );
      return { messages: { fetch } };
    }

    async function connectedChannel() {
      const channel = new DiscordChannel('test-token', createTestOpts());
      await channel.connect();
      return channel;
    }

    it('returns messages oldest-first', async () => {
      const channel = await connectedChannel();
      const fake = makeHistoryChannel([
        { id: 'a', ts: 1000 },
        { id: 'b', ts: 2000 },
        { id: 'c', ts: 3000 },
      ]);
      currentClient().channels.fetch = vi.fn().mockResolvedValue(fake);

      const result = await channel.fetchChannelHistory('chan-1');
      expect(result.map((m) => m.id)).toEqual(['a', 'b', 'c']);
      expect(result[0].timestamp).toBe(new Date(1000).toISOString());
    });

    it('paginates across pages up to the limit', async () => {
      const channel = await connectedChannel();
      const many = Array.from({ length: 250 }, (_, i) => ({
        id: `m${i}`,
        ts: i + 1,
      }));
      const fake = makeHistoryChannel(many);
      currentClient().channels.fetch = vi.fn().mockResolvedValue(fake);

      const result = await channel.fetchChannelHistory('chan-1', {
        limit: 250,
      });
      expect(result).toHaveLength(250);
      // 100 + 100 + 50 → three pages
      expect(fake.messages.fetch).toHaveBeenCalledTimes(3);
      // Oldest-first: m0 (ts 1) is first, m249 (ts 250) last
      expect(result[0].id).toBe('m0');
      expect(result[249].id).toBe('m249');
    });

    it('stops at the `since` cutoff and excludes older messages', async () => {
      const channel = await connectedChannel();
      const fake = makeHistoryChannel([
        { id: 'old1', ts: 1000 },
        { id: 'old2', ts: 2000 },
        { id: 'keep1', ts: 3000 },
        { id: 'keep2', ts: 4000 },
        { id: 'keep3', ts: 5000 },
      ]);
      currentClient().channels.fetch = vi.fn().mockResolvedValue(fake);

      const result = await channel.fetchChannelHistory('chan-1', {
        sinceIso: new Date(3000).toISOString(),
      });
      expect(result.map((m) => m.id)).toEqual(['keep1', 'keep2', 'keep3']);
    });

    it('throws a clear error for an invalid `since` date', async () => {
      const channel = await connectedChannel();
      currentClient().channels.fetch = vi
        .fn()
        .mockResolvedValue(makeHistoryChannel([]));
      await expect(
        channel.fetchChannelHistory('chan-1', { sinceIso: 'not-a-date' }),
      ).rejects.toThrow(/Invalid "since" date/);
    });

    it('throws when the channel has no readable message history', async () => {
      const channel = await connectedChannel();
      // A voice channel / unknown id resolves to an object without `messages`.
      currentClient().channels.fetch = vi.fn().mockResolvedValue({});
      await expect(channel.fetchChannelHistory('chan-1')).rejects.toThrow(
        /no readable message history/,
      );
    });
  });

  // --- History message flattening ---

  describe('toHistoryMessage', () => {
    it('prefers guild nick, then global name, then username', () => {
      expect(
        toHistoryMessage({
          id: '1',
          member: { displayName: 'Nick' },
          author: { displayName: 'Global', username: 'uname' },
        }).authorName,
      ).toBe('Nick');
      expect(
        toHistoryMessage({
          id: '2',
          author: { displayName: 'Global', username: 'uname' },
        }).authorName,
      ).toBe('Global');
      expect(
        toHistoryMessage({ id: '3', author: { username: 'uname' } }).authorName,
      ).toBe('uname');
      expect(toHistoryMessage({ id: '4' }).authorName).toBe('unknown');
    });

    it('flattens attachments to name-or-url', () => {
      const out = toHistoryMessage({
        id: '5',
        attachments: {
          values: () => [
            { name: 'report.csv' },
            { name: null, url: 'http://x/y' },
          ],
        },
      });
      expect(out.attachments).toEqual(['report.csv', 'http://x/y']);
    });
  });
});
