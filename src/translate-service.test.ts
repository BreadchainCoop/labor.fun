import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ANTHROPIC_API_BASE,
  OAUTH_CREATE_API_KEY_PATH,
  resetAnthropicApiKeyCache,
} from './anthropic-auth.js';
import { logger } from './logger.js';
import {
  ALL_LANGUAGES,
  casualLanguageHints,
  detectLanguage,
  displayPair,
  formatLanguageList,
  formatTranslationReply,
  isTranslationConfigured,
  isTranslationReply,
  normalizeForPair,
  resolveLanguage,
  resolvePairForText,
  resolveTranslateProvider,
  selectTranslateProvider,
  targetForSource,
  textLanguageCandidates,
  translateText,
  translateWith,
} from './translate-service.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  // The OAuth exchange cache / degrade breaker is module state shared by every
  // test in this file — reset so ordering can never leak.
  resetAnthropicApiKeyCache();
});

// --- Language catalog (port of translate_lang.rs tests) ---

describe('resolveLanguage', () => {
  it('resolves ISO codes', () => {
    const lang = resolveLanguage('es');
    expect(lang?.code).toBe('es');
    expect(lang?.flag).toBe('🇪🇸');
  });

  it('resolves common names and native aliases', () => {
    expect(resolveLanguage('Spanish')?.code).toBe('es');
    expect(resolveLanguage('español')?.code).toBe('es');
    expect(resolveLanguage('Deutsch')?.code).toBe('de');
  });

  it('returns undefined for unknown languages', () => {
    expect(resolveLanguage('klingon')).toBeUndefined();
    expect(resolveLanguage('')).toBeUndefined();
  });

  it('catalog covers the 30 supported languages', () => {
    expect(ALL_LANGUAGES).toHaveLength(30);
    expect(ALL_LANGUAGES[0]).toEqual({
      code: 'en',
      name: 'English',
      flag: '🇺🇸',
    });
  });
});

describe('formatLanguageList', () => {
  it('renders sorted "flag code — name" lines', () => {
    const list = formatLanguageList();
    expect(list).toContain('🇪🇸 es — Spanish');
    expect(list).toContain('🇺🇸 en — English');
    expect(list.split('\n')).toHaveLength(ALL_LANGUAGES.length);
    const lines = list.split('\n');
    expect([...lines].sort()).toEqual(lines);
  });
});

// --- Detection heuristics (port of translate_service.rs tests) ---

describe('language detection', () => {
  it('detects english text', () => {
    expect(detectLanguage('Is anyone going to the meetup?')).toBe('en');
  });

  it('returns null below the confidence threshold', () => {
    expect(detectLanguage('ok')).toBeNull();
  });

  it('collects EN casual-marker hints for short snippets', () => {
    expect(casualLanguageHints('hello, how are you doing?')).toContain('en');
    expect(casualLanguageHints('How was your day?')).toContain('en');
  });

  it('collects ES casual-marker hints for short snippets', () => {
    expect(casualLanguageHints('Como está?')).toContain('es');
    expect(casualLanguageHints('¿Qué tal?')).toContain('es');
    expect(casualLanguageHints('hola amigos')).toContain('es');
  });

  it('candidate list is ordered and deduped', () => {
    const candidates = textLanguageCandidates('hello, how are you doing?');
    expect(candidates[0]).toBe('en');
    expect(new Set(candidates).size).toBe(candidates.length);
  });
});

// --- Pair resolution (port of GroupTranslateMode + normalization tests) ---

const ES_EN = { langA: 'es', langB: 'en' };

describe('targetForSource', () => {
  it('swaps the pair', () => {
    expect(targetForSource(ES_EN, 'es')?.code).toBe('en');
    expect(targetForSource(ES_EN, 'en')?.code).toBe('es');
    expect(targetForSource(ES_EN, 'fr')).toBeUndefined();
  });
});

describe('normalizeForPair', () => {
  it('maps pt/ca/gl to es when es is in the pair', () => {
    expect(normalizeForPair(ES_EN, 'pt')).toBe('es');
    expect(normalizeForPair(ES_EN, 'ca')).toBe('es');
    expect(normalizeForPair(ES_EN, 'gl')).toBe('es');
  });

  it('does not map pt when es is not in the pair', () => {
    expect(normalizeForPair({ langA: 'fr', langB: 'en' }, 'pt')).toBeNull();
  });

  it('passes through codes already in the pair', () => {
    expect(normalizeForPair(ES_EN, 'EN')).toBe('en');
    expect(normalizeForPair(ES_EN, 'es')).toBe('es');
  });
});

