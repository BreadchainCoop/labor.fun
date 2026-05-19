---
name: tours
description: Tour scheduling, guide assignment, and visitor request management for the organization
---

# Tours Skill

## Overview
the organization offers tours on Fridays and Mondays at 2:00 PM. Special tours may be scheduled around events. This skill covers slot management, guide assignment, and visitor request logging.

## Available Tools

| Tool | When to Use |
|------|-------------|
| `list_tour_slots` | "What tours are coming up?", "Show past tours" (filter: upcoming/past/all) |
| `get_tour_slot` | Need shift_id or request_id, or want full slot detail (guides + requests) |
| `list_potential_tour_dates` | "What events could be tours?", upcoming calendar events not yet linked to a slot |
| `create_tour_slot` | Someone asks to schedule a tour on a specific date |
| `generate_weekly_tour_slots` | "Set up the tour schedule", "generate slots for the coming weeks" |
| `claim_tour_shift` | "I can lead the Friday tour", "[Name] will guide Monday" |
| `release_tour_shift` | "Release Bob from the Monday tour", "I can't do Friday anymore" (needs shift_id from `get_tour_slot`) |
| `request_tour` | "Someone wants to visit", "A group of 5 wants a tour next Friday" |
| `update_tour_request_status` | "Confirm the Smith request", "Cancel the request from Alex" (needs request_id from `get_tour_slot`) |

## Chat Flow Pattern

Most flows start with a read tool to resolve IDs, then call a write tool:

- **Claim** — usually one call: `claim_tour_shift` with the slot_id from a recent `list_tour_slots`. If the user says "Friday" without a specific date, use `list_tour_slots` to pick the nearest Friday.
- **Release** — `get_tour_slot` to find the shift_id → `release_tour_shift`.
- **Request** — if the user names a date that has no slot, `create_tour_slot` first, then `request_tour`. Otherwise `list_tour_slots` → `request_tour`.
- **Confirm / cancel** — `get_tour_slot` for the request's slot to find the request_id → `update_tour_request_status`.

After any write, summarize the new state in natural language (dates + names), not UUIDs.

## Gathering Information

### For tour requests, collect:
- **Name** (required) -- who is asking for the tour
- **Group size** (required, default 1) -- how many people
- **Email** (optional) -- for follow-up
- **Phone** (optional) -- for follow-up
- **Preferred date** (optional) -- may differ from the slot they are assigned to
- **Notes** (optional) -- accessibility needs, special interests, etc.

### For guide claims:
- **Guide name** (required) -- free text, system handles user creation
- **Slot** (required) -- identify by date; look up the slot ID from upcoming slots

## Edge Cases

- If a visitor asks for a date with no slot, create one first with `create_tour_slot`, then log the request with `request_tour`.
- If someone asks "when are tours?" -- the regular schedule is Fridays and Mondays at 2PM. Check for upcoming slots to give specific dates.
- If capacity is full (confirmed guests >= max_capacity), still log the request but mention the slot is at capacity.
- Guide names are matched case-insensitively. "alice" and "Alice" resolve to the same user.
- Do not assign the same guide to the same slot twice -- check existing shifts first if possible.

## Dashboard
The Tours dashboard at kb.example.com/tours shows:
- Upcoming events that could become tour dates (potential tours)
- Scheduled tour slots with guide assignments and request counts
- Capacity display: confirmed guests / max_capacity
- Past tours (dimmed, read-only)
