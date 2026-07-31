// residency.mjs — the residency vertical as a first-party CATALOG plugin.
//
// Ported from lil_salem (rooms, occupancy, residency applications, Gantt).
// Policy-closed like every catalog plugin: inert unless 'residency' appears in
// ENABLED_PLUGINS (profile `enabledPlugins` or the env var).
//
// The plugin splits across the two processes:
//   - DATA LAYER: first-class in the framework — src/db.ts owns the schema
//     (rooms / room_occupancy / residency_requests) and the accessors. The
//     tables are additive CREATE IF NOT EXISTS, so they exist on every install;
//     they only carry data where this plugin is enabled.
//   - UI + JSON APIs: the kb-ui slice at ./residency/kb-ui/index.mjs, mounted
//     at /residency by kb-ui's generic plugin-route hook (kb-ui/plugin-mount.mjs)
//     when this id is enabled. The 3D map is the R3 module (buttons render
//     disabled until it ships).
//   - ORCHESTRATOR-SIDE features (agent tools / intake flows over
//     residency_requests) arrive in R4; registration is minimal until then.

/** Manifest: stable id (matched against ENABLED_PLUGINS) + kind. */
export const id = 'residency';
export const kind = 'integration';

export default function register(api, _config) {
  const { logger } = api;
  // R1+R2: schema + accessors live in src/db.ts (reachable via api.getDb());
  // the dashboard slice mounts via kb-ui. Nothing to run orchestrator-side yet
  // — log enablement so operators can see the toggle took effect.
  logger.info(
    '[residency] plugin enabled — /residency dashboard active in kb-ui; orchestrator-side flows arrive in R4',
  );
}
