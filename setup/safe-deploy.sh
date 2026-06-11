#!/usr/bin/env bash
# safe-deploy.sh — deploy labor.fun from GitHub main to this org's host.
#
# Source of truth is GitHub main, mirrored into $GIT_DIR, then synced into the
# live app dir ($DEPLOY_ROOT) preserving stateful paths. Honors the
# push -> merge -> deploy rule. Run as root: takes a backup, rolls back on
# any failure.
#
# Infra (install paths, systemd service names, OS user) is parameterized via
# profiles/$PROFILE/deploy.config; the defaults below reproduce the breadchain
# droplet. Org-specific state (groups/, store/, data/) lives under
# profiles/$PROFILE/ — see src/profile.ts.
set -euo pipefail

# --- Resolve active profile + infra config ---------------------------------
# Profiles are host-local (gitignored, not in the repo), so the infra config is
# read from the LIVE install ($DEPLOY_ROOT/profiles/<profile>/), not the git
# mirror. Override via env (DEPLOY_ROOT=..., LABOR_PROFILE=...) for a new org.
BOOT_ROOT="${DEPLOY_ROOT:-/opt/breadbrich}"
PROFILE="${LABOR_PROFILE:-}"
if [ -z "$PROFILE" ] && [ -d "$BOOT_ROOT/profiles" ]; then
  # Single non-example profile present? Use it (mirrors src/profile.ts).
  PROFILE="$(ls "$BOOT_ROOT/profiles" 2>/dev/null | grep -vx example | head -n1 || true)"
fi
PROFILE="${PROFILE:-breadchain}"
DEPLOY_CONFIG="$BOOT_ROOT/profiles/$PROFILE/deploy.config"
# shellcheck disable=SC1090
[ -f "$DEPLOY_CONFIG" ] && . "$DEPLOY_CONFIG"

# Infra vars — config wins, else breadchain-preserving defaults.
DEPLOY_ROOT="${DEPLOY_ROOT:-/opt/breadbrich}"
GIT_DIR="${GIT_DIR:-/opt/breadbrich-git}"
BACKUP_DIR="${BACKUP_DIR:-/opt/breadbrich-backups}"
SERVICE_NAME="${SERVICE_NAME:-breadbrich}"
KB_SERVICE_NAME="${KB_SERVICE_NAME:-breadbrich-kb}"
AUTO_DEPLOY_NAME="${AUTO_DEPLOY_NAME:-breadbrich-auto-deploy}"
SERVICE_USER="${SERVICE_USER:-breadbrich}"
# Runtime env lives in the profile (host-local), derived unless overridden.
DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-$DEPLOY_ROOT/profiles/$PROFILE/deploy.env}"

APP_DIR="$DEPLOY_ROOT"
BK_DIR="$BACKUP_DIR"
APP_USER="$SERVICE_USER"
PRE="$BK_DIR/pre-deploy"
TS="$(date -u +%Y%m%d-%H%M%S)"
SNAP="$PRE/$SERVICE_NAME-pre-deploy-$TS.tar.gz"
LOCK_FILE="/run/$SERVICE_NAME-deploy.lock"
PROFILE_REL="profiles/$PROFILE"

log() { echo "[safe-deploy $(date -u +%H:%M:%S)] $*"; }
as_app() { su - "$APP_USER" -c "$*"; }

# Serialize deploys — manual + auto-deploy.sh share this lock. If another
# deploy is in flight, exit fast (exit 0 so an auto-deploy timer tick
# isn't recorded as a failure in systemd).
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another deploy in progress (flock $LOCK_FILE held) — skipping this run"
  exit 0
fi

mkdir -p "$PRE"

# --- 0. One-time migration: relocate legacy root-level state into the active
# profile. Pre-profile installs kept store/, data/, and groups/ at $APP_DIR
# root; profile-aware code expects them under $APP_DIR/$PROFILE_REL/. Move
# them once, before backup + sync, so rsync --delete can't wipe them.
# Idempotent: a no-op once the profile paths exist.
PROFILE_ABS="$APP_DIR/$PROFILE_REL"
mkdir -p "$PROFILE_ABS"
for d in store data groups; do
  if [ -e "$APP_DIR/$d" ] && [ ! -e "$PROFILE_ABS/$d" ]; then
    log "Migrating legacy $d -> $PROFILE_REL/$d"
    mv "$APP_DIR/$d" "$PROFILE_ABS/$d"
  fi
