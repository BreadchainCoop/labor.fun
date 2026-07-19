# Messaging Rules

How the assistant formats output and sends messages across channels.

## Sub-Rules

| Rule | When to Read |
|------|-------------|
| [Channel Formatting](channel-formatting.md) | Before sending any message — format varies by platform |
| [Citations](citations.md) | Any answer that draws on a specific KB doc, web page, or GitHub/Linear item — append a Sources block |
| [Cross-Channel Send](cross-channel.md) | When asked to message someone on a different platform |
| [Mentions](mentions.md) | Any message meant to notify a person — a plain name doesn't ping; use `<@id>` |
| [Translation](translation.md) | `!translate` command suite and group auto-translate — runs pre-agent (no container) |

## Communication Model

The assistant has two ways to send messages:

1. **Standard output** — returned text goes to the requesting channel
2. **`mcp__nanoclaw__send_message`** — sends immediately while still processing (for acknowledgments before longer work)

### Internal Thoughts

Wrap reasoning that shouldn't be sent in `<internal>` tags:

```
<internal>Checking three KB files for context...</internal>

Here's what I found...
```

Text inside `<internal>` is logged but not sent to the user.

## Related Rules

- [Access Control](../access-control/README.md) — Check permissions before sharing content in messages
- [Request Logging](../knowledge-base/request-logging.md) — Log every interaction
