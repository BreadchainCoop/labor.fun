# Residency Request Rules

Residency requests are applications from people asking to stay at the organization -- either as long-term residents or as guests. They are distinct from the direct CRUD tools in [`rules/residency/residency.md`](residency.md): those are for operations/house staff to manage occupancy directly, while requests are the applicant-facing intake flow.

## Who Can Submit a Request
- Anyone, from any registered group. `submit_residency_request` is not gated by `isMain`.
- The agent logs the application on behalf of the requester; the requester does not need to use the tool themselves.

## Who Can Review a Request
- Only admins or members with the `operations` or `house` tag.
- Reviews are restricted to the **main group** (`review_residency_request` and `list_residency_requests` are `isMain`-gated).
- The IPC handler re-checks `isMain` as defense-in-depth even though the MCP tool already rejects non-main callers.

## Lifecycle

1. **pending** (initial): applicant's request is recorded. The main group is notified with the application details and the request ID.
2. **approved**: a reviewer accepted the application. The originating chat is notified. A coordinator follows up to pick a room and run onboarding (using `add_resident` / `add_guest`).
3. **rejected**: a reviewer declined. The originating chat is notified with any `resolution_notes`.
4. **onboarded** (optional terminal state): reserved for reviewers to mark that an approved applicant has actually been placed into a room. Not transitioned to automatically.

A request cannot be transitioned out of `pending` more than once -- once approved or rejected, further `review_residency_request` calls for the same ID are rejected.

## Approval Chain

| Request Type | Reviewer |
|--------------|---------|
| `guest` (short-term visitor) | Any reviewer (operations/house tag or admin) |
| `resident` (long-term community member) | Any reviewer, but coordinators typically loop in leadership for long-term community decisions |

There is no automatic amount- or duration-based escalation.

## Notifications

- **On submit**: main group receives a multi-line summary with the request ID and a hint to use `review_residency_request`.
- **On review (approved or rejected)**: the **originating chat** (the chat where the agent called `submit_residency_request`) receives a notification with the decision and any resolution notes. If approved, the message includes a heads-up that a coordinator will follow up.
- **On list**: `list_residency_requests` posts a compact listing back to the main group (up to 20 entries).

## Relationship to Occupancy

- Approval does **not** automatically create an occupancy record. The reviewer is expected to:
  1. Confirm the applicant's room with them (via whatever channel is appropriate).
  2. Use `add_resident` or `add_guest` to create the occupancy record with the final dates and room.
  3. Optionally mark the request as `onboarded` (future enhancement) once placement is done.

## Constraints

- `requested_end_date`, if present, must be >= `requested_start_date`. Enforced at tool + IPC handler layers.
- `request_type` must be either `resident` or `guest` (enforced by enum in MCP tool and re-validated in IPC).
- Agents must never approve or reject a request without an explicit instruction from a reviewer -- the tool call should only be made when a qualified reviewer has said so in the chat.
- Agents must not re-submit a duplicate request for the same person and dates if one is already pending -- check `list_residency_requests` first if unsure.
