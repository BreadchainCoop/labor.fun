import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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

  function fakeApi(): PluginApi {
    return {
      registerChannel: vi.fn(),
      registerIntegration: vi.fn(),
      readEnvFile: vi.fn(() => ({})),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
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
    const loaded = await loadProfilePlugins({ pluginsDir: dir, api });

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
    const loaded = await loadProfilePlugins({ pluginsDir: dir, api });
    expect(loaded).toEqual(['good.mjs']);
  });

  it('isolates a throwing plugin without failing the load', async () => {
    const dir = makePluginsDir({
      'boom.mjs': 'export default () => { throw new Error("nope"); };',
      'fine.mjs':
        'export default (api) => api.registerChannel("ok", () => null);',
    });
    const api = fakeApi();
    const loaded = await loadProfilePlugins({ pluginsDir: dir, api });
    expect(loaded).toEqual(['fine.mjs']); // boom recorded as failure, not thrown
    expect(api.registerChannel).toHaveBeenCalledWith(
      'ok',
      expect.any(Function),
    );
  });
});
