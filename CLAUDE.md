# labor.fun

A standalone, **multi-org** framework for multi-channel AI assistants. Runs
Claude agents in isolated containers with per-group memory. (Internal container
protocol keeps the `nanoclaw` codename.)

## Quick Context

Single Node.js process. Channels (Telegram, Slack, Discord) self-register at startup. Messages route to Claude Agent SDK running in Docker containers. Each group has isolated filesystem and memory.

**The framework is org-agnostic.** Every org-specific thing — identity, KB, people, runtime state — lives in a **profile** under `profiles/<name>/`. The active profile is chosen at startup via `LABOR_PROFILE` (else the single profile present, else the repo root for legacy/dev). `profile.config.json` is the single source of truth for brand/identity/paths; the code reads it via `src/profile.ts` → `src/config.ts`. Never hardcode an org name, path, or GitHub org in `src/` — derive it from the profile/config. See `docs/NEW-ORG-GUIDE.md` and `docs/PLUGINS.md`.

## Rules & Operational Knowledge

Breadbrich Engels's behavior is defined by structured rule files in [`rules/`](rules/INDEX.md). These are the authoritative source for:

| Rule Set | Path | Governs |
|----------|------|---------|
| [Access Control](rules/access-control/README.md) | `rules/access-control/` | Who can see/do what, privacy enforcement |
| [Knowledge Base](rules/knowledge-base/README.md) | `rules/knowledge-base/` | KB structure, document format, task management |
| [Messaging](rules/messaging/README.md) | `rules/messaging/` | Channel formatting, cross-platform send |
| [Scheduling](rules/scheduling/README.md) | `rules/scheduling/` | Cron tasks, scripts, API credit conservation |
| [Identity & RBAC](rules/identity/README.md) | `rules/identity/` | User resolution, tag hierarchy, platform mapping |
| [Transcripts](rules/transcripts/transcripts.md) | `rules/transcripts/` | Meeting transcript processing, action item extraction |
| [GitHub Integration](rules/integrations/github.md) | `rules/integrations/` | GitHub issues/PRs/code/Actions on the org's GitHub org (`githubOrg` in the active profile) |
| [Notion Integration](rules/integrations/notion.md) | `rules/integrations/` | Reading/writing Notion pages and databases shared with the assistant's integration (`mcp__notion__*`) |

Read `rules/INDEX.md` for the full cross-linked index. When modifying the assistant's behavior — update the relevant rule file, not ad-hoc code. Rules are framework-wide and org-agnostic; reference the profile's config (`orgName`, `githubOrg`) rather than hardcoding an org.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/channels/slack.ts` | Slack channel (bolt) |
| `src/channels/telegram.ts` | Telegram channel (grammy) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/permissions.ts` | KB-based RBAC, identity resolution |
| `src/config.ts` | Trigger pattern, paths, intervals (derived from active profile) |
| `src/profile.ts` | Profile resolution + `profile.config.json` loading (org-agnostic core) |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/integrations/registry.ts` | Flow/integration registry (background flows self-register) |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations; see `schema/tables.md` for schema reference |
| `profiles/<org>/profile.config.json` | Per-org identity & config (single source of truth) |
| `profiles/<org>/groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `profiles/<org>/groups/<sharedKbGroup>/context/` | Knowledge base (people, tasks, calendar, artifacts) |
| `profiles/example/` | Copy-me template for a new org |
| `kb-ui/server.mjs` | Admin dashboard (Express, Basic Auth) |
| `container/skills/` | Skills loaded inside agent containers (+ `<profile>/container-skills/`) |
| `schema/tables.md` | Database schema reference |

## Credentials

API keys and tokens managed by OneCLI Agent Vault — injected into containers at request time. Never committed. Run `onecli --help`.

## Skills

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

## Development

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
npm test             # Run tests
./container/build.sh # Rebuild agent container
```

## Deployment

**HARD RULE: push → merge → deploy. Never deploy code that isn't in git.**

All code changes must follow this workflow:
1. Commit to a feature branch
2. Push to GitHub and create a PR on the framework repo (`BreadchainCoop/labor.fun`)
3. Merge the PR to main
4. Deploy via `safe-deploy.sh` on the host (or `/redeploy-breadbrich` skill)

Never rsync individual files to the host. Never restart services after manual edits. The only exception is data in `.gitignore` (`profiles/<org>/store/`, `.env`, profile runtime state).

```bash
# On the droplet — proper deploy:
/opt/breadbrich-backups/safe-deploy.sh

# Service management (after deploy only):
systemctl restart breadbrich        # Main orchestrator
systemctl restart breadbrich-kb     # KB dashboard
```

## Container Build Cache

The container buildkit caches aggressively. `--no-cache` alone does NOT invalidate COPY steps. To force a clean rebuild, prune the builder then re-run `./container/build.sh`.
