---
name: faq-capture
description: Turn a resolved chat question into a living-FAQ knowledge-base card, idempotently, gated by the human-in-the-loop approval primitive. Use whenever you've just given someone a clear, reusable answer worth remembering.
default: false
---

# Living FAQ Capture

When a question in chat gets a clear, reusable answer — the kind of thing
someone else will ask again in a month — capture it as an FAQ card under
`artifacts/faq/` instead of letting the answer evaporate into scrollback.

This is opt-in per org (`ENABLED_SKILLS`). If you don't see this skill listed,
don't do any of the below.

## When to capture (use judgment)

Capture when the exchange was a genuine question with a durable answer:
"how do I...", "what's the process for...", "where do I find...", "why does...".

Do **not** capture:
- One-off, person-specific requests ("can you send me the Q3 numbers")
- Anything that touches private/restricted information (see
  `rules/access-control/privacy-policy.md`) — an FAQ card defaults to `open`
  visibility and is meant to be broadly readable
- Small talk, status updates, or anything without a real question+answer shape
- A question you couldn't actually answer — see "Knowledge gaps" below instead

## Step 1 — compute the deterministic slug (idempotency key)

Two different phrasings of the same question must land on the **same** card
so re-asking updates it instead of creating a duplicate. Derive the slug
yourself, exactly like this (mirrors `src/faq-capture.ts` `faqSlug`, which is
unit-tested — match it precisely):

1. Unicode-normalize (NFKD) and strip diacritics.
2. Lowercase.
3. Drop apostrophes/quotes (`'`, `’`, `"`, `` ` ``) — `"don't"` and `"dont"`
   must collide.
4. Replace every remaining run of non `[a-z0-9]` characters with a single `-`.
5. Trim leading/trailing `-`.
6. Cap at 80 characters, re-trimming a trailing `-` if the cut landed on one.
7. Empty result → `faq`.

The card path is always `artifacts/faq/<slug>.md`.

## Step 2 — check for an existing card (idempotent update, not duplicate)

Read `/workspace/shared-kb/artifacts/faq/<slug>.md` (read-only mount). If it
exists, compare its title + body against what you're about to write:

- Same question title **and** the new answer/source text is already present
  in the existing body → **no-op**. Don't request approval, don't write
  anything. Tell the user (if relevant) that this is already documented.
- Different or missing → proceed to Step 3 with an **update**, not a fresh
  card (same path, so it overwrites rather than duplicating).

## Step 3 — request approval for the write (`kb_write`)

Call `request_approval` with:

- `action_class`: `"kb_write"`
- `summary`: one line — the question being captured, e.g. `FAQ: capture "How do I deploy?"`
- `payload`: `{ "file_path": "artifacts/faq/<slug>.md", "content": "<full rendered card>" }`
- `dedupe_key`: the slug (e.g. `faq-how-do-i-deploy`) — so re-triggering the
  same capture before it's resolved reuses the pending request instead of
  spamming a second prompt.

Render the card content as YAML frontmatter + markdown body:

```yaml
---
title: "<question, verbatim>"
created_by: labor.fun
created_at: <YYYY-MM-DD>
visibility: open
editable_by: open
tags: [faq]
---
```
```
# <question>

<answer>

**Source:** <who/where the answer came from — a person, message, or doc>
```

`kb_write` is **not** in the default gated set (see
`rules/approvals/README.md`) — most orgs will see `request_approval` respond
"not gated, proceeding" immediately, in which case skip straight to Step 4. An
org that adds `kb_write` to its `gatedActionClasses` gets a real human
sign-off prompt first; wait for the outcome message before writing anything.

## Step 4 — write it

Once you're clear to proceed (either an immediate "not gated" response, or an
"Approved" resolution), call `modify_kb_file` with the exact `file_path` and
`content` from your payload. Don't improvise a different path or re-render
the content — write back precisely what was approved.

If the request was **rejected** or sent back for **revision**, don't write
anything; read the notes and, for a revision, redo Steps 1-3 with the
corrected content (same slug/path).

## Knowledge gaps

If you could **not** answer a question well, don't fabricate an FAQ card.
Instead append a short bullet to `artifacts/faq/_gaps.md` (via
`modify_kb_file`, no approval needed — it's an append-only note, not a
published answer) so a human can follow up: the question, who asked, and the
chat/date. This is a knowledge gap log, not gated by `request_approval`.

## Related

- Deterministic contract + tests: `src/faq-capture.ts`, `src/faq-capture.test.ts`
- Approval primitive: `rules/approvals/README.md`, `src/ipc.ts`
  (`request_approval` / `resolve_approval`)
- KB write mechanics: `container/skills/kb-operations/SKILL.md`
