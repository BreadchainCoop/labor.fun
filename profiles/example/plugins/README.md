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

## House-governance suite (chores + hearts + things)

`chores.mjs`, `hearts.mjs`, and `things.mjs` are a reference suite for
coliving/coop houses — self-governance without a house manager:

- **chores** — a point-based chore wheel. Undone chores accrue value over the
  month (weighted by per-chore `speed`); claims are peer-verified by emoji
  reaction poll before points are credited.
- **hearts** — an accountability layer. Residents carry hearts (baseline 5,
  max 10) that drift toward baseline monthly; karma (`<@user> ++`) earns top
  receivers a heart, heart challenges go to a house vote, and monthly chore
  completion feeds back into hearts (bonus for a full budget, penalty for
  shortfall — read file-to-file from the chores ledger, no core hooks).
- **things** — procurement. A house fund plus a catalog of buyable things;
  buys and catalog changes are approved by reaction poll, with vote thresholds
  scaled by price and by the buyer's hearts.

The governance mechanisms (parameters, vote thresholds, regen/karma/penalty
math) are reimplemented from the mechanism designs of
[choreWheel](https://github.com/zaratanDotWorld/choreWheel) by Zaratan /
Daniel Kronovet (AGPL-3.0). This is an independent implementation against the
labor.fun plugin surface — no choreWheel code is copied — written so the
numeric behavior matches upstream (see the `upstream:` references in each
file and the parity tests in `__tests__/`). If you want the full hosted
product, use choreWheel itself.

Each plugin is a silent no-op until its `config.json` exists under
`groups/<sharedKbGroup>/<app>/`; see the companion container skills
(`container-skills/{chores,hearts,things}/SKILL.md`) for the agent-facing
commands, file formats, and setup. When adopting the suite in your org
profile, also add a short summary of the three mechanisms to your group's
`CLAUDE.md` so the agent reaches for the skills unprompted.

One caveat: the framework doesn't surface Slack `reaction_added` events to
plugins, so these poll `reactions.get` on their own poll messages (about one
API call per minute per open poll). If reaction events are ever surfaced to
plugins, the polling can be dropped.
