# Identity & RBAC Rules

How the assistant determines who is making a request. After the flat-permission refactor there are two states: **allowlisted** (a known KB person) and **unknown** — there are no tiers in between.

## Identity Resolution Pipeline

1. **Get platform ID** — Slack user ID, Telegram JID, Discord ID, or CLI username
2. **Look up in `user_identities` table** — maps `(platform_id, platform)` → `kb_person`
3. **Load KB person file** — `context/people/{kb_person}.md` for display name and descriptive tags
4. **If a `kb_person` was resolved** → caller is **allowlisted** with full access
5. **Otherwise** → caller is **unknown**; allow open-visibility reads only

## How allowlisting is populated

Two cooperating mechanisms:

- **`sender-allowlist.json`** — chat-level intake filter; controls who can speak to the agent at all
- **Discord-members sync** — periodically writes a `context/people/<slug>.md` and a `user_identities` row for every Discord member holding one of `DISCORD_DM_ALLOWED_ROLE_IDS`

A sender is "allowlisted" when both apply: they passed the intake filter, and they resolve to a KB person.

## Seeded Identities

For non-Discord platforms (CLI, ad-hoc Slack/Telegram), the orchestrator can be given a startup seed via the `SEED_IDENTITIES` env var (JSON array of `{platform_id, platform, kb_person}`). Real IDs are not committed to the repo.

To inspect the live mapping:

```bash
sqlite3 /opt/breadbrich/store/messages.db 'SELECT * FROM user_identities'
```

See [platform-identities.md](platform-identities.md) for how to add a new mapping.

## When Identity is Unknown

If the platform ID doesn't exist in `user_identities`:
1. Check if the display name matches a KB person (operator may have just not bound the platform ID yet)
2. If no match, treat as **Unknown** (open-visibility reads only)
3. Never guess — if unsure, default to most restrictive

## Tags

People files carry descriptive `tags:` in frontmatter (`engineering`, `operations`, etc.). These are **labels only**: useful for `dm_user` resolution and human grep, but they do not grant permissions. There is no tag hierarchy.

## Related Rules

- [Platform Identities](platform-identities.md) — Full cross-platform mapping
- [Access Control](../access-control/README.md) — What allowlisted users can do
- [Privacy Policy](../access-control/privacy-policy.md) — Enforce after identity resolution
