# Breadbrich Engels Orchestration Architecture

**Status:** Draft for review
**Last updated:** 2026-04-21
**Audience:** anyone modifying Breadbrich Engels's core — channels, IPC, orchestrator, containers

## Purpose

Define the canonical model for how Breadbrich Engels's three components — the central orchestrator (orchestrator), Breadbrich Engels Slack bot, Breadbrich Engels Telegram bot — work together, share context, and serve requests. This document is the single source of truth for the system's topology. Code must conform to it; if it doesn't, one of them is wrong and must be reconciled.

## The three components

| Component | Process | Role | Feature parity? |
|---|---|---|---|
| **the central orchestrator** | `breadbrich.service` — the long-running Node.js orchestrator on the droplet | Authoritative brain. Owns SDK sessions per chat. Has DB write access. Runs the routing-rule engine. Runs dreaming jobs (Observer/Reflector/Curator). Source of truth for all KB reads/writes. | Full |
| **Breadbrich Engels Slack bot** | Slack channel handler inside the same `breadbrich.service` process + per-group thin-forwarder containers | Receives Slack events → forwards to the central orchestrator → relays response. No local reasoning. | Thin — forwarding + response relay only |
| **Breadbrich Engels Telegram bot** (`@your_bot_username`) | Telegram channel handler inside the same `breadbrich.service` process + per-group thin-forwarder containers | Receives TG events → forwards to the central orchestrator → relays response. No local reasoning. | Thin — forwarding + response relay only |

**Physical deployment:** one Node.js process (`breadbrich.service`) hosts the channel listeners, the IPC dispatcher, the router, the SDK client, and the dreaming scheduler. Per-group containers are still spawned for isolation but they become thin forwarders — no direct Claude API calls from a container.

## Core principles

1. **One brain.** All reasoning happens in the central orchestrator. Containers forward, they don't think.
2. **Pull, not push.** Thin clients do not keep the central orchestrator's state cached. When a message arrives, they send it to the central orchestrator; the central orchestrator pulls whatever context it needs.
3. **Per-chat sessions.** the central orchestrator maintains a separate Claude SDK session per `(group_folder, sender_identity)` so conversations stay coherent within a chat without leaking across chats.
4. **Rules are data.** Routing, privacy, and awareness-sharing live in `routing-rules.yaml` loaded at startup. Changing rules is a config change, not a code change.
5. **Append-only observations.** Observer extracts facts to `groups/{chat}/observations.md` as dated entries. Always-append preserves prompt cache and keeps auditability.
6. **Thin clients are replaceable.** Adding Discord, WhatsApp, or a new Telegram bot = writing a ~300 LOC adapter that conforms to the Big-Breadbrich Engels-facing IPC contract.

## Message flow — inbound

```
Telegram/Slack event arrives
  ↓
Channel handler (Grammy/Bolt) in breadbrich.service
  ├─ Stores message in SQLite (messages table)
  └─ Adds reaction ACK (👀 or thinking_face) if triggered
  ↓
Message loop picks up unprocessed messages (every 2s)
  ↓
For each message, GroupQueue schedules processing for its group
  ↓
Thin-forwarder container wakes (or is spawned if cold)
  ├─ Writes IPC request: type=forward_to_big_breadbrich, payload={message, sender, chat}
  └─ Waits for response file (bounded poll, ~5s typical)
  ↓
the central orchestrator IPC watcher picks up the forward request
  ├─ Looks up sender identity (user_identities table)
  ├─ Evaluates routing rules → { route: big_breadbrich | local | reject, ... }
  ├─ Calls classifier (Haiku) for request-type classification
  ├─ For actionable requests: loads context via MEMORY.md pointer index + relevant topic files
  ├─ Calls Claude SDK with per-chat session + context + tools
  └─ Writes response IPC file back to the forwarder
  ↓
Thin-forwarder relays response to channel handler
  ↓
Channel sends back via TG/Slack API + updates reactions to ✓
  ↓
(background) Observer pass queues the message for fact extraction
```

## Message flow — outbound (proactive, cross-channel)

the central orchestrator can initiate messages without an inbound trigger — e.g., reminders, escalations, cross-channel relays. Flow:

```
Trigger (scheduled task, cron, rule-fire, explicit directive)
  ↓
the central orchestrator decides target chat + message
  ↓
Checks routing rules for authorization (is this action allowed for this target?)
  ↓
Directly calls channel.sendMessage(target_jid, text) — no container involvement
  ↓
storeOutboundMessage() records it in messages table
```

Outbound does not go through thin-forwarders. They only handle inbound.

## Dreaming cycle

Three scheduled jobs run on the central orchestrator via the existing `scheduled_tasks` infrastructure:

### Observer (every 15 minutes, per chat)
- Model: Haiku (cheap, good at extraction)
- Reads new messages since last run for each chat
- Extracts: decisions, commitments, unresolved threads, user preferences, KB references mentioned
- Appends to `groups/{chat}/observations.md` as dated entries with severity marks and `range` pointers to source messages
- Always-append = stable cache prefix

### Reflector (2am daily)
- Model: Sonnet (stronger; needs to compress across many observations)
- For each chat, compresses observations older than 7 days into consolidated summaries
- Detects duplicates: tasks with near-identical titles, people mentioned under multiple names, events mentioned multiple times
- Flags duplicates to `reflector-queue.md` for human review before auto-merge
- Rebuilds `groups/{chat}/MEMORY.md` — a pointer-only index of: recent observations, active tasks, recent people mentions, topic file locations

### Curator (weekly, Sundays 3am)
- Tiers KB content by age: **hot** (≤7 days, always in context), **warm** (≤30 days, loaded on query), **cold** (>30 days, archived under `groups/{chat}/archive/`)
- Purges Observer entries that have been promoted into KB markdown
- Rebuilds `groups/{chat}/MEMORY.md` index
- Verifies DB integrity: `PRAGMA integrity_check`, backup rotation

