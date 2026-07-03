import { createHmac } from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';

import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

// Real bolt App (not a mock): events posted to the receiver must reach the
// exact same app.event(...) handler path that Socket Mode drives.
import { App } from '@slack/bolt';

import {
  SlackHttpReceiver,
  verifyIngressSignature,
  verifySlackSignature,
} from './slack-http-receiver.js';

const INGRESS_SECRET = 'test-ingress-secret';
const SIGNING_SECRET = 'test-signing-secret';

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

function signSlack(
  rawBody: string,
  secret = SIGNING_SECRET,
  timestamp = nowSeconds(),
): Record<string, string> {
  const signature =
    'v0=' +
    createHmac('sha256', secret)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest('hex');
  return {
    'x-slack-request-timestamp': String(timestamp),
    'x-slack-signature': signature,
  };
}

function messageEnvelope(text = 'hello over http'): Record<string, unknown> {
  return {
    token: 'verification-token',
    team_id: 'T123',
    api_app_id: 'A123',
    event: {
      type: 'message',
      channel: 'C123',
      channel_type: 'channel',
      user: 'U_USER',
      text,
      ts: '1704067200.000000',
      event_ts: '1704067200.000000',
    },
    type: 'event_callback',
    event_id: 'Ev123',
    event_time: 1704067200,
  };
}

function post(
  port: number,
  path: string,
  body: string,
  headers: Record<string, string> = {},
  method = 'POST',
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
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
    if (method === 'POST') req.write(body);
    req.end();
  });
}

// --- Pure signature verification ---

describe('verifyIngressSignature', () => {
  const rawBody = '{"type":"event_callback"}';

  function args(
    overrides: Partial<Parameters<typeof verifyIngressSignature>[0]> = {},
  ) {
    const timestamp = String(nowSeconds());
    const signature = createHmac('sha256', INGRESS_SECRET)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');
    return {
      ingressSecret: INGRESS_SECRET,
      rawBody,
      timestamp,
      signature,
      nowSeconds: nowSeconds(),
      ...overrides,
    };
  }

  it('accepts a valid signature', () => {
    expect(verifyIngressSignature(args())).toBe(true);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const timestamp = String(nowSeconds());
    const signature = createHmac('sha256', 'wrong-secret')
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');
    expect(verifyIngressSignature(args({ timestamp, signature }))).toBe(false);
  });

  it('rejects when the body was tampered with', () => {
    expect(verifyIngressSignature(args({ rawBody: '{"evil":true}' }))).toBe(
      false,
    );
  });

  it('rejects an expired timestamp (> 300s old)', () => {
    const timestamp = String(nowSeconds() - 400);
    const signature = createHmac('sha256', INGRESS_SECRET)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');
    expect(verifyIngressSignature(args({ timestamp, signature }))).toBe(false);
  });

  it('rejects a future timestamp (> 300s ahead)', () => {
    const timestamp = String(nowSeconds() + 400);
    const signature = createHmac('sha256', INGRESS_SECRET)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');
    expect(verifyIngressSignature(args({ timestamp, signature }))).toBe(false);
  });

  it('rejects missing timestamp or signature', () => {
    expect(verifyIngressSignature(args({ timestamp: undefined }))).toBe(false);
    expect(verifyIngressSignature(args({ signature: undefined }))).toBe(false);
  });

  it('rejects a non-numeric timestamp', () => {
    expect(verifyIngressSignature(args({ timestamp: 'not-a-number' }))).toBe(
      false,
    );
  });

  it('rejects a signature of different length without throwing', () => {
    expect(verifyIngressSignature(args({ signature: 'deadbeef' }))).toBe(false);
  });
});

