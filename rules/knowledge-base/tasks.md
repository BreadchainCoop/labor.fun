# Task Management Rules

Tasks use structured files in `context/tasks/` with one file per task.

## Task File Schema

```yaml
---
title: Task Title
id: TASK-001
status: open | in_progress | blocked | done | cancelled
priority: critical | high | medium | low
created_by: Person Name
created_at: YYYY-MM-DD
last_edited: YYYY-MM-DD
owners: [Person Name]
stakeholders: [Person Name]
upstream: [TASK-XXX]
downstream: [TASK-XXX]
linked_events: [EVT-NNN]
tags: [category]
visibility: open
editable_by: open
---
```

## Required Fields

| Field | Format | Description |
|-------|--------|-------------|
| `id` | `TASK-NNN` (zero-padded) | Unique identifier |
| `title` | String | Short descriptive title |
| `status` | Enum | `open`, `in_progress`, `blocked`, `done`, `cancelled` |
| `priority` | Enum | `critical`, `high`, `medium`, `low` |
| `created_by` | String | Creator's name |
| `created_at` | `YYYY-MM-DD` | Creation date |
| `last_edited` | `YYYY-MM-DD` | Last modification date |
| `owners` | List | People responsible for completing |

## Creating a Task

1. Check `active.md` for the last used ID
2. Assign the next `TASK-NNN` ID
3. Create `context/tasks/TASK-NNN.md` with all required frontmatter
4. Include Description, Checklist, Dependencies, and Comments sections
5. Add an initial comment noting creation
6. Update `context/tasks/active.md` index

## Modifying a Task

1. Update the relevant frontmatter fields
2. Set `last_edited` to today's date
3. Append a comment with timestamp, user, and what changed
4. If adding a dependency, update BOTH tasks (upstream on one, downstream on the other)
5. Update `active.md` if status, priority, or ownership changed

## Comments

**Comments are append-only** — never delete or modify existing comments.

Format:
```markdown
## Comments

| Date | User | Comment |
|------|------|---------|
| 2026-04-10 14:30 | Bob | Created task from Slack discussion |
| 2026-04-11 09:00 | The assistant | Status changed: open → in_progress |
```

## Task-Event Linking

- Tasks have `linked_events: [EVT-NNN]` in frontmatter
- Events have `linked_tasks: [TASK-NNN]` in frontmatter
- **When creating a link, update BOTH files** (the task and the event)
- Events use `EVT-NNN` IDs and live in `context/calendar/`

## Dependencies

- `upstream`: Task IDs that must complete before this task can start
- `downstream`: Task IDs that depend on this task completing
- **When adding a dependency, update BOTH tasks**

## Related Rules

- [Document Format](document-format.md) — General frontmatter requirements
- [Access Control](../access-control/role-matrix.md) — Who can create/edit tasks
- [Request Logging](request-logging.md) — Log task operations
