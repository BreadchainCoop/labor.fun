# Permission Matrix (Flat Model)

There is one tier: **Allowlisted user**. Any sender who resolves to a KB person (present in `sender-allowlist.json` and carrying the configured Discord allowlist role, which makes them a known KB person) has full access. Unknown senders have none.

## By Capability

| Permission | Allowlisted user | Unknown sender |
|-----------|------------------|---------------|
| View any KB doc | Yes (subject to per-doc `visibility` frontmatter) | Open-visibility only |
| Create/edit/delete KB docs (any directory) | Yes | No |
| Cross-channel send | Yes (from any registered group) | No |
| Manage scheduled tasks (schedule/pause/resume/cancel/update, any group) | Yes | No |
| Register or refresh groups | Yes | No |
| Approve/reject proposed tasks | Yes | No |
| Approve expenses (any amount, prospective or retrospective) | Yes | No |
| Process reimbursements | Yes | No |
| Modify another group's CLAUDE.md | Yes | No |
| Create KB-UI dashboard users | Yes | No |

## Visibility Frontmatter Still Applies

Per-document `visibility:` frontmatter (`open` / `restricted` / `private`) and `editable_by:` rules are still enforced for read display — those gate what gets *shown* in summaries and surfaces, not whether the user has write access. See [privacy-policy.md](privacy-policy.md).

## Group-level `isMain`

`isMain` is a property of a registered chat/group identifying the "control channel" (used for routing default notifications and prompts). It is **not** a permission gate — an allowlisted user can do main-group operations from any registered group.

## Related Rules

- [Privacy Policy](privacy-policy.md) — `visibility` frontmatter enforcement
- [Identity Resolution](../identity/README.md) — How allowlisted-vs-unknown is determined
