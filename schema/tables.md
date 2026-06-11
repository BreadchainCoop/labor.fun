# Database Schema

SQLite database at `store/messages.db` via better-sqlite3.

## Tables

### chats
Chat and group metadata. No message content stored here.

| Column | Type | Notes |
|---|---|---|
| **jid** | TEXT PK | Chat/group JID |
| name | TEXT | Display name |
| last_message_time | TEXT | ISO-8601 string, e.g. `2026-05-19T18:17:36.528Z` |
| channel | TEXT | slack, telegram, cli, etc. |
| is_group | INTEGER | 0=DM, 1=group |

### messages
Full message history with reply threading context.

| Column | Type | Notes |
|---|---|---|
| **id** | TEXT | Message ID (composite PK with chat_jid) |
| **chat_jid** | TEXT | FK -> chats.jid |
| sender | TEXT | Sender platform ID |
| sender_name | TEXT | Display name |
| content | TEXT | Message body |
| timestamp | TEXT | ISO-8601 string, e.g. `2026-05-19T18:17:36.528Z` (indexed; sorts chronologically as text) |
| is_from_me | INTEGER | 1 if bot sent it |
| is_bot_message | INTEGER | 1 if from any bot |
| reply_to_message_id | TEXT | Threading |
| reply_to_message_content | TEXT | Quoted text |
| reply_to_sender_name | TEXT | Who was replied to |
| thread_id | TEXT | Thread grouping |
| is_reply_to_bot | INTEGER | 1 if replying to Breadbrich Engels |

### registered_groups
Group registration and container configuration.

| Column | Type | Notes |
|---|---|---|
| **jid** | TEXT PK | Group JID |
| name | TEXT | Display name |
| folder | TEXT UNIQUE | Filesystem folder name |
| trigger_pattern | TEXT | Regex for activation |
| requires_trigger | INTEGER | 1 = must match pattern |
| container_config | TEXT | JSON mount/env overrides |
| is_main | INTEGER | 1 = elevated privileges |
| added_at | TEXT | ISO timestamp |

### sessions
Claude Agent SDK session persistence per group.

| Column | Type | Notes |
|---|---|---|
| **group_folder** | TEXT PK | Maps to registered_groups.folder |
| session_id | TEXT | SDK session UUID |

### router_state
Key-value state persistence for the message router.

| Column | Type | Notes |
|---|---|---|
| **key** | TEXT PK | State key |
| value | TEXT | JSON-encoded value |

Stores: `last_timestamp`, `last_agent_timestamp` (JSON per-group).

### scheduled_tasks
Cron, interval, and one-time task definitions.

| Column | Type | Notes |
|---|---|---|
| **id** | TEXT PK | Task UUID |
| group_folder | TEXT | FK -> registered_groups.folder |
| chat_jid | TEXT | FK -> chats.jid (response target) |
| prompt | TEXT | Claude prompt to execute |
| script | TEXT | Alternative: raw script |
| schedule_type | TEXT | cron, interval, or once |
| schedule_value | TEXT | Cron expr / ms interval / ISO date |
| context_mode | TEXT | What context to include |
| next_run | INTEGER | Unix timestamp (indexed with status) |
| last_run | INTEGER | Unix timestamp |
| last_result | TEXT | Last execution output |
| status | TEXT | active, paused, or done |
| created_at | TEXT | ISO timestamp |

### task_run_logs
Execution history for scheduled tasks.

| Column | Type | Notes |
|---|---|---|
| **id** | INTEGER PK | Autoincrement |
| task_id | TEXT | FK -> scheduled_tasks.id (indexed with run_at) |
| run_at | TEXT | ISO timestamp |
| duration_ms | INTEGER | Execution time |
| status | TEXT | ok or error |
| result | TEXT | Output or error message |
| error | TEXT | Error details if failed |

### user_identities
Maps platform-specific IDs to KB person names — the identity-resolution allowlist. The orchestrator writes a `sender_context.json` (with the resolved `user_id`) only for senders that have a row here, and every gated IPC handler authorizes based on the presence of that validated sender context. Note that the chat-level intake filter (`sender-allowlist.json`) is a separate, earlier gate — it controls who can speak to the agent at all before any of this matters.

