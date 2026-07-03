# Breadbrich Engels Migration Runbook

**Purpose:** step-by-step procedure for the breadbrich → breadbrich orchestrator consolidation with verify gates + rollback triggers at each stage.

**Status:** Draft for review

**Rule:** never cross two irreversible steps in one deploy. Each phase has a verify window before the next.

## Phase ordering (blast-radius smallest first)

| Phase | Scope | Reversibility | Risk |
|---|---|---|---|
| **Phase 0** | Docs + backup + drain + staging VPS | Fully reversible (read-only on prod) | None |
| **Phase 1** | Cosmetic rename: systemd alias `breadbrich.service` → `breadbrich.service`, Cloudflare tunnel label rename | Trivially reversible | Very low |
| **Phase 2** | the central orchestrator orchestrator: SDK init, routing rules, Observer/Reflector, thin-forwarder containers | Medium — ~5min rollback via symlink flip | Medium |
| **Phase 3** | Filesystem rename: `/opt/breadbrich` → `/opt/breadbrich` with symlink bridge | Reversible for 1 month via `/opt/breadbrich.old` retention | Medium |
| **Phase 4** | *(Optional, recommended skip)* User account rename `breadbrich` → `breadbrich` | Hard — many config files touched | High, low reward |
| **Phase 5** | Cleanup: remove `/opt/breadbrich.old`, drop `breadbrich.service` alias | Irreversible per step | Irreversible |

Between phases: minimum 1 week verification. Phase 3 holds for 1 month before Phase 5.

## Universal gate (run before every deploy phase)

```bash
# 1. Verify backup exists + checksum
ssh "$DROPLET_HOST" '/opt/breadbrich-backups/backup.sh pre-deploy'
# Wait for "Done: ..." output

# 2. Take snapshot for rollback
ssh "$DROPLET_HOST" 'ls -t /opt/breadbrich-backups/pre-deploy/*.tar.gz | head -1'
# Note this filename — it's the rollback point for this phase

# 3. Verify services healthy
ssh "$DROPLET_HOST" 'systemctl is-active breadbrich breadbrich-kb cloudflared'
# All "active"

# 4. Verify git in sync
cd /local/breadbrich && git fetch cvnt && git status
# Clean working tree, on feature branch

# 5. Verify no critical in-flight
ssh "$DROPLET_HOST" 'docker ps; find /opt/breadbrich/data/ipc -name "*.json" -not -name "current_*" -not -name "available_*" -not -name "current_events*"'
# No unprocessed messages
```

If any check fails, STOP. Do not proceed.

## Phase 0 — Consolidation + safety net

**Goal:** every piece of state captured; docs + plan approved; staging ready; no prod changes.

### 0.1 — Git triage ✅ DONE 2026-04-21
- 15 merged branches deleted
- 3 real-diff branches preserved as tags
- 3 old remotes pruned
- `kb-ui/budget-dashboard` pushed + PR #27 open
- Worktrees cleaned

### 0.2 — Droplet src divergence resolution ✅ DONE (was already resolved)
- Verified all 4 previously-diverged files are byte-identical between droplet and `cvnt/main`
- `writeEventsSnapshot`, `onEventsChanged`, `buildEventsSnapshot` all present in git

