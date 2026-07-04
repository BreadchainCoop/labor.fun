import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- Mocks ---

// registerChannel runs at import time — capture the factory so we can test the
// gating logic directly.
const registered = vi.hoisted(
  () => ({ factory: null as unknown }) as { factory: unknown },
);
vi.mock('./registry.js', () => ({
  registerChannel: vi.fn((_name: string, factory: unknown) => {
    registered.factory = factory;
  }),
}));

// Factory reads env; make it controllable per-test.
const envValues = vi.hoisted(() => ({ current: {} as Record<string, string> }));
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...envValues.current })),
}));

// Only mock the config exports the module actually imports.
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Breadbrich Engels',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../db.js', () => ({
  storeOutboundMessage: vi.fn(),
}));

import { WebChannel, WebChannelConfig } from './web.js';
import { storeOutboundMessage } from '../db.js';
import { ChannelOpts } from './registry.js';

// --- Helpers ---

function createTestOpts(overrides?: Partial<ChannelOpts>): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({}) as Record<string, never>),
    registerGroup: vi.fn(),
    deregisterGroup: vi.fn(),
    ...overrides,
  } as ChannelOpts;
}

function createConfig(overrides?: Partial<WebChannelConfig>): WebChannelConfig {
  return {
    port: 3100,
    host: '0.0.0.0',
    siteKey: 'secret-site-key',
    siteId: 'acme',
    allowedOrigins: ['https://example.com'],
    defaultGroup: 'web-visitors',
    rateLimitPerMin: 3,
    maxMessageLength: 100,
    ...overrides,
  };
}

/** A duck-typed IncomingMessage: method/url/headers + an `on` emitter that
 * replays a body chunk then end. */
function createReq(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}) {
  const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
  const req = {
    method: opts.method ?? 'POST',
    url: opts.url ?? '/api/message',
    headers: opts.headers ?? {},
    on(event: string, cb: (arg?: unknown) => void) {
      (listeners[event] ||= []).push(cb);
      return req;
    },
    // Test helper to drive the body stream.
    _emitBody(body: string) {
      for (const cb of listeners['data'] || []) cb(Buffer.from(body, 'utf8'));
      for (const cb of listeners['end'] || []) cb();
    },
  };
  return req;
}

/** A duck-typed ServerResponse capturing status/headers/body/writes. */
function createRes() {
  return {
    statusCode: 0 as number,
    headers: {} as Record<string, string>,
    body: '' as string,
    writes: [] as string[],
    ended: false,
    headersSent: false,
    writeHead(code: number, headers?: Record<string, string>) {
      this.statusCode = code;
      if (headers) this.headers = { ...this.headers, ...headers };
      this.headersSent = true;
      return this;
    },
    write(chunk: string) {
      this.writes.push(chunk);
      return true;
    },
    end(body?: string) {
      if (body) this.body = body;
      this.ended = true;
      return this;
    },
    on() {
      return this;
    },
  };
}

/** Drive a POST /api/message through handleRequest and resolve when done. */
async function postMessage(
  ch: WebChannel,
  opts: {
    origin?: string;
    siteKey?: string;
    body: object | string;
    headers?: Record<string, string>;
  },
) {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.origin !== undefined) headers['origin'] = opts.origin;
  if (opts.siteKey !== undefined) headers['x-site-key'] = opts.siteKey;
  const req = createReq({ method: 'POST', url: '/api/message', headers });
  const res = createRes();
  const promise = ch.handleRequest(req as never, res as never);
  const bodyStr =
    typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  req._emitBody(bodyStr);
  await promise;
  return res;
}

const OK_ORIGIN = 'https://example.com';
const OK_KEY = 'secret-site-key';

