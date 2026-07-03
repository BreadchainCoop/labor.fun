# Breadbrich Engels — The Complete Guide

> One Node.js process, real containers per group, markdown for knowledge, SQLite for state, rules for behavior, skills as git branches.

This guide teaches Breadbrich Engels end-to-end. Read it linearly the first time; use the table of contents thereafter.

---

## Contents

1. [What Breadbrich Engels is, in one paragraph](#1-what-breadbrich-is-in-one-paragraph)
2. [The mental model](#2-the-mental-model)
3. [Glossary](#3-glossary)
4. [The orchestrator and the container](#4-the-orchestrator-and-the-container)
5. [How a single message flows, end to end](#5-how-a-single-message-flows-end-to-end)
6. [Two memory systems: markdown KB and SQLite](#6-two-memory-systems-markdown-kb-and-sqlite)
7. [Data schema overview](#7-data-schema-overview)
8. [Workflow primitives: tasks, projects, events, processes, templates](#8-workflow-primitives-tasks-projects-events-processes-templates)
9. [Rules: where behavior lives](#9-rules-where-behavior-lives)
10. [Routing: the YAML that decides who handles what](#10-routing-the-yaml-that-decides-who-handles-what)
11. [Skills and extensibility](#11-skills-and-extensibility)
12. [Deploy, ops, and recovery](#12-deploy-ops-and-recovery)
13. [End-to-end walkthroughs](#13-end-to-end-walkthroughs)
14. [Adding to the system: a contributor's checklist](#14-adding-to-the-system-a-contributors-checklist)
15. [Pitfalls and gotchas](#15-pitfalls-and-gotchas)
16. [Where to go next](#16-where-to-go-next)

---

## 1. What Breadbrich Engels is, in one paragraph

Breadbrich Engels is a small (single Node.js process) AI assistant that lives on a Linux droplet, listens to several chat channels at once (Slack, Telegram, WhatsApp, Discord, Gmail, CLI), and answers requests by spawning ephemeral Claude agent containers. Each registered chat group gets its own container with its own filesystem and its own markdown memory. Breadbrich Engels's "brain" — what it knows, what it can do, who is allowed to ask — is written as rules and routing files in the repo, not buried in code. Adding capability means merging a `skill/<name>` git branch; modifying behavior means editing a rule file; everything is version-controlled.

If you remember nothing else, remember this: **one process, real containers, markdown knowledge, SQLite state, rules as source of truth, skills as branches.**

---

## 2. The mental model

```
   ┌──────────── chat channels ────────────┐
   │ Slack    Telegram   WhatsApp   Gmail  │
   │ Discord  CLI        (Emacs, X)        │
   └───────────────────┬───────────────────┘
                       │ messages
                       ▼
   ┌────────────────────────────────────────────┐
   │  Breadbrich Engels orchestrator (one Node.js process)  │
   │  - channel registry  (src/channels)        │
   │  - message loop      (src/index.ts)        │
   │  - router            (src/router.ts)       │
   │  - permissions       (src/permissions.ts)  │
   │  - task scheduler    (src/task-scheduler)  │
   │  - IPC watcher       (src/ipc.ts)          │
   │  - SQLite            (store/messages.db)   │
   └────────────┬───────────────────────────────┘
                │ spawn (one container per group invocation)
                ▼
   ┌─────────────────────────────────────────────┐
   │  Agent container (Linux, ephemeral, --rm)   │
   │  - Claude Agent SDK                         │
   │  - container skills (browser, formatting)   │
   │  - MCP tools (incl. IPC tool to host)       │
   │  - mounted: groups/<name>/, store/ (main)   │
   │  - mounted: groups/global/ (read-only)      │
   └─────────────────────────────────────────────┘
```

Breadbrich Engels's three durable invariants:

1. **Small enough to understand.** No microservices. No queues. One process. The whole orchestrator is on the order of 35 source files.
2. **Real isolation, not application sandboxes.** Agents run as a non-root user inside a Linux container with a deliberately narrow set of mounted paths.
3. **Customization is code, not configuration sprawl.** Adding a channel, an integration, or a workflow is a code change on a branch, merged through PR, deployed through `safe-deploy.sh`. There is no admin dashboard for "add a new feature."

---

## 3. Glossary

This vocabulary recurs throughout the codebase and the rest of this guide.

| Term | Meaning |
|---|---|
| **NanoClaw** | Upstream package Breadbrich Engels is forked from; you will see `nanoclaw` in package names, container image tags (`nanoclaw-agent:latest`), and env paths (`~/.config/nanoclaw/.env`). Treat as a synonym for the Breadbrich Engels runtime. |
| **Breadbrich Engels** | The fork / product name. The droplet hostname is set via `DROPLET_HOST` in `.env`; the service is `breadbrich.service`; the install path is `/opt/breadbrich` (with `/opt/breadbrich` symlink kept for backward compatibility during the rename rollout). |
| **the personal assistant** | The Telegram-facing persona, bot username `@your_bot_username`. **Not** a separate deployment. Same Breadbrich Engels orchestrator; Telegram is just one of several channels. Historically had reduced KB access because non-main containers didn't mount the main group's KB; the shared-KB mount has since fixed that. |
| **Group** | A registered chat. Has a name, a folder under `groups/<name>/`, a JID, a channel (slack / telegram / discord / cli / gmail / whatsapp), and per-group config in SQLite (`registered_groups`) and on disk (`groups/<name>/CLAUDE.md`). |
| **Main group** | The single elevated, admin chat (typically the operator's self-chat). Has read-write access to the global KB and can schedule tasks for, send messages to, and manage other groups. There is exactly one main per Breadbrich Engels instance. |
| **Trigger** | The prefix that wakes the agent in a non-main group. Default is `@Breadbrich Engels` (case-insensitive), set by `ASSISTANT_NAME`. Main does not require a trigger. |
| **JID** | Jabber ID, the channel-independent unique identifier for a chat (`tg:123456` for Telegram, `1234567890@s.whatsapp.net` for WhatsApp, slack channel id for Slack, etc.). |
| **KB** | Knowledge Base. The markdown tree mounted at `groups/<name>/context/` containing people, tasks, events, artifacts, projects, calendar entries, and so on. The KB is the canonical organizational memory; the SQLite database is the canonical system memory. |
| **kb-ui** | The Express web app at `kb-ui/server.mjs`, served on port 8080 and tunneled through Cloudflare to `kb.example.com`. Renders the KB and exposes dashboards (Projects, Admin). |
| **Container skill** | A directory under `container/skills/` mounted into every agent container at runtime. Examples: `agent-browser`, `slack-formatting`, `capabilities`. These shape *agent* behavior. |
| **Skill** | One of four extension types. Feature skills are merged git branches; utility skills ship code; operational skills ship only instructions; container skills ship runtime behaviors. See §11. |
| **Rule** | A markdown file in `rules/<category>/` describing behavior the system enforces. Rules are authoritative; code enforces rules, never the other way around. |
| **Routing rules** | The YAML at `docs/architecture/routing-rules.yaml`. Decides how each classified message is handled. |
| **IPC** | Filesystem-based inter-process channel between containers and the host orchestrator. Containers write JSON files into a watched fifo/dir; the host parses and dispatches them. See `src/ipc.ts`. |
| **the central orchestrator** | An emerging architecture in `BREADBRICH-ORCHESTRATION.md` (draft) where the host orchestrator centralizes reasoning and containers become thin forwarders. Not yet the production reality across the board. |
| **Observer / Reflector / Curator** | Three background "dreaming" jobs that watch chats and consolidate facts into the KB. Observer extracts, Reflector compresses, Curator archives. |
| **OneCLI Agent Vault** | A credential proxy that injects API keys into agent traffic without exposing them inside containers. Containers never see real secrets. |
| **Mount allowlist** | An external JSON file (`~/.config/breadbrich/mount-allowlist.json`) that blocks sensitive paths (`.ssh`, `.gnupg`, `.aws`, etc.) from being mounted into any container regardless of group config. |

---

## 4. The orchestrator and the container

Breadbrich Engels has two concentric runtimes. Both are needed.

### 4.1 The orchestrator (host)

A single Node.js process started by systemd (Linux) or launchd (macOS). The launchd plist is `launchd/com.nanoclaw.plist`; the systemd service is `breadbrich.service`.

Top-level source layout:

| Path | Role |
|---|---|
| `src/index.ts` | Main entry; sets up channels, opens DB, runs the 2-second poll loop. |
| `src/config.ts` | Constants: `ASSISTANT_NAME`, `POLL_INTERVAL`, `CONTAINER_TIMEOUT`, `MAX_CONCURRENT_CONTAINERS`. |
| `src/db.ts` | SQLite open + table init (see §7). |
| `src/channels/` | One file per channel + a registry that self-registers at startup. |
| `src/router.ts` | Message normalization, trigger matching, outbound formatting. |
| `src/permissions.ts` | RBAC: sender → role; gate for cross-channel sends and KB visibility. |
| `src/container-runner.ts` | Builds the `docker run`/`container run` argv: mounts, env, entrypoint. |
| `src/container-runtime.ts` | Lifecycle: spawn, watch, time out, GC orphans. |
| `src/group-queue.ts` | Per-group serial queue plus a global concurrency cap. |
| `src/task-scheduler.ts` | Polls `scheduled_tasks` every 60 seconds, spawns one container per due task. |
| `src/ipc.ts` | Watches the IPC fifo/dir, dispatches container requests to handlers (create_task, send_message, expense_request, safe_payout_request, etc.). |
| `src/credential-proxy.ts` | Bridges OneCLI Agent Vault into agent traffic. |
| `src/mount-security.ts` | Validates mount paths against the external allowlist. |
| `kb-ui/server.mjs` | Express app serving the KB and the Projects/Admin dashboards (separate `breadbrich-kb` service). |
| `setup/` | First-run installer (deps, channel auth, group registration, service install). |
| `container/agent-runner/` | Code that runs *inside* the agent container (entry, IPC client). |
| `container/skills/` | Runtime skills mounted into every container. |
| `groups/<name>/` | Per-group state: `CLAUDE.md`, `context/` KB, `logs/`. Stateful, not deployed by PR. |
| `store/` | SQLite database files. Stateful, not deployed by PR. |
| `data/` | Sessions, IPC fifos, env-dir. Stateful, not deployed by PR. |

### 4.2 The container (guest)

For every reply or scheduled job, Breadbrich Engels spawns a fresh container. Image: `nanoclaw-agent:latest` (built by `container/build.sh`). Runtime: Docker by default; can be switched to Apple Container on macOS via the `/convert-to-apple-container` skill.

What the container has:

- A non-root `node` user (uid 1000).
- The Claude Agent SDK and the agent-runner entrypoint.
- The `container/skills/` directory mounted at `/home/node/.claude/skills/`.
- The invoking group's folder mounted at `/workspace/group/`.
- The global folder (`groups/global/`) mounted at `/workspace/global/` (read-only for non-main; read-write for main).
- For the main group: the store directory mounted read-write for direct SQLite access.
- An MCP stdio bridge to the host (`ipc-mcp-stdio.ts`) so the agent can ask the host to "send a message," "create a task," "create an event," "create an expense," etc.

What the container does **not** have:

- Direct network access to credential sources. API keys arrive via the OneCLI proxy gateway.
- Visibility into other groups' folders.
- `.ssh`, `.gnupg`, `.aws`, `.kube`, `.docker`, `credentials`, `.env`, `.netrc`, or any path on the mount allowlist's deny list.

A container lifecycle:

```
spawn → run agent loop (tools → IPC → tools → ...) → reach turn end → exit (--rm) → GC any orphans
```

Containers die when the agent emits a non-tool turn end, when `CONTAINER_TIMEOUT` (default 30 min) elapses, or when the orchestrator restarts.

---

## 5. How a single message flows, end to end

Take a concrete case: a member of `slack_main` types `@Breadbrich Engels please file a $40 expense for team snacks`.

1. **Slack listener** (`src/channels/slack.ts`) receives the message via Socket Mode and writes a row to the `messages` table with `chat_jid`, `sender`, `content`, `timestamp`, `thread_id`.
2. **Message loop** (`src/index.ts`) polls every 2 seconds for messages newer than the `router_state` cursor for `slack_main`.
3. **Trigger check** (`src/router.ts`) — non-main group, so the leading `@Breadbrich Engels` (case-insensitive) is required. The trigger matches; the message is queued for `slack_main`.
4. **Group queue** (`src/group-queue.ts`) serializes per-group invocations and applies the global concurrency cap (default 5).
5. **Identity resolution** (`src/permissions.ts`) — the sender's Slack user id is looked up in `user_identities` and mapped to a KB person slug (e.g. `jane-doe`). If the sender is unknown (not in the allowlist), they get no privileged access — read-only on open docs.
6. **Container spawn** (`src/container-runner.ts`) — builds the `docker run` (or `container run`) command, mounting `groups/slack_main/`, `groups/global/`, `store/` (main only), and the container skills. Resumes the SDK session for `slack_main` from `data/sessions/slack_main/.claude/`.
7. **Agent loop** — the Claude Agent SDK starts. The agent reads the group's `CLAUDE.md`, any relevant KB documents, the available tools (including the IPC tool for `request_expense`), and the user's message.
8. **Classifier (when present)** — a Haiku pre-pass classifies the request type (`expense_request` here) and confidence. Per `routing-rules.yaml`, casual requests can be short-circuited to emoji reactions; substantive requests proceed.
9. **Tool call** — the agent calls `request_expense(amount_cents=4000, description="team snacks", category="food")` via MCP, which the IPC stdio bridge serializes to a JSON file in the watched IPC directory.
10. **IPC dispatch** (`src/ipc.ts`) — host process reads the JSON, validates that the sender is authorized to file expenses, resolves them to a KB user, writes the row into `expenses`, and emits a result.
11. **Post-hooks** (per routing rule) — e.g. an approval-needed DM is sent to a finance approver; `update_memory_pointer_index` lets the Reflector know the KB has changed.
12. **Reply** — the agent formats a confirmation. `src/router.ts` converts Markdown to Slack mrkdwn (via the `channel-formatting` container skill / host helper). The Slack channel handler posts the reply.
13. **Turn end** — the agent emits a non-tool turn end. The container exits. The orchestrator advances the message cursor in `router_state` (after success — per the deploy memory, advancing before confirmation has caused message loss; the current fix is to advance only on acknowledgement).
14. **Dreaming loop** — eventually, the Observer extracts the expense as a fact, the Reflector compresses overlapping observations, and the Curator archives the fact into `groups/slack_main/context/`.

That sequence is invariant across channels. The only thing that changes between Slack and Telegram and Gmail is the channel handler at step 1 and the outbound formatting at step 12.

---

## 6. Two memory systems: markdown KB and SQLite

Breadbrich Engels maintains state in two complementary stores. Understanding the split is essential.

### 6.1 The markdown KB

Located at `groups/<name>/context/<category>/<doc>.md`. Categories include `people/`, `tasks/`, `calendar/`, `artifacts/`, and `projects/`. Files have a YAML frontmatter:

```markdown
---
visibility: open
created_by: jane-doe
tags: [engineering, breadbrich]
---

# TASK-041 — Restore KB access for non-main groups

...
```

The KB is what the agent reads at the start of a turn (a curated subset, not the whole tree) and what humans browse via `kb-ui`. Agents both read and write KB files using the SDK's filesystem tools, subject to the visibility frontmatter and role checks (see `KB-ACCESS-CONTROL.md`).

Why markdown?

- Diffable in git.
- Editable by humans without a UI.
- Easy to render in the dashboard.
- The visibility field is human-legible.

### 6.2 The SQLite database

Located at `store/messages.db`. Around a dozen tables (see §7). Contains channel-level state: messages, chats, registered groups, sessions, scheduled tasks, run logs, identity mappings, router cursors, and application data (expenses, meeting summaries).

Why SQLite?

- One file. No daemon.
- Transactional. Survives crashes.
- Fast enough for the orchestrator's polling pattern.
- Backed up as part of the nightly snapshot.

### 6.3 The rule of thumb

| If the data is… | Store it in… |
|---|---|
| Organizational knowledge that a human or agent reads or edits as prose | Markdown KB |
| System state the orchestrator polls or updates non-interactively | SQLite |
| Both | Markdown KB is canonical; the SQLite row mirrors it for indexing |

Tasks are an interesting hybrid: the *scheduled-task* row in SQLite is the executable record; the *task tracking* document at `context/tasks/TASK-NNN.md` is the human-readable record. Breadbrich Engels keeps them in sync; humans edit the markdown.

---

## 7. Data schema overview

This section gives you a one-screen summary of what's in `store/messages.db`. The exhaustive column-level reference is `schema/tables.md`; consult it when you actually need to query.

### 7.1 Messaging core

| Table | What it stores | Notes |
|---|---|---|
| `chats` | One row per known chat across all channels | Keyed by JID; `channel`, `is_group`, `name`, `last_message_time` |
| `messages` | Full message history with threading | Composite PK `(id, chat_jid)`; reply / thread metadata; `is_from_me`, `is_bot_message` |
| `registered_groups` | Which chats Breadbrich Engels actively serves | Trigger pattern, container_config JSON, `is_main` |
| `sessions` | Persisted SDK session id per group | Allows resume across orchestrator restarts |
| `router_state` | KV cursor table for the polling router | Tracks last-processed timestamp per group |

### 7.2 Scheduling

| Table | What it stores | Notes |
|---|---|---|
| `scheduled_tasks` | Cron / interval / once jobs | Has either a `prompt` (Claude task) or a `script` (shell), `next_run` indexed |
| `task_run_logs` | One row per execution | `status`, `duration_ms`, `result`, `error` |

### 7.3 Identity

| Table | What it stores | Notes |
|---|---|---|
| `user_identities` | `(platform_id, platform) → kb_person` | One row per (slack id, telegram id, discord id, etc.) for each person. Presence here = "allowlisted user" under the flat permission model. |

### 7.4 Application support

| Table | What it stores |
|---|---|
| `app_users` | People-as-app-users (a row per assignable person) |

### 7.5 Finance

| Table | What it stores |
|---|---|
| `expenses` | Full lifecycle of an expense request: prospective vs retrospective, approval, receipt, reimbursement |

### 7.6 Documentation

| Table | What it stores |
|---|---|
| `meeting_summaries` | Processed meeting transcripts + action items + extracted entities (events, people, tasks, documents) |

### 7.7 What is *not* in the database

A few things people expect to find in SQL but are actually stored as markdown documents:

| Not a table | Lives in |
|---|---|
| **Projects** | `groups/<name>/context/projects/PROJECT-*.md`. The `/projects` dashboard in `kb-ui/server.mjs` reads these files directly. |
| **People** | `groups/<name>/context/people/<name>.md`. (`user_identities` only maps platform ids to person *names*; the rich profile lives in the markdown.) |
| **Tasks (human view)** | `groups/<name>/context/tasks/TASK-NNN.md`. (`scheduled_tasks` is the *executable* layer.) |
| **Expenses** | `groups/<name>/context/artifacts/` records, plus the `expenses` table (see `docs/expense-flows.md`). On-chain payouts use the separate `safe_payouts` table. |

For an authoritative list of every column and index, read `schema/tables.md`.

---

## 8. Workflow primitives: tasks, projects, events, processes, templates

Breadbrich Engels builds organizational workflows out of five primitives. They are distinct concepts; mixing them up is the single most common source of confusion.

### 8.1 Tasks

There are **two kinds** of "task" in Breadbrich Engels and they are not the same thing.

**(a) Scheduled tasks** are rows in the `scheduled_tasks` table. They are Claude prompts or shell scripts that the scheduler runs at a `next_run` time, on a cron expression, on an interval, or once. They produce a `task_run_logs` row each time. They are how Breadbrich Engels does background work: daily reports, the Observer's 15-minute pass, the Reflector's nightly summarization, the Curator's weekly archival, periodic calendar syncs.

Created via the IPC `create_task` handler (from inside an agent container) or by direct SQL on the main group. Lifecycle: `active → paused → done` (or stays `active` for recurring tasks).

**(b) Tracked tasks** are markdown documents at `context/tasks/TASK-NNN.md`. They are the human/agent-readable record of work. They have ids like `TASK-041`, a status (`open`, `in_progress`, `done`, `blocked`, `wontfix`), a priority, an owner, and a body. The kb-ui `/category/tasks` swim-lane view groups them by status × priority. Agents can create and update these via the IPC handlers.

A given piece of work might be tracked as both: a scheduled-task row that polls something and a tracked-task document that records the human-facing problem the polling is solving.

### 8.2 Projects

A project is a markdown document at `context/projects/PROJECT-*.md`. It has a title, status, and (typically) tags linking it to people, events, expenses, and tracked tasks. The kb-ui `/projects` dashboard scans this directory at request time and renders a Kanban board.

There is **no `projects` table in SQLite**. The relational structure (project ↔ tasks ↔ events) is expressed via the `project:` frontmatter / link fields on the child documents, and resolved at read time by kb-ui. If you want to add programmatic queries against projects, do it by parsing the markdown — do not add a table without a migration plan, because the markdown is canonical.

### 8.3 Events

An event is a markdown document at `context/calendar/<date>-<slug>.md` with an `EVT-NNN` id, used for narrative context (program, location, prep notes) and for `linked_tasks` / `linked_events` cross-references. There is **no `events` table in SQLite** and no Google Calendar sync — events are purely KB markdown, canonical and resolved at read time.

### 8.4 Processes

A "process" is a documented multi-step workflow that crosses the rule layer, the IPC layer, the database layer, and the KB. It is not a single table or a single file — it is a **vertical slice** through the system.

Each process follows the seven-layer template described in `docs/workflows/`:

| Layer | What it is | Where it lives |
|---|---|---|
| 1 | Database schema | `schema/tables.md` (e.g. `expenses`, `safe_payouts`) |
| 2 | Container MCP tools | `container/skills/<process>/` (e.g. `expense-helper` → `request_expense`) |
| 3 | Host IPC handlers | `src/ipc.ts` case blocks (e.g. `expense_request`) |
| 4 | Agent rules | `rules/<category>/` (authorization, priority, notifications) |
| 5 | KB documents | `groups/<name>/context/<category>/<id>.md` |
| 6 | Agent instructions | Appended to `groups/<name>/CLAUDE.md` or rule docs |
| 7 | Container skill (optional) | `container/skills/<process>/` for deeper logic |

The reference process specified today:

- **Expense flows** — `docs/expense-flows.md`. Prospective request → approval → receipt → reimbursement; retrospective submission → approval → reimbursement.

When you build a new process, copy the template, fill in all seven layers, and update the routing rules so the classifier sends matching requests to your handler.

### 8.5 Templates

"Template" means two related things:

- **Workflow spec templates** (`docs/workflows/workflow-spec-template-v1.md`) — the 7-layer scaffold you fill in when creating a new process.
- **Container skills** (`container/skills/<name>/`) — reusable behavioral templates loaded into every container. The `agent-browser` skill is a template for "how to use a browser"; `slack-formatting` is a template for "how to format text for Slack"; `capabilities` is a template for "what commands you can run."

Templates are read by the agent at the top of every turn; they do not have an instantiation lifecycle.

---

## 9. Rules: where behavior lives

Open `rules/INDEX.md` for the canonical index. The directory structure is:

```
rules/
├── INDEX.md
├── access-control/      # who can see and do what
├── finance/             # expense approval, reimbursement, budget tags
├── identity/            # user resolution, allowlist, platform mapping
├── knowledge-base/      # KB structure, document format, task management
├── messaging/           # channel formatting, cross-channel send authority
├── scheduling/          # cron tasks, API credit conservation, scripts
└── transcripts/         # meeting transcript processing, action item extraction
```

The principle: **the rule file is the source of truth**. If you want to change how expense approval works, edit `rules/finance/approval.md` and *then* update `src/ipc.ts` and the container skill to match. The rule documents what the system promises; the code is supposed to deliver on the promise.

When two pieces of code disagree (host says one thing, container skill says another, kb-ui says a third), the resolution order is:

1. The rule file in `rules/`.
2. The canonical doc (`SPEC.md`, `schema/tables.md`, workflow doc).
3. The host orchestrator (`src/`).
4. Container skills.
5. kb-ui.

Anything below #1 that contradicts a rule is a bug.

---

## 10. Routing: the YAML that decides who handles what

`docs/architecture/routing-rules.yaml` is the dispatcher. It defines:

- **Identity groups** — `allowlisted` (the `people/` allowlist — full access) and `system`; unregistered senders are `any` (read-only on open docs). There are no admin/coordinator/guest tiers — the access model is flat.
- **Request types** — about a dozen, including `task_management`, `event_logging`, `code_operations`, `financial_tracking`, `information_retrieval`, `credential_access`, `cross_channel_delegation`, `reminder_scheduling`, `content_generation`, `transcript_processing`, `people_management`, `meta_bot_management`, `casual_social`.
- **Urgency levels** — `immediate`, `normal`, `low`.
- **Rules (top-down)** — each with `match` predicates (request_type, action, classifier confidence, sender role), a `route` (typically `big_breadbrich` or `reaction_only`), an `auth` clause (which identity groups are allowed), a `share_back` list (what fields the response includes), and `post_hooks`.
- **Visibility filters** — applied to the share_back payload so private/restricted docs are not leaked back to senders who can't see them.
- **Rate limits** — per chat, per sender, global.

The rule order matters: the classifier picks the first matching rule. The fall-through is `flag_for_rule_review` so any unmatched request is logged for a maintainer to triage.

Worked example. For `@Breadbrich Engels delete TASK-005 it's a duplicate`:

1. Classifier: `request_type=task_management, action=delete, confidence=0.9`.
2. Matching rule (`task_delete`): `auth: [admin, owner]`. The sender is `jane-doe` (admin), so the request is allowed.
3. Route: `big_breadbrich`. The agent receives the request with the classification, calls the delete IPC tool.
4. `share_back: [deleted_task_id, prior_state]`. The agent confirms the deletion and includes the recovered prior state in the reply for safety.
5. `post_hooks: [update_memory_pointer_index, notify_owner_if_assigned]`. The KB pointer is refreshed; the previous owner is DM'd.

When you add a new IPC handler, you almost always also add a routing rule.

---

## 11. Skills and extensibility

Breadbrich Engels has four skill types. Knowing which type you want is the first decision when adding to the system.

### 11.1 Feature skills (branch-merged)

Add a capability that touches multiple files (a new channel, a new integration, a new top-level workflow). Live on a `skill/<name>` git branch. The user invokes them with `/<name>` (e.g. `/add-slack`, `/add-gmail`, `/add-discord`). The skill's `SKILL.md` is on `main` at `.claude/skills/<name>/SKILL.md` and its first step is `git merge skill/<name>`.

The currently-published feature skills include channels (`add-slack`, `add-telegram`, `add-whatsapp`, `add-discord`, `add-gmail`, `add-emacs`), tools (`add-pdf-reader`, `add-image-vision`, `add-voice-transcription`, `add-reactions`, `add-ollama-tool`, `add-parallel`, `x-integration`), runtime variants (`convert-to-apple-container`, `use-local-whisper`, `use-native-credential-proxy`, `add-telegram-swarm`), CLI tools (`claw`, `add-macos-statusbar`), and meta-features (`add-compact`, `channel-formatting`, `init-onecli`).

Branch merges scale because the marketplace pipeline re-merges `main` into every `skill/*` branch on every push and resolves conflicts with Claude.

### 11.2 Utility skills (self-contained code)

Ship a tool that does not modify the orchestrator. Code lives in the skill directory itself (often a `scripts/` subdir referenced via `${CLAUDE_SKILL_DIR}` in `SKILL.md`). Example: `/claw` (the CLI for running an agent container from a terminal).

### 11.3 Operational skills (instructions only)

Pure documentation, always present on `main`. Examples: `/setup`, `/customize`, `/update-breadbrich`, `/update-skills`, `/safe-ingest`, `/ship-feature`, `/redeploy-breadbrich`, `/breadbrich-test`, `/breadbrich-push`. These are how operators do things — they encode a procedure without changing any code.

### 11.4 Container skills (runtime behaviors)

Files under `container/skills/<name>/` mounted into every agent container. Examples:

- `agent-browser` — how to use a Playwright/Chromium browser.
- `slack-formatting` — how to convert Markdown to Slack mrkdwn.
- `capabilities` — what commands the agent can run on the host via IPC.
- `<process>/` — domain-specific cheat sheets (e.g. maintenance priority ladder).

These shape Claude's *in-container behavior*. Adding a container skill is the right move when you want the agent to behave differently in every group, not just one.

### 11.5 SKILL.md format

```markdown
---
name: my-skill
description: One sentence on what this skill does and when to use it.
---

Instructions go here.
```

Hard constraints from `CONTRIBUTING.md`:

- Under 500 lines (move detail to separate reference files).
- `name`: lowercase alphanumeric + hyphens, ≤ 64 chars.
- `description` is required; Claude uses it to decide when to invoke.
- Put code in separate files, not inline.

---

## 12. Deploy, ops, and recovery

### 12.1 Local development

```bash
npm run dev          # tsx src/index.ts with hot reload
./container/build.sh # rebuild the agent container after src changes
npm run typecheck    # tsc --noEmit
npm test             # vitest
npm run lint         # eslint
```

### 12.2 Production deploy

Breadbrich Engels ships via `scripts/deploy.sh` (local side) and `/opt/breadbrich-backups/safe-deploy.sh` (droplet side). The flow:

1. rsync source to `/tmp/breadbrich-staging/` on the droplet, excluding stateful paths (`.env`, `store/`, `data/`, `groups/`, `.git`, `node_modules`, `dist`).
2. Take a pre-deploy snapshot of the live install (retention: 10 pre-deploy, 7 daily, 4 weekly, 20 manual).
3. rsync staging → live; `npm install` if package files changed; `npm run build` if TS changed; `./container/build.sh` if container sources changed.
4. `systemctl restart breadbrich` + `systemctl restart breadbrich-kb` if KB-UI changed.
5. Health-check by polling service status for ~24 seconds and grepping the journal for `Credential proxy started`.
6. Rollback automatically on any failure: stop, extract pre-deploy tarball, `npm install`, restart.

Known fragility: when the queue is busy, `journalctl -n 50` can roll the `Credential proxy started` line off before the health check sees it. Retry once the queue drains; do not assume the deploy failed.

Hard rule: **push → merge → deploy**. Never deploy code that is not on `main`. Never rsync individual files. Never restart the service manually outside the deploy script. The pre-deploy snapshot and rollback can clobber any manual changes you sync mid-deploy.

### 12.3 What does and does not get deployed

| Path | Deployed? |
|---|---|
| `src/`, `setup/`, `container/`, `kb-ui/`, `scripts/`, `docs/`, `schema/`, `rules/`, `.claude/`, `package.json`, `package-lock.json`, `tsconfig.json` | Yes |
| `.env`, `store/`, `data/`, `groups/`, `kb-ui/users.json`, `repo-tokens/` | No — stateful, preserved on the droplet |
| `node_modules/`, `dist/`, container image | No — regenerated on the droplet |

The KB lives in `groups/`. Because `groups/` is stateful and not deployed, the local copy will lag the droplet copy. If you need ground-truth KB content, look on the droplet or pull a snapshot down.

### 12.4 Backups

Run by `backup.sh` on the droplet:

| Tier | When | Retention |
|---|---|---|
| Daily | 03:30 UTC | 7 |
| Weekly | Sunday 04:00 UTC | 4 |
| Pre-deploy | before each deploy | 10 |
| Manual | on demand | 20 |

A snapshot is roughly 21 MB and includes `.env`, `messages.db`, sessions, the full KB markdown tree, and `kb-ui/users.json`. See `docs/architecture/STATE-RECOVERY-MAP.md` for what recovers from where, with RTOs.

### 12.5 Logs

| File | What's in it |
|---|---|
| `logs/breadbrich.log` | Orchestrator stdout |
| `logs/breadbrich.error.log` | Orchestrator stderr |
| `groups/<name>/logs/container-*.log` | Per-container agent transcripts |
| `journalctl -u breadbrich.service` | Service status, health-check lines |

Quick triage commands:

```bash
launchctl list | grep breadbrich                       # macOS: is it running?
systemctl status breadbrich                            # Linux: is it running?
grep -E 'ERROR|WARN' logs/breadbrich.log | tail -20    # recent errors
grep groupCount logs/breadbrich.log | tail -3          # last few startup summaries
```

### 12.6 Deploy authorization

Any allowlisted user can trigger a deploy via the `/redeploy-breadbrich` skill or by running `safe-deploy.sh` directly on the droplet. There are no per-role carve-outs.

---

## 13. End-to-end walkthroughs

### 13.1 "I want to ask Breadbrich Engels something from Slack"

1. Join the `slack_main` workspace.
2. In the channel, type `@Breadbrich Engels what events are on the calendar this week?`
3. Breadbrich Engels replies in-thread with a list of `events` rows for the next seven days, filtered to events whose visibility you can see.

If you're in a non-main Slack channel, prefix is still `@Breadbrich Engels`. Without the prefix, Breadbrich Engels stays quiet.

### 13.2 "I want to add a task"

From any chat:

```
@Breadbrich Engels add a task: write the migration runbook for the fresh-repo move; priority high; owner ops
```

The agent:

1. Classifies as `task_management.create`.
2. Generates an ID (`TASK-NNN` with N = next available).
3. Writes `groups/slack_main/context/tasks/TASK-NNN.md` with the relevant frontmatter (`status: open`, `priority: high`, `owner: ops`).
4. Replies with the new task id.

You can edit the markdown directly, or drag the card in the kb-ui swim-lane.

### 13.3 "I want to file a reimbursement"

```
@Breadbrich Engels I spent $40 on lunch for the working group — receipt attached
```

The agent:

1. Classifies as `financial_tracking`.
2. Runs the expense flow (`docs/expense-flows.md`): captures amount, description, and receipt, and files an expense record.
3. The host writes the markdown record and routes it for approval.
4. Replies with the expense id.

Any allowlisted user can check status or approve per the expense-flows doc.

### 13.4 "I want to request reimbursement for catering"

Prospective (preferred):

```
@Breadbrich Engels I need $450 for catering for the Friday workshop
```

Flow:

1. `financial_tracking` classification.
2. Agent calls `create_expense` with the request as `pending_approval`.
3. Any other allowlisted user (the requester cannot approve their own expense) gets a DM. They reply `approve exp-XYZ at $400` to modify the amount.
4. Status moves to `receipt_pending`.
5. After the workshop, the requester submits a receipt: `@Breadbrich Engels here's the receipt for exp-XYZ, actual $447`. Status → `receipt_submitted`.
6. Finance reimburses: `@Breadbrich Engels reimbursed exp-XYZ via venmo`. Status → `reimbursed`.

Full lifecycle and retrospective variant: `docs/expense-flows.md`.

### 13.5 "I want to add a calendar event"

```
@Breadbrich Engels add an event: AI safety reading group, Thursday 7pm, the School, host: nina
```

The agent:

1. Writes `groups/slack_main/context/calendar/2026-05-21-ai-safety-reading.md` with an `EVT-NNN` id and frontmatter (date, location, host: nina).
2. Cross-links any related tasks via `linked_tasks` / `linked_events` frontmatter.
3. Replies with the event id and a confirmation.

### 13.6 "I want to schedule a daily report"

From any registered group (any allowlisted user):

```
@Breadbrich Engels schedule a daily 9am report of open MRs and unresolved expenses
```

The agent creates a `scheduled_tasks` row with `schedule_type=cron`, `schedule_value="0 9 * * *"`, and a prompt that reads the relevant tables and posts a summary.

### 13.7 "I want to add a new channel (Discord)"

Inside Claude Code, in the breadbrich repo:

```
/add-discord
```

The skill walks you through: merging `skill/discord`, registering the bot, adding env vars, registering the chat in SQLite, rebuilding the container, restarting. After that, Discord is just another channel.

### 13.8 "I want to add a new workflow (e.g. supplies-ordering)"

1. Copy `docs/workflows/workflow-spec-template-v1.md` → `docs/workflows/supplies.md`.
2. Fill in the seven layers: table schema (Layer 1), MCP tool defs (Layer 2), IPC handler (Layer 3), rule file in `rules/finance/` or a new `rules/supplies/` (Layer 4), KB doc structure (Layer 5), agent instructions in `groups/global/CLAUDE.md` (Layer 6), optional container skill (Layer 7).
3. Add a routing rule to `docs/architecture/routing-rules.yaml` so the classifier sends matching messages to your new handler.
4. Write the migration to add the new SQL table (see `docs/architecture/MIGRATION-RUNBOOK.md`).
5. Test on staging, ship via `/ship-feature` or `/redeploy-breadbrich`.

---

## 14. Adding to the system: a contributor's checklist

When you're about to change Breadbrich Engels, walk this list:

- [ ] Is the change a rule, a code change, both, or a workflow (all of the above)? Start with the rule.
- [ ] If a new channel or integration: feature skill on a `skill/<name>` branch.
- [ ] If a new domain workflow: copy the workflow spec template, fill all 7 layers, add a routing rule.
- [ ] If a behavioral tweak (e.g. classifier behavior, formatting): rules first, then container skill, then code.
- [ ] If a new SQL table: schema doc, migration script, runbook entry.
- [ ] Tests: unit tests (vitest), staging smoke test (`/breadbrich-test`).
- [ ] `npm run build && npm run typecheck && npm test` all green.
- [ ] PR off `main`. Get review. Merge.
- [ ] Deploy with `/ship-feature` or `safe-deploy.sh` — never manual rsync.
- [ ] If you changed `groups/` content: remember that `groups/` is stateful. You almost certainly want to either (a) propose a change to `groups/global/CLAUDE.md` which *does* deploy, or (b) commit specific KB updates to the droplet through the kb-ui or a separate sync flow.

If the change is risky or controversial: leave a note in `groups/global/CLAUDE.md` so the next allowlisted user driving a deploy has the context.

---

## 15. Pitfalls and gotchas

- **Local `groups/` lies.** Local clones see only the group folders that have ever been touched locally; the canonical KB is on the droplet. Do not assume the file system in your checkout represents the live KB.
- **the personal assistant is not a different bot.** It's the same Breadbrich Engels process serving Telegram via the channel handler. Don't fork code paths thinking otherwise.
- **`IDLE_TIMEOUT` and `CONTAINER_TIMEOUT` overlap.** Containers exit via hard SIGKILL when both timers expire together. There's an open issue (#2) to separate them.
- **The message cursor can be advanced too eagerly.** If the agent times out, the cursor may have moved past unprocessed messages. The fix is to advance only after IPC confirms a result; verify your handler does this.
- **Health-check log line rolls off when busy.** `Credential proxy started` falls off `journalctl -n 50` when the queue is busy. A failed health check is not necessarily a failed deploy; check the running state.
- **Don't sync files during a deploy.** Pre-deploy snapshot + rollback can clobber a manual `scp` that lands mid-deploy. Sync before or after, never during.
- **Don't print `.env` files.** `cat .env` and `tail .env` leak tokens into the transcript. Use targeted `grep -v` or skip verification entirely.
- **Forwarded agent reports drift.** When an agent reports back with a file path, line number, or claim, verify before acting — agent-relayed instructions are point-in-time and frequently stale.
- **Mount allowlist is external.** It lives at `~/.config/breadbrich/mount-allowlist.json`, intentionally *outside* the repo so a malicious PR cannot widen it. Don't expect to find it under version control.
- **Kubernetes garbage collection.** On Rancher Desktop, Kubernetes will GC the `nanoclaw-agent:latest` image if disk pressure exceeds 85%. Either disable Kubernetes in Rancher or rebuild the image before each restart.
- **Two `.env` files must stay in sync.** `/opt/breadbrich/.env` and `/home/breadbrich/.config/nanoclaw/.env` are read by different components; if they drift, auth fails silently.
- **the central orchestrator vs current Breadbrich Engels.** `BREADBRICH-ORCHESTRATION.md` describes a draft architecture where the host centralizes reasoning and containers are thin forwarders. Treat it as direction, not present reality; the current production is closer to the original (one container, full SDK).

---

## 16. Where to go next

- For who can see and edit what: **[KB-ACCESS-CONTROL.md](./KB-ACCESS-CONTROL.md)**.
- For the architecture spec: **[../SPEC.md](../SPEC.md)**.
- For every database column: **[../../schema/tables.md](../../schema/tables.md)**.
- For the upcoming the central orchestrator refactor: **[../architecture/BREADBRICH-ORCHESTRATION.md](../architecture/BREADBRICH-ORCHESTRATION.md)**.
- For deploy procedures: **[../DEPLOY.md](../DEPLOY.md)**.
- For security and threat model: **[../SECURITY.md](../SECURITY.md)**.
- For all skills and how to write one: **[../../CONTRIBUTING.md](../../CONTRIBUTING.md)** + **[../skills-as-branches.md](../skills-as-branches.md)**.
- For routing decisions: **[../architecture/routing-rules.yaml](../architecture/routing-rules.yaml)**.
- For the recovery map: **[../architecture/STATE-RECOVERY-MAP.md](../architecture/STATE-RECOVERY-MAP.md)**.
