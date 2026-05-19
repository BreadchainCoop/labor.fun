#!/bin/bash
# Deploy Breadbrich Engels from GitHub main to the droplet.
#
# The droplet pulls from GitHub (via /opt/breadbrich-git/) rather than rsyncing from
# this machine — GitHub main is now the source of truth. This script just
# triggers the droplet-side safe-deploy.
#
# Usage:
#   ./scripts/deploy.sh           # deploy latest origin/main
#   ./scripts/deploy.sh --status  # show current state on droplet
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

case "${1:-}" in
  --status)
    ssh "$DROPLET" '
      echo "=== Breadbrich Engels service ==="
      systemctl is-active breadbrich
      echo ""
      echo "=== Source of truth (origin/main via /opt/breadbrich-git) ==="
      su - breadbrich -c "cd /opt/breadbrich-git && git log -1 --oneline"
      echo ""
      echo "=== Last deploy log entries ==="
      tail -20 /opt/breadbrich-backups/deploy.log
    '
    exit 0
    ;;

  --logs)
    ssh "$DROPLET" 'tail -f /opt/breadbrich-backups/deploy.log'
    exit 0
    ;;

  "")
    ;; # normal deploy, fall through

  *)
    echo "Usage: deploy.sh [--status | --logs]"
    exit 1
    ;;
esac

echo "=== Deploying Breadbrich Engels (latest origin/main) via droplet git-pull ==="
ssh "$DROPLET" "/opt/breadbrich-backups/safe-deploy.sh"
