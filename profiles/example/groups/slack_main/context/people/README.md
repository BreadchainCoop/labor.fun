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
github_username: jane-doe    # optional — enables auto co-authoring commits the
                             # assistant makes at this person's request
# Optional capacity fields — used by the operational report (#34). All optional,
# self-declared (we have no verified time tracking).
team: Operations            # groups the member in the report's "by team" view
expected_hours_per_week: 20 # declared, NOT verified
capacity_points: 8          # declared sprint capacity (same unit as task estimate)
pay_parity_note: part-time  # free-text caveat surfaced next to any overload flag
---

Operations lead. Owns the budget.
```

See the framework `rules/identity/` and `rules/access-control/` for the full
schema and role hierarchy, and `rules/integrations/operational-reports.md` for
how the capacity fields feed the recurring operational report.
