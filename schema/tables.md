# Database Schema

SQLite database at `store/messages.db` via better-sqlite3.

## Tables

### chats

Chat and group metadata. No message content stored here.

| Column            | Type    | Notes                                            |
| ----------------- | ------- | ------------------------------------------------ |
| **jid**           | TEXT PK | Chat/group JID                                   |
| name              | TEXT    | Display name                                     |
| last_message_time | TEXT    | ISO-8601 string, e.g. `2026-05-19T18:17:36.528Z` |
| channel           | TEXT    | slack, telegram, cli, etc.                       |
| is_group          | INTEGER | 0=DM, 1=group                                    |

### messages

Full message history with reply threading context.

| Column                   | Type    | Notes                                                                                     |
| ------------------------ | ------- | ----------------------------------------------------------------------------------------- |
| **id**                   | TEXT    | Message ID (composite PK with chat_jid)                                                   |
| **chat_jid**             | TEXT    | FK -> chats.jid                                                                           |
| sender                   | TEXT    | Sender platform ID                                                                        |
| sender_name              | TEXT    | Display name                                                                              |
| content                  | TEXT    | Message body                                                                              |
| timestamp                | TEXT    | ISO-8601 string, e.g. `2026-05-19T18:17:36.528Z` (indexed; sorts chronologically as text) |
| is_from_me               | INTEGER | 1 if bot sent it                                                                          |
| is_bot_message           | INTEGER | 1 if from any bot                                                                         |
| reply_to_message_id      | TEXT    | Threading                                                                                 |
| reply_to_message_content | TEXT    | Quoted text                                                                               |
| reply_to_sender_name     | TEXT    | Who was replied to                                                                        |
| thread_id                | TEXT    | Thread grouping                                                                           |
| is_reply_to_bot          | INTEGER | 1 if replying to Breadbrich Engels                                                        |

### registered_groups

Group registration and container configuration.

| Column           | Type        | Notes                    |
| ---------------- | ----------- | ------------------------ |
| **jid**          | TEXT PK     | Group JID                |
| name             | TEXT        | Display name             |
| folder           | TEXT UNIQUE | Filesystem folder name   |
| trigger_pattern  | TEXT        | Regex for activation     |
| requires_trigger | INTEGER     | 1 = must match pattern   |
| container_config | TEXT        | JSON mount/env overrides |
| is_main          | INTEGER     | 1 = elevated privileges  |
| added_at         | TEXT        | ISO timestamp            |

### sessions

Claude Agent SDK session persistence per group.

| Column           | Type    | Notes                            |
| ---------------- | ------- | -------------------------------- |
| **group_folder** | TEXT PK | Maps to registered_groups.folder |
| session_id       | TEXT    | SDK session UUID                 |

### router_state

Key-value state persistence for the message router.

| Column  | Type    | Notes              |
| ------- | ------- | ------------------ |
| **key** | TEXT PK | State key          |
| value   | TEXT    | JSON-encoded value |

Stores: `last_timestamp`, `last_agent_timestamp` (JSON per-group), and `control_plane_usage_cursor` (last `api_usage.id` already reported to the hosted control plane — see `api_usage`).

### scheduled_tasks

Cron, interval, and one-time task definitions.

| Column         | Type    | Notes                                |
| -------------- | ------- | ------------------------------------ |
| **id**         | TEXT PK | Task UUID                            |
| group_folder   | TEXT    | FK -> registered_groups.folder       |
| chat_jid       | TEXT    | FK -> chats.jid (response target)    |
| prompt         | TEXT    | Claude prompt to execute             |
| script         | TEXT    | Alternative: raw script              |
| schedule_type  | TEXT    | cron, interval, or once              |
| schedule_value | TEXT    | Cron expr / ms interval / ISO date   |
| context_mode   | TEXT    | What context to include              |
| next_run       | INTEGER | Unix timestamp (indexed with status) |
| last_run       | INTEGER | Unix timestamp                       |
| last_result    | TEXT    | Last execution output                |
| status         | TEXT    | active, paused, or done              |
| created_at     | TEXT    | ISO timestamp                        |

