# Extending labor.fun

labor.fun has six extension points. They all follow the **same shape**: a small
module **self-registers** with a registry, and a barrel file imports it so the
registration runs at startup. Nothing edits the core message loop.

| Extension | Registry | Barrel | Add an org-specific one in |
|---|---|---|---|
| Channel | `src/channels/registry.ts` | `src/channels/index.ts` | `src/channels/` (built-in) or **`<profile>/plugins/`** |
| Flow (background integration) | `src/integrations/registry.ts` | `src/integrations/index.ts` | `src/integrations/` (built-in) or **`<profile>/plugins/`** |
| Chat flow (sandboxed channel takeover) | `src/chat-flows/registry.ts` | `src/chat-flows/index.ts` | `src/chat-flows/` (built-in) or **`<profile>/plugins/`** |
| Container skill | filesystem | — | `container/skills/` or `<profile>/container-skills/` |
| Setup step | `setup/index.ts` `STEPS` | — | `setup/` |
| Rules / KB | filesystem (markdown) | — | `rules/` (core) + `<profile>/groups/` (org) |
| **Infra / deploy** | `profiles/<org>/deploy.config` | — | each org's profile |

> **Org-specific vs built-in.** Anything in `src/` ships with the framework and
> is shared by every org. For per-org capabilities — which is the norm when one
> install serves multiple organizations — put **channels and flows in
> `<profile>/plugins/`** (below), skills in `<profile>/container-skills/`, and
> infra in `<profile>/deploy.config`. No framework edits, no merge conflicts
> between orgs.

## 0. Profile plugins (per-org channels &amp; flows)

The cleanest place for an org's own code. Every `.js`/`.mjs`/`.cjs` file in the
active profile's `plugins/` directory is loaded at startup (after the built-ins)
and its `default` (or named `register`) export is called with a small API:

```js
// profiles/<org>/plugins/sms.mjs
export default function register({ registerChannel, registerIntegration, registerChatFlow, readEnvFile, logger }) {
  registerChannel('sms', (opts) => {
    const env = readEnvFile(['TWILIO_SID', 'TWILIO_TOKEN']);
    if (!env.TWILIO_SID) return null;        // missing creds → skipped
    return new SmsChannel(opts, env);
  });

  registerIntegration({
    name: 'nightly-export',
    start: () => setInterval(() => exportToKb(), 86_400_000),
  });
}
```

The `PluginApi` exposes `registerChannel`, `registerIntegration`,
`registerChatFlow`, `readEnvFile`, and `logger`. Plugins are **plain JS** (the
framework build compiles `src/`, not
`profiles/`), load in filename order, can shadow a built-in by re-registering
the same name, and are isolated — a throwing plugin is logged and skipped, never
fatal. The `Channel` / `Integration` interfaces below define what to return.

For complete reference plugins — real org workflows driven entirely through the
KB and IPC filesystem contracts, with zero secrets and zero framework imports —
see:

- `profiles/example/plugins/sd-kickoff.mjs` — quarterly Strategic Directives
  kickoff (multi-nudge input collection + AI first draft).
