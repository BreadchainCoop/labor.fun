# Breadbrich Engels Data Inventory

**Purpose:** exhaustive catalog of every place Breadbrich Engels state lives. Load-bearing for `STATE-RECOVERY-MAP.md` and `MIGRATION-RUNBOOK.md`. Must stay in sync with reality — update this file any time a new state surface is introduced.

**Last verified:** 2026-04-21

## Tier definitions

- **Tier 1** — state, not regeneratable from code. Losing this = irrecoverable data loss.
- **Tier 2** — state, regeneratable with effort. Losing this = operational pain, recoverable.
- **Tier 3** — derived from source. Losing this = rebuild (`npm install`, `npm run build`).
- **Tier 4** — ephemeral. Lives in process memory or in-flight IPC. Acceptable to lose on restart.

## Tier 1 — must preserve

| ID | Surface | Path (droplet) | Size | Backed up? | Criticality |
|---|---|---|---|---|---|
| T1-01 | Messages DB | `/opt/breadbrich/store/messages.db` | 1.3M | ✅ backup.sh, pre-deploy snapshots, `.backup` sidecars | 5 |
| T1-02 | Nanoclaw DB | `/opt/breadbrich/store/nanoclaw.db` | 200K | ✅ backup.sh | 5 |
| T1-03 | .env main (bot tokens, API keys) | `/opt/breadbrich/.env` | 631B | ✅ backup.sh | 5 |
| T1-04 | .env vault (email creds) | `/home/breadbrich/.config/nanoclaw/.env` | 699B | ✅ backup.sh | 5 |
| T1-05 | KB markdown | `/opt/breadbrich/groups/*/context/**` | 142M | ✅ backup.sh (also in git for most) | 5 |
| T1-06 | Claude SDK session transcripts | `/opt/breadbrich/data/sessions/*/.claude/projects/*/*.jsonl` | 20M | ✅ backup.sh | 4 |
| T1-07 | KB UI users.json | `/opt/breadbrich/kb-ui/users.json` | <1K | ✅ backup.sh | 4 |
| T1-08 | repo-tokens | `/opt/breadbrich/repo-tokens/` | 40K | ✅ backup.sh | 3 |
| T1-09 | SSH keys (breadbrich user) | `/home/breadbrich/.ssh/github_deploy*` | 452B + 112B | ✅ gap-items 2026-04-21 | 4 |
| T1-10 | SSH authorized_keys (root) | `/root/.ssh/authorized_keys` | ~1K | ✅ gap-items 2026-04-21 | 4 |
| T1-11 | GitHub PAT | `/home/breadbrich/.netrc` | 94B | ✅ gap-items 2026-04-21 | 4 |
| T1-12 | Cloudflare tunnel token | embedded in running cloudflared.service | 100B token | ✅ gap-items 2026-04-21 (running-cloudflared-cmd.txt) | 5 |

## Tier 2 — regeneratable with effort

| ID | Surface | Path (droplet) | Recovery |
|---|---|---|---|
| T2-01 | systemd unit files (breadbrich, breadbrich-kb, breadbrich-tunnel [now masked], cloudflared) | `/etc/systemd/system/` | From backup tarball gap-items/systemd/ or recreate from MIGRATION-RUNBOOK |
| T2-02 | cron files (breadbrich-hourly, breadbrich-backup) | `/etc/cron.d/` | From backup tarball; scripts are in git |
| T2-03 | cloudflared config | `/etc/cloudflared/` | Recreate via `cloudflared tunnel create` + DNS CNAME update |
| T2-04 | journalctl 30-day history | `/var/log/journal/` | Cannot recover prior; future logs rebuild automatically |
| T2-05 | App logs | `/opt/breadbrich/logs/` | Cannot recover prior; future logs rebuild |
| T2-06 | dpkg package list | system-wide | `dpkg -l` snapshot in gap-items |
| T2-07 | Pre-deploy backups | `/opt/breadbrich-backups/pre-deploy/` | Rotated automatically; 10 kept |
| T2-08 | Daily + weekly backups | `/opt/breadbrich-backups/daily/`, `.../weekly/` | Rotated automatically; 7+4 kept |

## Tier 3 — derived

