# Messaging Rules

How the assistant formats output and sends messages across channels.

## Sub-Rules

| Rule | When to Read |
|------|-------------|
| [Channel Formatting](channel-formatting.md) | Before sending any message — format varies by platform |
| [Cross-Channel Send](cross-channel.md) | When asked to message someone on a different platform |
| [Mentions](mentions.md) | Any message meant to notify a person — a plain name doesn't ping; use `<@id>` |
| [Message Provenance](provenance.md) | Any time you relay/send a message on someone else's behalf — disclose the source; never hide who asked |

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
