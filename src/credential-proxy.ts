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
 *
 * Usage metering + budget enforcement (OSS "API cost tracking & budgets"):
 * optional `hooks` let a caller observe token usage per run and gate
 * requests against a quota BEFORE they're forwarded upstream. With no hooks
 * passed, behavior is byte-identical to the base proxy.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

/** One captured usage event, parsed from a proxied /v1/messages response. */
export interface UsageEvent {
  /** Run identifier decoded from the container's placeholder x-api-key, if present. */
  runTag: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  statusCode: number;
  requestPath: string;
}

export type QuotaResult = { ok: true } | { ok: false; reason: string };

export interface ProxyHooks {
  /** Called once per completed /v1/messages request/response with parsed usage. */
  onUsage?: (usage: UsageEvent) => void;
  /**
   * Called before forwarding any /v1/messages request. Returning
   * `{ok:false}` short-circuits the request with a 429 instead of
   * forwarding it upstream.
   */
  checkQuota?: (info: { runTag: string | null; url: string }) => QuotaResult;
}

// Placeholder x-api-key format, produced by container-runner.ts:
//   placeholder-<runTag>                       (no proxy auth token configured)
//   placeholder.<authToken>.<runTag>            (CREDENTIAL_PROXY_AUTH_TOKEN set)
// '.' is the separator in the authed form because it cannot appear in a
// Docker container name (mount/host-safe charset is [a-zA-Z0-9_.-], and '.'
// specifically is excluded by the sanitization in container-runner.ts's
// safeName, so it can never collide with a real runTag).
const PLACEHOLDER_PREFIX = 'placeholder';

/** Parse the inbound placeholder x-api-key into its auth token (if any) and runTag. */
function parsePlaceholderApiKey(value: string | undefined): {
  authToken: string | null;
  runTag: string | null;
} {
  if (!value || !value.startsWith(PLACEHOLDER_PREFIX)) {
    return { authToken: null, runTag: null };
  }
  const rest = value.slice(PLACEHOLDER_PREFIX.length);
  if (rest.startsWith('.')) {
    // placeholder.<authToken>.<runTag>
    const parts = rest.slice(1).split('.');
    if (parts.length >= 2) {
      const authToken = parts[0];
      const runTag = parts.slice(1).join('.');
      return { authToken, runTag: runTag || null };
    }
    return { authToken: null, runTag: null };
  }
  if (rest.startsWith('-')) {
    // placeholder-<runTag>
    const runTag = rest.slice(1);
    return { authToken: null, runTag: runTag || null };
  }
  return { authToken: null, runTag: null };
}

// Cap how much of a proxied response body we buffer for usage parsing, to
// avoid pathological memory use on huge/streaming responses. Parsing simply
// stops once this many bytes have been accumulated; the client-facing stream
// is never affected (it's piped independently of this buffer).
const USAGE_PARSE_BUFFER_CAP = 20 * 1024 * 1024; // 20MB

interface NonStreamingUsageBody {
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/** Parse usage out of a buffered /v1/messages response body (SSE or JSON). */
function parseUsageFromBody(
  body: string,
  contentType: string | undefined,
): {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} | null {
  const isSse =
    (contentType || '').includes('text/event-stream') ||
    body.trimStart().startsWith('event:');

  if (isSse) {
    let model: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let sawUsage = false;

    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const jsonStr = line.slice('data:'.length).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;
      let evt: {
        type?: string;
        message?: {
          model?: string;
          usage?: NonStreamingUsageBody['usage'];
        };
        usage?: { output_tokens?: number };
      };
      try {
        evt = JSON.parse(jsonStr);
      } catch {
        continue;
      }
      if (evt.type === 'message_start' && evt.message) {
        sawUsage = true;
        model = evt.message.model ?? model;
        const u = evt.message.usage;
        if (u) {
          inputTokens += u.input_tokens ?? 0;
          cacheReadTokens += u.cache_read_input_tokens ?? 0;
          cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
        }
      } else if (evt.type === 'message_delta' && evt.usage) {
        sawUsage = true;
        // output_tokens in message_delta is cumulative for the message —
        // take the latest value rather than summing across delta events.
        outputTokens = evt.usage.output_tokens ?? outputTokens;
      }
    }
    if (!sawUsage) return null;
    return {
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    };
  }

