---
title: Bread Cooperative — Organization Overview
created_by: Ron
created_at: 2026-05-25
visibility: open
editable_by: admins
tags: [org, identity, canonical]
---

# Bread Cooperative

## Canonical name

The organization is **Bread Cooperative** (also written **Bread Co-op** or
**bread.coop**). When you refer to the org in conversation, in messages, in
new KB documents, or in tasks, always use **Bread Cooperative**.

**`BreadchainCoop` is the GitHub organization handle**
(`github.com/BreadchainCoop`) — that's a code-hosting identifier, not the
name of the org. Do NOT call the organization "Breadchain", "Breadchain
Coop", or "BreadchainCoop" in user-facing text. Those are legacy/handle
strings; the brand is **Bread Cooperative**.

If a user themselves writes "Breadchain", treat it as referring to Bread
Cooperative (don't correct them mid-conversation), but still produce
"Bread Cooperative" in your own outputs.

## Authoritative sources

When you need details about the org (mission, products, governance,
membership, $BREAD token, etc.), prefer these in order:

1. **Docs site** — <https://docs.bread.coop/>
2. **Blog / publications** — <https://paragraph.com/@breadcoop>
3. **GitHub org** — <https://github.com/BreadchainCoop> (code only)

Fetch these with your browser tools (`agent-browser open <url>` then
`agent-browser snapshot`) rather than guessing. If you learn something
durable from those sources that other agents would benefit from,
expand this file rather than creating a parallel overview document.

## At a glance

- **What it is**: a worker- and member-governed cooperative building
  public-goods funding infrastructure on Ethereum / Gnosis Chain.
- **Primary product**: **$BREAD**, a yield-bearing community currency
  whose yield is directed to post-capitalist / public-goods projects
  voted on by holders.
- **Where it lives**: docs at docs.bread.coop, code at
  github.com/BreadchainCoop, community on Discord (this server).

The above is a seed summary — confirm specifics against the
authoritative sources before quoting numbers, dates, or governance
mechanics to a user.

## For the agent

- This file exists because earlier versions of you hallucinated the
  org name as "Breadchain" — a string only present in the GitHub
  handle. Read this file first whenever a user asks "what is this
  org / what do you do / what's bread.coop".
- If a fact here turns out to be wrong, **fix it in place** — call
  `modify_kb_file` with `path: "artifacts/org-overview.md"` (KB-relative;
  the shared-KB mount at `/workspace/shared-kb/` is read-only, so direct
  filesystem writes will fail). Don't fork a second overview document.
