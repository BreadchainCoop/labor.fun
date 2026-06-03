#!/bin/bash
# One-time setup: configure droplet to pull from GitHub via HTTPS+PAT.
#
# Prerequisite: create a fine-grained PAT at
#   https://github.com/settings/personal-access-tokens/new
# with:
#   - Resource owner: the org that owns the framework repo (e.g. BreadchainCoop)
#   - Repository access: Only select repositories → BreadchainCoop/labor.fun
#   - Repository permissions: Contents → Read-only
# Copy the token (starts with "github_pat_...") and export it before running:
#
#   export BREADBRICH_DEPLOY_PAT=github_pat_xxx
#   ./scripts/setup-droplet-gitpull.sh
#
# After this runs, deploy flow becomes:
#   1. ssh to droplet
#   2. cd /opt/breadbrich-git && git fetch && git reset --hard origin/main
#   3. run safe-deploy.sh (which rsyncs /opt/breadbrich-git/ → /opt/breadbrich/ preserving stateful paths)

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
PAT="${BREADBRICH_DEPLOY_PAT:-}"

# Infra config from the LOCAL profile (the droplet has nothing yet). Defaults
# preserve breadchain; a new org's profiles/<org>/deploy.config overrides them.
PROFILE="${LABOR_PROFILE:-breadchain}"
DEPLOY_CONFIG="$REPO_ROOT/profiles/$PROFILE/deploy.config"
# shellcheck disable=SC1090
[ -f "$DEPLOY_CONFIG" ] && . "$DEPLOY_CONFIG"
GIT_DIR="${GIT_DIR:-/opt/breadbrich-git}"
SERVICE_USER="${SERVICE_USER:-breadbrich}"
REPO_URL="${REPO_URL:-https://github.com/BreadchainCoop/labor.fun.git}"

if [ -z "$PAT" ]; then
  echo "ERROR: set BREADBRICH_DEPLOY_PAT env var first. See the top of this script for instructions."
  exit 1
fi

echo "Configuring git-pull on droplet (user=$SERVICE_USER, mirror=$GIT_DIR)..."
ssh "$DROPLET" "bash -s" <<EOF
set -euo pipefail

# Install the PAT in the service user's ~/.netrc for HTTPS auth
mkdir -p "/home/$SERVICE_USER"
cat > "/home/$SERVICE_USER/.netrc" << NETRC
machine github.com
  login x-access-token
  password $PAT
NETRC
chmod 600 "/home/$SERVICE_USER/.netrc"
chown "$SERVICE_USER:$SERVICE_USER" "/home/$SERVICE_USER/.netrc"

# Clone the framework repo into the git mirror (fresh clone each time — idempotent)
rm -rf "$GIT_DIR"
su - "$SERVICE_USER" -c 'git clone --depth 1 --branch main "$REPO_URL" "$GIT_DIR"'

echo ""
echo "Clone succeeded. Current HEAD:"
su - "$SERVICE_USER" -c 'cd "$GIT_DIR" && git log -1 --oneline'
EOF

echo ""
echo "Done. To deploy from GitHub main:"
echo "  ssh $DROPLET \"su - breadbrich -c 'cd /opt/breadbrich-git && git fetch && git reset --hard origin/main'\""
echo "  ssh $DROPLET \"/opt/breadbrich-backups/safe-deploy.sh /opt/breadbrich-git\""
echo ""
echo "Next: update safe-deploy.sh to source from /opt/breadbrich-git/ instead of /tmp/breadbrich-staging/"
echo "(I'll do that once this clone succeeds)"
