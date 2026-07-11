/**
 * HTTP receiver for the Slack channel — an alternative to Socket Mode.
 *
 * A thin, hand-rolled custom bolt Receiver that feeds Slack's Events API into
 * `app.processEvent()`, so ALL registered `app.event(...)` handlers are shared
 * between Socket Mode and HTTP mode with zero duplication.
 *
 * Why not bolt's built-in HTTPReceiver/ExpressReceiver? Those only support
 * Slack's own signing-secret verification and their own routing/ack lifecycle.
 * Our contract needs (a) a *forwarded-from-ingress* HMAC scheme, (b) direct
 * Slack v0 signature verification, AND (c) our own immediate-200-then-async-
 * process ack semantics. A hand-rolled receiver that calls `app.processEvent()`
 * gives us full control over verification and acking while keeping the event
 * handlers shared — and it avoids pulling in ExpressReceiver's express
 * dependency and subclassing its verification.
 */
import { Server, IncomingMessage, ServerResponse } from 'http';
import { createHmac, timingSafeEqual } from 'crypto';

import type { App, Receiver, ReceiverEvent } from '@slack/bolt';

import { getIngressHttpServer } from './ingress-http-server.js';
import { logger as defaultLogger } from '../logger.js';

// Slack allows a 3s budget to respond to events, and rejects requests whose
// timestamp is stale. We use ±300s (matching Slack's own guidance) to bound
// replay of captured signatures.
const MAX_TIMESTAMP_SKEW_SECONDS = 300;

type Logger = Pick<typeof defaultLogger, 'info' | 'warn' | 'error' | 'debug'>;

export interface SlackHttpReceiverOptions {
  port: number;
  /**
   * Shared secret with the ingress/control-plane. When set, requests are
   * verified using the forwarded-from-ingress HMAC scheme and Slack's own
   * signing secret is not consulted (the ingress already verified Slack).
   */
  ingressSecret?: string;
  /** Slack signing secret — used for direct Slack v0 verification. */
  signingSecret?: string;
  logger?: Logger;
}

/**
 * Constant-time comparison of two hex/ascii strings. `timingSafeEqual` throws
 * when the buffers differ in length, so we guard on length first (a length
 * mismatch is itself a definitive non-match).
 */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  try {
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Verify a forwarded-from-ingress request.
 * expected = hex(HMAC_SHA256(ingressSecret, `${timestamp}.${rawBody}`))
 */
export function verifyIngressSignature(args: {
  ingressSecret: string;
  rawBody: string;
  timestamp: string | undefined;
  signature: string | undefined;
  nowSeconds: number;
}): boolean {
  const { ingressSecret, rawBody, timestamp, signature, nowSeconds } = args;
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (Number.isNaN(ts)) return false;
  if (Math.abs(nowSeconds - ts) > MAX_TIMESTAMP_SKEW_SECONDS) return false;

  const expected = createHmac('sha256', ingressSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return safeCompare(expected, signature);
}

/**
 * Verify a direct Slack request using the v0 signing scheme.
 * basestring = `v0:${timestamp}:${rawBody}`
 * expected   = 'v0=' + hex(HMAC_SHA256(signingSecret, basestring))
 */
export function verifySlackSignature(args: {
  signingSecret: string;
  rawBody: string;
  timestamp: string | undefined;
  signature: string | undefined;
  nowSeconds: number;
}): boolean {
  const { signingSecret, rawBody, timestamp, signature, nowSeconds } = args;
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (Number.isNaN(ts)) return false;
  if (Math.abs(nowSeconds - ts) > MAX_TIMESTAMP_SKEW_SECONDS) return false;

  const expected =
    'v0=' +
    createHmac('sha256', signingSecret)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest('hex');
  return safeCompare(expected, signature);
}

export class SlackHttpReceiver implements Receiver {
  private app: App | undefined;
  private readonly port: number;
  private readonly ingressSecret: string | undefined;
  private readonly signingSecret: string | undefined;
  private readonly logger: Logger;

  constructor(opts: SlackHttpReceiverOptions) {
    this.port = opts.port;
    this.ingressSecret = opts.ingressSecret;
    this.signingSecret = opts.signingSecret;
    this.logger = opts.logger ?? defaultLogger;
  }

  init(app: App): void {
    this.app = app;
  }

  start(): Promise<Server> {
    // Share ONE listener per port with any other ingress receiver (e.g. the
    // Telegram shared-bot ingress) so both can bind the same SLACK_HTTP_PORT.
    // Raw-body buffering + the 1 MiB cap now live in the shared server; this
    // handler owns verification, the url_verification challenge, ack, and
    // dispatch — behaviorally identical to the previous inline handleRequest.
    const shared = getIngressHttpServer(this.port, this.logger);
    shared.registerRoute('POST', '/slack/events', (rawBody, req, res) =>
      this.handleSlackRequest(rawBody, req, res),
    );
    return shared.start();
  }

  stop(): Promise<void> {
    return getIngressHttpServer(this.port, this.logger).stop();
  }

  private handleSlackRequest(
    rawBody: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): void {
    // Raw body first: signature verification runs on the raw bytes, BEFORE any
    // JSON parsing.
    const nowSeconds = Math.floor(Date.now() / 1000);

    const verified = this.verify(req, rawBody, nowSeconds);
    if (!verified) {
      this.logger.warn(
        { url: req.url, mode: this.ingressSecret ? 'ingress' : 'slack' },
        'Slack HTTP receiver rejected request (signature verification failed)',
      );
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }

    // Slack's URL verification handshake: echo the challenge. Verified above,
    // but never dispatched to the app.
    if (parsed.type === 'url_verification') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ challenge: parsed.challenge }));
      return;
    }

    // Ack Slack immediately (empty 200 within the 3s budget), THEN process
    // asynchronously — fire-and-forget so slow handlers never blow the ack.
    res.writeHead(200);
    res.end();

    this.dispatch(parsed);
  }

  private verify(
    req: IncomingMessage,
    rawBody: string,
    nowSeconds: number,
  ): boolean {
    // Prefer the forwarded-from-ingress scheme when an ingress secret is set;
    // otherwise fall back to direct Slack v0 verification.
    if (this.ingressSecret) {
      return verifyIngressSignature({
        ingressSecret: this.ingressSecret,
        rawBody,
        timestamp: header(req, 'x-labor-ingress-timestamp'),
        signature: header(req, 'x-labor-ingress-signature'),
        nowSeconds,
      });
    }
    if (this.signingSecret) {
      return verifySlackSignature({
        signingSecret: this.signingSecret,
        rawBody,
        timestamp: header(req, 'x-slack-request-timestamp'),
        signature: header(req, 'x-slack-signature'),
        nowSeconds,
      });
    }
    // No secret configured — cannot verify, so reject. (The channel refuses to
    // start in this state, so this is a defensive fallback.)
    return false;
  }

  private dispatch(body: Record<string, unknown>): void {
    if (!this.app) {
      this.logger.warn('Slack HTTP receiver dispatched an event before init()');
      return;
    }
    const event: ReceiverEvent = {
      body,
      // We ack Slack over HTTP ourselves, so the bolt-side ack is a no-op.
      ack: async () => {},
    };
    // Never let a handler error crash the server.
    this.app.processEvent(event).catch((err) => {
      this.logger.error({ err }, 'Slack HTTP receiver processEvent failed');
    });
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
