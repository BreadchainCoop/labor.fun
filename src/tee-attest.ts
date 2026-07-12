/**
 * TEE attestation via the dstack guest API.
 *
 * When labor.fun runs inside a dstack / Phala Intel-TDX Confidential VM (CVM),
 * a guest agent exposes an HTTP API over a unix socket (default
 * `/var/run/dstack.sock`). We use it to answer a user's `!verify <nonce>`:
 * generate a fresh TDX quote that cryptographically binds the caller's nonce
 * (in `report_data`), so anyone can confirm the attestation is fresh and the
 * running code matches the published `compose_hash`.
 *
 * dstack guest API (see https://github.com/Dstack-TEE/dstack sdk/curl/api.md):
 *   GET  http://dstack/Info      → { app_id, instance_id, app_name,
 *                                     compose_hash, tcb_info, ... }
 *   POST http://dstack/GetQuote  { report_data: <hex, max 64 bytes> }
 *                                → { quote (hex), event_log, report_data, ... }
 *
 * This module deliberately has NO channel/db dependencies so it can be unit
 * tested with the socket call stubbed. `TEE_MODE` gating and the reply text
 * live in the Signal channel; here we only talk to the socket and shape data.
 */
import crypto from 'crypto';
import fs from 'fs';
import { request as httpRequest } from 'http';

/** Default dstack guest socket path; overridable via DSTACK_SOCKET_PATH. */
export const DEFAULT_DSTACK_SOCKET = '/var/run/dstack.sock';

/** Public quote verifier linked in !verify replies; overridable via TEE_VERIFY_URL. */
export const DEFAULT_VERIFY_URL = 'https://proof.phala.network';

/** Max bytes dstack accepts for report_data. Larger inputs must be hashed. */
const REPORT_DATA_MAX_BYTES = 64;

/** Subset of GET /Info we surface in the reply. Extra fields are ignored. */
export interface DstackInfo {
  app_id?: string;
  instance_id?: string;
  app_name?: string;
  compose_hash?: string;
  [k: string]: unknown;
}

/** Subset of POST /GetQuote we surface in the reply. */
export interface DstackQuote {
  /** Hex-encoded TDX quote. */
  quote: string;
  /** Hex-encoded report_data that was embedded (echoed by dstack). */
  report_data?: string;
  [k: string]: unknown;
}

/**
 * The report_data bytes for a nonce, plus whether it was hashed.
 *
 * A nonce that fits in 64 bytes is embedded verbatim (the verifier can recover
 * it with `echo -n '<nonce>' | xxd -p`). A longer value is reduced with
 * SHA-512/256 (a 32-byte digest that fits comfortably), matching the
 * "SHA-512/256 or direct embed" contract; the verifier recomputes with
 * `openssl dgst -sha512-256`.
 */
export function reportDataForNonce(nonce: string): {
  bytes: Buffer;
  hashed: boolean;
} {
  const raw = Buffer.from(nonce, 'utf8');
  if (raw.length <= REPORT_DATA_MAX_BYTES) {
    return { bytes: raw, hashed: false };
  }
  const digest = crypto.createHash('sha512-256').update(raw).digest();
  return { bytes: digest, hashed: true };
}

/** URL-safe nonce accepted from `!verify`: 8–64 chars of [A-Za-z0-9_-]. */
const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** True when `nonce` is a well-formed `!verify` challenge. */
export function isValidNonce(nonce: string): boolean {
  return NONCE_RE.test(nonce);
}

/**
 * Parse the nonce out of a `!verify <nonce>` command. Returns:
 *   { kind: 'ok', nonce }        — valid command with a valid nonce
 *   { kind: 'missing' }          — `!verify` with no argument
 *   { kind: 'invalid', arg }     — `!verify` with a malformed argument
 *   null                         — not a `!verify` command at all
 */
export function parseVerifyCommand(
  text: string,
):
  | { kind: 'ok'; nonce: string }
  | { kind: 'missing' }
  | { kind: 'invalid'; arg: string }
  | null {
  const trimmed = (text || '').trim();
  if (trimmed !== '!verify' && !trimmed.startsWith('!verify ')) return null;
  const arg = trimmed.slice('!verify'.length).trim();
  if (!arg) return { kind: 'missing' };
  if (!isValidNonce(arg)) return { kind: 'invalid', arg };
  return { kind: 'ok', nonce: arg };
}

/** Minimal HTTP-over-unix-socket client for the dstack guest API. */
export class DstackClient {
  private socketPath: string;

  constructor(socketPath: string = DEFAULT_DSTACK_SOCKET) {
    this.socketPath = socketPath;
  }

  /** True only when the guest socket exists (i.e. we're plausibly in a CVM). */
  socketPresent(): boolean {
    try {
      return fs.existsSync(this.socketPath);
    } catch {
      return false;
    }
  }

  /** GET /Info — app_id, instance_id, compose_hash, etc. */
  async getInfo(): Promise<DstackInfo> {
    const body = await this.request('GET', '/Info');
    return JSON.parse(body) as DstackInfo;
  }