- `profiles/example/plugins/peer-reviews.mjs` — quarterly peer-review +
  self-evaluation tracking (round-robin assignment, per-member nudge ladder,
  status summary; the companion skill files reviews and books review meetings
  via the agent's `gws` calendar tool).
- `profiles/example/plugins/admin-email.mjs` — administrative email →
  auto-issues. The plugin just keeps one recurring triage task in sync with KB
  config (schedule/cancel/reschedule); the companion skill reads forwarded mail
  via the agent's `gws` gmail tool, classifies it, and opens GitHub issues.

Each pairs with a container skill under
`profiles/example/container-skills/<name>/` for the agent-side half.

---

## 0b. The plugin catalog (first-party, enable + configure per tenant)

Profile plugins (§0) live in a tenant's own `<profile>/plugins/` dir — one org's
private code. The **catalog** is the complement: a menu of **vetted, first-party
plugins that ship with the framework** (`container/catalog-plugins/`, baked into
the orchestrator image at `/app/catalog-plugins`). Every hosted tenant carries
the same menu; each tenant chooses which items to run and how to configure them.

This is the **"mechanisms-open / policy-closed"** split:

- **mechanism** (the plugin code) ships to everyone in the image, and
- **policy** (which tenant runs which plugin, with what config) is per-tenant
  config — never a code change.

### The full contract

A catalog plugin is gated by **two** config surfaces, each with a profile form
and an env form. The env form always **wins** (it is how the hosted control plane
injects per-tenant policy without editing profile files):

| What | `profile.config.json` | Env var | Shape |
|---|---|---|---|
| **Which** plugins register | `enabledPlugins` | `ENABLED_PLUGINS` | array of ids / comma-or-JSON-array list |
| **How** each plugin is configured | `pluginConfig` | `PLUGIN_CONFIG_JSON` | object keyed by plugin id → that plugin's config object |

```jsonc
// profiles/<org>/profile.config.json
{
  "enabledPlugins": ["weekly-agenda", "admin-email"],
  "pluginConfig": {
    "weekly-agenda": { "facilitatorPool": ["alice", "bob"], "meetingDay": 3 },
    "admin-email": { "githubRepo": "acme/admin", "notifyChannelJid": "slack:C123" }
  }
}
```

```bash
# …or, hosted per-tenant injection (env wins over the profile):
ENABLED_PLUGINS=weekly-agenda,admin-email
PLUGIN_CONFIG_JSON={"weekly-agenda":{"facilitatorPool":["carol"]}}
```

**Gating (`ENABLED_PLUGINS`).** `enabledPlugins`/`ENABLED_PLUGINS` merge to a
single set of ids. A plugin registers only if its `id` is in that set — from
*either* source (catalog or profile dir). Backward-compat is exact: when the list
is **absent everywhere**, gating is **off** and the legacy behavior is preserved —
every profile-dir plugin registers and the catalog stays dark. An explicit list
(even `[]`) turns gating **on**. See `src/config.ts` (`ENABLED_PLUGINS`) and
`src/plugin-loader.ts`.

**Config (`PLUGIN_CONFIG`).** `pluginConfig` (base) and `PLUGIN_CONFIG_JSON`
(override) merge **at the plugin-id level**: the env's entry for an id *replaces*
the profile's entry for that id wholesale (a shallow, id-level merge — not a deep
merge of the two config objects). The loader hands each plugin
`PLUGIN_CONFIG[<id>] ?? {}` as the **second argument** to its register function:

```js
// container/catalog-plugins/<id>.mjs
export const id = 'weekly-agenda';
export const kind = 'integration';
export default function register(api, config) {
  // api: registerChannel / registerIntegration / registerChatFlow /
  //      readEnvFile / logger / profileDir
  // config: this tenant's config for THIS plugin (always an object, never undefined)
}
```

A legacy one-arg `register(api)` still works unchanged (it just ignores the
config). Config **keys** are logged on register; **values are never logged** (a
config may hold emails or people names). Malformed `PLUGIN_CONFIG_JSON` throws
loudly at startup — a silently-ignored tenant config looks like a working plugin
mysteriously running on defaults.

Catalog plugins take `profileDir` from `api` (not `import.meta.url`): they live
*outside* the profile, so they cannot derive the profile root the way a
profile-dir plugin can. That is how the ported `weekly-agenda` / `admin-email`
plugins locate their KB config and IPC dirs.

The two ported plugins and their full config-key schema (types + defaults) are in
[`container/catalog-plugins/README.md`](../container/catalog-plugins/README.md).

### How the hosted SaaS delivers this

The control plane never delivers **code** to a running tenant — the plugin code is
already in the (published, immutable) orchestrator image every tenant shares.
Enabling/reconfiguring a plugin is purely an **env change**:

1. The operator toggles a plugin (or edits its config) for a tenant in the control
   plane.
2. The control plane patches that tenant's env — `ENABLED_PLUGINS` and/or
   `PLUGIN_CONFIG_JSON` — and **rolls the pod**.
3. On restart the plugin loader reads the new env and registers/configures
   accordingly. No image rebuild, no code push, no profile-file edit on the host.

This keeps the delivery path for policy (a two-key env patch) completely separate
from the delivery path for mechanism (publishing a new image with new catalog
code), which is what lets the same image serve every tenant.

### TEE note (measured deployments)

In a TEE deployment the catalog plugins ship **inside the MEASURED orchestrator
image** — their code is vouched for by the image digest, which the attestation
already covers. `ENABLED_PLUGINS` and `PLUGIN_CONFIG_JSON` ride the **sealed
`.env.tee`** env, not the compose file. So **enabling or configuring a catalog
plugin does NOT change `compose_hash`** — only the (already-published) image digest
attests to the plugin code, and the sealed env carries the per-tenant policy. A
tenant can turn a first-party plugin on/off and reconfigure it without
re-measuring the compose, because no new code enters the enclave — it was always
in the measured image, merely dormant until its id was enabled.

