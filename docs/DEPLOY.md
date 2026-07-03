# Deploy & Backup

How to deploy Breadbrich Engels to the droplet without clobbering state, and how state gets backed up.

## TL;DR

**Normal path: just merge to `main` — it auto-deploys.** A host systemd timer
(`breadbrich-auto-deploy.timer`) runs `setup/auto-deploy.sh` ~every 2 min; when
`origin/main` advances it runs `safe-deploy.sh` (rsync -> snapshot -> build/pull
image -> restart -> health-check -> rollback on failure), deferring while an
agent container is mid-run (~15 min cap), then posts a `Deployed to production`
comment on the merged PR. There is **no manual step** for a normal change. See
[the agent-facing summary](../rules/deployment.md).

```bash
# Manual / emergency override only (normal changes deploy themselves on merge):
./scripts/deploy.sh

# Preview without applying
./scripts/deploy.sh --dry-run

# Status / logs
./scripts/deploy.sh --status
./scripts/deploy.sh --logs

# Pull droplet backups to your Mac as off-site mirror
./scripts/pull-backups.sh
```

---

## Naming convention

Everything across infra and product uses the `breadbrich` name; `nanoclaw` is the upstream package the fork is built on.

| Layer | Name |
| --- | --- |
| Repo / project | nanoclaw (upstream), breadbrich (fork) |
| Product / bot | Breadbrich Engels (`@your_bot_username`; service email is `BREADBRICH_EMAIL` in `.env`) |
| Droplet hostname | (set `DROPLET_HOST` in `.env`) |
| System user | `breadbrich` |
| Install path | `/opt/breadbrich/` |
| User config | `/home/breadbrich/.config/nanoclaw/.env` |
| systemd units | `breadbrich.service`, `breadbrich-kb.service` |
| Backups | `/opt/breadbrich-backups/`, `<local-mac>/breadbrich-backups/` |
| Container image tag | `nanoclaw-agent:latest` |

The droplet and system user were renamed from their pre-2026-05-04 names to `breadbrich` (system user) and the hostname configured via `DROPLET_HOST`. Transition symlinks remain in place for the legacy `/opt/breadbrich`, `/opt/breadbrich-backups`, `/opt/breadbrich-git`, and `/home/breadbrich` paths so older scripts still resolve.

---

## Architecture

```
Your Mac                                    Droplet ($DROPLET_HOST)
────────                                    ────────────────────────────
~/Documents/Code/Claude/breadbrich/
  scripts/deploy.sh  ──────── rsync ─────→  /tmp/breadbrich-staging/
  scripts/pull-backups.sh ←──── rsync ────  /opt/breadbrich-backups/
~/Documents/Code/Claude/breadbrich-backups/
  (off-site mirror)                         /opt/breadbrich/            ← live app
                                              ├─ .env             ← stateful
                                              ├─ store/           ← stateful (SQLite)
                                              ├─ data/            ← stateful (sessions, ipc)
                                              ├─ groups/          ← stateful (KB files)
                                              ├─ kb-ui/users.json ← stateful
                                              ├─ repo-tokens/     ← stateful
                                              ├─ src/ container/ kb-ui/ ... ← code
                                              └─ node_modules/    ← generated

                                            /home/breadbrich/.config/nanoclaw/.env ← stateful

                                            /opt/breadbrich-backups/
                                              ├─ backup.sh
                                              ├─ safe-deploy.sh
                                              ├─ daily/      (7 × ~21MB)
                                              ├─ weekly/     (4 × ~21MB)
                                              ├─ pre-deploy/ (10 × ~21MB)
                                              └─ manual/     (20 × ~21MB)
```

### Stateful vs derived

**Stateful** (preserved across deploys, backed up):
- `.env` files (both `/opt/breadbrich/.env` and `/home/breadbrich/.config/nanoclaw/.env`)
- `store/` — SQLite DBs (`messages.db`, `nanoclaw.db`)
- `data/` — agent session state, IPC dirs, per-group Claude settings
- `groups/` — per-group memory (`CLAUDE.md`, KB context, assets; agents live-edit these)
- `kb-ui/users.json` — dashboard user roles
- `repo-tokens/` — GitHub PATs
- `package.json` + `package-lock.json` — needed so rollback can reinstall the right deps

**Derived** (regenerated on deploy):
- `node_modules/` — from `npm install`
- `dist/` — from `npm run build`
- `container/` builds — from `./container/build.sh`

---

## Deploy flow

