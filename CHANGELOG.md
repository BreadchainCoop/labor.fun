# Changelog

All notable changes to labor.fun will be documented in this file.

## [Unreleased]

- Added an **external-facing membership-intake channel** (#30, part 1). Designate a public channel via `MEMBERSHIP_CHANNEL` and the general assistant is **suppressed** there — replaced by a sandboxed intake flow (`src/chat-flows/membership-intake.ts`). The channel is treated as **untrusted**: the run is forced **non-privileged regardless of `FLAT_ACCESS`** (sandboxed mounts, no DB, shared-KB read-only), restricted to a **read-only tool set** (`Read`/`Glob`/`Grep`/`WebFetch` — no Bash/Write/Edit, no `mcp__nanoclaw__*`/GitHub/Workspace), and runs an **injection-hardened intake persona** (system-prompt append). It accepts messages from unknown senders (allowlist drop bypassed for this channel) and has **no write path of its own**; when a prospective contributor clearly opts in, the agent emits a sentinel, and the **privileged orchestrator** files a membership-interest record (attributed to the *real* sender, never agent-provided) under `context/memberships/` and notifies onboarding (`MEMBERSHIP_NOTIFY_JID`, default shared-KB group). Defense in depth: IPC from a membership channel is ignored entirely. New per-run `ContainerInput.allowedTools` / `systemPromptAppend` (requires a container rebuild to ship). The internal 6-month signer-milestone slice of #30 is a planned follow-up.
- Refactored membership intake into a **pluggable chat-flow extension point** (`src/chat-flows/registry.ts`). Chat flows are a generic mechanism for sandboxed, assistant-suppressing takeovers of external channels — exposed to profile plugins via `registerChatFlow` in the `PluginApi` — and the orchestrator's allowlist exemption and IPC hardening now key off the registry instead of membership-specific config. Membership intake is the first registered flow; no behavior change. Docs: `docs/PLUGINS.md` (§2b).
- Added **recurring operational reports** (#34) — a leadership-facing readout of operational state so it stops being asked for ad-hoc. A new deterministic loop (`src/integrations/operational-report.ts`) builds, from the same KB task graph the PM layer uses (reusing `classify()`) plus declared member capacity, a report covering: **what's late** grouped by team and by person, **bottlenecks** (blocking work), and **load vs. capacity** per member with a *soft* over-capacity flag. Pure analysis + markdown render live in `src/operational-report.ts` (table-tested); capacity is read from optional people-profile frontmatter (`team`, `expected_hours_per_week`, `capacity_points`, `pay_parity_note`) by `src/member-profiles.ts`. The issue's open questions are resolved as configurable defaults: **audience** via `OPS_REPORT_AUDIENCE` (`leaders` = full per-person detail to a private channel, default; `coop` = team aggregates, no per-person hours); **hours verification** — capacity is self-declared and every figure is labelled "declared, not verified", overload is only ever a soft flag and never raised without a declared capacity; **effort estimation** — route (a), the optimistic `estimate` is summed and humans correct it after the fact. Unlike PM orchestration this never wakes the agent, so it costs **no API spend**. The loop sweeps on `OPS_REPORT_INTERVAL_MS` (daily default) but posts **at most once per period** (`OPS_REPORT_PERIOD`: weekly/monthly) via a new `ops_report_log` table; a rolling copy is always written to `context/operational-report.md`. Tunable via `OPS_REPORT_*` env vars (`OPS_REPORT_INTERVAL_MS=0` disables). Orchestrator-side only; no container rebuild required. Docs: `rules/integrations/operational-reports.md`.
- **PM orchestration: chat trigger + unassigned-work handling** (#31). The routine can now be **triggered on demand from chat** — an allowlisted user saying "run pm orchestration" / "/pm" runs the same deterministic brief + agent run in that chat (`isPmCommand` interception in `processGroupMessages`, sharing a new `buildPmRun` helper with the scheduled loop). And overdue/blocking work with **no assignee** is no longer dropped: the brief now has an "Unassigned — needs an owner" section, and the agent (per the updated skill) finds/assigns an owner or raises it to a configurable **`PM_LEAD`** + the channel. Adds the `pm-preview` dry-run note.
- Added **PM orchestration on top of GitHub** (#31), in two parts. **(1) Dependency-edge sync:** the GitHub→KB sync now pulls issue **blocked-by / blocking** relations (GA in GraphQL) and **sub-issue parent/child** edges (behind the `GraphQL-Features: sub_issues` header), mapping them onto the hand-authored task schema's `upstream` / `downstream` frontmatter so the dependency graph spans synced + hand-authored tasks; it also surfaces an `estimate` (a ProjectV2 number field) and `gh_parent` / `gh_sub_issues`. Edge ids derive from the *target's* repo so cross-repo/cross-org edges resolve; unreadable/dangling targets are dropped/tolerated; the query degrades gracefully (`GITHUB_SYNC_ISSUE_DEPS`, default on) on instances lacking the fields. **(2) Agent-driven loop:** a new weekly integration (`src/integrations/pm-orchestration.ts`) does a cheap deterministic pre-pass (`src/pm-orchestration.ts` — `classify`/`dmCandidates`/`buildPmBrief`, pure & table-tested) over the task graph to find what's blocked / blocking others / overdue / due-soon + per-owner load, and **only when there's something to act on** wakes the container agent (reusing the scheduler's `runContainerAgent` + queue) with a structured brief. Guided by a new `pm-orchestration` container skill, the agent **acts optimistically** — applies re-estimates / deadline / status changes via `modify_kb_file` + `mcp__github__*`, then **DMs the people on the critical path** (blockers, overdue owners) via `dm_user` to confirm rather than asking first. A `pm_dm_log` table + `PM_DM_COOLDOWN_MS` throttle prevents re-pinging the same person about the same task within the window. Tunable via `PM_*` env vars (weekly default; `PM_ORCHESTRATION_INTERVAL_MS=0` disables). No agent run (no API spend) happens when the brief is empty. Orchestrator-side; the skill ships on deploy. Also adds a read-only **`npm run pm-preview [filter]`** that fetches live GitHub data via the new edge sync, runs the deterministic pre-pass, and prints the brief + who-it-would-DM — without writing the KB, DMing, or running the agent — for validating against a real project (e.g. `pm-preview crowdstake`).
- Added a **generalized escalating-deadline reminder engine** (#25). Any deadline-bearing item that yields `{ id, title, deadline, owners, escalationContact?, status? }` plugs into one primitive (`src/reminder-engine.ts`): a periodic sweep fires reminders on a tightening ladder as the deadline approaches (default T-3w → T-1w → T-3d → T-1d, tunable via `REMINDER_LADDER`), naming the owners; the closest rung is a "final tick" that loops in the escalation contact, and an OVERDUE rung escalates again once the deadline passes. Done/cancelled items are never reminded about. Idempotency lives in a new `reminder_log` SQLite table keyed by `(item_id, rung)` so each rung sends at most once; moving a deadline re-arms the ladder. The first consumer is **KB tasks** — tasks gain machine-readable `deadline:` / `escalation_contact:` frontmatter (`src/kb-task-source.ts` scans `context/tasks/*.md`, falling back to `end_date` for GitHub-synced tasks), and `writeApprovedTaskFile` now emits those fields. Reminders post to the shared-KB group's chat by default (`REMINDER_TARGET_JID` to override), and a rolling "everything with a deadline" digest grouped by week and by owner is written to `context/deadline-digest.md`. The ladder decision (`selectRung`) is a pure function of `now` vs the deadline, with table-driven + idempotency tests (30+ new cases). Operator-tunable via `REMINDER_*` env vars; orchestrator-side only, no container rebuild required. Foundation for the grants/SD/onboarding/peer-review flows that depend on it.
- Fixed **replies landing in the wrong thread/conversation under concurrent load** (#46). Discord, Slack, and Telegram each resolved the outbound reply target from a single per-channel mutable slot (`lastReplyAnchor` / `lastThreadTs`) that was overwritten by *every* inbound message. When a second message arrived (in another Discord thread, Slack thread, or Telegram topic) while the agent was still answering the first, the in-flight reply was routed to the newer message's thread instead of the one it answered. Because a channel and all its threads/topics collapse to one JID → one container, this triggers whenever two requests overlap in the same channel. Fix: the orchestrator now passes the **triggering message's ID** to `sendMessage` (new optional `SendMessageOpts.replyToMessageId` on the `Channel` interface), and each channel resolves the thread from a concurrency-safe per-message index (capped LRU) instead of the last-seen anchor. Proactive/agent-initiated sends with no trigger ID fall back to channel-level routing as before. Also wires up Telegram forum-topic replies, which previously never targeted a topic. New regression tests for Discord and Slack (verified to fail without the fix). Orchestrator-side only (`src/channels/{discord,slack,telegram}.ts`, `src/types.ts`, `src/index.ts`); no container rebuild required.
- Fixed **stale "non-main containers cannot write to the KB" instruction** in the container `kb-operations` skill (#45). The framework already authorizes KB writes via the `modify_kb_file` tool for any allowlisted sender from any group — including DMs/non-main contexts — under the flat permission model (`canModifyKbFile` gates on `sender_context`, not `isMain`; cooperative mode is on by default). The skill doc still told the agent it could not write from non-main contexts and to "route the request through the main group container", so the agent declined KB writes from DMs even though the IPC path worked. Rewrote the skill's storage/write section to describe writing through `modify_kb_file` (the `/workspace/shared-kb` mount stays read-only by design), and to explicitly instruct the agent not to decline a write just because it came from a DM when the requester is allowlisted. Documents the `FLAT_ACCESS=false` sandboxed case too. Docs-only — requires a container rebuild to ship the updated skill, no code change.
- **BREAKING: Refactored into a standalone, multi-org framework (renamed `labor.fun`).** Every org-specific thing — identity, KB, groups, and runtime state — now lives in a profile under `profiles/<name>/`, selected at startup via `LABOR_PROFILE` (else the single non-`example` profile, else the repo root for legacy/dev). The reference org moved to `profiles/breadchain/`; `profiles/example/` is a copy-me template. Run `/setup` to migrate. Key effects:
  - `store/`, `data/`, and `groups/` moved from the repo/app root to `profiles/<name>/`. Deploy (`safe-deploy.sh`) self-migrates legacy root-level state into the active profile on the first run; the systemd `breadbrich-deploy.env` now sets `LABOR_PROFILE` and points `CONTEXT_DIR`/`DB_PATH` into the profile.
  - Identity/brand/paths/GitHub org are read from `profiles/<name>/profile.config.json` via `src/profile.ts` → `src/config.ts`; hardcoded `/opt/breadbrich` paths and brand defaults are gone from `src/`. CLAUDE.md templates use the `{{ASSISTANT_NAME}}` token.
  - New flow/integration registry (`src/integrations/registry.ts`) mirrors the channel registry; profiles can overlay `container-skills/`. See `docs/PLUGINS.md` and `docs/NEW-ORG-GUIDE.md`.
- Added **`org-overview.md` canonical KB seed** at `profiles/breadchain/groups/discord_main/context/artifacts/org-overview.md` to stop the agent from hallucinating the org name as "Breadchain". The file pins **Bread Cooperative** (bread.coop) as the canonical name and explicitly calls out that `BreadchainCoop` is just the GitHub org handle, not the brand. Lists the authoritative source URLs the agent should fetch when asked about the org (`docs.bread.coop`, `paragraph.com/@breadcoop`). The profile's `discord_main/CLAUDE.md` and `global/CLAUDE.md` gained an `## About the org` pointer at the top of their KB sections so the agent reads `org-overview.md` before answering "what is this org" questions. The KB file lives under the profile's `groups/` so deploys won't ship it on its own — operators must drop it onto the droplet manually (see PR description) since `safe-deploy.sh` preserves/excludes the active profile's `groups/` from rsync.
- **BREAKING: Flattened the permission hierarchy.** The four-tier role model (Superadmin / Admin / Coordinator / Contributor / Guest) and the parallel `admin → leadership/coordinator → engineering/...` tag hierarchy are gone. There is now exactly one tier: an **allowlisted user** — anyone who resolves to a KB person (present in `sender-allowlist.json` AND carrying the configured Discord allowlist role, which the Discord-members sync writes into `groups/<sharedKb>/context/people/`) — has full access to every gated operation. Unknown senders still have none.
  - `tag_hierarchy` SQLite table dropped (no migration needed; the store is gitignored and production redeploys re-init).
  - `SenderContext.is_admin` removed from the orchestrator → container IPC contract. Tags on people files remain as descriptive labels only.
  - All per-tier gates removed from `src/ipc.ts` and `container/agent-runner/src/ipc-mcp-stdio.ts`: `canModifyKbFile`, `approve_proposed_tasks`, `reject_proposed_task`, `approve_expense` (no more `<$500` ceiling, no retrospective-vs-prospective split), `process_reimbursement`, `add_kb_user`, `modify_group_claude_md`, `register_group`, `refresh_groups`, `schedule_task`, `pause_task`, `resume_task`, `cancel_task`, `update_task`, and cross-channel send. The single check at each gate is now "is there a sender_context?" — i.e. is the caller allowlisted.
  - `isMain` on registered groups is retained as a routing property (which channel is the "control channel" for default prompts/notifications) but is no longer a permission gate — any allowlisted user can do main-group operations from any registered group.
  - The `## Admins` section in `groups/<sharedKb>/context/index.md` is no longer parsed. Operators can remove it on existing deployments; leaving it in place is harmless dead text.
  - Rules docs rewritten to reflect the flat model: `rules/access-control/{README,role-matrix,privacy-policy}.md`, `rules/identity/README.md`. `rules/identity/tag-hierarchy.md` deleted. Container `access-control` / `kb-operations` / `scheduling-rules` / `expense-helper` skill docs updated. `.claude/skills/redeploy-breadbrich/SKILL.md` no longer carves out a "coordinator standard-only" path.
- Added **cooperative mode** (`FLAT_ACCESS`, default on): every registered group is treated as main-equivalent for data access — read-write SQLite store mount, KB writes, and full IPC authorization in every container, with no main/non-main split. Intentionally removes the prompt-injection trust boundary; only safe when every channel is trusted-internal. Set `FLAT_ACCESS=false` to restore the sandboxed model. See `docs/COOPERATIVE-MODE.md`.
- Sharpened the **`dm_user`** tool's discoverability so the agent actually reaches for it. Tool description now opens with an imperative "USE THIS whenever the user asks you to DM / message / tell / contact / ping a named person", includes worked examples ("DM Josh and tell him X" → `dm_user(target='Josh', text='X')`), and explicitly tells the agent **not** to ask for a numeric Discord ID. The `groups/global/CLAUDE.md` + `groups/main/CLAUDE.md` capability lists also gained a dedicated DM-by-name bullet; before this the only related capability was the generic "Send messages back to the chat", which left the agent defaulting to "please paste the user ID" even though the tool was advertised on every container start.
- Added **`dm_user` MCP tool** so the agent can DM an allowlisted member by name without needing the numeric Discord ID. Accepts any of slug / Discord ID / Discord username / display name / KB-file `title`. Resolution is restricted to people in `user_identities` + `groups/<sharedKb>/context/people/*.md` — the bot will refuse to DM users it doesn't already know about, which is the safety perimeter for unsolicited DMs. Ambiguous matches return an error with the candidate list; misses include fuzzy suggestions. Failures are surfaced back as a message in the source chat. New module `src/integrations/dm-resolve.ts` for the pure resolver (11 unit tests covering ID / slug / title / username / display-name paths, slug-priority preference, ambiguity, fuzzy suggestions, empty-input rejection). Requires a container rebuild (`container/agent-runner/src/ipc-mcp-stdio.ts` changed).
- Fixed **auto-deploy.service `$HOME not set` failure**. systemd doesn't set `$HOME` for services by default, which made the `git config --global ...` lines inside `safe-deploy.sh` fail and tripped the ERR trap → rollback (caused PR #36's first auto-deploy to roll back, leaving services briefly inactive). Added `Environment=HOME=/root` to `setup/systemd/breadbrich-auto-deploy.service` so root-user git calls have a place to write their global config; per-user (`breadbrich`) git calls were already fine because `su - breadbrich` sets HOME via login shell. Also added `safe.directory /opt/breadbrich-git` to `/etc/gitconfig` on the droplet so the workaround works in any user context.
- Added **periodic Discord-members re-sync**. `startDiscordMembersSyncLoop()` runs the same logic as the one-shot `scripts/sync-discord-members.ts` on a configurable interval (default 1 hour, `DISCORD_MEMBERS_SYNC_INTERVAL_MS`). Each tick spins up a short-lived client with the `GuildMembers` intent and exits — the main orchestrator's persistent client still does NOT carry that intent. Skips when `DISCORD_DM_ALLOWED_ROLE_IDS` is empty or the interval is `0`. KB people files stay fresh as members change names / roles / leave / join, and the title-rename preservation in `mergeFrontmatter` means manual edits (e.g. setting `title: Ruben` for `0xr.md`) survive every re-run.
- Added **Discord-members → KB people sync** (`scripts/sync-discord-members.ts`, `npm run sync-discord-members`). One-shot: logs into Discord with the bot token (with the `GuildMembers` intent — the orchestrator's main client does not request this, so the bot's persistent intent footprint is unchanged), iterates `DISCORD_DM_ALLOWED_GUILD_IDS` (or every guild the bot is in), filters to anyone holding a `DISCORD_DM_ALLOWED_ROLE_IDS` role, and for each match (a) writes / refreshes `groups/<SHARED_KB_GROUP>/context/people/<slug>.md` and (b) binds `(discord, <discord_id>) → <slug>` in `user_identities`. Idempotent: a re-run only refreshes Discord-derived frontmatter (`discord_id`, `discord_username`, `discord_display_name`, `discord_roles`, `last_synced_at`); existing body content and human-set fields like `title`, `visibility`, `skills`, `contact` are preserved. Slug stability is anchored to the existing `user_identities` mapping first; new users get a slugified display name with `-2`/`-3` deconflict on collision. New db helpers `upsertIdentity` + `getKbPersonByPlatformId`. Requires the bot to have **Server Members Intent** enabled in the Discord Developer Portal.
- Added **`discord_main` as the canonical Discord-primary group**. `groups/discord_main/CLAUDE.md` mirrors `slack_main`'s role for installs that bootstrapped on Discord. `setup/breadbrich-deploy.env` now sets `SHARED_KB_GROUP=discord_main` + `CONTEXT_DIR=…/groups/discord_main/context` — the GH Projects sync and the kb-ui read the same canonical location. The previous install-specific `discord_<channel-id>/context/` data should be migrated into `discord_main/context/` on the droplet during this deploy (see PR description).
- Added **auto-deploy on merge to `main`**. A new `breadbrich-auto-deploy.timer` polls `origin/main` every 2 minutes via `git ls-remote` (refs only, no object fetch) and triggers `safe-deploy.sh` when the mirror is behind. Auth piggybacks on the credential helper `safe-deploy.sh` already configured — no GitHub Secrets, no inbound ports. Manual + auto deploys are serialized through a `flock` on `/run/breadbrich-deploy.lock` taken at the top of `safe-deploy.sh`; concurrent runs exit fast with code 0 so a colliding timer tick doesn't surface as a failure. `safe-deploy.sh` step 7a now also processes `*.timer` units and `enable --now`-s newly-installed timers so the bootstrap is one deploy, not two. Logs at `/opt/breadbrich/logs/auto-deploy.log`.
- Extracted non-secret deployment env vars (`KB_PORT`, `CONTEXT_DIR`, `USERS_FILE`, `KB_ADMINS`, `KB_SUPERADMINS`, `DB_PATH`, `CREDENTIAL_PROXY_HOST`, `NODE_ENV`) from the `Environment=` lines inside the systemd units into a single `setup/breadbrich-deploy.env` file. Both units load it via `EnvironmentFile=-/opt/breadbrich/setup/breadbrich-deploy.env` — leading `-` tolerates a missing file (server-side defaults still apply). Secrets remain in `/opt/breadbrich/.env` (loaded by `readEnvFile` inside Node, gitignored). Tuning these no longer requires editing a unit file; just edit `setup/breadbrich-deploy.env` and deploy.
- Added **GitHub Projects hide list** (`GITHUB_PROJECT_HIDE_TITLE_PATTERNS`, default `untitled,micro,macro`). Case-insensitive substring match against the project title; any matching project (and its items) is skipped at sync time. Empty titles are always skipped. Default covers GitHub's auto-named `"@<user>'s untitled project"` boards plus the `"Breadchain Micro"` / `"Breadchain Macro"` categorization boards. Reconcile then sweeps the now-orphaned local files on the next successful run.
- **Synced GitHub items now include a direct link to the source.** The sync prepends a `[View on GitHub](<url>)` line to the markdown body for each item and project — visible in `/doc/tasks/<file>` (and to any agent that reads the file), and `gh_url` is now also captured into the kb-ui task object so an `↗` icon appears next to each item in the `/projects` list view and on kanban cards.
- **Deploy infrastructure is now version-controlled.** The systemd unit files (`breadbrich.service`, `breadbrich-kb.service`) and the canonical `safe-deploy.sh` now live in `setup/systemd/` and `setup/` respectively. `safe-deploy.sh` gained two steps: (a) byte-diffs `setup/systemd/*.service` against `/etc/systemd/system/`, installs any changed units, and runs `systemctl daemon-reload` once before the restart step; (b) at the end of a successful run, self-updates `/opt/breadbrich-backups/safe-deploy.sh` from the repo copy so the next deploy picks up its own changes. See `setup/DEPLOY-INFRA.md` for the bootstrap flow.
- Routed `SHARED_KB_GROUP` through the `readEnvFile` allowlist + centralized export from `config.ts`. Previously read via `process.env.SHARED_KB_GROUP` in two places (`container-runner.ts`, `github-project-sync.ts`) — same `.env`-not-loaded class of bug as the others fixed in PR #14. With this, operators can point the GH sync's write target at any group's `context/` (e.g. `discord_<id>` for installs that bootstrapped their KB inside a Discord group folder), and have it align with whatever `CONTEXT_DIR` the kb-ui systemd unit reads from.
- **kb-ui `/projects` (and `/tasks`, `/linkages`) now display GitHub-synced items.** The existing routes filtered by `TASK-*` / `PROJECT-*` filename prefixes only, so the four-view UI (kanban / list / gantt + configurable swimlanes via kanban's col/row selectors) couldn't see anything written by the GH Projects V2 sync. Centralized the allow list into `isTaskFile` / `isProjectFile` helpers covering `TASK-` + `GH-` + `GHD-` (tasks) and `PROJECT-` + `GHP-` (projects), and made the project↔task count match by project id **or** title (GH-synced tasks reference projects by display title; hand-authored ones reference by id). The existing kanban / list / gantt views render synced data immediately — no view code touched.
- Fixed **Discord DMs were never delivered to the bot**: discord.js v14 silently drops `messageCreate` events for DM channels unless the `Channel` partial is enabled, and we were missing it. Added `partials: [Channel, Message, Reaction]` to the client. DM allowlist (PR #7) couldn't fire prior to this — no DM events were reaching the handler at all.
- Fixed **operator env vars added since cooperative mode never actually loaded**: `FLAT_ACCESS`, `DISCORD_DM_ALLOWED_ROLE_IDS`, `DISCORD_DM_ALLOWED_GUILD_IDS`, `DISCORD_DM_ROLE_REFRESH_INTERVAL`, `GITHUB_PROJECT_SYNC_ORGS`, `GITHUB_PROJECT_SYNC_INTERVAL_MS` were all read via `process.env` only — but systemd doesn't load `/opt/breadbrich/.env` globally, so they were silently empty in production. Added them to the explicit `readEnvFile` list at the top of `config.ts` and centralized lookup via a small `envVal()` helper that prefers `process.env` then falls back to the loaded `.env`. (FLAT_ACCESS defaulted on, so cooperative mode worked accidentally; the rest of the features quietly didn't.)
- Added **GitHub Projects V2 → KB sync**: a background loop pulls every ProjectV2 board (and every item in it) for the orgs listed in `GITHUB_PROJECT_SYNC_ORGS`, writing them into the KB as `context/projects/GHP-<org>-<n>.md` and `context/tasks/GH-<org>-<repo>-<issue#>.md` with the same frontmatter shape the existing `/projects` page already reads (status / priority / owners / start_date / end_date / project / tags) plus GitHub-specific fields for the upcoming kanban/swimlane/gantt views. Items removed from a project are auto-deleted on the next successful sync (stale `gh_synced_at` reconcile); hand-authored `TASK-NNN` / `PROJECT-*` files are never touched. Default interval 15 min. Requires the existing `GITHUB_PERSONAL_ACCESS_TOKEN` to carry `read:project`.
- Added **Discord emoji reactions** for the seen / working ACK pattern: bot now reacts with 👀 when a triggered message is received and 🤔 while the agent is working, mirroring the Telegram channel's behavior. `DiscordChannel` now implements `addReaction` / `removeReaction` (Slack-style names mapped to Unicode; raw Unicode passes through). On completion the thinking emoji is removed and **no follow-up reaction is added** (the agent's reply itself is the completion signal) — applies to every channel that supports reactions, not just Discord.
- Fixed Discord **role-mention trigger silently dropping**: Discord's autocomplete frequently picks a role mention (`<@&roleId>`) when a role shares the bot's display name. Mention translation only detected user mentions (`<@userId>` / `<@!userId>`), so role mentions of bot-held roles slipped through untranslated and the anchored trigger regex missed. `isBotMentioned` now also fires when the message mentions any role the bot holds (`guild.members.me.roles.cache`), and those tokens are stripped from the content alongside user-mention tokens.
- Fixed Discord **reply + @mention trigger silently dropping**: `discord.ts` was prepending `[Reply to <author>] ` to message content, which blocked the anchored `^@Breadbrich Engels` trigger regex from matching. The annotation now appends to the end of the content (`<msg>\n[In reply to <author>]`) so the trigger at the start is preserved and the agent still receives reply context. Replies that also @-mention the bot now correctly trigger a response.
- Added **agent_runs startup hygiene**: on orchestrator boot, in-flight `agent_runs` rows (status `running` with no `completed_at`) are now marked `interrupted` with `error='Orchestrator restarted before run completed'`, so zombie rows from previous restarts stop polluting durations/stats. Idempotent.
- Improved **`agent_runs.error` diagnostic detail**: the generic `'Agent returned error'` message now distinguishes whether partial output reached the user (`'Agent returned error (partial output sent to user)'` vs `'(no output sent)'`).
- Added **Discord DM role-based allowlist** (`DISCORD_DM_ALLOWED_ROLE_IDS`, optional `DISCORD_DM_ALLOWED_GUILD_IDS`, `DISCORD_DM_ROLE_REFRESH_INTERVAL`): when set, the bot auto-registers a DM as its own group (no `@` trigger needed) the first time a user holding any of the listed Discord role IDs in a shared guild DMs the bot. A background refresh re-checks roles on the configured interval (default 10 min) and deregisters DM groups whose owner has lost the required role (folder + data preserved). Outbound DM sends already worked via the existing `sendMessage` path. Feature is off unless `DISCORD_DM_ALLOWED_ROLE_IDS` is non-empty. Channel `ChannelOpts` extended with `registerGroup` / `deregisterGroup` callbacks; new `deleteRegisteredGroup` db helper.

## [1.2.36] - 2026-03-26

- [BREAKING] Replaced pino logger with built-in logger. WhatsApp users must re-merge the WhatsApp fork to pick up the Baileys logger compatibility fix: `git fetch whatsapp main && git merge whatsapp/main`. If the `whatsapp` remote is not configured: `git remote add whatsapp https://github.com/qwibitai/salem-whatsapp.git`.

## [1.2.35] - 2026-03-26

- [BREAKING] OneCLI Agent Vault replaces the built-in credential proxy. Check your runtime: `grep CONTAINER_RUNTIME_BIN src/container-runtime.ts` — if it shows `'container'` you are on Apple Container, if `'docker'` you are on Docker. Docker users: run `/init-onecli` to install OneCLI and migrate `.env` credentials to the vault. Apple Container users: re-merge the skill branch (`git fetch upstream skill/apple-container && git merge upstream/skill/apple-container`) then run `/convert-to-apple-container` and follow all instructions (configures credential proxy networking) — do NOT run `/init-onecli`, it requires Docker.

## [1.2.21] - 2026-03-22

- Added opt-in diagnostics via PostHog with explicit user consent (Yes / No / Never ask again)

## [1.2.20] - 2026-03-21

- Added ESLint configuration with error-handling rules

## [1.2.19] - 2026-03-19

- Reduced `docker stop` timeout for faster container restarts (`-t 1` flag)

## [1.2.18] - 2026-03-19

- User prompt content no longer logged on container errors — only input metadata
- Added Japanese README translation

## [1.2.17] - 2026-03-18

- Added `/capabilities` and `/status` container-agent skills

## [1.2.16] - 2026-03-18

- Tasks snapshot now refreshes immediately after IPC task mutations

## [1.2.15] - 2026-03-16

- Fixed remote-control prompt auto-accept to prevent immediate exit
- Added `KillMode=process` so remote-control survives service restarts

## [1.2.14] - 2026-03-14

- Added `/remote-control` command for host-level Claude Code access from within containers

## [1.2.13] - 2026-03-14

**Breaking:** Skills are now git branches, channels are separate fork repos.

- Skills live as `skill/*` git branches merged via `git merge`
- Added Docker Sandboxes support
- Fixed setup registration to use correct CLI commands

## [1.2.12] - 2026-03-08

- Added `/compact` skill for manual context compaction
- Enhanced container environment isolation via credential proxy

## [1.2.11] - 2026-03-08

- Added PDF reader, image vision, and WhatsApp reactions skills
- Fixed task container to close promptly when agent uses IPC-only messaging

## [1.2.10] - 2026-03-06

- Added `LIMIT` to unbounded message history queries for better performance

## [1.2.9] - 2026-03-06

- Agent prompts now include timezone context for accurate time references

## [1.2.8] - 2026-03-06

- Fixed misleading `send_message` tool description for scheduled tasks

## [1.2.7] - 2026-03-06

- Added `/add-ollama` skill for local model inference
- Added `update_task` tool and return task ID from `schedule_task`

## [1.2.6] - 2026-03-04

- Updated `claude-agent-sdk` to 0.2.68

## [1.2.5] - 2026-03-04

- CI formatting fix

## [1.2.4] - 2026-03-04

- Fixed `_chatJid` rename to `chatJid` in `onMessage` callback

## [1.2.3] - 2026-03-04

- Added sender allowlist for per-chat access control

## [1.2.2] - 2026-03-04

- Added `/use-local-whisper` skill for local voice transcription
- Atomic task claims prevent scheduled tasks from executing twice

## [1.2.1] - 2026-03-02

- Version bump (no functional changes)

## [1.2.0] - 2026-03-02

**Breaking:** WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add.

- Channel registry: channels self-register at startup via `registerChannel()` factory pattern
- `isMain` flag replaces folder-name-based main group detection
- `ENABLED_CHANNELS` removed — channels detected by credential presence
- Prevent scheduled tasks from executing twice when container runtime exceeds poll interval

## [1.1.6] - 2026-03-01

- Added CJK font support for Chromium screenshots

## [1.1.5] - 2026-03-01

- Fixed wrapped WhatsApp message normalization

## [1.1.4] - 2026-03-01

- Added third-party model support
- Added `/update-breadbrich` skill for syncing with upstream

## [1.1.3] - 2026-02-25

- Added `/add-slack` skill
- Restructured Gmail skill for new architecture

## [1.1.2] - 2026-02-24

- Improved error handling for WhatsApp Web version fetch

## [1.1.1] - 2026-02-24

- Added Qodo skills and codebase intelligence
- Fixed WhatsApp 405 connection failures

## [1.1.0] - 2026-02-23

- Added `/update` skill to pull upstream changes from within Claude Code
- Enhanced container environment isolation via credential proxy
