// kb-ui reverse-proxy support: KB_BASE_PATH URL prefixing + KB_PROXY_SECRET
// identity assertion + forwarded-host origin checks.
//
// Unlike the other kb-ui tests this one DOES import server.mjs — the module
// only calls app.listen() when it is the process entrypoint, so importing it
// yields a configured Express app that binds nothing. Each instance is started
// with `vi.resetModules()` + a fresh env, because server.mjs reads its config
// (KB_BASE_PATH, KB_PROXY_SECRET, KB_ADMINS, ...) once at import time.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_KB_UI = path.dirname(fileURLToPath(import.meta.url));
const BASE = '/dashboard/orgs/org_test/kb';
const PROXY_SECRET = 'sekret-abc123';
const PROFILE = 'kbui_proxy_fixture';
const BASIC = 'Basic ' + Buffer.from('admin:pw').toString('base64');

let fixtureRoot;
let originalCwd;

function write(rel, contents) {
  const full = path.join(fixtureRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents, 'utf-8');
}

function buildFixture() {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kbui-proxy-'));
  const p = `profiles/${PROFILE}`;
  const ctx = `${p}/groups/slack_main/context`;
  write(`${p}/profile.config.json`, JSON.stringify({ orgName: 'Fixture Org', sharedKbGroup: 'slack_main' }));
  fs.mkdirSync(path.join(fixtureRoot, p, 'store'), { recursive: true });
  write('users.json', JSON.stringify({ admin: 'pw' }));

  write(`${ctx}/index.md`, '# Fixture KB\n\nA [link](https://example.com).\n');
  write(
    `${ctx}/tasks/TASK-1.md`,
    '---\nid: TASK-1\ntitle: First task\nstatus: open\npriority: high\nowners: [ana]\nstart_date: 2026-01-01\nend_date: 2026-01-05\nlinked_events: [EVT-1]\n---\n\nBody one.\n',
  );
  write(
    `${ctx}/tasks/TASK-9.md`,
    '---\nid: TASK-9\ntitle: Mutable task\nstatus: open\npriority: low\n---\n\nBody nine.\n',
  );
  write(
    `${ctx}/calendar/EVT-1.md`,
    '---\nid: EVT-1\ntitle: Kickoff\nlinked_tasks: [TASK-1]\ndate: 2026-01-02\n---\n\nEvent body.\n',
  );
  write(
    `${ctx}/artifacts/NOTE-1.md`,
    '---\ntitle: An artifact\nvisibility: open\ntags: [demo]\ncreated_at: 2026-01-01\n---\n\nArtifact body.\n',
  );
  write(`${ctx}/people/ana.md`, '---\ntitle: Ana\nvisibility: open\n---\n\nPerson body.\n');
  write(
    `${ctx}/projects/PROJECT-1.md`,
    '---\nid: PROJECT-1\ntitle: A project\nstatus: active\n---\n\nProject body.\n',
  );

  // A plugin dashboard slice with zero imports (it lives outside the repo, so
  // it cannot resolve express) — enough to exercise nav-card href prefixing
  // and a mounted router.
  write(
    `${p}/plugins/demo/kb-ui/index.mjs`,
    [
      'export function navCards() {',
      "  return [{ href: '/demo', title: 'Demo Plugin', desc: 'fixture', icon: '\\u2699' }];",
      '}',
      'export function createRoutes(deps) {',
      '  return function router(req, res) {',
      "    res.send(deps.layout('Demo', '<a href=\"' + deps.url('/demo/thing') + '\">thing</a>', 'admin'));",
      '  };',
      '}',
    ].join('\n'),
  );
}

const ENV_KEYS = [
  'KB_BASE_PATH',
  'KB_PROXY_SECRET',
  'KB_ADMINS',
  'KB_SUPERADMINS',
  'KB_COORDINATORS',
  'KB_RESIDENTS',
  'LABOR_PROFILE',
  'ENABLED_PLUGINS',
  'USERS_FILE',
  'CONTEXT_DIR',
  'DB_PATH',
  'KB_PORT',
];

const started = [];

