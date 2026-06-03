# Profile plugins

Drop org-specific **channels** and **background flows** here. Every `.js` /
`.mjs` file in this directory is loaded at startup; its `default` (or named
`register`) export is called with a small API so it can self-register without
importing framework internals by path:

```js
// profiles/<org>/plugins/my-plugin.mjs
export default function register({ registerChannel, registerIntegration, readEnvFile, logger }) {
  // a channel:
  registerChannel('sms', (opts) => {
    const env = readEnvFile(['TWILIO_SID', 'TWILIO_TOKEN']);
    if (!env.TWILIO_SID) return null; // missing creds → skipped
    return new SmsChannel(opts, env);
  });

  // or a background flow:
  registerIntegration({
    name: 'nightly-export',
    start: () => setInterval(() => exportToSheets(), 86_400_000),
  });
}
```

Plugins are **plain JS** (no build step — the framework build compiles `src/`,
not `profiles/`). They load *after* the core channels/flows, so a plugin can add
new ones or shadow a built-in by re-registering the same name. A broken plugin
is logged and skipped; it never takes down the process.

See `docs/PLUGINS.md` for the full contract and the `Channel` / `Integration`
interfaces.
