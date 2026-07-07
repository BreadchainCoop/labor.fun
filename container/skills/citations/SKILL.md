---
name: citations
description: Cite your sources. When an answer draws on a specific KB doc, web page, or GitHub/Linear item, append a compact channel-native "Sources" block with traceable links. Use whenever you looked something up to answer.
---

# /citations — Cite What You Used

Trust comes from traceability. When your answer depends on a specific source —
a KB document, a web page you fetched, a GitHub/Linear item you read — end the
message with a compact **Sources** block so anyone can verify it. This is core
behavior, not optional polish.

## Track sources as you work

While answering, keep a running list of what you actually used:

- **Internal KB docs** — the context-relative path you read, e.g.
  `people/jane-doe.md`, `tasks/TASK-123.md`, `artifacts/gotchas.md`.
- **Web pages** — the exact URL you browsed/fetched (agent-browser, WebFetch),
  plus its title.
- **Integration items** — the GitHub issue/PR/file URL or Linear issue URL you
  read.

Only list sources you genuinely used to form the answer — not every file you
glanced at. One traceable link per real source beats a wall of paths.

## When to cite (use judgment)

**Cite** when the answer depends on a specific doc, page, or item:
- "What's the status of TASK-123?" → cite `tasks/TASK-123.md`
- "What did the vendor quote?" → cite the artifact/web page you read
- "Summarize issue #42" → cite the GitHub URL

**Skip** for general conversation that doesn't lean on a retrieved source:
- Greetings, acknowledgements, chit-chat ("thanks!", "on it")
- Answers from the immediate conversation or your own reasoning
- Trivial confirmations ("done", "scheduled for 3pm")

When unsure and the answer rests on knowledge you looked up, cite. A missing
citation on a factual answer is worse than a slightly redundant one.

## Render the Sources block (channel-native)

Detect the channel from your group folder prefix and render links natively —
literal `[text](url)` in Slack, or `<url|text>` in WhatsApp, is a broken link.

| Channel (`folder` prefix) | Link syntax | Header / bullets |
|---------------------------|-------------|------------------|
| Slack (`slack_`) | `<url\|Title>` | `*Sources*` · `•` |
| Telegram (`telegram_`) | `[Title](url)` (Markdown v1 renders it) | `*Sources*` · `•` |
| WhatsApp (`whatsapp_`) | `Title (url)` — no link markup exists | `*Sources*` · `•` |
| Discord (`discord_`) | `[Title](url)` | `**Sources**` · `-` |
| CLI / other | `[Title](url)` | `**Sources**` · `-` |

Put the block last, after a blank line. Keep it tight — title + link per line.

**Slack example:**
```
Jane owns TASK-123; it's in progress, due Friday.

*Sources*
• <https://kb.example.com/doc/tasks/TASK-123.md|TASK-123: Ship dashboard>
• <https://kb.example.com/doc/people/jane-doe.md|Jane Doe>
```

**Telegram example:**
```
Jane owns TASK-123; it's in progress, due Friday.

*Sources*
• [TASK-123: Ship dashboard](https://kb.example.com/doc/tasks/TASK-123.md)
```

## Internal KB doc links — deep-link the dashboard

If the env var `KB_DASHBOARD_URL` is set, turn an internal doc path into a
clickable dashboard link. The dashboard serves docs at:

```
$KB_DASHBOARD_URL/doc/<category>/<file>
```

- `<category>` is the first path segment: `people`, `tasks`, `calendar`,
  `artifacts`, `financials`, or `dashboards`.
- `<file>` is the rest of the context-relative path, URL-encoded (a nested
  `equipment/laptop.md` becomes `equipment%2Flaptop.md`).
- Drop any leading `context/`.

Examples (with `KB_DASHBOARD_URL=https://kb.example.com`):

| KB path | Deep-link |
|---------|-----------|
| `people/jane-doe.md` | `https://kb.example.com/doc/people/jane-doe.md` |
| `context/tasks/TASK-123.md` | `https://kb.example.com/doc/tasks/TASK-123.md` |
| `artifacts/equipment/laptop.md` | `https://kb.example.com/doc/artifacts/equipment%2Flaptop.md` |

Check it once at runtime:
```bash
echo "${KB_DASHBOARD_URL:-<unset>}"
```

**If `KB_DASHBOARD_URL` is unset** (or the doc isn't under a served category),
cite the doc by its path or title instead — e.g. `tasks/TASK-123.md` — so the
reference is still traceable. Never invent a URL.

**Web / integration links** always use their real URL directly — no dashboard
involved.

## Access control — never cite what the user can't see

You already read only what the requesting user is allowed to see, and the
dashboard re-checks `visibility` on every `/doc/...` view (restricted/private
docs 403 for unauthorized users). So citing a doc you legitimately used in this
answer is safe.

Still: do not add a Sources link that surfaces a `restricted`/`private` doc into
a **shared channel** if you wouldn't have quoted that doc's content there.
Citations follow the same surfacing rules as the answer itself — see
`/workspace/project/rules/access-control/privacy-policy.md`. When in doubt in a
public room, cite in a DM or omit the private link.

## Related

- Citation format per channel: `/workspace/project/rules/messaging/citations.md`
- Channel formatting: `/workspace/project/rules/messaging/channel-formatting.md`
- Privacy / visibility: `/workspace/project/rules/access-control/privacy-policy.md`
- KB paths & doc format: `/workspace/project/rules/knowledge-base/`
