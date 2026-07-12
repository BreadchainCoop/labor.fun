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

## Per-plugin config (M2)

A catalog plugin is one shared piece of code parameterized per tenant. Its config
object is delivered as the **second argument** to its register function
(`register(api, config)`), sourced from `PLUGIN_CONFIG[<plugin id>]`, which merges
two sources at the plugin-id level:

- **base** — the profile's `pluginConfig` in `profile.config.json`:

  ```jsonc
  {
    "enabledPlugins": ["weekly-agenda", "admin-email"],
    "pluginConfig": {
      "weekly-agenda": { "facilitatorPool": ["alice", "bob"], "meetingDay": 3 },
      "admin-email": { "githubRepo": "acme/admin", "notifyChannelJid": "slack:C123" }
    }
  }
  ```

- **override** — the `PLUGIN_CONFIG_JSON` env var (hosted per-tenant injection),
  a JSON object keyed by plugin id. Its entry for an id **replaces** the profile's
  entry for that id wholesale (a shallow, id-level merge — not a deep merge):

  ```
  PLUGIN_CONFIG_JSON={"weekly-agenda":{"facilitatorPool":["carol"]}}
  ```

Malformed `PLUGIN_CONFIG_JSON` throws loudly at startup. A plugin with no config
receives `{}`. Config **keys** are logged (never values — a config may hold emails
or people names). Catalog plugins take `profileDir` from the `PluginApi` (they
live outside the profile, so they cannot derive it from `import.meta.url`).

The catalog plugins keep their per-week/per-target **content** in the KB (so ops
can edit it from the dashboard); plugin config supplies the **defaults** those KB
files omit plus the runtime knobs (tick cadence, which shared-KB group to watch).
KB `config.md` values always win over the config defaults.

## Available catalog plugins

| id              | Kind        | What it does                                                                                                                                                                             |
| --------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hello-catalog` | integration | Reference/no-op plugin — logs a line on register + a slow tick. Fork it as a starting point.                                                                                            |
| `weekly-agenda` | integration | Weekly-meeting agenda automation: each week builds a decision-ready agenda doc (archives last week, pulls each owner's merged PRs/closed issues + deadlines + goals read), announces it after a verified build, then DMs/nudges owners to fill their sections and escalates once after `max_nudges`. Per-week content lives in `groups/<sharedKbGroup>/context/weekly-agenda/config.md`. |
| `admin-email`   | integration | Administrative-email → auto-issues: keeps one recurring triage task scheduled (schedule/cancel/reschedule) that reads forwarded admin mail via the `gws` gmail tool, classifies it, opens a GitHub issue, and DMs the owner. Targets live in `groups/<sharedKbGroup>/context/admin-email/config.md` (or entirely in config). |

### `weekly-agenda` config keys

All keys optional. Runtime knobs plus **defaults** for the KB `config.md`
(a `config.md` frontmatter key of the same name, e.g. `meeting_day`, always wins).

| key                 | type       | default   | meaning                                                                                     |
| ------------------- | ---------- | --------- | ------------------------------------------------------------------------------------------- |
| `tickMs`            | number     | `21600000` (6h) | How often the reconcile loop runs.                                                     |
| `firstTickDelayMs`  | number     | `60000` (60s)   | Delay before the first tick after startup.                                            |
| `sharedKbGroup`     | string     | `""`      | Which group's `context/` holds config + state. Empty → the profile's `sharedKbGroup`.       |
| `meetingDay`        | integer    | `3` (Wed) | Default weekly meeting day (0=Sun..6=Sat) when `config.md` omits `meeting_day`.              |
| `meetingHour`       | integer    | `16`      | Default meeting hour (local, 24h) when `config.md` omits `meeting_hour`.                     |
| `prepDaysBefore`    | number     | `2`       | Default days before the meeting the prep window opens (`prep_days_before`).                  |
| `nudgeEveryDays`    | number     | `1`       | Default days between owner nudges (`nudge_every_days`).                                      |
| `maxNudges`         | number     | `3`       | Default max DM nudges before escalating once in-channel (`max_nudges`).                      |
| `refreshHoursBefore`| number     | `0` (off) | Default hours before the meeting to run a light auto-facts refresh (`refresh_hours_before`). |
| `facilitatorPool`   | string[]   | `[]`      | Default facilitator-rotation pool (KB people slugs) when `config.md` omits `facilitator_pool`. |

The per-week **content** — `channel_jid`, `doc_id`, `this_week_tab_id`,
`archive_tab_id`, `owners` map, `facilitators` rota, `directives_doc`,
`deadline_digest`, `github_org`, `corrector_base_url`/`corrector_password` — lives
in the KB `config.md` (see `profiles/example/.../context/weekly-agenda/README.md`).

### `admin-email` config keys

All keys optional. Runtime knobs plus **defaults** for the KB `config.md`
(`config.md` frontmatter `triage_cron` / `github_repo` / `notify_channel_jid`
always win). If there is no `config.md` at all but `notifyChannelJid` is set in
config, the flow runs entirely from these defaults.

| key                | type   | default        | meaning                                                                                   |
| ------------------ | ------ | -------------- | ----------------------------------------------------------------------------------------- |
| `tickMs`           | number | `21600000` (6h)| How often the reconcile loop runs (the triage itself runs on its own cron task).          |
| `firstTickDelayMs` | number | `90000` (90s)  | Delay before the first tick after startup.                                                |
| `sharedKbGroup`    | string | `""`           | Which group's `context/` holds config + state. Empty → the profile's `sharedKbGroup`.     |
| `triageCron`       | string | `"0 */2 * * *"`| Default triage cadence (cron) when `config.md` omits `triage_cron`.                        |
| `githubRepo`       | string | `""`           | Default `owner/repo` to file issues in (`github_repo`); empty → the org's default issues repo. |
| `notifyChannelJid` | string | `""`           | Default channel JID for the triage summary (`notify_channel_jid`). Required for the flow to run. |
