# Changelog

All notable changes to Breadbrich Engels will be documented in this file.

For detailed release notes, see the [full changelog on the documentation site](https://docs.salem.dev/changelog).

## [Unreleased]

- Added **cooperative mode** (`FLAT_ACCESS`, default on): every registered group is treated as main-equivalent for data access — read-write SQLite store mount, KB writes, and full IPC authorization in every container, with no main/non-main split. Intentionally removes the prompt-injection trust boundary; only safe when every channel is trusted-internal. Set `FLAT_ACCESS=false` to restore the sandboxed model. See `docs/COOPERATIVE-MODE.md`.
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