describe('resolvePairForText', () => {
  it('resolves casual english in an es/en pair', () => {
    const pair = resolvePairForText(ES_EN, 'hello, how are you doing?');
    expect(pair?.source.code).toBe('en');
    expect(pair?.target.code).toBe('es');
  });

  it('resolves spanish-ish (detected as portuguese) to es → en', () => {
    const pair = resolvePairForText(ES_EN, 'Como foi tu dia?');
    expect(pair?.source.code).toBe('es');
    expect(pair?.target.code).toBe('en');
  });

  it('returns null when the language is not in the pair', () => {
    expect(
      resolvePairForText(
        { langA: 'de', langB: 'fr' },
        'Is anyone going to the meetup?',
      ),
    ).toBeNull();
  });
});

describe('formatting helpers', () => {
  it('formats the auto-translate reply as "<flag> <translation>"', () => {
    const en = resolveLanguage('en')!;
    expect(formatTranslationReply(en, ' Hello ')).toBe('🇺🇸 Hello');
  });

  it('recognizes translation replies (loop guard)', () => {
    expect(isTranslationReply('🇺🇸 Hello')).toBe(true);
    expect(isTranslationReply('Hello there')).toBe(false);
  });

  it('renders the pair label', () => {
    expect(displayPair(ES_EN)).toBe('🇪🇸 Spanish ↔ 🇺🇸 English');
  });
});

// --- Provider selection + wire calls ---

describe('selectTranslateProvider', () => {
  it('prefers the OpenAI-compatible endpoint when the local backend is active', () => {
    const provider = selectTranslateProvider({
      backend: 'local',
      localBaseUrl: 'https://cloud-api.near.ai/v1',
      localApiKey: 'near-key',
      localModel: 'deepseek-ai/DeepSeek-V3.1',
      anthropicAuth: { mode: 'api-key', token: 'sk-ant-unused' },
    });
    expect(provider).toEqual({
      kind: 'openai-compatible',
      baseUrl: 'https://cloud-api.near.ai/v1',
      apiKey: 'near-key',
      model: 'deepseek-ai/DeepSeek-V3.1',
    });
  });

  it('falls back to Anthropic when the claude backend has an api key', () => {
    const provider = selectTranslateProvider({
      backend: 'claude',
      localBaseUrl: 'http://host.docker.internal:1234/v1',
      anthropicAuth: { mode: 'api-key', token: 'sk-ant-123' },
    });
    expect(provider).toEqual({
      kind: 'anthropic',
      auth: { mode: 'api-key', token: 'sk-ant-123' },
    });
  });

  it('falls back to Anthropic when the claude backend has only an OAuth token', () => {
    const provider = selectTranslateProvider({
      backend: 'claude',
      localBaseUrl: 'http://host.docker.internal:1234/v1',
      anthropicAuth: { mode: 'oauth', token: 'sk-ant-oat01-abc' },
    });
    expect(provider).toEqual({
      kind: 'anthropic',
      auth: { mode: 'oauth', token: 'sk-ant-oat01-abc' },
    });
  });

  it('returns null when neither is configured', () => {
    expect(
      selectTranslateProvider({
        backend: 'claude',
        localBaseUrl: 'http://host.docker.internal:1234/v1',
        anthropicAuth: null,
      }),
    ).toBeNull();
  });
});

// isTranslationConfigured() reads live env; these lock in that BOTH hosted
// credential shapes count as configured (the hosted-tenant regression: the
// control plane sets CLAUDE_CODE_OAUTH_TOKEN and leaves ANTHROPIC_API_KEY
// unset, which used to read as "translation not configured").
describe('isTranslationConfigured', () => {
  const CRED_KEYS = [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
  ] as const;

  function clearCredentials() {
    // Stubbing to '' (not deleting) also neutralizes the .env fallback:
    // readSecrets uses `process.env[k] ?? fromEnvFile[k]`, and '' is not
    // nullish, so a developer's real .env can never leak into these asserts.
    for (const key of CRED_KEYS) vi.stubEnv(key, '');
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is true in api-key mode', () => {
    clearCredentials();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api-123');
    expect(isTranslationConfigured()).toBe(true);
    expect(resolveTranslateProvider()).toEqual({
      kind: 'anthropic',
      auth: { mode: 'api-key', token: 'sk-ant-api-123' },
    });
  });

  it('is true in OAuth mode (hosted tenants: no ANTHROPIC_API_KEY)', () => {
    clearCredentials();
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-hosted');
    expect(isTranslationConfigured()).toBe(true);
    expect(resolveTranslateProvider()).toEqual({
      kind: 'anthropic',
      auth: { mode: 'oauth', token: 'sk-ant-oat01-hosted' },
    });
  });

  it('accepts ANTHROPIC_AUTH_TOKEN as an OAuth credential', () => {
    clearCredentials();
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-ant-oat01-alt');
    expect(isTranslationConfigured()).toBe(true);
  });

  it('is false when no credential is present', () => {
    clearCredentials();
    expect(isTranslationConfigured()).toBe(false);
    expect(resolveTranslateProvider()).toBeNull();
  });
});

