/**
 * Shared Google OAuth for the Google knowledge connectors.
 *
 * Every Google connector (Drive, Calendar, …) authenticates the SAME way: by
 * reusing the credentials the bundled `gws` (Google Workspace CLI) tool
 * already uses — the JSON pointed at by `GOOGLE_WORKSPACE_CREDENTIALS_FILE`.
 * This module IS that one mechanism, lifted verbatim out of `google-drive.ts`
 * so that a second Google connector cannot grow a second one. A new Google
 * source imports from here; it must not add its own token handling, must not
 * ask the operator to configure Google auth twice, and must not import
 * `googleapis` (no new dependencies — plain `fetch`, like every connector).
 *
 * `resolveGoogleWorkspaceCredsPath` is a minimal replica of the resolver in
 * `src/container-runner.ts` (~lines 890-940); it is duplicated rather than
 * imported because that module pulls heavy container/runtime deps. Keep the
 * two in sync if the resolution rules change.
 *
 * Nothing here ever logs or interpolates token material: a creds file that
 * won't parse, an expired bundle, and a rejected refresh all surface as a
 * `GoogleApiError` whose message carries a status code and nothing else.
 */

import fs from 'fs';

import { readEnvFile } from '../../env.js';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Typed error for Google auth/API failures (auth, malformed creds, non-2xx).
 * Messages are always non-secret — never interpolate token material. */
export class GoogleApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

// --- Creds path resolution --------------------------------------------------

/**
 * Resolve the host path to the Google Workspace CLI credentials file. Minimal
 * replica of `resolveGoogleWorkspaceCredsPath` in `src/container-runner.ts`
 * (we don't import it to avoid pulling that module's heavy deps). Reads
 * `GOOGLE_WORKSPACE_CREDENTIALS_FILE` from `.env` (process.env fallback) and
 * requires the path to exist and be a regular file. Returns undefined when
 * unset/invalid — a connector then reports itself unconfigured.
 */
