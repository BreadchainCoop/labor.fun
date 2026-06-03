#!/usr/bin/env bash
# auto-deploy.sh — triggers safe-deploy.sh when /opt/breadbrich-git is behind
# origin/main. Fired by breadbrich-auto-deploy.timer (default every 2 min).
#
# Uses git ls-remote rather than fetch — refs only, no object download — so
# the "is anything to deploy?" check is cheap. Auth piggybacks on the
# credential helper safe-deploy already configured (PAT in
# /home/breadbrich/.git-credentials). No extra secrets to manage.
#
# DRAIN BEHAVIOR
# --------------
# Active agent containers (nanoclaw-*) are processing live user requests
# at deploy time. Restarting the orchestrator mid-run kills those requests
# and surfaces as "agent_runs.status='interrupted'" + dropped user replies.
# To avoid that, this script DEFERS deploys while any agent container is
# alive, retrying on the next 2-min tick.
#
# Safeguards:
#   * If we've been waiting longer than MAX_DEFER_SECONDS (default 15 min)
#     we proceed anyway — a stuck container shouldn't block deploys forever.
#   * A presence-file at $FORCE_FILE forces an immediate deploy regardless
#     of running containers (for emergency hot-fixes). The file is consumed
#     (removed) on read so it only forces once.
#
# Serialization with manual `safe-deploy.sh` invocations is still handled
# by safe-deploy's own flock at the top of the script.
set -euo pipefail

# --- Resolve infra config from the live install (profiles are host-local) ---
BOOT_ROOT="${DEPLOY_ROOT:-/opt/breadbrich}"
PROFILE="${LABOR_PROFILE:-}"
if [ -z "$PROFILE" ] && [ -d "$BOOT_ROOT/profiles" ]; then
  PROFILE="$(ls "$BOOT_ROOT/profiles" 2>/dev/null | grep -vx example | head -n1 || true)"
fi
PROFILE="${PROFILE:-breadchain}"
DEPLOY_CONFIG="$BOOT_ROOT/profiles/$PROFILE/deploy.config"
# shellcheck disable=SC1090
[ -f "$DEPLOY_CONFIG" ] && . "$DEPLOY_CONFIG"
GIT_DIR="${GIT_DIR:-/opt/breadbrich-git}"
BACKUP_DIR="${BACKUP_DIR:-/opt/breadbrich-backups}"
SERVICE_NAME="${SERVICE_NAME:-breadbrich}"
SERVICE_USER="${SERVICE_USER:-breadbrich}"

DEPLOY_SH="$BACKUP_DIR/safe-deploy.sh"
APP_USER="$SERVICE_USER"
FORCE_FILE="$BACKUP_DIR/.deploy-force"
DEFER_STATE="/run/$SERVICE_NAME-deploy-deferred-since"
MAX_DEFER_SECONDS="${MAX_DEFER_SECONDS:-900}"   # 15 min — override via env

log() { echo "[auto-deploy $(date -u +%H:%M:%S)] $*"; }

LOCAL="$(su - "$APP_USER" -c "git -C '$GIT_DIR' rev-parse HEAD")"
# 30s timeout: a slow/down GitHub shouldn't wedge the timer.
REMOTE="$(timeout 30 su - "$APP_USER" -c "git -C '$GIT_DIR' ls-remote origin main" 2>/dev/null | cut -f1)"

if [ -z "$REMOTE" ]; then
  log "ls-remote returned nothing (network/auth issue) — skipping this tick"
  exit 0
fi

if [ "$LOCAL" = "$REMOTE" ]; then
  # Already at origin/main — most ticks land here. Stay quiet and clear
  # any leftover defer state so the next backlog starts clean.
  rm -f "$DEFER_STATE"
  exit 0
fi

# Mirror is behind. Drain-check before triggering safe-deploy.
# `--filter name=` is substring match (not regex) — matches the convention
# in src/container-runtime.ts and scripts/hourly-ops.sh.
ACTIVE_COUNT=$(docker ps --filter name=nanoclaw- -q 2>/dev/null | grep -c . || true)

if [ -f "$FORCE_FILE" ]; then
  log "force-file present at $FORCE_FILE — bypassing drain check"
  rm -f "$FORCE_FILE"
elif [ "$ACTIVE_COUNT" -gt 0 ]; then
  NOW=$(date +%s)
  if [ -f "$DEFER_STATE" ]; then
    SINCE=$(cat "$DEFER_STATE" 2>/dev/null || echo "")
    if ! [[ "$SINCE" =~ ^[0-9]+$ ]]; then
      log "defer state file corrupt ('$SINCE') — resetting"
      echo "$NOW" > "$DEFER_STATE"
      SINCE=$NOW
    fi
    WAITED=$((NOW - SINCE))
    if [ "$WAITED" -ge "$MAX_DEFER_SECONDS" ]; then
      log "deferred ${WAITED}s exceeds cap ${MAX_DEFER_SECONDS}s — proceeding anyway ($ACTIVE_COUNT container(s) still running)"
      rm -f "$DEFER_STATE"
    else
      log "$ACTIVE_COUNT agent container(s) running; deferring (waited ${WAITED}s / cap ${MAX_DEFER_SECONDS}s)"
      exit 0
    fi
  else
    echo "$NOW" > "$DEFER_STATE"
    log "$ACTIVE_COUNT agent container(s) running; deferring this tick (first detection)"
    exit 0
  fi
fi

log "Mirror $LOCAL behind origin/main $REMOTE — triggering safe-deploy"
rm -f "$DEFER_STATE"
exec "$DEPLOY_SH"
