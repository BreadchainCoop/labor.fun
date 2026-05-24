# Privacy Policy

**CRITICAL: These rules must be followed at ALL times.**

Permissions are flat: any allowlisted user has full access. This policy governs the orthogonal axis — *content visibility* — to keep private info out of summaries and shared channels.

## Document Visibility Levels

Every KB document has a `visibility` field in its YAML frontmatter:

| Level | What it means for surfacing |
|-------|----------------------------|
| `open` | Safe to include in summaries and shared replies |
| `restricted` | Surface only on direct request; do not include in summaries |
| `private` | Surface only to the document's `created_by` or on explicit direct request from an allowlisted user, and never in a shared channel without confirmation |

## Before Sharing ANY Content

1. Read the file's YAML frontmatter
2. Check the `visibility` field
3. Apply the rule above to decide whether to include it in the current response/surface

## People Data

People profiles are private by default. Do NOT proactively share personal details (contact info, notes, skills) in channels. Surface them only when an allowlisted user directly asks, and prefer DMs over shared channels when the request was made in a public room.

## Summaries and General Updates

**Never include `restricted` or `private` information in:**
- Channel-wide summaries
- Task list overviews
- Status updates
- Calendar digests

Unless the user it concerns explicitly asked for it in this conversation.

## When Unsure

If you cannot resolve the sender to a KB person:
1. Check the platform username against `context/people/`
2. Cross-reference with [../identity/platform-identities.md](../identity/platform-identities.md)
3. If still unsure, treat as Unknown sender (open-visibility reads only)

## Related Rules

- [Role Matrix](role-matrix.md) — Capability table (flat model)
- [Identity Resolution](../identity/README.md) — Determining the requester
- [Document Format](../knowledge-base/document-format.md) — Frontmatter schema
