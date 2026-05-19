# Events Rules

Two related but distinct workflows live under this directory.

| Rule File | Scope | When to Read |
|-----------|-------|--------------|
| [events.md](events.md) | Calendar-synced events from Google Calendar + role assignments (host, setup, cleanup, etc.) | Reading or writing event role assignments; answering questions about scheduled events |
| [intake.md](intake.md) | Event intake & booking workflow — host inquiries, internal pricing/staffing, lifecycle from inquiry → confirmed → complete | Hosting a booking conversation, recording internal intake, transitioning a booking, sending proposals |

The two are linked: once a booking is `confirmed`, ops manually creates a Google Calendar entry. After it syncs back through iCal into the `events` table, ops sets the booking's `calendar_entry_code` and the role-assignment workflow takes over. (Auto-push is Phase 2.)
