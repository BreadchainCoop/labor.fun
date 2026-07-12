/**
 * Outbound WhatsApp proxy for shared-bot INGRESS mode.
 *
 * In hosted SaaS mode ONE platform WhatsApp account (a Baileys client the
 * control plane (CP) runs, linked to the platform number) serves every org. The
 * tenant never holds WhatsApp creds and has no socket, so every outbound message
 * the channel produces is proxied through the CP, which resolves jid → its
 * shared-Baileys send:
 *
 *   POST ${CONTROL_PLANE_URL}/api/instance/whatsapp/send
 *   Authorization: Bearer ${CONTROL_PLANE_TOKEN}
 *   content-type: application/json
 *   body: { jid, text }              // v1 contract
 *
 * Contract invariants:
 * - `jid` and `text` MUST be present (jid asserted here; empty text still sends
 *   nothing meaningful but is not rejected — the caller controls content).
 * - This NEVER throws. On a CP outage / non-2xx / network error it logs a warn
 *   and returns — mirroring the Baileys path's "queue on failure, never crash"
 *   degradation. There is no per-tenant retry queue in ingress mode (the CP owns
 *   delivery + retries on its shared socket), so a persistent CP outage drops
 *   the message with a logged warn rather than crashing the orchestrator.
 *
 * ── Baileys-only degradations (NOT available over this v1 { jid, text } proxy) ─
 * The following are Baileys socket capabilities with no CP proxy method in v1;
 * in shared-bot ingress mode they degrade cleanly (see whatsapp.ts):
 *   - media download (imageMessage/videoMessage/etc. bytes) — text/caption only;
 *   - presence / typing indicators (sendPresenceUpdate) — no-op;
 *   - group metadata sync (groupFetchAllParticipating) — CP owns discovery;
 *   - retry re-encryption cache (getMessage) — CP owns its own socket's retries.
 *
 * Fetch style mirrors control-plane-sync.ts / telegram-sender.ts: an
 * AbortController timeout, Bearer + json content-type.
 */
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

const HTTP_TIMEOUT_MS = 20_000;

export interface WhatsAppSenderConfig {
  url: string; // CONTROL_PLANE_URL (no trailing slash)
  token: string; // CONTROL_PLANE_TOKEN
}

/**
 * Read CONTROL_PLANE_URL / CONTROL_PLANE_TOKEN (process.env, then .env),
 * matching control-plane-sync.ts's controlPlaneConfig() and
 * telegram-sender.ts's telegramSenderConfig(). Returns null when either is
 * missing (ingress outbound can't function without the proxy).
 */
export function whatsappSenderConfig(): WhatsAppSenderConfig | null {
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
 * Proxies WhatsApp sends through the control plane. Construct with a config
 * (from whatsappSenderConfig()). `send()` never throws.
 */
export class WhatsAppSender {
  private readonly url: string;
  private readonly token: string;

  constructor(cfg: WhatsAppSenderConfig) {
    this.url = cfg.url;
    this.token = cfg.token;
  }

  /**
   * Proxy a single WhatsApp send. `jid` is required and asserted. Returns true
   * on a 2xx from the CP, false on any failure. Never throws — a CP outage /
   * non-2xx / network error logs a warn and returns false, so the caller
   * degrades cleanly (the message is dropped with a warn, exactly as the Baileys
   * path queues-then-warns on a failed socket send).
   */
  async send(jid: string, text: string): Promise<boolean> {
    if (!jid) {
      // Contract violation — surface loudly but never throw into the caller.
      logger.warn('WhatsAppSender: send missing jid (dropping)');
      return false;
    }

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.url}/api/instance/whatsapp/send`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jid, text }),
        signal: controller.signal,
      });
      if (!res.ok) {
        logger.warn(
          { jid, status: res.status },
          'WhatsAppSender: control-plane proxy non-2xx (dropping send)',
        );
        return false;
      }
      logger.info(
        { jid, length: text.length },
        'WhatsApp message sent via control-plane proxy',
      );
      return true;
    } catch (err) {
      logger.warn(
        { jid, err },
        'WhatsAppSender: proxy call failed (dropping send)',
      );
      return false;
    } finally {
      clearTimeout(t);
    }
  }
}
