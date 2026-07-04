# Knowledge Base Rules

The assistant maintains a structured KB, mounted into every container at `/workspace/shared-kb` (use this path at runtime). On the host it lives under the active profile at `profiles/<name>/groups/<sharedKbGroup>/context/`. These rules govern how documents are created, updated, and organized.

## Directory Structure

| Category | Path | Default Visibility | Description |
|----------|------|--------------------|-------------|
| People | `context/people/` | private | One file per person — role, contact, skills |
| Tasks | `context/tasks/` | open | Structured task tracking with dependencies |
| Calendar | `context/calendar/` | open | Events, recurring schedules, deadlines |
| Artifacts | `context/artifacts/` | open | Documents, creative works, equipment |
| Connectors | `context/connectors/<source>/` | open | Docs synced from external sources (Notion, Google Drive, …), one file per source page/doc — **auto-maintained, do not hand-edit** |

**Synced connector docs** under `context/connectors/` are pulled from external
sources (Notion, Google Drive, …) by the knowledge connectors and refreshed
automatically. They are normal KB markdown — so the same visibility/RBAC rules
apply — and each carries a `source_url` in frontmatter pointing at the origin
document, which is the citation to use when you quote them. Treat them as
read-only mirrors: don't hand-edit (edits are overwritten on the next sync) and
don't create files there yourself. See [docs/CONNECTORS.md](../../docs/CONNECTORS.md).

## Core Behaviors

### When someone mentions a person, task, event, or artifact:
1. Check if a file exists in the relevant directory
2. If yes: update it with new information
3. If no: create a new file following [document-format.md](document-format.md)

### When asked to look something up:
- Read the relevant KB files — do NOT rely on session memory
- Check `context/index.md` for the quick-reference summary
- Check `context/tasks/active.md` for the running task index

### Index maintenance:
- Keep `context/index.md` updated as the master summary
- Keep `context/tasks/active.md` as the running task table
- Keep `context/calendar/upcoming.md` as the running events list

### File organization:
- One file per task (`TASK-NNN.md`)
- One file per person
- One file per event
- For large topics, split into subdirectories (e.g., `context/artifacts/equipment/`)

## Sub-Rules

| Rule | When to Read |
|------|-------------|
| [Storage Systems](storage.md) | Understanding what lives in markdown vs SQLite |
| [Document Format](document-format.md) | Creating or editing any KB document |
| [Task Management](tasks.md) | Creating, updating, linking, or querying tasks |
| [Request Logging](request-logging.md) | After every interaction (mandatory) |

## Related Rules

- [Access Control](../access-control/README.md) — Who can read/write what
- [Privacy Policy](../access-control/privacy-policy.md) — Visibility enforcement before sharing
