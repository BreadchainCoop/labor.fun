import { createHmac } from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- Mocks (mirror telegram.test.ts) ---

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Breadbrich Engels',
  TRIGGER_PATTERN: /^@Breadbrich Engels\b/i,
  TELEGRAM_AUTO_REGISTER_GROUPS: false,
  TELEGRAM_AUTO_ALLOWLIST_GROUPS: '',
  // Ingress binds this port; 0 → ephemeral, isolated (never shared).
  INGRESS_HTTP_PORT: 0,
}));

const ensureAllowlistedMock = vi.hoisted(() => vi.fn());
vi.mock('./telegram-allowlist.js', () => ({
  ensureTelegramSenderAllowlisted: ensureAllowlistedMock,
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(
    (folder: string) => `/tmp/test-groups/${folder}`,
  ),
}));

vi.mock('../db.js', () => ({
  logReaction: vi.fn(),
  storeOutboundMessage: vi.fn(),
}));

// env reader — the factory reads TELEGRAM_* keys through it.
const envRef = vi.hoisted(() => ({ vars: {} as Record<string, string> }));
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...envRef.vars })),
}));

import { TelegramChannel, TelegramChannelOpts } from './telegram.js';
import { registerChannel } from './registry.js';

// Capture the factory registered at import time.
const telegramFactory = vi.mocked(registerChannel).mock.calls[0][1];

const INGRESS_SECRET = 'test-tg-ingress-secret';

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

function textUpdate(overrides: {
  chatId?: number;
  chatType?: string;
  chatTitle?: string;
  text: string;
  fromId?: number;
  firstName?: string;
  username?: string;
  messageId?: number;
  date?: number;
  entities?: any[];
  reply_to_message?: any;
}): Record<string, unknown> {
  return {
    update_id: 1,
    message: {
      message_id: overrides.messageId ?? 1,
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      chat: {
        id: overrides.chatId ?? 100200300,
        type: overrides.chatType ?? 'group',
        title: overrides.chatTitle ?? 'Test Group',
      },
      from: {
        id: overrides.fromId ?? 99001,
        first_name: overrides.firstName ?? 'Alice',
        username: overrides.username ?? 'alice_user',
      },
      text: overrides.text,
      entities: overrides.entities ?? [],
      reply_to_message: overrides.reply_to_message,
    },
  };
}

function createOpts(
  overrides?: Partial<TelegramChannelOpts>,
): TelegramChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'tg:100200300': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Breadbrich Engels',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ingressSecret: INGRESS_SECRET,
    ...overrides,
  };
}

async function startIngress(opts: TelegramChannelOpts): Promise<{
  channel: TelegramChannel;
  port: number;
}> {
  const channel = new TelegramChannel('', opts);
  await channel.connect();
  // The channel started a shared ingress server on port 0; find its bound port.
  // We reach into the underlying http.Server via the shared registry helper:
  // the channel exposes it only through the network, so bind to the address by
  // reading it off the server we started. To avoid touching internals, we spin
  // the server up and query its address through a probe: the server is on
  // 0.0.0.0:<ephemeral>. Capture it via the returned server handle.
  const port = (channel as any).ingressServer
    ? await getBoundPort((channel as any).ingressServer)
    : 0;
  return { channel, port };
}

// The IngressHttpServer keeps its http.Server private; grab it after start().
async function getBoundPort(server: any): Promise<number> {
  // start() is idempotent and returns the same http.Server.
  const httpServer = await server.start();
  return (httpServer.address() as AddressInfo).port;
}