describe('translateWith', () => {
  const es = resolveLanguage('es')!;

  it('calls the OpenAI-compatible chat/completions endpoint with the ported prompt', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: ' Hola mundo ' } }],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await translateWith(
      {
        kind: 'openai-compatible',
        baseUrl: 'https://cloud-api.near.ai/v1/',
        apiKey: 'near-key',
        model: 'test-model',
      },
      'Hello world',
      es,
    );

    expect(result).toBe('Hola mundo');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://cloud-api.near.ai/v1/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body.temperature).toBe(0.3);
    expect(body.model).toBe('test-model');
    expect(body.messages[0]).toEqual({
      role: 'system',
      content:
        'You are a professional translator. Output only the translated text.',
    });
    expect(body.messages[1].content).toContain(
      'Translate the following text to Spanish. Return only the translation, with no explanation or quotes.\n\nHello world',
    );
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer near-key',
    );
  });

  it('calls the Anthropic Messages API with the haiku model (api-key mode)', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ content: [{ type: 'text', text: 'Hola' }] }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    // api-key mode must never touch the OAuth exchange endpoint.
    const exchangeCalls = () =>
      (fetchMock.mock.calls as unknown as unknown[][]).filter((c) =>
        String(c[0]).includes(OAUTH_CREATE_API_KEY_PATH),
      );

    const result = await translateWith(
      { kind: 'anthropic', auth: { mode: 'api-key', token: 'sk-ant-123' } },
      'Hello',
      es,
    );

    expect(result).toBe('Hola');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(exchangeCalls()).toHaveLength(0);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-123');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    // api-key mode must NOT send the OAuth headers.
    expect(headers['authorization']).toBeUndefined();
    expect(headers['anthropic-beta']).toBeUndefined();
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('claude-haiku-4-5-20251001');
    expect(body.temperature).toBe(0.3);
    expect(body.system).toBe(
      'You are a professional translator. Output only the translated text.',
    );
  });

  it('never logs the credential on failure', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 401 })),
    );

    await translateWith(
      {
        kind: 'anthropic',
        auth: { mode: 'oauth', token: 'sk-ant-oat01-secret' },
      },
      'Hello',
      es,
    );

    expect(warn).toHaveBeenCalled();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('sk-ant-oat01-secret');
    expect(logged).not.toContain('Bearer');
  });

  it('returns null on HTTP errors instead of throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    const result = await translateWith(
      { kind: 'anthropic', auth: { mode: 'api-key', token: 'sk-ant-123' } },
      'Hello',
      es,
    );
    expect(result).toBeNull();
  });

  it('returns null on network failure instead of throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const result = await translateWith(
      {
        kind: 'openai-compatible',
        baseUrl: 'http://localhost:9',
      },
      'Hello',
      es,
    );
    expect(result).toBeNull();
  });
});

