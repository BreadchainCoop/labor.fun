import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { registerChannel } from './channels/registry.js';
import { PROFILE_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { registerIntegration } from './integrations/registry.js';
import { logger } from './logger.js';

/**
 * The surface a profile plugin receives. Plugins are out-of-tree (they live in
 * `profiles/<org>/plugins/`, not `src/`), so they register through this API
 * object rather than importing framework internals by path. This keeps an
 * org's plugins decoupled from the framework's module layout.
 */
export interface PluginApi {
  registerChannel: typeof registerChannel;
  registerIntegration: typeof registerIntegration;
  /** Read keys from the install's .env without leaking them to process.env. */
  readEnvFile: typeof readEnvFile;
  logger: typeof logger;
}

/** A profile plugin module: `export default function register(api) {...}`. */
export type PluginRegister = (api: PluginApi) => void | Promise<void>;

function defaultApi(): PluginApi {
  return { registerChannel, registerIntegration, readEnvFile, logger };
}

/**
 * Load every plugin in the active profile's `plugins/` directory and let each
 * self-register channels/flows. A plugin is a `.js`/`.mjs`/`.cjs` module whose
 * default (or named `register`) export is a function receiving {@link PluginApi}.
 *
 * Plugins are plain JS so they load at runtime with no build step (the
 * framework build compiles `src/`, not `profiles/`). Loaded after the core
 * channel + integration barrels so an org plugin can add or shadow built-ins.
 *
 * @returns the filenames that registered successfully.
 */
export async function loadProfilePlugins(opts?: {
  pluginsDir?: string;
  api?: PluginApi;
}): Promise<string[]> {
  const pluginsDir = opts?.pluginsDir ?? path.join(PROFILE_DIR, 'plugins');
  const api = opts?.api ?? defaultApi();

  if (!fs.existsSync(pluginsDir)) return [];

  const loaded: string[] = [];
  // Deterministic order so registration/shadowing is predictable.
  for (const entry of fs.readdirSync(pluginsDir).sort()) {
    if (!/\.(mjs|cjs|js)$/.test(entry)) continue;
    const full = path.join(pluginsDir, entry);
    try {
      // statSync inside the try: a broken symlink / permission error on one
      // entry must be skipped, not crash startup.
      if (!fs.statSync(full).isFile()) continue;
      const mod = await import(pathToFileURL(full).href);
      const register: unknown = mod.default ?? mod.register;
      if (typeof register !== 'function') {
        logger.warn(
          { plugin: entry },
          'Profile plugin has no default/register() export — skipped',
        );
        continue;
      }
      await (register as PluginRegister)(api);
      loaded.push(entry);
      logger.info({ plugin: entry }, 'Loaded profile plugin');
    } catch (err) {
      // A broken org plugin must not take down the whole process.
      logger.error({ err, plugin: entry }, 'Failed to load profile plugin');
    }
  }
  return loaded;
}
