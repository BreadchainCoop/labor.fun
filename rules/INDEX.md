# Assistant Rules Index

Operational rules, access control policies, and process definitions. The assistant reads these at runtime to determine how to handle requests. Each rule file is self-contained with cross-links to related rules.

## How the assistant Uses These Rules

When the assistant starts a conversation, it reads the relevant rules based on context:
- **Every interaction**: [Access Control](access-control/README.md), [Privacy Policy](access-control/privacy-policy.md)
- **KB operations**: [Knowledge Base](knowledge-base/README.md) and its sub-rules
- **Cross-channel requests**: [Messaging](messaging/README.md)
- **Task scheduling**: [Scheduling](scheduling/README.md)
- **Identity questions**: [Identity & RBAC](identity/README.md)
- **Transcript processing**: [Transcripts](transcripts/transcripts.md)
- **GitHub operations**: [GitHub Integration](integrations/github.md)
- **Notion operations**: [Notion Integration](integrations/notion.md)

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
| [Cross-Channel Send](messaging/cross-channel.md) | `rules/messaging/cross-channel.md` | When asked to message someone on another platform |
| [Scheduling](scheduling/README.md) | `rules/scheduling/` | Task scheduling, scripts, cron |
| [Identity & Allowlist](identity/README.md) | `rules/identity/` | Resolving who is asking; allowlisted vs unknown |
| [Platform Identities](identity/platform-identities.md) | `rules/identity/platform-identities.md` | Resolving cross-platform users |
| [Transcripts](transcripts/transcripts.md) | `rules/transcripts/` | Meeting transcript processing, action item extraction, HTML slideshow generation |
| [Transcript Task Approval](transcripts/task-approval.md) | `rules/transcripts/task-approval.md` | Approval gate for tasks proposed from meeting transcripts |
| [Expenses](finance/expenses.md) | `rules/finance/` | Any time a user mentions money, spending, reimbursement, or receipts |
| [GitHub Integration](integrations/github.md) | `rules/integrations/` | Any GitHub operation — issues, PRs, code, Actions on the org's GitHub org (`githubOrg`) |
| [Notion Integration](integrations/notion.md) | `rules/integrations/` | Any Notion operation — reading/writing pages and databases shared with the assistant's integration |
