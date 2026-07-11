import http from 'http';
import type { AddressInfo } from 'net';

import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import {
  getIngressHttpServer,
  IngressHttpServer,
} from './ingress-http-server.js';

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

describe('IngressHttpServer', () => {
  const started: IngressHttpServer[] = [];

  afterEach(async () => {
    while (started.length > 0) {
      await started.pop()!.stop();
    }
    vi.clearAllMocks();
  });

  async function startFresh(): Promise<{
    server: IngressHttpServer;
    port: number;
  }> {
    const server = getIngressHttpServer(0);
    started.push(server);
    // A route is required to reach a 200; register a trivial echo.
    server.registerRoute('POST', '/echo', (raw, _req, res) => {
      res.writeHead(200);
      res.end(raw);
    });
    const httpServer = await server.start();
    const port = (httpServer.address() as AddressInfo).port;
    return { server, port };
  }

  describe('port-0 isolation', () => {
    it('gives two distinct servers on port 0 different ephemeral ports', async () => {
      const a = getIngressHttpServer(0);
      const b = getIngressHttpServer(0);
      started.push(a, b);
      expect(a).not.toBe(b);

      a.registerRoute('POST', '/x', (_r, _q, res) => {
        res.writeHead(200);
        res.end('a');
      });
      b.registerRoute('POST', '/x', (_r, _q, res) => {
        res.writeHead(200);
        res.end('b');
      });
      const sa = await a.start();
      const sb = await b.start();
      const pa = (sa.address() as AddressInfo).port;
      const pb = (sb.address() as AddressInfo).port;
      expect(pa).not.toBe(pb);

      // Each server serves only its own handler.
      expect((await post(pa, '/x', '')).body).toBe('a');
      expect((await post(pb, '/x', '')).body).toBe('b');
    });

    it('shares the SAME instance for a port > 0', () => {
      const a = getIngressHttpServer(31999);
      const b = getIngressHttpServer(31999);
      try {
        expect(a).toBe(b);
      } finally {
        void a.stop();
      }
    });
  });

  describe('routing', () => {
    it('dispatches to a registered route and 404s unknown paths/methods', async () => {
      const { port } = await startFresh();

      const ok = await post(port, '/echo', 'hello');
      expect(ok.statusCode).toBe(200);
      expect(ok.body).toBe('hello');

      const wrongPath = await post(port, '/nope', 'x');
      expect(wrongPath.statusCode).toBe(404);

      const wrongMethod = await post(port, '/echo', '', {}, 'GET');
      expect(wrongMethod.statusCode).toBe(404);
    });

    it('throws if a different handler is registered for the same route', async () => {
      const { server } = await startFresh();
      expect(() =>
        server.registerRoute('POST', '/echo', (_r, _q, res) => res.end()),
      ).toThrow(/already registered/);
    });
  });

  describe('body size cap', () => {
    const OVERSIZE = 'x'.repeat(1024 * 1024 + 1024);

    it('rejects an oversize body with 413 and never invokes the handler', async () => {
      const server = getIngressHttpServer(0);
      started.push(server);
      const handler = vi.fn((_raw: string, _req: any, res: any) => {
        res.writeHead(200);
        res.end();
      });
      server.registerRoute('POST', '/echo', handler);
      const httpServer = await server.start();
      const port = (httpServer.address() as AddressInfo).port;

      const res = await post(port, '/echo', OVERSIZE);
      expect(res.statusCode).toBe(413);
      await new Promise((r) => setTimeout(r, 20));
      expect(handler).not.toHaveBeenCalled();
    }, 10_000);
  });

  describe('start/stop idempotency', () => {
    it('start() is idempotent (same Server) and stop() lets a later start rebind', async () => {
      const { server, port } = await startFresh();
      const again = await server.start();
      expect((again.address() as AddressInfo).port).toBe(port);

      await server.stop();
      // A fresh port-0 server can bind again with no leaked listener.
      const next = getIngressHttpServer(0);
      started.push(next);
      next.registerRoute('POST', '/echo', (raw, _q, res) => {
        res.writeHead(200);
        res.end(raw);
      });
      const s2 = await next.start();
      expect((s2.address() as AddressInfo).port).toBeGreaterThan(0);
    });
  });
});
