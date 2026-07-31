import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadKbUiPlugins,
  navCardVisible,
  resolveCatalogDir,
  resolveEnabledPluginIds,
} from './plugin-mount.mjs';

const tmpDirs = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
function writePluginModule(root, id, body) {
  const dir = path.join(root, id, 'kb-ui');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.mjs'), body);
}
const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('resolveEnabledPluginIds', () => {
  it('is undefined (gating off) when neither profile nor env declares a list', () => {
    expect(resolveEnabledPluginIds(undefined, undefined)).toBeUndefined();
    expect(resolveEnabledPluginIds(undefined, '')).toBeUndefined();
  });

  it('unions profile and env (comma form), deduped', () => {
    expect(resolveEnabledPluginIds(['residency'], 'residency, other')).toEqual([
      'residency',
      'other',
    ]);
  });

  it('accepts the JSON-array env form', () => {
    expect(resolveEnabledPluginIds(undefined, '["a","b"]')).toEqual(['a', 'b']);
  });

  it('empty profile list turns gating ON (empty set, not undefined)', () => {
    expect(resolveEnabledPluginIds([], undefined)).toEqual([]);
  });

  it('malformed env JSON logs and degrades instead of crashing kb-ui', () => {
    expect(resolveEnabledPluginIds(['residency'], '[oops', silentLogger)).toEqual([
      'residency',
    ]);
    expect(silentLogger.warn).toHaveBeenCalled();
  });
});

describe('resolveCatalogDir', () => {
  it('prefers <root>/catalog-plugins (image layout) when present', () => {
    const root = tmpDir('cat-root-');
    fs.mkdirSync(path.join(root, 'catalog-plugins'));
    expect(resolveCatalogDir(root)).toBe(path.join(root, 'catalog-plugins'));
  });

  it('falls back to <root>/container/catalog-plugins (dev checkout)', () => {
    const root = tmpDir('cat-root-');
    expect(resolveCatalogDir(root)).toBe(
      path.join(root, 'container', 'catalog-plugins'),
    );
  });
});

