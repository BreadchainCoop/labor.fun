// hello-catalog.mjs — the reference first-party CATALOG plugin.
//
// This lives in the baked catalog (container/catalog-plugins/, COPYed into the
// orchestrator image at /app/catalog-plugins). Unlike a profile's own
// plugins/ dir, catalog plugins are POLICY-CLOSED: discovered and imported at
// boot, but only REGISTERED when their `id` appears in ENABLED_PLUGINS (the
// active profile's `enabledPlugins` or the ENABLED_PLUGINS env var). Left out of
// that list, this plugin is inert — it never registers a channel or flow, so it
// cannot affect a profile that hasn't opted in.
//
// The plugin's id is its filename without extension ("hello-catalog") unless it
// exports `id`. We export it explicitly here to make the manifest convention
// concrete. See container/catalog-plugins/README.md.

/** Manifest: stable id (matched against ENABLED_PLUGINS) + kind. */
export const id = 'hello-catalog';
export const kind = 'integration';

// Same contract as a profile plugin: a default (or named `register`) export
// that receives the PluginApi and self-registers channels/flows through it.
export default function register({ registerIntegration, logger }) {
  let timer;
  registerIntegration({
    name: 'hello-catalog',
    start: () => {
      logger.info('[hello-catalog] catalog plugin registered (opted in)');
      // Replace with real work in a forked catalog plugin (poll an API, sync
      // to the KB, add a channel, etc.). Kept trivial as a reference.
      timer = setInterval(
        () => logger.info('[hello-catalog] tick'),
        3_600_000,
      );
      timer.unref?.();
    },
    stop: () => clearInterval(timer),
  });
}
