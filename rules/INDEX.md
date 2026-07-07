# Assistant Rules Index

Operational rules, access control policies, and process definitions. The assistant reads these at runtime to determine how to handle requests. Each rule file is self-contained with cross-links to related rules.

## How the assistant Uses These Rules

When the assistant starts a conversation, it reads the relevant rules based on context:
- **Every interaction**: [Access Control](access-control/README.md), [Privacy Policy](access-control/privacy-policy.md), [Voice & Register](identity/voice.md)
- **KB operations**: [Knowledge Base](knowledge-base/README.md) and its sub-rules
- **Cross-channel requests**: [Messaging](messaging/README.md)
- **Answering from a specific doc/page/item**: [Citations](messaging/citations.md) — append a Sources block
- **Task scheduling**: [Scheduling](scheduling/README.md)
- **Identity questions**: [Identity & RBAC](identity/README.md)
- **Transcript processing**: [Transcripts](transcripts/transcripts.md)
- **Proposing a consequential action (gated write, external message, payout, …)**: [Approvals](approvals/README.md)
- **Needs deploy/operator access or a human decision**: [Escalation](escalation.md)
- **Shipping / "is it live?" / deploy questions**: [Deployment](deployment.md)
- **Multi-step work / cloning repos / where files persist**: [Runtime Environment](runtime-environment.md)
- **GitHub operations**: [GitHub Integration](integrations/github.md)
- **Linear operations**: [Linear Integration](integrations/linear.md)
- **Reading Discord channel history**: [Discord Integration](integrations/discord.md)

## Directory

| Rule Set | Path | When to Read |
|----------|------|-------------|
| [Access Control](access-control/README.md) | `rules/access-control/` | Every interaction — confirm requester is allowlisted |
| [Privacy Policy](access-control/privacy-policy.md) | `rules/access-control/privacy-policy.md` | Before sharing ANY KB content |
| [Capability Matrix](access-control/role-matrix.md) | `rules/access-control/role-matrix.md` | Allowlisted vs unknown — what each can do |
| [Knowledge Base](knowledge-base/README.md) | `rules/knowledge-base/` | Any KB read/write operation |
| [Task Management](knowledge-base/tasks.md) | `rules/knowledge-base/tasks.md` | Creating, updating, or querying tasks |
| [Storage Systems](knowledge-base/storage.md) | `rules/knowledge-base/storage.md` | Understanding markdown KB vs SQLite DB |
| [Document Format](knowledge-base/document-format.md) | `rules/knowledge-base/document-format.md` | Creating or editing any KB document |
| [Request Logging](knowledge-base/request-logging.md) | `rules/knowledge-base/request-logging.md` | After every interaction |
| [Close the Loop](knowledge-base/close-the-loop.md) | `rules/knowledge-base/close-the-loop.md` | Every reply — ensure actionable info is written to KB |
| [Messaging](messaging/README.md) | `rules/messaging/` | Formatting output, cross-channel sends |
| [Channel Formatting](messaging/channel-formatting.md) | `rules/messaging/channel-formatting.md` | Before sending any message |
| [Citations](messaging/citations.md) | `rules/messaging/citations.md` | Any answer drawn from a specific KB doc, web page, or GitHub/Linear item — cite the source |
| [Cross-Channel Send](messaging/cross-channel.md) | `rules/messaging/cross-channel.md` | When asked to message someone on another platform |
| [Scheduling](scheduling/README.md) | `rules/scheduling/` | Task scheduling, scripts, cron |
| [Escalation](escalation.md) | `rules/escalation.md` | A request needs deploy/operator access or a human decision the assistant can't make |
| [Deployment](deployment.md) | `rules/deployment.md` | Shipping changes, "is it live?", how auto-deploy works (merge -> auto-deploy, no manual step) |
| [Runtime Environment](runtime-environment.md) | `rules/runtime-environment.md` | Multi-step/multi-turn work — `/tmp` is ephemeral per turn; clone repos under `/workspace/group/.work` |
| [Identity & Allowlist](identity/README.md) | `rules/identity/` | Resolving who is asking; allowlisted vs unknown |
| [Voice & Register](identity/voice.md) | `rules/identity/voice.md` | Every message — peer/co-op tone, shared-mirror not scoreboard |
| [Platform Identities](identity/platform-identities.md) | `rules/identity/platform-identities.md` | Resolving cross-platform users |
| [Transcripts](transcripts/transcripts.md) | `rules/transcripts/` | Meeting transcript processing, action item extraction, HTML slideshow generation |
| [Transcript Task Approval](transcripts/task-approval.md) | `rules/transcripts/task-approval.md` | Approval gate for tasks proposed from meeting transcripts |
| [Approvals](approvals/README.md) | `rules/approvals/` | The reusable human-in-the-loop approval primitive — gated action classes, who approves, expiry, living-FAQ capture |
| [Expenses](finance/expenses.md) | `rules/finance/` | Any time a user mentions money, spending, reimbursement, or receipts |
| [GitHub Integration](integrations/github.md) | `rules/integrations/` | Any GitHub operation — issues, PRs, code, Actions on the org's GitHub org (`githubOrg`) |
| [Linear Integration](integrations/linear.md) | `rules/integrations/` | Any Linear operation — issues, projects, comments in the org's Linear workspace |
| [Discord Integration](integrations/discord.md) | `rules/integrations/` | Reading a Discord channel's past messages (`fetch_discord_history`), registered vs. unregistered channels |
| [Operational Reports](integrations/operational-reports.md) | `rules/integrations/` | Recurring leadership readout — what's late, load vs. capacity, bottlenecks; member-profile capacity fields |
