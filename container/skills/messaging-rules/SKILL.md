---
name: messaging-rules
description: Reference skill for Breadbrich Engels's messaging rules — channel formatting, cross-channel sends, and communication protocols. Use when sending messages across platforms.
---

# /messaging-rules — Communication Reference

How Breadbrich Engels formats and sends messages across channels.

## Channel Formatting

Format based on the channel prefix in the group folder name:

### Telegram (`telegram_*`) / WhatsApp (`whatsapp_*`)
- `*bold*` (single asterisks, NEVER `**double**`)
- `_italic_` (underscores)
- `•` bullet points
- ` ``` ` code blocks
- No `##` headings, no `[links](url)`, no `**double stars**`

### Slack (`slack_*`)
- `*bold*` (single asterisks)
- `_italic_` (underscores)
- `<https://url|link text>` for links (NOT `[text](url)`)
- `•` bullets (no numbered lists)
- `:emoji:` shortcodes
- `>` for block quotes
- No `##` headings — use `*Bold text*` instead

### Discord (`discord_*`)
- Standard Markdown: `**bold**`, `*italic*`, `[links](url)`, `# headings`

## Communication Model

1. **Standard output** — returned text goes to the requesting channel
2. **`send_message` MCP tool** — sends immediately while still processing

### Internal Thoughts

Wrap non-user-facing reasoning in `<internal>` tags — logged but not sent.

## Cross-Channel Sending

Breadbrich Engels can send messages across platforms using `target_jid`:

| Platform | JID Format | Example |
|----------|-----------|---------|
| Telegram user | `tg:USERID` | `tg:NNNNNNN` |
| Telegram group | `tg:-100GROUPID` | `tg:-100NNNNNNNN` |
| Slack channel | `slack:CHANNELID` | `slack:CXXXXXXXXX` |
| WhatsApp group | `GROUPID@g.us` | `NNNNNNN@g.us` |

### Permission Required
- Any allowlisted user can cross-channel send
- Unknown senders cannot

## Person → JID Lookup

The authoritative roster of people-to-JID mappings lives in:

- **People profiles** at `/workspace/shared-kb/people/<name>.md` (read the `Telegram JID` field). This mount is available to every container regardless of which group spawned it — always check here first.
- **Cross-channel JID table** in `groups/slack_main/CLAUDE.md` (visible to main containers via `/workspace/project/groups/slack_main/CLAUDE.md`; non-main containers should rely on `/workspace/shared-kb/people/` instead).

Read those at runtime — never memorize JIDs in skill content. If a person isn't in `/workspace/shared-kb/people/`, they're not in the KB yet; ask the user for their JID rather than guessing.

## Message Provenance — No Covert Relays

When you send a message to someone **on behalf of a third party** (a "tell X…",
a DM you were asked to pass on, a relay, a reminder someone else requested):

- **Disclose the source** — relay with attribution ("Ron asked me to remind
  you…"). Don't pass off a prompted message as your own spontaneous thought.
- **Never conceal the requester on request.** If asked to send something *"but
  don't tell them I asked"*, **decline** — offer to send it *with* attribution
  or not at all. Don't be a deniable conduit for someone else.
- **Answer provenance questions truthfully.** If the recipient asks "who
  prompted this?", say so honestly — a third party's "don't tell them" does not
  override a direct question from the person involved.
- **"It's just a joke" doesn't change this** — the issue is hiding the source,
  not the content.

Fine and encouraged: your own replies, and openly-attributed relays. Full rule:
`/workspace/project/rules/messaging/provenance.md`.

## Gotchas

- **Can't edit/delete sent messages** — send corrections instead
- **Gotcha #2**: `schedule_type: "once"` interprets timestamps as UTC. Convert ET to UTC (+4 hours for EDT) for one-shot tasks. Cron schedules use local time.
- **Gotcha #3**: Daily summaries must frame content as retrospective, not re-issue past directives as live instructions.

## Related

- Full rules: `/workspace/project/rules/messaging/`
- Scheduling rules: `/workspace/project/rules/scheduling/`
- Per-group JID rosters: `/workspace/project/groups/*/CLAUDE.md`
