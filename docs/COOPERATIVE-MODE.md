# Cooperative Mode (Flat Access)

Breadbrich Engels normally runs a **main / non-main** trust split: exactly one
designated group (the "main" group) gets read-write access to the SQLite
database and the shared knowledge base, while every other channel/DM is
sandboxed (read-only KB, no DB, KB writes RBAC-gated through the orchestrator).

**Cooperative mode** removes that split. It is controlled by a single
environment variable:

```bash
FLAT_ACCESS=true   # default — cooperative mode ON
FLAT_ACCESS=false  # restore the sandboxed main/non-main model
```

This was introduced for an organization restructuring as a **cooperative where
every member has equal access and voting power**. There is no privileged admin
channel; every channel is a peer.

## What it changes

When `FLAT_ACCESS=true`, every registered group is treated as
main-equivalent for the **data-access plane**:

| Capability | Sandboxed (default off) | Cooperative (`FLAT_ACCESS=true`) |
|---|---|---|
| Read shared KB | All groups (read-only mount) | All groups |
| Write shared KB (`modify_kb_file`) | Main, or RBAC-tagged sender via IPC | **Every group, every sender** |
| SQLite DB (`store/`) | Main group only, read-write | **Every group, read-write** |
| Read other groups' folders (`/workspace/all-groups`) | Main group only | **Every group** |
| Cross-group `schedule_task`, task edit/delete, group registration | Main group only | **Every group** |
| Container `NANOCLAW_IS_MAIN` env | `1` only for main | `1` for every group |

Implementation: `isPrivilegedGroup()` / `FLAT_ACCESS` in `src/config.ts`. It is
OR'd into the single `isMain` decision that already drives container mounts
(`src/index.ts`, `src/task-scheduler.ts`), IPC authorization (`src/ipc.ts`), and
the per-group snapshots. No container image rebuild is required — the
container-side behavior follows the `NANOCLAW_IS_MAIN` env the orchestrator
sets per run.

## What it deliberately does NOT change

These are scoped out because they are not the data-access boundary, and
flattening them would be surprising or harmful:

- **Message-trigger behavior.** Non-main groups still require their trigger
  pattern / @mention to wake the agent. Flat *access* does not mean the bot
  replies to every message in every channel.
- **Host remote-control plane** (`/remote-control`). Still restricted to the
  actual designated main group — this is orchestrator takeover, not data
  access. Flatten it explicitly if the cooperative wants that too.

## Security implications — read this

Cooperative mode **removes the prompt-injection containment boundary**. Any
text anyone sends in any channel becomes agent instructions, and every
container now has read-write reach over:

- the full message history of **every** channel,
- every KB file including `people/` (private) and `financials/` (restricted),
- the `user_identities` and `tag_hierarchy` RBAC tables.

A prompt-injected message in any channel can therefore exfiltrate or mutate
org-wide data and rewrite permissions. **This is only acceptable when every
channel is trusted-internal** — i.e. there are no public, visitor-facing, or
external-intake channels. If you ever add an externally-reachable channel,
set `FLAT_ACCESS=false` first.

## Reverting

Set `FLAT_ACCESS=false` (or remove the line) and redeploy. No data migration
is involved; the flag only affects mount/authorization decisions at runtime.