  /** POST /GetQuote with report_data = the nonce (or its hash). */
  async getQuote(reportData: Buffer): Promise<DstackQuote> {
    const clamped = reportData.subarray(0, REPORT_DATA_MAX_BYTES);
    const body = await this.request(
      'POST',
      '/GetQuote',
      JSON.stringify({ report_data: clamped.toString('hex') }),
    );
    return JSON.parse(body) as DstackQuote;
  }

  /**
   * HTTP over the unix socket. dstack ignores the host, so we use a fixed
   * `http://dstack` origin and route via `socketPath`. Rejects if the socket
   * is missing (callers gate on socketPresent() first, but this is a
   * belt-and-suspenders guard so a race degrades to an error, never a crash).
   */
  private request(
    method: 'GET' | 'POST',
    path: string,
    payload?: string,
  ): Promise<string> {
    if (!this.socketPresent()) {
      return Promise.reject(
        new Error(`dstack socket not found at ${this.socketPath}`),
      );
    }
    return new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(payload
              ? { 'Content-Length': Buffer.byteLength(payload) }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode || 0;
            if (status < 200 || status >= 300) {
              reject(new Error(`dstack ${path} HTTP ${status}: ${text}`));
              return;
            }
            resolve(text);
          });
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
}

/** Structured result of an attestation attempt, ready to render as a reply. */
export interface AttestationResult {
  inTee: boolean;
  nonce: string;
  reportDataHex?: string;
  wasHashed?: boolean;
  quote?: string;
  composeHash?: string;
  appId?: string;
  instanceId?: string;
  verifyUrl: string;
  error?: string;
}

export interface AttestOptions {
  socketPath?: string;
  verifyUrl?: string;
  /** Injected for tests; defaults to a real DstackClient. */
  client?: Pick<DstackClient, 'socketPresent' | 'getInfo' | 'getQuote'>;
}

/**
 * Produce an attestation for `nonce`. Never throws: a missing socket or a
 * failing dstack call is captured in the result so the caller can always reply
 * honestly instead of crashing.
 */
export async function attestNonce(
  nonce: string,
  opts: AttestOptions = {},
): Promise<AttestationResult> {
  const verifyUrl = opts.verifyUrl || DEFAULT_VERIFY_URL;
  const client =
    opts.client || new DstackClient(opts.socketPath || DEFAULT_DSTACK_SOCKET);

  if (!client.socketPresent()) {
    return { inTee: false, nonce, verifyUrl };
  }

  const { bytes, hashed } = reportDataForNonce(nonce);
  const reportDataHex = bytes.toString('hex');

  try {
    // Info first: even if quote generation fails we can still show which app
    // is attesting. Both are needed for a full, trustworthy reply.
    const [info, quote] = await Promise.all([
      client.getInfo(),
      client.getQuote(bytes),
    ]);
    return {
      inTee: true,
      nonce,
      reportDataHex,
      wasHashed: hashed,
      quote: quote.quote,
      composeHash: info.compose_hash,
      appId: info.app_id,
      instanceId: info.instance_id,
      verifyUrl,
    };
  } catch (err) {
    // Socket present but the call failed — we ARE in a TEE, but attestation
    // is degraded. Report the error rather than claiming success or crashing.
    return {
      inTee: true,
      nonce,
      reportDataHex,
      wasHashed: hashed,
      verifyUrl,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Chunk a long string every `size` chars (keeps quotes readable on Signal). */
function chunk(s: string, size: number): string {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out.join('\n');
}

/** Render an AttestationResult as the Signal reply text for `!verify`. */
export function formatAttestationReply(r: AttestationResult): string {
  if (!r.inTee) {
    return [
      '⚠️ NOT RUNNING IN A TEE',
      '',
      'This instance is not running inside a Trusted Execution Environment, ',
      'so I cannot produce a hardware attestation. Your messages are not ',
      'protected by TEE isolation here.',
    ].join('');
  }

  const lines: string[] = ['🔐 TEE Attestation', ''];
  lines.push(`Nonce: ${r.nonce}`);

  if (r.reportDataHex) {
    lines.push('', 'Report data (hex, embedded in the quote):');
    lines.push('```', r.reportDataHex, '```');
    lines.push(
      r.wasHashed
        ? '(SHA-512/256 of your nonce — verify: `openssl dgst -sha512-256`)'
        : "(your nonce in hex — verify: `echo -n '<nonce>' | xxd -p`)",
    );
  }

  lines.push('', 'TEE info:');
  if (r.appId) lines.push(`- App ID: ${r.appId}`);
  if (r.instanceId) lines.push(`- Instance ID: ${r.instanceId}`);
  if (r.composeHash) lines.push(`- Compose hash: ${r.composeHash}`);

  if (r.error) {
    lines.push('', `⚠️ Quote generation failed: ${r.error}`);
    lines.push('The dstack socket is present but attestation is degraded.');
    return lines.join('\n');
  }

  if (r.quote) {
    lines.push('', 'TDX quote (hex):', '```', chunk(r.quote, 64), '```');
  }

  lines.push('', 'Verify this quote:');
  lines.push(`1. Paste the quote at ${r.verifyUrl}`);
  lines.push('2. Confirm the report_data matches the hex above (your nonce).');
  lines.push(
    '3. Confirm the compose hash matches the published deploy/tee/docker-compose.tee.yaml.',
  );

  return lines.join('\n');
}
