# Onboarding a new organization

labor.fun is a single framework that can run **many organizations**. Each org is
a self-contained **profile** under `profiles/<name>/`. The framework code never
hardcodes a specific org — everything org-specific is read from the active
profile at startup.

This guide takes you from a fresh checkout to a running assistant for your org.

---

## 1. What a profile is

```
profiles/<your-org>/
├── profile.config.json     # identity & config — the single source of truth
├── groups/                 # per-group agent memory + KB context
│   ├── main/CLAUDE.md      # template for the privileged "main" control channel
│   ├── global/CLAUDE.md    # template for ordinary channels
│   └── <sharedKbGroup>/context/   # the shared knowledge base (people/, tasks/, …)
├── store/                  # SQLite DB                (created at runtime, gitignored)
├── data/                   # sessions + IPC           (created at runtime, gitignored)
├── container-skills/       # optional: org-specific agent skills
└── plugins/                # optional: org-specific plugins
```

Only `profile.config.json` and `groups/` are authored by you; `store/` and
`data/` are runtime state.

## 2. Create your profile

Copy the template — never edit `profiles/example` in place:

```bash
cp -r profiles/example profiles/acme
```

## 3. Fill in `profile.config.json`

This file is the **single source of truth** for your org's identity. Every brand
string, path, and GitHub reference in the framework derives from it.

```jsonc
{
  "assistantName": "Aide",                 // what the agent answers to
  "orgName": "Acme Cooperative",           // canonical org name
  "orgShortName": "Acme",
  "orgWebsite": "https://acme.example",
  "githubOrg": "acme-coop",                // GitHub org the agent operates on
  "githubRepo": "labor.fun",
  "kbDashboardUrl": "https://kb.acme.example",
  "sharedKbGroup": "slack_main",           // which group folder holds the shared KB
  "serviceUser": "laborfun",               // OS user that owns KB files in prod
  "telegramBotUsername": "acme_bot",
  "timezone": "America/New_York"
}
```

| Field | Used for |
|---|---|
| `assistantName` | Agent identity; default trigger `@<assistantName>`; CLAUDE.md `{{ASSISTANT_NAME}}` substitution |
| `orgName` / `orgShortName` / `orgWebsite` | How the agent refers to your org |
| `githubOrg` / `githubRepo` | GitHub integration scope (issues/PRs/Actions) |
| `kbDashboardUrl` | Links the agent surfaces to the KB dashboard |
| `sharedKbGroup` | Group whose `context/` is mounted read-only into every container |
| `serviceUser` | KB file ownership on the production host |
| `timezone` | Scheduling and message formatting |

Any field can also be overridden by an env var (e.g. `ASSISTANT_NAME`,
`GITHUB_ORG`, `SHARED_KB_GROUP`) when you need a per-deploy override.

## 4. Write the agent's instructions

Edit `groups/main/CLAUDE.md` (privileged control channel) and
`groups/global/CLAUDE.md` (ordinary channels) to describe your org and how the
assistant should behave. Use the `{{ASSISTANT_NAME}}` token anywhere you want the
configured name substituted — it's filled in when a group is first registered.

The authoritative **operating rules** (access control, messaging, scheduling,
identity, integrations) live in the framework `rules/` directory and apply to
every org. Don't copy them into your profile; reference them.

### Declare your operator roles (required)

The agent routes real-world actions to real people, so your `CLAUDE.md` "System
& People" section **must declare who fills each operator role** — don't ship the
example placeholders. At minimum, declare:

- **Technical escalation** — who owns deploys and the bot's own behavior/infra
  (e.g. "escalate technical issues to `<slug>`").
- **Workspace / infrastructure admin** — who administers the shared accounts the
  bot depends on (Google Workspace, dashboards, credentials).
- **Governance body** — the group that makes strategy/budget decisions the bot
  routes to (e.g. a strategic/steering committee), if your org has one.

