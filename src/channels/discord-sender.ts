/**
 * Outbound Discord proxy for shared-bot INGRESS mode.
 *
 * In hosted SaaS mode the platform-wide Discord bot token is owned by the
 * control plane (CP); the tenant never holds it. Every outbound Discord action
 * the channel takes is therefore proxied through the CP:
 *
 *   POST ${CONTROL_PLANE_URL}/api/instance/discord/send
 *   Authorization: Bearer ${CONTROL_PLANE_TOKEN}
 *   content-type: application/json
 *   body: { channelId, content }                          (v1 send)
 *   body: { channelId, action, ... }                      (edit/delete/typing/reaction)
 *
 * The response is the CP's JSON: { ok, id?, description? }. `id` is the created
 * message id on a send (so the channel can log the outbound row).
 *
 * Contract invariants:
 * - `channelId` MUST be present on every call (asserted here).
 * - This NEVER throws. On a CP outage / non-2xx / network error it logs a warn
 *   and returns a safe `{ ok: false, description }` so callers degrade cleanly
 *   (dropped reactions/typing, a logged send failure) rather than crashing.
 *
 * Fetch style mirrors control-plane-sync.ts / telegram-sender.ts: an
 * AbortController timeout, Bearer + json content-type.
 */
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

const HTTP_TIMEOUT_MS = 20_000;

/** CP proxy response shape. */
export interface DiscordApiResult {
  ok: boolean;
  /** Created message id (present on a successful send). */
  id?: string;
  description?: string;
}

export interface DiscordSenderConfig {
  url: string; // CONTROL_PLANE_URL (no trailing slash)
  token: string; // CONTROL_PLANE_TOKEN
}

/**
 * Read CONTROL_PLANE_URL / CONTROL_PLANE_TOKEN (process.env, then .env),
 * matching control-plane-sync.ts's controlPlaneConfig() / telegramSenderConfig().
 * Returns null when either is missing (ingress outbound can't function without
 * the proxy).
 */
export function discordSenderConfig(): DiscordSenderConfig | null {
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
 * Proxies Discord bot actions through the control plane. Construct with a
 * config (from discordSenderConfig()). Every method never throws.
 */
export class DiscordSender {
  private readonly url: string;
  private readonly token: string;

  constructor(cfg: DiscordSenderConfig) {
    this.url = cfg.url;
    this.token = cfg.token;
  }

  /**
   * POST a payload to the CP send endpoint. `body.channelId` is required and
   * asserted (attached callers always pass it). Returns the CP JSON verbatim or
   * a safe `{ ok: false }` on any failure.
   */
  private async post(body: Record<string, unknown>): Promise<DiscordApiResult> {
    if (
      body.channelId === undefined ||
      body.channelId === null ||
      body.channelId === ''
    ) {
      // Contract violation — surface loudly but never throw into the caller.
      logger.warn(
        { action: body.action },
        'DiscordSender: call missing channelId (dropping)',
      );
      return { ok: false, description: 'missing channelId' };
    }

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.url}/api/instance/discord/send`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        logger.warn(
          { status: res.status },
          'DiscordSender: control-plane proxy non-2xx',
        );
        return {
          ok: false,
          description: `control-plane proxy status ${res.status}`,
        };
      }
      const parsed = (await res.json()) as DiscordApiResult;
      if (parsed && parsed.ok === false) {
        // A Discord-level failure surfaced by the CP. Log at debug so callers
        // that already warn don't double-log; it's not a crash.
        logger.debug(
          { description: parsed.description },
          'DiscordSender: proxy returned ok:false',
        );
      }
      return parsed ?? { ok: false, description: 'empty proxy response' };
    } catch (err) {
      logger.warn({ err }, 'DiscordSender: proxy call failed');
      return { ok: false, description: 'control-plane proxy unreachable' };
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Send a message to a channel. v1 contract body: `{ channelId, content }`.
   * Returns the created message id on success (for outbound logging).
   */
  async send(channelId: string, content: string): Promise<DiscordApiResult> {
    return this.post({ channelId, content });
  }

  /** Edit a previously-sent message. */
  async edit(
    channelId: string,
    messageId: string,
    content: string,
  ): Promise<DiscordApiResult> {
    return this.post({ channelId, action: 'edit', messageId, content });
  }

  /** Delete a message. */
  async delete(
    channelId: string,
    messageId: string,
  ): Promise<DiscordApiResult> {
    return this.post({ channelId, action: 'delete', messageId });
  }

  /** Show the typing indicator in a channel. */
  async typing(channelId: string): Promise<DiscordApiResult> {
    return this.post({ channelId, action: 'typing' });
  }

  /** Add a reaction (Unicode emoji) to a message. */
  async addReaction(
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<DiscordApiResult> {
    return this.post({
      channelId,
      action: 'reaction',
      messageId,
      emoji,
      op: 'add',
    });
  }

  /** Remove the bot's reaction (Unicode emoji) from a message. */
  async removeReaction(
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<DiscordApiResult> {
    return this.post({
      channelId,
      action: 'reaction',
      messageId,
      emoji,
      op: 'remove',
    });
  }
}
