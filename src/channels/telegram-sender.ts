/**
 * Outbound Telegram proxy for shared-bot INGRESS mode.
 *
 * In hosted SaaS mode the platform-wide Telegram bot token is owned by the
 * control plane (CP); the tenant never holds it. Every outbound Telegram API
 * call the channel makes is therefore proxied through the CP:
 *
 *   POST ${CONTROL_PLANE_URL}/api/instance/telegram/send
 *   Authorization: Bearer ${CONTROL_PLANE_TOKEN}
 *   content-type: application/json
 *   body: { method, params }
 *
 * The response is Telegram's Bot API JSON verbatim: { ok, result?, description? }.
 *
 * Contract invariants:
 * - `params.chat_id` MUST be present on every call (asserted here).
 * - Only the allowed method set is used (documented below) — the CP enforces it
 *   too, but we keep the list here for clarity.
 * - This NEVER throws. On a CP outage / non-2xx / network error it logs a warn
 *   and returns a safe `{ ok: false, description }` so callers degrade cleanly
 *   (Markdown→plain fallback, dropped reactions, etc.) exactly as a Telegram
 *   `ok:false` would drive them.
 *
 * Fetch style mirrors control-plane-sync.ts: an AbortController timeout,
 * Bearer + json content-type.
 */
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

const HTTP_TIMEOUT_MS = 20_000;

/** The Telegram Bot API methods the channel is allowed to proxy. */
export const ALLOWED_TELEGRAM_METHODS = [
  'sendMessage',
  'sendChatAction',
  'editMessageText',
  'deleteMessage',
  'sendPhoto',
  'sendDocument',
  'setMessageReaction',
  'getChat',
  'getChatMember',
  'getChatAdministrators',
] as const;

export type TelegramMethod = (typeof ALLOWED_TELEGRAM_METHODS)[number];

/** Telegram Bot API response shape (verbatim from the CP proxy). */
export interface TelegramApiResult<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
}

export interface TelegramSenderConfig {
  url: string; // CONTROL_PLANE_URL (no trailing slash)
  token: string; // CONTROL_PLANE_TOKEN
}

/**
 * Read CONTROL_PLANE_URL / CONTROL_PLANE_TOKEN (process.env, then .env),
 * matching control-plane-sync.ts's controlPlaneConfig(). Returns null when
 * either is missing (ingress outbound can't function without the proxy).
 */
export function telegramSenderConfig(): TelegramSenderConfig | null {
  const env = readEnvFile(['CONTROL_PLANE_URL', 'CONTROL_PLANE_TOKEN']);
  const url = (process.env.CONTROL_PLANE_URL || env.CONTROL_PLANE_URL || '')
    .trim()
    .replace(/\/$/, '');
  const token = (
    process.env.CONTROL_PLANE_TOKEN ||
    env.CONTROL_PLANE_TOKEN ||
    ''
  ).trim();
  if (!url || !token) return null;
  return { url, token };
}

/**
 * Proxies Telegram Bot API calls through the control plane. Construct with a
 * config (from telegramSenderConfig()). `call()` never throws.
 */
export class TelegramSender {
  private readonly url: string;
  private readonly token: string;

  constructor(cfg: TelegramSenderConfig) {
    this.url = cfg.url;
    this.token = cfg.token;
  }

  /**
   * Proxy a single Telegram method call. `params.chat_id` is required and
   * asserted (attached callers always pass it). Returns Telegram's JSON verbatim
   * or a safe `{ ok: false }` on any failure.
   */
  async call<T = unknown>(
    method: TelegramMethod,
    params: Record<string, unknown>,
  ): Promise<TelegramApiResult<T>> {
    if (
      params.chat_id === undefined ||
      params.chat_id === null ||
      params.chat_id === ''
    ) {
      // Contract violation — surface loudly but never throw into the caller.
      logger.warn(
        { method },
        'TelegramSender: call missing params.chat_id (dropping)',
      );
      return { ok: false, description: 'missing chat_id' };
    }

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.url}/api/instance/telegram/send`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ method, params }),
        signal: controller.signal,
      });
      if (!res.ok) {
        logger.warn(
          { method, status: res.status },
          'TelegramSender: control-plane proxy non-2xx',
        );
        return {
          ok: false,
          description: `control-plane proxy status ${res.status}`,
        };
      }
      const body = (await res.json()) as TelegramApiResult<T>;
      if (body && body.ok === false) {
        // A Telegram-level failure (e.g. Markdown parse error). Surface it as
        // a warn so the caller's Markdown→plain fallback can react; not an error.
        logger.debug(
          { method, description: body.description },
          'TelegramSender: Telegram returned ok:false',
        );
      }
      return body;
    } catch (err) {
      logger.warn({ method, err }, 'TelegramSender: proxy call failed');
      return { ok: false, description: 'control-plane proxy unreachable' };
    } finally {
      clearTimeout(t);
    }
  }
}
