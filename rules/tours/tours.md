# Tour Management Rules

## Who Can Manage Tours
- Any member with `operations` or `coordinator` tag can create slots and generate weekly schedules
- Any member can claim or release their own tour shifts (self-service)
- Tour requests can be submitted by anyone relaying visitor information

## Slot Types
- **Regular**: recurring Fri/Mon at 2PM, generated in 4-week batches
- **Special**: linked to a specific event, created manually with an event_id

## Lifecycle

### Slots
1. **Created**: slot exists with date, time, capacity. No guides or requests yet.
2. **Active**: one or more guides assigned, requests may be logged. Visible on the Tours dashboard.
3. **Past**: slot date has passed. Read-only on the dashboard (dimmed). No new claims or requests.

### Shifts
1. **Claimed**: guide types their name to self-assign. User created automatically if new.
2. **Released**: guide or coordinator removes the assignment. Shift row is deleted.

### Requests
1. **Pending**: request logged with contact info. Default state.
2. **Confirmed**: coordinator marks the request as confirmed. Requester is emailed (if email is whitelisted).
3. **Cancelled**: request withdrawn or declined.

Status changes are informational — a pending request still counts against capacity when guests are booked. The coordinator flips status to communicate state back to the team and the requester.

## Notifications
- On new tour request: notify main group with requester name, group size, and slot date
- On guide shift claimed: notify main group with guide name and slot
- On guide shift released: notify main group with guide name and slot
- On tour request status change (confirmed/cancelled): notify main group. If status becomes `confirmed` and the requester's email is on the Breadbrich Engels email whitelist, also email the requester.
- On weekly slot generation: no notification (bulk operation, visible on dashboard)

## Chat Interface (Parity with Dashboard)
All dashboard actions are available via chat through the tour tools. Use them in this order when replying:
1. **Read before write** — call `list_tour_slots` or `get_tour_slot` to resolve IDs before `claim_tour_shift`, `release_tour_shift`, `request_tour`, or `update_tour_request_status`.
2. **Prefer natural IDs in responses** — reply with slot date + time + guide names, not raw UUIDs, unless the user explicitly asks for IDs.
3. **Potential dates** — call `list_potential_tour_dates` when someone asks about upcoming events that could become tours, then pair with `create_tour_slot` (passing `event_id`) to schedule.

## Constraints
- Weekly generation is idempotent -- running it twice for the same period creates no duplicates
- Slot times are normalized to HH:MM:SS format
- max_capacity defaults to 10 guests per slot
- Guide names are free-text; the system finds or creates app_users by name (case-insensitive match)
- The agent should NOT approve or deny tour requests -- just log them and notify
- The agent should NOT delete tour slots -- only coordinators via the dashboard