done
# Legacy runtime env: setup/breadbrich-deploy.env -> profiles/<profile>/deploy.env.
if [ -f "$APP_DIR/setup/breadbrich-deploy.env" ] && [ ! -e "$PROFILE_ABS/deploy.env" ]; then
  log "Migrating legacy setup/breadbrich-deploy.env -> $PROFILE_REL/deploy.env"
  mv "$APP_DIR/setup/breadbrich-deploy.env" "$PROFILE_ABS/deploy.env"
fi
chown -R "$APP_USER:$APP_USER" "$PROFILE_ABS" 2>/dev/null || true

# --- 1. Pre-deploy backup (stateful paths + current built code) ---
log "Backup -> $SNAP (profile: $PROFILE)"
tar -czf "$SNAP" -C "$APP_DIR" \
  .env "$PROFILE_REL/store" "$PROFILE_REL/data" "$PROFILE_REL/groups" \
  kb-ui/users.json dist logs 2>/dev/null || true
ln -sfn "$SNAP" "$PRE/$SERVICE_NAME-pre-deploy-LATEST.tar.gz"

rollback() {
  log "FAILURE during deploy — rolling back from $SNAP"
  systemctl stop "$SERVICE_NAME" "$KB_SERVICE_NAME" || true
  tar -xzf "$SNAP" -C "$APP_DIR" || true
  chown -R "$APP_USER:$APP_USER" "$APP_DIR" || true
  systemctl start "$SERVICE_NAME" "$KB_SERVICE_NAME" || true
  log "Rollback complete — services restarted on previous state"
  exit 1
}
trap rollback ERR

# --- 2. Update git mirror to origin/main ---
log "Fetch origin/main"
git config --global --add safe.directory "$GIT_DIR" || true
as_app "git -C '$GIT_DIR' fetch origin main --quiet"
OLD="$(git -C "$GIT_DIR" rev-parse HEAD)"
as_app "git -C '$GIT_DIR' reset --hard origin/main"
NEW="$(git -C "$GIT_DIR" rev-parse HEAD)"
log "Mirror $OLD -> $NEW"

if [ "$OLD" = "$NEW" ]; then
  log "Already at origin/main ($NEW). Re-syncing anyway."
fi

# --- 3. Sync code into live app dir, preserving stateful paths ---
log "Sync code -> $APP_DIR (preserving host-local profiles)"
# Org profiles are host-local (gitignored, not in the mirror), so rsync --delete
# would wipe them. Exclude every real profile; only `example` (a tracked
# template) is allowed to sync from the mirror.
#   - the entire active profile (config, deploy.env, groups, store, data)
#   - any other profile's store/ + data/ (one box, several orgs)
#   - the local staging profile
rsync -a --delete \
  --exclude='.git/' \
  --exclude='.env' \
  --exclude="/$PROFILE_REL/" \
  --exclude='/profiles/*/store/' \
  --exclude='/profiles/*/data/' \
  --exclude='/profiles/staging/' \
  --exclude='kb-ui/users.json' \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='logs/' \
  "$GIT_DIR"/ "$APP_DIR"/
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# Runtime dirs the systemd units depend on but git does not track.
# Recreate defensively so a restart never fails with 209/STDOUT.
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_DIR/logs"

# --- 4. Dependencies (only if lockfile/package changed) ---
if ! git -C "$GIT_DIR" diff --quiet "$OLD" "$NEW" -- package-lock.json package.json; then
  log "Dependencies changed -> npm ci"
  as_app "cd '$APP_DIR' && npm ci --no-audit --no-fund"
else
  log "Dependencies unchanged -> skip npm ci"
fi

# --- 5. Build ---
log "Build (npm run build)"
as_app "cd '$APP_DIR' && npm run build"