**Failure modes for dreaming:** observer run failures are non-fatal and retried next tick. Reflector failures require human review of the queue. Curator never deletes — always archives.

## Per-chat session model

the central orchestrator maintains SDK sessions keyed by `(group_folder, sender_identity)` in the existing `sessions` table. When a message arrives:

1. Look up `user_identities` to resolve platform ID → KB person name
2. Look up `sessions[group_folder:sender_identity]` for existing session_id
3. If found, resume; otherwise create new session
4. Session persists in Claude SDK jsonl transcripts (existing path `data/sessions/{group}/.claude/...`)

Cross-session context never flows automatically. It flows only through:
- Routing rules that explicitly say "share X back to chat Y"
- the central orchestrator calls that query the KB (not session state)
- Observer/Reflector pulling into the KB, which any future session can see

## Privacy + RBAC

Three enforcement layers:

1. **Routing rules** (`routing-rules.yaml`) gate what requests are allowed from what sender identities in what chats. Evaluated before the SDK call.
2. **KB frontmatter `visibility:`** field (existing) — every markdown KB file declares `open | restricted | private`. the central orchestrator filters at read time before exposing content to a requester.
3. **`canModifyKbFile`** (existing, `src/ipc.ts:78-107`) — RBAC on KB writes. Admin/coordinator gates. Expanded to apply to Big-Breadbrich Engels-initiated writes as well.

Sender identity resolution (existing `user_identities` table) is load-bearing. A missing identity mapping = sender treated as unknown; request may be rejected depending on rule.

## Thin-forwarder container contract

Per-group containers no longer run Claude. Their job shrinks to:

1. Watch their IPC input dir for messages
2. Write `type=forward_to_big_breadbrich` request file
3. Poll for a `type=response` file (bounded, ~5s default, 30s max)
4. Write response to channel via the existing IPC message path

Container lifecycle is unchanged (IDLE_TIMEOUT=30min, spawn on message). The agent-runner source gets simpler: no Claude SDK init, no MCP tools (the central orchestrator has those now), just a forwarder loop. Existing MCP tools that operate on local data (e.g. `modify_kb_file` IPC) are not removed — they're invoked by the central orchestrator when it needs to act on a group's local KB, via the same IPC path but initiated from the orchestrator side.

## Classifier (cheap first-pass)

Every inbound message hits a Haiku classifier *before* the Sonnet SDK call. Classifier output:

```json
{
  "request_type": "task_management" | "event_logging" | ... | "casual_social",
  "urgency": "immediate" | "normal" | "low",
  "needs_big_breadbrich": true | false,
  "confidence": 0.0-1.0
}
```

If `needs_big_breadbrich=false` AND `request_type=casual_social`, respond with a reaction only (no SDK invocation). This is the cost gate that prevents every "hi Breadbrich Engels" from costing an Opus call.

## Data ownership

| Data | Owner | Who writes | Who reads |
|---|---|---|---|
| Messages (messages table) | the central orchestrator | Channel handlers (inbound), the central orchestrator (outbound) | the central orchestrator, KB UI |
| User identities | the central orchestrator | Admin + registration flow | the central orchestrator |
| Tasks (markdown KB) | the central orchestrator | the central orchestrator via IPC modify_kb_file | the central orchestrator |
| People (markdown KB) | the central orchestrator | Admin only via IPC modify_kb_file | the central orchestrator |
| Observations | Observer job | Observer (append only) | Reflector, the central orchestrator |
| MEMORY.md pointer index | Reflector + Curator | Reflector / Curator | the central orchestrator (always-loaded) |
| Routing rules YAML | Human (via PR) | Git commits only | the central orchestrator (loaded at startup) |
| Session transcripts | Claude SDK | SDK | the central orchestrator (session resume), drain job |
| Scheduled tasks | task-scheduler | Anyone via `schedule_task` | task-scheduler |

## What doesn't change

- **SQLite is still the message log and state store.** No migration needed.
- **Container isolation is preserved.** Thin forwarders run in containers with group-scoped mounts.
- **Credential proxy continues to gate API access.** the central orchestrator's own SDK calls use the same credential injection; containers no longer need it (no Claude calls).
- **KB markdown files remain the source of truth** for all group knowledge.
- **systemd + safe-deploy.sh remain the deploy path.**

## What does change

- **Per-group containers lose their Claude SDK** — they become forwarders.
- **the central orchestrator gains the Claude SDK** — new Anthropic client initialization, new session manager, new rule engine, new dreaming scheduler.
- **New MEMORY.md pointer-index pattern** per group; Curator maintains it.
- **Observer/Reflector/Curator** are new scheduled tasks.
- **`routing-rules.yaml`** is a new loaded config at startup.

## Open questions (tracked in MIGRATION-RUNBOOK)

- Routing rules edited by admins at runtime via kb-ui, or only via PR? (Default: PR only for v1)
- Should Observer run cross-chat or stay per-chat? (Default: per-chat for v1; cross-chat would break privacy)
- Context sharing across chats via rule match — opt-in per chat, or global rule matrix? (Default: global matrix with explicit overrides)
- Fallback if the central orchestrator is down — do channels still store inbound and replay? (Default: yes, breadbrich's current message loop continues)

## Reference

- `DATA-INVENTORY.md` — every state surface
- `STATE-RECOVERY-MAP.md` — disaster recovery
- `MIGRATION-RUNBOOK.md` — step-by-step cutover with gates
- `routing-rules.yaml` — machine-readable routing rule set
- `breadbrich-architecture.html` — visual diagrams
- `IMPLEMENTATION-ROADMAP.md` — phased timeline
