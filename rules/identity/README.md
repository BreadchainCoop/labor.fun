# Identity & RBAC Rules

How Breadbrich Engels determines who is making a request and what they can do.

## Identity Resolution Pipeline

1. **Get platform ID** — Slack user ID, Telegram JID, or CLI username
2. **Look up in `user_identities` table** — maps `(platform_id, platform)` → `kb_person`
3. **Load KB person file** — `context/people/{kb_person}.md` for tags and role
4. **Check tags against [tag-hierarchy.md](tag-hierarchy.md)** — determine effective permissions
5. **Apply [../access-control/role-matrix.md](../access-control/role-matrix.md)** — grant/deny access

## Seeded Identities

The seed list is provided to the orchestrator at startup via the `SEED_IDENTITIES` env var (JSON array of `{platform_id, platform, kb_person}`). Real IDs are not committed to the repo. The current list maps the admin set (Alice, Bob, Carol, Ops, Dave) to their `kb_person` entries.

To inspect the live mapping:

```bash
sqlite3 /opt/breadbrich/store/messages.db 'SELECT * FROM user_identities'
```

See [platform-identities.md](platform-identities.md) for how to add a new mapping.

## When Identity is Unknown

If the platform ID doesn't exist in `user_identities`:
1. Check if the Slack/Telegram display name matches a KB person
2. If no match, treat as **Guest** (open docs only)
3. Never guess — if unsure, default to most restrictive

## Admin List

These people have admin privileges regardless of tag resolution:
- **Alice Adams** — Owner, Superadmin
- **Bob Baker** — Superadmin
- **Carol Cole** — Admin
- **Ops** — Admin (system operator)
- **Dave Doyle** — Coordinator (not admin, but elevated access)

The admin list is also parsed from the `## Admins` section of `context/index.md`.

## Related Rules

- [Tag Hierarchy](tag-hierarchy.md) — Which tags inherit from which
- [Platform Identities](platform-identities.md) — Full cross-platform mapping
- [Access Control](../access-control/README.md) — What each role can do
- [Privacy Policy](../access-control/privacy-policy.md) — Enforce after identity resolution
