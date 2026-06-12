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

# --- Resolve active profile + infra config (defaults preserve breadchain) ---
# Profiles are host-local (gitignored); read infra config from the LIVE install,
# not the git mirror.
BOOT_ROOT="${DEPLOY_ROOT:-/opt/breadbrich}"
PROFILE="${LABOR_PROFILE:-}"
if [ -z "$PROFILE" ] && [ -d "$BOOT_ROOT/profiles" ]; then
  PROFILE="$(ls "$BOOT_ROOT/profiles" 2>/dev/null | grep -vx example | head -n1 || true)"
fi
PROFILE="${PROFILE:-breadchain}"
DEPLOY_CONFIG="$BOOT_ROOT/profiles/$PROFILE/deploy.config"
# shellcheck disable=SC1090
[ -f "$DEPLOY_CONFIG" ] && . "$DEPLOY_CONFIG"
SOURCE="${GIT_DIR:-/opt/breadbrich-git}"
DEPLOY_ROOT="${DEPLOY_ROOT:-/opt/breadbrich}"
BACKUP_DIR="${BACKUP_DIR:-/opt/breadbrich-backups}"
SERVICE_NAME="${SERVICE_NAME:-breadbrich}"
KB_SERVICE_NAME="${KB_SERVICE_NAME:-breadbrich-kb}"
SERVICE_USER="${SERVICE_USER:-breadbrich}"
BACKUP_SCRIPT="$BACKUP_DIR/backup.sh"
LOG="$BACKUP_DIR/deploy.log"
PROFILE_REL="profiles/$PROFILE"

log() { echo "[$(date -Iseconds)] $*" | tee -a "$LOG"; }

rollback() {
  log "!!! $1 !!! Rolling back from $LAST_BACKUP"
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  cd /
  tar -xzf "$LAST_BACKUP" 2>> "$LOG"
  log "Files restored. Reinstalling deps from snapshot package.json..."
  su - "$SERVICE_USER" -c "cd $DEPLOY_ROOT && npm install --no-audit --no-fund" >> "$LOG" 2>&1 || log "WARN: npm install failed in rollback"
  systemctl start "$SERVICE_NAME"
  sleep 3
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    log "Rollback OK: $SERVICE_NAME active."
  else
    log "CRITICAL: $SERVICE_NAME did not recover. Manual intervention required."
  fi
  exit 1
}

[ ! -d "$SOURCE" ] && { log "ERROR: $SOURCE missing. Run setup-droplet-gitpull.sh first."; exit 1; }

STATEFUL_PATHS=(
  ".env" ".env.bak-*"
  # Org profiles are host-local (gitignored, not in the mirror). Preserve the
  # whole active profile + any other profile's runtime so rsync --delete can't
  # wipe them. Only `example` (tracked template) syncs from the mirror.
  "$PROFILE_REL" "profiles/*/store" "profiles/*/data" "profiles/staging" "logs"
  "kb-ui/users.json"
  "repo-tokens"
  "node_modules" ".npm-cache"
)

log "=== Starting labor.fun safe deploy (from $SOURCE, profile: $PROFILE) ==="

# One-time migration: relocate legacy root-level state into the active
# profile so rsync --delete can't wipe it. Idempotent.
PROFILE_ABS="$DEPLOY_ROOT/$PROFILE_REL"
mkdir -p "$PROFILE_ABS"
for d in store data groups; do
  if [ -e "$DEPLOY_ROOT/$d" ] && [ ! -e "$PROFILE_ABS/$d" ]; then
    log "Migrating legacy $d -> $PROFILE_REL/$d"
    mv "$DEPLOY_ROOT/$d" "$PROFILE_ABS/$d"
  fi
done
if [ -f "$DEPLOY_ROOT/setup/breadbrich-deploy.env" ] && [ ! -e "$PROFILE_ABS/deploy.env" ]; then
  log "Migrating legacy setup/breadbrich-deploy.env -> $PROFILE_REL/deploy.env"
  mv "$DEPLOY_ROOT/setup/breadbrich-deploy.env" "$PROFILE_ABS/deploy.env"
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$PROFILE_ABS" 2>/dev/null || true

