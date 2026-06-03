# People

Each member of your org gets one markdown file here (`<slug>.md`) with
frontmatter describing their identity, role, and platform handles. This folder
**is** the allowlist — the assistant resolves names and permissions against it.

Example (`jane-doe.md`):

```markdown
---
name: Jane Doe
slug: jane-doe
role: admin
tags: [admin]
platforms:
  slack: U01234567
  telegram: 123456789
---

Operations lead. Owns the budget.
```

See the framework `rules/identity/` and `rules/access-control/` for the full
schema and role hierarchy.