`scripts/deploy.sh` (Mac) → `safe-deploy.sh` (droplet):

1. **Local**: rsync source to `/tmp/breadbrich-staging/` on droplet, excluding stateful paths, `.git`, `node_modules`, `dist`, worktrees.
2. **Local**: detect if `container/` sources changed (diff staged vs live). Touch `/tmp/breadbrich-deploy-container-changed` if so.
3. **Droplet** (`safe-deploy.sh`):
    1. Take pre-deploy snapshot → `/opt/breadbrich-backups/pre-deploy/`
    2. Record current `package.json` + lock as `/tmp/breadbrich-pre-*.json` for diff
    3. rsync `/tmp/breadbrich-staging/` → `/opt/breadbrich/`, excluding stateful paths (code only)
    4. If `package.json` or lock changed: `npm install`. Else skip (faster).
    5. `npm run build`
    6. If container sources changed: `./container/build.sh`
    7. `systemctl restart breadbrich`
    8. Health check: poll up to ~23s (5s initial sleep + 6 × 3s loop) and require both `systemctl is-active` AND `"Credential proxy started"` log line within the last 60s of journal. The 60s window (patched 2026-05-16 from `-n 50 --since "45 seconds ago"`) survives noisy startups where recovery logs would otherwise push the cred-proxy line out.
    9. **Rollback on any failure above**

### Rollback flow

Triggered by: `rsync` error, `npm install` error, build error, container build error, or health check timeout.

1. `systemctl stop breadbrich`
2. `tar -xzf` latest pre-deploy snapshot into `/` (restores `.env`, `store/`, `data/`, `groups/`, `kb-ui/users.json`, `repo-tokens/`, `package.json`, `package-lock.json`)
3. `npm install` from the restored `package.json` (rebuilds `node_modules` to match the pre-deploy state)
4. `systemctl start breadbrich`
5. Verify active; log CRITICAL if not

Rollback has been exercised in production: successfully restored service after a TypeScript build failure during the initial deploy.

---

## Backup flow

`/opt/breadbrich-backups/backup.sh` is invoked in four modes:

| Mode | Trigger | Destination | Keep |
| --- | --- | --- | --- |
| `daily` | cron, 03:30 UTC | `daily/` | 7 |
| `weekly` | cron, Sunday 04:00 UTC | `weekly/` | 4 |
| `pre-deploy` | `safe-deploy.sh` | `pre-deploy/` | 10 |
| `manual` | `backup.sh manual` on droplet | `manual/` | 20 |