  // Non-streaming JSON response
  let parsed: NonStreamingUsageBody;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed.usage) return null;
  return {
    model: parsed.model ?? null,
    inputTokens: parsed.usage.input_tokens ?? 0,
    outputTokens: parsed.usage.output_tokens ?? 0,
    cacheReadTokens: parsed.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: parsed.usage.cache_creation_input_tokens ?? 0,
  };
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
  hooks: ProxyHooks = {},
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CREDENTIAL_PROXY_AUTH_TOKEN',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;
  const proxyAuthToken = secrets.CREDENTIAL_PROXY_AUTH_TOKEN || undefined;

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
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        // Strip accept-encoding so the upstream responds uncompressed —
        // required to parse usage out of the response body below. Only
        // matters for API-key mode requests (x-api-key), which is where
        // usage capture happens; harmless to strip unconditionally.
        delete headers['accept-encoding'];

        const requestPath = req.url || '';
        const isMessagesRequest = requestPath.startsWith('/v1/messages');

        let runTag: string | null = null;

        if (authMode === 'api-key') {
          // Capture the inbound placeholder BEFORE replacing it, so we can
          // attribute usage to the run that made the request and (if
          // CREDENTIAL_PROXY_AUTH_TOKEN is set) verify the caller is
          // authorized to use this proxy.
          const inbound = parsePlaceholderApiKey(
            headers['x-api-key'] as string | undefined,
          );
          runTag = inbound.runTag;

          if (proxyAuthToken && inbound.authToken !== proxyAuthToken) {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                type: 'error',
                error: {
                  type: 'authentication_error',
                  message: 'Invalid or missing credential proxy auth token',
                },
              }),
            );
            return;
          }

          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          //
          // Run attribution and CREDENTIAL_PROXY_AUTH_TOKEN enforcement are
          // intentionally skipped in OAuth mode: the exchange request
          // carries the placeholder in `authorization`, not `x-api-key`, and
          // post-exchange requests carry a temp key issued by Anthropic
          // (not our placeholder), so there's no placeholder value left to
          // decode a runTag or auth token from at proxy time.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        if (isMessagesRequest && hooks.checkQuota) {
          const result = hooks.checkQuota({ runTag, url: requestPath });
          if (!result.ok) {
            res.writeHead(429, {
              'content-type': 'application/json',
              'retry-after': '3600',
            });
            res.end(
              JSON.stringify({
                type: 'error',
                error: {
                  type: 'rate_limit_error',
                  message: result.reason,
                },
              }),
            );
            return;
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

            if (!isMessagesRequest || !hooks.onUsage) {
              upRes.pipe(res);
              return;
            }

            // Tee: stream unmodified to the client, while separately
            // accumulating a capped copy to parse usage from once the
            // response ends.
            const usageChunks: Buffer[] = [];
            let usageBufSize = 0;
            let capped = false;

            upRes.on('data', (chunk: Buffer) => {
              res.write(chunk);
              if (!capped) {
                if (usageBufSize + chunk.length > USAGE_PARSE_BUFFER_CAP) {
                  capped = true;
                } else {
                  usageChunks.push(chunk);
                  usageBufSize += chunk.length;
                }
              }
            });

            upRes.on('end', () => {
              res.end();
              try {
                const bodyStr = Buffer.concat(usageChunks).toString('utf-8');
                const parsedUsage = parseUsageFromBody(
                  bodyStr,
                  upRes.headers['content-type'],
                );
                if (parsedUsage) {
                  hooks.onUsage!({
                    runTag,
                    model: parsedUsage.model,
                    inputTokens: parsedUsage.inputTokens,
                    outputTokens: parsedUsage.outputTokens,
                    cacheReadTokens: parsedUsage.cacheReadTokens,
                    cacheWriteTokens: parsedUsage.cacheWriteTokens,
                    statusCode: upRes.statusCode || 0,
                    requestPath,
                  });
                }
              } catch (err) {
                logger.debug(
                  { err, url: req.url },
                  'Failed to parse usage from proxied response',
                );
              }
            });

            upRes.on('error', (err) => {
              logger.debug(
                { err, url: req.url },
                'Upstream response stream error during usage capture',
              );
            });
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
