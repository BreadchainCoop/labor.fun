# Access Control Rules

These rules govern what the assistant can share, who can see what, and how requests are authorized. **Read [privacy-policy.md](privacy-policy.md) before sharing ANY KB content.**

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

## External membership-intake channels

A channel listed in `MEMBERSHIP_CHANNEL` is **public/untrusted** and is the one
exception to cooperative mode: the general assistant is suppressed there, and a
**sandboxed** membership-intake flow runs instead — non-privileged regardless of
`FLAT_ACCESS` (no DB, KB read-only), restricted to read-only tools, with an
injection-hardened persona. It accepts unknown senders, has no KB/DB write path,
and its IPC is ignored. The only thing it can do is file a membership-interest
record (written by the privileged orchestrator, attributed to the real sender)
and notify onboarding. Never widen this channel's privileges. See `src/membership-intake.ts`.

## Related Rules

- [Privacy Policy](privacy-policy.md) — Document visibility enforcement
- [Role Matrix](role-matrix.md) — Capability table
- [Identity Resolution](../identity/README.md) — How allowlisted-vs-unknown is determined
