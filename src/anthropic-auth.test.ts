import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ANTHROPIC_API_BASE,
  ANTHROPIC_API_VERSION,
  ANTHROPIC_OAUTH_BETA,
  EXCHANGED_KEY_TTL_MS,
  EXCHANGE_FAILURE_COOLDOWN_MS,
  OAUTH_CREATE_API_KEY_PATH,
  anthropicAuthHeaders,
  anthropicMessagesHeaders,
  detectAnthropicAuthMode,
  getAnthropicApiKey,
  invalidateAnthropicApiKey,
  isAnthropicOAuthExchangeDegraded,
  resetAnthropicApiKeyCache,
  resolveAnthropicAuth,
} from './anthropic-auth.js';
import { logger } from './logger.js';

const CRED_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
] as const;

/**
 * Stub every credential to '' rather than deleting it: readSecrets uses
 * `process.env[k] ?? fromEnvFile[k]`, so a non-nullish '' also suppresses the
 * .env fallback — a developer's real .env can't leak into these assertions.
 */
function clearCredentials() {
  for (const key of CRED_KEYS) vi.stubEnv(key, '');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveAnthropicAuth', () => {
  it('returns api-key mode when ANTHROPIC_API_KEY is set', () => {
    clearCredentials();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api-1');
    expect(resolveAnthropicAuth()).toEqual({
      mode: 'api-key',
      token: 'sk-ant-api-1',
    });
    expect(detectAnthropicAuthMode()).toBe('api-key');
  });

  it('returns oauth mode from CLAUDE_CODE_OAUTH_TOKEN when no api key is set', () => {
    clearCredentials();
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-x');
    expect(resolveAnthropicAuth()).toEqual({
      mode: 'oauth',
      token: 'sk-ant-oat01-x',
    });
    expect(detectAnthropicAuthMode()).toBe('oauth');
  });

  it('accepts ANTHROPIC_AUTH_TOKEN as the OAuth credential', () => {
    clearCredentials();
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-ant-oat01-alt');
    expect(resolveAnthropicAuth()).toEqual({
      mode: 'oauth',
      token: 'sk-ant-oat01-alt',
    });
  });

  it('prefers CLAUDE_CODE_OAUTH_TOKEN over ANTHROPIC_AUTH_TOKEN', () => {
    clearCredentials();
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'primary');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'secondary');
    expect(resolveAnthropicAuth()?.token).toBe('primary');
  });

  it('api key wins over an OAuth token (matches the proxy mode rule)', () => {
    clearCredentials();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api-1');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-x');
    expect(resolveAnthropicAuth()).toEqual({
      mode: 'api-key',
      token: 'sk-ant-api-1',
    });
  });

  it('returns null when no credential is present', () => {
    clearCredentials();
    expect(resolveAnthropicAuth()).toBeNull();
    // No credential still reports OAuth mode — the proxy's long-standing
    // "absence of an API key means OAuth" contract.
    expect(detectAnthropicAuthMode()).toBe('oauth');
  });
});

describe('anthropicAuthHeaders', () => {
  it('uses x-api-key in api-key mode and nothing else', () => {
    expect(
      anthropicAuthHeaders({ mode: 'api-key', token: 'sk-ant-api-1' }),
    ).toEqual({ 'x-api-key': 'sk-ant-api-1' });
  });

  it('uses Bearer + the oauth beta in OAuth mode, never x-api-key', () => {
    const headers = anthropicAuthHeaders({
      mode: 'oauth',
      token: 'sk-ant-oat01-x',
    });
    expect(headers).toEqual({
      authorization: 'Bearer sk-ant-oat01-x',
      'anthropic-beta': ANTHROPIC_OAUTH_BETA,
    });
    expect(headers['x-api-key']).toBeUndefined();
  });
});

describe('anthropicMessagesHeaders', () => {
  it('always authenticates /v1/messages with x-api-key, never a Bearer token', () => {
    // The Messages API does not accept an OAuth token; in OAuth mode the key
    // passed here is the exchanged temporary one.
    expect(anthropicMessagesHeaders('sk-ant-api03-exchanged')).toEqual({
      'content-type': 'application/json',
      'anthropic-version': ANTHROPIC_API_VERSION,
      'x-api-key': 'sk-ant-api03-exchanged',
    });
  });
});

// --- OAuth token → temporary API key exchange ---
//
// The protocol under test is the one the credential proxy has always relayed
// for container traffic (credential-proxy.ts header block + its OAuth test):
// POST /api/oauth/claude_cli/create_api_key authenticated with the Bearer
// OAuth token, returning a temp API key used as x-api-key afterwards.

