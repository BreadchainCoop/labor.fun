// Generic kb-ui plugin-route hook.
//
// Catalog/profile plugins may ship a dashboard slice alongside their
// orchestrator entry: `<plugin dir>/<id>/kb-ui/index.mjs` exporting
//
//   createRoutes(deps) -> express.Router   mounted at `/<id>`
//   navCards(deps)     -> [{ href, title, desc, icon?, roles? }]
//
// `deps` is the injection surface server.mjs builds (layout, esc, role
// predicates, usernameFromReq, Database ctor + DB_PATH, PROFILE_DIR,
// CONTEXT_DIR, logger). Which plugins mount mirrors the orchestrator's
// ENABLED_PLUGINS gating (src/config.ts): profile.config.json `enabledPlugins`
// unioned with the ENABLED_PLUGINS env var; neither present -> gating off ->
// nothing mounts (catalog plugins are policy-closed, off by default).
//
// Failures NEVER crash kb-ui: a missing kb-ui module is normal (most plugins
// are orchestrator-only), and a broken one is logged and skipped.
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

/**
 * Mirror src/config.ts ENABLED_PLUGINS semantics for the kb-ui process:
 * union of the profile's `enabledPlugins` and the ENABLED_PLUGINS env var
 * (comma-separated OR a JSON array). Returns undefined when neither source
 * declares a list (gating off — no kb-ui plugin mounts). Unlike the
 * orchestrator (which throws loudly at startup), malformed input here logs
 * and degrades: kb-ui must keep serving the KB.
 */
export function resolveEnabledPluginIds(
  profileEnabled,
  envRaw,
  logger = console,
) {
  const envSet = typeof envRaw === 'string' && envRaw.trim() !== '';
  let fromEnv = [];
  if (envSet) {
    const trimmed = envRaw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        fromEnv = Array.isArray(parsed)
          ? parsed.filter((id) => typeof id === 'string').map((id) => id.trim())
          : [];
      } catch (err) {
        logger.warn(
          `[kb-ui] ENABLED_PLUGINS env var is not valid JSON — ignoring: ${err.message}`,
        );
      }
    } else {
      fromEnv = trimmed
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  const profileSet = Array.isArray(profileEnabled);
  const fromProfile = profileSet
    ? profileEnabled.filter((id) => typeof id === 'string').map((id) => id.trim())
    : [];

  if (!profileSet && !envSet) return undefined; // gating off
  return Array.from(new Set([...fromProfile, ...fromEnv].filter(Boolean)));
}

/**
 * Resolve the baked first-party catalog dir the same way the orchestrator
 * does (src/config.ts CATALOG_PLUGINS_DIR): prefer `<root>/catalog-plugins`
 * (orchestrator image layout), else `<root>/container/catalog-plugins`
 * (dev checkout).
 */
export function resolveCatalogDir(root = process.cwd()) {
  const baked = path.join(root, 'catalog-plugins');
  if (fs.existsSync(baked)) return baked;
  return path.join(root, 'container', 'catalog-plugins');
}

// Plugin ids become URL mounts and path segments — refuse anything that could
// escape the plugin dirs (`../`, separators) or produce a weird mount.
const SAFE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * Discover + import the kb-ui module of every enabled plugin.
 *
 * For each id, `<profileDir>/plugins/<id>/kb-ui/index.mjs` is preferred over
 * `<catalogDir>/<id>/kb-ui/index.mjs` (profile shadows catalog, matching the
 * orchestrator loader). Returns `{ mounts, navCards }`:
 *   - mounts:   [{ id, mount: '/<id>', router }] for app.use(mount, router)
 *   - navCards: [{ pluginId, href, title, desc, icon?, roles? }] for the home page
 *
 * Absent dirs/modules are skipped silently; import or createRoutes/navCards
 * failures are logged and skipped — never thrown.
 */
export async function loadKbUiPlugins({
  enabledIds,
  catalogDir,
  profileDir,
  deps,
  logger = console,
}) {
  const mounts = [];
  const navCards = [];
  for (const id of enabledIds ?? []) {
    if (!SAFE_ID_RE.test(id)) {
      logger.warn(`[kb-ui] skipping plugin with unsafe id: ${JSON.stringify(id)}`);
      continue;
    }
    const candidates = [
      path.join(profileDir, 'plugins', id, 'kb-ui', 'index.mjs'),
      path.join(catalogDir, id, 'kb-ui', 'index.mjs'),
    ];
    const file = candidates.find((f) => fs.existsSync(f));
    if (!file) continue; // plugin has no dashboard slice — normal
    try {
      const mod = await import(pathToFileURL(file).href);
      if (typeof mod.createRoutes === 'function') {
        const router = mod.createRoutes(deps);
        if (router) mounts.push({ id, mount: '/' + id, router });
      }
      if (typeof mod.navCards === 'function') {
        const cards = mod.navCards(deps);
        for (const c of Array.isArray(cards) ? cards : []) {
          if (c && typeof c.href === 'string' && typeof c.title === 'string') {
            navCards.push({ pluginId: id, ...c });
          }
        }
      }
    } catch (err) {
      logger.error(
        `[kb-ui] failed to load kb-ui module for plugin "${id}" (${file}): ${err && err.stack ? err.stack : err}`,
      );
    }
  }
  return { mounts, navCards };
}

/**
 * Should `card` be shown to `username`? `roles` (optional) is an array of
 * 'admin' | 'superadmin' | 'coordinator' | 'resident'; the card shows when the
 * user holds ANY listed role. No `roles` -> visible to every authenticated user.
 */
export function navCardVisible(card, username, roles = {}) {
  if (!Array.isArray(card.roles) || card.roles.length === 0) return true;
  const checks = {
    admin: roles.isAdmin,
    superadmin: roles.isSuperAdmin,
    coordinator: roles.isCoordinator,
    resident: roles.isResident,
  };
  return card.roles.some((r) => {
    const fn = checks[r];
    return typeof fn === 'function' && fn(username);
  });
}
