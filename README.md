# labor.fun

A standalone, multi-org framework for **multi-channel AI assistants**. It runs
Claude agents in isolated containers with per-group memory and a shared
knowledge base, and speaks Slack, Telegram, Discord, and CLI out of the box.

The framework is **org-agnostic**. Each organization is a self-contained
**profile** you drop into `profiles/<name>/` — its identity, knowledge base,
people, and runtime state. Nothing about a specific org is baked into the code.

> labor.fun is the framework formerly developed as "Breadbrich Engels / NanoClaw".
> `nanoclaw` remains the internal codename for the container/agent protocol.

## How it's organized

```
labor.fun/                  ← the framework (org-agnostic, reusable)
├── src/                    Orchestrator: message loop, channels, DB, IPC, scheduler
├── container/              Agent container image + runtime skills
├── kb-ui/                  Admin dashboard (self-host; see "Self-host vs hosted")
├── rules/                  Core operating rules the agent follows
├── setup/                  Install wizard steps
└── profiles/              ← org instances (only `example` is tracked)
    └── example/            A copy-me template for new orgs
        ├── profile.config.json   identity & config (single source of truth)
        ├── groups/               per-group memory + KB context
        ├── deploy.config         per-org host: paths, service names, user
        ├── container-skills/      optional org-specific agent skills
        └── plugins/               optional org-specific channels & flows
```

A real org (e.g. `profiles/acme/`) is created **locally** from `example` and is
**gitignored** — its config, KB, plugins, infra, `store/`, and `data/` live only
on that org's clone/host, never in the shared framework repo.

**Active profile** is selected at startup: `LABOR_PROFILE=<name>` (in `.env`),
else the single profile present, else the repo root (legacy/dev layout).

## Quick start for a new org

See **[docs/NEW-ORG-GUIDE.md](docs/NEW-ORG-GUIDE.md)** for the full walkthrough.
In short:

```bash
cp -r profiles/example profiles/acme        # 1. copy the template
$EDITOR profiles/acme/profile.config.json    # 2. set identity (name, github org, …)
echo "LABOR_PROFILE=acme" >> .env            # 3. activate it
npm run setup                                # 4. run the install wizard
```

## Extending it

Five consistent extension points — all self-register the same way (see
**[docs/PLUGINS.md](docs/PLUGINS.md)**):

| Extension | Mechanism | Lives in |
|---|---|---|
| **Profile plugin** (org channels &amp; flows) | `export default register(api)`, auto-loaded | **`<profile>/plugins/`** |
| **Channel** (built-in) | `registerChannel()` + barrel import | `src/channels/` |
| **Flow** (built-in background integration) | `registerIntegration()` + barrel import | `src/integrations/` |
| **Container skill** | drop a `SKILL.md` folder | `container/skills/` or `<profile>/container-skills/` |
| **Infra / deploy** | per-org `deploy.config` | `<profile>/deploy.config` |
| **Setup step** | add to the `STEPS` registry | `setup/` |
| **Rules / KB** | markdown | `rules/` (core) + `<profile>/groups/` (org) |

## Self-host vs hosted

The framework runs in two deployment shapes, and they do not have the same
surfaces today. Stated plainly so nobody plans around a feature that isn't
reachable:

| Surface | Self-host (your own box / Docker) | Hosted (control-plane provisioned) |
|---|---|---|
| Chat channels, agent runs, KB, scheduled tasks | Available | Available |
| **KB dashboard (`kb-ui/`)** | Available — run `node kb-ui/server.mjs` (`KB_PORT`, default 8080) | **Not exposed.** The orchestrator image now ships `/app/kb-ui`, so a deployment *can* run it as a second container from the same image, but the hosted control plane does not yet provision or route to one. |
| **Plugin dashboard slices** ([docs/PLUGINS.md §2c](docs/PLUGINS.md)) | Available (mounted by kb-ui) | Unreachable until the dashboard above is provisioned — plugin *chat* surfaces are unaffected. |
| Anthropic credential | API key or Claude Code OAuth token | OAuth token only (`CLAUDE_CODE_OAUTH_TOKEN`); `ANTHROPIC_API_KEY` is deliberately unset |

## Architecture

```
Slack / Telegram / Discord / CLI
        │
        ▼
   ┌──────────────┐
   │ Orchestrator │  Node.js process — poll → trigger check → identity resolution
   └──────┬───────┘
          │
   ┌──────▼───────┐
   │  Container   │  Docker, isolated filesystem, Claude SDK + MCP tools + skills
   └──────┬───────┘
          │
   ┌──────▼───────┐
   │  IPC Watcher │  Outbound messages, task ops, cross-channel send, KB writes
   └──────────────┘
```

## Database

SQLite at `<profile>/store/messages.db`. Full schema in
[`schema/tables.md`](schema/tables.md). Core: `chats`, `messages`,
`registered_groups`, `sessions`, `router_state`. Operational: `scheduled_tasks`,
`task_run_logs`. Identity: `user_identities`.

## Development

```bash
npm install
npm run dev          # Run with hot reload (uses the active profile)
npm run build        # Compile TypeScript
npm test             # Run test suite
npm run typecheck    # Type-check only
./container/build.sh # Rebuild agent container image
```

## License

MIT