// --- OAuth (hosted tenant) path ---
//
// A Claude Code OAuth token is NOT accepted by /v1/messages. The real protocol,
// the one the credential proxy relays for container traffic, is a token
// exchange: POST /api/oauth/claude_cli/create_api_key with the Bearer token →
// { raw_key } → use that as x-api-key. These tests pin that wire behaviour, not
// a header choice.
describe('translateWith — OAuth mode goes through the create_api_key exchange', () => {
  const es = resolveLanguage('es')!;
  const OAUTH_AUTH = {
    kind: 'anthropic' as const,
    auth: { mode: 'oauth' as const, token: 'sk-ant-oat01-hosted' },
  };
  const EXCHANGE_URL = `${ANTHROPIC_API_BASE}${OAUTH_CREATE_API_KEY_PATH}`;
  const MESSAGES_URL = `${ANTHROPIC_API_BASE}/v1/messages`;

  /** Router mock: exchange endpoint issues temp keys, /v1/messages replies. */
  function routedFetch(opts: {
    exchange?: () => Response;
    messages?: (apiKey: string | undefined) => Response;
  }) {
    let issued = 0;
    return vi.fn(async (url: string, init: RequestInit) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      if (String(url) === EXCHANGE_URL) {
        return (
          opts.exchange?.() ??
          new Response(JSON.stringify({ raw_key: `temp-key-${++issued}` }), {
            status: 200,
          })
        );
      }
      return (
        opts.messages?.(headers['x-api-key']) ??
        new Response(
          JSON.stringify({ content: [{ type: 'text', text: 'Hola' }] }),
          { status: 200 },
        )
      );
    });
  }

  const callsTo = (
    fetchMock: ReturnType<typeof routedFetch>,
    url: string,
  ): [string, RequestInit][] =>
    fetchMock.mock.calls.filter((c) => String(c[0]) === url) as unknown as [
      string,
      RequestInit,
    ][];

  it('exchanges the OAuth token, then sends the temp key as x-api-key with no Bearer', async () => {
    const fetchMock = routedFetch({});
    vi.stubGlobal('fetch', fetchMock);

    const result = await translateWith(OAUTH_AUTH, 'Hello', es);
    expect(result).toBe('Hola');

    // 1. The exchange, authenticated with the Bearer OAuth token.
    const exchanges = callsTo(fetchMock, EXCHANGE_URL);
    expect(exchanges).toHaveLength(1);
    const exchangeHeaders = exchanges[0][1].headers as Record<string, string>;
    expect(exchanges[0][1].method).toBe('POST');
    expect(exchangeHeaders['authorization']).toBe('Bearer sk-ant-oat01-hosted');
    expect(exchangeHeaders['anthropic-beta']).toBe('oauth-2025-04-20');

    // 2. /v1/messages carries the EXCHANGED key as x-api-key — never a Bearer
    //    token, never the raw OAuth credential.
    const messages = callsTo(fetchMock, MESSAGES_URL);
    expect(messages).toHaveLength(1);
    const msgHeaders = messages[0][1].headers as Record<string, string>;
    expect(msgHeaders['x-api-key']).toBe('temp-key-1');
    expect(msgHeaders['authorization']).toBeUndefined();
    expect(msgHeaders['anthropic-version']).toBe('2023-06-01');
    expect(JSON.stringify(msgHeaders)).not.toContain('sk-ant-oat01-hosted');
  });

  it('reuses the exchanged key: three translations, one exchange', async () => {
    const fetchMock = routedFetch({});
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 3; i++) {
      expect(await translateWith(OAUTH_AUTH, 'Hello', es)).toBe('Hola');
    }

    expect(callsTo(fetchMock, EXCHANGE_URL)).toHaveLength(1);
    expect(callsTo(fetchMock, MESSAGES_URL)).toHaveLength(3);
  });

  it('re-exchanges exactly once when the temp key has expired (401 from /v1/messages)', async () => {
    const fetchMock = routedFetch({
      messages: (apiKey) =>
        apiKey === 'temp-key-1'
          ? new Response('expired', { status: 401 })
          : new Response(
              JSON.stringify({ content: [{ type: 'text', text: 'Hola' }] }),
              { status: 200 },
            ),
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(await translateWith(OAUTH_AUTH, 'Hello', es)).toBe('Hola');

    expect(callsTo(fetchMock, EXCHANGE_URL)).toHaveLength(2);
    const messages = callsTo(fetchMock, MESSAGES_URL);
    expect(messages).toHaveLength(2);
    expect(
      (messages[1][1].headers as Record<string, string>)['x-api-key'],
    ).toBe('temp-key-2');
  });

  it('a failing exchange degrades to "not configured" — no per-message storm', async () => {
    for (const key of [
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_AUTH_TOKEN',
    ]) {
      vi.stubEnv(key, '');
    }
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-hosted');

    const fetchMock = routedFetch({
      exchange: () => new Response('unauthorized', { status: 401 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    // Before anything is attempted the credential is present → configured.
    expect(isTranslationConfigured()).toBe(true);

    // Five inbound messages hit the auto-translate path.
    for (let i = 0; i < 5; i++) {
      expect(await translateText('Hello', es)).toBeNull();
    }

    // Exactly ONE upstream attempt total, and /v1/messages was never called
    // with an unusable credential.
    expect(callsTo(fetchMock, EXCHANGE_URL)).toHaveLength(1);
    expect(callsTo(fetchMock, MESSAGES_URL)).toHaveLength(0);

    // …and the feature now reports itself unconfigured, so translate-commands
    // silently skips auto-translate and answers the honest NOT_CONFIGURED
    // message for explicit commands instead of TRANSLATE_FAILED per message.
    expect(isTranslationConfigured()).toBe(false);
  });

  it('never logs the OAuth token or the exchanged key on the OAuth path', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);

    vi.stubGlobal('fetch', routedFetch({}));
    await translateWith(OAUTH_AUTH, 'Hello', es);

    resetAnthropicApiKeyCache();
    vi.stubGlobal(
      'fetch',
      routedFetch({
        exchange: () =>
          new Response(JSON.stringify({ error: 'sk-ant-oat01-hosted' }), {
            status: 401,
          }),
      }),
    );
    await translateWith(OAUTH_AUTH, 'Hello', es);

    const logged = JSON.stringify([...warn.mock.calls, ...info.mock.calls]);
    expect(logged).not.toContain('sk-ant-oat01-hosted');
    expect(logged).not.toContain('temp-key-1');
    expect(logged).not.toContain('Bearer');
  });
});
