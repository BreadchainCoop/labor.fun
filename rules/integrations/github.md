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
