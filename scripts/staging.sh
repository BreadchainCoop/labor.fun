#!/bin/bash
# labor.fun staging environment — local Mac, isolated from prod.
#
# Uses:
#   - .env.staging (separate from prod .env), which sets LABOR_PROFILE=staging
#   - profiles/staging/ for store/, data/, groups/ (its own profile, gitignored)
#   - ./staging-data/ for logs + pidfile only
#   - Separate Telegram bot and Slack channel
#
# Usage:
#   ./scripts/staging.sh init       # first-time setup (create .env.staging from template)
#   ./scripts/staging.sh start      # start staging locally
#   ./scripts/staging.sh test       # run test suite against staging
#   ./scripts/staging.sh reset      # wipe staging data (NOT prod)
#   ./scripts/staging.sh logs       # tail staging logs

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STAGING_DATA="$PROJECT_ROOT/staging-data"
STAGING_PROFILE="$PROJECT_ROOT/profiles/staging"
STAGING_ENV="$PROJECT_ROOT/.env.staging"
STAGING_LOG="$STAGING_DATA/staging.log"
STAGING_PIDFILE="$STAGING_DATA/staging.pid"

cmd="${1:-}"

case "$cmd" in
  init)
    mkdir -p "$STAGING_DATA/logs"
    mkdir -p "$STAGING_PROFILE/groups/main"
    if [ ! -f "$STAGING_PROFILE/profile.config.json" ]; then
      cat > "$STAGING_PROFILE/profile.config.json" <<'EOF'
{
  "assistantName": "Staging Aide",
  "orgName": "Staging Org",
  "sharedKbGroup": "main"
}
EOF
    fi
    cat > "$STAGING_PROFILE/groups/main/CLAUDE.md" <<'EOF'
# {{ASSISTANT_NAME}} (staging)

This is the staging environment. Do not use real credentials here.
EOF
    if [ ! -f "$STAGING_ENV" ]; then
      cat > "$STAGING_ENV" <<'EOF'
# Breadbrich Engels STAGING environment config
# DO NOT use prod credentials here.
#
# Create a new Telegram bot for staging:
#   1. Message @BotFather: /newbot
#   2. Name: Breadbrich Engels Staging
#   3. Username: breadbrich_staging_bot (or similar)
#   4. Copy the token below
#
# For Slack: create a new channel #breadbrich-staging and use the same workspace app,
# or create a separate app. Either way, set SLACK_BOT_TOKEN / SLACK_APP_TOKEN below.

# Active profile — staging state lives under profiles/staging/
LABOR_PROFILE=staging

# Required — replace with staging values
ASSISTANT_NAME=Staging Aide
TELEGRAM_BOT_TOKEN=PASTE_STAGING_BOT_TOKEN_HERE
SLACK_BOT_TOKEN=PASTE_STAGING_SLACK_BOT_TOKEN
SLACK_APP_TOKEN=PASTE_STAGING_SLACK_APP_TOKEN
SLACK_SIGNING_SECRET=PASTE_STAGING_SLACK_SIGNING_SECRET

# Auth — use Ops account locally (not Mother Goose)
# Or mint a separate staging-only token via `claude setup-token`
CLAUDE_CODE_OAUTH_TOKEN=PASTE_STAGING_OAUTH_TOKEN

# Staging state (store/, data/, groups/) lives under profiles/staging/ via
# LABOR_PROFILE above — no path overrides needed.

# Use a distinct credential proxy port so multiple envs can coexist
CREDENTIAL_PROXY_PORT=3002

# Disable features that would hit real services
ENABLE_GMAIL=false
ENABLE_IMAP=false
EOF
      echo "Created $STAGING_ENV"
      echo "Edit it with your staging bot tokens before running 'staging.sh start'"
    fi
    echo "Staging initialized at $STAGING_DATA"
    echo "Next: edit .env.staging, then run ./scripts/staging.sh start"
    ;;

  start)
    [ ! -f "$STAGING_ENV" ] && { echo "Run 'staging.sh init' first"; exit 1; }
    grep -q "PASTE_" "$STAGING_ENV" && {
      echo "ERROR: $STAGING_ENV still has PASTE_* placeholders. Fill in real staging values first."
      exit 1
    }
    if [ -f "$STAGING_PIDFILE" ] && kill -0 "$(cat "$STAGING_PIDFILE")" 2>/dev/null; then
      echo "Staging already running (pid $(cat "$STAGING_PIDFILE")). Stop with: staging.sh stop"
      exit 1
    fi
    echo "Starting staging..."
    cd "$PROJECT_ROOT"
    npm run build
    # Run tsx with staging env loaded — explicit env avoids leaking prod config
    env -i PATH="$PATH" HOME="$HOME" NODE_ENV=staging \
      bash -c "set -a; source '$STAGING_ENV'; set +a; exec nohup npx tsx src/index.ts > '$STAGING_LOG' 2>&1 &"
    echo $! > "$STAGING_PIDFILE"
    sleep 2
    if kill -0 "$(cat "$STAGING_PIDFILE")" 2>/dev/null; then
      echo "Staging started (pid $(cat "$STAGING_PIDFILE")). Logs: staging.sh logs"
    else
      echo "Staging failed to start. Check $STAGING_LOG"
      cat "$STAGING_LOG" | tail -20
      exit 1
    fi
    ;;

  stop)
    if [ -f "$STAGING_PIDFILE" ]; then
      pid=$(cat "$STAGING_PIDFILE")
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid"
        echo "Staging stopped (pid $pid)"
      fi
      rm -f "$STAGING_PIDFILE"
    else
      echo "No staging pidfile found."
    fi
    ;;

  test)
    echo "=== Running unit tests ==="
    cd "$PROJECT_ROOT"
    npm test
    echo ""
    echo "=== Typecheck ==="
    npx tsc --noEmit
    echo ""
    echo "NOTE: integration tests against a live staging instance are not yet wired up."
    echo "For now, run './scripts/staging.sh start' and exercise the bot manually."
    ;;

  reset)
    if [ -f "$STAGING_PIDFILE" ] && kill -0 "$(cat "$STAGING_PIDFILE")" 2>/dev/null; then
      echo "Stop staging first: staging.sh stop"; exit 1
    fi
    read -p "Wipe all staging data at $STAGING_PROFILE ? [y/N] " yn
    if [ "$yn" = "y" ]; then
      rm -rf "$STAGING_PROFILE"/{store,data}/* "$STAGING_PROFILE"/groups/*/context/* "$STAGING_DATA/logs"/*
      echo "Staging data wiped (profile config and dirs preserved)."
    fi
    ;;

  logs)
    tail -f "$STAGING_LOG" 2>/dev/null || { echo "No staging log found. Run 'start' first."; exit 1; }
    ;;

  status)
    if [ -f "$STAGING_PIDFILE" ] && kill -0 "$(cat "$STAGING_PIDFILE")" 2>/dev/null; then
      echo "Staging: RUNNING (pid $(cat "$STAGING_PIDFILE"))"
    else
      echo "Staging: STOPPED"
    fi
    ;;

  *)
    echo "Usage: staging.sh {init|start|stop|test|reset|logs|status}"
    exit 1
    ;;
esac
