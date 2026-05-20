#!/usr/bin/env bash
# safe-deploy.sh — deploy Breadbrich Engels from GitHub main to /opt/breadbrich.
#
# Source of truth is GitHub main, mirrored into /opt/breadbrich-git, then
# synced into the live app dir preserving stateful paths. Honors the
# push -> merge -> deploy rule. Run as root: takes a backup, rolls back on
# any failure.
set -euo pipefail

GIT_DIR=/opt/breadbrich-git
APP_DIR=/opt/breadbrich
BK_DIR=/opt/breadbrich-backups
PRE="$BK_DIR/pre-deploy"
TS="$(date -u +%Y%m%d-%H%M%S)"
SNAP="$PRE/breadbrich-pre-deploy-$TS.tar.gz"
APP_USER=breadbrich

log() { echo "[safe-deploy $(date -u +%H:%M:%S)] $*"; }
as_app() { su - "$APP_USER" -c "$*"; }

mkdir -p "$PRE"

# --- 1. Pre-deploy backup (stateful paths + current built code) ---
log "Backup -> $SNAP"
tar -czf "$SNAP" -C "$APP_DIR" \
  .env store data groups kb-ui/users.json dist logs 2>/dev/null || true
ln -sfn "$SNAP" "$PRE/breadbrich-pre-deploy-LATEST.tar.gz"

rollback() {
  log "FAILURE during deploy — rolling back from $SNAP"
  systemctl stop breadbrich breadbrich-kb || true
  tar -xzf "$SNAP" -C "$APP_DIR" || true
  chown -R "$APP_USER:$APP_USER" "$APP_DIR" || true
  systemctl start breadbrich breadbrich-kb || true
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
log "Sync code -> $APP_DIR"
rsync -a --delete \
  --exclude='.git/' \
  --exclude='.env' \
  --exclude='store/' \
  --exclude='data/' \
  --exclude='groups/' \
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

# --- 6. Container image rebuild only if container/ sources changed ---
if ! git -C "$GIT_DIR" diff --quiet "$OLD" "$NEW" -- container/; then
  log "container/ changed -> rebuild agent image"
  as_app "cd '$APP_DIR' && ./container/build.sh"
else
  log "container/ unchanged -> skip image rebuild"
fi

# --- 7a. Install systemd unit changes from the repo, if any ---
UNITS_DIR="$GIT_DIR/setup/systemd"
units_changed=0
if [ -d "$UNITS_DIR" ]; then
  for unit_src in "$UNITS_DIR"/*.service; do
    [ -e "$unit_src" ] || continue
    unit_name="$(basename "$unit_src")"
    unit_dst="/etc/systemd/system/$unit_name"
    if ! cmp -s "$unit_src" "$unit_dst" 2>/dev/null; then
      log "Unit changed: $unit_name -> installing"
      install -m 644 -o root -g root "$unit_src" "$unit_dst"
      units_changed=1
    fi
  done
  if [ "$units_changed" -eq 1 ]; then
    log "systemctl daemon-reload"
    systemctl daemon-reload
  fi
fi

# --- 7b. Restart services ---
log "Restart services"
systemctl restart breadbrich
systemctl restart breadbrich-kb

# --- 8. Health check ---
log "Health check (settle + retry up to 45s)"
for s in breadbrich breadbrich-kb; do
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
