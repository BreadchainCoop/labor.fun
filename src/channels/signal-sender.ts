/**
 * Outbound Signal proxy for shared-bot INGRESS mode.
 *
 * In hosted SaaS mode ONE platform Signal number (a real signal-cli account the
 * control plane (CP) drives via the bbernhard/signal-cli-rest-api gateway) serves
 * every org. Signal has NO bot API and no per-org account, so the tenant never
 * holds Signal creds and has no signal-cli socket. Every outbound message the
 * channel produces is therefore proxied through the CP, which resolves the group
 * and relays it to the shared gateway:
 *
 *   POST ${CONTROL_PLANE_URL}/api/instance/signal/send
 *   Authorization: Bearer ${CONTROL_PLANE_TOKEN}
 *   content-type: application/json
 *   body: { groupId, message }        // v1 contract
 *
 * `groupId` is the INTERNAL base64 Signal group id (the value inside a
 * `signal:group:<id>` tenant JID — NOT the `signal:group:` prefix). The CP
 * addresses it to the gateway as `group.<groupId>` (bbernhard convention) and
 * enforces a cross-tenant binding guard, so org A can never message org B's
 * group through the shared account.
 *
 * Contract invariants:
 * - `groupId` and `message` MUST be present (groupId asserted here; a jid that
 *   isn't a shared-Signal group yields an empty groupId → dropped with a warn).
 * - This NEVER throws. On a CP outage / non-2xx / network error it logs a warn
 *   and returns false — mirroring the native path's "log and drop, never crash"
 *   degradation (SignalChannel.sendMessage swallows send errors). There is no
 *   per-tenant retry queue in ingress mode (the CP owns delivery on its shared
 *   gateway), so a persistent CP outage drops the message with a logged warn.
 *
 * ── Native-only degradations (NOT available over this v1 { groupId, message } proxy) ─
 * The following are signal-cli JSON-RPC capabilities with no CP proxy method in
 * v1; in shared-bot ingress mode they degrade cleanly (see signal.ts):
 *   - reactions (sendReaction)       — no-op;
 *   - typing indicators (sendTyping) — no-op;
 *   - explicit textStyle ranges      — the CP gateway renders `text_mode:styled`
 *     from the raw message text instead, so we forward the text verbatim.
 *
 * Shared Signal is a GROUP-only surface: the CP drops DMs to the platform number
 * and only ever forwards (and accepts sends for) bound groups. A non-group jid
 * therefore has no groupId and is dropped here rather than proxied.
 *
 * Fetch style mirrors whatsapp-sender.ts / telegram-sender.ts: an
 * AbortController timeout, Bearer + json content-type.
 */
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

const HTTP_TIMEOUT_MS = 20_000;

export interface SignalSenderConfig {
  url: string; // CONTROL_PLANE_URL (no trailing slash)
  token: string; // CONTROL_PLANE_TOKEN
}

/**
 * Extract the internal (base64) Signal group id from a tenant JID. Returns the
 * id for a `signal:group:<id>` JID, or '' for a DM JID (`signal:<e164>`) or any
 * non-group value — shared Signal is group-only, so those are never proxied.
 */
export function signalGroupIdFromJid(jid: string): string {
  const rest = jid.replace(/^signal:/, '');
  return rest.startsWith('group:') ? rest.slice('group:'.length) : '';
}

/**
 * Read CONTROL_PLANE_URL / CONTROL_PLANE_TOKEN (process.env, then .env),
 * matching whatsapp-sender.ts's whatsappSenderConfig() and
 * telegram-sender.ts's telegramSenderConfig(). Returns null when either is
 * missing (ingress outbound can't function without the proxy).
 */
export function signalSenderConfig(): SignalSenderConfig | null {
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
 * Proxies Signal group sends through the control plane. Construct with a config
 * (from signalSenderConfig()). `send()` never throws.
 */
export class SignalSender {
  private readonly url: string;
  private readonly token: string;

  constructor(cfg: SignalSenderConfig) {
    this.url = cfg.url;
    this.token = cfg.token;
  }

  /**
   * Proxy a single Signal group send. `jid` is the tenant chat JID; only a
   * `signal:group:<id>` JID yields a groupId (shared Signal is group-only).
   * Returns true on a 2xx from the CP, false on any failure. Never throws — a CP
   * outage / non-2xx / network error logs a warn and returns false, so the
   * caller degrades cleanly (the message is dropped with a warn, exactly as the
   * native path logs-and-drops on a failed socket send).
   */
  async send(jid: string, text: string): Promise<boolean> {
    const groupId = signalGroupIdFromJid(jid);
    if (!groupId) {
      // Contract violation — surface loudly but never throw into the caller.
      logger.warn(
        { jid },
        'SignalSender: jid is not a shared-Signal group (dropping — shared Signal is group-only)',
      );
      return false;
    }

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.url}/api/instance/signal/send`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ groupId, message: text }),
        signal: controller.signal,
      });
      if (!res.ok) {
        logger.warn(
          { groupId, status: res.status },
          'SignalSender: control-plane proxy non-2xx (dropping send)',
        );
        return false;
      }
      logger.info(
        { groupId, length: text.length },
        'Signal message sent via control-plane proxy',
      );
      return true;
    } catch (err) {
      logger.warn(
        { groupId, err },
        'SignalSender: proxy call failed (dropping send)',
      );
      return false;
    } finally {
      clearTimeout(t);
    }
  }
}