describe('loadKbUiPlugins', () => {
  const deps = { marker: 'deps' };

  it('mounts an enabled plugin at /<id> and collects its nav cards', async () => {
    const catalogDir = tmpDir('catalog-');
    writePluginModule(
      catalogDir,
      'residency',
      `export function createRoutes(deps) { return { fakeRouter: true, got: deps.marker }; }
       export function navCards() { return [{ href: '/residency', title: 'Residency', desc: 'Rooms' }]; }`,
    );
    const { mounts, navCards } = await loadKbUiPlugins({
      enabledIds: ['residency'],
      catalogDir,
      profileDir: tmpDir('profile-'),
      deps,
      logger: silentLogger,
    });
    expect(mounts).toHaveLength(1);
    expect(mounts[0].mount).toBe('/residency');
    expect(mounts[0].router).toEqual({ fakeRouter: true, got: 'deps' });
    expect(navCards).toEqual([
      { pluginId: 'residency', href: '/residency', title: 'Residency', desc: 'Rooms' },
    ]);
  });

  it("carries a card's roles through so the home page can hide it", async () => {
    const catalogDir = tmpDir('catalog-');
    writePluginModule(
      catalogDir,
      'residency',
      `export function createRoutes() { return { ok: true }; }
       export function navCards() { return [{ href: '/residency', title: 'Residency', roles: ['coordinator', 'admin'] }]; }`,
    );
    const { navCards } = await loadKbUiPlugins({
      enabledIds: ['residency'],
      catalogDir,
      profileDir: tmpDir('profile-'),
      deps,
      logger: silentLogger,
    });
    expect(navCards[0].roles).toEqual(['coordinator', 'admin']);
  });

  it('plugin disabled / gating off → nothing mounts and no nav cards', async () => {
    const catalogDir = tmpDir('catalog-');
    writePluginModule(
      catalogDir,
      'residency',
      `export function createRoutes() { return {}; }
       export function navCards() { return [{ href: '/x', title: 'X' }]; }`,
    );
    // Gating off (undefined) — catalog stays dark.
    let out = await loadKbUiPlugins({
      enabledIds: undefined,
      catalogDir,
      profileDir: tmpDir('profile-'),
      deps,
      logger: silentLogger,
    });
    expect(out.mounts).toEqual([]);
    expect(out.navCards).toEqual([]);
    // Gating on but the id isn't listed.
    out = await loadKbUiPlugins({
      enabledIds: ['other-plugin'],
      catalogDir,
      profileDir: tmpDir('profile-'),
      deps,
      logger: silentLogger,
    });
    expect(out.mounts).toEqual([]);
    expect(out.navCards).toEqual([]);
  });

  it('skips silently when an enabled plugin has no kb-ui module or dirs are absent', async () => {
    const out = await loadKbUiPlugins({
      enabledIds: ['residency', 'weekly-agenda'],
      catalogDir: '/nonexistent/catalog',
      profileDir: '/nonexistent/profile',
      deps,
      logger: silentLogger,
    });
    expect(out.mounts).toEqual([]);
    expect(out.navCards).toEqual([]);
    expect(silentLogger.error).not.toHaveBeenCalled();
  });

  it('a broken kb-ui module logs + skips without breaking the others', async () => {
    const catalogDir = tmpDir('catalog-');
    writePluginModule(catalogDir, 'broken', 'this is not valid javascript {{{');
    writePluginModule(
      catalogDir,
      'fine',
      'export function createRoutes() { return { ok: true }; }',
    );
    const out = await loadKbUiPlugins({
      enabledIds: ['broken', 'fine'],
      catalogDir,
      profileDir: tmpDir('profile-'),
      deps,
      logger: silentLogger,
    });
    expect(out.mounts.map((m) => m.id)).toEqual(['fine']);
    expect(silentLogger.error).toHaveBeenCalled();
  });

  it('a throwing createRoutes logs + skips', async () => {
    const catalogDir = tmpDir('catalog-');
    writePluginModule(
      catalogDir,
      'boom',
      'export function createRoutes() { throw new Error("nope"); }',
    );
    const out = await loadKbUiPlugins({
      enabledIds: ['boom'],
      catalogDir,
      profileDir: tmpDir('profile-'),
      deps,
      logger: silentLogger,
    });
    expect(out.mounts).toEqual([]);
    expect(silentLogger.error).toHaveBeenCalled();
  });

  it('profile plugins shadow the catalog for the same id', async () => {
    const catalogDir = tmpDir('catalog-');
    const profileDir = tmpDir('profile-');
    writePluginModule(catalogDir, 'residency', 'export function createRoutes() { return { from: "catalog" }; }');
    writePluginModule(path.join(profileDir, 'plugins'), 'residency', 'export function createRoutes() { return { from: "profile" }; }');
    const out = await loadKbUiPlugins({
      enabledIds: ['residency'],
      catalogDir,
      profileDir,
      deps,
      logger: silentLogger,
    });
    expect(out.mounts[0].router).toEqual({ from: 'profile' });
  });

  it('refuses unsafe plugin ids (path traversal cannot escape the plugin dirs)', async () => {
    const out = await loadKbUiPlugins({
      enabledIds: ['../../etc', 'ok..id/'],
      catalogDir: tmpDir('catalog-'),
      profileDir: tmpDir('profile-'),
      deps,
      logger: silentLogger,
    });
    expect(out.mounts).toEqual([]);
    expect(silentLogger.warn).toHaveBeenCalledTimes(2);
  });
});

describe('navCardVisible', () => {
  const roles = {
    isAdmin: (u) => u === 'root',
    isCoordinator: (u) => u === 'coord',
    isResident: (u) => u === 'res',
  };

  it('no roles → visible to everyone', () => {
    expect(navCardVisible({ href: '/x', title: 'X' }, 'anyone', roles)).toBe(true);
  });

  it('role-restricted card shows only to holders of a listed role', () => {
    const card = { href: '/x', title: 'X', roles: ['admin', 'coordinator'] };
    expect(navCardVisible(card, 'root', roles)).toBe(true);
    expect(navCardVisible(card, 'coord', roles)).toBe(true);
    expect(navCardVisible(card, 'res', roles)).toBe(false);
    expect(navCardVisible(card, 'guest', roles)).toBe(false);
  });

  it('unknown role names never match', () => {
    expect(navCardVisible({ href: '/x', title: 'X', roles: ['wizard'] }, 'root', roles)).toBe(false);
  });

  it("the residency card is hidden from users its route gate would 403", async () => {
    // Real card, not a fixture — the advertisement must track the gate.
    const residency = await import(
      '../container/catalog-plugins/residency/kb-ui/index.mjs'
    );
    const [card] = residency.navCards();
    expect(navCardVisible(card, 'coord', roles)).toBe(true);
    expect(navCardVisible(card, 'root', roles)).toBe(true);
    expect(navCardVisible(card, 'res', roles)).toBe(false);
    expect(navCardVisible(card, 'viewer', roles)).toBe(false);
  });
});
