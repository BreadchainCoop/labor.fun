import { createHmac } from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- Mocks (mirror discord.test.ts / telegram-ingress.test.ts) ---

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  DISCORD_DM_ALLOWED_ROLE_IDS: [] as string[],
  DISCORD_DM_ALLOWED_GUILD_IDS: [] as string[],
  DISCORD_DM_ROLE_REFRESH_INTERVAL: 0,
  // Ingress binds this port; 0 → ephemeral, isolated (never shared).
  INGRESS_HTTP_PORT: 0,
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../db.js', () => ({
  storeOutboundMessage: vi.fn(),
  logReaction: vi.fn(),
}));

// discord.js is NOT constructed in ingress mode, but the module is imported at
// the top of discord.ts, so we must still mock it so the import resolves
// without a real gateway connection.
vi.mock('discord.js', () => ({
  ChannelType: { GuildForum: 15, GuildMedia: 16 },
  Client: class {},
  Events: {
    MessageCreate: 'messageCreate',
    ClientReady: 'ready',
    Error: 'error',
  },
  GatewayIntentBits: {},
  Partials: {},
  TextChannel: class {},
  ThreadChannel: class {},
}));

// env reader — the factory reads DISCORD_* keys through it.
const envRef = vi.hoisted(() => ({ vars: {} as Record<string, string> }));
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...envRef.vars })),
}));

import { DiscordChannel, DiscordChannelOpts } from './discord.js';
import { registerChannel } from './registry.js';

// Capture the factory registered at import time.
const discordFactory = vi.mocked(registerChannel).mock.calls[0][1];

const INGRESS_SECRET = 'test-dc-ingress-secret';
const CHANNEL_ID = '1234567890123456';
const BOT_ID = '999888777';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function signIngress(
  rawBody: string,
  secret = INGRESS_SECRET,
  timestamp = nowSeconds(),
): Record<string, string> {
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return {
    'x-labor-ingress-timestamp': String(timestamp),
    'x-labor-ingress-signature': signature,
  };
}

function post(
  port: number,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** A raw Discord MESSAGE_CREATE payload as the control plane forwards it. */
function messagePayload(overrides: {
  channelId?: string;
  guildId?: string | null;
  content?: string;
  authorId?: string;
  username?: string;
  globalName?: string;
  messageId?: string;
  mentions?: Array<{ id: string }>;
  attachments?: any[];
  referenced_message?: any;
}): Record<string, unknown> {
  return {
    message: {
      id: overrides.messageId ?? 'msg_001',
      channel_id: overrides.channelId ?? CHANNEL_ID,
      guild_id: overrides.guildId === undefined ? 'guild-1' : overrides.guildId,
      guild_name: 'Test Server',
      channel_name: 'general',
      content: overrides.content ?? 'Hello everyone',
      timestamp: '2024-01-01T00:00:00.000Z',
      author: {
        id: overrides.authorId ?? '55512345',
        username: overrides.username ?? 'alice',
        global_name: overrides.globalName ?? 'Alice',
        bot: false,
      },
      mentions: overrides.mentions ?? [],
      attachments: overrides.attachments ?? [],
      referenced_message: overrides.referenced_message,
    },
  };
}

function createOpts(
  overrides?: Partial<DiscordChannelOpts>,
): DiscordChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      [`dc:${CHANNEL_ID}`]: {
        name: 'Test Server #general',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    registerGroup: vi.fn(),
    deregisterGroup: vi.fn(),
    ingressSecret: INGRESS_SECRET,
    ...overrides,
  };
}

async function startIngress(opts: DiscordChannelOpts): Promise<{
  channel: DiscordChannel;
  port: number;
}> {
  const channel = new DiscordChannel('', opts);
  await channel.connect();
  const server = (channel as any).ingressServer;
  const httpServer = await server.start(); // idempotent → same http.Server
  const port = (httpServer.address() as AddressInfo).port;
  return { channel, port };
}