describe('verifySlackSignature', () => {
  const rawBody = '{"type":"event_callback"}';

  it('accepts a valid v0 signature', () => {
    const timestamp = String(nowSeconds());
    const signature =
      'v0=' +
      createHmac('sha256', SIGNING_SECRET)
        .update(`v0:${timestamp}:${rawBody}`)
        .digest('hex');
    expect(
      verifySlackSignature({
        signingSecret: SIGNING_SECRET,
        rawBody,
        timestamp,
        signature,
        nowSeconds: nowSeconds(),
      }),
    ).toBe(true);
  });

  it('rejects an invalid v0 signature', () => {
    const timestamp = String(nowSeconds());
    expect(
      verifySlackSignature({
        signingSecret: SIGNING_SECRET,
        rawBody,
        timestamp,
        signature: 'v0=' + '0'.repeat(64),
        nowSeconds: nowSeconds(),
      }),
    ).toBe(false);
  });

  it('rejects an expired timestamp', () => {
    const timestamp = String(nowSeconds() - 400);
    const signature =
      'v0=' +
      createHmac('sha256', SIGNING_SECRET)
        .update(`v0:${timestamp}:${rawBody}`)
        .digest('hex');
    expect(
      verifySlackSignature({
        signingSecret: SIGNING_SECRET,
        rawBody,
        timestamp,
        signature,
        nowSeconds: nowSeconds(),
      }),
    ).toBe(false);
  });

  it('rejects missing headers', () => {
    expect(
      verifySlackSignature({
        signingSecret: SIGNING_SECRET,
        rawBody,
        timestamp: undefined,
        signature: undefined,
        nowSeconds: nowSeconds(),
      }),
    ).toBe(false);
  });
});

// --- HTTP server + bolt App integration ---

