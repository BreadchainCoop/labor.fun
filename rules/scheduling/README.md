# Scheduling Rules

The assistant can schedule tasks to run later or on a recurring basis using `schedule_task`.

## Task Types

| Type | `schedule_type` | `schedule_value` | Example |
|------|----------------|-------------------|--------|
| Cron | `cron` | Cron expression | `0 9 * * 1` (Mondays 9am) |
| Interval | `interval` | Milliseconds | `3600000` (every hour) |
| One-time | `once` | ISO date | `2026-04-15T14:00:00` |

## Scripts (Gate Pattern)

For recurring tasks, add a `script` that runs before the agent wakes:

1. Script runs first (30-second timeout)
2. Script prints JSON: `{ "wakeAgent": true/false, "data": {...} }`
3. If `wakeAgent: false` — nothing happens, waits for next run
4. If `wakeAgent: true` — agent wakes with the script's data + prompt

### Available tools in scripts

Scripts run as bash with the following available:

- **`gh` CLI** — authenticated automatically via `GH_TOKEN`. Use `gh api` for GitHub API calls.
- **`curl`** — for arbitrary HTTP requests; use `$GITHUB_PERSONAL_ACCESS_TOKEN` for auth if needed.
- **`jq`** — for JSON parsing.
- **`node`** — for more complex logic.

### Always Test First

Run the script locally before scheduling:

```bash
# Using gh CLI (preferred for GitHub API calls)
bash -c '
  INCOMPLETE=$(gh api repos/owner/repo/pulls/123 --jq ".state")
  if [ "$INCOMPLETE" = "open" ]; then
    echo "{\"wakeAgent\": true}"
  else
    echo "{\"wakeAgent\": false}"
  fi
'

# Using fetch (for non-GitHub APIs)
bash -c 'node --input-type=module -e "
  const r = await fetch(\"https://api.example.com/status\");
  const data = await r.json();
  console.log(JSON.stringify({ wakeAgent: data.hasUpdates === true, data }));
"'
```

### When NOT to Use Scripts

If the task needs the assistant's judgment every time (daily briefings, reminders, reports), skip the script — just use a prompt.

## API Credit Conservation

Each agent wake-up uses API credits. For tasks running more than ~2x daily:

1. Explain the cost to the user
2. Suggest a script gate that checks the condition first
3. If evaluation needs an LLM, suggest direct Anthropic API calls in the script
4. Help find the minimum viable frequency

## Scheduling for Other Groups

Use `target_group_jid` to schedule in another group's context:

```
schedule_task(prompt: "...", schedule_type: "cron", schedule_value: "0 9 * * 1", target_group_jid: "chat-jid-here")
```

The task runs with that group's files and memory.

## Database Tables

Scheduled tasks are stored in `scheduled_tasks` and execution history in `task_run_logs`. See [../schema/tables.md](../../schema/tables.md) for full schema.

## Related Rules

- [Access Control](../access-control/role-matrix.md) — Only admins can manage scheduled tasks
- [Task Management](../knowledge-base/tasks.md) — KB task tracking (different from scheduled tasks)