describe('getAnthropicApiKey', () => {
  const OAUTH: { mode: 'oauth'; token: string } = {
    mode: 'oauth',
    token: 'sk-ant-oat01-secret',
  };

  function mockExchange(key = 'sk-ant-api03-temp') {
    return vi.fn(
      async () =>
        new Response(JSON.stringify({ raw_key: key }), { status: 200 }),
    );
  }

  beforeEach(() => {
    resetAnthropicApiKeyCache();
  });

  afterEach(() => {
    resetAnthropicApiKeyCache();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('api-key mode returns the key directly and performs NO exchange', async () => {
    const fetchMock = mockExchange();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getAnthropicApiKey({ mode: 'api-key', token: 'sk-ant-api-1' }),
    ).resolves.toEqual({ key: 'sk-ant-api-1', mode: 'api-key' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('OAuth mode POSTs the create_api_key exchange with the Bearer token', async () => {
    const fetchMock = mockExchange('sk-ant-api03-temp');
    vi.stubGlobal('fetch', fetchMock);

    await expect(getAnthropicApiKey(OAUTH)).resolves.toEqual({
      key: 'sk-ant-api03-temp',
      mode: 'oauth',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${ANTHROPIC_API_BASE}${OAUTH_CREATE_API_KEY_PATH}`);
    expect(url).toBe(
      'https://api.anthropic.com/api/oauth/claude_cli/create_api_key',
    );
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk-ant-oat01-secret');
    expect(headers['anthropic-beta']).toBe(ANTHROPIC_OAUTH_BETA);
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('caches the exchanged key: a second call does not re-exchange', async () => {
    const fetchMock = mockExchange();
    vi.stubGlobal('fetch', fetchMock);

    await getAnthropicApiKey(OAUTH);
    await getAnthropicApiKey(OAUTH);
    await getAnthropicApiKey(OAUTH);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('concurrent callers share a single in-flight exchange', async () => {
    const fetchMock = mockExchange();
    vi.stubGlobal('fetch', fetchMock);

    const results = await Promise.all([
      getAnthropicApiKey(OAUTH),
      getAnthropicApiKey(OAUTH),
      getAnthropicApiKey(OAUTH),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r?.key).toBe('sk-ant-api03-temp');
  });

  it('re-exchanges once the cached key expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    let n = 0;
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ raw_key: `temp-${++n}` }), {
          status: 200,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect((await getAnthropicApiKey(OAUTH))?.key).toBe('temp-1');

    vi.setSystemTime(Date.now() + EXCHANGED_KEY_TTL_MS - 1000);
    expect((await getAnthropicApiKey(OAUTH))?.key).toBe('temp-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 2000);
    expect((await getAnthropicApiKey(OAUTH))?.key).toBe('temp-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('invalidateAnthropicApiKey forces a fresh exchange (stale temp key)', async () => {
    let n = 0;
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ raw_key: `temp-${++n}` }), {
          status: 200,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect((await getAnthropicApiKey(OAUTH))?.key).toBe('temp-1');
    invalidateAnthropicApiKey(OAUTH);
    expect((await getAnthropicApiKey(OAUTH))?.key).toBe('temp-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a rotated OAuth token is not served from the old cache entry', async () => {
    let n = 0;
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ raw_key: `temp-${++n}` }), {
          status: 200,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect((await getAnthropicApiKey(OAUTH))?.key).toBe('temp-1');
    expect(
      (await getAnthropicApiKey({ mode: 'oauth', token: 'rotated' }))?.key,
    ).toBe('temp-2');
  });

  it('a failing exchange returns null, marks degraded, and does not retry per call', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await getAnthropicApiKey(OAUTH)).toBeNull();
    expect(isAnthropicOAuthExchangeDegraded()).toBe(true);

    // 20 further attempts inside the cooldown must not touch the network.
    for (let i = 0; i < 20; i++) {
      expect(await getAnthropicApiKey(OAUTH)).toBeNull();
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries the exchange after the failure cooldown elapses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fetchMock = vi.fn(async () => new Response('nope', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await getAnthropicApiKey(OAUTH)).toBeNull();
    vi.setSystemTime(Date.now() + EXCHANGE_FAILURE_COOLDOWN_MS + 1000);
    expect(isAnthropicOAuthExchangeDegraded()).toBe(false);
    expect(await getAnthropicApiKey(OAUTH)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats a network error and a keyless 200 body as failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    expect(await getAnthropicApiKey(OAUTH)).toBeNull();

    resetAnthropicApiKeyCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    );
    expect(await getAnthropicApiKey(OAUTH)).toBeNull();
  });

  it('never logs the OAuth token or the exchanged key', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    // Success path.
    vi.stubGlobal('fetch', mockExchange('sk-ant-api03-supersecret'));
    await getAnthropicApiKey(OAUTH);

    // Failure path (body echoes the token — must not be logged either).
    resetAnthropicApiKeyCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'sk-ant-oat01-secret' }), {
            status: 401,
          }),
      ),
    );
    await getAnthropicApiKey(OAUTH);

    // Network-error path (message carries the URL + token).
    resetAnthropicApiKeyCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect failed for sk-ant-oat01-secret');
      }),
    );
    await getAnthropicApiKey(OAUTH);

    const logged = JSON.stringify([
      ...warn.mock.calls,
      ...info.mock.calls,
      ...debug.mock.calls,
    ]);
    expect(logged).not.toContain('sk-ant-oat01-secret');
    expect(logged).not.toContain('sk-ant-api03-supersecret');
    expect(logged).not.toContain('Bearer');
  });

  it('returns null when no credential is configured at all', async () => {
    const fetchMock = mockExchange();
    vi.stubGlobal('fetch', fetchMock);
    expect(await getAnthropicApiKey(null)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
