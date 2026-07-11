/**
 * Shared raw-body HTTP listener for ingress-style channel receivers.
 *
 * Both the Slack HTTP receiver (`/slack/events`) and the Telegram shared-bot
 * ingress (`/telegram/updates`) need to accept signed POSTs on the SAME port
 * (SLACK_HTTP_PORT). In hosted Kubernetes the tenant NetworkPolicy opens
 * exactly ONE port, so two independent `http.Server` instances can't both bind
 * it. This module owns a single listener per port and lets each receiver
 * register its own route on it: one bind, many routes.
 *
 * ── The port-0-is-NEVER-shared rule ──────────────────────────────────────────
 * `getIngressHttpServer(0)` returns a FRESH, independent server on EVERY call;
 * port 0 is never entered into the shared registry. Two reasons:
 *
 *   1. Test isolation. `port: 0` means "bind an ephemeral OS-assigned port".
 *      The slack-http-receiver test spins up many receivers on port 0 and each
 *      must get its own listener + its own `.address().port` — sharing a
 *      port-0 singleton would collapse them onto one server and cross-wire
 *      unrelated tests.
 *   2. Semantically, port 0 is a request for a *distinct* ephemeral port, so
 *      "the server for port 0" is not a meaningful shared identity anyway.
 *
 * For any real port > 0, `getIngressHttpServer(port)` returns the SAME
 * singleton, so slack + telegram share one bound listener in production.
 *
 * The server owns the security-critical raw-body plumbing (1 MiB cap with a
 * Content-Length fast path AND a running-counter teardown, mirroring the
 * original slack-http-receiver). It hands the matched route handler the raw
 * utf-8 body + req + res; the handler owns verification, status codes, and
 * dispatch. Per-request errors are caught so a buggy handler can't crash the
 * listener.
 *
 * Dependency-free: node `http` + the project logger only.
 */
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';

import { logger as defaultLogger } from '../logger.js';

// Cap the buffered request body to bound a pre-auth memory-exhaustion DoS.
// Matches the original slack-http-receiver value: event payloads are small and
// 1 MiB is generous headroom.
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

type Logger = Pick<typeof defaultLogger, 'info' | 'warn' | 'error' | 'debug'>;

/** A route handler receives the already-buffered raw body plus req/res. */
export type IngressRouteHandler = (
  rawBody: string,
  req: IncomingMessage,
  res: ServerResponse,
) => void;

export class IngressHttpServer {
  private readonly port: number;
  private readonly logger: Logger;
  private readonly routes = new Map<string, IngressRouteHandler>();
  private server: Server | undefined;
  private startPromise: Promise<Server> | undefined;

  constructor(port: number, logger: Logger = defaultLogger) {
    this.port = port;
    this.logger = logger;
  }

  private static key(method: string, path: string): string {
    return `${method} ${path}`;
  }

  /**
   * Register a route handler for a method+path. Throws if a DIFFERENT handler
   * is already registered for the same method+path (double-registration guard);
   * re-registering the identical handler function is a no-op.
   */
  registerRoute(
    method: 'POST',
    path: string,
    handler: IngressRouteHandler,
  ): void {
    const key = IngressHttpServer.key(method, path);
    const existing = this.routes.get(key);
    if (existing && existing !== handler) {
      throw new Error(
        `IngressHttpServer: a different handler is already registered for ${key}`,
      );
    }
    this.routes.set(key, handler);
  }

  /**
   * Bind on 0.0.0.0:<port> (NOT 127.0.0.1 — the ingress / other pods must reach
   * us). Idempotent: concurrent or repeated calls return the SAME promise/Server
   * so slack and telegram both calling start() on a shared port yield ONE bind.
   */
  start(): Promise<Server> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<Server>((resolve, reject) => {
      const server = createServer((req, res) => this.handleRequest(req, res));
      this.server = server;
      server.listen(this.port, '0.0.0.0', () => {
        this.logger.info(
          { port: this.port, routes: [...this.routes.keys()] },
          'Ingress HTTP server listening',
        );
        resolve(server);
      });
      server.on('error', (err) => {
        // Reset so a later start() can retry a clean bind.
        this.startPromise = undefined;
        this.server = undefined;
        reject(err);
      });
    });
    return this.startPromise;
  }

  /**
   * Close the server and drop it from the global registry so a later start()
   * rebinds cleanly. Idempotent.
   */
  stop(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = this.server;
      // Always remove from the registry, even if never started.
      unregisterIngressHttpServer(this.port, this);
      this.startPromise = undefined;
      if (!server) {
        this.server = undefined;
        resolve();
        return;
      }
      server.close((err) => {
        this.server = undefined;
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url || '').split('?')[0];
    const method = req.method || '';
    const handler = this.routes.get(IngressHttpServer.key(method, path));
    if (!handler) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    // Content-Length fast path: reject an advertised over-cap body before
    // attaching data listeners so we never buffer a byte. A malformed/absent
    // header falls through to the running counter below.
    const contentLength = Number(req.headers['content-length']);
    if (!Number.isNaN(contentLength) && contentLength > MAX_BODY_BYTES) {
      res.writeHead(413);
      res.end('Payload Too Large');
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      received += c.length;
      // Running-counter enforcement: defends against chunked / missing / lying
      // Content-Length. Stop buffering the moment we cross the cap, respond 413
      // (once), and tear down the socket.
      if (received > MAX_BODY_BYTES) {
        aborted = true;
        if (!res.headersSent) {
          res.writeHead(413);
          res.end('Payload Too Large');
        }
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      const rawBody = Buffer.concat(chunks).toString('utf-8');
      // Never let a route handler error crash the listener.
      try {
        handler(rawBody, req, res);
      } catch (err) {
        this.logger.error({ err, path }, 'Ingress route handler threw');
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('Internal Server Error');
        }
      }
    });
    req.on('error', (err) => {
      this.logger.warn({ err }, 'Ingress HTTP server request error');
      if (!res.headersSent) {
        res.writeHead(400);
        res.end('Bad Request');
      }
    });
  }
}

// Process-global registry keyed by port. Only ports > 0 are ever stored; port 0
// is deliberately never shared (see the file header).
const registry = new Map<number, IngressHttpServer>();

/**
 * Get the shared ingress HTTP server for `port`.
 *
 * - port === 0 → a FRESH, unshared server every call (test isolation; each gets
 *   its own ephemeral OS-assigned port).
 * - port > 0   → the process-global singleton for that port (slack + telegram
 *   share ONE listener + one bind).
 */
export function getIngressHttpServer(
  port: number,
  logger?: Logger,
): IngressHttpServer {
  if (port === 0) {
    return new IngressHttpServer(0, logger);
  }
  let server = registry.get(port);
  if (!server) {
    server = new IngressHttpServer(port, logger);
    registry.set(port, server);
  }
  return server;
}

/**
 * Remove a server from the registry (called by stop()). Only removes the entry
 * if it still points at THIS instance, so a stop() on a stale handle never
 * evicts a freshly rebound server.
 */
function unregisterIngressHttpServer(
  port: number,
  server: IngressHttpServer,
): void {
  if (port === 0) return;
  if (registry.get(port) === server) registry.delete(port);
}