/** Import a fresh server.mjs under `env` and listen on an ephemeral port. */
async function startKbUi(env = {}) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, {
    LABOR_PROFILE: PROFILE,
    ENABLED_PLUGINS: 'demo',
    USERS_FILE: path.join(fixtureRoot, 'users.json'),
    KB_ADMINS: 'admin',
    KB_SUPERADMINS: 'admin',
    ...env,
  });
  vi.resetModules();
  const mod = await import('./server.mjs');
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  const server = mod.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const instance = {
    mod,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  };
  instance.get = (p, headers = {}) =>
    fetch(instance.origin + p, { headers: { Authorization: BASIC, ...headers } });
  instance.html = async (p, headers) => {
    const res = await instance.get(p, headers);
    expect(res.status, `GET ${p} -> ${res.status}`).toBe(200);
    return res.text();
  };
  started.push(instance);
  return instance;
}

const PAGES = [
  '/',
  '/category/tasks',
  '/category/artifacts',
  '/category/people',
  '/category/calendar',
  '/doc/tasks/TASK-1.md',
  '/linkages',
  '/projects',
  '/logs',
  '/analytics',
  '/admin',
  '/architecture',
  '/demo',
];

let plain; // no base path, no proxy
let prefixed; // KB_BASE_PATH set
let proxied; // KB_PROXY_SECRET set, no env roles

beforeAll(async () => {
  buildFixture();
  originalCwd = process.cwd();
  process.chdir(fixtureRoot);
  plain = await startKbUi();
  prefixed = await startKbUi({ KB_BASE_PATH: BASE });
  proxied = await startKbUi({
    KB_PROXY_SECRET: PROXY_SECRET,
    KB_ADMINS: '',
    KB_SUPERADMINS: '',
    KB_COORDINATORS: '',
  });
}, 30_000);

afterAll(async () => {
  for (const s of started) await s.close();
  process.chdir(originalCwd);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('entrypoint', () => {
  it('listens when run as `node kb-ui/server.mjs`, even through a symlinked path', async () => {
    // The module only calls app.listen() when it is the process entrypoint;
    // that check must survive a symlinked deploy root (Node resolves
    // import.meta.url through symlinks, process.argv[1] does not).
    const link = path.join(fixtureRoot, 'kbui-link');
    fs.symlinkSync(path.resolve(REPO_KB_UI), link, 'dir');
    const child = spawn(process.execPath, [path.join(link, 'server.mjs')], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        KB_PORT: '0',
        LABOR_PROFILE: PROFILE,
        USERS_FILE: path.join(fixtureRoot, 'users.json'),
        KB_ADMINS: 'admin',
        KB_BASE_PATH: BASE,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const line = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no listen banner')), 10_000);
        child.stdout.setEncoding('utf-8');
        child.stdout.on('data', (chunk) => {
          if (chunk.includes('Knowledge Base UI running at')) {
            clearTimeout(timer);
            resolve(chunk);
          }
        });
        child.on('exit', (code) => { clearTimeout(timer); reject(new Error('exited ' + code)); });
      });
      expect(line).toContain(BASE);
    } finally {
      child.kill('SIGKILL');
    }
  }, 15_000);
});

