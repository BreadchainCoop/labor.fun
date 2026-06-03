#!/usr/bin/env bash
# labor.fun post-deploy smoke test
# Run locally — tests the remote droplet via SSH
# Usage: bash scripts/smoke-test.sh
#   LABOR_PROFILE selects which profile's DB to inspect (default: read from the
#   droplet's deploy env, else "breadchain").

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
fi
HOST="${DROPLET_HOST:?Set DROPLET_HOST in .env or environment (e.g. root@your-droplet)}"

# Resolve the active profile: explicit LABOR_PROFILE, else the single
# non-example profile in this local checkout, else default. Its store/ holds the
# DB the smoke test inspects.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILES_DIR="$SCRIPT_DIR/../profiles"
PROFILE="${LABOR_PROFILE:-}"
if [ -z "$PROFILE" ] && [ -d "$PROFILES_DIR" ]; then
  PROFILE="$(ls "$PROFILES_DIR" 2>/dev/null | grep -vx example | head -n1 || true)"
fi
PROFILE="${PROFILE:-breadchain}"
DB_REL="profiles/$PROFILE/store/messages.db"

# Infra (DEPLOY_ROOT, SERVICE_USER) from the local profile config; defaults
# preserve breadchain.
DEPLOY_CONFIG="$PROFILES_DIR/$PROFILE/deploy.config"
# shellcheck disable=SC1090
[ -f "$DEPLOY_CONFIG" ] && . "$DEPLOY_CONFIG"
DEPLOY_ROOT="${DEPLOY_ROOT:-/opt/breadbrich}"
SERVICE_USER="${SERVICE_USER:-breadbrich}"

# Comma-separated list of JIDs the smoke test should assert are registered.
# If unset, the per-JID assertions are skipped.
IFS=',' read -ra EXPECTED_JIDS <<< "${EXPECTED_REGISTERED_JIDS:-}"
EXPECTED_GROUPS="${#EXPECTED_JIDS[@]}"
PASS=0
FAIL=0

pass() { echo "  ✓ $1"; ((PASS++)); }
fail() { echo "  ✗ $1"; ((FAIL++)); }

echo "=== labor.fun Smoke Tests ==="
echo ""

# 1. Service is running
echo "Service:"
status=$(ssh "$HOST" "systemctl is-active breadbrich 2>/dev/null" || true)
if [ "$status" = "active" ]; then
  pass "breadbrich.service is active"
else
  fail "breadbrich.service is $status"
fi

# 2. Process is alive and recent
pid=$(ssh "$HOST" "systemctl show breadbrich -p MainPID --value 2>/dev/null" || echo "0")
if [ "$pid" != "0" ] && [ -n "$pid" ]; then
  pass "Process running (PID $pid)"
else
  fail "No running process"
fi

# 3. groupCount matches expected (only if EXPECTED_REGISTERED_JIDS is set)
echo ""
echo "Groups:"
if [ "$EXPECTED_GROUPS" -gt 0 ]; then
  group_count=$(ssh "$HOST" "journalctl -u breadbrich --no-pager -n 50 | grep -o 'groupCount: [0-9]*' | tail -1 | grep -o '[0-9]*'" || echo "0")
  # Use >= rather than == — the orchestrator typically registers more groups
  # than the test asserts. The per-JID checks below still verify the specific
  # ones we care about are present.
  if [ "$group_count" -ge "$EXPECTED_GROUPS" ]; then
    pass "groupCount is $group_count (≥ expected $EXPECTED_GROUPS)"
  else
    fail "groupCount is $group_count (expected ≥ $EXPECTED_GROUPS)"
  fi

  # 4. All expected JIDs registered
  all_jids=$(ssh "$HOST" "su - $SERVICE_USER -c 'cd $DEPLOY_ROOT && node -e \"const db = require(\\\"better-sqlite3\\\")(\\\"$DB_REL\\\"); db.prepare(\\\"SELECT jid FROM registered_groups\\\").all().forEach(r => console.log(r.jid))\"'" 2>/dev/null || echo "")
  for jid in "${EXPECTED_JIDS[@]}"; do
    if echo "$all_jids" | grep -qF "$jid"; then
      pass "Registered: $jid"
    else
      fail "Missing registration: $jid"
    fi
  done
else
  echo "  (skipped — set EXPECTED_REGISTERED_JIDS in .env to enable)"
fi

# 5. Slack token valid
echo ""
echo "Credentials:"
slack_ok=$(ssh "$HOST" "source /home/breadbrich/.config/nanoclaw/.env 2>/dev/null; export \$(grep -E '^SLACK_BOT_TOKEN' /home/breadbrich/.config/nanoclaw/.env | xargs); curl -s -H \"Authorization: Bearer \$SLACK_BOT_TOKEN\" https://slack.com/api/auth.test | grep -o '\"ok\":true'" 2>/dev/null || echo "")
if [ -n "$slack_ok" ]; then
  pass "Slack bot token valid"
else
  fail "Slack bot token invalid or missing"
fi

# 6. Telegram bot connected (check logs)
tg_connected=$(ssh "$HOST" "journalctl -u breadbrich --no-pager -n 50 | grep -c 'Telegram bot connected'" || echo "0")
if [ "$tg_connected" -gt 0 ]; then
  pass "Telegram bot connected"
else
  fail "Telegram bot not connected"
fi

# 7. Slack connected
slack_connected=$(ssh "$HOST" "journalctl -u breadbrich --no-pager -n 50 | grep -c 'Connected to Slack'" || echo "0")
if [ "$slack_connected" -gt 0 ]; then
  pass "Slack connected"
else
  fail "Slack not connected"
fi

# 8. Credential proxy running
proxy_up=$(ssh "$HOST" "journalctl -u breadbrich --no-pager -n 50 | grep -c 'Credential proxy started'" || echo "0")
if [ "$proxy_up" -gt 0 ]; then
  pass "Credential proxy started"
else
  fail "Credential proxy not started"
fi

# 9. No errors in recent logs
echo ""
echo "Health:"
error_count=$(ssh "$HOST" "journalctl -u breadbrich --no-pager --since '2 min ago' | grep -ci 'error\|fatal\|crash\|ECONNREFUSED' || true" 2>/dev/null)
if [ "${error_count:-0}" -eq 0 ]; then
  pass "No errors in recent logs"
else
  fail "$error_count error(s) in recent logs"
  ssh "$HOST" "journalctl -u breadbrich --no-pager --since '2 min ago' | grep -i 'error\|fatal\|crash'" 2>/dev/null | head -5 | sed 's/^/    /'
fi

# 10. Docker available for containers
docker_ok=$(ssh "$HOST" "docker info >/dev/null 2>&1 && echo ok || echo fail")
if [ "$docker_ok" = "ok" ]; then
  pass "Docker daemon available"
else
  fail "Docker daemon not available"
fi

# Summary
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
  echo "SMOKE TEST FAILED"
  exit 1
else
  echo "ALL CLEAR"
  exit 0
fi