describe('Telegram ingress mode', () => {
  const channels: TelegramChannel[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(envRef.vars)) delete envRef.vars[key];
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_INGRESS_SECRET;
    delete process.env.CONTROL_PLANE_URL;
    delete process.env.CONTROL_PLANE_TOKEN;
    // Mock fetch so the outbound proxy never hits the network.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi
          .fn()
          .mockResolvedValue({ ok: true, result: { message_id: 5 } }),
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
    it('delivers onMessage for a validly-signed update in a registered group', async () => {
      const opts = createOpts();
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const raw = JSON.stringify(textUpdate({ text: 'Hello everyone' }));
      const res = await post(port, '/telegram/updates', raw, signIngress(raw));

      expect(res.statusCode).toBe(200);
      await vi.waitFor(() => expect(opts.onMessage).toHaveBeenCalledTimes(1));
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          id: '1',
          chat_jid: 'tg:100200300',
          sender: '99001',
          sender_name: 'Alice',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('auto-registers an unregistered group then delivers when autoRegisterGroups is on', async () => {
      const groups: Record<string, any> = {};
      const registerGroup = vi.fn((jid: string, g: any) => {
        groups[jid] = g;
      });
      const opts = createOpts({
        registeredGroups: vi.fn(() => groups),
        registerGroup,
        autoRegisterGroups: true,
      });
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const raw = JSON.stringify(
        textUpdate({
          chatId: -100777,
          chatType: 'supergroup',
          chatTitle: 'Late Group',
          text: '@Breadbrich Engels hello',
        }),
      );
      const res = await post(port, '/telegram/updates', raw, signIngress(raw));
      expect(res.statusCode).toBe(200);

      await vi.waitFor(() => expect(registerGroup).toHaveBeenCalled());
      expect(registerGroup).toHaveBeenCalledWith(
        'tg:-100777',
        expect.objectContaining({ folder: 'telegram_late-group' }),
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:-100777',
        expect.objectContaining({ content: '@Breadbrich Engels hello' }),
      );
    });

    it('rejects a bad signature with 401 and does not deliver', async () => {
      const opts = createOpts();
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const raw = JSON.stringify(textUpdate({ text: 'evil' }));
      const res = await post(port, '/telegram/updates', raw, {
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
      const res = await post(port, '/telegram/updates', raw, signIngress(raw));
      expect(res.statusCode).toBe(400);
      await new Promise((r) => setTimeout(r, 20));
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('translates @handle mentions when TELEGRAM_BOT_USERNAME hint is set', async () => {
      const opts = createOpts({ botUsername: 'andy_ai_bot' });
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const raw = JSON.stringify(
        textUpdate({
          text: '@andy_ai_bot what time is it?',
          entities: [{ type: 'mention', offset: 0, length: 12 }],
        }),
      );
      await post(port, '/telegram/updates', raw, signIngress(raw));

      await vi.waitFor(() => expect(opts.onMessage).toHaveBeenCalled());
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Breadbrich Engels @andy_ai_bot what time is it?',
        }),
      );
    });

    it('degrades @handle translation to off without a bot-username hint', async () => {
      const opts = createOpts(); // no botUsername
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const raw = JSON.stringify(
        textUpdate({
          text: '@andy_ai_bot hi',
          entities: [{ type: 'mention', offset: 0, length: 12 }],
        }),
      );
      await post(port, '/telegram/updates', raw, signIngress(raw));

      await vi.waitFor(() => expect(opts.onMessage).toHaveBeenCalled());
      // No trigger prepended — @handle detection is off.
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '@andy_ai_bot hi' }),
      );
    });

    it('delivers media as a placeholder (no download in ingress)', async () => {
      const opts = createOpts();
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const raw = JSON.stringify({
        update_id: 2,
        message: {
          message_id: 7,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 100200300, type: 'group', title: 'Test Group' },
          from: { id: 99001, first_name: 'Alice', username: 'alice_user' },
          caption: 'look',
          photo: [
            { file_id: 'small', width: 90 },
            { file_id: 'big', width: 800 },
          ],
        },
      });
      await post(port, '/telegram/updates', raw, signIngress(raw));

      await vi.waitFor(() => expect(opts.onMessage).toHaveBeenCalled());
      // Placeholder + caption, NO downloaded path.
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo] look' }),
      );
    });

    it('does not store /ping and /chatid but replies via the proxy', async () => {
      process.env.CONTROL_PLANE_URL = 'https://cp.example';
      process.env.CONTROL_PLANE_TOKEN = 'cp-token';
      const opts = createOpts();
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const ping = JSON.stringify(textUpdate({ text: '/ping' }));
      await post(port, '/telegram/updates', ping, signIngress(ping));
      const chatid = JSON.stringify(textUpdate({ text: '/chatid' }));
      await post(port, '/telegram/updates', chatid, signIngress(chatid));

      // Give async processing a beat.
      await vi.waitFor(() =>
        expect((global.fetch as any).mock.calls.length).toBeGreaterThanOrEqual(
          2,
        ),
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
      // Both replies went through the CP proxy send endpoint.
      const urls = (global.fetch as any).mock.calls.map((c: any[]) => c[0]);
      expect(
        urls.every((u: string) => u.endsWith('/api/instance/telegram/send')),
      ).toBe(true);
    });
  });

  describe('outbound sendMessage → proxy', () => {
    it('POSTs {method,params} with Bearer auth and chat_id', async () => {
      process.env.CONTROL_PLANE_URL = 'https://cp.example';
      process.env.CONTROL_PLANE_TOKEN = 'cp-token';
      const opts = createOpts();
      const { channel } = await startIngress(opts);
      channels.push(channel);

      await channel.sendMessage('tg:100200300', 'Hello');

      const call = (global.fetch as any).mock.calls[0];
      expect(call[0]).toBe('https://cp.example/api/instance/telegram/send');
      expect(call[1].headers.Authorization).toBe('Bearer cp-token');
      expect(call[1].headers['content-type']).toBe('application/json');
      const body = JSON.parse(call[1].body);
      expect(body.method).toBe('sendMessage');
      expect(body.params.chat_id).toBe('100200300');
      expect(body.params.text).toBe('Hello');
      // Markdown attempted first.
      expect(body.params.parse_mode).toBe('Markdown');
    });

    it('falls back to plain text when the proxy returns ok:false for Markdown', async () => {
      process.env.CONTROL_PLANE_URL = 'https://cp.example';
      process.env.CONTROL_PLANE_TOKEN = 'cp-token';
      // First call (Markdown) → ok:false; second (plain) → ok:true.
      (global.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: vi
            .fn()
            .mockResolvedValue({ ok: false, description: 'bad markdown' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: vi
            .fn()
            .mockResolvedValue({ ok: true, result: { message_id: 9 } }),
        });

      const opts = createOpts();
      const { channel } = await startIngress(opts);
      channels.push(channel);

      await channel.sendMessage('tg:100200300', 'Hello *world*');

      expect((global.fetch as any).mock.calls.length).toBe(2);
      const second = JSON.parse((global.fetch as any).mock.calls[1][1].body);
      expect(second.method).toBe('sendMessage');
      expect(second.params.parse_mode).toBeUndefined(); // plain retry
    });

    it('does not throw when the proxy rejects (network error)', async () => {
      process.env.CONTROL_PLANE_URL = 'https://cp.example';
      process.env.CONTROL_PLANE_TOKEN = 'cp-token';
      (global.fetch as any).mockRejectedValue(new Error('ECONNREFUSED'));

      const opts = createOpts();
      const { channel } = await startIngress(opts);
      channels.push(channel);

      await expect(channel.sendMessage('tg:100200300', 'Hello')).resolves.toBe(
        false,
      );
    });

    it('setTyping proxies sendChatAction', async () => {
      process.env.CONTROL_PLANE_URL = 'https://cp.example';
      process.env.CONTROL_PLANE_TOKEN = 'cp-token';
      const opts = createOpts();
      const { channel } = await startIngress(opts);
      channels.push(channel);

      await channel.setTyping!('tg:100200300', true);

      const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
      expect(body.method).toBe('sendChatAction');
      expect(body.params.chat_id).toBe('100200300');
      expect(body.params.action).toBe('typing');
    });

    it('addReaction proxies setMessageReaction', async () => {
      process.env.CONTROL_PLANE_URL = 'https://cp.example';
      process.env.CONTROL_PLANE_TOKEN = 'cp-token';
      const opts = createOpts();
      const { channel } = await startIngress(opts);
      channels.push(channel);

      await channel.addReaction!('tg:100200300', '42', 'eyes');

      const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
      expect(body.method).toBe('setMessageReaction');
      expect(body.params.chat_id).toBe('100200300');
      expect(body.params.message_id).toBe(42);
      expect(body.params.reaction).toEqual([{ type: 'emoji', emoji: '👀' }]);
    });
  });

  describe('factory mode matrix', () => {
    function factoryOpts() {
      return {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: vi.fn(() => ({})),
        registerGroup: vi.fn(),
      };
    }

    it('TELEGRAM_BOT_TOKEN set → polling channel (no ingress server bound)', () => {
      envRef.vars.TELEGRAM_BOT_TOKEN = 'bot-token';
      const channel = telegramFactory(factoryOpts() as any);
      expect(channel).toBeInstanceOf(TelegramChannel);
      // Polling: not in ingress mode.
      expect((channel as any).ingress).toBe(false);
    });

    it('TELEGRAM_INGRESS_SECRET only → ingress channel', () => {
      envRef.vars.TELEGRAM_INGRESS_SECRET = INGRESS_SECRET;
      const channel = telegramFactory(factoryOpts() as any);
      expect(channel).toBeInstanceOf(TelegramChannel);
      expect((channel as any).ingress).toBe(true);
    });

    it('neither → null', () => {
      const channel = telegramFactory(factoryOpts() as any);
      expect(channel).toBeNull();
    });

    it('BOT_TOKEN wins when both are set (polling)', () => {
      envRef.vars.TELEGRAM_BOT_TOKEN = 'bot-token';
      envRef.vars.TELEGRAM_INGRESS_SECRET = INGRESS_SECRET;
      const channel = telegramFactory(factoryOpts() as any);
      expect((channel as any).ingress).toBe(false);
    });

    it('passes TELEGRAM_BOT_USERNAME / TELEGRAM_BOT_ID hints in ingress mode', () => {
      envRef.vars.TELEGRAM_INGRESS_SECRET = INGRESS_SECRET;
      envRef.vars.TELEGRAM_BOT_USERNAME = 'shared_bot';
      envRef.vars.TELEGRAM_BOT_ID = '424242';
      const channel = telegramFactory(factoryOpts() as any);
      expect((channel as any).ingressBotUsername).toBe('shared_bot');
      expect((channel as any).ingressBotId).toBe(424242);
    });
  });
});
