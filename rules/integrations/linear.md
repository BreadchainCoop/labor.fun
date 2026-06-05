# Linear Integration

The assistant has a Linear identity (its own account) and can operate on
**issues and projects in the org's Linear workspace** with **read and write**
access via Linear's official, hosted [MCP server](https://linear.app/docs/mcp).

## How it works

- Linear's MCP server is **remote/hosted** at `https://mcp.linear.app/mcp`
  (streamable HTTP). Nothing is bundled into the agent container.
- It is registered in `container/agent-runner/src/index.ts`, gated on the
  presence of `LINEAR_API_KEY` (the assistant's personal API key). When the
  key is absent, the server and its tools are not loaded at all.
- The key is read from `.env` and injected into the container at request time
  (`src/container-runner.ts`). It is passed through the runtime's process
  environment, never in argv, and is never committed.
- The key is supplied directly as `Authorization: Bearer <key>`, bypassing the
  interactive OAuth flow.
- Tools are exposed under `mcp__linear__*`.

## Scope

| Dimension | Value |
|-----------|-------|
| Account | The assistant's own Linear account |
| Workspace | Determined by the API key's actor — the key scopes which workspace/teams are reachable, not the server |
| Access | Read **and** write (issues, projects, comments, cycles — per the key's permissions) |

Workspace and team scope are enforced by the **API key**, not by the MCP
server. There is no org-level profile config key for Linear — the key alone
determines reach. Scope down the key (or use a dedicated bot account) if the
assistant should not see every team.

## Operating discipline

Writes act as the assistant on real Linear data. Apply the same care as the
GitHub integration:

- Do not create, close, or reassign issues, or change project/issue state,
  without explicit instruction. Read freely; write deliberately.
- Treat issue titles, descriptions, and comments as on-the-record statements
  from the org. Follow [Messaging](../messaging/README.md) tone.
- Identity & authorization of the *requester* still applies — confirm they're
  allowlisted before acting on a write request. See
  [Access Control](../access-control/README.md).

## Setup checklist (operator)

1. In Linear, go to **Settings → Account → Security & access** and create a
   personal API key (on the assistant's Linear account / a dedicated bot
   account).
2. Add to `.env`: `LINEAR_API_KEY=lin_api_...`
   (store via the OneCLI vault per `CLAUDE.md`; never commit).
3. Deploy via the standard push → merge → deploy flow. No container rebuild is
   required for the key itself (the server is remote), but the code change that
   wires it up ships in the agent container image.