### task_run_logs

Execution history for scheduled tasks.

| Column      | Type       | Notes                                          |
| ----------- | ---------- | ---------------------------------------------- |
| **id**      | INTEGER PK | Autoincrement                                  |
| task_id     | TEXT       | FK -> scheduled_tasks.id (indexed with run_at) |
| run_at      | TEXT       | ISO timestamp                                  |
| duration_ms | INTEGER    | Execution time                                 |
| status      | TEXT       | ok or error                                    |
| result      | TEXT       | Output or error message                        |
| error       | TEXT       | Error details if failed                        |

### user_identities

Maps platform-specific IDs to KB person names — the identity-resolution allowlist. The orchestrator writes a `sender_context.json` (with the resolved `user_id`) only for senders that have a row here, and every gated IPC handler authorizes based on the presence of that validated sender context. Note that the chat-level intake filter (`sender-allowlist.json`) is a separate, earlier gate — it controls who can speak to the agent at all before any of this matters.

| Column          | Type | Notes                                    |
| --------------- | ---- | ---------------------------------------- |
| **platform_id** | TEXT | Platform-specific user ID (composite PK) |
| **platform**    | TEXT | slack, telegram, discord, cli, etc.      |
| kb_person       | TEXT | KB person identifier (e.g. jane-doe)     |

### app_users

People records used for assignment and identity resolution.

| Column     | Type    | Notes                                    |
| ---------- | ------- | ---------------------------------------- |
| **id**     | TEXT PK | Generated ID (user-{timestamp}-{random}) |
| name       | TEXT    | Display name                             |
| created_at | TEXT    | ISO timestamp                            |

### proposal_approvals

Admin sign-off request records. Each row tracks an approval request and its decision.

| Column               | Type    | Notes                                                  |
| -------------------- | ------- | ------------------------------------------------------ |
| **id**               | TEXT PK | e.g. PA-EVT-014-1                                      |
| booking_id           | TEXT    | Opaque reference to the item under approval            |
| requested_by_user_id | TEXT    | The ops/coordinator who triggered the request          |
| requested_at         | TEXT    | ISO timestamp                                          |
| status               | TEXT    | pending, approved, rejected, expired (default pending) |
| decided_by_user_id   | TEXT    | Admin who decided                                      |
| decided_at           | TEXT    | ISO timestamp                                          |
| decision_notes       | TEXT    | Optional                                               |

### expenses

Financial expense requests with approval, receipt, and reimbursement lifecycle.

| Column                | Type    | Notes                                                      |
| --------------------- | ------- | ---------------------------------------------------------- |
| **id**                | TEXT PK | Generated ID (exp-{timestamp}-{random})                    |
| chat_jid              | TEXT    | FK -> chats.jid (originating chat)                         |
| requester_user_id     | TEXT    | KB person ID of the requester                              |
| request_type          | TEXT    | `prospective` (preferred) or `retrospective` (discouraged) |
| amount_cents          | INTEGER | Requested amount in cents                                  |
| currency              | TEXT    | ISO 4217 code, default `USD`                               |
| description           | TEXT    | What the money is for                                      |
| category              | TEXT    | supplies, travel, food, av, cleaning, other                |
| vendor                | TEXT    | Who is being paid                                          |
| justification         | TEXT    | Why needed; required for retrospective                     |
| expected_date         | TEXT    | ISO date (prospective only)                                |
| incurred_date         | TEXT    | ISO date (retrospective only)                              |
| event_id              | TEXT    | Optional opaque event grouping key (indexed)               |
| approver_user_id      | TEXT    | KB person ID of approver                                   |
| approved_amount_cents | INTEGER | May differ from amount_cents if modified                   |
| approver_notes        | TEXT    | Reason/notes from approver                                 |
| receipt_path          | TEXT    | KB path or URL to receipt                                  |
| receipt_submitted_at  | TEXT    | ISO timestamp                                              |
| actual_amount_cents   | INTEGER | Final cost if differs from approved                        |
| reimbursed_by         | TEXT    | KB person ID of finance member                             |
| reimbursed_at         | TEXT    | ISO timestamp                                              |
| reimbursement_method  | TEXT    | venmo, zelle, check, ach, cash                             |
| status                | TEXT    | Lifecycle state (see below)                                |
| created_at            | TEXT    | ISO timestamp                                              |
| resolved_by           | TEXT    | KB person ID who resolved                                  |
| resolved_at           | TEXT    | ISO timestamp                                              |

