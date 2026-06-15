# Mentioning / Notifying People

A plain name in a channel message — `Josh:`, `**Marv**`, "tell the team" — is
just text. It does **not** send anyone a notification. To actually get a
specific person's attention you must use that platform's **mention** syntax,
which pings them.

This is a hard rule for any message whose *purpose* is to reach someone:
reminders, nudges, deadline pings, task assignments, escalations, "please
review" requests.

## How to mention, per platform

| Platform | Syntax | ID source |
|----------|--------|-----------|
| Discord | `<@discord_id>` | `discord_id` in `people/<slug>.md` frontmatter |
| Slack | `<@slack_user_id>` | `slack_id` in the person's file (if present) |
| Telegram | `@username`, or `[name](tg://user?id=<id>)` | `telegram_username` / JID |

Resolve the id from the shared KB (`/workspace/shared-kb/people/`); **never
guess** an id. Append the readable name for clarity when helpful, e.g.
`<@511575159929438224> (Josh)`. If a person has no id on file, fall back to
their name and say you couldn't tag them so a human can follow up.

## Scheduled messages count too

When you write a `schedule_task` whose message names people, put the
**mentions in the scheduled message text itself** — your future run will send
that text verbatim. A scheduled reminder that says `• Josh: …` pings no one;
`• <@511575159929438224> (Josh): …` does. (This is the most common way the
rule gets missed — the task author writes a friendly-looking plain-name list.)

## When NOT to mass-mention

Don't use `@everyone` / `@here` for routine reminders — ping the specific
owners instead. Reserve broadcast mentions for genuinely all-hands, time-
critical messages, and prefer naming the relevant people individually.

## Related

- [Channel Formatting](channel-formatting.md) — the rest of per-platform syntax
- [Identity & RBAC](../identity/README.md) — resolving who a name refers to
