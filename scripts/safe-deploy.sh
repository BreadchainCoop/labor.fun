#!/bin/bash
# labor.fun safe deploy — sources code from /opt/breadbrich-git/ (GitHub main).
#
# NOTE: setup/safe-deploy.sh is the canonical, self-updating deploy script
# (installed to /opt/breadbrich-backups/safe-deploy.sh and refreshed on every
# run). This scripts/ copy is a secondary variant kept in sync by hand.
#
# RUNS ON THE DROPLET (not locally).
#
# Org-specific state (store/, data/, groups/) lives under profiles/$PROFILE/
# (see src/profile.ts). Flow:
#   1. git fetch + reset --hard to latest origin/main in /opt/breadbrich-git/
#   2. Migrate any legacy root-level state into profiles/$PROFILE/
#   3. Pre-deploy snapshot
#   4. rsync /opt/breadbrich-git/ -> /opt/breadbrich/ (preserving stateful paths)
#   5. npm install (only if deps changed)
#   6. npm run build
#   7. Optional container rebuild
#   8. Restart services; health check; rollback on failure

set -uo pipefail

SOURCE="/opt/breadbrich-git"
DEPLOY_ROOT="/opt/breadbrich"
BACKUP_SCRIPT="/opt/breadbrich-backups/backup.sh"
LOG="/opt/breadbrich-backups/deploy.log"

# Active profile — its groups/store/data are the stateful paths to preserve.
DEPLOY_ENV="$DEPLOY_ROOT/setup/breadbrich-deploy.env"
PROFILE="${LABOR_PROFILE:-}"
if [ -z "$PROFILE" ] && [ -f "$DEPLOY_ENV" ]; then
  PROFILE="$(grep -E '^LABOR_PROFILE=' "$DEPLOY_ENV" | tail -1 | cut -d= -f2- | tr -d '"'"'"'"' || true)"
fi
PROFILE="${PROFILE:-breadchain}"
PROFILE_REL="profiles/$PROFILE"

log() { echo "[$(date -Iseconds)] $*" | tee -a "$LOG"; }

rollback() {
  log "!!! $1 !!! Rolling back from $LAST_BACKUP"
  systemctl stop breadbrich 2>/dev/null || true
  cd /
  tar -xzf "$LAST_BACKUP" 2>> "$LOG"
  log "Files restored. Reinstalling deps from snapshot package.json..."
  su - breadbrich -c "cd $DEPLOY_ROOT && npm install --no-audit --no-fund" >> "$LOG" 2>&1 || log "WARN: npm install failed in rollback"
  systemctl start breadbrich
  sleep 3
  if systemctl is-active --quiet breadbrich; then
    log "Rollback OK: Breadbrich Engels active."
  else
    log "CRITICAL: Breadbrich Engels did not recover. Manual intervention required."
  fi
  exit 1
}

[ ! -d "$SOURCE" ] && { log "ERROR: $SOURCE missing. Run setup-droplet-gitpull.sh first."; exit 1; }

STATEFUL_PATHS=(
  ".env" ".env.bak-*"
  "$PROFILE_REL/store" "$PROFILE_REL/data" "$PROFILE_REL/groups" "logs"
  "kb-ui/users.json"
  "repo-tokens"
  "node_modules" ".npm-cache"
)

log "=== Starting labor.fun safe deploy (from $SOURCE, profile: $PROFILE) ==="

# One-time migration: relocate legacy root-level state into the active
# profile so rsync --delete can't wipe it. Idempotent.
PROFILE_ABS="$DEPLOY_ROOT/$PROFILE_REL"
for d in store data groups; do
  if [ -e "$DEPLOY_ROOT/$d" ] && [ ! -e "$PROFILE_ABS/$d" ]; then
    log "Migrating legacy $d -> $PROFILE_REL/$d"
    mkdir -p "$PROFILE_ABS"
    mv "$DEPLOY_ROOT/$d" "$PROFILE_ABS/$d"
  fi
done
chown -R breadbrich:breadbrich "$PROFILE_ABS" 2>/dev/null || true

# Fetch latest main
log "git fetch + reset --hard origin/main..."
su - breadbrich -c "cd $SOURCE && git fetch origin main && git reset --hard origin/main" >> "$LOG" 2>&1 || { log "git fetch/reset failed"; exit 1; }
CURRENT_SHA=$(su - breadbrich -c "cd $SOURCE && git rev-parse --short HEAD")
log "HEAD now at: $CURRENT_SHA"

# Pre-deploy snapshot
log "Pre-deploy snapshot..."
su - breadbrich -c "$BACKUP_SCRIPT pre-deploy" >> "$LOG" 2>&1 || { log "Backup failed"; exit 1; }
LAST_BACKUP=$(ls -t /opt/breadbrich-backups/pre-deploy/*.tar.gz | head -1)
log "Snapshot: $LAST_BACKUP"

# Record predeploy deps to detect if npm install is needed
cp $DEPLOY_ROOT/package.json /tmp/breadbrich-pre-pkg.json 2>/dev/null || true
cp $DEPLOY_ROOT/package-lock.json /tmp/breadbrich-pre-lock.json 2>/dev/null || true

# Detect container source changes
CONTAINER_CHANGED=0
if ! diff -rq $DEPLOY_ROOT/container $SOURCE/container >/dev/null 2>&1; then
  CONTAINER_CHANGED=1
fi

# Rsync source -> deploy (preserve stateful)
EXCLUDES=()
for p in "${STATEFUL_PATHS[@]}"; do EXCLUDES+=(--exclude="$p"); done
EXCLUDES+=(--exclude=".git" --exclude=".github")
log "Syncing code..."
rsync -a --delete "${EXCLUDES[@]}" "$SOURCE/" "$DEPLOY_ROOT/" || rollback "rsync failed"
chown -R breadbrich:breadbrich "$DEPLOY_ROOT"

# Install deps only if package.json or lock changed
if ! cmp -s /tmp/breadbrich-pre-pkg.json $DEPLOY_ROOT/package.json 2>/dev/null || ! cmp -s /tmp/breadbrich-pre-lock.json $DEPLOY_ROOT/package-lock.json 2>/dev/null; then
  log "Deps changed — npm install..."
  su - breadbrich -c "cd $DEPLOY_ROOT && npm install --no-audit --no-fund" >> "$LOG" 2>&1 || rollback "npm install failed"
else
  log "Deps unchanged — skipping npm install"
fi

log "npm run build..."
su - breadbrich -c "cd $DEPLOY_ROOT && npm run build" >> "$LOG" 2>&1 || rollback "build failed"

if [ "$CONTAINER_CHANGED" = "1" ]; then
  log "Rebuilding container..."
  su - breadbrich -c "cd $DEPLOY_ROOT && ./container/build.sh" >> "$LOG" 2>&1 || rollback "container build failed"
fi

log "Restarting Breadbrich Engels..."
systemctl restart breadbrich
systemctl restart breadbrich-kb
sleep 5

for i in 1 2 3 4 5 6; do
  if systemctl is-active --quiet breadbrich; then
    if journalctl -u breadbrich --since "60 seconds ago" | grep -q "Credential proxy started"; then
      log "Breadbrich Engels active, credential proxy up. Deploy @ $CURRENT_SHA complete."
      rm -f /tmp/breadbrich-pre-pkg.json /tmp/breadbrich-pre-lock.json
      exit 0
    fi
  fi
  sleep 3
done

rollback "health check failed"