---

## 1. Channels

A channel is an I/O adapter (Slack, Telegram, Discord, …). Implement the
`Channel` interface (`src/types.ts`) and self-register a factory. See also
[`docs/WEB-WIDGET.md`](WEB-WIDGET.md) for the browser-embeddable web chat widget
channel — a fuller worked example of a channel that opens its own HTTP server.

```ts
// src/channels/mychannel.ts
import { registerChannel } from './registry.js';
import { readEnvFile } from '../env.js';

registerChannel('mychannel', (opts) => {
  const env = readEnvFile(['MYCHANNEL_TOKEN']);
  if (!env.MYCHANNEL_TOKEN) return null;     // missing creds → gracefully skipped
  return new MyChannel(opts);
});
```

Then add `import './mychannel.js';` to `src/channels/index.ts`. The factory
receives `opts` (`onMessage`, `onChatMetadata`, `registeredGroups`,
`registerGroup`, `deregisterGroup`) and must call `opts.onMessage(jid, message)`
for inbound traffic. JIDs are prefixed by channel (`slack:`, `tg:`, `dc:`).

## 2. Flows (background integrations)

A **flow** is anything that runs alongside the message loop — a polling loop that
syncs an external system into the KB, a recurring job, etc. This is the mechanism
for **application-specific flows**. Mirror the channel pattern:

```ts
// src/integrations/my-sync.ts  (or <profile>/plugins/my-sync.ts)
import { registerIntegration } from './registry.js';

export function startMySyncLoop(): void {
  // read config; no-op if disabled; setInterval(...) to poll
}

registerIntegration({
  name: 'my-sync',
  start: () => startMySyncLoop(),
  stop: () => { /* clear timers */ },
});
```

Register it from `src/integrations/index.ts` (the barrel). The orchestrator calls
`startRegisteredIntegrations()` after channels connect; each integration checks
its own config and no-ops when unconfigured. The built-in flows
(`group-digest`, `github-project-sync`, `discord-members-sync`) are the
reference implementations.

### Knowledge connectors (a specialized flow)

A **knowledge connector** is a flow that syncs external documents (Notion,
Google Drive, Confluence, …) **into the per-group markdown KB** so per-doc RBAC,
search, and citations apply for free. Connectors share a small framework
(`src/integrations/connectors/base.ts`) — you implement a `Connector`
(`{ name, syncInterval, isConfigured, sync(ctx) }` returning `ConnectorDoc`s),
and the framework does the KB writes, upsert idempotency, deletion-on-removal,
path-safety, citable `source_url` frontmatter, and cursor bookkeeping. See
[CONNECTORS.md](CONNECTORS.md) for the two built-in connectors (Notion, Google
Drive), how to enable them, and how to write your own — including as a per-org
profile plugin.

## 2b. Chat flows (sandboxed channel takeover)

A **chat flow** claims specific chat JIDs and *replaces* the general assistant
there with a sandboxed, single-purpose agent — for **external/untrusted**
channels (a public intake desk, a support kiosk, …). The orchestrator enforces
the trust boundary for every flow chat:

- the agent run is forced **non-privileged** (sandboxed mounts, no DB),
  restricted to the flow's `allowedTools`, with the flow's `systemPrompt`
  persona appended;
- the chat is **exempt from the sender allowlist** (public by design — anyone
  may write);
- **all IPC from the chat's group folder is ignored** (defense in depth
  against prompt injection).

Side effects happen on the privileged orchestrator side, in the flow's
`onAgentResult` — the sandboxed container has no write path of its own:

```ts
// src/chat-flows/my-desk.ts  (or via registerChatFlow in <profile>/plugins/)
import { registerChatFlow } from './registry.js';

registerChatFlow({
  name: 'my-desk',
  matches: (jid) => jid === readDeskJidFromEnv(),
  allowedTools: ['Read', 'Glob', 'Grep'],          // read-only sandbox
  systemPrompt: 'You are the public help desk. …', // injection-hardened persona
  async onAgentResult(output, triggerMsg, chatJid, host) {
    // Detect a sentinel in `output`, file records, notify ops via
    // host.notify(jid, text) — attribute to triggerMsg.sender, never to
    // anything the agent claims. Return the user-facing reply ('' = silent).
    return output;
  },
});
```

