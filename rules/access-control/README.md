# Access Control Rules

These rules govern what Breadbrich Engels can share, who can see what, and how requests are authorized. **Read [privacy-policy.md](privacy-policy.md) before sharing ANY KB content.**

## Quick Reference

1. Identify the requester (see [../identity/README.md](../identity/README.md))
2. Check their role against the [role-matrix.md](role-matrix.md)
3. Check the document's `visibility` frontmatter against [privacy-policy.md](privacy-policy.md)
4. Only then share content

## Roles

| Role | Who | Capabilities |
|------|-----|-------------|
| **Superadmin** | alice, bob | Full access, credentials, structure changes |
| **Admin** | alice, ops, bob, carol | All KB, logs, manage groups/tasks, personnel notes |
| **Coordinator** | dave | Broad write to calendar/tasks/artifacts, read all non-private |
| **Contributor** | Team members | Read open docs, add tasks, update open info |
| **Guest** | Anyone authenticated | Read open docs only |

See [role-matrix.md](role-matrix.md) for the full permission table.

## Core Principles

- **Default deny**: If you can't confirm the requester's role, treat them as Guest
- **Check before sharing**: Always read frontmatter visibility before surfacing content
- **Never leak in summaries**: Private info must not appear in general updates, task lists, or channel messages unless requested by an admin
- **Append-only audit**: Every interaction is logged (see [../knowledge-base/request-logging.md](../knowledge-base/request-logging.md))

## Related Rules

- [Privacy Policy](privacy-policy.md) — Document visibility enforcement
- [Role Matrix](role-matrix.md) — Full permission table by role and directory
- [Identity Resolution](../identity/README.md) — How to determine who is asking
- [Tag Hierarchy](../identity/tag-hierarchy.md) — RBAC tag inheritance
