# Runtime Environment

How the assistant's execution environment is laid out — so multi-step work
doesn't get silently lost.

## Ephemeral container per turn

Each turn (agent invocation) runs in a **fresh, isolated container**. The
container's overlay/root filesystem — including **`/tmp`**, `$HOME`, and anything
outside `/workspace/*` — is **discarded when the container is recycled between
turns**. It survives *within* a single turn, but not across turns.

Only the mounted **`/workspace/*`** paths persist:

| Path | Persists across turns? | Access | Use for |
|------|:---:|--------|---------|
| `/workspace/group` | yes | read/write | per-group memory, notes, and scratch work that must survive turns |
| `/workspace/shared-kb` | yes | read-only (writable via IPC from main) | the shared knowledge base |
| `/workspace/ipc` | yes | read/write | framework IPC (don't hand-edit) |
| `/tmp`, `$HOME`, `/` (overlay) | **no** | read/write | throwaway *within a single turn only* |

## Rule: never do multi-turn work in `/tmp`

For anything spanning more than one turn — most importantly **`git clone`ing a
repo to edit, build, and test** — work inside a **persistent** path
(`/workspace/group/.work/<name>`), not `/tmp`.

If a turn is interrupted (e.g. the user sends a message mid-task), a clone in
`/tmp` is gone on the next turn along with any uncommitted changes; a clone under
`/workspace/group` is still there.

- Clone / build under `/workspace/group/.work/`; clean it up when done.
- If you must use `/tmp`, complete the whole clone -> edit -> commit -> **push**
  within a single turn, so the work reaches the remote before the container can
  recycle.
