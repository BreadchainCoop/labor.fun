# GitHub Integration

Breadbrich Engels has a GitHub identity (his own account) and can operate on
**all BreadchainCoop repositories** with **read and write** access via the
official [`github-mcp-server`](https://github.com/github/github-mcp-server),
bundled in the agent container.

## How it works

- The container ships the pinned `github-mcp-server` binary (see
  `container/Dockerfile`, `ARG GITHUB_MCP_SERVER_VERSION`).
- It runs as a stdio MCP server, gated on the presence of
  `GITHUB_PERSONAL_ACCESS_TOKEN` (Breadbrich's PAT). When the token is
  absent, the server and its tools are not loaded at all.
- The token is read from `.env` and injected into the container at request
  time (`src/container-runner.ts`). It is never committed.
- Tools are exposed under `mcp__github__*`.

## Scope

| Dimension | Value |
|-----------|-------|
| Account | Breadbrich's own GitHub account |
| Repositories | All BreadchainCoop repos (enforced by the PAT, not the server) |
| Access | Read **and** write |
| Toolsets enabled | `context`, `repos`, `issues`, `pull_requests`, `actions`, `projects` |

Disabled by design (not in the enabled toolsets): org/team admin, user
management, security/Dependabot/secret-scanning, gists, notifications,
discussions, experiments. Add a toolset in
`container/agent-runner/src/index.ts` only with explicit approval.

Repo scope is enforced by the **fine-grained PAT**, not by the MCP server.
The PAT must be a fine-grained token authorized for the BreadchainCoop
organization with: Contents (RW), Issues (RW), Pull requests (RW),
Actions (read), Metadata (read).

For the `projects` toolset (GitHub Projects V2 — add issues/PRs to a
project, update project item field values), the PAT additionally needs
**organization-level** `Projects (RW)` permission. Without it the
`projects_*` tools will return GraphQL permission errors even though
the toolset is loaded.

## Operating discipline

Writes act as Breadbrich on real repositories. Apply the same care as the
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

## Setup checklist (operator)

1. On Breadbrich's GitHub account, create a **fine-grained PAT** scoped to
   the BreadchainCoop organization with the permissions listed under Scope.
2. Add to `.env`: `GITHUB_PERSONAL_ACCESS_TOKEN=github_pat_...`
   (store via the OneCLI vault per `CLAUDE.md`; never commit).
3. Rebuild the agent container (`./container/build.sh`) so the binary is
   present, then deploy via the standard push → merge → deploy flow.