export function resolveGoogleWorkspaceCredsPath(): string | undefined {
  const raw =
    readEnvFile(['GOOGLE_WORKSPACE_CREDENTIALS_FILE'])
      .GOOGLE_WORKSPACE_CREDENTIALS_FILE ||
    process.env.GOOGLE_WORKSPACE_CREDENTIALS_FILE;
  if (!raw) return undefined;

  let realPath: string;
  try {
    realPath = fs.realpathSync(raw);
  } catch {
    return undefined;
  }
  try {
    if (!fs.statSync(realPath).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return realPath;
}

// --- Access token loading ---------------------------------------------------

/** Shapes we accept in the gws creds JSON. Token material may live at the top
 * level, or be nested under a `tokens`/`credentials` object, or under a single
 * top-level account key (gws stores per-account entries keyed by email). */
interface RawTokenBundle {
  access_token?: string;
  token?: string;
  expiry?: string | number;
  expires_at?: string | number;
  expiry_date?: string | number;
  refresh_token?: string;
  client_id?: string;
  client_secret?: string;
}

/** Reads a creds file's parsed JSON. Injectable so tests need no real creds. */
export type CredsReader = () => unknown;

/** Default creds reader: resolve the path and parse the JSON off disk. */
function defaultCredsReader(): unknown {
  const credsPath = resolveGoogleWorkspaceCredsPath();
  if (!credsPath) {
    throw new GoogleApiError(
      'GOOGLE_WORKSPACE_CREDENTIALS_FILE is not set or does not resolve to a file',
    );
  }
  let text: string;
  try {
    text = fs.readFileSync(credsPath, 'utf-8');
  } catch {
    throw new GoogleApiError(
      'unable to read Google Workspace credentials file',
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GoogleApiError(
      'Google Workspace credentials file is not valid JSON',
    );
  }
}

/** True when an access token has an expiry that is already in the past. A
 * missing expiry is treated as usable (many gws bundles omit it). */
function isExpired(bundle: RawTokenBundle): boolean {
  const raw = bundle.expiry ?? bundle.expires_at ?? bundle.expiry_date;
  if (raw == null) return false;
  const ms =
    typeof raw === 'number'
      ? // Heuristic: 10-digit values are unix seconds, 13-digit are ms.
        raw < 1e12
        ? raw * 1000
        : raw
      : Date.parse(String(raw));
  if (Number.isNaN(ms)) return false;
  // 60s skew so we don't hand back a token about to expire mid-request.
  return ms <= Date.now() + 60_000;
}

/** Pull the first plausible token bundle out of a parsed creds object,
 * tolerating the couple of nesting shapes gws is known to emit. */
function findTokenBundle(parsed: unknown): RawTokenBundle | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const obj = parsed as Record<string, unknown>;

  const looksLikeBundle = (v: unknown): v is RawTokenBundle => {
    if (!v || typeof v !== 'object') return false;
    const b = v as RawTokenBundle;
    return (
      typeof b.access_token === 'string' ||
      typeof b.token === 'string' ||
      typeof b.refresh_token === 'string'
    );
  };

  // (a) top-level bundle
  if (looksLikeBundle(obj)) return obj as RawTokenBundle;
  // (b) nested under a well-known key
  for (const key of ['tokens', 'credentials', 'token', 'installed', 'web']) {
    if (looksLikeBundle(obj[key])) return obj[key] as RawTokenBundle;
  }
  // (c) per-account map: pick the first value that looks like a bundle
  for (const v of Object.values(obj)) {
    if (looksLikeBundle(v)) return v as RawTokenBundle;
    // one more level down (e.g. { "user@x": { tokens: {...} } })
    if (v && typeof v === 'object') {
      for (const inner of Object.values(v as Record<string, unknown>)) {
        if (looksLikeBundle(inner)) return inner as RawTokenBundle;
      }
    }
  }
  return undefined;
}

/**
 * Load a usable Google API access token, reusing the gws credentials file.
 *
 * 1. Parse the creds JSON (via `readCreds`, injectable for tests).
 * 2. If it carries a usable, unexpired `access_token`/`token`, return it — no
 *    network.
 * 3. Otherwise, if it carries `refresh_token` + `client_id` + `client_secret`,
 *    POST a `grant_type=refresh_token` request to Google's OAuth token endpoint
 *    and return the minted access token.
 * 4. If no token material is found, throw a `GoogleApiError` with a
 *    non-secret message.
 *
 * Deliberately stateless — nothing is cached between calls. A caller that hits
 * a 401 mid-run can therefore simply call this again to pick up a token the
 * credentials file has since been rewritten with (see the Calendar connector's
 * re-auth path).
 *
 * Never logs or interpolates token/secret values.
 */
export async function loadGoogleAccessToken(
  fetchImpl: typeof fetch,
  readCreds: CredsReader = defaultCredsReader,
): Promise<string> {
  const parsed = readCreds();
  const bundle = findTokenBundle(parsed);
  if (!bundle) {
    throw new GoogleApiError(
      'no usable Google token material found in credentials file',
    );
  }

  const direct = bundle.access_token || bundle.token;
  if (direct && !isExpired(bundle)) return direct;

  if (bundle.refresh_token && bundle.client_id && bundle.client_secret) {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: bundle.refresh_token,
      client_id: bundle.client_id,
      client_secret: bundle.client_secret,
    });
    const res = await fetchImpl(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      // Body may echo the client_secret in an error — do NOT include it.
      throw new GoogleApiError(
        `Google OAuth token refresh failed (HTTP ${res.status})`,
        res.status,
      );
    }
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) {
      throw new GoogleApiError(
        'Google OAuth token refresh returned no access_token',
      );
    }
    return json.access_token;
  }

  // We had a bundle but it was expired with no way to refresh, or missing
  // client material — either way we can't produce a valid token.
  if (direct) {
    throw new GoogleApiError(
      'Google access token is expired and no refresh material is available',
    );
  }
  throw new GoogleApiError(
    'Google credentials file lacks a usable access_token or refresh_token+client_id+client_secret',
  );
}

// --- Authenticated reads ----------------------------------------------------

/**
 * Authenticated GET against a Google API endpoint returning parsed JSON.
 * Shared by every Google connector so the bearer-header shape and the
 * non-2xx → typed-error translation stay identical across them.
 *
 * 401/403 are auth problems the caller must decide about (Drive treats them as
 * fatal and aborts the run; Calendar re-reads the credential and retries once)
 * — the status is carried on the error so that decision is possible.
 */
export async function googleApiGet<T>(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<T> {
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new GoogleApiError(
      `Google API HTTP ${res.status}: ${text.slice(0, 200)}`,
      res.status,
    );
  }
  return (await res.json()) as T;
}
