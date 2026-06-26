// Agenda-web service: serves the StatiCrypt-encrypted weekly-agenda corrector
// pages on a public port, and (re)publishes them from page-data JSON the build
// agent writes into the KB. Run as a long-lived systemd service on the droplet.
//
// Pipeline per week:
//   build agent → writes  <pageDataDir>/<week>.json   (structured agenda data)
//   this service → render.mjs → plaintext HTML → `staticrypt` (password) →
//                  <serveDir>/<week>.html  (encrypted) → served on :PORT
//
// The page is StatiCrypt-encrypted, so serving it on a public port only ever
// exposes ciphertext; the shared co-op password gates the content client-side.
//
// Served over HTTPS: StatiCrypt decrypts via the Web Crypto API, which browsers
// only expose in a SECURE CONTEXT (HTTPS or localhost) — over plain HTTP to a
// public IP `crypto.subtle` is undefined and decryption fails. We serve TLS with
// a self-signed cert (auto-generated if absent); members accept a one-time
// browser warning, then decryption works. Point a real cert via env for no warning.
//
// Env:
//   AGENDA_WEB_PORT        (default 8091)  — public port to serve on
//   AGENDA_WEB_DIR         — directory of published encrypted *.html (served)
//   AGENDA_PAGEDATA_DIR    — directory the build agent writes <week>.json into
//   AGENDA_WEB_PASSWORD    — shared StatiCrypt password (must match config.md)
//   AGENDA_WEB_TLS_DIR     — where the self-signed cert/key live (keep OFF the
//                            deploy path so it survives deploys). Or set
//                            AGENDA_WEB_TLS_CERT / AGENDA_WEB_TLS_KEY to a real cert.
//   AGENDA_PUBLISH_INTERVAL_MS (default 120000) — rescan cadence
//   STATICRYPT_BIN         (default: node_modules/.bin/staticrypt)

import { execFileSync } from 'child_process';
import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { renderAgendaPage } from './render.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.AGENDA_WEB_PORT) || 8091;
const SERVE_DIR = process.env.AGENDA_WEB_DIR || path.join(HERE, 'published');
const PAGEDATA_DIR = process.env.AGENDA_PAGEDATA_DIR || path.join(HERE, 'page-data');
const PASSWORD = process.env.AGENDA_WEB_PASSWORD || '';
const INTERVAL = Number(process.env.AGENDA_PUBLISH_INTERVAL_MS) || 120_000;
const STATICRYPT_BIN =
  process.env.STATICRYPT_BIN ||
  path.join(HERE, '..', '..', 'node_modules', '.bin', 'staticrypt');

const log = (...a) => console.log(new Date().toISOString(), '[agenda-web]', ...a);

/** A published file is stale if its JSON source is newer (or it doesn't exist). */
function needsPublish(week) {
  const out = path.join(SERVE_DIR, `${week}.html`);
  const src = path.join(PAGEDATA_DIR, `${week}.json`);
  if (!fs.existsSync(out)) return true;
  try {
    return fs.statSync(src).mtimeMs > fs.statSync(out).mtimeMs;
  } catch {
    return false;
  }
}

/** Render <week>.json → plaintext HTML → staticrypt-encrypted <serveDir>/<week>.html. */
function publish(week) {
  if (!PASSWORD) {
    log('skip', week, '— AGENDA_WEB_PASSWORD not set');
    return;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(PAGEDATA_DIR, `${week}.json`), 'utf-8'));
  } catch (err) {
    log('skip', week, '— bad/missing JSON:', err.message);
    return;
  }
  fs.mkdirSync(SERVE_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-'));
  const plain = path.join(tmp, `${week}.html`);
  fs.writeFileSync(plain, renderAgendaPage(data));
  try {
    // staticrypt keeps the basename, writing <SERVE_DIR>/<week>.html (encrypted).
    execFileSync(STATICRYPT_BIN, [plain, '-p', PASSWORD, '--short', '-d', SERVE_DIR], {
      stdio: 'pipe',
    });
    log('published', week);
  } catch (err) {
    log('encrypt failed for', week, '—', err.message);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function publishSweep() {
  if (!fs.existsSync(PAGEDATA_DIR)) return;
  for (const f of fs.readdirSync(PAGEDATA_DIR)) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
    if (m && needsPublish(m[1])) publish(m[1]);
  }
}

/** Load the TLS cert/key, generating a self-signed pair if none is configured. */
function loadTls() {
  const dir = process.env.AGENDA_WEB_TLS_DIR || path.join(HERE, 'tls');
  const certPath = process.env.AGENDA_WEB_TLS_CERT || path.join(dir, 'cert.pem');
  const keyPath = process.env.AGENDA_WEB_TLS_KEY || path.join(dir, 'key.pem');
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    fs.mkdirSync(path.dirname(certPath), { recursive: true });
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath,
       '-out', certPath, '-days', '3650', '-subj', '/CN=agenda-web'],
      { stdio: 'pipe' },
    );
    log('generated self-signed cert at', certPath);
  }
  return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
}

// --- static file server (encrypted pages only), over HTTPS (secure context
// required for StatiCrypt's Web Crypto decryption) ---
const server = https.createServer(loadTls(), (req, res) => {
  // Only serve *.html basenames from SERVE_DIR — no traversal, no listing.
  const name = path.basename(decodeURIComponent((req.url || '/').split('?')[0]));
  const file = path.join(SERVE_DIR, name);
  if (!name.endsWith('.html') || !file.startsWith(SERVE_DIR) || !fs.existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
});

publishSweep();
setInterval(publishSweep, INTERVAL);
server.listen(PORT, () => log(`serving ${SERVE_DIR} on https://:${PORT} (publish every ${INTERVAL}ms)`));
