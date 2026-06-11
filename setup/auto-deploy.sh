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

# Reconcile nanoclaw-agent:latest with the registry on idle ticks. safe-deploy
# pulls the CI-built image right after a merge, but CI's image build can land
# minutes later — the failed pull kept the previous image, and since deploys
# only run on NEW commits, nothing ever retried for that sha. Each idle tick,
# make sure the local tag matches the image CI built for the last commit that
# touched container/ (the only commits container.yml publishes images for);
# pull + retag when it doesn't. Steady state — image already local and tagged —
# is a no-op with no network calls beyond the ls-remote we already did.
reconcile_agent_image() {
  [ -n "${CONTAINER_REGISTRY_IMAGE:-}" ] || return 0
  local sha ref want have
  sha="$(su - "$APP_USER" -c "git -C '$GIT_DIR' log -1 --format=%H -- container/" 2>/dev/null || true)"
  [ -n "$sha" ] || return 0
  ref="$CONTAINER_REGISTRY_IMAGE:$sha"
  have="$(docker image inspect nanoclaw-agent:latest -f '{{.Id}}' 2>/dev/null || true)"
  want="$(docker image inspect "$ref" -f '{{.Id}}' 2>/dev/null || true)"
  if [ -z "$want" ]; then
    # Image not local — probe the registry cheaply first. Absent means CI
    # hasn't published it yet (still building, or pre-CI history); retry on
    # a later tick. Works unauthenticated for public packages; for private
    # ones the probe just fails and reconciliation stays a no-op.
    timeout 30 docker manifest inspect "$ref" >/dev/null 2>&1 || return 0
    log "agent image $ref published — pulling"
    timeout 600 docker pull "$ref" >/dev/null 2>&1 \
      || { log "WARN: reconcile pull failed for $ref"; return 0; }
    want="$(docker image inspect "$ref" -f '{{.Id}}' 2>/dev/null || true)"
  fi
  if [ -n "$want" ] && [ "$want" != "$have" ]; then
    docker tag "$ref" nanoclaw-agent:latest
    log "reconciled nanoclaw-agent:latest -> $ref (was ${have:-<none>})"
  fi
}

LOCAL="$(su - "$APP_USER" -c "git -C '$GIT_DIR' rev-parse HEAD")"
# 30s timeout: a slow/down GitHub shouldn't wedge the timer.
REMOTE="$(timeout 30 su - "$APP_USER" -c "git -C '$GIT_DIR' ls-remote origin main" 2>/dev/null | cut -f1)"

if [ -z "$REMOTE" ]; then
  log "ls-remote returned nothing (network/auth issue) — skipping this tick"
  exit 0
fi

if [ "$LOCAL" = "$REMOTE" ]; then
  # Already at origin/main — most ticks land here. Clear any leftover defer
  # state, then self-heal the agent image in case a recent deploy raced CI's
  # image build (quiet no-op when everything already matches).
  rm -f "$DEFER_STATE"
  reconcile_agent_image
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