# --- 6. Container image ---
# If CONTAINER_REGISTRY_IMAGE is set (in deploy.config), pull the CI-built,
# SHA-pinned image from the registry and retag it to nanoclaw-agent:latest —
# the tag the app expects (CONTAINER_IMAGE default in src/config.ts) and that
# container/build.sh produces. Pulling guarantees image==deployed-code and keeps
# the ~10-min chromium build off the host. If unset, fall back to the legacy
# behavior: build on the host when container/ sources changed.
#
# Which sha to pull: CI (container.yml) only publishes an image for commits
# that touch container/**, so most HEADs have no image of their own — the
# image that should be live is the one built from the LAST commit that touched
# container/. Pulling $NEW unconditionally (the old behavior) failed for most
# deploys and, worse, raced CI on container-touching merges: the deploy fires
# ~1 min after merge while the image build takes minutes, so the single pull
# failed and nothing ever retried — nanoclaw-agent:latest silently stayed
# stale until some later container-touching merge. Now: pull the
# last-container-commit's image (already published except in the race window),
# retry briefly when this very deploy changed container/ (the race window),
# and let auto-deploy.sh's idle-tick reconciler converge the tail end.
LOCAL_IMAGE="nanoclaw-agent:latest"
if [ -n "${CONTAINER_REGISTRY_IMAGE:-}" ]; then
  REGISTRY_HOST="${REGISTRY_HOST:-ghcr.io}"
  # Optional auth for a private package. Public packages need none. A token
  # requires the matching REGISTRY_USER (the PAT owner) — GHCR rejects a
  # placeholder username — so skip login with a clear warning if it's missing.
  if [ -n "${REGISTRY_TOKEN:-}" ]; then
    if [ -z "${REGISTRY_USER:-}" ]; then
      log "WARN: REGISTRY_TOKEN set but REGISTRY_USER is not — skipping docker login (set REGISTRY_USER to the PAT owner, or make the package public)"
    else
      echo "$REGISTRY_TOKEN" | docker login "$REGISTRY_HOST" -u "$REGISTRY_USER" --password-stdin >/dev/null 2>&1 \
        || log "WARN: docker login to $REGISTRY_HOST failed — continuing (image may be public)"
    fi
  fi
  IMAGE_SHA="$(git -C "$GIT_DIR" log -1 --format=%H -- container/ 2>/dev/null || true)"
  IMAGE_SHA="${IMAGE_SHA:-$NEW}"
  REMOTE_REF="$CONTAINER_REGISTRY_IMAGE:$IMAGE_SHA"
  # Retry only when this deploy changed container/ — that's when the tag is
  # brand-new and CI may still be building it. 6 × 20s ≈ 2 min covers cached
  # CI builds; the idle reconciler covers anything slower.
  PULL_TRIES=1
  if ! git -C "$GIT_DIR" diff --quiet "$OLD" "$NEW" -- container/ 2>/dev/null; then
    PULL_TRIES="${IMAGE_PULL_TRIES:-6}"
  fi
  pulled=0
  for attempt in $(seq 1 "$PULL_TRIES"); do
    log "Pull agent image $REMOTE_REF (attempt $attempt/$PULL_TRIES)"
    if docker pull "$REMOTE_REF"; then
      pulled=1
      break
    fi
    [ "$attempt" -lt "$PULL_TRIES" ] && sleep "${IMAGE_PULL_DELAY:-20}"
  done
  if [ "$pulled" -eq 1 ]; then
    docker tag "$REMOTE_REF" "$LOCAL_IMAGE"
    log "Tagged $REMOTE_REF -> $LOCAL_IMAGE"
  elif docker image inspect "$LOCAL_IMAGE" >/dev/null 2>&1; then
    log "WARN: pull failed for $REMOTE_REF — keeping existing $LOCAL_IMAGE (auto-deploy's reconciler retags once CI publishes)"
  else
    log "WARN: pull failed and no local $LOCAL_IMAGE present — building on host as fallback"
    as_app "cd '$APP_DIR' && ./container/build.sh"
  fi
elif ! git -C "$GIT_DIR" diff --quiet "$OLD" "$NEW" -- container/; then
  log "container/ changed -> rebuild agent image"
  as_app "cd '$APP_DIR' && ./container/build.sh"
else
  log "container/ unchanged -> skip image rebuild"
fi

