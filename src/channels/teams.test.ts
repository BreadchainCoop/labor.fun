import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock config
vi.mock('../config.js', () => ({ ASSISTANT_NAME: 'Jonesy' }));

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
vi.mock('../db.js', () => ({ storeOutboundMessage: vi.fn() }));

// Mock env
const envMock = vi.hoisted(() => ({ current: {} as Record<string, string> }));
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => envMock.current),
}));

// --- botbuilder mock ---
// We keep TurnContext's static helpers REAL (they're pure functions over
// plain activity objects — exercising them gives real confidence in the
// mention-stripping / conversation-reference-capture logic) but replace
// CloudAdapter and ConfigurationBotFrameworkAuthentication, which otherwise
// perform real JWT verification / network calls.
const adapterRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('botbuilder', async () => {
  const actual =
    await vi.importActual<typeof import('botbuilder')>('botbuilder');
  class MockCloudAdapter {
    onTurnError: ((context: any, err: any) => Promise<void>) | undefined;
    process = vi.fn();
    continueConversationAsync = vi.fn(
      async (_appId: string, _reference: unknown, logic: any) => {
        const turnContext = {
          sendActivity: vi.fn().mockResolvedValue({ id: 'outbound-id-1' }),
        };
        await logic(turnContext);
      },
    );

    constructor() {
      adapterRef.current = this;
    }
  }
  class MockAuth {
    constructor() {}
  }
  return {
    ...actual,
    CloudAdapter: MockCloudAdapter,
    ConfigurationBotFrameworkAuthentication: MockAuth,
  };
});

import { TeamsChannel, TeamsChannelConfig } from './teams.js';
import { registerChannel } from './registry.js';
import { storeOutboundMessage } from '../db.js';
import { ChannelOpts } from './registry.js';

// Capture the registered factory at import time (module side effect), since
// `beforeEach`'s vi.clearAllMocks() would otherwise wipe registerChannel's
// recorded call history before a later test can inspect it.
const registeredTeamsFactory = (registerChannel as any).mock.calls.find(
  (c: any[]) => c[0] === 'teams',
)?.[1];

function currentAdapter() {
  return adapterRef.current;
}

function createTestOpts(overrides?: Partial<ChannelOpts>): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'teams:19:abc123@thread.v2': {
        name: 'Test Team Channel',
        folder: 'teams_main',
        trigger: '@Jonesy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    registerGroup: vi.fn(),
    deregisterGroup: vi.fn(),
    ...overrides,
  } as ChannelOpts;
}

function createTestConfig(
  overrides?: Partial<TeamsChannelConfig>,
): TeamsChannelConfig {
  return {
    appId: 'app-id-123',
    appPassword: 'super-secret',
    port: 3978,
    host: '127.0.0.1',
    ...overrides,
  };
}

/** Build a minimal Bot Framework message activity. `mentioned` (when set)
 * appends a Teams-style <at> mention entity + prefixes the mention text onto
 * `text`, mirroring what Teams actually sends when the bot is @mentioned. */
function createActivity(overrides: {
  conversationId?: string;
  conversationType?: string;
  text?: string;
  fromId?: string;
  fromName?: string;
  recipientId?: string;
  id?: string;
  timestamp?: string;
  mentioned?: boolean;
  teamName?: string;
  conversationName?: string;
}) {
  const recipientId = overrides.recipientId ?? 'bot-id-1';
  const mentionText = '<at>Jonesy</at>';
  const baseText = 'text' in overrides ? overrides.text : 'hello there';
  const text = overrides.mentioned
    ? `${mentionText} ${baseText}`
    : (baseText ?? '');

  return {
    type: 'message',
    id: overrides.id ?? 'activity-1',
    text,
    timestamp: overrides.timestamp ?? '2024-01-01T00:00:00.000Z',
    from: {
      id: overrides.fromId ?? 'user-1',
      name: overrides.fromName ?? 'Alice',
    },
    recipient: { id: recipientId, name: 'Jonesy' },
    conversation: {
      id: overrides.conversationId ?? '19:abc123@thread.v2',
      conversationType: overrides.conversationType ?? 'channel',
      name: overrides.conversationName,
    },
    channelData: overrides.teamName
      ? { team: { id: 'team-1', name: overrides.teamName } }
      : undefined,
    entities: overrides.mentioned
      ? [
          {
            type: 'mention',
            text: mentionText,
            mentioned: { id: recipientId, name: 'Jonesy' },
          },
        ]
      : undefined,
    serviceUrl: 'https://smba.trafficmanager.net/amer/',
    channelId: 'msteams',
  };
}