Lifecycle states:

- **prospective**: `pending_approval` → `receipt_pending` → `receipt_submitted` → `reimbursed`
- **retrospective**: `submitted_retro` → `approved_retro` → `reimbursed`
- Terminal: `reimbursed`, `denied`, `denied_retro`, `cancelled`

### safe_payouts

On-chain token reimbursements proposed to the org's Safe{Wallet} multisig (#108).
**Separate from `expenses`** — the assistant is a _proposer only_, and the Safe
threshold is the approval. `amount_raw` is base units (wei) as a decimal string.

| Column                                              | Type          | Notes                                                 |
| --------------------------------------------------- | ------------- | ----------------------------------------------------- |
| id                                                  | TEXT          | `PAY-N` per group                                     |
| chat_jid / group_folder                             | TEXT          | origin chat/group                                     |
| requester_user_id                                   | TEXT          | KB person who requested                               |
| recipient_slug                                      | TEXT          | KB people slug (nullable)                             |
| recipient_address                                   | TEXT          | checksummed EVM address                               |
| token_address / chain_id / safe_address             | TEXT/INT/TEXT | from profile `safe` config                            |
| amount_raw                                          | TEXT          | base units (wei) as decimal string                    |
| amount_display                                      | TEXT          | e.g. "100 BREAD"                                      |
| safe_nonce / safe_tx_hash                           | INT/TEXT      | set at propose; `safe_tx_hash` is the idempotency key |
| status                                              | TEXT          | lifecycle (below)                                     |
| confirmations / threshold                           | INT           | mirrored from the Tx Service                          |
| exec_tx_hash                                        | TEXT          | on-chain execution tx                                 |
| last_error / expense_id                             | TEXT          | propose error / optional expense link                 |
| created_at / proposed_at / executed_at / updated_at | TEXT          | ISO timestamps                                        |

Lifecycle: `requested` → `proposed` → `confirming` → `executed` (terminal);
plus `failed` (retryable propose error), `cancelled`, `rejected` (nonce replaced).
The reconcile loop only advances rows by observation; terminal rows are immutable
(replay-safe). See `rules/finance/safe-payouts.md`.

### meeting_summaries

Processed meeting transcript summaries with extracted action items.

| Column                  | Type    | Notes                                     |
| ----------------------- | ------- | ----------------------------------------- |
| **id**                  | TEXT PK | Generated ID (mtg-{timestamp}-{random})   |
| chat_jid                | TEXT    | FK -> chats.jid                           |
| group_folder            | TEXT    | Source group folder                       |
| title                   | TEXT    | Meeting title                             |
| transcript_text         | TEXT    | Raw transcript input                      |
| summary_html            | TEXT    | Self-contained HTML slideshow             |
| action_items            | TEXT    | JSON array of action items                |
| extracted_events        | TEXT    | JSON array of new events                  |
| extracted_people        | TEXT    | JSON array of new people                  |
| extracted_tasks         | TEXT    | JSON array of task updates                |
| extracted_documents     | TEXT    | JSON array of documents needed            |
| clarification_questions | TEXT    | JSON array of questions for unclear items |
| status                  | TEXT    | pending, completed                        |
| created_at              | TEXT    | ISO timestamp                             |

### proposed_tasks

Action items extracted from meeting transcripts that need coordinator approval before they become real KB TASK-NNN entries. One row per proposed task. Self-approval is allowed (a coordinator may approve tasks from their own transcript).