Reference each by their people-file slug (§5). The access model is **flat** — an
allowlisted member has full access, there are no role tiers — so these are
*routing* declarations, not permission tiers. Leaving an operator role undeclared
means the agent has no real target to route to and may fall back to a
placeholder; an un-customized profile is exactly how fictional "admins" leak into
a live org and get "escalated" to. A guided setup wizard to collect these is
planned (backlog: `BreadchainCoop/labor.fun#138`).

## 5. Seed your people (the allowlist)

Add one markdown file per member under
`groups/<sharedKbGroup>/context/people/<slug>.md`. This folder **is** the
allowlist — identity resolution and RBAC are driven by it. See
`rules/identity/` and `rules/access-control/` for the schema and role hierarchy.

## 6. Activate the profile

```bash
echo "LABOR_PROFILE=acme" >> .env
```

If `acme` is the only profile present (besides `example`), it's auto-selected and
`LABOR_PROFILE` is optional. With more than one profile, it's required.

## 7. Install & run

```bash
npm install
npm run setup        # interactive wizard: timezone, env, container, groups, register, service
npm run dev          # or `npm run build && npm start`
```

Register your channels (Slack/Telegram/Discord) during `npm run setup`, or via
the per-channel skills (`/add-slack`, `/add-telegram`, `/add-discord`).

## 8. (Optional) Add org-specific capabilities

Everything an org owns lives in its profile — no framework edits:

- **Plugins** (your own channels &amp; background flows): drop a `.mjs` file in
  `profiles/acme/plugins/` exporting `default function register(api)`. It's
  auto-loaded at startup. See [PLUGINS.md](PLUGINS.md) §0.
- **Agent skills**: drop a `SKILL.md` folder in
  `profiles/acme/container-skills/`. It overlays the core `container/skills/`.

## 9. (Optional) Your own production infrastructure

Each org runs on its own host with its own install path, systemd service names,
and OS user. Those are **not** baked into the framework — they come from
`profiles/acme/deploy.config` (copied from `profiles/example/deploy.config`):

```sh
DEPLOY_ROOT=/opt/acme            # install dir on the host
GIT_DIR=/opt/acme-git            # git mirror
BACKUP_DIR=/opt/acme-backups
SERVICE_NAME=acme                # → acme.service
KB_SERVICE_NAME=acme-kb          # → acme-kb.service
AUTO_DEPLOY_NAME=acme-auto-deploy
SERVICE_USER=acme                # OS user that owns the install
REPO_URL=https://github.com/your-org/labor.fun.git
DEPLOY_ENV_FILE=/opt/acme/profiles/acme/deploy.env
```

The deploy scripts (`scripts/deploy.sh`, `setup/safe-deploy.sh`, …) read this
file based on `LABOR_PROFILE` and provision the host accordingly — systemd units
are **rendered from templates** in `setup/systemd/*.in` with your service names
and paths. The safety-critical logic (drain in-flight agent containers, atomic
rollback, profile-state migration) is shared and identical for every org; only
these values differ. With no `deploy.config`, the defaults reproduce the
reference (breadchain) host.

---

## Running multiple orgs from one checkout

This is the monorepo model: **everyone clones the same `labor.fun` repo**, and
each org lives in its own `profiles/<org>/` directory — config, KB, plugins, and
`deploy.config`. `LABOR_PROFILE` selects which one is active. Each profile keeps
its own `store/` (database) and `data/` (sessions), so orgs never share state.

- **Three orgs, three hosts:** clone the repo on each host, set
  `LABOR_PROFILE=<org>`, and give each its own `deploy.config`. Pull framework
  updates with `git pull` on each host's cadence.
- **Several orgs on one box (dev):** run one process per profile with distinct
  `LABOR_PROFILE` + `CREDENTIAL_PROXY_PORT` + `KB_PORT`.

Org code (plugins, infra config, KB) never touches `src/`, so framework upgrades
land cleanly for all orgs and orgs can't conflict with each other.

## Renaming / forking the framework

The framework is named **labor.fun** (`package.json`). The internal container
protocol keeps the `nanoclaw` codename (`NANOCLAW_*` env vars, output markers,
container name prefix) — that's an implementation detail, not org-facing, and
left unchanged to avoid churn.
