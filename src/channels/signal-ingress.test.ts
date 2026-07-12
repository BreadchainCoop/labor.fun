import { createHmac } from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- Mocks (mirror whatsapp-ingress.test.ts / signal.test.ts) ---

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  SIGNAL_AUTO_REGISTER_GROUPS: false,
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

// Stub the TEE attestation module so `!verify` tests never touch a real socket
// (mirrors signal.test.ts). The channel still owns command routing + reply-send.
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

// env reader — the factory reads SIGNAL_* keys (and the sender reads
// CONTROL_PLANE_*) through it.
const envRef = vi.hoisted(() => ({ vars: {} as Record<string, string> }));
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...envRef.vars })),
}));

import { SignalChannel, SignalChannelOpts } from './signal.js';
import { registerChannel } from './registry.js';

// Capture the factory registered at import time.
const signalFactory = vi.mocked(registerChannel).mock.calls[0][1];

const INGRESS_SECRET = 'test-signal-ingress-secret';
const GROUP_ID = 'R0lE';
const GROUP_JID = `signal:group:${GROUP_ID}`;

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

/**
 * The RAW single-envelope wrapper the control plane forwards verbatim to
 * /signal/messages (a bbernhard/signal-cli receive envelope — the SAME shape
 * signal-cli pushes as a JSON-RPC `receive` notification's params).
 */
function envelopePayload(overrides: {
  groupId?: string | null;
  source?: string;
  sourceName?: string;
  message: string;
  timestamp?: number;
}): Record<string, unknown> {
  const groupId =
    overrides.groupId === undefined ? GROUP_ID : overrides.groupId;
  return {
    envelope: {
      source: overrides.source ?? '+15550002222',
      sourceNumber: overrides.source ?? '+15550002222',
      sourceName: overrides.sourceName ?? 'Bob',
      timestamp: overrides.timestamp ?? 1700000000001,
      dataMessage: {
        message: overrides.message,
        ...(groupId ? { groupInfo: { groupId, type: 'DELIVER' } } : {}),
      },
    },
  };
}

function createOpts(overrides?: Partial<SignalChannelOpts>): SignalChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      [GROUP_JID]: {
        name: 'Test Group',
        folder: 'signal_grp',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ingressSecret: INGRESS_SECRET,
    ...overrides,
  };
}

async function startIngress(opts: SignalChannelOpts): Promise<{
  channel: SignalChannel;
  port: number;
}> {
  // account/rpcAddr are unused in ingress mode (no signal-cli socket).
  const channel = new SignalChannel('', '', opts);
  await channel.connect();
  const server = (channel as any).ingressServer;
  const httpServer = await server.start(); // idempotent → same http.Server
  const port = (httpServer.address() as AddressInfo).port;
  return { channel, port };
}

