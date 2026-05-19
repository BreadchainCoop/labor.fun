# Event Intake & Booking Rules

Captures an external host's event request, runs it through internal pricing/staffing review, and tracks it across the inquiry → confirmed → complete lifecycle. For the calendar-sync workflow that takes over once a booking is confirmed, see [events.md](events.md).

## Who Can Submit Public Intake
- Anyone — hosts message us in DM, the main group, or via a registered intake group.
- No tag requirement.

## Who Can Record Internal Intake
- Main group only.
- Sender must have `operations` or `coordinator` tag.
- The named `intake_owner` must resolve to an existing KB person; if not, the agent MUST ask before creating a new person record.

## Lifecycle

| State | Meaning | Required to enter |
|-------|---------|-------------------|
| `inquiry` | Public intake submitted; awaiting Organization review | Public form has all `required` fields (host name, contact, event name, type, date, headcount, space) |
| `proposal_sent` | Quote and venue offer sent to host | Internal intake has `total_quote`, `deposit_pct`, `final_payment_due` AND admin ack on file |
| `contract_out` | Contract delivered for signature | (`contract_sent_at` set automatically) |
| `confirmed` | Contract signed AND deposit paid | `contract_signed_date` AND `deposit_paid_date` |
| `complete` | Event has occurred; cleanup done | `post_event_state` recorded |
| `cancelled` | Withdrawn at any stage | `cancellation_reason` |

## Who Can Transition State

| Transition | Required Tag | Required Fields |
|------------|--------------|-----------------|
| inquiry → proposal_sent | operations / coordinator + **admin ack** (every time) | total_quote, deposit_pct, final_payment_due |
| proposal_sent → contract_out | operations / coordinator | (contract_sent_at set automatically) |
| contract_out → confirmed | operations / coordinator | contract_signed_date AND deposit_paid_date |
| confirmed → complete | operations / coordinator | post_event_state |
| any → cancelled | operations / coordinator / admin | cancellation_reason |

## Admin Ack on Proposals

**Every** `inquiry → proposal_sent` transition requires admin sign-off. There is no dollar threshold.

When an ops/coordinator triggers the transition:
1. Breadbrich Engels creates a row in `proposal_approvals` (status `pending`) and pings the main group: "EVT-014 needs admin sign-off — $4,200 quote, 60 guests, 2026-05-14. Reply 'approved EVT-014' or 'rejected EVT-014' to act."
2. Any user with the `admin` tag can reply with the approval verb. Breadbrich Engels matches the message via the trigger pattern and decides the approval row.
3. On approve: transition completes, host receives proposal. On reject: booking stays in `inquiry`; pricing stays editable.
4. If no admin responds within 24h, Breadbrich Engels re-pings; after 72h with no decision, ops gets an escalation message.

## Calendar Entry

On `confirmed`, Breadbrich Engels does **not** auto-push to Google Calendar (out of scope for now). Ops creates the calendar entry manually in Google Calendar; once it syncs back through iCal into the local `events` table, ops links the two by setting `calendar_entry_code` on the booking. After that, the role-assignment workflow ([events.md](events.md)) takes over. (Auto-push is Phase 2 once we wire OneCLI calendar credentials.)

## Notifications
- **On new inquiry**: notify ops channel with EVT-ID, host, date, headcount, space.
- **On internal intake update**: short summary to ops with what changed and by whom.
- **On proposal approval request**: ping main group, tag admins.
- **On confirmed**: ops channel + host get confirmation; calendar entry code returned.
- **On complete**: ops channel only.
- **On cancelled**: ops channel + host get cancellation notice.

## Constraints
- The agent MUST NOT skip lifecycle states (no inquiry → confirmed direct).
- The agent MUST NOT create a calendar entry until the booking reaches `confirmed`.
- The agent MUST NOT delete bookings — cancel them instead.
- Pricing fields are write-once per intake event in Phase 1; subsequent edits overwrite + bump `updated_at`. (No revision history yet.)
- If the host asks for a date that conflicts with another `confirmed` booking in the same `preferred_space`, the agent MUST flag the conflict and ask for a backup date before submitting intake.
- Quote delivery is a markdown summary in chat (Phase 1). PDF generation is out of scope.

## Tools

| Tool | Caller | Purpose |
|------|--------|---------|
| `submit_event_intake` | Host (DM or main) | Create the inquiry row + answers |
| `record_internal_intake` | ops / coordinator (main) | Apply pricing and/or staffing |
| `request_proposal_approval` | ops / coordinator (main) | Open an admin-ack request |
| `decide_proposal_approval` | admin (main) | Approve/reject a proposal request |
| `transition_event_booking` | ops / coordinator (main) | Move lifecycle forward |
| `list_event_bookings` | anyone in main | Read-only view |

See `rules/access-control/role-matrix.md` for tag definitions.
