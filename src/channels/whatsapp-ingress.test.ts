import { createHmac } from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- Mocks (mirror telegram-ingress.test.ts) ---

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  ASSISTANT_HAS_OWN_NUMBER: false,
  STORE_DIR: '/tmp/nanoclaw-test-store',
  WHATSAPP_AUTO_REGISTER_GROUPS: false,
  WHATSAPP_AUTO_ALLOWLIST_GROUPS: '',
  // Ingress binds this port; 0 → ephemeral, isolated (never shared).
  INGRESS_HTTP_PORT: 0,
}));

const ensureAllowlistedMock = vi.hoisted(() => vi.fn());
vi.mock('./whatsapp-allowlist.js', () => ({
  ensureWhatsAppSenderAllowlisted: ensureAllowlistedMock,
}));

// The factory gate — flip per test for the mode matrix.
const credsExistMock = vi.hoisted(() => vi.fn(() => false));
vi.mock('../integrations/whatsapp-pairing-broker.js', () => ({
  whatsappCredsExist: credsExistMock,
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../db.js', () => ({
  getLastGroupSync: vi.fn(() => null),
  getMessageContentById: vi.fn(() => undefined),
  setLastGroupSync: vi.fn(),
  updateChatName: vi.fn(),
}));

// Baileys is never constructed in ingress mode, but whatsapp.ts imports it at
// module load — mock it so the import doesn't drag the real socket in.
vi.mock('@whiskeysockets/baileys', () => ({
  default: vi.fn(),
  makeWASocket: vi.fn(),
  Browsers: { macOS: vi.fn(() => ['macOS', 'Chrome', '']) },
  DisconnectReason: { loggedOut: 401 },
  fetchLatestWaWebVersion: vi.fn().mockResolvedValue({ version: [2, 3000, 0] }),
  // Pass-through so parseIngressMessage (raw-Baileys shape) can extract text.
  normalizeMessageContent: vi.fn((content: unknown) => content),
  makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
  useMultiFileAuthState: vi
    .fn()
    .mockResolvedValue({ state: { creds: {}, keys: {} }, saveCreds: vi.fn() }),
}));

// env reader — the factory reads WHATSAPP_INGRESS_SECRET (and the sender reads
// CONTROL_PLANE_*) through it.
const envRef = vi.hoisted(() => ({ vars: {} as Record<string, string> }));
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...envRef.vars })),
}));

import { WhatsAppChannel, WhatsAppChannelOpts } from './whatsapp.js';
import { registerChannel } from './registry.js';

// Capture the factory registered at import time.
const whatsappFactory = vi.mocked(registerChannel).mock.calls[0][1];

const INGRESS_SECRET = 'test-wa-ingress-secret';

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

/** A normalized (v1 contract) ingress payload for a registered group. */
function normalizedPayload(overrides: {
  chatJid?: string;
  sender?: string;
  senderName?: string;
  content: string;
  id?: string;
  messageTimestamp?: number;
  fromMe?: boolean;
}): Record<string, unknown> {
  return {
    chatJid: overrides.chatJid ?? 'registered@g.us',
    sender: overrides.sender ?? '5551234@s.whatsapp.net',
    senderName: overrides.senderName ?? 'Alice',
    content: overrides.content,
    id: overrides.id ?? 'msg-1',
    messageTimestamp: overrides.messageTimestamp ?? nowSeconds(),
    fromMe: overrides.fromMe ?? false,
  };
}

function createOpts(
  overrides?: Partial<WhatsAppChannelOpts>,
): WhatsAppChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'registered@g.us': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ingressSecret: INGRESS_SECRET,
    ...overrides,
  };
}

async function startIngress(opts: WhatsAppChannelOpts): Promise<{
  channel: WhatsAppChannel;
  port: number;
}> {
  const channel = new WhatsAppChannel(opts);
  await channel.connect();
  const port = (channel as any).ingressServer
    ? await getBoundPort((channel as any).ingressServer)
    : 0;
  return { channel, port };
}

// The IngressHttpServer keeps its http.Server private; grab it after start()
// (start() is idempotent and returns the same http.Server).
async function getBoundPort(server: any): Promise<number> {
  const httpServer = await server.start();
  return (httpServer.address() as AddressInfo).port;
}

