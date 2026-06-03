#!/bin/bash
# labor.fun hourly operations cron job
# Runs every hour to:
#   1. Check for open PRs that need review/merge/deploy
#   2. Verify recent messages were ingested into tasks/KB
#   3. Compact group memory files (except active conversations)
#
# Logs to /opt/breadbrich/logs/hourly-ops.log
# Org-specific state lives under profiles/$PROFILE/ (see src/profile.ts).

set -uo pipefail

DEPLOY_ROOT="${DEPLOY_ROOT:-/opt/breadbrich}"
# Profiles are host-local; autodetect the single non-example one.
PROFILE="${LABOR_PROFILE:-}"
if [ -z "$PROFILE" ] && [ -d "$DEPLOY_ROOT/profiles" ]; then
  PROFILE="$(ls "$DEPLOY_ROOT/profiles" 2>/dev/null | grep -vx example | head -n1 || true)"
fi
PROFILE="${PROFILE:-breadchain}"
# Infra config (DEPLOY_ROOT, REPO_URL, …) from the live profile.
DEPLOY_CONFIG="$DEPLOY_ROOT/profiles/$PROFILE/deploy.config"
# shellcheck disable=SC1090
[ -f "$DEPLOY_CONFIG" ] && . "$DEPLOY_CONFIG"
DEPLOY_ROOT="${DEPLOY_ROOT:-/opt/breadbrich}"
# Shared KB group: explicit, else the profile's deploy.env, else default.
KB_GROUP="${SHARED_KB_GROUP:-}"
PROFILE_ENV="$DEPLOY_ROOT/profiles/$PROFILE/deploy.env"
if [ -z "$KB_GROUP" ] && [ -f "$PROFILE_ENV" ]; then
  KB_GROUP="$(grep -E '^SHARED_KB_GROUP=' "$PROFILE_ENV" | tail -1 | cut -d= -f2- | tr -d '"' || true)"
fi
KB_GROUP="${KB_GROUP:-discord_main}"
REPO="${REPO_URL:-https://github.com/BreadchainCoop/labor.fun.git}"
REPO="${REPO#https://github.com/}"; REPO="${REPO%.git}"   # gh wants owner/name

LOG="$DEPLOY_ROOT/logs/hourly-ops.log"
GROUPS="$DEPLOY_ROOT/profiles/$PROFILE/groups"
DB="$DEPLOY_ROOT/profiles/$PROFILE/store/messages.db"
CONTEXT="$GROUPS/$KB_GROUP/context"
NOW=$(date -Iseconds)

log() { echo "[$NOW] $*" >> "$LOG"; }

log "=== Hourly ops started ==="

# --- 1. Check for open PRs ---
log "Checking open PRs..."
if command -v gh &>/dev/null; then
  PRS=$(gh pr list --repo "$REPO" --state open --json number,title,createdAt 2>/dev/null || echo "[]")
  PR_COUNT=$(echo "$PRS" | node -e "process.stdin.on('data',d=>{console.log(JSON.parse(d).length)})" 2>/dev/null || echo "0")
  if [ "$PR_COUNT" -gt "0" ]; then
    log "ALERT: $PR_COUNT open PR(s) need review"
    echo "$PRS" | node -e "process.stdin.on('data',d=>{JSON.parse(d).forEach(p=>console.log('  #'+p.number+': '+p.title))})" >> "$LOG" 2>/dev/null
  else
    log "No open PRs"
  fi
else
  log "WARN: gh CLI not available, skipping PR check"
fi

# --- 2. Check recent messages for missed ingestion (opt-in) ---
# Compares trigger mentions vs agent runs for one chat over the last 2 hours.
# Org-specific, so it's off by default: set HOURLY_OPS_CHECK_JID to the chat JID
# to watch (e.g. tg:-100123...). The mention pattern uses the configured trigger.
CHECK_JID="${HOURLY_OPS_CHECK_JID:-}"
if [ -z "$CHECK_JID" ]; then
  log "Ingestion check skipped (HOURLY_OPS_CHECK_JID not set)"
else
  log "Checking message ingestion for $CHECK_JID..."
  CUTOFF=$(date -u -d "2 hours ago" +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -v-2H +%Y-%m-%dT%H:%M:%S 2>/dev/null || echo "")
  TRIGGER="${ASSISTANT_NAME:-}"
  if [ -z "$TRIGGER" ] && [ -f "$DEPLOY_ENV" ]; then
    TRIGGER="$(grep -E '^ASSISTANT_NAME=' "$DEPLOY_ENV" | tail -1 | cut -d= -f2- | tr -d '"' || true)"
  fi
  if [ -n "$CUTOFF" ] && [ -f "$DB" ]; then
    CHECK_JID="$CHECK_JID" TRIGGER="$TRIGGER" DB="$DB" CUTOFF="$CUTOFF" node --input-type=module -e "
      import Database from 'better-sqlite3';
      const db = new Database(process.env.DB);
      const jid = process.env.CHECK_JID;
      const like = '%@' + (process.env.TRIGGER || '') + '%';
      const mentions = db.prepare(
        \"SELECT id FROM messages WHERE chat_jid = ? AND timestamp > ? AND content LIKE ? AND is_from_me = 0\"
      ).all(jid, process.env.CUTOFF, like);
      const runs = db.prepare(
        \"SELECT status FROM agent_runs WHERE chat_jid = ? AND started_at > ?\"
      ).all(jid, process.env.CUTOFF);
      console.log(JSON.stringify({ mentions: mentions.length, runs: runs.length, successRuns: runs.filter(r => r.status === 'success').length }));
    " >> "$LOG" 2>/dev/null || log "WARN: ingestion check failed"
  fi
fi

# --- 3. Compact group memory (except active sessions) ---
log "Compacting group memory..."
ACTIVE_CONTAINERS=$(docker ps --filter name=nanoclaw --format '{{.Names}}' 2>/dev/null | sed 's/nanoclaw-//' | sed 's/-[0-9]*$//' || echo "")

for group_dir in "$GROUPS"/telegram_* "$GROUPS"/slack_*; do
  [ ! -d "$group_dir" ] && continue
  folder=$(basename "$group_dir")

  # Skip if container is active for this group
  if echo "$ACTIVE_CONTAINERS" | grep -q "$folder"; then
    log "  $folder: ACTIVE container, skipping"
    continue
  fi

  # Check conversation log size
  CONV_DIR="$group_dir/conversations"
  if [ -d "$CONV_DIR" ]; then
    CONV_SIZE=$(du -sk "$CONV_DIR" 2>/dev/null | cut -f1)
    if [ "${CONV_SIZE:-0}" -gt 500 ]; then
      # Archive old conversation files (keep last 3)
      CONV_COUNT=$(ls -1 "$CONV_DIR"/*.md 2>/dev/null | wc -l)
      if [ "$CONV_COUNT" -gt 3 ]; then
        ARCHIVE="$group_dir/conversations-archive"
        mkdir -p "$ARCHIVE"
        ls -1t "$CONV_DIR"/*.md 2>/dev/null | tail -n +4 | xargs -I{} mv {} "$ARCHIVE/" 2>/dev/null
        MOVED=$((CONV_COUNT - 3))
        log "  $folder: archived $MOVED old conversations (${CONV_SIZE}KB → kept 3)"
      fi
    fi
  fi
done

log "=== Hourly ops complete ==="