/** Drive handleRequest with adapter.process short-circuited to invoke the
 * logic callback directly against a fake TurnContext wrapping the given
 * activity — this is the seam handleActivity() is exercised through, mirroring
 * how web.ts tests drive handleRequest() directly instead of opening a real
 * TCP socket. */
async function deliverActivity(
  channel: TeamsChannel,
  activity: ReturnType<typeof createActivity>,
) {
  const adapter = currentAdapter();
  adapter.process.mockImplementationOnce(
    async (_req: unknown, _res: unknown, logic: any) => {
      await logic({ activity });
    },
  );
  const req = {
    method: 'POST',
    headers: { authorization: 'Bearer fake-token' },
    on(event: string, cb: (...args: any[]) => void) {
      if (event === 'data') cb(Buffer.from(JSON.stringify(activity)));
      if (event === 'end') cb();
    },
  };
  const res = {
    writeHead: vi.fn(),
    end: vi.fn(),
    headersSent: false,
  };
  await channel.handleRequest(req as any, res as any);
  return res;
}

describe('TeamsChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.current = {};
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Factory gating ---

  describe('factory registration', () => {
    it('registers a teams factory at import time', () => {
      expect(registeredTeamsFactory).toEqual(expect.any(Function));
    });

    it('returns null when TEAMS_ENABLED is not set', () => {
      envMock.current = {
        TEAMS_APP_ID: 'app-id',
        TEAMS_APP_PASSWORD: 'pw',
      };
      const opts = createTestOpts();
      expect(registeredTeamsFactory(opts)).toBeNull();
    });

    it('returns null when TEAMS_ENABLED=true but app id/password missing', () => {
      envMock.current = { TEAMS_ENABLED: 'true' };
      expect(registeredTeamsFactory(createTestOpts())).toBeNull();
    });

    it('returns null when only TEAMS_APP_ID is set (password missing)', () => {
      envMock.current = { TEAMS_ENABLED: 'true', TEAMS_APP_ID: 'app-id' };
      expect(registeredTeamsFactory(createTestOpts())).toBeNull();
    });

    it('returns a TeamsChannel when fully configured', () => {
      envMock.current = {
        TEAMS_ENABLED: 'true',
        TEAMS_APP_ID: 'app-id',
        TEAMS_APP_PASSWORD: 'pw',
      };
      const channel = registeredTeamsFactory(createTestOpts());
      expect(channel).toBeInstanceOf(TeamsChannel);
    });

    it('prefers process.env over .env file values', () => {
      envMock.current = {
        TEAMS_ENABLED: 'false',
        TEAMS_APP_ID: 'file-app-id',
        TEAMS_APP_PASSWORD: 'file-pw',
      };
      process.env.TEAMS_ENABLED = 'true';
      try {
        const channel = registeredTeamsFactory(createTestOpts());
        expect(channel).toBeInstanceOf(TeamsChannel);
      } finally {
        delete process.env.TEAMS_ENABLED;
      }
    });
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('isConnected() is false before connect()', () => {
      const channel = new TeamsChannel(createTestOpts(), createTestConfig());
      expect(channel.isConnected()).toBe(false);
    });

    it('opens a listening HTTP server on connect() and reports connected', async () => {
      const channel = new TeamsChannel(
        createTestOpts(),
        createTestConfig({ port: 0 }),
      );
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
      await channel.disconnect();
    });

    it('disconnect() closes the server and reports disconnected', async () => {
      const channel = new TeamsChannel(
        createTestOpts(),
        createTestConfig({ port: 0 }),
      );
      await channel.connect();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns teams: JIDs', () => {
      const channel = new TeamsChannel(createTestOpts(), createTestConfig());
      expect(channel.ownsJid('teams:19:abc@thread.v2')).toBe(true);
    });

    it('does not own slack/discord/telegram JIDs', () => {
      const channel = new TeamsChannel(createTestOpts(), createTestConfig());
      expect(channel.ownsJid('slack:C123')).toBe(false);
      expect(channel.ownsJid('dc:123')).toBe(false);
      expect(channel.ownsJid('tg:123')).toBe(false);
    });
  });

  // --- Inbound activity -> internal message shape ---

  describe('inbound message handling', () => {
    it('delivers a channel message for a registered group with the teams: jid', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts, createTestConfig());

      const activity = createActivity({
        conversationId: '19:abc123@thread.v2',
        text: 'hello there',
      });
      await deliverActivity(channel, activity);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'teams:19:abc123@thread.v2',
        expect.any(String),
        undefined,
        'teams',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'teams:19:abc123@thread.v2',
        expect.objectContaining({
          id: 'activity-1',
          chat_jid: 'teams:19:abc123@thread.v2',
          sender: 'user-1',
          sender_name: 'Alice',
          content: 'hello there',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered conversations', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts, createTestConfig());

      const activity = createActivity({ conversationId: '19:unregistered' });
      await deliverActivity(channel, activity);

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('strips the bot @mention from channel message text', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts, createTestConfig());

      const activity = createActivity({
        conversationId: '19:abc123@thread.v2',
        mentioned: true,
        text: 'what is the status',
      });
      await deliverActivity(channel, activity);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'teams:19:abc123@thread.v2',
        expect.objectContaining({ content: 'what is the status' }),
      );
    });

    it('identifies a personal (1:1 DM) conversation as non-group', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'teams:19:dm-conv': {
            name: 'DM',
            folder: 'teams_dm',
            trigger: '@Jonesy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TeamsChannel(opts, createTestConfig());

      const activity = createActivity({
        conversationId: '19:dm-conv',
        conversationType: 'personal',
      });
      await deliverActivity(channel, activity);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'teams:19:dm-conv',
        expect.any(String),
        undefined,
        'teams',
        false,
      );
    });

    it('treats a channel/team conversation as a group', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts, createTestConfig());

      const activity = createActivity({
        conversationId: '19:abc123@thread.v2',
        conversationType: 'channel',
        teamName: 'Engineering',
      });
      await deliverActivity(channel, activity);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'teams:19:abc123@thread.v2',
        expect.any(String),
        'Engineering',
        'teams',
        true,
      );
    });

    it('ignores non-message activities (e.g. conversationUpdate)', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts, createTestConfig());

      const activity = {
        ...createActivity({}),
        type: 'conversationUpdate',
      };
      await deliverActivity(channel, activity as any);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('skips messages with no text', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts, createTestConfig());

      const activity = createActivity({ text: undefined });
      await deliverActivity(channel, activity);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('converts activity timestamp to ISO', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts, createTestConfig());

      const activity = createActivity({
        conversationId: '19:abc123@thread.v2',
        timestamp: '2024-06-15T12:30:00.000Z',
      });
      await deliverActivity(channel, activity);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'teams:19:abc123@thread.v2',
        expect.objectContaining({ timestamp: '2024-06-15T12:30:00.000Z' }),
      );
    });
  });

  // --- Outbound sendMessage / conversation reference ---

  describe('sendMessage', () => {
    it('drops the message when no conversation reference has been captured for the jid', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts, createTestConfig());

      await channel.sendMessage('teams:never-seen', 'hello');

      const adapter = currentAdapter();
      expect(adapter.continueConversationAsync).not.toHaveBeenCalled();
    });

    it('sends a reply using the conversation reference captured from an inbound activity', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts, createTestConfig());

      const activity = createActivity({
        conversationId: '19:abc123@thread.v2',
      });
      await deliverActivity(channel, activity);

      await channel.sendMessage('teams:19:abc123@thread.v2', 'the reply');

      const adapter = currentAdapter();
      expect(adapter.continueConversationAsync).toHaveBeenCalledWith(
        'app-id-123',
        expect.objectContaining({
          conversation: expect.objectContaining({
            id: '19:abc123@thread.v2',
          }),
        }),
        expect.any(Function),
      );
      expect(storeOutboundMessage).toHaveBeenCalledWith(
        'teams:19:abc123@thread.v2',
        'outbound-id-1',
        'the reply',
        'Jonesy',
      );
    });

    it('routes a reply to the conversation matching its jid, not some other cached one', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'teams:19:conv-a': {
            name: 'A',
            folder: 'a',
            trigger: '@Jonesy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
          'teams:19:conv-b': {
            name: 'B',
            folder: 'b',
            trigger: '@Jonesy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TeamsChannel(opts, createTestConfig());

      await deliverActivity(
        channel,
        createActivity({ conversationId: '19:conv-a' }),
      );
      await deliverActivity(
        channel,
        createActivity({ conversationId: '19:conv-b' }),
      );

      await channel.sendMessage('teams:19:conv-b', 'to B only');

      const adapter = currentAdapter();
      expect(adapter.continueConversationAsync).toHaveBeenCalledTimes(1);
      expect(adapter.continueConversationAsync).toHaveBeenCalledWith(
        'app-id-123',
        expect.objectContaining({
          conversation: expect.objectContaining({ id: '19:conv-b' }),
        }),
        expect.any(Function),
      );
    });

    it('splits very long messages into multiple sends', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts, createTestConfig());
      await deliverActivity(
        channel,
        createActivity({ conversationId: '19:abc123@thread.v2' }),
      );

      const longText = 'a'.repeat(45000); // > 2x MAX_MESSAGE_LENGTH (20000)
      await channel.sendMessage('teams:19:abc123@thread.v2', longText);

      const adapter = currentAdapter();
      expect(adapter.continueConversationAsync).toHaveBeenCalledTimes(3);
    });

    it('does not throw when continueConversationAsync rejects', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts, createTestConfig());
      await deliverActivity(
        channel,
        createActivity({ conversationId: '19:abc123@thread.v2' }),
      );

      const adapter = currentAdapter();
      adapter.continueConversationAsync.mockRejectedValueOnce(
        new Error('network down'),
      );

      await expect(
        channel.sendMessage('teams:19:abc123@thread.v2', 'hi'),
      ).resolves.not.toThrow();
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('is a no-op that resolves', async () => {
      const channel = new TeamsChannel(createTestOpts(), createTestConfig());
      await expect(
        channel.setTyping('teams:19:abc', true),
      ).resolves.toBeUndefined();
    });
  });

  // --- HTTP surface ---

  describe('handleRequest', () => {
    it('responds 200 to a GET health check without touching the adapter', async () => {
      const channel = new TeamsChannel(createTestOpts(), createTestConfig());
      const res = { writeHead: vi.fn(), end: vi.fn(), headersSent: false };
      const req = {
        method: 'GET',
        headers: {},
        on: vi.fn(),
      };
      await channel.handleRequest(req as any, res as any);
      expect(res.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({ 'content-type': 'application/json' }),
      );
      const adapter = currentAdapter();
      expect(adapter.process).not.toHaveBeenCalled();
    });

    it('responds 405 to non-GET/POST methods', async () => {
      const channel = new TeamsChannel(createTestOpts(), createTestConfig());
      const res = { writeHead: vi.fn(), end: vi.fn(), headersSent: false };
      const req = { method: 'DELETE', headers: {}, on: vi.fn() };
      await channel.handleRequest(req as any, res as any);
      expect(res.writeHead).toHaveBeenCalledWith(405, expect.anything());
    });

    it('responds 400 on invalid JSON body for POST', async () => {
      const channel = new TeamsChannel(createTestOpts(), createTestConfig());
      const res = { writeHead: vi.fn(), end: vi.fn(), headersSent: false };
      const req = {
        method: 'POST',
        headers: {},
        on(event: string, cb: (...args: any[]) => void) {
          if (event === 'data') cb(Buffer.from('not json'));
          if (event === 'end') cb();
        },
      };
      await channel.handleRequest(req as any, res as any);
      expect(res.writeHead).toHaveBeenCalledWith(400, expect.anything());
      const adapter = currentAdapter();
      expect(adapter.process).not.toHaveBeenCalled();
    });

    it('invokes adapter.process for a well-formed POST (auth delegated to botbuilder)', async () => {
      const channel = new TeamsChannel(createTestOpts(), createTestConfig());
      const activity = createActivity({});
      await deliverActivity(channel, activity);
      const adapter = currentAdapter();
      expect(adapter.process).toHaveBeenCalledTimes(1);
    });
  });
});
