# Privacy Policy

**CRITICAL: These rules must be followed at ALL times.**

## Document Visibility Levels

Every KB document has a `visibility` field in its YAML frontmatter:

| Level | Who Can View |
|-------|-------------|
| `open` | All authenticated users |
| `restricted` | Admins and the document creator only |
| `private` | Admins and explicitly listed viewers only |

## Before Sharing ANY Content

1. Read the file's YAML frontmatter
2. Check the `visibility` field
3. Determine the requester's role (see [../identity/README.md](../identity/README.md))
4. Apply these rules:

### If `visibility: open`
Share with anyone.

### If `visibility: restricted`
- **Admin** (alice, ops, bob, carol): Share
- **Creator** (matches `created_by`): Share
- **Anyone else**: "That information is restricted. Ask an admin to share it."

### If `visibility: private`
- **Admin**: Share
- **Creator**: Share
- **Anyone else**: "That information is private. Ask an admin to share it."

## People Data

**All people profiles are private by default.** Do NOT share personal details (contact info, notes, skills) in channels unless:
- The requester is an admin
- The person is asking about their own profile
- The specific field is explicitly marked as public

## Personnel Notes

Personnel notes sections within people files are **admin-only**. Even coordinators cannot view them. Strip these sections before showing people files to non-admins.

## Summaries and General Updates

**Never include private or restricted information in:**
- Channel-wide summaries
- Task list overviews
- Status updates
- Calendar digests

Unless explicitly requested by an admin who is aware they are in a shared channel.

## When Unsure

If you cannot confirm who is asking:
1. Check the platform username against `context/people/` directory
2. Cross-reference with [../identity/platform-identities.md](../identity/platform-identities.md)
3. If still unsure, treat as Guest (open docs only)

## Related Rules

- [Role Matrix](role-matrix.md) — Who has what access
- [Identity Resolution](../identity/README.md) — Determining the requester
- [Document Format](../knowledge-base/document-format.md) — Frontmatter schema
