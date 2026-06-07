# Discord Integration

The Discord channel runs **in the orchestrator**, not in the agent container.
The bot token lives only on the host; the container agent has no Discord
access of its own. Everything the agent does on Discord goes through an IPC
op the orchestrator executes on its behalf.

This matters for one common request: **"go through channel X and
summarize/tally its history."** The agent cannot reach Discord's API directly,
and live message capture only covers *registered* channels going forward — it
does not retain a backlog. To read a channel's past messages, use the
`fetch_discord_history` tool.

## `fetch_discord_history`

Reads past messages from a Discord channel **by channel ID**, including
channels that are **not** registered groups. This is the one read path that
reaches beyond live, registered traffic.

| Parameter | Meaning |
|-----------|---------|
| `channel_id` | Discord channel ID, e.g. `1291129091440902165` (a `dc:` prefix is tolerated). |
| `limit` | Max messages to return. Default 200, **hard cap 2000**. |
| `since` | ISO date/datetime — only messages at or after this instant are returned. Use for "this quarter / month". |
| `before` | Message ID — return only messages older than this. For manual pagination beyond the cap. |

Returns messages **oldest-first** as JSON, each with `id`, `authorId`,
`authorName`, `authorIsBot`, `content`, `timestamp`, and `attachments`.

### How it works (request/response IPC)

Unlike `send_message` / `dm_user` (fire-and-forget), this is a **request →
response** op:

1. The tool writes a request to `/workspace/ipc/requests/`.
2. The orchestrator paginates Discord's API (the token lives there) and writes
   the result to `/workspace/ipc/responses/<requestId>.json`.
3. The tool polls for that file and returns the messages inline (120 s
   timeout).

Implementation: `DiscordChannel.fetchChannelHistory` (`src/channels/discord.ts`),
wired through `IpcDeps.fetchDiscordHistory` (`src/index.ts`) and the
`fetch_discord_history` request handler (`src/ipc.ts`).

## Access control

Reading a channel's backlog is privacy-sensitive. The orchestrator gates the
op with the **flat model** used elsewhere: only an **allowlisted sender** (a
validated `sender_context` with a `user_id`) **or a main-group origin** may
call it. Unauthorized callers get an error back, and nothing is fetched. See
[Access Control](../access-control/README.md).

## Limits & failure modes

- The bot must be a **member of the channel's server** and hold **Read Message
  History** permission. Otherwise Discord returns "Missing Access" and the tool
  surfaces that error.
- Threads are not walked — the tool reads the channel's own messages. Fetch a
  thread directly by passing the **thread's** channel ID.
- Very large channels: bound with `since` and/or page with `before` rather than
  raising `limit` past the 2000 cap.

## Registering a channel vs. reading its history

These are different things:

- **Registering** a channel (`register_group`, main group only) makes the bot
  respond to and capture **future** live messages there. It does **not**
  retrieve past messages.
- **`fetch_discord_history`** retrieves the **backlog** and does not require the
  channel to be registered.

So "get everyone's hours from #standup this quarter" is a `fetch_discord_history`
call (`since` = quarter start), not a registration.

## Related

- [Messaging](../messaging/README.md) — outbound formatting, cross-channel send
- [GitHub Integration](github.md) — the other orchestrator-side integration
- [Access Control](../access-control/README.md) — the allowlist gate