describe('Discord ingress mode', () => {
  const channels: DiscordChannel[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(envRef.vars)) delete envRef.vars[key];
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.DISCORD_INGRESS_SECRET;
    delete process.env.DISCORD_BOT_ID;
    delete process.env.CONTROL_PLANE_URL;
    delete process.env.CONTROL_PLANE_TOKEN;
    // Mock fetch so the outbound proxy never hits the network.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ ok: true, id: 'sent_1' }),
      }),
    );
  });

  afterEach(async () => {
    while (channels.length > 0) {
      await channels.pop()!.disconnect();
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('inbound endpoint', () => {
    it('delivers onMessage for a validly-signed message in a registered channel', async () => {
      const opts = createOpts();
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const raw = JSON.stringify(messagePayload({ content: 'Hello everyone' }));
      const res = await post(port, '/discord/messages', raw, signIngress(raw));

      expect(res.statusCode).toBe(200);
      await vi.waitFor(() => expect(opts.onMessage).toHaveBeenCalledTimes(1));
      expect(opts.onMessage).toHaveBeenCalledWith(
        `dc:${CHANNEL_ID}`,
        expect.objectContaining({
          id: 'msg_001',
          chat_jid: `dc:${CHANNEL_ID}`,
          sender: '55512345',
          sender_name: 'Alice',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('rejects a bad signature with 401 and does not deliver', async () => {
      const opts = createOpts();
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const raw = JSON.stringify(messagePayload({ content: 'evil' }));
      const res = await post(port, '/discord/messages', raw, {
        'x-labor-ingress-timestamp': String(nowSeconds()),
        'x-labor-ingress-signature': '0'.repeat(64),
      });

      expect(res.statusCode).toBe(401);
      await new Promise((r) => setTimeout(r, 20));
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('rejects malformed JSON (valid signature) with 400', async () => {
      const opts = createOpts();
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const raw = 'not json{';
      const res = await post(port, '/discord/messages', raw, signIngress(raw));
      expect(res.statusCode).toBe(400);
      await new Promise((r) => setTimeout(r, 20));
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('drops a message from an unregistered channel (metadata only)', async () => {
      const opts = createOpts({ registeredGroups: vi.fn(() => ({})) });
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const raw = JSON.stringify(
        messagePayload({ channelId: 'unknown-chan', content: 'hi' }),
      );
      await post(port, '/discord/messages', raw, signIngress(raw));

      await vi.waitFor(() =>
        expect(opts.onChatMetadata).toHaveBeenCalledWith(
          'dc:unknown-chan',
          expect.any(String),
          expect.any(String),
          'discord',
          true,
        ),
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('translates @bot-user mentions to the trigger when DISCORD_BOT_ID is set', async () => {
      const opts = createOpts({ botId: BOT_ID });
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const raw = JSON.stringify(
        messagePayload({
          content: `<@${BOT_ID}> what time is it?`,
          mentions: [{ id: BOT_ID }],
        }),
      );
      await post(port, '/discord/messages', raw, signIngress(raw));

      await vi.waitFor(() => expect(opts.onMessage).toHaveBeenCalled());
      expect(opts.onMessage).toHaveBeenCalledWith(
        `dc:${CHANNEL_ID}`,
        expect.objectContaining({ content: '@Andy what time is it?' }),
      );
    });

    it('degrades @bot-user mention translation to off without a bot-id hint', async () => {
      const opts = createOpts(); // no botId
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const raw = JSON.stringify(
        messagePayload({
          content: `<@${BOT_ID}> hi`,
          mentions: [{ id: BOT_ID }],
        }),
      );
      await post(port, '/discord/messages', raw, signIngress(raw));

      await vi.waitFor(() => expect(opts.onMessage).toHaveBeenCalled());
      // No trigger prepended — @bot-user detection is off.
      expect(opts.onMessage).toHaveBeenCalledWith(
        `dc:${CHANNEL_ID}`,
        expect.objectContaining({ content: `<@${BOT_ID}> hi` }),
      );
    });

    it('surfaces attachment URLs inline (no download in ingress)', async () => {
      const opts = createOpts();
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const raw = JSON.stringify(
        messagePayload({
          content: 'see this',
          attachments: [
            {
              filename: 'notes.pdf',
              url: 'https://cdn.example/notes.pdf',
              content_type: 'application/pdf',
            },
          ],
        }),
      );
      await post(port, '/discord/messages', raw, signIngress(raw));

      await vi.waitFor(() => expect(opts.onMessage).toHaveBeenCalled());
      expect(opts.onMessage).toHaveBeenCalledWith(
        `dc:${CHANNEL_ID}`,
        expect.objectContaining({
          content:
            'see this\n[File: notes.pdf | https://cdn.example/notes.pdf]',
        }),
      );
    });

    it('carries embedded reply context (no fetch)', async () => {
      const opts = createOpts();
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const raw = JSON.stringify(
        messagePayload({
          content: 'thanks',
          referenced_message: {
            id: 'ref_1',
            content: 'the earlier message',
            author: { id: 'someone', username: 'bob', global_name: 'Bob' },
          },
        }),
      );
      await post(port, '/discord/messages', raw, signIngress(raw));

      await vi.waitFor(() => expect(opts.onMessage).toHaveBeenCalled());
      expect(opts.onMessage).toHaveBeenCalledWith(
        `dc:${CHANNEL_ID}`,
        expect.objectContaining({
          content: 'thanks\n[In reply to Bob]',
          reply_to_message_id: 'ref_1',
          reply_to_message_content: 'the earlier message',
          reply_to_sender_name: 'Bob',
        }),
      );
    });
  });

  describe('outbound → CP proxy', () => {
    it('POSTs {channelId,content} with Bearer auth', async () => {
      process.env.CONTROL_PLANE_URL = 'https://cp.example';
      process.env.CONTROL_PLANE_TOKEN = 'cp-token';
      const opts = createOpts();
      const { channel } = await startIngress(opts);
      channels.push(channel);

      await channel.sendMessage(`dc:${CHANNEL_ID}`, 'Hello');

      const call = (global.fetch as any).mock.calls[0];
      expect(call[0]).toBe('https://cp.example/api/instance/discord/send');
      expect(call[1].headers.Authorization).toBe('Bearer cp-token');
      expect(call[1].headers['content-type']).toBe('application/json');
      const body = JSON.parse(call[1].body);
      expect(body.channelId).toBe(CHANNEL_ID);
      expect(body.content).toBe('Hello');
    });

    it('logs the outbound message with the returned id', async () => {
      process.env.CONTROL_PLANE_URL = 'https://cp.example';
      process.env.CONTROL_PLANE_TOKEN = 'cp-token';
      const { storeOutboundMessage } = await import('../db.js');
      const opts = createOpts();
      const { channel } = await startIngress(opts);
      channels.push(channel);

      await channel.sendMessage(`dc:${CHANNEL_ID}`, 'Hello');

      expect(storeOutboundMessage).toHaveBeenCalledWith(
        `dc:${CHANNEL_ID}`,
        'sent_1',
        'Hello',
        'Andy',
      );
    });

    it('chunks a >2000-char message into multiple proxy sends', async () => {
      process.env.CONTROL_PLANE_URL = 'https://cp.example';
      process.env.CONTROL_PLANE_TOKEN = 'cp-token';
      const opts = createOpts();
      const { channel } = await startIngress(opts);
      channels.push(channel);

      await channel.sendMessage(`dc:${CHANNEL_ID}`, 'x'.repeat(4500));

      // 4500 / 2000 → 3 chunks → 3 proxy calls.
      expect((global.fetch as any).mock.calls.length).toBe(3);
    });

    it('does not throw when the proxy rejects (network error)', async () => {
      process.env.CONTROL_PLANE_URL = 'https://cp.example';
      process.env.CONTROL_PLANE_TOKEN = 'cp-token';
      (global.fetch as any).mockRejectedValue(new Error('ECONNREFUSED'));

      const opts = createOpts();
      const { channel } = await startIngress(opts);
      channels.push(channel);

      await expect(
        channel.sendMessage(`dc:${CHANNEL_ID}`, 'Hello'),
      ).resolves.toBe(false);
    });

    it('does not throw / log an outbound row when Discord returns ok:false', async () => {
      process.env.CONTROL_PLANE_URL = 'https://cp.example';
      process.env.CONTROL_PLANE_TOKEN = 'cp-token';
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: vi
          .fn()
          .mockResolvedValue({ ok: false, description: 'Missing Access' }),
      });
      const { storeOutboundMessage } = await import('../db.js');
      const opts = createOpts();
      const { channel } = await startIngress(opts);
      channels.push(channel);

      await expect(
        channel.sendMessage(`dc:${CHANNEL_ID}`, 'Hello'),
      ).resolves.toBe(false);
      // ok:false → no id → no outbound row logged (but no crash).
      expect(storeOutboundMessage).not.toHaveBeenCalled();
    });

    it('drops a dc-dm:<userId> send with a warn (no proxy call)', async () => {
      process.env.CONTROL_PLANE_URL = 'https://cp.example';
      process.env.CONTROL_PLANE_TOKEN = 'cp-token';
      const opts = createOpts();
      const { channel } = await startIngress(opts);
      channels.push(channel);

      await channel.sendMessage('dc-dm:55512345', 'hi there');

      expect((global.fetch as any).mock.calls.length).toBe(0);
    });

    it('setTyping proxies the typing action', async () => {
      process.env.CONTROL_PLANE_URL = 'https://cp.example';
      process.env.CONTROL_PLANE_TOKEN = 'cp-token';
      const opts = createOpts();
      const { channel } = await startIngress(opts);
      channels.push(channel);

      await channel.setTyping!(`dc:${CHANNEL_ID}`, true);

      const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
      expect(body.channelId).toBe(CHANNEL_ID);
      expect(body.action).toBe('typing');
    });

    it('addReaction proxies the reaction action with the resolved emoji', async () => {
      process.env.CONTROL_PLANE_URL = 'https://cp.example';
      process.env.CONTROL_PLANE_TOKEN = 'cp-token';
      const opts = createOpts();
      const { channel } = await startIngress(opts);
      channels.push(channel);

      await channel.addReaction!(`dc:${CHANNEL_ID}`, 'msg_001', 'eyes');

      const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
      expect(body.channelId).toBe(CHANNEL_ID);
      expect(body.action).toBe('reaction');
      expect(body.op).toBe('add');
      expect(body.emoji).toBe('👀'); // eyes → Unicode
      expect(body.messageId).toBe('msg_001');
    });

    it('drops a proxy call missing channelId without throwing', async () => {
      process.env.CONTROL_PLANE_URL = 'https://cp.example';
      process.env.CONTROL_PLANE_TOKEN = 'cp-token';
      const opts = createOpts();
      const { channel } = await startIngress(opts);
      channels.push(channel);

      // `dc:` with an empty channel id → channelId '' → sender asserts + drops.
      await expect(channel.sendMessage('dc:', 'orphan')).resolves.toBe(false);
      expect((global.fetch as any).mock.calls.length).toBe(0);
    });
  });

  describe('factory mode matrix', () => {
    function factoryOpts() {
      return {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: vi.fn(() => ({})),
        registerGroup: vi.fn(),
        deregisterGroup: vi.fn(),
      };
    }

    it('DISCORD_BOT_TOKEN set → gateway channel (not ingress)', () => {
      envRef.vars.DISCORD_BOT_TOKEN = 'bot-token';
      const channel = discordFactory(factoryOpts() as any);
      expect(channel).toBeInstanceOf(DiscordChannel);
      expect((channel as any).ingress).toBe(false);
    });

    it('DISCORD_INGRESS_SECRET only → ingress channel', () => {
      envRef.vars.DISCORD_INGRESS_SECRET = INGRESS_SECRET;
      const channel = discordFactory(factoryOpts() as any);
      expect(channel).toBeInstanceOf(DiscordChannel);
      expect((channel as any).ingress).toBe(true);
    });

    it('neither → null', () => {
      const channel = discordFactory(factoryOpts() as any);
      expect(channel).toBeNull();
    });

    it('BOT_TOKEN wins when both are set (gateway)', () => {
      envRef.vars.DISCORD_BOT_TOKEN = 'bot-token';
      envRef.vars.DISCORD_INGRESS_SECRET = INGRESS_SECRET;
      const channel = discordFactory(factoryOpts() as any);
      expect((channel as any).ingress).toBe(false);
    });

    it('passes the DISCORD_BOT_ID hint in ingress mode', () => {
      envRef.vars.DISCORD_INGRESS_SECRET = INGRESS_SECRET;
      envRef.vars.DISCORD_BOT_ID = BOT_ID;
      const channel = discordFactory(factoryOpts() as any);
      expect((channel as any).ingressBotId).toBe(BOT_ID);
    });
  });
});
