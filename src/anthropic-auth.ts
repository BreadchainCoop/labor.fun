/**
 * Shared Anthropic credential resolution, OAuth token exchange, and upstream
 * auth headers.
 *
 * There are two ways an org can authenticate against Anthropic, and BOTH are
 * used in production:
 *
 *   api-key mode  — `ANTHROPIC_API_KEY` is set. Requests carry `x-api-key`.
 *   OAuth mode    — no API key; a Claude Code OAuth token (`sk-ant-oat…`) is
 *                   set as `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_AUTH_TOKEN`).
 *
 * An OAuth token is NOT accepted by `/v1/messages`. The protocol — the one the
 * Claude CLI speaks and the one the credential proxy has always relayed (see
 * the header block of `credential-proxy.ts` and its OAuth test) — is a two-step
 * exchange:
 *
 *   1. POST `/api/oauth/claude_cli/create_api_key`
 *        headers: `Authorization: Bearer <sk-ant-oat…>`
 *                 `anthropic-beta: oauth-2025-04-20`
 *                 `content-type: application/json`
 *        body:    `{}`
 *        →        `{ "raw_key": "sk-ant-api03-…" }`   (a temporary API key)
 *   2. POST `/v1/messages` with `x-api-key: <raw_key>` — "valid as-is", i.e.
 *      NO `Authorization` header and no OAuth beta.
 *
 * Container traffic performs step 1 itself inside the container (the proxy
 * only swaps the placeholder Bearer for the real OAuth token on the way past —
 * that relay is deliberately untouched here). Host-process callers that hit
 * api.anthropic.com directly (e.g. translate-service) have no CLI to do it for
 * them, so `getAnthropicApiKey()` below is the single implementation of the
 * exchange for them, and the proxy + this module derive the exchange's
 * `Authorization` header from the same `anthropicAuthHeaders()` helper so the
 * two can never drift.
 *
 * Hosted (control-plane provisioned) tenants run in OAuth mode: the control
 * plane deliberately leaves `ANTHROPIC_API_KEY` unset, because the credential
 * proxy selects its auth mode by that variable's presence. Any host-process
 * code path that talks to Anthropic directly MUST go through this module —
 * reading `ANTHROPIC_API_KEY` alone silently disables the feature for every
 * hosted tenant (this is exactly how translation broke), and sending the OAuth
 * token straight to `/v1/messages` 401s on every request.
 *
 * Never log the values returned from here. `AnthropicAuth.token` and the
 * exchanged key are both secrets.
 */
import { createHash } from 'crypto';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AnthropicAuthMode = 'api-key' | 'oauth';

export interface AnthropicAuth {
  mode: AnthropicAuthMode;
  /** The raw credential. SECRET — never log, never serialize. */
  token: string;
}

/** A key that `/v1/messages` accepts as `x-api-key`. SECRET. */
export interface AnthropicApiKey {
  /** SECRET — never log. In OAuth mode this is the exchanged temporary key. */
  key: string;
  /** Which credential it came from (`oauth` = produced by the exchange). */
  mode: AnthropicAuthMode;
}

/** Public Anthropic API origin used for direct host-process calls. */
export const ANTHROPIC_API_BASE = 'https://api.anthropic.com';

/** `anthropic-version` sent on direct Messages API calls. */
export const ANTHROPIC_API_VERSION = '2023-06-01';

/**
 * Beta opt-in sent alongside an OAuth `Authorization: Bearer` token. This is
 * an EXCHANGE-request header (and part of the CLI's own beta list that the
 * proxy relays) — it is NOT sent on `/v1/messages`, which only ever sees the
 * exchanged `x-api-key`.
 */
export const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20';

/**
 * The OAuth token → temporary API key exchange endpoint. Same path the
 * credential proxy relays for container traffic (asserted in
 * credential-proxy.test.ts), so host and container speak one protocol.
 */
export const OAUTH_CREATE_API_KEY_PATH = '/api/oauth/claude_cli/create_api_key';

/** Credential env vars, in the precedence order both auth paths agree on. */
export const ANTHROPIC_CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
] as const;

