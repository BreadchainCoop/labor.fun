---
name: Breadbrich Engels/Breadbrich Engels architecture reference
description: Full Breadbrich Engels architecture — all 9 SQLite tables, KB file structure, RBAC, deployment, versioning, container mounts
type: project
---

## Database Schema (store/messages.db — better-sqlite3)

| Table | PK | Key Columns | Purpose |
|---|---|---|---|
| `chats` | jid | name, last_message_time, channel, is_group | Chat/group metadata |
| `messages` | (id, chat_jid) | sender, sender_name, content, timestamp, is_from_me, is_bot_message, reply_to_*, thread_id, is_reply_to_bot | Full message history with reply context |
| `registered_groups` | jid | name, folder (UNIQUE), trigger_pattern, requires_trigger, container_config (JSON), is_main, added_at | Group registration & container config |
| `sessions` | group_folder | session_id | Claude Agent SDK session IDs per group |
| `router_state` | key | value (JSON) | KV state persistence (last timestamps) |
| `scheduled_tasks` | id | group_folder (FK), chat_jid (FK), prompt, script, schedule_type (cron\|interval\|once), schedule_value, context_mode, next_run, last_run, last_result, status, created_at | Task scheduling |
| `task_run_logs` | id (AI) | task_id (FK), run_at, duration_ms, status (ok\|error), result, error | Task execution history |
| `user_identities` | (platform_id, platform) | kb_person | Identity-resolution allowlist: the orchestrator writes `sender_context.json` only for senders with a row here. Chat-level intake (`sender-allowlist.json`) gates earlier. |

**Indices:** messages(timestamp), scheduled_tasks(next_run, status), task_run_logs(task_id, run_at)

## KB File Structure

```
groups/
  global/CLAUDE.md          — Global instructions (all groups)
  global/personality.md     — Lauryn Hill-inspired voice
  main/CLAUDE.md            — Main control group (elevated, is_main=true)
  slack_main/CLAUDE.md      — Slack main channel
  slack_main/context/       — KB documents (deployed to /opt/breadbrich/)
    people/                 — Person profiles (visibility: restricted)
    tasks/                  — TASK-NNN.md with owners, priority, linked_events
    calendar/               — Events with linked_tasks
    artifacts/              — Project deliverables
    index.md                — Root doc with ## Admins section
  telegram_example/CLAUDE.md
```

**KB Doc Format:** YAML frontmatter (title, tags[], visibility: open|restricted|private, created_by, created_at, editable_by) + markdown body.

## Container Mounts

- **Main group (is_main=true):** `/workspace/project` ← project root (ro), `/workspace/project/store` ← DB (rw), `/workspace/group` ← group folder (rw)
- **Other groups:** `/workspace/group` ← group folder (rw), `/workspace/global` ← global KB (ro)
- Limits: 30min timeout, 10MB max output, 5 max concurrent containers
- Base image: node:22-slim + Chromium + fonts + agent-browser

## RBAC

Role membership is configured per deployment via the env vars
`KB_SUPERADMINS` / `KB_ADMINS` / `KB_COORDINATORS` / `KB_RESIDENTS`
(comma-separated lowercase usernames), resolved against the active profile's
`people/` files. The usernames below are **placeholders** — substitute your
org's own:

- **Superadmins:** `<superadmin-usernames>` (admin dashboard, credentials)
- **Admins:** `<admin-usernames>` (all KB, logs, manage groups/tasks)
- **Coordinators:** `<coordinator-usernames>` (operations, cross-send, non-private KB write)
- **Identity resolution:** user_identities table maps platform_id+platform → kb_person
- **Tag hierarchy:** admin → {leadership, engineering, creative, operations, community}; leadership → {engineering, creative, operations, community}

## Versioning

- **Git remotes:** origin (qwibitai/salem), slack (breadbrich-slack), telegram (breadbrich-telegram)
- **Branching:** main = core, skill/add-slack, skill/add-telegram
- **Package:** Breadbrich Engels v1.2.47, CHANGELOG.md, Husky pre-commit hooks
- **KB versioning:** Git-tracked files with frontmatter timestamps

## Deployment

- **Droplet:** configured via `DROPLET_HOST` (see `.env.example`); systemd services: breadbrich, breadbrich-kb
- **KB Dashboard:** Express :8080 via Cloudflare quick tunnel
- **Routes:** /, /category/:name, /doc/:cat/:file, /linkages, /logs (admin), /admin (superadmin), /architecture (admin)
- **Deploy:** rsync → chown → npm run build → systemctl restart breadbrich; container/build.sh for agent image

## Message Flow

1. Channels (Slack/Telegram/CLI) → SQLite (messages + chats)
2. Router loop (2s poll) → trigger check → identity resolution → XML context build
3. Container spawn (stdin prompt) → Claude Agent SDK + MCP tools + credential proxy :3001
4. IPC watcher (data/ipc/{group}/) → outbound messages, task ops
5. Task scheduler (60s poll) → scheduled_tasks → container → task_run_logs

**Why:** This is the single authoritative reference for Breadbrich Engels's full architecture. Use it to answer questions about DB schema, permissions, deployment, or file structure without re-exploring.

**How to apply:** When modifying Breadbrich Engels code, check this for table schemas, mount paths, and permission boundaries. Verify against current code for line-specific details since this is a snapshot.
