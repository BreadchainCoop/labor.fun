# Document Format

Every KB document MUST have YAML frontmatter with these fields.

## Required Frontmatter

```yaml
---
title: Document Title
created_by: Person Name
created_at: YYYY-MM-DD
visibility: open | restricted | private
editable_by: open | admins | creator
tags: [tag1, tag2]
---
```

## Visibility Levels

| Level | Meaning |
|-------|---------|
| `open` | Anyone can view |
| `restricted` | Admins and creator only |
| `private` | Admins and explicitly listed viewers only |

See [../access-control/privacy-policy.md](../access-control/privacy-policy.md) for enforcement rules.

## Editability Levels

| Level | Meaning |
|-------|---------|
| `open` | Anyone can request edits |
| `admins` | Only admins can edit |
| `creator` | Only the original creator can edit |

## Default Rules

| Document Type | Default Visibility | Default Editability |
|---------------|-------------------|---------------------|
| General contributor docs | `open` | `open` |
| Admin-created docs | `restricted` | `admins` |
| People profiles | `private` | `admins` |
| Tasks | `open` | `open` |
| Calendar events | `open` | `open` |

## People File Format

```markdown
---
title: Full Name
created_by: Who added this person
created_at: YYYY-MM-DD
visibility: private
editable_by: admins
tags: [group1, group2]
---

# Full Name

- **Role**: Their role at the organization
- **Status**: Active / Inactive / Contributor
- **Groups**: leadership, engineering, creative, operations, community
- **Contact**: Email, Slack handle, phone (as provided)
- **Skills**: What they bring
- **Notes**: Anything relevant
```

## Related Rules

- [Task Format](tasks.md) — Task-specific schema with dependencies and comments
- [Privacy Policy](../access-control/privacy-policy.md) — How visibility is enforced
