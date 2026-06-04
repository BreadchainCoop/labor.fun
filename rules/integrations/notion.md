# Notion Integration

The assistant has its own Notion identity (an **internal integration**) and can
**read and write** the Notion pages and databases that have been shared with it,
via the official
[`@notionhq/notion-mcp-server`](https://github.com/makenotion/notion-mcp-server),
bundled in the agent container.

## How it works

- The container ships `@notionhq/notion-mcp-server` (see `container/Dockerfile`,
  pinned on the global npm install line). It runs as a stdio MCP server.
- It is gated on the presence of `NOTION_TOKEN` (the assistant's internal
  integration token). When the token is absent, the server and its tools are
  not loaded at all.
- The token is read from `.env` and injected into the container at request time
  (`src/container-runner.ts`). It is never placed in the container argv and
  never committed.
- Tools are exposed under `mcp__notion__*`.

## Scope

| Dimension | Value |
|-----------|-------|
| Identity | The assistant's own Notion internal integration |
| Reach | Only the pages/databases explicitly **shared** with the integration; enforced by Notion's sharing model, not the server |
| Access | Read **and** write |

Scope is enforced by what a workspace admin shares with the integration — the
server itself imposes no boundary. To widen or narrow reach, change which pages
and databases are connected to the integration in Notion; do not assume the
assistant can see a page just because a human can.

## Operating discipline

Writes act as the assistant on real, shared Notion content. Apply the same care
as for the GitHub and deployment rules:

- Treat page/comment content as on-the-record statements from the org. Follow
  [Messaging](../messaging/README.md) tone.
- Do **not** delete pages or databases, or overwrite substantial existing
  content, without explicit instruction from an allowlisted user. Prefer
  appending or creating new pages over destructive edits.
- Identity & authorization of the *requester* still applies — confirm they're
  allowlisted before acting on a write request. See
  [Access Control](../access-control/README.md).

## Setup checklist (operator)

1. Create an **internal integration** at
   <https://www.notion.so/my-integrations> and copy its token (`ntn_...`).
2. In Notion, **share** each page/database the assistant should access with the
   integration (the `•••` menu → Connections → add the integration).
3. Add to `.env`: `NOTION_TOKEN=ntn_...` (store via the OneCLI vault per
   `CLAUDE.md`; never commit).
4. Rebuild the agent container (`./container/build.sh`) so the server is
   present, then deploy via the standard push → merge → deploy flow.