| Column | Type | Notes |
|---|---|---|
| **platform_id** | TEXT | Platform-specific user ID (composite PK) |
| **platform** | TEXT | slack, telegram, discord, cli, etc. |
| kb_person | TEXT | KB person identifier (e.g. bob, alice) |

### app_users
People records used for assignment and identity resolution.

| Column | Type | Notes |
|---|---|---|
| **id** | TEXT PK | Generated ID (user-{timestamp}-{random}) |
| name | TEXT | Display name |
| created_at | TEXT | ISO timestamp |

### proposal_approvals
Admin sign-off request records. Each row tracks an approval request and its decision.

| Column | Type | Notes |
|---|---|---|
| **id** | TEXT PK | e.g. PA-EVT-014-1 |
| booking_id | TEXT | Opaque reference to the item under approval |
| requested_by_user_id | TEXT | The ops/coordinator who triggered the request |
| requested_at | TEXT | ISO timestamp |
| status | TEXT | pending, approved, rejected, expired (default pending) |
| decided_by_user_id | TEXT | Admin who decided |
| decided_at | TEXT | ISO timestamp |
| decision_notes | TEXT | Optional |

### expenses
Financial expense requests with approval, receipt, and reimbursement lifecycle.

| Column | Type | Notes |
|---|---|---|
| **id** | TEXT PK | Generated ID (exp-{timestamp}-{random}) |
| chat_jid | TEXT | FK -> chats.jid (originating chat) |
| requester_user_id | TEXT | KB person ID of the requester |
| request_type | TEXT | `prospective` (preferred) or `retrospective` (discouraged) |
| amount_cents | INTEGER | Requested amount in cents |
| currency | TEXT | ISO 4217 code, default `USD` |
| description | TEXT | What the money is for |
| category | TEXT | supplies, travel, food, av, cleaning, other |
| vendor | TEXT | Who is being paid |
| justification | TEXT | Why needed; required for retrospective |
| expected_date | TEXT | ISO date (prospective only) |
| incurred_date | TEXT | ISO date (retrospective only) |
| event_id | TEXT | Optional opaque event grouping key (indexed) |
| approver_user_id | TEXT | KB person ID of approver |
| approved_amount_cents | INTEGER | May differ from amount_cents if modified |
| approver_notes | TEXT | Reason/notes from approver |
| receipt_path | TEXT | KB path or URL to receipt |
| receipt_submitted_at | TEXT | ISO timestamp |
| actual_amount_cents | INTEGER | Final cost if differs from approved |
| reimbursed_by | TEXT | KB person ID of finance member |
| reimbursed_at | TEXT | ISO timestamp |
| reimbursement_method | TEXT | venmo, zelle, check, ach, cash |
| status | TEXT | Lifecycle state (see below) |
| created_at | TEXT | ISO timestamp |
| resolved_by | TEXT | KB person ID who resolved |
| resolved_at | TEXT | ISO timestamp |

Lifecycle states:
- **prospective**: `pending_approval` → `receipt_pending` → `receipt_submitted` → `reimbursed`
- **retrospective**: `submitted_retro` → `approved_retro` → `reimbursed`
- Terminal: `reimbursed`, `denied`, `denied_retro`, `cancelled`

### meeting_summaries
Processed meeting transcript summaries with extracted action items.

| Column | Type | Notes |
|---|---|---|
| **id** | TEXT PK | Generated ID (mtg-{timestamp}-{random}) |
| chat_jid | TEXT | FK -> chats.jid |
| group_folder | TEXT | Source group folder |
| title | TEXT | Meeting title |
| transcript_text | TEXT | Raw transcript input |
| summary_html | TEXT | Self-contained HTML slideshow |
| action_items | TEXT | JSON array of action items |
| extracted_events | TEXT | JSON array of new events |
| extracted_people | TEXT | JSON array of new people |
| extracted_tasks | TEXT | JSON array of task updates |
| extracted_documents | TEXT | JSON array of documents needed |
| clarification_questions | TEXT | JSON array of questions for unclear items |
| status | TEXT | pending, completed |
| created_at | TEXT | ISO timestamp |

