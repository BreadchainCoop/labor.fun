# Transcript Task Approval Rules

Action items extracted from meeting transcripts go through a review queue before they become real KB tasks. This file is the source of truth for that workflow.

## Why this exists

Transcript extraction is noisy: misheard names, duplicates of existing TASK-NNN entries, scope creep, ambiguous "we should..." statements. A human review gate keeps the KB clean and prevents notifications firing for tasks that nobody actually owns.

## Who can approve

Any allowlisted user. The host rejects calls without a `sender_context` (unknown sender) and posts a warning back to the main group. Self-approval is allowed — the user who submitted the transcript may approve its proposed tasks. There is no "second pair of eyes" requirement at the host layer.

## What goes through the gate

| Item type | Gated? | How to handle |
|-----------|--------|---------------|
| New TASK-NNN derived from a transcript | ✅ Yes | Use `propose_meeting_tasks` |
| Updates to existing TASK-NNN (status, comments) | ❌ No | Use `modify_kb_file` directly |
| New people mentioned in transcript | ❌ No | Use `modify_kb_file` directly |
| New events extracted from transcript | ❌ No | Use `modify_kb_file` directly |
| New artifacts/documents referenced | ❌ No | Use `modify_kb_file` directly |

The gate is narrow on purpose. Only the highest-noise item type — new tasks — gets the review queue.

## Lifecycle

```
[transcript submitted]
  → save_meeting_summary       → meeting_summaries row (status=pending|completed)
  → propose_meeting_tasks      → N proposed_tasks rows (status=pending)
  → reviewers notified in main group with PT-IDs
       ↓
[reviewer decides per-row]
  → approve_proposed_tasks (bulk)  → status=approved → host writes TASK-NNN.md → status=created
  → reject_proposed_task           → status=rejected (no KB write)
```

State transitions allowed:
- `pending` → `approved` → `created`
- `pending` → `rejected`

No other transitions. Re-approving or re-rejecting a non-pending row is a no-op (logged, ignored).

## What the agent must do differently

When processing a transcript:

1. **First** call `save_meeting_summary` and capture the returned `summary_id`.
2. **Then** call `propose_meeting_tasks` with that `summary_id` and the array of action items the agent would otherwise have written as TASK-NNN files.
3. **Do NOT** call `modify_kb_file` to create new TASK-NNN files derived from a transcript. Those go through the approval queue.
4. People, events, and artifacts mentioned in the transcript still go through `modify_kb_file` directly — no gate.

## When the reviewer responds

After the review message is posted, a user will reply in natural language (e.g. "approve PT-1714060800000-0 and PT-1714060800000-2, reject PT-1714060800000-1"). The agent translates that into:

- `approve_proposed_tasks` with an array of items (one entry per approved row, with optional `final_title` / `final_assignee` / `final_due_date` overrides if the user asked to refine).
- `reject_proposed_task` per rejected row, with the user's reason if any.

Bulk approval is encouraged — one tool call covers the whole batch.

## Notifications

- On `propose_meeting_tasks`: a single message to the main group, numbered list, each row showing title, proposed assignee, proposed due date, and `PT-...` id.
- On approval: `✅ Approved: <title> → TASK-NNN` per task in the main group.
- On rejection: `❌ Rejected: <title> — <reason>` in the main group.

## Constraints

- A `proposed_task` row cannot transition out of `created` or `rejected`. Final states.
- Approval is idempotent — calling `approve_proposed_tasks` with already-created rows skips them with a "skipped" line in the response message.
- The host always writes the TASK-NNN.md file with the assigned KB person stored under `created_by` (the user who approved). The original transcript submitter's name is preserved in the `source_quote` and in the meeting_summaries record.
- Rejected tasks remain in the `proposed_tasks` table for audit. They are not deleted.

## Related files

- `src/db.ts` — `proposed_tasks` table + accessors
- `src/ipc.ts` — `propose_meeting_tasks`, `approve_proposed_tasks`, `reject_proposed_task` cases
- `src/kb-tasks.ts` — `writeApprovedTaskFile` helper
- `container/agent-runner/src/ipc-mcp-stdio.ts` — agent-facing MCP tools
- `rules/transcripts/transcripts.md` — overall transcript processing pipeline
- `groups/slack_main/CLAUDE.md` — agent-side instructions
