/**
 * whatsapp-pairing-broker — hosted-mode WhatsApp pairing driver.
 *
 * In hosted (SaaS) mode the tenant can't run the interactive setup CLI, so the
 * control plane drives WhatsApp pairing on their behalf. At orchestrator
 * startup, when ALL of the following hold:
 *
 *   - WHATSAPP_PAIRING_PHONE is set (digits only), AND
 *   - CONTROL_PLANE_URL is set (control-plane bridge configured), AND
 *   - no creds exist yet at <STORE_DIR>/auth/creds.json,
 *
 * this broker opens a WhatsApp socket in pairing-code mode for that phone and
 * relays each generated pairing code up to the control plane:
 *
 *   POST {CONTROL_PLANE_URL}/api/instance/whatsapp/pairing-code
 *     Authorization: Bearer {CONTROL_PLANE_TOKEN}
 *     content-type: application/json
 *     { "code": "<code>", "phone": "<phone>" }
 *
 * Pairing codes expire ~60s after issue, so the broker re-requests (and
 * re-POSTs) a fresh one on expiry, up to a ~10 minute overall cap. On success
 * (creds saved) it notifies the control plane:
 *
 *   POST {CONTROL_PLANE_URL}/api/instance/whatsapp/paired
 *     Authorization: Bearer {CONTROL_PLANE_TOKEN}
 *     content-type: application/json
 *     { "phone": "<phone>" }
 *
 * then returns so the caller connects the WhatsApp channel normally (in-process
 * — the channel's connect() picks up the freshly-saved creds from the same
 * <STORE_DIR>/auth directory).
 *
 * If creds already exist at startup the broker is skipped entirely. It mirrors
 * control-plane-sync.ts's fetch/auth/error discipline: fetchWithTimeout +
 * Bearer auth headers + logger.warn, and NEVER throws — a control-plane outage
 * or network failure must never crash the orchestrator.
 */
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { runPairingSession } from '../whatsapp-pairing.js';
import { controlPlaneConfig } from './control-plane-sync.js';

const HTTP_TIMEOUT_MS = 20_000;
/** Pairing codes expire ~60s; re-request a bit sooner to avoid a dead window. */
const CODE_REFRESH_MS = 55_000;
/** Overall cap: stop waiting for the user to pair after ~10 minutes. */
const OVERALL_CAP_MS = 10 * 60_000;

/** Where the running WhatsApp channel reads/writes its baileys auth state. */
export function whatsappAuthDir(): string {
  return path.join(STORE_DIR, 'auth');
}

/** True when authenticated creds already exist (baileys writes creds.json). */
export function whatsappCredsExist(): boolean {
  try {
    return fs.existsSync(path.join(whatsappAuthDir(), 'creds.json'));
  } catch {
    return false;
  }
}

/** WHATSAPP_PAIRING_PHONE, digits only (process.env, then .env). '' when unset/invalid. */
export function pairingPhone(): string {
  const env = readEnvFile(['WHATSAPP_PAIRING_PHONE']);
  const raw = (
    process.env.WHATSAPP_PAIRING_PHONE ||
    env.WHATSAPP_PAIRING_PHONE ||
    ''
  ).trim();
  const digits = raw.replace(/[^0-9]/g, '');
  return digits;
}

/**
 * Trigger check: broker should run iff a pairing phone + control plane are
 * configured AND no creds exist yet. Returns the resolved inputs or null.
 */
export function pairingBrokerInputs(): {
  phone: string;
  url: string;
  token: string;
} | null {
  const phone = pairingPhone();
  if (!phone) return null;
  const cfg = controlPlaneConfig();
  if (!cfg) return null; // requires CONTROL_PLANE_URL (+ TOKEN)
  if (whatsappCredsExist()) return null; // already paired
  return { phone, url: cfg.url, token: cfg.token };
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

/** POST a fresh pairing code to the control plane. Never throws. */
export async function postPairingCode(
  url: string,
  token: string,
  code: string,
  phone: string,
): Promise<void> {
  try {
    const res = await fetchWithTimeout(
      `${url}/api/instance/whatsapp/pairing-code`,
      {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ code, phone }),
      },
    );
    if (!res.ok) {
      logger.warn(
        { status: res.status },
        'whatsapp-pairing-broker: pairing-code POST non-200',
      );
    }
  } catch (err) {
    logger.warn(
      { err },
      'whatsapp-pairing-broker: pairing-code POST failed — continuing',
    );
  }
}

