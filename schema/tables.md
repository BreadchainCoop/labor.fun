# Database Schema

SQLite database at `store/messages.db` via better-sqlite3.

## Tables

### chats
Chat and group metadata. No message content stored here.

| Column | Type | Notes |
|---|---|---|
| **jid** | TEXT PK | Chat/group JID |
| name | TEXT | Display name |
| last_message_time | INTEGER | Unix timestamp |
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
| timestamp | INTEGER | Unix timestamp (indexed) |
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
Maps platform-specific IDs to KB person names for RBAC.

| Column | Type | Notes |
|---|---|---|
| **platform_id** | TEXT | Platform-specific user ID (composite PK) |
| **platform** | TEXT | slack, telegram, cli, etc. |
| kb_person | TEXT | KB person identifier (e.g. bob, alice) |

### tag_hierarchy
RBAC permission tree defining which tags can assign other tags.

| Column | Type | Notes |
|---|---|---|
| **parent_tag** | TEXT | Holder tag (composite PK) |
| **child_tag** | TEXT | Assignable tag |

Default hierarchy:
- `admin` -> leadership, engineering, creative, operations, community
- `leadership` -> engineering, creative, operations, community
- `coordinator` -> operations, community

### app_users
People who can be assigned to event roles.

| Column | Type | Notes |
|---|---|---|
| **id** | TEXT PK | Generated ID (user-{timestamp}-{random}) |
| name | TEXT | Display name |
| created_at | TEXT | ISO timestamp |

### events
Calendar events synced from Google Calendar iCal feed.

| Column | Type | Notes |
|---|---|---|
| **id** | TEXT PK | Generated ID |
| google_calendar_id | TEXT UNIQUE | iCal UID for deduplication |
| title | TEXT | Event name |
| description | TEXT | Event description |
| start_time | TEXT | ISO timestamp |
| end_time | TEXT | ISO timestamp |
| location | TEXT | Venue/location |
| tours_eligible | INTEGER | 1 if eligible for tours |
| created_at | TEXT | ISO timestamp |
| updated_at | TEXT | ISO timestamp |

### event_assignments
Role assignments linking people to events.

| Column | Type | Notes |
|---|---|---|
| **id** | TEXT PK | Generated ID (asgn-{timestamp}-{random}) |
| event_id | TEXT | FK -> events.id (indexed) |
| user_id | TEXT | FK -> app_users.id |
| role | TEXT | host, setup, cleanup, catering, security, other |
| notes | TEXT | Optional notes |
| created_at | TEXT | ISO timestamp |

### event_bookings
Event-intake / booking workflow. One row per inquiry. Pricing, staffing, lifecycle status all live here.

| Column | Type | Notes |
|---|---|---|
| **id** | TEXT PK | Human-readable code, e.g. EVT-014 (monotonic via `nextEventBookingCode`) |
| chat_jid | TEXT | FK -> chats.jid (where the inquiry originated) |
| requester_user_id | TEXT | KB person resolved at intake |
| requester_name | TEXT | Host org / individual |
| requester_email | TEXT | |
| requester_phone | TEXT | |
| event_name | TEXT | |
| event_type | TEXT | dinner, talk, launch, etc. |
| event_date | TEXT | ISO date (primary requested) |
| start_time | TEXT | HH:MM |
| end_time | TEXT | HH:MM |
| expected_headcount | INTEGER | |
| preferred_space | TEXT | |
| base_venue_fee | REAL | |
| portfolio_discount | INTEGER | 0/1 flag |
| av_line_item | REAL | |
| cleaning_fee | REAL | |
| catering_passthrough | REAL | |
| damage_deposit | REAL | |
| total_quote | REAL | Required before `proposal_sent` |
| deposit_pct | REAL | e.g. 30.0 — required before `proposal_sent` |
| final_payment_due | TEXT | ISO date — required before `proposal_sent` |
| on_site_lead_user_id | TEXT | FK -> app_users.id |
| greeter_user_id | TEXT | FK -> app_users.id |
| bar_kitchen_user_id | TEXT | FK -> app_users.id |
| cleaner_user_id | TEXT | FK -> app_users.id |
| outside_vendors | TEXT | Free-form names+roles+contacts |
| intake_date | TEXT | ISO date — when ops recorded internal intake |
| intake_owner_user_id | TEXT | FK -> app_users.id |
| status | TEXT | inquiry, proposal_sent, contract_out, confirmed, complete, cancelled (default inquiry) |
| proposal_sent_at | TEXT | Set on transition to proposal_sent |
| contract_sent_at | TEXT | Set on transition to contract_out |
| contract_signed_date | TEXT | Required for confirmed |
| deposit_paid_date | TEXT | Required for confirmed |
| calendar_entry_code | TEXT | events.id of the synced GCal entry, set on transition to confirmed |
| cancellation_reason | TEXT | Required for cancelled |
| post_event_state | TEXT | Required for complete |
| created_at | TEXT | ISO timestamp |
| updated_at | TEXT | ISO timestamp |
| resolved_by | TEXT | Last actor who mutated the row |
| resolved_at | TEXT | Set on terminal states (complete / cancelled) |

