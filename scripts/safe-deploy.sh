#!/bin/bash
# Breadbrich Engels safe deploy — sources code from /opt/breadbrich-git/ (GitHub main).
#
# RUNS ON THE DROPLET (not locally). Lives at /opt/breadbrich-backups/safe-deploy.sh.
# This file in the repo is the CANONICAL SOURCE; when it changes, copy it to
# the droplet: `scp scripts/safe-deploy.sh "$DROPLET_HOST:/opt/breadbrich-backups/safe-deploy.sh"`
# (the local ./scripts/deploy.sh wrapper does NOT auto-sync this — manual for now).
#
# Flow:
#   1. git fetch + reset --hard to latest origin/main in /opt/breadbrich-git/
#   2. Pre-deploy snapshot
#   3. rsync /opt/breadbrich-git/ -> /opt/breadbrich/ (preserving stateful paths)
#   4. npm install (only if deps changed)
#   5. npm run build
#   6. Optional container rebuild
#   7. Restart Breadbrich Engels
#   8. Health check; rollback on failure

set -uo pipefail

SOURCE="/opt/breadbrich-git"
DEPLOY_ROOT="/opt/breadbrich"
BACKUP_SCRIPT="/opt/breadbrich-backups/backup.sh"
LOG="/opt/breadbrich-backups/deploy.log"

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
  "store" "data" "groups" "logs"
  "kb-ui/users.json"
  "repo-tokens"
  "node_modules" ".npm-cache"
)

log "=== Starting Breadbrich Engels safe deploy (from $SOURCE) ==="

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
