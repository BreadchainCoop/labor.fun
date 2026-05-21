#!/usr/bin/env bash
# auto-deploy.sh — triggers safe-deploy.sh when /opt/breadbrich-git is behind
# origin/main. Fired by breadbrich-auto-deploy.timer (default every 2 min).
#
# Uses git ls-remote rather than fetch — refs only, no object download — so
# the "is anything to deploy?" check is cheap. Auth piggybacks on the
# credential helper safe-deploy already configured (PAT in
# /home/breadbrich/.git-credentials). No extra secrets to manage.
#
# Serialization with manual deploys is handled by safe-deploy.sh's own
# flock at the top of the script — if a manual deploy is in flight, our
# call to safe-deploy.sh will exit fast with "another deploy in progress".
set -euo pipefail

GIT_DIR=/opt/breadbrich-git
DEPLOY_SH=/opt/breadbrich-backups/safe-deploy.sh
APP_USER=breadbrich

log() { echo "[auto-deploy $(date -u +%H:%M:%S)] $*"; }

LOCAL="$(su - "$APP_USER" -c "git -C '$GIT_DIR' rev-parse HEAD")"
# 30s timeout: a slow/down GitHub shouldn't wedge the timer.
REMOTE="$(timeout 30 su - "$APP_USER" -c "git -C '$GIT_DIR' ls-remote origin main" 2>/dev/null | cut -f1)"

if [ -z "$REMOTE" ]; then
  log "ls-remote returned nothing (network/auth issue) — skipping this tick"
  exit 0
fi

if [ "$LOCAL" = "$REMOTE" ]; then
  # Already at origin/main — most ticks land here. Stay quiet.
  exit 0
fi

log "Mirror $LOCAL behind origin/main $REMOTE — triggering safe-deploy"
exec "$DEPLOY_SH"
