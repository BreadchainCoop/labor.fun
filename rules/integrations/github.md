# GitHub Integration

The assistant has a GitHub identity (its own account) and can operate on
**all repositories in the org's GitHub organization** (configured as `githubOrg`
in the active profile) with **read and write** access via the
official [`github-mcp-server`](https://github.com/github/github-mcp-server),
bundled in the agent container.

## How it works

- The container ships the pinned `github-mcp-server` binary (see
  `container/Dockerfile`, `ARG GITHUB_MCP_SERVER_VERSION`).
- It runs as a stdio MCP server, gated on the presence of
  `GITHUB_PERSONAL_ACCESS_TOKEN` (the assistant's PAT). When the token is
  absent, the server and its tools are not loaded at all.
- The token is read from `.env` and injected into the container at request
  time (`src/container-runner.ts`). It is never committed.
- Tools are exposed under `mcp__github__*`.

## Scope

| Dimension | Value |
|-----------|-------|
| Account | The assistant's own GitHub account |
| Repositories | All repos in the org's GitHub org (`githubOrg`); enforced by the PAT, not the server |
| Access | Read **and** write |
| Toolsets enabled | `context`, `repos`, `issues`, `pull_requests`, `actions`, `projects` |

Disabled by design (not in the enabled toolsets): org/team admin, user
management, security/Dependabot/secret-scanning, gists, notifications,
discussions, experiments. Add a toolset in
`container/agent-runner/src/index.ts` only with explicit approval.

Repo scope is enforced by the **fine-grained PAT**, not by the MCP server.
The PAT must be a fine-grained token authorized for the org's GitHub
organization (`githubOrg`) with: Contents (RW), Issues (RW), Pull requests (RW),
Actions (read), Metadata (read).

For the `projects` toolset (GitHub Projects V2 — add issues/PRs to a
project, update project item field values), the PAT additionally needs
**organization-level** `Projects (RW)` permission. Without it the
`projects_*` tools will return GraphQL permission errors even though
the toolset is loaded.

## Operating discipline

Writes act as the assistant on real repositories. Apply the same care as the
deployment rule in `CLAUDE.md`:

- **Never push directly to `main`** or any protected branch. Branch → PR.
- Open PRs for review; do not self-merge unless an allowlisted user
  explicitly asks.
- Do not delete branches, force-push, or rewrite history without explicit
  instruction from an allowlisted user.
- Treat issue/PR comments as public, on-the-record statements from the org.
  Follow [Messaging](../messaging/README.md) tone.
- Identity & authorization of the *requester* still applies — confirm
  they're allowlisted before acting on a write request. See
  [Access Control](../access-control/README.md).

## Commit attribution (co-authors)

When an **allowlisted user asks you to make a commit or PR**, credit them as a
co-author on the commit(s) you create — in addition to your own trailer. It's
their change; you're just the hands.

> **This is now enforced automatically for local git commits.** A
> container-global `prepare-commit-msg` hook (`container/hooks/`) appends the
> requesting human's `Co-Authored-By:` trailer to every commit, sourced from the
> per-turn sender context (`github_username`), and de-dupes so it's never doubled.
> You don't have to remember it. The guidance below still matters for **commits
> made via the GitHub API/MCP** (`create_or_update_file`, `push_files`), which
> bypass local git and the hook — add the trailer in the message yourself there.

- Resolve the requester's GitHub handle from their KB people file
  (`people/<slug>.md` frontmatter `github_username`).
- Add a Git trailer at the very end of the commit message, after a blank line:

  ```
  Co-Authored-By: <github_username> <ID+github_username@users.noreply.github.com>
  ```

  Prefer the requester's numeric GitHub user id when known — the
  `ID+login@users.noreply.github.com` form links the commit to their profile; if
  you only have the login, `login@users.noreply.github.com` is acceptable.
- Keep your own `Co-Authored-By: Claude …` trailer too; list the human first.
- **Never guess or invent a handle.** If the requester has no `github_username`
  on file, omit their trailer rather than fabricate one — consistent with
  [Escalation](../escalation.md) (never invent an identity). If you want the
  credit and it's missing, ask them for their GitHub username.
- GitHub renders these trailers as co-authors on the resulting commit/PR.

## Applying labels, tags & batch edits — act, verify, report

A confirmation is **not** an action. The failure mode to avoid is confirming in
chat that you labelled/edited issues while nothing actually changed on GitHub
("confirm-without-acting" — see issue #93). Whenever you add/remove labels or do
any batch edit across issues, hold yourself to this protocol:

1. **Call the tool for every targeted issue.** Don't narrate an intention —
   invoke `mcp__github__*` once per issue. A natural-language "done" with no
   underlying tool call is a silent no-op.
2. **Create the label first if it's missing.** Applying a label the repo doesn't
   have can error or no-op. If the label doesn't exist, create it (or, if you
   can't, say so) — never silently skip the issue.
3. **Verify by reading back.** After applying, re-read the issue's labels and
   confirm the change landed. Trust the read-back, not the apply call's
   optimistic response.
4. **Report per issue, not in bulk.** State which issues succeeded and which
   failed (and why) — e.g. "labelled #1, #2, #3; #4 failed (label didn't exist,
   created + applied)". Never a blanket "added it to all of them" unless you
   verified each one.
5. **Never claim success you didn't verify.** If a tool errors, or the read-back
   doesn't show the change, report the failure and what you'll do — don't paper
   over it with a confident confirmation.

This generalizes to any write you make on a user's behalf: file the action,
confirm it took, then report what actually happened — not what you intended.

## Inbound: responding to @-mentions

Everything above is **outbound** — the agent acting on GitHub when a user asks
it to from a chat channel. There is also an optional **inbound** trigger so the
assistant can *respond when it is tagged on GitHub itself*.

- Implemented as a channel (`src/channels/github.ts`), not via the container
  MCP. A host-side poller checks the bot account's GitHub **notifications**
  (`reason: mention` / `team_mention`) on an interval, exactly like the email
  poller. (The MCP server's `notifications` toolset stays disabled — this is a
  separate, narrowly-scoped read.)
- When the bot is @-mentioned, the poller fetches the triggering comment/issue,
  routes it into the agent as a normal inbound message under a `gh:<owner>/<repo>/<number>`
  jid, and the agent's reply is posted **back into that thread** as a comment.
- **Authorization — org members only.** A mention only triggers a response if
  the comment author is a member of the org (`githubOrg`), checked via
  `GET /orgs/{org}/members/{user}`. Mentions from non-members are marked read
  and dropped — on a public repo anyone can tag the bot, but only the co-op can
  drive it. This is the requester-authorization rule above, applied to GitHub.
  (The bot account should itself be an **org member** so this endpoint can see
  *concealed* members; an outside collaborator only sees public members and
  would wrongly reject private ones.)
- **Off by default.** Set `GITHUB_MENTIONS_ENABLED=true` to turn it on. The PAT
  additionally needs `Notifications` access and `read:org` (org membership);
  the account should be a **dedicated bot account**, since the notifications
  API reports mentions of the *authenticated user*. Optionally pin the bot's
  handle with `GITHUB_BOT_LOGIN` (else it's resolved via `GET /user` on start).
- Replies are public, on-the-record org statements — same tone/discipline as
  the rest of this file. The agent runs as a non-main group (no `rules/` mount;
  it reads `groups/global/CLAUDE.md`).

## Setup checklist (operator)

1. On the assistant's GitHub account, create a **fine-grained PAT** scoped to
   the org's GitHub organization (`githubOrg`) with the permissions listed under Scope.
2. Add to `.env`: `GITHUB_PERSONAL_ACCESS_TOKEN=github_pat_...`
   (store via the OneCLI vault per `CLAUDE.md`; never commit).
3. Rebuild the agent container (`./container/build.sh`) so the binary is
   present, then deploy via the standard push → merge → deploy flow.
4. *(Optional — inbound @-mentions)* Grant the PAT `Notifications` + `read:org`,
   set `GITHUB_MENTIONS_ENABLED=true` (and optionally `GITHUB_BOT_LOGIN`), and
   restart the orchestrator. No container rebuild needed — the poller runs
   host-side in the orchestrator, not in the agent container.
