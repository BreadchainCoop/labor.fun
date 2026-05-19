#!/bin/bash
# Pull droplet backups to local machine as off-site copy.
# Run periodically (manually or via launchd/cron) to keep a local mirror.
#
# Usage: ./scripts/pull-backups.sh

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
LOCAL_BACKUPS="$HOME/Documents/Code/Claude/breadbrich-backups"

mkdir -p "$LOCAL_BACKUPS"

echo "Pulling backups from droplet..."
rsync -avz --progress --partial \
  "$DROPLET:/opt/breadbrich-backups/" \
  "$LOCAL_BACKUPS/"

echo ""
echo "=== Local backup summary ==="
du -sh "$LOCAL_BACKUPS"/*/ 2>/dev/null
echo ""
echo "Most recent backups:"
ls -lht "$LOCAL_BACKUPS/daily/" 2>/dev/null | head -5
ls -lht "$LOCAL_BACKUPS/pre-deploy/" 2>/dev/null | head -5
