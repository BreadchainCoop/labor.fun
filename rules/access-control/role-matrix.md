# Role Permission Matrix

## By KB Directory

| Directory | Admin | Coordinator | Contributor | Guest |
|-----------|-------|-------------|-------------|-------|
| `people/` | R/W | Read | -- | -- |
| `people/` (personnel notes) | R/W | -- | -- | -- |
| `calendar/` | R/W | R/W | Read | Read |
| `tasks/` | R/W | R/W | Read (open) | Read (open) |
| `artifacts/` | R/W | R/W | Read (open) | Read (open) |

## By Capability

| Permission | Admin | Coordinator | Contributor | Guest |
|-----------|-------|-------------|-------------|-------|
| View all KB docs | Yes | Yes (except personnel notes) | Open only | Open only |
| Create/edit KB docs | Yes | Non-private dirs | No | No |
| Cross-channel send | Yes | Yes | No | No |
| Manage scheduled tasks | Yes | No | No | No |
| Manage groups | Yes | No | No | No |
| Manage tags | Yes (subject to hierarchy) | No | No | No |
| Trigger redeployment | Yes | Yes (standard only) | No | No |
| View request logs | Yes | No | No | No |
| View credentials | Superadmin only | No | No | No |
| Modify KB structure | Superadmin only | No | No | No |
| Access admin dashboard | Superadmin only | No | No | No |

## By Channel

| Channel | Admin | Coordinator | Contributor |
|---------|-------|-------------|-------------|
| **Slack** - Read KB | All | All (no personnel) | Open |
| **Slack** - Write KB | All | Non-private | No |
| **Slack** - Cross-send | Yes | Yes | No |
| **Slack** - Manage groups | Yes | No | No |
| **Telegram** - Read KB | All | All (no personnel) | Open |
| **Telegram** - Write KB | All | Non-private | No |
| **Telegram** - Cross-send | Yes | Yes | No |
| **CLI** - All ops | Yes | N/A | N/A |
| **KB Web UI** - View docs | Per visibility | Per visibility | Per visibility |
| **KB Web UI** - View creds | Superadmin | No | No |

## Coordinator Specifics

Coordinators (currently: Dave Doyle) have broad write access but with limits:
- **CAN**: Create/edit/delete in calendar, tasks, artifacts
- **CAN**: View all KB docs including restricted ones
- **CAN**: Send cross-channel messages
- **CAN**: Trigger standard redeployments via the `/redeploy-breadbrich` skill (`safe-deploy.sh` only)
- **CANNOT**: Edit people profiles
- **CANNOT**: View personnel notes
- **CANNOT**: Access credentials
- **CANNOT**: Modify KB directory structure, DB schema, or system config
- **CANNOT**: Modify deploy scripts, `.env`, or service configuration, or perform manual rollbacks

## Related Rules

- [Privacy Policy](privacy-policy.md) — Visibility enforcement
- [Tag Hierarchy](../identity/tag-hierarchy.md) — Tag assignment permissions
- [Identity Resolution](../identity/README.md) — How roles are determined
