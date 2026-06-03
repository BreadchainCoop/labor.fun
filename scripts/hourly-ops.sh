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

DEPLOY_ROOT="/opt/breadbrich"
DEPLOY_ENV="$DEPLOY_ROOT/setup/breadbrich-deploy.env"
PROFILE="${LABOR_PROFILE:-}"
KB_GROUP="${SHARED_KB_GROUP:-}"
if [ -f "$DEPLOY_ENV" ]; then
  [ -z "$PROFILE" ] && PROFILE="$(grep -E '^LABOR_PROFILE=' "$DEPLOY_ENV" | tail -1 | cut -d= -f2- | tr -d '"' || true)"
  [ -z "$KB_GROUP" ] && KB_GROUP="$(grep -E '^SHARED_KB_GROUP=' "$DEPLOY_ENV" | tail -1 | cut -d= -f2- | tr -d '"' || true)"
fi
PROFILE="${PROFILE:-breadchain}"
KB_GROUP="${KB_GROUP:-discord_main}"
REPO="${LABOR_REPO:-BreadchainCoop/labor.fun}"

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

# --- 2. Check recent TG messages for missed ingestion ---
log "Checking TG message ingestion..."
# Get @your_bot_username mentions from last 2 hours that should have been processed
CUTOFF=$(date -u -d "2 hours ago" +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -v-2H +%Y-%m-%dT%H:%M:%S 2>/dev/null || echo "")
if [ -n "$CUTOFF" ] && [ -f "$DB" ]; then
  node --input-type=module -e "
    import Database from 'better-sqlite3';
    const db = new Database('$DB');

    // Get recent @mentions
    const mentions = db.prepare(
      \"SELECT id, sender_name, content, timestamp FROM messages WHERE chat_jid = 'tg:-1001234567890' AND timestamp > ? AND (content LIKE '%@your_bot%' OR content LIKE '%@Breadbrich Engels%') AND is_from_me = 0 ORDER BY timestamp ASC\"
    ).all('$CUTOFF');

    // Get recent agent runs for this group
    const runs = db.prepare(
      \"SELECT trigger_content, status, started_at FROM agent_runs WHERE chat_jid = 'tg:-1001234567890' AND started_at > ? ORDER BY started_at ASC\"
    ).all('$CUTOFF');

    // Check for blocked KB writes
    const results = { mentions: mentions.length, runs: runs.length, successRuns: runs.filter(r => r.status === 'success').length };
    console.log(JSON.stringify(results));
  " >> "$LOG" 2>/dev/null || log "WARN: TG ingestion check failed"
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