/**
 * Read config/credential values preferring `process.env`, falling back to
 * `.env`.
 *
 * Hosted Kubernetes tenants receive their credentials as pod env vars (from a
 * Secret via secretKeyRef — see deploy/k8s/tenant-example/deployment.yaml) and
 * have no `.env` file at all. Self-hosted installs keep everything in `.env`.
 * process.env-first covers both and matches the convention used by the Slack
 * channel and container-runner (`process.env.X || env.X`).
 */
export function readSecrets(keys: readonly string[]): Record<string, string> {
  const fromEnvFile = readEnvFile([...keys]);
  const result: Record<string, string> = {};
  for (const key of keys) {
    const v = process.env[key] ?? fromEnvFile[key];
    if (v) result[key] = v;
  }
  return result;
}

/**
 * Resolve the active Anthropic credential, or null when the host has none.
 *
 * API key wins when both are present — same rule the credential proxy uses to
 * pick its mode, so the two can never disagree about which credential is live.
 */
export function resolveAnthropicAuth(): AnthropicAuth | null {
  const secrets = readSecrets(ANTHROPIC_CREDENTIAL_KEYS);
  if (secrets.ANTHROPIC_API_KEY) {
    return { mode: 'api-key', token: secrets.ANTHROPIC_API_KEY };
  }
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;
  if (oauthToken) return { mode: 'oauth', token: oauthToken };
  return null;
}

/** Which auth mode the host is configured for (OAuth is the no-API-key case). */
export function detectAnthropicAuthMode(): AnthropicAuthMode {
  return readSecrets(['ANTHROPIC_API_KEY']).ANTHROPIC_API_KEY
    ? 'api-key'
    : 'oauth';
}

/**
 * The auth headers for an upstream Anthropic request as authenticated by the
 * RAW credential: `x-api-key` for an API key, `Authorization: Bearer` + the
 * OAuth beta for an OAuth token (i.e. the exchange request, and the container
 * traffic the credential proxy relays). Single source of truth for "which
 * header carries the credential".
 *
 * NOTE: for `/v1/messages` in OAuth mode you want `getAnthropicApiKey()` +
 * `anthropicMessagesHeaders()` instead — the Messages API does not accept a
 * Bearer OAuth token.
 */
export function anthropicAuthHeaders(
  auth: AnthropicAuth,
): Record<string, string> {
  if (auth.mode === 'api-key') {
    return { 'x-api-key': auth.token };
  }
  return {
    authorization: `Bearer ${auth.token}`,
    'anthropic-beta': ANTHROPIC_OAUTH_BETA,
  };
}

/**
 * Full header set for a direct JSON call to the Anthropic Messages API.
 * Takes a plain API key — in OAuth mode that is the exchanged temporary key
 * from `getAnthropicApiKey()`, which `/v1/messages` accepts as-is.
 *
 * (The proxy uses `anthropicAuthHeaders` alone — it must NOT overwrite the
 * client's own `anthropic-version` / `anthropic-beta` / content-type.)
 */
export function anthropicMessagesHeaders(
  apiKey: string,
): Record<string, string> {
  return {
    'content-type': 'application/json',
    'anthropic-version': ANTHROPIC_API_VERSION,
    'x-api-key': apiKey,
  };
}

// --- OAuth token → temporary API key exchange (cached) ---

/**
 * How long an exchanged key is reused before a fresh exchange.
 *
 * Anthropic does not publish the temp key's TTL, so this is deliberately
 * conservative: short enough that an expired key is never reused for long,
 * long enough that a busy group's auto-translate traffic performs ONE exchange
 * instead of one per message. Callers additionally invalidate on a 401/403
 * from `/v1/messages` (see `invalidateAnthropicApiKey`), so correctness never
 * depends on this number matching the real TTL.
 */
export const EXCHANGED_KEY_TTL_MS = 10 * 60 * 1000;

/**
 * After a failed exchange, don't retry (and report "degraded") for this long.
 * This is what stops a broken/expired OAuth token from producing one failed
 * upstream call — and one apologetic reply — per inbound message.
 */
export const EXCHANGE_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

const EXCHANGE_TIMEOUT_MS = 15_000;

interface CachedKey {
  key: string;
  expiresAt: number;
}

/**
 * Cache keyed by a fingerprint of the OAuth token (never the token itself), so
 * rotating the credential naturally misses the cache and nothing secret is
 * retained as a map key.
 */
