# Platform Identities

Maps platform-specific user IDs to KB person names across all channels.

## Current Mappings

The authoritative platform-ID-to-KB-person mapping lives in:

- The `user_identities` table on the droplet (seeded at startup from `SEED_IDENTITIES` env var)
- Each person's `context/people/<name>.md` file (the `Telegram JID` / `Slack ID` fields)

Real IDs are not committed to the repo. To inspect the live mapping:

```bash
sqlite3 /opt/breadbrich/store/messages.db 'SELECT * FROM user_identities'
```

## Storage

Stored in the `user_identities` SQLite table:

```sql
CREATE TABLE user_identities (
  platform_id TEXT,
  platform TEXT,
  kb_person TEXT,
  PRIMARY KEY (platform_id, platform)
);
```

## Adding New Identities

When a new team member needs to be linked:

1. Have them send a message to the assistant on the platform
2. The assistant captures their platform ID from the message metadata
3. Create/update their `context/people/{name}.md` file
4. Insert into `user_identities` table

For Telegram: user sends `/chatid` to `@your_bot_username` (or whichever bot username is configured via `TELEGRAM_BOT_USERNAME`) to register.

## Cross-Channel Lookup

When sending cross-channel messages (see [../messaging/cross-channel.md](../messaging/cross-channel.md)), use this table to find the target's JID on the destination platform.

## Related Rules

- [Identity Resolution](README.md) — Full resolution pipeline
- [Cross-Channel Send](../messaging/cross-channel.md) — Using JIDs for cross-platform messaging
