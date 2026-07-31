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
| Interval | `interval` | Milliseconds | `3600000` (every hour) |
| One-time | `once` | ISO timestamp (local, NO Z suffix) | `2026-05-07T14:00:00` |

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

## Delivery Mode (privacy) — prevents reminder leaks

`delivery` controls whether the task's **result narration** is posted to the bound chat.

| Mode | Use When |
|------|----------|
| `channel` (default) | The result is meant for everyone in the chat — daily briefings, in-channel reminders, public status posts. |
| `silent` | **Private** reminders / DM-only tasks. The result is NOT posted to any channel; the real output goes out via `dm_user` to the requester. |

**Rule of thumb:** if the request is "remind **me**" / "DM me" / anything personal, set `delivery: "silent"` **and** have the prompt deliver via `dm_user(target=<requester>, ...)`. If the request is "remind **the channel**" / "post the briefing here", use the default `channel`.

Why this exists: `silent` makes the orchestrator **structurally** drop the result narration, so a confirmation like "DM sent ✅" can never leak into a shared channel/thread where other people (not the requester) would see it. Do **not** rely on wrapping narration in `<internal>` for privacy — `silent` is the guarantee. See issue #46.

```
schedule_task(
  prompt: "DM <requester> via dm_user: 'Reminder — check the X'.",
  schedule_type: "once",
  schedule_value: "2026-06-27T09:00:00",
  delivery: "silent",
)
```

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