describe('WebChannel', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  describe('ownsJid', () => {
    it('is true for web: jids and false for other channels', () => {
      const ch = new WebChannel(createTestOpts(), createConfig());
      expect(ch.ownsJid('web:acme:abcdef12')).toBe(true);
      expect(ch.ownsJid('tg:123')).toBe(false);
      expect(ch.ownsJid('dc:456')).toBe(false);
      expect(ch.ownsJid('slack:789')).toBe(false);
      expect(ch.ownsJid('signal:000')).toBe(false);
    });
  });

  describe('inbound POST /api/message', () => {
    it('delivers a correct NewMessage and jid, calls onChatMetadata with web/false', async () => {
      const opts = createTestOpts();
      const ch = new WebChannel(opts, createConfig());
      const res = await postMessage(ch, {
        origin: OK_ORIGIN,
        siteKey: OK_KEY,
        body: { text: 'hello there' },
      });

      expect(res.statusCode).toBe(200);
      const parsed = JSON.parse(res.body);
      expect(parsed.sessionId).toMatch(/^[a-zA-Z0-9]+$/);
      const sessionId = parsed.sessionId;
      const expectedJid = `web:acme:${sessionId}`;

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        expectedJid,
        expect.any(String),
        'Web visitor',
        'web',
        false,
      );
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      const [jidArg, msg] = (opts.onMessage as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(jidArg).toBe(expectedJid);
      expect(msg).toMatchObject({
        chat_jid: expectedJid,
        sender: sessionId,
        sender_name: 'Web visitor',
        content: 'hello there',
        is_from_me: false,
      });
      expect(typeof msg.id).toBe('string');
      expect(msg.id.length).toBeGreaterThan(0);
    });

    it('trims text and rejects empty text with 400', async () => {
      const opts = createTestOpts();
      const ch = new WebChannel(opts, createConfig());
      const res = await postMessage(ch, {
        origin: OK_ORIGIN,
        siteKey: OK_KEY,
        body: { text: '   ' },
      });
      expect(res.statusCode).toBe(400);
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('adopts a valid client-supplied sessionId', async () => {
      const opts = createTestOpts();
      const ch = new WebChannel(opts, createConfig());
      const sessionId = 'client_supplied_1234';
      const res = await postMessage(ch, {
        origin: OK_ORIGIN,
        siteKey: OK_KEY,
        body: { text: 'hi', sessionId },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).sessionId).toBe(sessionId);
      const [jidArg] = (opts.onMessage as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(jidArg).toBe(`web:acme:${sessionId}`);
    });

    it('rejects a malformed client-supplied sessionId with 400', async () => {
      const opts = createTestOpts();
      const ch = new WebChannel(opts, createConfig());
      const res = await postMessage(ch, {
        origin: OK_ORIGIN,
        siteKey: OK_KEY,
        body: { text: 'hi', sessionId: 'bad/../path' },
      });
      expect(res.statusCode).toBe(400);
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  describe('auto-registration', () => {
    it('registers a group for a new session jid with the shared folder and requiresTrigger:false', async () => {
      const opts = createTestOpts();
      const ch = new WebChannel(opts, createConfig());
      const sessionId = 'session_abcdef12';
      await postMessage(ch, {
        origin: OK_ORIGIN,
        siteKey: OK_KEY,
        body: { text: 'hi', sessionId },
      });

      expect(opts.registerGroup).toHaveBeenCalledTimes(1);
      const [jidArg, group] = (opts.registerGroup as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      expect(jidArg).toBe(`web:acme:${sessionId}`);
      expect(group.folder).toBe('web-visitors');
      expect(group.requiresTrigger).toBe(false);
      expect(group.trigger).toBe('@Breadbrich Engels');
    });

    it('does not re-register a jid already present in registeredGroups', async () => {
      const sessionId = 'existing_session1';
      const jid = `web:acme:${sessionId}`;
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          [jid]: {
            name: 'Web visitor existing',
            folder: 'web-visitors',
            trigger: '@Breadbrich Engels',
            added_at: '2024-01-01T00:00:00.000Z',
            requiresTrigger: false,
          },
        })),
      });
      const ch = new WebChannel(opts, createConfig());
      await postMessage(ch, {
        origin: OK_ORIGIN,
        siteKey: OK_KEY,
        body: { text: 'hi again', sessionId },
      });
      expect(opts.registerGroup).not.toHaveBeenCalled();
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('origin enforcement', () => {
    it('rejects a disallowed origin with 403 and does not deliver', async () => {
      const opts = createTestOpts();
      const ch = new WebChannel(opts, createConfig());
      const res = await postMessage(ch, {
        origin: 'https://evil.com',
        siteKey: OK_KEY,
        body: { text: 'hi' },
      });
      expect(res.statusCode).toBe(403);
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('rejects a missing origin with 403 and does not deliver', async () => {
      const opts = createTestOpts();
      const ch = new WebChannel(opts, createConfig());
      const res = await postMessage(ch, {
        siteKey: OK_KEY,
        body: { text: 'hi' },
      });
      expect(res.statusCode).toBe(403);
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('does not use substring matching for origins', async () => {
      const opts = createTestOpts();
      const ch = new WebChannel(opts, createConfig());
      const res = await postMessage(ch, {
        origin: 'https://example.com.evil.com',
        siteKey: OK_KEY,
        body: { text: 'hi' },
      });
      expect(res.statusCode).toBe(403);
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  describe('site-key enforcement', () => {
    it('rejects a wrong site key with 401', async () => {
      const opts = createTestOpts();
      const ch = new WebChannel(opts, createConfig());
      const res = await postMessage(ch, {
        origin: OK_ORIGIN,
        siteKey: 'wrong',
        body: { text: 'hi' },
      });
      expect(res.statusCode).toBe(401);
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('rejects a missing site key with 401', async () => {
      const opts = createTestOpts();
      const ch = new WebChannel(opts, createConfig());
      const res = await postMessage(ch, {
        origin: OK_ORIGIN,
        body: { text: 'hi' },
      });
      expect(res.statusCode).toBe(401);
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  describe('rate limiting', () => {
    it('allows up to the limit then rejects the (N+1)th with 429', async () => {
      const opts = createTestOpts();
      const ch = new WebChannel(opts, createConfig({ rateLimitPerMin: 3 }));
      const sessionId = 'rate_session_01';
      for (let i = 0; i < 3; i++) {
        const res = await postMessage(ch, {
          origin: OK_ORIGIN,
          siteKey: OK_KEY,
          body: { text: `msg ${i}`, sessionId },
        });
        expect(res.statusCode).toBe(200);
      }
      const over = await postMessage(ch, {
        origin: OK_ORIGIN,
        siteKey: OK_KEY,
        body: { text: 'too much', sessionId },
      });
      expect(over.statusCode).toBe(429);
      // Only the first 3 were delivered.
      expect(opts.onMessage).toHaveBeenCalledTimes(3);
    });

    it('tracks the window per session independently', async () => {
      const opts = createTestOpts();
      const ch = new WebChannel(opts, createConfig({ rateLimitPerMin: 1 }));
      const a = await postMessage(ch, {
        origin: OK_ORIGIN,
        siteKey: OK_KEY,
        body: { text: 'a', sessionId: 'session_aaaaaaa1' },
      });
      const b = await postMessage(ch, {
        origin: OK_ORIGIN,
        siteKey: OK_KEY,
        body: { text: 'b', sessionId: 'session_bbbbbbb1' },
      });
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);
      expect(opts.onMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('message length cap', () => {
    it('rejects text longer than the max with 400', async () => {
      const opts = createTestOpts();
      const ch = new WebChannel(opts, createConfig({ maxMessageLength: 10 }));
      const res = await postMessage(ch, {
        origin: OK_ORIGIN,
        siteKey: OK_KEY,
        body: { text: 'x'.repeat(11) },
      });
      expect(res.statusCode).toBe(400);
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('allows text exactly at the max', async () => {
      const opts = createTestOpts();
      const ch = new WebChannel(opts, createConfig({ maxMessageLength: 10 }));
      const res = await postMessage(ch, {
        origin: OK_ORIGIN,
        siteKey: OK_KEY,
        body: { text: 'x'.repeat(10) },
      });
      expect(res.statusCode).toBe(200);
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('CORS preflight', () => {
    it('reflects the origin for an allowed origin with 204', async () => {
      const ch = new WebChannel(createTestOpts(), createConfig());
      const req = createReq({
        method: 'OPTIONS',
        url: '/api/message',
        headers: { origin: OK_ORIGIN },
      });
      const res = createRes();
      await ch.handleRequest(req as never, res as never);
      expect(res.statusCode).toBe(204);
      expect(res.headers['Access-Control-Allow-Origin']).toBe(OK_ORIGIN);
    });

    it('omits CORS headers and 403s for a disallowed origin', async () => {
      const ch = new WebChannel(createTestOpts(), createConfig());
      const req = createReq({
        method: 'OPTIONS',
        url: '/api/message',
        headers: { origin: 'https://evil.com' },
      });
      const res = createRes();
      await ch.handleRequest(req as never, res as never);
      expect(res.statusCode).toBe(403);
      expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
    });
  });

  describe('outbound sendMessage / SSE routing', () => {
    it('writes the reply to the right session stream and not another', async () => {
      const ch = new WebChannel(createTestOpts(), createConfig());
      const jidA = 'web:acme:session_stream_a';

      const resA = createRes();
      const resB = createRes();
      // Open an SSE stream for each session.
      const streamReqA = createReq({
        method: 'GET',
        url: `/api/stream?sessionId=session_stream_a&siteKey=${OK_KEY}`,
        headers: { origin: OK_ORIGIN },
      });
      const streamReqB = createReq({
        method: 'GET',
        url: `/api/stream?sessionId=session_stream_b&siteKey=${OK_KEY}`,
        headers: { origin: OK_ORIGIN },
      });
      await ch.handleRequest(streamReqA as never, resA as never);
      await ch.handleRequest(streamReqB as never, resB as never);

      expect(resA.statusCode).toBe(200);
      expect(resA.headers['Content-Type']).toBe('text/event-stream');

      await ch.sendMessage(jidA, 'reply for A');

      const aWrites = resA.writes.join('');
      const bWrites = resB.writes.join('');
      expect(aWrites).toContain('reply for A');
      expect(bWrites).not.toContain('reply for A');
      // The db store was attempted.
      expect(storeOutboundMessage).toHaveBeenCalledWith(
        jidA,
        expect.any(String),
        'reply for A',
        'Breadbrich Engels',
      );
    });

    it('drops (does not throw) when there is no active stream for the jid', async () => {
      const ch = new WebChannel(createTestOpts(), createConfig());
      await expect(
        ch.sendMessage('web:acme:no_stream_here', 'hi'),
      ).resolves.toBeUndefined();
      // Still recorded outbound.
      expect(storeOutboundMessage).toHaveBeenCalledTimes(1);
    });

    it('writes to all open tabs for the same jid', async () => {
      const ch = new WebChannel(createTestOpts(), createConfig());
      const jid = 'web:acme:multi_tab_session';
      const res1 = createRes();
      const res2 = createRes();
      for (const res of [res1, res2]) {
        const req = createReq({
          method: 'GET',
          url: `/api/stream?sessionId=multi_tab_session&siteKey=${OK_KEY}`,
          headers: { origin: OK_ORIGIN },
        });
        await ch.handleRequest(req as never, res as never);
      }
      await ch.sendMessage(jid, 'broadcast');
      expect(res1.writes.join('')).toContain('broadcast');
      expect(res2.writes.join('')).toContain('broadcast');
    });
  });

  describe('SSE stream auth', () => {
    it('rejects a stream with a bad origin (403) and does not open it', async () => {
      const ch = new WebChannel(createTestOpts(), createConfig());
      const req = createReq({
        method: 'GET',
        url: `/api/stream?sessionId=some_session01&siteKey=${OK_KEY}`,
        headers: { origin: 'https://evil.com' },
      });
      const res = createRes();
      await ch.handleRequest(req as never, res as never);
      expect(res.statusCode).toBe(403);
      // No SSE headers written.
      expect(res.headers['Content-Type']).not.toBe('text/event-stream');
    });

    it('rejects a stream with a malformed sessionId (400)', async () => {
      const ch = new WebChannel(createTestOpts(), createConfig());
      const req = createReq({
        method: 'GET',
        url: `/api/stream?sessionId=bad&siteKey=${OK_KEY}`,
        headers: { origin: OK_ORIGIN },
      });
      const res = createRes();
      await ch.handleRequest(req as never, res as never);
      expect(res.statusCode).toBe(400);
    });
  });

  describe('isConnected', () => {
    it('is false before connect', () => {
      const ch = new WebChannel(createTestOpts(), createConfig());
      expect(ch.isConnected()).toBe(false);
    });
  });

  describe('connect / disconnect (real socket, port 0)', () => {
    it('binds, reports connected, and tears down cleanly', async () => {
      const ch = new WebChannel(createTestOpts(), createConfig({ port: 0 }));
      await ch.connect();
      expect(ch.isConnected()).toBe(true);
      await ch.disconnect();
      expect(ch.isConnected()).toBe(false);
    });
  });

  describe('factory gating', () => {
    // The factory is captured at import time via the mocked registerChannel.
    const runFactory = (env: Record<string, string>) => {
      envValues.current = env;
      const factory = registered.factory as (opts: ChannelOpts) => unknown;
      return factory(createTestOpts());
    };

    afterEach(() => {
      envValues.current = {};
    });

    it('returns null when WEB_WIDGET_ENABLED is unset (inert, no server)', () => {
      expect(runFactory({})).toBeNull();
    });

    it('returns null when WEB_WIDGET_ENABLED is not exactly "true"', () => {
      expect(runFactory({ WEB_WIDGET_ENABLED: 'yes' })).toBeNull();
    });

    it('returns null (fail closed) when enabled but WEB_WIDGET_SITE_KEY is missing', () => {
      const result = runFactory({
        WEB_WIDGET_ENABLED: 'true',
        WEB_WIDGET_ALLOWED_ORIGINS: 'https://example.com',
      });
      expect(result).toBeNull();
    });

    it('returns null (fail closed) when enabled but WEB_WIDGET_ALLOWED_ORIGINS is empty', () => {
      const result = runFactory({
        WEB_WIDGET_ENABLED: 'true',
        WEB_WIDGET_SITE_KEY: 'k',
      });
      expect(result).toBeNull();
    });

    it('returns a WebChannel when fully configured', () => {
      const result = runFactory({
        WEB_WIDGET_ENABLED: 'true',
        WEB_WIDGET_SITE_KEY: 'k',
        WEB_WIDGET_ALLOWED_ORIGINS: 'https://example.com,https://foo.com',
      });
      expect(result).toBeInstanceOf(WebChannel);
    });
  });
});