Each snapshot:
1. Makes a consistent SQLite copy via `sqlite3 .backup` (so the tarball doesn't catch a torn DB mid-write)
2. `tar -czf` of `.env`, `package.json`, lock, `store/`, `data/`, `groups/`, `kb-ui/users.json`, `repo-tokens/`, plus `/home/breadbrich/.config/nanoclaw/.env`
3. Excludes `node_modules`, `.npm-cache`, `*.log`, transient IPC/session compile artifacts
4. Rotates: keeps N newest, deletes the rest

Average snapshot size: **~21MB**. Disk footprint with all retention slots full: ~880MB.

### Off-site mirror

`scripts/pull-backups.sh` rsyncs `/opt/breadbrich-backups/` → `~/Documents/Code/Claude/breadbrich-backups/` on your Mac. Not automated — run manually or via launchd if desired.

**Limitation**: Mac must be on and reachable. For true independence from Mac uptime, see the DO Spaces option in *Future options* below.

---

## Usage

### Normal deploy

```bash
cd ~/Documents/Code/Claude/breadbrich
./scripts/deploy.sh
```

Output surfaces rsync progress, `npm` activity, build output, and final health check. On failure, rollback runs automatically and the script exits 1.

### Dry run (preview what would sync)

```bash
./scripts/deploy.sh --dry-run
```

### Restore from a snapshot manually

```bash
ssh "$DROPLET_HOST"
systemctl stop breadbrich
cd /
tar -xzf /opt/breadbrich-backups/pre-deploy/breadbrich-pre-deploy-YYYYMMDD-HHMMSS.tar.gz
su - breadbrich -c "cd /opt/breadbrich && npm install --no-audit --no-fund"
systemctl start breadbrich
```

### Pull backups to Mac

```bash
./scripts/pull-backups.sh
```

### Force an immediate backup

```bash
ssh "$DROPLET_HOST" "su - breadbrich -c '/opt/breadbrich-backups/backup.sh manual'"
```

---

## Gotchas

### 1. Naming: breadbrich vs nanoclaw
Two names: `breadbrich` for the fork, `nanoclaw` for the upstream package. Documented in the naming table above.

### 2. `safe-deploy.sh` canonical source is in the repo, but NOT auto-synced
The droplet runs `/opt/breadbrich-backups/safe-deploy.sh`. The canonical source is `scripts/safe-deploy.sh` in this repo (added 2026-05-17). When that file changes, you must manually push it to the droplet:

```bash
scp scripts/safe-deploy.sh "$DROPLET_HOST:/opt/breadbrich-backups/safe-deploy.sh"
```

`./scripts/deploy.sh` does NOT auto-sync this — adding an auto-sync step is a future option. Drift detection: `ssh "$DROPLET_HOST" 'diff /opt/breadbrich-backups/safe-deploy.sh -' < scripts/safe-deploy.sh`.

### 3. `.claude/worktrees/` rsync warnings
The deploy prints `cannot delete non-empty directory: .claude/worktrees/...` — harmless. The agent worktree system holds open files during deploy; excluded from sync but `--delete` logs the skip. Ignore.

### 4. `package-lock.json` must stay committed
The fork's `.gitignore` was excluding the lock file, which breaks CI (`cache: npm` in setup-node needs it) and makes `npm ci` impossible. Fixed in PR that added `package-lock.json`. **Do not re-add** to `.gitignore`.

### 5. `node_modules` not in backups
Snapshots contain `package.json` + `package-lock.json` but NOT `node_modules` (too large, easy to regenerate). Rollback runs `npm install` to rebuild. **Consequence**: rollback needs working internet and a working npm registry. If offline rollback is a requirement, add `node_modules` to the backup (will ~3× the snapshot size).

### 6. `breadbrich` user has no SSH
We connect via `ssh root@...` and then `su - breadbrich`. Deploy depends on the root key. If root auth changes, update `scripts/deploy.sh`.

### 7. `.env` OAuth token expires (~1 year)
`CLAUDE_CODE_OAUTH_TOKEN` in `.env` is a long-lived OAuth token, not a refreshable one. Watch the expiry in the keychain JSON on the Mac; rotate via `claude setup-token` (run as the Mother Goose account) before expiry and redeploy the `.env`. Short-lived tokens from plain `claude auth login` will die within hours on a 24/7 service.

### 8. Breadbrich Engels runs on droplet only
The local checkout is not a running instance. `npm run dev` locally spawns containers on your Mac against local files. Production is 100% on the droplet. Don't confuse "it works on my Mac" with "production works."

### 9. `rsync --delete` respects excludes — but excludes must be exact
Any stateful path you add (or path that gets touched at runtime) must be added to BOTH `scripts/deploy.sh` `EXCLUDES=()` AND `safe-deploy.sh` `STATEFUL_PATHS=()`. If only one has it, the other side will still clobber it. Audit after any directory structure change.

### 10. Fork's `main` is behind upstream NanoClaw `main`
`cvnt/main` has only one contributor's PRs merged in; `qwibitai/nanoclaw@main` has many more commits. The fork hasn't been synced with upstream in a while. Sync at your own risk — the PR merge conflicts we already dealt with hint at how divergent they are.

### 11. Breadbrich Engels deploy safety (legacy memory item)
Per earlier notes: `rsync` clobbered `.env`, sessions cached stale source, merge conflicts broke containers. All three are now handled by the safe-deploy script, but re-read `feedback_breadbrich_deploy_safety.md` before making changes to deploy scripts.

---

## Deploy notifications

After a successful deploy that **advanced `main`** (`OLD != NEW`), `safe-deploy.sh`
runs `setup/deploy-notify.mjs <deployed-sha>` as the app user. It looks up the PR
the deployed commit came from and comments on it, @-mentioning whoever merged it:
*"🚀 Deployed to production — @user your changes from #NN are now live."*

- **Fires once per merge.** No-op re-syncs and the auto-deploy reconciler's idle
  ticks re-run the deploy at the same SHA; the `OLD != NEW` guard skips those so
  nobody is re-pinged.
- **Best-effort, never fatal.** The helper always exits 0. A missing token, a
  direct push with no PR, or a GitHub error just logs a line — a notification
  can never fail or roll back an otherwise-healthy deploy.
- **Auth — reuses the existing token.** No new token or file: it uses the same
  `GITHUB_PERSONAL_ACCESS_TOKEN` the bot already relies on for the GitHub MCP
  server and project sync (already PR/issue-write capable), read from
  `$DEPLOY_ROOT/.env` the same way `src/env.ts` does. Resolution order:
  `$DEPLOY_NOTIFY_TOKEN` → `$GITHUB_PERSONAL_ACCESS_TOKEN` / `$GH_TOKEN` (env) →
  the same keys parsed from `.env`. If none resolves it logs and skips.
- **Config.** `NOTIFY_REPO` overrides the target repo (default `BreadchainCoop/labor.fun`).

---

## Future options (alternatives to rsync)

Ranked by effort vs impact. Not urgent — current system works.

### A. Git-pull on droplet (recommended next step)
Droplet clones the fork (shallow) and `git pull` during deploy. Benefits: local Mac is no longer source of truth, CI on GitHub is. Drawbacks: deploy key on droplet, first-time clone setup. **Effort: 1-2 hours. Impact: high.**

### B. Capistrano-style atomic releases
Each deploy is a timestamped directory under `/opt/breadbrich/releases/`; `/opt/breadbrich/current` is a symlink. Rollback = re-symlink. Benefits: sub-second rollback, no tar extraction. Drawbacks: every release is a full checkout (disk growth), symlink-aware for stateful paths (`store/`, `groups/`, `.env` live outside release dirs, symlinked in). **Effort: half day. Impact: high.**

### C. GitHub Actions triggered by merge-to-main
`.github/workflows/deploy.yml` SSH'es to droplet and runs `safe-deploy.sh`. Benefits: true-ish CD, no manual trigger. Drawbacks: SSH secret in GH, need to gate on merge-to-main only. **Effort: 1-2 hours. Impact: medium.**

### D. DO Spaces for off-site backups
`rclone` on droplet pushes to DigitalOcean Spaces nightly. Benefits: Mac-independent off-site, 11 9s durability. Drawbacks: $5/mo base + IAM setup. **Effort: 1 hour. Impact: medium** (depends on how often Mac is off).

### E. Docker image deployment — **available (opt-in)**
The agent container is built in CI (`.github/workflows/container.yml`), but only
when `container/**` (or the workflow file) changes: such a PR build-checks the
Dockerfile, and such a push to main publishes a SHA-pinned image to GHCR
(`ghcr.io/<org>/nanoclaw-agent:<sha>` + `:latest`, linux/amd64). Commits that
don't touch `container/**` produce no new image, so the deploy keeps using the
existing one. To make the host pull it instead of building locally, set in the
profile's `deploy.config`:

```
CONTAINER_REGISTRY_IMAGE=ghcr.io/<org>/nanoclaw-agent
# plus REGISTRY_TOKEN/REGISTRY_USER if the GHCR package is private
```

The deploy then pulls `<image>:<deployed-sha>` and retags it to
`nanoclaw-agent:latest` (the app's `CONTAINER_IMAGE` default — no app change).
Benefits: the ~10-min chromium build moves off the host, the image is provably
built from a main SHA, and rollback is a re-pull. If `CONTAINER_REGISTRY_IMAGE`
is unset the deploy keeps the legacy host-build behavior. Local macOS (arm64)
dev still uses `container/build.sh`.

### F. Kamal
37signals' zero-downtime container deployer. Good if we containerize the orchestrator itself. **Effort: days. Impact: low unless we add more hosts.**

### G. Ansible / pyinfra
Config-management tooling. Good if droplet config drifts or we add more hosts. **Effort: days. Impact: low for single-host.**

**Recommended path**: `A → B → C` over the next few weeks. `D` in parallel. Everything else: skip.

---

## Files

| Path | Purpose |
| --- | --- |
| `scripts/deploy.sh` | Local driver — kicks off droplet-side `safe-deploy.sh` over SSH |
| `scripts/safe-deploy.sh` | **Canonical source** for the droplet's safe-deploy script. Manually `scp` to droplet on change (see gotcha #2). |
| `scripts/pull-backups.sh` | Pull droplet backups to Mac |
| `/opt/breadbrich-backups/backup.sh` | Droplet backup script |
| `/opt/breadbrich-backups/safe-deploy.sh` | Droplet copy of the deploy script (snapshot → build → health-check → rollback). Should match `scripts/safe-deploy.sh` in this repo. |
| `/etc/cron.d/breadbrich-backup` | Daily + weekly cron |
| `/opt/breadbrich-backups/deploy.log` | Deploy history |
| `/opt/breadbrich-backups/backup.log` | Backup history |
