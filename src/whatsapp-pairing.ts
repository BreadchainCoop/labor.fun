/**
 * Shared WhatsApp pairing-session logic.
 *
 * Extracted from src/whatsapp-auth.ts so the same baileys connect/pairing
 * flow drives BOTH:
 *   - the interactive setup CLI (`npx tsx src/whatsapp-auth.ts`), and
 *   - the hosted pairing broker (src/integrations/whatsapp-pairing-broker.ts),
 *     which relays pairing codes to the control plane instead of a terminal.
 *
 * The function opens a baileys socket, (optionally) requests a phone pairing
 * code, and resolves once the connection reaches 'open' (authenticated) or a
 * terminal error occurs. Pairing codes expire after ~60s, so the caller can
 * request a fresh one via the returned handle's `requestPairingCode()`.
 */
import type { WASocket } from '@whiskeysockets/baileys';
import {
  makeWASocket,
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';

// Fix Baileys 6.x bug: getPlatformId sends charCode (49) instead of enum value
// (1). Fixed in Baileys 7.x but not backported. Without this, pairing codes
// fail with "couldn't link device" because WhatsApp receives an invalid
// platform ID. NOTE: Must use createRequire — ESM `import *` creates a
// read-only namespace.
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const _generics = _require(
  '@whiskeysockets/baileys/lib/Utils/generics',
) as Record<string, unknown>;
const { proto } = _require('@whiskeysockets/baileys') as { proto: any };
_generics.getPlatformId = (browser: string): string => {
  const platformType =
    proto.DeviceProps.PlatformType[
      browser.toUpperCase() as keyof typeof proto.DeviceProps.PlatformType
    ];
  return platformType ? platformType.toString() : '1';
};

const baileysLogger = pino({ level: 'warn' });

export interface PairingSessionOptions {
  /** Directory for baileys multi-file auth state (creds.json lives here). */
  authDir: string;
  /**
   * Phone number (country code + number, digits only, no + or spaces) to
   * request a pairing code for. When omitted, the socket surfaces a QR code
   * via `onQr` instead.
   */
  phone?: string;
  /** Called with the raw QR string whenever baileys emits one (QR flow). */
  onQr?: (qr: string) => void;
  /**
   * Called each time a fresh pairing code is generated. Codes expire ~60s
   * after issue; re-request via the handle's `requestPairingCode()`.
   */
  onPairingCode?: (code: string) => void;
  /** Called once the connection is authenticated ('open'). */
  onOpen?: () => void;
  /** Called on a terminal connection failure with the numeric reason code. */
  onClose?: (reason: number | undefined) => void;
}

export interface PairingSessionHandle {
  /** Resolves 'authenticated' on success, or a terminal failure reason. */
  done: Promise<'authenticated' | { failed: number | 'unknown' }>;
  /** Request a fresh pairing code (returns the code, or throws). */
  requestPairingCode: () => Promise<string>;
  /** Tear the socket down (idempotent). */
  close: () => void;
}

/**
 * Open a baileys socket and drive a pairing/QR session. Never process.exit()s —
 * callers decide what to do on completion. If creds are already registered,
 * resolves 'authenticated' immediately without opening a socket.
 */
export async function runPairingSession(
  opts: PairingSessionOptions,
): Promise<PairingSessionHandle> {
  const { authDir, phone } = opts;

  let sock: WASocket | undefined;
  let closed = false;
  let resolveDone!: (
    v: 'authenticated' | { failed: number | 'unknown' },
  ) => void;
  const done = new Promise<'authenticated' | { failed: number | 'unknown' }>(
    (resolve) => {
      resolveDone = resolve;
    },
  );

  const teardown = () => {
    if (closed) return;
    closed = true;
    try {
      sock?.end?.(undefined);
    } catch {
      /* best-effort */
    }
  };

  async function connect(isReconnect = false): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    // Already authenticated — nothing to do.
    if (state.creds.registered && !isReconnect) {
      resolveDone('authenticated');
      return;
    }

    const { version } = await fetchLatestWaWebVersion({}).catch(() => ({
      version: undefined,
    }));

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      printQRInTerminal: false,
      logger: baileysLogger,
      browser: Browsers.macOS('Chrome'),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && opts.onQr) opts.onQr(qr);

      if (connection === 'close') {
        const reason = (
          lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;
        if (reason === 515) {
          // 515 = stream error, common after pairing succeeds but before
          // registration completes. Reconnect to finish the handshake.
          connect(true).catch(() => {
            opts.onClose?.(reason);
            resolveDone({ failed: reason ?? 'unknown' });
          });
          return;
        }
        if (
          reason === DisconnectReason.loggedOut ||
          reason === DisconnectReason.timedOut ||
          reason !== undefined
        ) {
          opts.onClose?.(reason);
          resolveDone({ failed: reason ?? 'unknown' });
          teardown();
        }
      }

      if (connection === 'open') {
        opts.onOpen?.();
        // Give baileys a moment to flush creds to disk before resolving.
        setTimeout(() => {
          resolveDone('authenticated');
          teardown();
        }, 1000);
      }
    });
  }

  const requestPairingCode = async (): Promise<string> => {
    if (!sock) throw new Error('socket not ready');
    if (!phone) throw new Error('no phone number for pairing code');
    const code = await sock.requestPairingCode(phone);
    opts.onPairingCode?.(code);
    return code;
  };

  await connect();

  return { done, requestPairingCode, close: teardown };
}
