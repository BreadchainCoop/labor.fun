# Tag Hierarchy

Tags determine RBAC permissions. Higher tags can assign lower tags.

## Hierarchy

```
admin
├── leadership
│   ├── engineering
│   ├── creative
│   ├── operations
│   └── community
└── coordinator
    ├── operations
    └── community
```

## Assignment Rules

| Holder Tag | Can Assign |
|-----------|-----------|
| `admin` | admin, leadership, engineering, creative, operations, community, coordinator |
| `leadership` | engineering, creative, operations, community |
| `coordinator` | operations, community |
| Others | Cannot assign tags |

## Tag Meanings

| Tag | Description | Example People |
|-----|-------------|---------------|
| `admin` | Full system access | alice, bob, carol, ops |
| `leadership` | Founders, owners, decision-makers | alice, bob, carol |
| `coordinator` | Manages operations, broad write access | dave |
| `engineering` | Technical contributors | bob, ops, dave |
| `creative` | Design, content, art | — |
| `operations` | Logistics, facilities | dave |
| `community` | Community members, external | — |

A person can have multiple tags. Permissions are the **union** of all their tags' capabilities.

## Storage

Tags are stored in two places:
- **`tag_hierarchy` table** — defines the hierarchy (DB)
- **`context/people/{name}.md`** — each person's tags in frontmatter

## Related Rules

- [Identity Resolution](README.md) — How tags are loaded
- [Role Matrix](../access-control/role-matrix.md) — What tags allow