describe('SlackHttpReceiver', () => {
  const startedApps: App[] = [];

  afterEach(async () => {
    while (startedApps.length > 0) {
      await startedApps.pop()!.stop();
    }
    vi.clearAllMocks();
  });

  async function startApp(opts: {
    ingressSecret?: string;
    signingSecret?: string;
  }): Promise<{
    app: App;
    port: number;
    messageHandler: ReturnType<typeof vi.fn>;
  }> {
    const receiver = new SlackHttpReceiver({ port: 0, ...opts });
    // authorize instead of a token: no network calls, and processEvent runs
    // the full authorize → middleware → listener pipeline as in production.
    const app = new App({
      receiver,
      authorize: async () => ({
        botId: 'B_BOT',
        botUserId: 'U_BOT',
        botToken: 'xoxb-test',
      }),
    });
    const messageHandler = vi.fn();
    app.event('message', messageHandler);
    const server = (await app.start()) as http.Server;
    startedApps.push(app);
    const port = (server.address() as AddressInfo).port;
    return { app, port, messageHandler };
  }

  describe('ingress HMAC auth', () => {
    it('dispatches a validly-signed event to the registered handler', async () => {
      const { port, messageHandler } = await startApp({
        ingressSecret: INGRESS_SECRET,
      });
      const rawBody = JSON.stringify(messageEnvelope('signed hello'));

      const res = await post(
        port,
        '/slack/events',
        rawBody,
        signIngress(rawBody),
      );

      expect(res.statusCode).toBe(200);
      await vi.waitFor(() => expect(messageHandler).toHaveBeenCalledTimes(1));
      expect(messageHandler.mock.calls[0][0].event).toMatchObject({
        type: 'message',
        text: 'signed hello',
        channel: 'C123',
      });
    });

    it('rejects an invalid signature with 401 and does not dispatch', async () => {
      const { port, messageHandler } = await startApp({
        ingressSecret: INGRESS_SECRET,
      });
      const rawBody = JSON.stringify(messageEnvelope());

      const res = await post(port, '/slack/events', rawBody, {
        'x-labor-ingress-timestamp': String(nowSeconds()),
        'x-labor-ingress-signature': '0'.repeat(64),
      });

      expect(res.statusCode).toBe(401);
      await new Promise((r) => setTimeout(r, 20));
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('rejects an expired (validly-signed) request with 401', async () => {
      const { port, messageHandler } = await startApp({
        ingressSecret: INGRESS_SECRET,
      });
      const rawBody = JSON.stringify(messageEnvelope());

      const res = await post(
        port,
        '/slack/events',
        rawBody,
        signIngress(rawBody, INGRESS_SECRET, nowSeconds() - 400),
      );

      expect(res.statusCode).toBe(401);
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('rejects requests missing the ingress headers with 401', async () => {
      const { port, messageHandler } = await startApp({
        ingressSecret: INGRESS_SECRET,
      });
      const rawBody = JSON.stringify(messageEnvelope());

      const res = await post(port, '/slack/events', rawBody);

      expect(res.statusCode).toBe(401);
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('prefers ingress auth when both secrets are set', async () => {
      const { port, messageHandler } = await startApp({
        ingressSecret: INGRESS_SECRET,
        signingSecret: SIGNING_SECRET,
      });
      const rawBody = JSON.stringify(messageEnvelope());

      // Slack-v0-signed only — must be rejected because the ingress scheme applies.
      const res = await post(
        port,
        '/slack/events',
        rawBody,
        signSlack(rawBody),
      );

      expect(res.statusCode).toBe(401);
      expect(messageHandler).not.toHaveBeenCalled();
    });
  });

  describe('direct Slack v0 auth', () => {
    it('dispatches a validly-signed event', async () => {
      const { port, messageHandler } = await startApp({
        signingSecret: SIGNING_SECRET,
      });
      const rawBody = JSON.stringify(messageEnvelope('direct slack'));

      const res = await post(
        port,
        '/slack/events',
        rawBody,
        signSlack(rawBody),
      );

      expect(res.statusCode).toBe(200);
      await vi.waitFor(() => expect(messageHandler).toHaveBeenCalledTimes(1));
      expect(messageHandler.mock.calls[0][0].event.text).toBe('direct slack');
    });

    it('rejects an invalid v0 signature with 401', async () => {
      const { port, messageHandler } = await startApp({
        signingSecret: SIGNING_SECRET,
      });
      const rawBody = JSON.stringify(messageEnvelope());

      const res = await post(port, '/slack/events', rawBody, {
        'x-slack-request-timestamp': String(nowSeconds()),
        'x-slack-signature': 'v0=' + '0'.repeat(64),
      });

      expect(res.statusCode).toBe(401);
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('rejects an expired v0 request with 401', async () => {
      const { port, messageHandler } = await startApp({
        signingSecret: SIGNING_SECRET,
      });
      const rawBody = JSON.stringify(messageEnvelope());

      const res = await post(
        port,
        '/slack/events',
        rawBody,
        signSlack(rawBody, SIGNING_SECRET, nowSeconds() - 400),
      );

      expect(res.statusCode).toBe(401);
      expect(messageHandler).not.toHaveBeenCalled();
    });
  });

  describe('url_verification', () => {
    it('echoes the challenge and does not dispatch to the app', async () => {
      const { app, port } = await startApp({ ingressSecret: INGRESS_SECRET });
      const processSpy = vi.spyOn(app, 'processEvent');
      const rawBody = JSON.stringify({
        token: 'tok',
        type: 'url_verification',
        challenge: 'challenge-abc-123',
      });

      const res = await post(
        port,
        '/slack/events',
        rawBody,
        signIngress(rawBody),
      );

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ challenge: 'challenge-abc-123' });
      expect(processSpy).not.toHaveBeenCalled();
    });

    it('still requires a valid signature for url_verification', async () => {
      const { port } = await startApp({ ingressSecret: INGRESS_SECRET });
      const rawBody = JSON.stringify({
        type: 'url_verification',
        challenge: 'challenge-abc-123',
      });

      const res = await post(port, '/slack/events', rawBody);

      expect(res.statusCode).toBe(401);
    });
  });

  describe('ack semantics', () => {
    it('acks with 200 immediately, before async processing completes', async () => {
      const { app, port } = await startApp({ ingressSecret: INGRESS_SECRET });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let handlerDone = false;
      app.event('message', async () => {
        await gate;
        handlerDone = true;
      });
      const rawBody = JSON.stringify(messageEnvelope());

      const res = await post(
        port,
        '/slack/events',
        rawBody,
        signIngress(rawBody),
      );

      // 200 returned while the handler is still blocked on the gate.
      expect(res.statusCode).toBe(200);
      expect(handlerDone).toBe(false);

      release();
      await vi.waitFor(() => expect(handlerDone).toBe(true));
    });
  });

  describe('routing and malformed input', () => {
    it('returns 404 for GET on the events path', async () => {
      const { port } = await startApp({ ingressSecret: INGRESS_SECRET });
      const res = await post(port, '/slack/events', '', {}, 'GET');
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for other paths', async () => {
      const { port } = await startApp({ ingressSecret: INGRESS_SECRET });
      const rawBody = JSON.stringify(messageEnvelope());
      const res = await post(port, '/other', rawBody, signIngress(rawBody));
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for a validly-signed but malformed JSON body', async () => {
      const { port } = await startApp({ ingressSecret: INGRESS_SECRET });
      const rawBody = 'not json{';
      const res = await post(
        port,
        '/slack/events',
        rawBody,
        signIngress(rawBody),
      );
      expect(res.statusCode).toBe(400);
    });
  });
});
