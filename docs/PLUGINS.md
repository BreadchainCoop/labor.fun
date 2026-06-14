# Extending labor.fun

labor.fun has five extension points. They all follow the **same shape**: a small
module **self-registers** with a registry, and a barrel file imports it so the
registration runs at startup. Nothing edits the core message loop.

| Extension | Registry | Barrel | Add an org-specific one in |
|---|---|---|---|
| Channel | `src/channels/registry.ts` | `src/channels/index.ts` | `src/channels/` (built-in) or **`<profile>/plugins/`** |
| Flow (background integration) | `src/integrations/registry.ts` | `src/integrations/index.ts` | `src/integrations/` (built-in) or **`<profile>/plugins/`** |
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
export default function register({ registerChannel, registerIntegration, readEnvFile, logger }) {
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

The `PluginApi` exposes `registerChannel`, `registerIntegration`, `readEnvFile`,
and `logger`. Plugins are **plain JS** (the framework build compiles `src/`, not
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

Each pairs with a container skill under
`profiles/example/container-skills/<name>/` for the agent-side half.

---

## 1. Channels

A channel is an I/O adapter (Slack, Telegram, Discord, …). Implement the
`Channel` interface (`src/types.ts`) and self-register a factory:

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
