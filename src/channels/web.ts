/**
 * Web chat widget channel — a browser-embeddable chat surface (like
 * Intercom/Crisp, but fully self-owned, no third-party API). This is the
 * default customer-facing deployment surface for the hosted SaaS.
 *
 * A visitor's browser talks to this channel over plain HTTP:
 *   - POST /api/message  — the visitor sends a message.
 *   - GET  /api/stream    — a Server-Sent-Events stream that pushes assistant
 *                           replies back to that visitor's open tab(s).
 * The client script lives at `public/widget/labor-widget.js`.
 *
 * SAFETY / OPT-IN: this module is fully inert unless WEB_WIDGET_ENABLED=true.
 * When enabled it additionally REQUIRES WEB_WIDGET_SITE_KEY and
 * WEB_WIDGET_ALLOWED_ORIGINS; if either is missing the factory returns null
 * (fail-closed) so we never half-start an open, unauthenticated widget.
 *
 * This module does PLAINTEXT HTTP only — like the other channels it does no
 * TLS of its own. In production a reverse proxy / TLS terminator is expected
 * in front of WEB_WIDGET_PORT.
 *
 * SECURITY: the server only ever emits JSON / SSE data frames; it NEVER
 * renders HTML from visitor input, so server-side XSS is not possible here.
 * The browser widget is responsible for escaping when it renders text (it uses
 * textContent, never innerHTML — see labor-widget.js). Every string that would
 * touch the filesystem (the group `folder`) is the fixed
 * WEB_WIDGET_DEFAULT_GROUP constant, never anything derived from visitor input,
 * and the visitor's jid is always built server-side from a validated siteId +
 * a regex-validated sessionId, so a client can never inject an arbitrary jid or
 * path.
 */
import { createServer, Server, IncomingMessage } from 'http';
import { randomUUID } from 'crypto';

import { ASSISTANT_NAME } from '../config.js';
import { storeOutboundMessage } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, RegisteredGroup, SendMessageOpts } from '../types.js';

/** Opaque session token shape: 8–128 url-safe chars. Untrusted client input
 * must match this before it is ever used to build a jid. */
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;

/** Max request body we will read for a chat message (before JSON.parse). A
 * chat message is tiny; 32KB is generous and caps abuse. */
const MAX_BODY_BYTES = 32 * 1024;

/** Cap on the number of tracked rate-limit sessions, LRU-evicted (mirrors the
 * THREAD_ID_BY_ID_MAX / INBOUND_BY_ID_MAX patterns in telegram.ts/discord.ts)
 * so the counter map can't grow unboundedly across many visitors. */
const RATE_LIMIT_SESSIONS_MAX = 10_000;

/** SSE heartbeat interval — keeps idle streams alive through proxies/LBs. */
const HEARTBEAT_MS = 25_000;

export interface WebChannelConfig {
  port: number;
  host: string;
  siteKey: string;
  /** Non-secret namespacing label used in the jid (see jid note below). */
  siteId: string;
  allowedOrigins: string[];
  defaultGroup: string;
  rateLimitPerMin: number;
  maxMessageLength: number;
}

/** Minimal shape we need off an inbound request — duck-typed so tests can pass
 * a plain object without a real socket. */
type ReqLike = Pick<IncomingMessage, 'method' | 'url' | 'headers' | 'on'>;

/** Minimal shape we need off a response — duck-typed for the same reason. */
interface ResLike {
  writeHead(code: number, headers?: Record<string, string>): unknown;
  write(chunk: string): unknown;
  end(body?: string): unknown;
  on?(event: string, cb: () => void): unknown;
}

export class WebChannel implements Channel {
  name = 'web';

  private opts: ChannelOpts;
  private cfg: WebChannelConfig;
  private server: Server | null = null;

  /**
   * SSE session map: jid → array of open SSE responses. An array (not a single
   * value) so a visitor with multiple tabs open all receive the reply. Each
   * entry is cleaned out on the connection's 'close' event so dead sockets are
   * not leaked. sendMessage() writes to every response registered for a jid.
   */
  private streams = new Map<string, ResLike[]>();

