/**
 * Smithers bridge — a localhost-only HTTP endpoint that lets the out-of-tree
 * Smithers sidecar (see orchestration/) execute a single agent step through
 * this process's runContainerAgent(), so every durable-workflow step keeps the
 * container sandbox, credential proxy, per-group memory, and RBAC.
 *
 * This module is HTTP + auth ONLY. The actual execution closure (resolving the
 * group and calling runContainerAgent) is injected as `runStep` by index.ts, so
 * the bridge stays decoupled from the framework's internals.
 *
 * SAFETY: it is inert unless SMITHERS_BRIDGE_ENABLED=true. It binds to
 * 127.0.0.1 and requires a shared bearer token. It never sees model secrets
 * (those stay in the credential proxy). See docs/SMITHERS-ORCHESTRATION.md.
 *
 * CONCURRENCY CAVEAT: this calls runContainerAgent directly, NOT through the
 * GroupQueue, so a workflow step and a live chat message for the SAME group
 * could spawn containers concurrently and race on that group's memory. Treat
 * the bridge as experimental and don't point a workflow at an actively-chatting
 * group until the queue-routed version lands (tracked in the migration epic).
 */
import { createServer, Server } from 'http';

import { logger } from './logger.js';

/** A single workflow step to execute inside a group's container. */
export interface BridgeRunRequest {
  /** Group folder slug (informational; the group is resolved by chatJid). */
  group: string;
  /** The group's jid — used to resolve the RegisteredGroup. */
  chatJid: string;
  /** Fully-rendered prompt for this step. */
  prompt: string;
  /** Per-run model id (the step's tier), passed as ContainerInput.modelOverride. */
  modelOverride?: string;
  /** Restrict tools for sandboxed steps. */
  allowedTools?: string[];
}

export interface BridgeRunResult {
  status: 'success' | 'error';
  result: string | null;
  error?: string;
}

export type BridgeRunStep = (req: BridgeRunRequest) => Promise<BridgeRunResult>;

export interface SmithersBridgeOptions {
  port: number;
  /** Shared bearer token; requests without it are rejected. */
  token: string;
  runStep: BridgeRunStep;
  host?: string;
}

function readJsonBody(
  req: import('http').IncomingMessage,
  limitBytes = 5_000_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Start the bridge. Resolves once it is listening. Caller closes the returned
 * Server on shutdown.
 */
export function startSmithersBridge(
  opts: SmithersBridgeOptions,
): Promise<Server> {
  const { port, token, runStep, host = '127.0.0.1' } = opts;

  const server = createServer((req, res) => {
    void (async () => {
      const send = (code: number, obj: unknown): void => {
        const body = JSON.stringify(obj);
        res.writeHead(code, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        });
        res.end(body);
      };

      // Bearer-token auth on every request.
      const auth = req.headers['authorization'];
      if (auth !== `Bearer ${token}`) {
        send(401, { status: 'error', result: null, error: 'unauthorized' });
        return;
      }

      if (req.method === 'GET' && req.url === '/health') {
        send(200, { status: 'success', result: 'ok' });
        return;
      }

      if (req.method !== 'POST' || req.url !== '/run-step') {
        send(404, { status: 'error', result: null, error: 'not found' });
        return;
      }

      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        send(400, {
          status: 'error',
          result: null,
          error: `bad request: ${(err as Error).message}`,
        });
        return;
      }

      const reqBody = body as Partial<BridgeRunRequest>;
      if (!reqBody?.chatJid || typeof reqBody.prompt !== 'string') {
        send(400, {
          status: 'error',
          result: null,
          error: 'chatJid and prompt are required',
        });
        return;
      }

      try {
        const out = await runStep({
          group: reqBody.group ?? '',
          chatJid: reqBody.chatJid,
          prompt: reqBody.prompt,
          modelOverride: reqBody.modelOverride,
          allowedTools: reqBody.allowedTools,
        });
        send(200, out);
      } catch (err) {
        logger.error({ err }, 'Smithers bridge run-step failed');
        send(500, {
          status: 'error',
          result: null,
          error: (err as Error).message,
        });
      }
    })();
  });

  // A /run-step holds the connection open for a whole container agent run
  // (minutes). Node's http.Server defaults requestTimeout to 5 min and would
  // abort long steps (reconcile), so disable both timeouts — this is a
  // localhost-only, token-authed endpoint, so slowloris isn't a concern.
  server.requestTimeout = 0;
  server.headersTimeout = 0;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      logger.info({ port, host }, 'Smithers bridge listening');
      resolve(server);
    });
  });
}