# --- 7a. Render + install systemd units from templates (services + timers).
# Unit *.in templates carry ${DEPLOY_ROOT}/${SERVICE_NAME}/${SERVICE_USER}/…
# placeholders; we render them with this deployment's infra config so each org
# gets its own service names + paths. A newly-installed timer is enabled --now.
UNITS_DIR="$GIT_DIR/setup/systemd"
units_changed=0
declare -a new_timers=()
render_unit() {
  # $1 = template basename, $2 = destination unit name (without dir)
  local src="$UNITS_DIR/$1" dst="/etc/systemd/system/$2"
  [ -f "$src" ] || return 0
  local rendered
  rendered="$(DEPLOY_ROOT="$DEPLOY_ROOT" BACKUP_DIR="$BACKUP_DIR" \
    SERVICE_NAME="$SERVICE_NAME" KB_SERVICE_NAME="$KB_SERVICE_NAME" \
    AUTO_DEPLOY_NAME="$AUTO_DEPLOY_NAME" SERVICE_USER="$SERVICE_USER" \
    DEPLOY_ENV_FILE="$DEPLOY_ENV_FILE" \
    envsubst '${DEPLOY_ROOT} ${BACKUP_DIR} ${SERVICE_NAME} ${KB_SERVICE_NAME} ${AUTO_DEPLOY_NAME} ${SERVICE_USER} ${DEPLOY_ENV_FILE}' \
    < "$src")"
  local was_present=0
  [ -e "$dst" ] && was_present=1
  if ! printf '%s' "$rendered" | cmp -s - "$dst" 2>/dev/null; then
    log "Unit changed: $2 -> installing"
    printf '%s' "$rendered" > "$dst"
    chmod 644 "$dst"; chown root:root "$dst"
    units_changed=1
    if [ "$was_present" -eq 0 ] && [[ "$2" == *.timer ]]; then
      new_timers+=("$2")
    fi
  fi
}
if [ -d "$UNITS_DIR" ]; then
  # Fail the deploy (→ ERR trap → rollback) rather than leaving units stale.
  command -v envsubst >/dev/null 2>&1 || {
    log "envsubst missing — install gettext-base, then redeploy"; false
  }
  render_unit orchestrator.service.in "$SERVICE_NAME.service"
  render_unit kb.service.in           "$KB_SERVICE_NAME.service"
  render_unit auto-deploy.service.in  "$AUTO_DEPLOY_NAME.service"
  render_unit auto-deploy.timer.in    "$AUTO_DEPLOY_NAME.timer"
  if [ "$units_changed" -eq 1 ]; then
    log "systemctl daemon-reload"
    systemctl daemon-reload
  fi
  for t in "${new_timers[@]:-}"; do
    [ -n "$t" ] || continue
    log "Enable + start new timer: $t"
    systemctl enable --now "$t" || log "Failed to enable $t"
  done
fi

# --- 7a-bis. Install / refresh the auto-deploy.sh helper if shipped. ---
AD_SRC="$GIT_DIR/setup/auto-deploy.sh"
AD_DST="$BK_DIR/auto-deploy.sh"
if [ -f "$AD_SRC" ] && ! cmp -s "$AD_SRC" "$AD_DST" 2>/dev/null; then
  install -m 755 -o root -g root "$AD_SRC" "$AD_DST"
  log "auto-deploy.sh installed/updated"
fi

# --- 7b. Restart services ---
log "Restart services"
systemctl restart "$SERVICE_NAME"
systemctl restart "$KB_SERVICE_NAME"

# --- 8. Health check ---
log "Health check (settle + retry up to 45s)"
for s in "$SERVICE_NAME" "$KB_SERVICE_NAME"; do
  ok=0
  for _ in $(seq 1 9); do
    sleep 5
    if systemctl is-active --quiet "$s"; then ok=1; break; fi
  done
  if [ "$ok" -ne 1 ]; then
    log "Service $s is NOT active 45s after restart"
    journalctl -u "$s" -n 15 --no-pager -o cat || true
    false
  fi
done
# KB dashboard responds (401 on auth-protected root is healthy)
code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' http://127.0.0.1:8080/ || true)"
log "KB dashboard HTTP $code"
case "$code" in
  200|301|302|401) : ;;
  *) log "KB dashboard unhealthy (HTTP $code)"; false ;;
esac

trap - ERR

# --- 9. Self-update: if the canonical safe-deploy.sh in the repo differs
# from the running copy, replace it so the next run picks up the new
# version. Done last so a broken update can't corrupt the in-flight run.
SELF_SRC="$GIT_DIR/setup/safe-deploy.sh"
SELF_DST="$BK_DIR/safe-deploy.sh"
if [ -f "$SELF_SRC" ] && ! cmp -s "$SELF_SRC" "$SELF_DST" 2>/dev/null; then
  install -m 755 -o root -g root "$SELF_SRC" "$SELF_DST"
  log "safe-deploy.sh self-updated from repo"
fi

log "DEPLOY OK — live app now at $NEW"