### proposed_tasks
Action items extracted from meeting transcripts that need coordinator approval before they become real KB TASK-NNN entries. One row per proposed task. Self-approval is allowed (a coordinator may approve tasks from their own transcript).

| Column | Type | Notes |
|---|---|---|
| **id** | TEXT PK | Generated ID (PT-{timestamp}-{idx}) |
| summary_id | TEXT | FK -> meeting_summaries.id (logical, not enforced) |
| chat_jid | TEXT | FK -> chats.jid (where the transcript was submitted) |
| group_folder | TEXT | Source group folder |
| requester_user_id | TEXT | KB person id of the transcript submitter (nullable) |
| title | TEXT | Short imperative title |
| description | TEXT | Fuller context from the transcript |
| proposed_assignee | TEXT | KB person name suggested by the agent |
| proposed_due_date | TEXT | YYYY-MM-DD if the transcript mentioned one |
| source_quote | TEXT | Verbatim line from the transcript justifying this task |
| status | TEXT | pending → approved → created, or pending → rejected |
| created_at | TEXT | ISO timestamp |
| resolved_by | TEXT | KB person id of the coordinator who approved/rejected |
| resolved_at | TEXT | ISO timestamp of approval/rejection |
| resulting_task_id | TEXT | TASK-NNN id created on approval |
| rejection_reason | TEXT | Optional reason given by coordinator |

### reminder_log

Idempotency ledger for the escalating-deadline reminder engine (`src/reminder-engine.ts`). One row per (item, ladder rung) that has already fired, so the periodic sweep sends each rung at most once.

| Column | Type | Notes |
|---|---|---|
| **item_id** | TEXT PK | Deadline-bearing item id (e.g. `TASK-001`) |
| **rung** | TEXT PK | Ladder label that fired (`3w`, `1w`, `3d`, `1d`, `OVERDUE`) |
| deadline | TEXT | Deadline this fire was computed against; a change resets the item's rungs |
| fired_at | TEXT | ISO timestamp the reminder was sent |

Primary key `(item_id, rung)` is the dedup guarantee.

### pm_dm_log

Throttle ledger for the PM-orchestration loop (`src/integrations/pm-orchestration.ts`, #31). One row per (person, task, reason) the loop has asked the agent to follow up on, so a person isn't re-pinged about the same blocked/overdue item within the cooldown window (`PM_DM_COOLDOWN_MS`).

| Column | Type | Notes |
|---|---|---|
| **person** | TEXT PK | KB person name the follow-up targets |
| **task_id** | TEXT PK | Task the follow-up is about |
| **reason** | TEXT PK | `blocking` or `overdue` |
| sent_at | TEXT | ISO timestamp the follow-up was raised |

### ops_report_log

Idempotency ledger for the operational-report loop (`src/integrations/operational-report.ts`, #34). One row per reporting period that has already been delivered, so the recurring report posts at most once per period (`OPS_REPORT_PERIOD`) regardless of how often the loop sweeps or how many times the process restarts.

| Column | Type | Notes |
|---|---|---|
| **period** | TEXT PK | Period key — ISO week (`2026-W24`) or month (`2026-06`) |
| sent_at | TEXT | ISO timestamp the report was delivered |

## Indices

| Index | Columns | Purpose |
|---|---|---|
| idx_messages_timestamp | messages(timestamp) | Fast message retrieval by time |
| idx_tasks_next_run | scheduled_tasks(next_run, status) | Scheduler polling |
| idx_task_logs | task_run_logs(task_id, run_at) | Task history lookup |
| idx_meeting_summaries_group | meeting_summaries(group_folder) | Summary lookup by group |
| idx_meeting_summaries_status | meeting_summaries(status) | Summary filtering by status |
| idx_proposed_tasks_status | proposed_tasks(status) | Coordinator queue lookup by status |
| idx_proposed_tasks_summary | proposed_tasks(summary_id) | Fetch all proposed tasks from one transcript |
| idx_proposal_approvals_pending | proposal_approvals(status, booking_id) | Look up pending admin approvals |
| idx_expenses_status | expenses(status) | Approval-queue lookup |
| idx_expenses_requester | expenses(requester_user_id) | Per-person expense history |
| idx_expenses_event | expenses(event_id) | Expense grouping by event_id |
