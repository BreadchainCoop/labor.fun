---
name: admin-email
description: Triage administrative email forwarded to the assistant's inbox into GitHub issues. Use when a scheduled task asks you to process admin email, or when asked to triage/check the admin inbox — read new forwarded mail via the gws gmail tool, classify it, open an issue for anything actionable, notify the owner, and label it triaged so it's never processed twice.
---

# Administrative email triage

The org has set an **auto-forward rule**: administrative mail (grant forms,
legal, partnerships, finance) is forwarded to the assistant's own Gmail. Your
job is to turn that inbox into tracked, owned work instead of letting it die in
someone's personal inbox.

You have the `gws` Google Workspace tools (`mcp__gws__*`, gmail included) and
the GitHub MCP (`mcp__github__*`). Use `gws_discover` (or the gmail tool's
discovery) to find the exact list / get / modify-labels operations.

## Idempotency — read this first

Never create two issues for the same email. The processed-marker is a Gmail
label, **`triaged`**:

1. Only fetch messages that are **in the inbox and NOT labelled `triaged`**
   (e.g. a query like `in:inbox -label:triaged`).
2. Process each one fully.
3. **Apply the `triaged` label** (create it if it doesn't exist) — and archive
   or mark read — the moment you've filed its issue. If you can't apply the
   label, do NOT file the issue (better to retry next run than double-file).

If there are no untriaged messages, do nothing and wrap any output in
`<internal>` so the channel stays quiet.

## For each new email

1. **Unwrap the forward.** The message is a forward from the admin address — pull
   out the *original* sender, subject, date, and body. Quote key specifics
   (amounts, names, links, dates) rather than paraphrasing them away.
2. **Classify** into one of: `grant-action`, `legal`, `partnership`, `finance`,
   `event`, `other`, or `noise`. `noise` = newsletters, receipts, spam, pure
   FYI with no action — label it `triaged` and move on, no issue.
3. **Extract a deadline** if the email implies one (form due date, response-by,
   meeting date). Note it explicitly; the org's deadline reminders pick up
   issues with due dates.
4. **Open a GitHub issue** (`mcp__github__*`) in the repo named in the task
   prompt:
   - Title: short and specific, e.g. `Grant action: <funder> application due <date>`.
   - Body: what's needed and by when, the original sender, any links, and a note
     that it was auto-filed from a forwarded admin email. Do **not** paste full
     legal/financial documents — summarize and link.
   - Labels: the category (+ `admin-email`).
5. **Suggest + notify an owner.** Pick the most likely owner from the shared-KB
   people files (role/skills) or the routing notes in
   `/workspace/shared-kb/admin-email/config.md` if present. `dm_user` them with
   a one-line heads-up and the issue link. If you genuinely can't tell, leave
   the issue unassigned and say so in the channel summary so a human routes it.
6. **Mark triaged** (step 3 of idempotency).

## Finish

Post one concise line per filed issue to the channel the task runs in
(`📨 Filed <issue link> — <category>, owner <name>`), or stay silent via
`<internal>` if nothing was actionable.

## Safety

- Never reply to, forward, or delete the source emails — you only read and
  label them.
- Never fabricate an issue or a sender. If the gmail or GitHub tool fails, say
  so plainly and leave the email untriaged so the next run retries.
- Treat contents as sensitive: summarize, link, and route — don't republish
  full personal/financial details into a public issue or channel.
