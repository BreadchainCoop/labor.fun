/**
 * Translation service — language catalog, detection heuristics, and the
 * LLM-backed translate call. Ported at parity from sigstack-bot
 * (crates/signal-bot/src/commands/translate_lang.rs + translate_service.rs).
 *
 * Runs in the orchestrator host process (pre-agent, no container). Provider
 * selection:
 *   1. OpenAI-compatible endpoint when the local/NEAR AI backend is active
 *      (NANOCLAW_BACKEND=local — set explicitly or implied by NEAR_AI_API_KEY;
 *      wire config is LOCAL_LLM_BASE_URL / LOCAL_LLM_API_KEY / LOCAL_LLM_MODEL).
 *   2. Anthropic Messages API with a small fast model when an
 *      ANTHROPIC_API_KEY is available (process.env or .env).
 *   3. Neither → translation is "not configured"; callers reply with a
 *      friendly message and never crash.
 */
import { detectAll } from 'tinyld';

import {
  LOCAL_LLM_API_KEY,
  LOCAL_LLM_BASE_URL,
  LOCAL_LLM_MODEL,
  NANOCLAW_BACKEND,
} from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

// --- Language catalog (port of translate_lang.rs) ---

export interface Language {
  code: string;
  name: string;
  flag: string;
}

/** Full supported language catalog (for !list-langs). */
export const ALL_LANGUAGES: readonly Language[] = [
  { code: 'en', name: 'English', flag: '🇺🇸' },
  { code: 'es', name: 'Spanish', flag: '🇪🇸' },
  { code: 'fr', name: 'French', flag: '🇫🇷' },
  { code: 'de', name: 'German', flag: '🇩🇪' },
  { code: 'it', name: 'Italian', flag: '🇮🇹' },
  { code: 'pt', name: 'Portuguese', flag: '🇵🇹' },
  { code: 'ru', name: 'Russian', flag: '🇷🇺' },
  { code: 'zh', name: 'Chinese', flag: '🇨🇳' },
  { code: 'ja', name: 'Japanese', flag: '🇯🇵' },
  { code: 'ko', name: 'Korean', flag: '🇰🇷' },
  { code: 'ar', name: 'Arabic', flag: '🇸🇦' },
  { code: 'hi', name: 'Hindi', flag: '🇮🇳' },
  { code: 'bn', name: 'Bengali', flag: '🇧🇩' },
  { code: 'nl', name: 'Dutch', flag: '🇳🇱' },
  { code: 'pl', name: 'Polish', flag: '🇵🇱' },
  { code: 'tr', name: 'Turkish', flag: '🇹🇷' },
  { code: 'vi', name: 'Vietnamese', flag: '🇻🇳' },
  { code: 'th', name: 'Thai', flag: '🇹🇭' },
  { code: 'id', name: 'Indonesian', flag: '🇮🇩' },
  { code: 'uk', name: 'Ukrainian', flag: '🇺🇦' },
  { code: 'sv', name: 'Swedish', flag: '🇸🇪' },
  { code: 'cs', name: 'Czech', flag: '🇨🇿' },
  { code: 'el', name: 'Greek', flag: '🇬🇷' },
  { code: 'he', name: 'Hebrew', flag: '🇮🇱' },
  { code: 'ro', name: 'Romanian', flag: '🇷🇴' },
  { code: 'hu', name: 'Hungarian', flag: '🇭🇺' },
  { code: 'fi', name: 'Finnish', flag: '🇫🇮' },
  { code: 'da', name: 'Danish', flag: '🇩🇰' },
  { code: 'no', name: 'Norwegian', flag: '🇳🇴' },
  { code: 'fa', name: 'Persian', flag: '🇮🇷' },
];

