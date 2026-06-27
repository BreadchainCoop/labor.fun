---
name: github-content-merge
description: Semi-automated, content-only PR review/merge for a docs repo, plus idle-branch merge-assist nudges. Use when running the scheduled github-content-merge gate tasks, or when asked to review/merge a documentation-content PR. Acts only on content (src/content/**.{md,mdx}); code changes always go to a human.
---

# github-content-merge

An agentic alternative to a CI auto-merge bot. Two scheduled tasks poll a docs
repo with a cheap **script gate** (`scripts/gate.mjs`) and only wake the agent
when there's something to do. The build stays on the repo's own checks (e.g.
Netlify) — this skill only **reads** check results and acts on the result.

**Scope is strict: only content.** A PR is auto-mergeable **only** if every
changed file is a content document — `src/content/**/*.md` or `*.mdx`. Anything
else (including `_meta.yml` sidebar/nav files, `astro.config.*`,
`keystatic.config.*`, other `src/`, `public/**`, `package.json`, configs) is a
**code** change and is left for a human.

> Default `mode` is **`watch`** — detect and report only, no merges/DMs. Flip to
> `live` in config when you're ready (see Setup). Watch and live run the exact
> same logic; only the final actions differ.

## Configuration

Copy `config.example.json` → `config.json` (or point `$GITHUB_CONTENT_MERGE_CONFIG`
at one) and edit. Fields: `repo`, `mode` (`watch`|`live`), `contentPaths`,
`contentExtensions`, `requiredChecks`, `mergeMethod`, `branchPrefix`,
`idleMinutes`, `maintainer`, `consentOptoutPath`, `statePath`.

The defaults target `BreadchainCoop/bread-docs` and reflect its `main` ruleset:
**merge-commit only** (`mergeMethod: "merge"`) and required checks
`netlify/bread-docs/deploy-preview`, `Redirect rules - bread-docs`,
`Header rules - bread-docs` (strict, up-to-date policy — see below).

## How it runs

Two scheduled tasks, each with a `script` gate that prints
`{ "wakeAgent": bool, ... , "candidates": [...] }`:

- **Workflow A — idle-branch nudge** — `node ${CLAUDE_SKILL_DIR}/scripts/gate.mjs --mode=idle-branches` (~every 20 min)
- **Workflow B — content-PR review/merge** — `node ${CLAUDE_SKILL_DIR}/scripts/gate.mjs --mode=content-prs` (~every 15 min)

When woken, you receive the gate's `candidates` plus `dryRun` (true in watch
mode), `maintainer`, `mergeMethod`, and `requiredChecks`. **Re-verify
everything yourself before acting** — the gate is a cheap pre-filter, you are
the authority.

## Workflow A — idle-branch merge assist

For each candidate branch (idle > `idleMinutes`, no open PR, not already nudged):

1. Resolve the author → a person. Prefer the branch HEAD **commit author login**
   (`candidate.author`); map GitHub login → person via the people files. Do
   **not** trust the branch name alone (Keystatic only guarantees the prefix).
2. **Consent check:** if the person has opted out of merge-assist DMs (see
   `consentOptoutPath`), skip them.
3. DM the author offering help: their Keystatic edits look paused — do they want
   you to open a PR and merge when ready? If they say go, create the PR (then
   Workflow B takes over review/merge).
4. If they reply "stop"/"don't message me about this," record an opt-out and
   never nudge them again.
5. Record the nudge in state (keyed by branch + HEAD sha) so you don't re-ping
   the same idle episode; re-arm only when new commits land.

## Workflow B — content-PR review & merge

For each candidate PR (the gate already filtered to **content-only**):

1. **Re-confirm content-only.** Re-list the PR files; every path must be
   `src/content/**/*.{md,mdx}`. One non-matching file → **escalate** (step 5), do
   not merge.
2. **Re-confirm required checks.** Every `requiredChecks` context must be
   success/neutral. Any failing/pending → if failing, **escalate**; if merely
   pending, leave it for the next cycle.
3. **Light review.** Sanity-check the diff: plausible documentation content, no
   secrets/keys, no surprising mass-deletion, frontmatter intact, nothing
   suspicious. Concern → **escalate**.
4. **Handle the strict up-to-date rule.** `main` requires PR branches to be up to
   date. If the PR's `mergeable_state` is `behind`, **update the branch**
   (`update_pull_request_branch`), then **stop** — let the next cycle re-merge
   once checks re-run. Do not merge a behind branch.
5. **Merge or escalate.**
   - Clean (content-only + checks green + up-to-date + no concerns) → **merge
     using `mergeMethod` (`merge` = a standard merge commit — never squash)**,
     comment the result, and record the PR + HEAD sha in state.
   - **Any** concern (non-content file, failing check, conflict/`dirty`,
     suspicious diff, ambiguity, or a merge API error) → **do not merge**.

## Escalation (always this shape)

On any issue found in review, any check/workflow failure, a merge error, or when
you or the editor needs guidance:

1. **Post a PR comment that @-mentions the `maintainer`** (primary) with the
   specific reason.
2. **DM the maintainer a link to that PR comment.**

Record the escalation in state (PR + HEAD sha) so you don't repeat it until the
PR changes.

## Watch mode (default)

When `dryRun` is true, run the **identical** evaluation but **do not** call
`merge_pull_request`, `update_pull_request_branch`, `dm_user`, or post comments.
Instead, for each decision emit a line: `WOULD <action> #<pr/branch> — <reasons>`
and post a single concise **digest** of all "WOULD" decisions to the maintainer.
Going live is a one-line config change (`mode: "live"`); nothing else changes.

**State semantics:** in watch mode, record only *observations* (what you saw),
kept separate from the live *acted* set, so flipping to live neither skips a real
backlog nor acts on a stale pile. Flip when the watch digest is clean/empty.

## State & idempotency

Keep a small JSON store at `statePath` with `{ nudged: {branch: sha}, handled:
{prNumber: sha} }`. The gate reads it to avoid re-surfacing the same unchanged
work; you write to it after each action (or "would-action" in watch mode, in the
separate observations namespace).

## Setup

1. Copy `config.example.json` → `config.json`; set `repo`, `maintainer`, and keep
   `mode: "watch"` to start.
2. Register the two tasks (off-round minutes to avoid fleet pile-ups):
   - `schedule_task` cron `19,39,59 * * * *` → prompt: *"Run github-content-merge
     Workflow A. Follow the github-content-merge skill."*, `script`:
     `node ${CLAUDE_SKILL_DIR}/scripts/gate.mjs --mode=idle-branches`
   - `schedule_task` cron `7,22,37,52 * * * *` → prompt: *"Run
     github-content-merge Workflow B. Follow the github-content-merge skill."*,
     `script`: `node ${CLAUDE_SKILL_DIR}/scripts/gate.mjs --mode=content-prs`
3. Watch the digests. When they look right, set `mode: "live"`.

## Tests

Pure gate helpers are unit-tested in `tests/gate.test.mjs`
(`isContentOnly`, `isIdle`, `requiredChecksState`, `parseBranchUser`). Run with
`npx vitest run container/skills/github-content-merge/tests`.
