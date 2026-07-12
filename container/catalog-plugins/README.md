# Plugin catalog (first-party, baked)

This directory is the framework's **first-party plugin catalog**. It is baked
into the orchestrator image (`deploy/docker/Dockerfile.orchestrator` COPYs it to
`/app/catalog-plugins`, next to `dist/`) so every hosted tenant ships the same
menu of vetted plugins without editing their profile.

## Policy: closed by default (opt-in per tenant)

Unlike a profile's own `profiles/<org>/plugins/` dir (whose plugins all load
today, unchanged), catalog plugins are **policy-closed**:

- **Discovered and imported at boot** — every `.mjs`/`.cjs`/`.js` here is
  `import()`-ed once at startup, so a later hot-enable never needs a re-import.
- **Registered only when opted in** — a catalog plugin's channels/flows
  self-register **only** if its `id` is listed in `ENABLED_PLUGINS` (the active
  profile's `enabledPlugins`, or the `ENABLED_PLUGINS` env var for hosted
  per-tenant injection). Absent from that list → the plugin is inert: imported
  but never registered, so it cannot affect a tenant that hasn't opted in.

This is the "mechanisms-open / policy-closed" split: the mechanism (the plugin
code) ships to everyone; the policy (which tenant runs it) is per-profile config.

## Manifest convention

Each catalog plugin is a plain-JS module using the same contract as a profile
plugin (`export default function register(api) { ... }` — see
`profiles/example/plugins/README.md` and `docs/PLUGINS.md`), plus a small
manifest so the loader can gate it:

| Export      | Meaning                                                             |
| ----------- | ------------------------------------------------------------------ |
| `id`        | Stable id matched against `ENABLED_PLUGINS`. Defaults to the file  |
|             | name without extension when not exported. Keep it URL-safe/kebab.  |
| `kind`      | Informational: `channel` \| `integration` \| `chat-flow`. For logs |
|             | and future tooling; does not change how the plugin is loaded.      |
| `default` / | The registration function. Receives the `PluginApi`               |
| `register`  | (`registerChannel` / `registerIntegration` / `registerChatFlow` /  |
|             | `readEnvFile` / `logger`) and self-registers through it.           |

See `hello-catalog.mjs` for the reference implementation.

## Enabling a catalog plugin

Add its `id` to the tenant's enable-list — either in the profile:

```jsonc
// profiles/<org>/profile.config.json
{ "enabledPlugins": ["hello-catalog"] }
```

or via env (hosted injection; comma-separated or a JSON array):

```
ENABLED_PLUGINS=hello-catalog
ENABLED_PLUGINS=["hello-catalog","another-id"]
```

Setting `enabledPlugins` (even to `[]`) turns gating **on** for that tenant. When
it is absent everywhere, gating stays **off** and the legacy behavior is
preserved exactly: every profile-dir plugin registers and the catalog stays
dark. See `src/plugin-loader.ts` and `src/config.ts` (`ENABLED_PLUGINS`).