| Column            | Type    | Notes                                                  |
| ----------------- | ------- | ------------------------------------------------------ |
| **id**            | TEXT PK | Generated ID (PT-{timestamp}-{idx})                    |
| summary_id        | TEXT    | FK -> meeting_summaries.id (logical, not enforced)     |
| chat_jid          | TEXT    | FK -> chats.jid (where the transcript was submitted)   |
| group_folder      | TEXT    | Source group folder                                    |
| requester_user_id | TEXT    | KB person id of the transcript submitter (nullable)    |
| title             | TEXT    | Short imperative title                                 |
| description       | TEXT    | Fuller context from the transcript                     |
| proposed_assignee | TEXT    | KB person name suggested by the agent                  |
| proposed_due_date | TEXT    | YYYY-MM-DD if the transcript mentioned one             |
| source_quote      | TEXT    | Verbatim line from the transcript justifying this task |
| status            | TEXT    | pending → approved → created, or pending → rejected    |
| created_at        | TEXT    | ISO timestamp                                          |
| resolved_by       | TEXT    | KB person id of the coordinator who approved/rejected  |
| resolved_at       | TEXT    | ISO timestamp of approval/rejection                    |
| resulting_task_id | TEXT    | TASK-NNN id created on approval                        |
| rejection_reason  | TEXT    | Optional reason given by coordinator                   |

### pending_approvals

The reusable human-in-the-loop approval primitive (`rules/approvals/README.md`). A container agent proposes a consequential action `{action_class, summary, payload}` via `request_approval`; if the class is gated (config-driven, see `GATED_ACTION_CLASSES`), one row is recorded here and an approve/reject prompt is posted to chat. An allowlisted human's reply resolves it via `resolve_approval`. **Not** used by `safe_payouts` (that approval is the on-chain Safe threshold, not a chat reply) — see `rules/finance/safe-payouts.md`.

| Column               | Type    | Notes                                                          |
| -------------------- | ------- | --------------------------------------------------------------- |
| **id**               | TEXT PK | Generated ID (AP-{timestamp}-{random})                          |
| action_class         | TEXT    | Free-form tag, e.g. `github_write`, `kb_write`, `payout`         |
| summary              | TEXT    | One-line human-readable description shown to the approver       |
| payload              | TEXT    | Opaque JSON the proposer round-trips back on approval            |
| dedupe_key           | TEXT    | Optional idempotency key; a live pending row with the same key is reused |
| chat_jid             | TEXT    | Chat the requesting agent is attached to (notified on resolution) |
| group_folder         | TEXT    | Source group folder                                             |
| requested_by_user_id | TEXT    | KB person id of the requester (nullable)                        |
| approver_hint        | TEXT    | Optional suggested approver name                                 |
| status               | TEXT    | `pending` → `approved` / `rejected` / `revise` / `expired`        |
| created_at           | TEXT    | ISO timestamp                                                    |
| expires_at           | TEXT    | ISO deadline from `APPROVAL_TIMEOUT_MINUTES`; null = never expires |
| resolved_by_user_id  | TEXT    | KB person id of the approver (nullable)                          |
| resolved_at          | TEXT    | ISO timestamp of resolution                                       |
| revision_notes       | TEXT    | Reject/revise reason, carried back to the requesting chat          |

Only a still-`pending` row transitions (guards double-resolution/races). A dedicated background sweep (`src/integrations/approval-expiry.ts`) flips stale pending rows past `expires_at` to `expired` and notifies the requesting chat once.

### reminder_log

Idempotency ledger for the escalating-deadline reminder engine (`src/reminder-engine.ts`). One row per (item, ladder rung) that has already fired, so the periodic sweep sends each rung at most once.

| Column      | Type    | Notes                                                                     |
| ----------- | ------- | ------------------------------------------------------------------------- |
| **item_id** | TEXT PK | Deadline-bearing item id (e.g. `TASK-001`)                                |
| **rung**    | TEXT PK | Ladder label that fired (`3w`, `1w`, `3d`, `1d`, `OVERDUE`)               |
| deadline    | TEXT    | Deadline this fire was computed against; a change resets the item's rungs |
| fired_at    | TEXT    | ISO timestamp the reminder was sent                                       |