Built-ins self-register via the barrel (`src/chat-flows/index.ts`).
`src/chat-flows/membership-intake.ts` — the external membership-intake desk
(#30) — is the reference implementation, including the sentinel pattern for
flagging events to the privileged side.

## 3. Container skills

Agent-side capabilities are plain `SKILL.md` folders synced into each container's
`~/.claude/skills/`. Two sources are layered, profile on top of core:

```
container/skills/<skill>/SKILL.md            # core — every org gets these
<profile>/container-skills/<skill>/SKILL.md  # org-specific — adds or overrides
```

Drop a folder in either location; no code change. Profile skills with the same
folder name override the core skill.

### Optional (off-by-default) skills

A skill can be present on disk but stay **disabled** until an install explicitly
turns it on. This is for heavy or niche knowledge bases that most orgs don't
need loaded into every container — and, in particular, for skills you want to
keep **private and out of this repo entirely**.

Mark a skill optional by adding `default: false` to its `SKILL.md` frontmatter:

```yaml
---
name: my-skill
description: Short description of what this skill is for …
default: false
---
```

Such a skill is **skipped** by the container-runner skill sync unless its folder
name appears in the install's enable list:

- **Per profile** — add it to `enabledSkills` in `profile.config.json`:

  ```json
  { "enabledSkills": ["my-skill"] }
  ```

- **Per install** — set the `ENABLED_SKILLS` env var (comma-separated). Values
  from both sources are merged.

Skills without the `default: false` flag always load, so this is fully
backwards-compatible — existing skills are unaffected.

#### Keeping an optional skill private (off-repo)

The per-profile overlay (`<profile>/container-skills/`) is **gitignored**, so a
skill placed there never lands in this framework repo. Combine that with the
opt-in flag to add a private skill entirely on the server:

1. Create `<profile>/container-skills/<name>/SKILL.md` on the host (with
   `default: false` if you also want it toggleable), plus any reference files.
2. Enable it via the profile's `enabledSkills` (or `ENABLED_SKILLS`).

The skill syncs into that org's containers only, stays out of the public repo,
and the framework needs no changes to host it.

## 3b. Remote MCP servers (config-driven tool access)

Beyond the built-in MCP servers wired directly into the agent
(`nanoclaw`/`gws`/`github`/`linear`), an org can add **any** MCP server —
hosted remote (streamable HTTP + Bearer/header auth) or local stdio — purely
via config: `mcpServers` in `profile.config.json`, or the `MCP_SERVERS` env var
for a hosted/multi-tenant install. No framework code change, no new
registration mechanism — the entry is validated at startup and, once its
referenced env var(s) are set, shows up in every agent container's
`mcpServers` map and `mcp__<name>__*` tool allowlist. This is how you add
Zapier (30k+ actions across 9k apps), Jira/Confluence, Stripe, Notion,
PagerDuty, or any other MCP-speaking service. See
[MCP-SERVERS.md](MCP-SERVERS.md) for the config schema, the exact
config-to-container path, and a worked Zapier example.

## 4. Setup steps

Install-wizard steps are modules in `setup/` registered in the `STEPS` map
(`setup/index.ts`). Each exports `run(args: string[])` and emits a status block:

```ts
// setup/mystep.ts
export async function run(args: string[]): Promise<void> {
  // ... perform setup ...
  emitStatus('MYSTEP', { STATUS: 'success' });
}
```

Add `mystep: () => import('./mystep.js')` to `STEPS`. Run it with
`npx tsx setup/index.ts --step mystep`.

## 5. Rules & knowledge

- **Core rules** (`rules/`) define framework-wide behavior every org inherits:
  access control, messaging, scheduling, identity, transcripts. Keep these
  org-agnostic — reference config (`githubOrg`, `orgName`) rather than hardcoding.
- **Org knowledge** lives in the profile: `<profile>/groups/*/CLAUDE.md` for
  agent instructions and `<profile>/groups/<sharedKbGroup>/context/` for the KB
  (people, tasks, calendar, artifacts).

---

## Where org-specific code should live

Prefer the **profile** for anything org-specific so the framework stays clean:

- Config/identity → `<profile>/profile.config.json`
- Agent instructions & KB → `<profile>/groups/`
- Org-only agent skills → `<profile>/container-skills/`
- Org-only flows/plugins → `<profile>/plugins/` (import them from a barrel)

Reserve `src/` changes for capabilities that benefit **every** org — those are
true framework features and belong in the core registries above.
