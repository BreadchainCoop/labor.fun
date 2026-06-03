#!/bin/bash
# Deploy labor.fun from GitHub main to this org's host.
#
# The host pulls from GitHub (via $GIT_DIR) rather than rsyncing from this
# machine — GitHub main is the source of truth. This script just triggers the
# host-side safe-deploy. Infra paths/names come from the active profile's
# deploy.config (defaults preserve breadchain).
#
# Usage:
#   ./scripts/deploy.sh           # deploy latest origin/main
#   ./scripts/deploy.sh --status  # show current state on the host
#   ./scripts/deploy.sh --logs    # tail the deploy log

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
fi
DROPLET="${DROPLET_HOST:?Set DROPLET_HOST in .env or environment (e.g. root@your-droplet)}"

# Infra config from the local profile (defaults preserve breadchain).
PROFILE="${LABOR_PROFILE:-breadchain}"
DEPLOY_CONFIG="$REPO_ROOT/profiles/$PROFILE/deploy.config"
# shellcheck disable=SC1090
[ -f "$DEPLOY_CONFIG" ] && . "$DEPLOY_CONFIG"
GIT_DIR="${GIT_DIR:-/opt/breadbrich-git}"
BACKUP_DIR="${BACKUP_DIR:-/opt/breadbrich-backups}"
SERVICE_NAME="${SERVICE_NAME:-breadbrich}"
SERVICE_USER="${SERVICE_USER:-breadbrich}"

case "${1:-}" in
  --status)
    ssh "$DROPLET" "
      echo '=== $SERVICE_NAME service ==='
      systemctl is-active '$SERVICE_NAME'
      echo ''
      echo '=== Source of truth (origin/main via $GIT_DIR) ==='
      su - '$SERVICE_USER' -c 'cd $GIT_DIR && git log -1 --oneline'
      echo ''
      echo '=== Last deploy log entries ==='
      tail -20 '$BACKUP_DIR/deploy.log'
    "
    exit 0
    ;;

  --logs)
    ssh "$DROPLET" "tail -f '$BACKUP_DIR/deploy.log'"
    exit 0
    ;;

  "")
    ;; # normal deploy, fall through

  *)
    echo "Usage: deploy.sh [--status | --logs]"
    exit 1
    ;;
esac

echo "=== Deploying labor.fun ($SERVICE_NAME, latest origin/main) via host git-pull ==="
ssh "$DROPLET" "$BACKUP_DIR/safe-deploy.sh"
