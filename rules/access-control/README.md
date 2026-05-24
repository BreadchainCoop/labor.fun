# Access Control Rules

These rules govern what Breadbrich Engels can share, who can see what, and how requests are authorized. **Read [privacy-policy.md](privacy-policy.md) before sharing ANY KB content.**

## Quick Reference

1. Identify the requester (see [../identity/README.md](../identity/README.md))
2. If they resolve to a KB person, they are an **allowlisted user** with full access
3. Check the document's `visibility` frontmatter against [privacy-policy.md](privacy-policy.md) before surfacing content
4. Only then share

## Roles

| Role | Who | Capabilities |
|------|-----|-------------|
| **Allowlisted user** | Anyone with a sender_context (a KB people file + identity mapping) | Full read/write everywhere; visibility frontmatter still applies for display |
| **Unknown sender** | No KB identity mapping | Open-visibility reads only; no writes; no actions |

See [role-matrix.md](role-matrix.md) for the full capability table.

## Core Principles

- **Default deny**: If you can't confirm the requester is allowlisted, treat them as Unknown
- **Check before sharing**: Always read frontmatter `visibility` before surfacing content
- **Never leak in summaries**: Private info must not appear in general updates, task lists, or channel messages unless explicitly requested by the user it belongs to
- **Append-only audit**: Every interaction is logged (see [../knowledge-base/request-logging.md](../knowledge-base/request-logging.md))

## Related Rules

- [Privacy Policy](privacy-policy.md) — Document visibility enforcement
- [Role Matrix](role-matrix.md) — Capability table
- [Identity Resolution](../identity/README.md) — How allowlisted-vs-unknown is determined
