# KB Access Control — The Consolidated Guide

> Who can see what, who can edit what, who can act on whose behalf — and where each rule is enforced.

The access control surface in Breadbrich Engels is small. It has three independent enforcement layers that compose. This document walks them from coarse to fine and ends with the per-document visibility rule.

## Contents

1. [Mental model: three layers](#1-mental-model-three-layers)
2. [Layer 1: container isolation](#2-layer-1-container-isolation)
3. [Layer 2: allowlist gate (flat permission model)](#3-layer-2-allowlist-gate-flat-permission-model)
4. [Layer 3: visibility frontmatter](#4-layer-3-visibility-frontmatter)
5. [Where each rule is enforced in code](#5-where-each-rule-is-enforced-in-code)
6. [Rule documents (source of truth)](#6-rule-documents-source-of-truth)

---

## 1. Mental model: three layers

A request to read or write the KB passes through three checks. All three must pass.

```
   Request
      │
      ▼
┌──────────────────────────┐
│ Layer 1: container       │  Is the file even mounted into the requesting
│ isolation                │  container? If not, the agent literally cannot
└──────────────────────────┘  see it.
      │
      ▼
┌──────────────────────────┐
│ Layer 2: allowlist gate  │  Did the sender resolve to a known KB person?
│                          │  Allowlisted → allow. Unknown → deny.
└──────────────────────────┘
      │
      ▼
┌──────────────────────────┐
│ Layer 3: document        │  Does the document's `visibility:` frontmatter
│ visibility frontmatter   │  permit surfacing it to this sender right now?
└──────────────────────────┘
      │
      ▼
   Result
```

Three layers means three independent things to check when something looks broken: was the file mounted, was the sender allowlisted, did the visibility check pass.

---

## 2. Layer 1: container isolation

Every agent container has a narrow filesystem view. The non-main containers can see:

- Their own group folder (`/workspace/group/`).
- The global folder (`/workspace/global/`), mounted read-only.
- The shared-KB mount: read access to the main group's `context/`.
- The mounted container skills.

The non-main containers cannot see:

- Other group folders.
- The `store/` directory or `messages.db`.
- Anything on the mount allowlist's deny list (`.ssh/`, `.gnupg/`, `.aws/`, `credentials`, `.env`, private keys, etc.).
- Arbitrary host paths — even those listed in a group's `container_config.mounts`, unless the path passes `mount-security.ts` validation against `~/.config/breadbrich/mount-allowlist.json`.

The main container additionally has `store/` and the global folder mounted read-write, plus wider mount permissions scoped by the same external allowlist.

The allowlist is intentionally **outside the repo** (in `~/.config/breadbrich/`) so a malicious PR cannot widen mount permissions by modifying tracked files.

A useful corollary: if a non-main agent can't perform a file operation, the first thing to verify is not the permission check but the mount. Layer 1 failures look like "command not found" or "no such file or directory," not like "permission denied."

---

## 3. Layer 2: allowlist gate (flat permission model)

There is one tier: **allowlisted user**. A sender is allowlisted iff they resolve to a row in the `user_identities` table (which the Discord-members sync populates from anyone holding `DISCORD_DM_ALLOWED_ROLE_IDS`, and which can be seeded for other platforms via `SEED_IDENTITIES`).

| State | What the orchestrator does |
|-------|---------------------------|
| Allowlisted | Writes a `sender_context.json` next to the IPC call. Every gated IPC handler (KB writes, cross-channel send, task management, expense approval, group registration, etc.) allows the call. |
| Unknown | No `sender_context.json` written. Gated handlers reject with `'Unknown sender'`. |

There are no Admin / Coordinator / Contributor / Guest tiers. The `tags:` on people files (`engineering`, `operations`, etc.) are descriptive labels only — they do not grant permissions.

The chat-level **intake** filter (`sender-allowlist.json`) is orthogonal: it controls who can speak to the agent at all, before any of this matters.

`isMain` is a property of a registered chat — it identifies the "control channel" used for default routing and prompts. It is **not** a permission gate.

---

## 4. Layer 3: visibility frontmatter

Per-document `visibility:` controls **how to surface** content, not whether the user has write access:

| Level | Surfacing rule |
|-------|---------------|
| `open` | Safe to include in summaries and shared replies |
| `restricted` | Surface only on direct request; do not include in summaries |
| `private` | Surface only to the document's `created_by` or on explicit direct request from an allowlisted user; never in a shared channel without confirmation |

People profiles are private by default — don't proactively share personal details in channels; prefer DMs over public rooms when surfacing them.

---

## 5. Where each rule is enforced in code

| Layer | File | Function |
|-------|------|----------|
| 1 | `src/container-runner.ts`, `src/mount-security.ts` | Container mount construction + mount allowlist |
| 2 | `src/permissions.ts` | `resolveUser`, `isAllowlisted`, `getSenderContext` |
| 2 | `src/ipc.ts` | `canModifyKbFile`, `processTaskIpc`, `handleModifyGroupClaudeMd`, expense handlers, task/group management handlers |
| 2 | `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP tool implementations |
| 3 | Agent prompts / skill docs | `visibility:` frontmatter read by the container agent before surfacing |

---

## 6. Rule documents (source of truth)

- [`rules/access-control/README.md`](../../rules/access-control/README.md) — Layer 2 overview
- [`rules/access-control/role-matrix.md`](../../rules/access-control/role-matrix.md) — Capability table (flat model)
- [`rules/access-control/privacy-policy.md`](../../rules/access-control/privacy-policy.md) — Layer 3 enforcement
- [`rules/identity/README.md`](../../rules/identity/README.md) — Identity resolution pipeline
- [`rules/identity/platform-identities.md`](../../rules/identity/platform-identities.md) — Cross-platform user mapping
