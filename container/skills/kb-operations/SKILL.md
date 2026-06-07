---
name: kb-operations
description: Reference skill for Knowledge Base operations — document format, task management, storage systems, and request logging. Use when creating, editing, or querying KB content.
---

# /kb-operations — Knowledge Base Reference

Reference for how Breadbrich Engels manages the structured KB.

## Directory Structure

The canonical KB lives in `slack_main/context/`. Every container reads it via the `/workspace/shared-kb/` mount (read-only) and **writes through the `modify_kb_file` tool** (the mount itself is read-only by design — never edit files under `/workspace/shared-kb/` directly). The orchestrator applies the write to the canonical location and enforces access control.

| Category | Read path (any container) | Write via `modify_kb_file` (relative path) | Default Visibility | Description |
|----------|---------------------------|---------------------------------------------|--------------------|-------------|
| People | `/workspace/shared-kb/people/` | `people/` | private | One file per person |
| Tasks | `/workspace/shared-kb/tasks/` | `tasks/` | open | Structured task tracking (TASK-NNN) |
| Calendar | `/workspace/shared-kb/calendar/` | `calendar/` | open | Events, schedules, deadlines |
| Artifacts | `/workspace/shared-kb/artifacts/` | `artifacts/` | open | Documents, creative works, equipment |
| Financials | `/workspace/shared-kb/financials/` | `financials/` | restricted | Budget, expenses, invoices |
| Dashboards | `/workspace/shared-kb/dashboards/` | `dashboards/` | restricted | Visual reports, HTML dashboards |

### Writing the KB (any container, including DMs)

KB writes are **not** restricted to the main group. Any container — including
`telegram_<user>` / `slack_<user>` DMs and other non-main groups — can create
or update KB files by calling the **`modify_kb_file`** tool with a path relative
to the KB context dir (e.g. `tasks/TASK-001.md`). The orchestrator gates the
write on the **sender**, not the channel:

- **Allowlisted sender** (anyone who resolves to a KB people file + identity
  mapping) → full read/write from any group, including DMs. This is the default
  cooperative model — see `docs/COOPERATIVE-MODE.md` and
  `rules/access-control/README.md`. Do **not** decline a KB write just because
  the request came from a DM; if the requester is allowlisted, write it.
- **Unknown sender** (no identity mapping) → reads of open-visibility content
  only; KB writes are rejected by the orchestrator.

When the install runs in sandboxed mode (`FLAT_ACCESS=false`), writes still flow
through `modify_kb_file`; the orchestrator additionally restricts them to
main-group origin or RBAC-tagged senders. You don't need to special-case this in
the agent — just attempt the write and let the orchestrator authorize it.

## Document Format

Every KB document uses YAML frontmatter:

```yaml
---
title: "Document Title"
id: TASK-NNN          # tasks only
status: open          # open, in-progress, completed, cancelled
priority: high        # high, medium, low
created_at: 2026-05-07
last_edited: 2026-05-07
owners: [Person Name]
stakeholders: [Name1, Name2]
visibility: open      # open, restricted, private
tags: [tag1, tag2]
---
```

## Task Management

- IDs: Sequential `TASK-NNN`
- One file per task: `context/tasks/TASK-NNN.md`
- Track dependencies: `upstream` and `downstream` in frontmatter
- Checklist items use `- [ ]` / `- [x]`
- Comments table for history

## Core Behaviors

1. **When someone mentions a person/task/event**: Check if file exists → update or create
2. **When looking something up**: Read KB files, never rely on session memory alone
3. **After every interaction**: Log the request (see request logging rules)
4. **Index maintenance**: Keep `context/index.md`, `context/tasks/active.md`, `context/calendar/upcoming.md` updated

## Storage Systems

| System | Used For | Access |
|--------|----------|--------|
| Markdown KB | People, tasks, calendar, artifacts | File read/write |
| SQLite DB | Messages, chats, users, expenses | Direct `sqlite3` + MCP tools |
| Attachments | Photos, business cards, uploads | File read |

### Reading message history (cooperative mode)

You have read-write access to the SQLite DB at
`/workspace/project/store/messages.db` (cooperative mode / `FLAT_ACCESS`,
the default — every group, not just main). When someone asks about past
messages, "what did X say", or to pull action items from a conversation,
**query it directly — do not claim you lack message-history access.**
`messages.timestamp` is a TEXT ISO-8601 string that sorts chronologically:

```bash
sqlite3 -readonly /workspace/project/store/messages.db \
  "SELECT timestamp, sender_name, content FROM messages
   WHERE chat_jid='<JID>' ORDER BY timestamp ASC LIMIT 2000;"
```

Full recipes (date ranges, keyword search): see
`/workspace/project/rules/knowledge-base/storage.md`.

## Request Logging

After every interaction, append to the request log:
- Timestamp, requester, request summary, actions taken, files modified

## Special Rules

- **WTF List**: Always anonymous submissions
- **Gotchas**: Log operational issues in `artifacts/gotchas.md`
- **People cards**: Any allowlisted user can edit; per-document `visibility` frontmatter still gates surfacing
- **Close the loop**: Every reply should write actionable info to KB, not just respond verbally

## Related

- Full rules: `/workspace/project/rules/knowledge-base/`
- Document format: `/workspace/project/rules/knowledge-base/document-format.md`
- Task management: `/workspace/project/rules/knowledge-base/tasks.md`
