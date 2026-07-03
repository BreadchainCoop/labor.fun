import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { startCredentialProxy } from './credential-proxy.js';

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('credential-proxy', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;

  beforeEach(async () => {
    lastUpstreamHeaders = {};

    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function startProxy(env: Record<string, string>): Promise<number> {
    Object.assign(mockEnv, env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    return (proxyServer.address() as AddressInfo).port;
  }

  it('API-key mode injects x-api-key and strips placeholder', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
  });

  it('OAuth mode replaces Authorization when container sends one', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer real-oauth-token',
    );
  });

  it('OAuth mode does not inject Authorization when container omits it', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    // Post-exchange: container uses x-api-key only, no Authorization header
    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'temp-key-from-exchange',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('temp-key-from-exchange');
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });

  it('strips hop-by-hop headers', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
        },
      },
      '{}',
    );

    // Proxy strips client hop-by-hop headers. Node's HTTP client may re-add
    // its own Connection header (standard HTTP/1.1 behavior), but the client's
    // custom keep-alive and transfer-encoding must not be forwarded.
    expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
    expect(lastUpstreamHeaders['transfer-encoding']).toBeUndefined();
  });

  it('returns 502 when upstream is unreachable', async () => {
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:59999',
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('Bad Gateway');
  });

  it('strips accept-encoding so usage parsing sees uncompressed bodies', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'accept-encoding': 'gzip, deflate, br',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['accept-encoding']).toBeUndefined();
  });

  it('passthrough is unchanged with no hooks (no onUsage/checkQuota called)', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder-nanoclaw-main-123',
        },
      },
      '{}',
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });
});

describe('credential-proxy usage metering', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let upstreamHandler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => void;

  beforeEach(async () => {
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    };
    upstreamServer = http.createServer((req, res) => upstreamHandler(req, res));
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function startProxy(
    env: Record<string, string>,
    hooks: Parameters<typeof startCredentialProxy>[2] = {},
  ): Promise<number> {
    Object.assign(mockEnv, env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0, '127.0.0.1', hooks);
    return (proxyServer.address() as AddressInfo).port;
  }

  it('parses usage from a non-streaming JSON response and attributes runTag', async () => {
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'claude-sonnet-5-20260201',
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 5,
          },
        }),
      );
    };

    const onUsage = vi.fn();
    proxyPort = await startProxy(
      { ANTHROPIC_API_KEY: 'sk-ant-real-key' },
      { onUsage },
    );

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder-nanoclaw-main-123',
        },
      },
      '{}',
    );

    // onUsage fires asynchronously after the response ends — wait a tick.
    await new Promise((r) => setTimeout(r, 20));

    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        runTag: 'nanoclaw-main-123',
        model: 'claude-sonnet-5-20260201',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 5,
        cacheWriteTokens: 10,
        statusCode: 200,
        requestPath: '/v1/messages',
      }),
    );
  });

  it('parses usage from a streaming SSE response', async () => {
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: 'message_start',
          message: {
            model: 'claude-opus-4-6',
            usage: {
              input_tokens: 200,
              cache_creation_input_tokens: 20,
              cache_read_input_tokens: 15,
            },
          },
        })}\n\n`,
      );
      res.write(
        `event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          usage: { output_tokens: 75 },
        })}\n\n`,
      );
      res.end();
    };

    const onUsage = vi.fn();
    proxyPort = await startProxy(
      { ANTHROPIC_API_KEY: 'sk-ant-real-key' },
      { onUsage },
    );

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder-nanoclaw-worker-456',
        },
      },
      '{}',
    );

    await new Promise((r) => setTimeout(r, 20));

    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        runTag: 'nanoclaw-worker-456',
        model: 'claude-opus-4-6',
        inputTokens: 200,
        outputTokens: 75,
        cacheReadTokens: 15,
        cacheWriteTokens: 20,
      }),
    );
  });

  it('never breaks the proxied stream when usage parsing throws', async () => {
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('not valid json{{{');
    };

    const onUsage = vi.fn();
    proxyPort = await startProxy(
      { ANTHROPIC_API_KEY: 'sk-ant-real-key' },
      { onUsage },
    );

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('not valid json{{{');
    await new Promise((r) => setTimeout(r, 20));
    expect(onUsage).not.toHaveBeenCalled();
  });

  it('returns a 429 with Anthropic-shaped body when checkQuota rejects', async () => {
    const checkQuota = vi.fn(() => ({
      ok: false as const,
      reason: 'over budget',
    }));
    proxyPort = await startProxy(
      { ANTHROPIC_API_KEY: 'sk-ant-real-key' },
      { checkQuota },
    );

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('3600');
    expect(JSON.parse(res.body)).toEqual({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'over budget' },
    });
  });

  it('checkQuota allows requests through when ok', async () => {
    const checkQuota = vi.fn(() => ({ ok: true as const }));
    proxyPort = await startProxy(
      { ANTHROPIC_API_KEY: 'sk-ant-real-key' },
      { checkQuota },
    );

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(200);
    expect(checkQuota).toHaveBeenCalledTimes(1);
  });

  it('does not call checkQuota for non-/v1/messages paths', async () => {
    const checkQuota = vi.fn(() => ({ ok: true as const }));
    proxyPort = await startProxy(
      { ANTHROPIC_API_KEY: 'sk-ant-real-key' },
      { checkQuota },
    );

    await makeRequest(
      proxyPort,
      {
        method: 'GET',
        path: '/v1/models',
        headers: { 'content-type': 'application/json' },
      },
      '',
    );

    expect(checkQuota).not.toHaveBeenCalled();
  });

  it('accepts a matching CREDENTIAL_PROXY_AUTH_TOKEN placeholder', async () => {
    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      CREDENTIAL_PROXY_AUTH_TOKEN: 'secret-token',
    });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder.secret-token.nanoclaw-main-999',
        },
      },
      '{}',
    );

    expect(res.statusCode).toBe(200);
  });

  it('rejects a non-matching CREDENTIAL_PROXY_AUTH_TOKEN placeholder with 401', async () => {
    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      CREDENTIAL_PROXY_AUTH_TOKEN: 'secret-token',
    });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder.wrong-token.nanoclaw-main-999',
        },
      },
      '{}',
    );

    expect(res.statusCode).toBe(401);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.type).toBe('authentication_error');
  });

  it('rejects a request with no placeholder at all when auth token is configured', async () => {
    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      CREDENTIAL_PROXY_AUTH_TOKEN: 'secret-token',
    });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(401);
  });
});