const keyCache = new Map<string, CachedKey>();
/** In-flight exchanges, so concurrent callers share one upstream request. */
const inFlight = new Map<string, Promise<string | null>>();
/** Epoch ms until which the exchange is considered broken. */
let exchangeFailedUntil = 0;

function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/**
 * True when the most recent OAuth exchange failed and we're still inside the
 * cooldown. Callers use this to degrade a feature to its honest
 * "not configured" path instead of failing once per message.
 */
export function isAnthropicOAuthExchangeDegraded(): boolean {
  return Date.now() < exchangeFailedUntil;
}

/** Drop any cached exchanged key for this credential (call on a 401/403). */
export function invalidateAnthropicApiKey(auth: AnthropicAuth): void {
  if (auth.mode !== 'oauth') return;
  keyCache.delete(fingerprint(auth.token));
}

/** Reset all cached exchange state (credential rotation / tests). */
export function resetAnthropicApiKeyCache(): void {
  keyCache.clear();
  inFlight.clear();
  exchangeFailedUntil = 0;
}

interface CreateApiKeyResponse {
  /** The field the CLI exchange returns. */
  raw_key?: string;
  /** Defensive aliases — the endpoint is undocumented. */
  key?: string;
  api_key?: string;
}

/** One exchange round-trip. Returns null on any failure; never throws. */
async function exchangeOAuthToken(token: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${ANTHROPIC_API_BASE}${OAUTH_CREATE_API_KEY_PATH}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...anthropicAuthHeaders({ mode: 'oauth', token }),
        },
        body: '{}',
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      // Status only — never the token, never the response body (which carries
      // the key on success and may echo request details on failure).
      logger.warn(
        { status: res.status },
        'anthropic-auth: OAuth token exchange rejected',
      );
      return null;
    }
    const data = (await res.json()) as CreateApiKeyResponse;
    const key = data.raw_key || data.key || data.api_key;
    if (typeof key !== 'string' || !key) {
      logger.warn(
        { status: res.status },
        'anthropic-auth: OAuth token exchange returned no key',
      );
      return null;
    }
    return key;
  } catch (err) {
    // Error NAME only: a thrown message can embed the request URL/headers, and
    // nothing about this credential may reach the logs.
    logger.warn(
      { err: err instanceof Error ? err.name : 'unknown' },
      'anthropic-auth: OAuth token exchange failed',
    );
    return null;
  }
}

async function getExchangedKey(token: string): Promise<string | null> {
  const id = fingerprint(token);
  const now = Date.now();

  const cached = keyCache.get(id);
  if (cached && cached.expiresAt > now) return cached.key;
  if (cached) keyCache.delete(id);

  // Circuit breaker: a known-bad credential must not produce one upstream
  // call per message.
  if (now < exchangeFailedUntil) return null;

  const pending = inFlight.get(id);
  if (pending) return pending;

  const attempt = exchangeOAuthToken(token)
    .then((key) => {
      if (key) {
        keyCache.set(id, { key, expiresAt: Date.now() + EXCHANGED_KEY_TTL_MS });
        exchangeFailedUntil = 0;
      } else {
        exchangeFailedUntil = Date.now() + EXCHANGE_FAILURE_COOLDOWN_MS;
      }
      return key;
    })
    .finally(() => {
      inFlight.delete(id);
    });

  inFlight.set(id, attempt);
  return attempt;
}

/**
 * Resolve a key usable as `x-api-key` on `/v1/messages`.
 *
 *   api-key mode — returns `ANTHROPIC_API_KEY` directly, no network call.
 *   OAuth mode   — performs (or reuses a cached) `create_api_key` exchange.
 *
 * Returns null when there is no credential at all, or when the OAuth exchange
 * is failing. Callers MUST treat null as "this feature is unavailable" and
 * degrade quietly (see `isAnthropicOAuthExchangeDegraded`) rather than
 * reporting a per-request error.
 */
export async function getAnthropicApiKey(
  auth: AnthropicAuth | null = resolveAnthropicAuth(),
): Promise<AnthropicApiKey | null> {
  if (!auth) return null;
  if (auth.mode === 'api-key') return { key: auth.token, mode: 'api-key' };
  const key = await getExchangedKey(auth.token);
  return key ? { key, mode: 'oauth' } : null;
}