/** POST the paired notification to the control plane. Never throws. */
export async function postPaired(
  url: string,
  token: string,
  phone: string,
): Promise<void> {
  try {
    const res = await fetchWithTimeout(`${url}/api/instance/whatsapp/paired`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ phone }),
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status },
        'whatsapp-pairing-broker: paired POST non-200',
      );
    }
  } catch (err) {
    logger.warn(
      { err },
      'whatsapp-pairing-broker: paired POST failed',
    );
  }
}

/**
 * Run the hosted pairing broker if its trigger conditions are met. Blocks until
 * the phone is paired (creds saved), the ~10 minute cap elapses, or a terminal
 * error — then returns. Callers run this BEFORE connecting the WhatsApp channel
 * so the channel picks up the freshly-saved creds in-process. No-op (returns
 * immediately) when the trigger conditions aren't met. NEVER throws.
 *
 * Returns true if pairing succeeded (creds saved), false otherwise.
 */
export async function runWhatsAppPairingBroker(): Promise<boolean> {
  const inputs = pairingBrokerInputs();
  if (!inputs) return false;
  const { phone, url, token } = inputs;

  logger.info(
    { phone: phone.slice(0, 4) + '…' },
    'whatsapp-pairing-broker: no creds + hosted mode — starting pairing',
  );

  const authDir = whatsappAuthDir();
  fs.mkdirSync(authDir, { recursive: true });

  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let capTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    const session = await runPairingSession({
      authDir,
      phone,
      onPairingCode: (code) => {
        // Fire-and-forget relay; postPairingCode never throws.
        void postPairingCode(url, token, code, phone);
      },
      onClose: (reason) => {
        logger.warn(
          { reason },
          'whatsapp-pairing-broker: connection closed before pairing',
        );
      },
    });

    // Request the first code once the socket is up, then refresh on expiry.
    const requestAndRelay = () => {
      session.requestPairingCode().catch((err) => {
        logger.warn(
          { err },
          'whatsapp-pairing-broker: requestPairingCode failed',
        );
      });
    };
    // Small delay for the connection to initialize before the first request.
    setTimeout(requestAndRelay, 3000).unref?.();
    refreshTimer = setInterval(requestAndRelay, CODE_REFRESH_MS);
    refreshTimer.unref?.();

    // Overall cap: resolve to a timeout after ~10 minutes.
    const capped = new Promise<'timeout'>((resolve) => {
      capTimer = setTimeout(() => resolve('timeout'), OVERALL_CAP_MS);
      capTimer.unref?.();
    });

    const result = await Promise.race([session.done, capped]);
    session.close();

    if (result === 'authenticated') {
      logger.info('whatsapp-pairing-broker: paired successfully');
      await postPaired(url, token, phone);
      return true;
    }
    if (result === 'timeout') {
      logger.warn(
        { capMs: OVERALL_CAP_MS },
        'whatsapp-pairing-broker: pairing timed out (user did not link in time)',
      );
      return false;
    }
    logger.warn(
      { failed: (result as { failed: unknown }).failed },
      'whatsapp-pairing-broker: pairing failed',
    );
    return false;
  } catch (err) {
    // Defensive: runPairingSession shouldn't throw, but never let it crash boot.
    logger.warn({ err }, 'whatsapp-pairing-broker: unexpected error — skipping');
    return false;
  } finally {
    if (refreshTimer) clearInterval(refreshTimer);
    if (capTimer) clearTimeout(capTimer);
  }
}
