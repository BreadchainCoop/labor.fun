/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { recordApiUsage } from './db.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { estimateCostUsd } from './model-pricing.js';
import { checkQuota } from './usage-budget.js';

/**
 * Parse the token-usage figures from an Anthropic Messages API response body
 * and record a row in `api_usage`. Handles both non-streaming JSON (a single
 * `{...,"usage":{...}}` object) and SSE streaming (message_start carries the
 * prompt-side counts; message_delta carries the cumulative output tokens).
 *
 * Best-effort and defensive: any parse failure is swallowed (metering must
 * never break the proxy). `runTag` is the x-nanoclaw-run-tag header the
 * orchestrator sets so usage can be attributed to a group/run.
 */
function meterResponse(
  bodyText: string,
  contentType: string | undefined,
  statusCode: number,
  runTag: string | null,
): void {
  try {
    let model: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let sawUsage = false;

    const applyUsage = (u: Record<string, unknown> | undefined): void => {
      if (!u) return;
      sawUsage = true;
      if (typeof u.input_tokens === 'number') inputTokens = u.input_tokens;
      if (typeof u.output_tokens === 'number') outputTokens = u.output_tokens;
      if (typeof u.cache_read_input_tokens === 'number')
        cacheReadTokens = u.cache_read_input_tokens;
      if (typeof u.cache_creation_input_tokens === 'number')
        cacheWriteTokens = u.cache_creation_input_tokens;
    };

    if (contentType && contentType.includes('text/event-stream')) {
      for (const line of bodyText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let evt: Record<string, unknown>;
        try {
          evt = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (evt.type === 'message_start') {
          const msg = evt.message as Record<string, unknown> | undefined;
          if (msg && typeof msg.model === 'string') model = msg.model;
          applyUsage(msg?.usage as Record<string, unknown> | undefined);
        } else if (evt.type === 'message_delta') {
          // message_delta.usage carries cumulative output_tokens (and, on
          // recent APIs, the input-side counts too). Merge without clobbering
          // the prompt-side figures already read from message_start.
          const u = evt.usage as Record<string, unknown> | undefined;
          if (u) {
            sawUsage = true;
            if (typeof u.output_tokens === 'number')
              outputTokens = u.output_tokens;
            if (typeof u.input_tokens === 'number' && u.input_tokens)
              inputTokens = u.input_tokens;
            if (typeof u.cache_read_input_tokens === 'number')
              cacheReadTokens = u.cache_read_input_tokens;
            if (typeof u.cache_creation_input_tokens === 'number')
              cacheWriteTokens = u.cache_creation_input_tokens;
          }
        }
      }
    } else {
      const obj = JSON.parse(bodyText) as Record<string, unknown>;
      if (typeof obj.model === 'string') model = obj.model;
      applyUsage(obj.usage as Record<string, unknown> | undefined);
    }

    if (!sawUsage) return;

    const estCostUsd = estimateCostUsd({
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    });
    recordApiUsage({
      runTag,
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      estCostUsd,
      statusCode,
    });
  } catch (err) {
    logger.warn({ err }, 'Usage metering failed (ignored)');
  }
}

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);

        // Attribute usage to a group/run if the orchestrator tagged it.
        const runTagHeader = req.headers['x-nanoclaw-run-tag'];
        const runTag = Array.isArray(runTagHeader)
          ? (runTagHeader[0] ?? null)
          : (runTagHeader ?? null);

        // Quota gate: only Messages API inference requests count against the
        // budget / entitlement. Auth probes and the OAuth key-exchange pass
        // through untouched. Fail-open lives inside checkQuota().
        const isInference =
          req.method === 'POST' &&
          typeof req.url === 'string' &&
          req.url.includes('/v1/messages');
        if (isInference) {
          const quota = checkQuota();
          if (!quota.ok) {
            logger.warn(
              { reason: quota.reason, state: quota.state },
              'Blocking API request — usage quota / entitlement',
            );
            res.writeHead(429, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                type: 'error',
                error: {
                  type: 'rate_limit_error',
                  message: quota.reason ?? 'Usage quota exceeded.',
                },
              }),
            );
            return;
          }
        }

        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };
        // Internal attribution header — never forward it upstream.
        delete headers['x-nanoclaw-run-tag'];

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            // Tee the upstream response: stream it to the client unchanged
            // while buffering a copy to parse token usage. Only meter the
            // Messages API inference path; caps the buffer to avoid holding
            // huge non-inference responses in memory.
            if (isInference) {
              const respChunks: Buffer[] = [];
              let buffered = 0;
              const MAX_METER_BYTES = 8 * 1024 * 1024;
              upRes.on('data', (c: Buffer) => {
                res.write(c);
                if (buffered < MAX_METER_BYTES) {
                  respChunks.push(c);
                  buffered += c.length;
                }
              });
              upRes.on('end', () => {
                res.end();
                meterResponse(
                  Buffer.concat(respChunks).toString('utf-8'),
                  upRes.headers['content-type'] as string | undefined,
                  upRes.statusCode ?? 0,
                  runTag,
                );
              });
              upRes.on('error', () => res.end());
            } else {
              upRes.pipe(res);
            }
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
