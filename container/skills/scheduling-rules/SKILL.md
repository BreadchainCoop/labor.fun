---
name: scheduling-rules
description: Reference skill for Breadbrich Engels's task scheduling — cron, interval, one-time tasks, script gates, and API credit conservation. Use when setting up recurring or scheduled tasks.
---

# /scheduling-rules — Task Scheduling Reference

How Breadbrich Engels schedules and manages recurring/one-time tasks.

## Task Types

| Type | `schedule_type` | `schedule_value` | Example |
|------|----------------|-------------------|---------|
| Cron | `cron` | Cron expression (local time) | `0 9 * * 1` (Mon 9am ET) |
| Interval | `interval` | Milliseconds or a unit suffix (`ms`/`s`/`m`/`h`/`d`) | `6h`, `30m`, or `3600000` (every hour) |
| One-time | `once` | ISO timestamp (local, NO Z suffix) | `2026-05-07T14:00:00` |

**Interval values**: bare number = milliseconds (`3600000`); suffixed number
uses the unit (`500ms`, `45s`, `30m`, `6h`, `2d`, case-insensitive). Minimum
**1 minute** (a run takes ~50s, so sub-minute intervals are a runaway), maximum
**365 days**. Anything else — `every 6h`, `6hh`, `30 seconds` — is rejected and
the task is not created or updated; a task already holding a bad interval gets
paused instead of rescheduled.

## ⚠️ CRITICAL GOTCHA: Timezone Handling

- **Cron**: Uses LOCAL timezone (ET). `0 9 * * *` = 9 AM ET. ✓
- **Once**: Also local time. Use `2026-05-07T14:00:00` (NO `Z` suffix). ✓
- **Before sending any time-sensitive message**: Verify current time if the task involves telling someone what time something is.

## Script Gates

For recurring tasks, add a `script` to avoid unnecessary agent wake-ups:

```json
{
  "script": "bash -c '...'",
  "prompt": "Do the thing",
  "schedule_type": "cron",
  "schedule_value": "0 9 * * *"
}
```

Script prints JSON: `{ "wakeAgent": true/false, "data": {...} }`
- `wakeAgent: false` → agent sleeps, waits for next run
- `wakeAgent: true` → agent wakes with data + prompt

**Always test scripts first** in the sandbox before scheduling.

## API Credit Conservation

Each wake-up uses API credits. For tasks > 2x/day:
1. Suggest a script gate
2. Help find minimum viable frequency
3. For LLM evaluation, suggest direct API calls in the script

## Context Modes

| Mode | Use When |
|------|----------|
| `group` | Task needs chat history / conversation context |
| `isolated` | Self-contained task, all context in prompt |

## Scheduling for Other Groups

```
schedule_task(prompt: "...", target_group_jid: "tg:-100...")
```

Task runs in that group's context with their files and memory.

## Permission

- **Allowlisted user**: Full task management (create, update, pause, resume, cancel) in any group
- **Unknown sender**: No access

## Daily Summary Task Rules

When generating daily recaps:
- Frame as *retrospective* ("Yesterday's Recap")
- Use past tense for completed items
- Never re-issue past directives as current instructions
- Start with "📋 Yesterday's Recap" header

## Related

- Full rules: `/workspace/project/rules/scheduling/`
- Access control: `/workspace/project/rules/access-control/`
