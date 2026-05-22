# Breadbrich Engels

Multi-channel AI assistant for your organization. Built on NanoClaw — runs Claude agents in isolated containers with per-group memory.

## Quick Context

Single Node.js process. Channels (Telegram, Slack) self-register at startup. Messages route to Claude Agent SDK running in Docker containers. Each group has isolated filesystem and memory. KB dashboard at kb.example.com.

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
| [GitHub Integration](rules/integrations/github.md) | `rules/integrations/` | GitHub issues/PRs/code/Actions on BreadchainCoop repos |

Read `rules/INDEX.md` for the full cross-linked index. When modifying Breadbrich Engels's behavior — update the relevant rule file, not ad-hoc code.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/channels/slack.ts` | Slack channel (bolt) |
| `src/channels/telegram.ts` | Telegram channel (grammy) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/permissions.ts` | KB-based RBAC, identity resolution |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations; see `schema/tables.md` for schema reference |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `groups/slack_main/context/` | Knowledge base (people, tasks, calendar, artifacts) |
| `kb-ui/server.mjs` | Admin dashboard (Express, Basic Auth) |
| `container/skills/` | Skills loaded inside agent containers |
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
2. Push to GitHub and create a PR on BreadchainCoop/breadbrich-engels
3. Merge the PR to main
4. Deploy via `safe-deploy.sh` on the droplet (or `/redeploy-breadbrich` skill)

Never rsync individual files to the droplet. Never restart services after manual edits. The only exception is data in `.gitignore` (store/, .env, groups/ runtime state).

```bash
# On the droplet — proper deploy:
/opt/breadbrich-backups/safe-deploy.sh

# Service management (after deploy only):
systemctl restart breadbrich        # Main orchestrator
systemctl restart breadbrich-kb     # KB dashboard
```

## Container Build Cache

The container buildkit caches aggressively. `--no-cache` alone does NOT invalidate COPY steps. To force a clean rebuild, prune the builder then re-run `./container/build.sh`.