describe('Signal ingress mode', () => {
  const channels: SignalChannel[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(envRef.vars)) delete envRef.vars[key];
    delete process.env.SIGNAL_ACCOUNT;
    delete process.env.SIGNAL_INGRESS_SECRET;
    delete process.env.CONTROL_PLANE_URL;
    delete process.env.CONTROL_PLANE_TOKEN;
    // Mock fetch so the outbound proxy never hits the network.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ timestamp: 42 }),
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
    it('delivers onMessage for a validly-signed group message in a registered group', async () => {
      const opts = createOpts();
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const raw = JSON.stringify(envelopePayload({ message: 'group hi' }));
      const res = await post(port, '/signal/messages', raw, signIngress(raw));

      expect(res.statusCode).toBe(200);
      await vi.waitFor(() => expect(opts.onMessage).toHaveBeenCalledTimes(1));
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        GROUP_JID,
        expect.any(String),
        undefined,
        'signal',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        GROUP_JID,
        expect.objectContaining({
          id: '1700000000001',
          chat_jid: GROUP_JID,
          sender: '+15550002222',
          sender_name: 'Bob',
          content: 'group hi',
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
        envelopePayload({ groupId: 'NewGrp', message: '@Andy hello' }),
      );
      const res = await post(port, '/signal/messages', raw, signIngress(raw));
      expect(res.statusCode).toBe(200);

      await vi.waitFor(() => expect(registerGroup).toHaveBeenCalled());
      expect(registerGroup).toHaveBeenCalledWith(
        'signal:group:NewGrp',
        expect.objectContaining({
          folder: 'signal_NewGrp',
          requiresTrigger: true,
        }),
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:group:NewGrp',
        expect.objectContaining({ content: '@Andy hello' }),
      );
    });

    it('rejects a bad signature with 401 and does not deliver', async () => {
      const opts = createOpts();
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const raw = JSON.stringify(envelopePayload({ message: 'evil' }));
      const res = await post(port, '/signal/messages', raw, {
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

      const raw = JSON.stringify(envelopePayload({ message: 'no sig' }));
      const res = await post(port, '/signal/messages', raw);

      expect(res.statusCode).toBe(401);
      await new Promise((r) => setTimeout(r, 20));
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('rejects malformed JSON (valid signature) with 400', async () => {
      const opts = createOpts();
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const raw = 'not json{';
      const res = await post(port, '/signal/messages', raw, signIngress(raw));
      expect(res.statusCode).toBe(400);
      await new Promise((r) => setTimeout(r, 20));
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('emits only metadata for an unregistered group (no auto-register)', async () => {
      const opts = createOpts({ registeredGroups: vi.fn(() => ({})) });
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const raw = JSON.stringify(
        envelopePayload({ groupId: 'Other', message: 'hello' }),
      );
      await post(port, '/signal/messages', raw, signIngress(raw));

      await vi.waitFor(() =>
        expect(opts.onChatMetadata).toHaveBeenCalledWith(
          'signal:group:Other',
          expect.any(String),
          undefined,
          'signal',
          true,
        ),
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('drops a non-data / empty-message envelope', async () => {
      const opts = createOpts();
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      // Receipt-style wrapper: no dataMessage.
      const receipt = JSON.stringify({
        envelope: { source: '+15550002222', timestamp: 1, receiptMessage: {} },
      });
      await post(port, '/signal/messages', receipt, signIngress(receipt));

      const empty = JSON.stringify(envelopePayload({ message: '' }));
      await post(port, '/signal/messages', empty, signIngress(empty));

      await new Promise((r) => setTimeout(r, 20));
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // ─── `!verify` intercept (TEE attestation) ─────────────────────────────

  describe('!verify intercept', () => {
    it('answers a valid !verify locally via the proxy and never routes to the agent', async () => {
      process.env.CONTROL_PLANE_URL = 'https://cp.example';
      process.env.CONTROL_PLANE_TOKEN = 'cp-token';
      const onMessage = vi.fn();
      const opts = createOpts({
        onMessage,
        tee: { enabled: true, socketPath: '/tmp/x.sock' },
      });
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const raw = JSON.stringify(
        envelopePayload({ message: '!verify my-nonce-1234' }),
      );
      const res = await post(port, '/signal/messages', raw, signIngress(raw));
      expect(res.statusCode).toBe(200);

      await vi.waitFor(() => expect(global.fetch as any).toHaveBeenCalled());
      // The verify command is answered locally, not forwarded to the agent.
      expect(onMessage).not.toHaveBeenCalled();
      expect(attestNonce).toHaveBeenCalledWith(
        'my-nonce-1234',
        expect.objectContaining({ socketPath: '/tmp/x.sock' }),
      );
      // The attestation reply is proxied back to the CP for THIS group.
      const call = (global.fetch as any).mock.calls[0];
      expect(call[0]).toBe('https://cp.example/api/instance/signal/send');
      const body = JSON.parse(call[1].body);
      expect(body.groupId).toBe(GROUP_ID);
      expect(body.message).toBe('ATTESTATION_REPLY');
    });

    it('does NOT intercept !verify when TEE mode is disabled — routes to the agent', async () => {
      const onMessage = vi.fn();
      const opts = createOpts({ onMessage }); // no tee → disabled
      const { channel, port } = await startIngress(opts);
      channels.push(channel);

      const raw = JSON.stringify(
        envelopePayload({ message: '!verify my-nonce-1234' }),
      );
      await post(port, '/signal/messages', raw, signIngress(raw));

      await vi.waitFor(() => expect(onMessage).toHaveBeenCalled());
      expect(attestNonce).not.toHaveBeenCalled();
      expect(onMessage).toHaveBeenCalledWith(
        GROUP_JID,
        expect.objectContaining({ content: '!verify my-nonce-1234' }),
      );
    });
  });

  // ─── Outbound sendMessage → CP proxy ───────────────────────────────────

  describe('outbound sendMessage → proxy', () => {
    it('POSTs { groupId, message } with Bearer auth', async () => {
      process.env.CONTROL_PLANE_URL = 'https://cp.example';
      process.env.CONTROL_PLANE_TOKEN = 'cp-token';
      const opts = createOpts();
      const { channel } = await startIngress(opts);
      channels.push(channel);

      await channel.sendMessage(GROUP_JID, 'Hello');

      const call = (global.fetch as any).mock.calls[0];
      expect(call[0]).toBe('https://cp.example/api/instance/signal/send');
      expect(call[1].headers.Authorization).toBe('Bearer cp-token');
      expect(call[1].headers['content-type']).toBe('application/json');
      const body = JSON.parse(call[1].body);
      expect(body.groupId).toBe(GROUP_ID);
      // Signal has no assistant-name prefix; the CP renders text_mode:styled.
      expect(body.message).toBe('Hello');
    });

    it('does not throw when the proxy rejects (network error)', async () => {
      process.env.CONTROL_PLANE_URL = 'https://cp.example';
      process.env.CONTROL_PLANE_TOKEN = 'cp-token';
      (global.fetch as any).mockRejectedValue(new Error('ECONNREFUSED'));

      const opts = createOpts();
      const { channel } = await startIngress(opts);
      channels.push(channel);

      await expect(
        channel.sendMessage(GROUP_JID, 'Hello'),
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
        channel.sendMessage(GROUP_JID, 'Hello'),
      ).resolves.toBe(false);
    });

    it('drops the send (no fetch) when CONTROL_PLANE_* is unset', async () => {
      const opts = createOpts();
      const { channel } = await startIngress(opts);
      channels.push(channel);

      await channel.sendMessage(GROUP_JID, 'Hello');
      expect(global.fetch as any).not.toHaveBeenCalled();
    });

    it('drops a non-group (DM) send without a proxy call (shared Signal is group-only)', async () => {
      process.env.CONTROL_PLANE_URL = 'https://cp.example';
      process.env.CONTROL_PLANE_TOKEN = 'cp-token';
      const opts = createOpts();
      const { channel } = await startIngress(opts);
      channels.push(channel);

      await channel.sendMessage('signal:+15550001111', 'hi there');
      expect((global.fetch as any).mock.calls.length).toBe(0);
    });

    it('setTyping and addReaction are no-ops in ingress (no CP proxy method)', async () => {
      process.env.CONTROL_PLANE_URL = 'https://cp.example';
      process.env.CONTROL_PLANE_TOKEN = 'cp-token';
      const opts = createOpts();
      const { channel } = await startIngress(opts);
      channels.push(channel);

      await channel.setTyping!(GROUP_JID, true);
      await channel.addReaction!(GROUP_JID, '1700000000001', 'eyes');
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

    it('SIGNAL_ACCOUNT set → native mode (not ingress)', () => {
      envRef.vars.SIGNAL_ACCOUNT = '+15559990000';
      const channel = signalFactory(factoryOpts() as any);
      expect(channel).toBeInstanceOf(SignalChannel);
      expect((channel as any).ingress).toBe(false);
    });

    it('no account + SIGNAL_INGRESS_SECRET set → ingress mode', () => {
      envRef.vars.SIGNAL_INGRESS_SECRET = INGRESS_SECRET;
      const channel = signalFactory(factoryOpts() as any);
      expect(channel).toBeInstanceOf(SignalChannel);
      expect((channel as any).ingress).toBe(true);
    });

    it('neither account nor secret → null (skip)', () => {
      const channel = signalFactory(factoryOpts() as any);
      expect(channel).toBeNull();
    });

    it('account wins when both account and secret are present (native)', () => {
      envRef.vars.SIGNAL_ACCOUNT = '+15559990000';
      envRef.vars.SIGNAL_INGRESS_SECRET = INGRESS_SECRET;
      const channel = signalFactory(factoryOpts() as any);
      expect((channel as any).ingress).toBe(false);
    });

    it('reads SIGNAL_INGRESS_SECRET from process.env too', () => {
      process.env.SIGNAL_INGRESS_SECRET = INGRESS_SECRET;
      const channel = signalFactory(factoryOpts() as any);
      expect((channel as any).ingress).toBe(true);
    });
  });
});
