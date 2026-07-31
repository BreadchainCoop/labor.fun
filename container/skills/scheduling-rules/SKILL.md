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

## ⚠️ CRITICAL: Private Reminders Must Not Leak Into a Channel

A scheduled task's **final reply is delivered to the task's bound chat** (the
channel or thread it runs in). So even when the task correctly `dm_user`s the
requester, its chatty "done ✅" narration is posted to a channel — where other
people can see it. This is how a personal reminder once leaked: the DM reached
the right user, but the task's confirmation text surfaced in a thread visible
to someone else.

**A reminder (or any private/DM-only task) must reach ONLY the user(s) who
requested it — and produce NO channel-visible output at all.** When scheduling
one:

1. **Deliver only via `dm_user`** to the requester(s) (by KB slug / unique ID).
   Never post the reminder itself to a channel.
2. **Suppress ALL channel output.** Instruct the task to wrap its **entire**
   response — including any "done"/error narration — in `<internal></internal>`
   so nothing is delivered to any channel or thread. The DM is the only visible
   artifact.
3. Use `context_mode: isolated` with everything needed in the prompt.
4. Keep the **acknowledgment** private too when the request was private — don't
   broadcast "I'll remind you" to a channel if it should stay between you and
   the requester.

**Template prompt for a private reminder:**

```
Scheduled PRIVATE reminder for <slug>. Work silently:
1. dm_user target "<slug>" with: "<reminder text>".
2. Do NOT post to any channel or thread, and do NOT @-mention anyone in a channel.
3. Wrap your ENTIRE response in <internal></internal> so nothing is delivered
   anywhere but the DM — including success/failure notes.
If the DM fails, keep the failure note inside <internal> and stop.
```

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
