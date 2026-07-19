import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ALL_LANGUAGES,
  casualLanguageHints,
  detectLanguage,
  displayPair,
  formatLanguageList,
  formatTranslationReply,
  isTranslationReply,
  normalizeForPair,
  resolveLanguage,
  resolvePairForText,
  selectTranslateProvider,
  targetForSource,
  textLanguageCandidates,
  translateWith,
} from './translate-service.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
      anthropicApiKey: 'sk-ant-unused',
    });
    expect(provider).toEqual({
      kind: 'openai-compatible',
      baseUrl: 'https://cloud-api.near.ai/v1',
      apiKey: 'near-key',
      model: 'deepseek-ai/DeepSeek-V3.1',
    });
  });

  it('falls back to Anthropic when the claude backend has a key', () => {
    const provider = selectTranslateProvider({
      backend: 'claude',
      localBaseUrl: 'http://host.docker.internal:1234/v1',
      anthropicApiKey: 'sk-ant-123',
    });
    expect(provider).toEqual({ kind: 'anthropic', apiKey: 'sk-ant-123' });
  });

  it('returns null when neither is configured', () => {
    expect(
      selectTranslateProvider({
        backend: 'claude',
        localBaseUrl: 'http://host.docker.internal:1234/v1',
      }),
    ).toBeNull();
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

  it('calls the Anthropic Messages API with the haiku model', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ content: [{ type: 'text', text: 'Hola' }] }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await translateWith(
      { kind: 'anthropic', apiKey: 'sk-ant-123' },
      'Hello',
      es,
    );

    expect(result).toBe('Hola');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-123');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('claude-haiku-4-5-20251001');
    expect(body.temperature).toBe(0.3);
    expect(body.system).toBe(
      'You are a professional translator. Output only the translated text.',
    );
  });

  it('returns null on HTTP errors instead of throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    const result = await translateWith(
      { kind: 'anthropic', apiKey: 'sk-ant-123' },
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