| ID | Surface | Regenerate via |
|---|---|---|
| T3-01 | `/opt/breadbrich/dist/` | `npm run build` (~2min) |
| T3-02 | `/opt/breadbrich/node_modules/` | `npm install` (~3min) |
| T3-03 | `/opt/breadbrich/kb-ui/node_modules/` | `npm install` in kb-ui/ |
| T3-04 | Docker image `nanoclaw-agent:latest` | `./container/build.sh` (~10min) |
| T3-05 | `data/sessions/*/agent-runner-src/` (per-session bind-mount caches) | Copied from `container/agent-runner/src/` on session start |

## Tier 4 — ephemeral

| ID | Surface | Lifetime | What's lost |
|---|---|---|---|
| T4-01 | Running container memory | Until restart or IDLE_TIMEOUT (30min) | In-flight conversation state; recovered from .jsonl on next spawn |
| T4-02 | IPC in-flight messages | Until dispatcher processes | Very short window; recovered by message loop re-reading unprocessed DB rows |
| T4-03 | Channel listener connection state | Until restart | Reconnects automatically via Grammy / Bolt |
| T4-04 | `data/ipc/*/current_tasks.json` etc. | Until next agent run | Regenerated on next task query |

## Local laptop state (not backed up by Breadbrich Engels)

| ID | Surface | Path | Recovery |
|---|---|---|---|
| L-01 | Memory files | `~/.claude/projects/-Users-ops-Documents-Code-Claude/memory/` | Not auto-backed-up. User-responsible. Re-derive from session logs if lost. |
| L-02 | Session history | `~/.claude/workflows/session-log.md` | Append-only; no backup. |
| L-03 | Workstream state | `~/.claude/workflows/workstreams.jsonl` | Active tracking file; no backup. |
| L-04 | Breadbrich Engels repo | `<local-clone>/breadbrich` | `git clone https://github.com/BreadchainCoop/breadbrich-engels` |
| L-05 | Pre-migration backup | `~/Documents/Code/Claude/breadbrich-backups/` | Local only; consider third-copy to iCloud/S3 |

## External services (authoritative out-of-band)

| ID | Service | What | Access |
|---|---|---|---|
| E-01 | GitHub | `BreadchainCoop/breadbrich-engels` private repo | Deploy key at T1-09, PAT at T1-11 |
| E-02 | DigitalOcean | Breadbrich Engels droplet (host in `DROPLET_HOST`) | DO console + SSH (T1-09, T1-10) |
| E-03 | Cloudflare | DNS + live tunnel for kb.example.com | Account owner has admin; system operator has view access |
| E-04 | Telegram | @your_bot_username | Token in T1-03; @BotFather for reissue |
| E-05 | Slack | your-workspace.slack.com workspace | Tokens in T1-03; app owner = system operator |
| E-06 | Anthropic | API + OAuth | OAuth token in T1-03; console.anthropic.com for rotation |
| E-07 | Email | service mailbox (Google Workspace; address in `BREADBRICH_EMAIL`) | Credentials in T1-04; SMTP blocked by DO |

## Gotchas / notes

- **`/opt/breadbrich/` is NOT a git repo.** It's an rsync target from `/opt/breadbrich-git/`. Don't try `git pull` inside /opt/breadbrich.
- **Dual .env (T1-03 + T1-04) must stay in sync.** Tokens appear in both. Divergence = silent auth failures.
- **Session-cached agent-runner-src** is bind-mounted. Deleting during a live session crashes the container.
- **Divergence risk**: memory prior to 2026-04-21 noted the droplet src/ had functions not in git. Verified 2026-04-21: **resolved**. All 4 previously-diverged files (`src/index.ts`, `src/container-runner.ts`, `src/ipc.ts`, `src/ipc-auth.test.ts`) are byte-identical between droplet and cvnt/main.
- **breadbrich-tunnel.service is deprecated** (masked + unit moved to `.deprecated-2026-04-21`). The live tunnel is `cloudflared.service`. Do not revive breadbrich-tunnel.
- **Credential token leaked in chat on 2026-04-21** (tunnel token visible in tool output during inventory). Consider rotation as hygiene; not publicly exposed.

## Update protocol

Any code change that touches state must update this file in the same PR. Specifically:
- Adding a new DB table → new T1 entry
- Adding a new KB directory → note mount + visibility
- Adding a new env var → note which .env it lives in + dual-path requirement
- Adding new credentials → note recovery procedure
- Deprecating a service → note in gotchas

Reviewers: reject PRs that modify state surfaces without updating DATA-INVENTORY.md.
