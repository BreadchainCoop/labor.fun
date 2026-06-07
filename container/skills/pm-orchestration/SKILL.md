---
name: pm-orchestration
description: Weekly PM orchestration on top of GitHub — re-estimate/re-plan the task graph, and DM the people on the critical path (blockers, overdue owners) with context. Use when running the PM orchestration routine (you'll be handed a "PM brief").
---

# /pm-orchestration — Continuous PM on top of GitHub

You run with a deterministic **PM brief** in your prompt (blocked / blocking /
overdue / due-soon / per-owner load, an "Unassigned — needs an owner" list, a
"DM these people" list, and a "do NOT re-ping" list). You're invoked two ways:
on a **schedule** (weekly) and **on demand from chat** when someone says "run
pm orchestration" / "/pm". Either way the brief is the same — do the routine
*on top* of GitHub (re-evaluate, re-plan, communicate), don't reinvent tracking.

## Philosophy: act first, then ask

**Optimistically make the update, then ask the human to confirm.** Do NOT ask
permission first. When the brief (or your reading of the task) shows reality has
diverged:

- **Re-estimate / adjust** directly — update the task's `estimate`, `deadline`,
  or `status` via `modify_kb_file`, and/or comment + adjust the GitHub issue via
  `mcp__github__*`.
- **Then DM the affected owner** stating *what you changed and why*, and invite
  them to reply if they want it adjusted. Example: "I bumped TASK-123's estimate
  from 2→5 pts and pushed the due date to Fri because it's blocked on the design
  asset — reply if that's wrong."

Make the smallest correct change. Never silently delete work or reassign owners
without saying so in the DM.

## Who to DM (and who not to)

Use the brief's **"DM these people"** list as the ground truth for *who*:

- **Blocking owners** — their incomplete task is on someone else's critical
  path. DM them: the task, *who/what is waiting* (the `blocks:` ids), why it
  matters now, and one clear ask (finish / re-estimate / hand off).
- **Overdue owners** — DM: the task, how overdue, and "can you (a) finish,
  (b) re-estimate, or (c) hand it off?"

Do **not** personally DM for routine *due-soon* items — those are not pings.

Use the `dm_user` tool (resolves a person by name → DM). Batch multiple items
for the same person into **one** DM.

## Unassigned work (no owner to DM)

The brief's **"Unassigned — needs an owner"** list is overdue/blocking work with
**no assignee** — there's no one to DM, but it must not fall through. For these:

1. **Try to find/assign an owner.** If the issue clearly belongs to someone
   (from its content, the `project`, recent activity, or who owns related
   tasks), assign them on GitHub via `mcp__github__*` and DM that person.
2. **Otherwise raise it.** Post the unassigned items in **this channel** asking
   for someone to pick them up, and — if a **PM lead** is named in the brief —
   DM the lead so it has a human owner of the *triage*, not the task.

Never silently skip an unassigned overdue/blocking item just because there's no
one in the "DM these people" list.

## Anti-spam — honor the cooldown

The brief lists people **"Already followed up recently — do NOT re-ping."** Do
not DM them about that same task/reason again. If someone appears in both lists
for different tasks, only address the fresh ones.

## DM vs GitHub comment

- **DM** = a human needs to act now (unblock, re-estimate, decide).
- **GitHub issue comment** (`mcp__github__*`) = durable record / re-estimate
  rationale / plan change the whole team should see. When in doubt, comment on
  the issue *and* DM only the person on the critical path.

## Tools

- `dm_user` — DM a person by name.
- `mcp__github__*` — comment on / update / label issues.
- `modify_kb_file` — apply estimate/deadline/status updates to KB task files.

## Related

- Task schema + dependency edges (`upstream`/`downstream`/`estimate`): `/workspace/project/rules/knowledge-base/tasks.md`
- KB operations: see the `kb-operations` skill.
