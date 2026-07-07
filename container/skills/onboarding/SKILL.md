---
name: onboarding
description: First-run conversational setup for a fresh group — introduce yourself, learn the team/people/preferences, offer starter automations, and write it all to group memory. Use when a group's CLAUDE.md is still the stock template (fresh/near-empty) or when a user says "set yourself up" / "onboarding".
default: false
---

# Onboarding

You're meeting this group for the first time. Get useful fast, don't
interrogate. One short intro message, then a couple of batched questions, then
go set things up. Total: a few messages, not a form.

## When this runs

- **Auto-detect**: your group `CLAUDE.md` is still the stock template (only
  the `{{ASSISTANT_NAME}}`-substituted boilerplate, no org-specific notes added
  below it) and this is the first real message in the group.
- **On request**: a user says "set yourself up", "onboarding", or similar, any
  time — treat it as a request to (re)run this even if memory already has
  content.

If memory already shows prior onboarding notes (see below) and nobody asked for
it explicitly, don't re-run — you're done, just help them.

## Step 1 — Introduce yourself (one message)

Short and concrete. Name (your configured assistant name), what you're for, one
line on how to talk to you. Example shape:

> Hi, I'm **{{ASSISTANT_NAME}}** 👋 I can answer questions, keep notes on your
> team, schedule reminders/summaries, and connect tools like GitHub. Give me a
> minute to get oriented — I'll ask a couple of quick questions.

Don't wait for a reply before moving to Step 2 — keep momentum.

## Step 2 — Batch the basics (one message, not five)

Ask together, in one message, with sensible defaults so a one-line reply is
enough:

1. **What should we call you / this assistant?** (default: keep the current
   configured name — only rename if they want something different in *this*
   group's tone; a real org-wide rename is host-level, see below)
2. **Timezone** — guess it if you can (from `people/` entries already in the
   shared KB, or system locale) and ask them to confirm or correct rather than
   asking blind.
3. **Response style** — brief default options: concise/to-the-point vs.
   more conversational. Default to concise if they don't care.
4. **What does the team/org do?** — one or two sentences is plenty.
5. **Who's here and what do they do?** — names + rough roles for the people in
   the channel. Don't demand a full roster; take what's offered and move on.

Frame it as low-effort:

> A few quick things so I can be useful — reply in whatever order, defaults are
> fine if you want to skip any:
> 1. What should I go by here?
> 2. I'm guessing you're in `<timezone guess>` — right?
> 3. Want me terse or more conversational?
> 4. What's the team working on?
> 5. Who's in this channel and what do they do?

## Step 3 — Offer starter automations (2-3 concrete options)

Don't describe capabilities abstractly — offer to turn them on right now.
Pick 2-3 relevant to what they told you in Step 2, e.g.:

- "Want a weekly summary posted here every Friday?"
- "Want a standing reminder for something recurring (standup, check-in)?"
- "Want me to connect GitHub so I can track issues/PRs for this project?"

Whatever they pick, set it up using existing capabilities — don't reinvent:

- **Scheduled tasks** (weekly summary, recurring reminder): use
  `mcp__nanoclaw__schedule_task` directly. See `rules/scheduling/README.md` for
  `schedule_type`/`schedule_value` and the script-gate pattern — don't duplicate
  that reference here, just follow it.
- **GitHub**: see `rules/integrations/github.md` for what's already wired up;
  point them at connecting their org's GitHub if it isn't yet, rather than
  explaining the integration from scratch.
- If they decline all three, that's fine — say so and move on.

## Step 4 — Write what you learned to memory, then stop repeating this

Append an "Org Notes" section to your own group `CLAUDE.md` (you have
read-write access to `/workspace/group/CLAUDE.md` — use Edit/Write directly, no
IPC needed) with what you learned: chosen name/style, timezone, what the
team/org does, and the people + roles mentioned. Keep it factual and short —
this is memory, not a transcript. For example:

```markdown
## Org Notes (onboarding)

- Team: <one-line description of what they do>
- Timezone: <tz>
- Style: <concise|conversational>
- People:
  - <name> — <role>
  - <name> — <role>
- Starter automations: <what was enabled, if anything>
```

The presence of this section is what tells you (next time) that onboarding is
already done — check for it before re-running automatically.

If people/roles you learned belong in the shared KB (main group only — see
`rules/knowledge-base/README.md`), write them there too via the normal KB
conventions instead of duplicating org-wide facts solely in one group's memory.

## Step 5 — Close out

End with how to get help later:

> That's it — I'll remember all this. Ask me anything, or say "onboarding"
> again anytime you want to revisit these settings.

## What you can't do here (host-level settings)

Some things aren't yours to change from inside a chat — they're host/dashboard
operations because they affect the whole org, not just this group:

- **Renaming the assistant across every group** (vs. just how this group
  addresses you) — a host-level config change.
- **Adding a new messaging platform** (Slack/Telegram/Discord/etc.) — requires
  host-side app credentials and registration.
- **Usage budgets / billing** — set by the operator, not per-group.

If asked, say plainly that this goes through the operator/dashboard, without
naming internal tooling or implying you can do it if asked differently.
