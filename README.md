# Breadbrich Engels

Multi-channel AI assistant for your organization. Runs on NanoClaw — a lightweight agent framework that executes Claude in isolated containers with per-group memory and multi-channel support (Slack, Telegram, CLI).

## Architecture

```
Slack / Telegram / CLI
        │
        ▼
   ┌─────────────┐
   │  Orchestrator │  Node.js process (systemd)
   │  Router Loop  │  2s poll → trigger check → identity resolution
   └──────┬───────┘
          │
   ┌──────▼───────┐
   │  Container    │  Docker, isolated filesystem
   │  Claude SDK   │  MCP tools + skills + credential proxy
   └──────┬───────┘
          │
   ┌──────▼───────┐
   │  IPC Watcher  │  Outbound messages, task ops, cross-channel send
   └──────────────┘
```

## What's Here

| Directory | What |
|---|---|
| `src/` | Orchestrator, channels (Slack, Telegram), DB, IPC, permissions, scheduler |
| `container/` | Dockerfile, agent-runner, build script |
| `groups/` | Per-group agent memory + KB context (people, tasks, calendar, artifacts) |
| `kb-ui/` | Admin dashboard — categories, linkages, logs, architecture diagram |
| `schema/` | Database table definitions (9 tables) and architecture reference |
| `.claude/skills/` | 30+ installable skills (channels, integrations, tools) |
| `container/skills/` | Runtime skills loaded inside agent containers |
| `docs/` | Spec, security model, SDK deep dive, debug checklist |
| `setup/` | First-time installation and service configuration |

## KB Dashboard

Accessible at [kb.example.com](https://kb.example.com) (Cloudflare tunnel → Express :8080).

| Route | Access | Description |
|---|---|---|
| `/` | All | Home with category cards |
| `/category/:name` | All | List documents in a category |
| `/doc/:cat/:file` | Per visibility | View single document |
| `/linkages` | All | Task ↔ Event cross-reference graph |
| `/logs` | Admin | All Breadbrich Engels request logs |
| `/architecture` | Admin | System architecture diagrams |
| `/admin` | Superadmin | Users, credentials, permissions, RBAC |

## Database

SQLite (`store/messages.db`). Full schema in [`schema/tables.md`](schema/tables.md).

Core: `chats`, `messages`, `registered_groups`, `sessions`, `router_state`
Operational: `scheduled_tasks`, `task_run_logs`
Identity: `user_identities`

## Deployment

Runs on a DigitalOcean droplet via systemd:
- `breadbrich` — main orchestrator process
- `breadbrich-kb` — KB dashboard (Express :8080)
- `cloudflared` — Cloudflare tunnel fronting the dashboard

```bash
# Deploy via the wrapper script (reads DROPLET_HOST from .env)
./scripts/deploy.sh
```

See [docs/DEPLOY.md](docs/DEPLOY.md) for the full deploy flow, snapshot/rollback behavior, and stateful-path preservation.

## Development

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
npm test             # Run test suite
./container/build.sh # Rebuild agent container image
```

## License

MIT