describe('normalizeBasePath', () => {
  it('normalises to a leading-slash, no-trailing-slash prefix (empty = off)', () => {
    const { normalizeBasePath } = plain.mod;
    expect(normalizeBasePath(undefined)).toBe('');
    expect(normalizeBasePath('')).toBe('');
    expect(normalizeBasePath('  ')).toBe('');
    expect(normalizeBasePath('/')).toBe('');
    expect(normalizeBasePath('dashboard/kb')).toBe('/dashboard/kb');
    expect(normalizeBasePath('/dashboard/kb/')).toBe('/dashboard/kb');
    expect(normalizeBasePath('/dashboard/kb///')).toBe('/dashboard/kb');
    expect(normalizeBasePath(BASE)).toBe(BASE);
  });

  it('rejects a prefix that could break out of an HTML attribute or JS string', () => {
    const warn = [];
    const logger = { warn: (m) => warn.push(m) };
    const { normalizeBasePath } = plain.mod;
    expect(normalizeBasePath('/a"onerror=x', logger)).toBe('');
    expect(normalizeBasePath("/a'+alert(1)+'", logger)).toBe('');
    expect(normalizeBasePath('/a b', logger)).toBe('');
    expect(normalizeBasePath('//evil.com', logger)).toBe('');
    expect(warn).toHaveLength(4);
  });

  it('rejects dot segments — a prefix the browser would resolve OUT of the prefix', () => {
    const warn = [];
    const logger = { warn: (m) => warn.push(m) };
    const { normalizeBasePath } = plain.mod;
    // `/a/..` + `/x` = `/a/../x`, which a browser resolves to `/x` — outside
    // the prefix, i.e. every link on the page escapes the proxy.
    expect(normalizeBasePath('/a/..', logger)).toBe('');
    expect(normalizeBasePath('/..', logger)).toBe('');
    expect(normalizeBasePath('/a/../b', logger)).toBe('');
    expect(normalizeBasePath('/a/.', logger)).toBe('');
    // …including the percent-encoded spellings the URL spec also treats as
    // dot segments.
    expect(normalizeBasePath('/a/%2e%2e', logger)).toBe('');
    expect(normalizeBasePath('/a/%2E%2E/b', logger)).toBe('');
    expect(normalizeBasePath('/a/.%2e', logger)).toBe('');
    expect(normalizeBasePath('/a/%2e', logger)).toBe('');
    expect(warn).toHaveLength(8);
    // A dot INSIDE a segment is fine — that's an ordinary path component.
    expect(normalizeBasePath('/a/v1.2/kb')).toBe('/a/v1.2/kb');
    expect(normalizeBasePath('/dashboard/orgs/a.b/kb')).toBe(
      '/dashboard/orgs/a.b/kb',
    );
  });
});