# Fetch latest main
log "git fetch + reset --hard origin/main..."
# Record HEAD before the reset so the success path can tell whether this deploy
# actually advanced main (and thus whether to notify the merger).
PREV_SHA_FULL=$(su - "$SERVICE_USER" -c "cd $SOURCE && git rev-parse HEAD" 2>/dev/null || echo "")
su - "$SERVICE_USER" -c "cd $SOURCE && git fetch origin main && git reset --hard origin/main" >> "$LOG" 2>&1 || { log "git fetch/reset failed"; exit 1; }
CURRENT_SHA=$(su - "$SERVICE_USER" -c "cd $SOURCE && git rev-parse --short HEAD")
CURRENT_SHA_FULL=$(su - "$SERVICE_USER" -c "cd $SOURCE && git rev-parse HEAD")
log "HEAD now at: $CURRENT_SHA"

# Pre-deploy snapshot
log "Pre-deploy snapshot..."
su - "$SERVICE_USER" -c "$BACKUP_SCRIPT pre-deploy" >> "$LOG" 2>&1 || { log "Backup failed"; exit 1; }
LAST_BACKUP=$(ls -t "$BACKUP_DIR/pre-deploy/"*.tar.gz | head -1)
log "Snapshot: $LAST_BACKUP"

# Record predeploy deps to detect if npm install is needed
cp $DEPLOY_ROOT/package.json /tmp/$SERVICE_NAME-pre-pkg.json 2>/dev/null || true
cp $DEPLOY_ROOT/package-lock.json /tmp/$SERVICE_NAME-pre-lock.json 2>/dev/null || true

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
chown -R "$SERVICE_USER:$SERVICE_USER" "$DEPLOY_ROOT"

# Install deps only if package.json or lock changed
if ! cmp -s /tmp/$SERVICE_NAME-pre-pkg.json $DEPLOY_ROOT/package.json 2>/dev/null || ! cmp -s /tmp/$SERVICE_NAME-pre-lock.json $DEPLOY_ROOT/package-lock.json 2>/dev/null; then
  log "Deps changed — npm install..."
  su - "$SERVICE_USER" -c "cd $DEPLOY_ROOT && npm install --no-audit --no-fund" >> "$LOG" 2>&1 || rollback "npm install failed"
else
  log "Deps unchanged — skipping npm install"
fi

log "npm run build..."
su - "$SERVICE_USER" -c "cd $DEPLOY_ROOT && npm run build" >> "$LOG" 2>&1 || rollback "build failed"

