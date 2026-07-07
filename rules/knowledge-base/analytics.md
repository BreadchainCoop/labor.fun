# Assistant Usage & Knowledge-Gap Analytics

A feedback loop that answers, for an admin: **what did the team ask the
assistant, and where couldn't it answer?** One row is recorded per completed
agent run in the `assistant_events` table; the KB dashboard's **Analytics** tab
renders volume, resolution rate, and the top unanswered questions.

## The `report_knowledge_gap` tool (agent convention)

When you (the container agent) **cannot answer** a user because the needed
information is **not in the knowledge base** — or you genuinely lack the
knowledge to answer — call the `report_knowledge_gap` tool:

```
report_knowledge_gap(question="<short paraphrase of what you couldn't answer>",
                     topic="<optional coarse topic, e.g. expenses>")
```

Rules for the signal:

- **Still reply to the user.** This tool only records a signal; it does not
  answer for you. Tell the user you don't have the info, then call the tool.
- **Call it only for genuine gaps** — a question you could not answer because the
  KB lacks the information.
- **Do NOT call it** when: you answered the question, the request was a
  command/action rather than a question, or something errored.
- One call per unanswerable question.

This tool description is self-contained, so the agent uses it correctly even in
non-main groups (which read `groups/global/CLAUDE.md`, not `rules/`).

## How the knowledge-gap signal is derived (honesty & limits)

The gap signal is **best-effort**, in priority order:

1. **Explicit agent signal** (`gap_source = 'agent_signal'`) — the agent called
   `report_knowledge_gap`. The IPC handler drops a sentinel flag in the group's
   IPC dir; the orchestrator's message loop reads-and-clears it at run
   completion and records the run's event as a knowledge gap. This is the
   high-signal path.
2. **Output heuristic** (`gap_source = 'heuristic'`) — when no explicit signal is
   present, the orchestrator scans the agent's reply for "couldn't answer"
   phrasing ("I don't have that information", "not in the KB", "I couldn't
   find…", etc.).

**Limits — do not overclaim precision.** The heuristic can both **miss** real
gaps (phrased differently) and **false-positive** on hedging language ("I'm not
sure, but…"). The `is_question` classifier is also heuristic. Treat the
resolution rate and gap counts as **directional**, not exact. The explicit tool
signal is the reliable path; encourage the agent to use it.

`outcome` is one of `answered` | `knowledge_gap` | `error` | `unknown`.
**Resolution rate = answered / (answered + knowledge_gap)** — errors are
excluded from the denominator so an outage doesn't masquerade as a knowledge
problem.

## Privacy stance — `ASSISTANT_ANALYTICS_PRIVACY`

Question text and sender are stored subject to a configurable stance (env var,
default is the most conservative):

| Mode | Question text stored | Sender stored |
|------|----------------------|---------------|
| `main-only` (default) | **Full** for the main / shared-KB group; a **redacted summary** for other groups | Only for the main group; **null** for other groups |
| `full` (opt-in) | Full for every group | Yes, for every group |
| `redacted` | **Never raw** — redacted summary for every group (including main) | Yes |

Redaction (best-effort, not anonymization): collapse whitespace, replace email
addresses with `<email>` and long digit runs with `<number>`, truncate to
~120 chars. Full text is capped at 500 chars. Rows whose question text is
redacted-to-null carry no actionable text and are **excluded** from the
"top unanswered questions" list; sender-redacted rows are excluded from the
"most active users" table.

## Dashboard tab

`/analytics` in the KB dashboard (admin-gated, like `/logs`) renders, over the
last 14 days: headline resolution rate + counts, a per-outcome daily volume
chart, a **Knowledge gaps** list (top unanswered questions with counts and an
"Add to KB" link), a per-group breakdown, and most-active groups/users.

## Storage

See [storage.md](storage.md) for the markdown-vs-SQLite split; the
`assistant_events` table schema is documented in
[`schema/tables.md`](../../schema/tables.md).

## Related Rules

- [Request Logging](request-logging.md) — the per-interaction KB request log (distinct from these aggregate analytics)
- [Access Control](../access-control/privacy-policy.md) — analytics respect the same privacy posture
