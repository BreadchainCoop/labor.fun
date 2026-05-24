---
name: access-control
description: Reference skill for Breadbrich Engels's flat access control model. There is one tier — allowlisted users have full access; unknown senders have none. Read-only.
---

# /access-control — Permission Check & Reference

Quick-reference for Breadbrich Engels's access control. Use when checking whether the caller can perform an action.

## Two States

| State | Who | What they can do |
|-------|-----|------------------|
| **Allowlisted user** | Anyone with a `sender_context` (a KB people file + identity mapping) | Full read/write everywhere; cross-channel; manage tasks/groups; approve expenses |
| **Unknown sender** | No KB identity mapping | Open-visibility reads only; no writes; no actions |

That's the whole model. There are no Admin/Coordinator/Contributor/Guest tiers, and `tags:` on people files are descriptive labels only (no permission effect).

## Visibility Frontmatter Still Applies

Per-document `visibility:` controls **what gets shown**, not whether the user has write access:

| Level | Surfacing rule |
|-------|---------------|
| `open` | Safe in summaries and shared replies |
| `restricted` | Surface only on direct request; not in summaries |
| `private` | Surface only to the document's `created_by` or on explicit direct request, never in a shared channel without confirmation |

## Quick Permission Check Flow

1. Identify the requester → `rules/identity/README.md`
2. If they resolved to a KB person → allowlisted → action permitted
3. Before surfacing a document, check its `visibility` frontmatter

## Group-level `isMain`

`isMain` is a property of a registered chat (the "control channel"). It is **not** a permission gate — an allowlisted user can do main-group operations from any registered group.

## Special Surfacing Rules

- **WTF List entries**: always anonymous; never record submitter identity
- **People profiles**: private by default — don't proactively surface in channels; prefer DMs

## Related

- Full rules: `/workspace/project/rules/access-control/`
- Identity resolution: `/workspace/project/rules/identity/`
- Privacy policy: `/workspace/project/rules/access-control/privacy-policy.md`