  /** Per-session fixed-window rate-limit counters. Fixed window (reset every
   * 60s) is simpler than a sliding window; the tradeoff is it permits up to ~2x
   * the nominal rate across a window boundary, which is fine for abuse control
   * on a chat widget. Insertion-ordered Map used as an LRU (see cap above). */
  private rateWindows = new Map<
    string,
    { windowStart: number; count: number }
  >();

  constructor(opts: ChannelOpts, cfg: WebChannelConfig) {
    this.opts = opts;
    this.cfg = cfg;
  }

  // --- Channel interface ---

  async connect(): Promise<void> {
    const server = createServer((req, res) => {
      // The handler is async; never let a rejection crash the process.
      void this.handleRequest(req, res).catch((err) => {
        logger.warn({ err }, 'Web widget: unhandled request error');
        try {
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal error' }));
          }
        } catch (_endErr) {
          // response already torn down — nothing to do
        }
      });
    });

    return new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // Bind 0.0.0.0: unlike the localhost-only smithers bridge, browsers
      // connect to this port directly (through a reverse proxy in prod).
      server.listen(this.cfg.port, this.cfg.host, () => {
        this.server = server;
        logger.info(
          { port: this.cfg.port, host: this.cfg.host },
          'Web widget channel listening',
        );
        resolve();
      });
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    _opts?: SendMessageOpts,
  ): Promise<void> {
    const messageId = randomUUID();
    const timestamp = new Date().toISOString();
    const responses = this.streams.get(jid);

    if (!responses || responses.length === 0) {
      // v1 limitation: no offline queue. If the visitor has no open SSE stream
      // (closed the tab, etc.) the reply is dropped — matching the other
      // channels' best-effort, fire-and-forget semantics.
      logger.debug(
        { jid },
        'No active web stream for jid — assistant message dropped (no offline queue)',
      );
    } else {
      const frame = this.sseFrame({ type: 'message', text, timestamp });
      for (const res of responses) {
        try {
          res.write(frame);
        } catch (err) {
          logger.debug({ jid, err }, 'Web widget: failed to write SSE frame');
        }
      }
    }

    try {
      storeOutboundMessage(jid, messageId, text, ASSISTANT_NAME);
    } catch (err) {
      logger.warn({ err, jid }, 'storeOutboundMessage failed (continuing)');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const responses = this.streams.get(jid);
    if (!responses || responses.length === 0) return;
    const frame = this.sseFrame({ type: 'typing', isTyping });
    for (const res of responses) {
      try {
        res.write(frame);
      } catch (_err) {
        // best effort — a dead stream will be reaped on its own 'close'
      }
    }
  }

  isConnected(): boolean {
    return this.server !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('web:');
  }

  async disconnect(): Promise<void> {
    for (const responses of this.streams.values()) {
      for (const res of responses) {
        try {
          res.end();
        } catch (_err) {
          // ignore — best effort teardown
        }
      }
    }
    this.streams.clear();
    this.rateWindows.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      logger.info('Web widget channel stopped');
    }
  }

  // --- Request handling (extracted so tests can drive it directly, without a
  // real TCP socket — pass duck-typed req/res objects). ---

  async handleRequest(req: ReqLike, res: ResLike): Promise<void> {
    const method = req.method || 'GET';
    const rawUrl = req.url || '/';
    const path = rawUrl.split('?')[0];

    if (method === 'OPTIONS') {
      this.handlePreflight(req, res);
      return;
    }
    if (method === 'POST' && path === '/api/message') {
      await this.handleMessage(req, res);
      return;
    }
    if (method === 'GET' && path === '/api/stream') {
      this.handleStream(req, res);
      return;
    }
    if (method === 'GET' && path === '/health') {
      this.sendJson(res, 200, { status: 'ok' }, undefined);
      return;
    }
    this.sendJson(res, 404, { error: 'not found' }, undefined);
  }

  /** CORS preflight. Reflects the origin ONLY on an exact allowlist match
   * (exact string equality — never substring/regex, which is the classic
   * origin-check bug). If the origin isn't allowed, we omit CORS headers so the
   * browser blocks the request client-side. */
  private handlePreflight(req: ReqLike, res: ResLike): void {
    const origin = this.headerStr(req.headers['origin']);
    const allowed = origin ? this.isAllowedOrigin(origin) : false;
    const headers: Record<string, string> = {
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Site-Key',
      'Access-Control-Max-Age': '600',
    };
    if (allowed && origin) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Vary'] = 'Origin';
    }
    res.writeHead(allowed ? 204 : 403, headers);
    res.end();
  }

  private async handleMessage(req: ReqLike, res: ResLike): Promise<void> {
    // Fail closed, cheapest/most-specific checks first.

    // 1. Origin check. We require Origin to be present AND allowlisted: this
    // widget is meant to be embedded on the customer's own site specifically
    // (a real cross-origin browser request carries Origin), not called
    // anonymously server-to-server. So a missing Origin is treated as a
    // rejection, not a same-origin allowance.
    const origin = this.headerStr(req.headers['origin']);
    if (!origin || !this.isAllowedOrigin(origin)) {
      this.sendJson(res, 403, { error: 'origin not allowed' }, undefined);
      return;
    }

    // 2. Site-key check. Never log the key value itself.
    const siteKey = this.headerStr(req.headers['x-site-key']);
    if (siteKey !== this.cfg.siteKey) {
      logger.warn({ origin }, 'Web widget: invalid site key');
      this.sendJson(res, 401, { error: 'invalid site key' }, origin);
      return;
    }

    // 3. Read + parse the (size-capped) JSON body.
    let body: unknown;
    try {
      body = await this.readJsonBody(req);
    } catch (err) {
      const tooLarge = (err as Error).message === 'body too large';
      this.sendJson(
        res,
        tooLarge ? 413 : 400,
        { error: tooLarge ? 'body too large' : 'invalid json' },
        origin,
      );
      return;
    }
    const parsed = (body ?? {}) as { sessionId?: unknown; text?: unknown };

    // 4. Validate text.
    if (typeof parsed.text !== 'string') {
      this.sendJson(res, 400, { error: 'text is required' }, origin);
      return;
    }
    const text = parsed.text.trim();
    if (!text) {
      this.sendJson(res, 400, { error: 'text is empty' }, origin);
      return;
    }

    // 5. Enforce max length — reject, never silently truncate.
    if (text.length > this.cfg.maxMessageLength) {
      this.sendJson(
        res,
        400,
        {
          error: 'message too long',
          maxLength: this.cfg.maxMessageLength,
        },
        origin,
      );
      return;
    }

    // 6. Resolve/validate the session id. A client-supplied id is untrusted:
    // it must match the opaque-token shape or we mint a fresh one. Never used
    // to build a filesystem path — only the jid (via the fixed prefix + siteId).
    let sessionId: string;
    if (typeof parsed.sessionId === 'string' && parsed.sessionId) {
      if (!SESSION_ID_RE.test(parsed.sessionId)) {
        this.sendJson(res, 400, { error: 'invalid session id' }, origin);
        return;
      }
      sessionId = parsed.sessionId;
    } else {
      sessionId = randomUUID().replace(/-/g, '');
    }

    // 7. Build the jid. NOTE: we deliberately use the NON-SECRET siteId here,
    // never WEB_WIDGET_SITE_KEY — embedding the secret key in the jid would
    // leak it into logs, the DB, and KB folder names. The jid shape is
    // `web:<siteId>:<sessionId>`.
    const jid = `web:${this.cfg.siteId}:${sessionId}`;

    // 8. Rate limit (fixed 60s window, per session).
    if (!this.checkRateLimit(sessionId)) {
      logger.debug({ jid }, 'Web widget: rate limit exceeded');
      this.sendJson(res, 429, { error: 'rate limit exceeded' }, origin);
      return;
    }

    const timestamp = new Date().toISOString();

    // 9. Auto-register a group for a new visitor jid. All web sessions share
    // ONE folder (WEB_WIDGET_DEFAULT_GROUP) — sessions are ephemeral/numerous
    // and we don't want to spam GROUPS_DIR. registerGroup is keyed by jid, so
    // each session jid gets its own registry entry all pointing at the same
    // folder. requiresTrigger:false because talking to the widget is inherently
    // a 1:1 conversation with the assistant (no @-mention needed).
    if (!this.opts.registeredGroups()[jid]) {
      const newGroup: RegisteredGroup = {
        name: `Web visitor ${sessionId.slice(0, 8)}`,
        folder: this.cfg.defaultGroup,
        trigger: `@${ASSISTANT_NAME}`,
        added_at: new Date().toISOString(),
        requiresTrigger: false,
      };
      this.opts.registerGroup(jid, newGroup);
    }

    // 10. Deliver. onChatMetadata records discovery; onMessage feeds the loop.
    this.opts.onChatMetadata(jid, timestamp, 'Web visitor', 'web', false);
    this.opts.onMessage(jid, {
      id: randomUUID(),
      chat_jid: jid,
      sender: sessionId,
      sender_name: 'Web visitor',
      content: text,
      timestamp,
      is_from_me: false,
    });

    logger.info({ jid, origin }, 'Web widget message received');

    // 11. Respond with the resolved session id (so a fresh client persists it)
    // and a message id. Plain JSON string fields only — never pre-rendered HTML.
    this.sendJson(res, 200, { sessionId, messageId: randomUUID() }, origin);
  }

  private handleStream(req: ReqLike, res: ResLike): void {
    // A GET SSE stream is as much an attack surface as the POST: same
    // origin + site-key checks apply.
    const origin = this.headerStr(req.headers['origin']);
    if (!origin || !this.isAllowedOrigin(origin)) {
      this.sendJson(res, 403, { error: 'origin not allowed' }, undefined);
      return;
    }
    // Site key on the stream: the browser's EventSource API cannot set request
    // headers, so for the GET stream we accept the site key via the
    // `siteKey` query param (falling back to the X-Site-Key header for
    // non-browser clients / proxies that can inject it). The site key is a
    // shared PUBLIC widget key, not a user secret — but we still never log its
    // value, and only ever compare it.
    const siteKey =
      this.parseQueryParam(req.url || '', 'siteKey') ||
      this.headerStr(req.headers['x-site-key']);
    if (siteKey !== this.cfg.siteKey) {
      logger.warn({ origin }, 'Web widget: invalid site key on stream');
      this.sendJson(res, 401, { error: 'invalid site key' }, origin);
      return;
    }

    // sessionId comes in as a query param. It is an opaque, unguessable token
    // (not a secret protecting anything beyond "which visitor am I"), and the
    // SSE response is consumed same-origin by the widget's own JS, so a query
    // param is acceptable. We log it only at debug (never at info) to avoid
    // spraying it into third-party-visible logs.
    const sessionId = this.parseQueryParam(req.url || '', 'sessionId');
    if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
      this.sendJson(res, 400, { error: 'invalid session id' }, origin);
      return;
    }
    const jid = `web:${this.cfg.siteId}:${sessionId}`;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
    });
    // Initial comment so EventSource fires onopen.
    res.write(': connected\n\n');

    const list = this.streams.get(jid) || [];
    list.push(res);
    this.streams.set(jid, list);
    logger.debug({ jid }, 'Web widget SSE stream opened');

    // Heartbeat keeps idle connections alive through proxies/LBs.
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (_err) {
        // dead — 'close' cleanup below will run
      }
    }, HEARTBEAT_MS);
    if (typeof (heartbeat as { unref?: () => void }).unref === 'function') {
      (heartbeat as { unref: () => void }).unref();
    }

    const cleanup = (): void => {
      clearInterval(heartbeat);
      const arr = this.streams.get(jid);
      if (arr) {
        const idx = arr.indexOf(res);
        if (idx !== -1) arr.splice(idx, 1);
        if (arr.length === 0) this.streams.delete(jid);
      }
      logger.debug({ jid }, 'Web widget SSE stream closed');
    };
    // Prefer the request's close event; the duck-typed test object may not
    // have one, which is fine (no socket to leak in a test).
    if (typeof req.on === 'function') {
      req.on('close', cleanup);
    }
  }

  // --- Helpers ---

  /** Exact-match origin allowlist. Exact string equality only — no substring,
   * no regex — to avoid origin-check bypass bugs. */
  private isAllowedOrigin(origin: string): boolean {
    return this.cfg.allowedOrigins.includes(origin);
  }

  /** Fixed-window rate limiter. Returns true if the message is allowed.
   * Opportunistically evicts expired windows and LRU-caps the map size. */
  private checkRateLimit(sessionId: string): boolean {
    const now = Date.now();
    const windowMs = 60_000;
    const existing = this.rateWindows.get(sessionId);

    if (existing && now - existing.windowStart < windowMs) {
      if (existing.count >= this.cfg.rateLimitPerMin) return false;
      existing.count += 1;
      // Refresh LRU position.
      this.rateWindows.delete(sessionId);
      this.rateWindows.set(sessionId, existing);
      return true;
    }

    // New or expired window.
    this.rateWindows.delete(sessionId);
    this.rateWindows.set(sessionId, { windowStart: now, count: 1 });

    if (this.rateWindows.size > RATE_LIMIT_SESSIONS_MAX) {
      const oldest = this.rateWindows.keys().next().value;
      if (oldest !== undefined) this.rateWindows.delete(oldest);
    }
    return true;
  }

  /** Read the request body with a hard size cap, then JSON.parse it. Rejects
   * with 'body too large' before parsing an oversized payload. */
  private readJsonBody(req: ReqLike): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('body too large'));
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(err as Error);
        }
      });
      req.on('error', reject);
    });
  }

  /** Build an SSE `data:` frame from a JSON payload. */
  private sseFrame(payload: unknown): string {
    return `data: ${JSON.stringify(payload)}\n\n`;
  }

  /** Send a JSON response, optionally reflecting an already-validated origin. */
  private sendJson(
    res: ResLike,
    code: number,
    obj: unknown,
    origin: string | undefined,
  ): void {
    const body = JSON.stringify(obj);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    };
    if (origin) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Vary'] = 'Origin';
    }
    res.writeHead(code, headers);
    res.end(body);
  }

  private headerStr(v: string | string[] | undefined): string | undefined {
    if (Array.isArray(v)) return v[0];
    return v;
  }

  private parseQueryParam(url: string, key: string): string | undefined {
    const qIdx = url.indexOf('?');
    if (qIdx === -1) return undefined;
    const params = new URLSearchParams(url.slice(qIdx + 1));
    return params.get(key) ?? undefined;
  }
}

