# Residency Rules

## Who Can Manage Residency
- Any admin or user with `operations` or `house` tag
- Residency tools are restricted to the main group (`isMain` gated)

## Room Management
- Rooms are identified by **room_number** (integer) and optionally a **room_name**
- Each room has a **capacity** (default 1) -- the max simultaneous occupants
- Deleting a room cascade-deletes ALL occupancy history for that room
- Before deleting a room with current occupants, warn the user and confirm

## Occupancy Types
1. **Resident** (community member): linked to `app_users` by name. The system auto-creates the user record if the name is new.
2. **Guest** (visitor): stored as a free-text `guest_name`, not linked to `app_users`.

## Date Handling
- `start_date` is required (YYYY-MM-DD)
- `end_date` is optional -- NULL means the occupant is **ongoing/permanent**
- End date must be >= start date (validated at tool, API, and UI layers)
- An occupancy is "current" when: start_date <= today AND (end_date IS NULL OR end_date >= today)

## Editing Occupancy
- Dates and notes can be updated; the occupant identity cannot be changed (remove + re-add instead)
- To convert an ongoing stay into a fixed stay, set an end_date
- To extend a stay, update the end_date

## Notifications
- No automated notifications currently -- residency changes are managed via the dashboard
- Future: notify #house channel on Slack when a new guest is added

## Constraints
- The agent should never delete a room without explicit user confirmation
- The agent should warn if adding an occupant would exceed room capacity
- The agent should not fabricate room numbers -- always check existing rooms first
