import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { logger } from './logger.js';
import { loadProfilePlugins, type PluginApi } from './plugin-loader.js';

describe('loadProfilePlugins', () => {
  const tmpDirs: string[] = [];

  function makePluginsDir(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-test-'));
    tmpDirs.push(dir);
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), body);
    }
    return dir;
  }

  function makeCatalogDir(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-test-'));
    tmpDirs.push(dir);
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), body);
    }
    return dir;
  }

  function fakeApi(): PluginApi {
    return {
      registerChannel: vi.fn(),
      registerIntegration: vi.fn(),
      registerChatFlow: vi.fn(),
      readEnvFile: vi.fn(() => ({})),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      profileDir: '/tmp/fake-profile',
    };
  }

  afterEach(() => {
    while (tmpDirs.length) {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('returns nothing when the plugins dir is absent', async () => {
    const loaded = await loadProfilePlugins({
      pluginsDir: '/nonexistent/plugins',
      api: fakeApi(),
    });
    expect(loaded).toEqual([]);
  });

  it('calls each plugin default export with the api, in sorted order', async () => {
    const dir = makePluginsDir({
      'b-flow.mjs':
        'export default (api) => api.registerIntegration({ name: "b", start(){} });',
      'a-channel.mjs':
        'export default (api) => api.registerChannel("a", () => null);',
      'ignored.txt': 'not a plugin',
    });
    const api = fakeApi();
    const loaded = await loadProfilePlugins({
      pluginsDir: dir,
      catalogDir: '/nonexistent/catalog',
      api,
    });

    expect(loaded).toEqual(['a-channel.mjs', 'b-flow.mjs']); // sorted, .txt skipped
    expect(api.registerChannel).toHaveBeenCalledWith('a', expect.any(Function));
    expect(api.registerIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'b' }),
    );
  });

  it('skips a module with no register export and keeps going', async () => {
    const dir = makePluginsDir({
      'noop.mjs': 'export const notRegister = 1;',
      'good.mjs':
        'export default (api) => api.registerIntegration({ name: "g", start(){} });',
    });
    const api = fakeApi();
    const loaded = await loadProfilePlugins({
      pluginsDir: dir,
      catalogDir: '/nonexistent/catalog',
      api,
    });
    expect(loaded).toEqual(['good.mjs']);
  });

  it('isolates a throwing plugin without failing the load', async () => {
    const dir = makePluginsDir({
      'boom.mjs': 'export default () => { throw new Error("nope"); };',
      'fine.mjs':
        'export default (api) => api.registerChannel("ok", () => null);',
    });
    const api = fakeApi();
    const loaded = await loadProfilePlugins({
      pluginsDir: dir,
      catalogDir: '/nonexistent/catalog',
      api,
    });
    expect(loaded).toEqual(['fine.mjs']); // boom recorded as failure, not thrown
    expect(api.registerChannel).toHaveBeenCalledWith(
      'ok',
      expect.any(Function),
    );
  });

  // --- M1: catalog + ENABLED_PLUGINS gating ---

  it('(a) absent enabledPlugins → registers ALL profile plugins (backward compat)', async () => {
    // Gating OFF (enabledPlugins undefined): every profile-dir plugin registers,
    // and the catalog stays dark even though it is present and imported.
    const profile = makePluginsDir({
      'p-one.mjs':
        'export default (api) => api.registerIntegration({ name: "one", start(){} });',
      'p-two.mjs':
        'export default (api) => api.registerIntegration({ name: "two", start(){} });',
    });
    const catalog = makeCatalogDir({
      'cat.mjs':
        'export const id = "cat"; export default (api) => api.registerIntegration({ name: "cat", start(){} });',
    });
    const api = fakeApi();
    const loaded = await loadProfilePlugins({
      pluginsDir: profile,
      catalogDir: catalog,
      enabledPlugins: undefined, // absent → gating off
      api,
    });

    expect(loaded).toEqual(['p-one.mjs', 'p-two.mjs']); // both profile plugins
    expect(loaded).not.toContain('cat.mjs'); // catalog off by default
    expect(api.registerIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'one' }),
    );
    expect(api.registerIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'two' }),
    );
    expect(api.registerIntegration).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'cat' }),
    );
  });

  it('(b) enabledPlugins=[id] → only that plugin registers; others imported-but-not-registered', async () => {
    const profile = makePluginsDir({
      'keep.mjs':
        'export const id = "keep"; export default (api) => api.registerIntegration({ name: "keep", start(){} });',
      'drop.mjs':
        'export const id = "drop"; export default (api) => api.registerIntegration({ name: "drop", start(){} });',
    });
    const catalog = makeCatalogDir({
      'wanted.mjs':
        'export const id = "wanted"; export default (api) => api.registerIntegration({ name: "wanted", start(){} });',
      'unwanted.mjs':
        'export const id = "unwanted"; export default (api) => api.registerIntegration({ name: "unwanted", start(){} });',
    });
    const api = fakeApi();

    // Enable one catalog id and one profile id.
    const loaded = await loadProfilePlugins({
      pluginsDir: profile,
      catalogDir: catalog,
      enabledPlugins: ['wanted', 'keep'],
      api,
    });

    expect(loaded.sort()).toEqual(['keep.mjs', 'wanted.mjs']);
    expect(loaded).not.toContain('drop.mjs');
    expect(loaded).not.toContain('unwanted.mjs');
    expect(api.registerIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'wanted' }),
    );
    expect(api.registerIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'keep' }),
    );
    // Imported (discovered) but never registered.
    expect(api.registerIntegration).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'drop' }),
    );
    expect(api.registerIntegration).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'unwanted' }),
    );
  });

  it('(c) unknown id in enabledPlugins → warns, no crash, valid ids still register', async () => {
    const catalog = makeCatalogDir({
      'real.mjs':
        'export const id = "real"; export default (api) => api.registerIntegration({ name: "real", start(){} });',
    });
    const api = fakeApi();
    // The unknown-id warning goes through the module logger (discovery-level),
    // not the plugin-facing api.logger.
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const loaded = await loadProfilePlugins({
      pluginsDir: '/nonexistent/plugins',
      catalogDir: catalog,
      enabledPlugins: ['real', 'does-not-exist'],
      api,
    });

    expect(loaded).toEqual(['real.mjs']); // no throw; real still registers
    expect(api.registerIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'real' }),
    );
    // The unknown id produced a warning naming it — rather than an error/throw.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'does-not-exist' }),
      expect.any(String),
    );
    warnSpy.mockRestore();
  });

  it('(d) empty enabledPlugins=[] with a catalog present → catalog NOT registered', async () => {
    const catalog = makeCatalogDir({
      'a.mjs':
        'export const id = "a"; export default (api) => api.registerIntegration({ name: "a", start(){} });',
      'b.mjs':
        'export const id = "b"; export default (api) => api.registerIntegration({ name: "b", start(){} });',
    });
    const profile = makePluginsDir({
      'prof.mjs':
        'export const id = "prof"; export default (api) => api.registerIntegration({ name: "prof", start(){} });',
    });
    const api = fakeApi();

    // Explicit [] turns gating ON but enables nothing → register nothing,
    // including the profile-dir plugin (gating applies to both sources).
    const loaded = await loadProfilePlugins({
      pluginsDir: profile,
      catalogDir: catalog,
      enabledPlugins: [],
      api,
    });

    expect(loaded).toEqual([]);
    expect(api.registerIntegration).not.toHaveBeenCalled();
  });

  // --- M2a: per-plugin config plumbing (register receives config as arg #2) ---

  it('passes each plugin its own config entry as the SECOND argument', async () => {
    // A plugin that records the (api, config) it was called with into a global
    // the test can read back. Two plugins, one config entry each.
    const catalog = makeCatalogDir({
      'alpha.mjs':
        'export const id = "alpha";' +
        'export default (api, config) => { globalThis.__alphaCfg = config; api.registerIntegration({ name: "alpha", start(){} }); };',
      'beta.mjs':
        'export const id = "beta";' +
        'export default (api, config) => { globalThis.__betaCfg = config; api.registerIntegration({ name: "beta", start(){} }); };',
    });
    const api = fakeApi();
    const loaded = await loadProfilePlugins({
      pluginsDir: '/nonexistent/plugins',
      catalogDir: catalog,
      enabledPlugins: ['alpha', 'beta'],
      pluginConfig: {
        alpha: { foo: 1, who: ['alice'] },
        beta: { bar: 'x' },
      },
      api,
    });
    expect(loaded.sort()).toEqual(['alpha.mjs', 'beta.mjs']);
    expect((globalThis as Record<string, unknown>).__alphaCfg).toEqual({
      foo: 1,
      who: ['alice'],
    });
    expect((globalThis as Record<string, unknown>).__betaCfg).toEqual({
      bar: 'x',
    });
    delete (globalThis as Record<string, unknown>).__alphaCfg;
    delete (globalThis as Record<string, unknown>).__betaCfg;
  });

  it('(d) register receives {} (not undefined) when the plugin has no config', async () => {
    const catalog = makeCatalogDir({
      'noconf.mjs':
        'export const id = "noconf";' +
        'export default (api, config) => { globalThis.__noconfCfg = config; api.registerIntegration({ name: "noconf", start(){} }); };',
    });
    const api = fakeApi();
    const loaded = await loadProfilePlugins({
      pluginsDir: '/nonexistent/plugins',
      catalogDir: catalog,
      enabledPlugins: ['noconf'],
      pluginConfig: {}, // nothing for this id
      api,
    });
    expect(loaded).toEqual(['noconf.mjs']);
    // Always an object — a plugin can safely destructure it.
    expect((globalThis as Record<string, unknown>).__noconfCfg).toEqual({});
    delete (globalThis as Record<string, unknown>).__noconfCfg;
  });

  it('(e) a legacy 1-arg register(api) plugin still registers fine (ignores arg #2)', async () => {
    const dir = makePluginsDir({
      // Classic one-arg signature — the second config argument is simply unused.
      'legacy.mjs':
        'export default (api) => api.registerIntegration({ name: "legacy", start(){} });',
    });
    const api = fakeApi();
    const loaded = await loadProfilePlugins({
      pluginsDir: dir,
      catalogDir: '/nonexistent/catalog',
      enabledPlugins: undefined, // gating off → profile plugin registers
      pluginConfig: { legacy: { unused: true } },
      api,
    });
    expect(loaded).toEqual(['legacy.mjs']);
    expect(api.registerIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'legacy' }),
    );
  });

  it('coerces a non-object config entry (array/scalar) to {} before passing it', async () => {
    const catalog = makeCatalogDir({
      'strict.mjs':
        'export const id = "strict";' +
        'export default (api, config) => { globalThis.__strictCfg = config; api.registerIntegration({ name: "strict", start(){} }); };',
    });
    const api = fakeApi();
    await loadProfilePlugins({
      pluginsDir: '/nonexistent/plugins',
      catalogDir: catalog,
      enabledPlugins: ['strict'],
      // A malformed per-id entry (array) must not reach the plugin as-is.
      pluginConfig: { strict: ['not', 'an', 'object'] as unknown as object },
      api,
    });
    expect((globalThis as Record<string, unknown>).__strictCfg).toEqual({});
    delete (globalThis as Record<string, unknown>).__strictCfg;
  });
});
