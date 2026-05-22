---
name: access-control
description: Reference skill for Breadbrich Engels's access control rules. Check who can see/do what, verify permissions, and understand the role hierarchy. Read-only.
---

# /access-control — Permission Check & Reference

Quick-reference for Breadbrich Engels's access control system. Use when checking permissions or explaining what a user can/cannot do.

## Role Hierarchy

| Role | Who | Level |
|------|-----|-------|
| **Superadmin** | alice, bob | Full access, credentials, structure changes |
| **Admin** | alice, ops, bob, carol | All KB, logs, manage groups/tasks, personnel notes |
| **Coordinator** | dave | Broad write (calendar/tasks/artifacts), read non-private, trigger deploys |
| **Contributor** | Team members | Read open docs, add tasks, update open info |
| **Guest** | Anyone authenticated | Read open docs only |

## Permission Matrix

| Permission | Superadmin | Admin | Coordinator | Contributor | Guest |
|-----------|-----------|-------|-------------|-------------|-------|
| View all KB docs | Yes | Yes | Yes (no personnel notes) | Open only | Open only |
| Create/edit KB docs | Yes | Yes | Non-private dirs | No | No |
| Cross-channel send | Yes | Yes | Yes | No | No |
| Manage scheduled tasks | Yes | Yes | No | No | No |
| Manage groups | Yes | Yes | No | No | No |
| Trigger redeployment | Yes | Yes | Yes (standard only) | No | No |
| View request logs | Yes | Yes | No | No | No |
| View credentials | Yes | No | No | No | No |
| Modify KB structure | Yes | No | No | No | No |
| Manual rollback | Yes | Yes | No | No | No |

## Core Principles

1. **Default deny** — if role unknown, treat as Guest
2. **Check before sharing** — always read frontmatter `visibility` before surfacing content
3. **Never leak in summaries** — private info must not appear in general updates
4. **Append-only audit** — every interaction logged

## Visibility Levels

| Level | Who Can See |
|-------|------------|
| `open` | All authenticated users |
| `restricted` | Admins + creator only |
| `private` | Admins + explicit viewers only |

## Quick Permission Check Flow

1. Identify the requester → `rules/identity/README.md`
2. Check their role → table above
3. Check document's `visibility` frontmatter
4. Only then share content

## Special Rules

- **WTF List entries**: Always anonymous. Never record submitter identity.
- **Personnel notes**: Admin-only. Never share with Coordinators.
- **Credentials**: Superadmin-only.
- **Side Project sensitive docs**: Restricted to Bob, Alice, Andrew Miller, dmarz, Dave.

## Related

- Full rules: `/workspace/project/rules/access-control/`
- Identity resolution: `/workspace/project/rules/identity/`
- Privacy policy: `/workspace/project/rules/access-control/privacy-policy.md`