/** Split a comma-separated env value into a trimmed, non-empty list. */
function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

registerChannel('web', (opts: ChannelOpts) => {
  const env = readEnvFile([
    'WEB_WIDGET_ENABLED',
    'WEB_WIDGET_PORT',
    'WEB_WIDGET_SITE_KEY',
    'WEB_WIDGET_SITE_ID',
    'WEB_WIDGET_ALLOWED_ORIGINS',
    'WEB_WIDGET_DEFAULT_GROUP',
    'WEB_WIDGET_RATE_LIMIT_PER_MIN',
    'WEB_WIDGET_MAX_MESSAGE_LENGTH',
    'WEB_WIDGET_HOST',
  ]);
  const get = (k: string): string => process.env[k] || env[k] || '';

  if (get('WEB_WIDGET_ENABLED') !== 'true') {
    // Not enabled — inert, no server, no noisy log (index.ts already logs the
    // generic "channel skipped" line for a null factory).
    return null;
  }

  const siteKey = get('WEB_WIDGET_SITE_KEY');
  if (!siteKey) {
    logger.warn(
      'Web widget: WEB_WIDGET_ENABLED=true but WEB_WIDGET_SITE_KEY is unset — refusing to start an unauthenticated widget',
    );
    return null;
  }

  const allowedOrigins = splitList(get('WEB_WIDGET_ALLOWED_ORIGINS'));
  if (allowedOrigins.length === 0) {
    logger.warn(
      'Web widget: WEB_WIDGET_ENABLED=true but WEB_WIDGET_ALLOWED_ORIGINS is empty — refusing to start with an open CORS policy',
    );
    return null;
  }

  const cfg: WebChannelConfig = {
    port: Number(get('WEB_WIDGET_PORT') || 3100),
    host: get('WEB_WIDGET_HOST') || '0.0.0.0',
    siteKey,
    siteId: get('WEB_WIDGET_SITE_ID') || 'default',
    allowedOrigins,
    defaultGroup: get('WEB_WIDGET_DEFAULT_GROUP') || 'web-visitors',
    rateLimitPerMin: Number(get('WEB_WIDGET_RATE_LIMIT_PER_MIN') || 20),
    maxMessageLength: Number(get('WEB_WIDGET_MAX_MESSAGE_LENGTH') || 4000),
  };

  return new WebChannel(opts, cfg);
});
