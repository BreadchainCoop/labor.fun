import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { registerChannel } from './channels/registry.js';
import { registerChatFlow } from './chat-flows/registry.js';
import { CATALOG_PLUGINS_DIR, ENABLED_PLUGINS, PROFILE_DIR } from './config.js';
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
  /** Claim a chat for a sandboxed, assistant-suppressing flow. */
  registerChatFlow: typeof registerChatFlow;
  /** Read keys from the install's .env without leaking them to process.env. */
  readEnvFile: typeof readEnvFile;
  logger: typeof logger;
}

/** A profile plugin module: `export default function register(api) {...}`. */
export type PluginRegister = (api: PluginApi) => void | Promise<void>;

function defaultApi(): PluginApi {
  return {
    registerChannel,
    registerIntegration,
    registerChatFlow,
    readEnvFile,
    logger,
  };
}

/** A plugin module discovered on disk, imported but not yet registered. */
interface DiscoveredPlugin {
  /** Source of this plugin. */
  source: 'catalog' | 'profile';
  /** File name including extension (also the return value / log label). */
  file: string;
  /** Absolute path. */
  full: string;
  /** Stable id used for ENABLED_PLUGINS gating (exported `id` or basename). */
  id: string;
  /** The resolved register function, or null if the module has none. */
  register: PluginRegister | null;
}

/** Plugin id = exported `id` (trimmed) if present, else filename sans ext. */
function pluginId(mod: Record<string, unknown>, file: string): string {
  const exported = mod?.id;
  if (typeof exported === 'string' && exported.trim()) return exported.trim();
  return file.replace(/\.(mjs|cjs|js)$/, '');
}

/**
 * Import every plugin module in `dir` (deterministic sorted order). Import
 * failures are isolated and logged, never thrown — a broken plugin must not
 * take down startup. Nothing is registered here; that decision is the caller's.
 */
async function discoverPlugins(
  dir: string,
  source: 'catalog' | 'profile',
): Promise<DiscoveredPlugin[]> {
  if (!fs.existsSync(dir)) return [];
  const out: DiscoveredPlugin[] = [];
  // Deterministic order so registration/shadowing is predictable.
  for (const entry of fs.readdirSync(dir).sort()) {
    if (!/\.(mjs|cjs|js)$/.test(entry)) continue;
    const full = path.join(dir, entry);
    try {
      // statSync inside the try: a broken symlink / permission error on one
      // entry must be skipped, not crash startup.
      if (!fs.statSync(full).isFile()) continue;
      const mod = await import(pathToFileURL(full).href);
      const register: unknown = mod.default ?? mod.register;
      out.push({
        source,
        file: entry,
        full,
        id: pluginId(mod as Record<string, unknown>, entry),
        register:
          typeof register === 'function' ? (register as PluginRegister) : null,
      });
    } catch (err) {
      // A broken org/catalog plugin must not take down the whole process.
      logger.error({ err, plugin: entry, source }, 'Failed to import plugin');
    }
  }
  return out;
}

/**
 * Load the active install's plugins and let each self-register
 * channels/flows/chat-flows. A plugin is a `.js`/`.mjs`/`.cjs` module whose
 * default (or named `register`) export is a function receiving {@link PluginApi}.
 *
 * Two sources are scanned:
 *   - the baked first-party CATALOG (`container/catalog-plugins/` →
 *     `/app/catalog-plugins`), policy-closed (off by default), and
 *   - the active profile's `plugins/` dir (org-specific).
 *
 * ALL discovered plugins are IMPORTED at boot (so a later hot-enable never needs
 * a re-import), but only a plugin whose `id` is enabled is REGISTERED.
 *
 * Gating (`ENABLED_PLUGINS`):
 *   - `undefined` (ABSENT everywhere — every existing profile) → gating OFF:
 *     preserve today's behavior EXACTLY — register EVERY profile-dir plugin, and
 *     leave the catalog dark. Backward compatible.
 *   - a set (present, even empty `[]`) → gating ON: register ONLY plugins (from
 *     EITHER source) whose id is in the set. `[]` registers nothing.
 *
 * Plugins are plain JS so they load at runtime with no build step. Loaded after
 * the core channel + integration barrels so a plugin can add or shadow builtins.
 *
 * @returns the filenames that registered successfully.
 */
export async function loadProfilePlugins(opts?: {
  /** Override the profile plugins dir (tests). */
  pluginsDir?: string;
  /** Override the baked catalog dir (tests). Absent → the configured dir. */
  catalogDir?: string;
  /**
   * Override the enable-list (tests). `undefined` = gating off (register all
   * profile-dir plugins); an array = gating on. Absent key → use config's
   * ENABLED_PLUGINS.
   */
  enabledPlugins?: string[] | undefined;
  api?: PluginApi;
}): Promise<string[]> {
  const pluginsDir = opts?.pluginsDir ?? path.join(PROFILE_DIR, 'plugins');
  const catalogDir = opts?.catalogDir ?? CATALOG_PLUGINS_DIR;
  const enabled =
    opts && 'enabledPlugins' in opts ? opts.enabledPlugins : ENABLED_PLUGINS;
  const api = opts?.api ?? defaultApi();

  // Import both sources up front. Catalog first so a same-named profile plugin
  // registered later can shadow it (profile > catalog).
  const discovered = [
    ...(await discoverPlugins(catalogDir, 'catalog')),
    ...(await discoverPlugins(pluginsDir, 'profile')),
  ];

  const gatingOff = enabled === undefined;
  const enabledSet = new Set(enabled ?? []);

  /** True when this discovered plugin should be REGISTERED. */
  function shouldRegister(p: DiscoveredPlugin): boolean {
    // Backward compat: gating off → register every PROFILE-dir plugin, and
    // keep the catalog dark (catalog is opt-in only, never on by default).
    if (gatingOff) return p.source === 'profile';
    // Gating on → register only ids in the enable-list, from either source.
    return enabledSet.has(p.id);
  }

  const loaded: string[] = [];
  for (const p of discovered) {
    if (!shouldRegister(p)) continue;
    if (!p.register) {
      logger.warn(
        { plugin: p.file, source: p.source },
        'Plugin has no default/register() export — skipped',
      );
      continue;
    }
    try {
      await p.register(api);
      loaded.push(p.file);
      logger.info(
        { plugin: p.file, id: p.id, source: p.source },
        'Registered plugin',
      );
    } catch (err) {
      // A broken plugin's registration must not take down the process.
      logger.error(
        { err, plugin: p.file, source: p.source },
        'Failed to register plugin',
      );
    }
  }

  // Observability: discovered vs registered, and any enabled id that matched
  // no discovered plugin (typo / removed plugin) — warn, don't crash.
  const registeredIds = new Set(
    discovered.filter((p) => loaded.includes(p.file)).map((p) => p.id),
  );
  const discoveredIds = new Set(discovered.map((p) => p.id));
  const unknown = gatingOff
    ? []
    : [...enabledSet].filter((id) => id && !discoveredIds.has(id));
  for (const id of unknown) {
    logger.warn(
      { id },
      'ENABLED_PLUGINS lists a plugin id that no discovered plugin declares — ignored',
    );
  }
  logger.info(
    {
      discovered: discovered.map((p) => p.id),
      registered: [...registeredIds],
      gating: gatingOff ? 'off (legacy: all profile plugins)' : 'on',
      unknown,
    },
    'Plugin discovery complete',
  );

  return loaded;
}
