# Cross-Channel Messaging

The assistant CAN send messages across platforms. This is a real capability — do NOT tell users it's impossible.

## How It Works

Use `mcp__nanoclaw__send_message` with the `target_jid` parameter:

```
mcp__nanoclaw__send_message(text="Message here", target_jid="tg:1234567890")
```

- **Without `target_jid`**: Message goes to the current channel
- **With `target_jid`**: Message goes to that specific chat on any platform

## Who Can Cross-Send

Any allowlisted user, from any registered group. See [../access-control/role-matrix.md](../access-control/role-matrix.md).

## Looking Up a JID

The authoritative roster lives in `/workspace/shared-kb/people/<name>.md` (each profile's `Telegram JID` field). Read those at runtime — never hardcode JIDs. New users register via `/chatid` to the configured Telegram bot (`TELEGRAM_BOT_USERNAME`).

## When to Use

- When someone explicitly asks to message/ping/notify someone on another platform
- When it clearly makes sense (e.g., "tell Alice on Telegram that...")
- When a task update needs to reach someone who is primarily on a different channel

## Formatting

Format the message for the **target** channel, not the source. If sending from Slack to Telegram, use Telegram formatting rules (see [channel-formatting.md](channel-formatting.md)).

## Related Rules

- [Channel Formatting](channel-formatting.md) — Format for the target platform
- [Identity Resolution](../identity/platform-identities.md) — Look up JIDs
- [Access Control](../access-control/role-matrix.md) — Who can cross-send