Primary key `(item_id, rung)` is the dedup guarantee.

### pm_dm_log

Throttle ledger for the PM-orchestration loop (`src/integrations/pm-orchestration.ts`, #31). One row per (person, task, reason) the loop has asked the agent to follow up on, so a person isn't re-pinged about the same blocked/overdue item within the cooldown window (`PM_DM_COOLDOWN_MS`).

| Column      | Type    | Notes                                  |
| ----------- | ------- | -------------------------------------- |
| **person**  | TEXT PK | KB person name the follow-up targets   |
| **task_id** | TEXT PK | Task the follow-up is about            |
| **reason**  | TEXT PK | `blocking` or `overdue`                |
| sent_at     | TEXT    | ISO timestamp the follow-up was raised |

### ops_report_log

Idempotency ledger for the operational-report loop (`src/integrations/operational-report.ts`, #34). One row per reporting period that has already been delivered, so the recurring report posts at most once per period (`OPS_REPORT_PERIOD`) regardless of how often the loop sweeps or how many times the process restarts.

| Column     | Type    | Notes                                                   |
| ---------- | ------- | ------------------------------------------------------- |
| **period** | TEXT PK | Period key — ISO week (`2026-W24`) or month (`2026-06`) |
| sent_at    | TEXT    | ISO timestamp the report was delivered                  |

### chat_translate_prefs

Per-chat translation preferences for the pre-agent translation suite (`src/translate-commands.ts`, see [rules/messaging/translation.md](../rules/messaging/translation.md)). `lang1`/`lang2` + `enabled` hold the group bidirectional pair set via `!translate-on`; `user_langs` is a JSON map of sender → target language code for per-user `!translate-me` opt-ins. Rows are pruned when both the pair and the user map are empty.

| Column       | Type    | Notes                                                    |
| ------------ | ------- | -------------------------------------------------------- |
| **chat_jid** | TEXT PK | Chat/group JID                                           |
| lang1        | TEXT    | One side of the bidirectional pair (nullable)            |
| lang2        | TEXT    | Other side of the pair (nullable)                        |
| enabled      | INTEGER | 1 when group pair auto-translate is active               |
| user_langs   | TEXT    | JSON object: sender id → ISO 639-1 target code           |
| updated_at   | TEXT    | ISO timestamp of the last change                         |

### api_usage

API cost tracking & budgets: one row per completed `/v1/messages` call observed by the credential proxy (`src/credential-proxy.ts`). Powers usage reporting (`scripts/usage-report.ts`), budget enforcement (`src/usage-budget.ts`), and hosted control-plane usage push (`src/integrations/control-plane-sync.ts` — drains rows by `id` in batches, cursor persisted in `router_state` under `control_plane_usage_cursor`). `run_tag` is the spawning container's name (see `container-runner.ts`), which encodes the group folder, so usage can be grouped per-group by prefix. `est_cost_usd` is computed at insert time from `src/model-pricing.ts`, so historical rows keep the price in effect when the call was made even if pricing is later overridden.

| Column             | Type       | Notes                                              |
| ------------------ | ---------- | --------------------------------------------------- |
| **id**             | INTEGER PK | Autoincrement                                      |
| run_tag            | TEXT       | Container name the request was attributed to (nullable — unattributed when the container sent no placeholder run tag) |
| model              | TEXT       | Model id reported by the API response              |
| input_tokens       | INTEGER    | Prompt tokens (excludes cache)                     |
| output_tokens      | INTEGER    | Completion tokens                                  |
| cache_read_tokens  | INTEGER    | Tokens served from the prompt cache                |
| cache_write_tokens | INTEGER    | Tokens written to the prompt cache                 |
| est_cost_usd       | REAL       | Estimated USD cost at time of the call             |
| status_code        | INTEGER    | HTTP status of the upstream response               |
| created_at         | TEXT       | ISO timestamp (indexed)                            |

### assistant_events

Assistant usage + knowledge-gap analytics: one row per completed agent run in a group (`src/db.ts`, `logAssistantEvent`). Powers the KB dashboard's `/analytics` tab (`kb-ui/server.mjs`). `run_id` is a soft link to `agent_runs.id` (no FK) so analytics can be pruned/rebuilt independently. `outcome` is one of `answered` | `knowledge_gap` | `error` | `unknown`; `gap_source` (`agent_signal` | `heuristic`) records how a `knowledge_gap` outcome was determined. Question text and sender are subject to the `ASSISTANT_ANALYTICS_PRIVACY` stance — see [rules/knowledge-base/analytics.md](../rules/knowledge-base/analytics.md) for the knowledge-gap signal convention and the privacy modes.

| Column        | Type       | Notes                                                                 |
| ------------- | ---------- | ---------------------------------------------------------------------- |
| **id**        | INTEGER PK | Autoincrement                                                         |
| run_id        | INTEGER    | Soft link to `agent_runs.id` (nullable, no FK)                        |
| chat_jid      | TEXT       | Chat/group JID the run served                                         |
| channel       | TEXT       | Channel the trigger arrived on (slack/telegram/etc, nullable)         |
| group_name    | TEXT       | Display name of the group (nullable)                                  |
| group_folder  | TEXT       | Group folder (stable identifier; NOT NULL)                            |
| is_main       | INTEGER    | 1 if the run happened in the main/shared-KB group                     |
| sender_name   | TEXT       | Trigger message sender; suppressed (null) per privacy mode            |
| is_question   | INTEGER    | 1 if the trigger text heuristically looks like a question             |
| outcome       | TEXT       | `answered` \| `knowledge_gap` \| `error` \| `unknown`                  |
| gap_source    | TEXT       | `agent_signal` \| `heuristic` \| null (set only when outcome is `knowledge_gap`) |
| topic         | TEXT       | Coarse keyword-bucketed topic (e.g. `expenses`, `calendar`), nullable |
| question_text | TEXT       | Trigger text, redacted/truncated/nulled per `ASSISTANT_ANALYTICS_PRIVACY` |
| created_at    | TEXT       | ISO timestamp (indexed)                                               |

## Indices

| Index                          | Columns                                | Purpose                                      |
| ------------------------------ | -------------------------------------- | -------------------------------------------- |
| idx_messages_timestamp         | messages(timestamp)                    | Fast message retrieval by time               |
| idx_tasks_next_run             | scheduled_tasks(next_run, status)      | Scheduler polling                            |
| idx_task_logs                  | task_run_logs(task_id, run_at)         | Task history lookup                          |
| idx_meeting_summaries_group    | meeting_summaries(group_folder)        | Summary lookup by group                      |
| idx_meeting_summaries_status   | meeting_summaries(status)              | Summary filtering by status                  |
| idx_proposed_tasks_status      | proposed_tasks(status)                 | Coordinator queue lookup by status           |
| idx_proposed_tasks_summary     | proposed_tasks(summary_id)             | Fetch all proposed tasks from one transcript |
| idx_proposal_approvals_pending | proposal_approvals(status, booking_id) | Look up pending admin approvals              |
| idx_expenses_status            | expenses(status)                       | Approval-queue lookup                        |
| idx_expenses_requester         | expenses(requester_user_id)            | Per-person expense history                   |
| idx_expenses_event             | expenses(event_id)                     | Expense grouping by event_id                 |
| idx_api_usage_created          | api_usage(created_at)                  | Time-range usage queries                     |
| idx_api_usage_run_tag          | api_usage(run_tag)                     | Per-run/group usage lookup                   |
| idx_api_usage_model            | api_usage(model)                       | Per-model usage breakdown                    |
| idx_assistant_events_created   | assistant_events(created_at)           | Time-range analytics queries                 |
| idx_assistant_events_group     | assistant_events(group_folder, created_at) | Per-group analytics breakdown            |
| idx_assistant_events_outcome   | assistant_events(outcome, created_at)  | Resolution-rate / knowledge-gap filtering    |