describe('WhatsApp ingress mode', () => {
  const channels: WhatsAppChannel[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    credsExistMock.mockReturnValue(false);
    for (const key of Object.keys(envRef.vars)) delete envRef.vars[key];
    delete process.env.WHATSAPP_INGRESS_SECRET;
    delete process.env.CONTROL_PLANE_URL;
    delete process.env.CONTROL_PLANE_TOKEN;
    // Mock fetch so the outbound proxy never hits the network.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ ok: true }),
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

  // ─── Inbound endpoint ──────────────────────────────────────────────────

  describe('inbound endpoint', () => {
    it('delivers onMessage for a validly-signed message in a registered group', async () => {
      const opts = createOpts();
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const raw = JSON.stringify(normalizedPayload({ content: 'Hello Andy' }));
      const res = await post(port, '/whatsapp/messages', raw, signIngress(raw));

      expect(res.statusCode).toBe(200);
      await vi.waitFor(() => expect(opts.onMessage).toHaveBeenCalledTimes(1));
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'registered@g.us',
        expect.any(String),
        undefined,
        'whatsapp',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({
          id: 'msg-1',
          chat_jid: 'registered@g.us',
          sender: '5551234@s.whatsapp.net',
          sender_name: 'Alice',
          content: 'Hello Andy',
          is_from_me: false,
        }),
      );
    });

    it('accepts a raw Baileys message shape forwarded verbatim', async () => {
      const opts = createOpts();
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const raw = JSON.stringify({
        key: {
          id: 'msg-raw',
          remoteJid: 'registered@g.us',
          participant: '5551234@s.whatsapp.net',
          fromMe: false,
        },
        message: { conversation: 'From raw shape' },
        pushName: 'Bob',
        messageTimestamp: nowSeconds(),
      });
      const res = await post(port, '/whatsapp/messages', raw, signIngress(raw));

      expect(res.statusCode).toBe(200);
      await vi.waitFor(() => expect(opts.onMessage).toHaveBeenCalledTimes(1));
      expect(opts.onMessage).toHaveBeenCalledWith(
        'registered@g.us',
        expect.objectContaining({
          id: 'msg-raw',
          content: 'From raw shape',
          sender_name: 'Bob',
        }),
      );
    });

    it('auto-registers an unregistered chat then delivers when autoRegisterGroups is on', async () => {
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
        normalizedPayload({
          chatJid: 'newgroup@g.us',
          senderName: 'Carol',
          content: '@Andy hello',
        }),
      );
      const res = await post(port, '/whatsapp/messages', raw, signIngress(raw));
      expect(res.statusCode).toBe(200);

      await vi.waitFor(() => expect(registerGroup).toHaveBeenCalled());
      expect(registerGroup).toHaveBeenCalledWith(
        'newgroup@g.us',
        expect.objectContaining({
          folder: expect.stringMatching(/^whatsapp_/),
        }),
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'newgroup@g.us',
        expect.objectContaining({ content: '@Andy hello' }),
      );
    });

    it('auto-allowlists an unknown sender in a matching group', async () => {
      const opts = createOpts({ autoAllowlistGroups: 'all' });
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const raw = JSON.stringify(normalizedPayload({ content: 'hi there' }));
      await post(port, '/whatsapp/messages', raw, signIngress(raw));

      await vi.waitFor(() => expect(opts.onMessage).toHaveBeenCalled());
      expect(ensureAllowlistedMock).toHaveBeenCalledWith(
        expect.objectContaining({ whatsappId: '5551234@s.whatsapp.net' }),
      );
    });

    it('rejects a bad signature with 401 and does not deliver', async () => {
      const opts = createOpts();
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const raw = JSON.stringify(normalizedPayload({ content: 'evil' }));
      const res = await post(port, '/whatsapp/messages', raw, {
        'x-labor-ingress-timestamp': String(nowSeconds()),
        'x-labor-ingress-signature': '0'.repeat(64),
      });

      expect(res.statusCode).toBe(401);
      await new Promise((r) => setTimeout(r, 20));
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('rejects a missing signature with 401', async () => {
      const opts = createOpts();
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const raw = JSON.stringify(normalizedPayload({ content: 'no sig' }));
      const res = await post(port, '/whatsapp/messages', raw);

      expect(res.statusCode).toBe(401);
      await new Promise((r) => setTimeout(r, 20));
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('rejects malformed JSON (valid signature) with 400', async () => {
      const opts = createOpts();
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const raw = 'not json{';
      const res = await post(port, '/whatsapp/messages', raw, signIngress(raw));
      expect(res.statusCode).toBe(400);
      await new Promise((r) => setTimeout(r, 20));
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('emits only metadata for an unregistered chat (no auto-register)', async () => {
      const opts = createOpts();
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const raw = JSON.stringify(
        normalizedPayload({ chatJid: 'unknown@g.us', content: 'hello' }),
      );
      await post(port, '/whatsapp/messages', raw, signIngress(raw));

      await vi.waitFor(() =>
        expect(opts.onChatMetadata).toHaveBeenCalledWith(
          'unknown@g.us',
          expect.any(String),
          undefined,
          'whatsapp',
          true,
        ),
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('drops status@broadcast and empty-content payloads', async () => {
      const opts = createOpts();
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const broadcast = JSON.stringify(
        normalizedPayload({ chatJid: 'status@broadcast', content: 'x' }),
      );
      await post(port, '/whatsapp/messages', broadcast, signIngress(broadcast));

      const empty = JSON.stringify(normalizedPayload({ content: '' }));
      await post(port, '/whatsapp/messages', empty, signIngress(empty));

      await new Promise((r) => setTimeout(r, 20));
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // ─── Outbound sendMessage → proxy ──────────────────────────────────────

  describe('outbound sendMessage → proxy', () => {
    it('POSTs { jid, text } with Bearer auth', async () => {
      process.env.CONTROL_PLANE_URL = 'https://cp.example';
      process.env.CONTROL_PLANE_TOKEN = 'cp-token';
      const opts = createOpts();
      const { channel } = await startIngress(opts);
      channels.push(channel);

      await channel.sendMessage('registered@g.us', 'Hello');

      const call = (global.fetch as any).mock.calls[0];
      expect(call[0]).toBe('https://cp.example/api/instance/whatsapp/send');
      expect(call[1].headers.Authorization).toBe('Bearer cp-token');
      expect(call[1].headers['content-type']).toBe('application/json');
      const body = JSON.parse(call[1].body);
      expect(body.jid).toBe('registered@g.us');
      // Shared number → assistant-name prefix (ASSISTANT_HAS_OWN_NUMBER false).
      expect(body.text).toBe('Andy: Hello');
    });

    it('does not throw when the proxy rejects (network error)', async () => {
      process.env.CONTROL_PLANE_URL = 'https://cp.example';
      process.env.CONTROL_PLANE_TOKEN = 'cp-token';
      (global.fetch as any).mockRejectedValue(new Error('ECONNREFUSED'));

      const opts = createOpts();
      const { channel } = await startIngress(opts);
      channels.push(channel);

      await expect(
        channel.sendMessage('registered@g.us', 'Hello'),
      ).resolves.toBe(false);
    });

    it('does not throw when the proxy returns a non-2xx', async () => {
      process.env.CONTROL_PLANE_URL = 'https://cp.example';
      process.env.CONTROL_PLANE_TOKEN = 'cp-token';
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 502,
        json: vi.fn().mockResolvedValue({}),
      });

      const opts = createOpts();
      const { channel } = await startIngress(opts);
      channels.push(channel);

      await expect(
        channel.sendMessage('registered@g.us', 'Hello'),
      ).resolves.toBe(false);
    });

    it('drops the send (no fetch) when CONTROL_PLANE_* is unset', async () => {
      // No CONTROL_PLANE_URL/TOKEN → no sender constructed.
      const opts = createOpts();
      const { channel } = await startIngress(opts);
      channels.push(channel);

      await channel.sendMessage('registered@g.us', 'Hello');
      expect(global.fetch as any).not.toHaveBeenCalled();
    });

    it('setTyping is a no-op in ingress (no presence proxy)', async () => {
      process.env.CONTROL_PLANE_URL = 'https://cp.example';
      process.env.CONTROL_PLANE_TOKEN = 'cp-token';
      const opts = createOpts();
      const { channel } = await startIngress(opts);
      channels.push(channel);

      await channel.setTyping!('registered@g.us', true);
      expect(global.fetch as any).not.toHaveBeenCalled();
    });
  });

  // ─── Factory mode matrix ───────────────────────────────────────────────

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

    it('creds.json present → Baileys mode (not ingress)', () => {
      credsExistMock.mockReturnValue(true);
      const channel = whatsappFactory(factoryOpts() as any);
      expect(channel).toBeInstanceOf(WhatsAppChannel);
      expect((channel as any).ingress).toBe(false);
    });

    it('no creds + WHATSAPP_INGRESS_SECRET set → ingress mode', () => {
      credsExistMock.mockReturnValue(false);
      envRef.vars.WHATSAPP_INGRESS_SECRET = INGRESS_SECRET;
      const channel = whatsappFactory(factoryOpts() as any);
      expect(channel).toBeInstanceOf(WhatsAppChannel);
      expect((channel as any).ingress).toBe(true);
    });

    it('neither creds nor secret → null (skip)', () => {
      credsExistMock.mockReturnValue(false);
      const channel = whatsappFactory(factoryOpts() as any);
      expect(channel).toBeNull();
    });

    it('creds win when both creds and secret are present (Baileys)', () => {
      credsExistMock.mockReturnValue(true);
      envRef.vars.WHATSAPP_INGRESS_SECRET = INGRESS_SECRET;
      const channel = whatsappFactory(factoryOpts() as any);
      expect((channel as any).ingress).toBe(false);
    });

    it('reads WHATSAPP_INGRESS_SECRET from process.env too', () => {
      credsExistMock.mockReturnValue(false);
      process.env.WHATSAPP_INGRESS_SECRET = INGRESS_SECRET;
      const channel = whatsappFactory(factoryOpts() as any);
      expect((channel as any).ingress).toBe(true);
    });
  });
});
