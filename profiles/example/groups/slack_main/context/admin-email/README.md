# Administrative email → auto-issues

KB home of the admin-email triage flow (issue #33), driven by the `admin-email`
profile plugin (`<profile>/plugins/admin-email.mjs`) and the `admin-email`
container skill. Forwarded admin mail becomes tracked, owned GitHub issues
instead of dying in a personal inbox.

## One-time setup (the human part)

1. On the administrative mailbox (or each admin's inbox), add an **auto-forward
   rule** that forwards incoming mail to **the assistant's Gmail address** (the
   account behind the `gws` credentials). That's the entire intake mechanism —
   the assistant triages whatever lands in its own inbox.
2. Create `config.md` here (below). That turns the flow on.

The assistant only **reads and labels** the forwarded mail — it never replies,
forwards, or deletes.

## config.md format

```markdown
---
enabled: true
triage_cron: "0 */2 * * *"                 # how often to triage (cron); default every 2h
github_repo: your-org/admin                # repo where issues are filed
notify_channel_jid: dc:123456789012345678  # channel for the triage summary; a REGISTERED group
---

Routing notes (optional, free text the skill reads): e.g.
- grant-action → gilberto
- legal → ron
- partnership → josh
```

The plugin keeps **one recurring triage task** in sync with this file: it
schedules it when `enabled`, cancels it when you set `enabled: false` or delete
`config.md`, and re-schedules if you change the cron / repo / channel. State
lives in `state.json` here (the scheduled task id) — don't edit it by hand.

## How a run works

Each scheduled run, the assistant: fetches inbox messages **not** labelled
`triaged`, unwraps each forward, classifies it, opens a GitHub issue (with a
deadline + category labels + suggested owner) for anything actionable, DMs the
owner, posts a one-line summary to `notify_channel_jid`, and applies the
`triaged` Gmail label so nothing is ever processed twice. Newsletters/receipts/
spam are labelled and skipped with no issue.