### event_intake_answers
Wide free-form answers from the public 69-field intake form. Keeps the parent row narrow.

| Column | Type | Notes |
|---|---|---|
| **booking_id** | TEXT | FK -> event_bookings.id (composite PK, ON DELETE CASCADE) |
| **question_key** | TEXT | Slug, e.g. "av_microphone_needs" |
| answer | TEXT | Raw text; structured types serialized as JSON |

### proposal_approvals
Admin sign-off requests for `inquiry → proposal_sent` transitions. Every proposal needs one approved row before it can send.

| Column | Type | Notes |
|---|---|---|
| **id** | TEXT PK | e.g. PA-EVT-014-1 |
| booking_id | TEXT | FK -> event_bookings.id (ON DELETE CASCADE) |
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
| event_id | TEXT | FK -> events.id (indexed) |
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

### rooms
Physical rooms at the organization tracked for residency/occupancy.

| Column | Type | Notes |
|---|---|---|
| **id** | TEXT PK | Generated UUID |
| room_number | INTEGER UNIQUE | Unique room identifier |
| room_name | TEXT | Human-friendly name (e.g. "Chapel Room") |
| capacity | INTEGER | Max simultaneous occupants (default 1) |
| notes | TEXT | Amenities, restrictions, etc. |
| created_at | TEXT | ISO timestamp |

### room_occupancy
Occupancy records: residents and guests assigned to rooms with dates.

| Column | Type | Notes |
|---|---|---|
| **id** | TEXT PK | Generated UUID |
| room_id | TEXT | FK -> rooms(id) |
| user_id | TEXT | FK -> app_users(id) (NULL for guests) |
| guest_name | TEXT | Free-text name for guests (NULL for residents) |
| start_date | TEXT | Move-in / check-in (YYYY-MM-DD) |
| end_date | TEXT | Move-out / check-out (NULL = ongoing) |
| is_guest | INTEGER | 1 for guest, 0 for resident |
| notes | TEXT | Special arrangements |
| created_at | TEXT | ISO timestamp |

### residency_requests
Applications from people asking to stay at the organization as residents or guests. Reviewed in the main group via `review_residency_request`.

| Column | Type | Notes |
|---|---|---|
| **id** | TEXT PK | Generated ID (rr-{timestamp}-{random}) |
| chat_jid | TEXT | FK -> chats.jid — originating chat (for result notification) |
| source_group | TEXT | Folder name of the group where the request was submitted |
| requester_user_id | TEXT | FK -> app_users.id (NULL if applicant isn't a known user) |
| requester_name | TEXT | Full name of the applicant |
| requester_contact | TEXT | Email / phone / handle if provided |
| request_type | TEXT | "resident" or "guest" |
| requested_start_date | TEXT | Requested move-in / check-in (YYYY-MM-DD) |
| requested_end_date | TEXT | Requested end (NULL = ongoing for residents) |
| room_preference | TEXT | Preferred room number/name, if mentioned |
| notes | TEXT | Reason, references, special needs |
| status | TEXT | pending, approved, rejected, onboarded |
| created_at | TEXT | ISO timestamp |
| resolved_by | TEXT | Source group folder of the reviewer who approved/rejected |
| resolved_at | TEXT | ISO timestamp of decision |
| resolution_notes | TEXT | Reviewer's note delivered back to the applicant chat |

## Indices

| Index | Columns | Purpose |
|---|---|---|
| idx_messages_timestamp | messages(timestamp) | Fast message retrieval by time |
| idx_tasks_next_run | scheduled_tasks(next_run, status) | Scheduler polling |
| idx_task_logs | task_run_logs(task_id, run_at) | Task history lookup |
| idx_event_assignments_event | event_assignments(event_id) | Assignment lookup by event |
| idx_meeting_summaries_group | meeting_summaries(group_folder) | Summary lookup by group |
| idx_meeting_summaries_status | meeting_summaries(status) | Summary filtering by status |
| idx_proposed_tasks_status | proposed_tasks(status) | Coordinator queue lookup by status |
| idx_proposed_tasks_summary | proposed_tasks(summary_id) | Fetch all proposed tasks from one transcript |
| idx_event_bookings_status | event_bookings(status) | Booking list views by lifecycle state |
| idx_event_bookings_event_date | event_bookings(event_date) | Calendar overlay, conflict detection |
| idx_event_bookings_intake_owner | event_bookings(intake_owner_user_id) | Owner workload views |
| idx_proposal_approvals_pending | proposal_approvals(status, booking_id) | Look up pending admin approvals |
| idx_expenses_status | expenses(status) | Approval-queue lookup |
| idx_expenses_requester | expenses(requester_user_id) | Per-person expense history |
| idx_expenses_event | expenses(event_id) | Event budget rollup |
| idx_rooms_number | rooms(room_number) | Fast lookup by room number |
| idx_occupancy_room | room_occupancy(room_id, start_date) | Occupancy history per room |
| idx_residency_requests_status | residency_requests(status, created_at) | Filter requests by lifecycle state |
