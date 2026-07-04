# Citations

Cited, verifiable answers are core trust behavior. When a reply draws on a
specific source, end it with a compact **Sources** block so the reader can trace
the claim back. Full runtime guidance: the `citations` container skill.

## When to cite

Cite when the answer **depends on a specific retrieved source** — a KB document,
a web page you fetched, or a GitHub/Linear item you read. Skip for general
conversation (greetings, acknowledgements, trivial confirmations) or answers
drawn only from the immediate chat or your own reasoning. When unsure and the
answer rests on looked-up knowledge, cite.

## What counts as a source

| Source | Cite as |
|--------|---------|
| Internal KB doc | Dashboard deep-link (below) if configured, else the doc path/title |
| Web page browsed/fetched | The page URL + title |
| GitHub issue/PR/file | The GitHub URL |
| Linear issue/project | The Linear URL |

List only sources you actually used — one traceable link per real source.

## Per-channel format

Render links natively for the channel (detect from the group folder prefix). A
literal `[text](url)` in Slack, or `<url|text>` in WhatsApp, renders broken.

| Channel | Link syntax | Header | Bullet |
|---------|-------------|--------|--------|
| Slack (`slack_`) | `<url\|Title>` | `*Sources*` | `•` |
| Telegram (`telegram_`) | `[Title](url)` | `*Sources*` | `•` |
| WhatsApp (`whatsapp_`) | `Title (url)` | `*Sources*` | `•` |
| Discord (`discord_`) | `[Title](url)` | `**Sources**` | `-` |
| CLI / other | `[Title](url)` | `**Sources**` | `-` |

Telegram uses Markdown v1, which renders `[Title](url)` natively (see
`src/channels/telegram.ts`). WhatsApp has no link markup — show `Title (url)`.

Put the block last, after a blank line, one source per line.

## KB dashboard deep-links

When `KB_DASHBOARD_URL` is set, link internal docs into the dashboard:

```
$KB_DASHBOARD_URL/doc/<category>/<file>
```

`<category>` is the first path segment (`people`, `tasks`, `calendar`,
`artifacts`, `financials`, `dashboards`); `<file>` is the rest of the
context-relative path, URL-encoded, with any leading `context/` dropped. Scheme
verified against `kb-ui/server.mjs` (`GET /doc/:category/:file`). If unset or the
path isn't under a served category, cite the doc by path/title — never invent a
URL. Web and integration links always use their real URL.

## Access control

Cite only what the requesting user may see. The agent already reads within the
group's visible KB, and the dashboard re-checks `visibility` on every doc view,
so citing what you legitimately used is safe. Do not surface a
`restricted`/`private` doc link into a shared channel if you wouldn't quote that
doc there — citations follow the same surfacing rules as the answer. See
[../access-control/privacy-policy.md](../access-control/privacy-policy.md).

## Related Rules

- [Channel Formatting](channel-formatting.md) — Native syntax per platform
- [Privacy Policy](../access-control/privacy-policy.md) — Visibility before surfacing
- [Knowledge Base](../knowledge-base/README.md) — KB paths and doc format