describe('HTML escaping of the proxied identity', () => {
  // X-KB-User is the control plane's `req.user.email`, and CP signup accepts
  // any string with a single @ — including this one. Self-XSS only (you have
  // to own the account), but the fix is one call.
  const XSS_USER = '<img src=x onerror=alert(1)>@e.com';

  it('escapes X-KB-User instead of interpolating it into the topbar', async () => {
    const res = await fetch(proxied.origin + '/', {
      headers: {
        'X-KB-Proxy-Secret': PROXY_SECRET,
        'X-KB-User': XSS_USER,
        'X-KB-Roles': 'admin',
        'X-Forwarded-Host': 'cloud.lab0r.fun',
      },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain(
      '&lt;img src=x onerror=alert(1)&gt;@e.com',
    );
  });
});

describe('KB_BASE_PATH off', () => {
  it('renders byte-identical HTML to the prefixed instance with the prefix removed', async () => {
    for (const page of PAGES) {
      const a = await plain.html(page);
      const b = await prefixed.html(page);
      expect(b.split(BASE).join(''), `page ${page}`).toBe(a);
    }
  });

  it('emits root-relative URLs unchanged (no prefix, no leftover template)', async () => {
    const home = await plain.html('/');
    expect(home).toContain('<a href="/projects" class="nav-card"');
    expect(home).toContain('<a href="/category/tasks" class="nav-card">');
    expect(home).toContain('<h1><a href="/" style="color:#fff">');
    expect(home).toContain('href="/demo"');
    const projects = await plain.html('/projects');
    expect(projects).toContain("fetch(cleanOrigin + '/api/tasks/' + encodeURIComponent(file)");
    for (const page of PAGES) {
      expect(await plain.html(page), `page ${page}`).not.toContain('${url(');
    }
  });
});

describe('KB_BASE_PATH on', () => {
  it('prefixes every URL it emits on every page', async () => {
    let checked = 0;
    for (const page of PAGES) {
      const html = await prefixed.html(BASE + page);
      expect(html, `page ${page}`).not.toContain('${url(');
      for (const m of html.matchAll(/(?:href|src|action)="([^"]*)"/g)) {
        const value = m[1];
        if (!value.startsWith('/')) continue; // absolute/anchor/JS-built – not ours
        expect(value.startsWith(BASE + '/'), `page ${page}: ${value}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(30);
  });

  it('prefixes the plugin nav card and the plugin router’s own url() links', async () => {
    const home = await prefixed.html('/');
    expect(home).toContain(`<a href="${BASE}/demo"`);
    const pluginPage = await prefixed.html('/demo');
    expect(pluginPage).toContain(`<a href="${BASE}/demo/thing">thing</a>`);
  });

  it('prefixes the fetch() URL in the inline drag-and-drop script', async () => {
    const projects = await prefixed.html('/projects');
    expect(projects).toContain(`fetch(cleanOrigin + '${BASE}/api/tasks/' + encodeURIComponent(file)`);
  });

  it('serves the same routes with or without the prefix on the wire', async () => {
    const withPrefix = await prefixed.html(BASE + '/category/tasks');
    const withoutPrefix = await prefixed.html('/category/tasks');
    expect(withPrefix).toBe(withoutPrefix);
  });
});

describe('proxy identity', () => {
  const proxyHeaders = (over = {}) => ({
    'X-KB-Proxy-Secret': PROXY_SECRET,
    'X-KB-User': 'ana@example.com',
    'X-KB-Roles': 'admin',
    'X-Forwarded-Proto': 'https',
    'X-Forwarded-Host': 'cloud.lab0r.fun',
    'X-Forwarded-Prefix': BASE,
    ...over,
  });

  it('authenticates from X-KB-User when the shared secret matches (no Basic Auth)', async () => {
    const res = await fetch(proxied.origin + '/', { headers: proxyHeaders() });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('ana@example.com');
    expect(html).toContain('href="/logs"'); // admin-only card, granted by X-KB-Roles
  });

  it('ignores X-KB-* entirely when the secret is wrong or absent', async () => {
    for (const secret of ['wrong-secret', '', undefined]) {
      const headers = proxyHeaders({ 'X-KB-Proxy-Secret': secret });
      if (secret === undefined) delete headers['X-KB-Proxy-Secret'];
      const res = await fetch(proxied.origin + '/', { headers });
      expect(res.status, `secret=${JSON.stringify(secret)}`).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/^Basic/);
    }
  });

  it('falls back to Basic Auth (and env roles) for a request carrying bogus X-KB-* headers', async () => {
    const html = await proxied.html('/', proxyHeaders({ 'X-KB-Proxy-Secret': 'wrong-secret' }));
    // Authenticated as the Basic Auth user, NOT as ana; this instance has no
    // KB_ADMINS, so the asserted admin role must not leak through.
    expect(html).toContain('>admin ');
    expect(html).not.toContain('ana@example.com');
    expect(html).not.toContain('href="/logs"');
  });

  it('grants nothing for an unknown or empty role list (default deny)', async () => {
    for (const roles of ['owner', 'member,billing', '', 'ADMINISTRATOR']) {
      const html = await proxied.html('/', proxyHeaders({ 'X-KB-Roles': roles }));
      expect(html, `roles=${roles}`).toContain('ana@example.com');
      expect(html, `roles=${roles}`).not.toContain('href="/logs"'); // admin
      expect(html, `roles=${roles}`).not.toContain('href="/admin"'); // superadmin
      const res = await fetch(proxied.origin + '/api/tasks/TASK-9.md', {
        method: 'PATCH',
        headers: {
          ...proxyHeaders({ 'X-KB-Roles': roles }),
          'Content-Type': 'application/json',
          Origin: 'https://cloud.lab0r.fun',
        },
        body: JSON.stringify({ status: 'blocked' }),
      });
      expect(res.status, `roles=${roles}`).toBe(403);
      expect((await res.json()).error).toBe('Permission denied');
    }
  });

  it('rejects a proxy request with no subject', async () => {
    const headers = proxyHeaders();
    delete headers['X-KB-User'];
    const res = await fetch(proxied.origin + '/', { headers });
    expect(res.status).toBe(401);
  });

  it('does not read X-KB-* at all when KB_PROXY_SECRET is unset', async () => {
    const res = await fetch(plain.origin + '/', {
      headers: { 'X-KB-Proxy-Secret': '', 'X-KB-User': 'ana@example.com', 'X-KB-Roles': 'admin' },
    });
    expect(res.status).toBe(401);
  });

  it('compares the secret in constant time, without length short-circuits', () => {
    const { proxySecretMatches } = proxied.mod;
    expect(proxySecretMatches(PROXY_SECRET, PROXY_SECRET)).toBe(true);
    expect(proxySecretMatches('x', PROXY_SECRET)).toBe(false); // length mismatch must not throw
    expect(proxySecretMatches(PROXY_SECRET + 'x', PROXY_SECRET)).toBe(false);
    expect(proxySecretMatches(PROXY_SECRET.toUpperCase(), PROXY_SECRET)).toBe(false);
    expect(proxySecretMatches('', PROXY_SECRET)).toBe(false);
    expect(proxySecretMatches(undefined, PROXY_SECRET)).toBe(false);
    expect(proxySecretMatches(PROXY_SECRET, '')).toBe(false); // feature off
  });
});

describe('same-origin enforcement', () => {
  const patch = (instance, headers) =>
    fetch(instance.origin + '/api/tasks/TASK-9.md', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ status: 'in_progress' }),
    });

  const adminProxyHeaders = (over = {}) => ({
    'X-KB-Proxy-Secret': PROXY_SECRET,
    'X-KB-User': 'ana@example.com',
    'X-KB-Roles': 'admin',
    'X-Forwarded-Proto': 'https',
    'X-Forwarded-Host': 'cloud.lab0r.fun',
    ...over,
  });

  it('accepts the forwarded host as the origin when the proxy secret matched', async () => {
    const res = await patch(proxied, {
      ...adminProxyHeaders(),
      Origin: 'https://cloud.lab0r.fun',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('rejects a foreign origin even on a correctly proxied request', async () => {
    const res = await patch(proxied, {
      ...adminProxyHeaders(),
      Origin: 'https://evil.example',
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Cross-origin request blocked');
  });

  it('ignores X-Forwarded-Host when the request is not proxy-authenticated', async () => {
    const res = await patch(plain, {
      Authorization: BASIC,
      'X-Forwarded-Host': 'cloud.lab0r.fun',
      Origin: 'https://cloud.lab0r.fun',
    });
    expect(res.status).toBe(403);
  });

  it('accepts the real host for a direct (non-proxied) request', async () => {
    const res = await patch(plain, {
      Authorization: BASIC,
      Origin: plain.origin,
    });
    expect(res.status).toBe(200);
  });

  it('requires an exact host match (a suffix/substring origin is rejected)', async () => {
    const host = plain.origin.replace('http://', '');
    const res = await patch(plain, {
      Authorization: BASIC,
      Origin: `https://${host}.evil.example`,
    });
    expect(res.status).toBe(403);
  });

  it('rejects an opaque ("null") origin', async () => {
    const res = await patch(plain, { Authorization: BASIC, Origin: 'null' });
    expect(res.status).toBe(403);
  });

  it('falls back to Referer, and allows a request with neither header', async () => {
    const bad = await patch(plain, {
      Authorization: BASIC,
      Referer: 'https://evil.example/projects',
    });
    expect(bad.status).toBe(403);
    const ok = await patch(plain, { Authorization: BASIC, Referer: plain.origin + '/projects' });
    expect(ok.status).toBe(200);
    const none = await patch(plain, { Authorization: BASIC });
    expect(none.status).toBe(200);
  });

  // The control plane refuses a foreign Origin itself and then forwards the
  // client's REAL Origin/Referer rather than a synthesised one, precisely so
  // that this check stays a real second opinion rather than a rubber stamp.
  // These are the values kb-ui must still reject if one ever gets through.
  it('rejects a foreign Referer on a proxied mutation (Origin-less, as the proxy relays it)', async () => {
    const res = await patch(proxied, {
      ...adminProxyHeaders(),
      Referer: 'https://evil.example/csrf',
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Cross-origin request blocked');
  });

  it('accepts a genuine proxied mutation carrying BOTH the real Origin and Referer', async () => {
    const res = await patch(proxied, {
      ...adminProxyHeaders(),
      Origin: 'https://cloud.lab0r.fun',
      Referer: `https://cloud.lab0r.fun${BASE}/projects`,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('still allows a proxied mutation with neither header (unchanged behaviour)', async () => {
    const res = await patch(proxied, adminProxyHeaders());
    expect(res.status).toBe(200);
  });
});
