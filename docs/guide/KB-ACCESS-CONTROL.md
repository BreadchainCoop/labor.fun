# KB Access Control — The Consolidated Guide

> Who can see what, who can edit what, who can act on whose behalf — and where each rule is enforced.

The access control surface in Breadbrich Engels is small but has three independent enforcement layers that compose. This document walks the layers from coarse to fine, explains the role hierarchy, lays out a per-directory matrix, and ends with worked examples.

## Contents

1. [Mental model: three layers](#1-mental-model-three-layers)
2. [Layer 1: container isolation (groups can only see their own world)](#2-layer-1-container-isolation-groups-can-only-see-their-own-world)
3. [Layer 2: role hierarchy](#3-layer-2-role-hierarchy)
4. [Layer 3: visibility frontmatter on KB documents](#4-layer-3-visibility-frontmatter-on-kb-documents)
5. [Personnel Notes — the special case](#5-personnel-notes--the-special-case)
6. [Per-directory matrix](#6-per-directory-matrix)
7. [Cross-channel send authority](#7-cross-channel-send-authority)
8. [Worked examples](#8-worked-examples)
9. [Where each rule is enforced in code](#9-where-each-rule-is-enforced-in-code)
10. [Rule documents (source of truth)](#10-rule-documents-source-of-truth)

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
│ Layer 2: sender role     │  Does the *human sender* have a role with
│                          │  the requested permission?
└──────────────────────────┘
      │
      ▼
┌──────────────────────────┐
│ Layer 3: document        │  Does the document's `visibility:` and `viewers:`
│ visibility frontmatter   │  frontmatter permit this sender to see it?
└──────────────────────────┘
      │
      ▼
   Result
```

Three layers means three independent things to check when something looks broken: was the file mounted, did the role check pass, did the visibility check pass.

---

## 2. Layer 1: container isolation (groups can only see their own world)

Every agent container has a narrow filesystem view. The non-main containers can see:

- Their own group folder (`/workspace/group/`).
- The global folder (`/workspace/global/`), mounted read-only.
- The shared-KB mount: read access to the main group's `context/` (this is what closed the historical "the personal assistant can't read the KB" gap).
- The mounted container skills.

The non-main containers cannot see:

- Other group folders.
- The `store/` directory or `messages.db`.
- Anything on the mount allowlist's deny list: `.ssh/`, `.gnupg/`, `.aws/`, `.kube/`, `.docker/`, `credentials`, `.env`, `.netrc`, private keys, etc.
- Arbitrary host paths — even those listed in a group's `container_config.mounts`, unless the path passes `mount-security.ts` validation against `~/.config/breadbrich/mount-allowlist.json`.

The main container additionally has:

- `store/` mounted read-write (so it can query SQLite directly).
- The global folder mounted read-write (so it can update cross-group memory).
- Wider mount permissions, scoped by the same external allowlist.

The allowlist is intentionally **outside the repo** (in the operator's home `~/.config/breadbrich/`) so a malicious PR cannot widen mount permissions by modifying tracked files.

A useful corollary: if a non-main agent can't perform a file operation, the first thing to verify is not the role check but the mount. Layer 1 failures look like "command not found" or "no such file or directory," not like "permission denied."

---

## 3. Layer 2: role hierarchy

Roles in Breadbrich Engels are tag-based, defined in the `tag_hierarchy` table and the role-matrix rule.

### 3.1 The roles

| Role | Typical members | Summary |
|---|---|---|
| **Superadmin** | alice, bob | The two operators with credential and structural authority. Can change deployment, modify the admin dashboard, manage secrets. |
| **Admin** | alice, bob, ops, carol | Full KB access (including restricted and private docs). Can manage groups, manage tasks, send across channels, view personnel notes. Effectively the operating team. |
| **Coordinator** | dave | The operations coordinator. Broad write to calendar, tasks, artifacts. Reads all non-private KB *except personnel notes*. Cross-channel send for operational purposes. Earmarked for live-testing the coordinator deploy path. |
| **Contributor** | residents, frequent collaborators | Reads open docs. Creates and updates their own tasks, expense requests, maintenance reports. Cannot read restricted or private docs unless granted. |
| **Guest** | anyone authenticated who isn't otherwise known | Reads open docs only. Cannot write. Default for unrecognized identities. |

### 3.2 How a sender gets a role

The pipeline is:

1. Channel message arrives with a platform id (slack user id, telegram id, etc.).
2. `src/permissions.ts` looks up `user_identities (platform_id, platform)` and gets a `kb_person` name.
3. That `kb_person` name is matched against the role lists in the rule files (and historically also against `tag_hierarchy`).
4. If no match is found at step 2, the sender is treated as a **guest** by default. This is the "default-deny" posture: unknown identities cannot perform admin actions.

### 3.3 Role inheritance via `tag_hierarchy`

`tag_hierarchy` encodes parent → child relationships (e.g. `admin → engineering`, `admin → leadership`, `coordinator → operations`). When code asks "is `bob` an engineering admin?" the answer is yes via inheritance from `admin`. The hierarchy is also surfaced in the kb-ui admin dashboard.

---

## 4. Layer 3: visibility frontmatter on KB documents

Every KB markdown document carries YAML frontmatter:

```yaml
---
visibility: open | restricted | private
created_by: <kb_person>
viewers: [list of kb_persons]   # only for visibility: private
tags: [...]
---
```

### 4.1 The three visibility levels

| Level | Who can read |
|---|---|
| `open` | Any authenticated viewer (any role). |
| `restricted` | Admins, plus the document's `created_by`, plus any sender whose role tags overlap the document's `tags`. |
| `private` | Admins, plus the document's `created_by`, plus the explicit `viewers` list. |

If a document has no `visibility` frontmatter, treat it as `open` for back-compatibility, but new documents should always declare it.

### 4.2 Edit permissions

Visibility governs *read*. Edit permissions are governed by a separate `editability:` field (or are derived from `visibility`):

| Document state | Who can edit |
|---|---|
| `editability: open` | Any contributor or higher. |
| `editability: admins` | Admins only. |
| `editability: creator` | The `created_by` user (plus admins as override). |
| (unspecified) | Defaults to the directory's role-matrix default (see §6). |

Agents enforce visibility before reading; kb-ui enforces visibility before serving HTML; the IPC handlers enforce role before writing.

### 4.3 What "restricted" actually means

A `restricted` document is meant to be visible to people who are part of the document's *topic*, not the general membership. The mechanism is **tag intersection**: if a document is tagged `[finance]` and a sender's role tags include `finance` (e.g. a `coordinator` whose `tag_hierarchy` rolls into `operations` and then to `finance`), the sender sees it. Admins always see all restricted documents regardless of tags.

This is why the `tag_hierarchy` table is doing work even on the read side, not just the write side.

---

## 5. Personnel Notes — the special case

There is one structural override that runs on top of the visibility model: **Personnel Notes are admin-only**.

Inside any KB document, a section literally headed `## Personnel Notes` is stripped from the rendered output for any non-admin viewer. This is enforced in `kb-ui/server.mjs` at render time. The stripping is at the *section level*, not the document level — a contributor can read the rest of a `people/<name>.md` document without seeing the Personnel Notes section.

Two implications:

- **Don't rename the section to circumvent the strip.** That defeats a privacy mechanism designed for compassionate use (e.g. notes about disabilities, conflicts, sensitive context).
- **Do put sensitive context under that heading.** The mechanism is built to be used; it is the appropriate place for information that you might otherwise not write down at all.

---

## 6. Per-directory matrix

Each KB directory under `groups/<name>/context/` has a default role posture. The role-matrix rule lays it out:

| Directory | Admin | Coordinator | Contributor | Guest |
|---|---|---|---|---|
| `people/` | R/W | Read | — | — |
| `calendar/` | R/W | R/W | Read (open) | Read (open) |
| `tasks/` | R/W | R/W | Read (open) | Read (open) |
| `artifacts/` | R/W | R/W | Read (open) | Read (open) |
| `projects/` | R/W | R/W | Read (open) | Read (open) |
| `maintenance/` | R/W | R/W | Read own; create new | — |
| Personnel Notes section (anywhere) | Read/Write | — | — | — |

Notes:

- "Read (open)" means: the role can read open documents in the directory but not restricted or private ones.
- Contributors can always create their own tasks, expense requests, and maintenance reports — even though they cannot read other contributors' restricted items.
- Guests are read-only and only see `open` documents.
- Coordinator does not get read access to `people/` notes by design; they coordinate operations, not personnel.

If you find code or a rule that contradicts this matrix, the role-matrix rule wins.

---

## 7. Cross-channel send authority

Sending a message *from one chat into another chat* is a distinct permission, gated by both role and routing rule.

| Sender role | Cross-channel allowed? |
|---|---|
| Main user | yes — main has full cross-channel authority |
| Admin | yes — admins can send to any registered chat, subject to routing rule `cross_channel_delegation` |
| Coordinator | yes — but typically scoped to operational chats; the `cross_channel_delegation` rule's `auth` field controls this |
| Contributor | no |
| Guest | no |

The routing rule `cross_channel_delegation` further enforces that the destination chat is registered and that the rule's `share_back` clause doesn't leak private content. A non-admin can never trigger a cross-channel send; the agent will refuse and explain why.

---

## 8. Worked examples

### Example 1: Contributor asks Breadbrich Engels to read TASK-005

- Sender: a contributor (resident, not in admin/coordinator lists).
- Action: `read context/tasks/TASK-005.md`.
- Layer 1 (mount): pass — `tasks/` is in the shared-KB mount.
- Layer 2 (role): pass — contributor can read open tasks.
- Layer 3 (visibility): the document has `visibility: open` → pass.

Result: agent returns the task. ✓

### Example 2: Contributor asks Breadbrich Engels to read a private task

- Sender: contributor.
- Action: read a task with `visibility: private`, `viewers: [alice, dave]`.
- Layer 1: pass.
- Layer 2: pass for the *directory* (contributors can read open tasks).
- Layer 3: **fail** — the sender is not in `viewers`, not the `created_by`, and not an admin.

Result: agent refuses, says the task is private. ✓

### Example 3: Guest browses kb-ui

- Sender: an authenticated user with no `kb_person` mapping.
- Action: `GET /category/artifacts`.
- Layer 1: pass (kb-ui has full FS access; we're at the role layer).
- Layer 2: guest → can read open docs only.
- Layer 3: each doc is filtered; the rendered category page shows only `visibility: open` documents.

Result: list is short, no restricted/private docs. ✓

### Example 4: Coordinator updates an event

- Sender: dave (coordinator).
- Action: `event_assign(event_id, user_id="nina", role="host")`.
- Layer 1: pass.
- Layer 2: coordinator has R/W on `calendar/` per the matrix.
- Layer 3: the event is `open` (events usually are) → pass.

Result: IPC handler writes the `event_assignments` row, post-hooks notify nina. ✓

### Example 5: Coordinator tries to read a personnel note

- Sender: dave.
- Action: `read context/people/kai.md`.
- Layer 1: pass.
- Layer 2: coordinator can read `people/` directory.
- Layer 3: file's visibility is open → pass.
- Personnel Notes override: dave is not admin → the `## Personnel Notes` section is stripped from the response.

Result: dave sees the body of `kai.md` minus the Personnel Notes section. ✓

### Example 6: Admin asks the personal assistant (Telegram) to DM everyone

- Sender: alice (admin), writing in `telegram_internal`.
- Action: "DM everyone about the workshop change."
- Layer 1: pass — the request goes through the host orchestrator, which can address any registered chat.
- Layer 2: admin → cross-channel send is allowed.
- Layer 3: the message is generated by the agent; visibility doesn't apply to outgoing text.
- Routing: the `cross_channel_delegation` rule matches; the agent enumerates registered chats and fans out.

Result: each registered chat gets a DM. ✓

(Historically this looked broken because the non-main Telegram container couldn't see the directory of recipients. The shared-KB mount closed that path; the action itself is performed by the host orchestrator on the agent's behalf, so the container's own mount set isn't the limiting factor for the *outbound* operation.)

### Example 7: Resident submits a maintenance request

- Sender: kai (contributor / resident).
- Action: `report_maintenance_issue(title="shower leak", location="room 4", priority="high")`.
- Layer 1: pass.
- Layer 2: contributors can create maintenance requests.
- Layer 3: the created document is `visibility: open` so anyone can see the new MR.

Result: IPC creates `MR-<timestamp>`, writes the markdown, notifies the ops channel. ✓

### Example 8: Anyone asks for credentials

- Sender: any role, including admin.
- Action: read the `.env`, request an API key, dump secrets.
- Layer 1: pass *or fail* depending on the sender's container — but it doesn't matter, because:
- Layer 2: the routing rule `credential_access` requires `auth: [superadmin]`, and even then `share_back` excludes raw secrets.

Result: refused unless the requester is alice or bob, and even then secrets are not surfaced in chat. ✓

---

## 9. Where each rule is enforced in code

For when something doesn't behave as the rules say:

| Concern | Enforced in |
|---|---|
| Container mounts and the mount allowlist | `src/mount-security.ts`; allowlist file at `~/.config/breadbrich/mount-allowlist.json` |
| Sender → role resolution | `src/permissions.ts`; backed by `user_identities` and `tag_hierarchy` |
| IPC authorization (who can call which handler) | per-handler checks in `src/ipc.ts` |
| Document visibility on read (kb-ui) | `kb-ui/server.mjs` (`canView()` and per-route filtering) |
| Personnel Notes stripping | `kb-ui/server.mjs` (section-level regex strip for non-admin) |
| Cross-channel send | `src/ipc.ts` send-message handler + the `cross_channel_delegation` routing rule |
| Visibility share-back filtering | `docs/architecture/routing-rules.yaml` (`visibility_filter` block) |
| Credential isolation | `src/credential-proxy.ts` + OneCLI Agent Vault outside the repo |

When you change a rule, audit each row that touches it.

---

## 10. Rule documents (source of truth)

These rule docs are authoritative. Code conforms to them, not the other way around.

| Document | Topic |
|---|---|
| `rules/access-control/README.md` | Overview of the access control model |
| `rules/access-control/role-matrix.md` | The per-directory R/W matrix (see §6) |
| `rules/access-control/privacy-policy.md` | The visibility frontmatter conventions, Personnel Notes rule |
| `rules/identity/README.md` | Identity resolution model (user_identities, tag_hierarchy) |
| `rules/identity/<platform>.md` | Per-platform identity mapping rules |
| `rules/messaging/cross-channel.md` | Cross-channel send authority and share-back filtering |
| `docs/architecture/routing-rules.yaml` | The dispatcher; auth clauses and post-hooks |
| `groups/<name>/CLAUDE.md` | Per-group overrides (rarely loosen permissions; commonly tighten) |

If you need to **change** access control behavior:

1. Update the relevant rule file first.
2. Update the corresponding enforcement (`src/permissions.ts`, `src/ipc.ts` handler, kb-ui filter, routing rule).
3. Test all three layers with a worked example like §8.
4. Capture the change in `MEMORY.md` if it changes operator habits.