### 0.3 — breadbrich-tunnel deprecated ✅ DONE 2026-04-21
- Unit file moved to `/etc/systemd/system/breadbrich-tunnel.service.deprecated-2026-04-21`
- Masked via `/dev/null` symlink
- Live tunnel is `cloudflared.service` (the infra owner's setup, unrelated)

### 0.4 — Pre-migration master backup ✅ DONE 2026-04-21
- `/opt/breadbrich-backups/pre-migration/breadbrich-premig-20260421-040545.tar.gz` (31M)
- Copy at `~/Documents/Code/Claude/breadbrich-backups/pre-migration-2026-04-21/`
- SHA256 verified both sides
- Gap items captured: SSH keys, .netrc, systemd, cron, tunnel token, journal

### 0.5 — GPG encryption + third offsite (PENDING)
```bash
# On local Mac (user provides passphrase)
cd ~/Documents/Code/Claude/breadbrich-backups/pre-migration-2026-04-21
gpg --symmetric --cipher-algo AES256 --output breadbrich-premig-20260421-040545.tar.gz.gpg breadbrich-premig-20260421-040545.tar.gz
# Verify
gpg --decrypt --output /tmp/verify.tar.gz breadbrich-premig-20260421-040545.tar.gz.gpg
shasum -a 256 /tmp/verify.tar.gz
# Must match 0aa656d10cf5088bcba95a009f15f665142fb79fb69614d638b5d22e9fb4ad8f
rm /tmp/verify.tar.gz

# Third offsite — pick one:
# Option A: iCloud
cp breadbrich-premig-20260421-040545.tar.gz.gpg ~/Library/Mobile\ Documents/com~apple~CloudDocs/breadbrich-backups/
# Option B: DO Spaces (requires s3cmd or aws-cli configured)
# Option C: external drive
```
**Gate:** three copies exist, all checksums verified.

### 0.6 — Staging VPS (PENDING)
```bash
# Create staging droplet ($24/mo, destroy after)
doctl compute droplet create breadbrich-staging --size s-2vcpu-4gb --image ubuntu-22-04-x64 --region nyc1 --ssh-keys <key-id>
# Copy master tarball to staging
scp breadbrich-premig-*.tar.gz.gpg root@<staging-ip>:/root/
# SSH in, decrypt, extract to /opt/breadbrich-staging/ (not /opt/breadbrich)
# Install node + sqlite + cloudflared
# Restore tarball into /opt/breadbrich-staging/
# Issue new @breadbrich_staging_bot token via BotFather, put in staging .env
# Start services via modified systemd units pointing at /opt/breadbrich-staging/
# Verify staging bot responds to test message
```
**Gate:** staging bot echoes a test message. Destroy staging after all phases complete.

### 0.7 — Context drain (PENDING)
```bash
# On droplet (read-only — safe)
mkdir -p /opt/breadbrich/drain/2026-04-21/{archive,observations,database}

# Archive raw jsonl transcripts
rsync -a /opt/breadbrich/data/sessions/ /opt/breadbrich/drain/2026-04-21/archive/

# Database exports
sqlite3 /opt/breadbrich/store/messages.db ".mode csv" ".output /opt/breadbrich/drain/2026-04-21/database/agent-runs.csv" "SELECT * FROM agent_runs;"
sqlite3 /opt/breadbrich/store/messages.db ".mode csv" ".output /opt/breadbrich/drain/2026-04-21/database/kb-audit-log.csv" "SELECT * FROM kb_audit_log;"
sqlite3 /opt/breadbrich/store/messages.db ".mode json" ".output /opt/breadbrich/drain/2026-04-21/database/scheduled-tasks.json" "SELECT * FROM scheduled_tasks;"
sqlite3 /opt/breadbrich/store/messages.db ".mode json" ".output /opt/breadbrich/drain/2026-04-21/database/user-identities.json" "SELECT * FROM user_identities;"

# Observer replay (runs when the central orchestrator exists — deferred to Phase 2)
# For now: placeholder

# Manifest
cd /opt/breadbrich/drain/2026-04-21
find . -type f -exec sha256sum {} \; > manifest.sha256
cat > manifest.json <<EOF
{
  "drain_date": "2026-04-21",
  "source_droplet": "$DROPLET_HOST",
  "source_path": "/opt/breadbrich",
  "archive_files": $(find archive -type f | wc -l),
  "db_exports": ["agent-runs.csv", "scheduled-tasks.json", "user-identities.json", "kb-audit-log.csv"],
  "observations_generated": false,
  "next_step": "the central orchestrator Observer will generate observations/ in Phase 2"
}
EOF
```
**Gate:** manifest.json shows expected file counts, all sha256 match on re-verify.

### 0.8 — Docs + YAML + viz reviewed + approved (THIS PHASE)
- BREADBRICH-ORCHESTRATION.md ✅
- DATA-INVENTORY.md ✅
- STATE-RECOVERY-MAP.md ✅
- MIGRATION-RUNBOOK.md ✅ (this file)
- routing-rules.yaml ✅
- breadbrich-architecture.html ✅
- IMPLEMENTATION-ROADMAP.md ✅

**Gate:** user reviews HTML viz, approves plan, PR merged to cvnt/main, tagged `v2.0.0-spec`.

### 0.9 — Memory file updates
- `reference_breadbrich_state_recovery.md` ✅ written
- `feedback_breadbrich_naming_consistency.md` — deprecate (reverse the rule)
- `reference_breadbrich_credentials.md` → rename to `reference_breadbrich_credentials.md`
- `feedback_breadbrich_droplet_divergence.md` — mark as RESOLVED 2026-04-21
- `project_breadbrich_migration.md` — new, tracks phase state

**Rollback for Phase 0:** discard local memory edits (git-style), nothing on prod touched.

## Phase 1 — Cosmetic rename

**Goal:** `breadbrich.service` also accessible as `breadbrich.service`. `breadbrich-tunnel` already gone. User-facing identity says Breadbrich Engels everywhere.

### 1.1 — systemd alias
```bash
# On droplet
cp /etc/systemd/system/breadbrich.service /etc/systemd/system/breadbrich.service.bak-$(date +%Y%m%d)
# Edit breadbrich.service: add to [Install] section: Alias=breadbrich.service
systemctl daemon-reload
systemctl disable breadbrich  # clears old symlinks
systemctl enable breadbrich   # re-creates enable symlink + alias symlink
# Verify both work
systemctl status breadbrich.service
systemctl status breadbrich.service
```
**Gate:** both `systemctl status breadbrich` and `systemctl status breadbrich` show same unit, both active.
**Rollback:** `mv breadbrich.service.bak-* breadbrich.service && systemctl daemon-reload`.

### 1.2 — breadbrich-kb alias similarly
```bash
# Same as 1.1 for breadbrich-kb.service, alias=breadbrich-kb.service
```

### 1.3 — Cloudflare tunnel label rename (cosmetic only)
- In Cloudflare dashboard → Zero Trust → Tunnels → rename display label to "breadbrich" (was "breadbrich" or similar)
- UUID unchanged, DNS unchanged, zero downtime

**Phase 1 verify window:** 1 week. Both names must work. Any tool/script/alert that uses "breadbrich" should keep working via the alias.

## Phase 2 — the central orchestrator orchestrator

**Goal:** evolve `breadbrich.service` from pure router to full orchestrator with SDK + routing + dreaming. Thin-forwarder containers.

### 2.1 — Inline Anthropic SDK in `breadbrich.service`
- Add `@anthropic-ai/sdk` initialization at host startup
- Reads credentials from `.env` via existing `credential-proxy` path
- Creates session manager keyed on `(group_folder, sender_identity)`
- Unit tests: session creation, session resume, credential injection

### 2.2 — Load `routing-rules.yaml` at startup
- New module `src/router-rules.ts`
- Parses `docs/architecture/routing-rules.yaml`
- Validates schema at startup; failure = don't start
- Evaluator function: `evaluateRule(request) → { route, share_back, auth_ok, log_to }`

### 2.3 — Wire forward flow
- New IPC type `forward_to_big_breadbrich` handler in `ipc.ts`
- Router receives forwarded request, applies rules, calls SDK, writes response file
- Thin-forwarder code in `container/agent-runner/src/` simplified to forward-and-relay
- Session-cache bind-mount surface unchanged — agent-runner-src updated

### 2.4 — Classifier (Haiku pre-pass)
- Every inbound goes through classifier first
- `request_type = casual_social && confidence > 0.8` → react-only, skip SDK
- Logs classifier output for review

### 2.5 — Observer job
- New scheduled task type
- Runs per chat every 15min
- Appends to `groups/{chat}/observations.md`
- Uses existing `schedule_task` infrastructure with cron `*/15 * * * *`

### 2.6 — Reflector job
- Daily 2am cron
- Compresses observations older than 7 days
- Detects + flags duplicates to `reflector-queue.md`
- Rebuilds `MEMORY.md` pointer index

### 2.7 — Curator job
- Weekly Sunday 3am
- Tiers KB (hot/warm/cold)
- Archives old observations
- DB integrity check + backup rotation verify

### 2.8 — Deploy via safe-deploy.sh
```bash
# On droplet
/opt/breadbrich-backups/safe-deploy.sh
# Script runs: pre-deploy snapshot → git fetch → build → health check → rollback if fail
```
**Gate:** 
- All channel handlers responding
- One test message each from Slack + Telegram DM + Telegram group → the central orchestrator responds within 10s
- Observer produces non-empty observations.md after 1h
- No errors in journalctl

**Rollback:** safe-deploy auto-rolls back on health-check failure. Manual rollback: extract previous pre-deploy tarball.

**Phase 2 verify window:** 2 weeks. Monitor rate limits, latency, observation quality.

## Phase 3 — Filesystem path rename

**Goal:** `/opt/breadbrich/` → `/opt/breadbrich/` with zero downtime via copy + symlink bridge.

### 3.1 — Pre-flight
- Confirm all SQLite writers are quiesced: `PRAGMA wal_checkpoint(TRUNCATE)`
- Run universal gate

### 3.2 — Copy + swap
```bash
# On droplet
systemctl stop breadbrich breadbrich-kb
sqlite3 /opt/breadbrich/store/messages.db 'PRAGMA wal_checkpoint(TRUNCATE);'
cp -a /opt/breadbrich /opt/breadbrich  # preserve ownership, perms, xattrs
mv /opt/breadbrich /opt/breadbrich.old
ln -s /opt/breadbrich /opt/breadbrich  # compatibility symlink (backup-reads still work)
```

### 3.3 — Update unit files to reference /opt/breadbrich/
```bash
# Edit /etc/systemd/system/breadbrich.service: WorkingDirectory=/opt/breadbrich, ExecStart paths
# Edit /etc/systemd/system/breadbrich-kb.service: same
# (breadbrich-tunnel already masked — skip)
systemctl daemon-reload
systemctl start breadbrich breadbrich-kb
```
**Gate:** services healthy using /opt/breadbrich path. `/opt/breadbrich` symlink still works for any forgotten references.

### 3.4 — Verify 1 week
- No errors referencing old path
- Backups still run (they'll follow symlink)
- kb-ui + kb.example.com working

### 3.5 — Grep universe for remaining hardcoded references
```bash
ssh "$DROPLET_HOST" 'grep -rn "/opt/breadbrich" /etc/ /opt/breadbrich/scripts/ /home/breadbrich/ 2>/dev/null | grep -v Binary'
# Clean up any found
```

**Rollback (within 1 month):**
```bash
systemctl stop breadbrich breadbrich-kb
rm /opt/breadbrich  # remove symlink
mv /opt/breadbrich.old /opt/breadbrich
# Revert unit files from .bak copies
systemctl daemon-reload && systemctl start breadbrich breadbrich-kb
```

**Phase 3 verify window:** 1 month before removing /opt/breadbrich.old.

## Phase 4 — User account rename (OPTIONAL — recommend skip)

Research conclusion: high risk, low reward. System user name is invisible to end-users. Leave `breadbrich` user as-is unless cosmetic consistency is critical.

If you must:
```bash
# Schedule maintenance window (~30min)
systemctl stop breadbrich breadbrich-kb
pkill -u breadbrich
# Wait for processes to exit
usermod -l breadbrich -d /home/breadbrich -m breadbrich
groupmod -n breadbrich breadbrich
mv /var/spool/cron/crontabs/breadbrich /var/spool/cron/crontabs/breadbrich
chown breadbrich:breadbrich /var/spool/cron/crontabs/breadbrich
# Update sudoers (visudo), sshd_config, all .service User= directives
visudo -c  # validate
systemctl daemon-reload && systemctl start breadbrich breadbrich-kb cloudflared
```

**Rollback:** multi-file revert. Keep a git-tracked snapshot of `/etc/sudoers.d/`, `/etc/ssh/sshd_config`, all service files before starting. Without that snapshot, rollback is reconstructive + error-prone.

## Phase 5 — Cleanup (irreversible)

Each step only after verify window expires and no issues observed.

- Remove `/opt/breadbrich.old` (Phase 3 rollback copy)
- Drop `breadbrich.service` alias symlink (keep `breadbrich.service` only)
- Drop `/opt/breadbrich` symlink
- Archive old backups
- Tag repo `v3.0.0`

## Failure escalation

- If a phase fails health check: auto-rollback via safe-deploy
- If rollback fails: restore from pre-migration master tarball (R-13 procedure)
- If recovery takes >1h: notify the infra/tunnel owner and the on-call coordinator
- Post-incident: write incident note in `groups/slack_main/context/artifacts/incidents/YYYY-MM-DD-*.md`

## Known gotchas (from memory + research)

1. **Dual .env sync** — must update both `/opt/breadbrich/.env` AND `/home/breadbrich/.config/nanoclaw/.env` together
2. **SQLite WAL checkpoint** — run `PRAGMA wal_checkpoint(TRUNCATE)` before any DB file rename/copy
3. **UTC once-timestamps** — `schedule_task` with `schedule_type='once'` treats timestamps as local, not UTC. Document in rule YAML.
4. **Session-cached agent-runner-src** — `/opt/breadbrich/data/sessions/*/agent-runner-src/` is bind-mounted. Update with source changes or leave untouched — never delete during live session.
5. **`breadbrich-tunnel.service` is defunct** — do not revive. Live tunnel is `cloudflared.service`.
6. **No `cloudflared rename` command** — tunnel label changes are dashboard-only.
7. **Drop-in systemd overrides** at `/etc/systemd/system/breadbrich.service.d/*.conf` must be copied to alias path.