const NAME_ALIASES: Record<string, string> = {
  english: 'en',
  spanish: 'es',
  español: 'es',
  espanol: 'es',
  french: 'fr',
  français: 'fr',
  francais: 'fr',
  german: 'de',
  deutsch: 'de',
  italian: 'it',
  italiano: 'it',
  portuguese: 'pt',
  português: 'pt',
  portugues: 'pt',
  russian: 'ru',
  русский: 'ru',
  chinese: 'zh',
  mandarin: 'zh',
  japanese: 'ja',
  korean: 'ko',
  arabic: 'ar',
  hindi: 'hi',
  bengali: 'bn',
  dutch: 'nl',
  polish: 'pl',
  turkish: 'tr',
  vietnamese: 'vi',
  thai: 'th',
  indonesian: 'id',
  ukrainian: 'uk',
};

/** Resolve a user-provided language token (ISO code or common name). */
export function resolveLanguage(input: string): Language | undefined {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return undefined;
  const byCode = ALL_LANGUAGES.find((l) => l.code === normalized);
  if (byCode) return byCode;
  const aliased = NAME_ALIASES[normalized];
  return aliased ? ALL_LANGUAGES.find((l) => l.code === aliased) : undefined;
}

/** Sorted "flag code — name" lines for !list-langs. */
export function formatLanguageList(
  languages: readonly Language[] = ALL_LANGUAGES,
): string {
  return languages
    .map((l) => `${l.flag} ${l.code} — ${l.name}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .join('\n');
}

// --- Language detection (port of translate_service.rs heuristics) ---
//
// sigstack-bot uses whatlang (Rust). The JS equivalent chosen here is
// `tinyld` — a small pure-JS n-gram detector that returns ISO 639-1 codes
// with a 0..1 accuracy score, mirroring whatlang's confidence. The thresholds
// and fallback heuristics below are ported verbatim: 0.2 confidence for text
// detection, a looser 0.08 pass for short snippets, hard-coded EN/ES casual
// markers, and Portuguese/Catalan/Galician → Spanish normalization when 'es'
// is one side of the active pair.

const MIN_DETECT_CONFIDENCE = 0.2;
const MIN_LOOSE_CONFIDENCE = 0.08;

/** Detection codes recognized in sigstack's whatlang → ISO 639-1 mapping. */
const SUPPORTED_DETECTION_CODES = new Set([
  'en',
  'es',
  'zh',
  'hi',
  'bn',
  'fr',
  'ar',
  'pt',
  'ru',
  'ja',
  'de',
  'ko',
  'it',
  'nl',
  'pl',
  'tr',
  'uk',
  'sv',
  'cs',
  'el',
  'he',
  'ro',
  'hu',
  'fi',
  'da',
  'no',
  'fa',
  'vi',
  'th',
  'id',
]);

function detectWithThreshold(
  text: string,
  minConfidence: number,
): string | null {
  let results: { lang: string; accuracy: number }[];
  try {
    results = detectAll(text);
  } catch {
    return null;
  }
  const top = results[0];
  if (!top || top.accuracy < minConfidence) return null;
  return SUPPORTED_DETECTION_CODES.has(top.lang) ? top.lang : null;
}

/**
 * Detect the ISO 639-1 language of a text message.
 * Returns null below the 0.2 confidence threshold (port of
 * detect_text_language, MIN_DETECT_CONFIDENCE).
 */
export function detectLanguage(text: string): string | null {
  return detectWithThreshold(text, MIN_DETECT_CONFIDENCE);
}

/**
 * Looser detection pass tuned for short snippets (port of
 * detect_text_language_voice, MIN_VOICE_CONFIDENCE = 0.08).
 */
export function detectLanguageLoose(text: string): string | null {
  return detectWithThreshold(text, MIN_LOOSE_CONFIDENCE);
}

/**
 * Hard-coded casual-marker hints for short EN/ES snippets that statistical
 * detection misses (port of casual_language_hints).
 */
export function casualLanguageHints(text: string): string[] {
  const lower = text.toLowerCase();
  const hints: string[] = [];

  const englishMarkers = [
    ' the ',
    " i'm ",
    ' how ',
    ' your ',
    'hello',
    'english',
    ' day?',
    'speaking in english',
    'how are',
    'doing?',
  ];
  if (englishMarkers.some((m) => lower.includes(m))) hints.push('en');

  const spanishMarkers = [
    '¿',
    'cómo',
    'como ',
    'está',
    'está?',
    'hola',
    'gracias',
    'día',
    'hablo',
  ];
  if (spanishMarkers.some((m) => lower.includes(m))) hints.push('es');

  return hints;
}

/**
 * Ordered, deduped candidate codes for a text message: strict detection,
 * loose detection, then casual-marker hints (port of text_language_candidates).
 */
export function textLanguageCandidates(text: string): string[] {
  const codes: string[] = [];
  const push = (code: string | null) => {
    if (code && !codes.includes(code)) codes.push(code);
  };
  push(detectLanguage(text));
  push(detectLanguageLoose(text));
  for (const hint of casualLanguageHints(text)) push(hint);
  return codes;
}

// --- Bidirectional pair resolution (port of GroupTranslateMode) ---

export interface TranslatePair {
  langA: string;
  langB: string;
}

/** If `sourceCode` matches one side of the pair, return the other language. */
export function targetForSource(
  pair: TranslatePair,
  sourceCode: string,
): Language | undefined {
  const source = sourceCode.toLowerCase();
  if (source === pair.langA) return resolveLanguage(pair.langB);
  if (source === pair.langB) return resolveLanguage(pair.langA);
  return undefined;
}

/**
 * Map a detected code into one side of the active pair when possible.
 * Iberian romance (pt/ca/gl) is often detected for Spanish; treat as Spanish
 * when 'es' is in the pair (port of normalize_for_translate_all_pair).
 */
export function normalizeForPair(
  pair: TranslatePair,
  code: string,
): string | null {
  const lower = code.toLowerCase();
  if (targetForSource(pair, lower)) return lower;
  if (
    ['pt', 'ca', 'gl'].includes(lower) &&
    (pair.langA === 'es' || pair.langB === 'es') &&
    targetForSource(pair, 'es')
  ) {
    return 'es';
  }
  return null;
}

/**
 * Resolve source/target languages for a group text message in pair mode
 * (port of resolve_translate_all_text_pair).
 */
export function resolvePairForText(
  pair: TranslatePair,
  text: string,
): { source: Language; target: Language } | null {
  for (const code of textLanguageCandidates(text)) {
    const normalized = normalizeForPair(pair, code);
    if (!normalized) continue;
    const target = targetForSource(pair, normalized);
    const source = resolveLanguage(normalized);
    if (target && source) return { source, target };
  }
  return null;
}

/** Human-readable pair for confirmation messages (port of display_pair). */
export function displayPair(pair: TranslatePair): string {
  const label = (code: string) => {
    const lang = resolveLanguage(code);
    return lang ? `${lang.flag} ${lang.name}` : code;
  };
  return `${label(pair.langA)} ↔ ${label(pair.langB)}`;
}

// --- Translation provider ---

// System prompt ported verbatim from sigstack-bot translate.rs /
// translate_service.rs (NEAR AI chat call, temperature 0.3).
const SYSTEM_PROMPT =
  'You are a professional translator. Output only the translated text.';

function userPrompt(text: string, target: Language): string {
  return (
    `Translate the following text to ${target.name}. ` +
    `Return only the translation, with no explanation or quotes.\n\n${text}`
  );
}

const TRANSLATE_TIMEOUT_MS = 20_000;
const ANTHROPIC_TRANSLATE_MODEL = 'claude-haiku-4-5-20251001';

export type TranslateProvider =
  | {
      kind: 'openai-compatible';
      baseUrl: string;
      apiKey?: string;
      model?: string;
    }
  | { kind: 'anthropic'; apiKey: string };

export interface TranslateProviderConfig {
  backend: 'claude' | 'local';
  localBaseUrl: string;
  localApiKey?: string;
  localModel?: string;
  anthropicApiKey?: string;
}

/**
 * Pure provider-selection logic (exported for tests): OpenAI-compatible when
 * the local/NEAR backend is configured, Anthropic key fallback, else null.
 */
export function selectTranslateProvider(
  cfg: TranslateProviderConfig,
): TranslateProvider | null {
  if (cfg.backend === 'local' && cfg.localBaseUrl) {
    return {
      kind: 'openai-compatible',
      baseUrl: cfg.localBaseUrl,
      apiKey: cfg.localApiKey,
      model: cfg.localModel,
    };
  }
  if (cfg.anthropicApiKey) {
    return { kind: 'anthropic', apiKey: cfg.anthropicApiKey };
  }
  return null;
}

function readAnthropicKey(): string | undefined {
  // process.env first (hosted Kubernetes mode), .env fallback — the same
  // convention as the credential proxy's readSecrets.
  return (
    process.env.ANTHROPIC_API_KEY ||
    readEnvFile(['ANTHROPIC_API_KEY']).ANTHROPIC_API_KEY ||
    undefined
  );
}

/** Resolve the active provider from live orchestrator config. */
export function resolveTranslateProvider(): TranslateProvider | null {
  return selectTranslateProvider({
    backend: NANOCLAW_BACKEND,
    localBaseUrl: LOCAL_LLM_BASE_URL,
    localApiKey: LOCAL_LLM_API_KEY,
    localModel: LOCAL_LLM_MODEL,
    anthropicApiKey: readAnthropicKey(),
  });
}

/** True when some translation backend is available. */
export function isTranslationConfigured(): boolean {
  return resolveTranslateProvider() !== null;
}

/**
 * Translate `text` to `target` using an explicit provider. Never throws:
 * returns null on HTTP/parse/timeout failure (callers decide whether to send
 * an apologetic reply or silently skip).
 */
export async function translateWith(
  provider: TranslateProvider,
  text: string,
  target: Language,
): Promise<string | null> {
  try {
    let res: Response;
    if (provider.kind === 'openai-compatible') {
      const base = provider.baseUrl.replace(/\/+$/, '');
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(provider.apiKey
            ? { Authorization: `Bearer ${provider.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          ...(provider.model ? { model: provider.model } : {}),
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt(text, target) },
          ],
          temperature: 0.3,
          max_tokens: 1024,
        }),
        signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
      });
      if (!res.ok) {
        logger.warn(
          { status: res.status },
          'translate: OpenAI-compatible endpoint returned error',
        );
        return null;
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = data.choices?.[0]?.message?.content;
      return typeof content === 'string' && content.trim()
        ? content.trim()
        : null;
    }

    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': provider.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_TRANSLATE_MODEL,
        max_tokens: 1024,
        temperature: 0.3,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt(text, target) }],
      }),
      signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status },
        'translate: Anthropic endpoint returned error',
      );
      return null;
    }
    const data = (await res.json()) as {
      content?: { type?: string; text?: string }[];
    };
    const block = data.content?.find((b) => typeof b.text === 'string');
    return block?.text?.trim() ? block.text.trim() : null;
  } catch (err) {
    logger.warn({ err }, 'translate: request failed');
    return null;
  }
}

/**
 * Translate using the configured provider. Returns null when translation is
 * unconfigured or the call fails. Never throws into the message loop.
 */
export async function translateText(
  text: string,
  target: Language,
): Promise<string | null> {
  const provider = resolveTranslateProvider();
  if (!provider) return null;
  return translateWith(provider, text, target);
}

/** Auto-translate reply body: translation only, flag-prefixed (port of format_text_auto_translation). */
export function formatTranslationReply(
  target: Language,
  translation: string,
): string {
  return `${target.flag} ${translation.trim()}`;
}

/** Loop guard: true when a message body looks like one of our translation replies. */
export function isTranslationReply(text: string): boolean {
  return ALL_LANGUAGES.some((l) => text.startsWith(`${l.flag} `));
}
