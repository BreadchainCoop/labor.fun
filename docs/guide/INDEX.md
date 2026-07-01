# Breadbrich Engels System Guide — Start Here

This is the onboarding and reference guide for the Breadbrich Engels system: the Node.js orchestrator that runs Claude agents in containers for your organization and its community.

If you are new, read these in order:

1. **[BREADBRICH-GUIDE.md](./BREADBRICH-GUIDE.md)** — The main teaching document. Mental model, terminology glossary, end-to-end message flow, data schema overview, workflow primitives, skills, rules, routing, deploy, and worked walkthroughs. Read this first.
2. **[KB-ACCESS-CONTROL.md](./KB-ACCESS-CONTROL.md)** — Who can see and edit what. Visibility frontmatter, role hierarchy, Personnel Notes stripping, per-directory matrix, worked examples.

When you need the deepest detail, those files link out to the canonical existing docs:

| Topic | Canonical doc |
|---|---|
| Architecture spec | [`docs/SPEC.md`](../SPEC.md) |
| Orchestration model | [`docs/architecture/BREADBRICH-ORCHESTRATION.md`](../architecture/BREADBRICH-ORCHESTRATION.md) |
| Database schema (every table, every column) | [`schema/tables.md`](../../schema/tables.md) |
| Data inventory (what state lives where) | [`docs/architecture/DATA-INVENTORY.md`](../architecture/DATA-INVENTORY.md) |
| State recovery | [`docs/architecture/STATE-RECOVERY-MAP.md`](../architecture/STATE-RECOVERY-MAP.md) |
| Migration runbook | [`docs/architecture/MIGRATION-RUNBOOK.md`](../architecture/MIGRATION-RUNBOOK.md) |
| Routing rules (message → handler) | [`docs/architecture/routing-rules.yaml`](../architecture/routing-rules.yaml) |
| Deploy + rollback | [`docs/DEPLOY.md`](../DEPLOY.md) |
| Security model + threat model | [`docs/SECURITY.md`](../SECURITY.md) |
| Apple Container networking | [`docs/APPLE-CONTAINER-NETWORKING.md`](../APPLE-CONTAINER-NETWORKING.md) |
| Docker sandboxes | [`docs/docker-sandboxes.md`](../docker-sandboxes.md) |
| Skills as branches (extensibility) | [`docs/skills-as-branches.md`](../skills-as-branches.md) |
| Claude Agent SDK internals | [`docs/SDK_DEEP_DIVE.md`](../SDK_DEEP_DIVE.md) |
| Branch/fork maintenance | [`docs/BRANCH-FORK-MAINTENANCE.md`](../BRANCH-FORK-MAINTENANCE.md) |
| Debug checklist | [`docs/DEBUG_CHECKLIST.md`](../DEBUG_CHECKLIST.md) |
| Workflow spec template | [`docs/workflows/`](../workflows/) |
| Expense lifecycle | [`docs/expense-flows.md`](../expense-flows.md) |
| Top-level operating rules | [`CLAUDE.md`](../../CLAUDE.md) |
| Rules index | [`rules/INDEX.md`](../../rules/INDEX.md) |
| Group config (per group) | `groups/<name>/CLAUDE.md` |
| Contributing skills/rules/code | [`CONTRIBUTING.md`](../../CONTRIBUTING.md) |

## What is and is not in this guide

**In this guide:** the mental model, the terminology, how the pieces fit together, what each piece is for, who can do what, end-to-end walkthroughs, and pointers to deeper detail.

**Not in this guide:** column-by-column schema specs (see `schema/tables.md`), exact deploy commands (see `docs/DEPLOY.md`), per-channel setup instructions (see the `/add-<channel>` skills). Those docs are authoritative for their topics; this guide does not duplicate them.

## A note on freshness

The Breadbrich Engels repo is a living system. When this guide and a canonical doc disagree, **trust the canonical doc and the current code**, then update this guide. If you find drift, file a small PR.

The local `groups/` directory is *stateful* and not deployed via PR — the authoritative KB state lives on the production droplet at `/opt/breadbrich/groups/`. If you `ls groups/` locally and see fewer groups than you expect, that is normal: only group folders touched on your machine appear there.
