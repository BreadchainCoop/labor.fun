/**
 * Inference attestation surface.
 *
 * Exposes what inference provider is serving agent turns and, for TEE-attested
 * providers (NEAR AI Cloud), a helper that fetches the live cryptographic
 * attestation report. Intended for a verification flow (e.g. the Signal
 * `!verify` command) to surface "inference: NEAR AI TEE" info to end users.
 *
 * Design notes:
 * - This is a light-touch v1. NEAR AI Cloud DOES expose a queryable attestation
 *   endpoint (GET <base>/attestation/report — see fetchNearAiAttestation), so
 *   we return live hardware-quote evidence when reachable and the static
 *   provider descriptor otherwise.
 * - For the hosted Anthropic ('claude') backend and generic OpenAI-compatible
 *   endpoints (LM Studio, vLLM, …) there is no standard attestation endpoint,
 *   so we return static provider info only and say so.
 * - No secrets are logged or returned. The NEAR AI key is sent only as the
 *   Bearer header on the attestation request.
 */

import {
  NANOCLAW_BACKEND,
  NEAR_AI_MODE,
  NEAR_AI_API_KEY,
  LOCAL_LLM_BASE_URL,
  LOCAL_LLM_MODEL,
} from './config.js';
import { logger } from './logger.js';

/** Which inference stack is active, at a glance. */
export type InferenceProvider = 'anthropic' | 'near-ai' | 'openai-compatible';

export interface InferenceProviderInfo {
  provider: InferenceProvider;
  /** Human-readable one-liner for a `!verify`-style response. */
  label: string;
  /** True when the provider runs inside a Trusted Execution Environment. */
  tee: boolean;
  /** True when the stack contains NO Anthropic/Claude dependency. */
  openSource: boolean;
  /** Model identifier in use (undefined for hosted Anthropic — SDK-selected). */
  model?: string;
  /** Base URL of the inference endpoint (undefined for hosted Anthropic). */
  baseUrl?: string;
}

/**
 * NEAR AI attestation report as returned by
 * GET <base>/attestation/report?model=...&signing_algo=ecdsa[&nonce=...].
 * See https://docs.near.ai/cloud/verification/model/.
 */
export interface NearAiAttestation {
  /** TEE public key the model TEE signs responses with. */
  signing_address?: string;
  /** NVIDIA confidential-GPU attestation payload (verify via NVIDIA NRAS). */
  nvidia_payload?: unknown;
  /** Intel TDX quote (verify via the dcap-qvl library). */
  intel_quote?: unknown;
  [k: string]: unknown;
}

export interface InferenceVerification extends InferenceProviderInfo {
  /**
   * Live attestation report, when the provider exposes one and it was
   * reachable. Absent for non-attested providers or on fetch failure.
   */
  attestation?: NearAiAttestation;
  /** Present when attestation was expected but could not be fetched. */
  attestationError?: string;
}

/**
 * Static provider descriptor derived from config. Always available, no network.
 */
export function getInferenceProviderInfo(): InferenceProviderInfo {
  if (NANOCLAW_BACKEND !== 'local') {
    return {
      provider: 'anthropic',
      label: 'Hosted Anthropic (Claude) via credential proxy',
      tee: false,
      openSource: false,
    };
  }

  if (NEAR_AI_MODE) {
    return {
      provider: 'near-ai',
      label:
        'NEAR AI Cloud — open-weight model in an Intel TDX + NVIDIA confidential-GPU TEE',
      tee: true,
      openSource: true,
      model: LOCAL_LLM_MODEL,
      baseUrl: LOCAL_LLM_BASE_URL,
    };
  }

  return {
    provider: 'openai-compatible',
    label: `OpenAI-compatible endpoint (${LOCAL_LLM_BASE_URL})`,
    tee: false,
    openSource: true,
    model: LOCAL_LLM_MODEL,
    baseUrl: LOCAL_LLM_BASE_URL,
  };
}

/**
 * True when the active provider is NEAR AI Cloud and we can query its
 * attestation endpoint.
 */
export function isAttestationAvailable(): boolean {
  return NEAR_AI_MODE && !!NEAR_AI_API_KEY;
}

/** 32 random bytes as a 64-char hex nonce, for attestation freshness. */
function makeNonce(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Fetch NEAR AI Cloud's live attestation report for the active model.
 *
 * Queries GET <base>/attestation/report?model=...&signing_algo=ecdsa&nonce=...
 * The report binds the exact code + weights serving inference to a hardware
 * quote (Intel TDX) and a confidential-GPU quote (NVIDIA). Returns undefined
 * (and logs) on any error, so callers can degrade to static provider info.
 *
 * @param signal optional AbortSignal to bound the request.
 */
export async function fetchNearAiAttestation(
  signal?: AbortSignal,
): Promise<NearAiAttestation | undefined> {
  if (!isAttestationAvailable()) return undefined;

  const model = LOCAL_LLM_MODEL || '';
  const nonce = makeNonce();
  // LOCAL_LLM_BASE_URL already ends in /v1 for NEAR AI; the report lives under it.
  const base = LOCAL_LLM_BASE_URL.replace(/\/+$/, '');
  const url =
    `${base}/attestation/report` +
    `?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${nonce}`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${NEAR_AI_API_KEY}`,
        Accept: 'application/json',
      },
      signal,
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status, model },
        'NEAR AI attestation request failed',
      );
      return undefined;
    }
    const report = (await res.json()) as NearAiAttestation;
    // Sanity: the returned quote should not echo our nonce anywhere it would
    // leak; we only log presence of fields, never their values.
    logger.info(
      {
        model,
        hasSigningAddress: !!report.signing_address,
        hasNvidiaPayload: !!report.nvidia_payload,
        hasIntelQuote: !!report.intel_quote,
      },
      'Fetched NEAR AI attestation report',
    );
    return report;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), model },
      'NEAR AI attestation fetch error',
    );
    return undefined;
  }
}

/**
 * One-call verification surface for a `!verify`-style flow: static provider
 * info plus a live NEAR AI attestation report when available. Never throws;
 * degrades to static info on any attestation error.
 *
 * @param opts.fetchAttestation set false to skip the network call (static only).
 * @param opts.signal optional AbortSignal to bound the attestation request.
 */
export async function getInferenceVerification(opts?: {
  fetchAttestation?: boolean;
  signal?: AbortSignal;
}): Promise<InferenceVerification> {
  const info = getInferenceProviderInfo();
  const fetchAttestation = opts?.fetchAttestation ?? true;

  if (!fetchAttestation || !isAttestationAvailable()) {
    return info;
  }

  const attestation = await fetchNearAiAttestation(opts?.signal);
  if (attestation) return { ...info, attestation };
  return { ...info, attestationError: 'attestation report unavailable' };
}