# Container image: pull CI-built SHA-pinned image from the registry if
# CONTAINER_REGISTRY_IMAGE is set (in deploy.config), retagging it to
# nanoclaw-agent:latest — the tag the app expects (CONTAINER_IMAGE default in
# src/config.ts) and that container/build.sh produces. Keeps the ~10-min
# chromium build off the host. Falls back to a host build when no registry is
# configured (legacy) or the pull fails with no local image.
LOCAL_IMAGE="nanoclaw-agent:latest"
if [ -n "${CONTAINER_REGISTRY_IMAGE:-}" ]; then
  REGISTRY_HOST="${REGISTRY_HOST:-ghcr.io}"
  # A token requires the matching REGISTRY_USER (the PAT owner) — GHCR rejects a
  # placeholder username — so skip login with a clear warning if it's missing.
  if [ -n "${REGISTRY_TOKEN:-}" ]; then
    if [ -z "${REGISTRY_USER:-}" ]; then
      log "WARN: REGISTRY_TOKEN set but REGISTRY_USER is not — skipping docker login (set REGISTRY_USER to the PAT owner, or make the package public)"
    else
      echo "$REGISTRY_TOKEN" | docker login "$REGISTRY_HOST" -u "$REGISTRY_USER" --password-stdin >/dev/null 2>&1 \
        || log "WARN: docker login to $REGISTRY_HOST failed — continuing (image may be public)"
    fi
  fi
  # Pull the image for the LAST commit that touched container/ — CI only
  # publishes images for those commits, so $CURRENT_SHA_FULL usually has no
  # image of its own, and on container-touching merges the deploy races CI's
  # build (the single pull failed and was never retried, leaving the tag
  # stale). Retry briefly when this deploy changed container/; the
  # auto-deploy idle reconciler converges anything slower.
  IMAGE_SHA=$(su - "$SERVICE_USER" -c "cd $SOURCE && git log -1 --format=%H -- container/" 2>/dev/null || true)
  IMAGE_SHA="${IMAGE_SHA:-$CURRENT_SHA_FULL}"
  REMOTE_REF="$CONTAINER_REGISTRY_IMAGE:$IMAGE_SHA"
  PULL_TRIES=1
  [ "$CONTAINER_CHANGED" = "1" ] && PULL_TRIES="${IMAGE_PULL_TRIES:-6}"
  pulled=0
  for attempt in $(seq 1 "$PULL_TRIES"); do
    log "Pulling agent image $REMOTE_REF (attempt $attempt/$PULL_TRIES)"
    if docker pull "$REMOTE_REF" >> "$LOG" 2>&1; then
      pulled=1
      break
    fi
    [ "$attempt" -lt "$PULL_TRIES" ] && sleep "${IMAGE_PULL_DELAY:-20}"
  done
  if [ "$pulled" = "1" ]; then
    docker tag "$REMOTE_REF" "$LOCAL_IMAGE"
    log "Tagged $REMOTE_REF -> $LOCAL_IMAGE"
  elif docker image inspect "$LOCAL_IMAGE" >/dev/null 2>&1; then
    log "WARN: pull failed for $REMOTE_REF — keeping existing $LOCAL_IMAGE (auto-deploy's reconciler retags once CI publishes)"
  else
    log "WARN: pull failed and no local $LOCAL_IMAGE — building on host as fallback"
    su - "$SERVICE_USER" -c "cd $DEPLOY_ROOT && ./container/build.sh" >> "$LOG" 2>&1 || rollback "container build failed"
  fi
elif [ "$CONTAINER_CHANGED" = "1" ]; then
  log "Rebuilding container..."
  su - "$SERVICE_USER" -c "cd $DEPLOY_ROOT && ./container/build.sh" >> "$LOG" 2>&1 || rollback "container build failed"
fi

log "Restarting Breadbrich Engels..."
systemctl restart "$SERVICE_NAME"
systemctl restart "$KB_SERVICE_NAME"
sleep 5

for i in 1 2 3 4 5 6; do
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    if journalctl -u "$SERVICE_NAME" --since "60 seconds ago" | grep -q "Credential proxy started"; then
      log "Breadbrich Engels active, credential proxy up. Deploy @ $CURRENT_SHA complete."
      rm -f /tmp/$SERVICE_NAME-pre-pkg.json /tmp/$SERVICE_NAME-pre-lock.json
      # Notify the merger their change is live — only when HEAD advanced this
      # run, and never fatally (a notification must not fail a healthy deploy).
      if [ "${PREV_SHA_FULL:-}" != "$CURRENT_SHA_FULL" ] && [ -f "$DEPLOY_ROOT/setup/deploy-notify.mjs" ]; then
        log "Notify merger that $CURRENT_SHA is live"
        su - "$SERVICE_USER" -c "cd $DEPLOY_ROOT && DEPLOY_ROOT='$DEPLOY_ROOT' NOTIFY_REPO='${NOTIFY_REPO:-}' node setup/deploy-notify.mjs '$CURRENT_SHA_FULL'" >> "$LOG" 2>&1 \
          || log "deploy-notify failed (non-fatal)"
      fi
      exit 0
    fi
  fi
  sleep 3
done

rollback "health check failed"
