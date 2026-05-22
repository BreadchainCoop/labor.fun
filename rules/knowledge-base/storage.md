# Storage Systems

Breadbrich Engels uses **two distinct storage systems**. Knowing which one holds what is critical — don't query SQLite for KB data or edit markdown for message history.

## 1. Markdown Files (Knowledge Base)

**What**: All organizational knowledge — people, tasks, calendar, artifacts.
**Where**: `groups/slack_main/context/` on disk, mounted into containers.
**Format**: Markdown with YAML frontmatter (see [document-format.md](document-format.md)).
**Managed by**: Breadbrich Engels reads/writes these files directly via filesystem operations.

| Directory | Example File | Managed How |
|-----------|-------------|-------------|
| `context/people/` | `bob.md` | Breadbrich Engels creates/edits markdown files |
| `context/tasks/` | `TASK-001.md` | Breadbrich Engels creates/edits markdown files |
| `context/calendar/` | `2026-05-01-shape-rotator.md` | Breadbrich Engels creates/edits markdown files |
| `context/artifacts/` | `request_log.md` | Breadbrich Engels creates/edits markdown files |
| `context/index.md` | — | Breadbrich Engels maintains as master index |
| `context/tasks/active.md` | — | Breadbrich Engels maintains as task index |
| `context/calendar/upcoming.md` | — | Breadbrich Engels maintains as events index |

**Versioning**: Git-tracked. Changes committed to repo.
**Access control**: Enforced by Breadbrich Engels reading `visibility` frontmatter — not by the filesystem.

## 2. SQLite Database (System State)

**What**: Message history, group registrations, scheduled tasks, identity mappings, RBAC tags.
**Where**: `store/messages.db` (better-sqlite3).
**Format**: Relational tables. Full schema in [../../schema/tables.md](../../schema/tables.md).
**Managed by**: The NanoClaw orchestrator (Node.js process) reads/writes via `src/db.ts`. In **cooperative mode** (`FLAT_ACCESS`, the default — see [COOPERATIVE-MODE.md](../../docs/COOPERATIVE-MODE.md)) **every group** can query it directly via the `sqlite3` CLI at `/workspace/project/store/messages.db`. This includes reading the **full message history** of any chat — you are not limited to the handful of messages piped into the prompt.

| Table | What It Stores | Who Writes |
|-------|---------------|------------|
| `chats` | Chat/group metadata (JID, name, channel) | Orchestrator (auto) |
| `messages` | Full message history with threading | Orchestrator (auto) |
| `registered_groups` | Group config (folder, trigger, container settings) | Orchestrator via IPC |
| `sessions` | Claude SDK session IDs per group | Orchestrator (auto) |
| `router_state` | KV state (last timestamps) | Orchestrator (auto) |
| `scheduled_tasks` | Cron/interval/one-time task definitions | Breadbrich Engels via `schedule_task` MCP tool |
| `task_run_logs` | Execution history (duration, status, result) | Orchestrator (auto) |
| `user_identities` | Platform ID → KB person mapping | Orchestrator + manual seeding |
| `tag_hierarchy` | RBAC tag inheritance tree | Manual seeding |

**Versioning**: Not git-tracked (in `.gitignore`). DB lives on the droplet.
**Access control**: In cooperative mode (default) **every** group container has a read-write mount of `store/` at `/workspace/project/store/`. (When `FLAT_ACCESS=false`, only the main group does — the legacy sandboxed model.)

## Key Distinction

| | Markdown (KB) | SQLite (System) |
|---|---|---|
| **Content type** | Organizational knowledge | Operational state |
| **Who manages** | Breadbrich Engels (file read/write) | Orchestrator process |
| **Versioned in git** | Yes | No |
| **Access from containers** | All groups (own context, read-only global) | All groups (cooperative mode); main only if `FLAT_ACCESS=false` |
| **Schema** | YAML frontmatter + markdown body | Relational tables |
| **Example** | "Person X is an admin with engineering tag" | "Message ID abc123 from <slack-user-id> at timestamp 1712764800" |

## When Breadbrich Engels Queries SQLite

From **any group** in cooperative mode (the DB is mounted read-write at
`/workspace/project/store/messages.db`). **You can and should query this
directly whenever someone asks about past messages, "what did X say",
action items from a conversation, or anything beyond the few messages in
your current prompt.** Do not tell the user you have no access to message
history — you do; read it here.

Find the current chat's JID from the conversation context, then:

`messages.timestamp` is a **TEXT ISO-8601 string** (e.g.
`2026-05-19T18:17:36.528Z`) — already human-readable, and it sorts
chronologically as a plain string. No epoch conversion needed.

```bash
DB=/workspace/project/store/messages.db

# Full history for one chat, oldest→newest (raise/remove LIMIT for everything)
sqlite3 -readonly "$DB" \
  "SELECT timestamp, sender_name, content
   FROM messages WHERE chat_jid='<JID>'
   ORDER BY timestamp ASC LIMIT 2000;"

# Last 30 days
sqlite3 -readonly "$DB" \
  "SELECT timestamp, sender_name, content FROM messages
   WHERE chat_jid='<JID>'
     AND timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 days')
   ORDER BY timestamp ASC;"

# Keyword search across a chat
sqlite3 -readonly "$DB" \
  "SELECT timestamp, sender_name, content FROM messages
   WHERE chat_jid='<JID>' AND content LIKE '%deadline%'
   ORDER BY timestamp ASC;"

# List chats / verify registered groups
sqlite3 -readonly "$DB" "SELECT jid, name FROM chats ORDER BY last_message_time DESC LIMIT 10;"
```

Use `-readonly` for lookups. Never modify the DB schema — migrations are
managed by `src/db.ts`.

## When Breadbrich Engels Edits Markdown

From **any group** (each group has its own `context/` if configured):

```bash
# Read a KB file
cat /workspace/group/context/tasks/TASK-001.md

# Create/update a KB file
cat > /workspace/group/context/tasks/TASK-014.md << 'EOF'
---
title: New Task
id: TASK-014
...
---
EOF
```

Always follow [document-format.md](document-format.md) for frontmatter.

## Related Rules

- [Document Format](document-format.md) — Markdown file schema
- [Task Management](tasks.md) — Task file operations
- [Schema Reference](../../schema/tables.md) — Full SQLite table definitions
- [Access Control](../access-control/role-matrix.md) — Main group vs other groups
