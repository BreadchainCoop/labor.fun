#!/usr/bin/env bash
#
# End-to-end smoke test for the hosted-Kubernetes story on a local kind cluster.
#
# What it proves (the whole spawn -> proxy -> metering -> cleanup loop actually
# works on a real cluster, not just at the argv/pod-spec unit level):
#   1. The orchestrator image runs as a per-tenant Deployment and its
#      credential proxy comes up.
#   2. A pre-seeded 'once' scheduled task makes the orchestrator spawn a real
#      agent Pod (nanoclaw-*) via `kubectl run --rm -i` — verifying attach
#      semantics carry the stdin/stdout JSON protocol and RBAC suffices.
#   3. The agent pod reaches the orchestrator's in-pod credential proxy, which
#      forwards to a mock Anthropic upstream (exercising the credential proxy +
#      usage metering path end to end).
#   4. An api_usage row lands in the tenant SQLite store (metering).
#   5. The agent pod is deleted after the run (--rm parity).
#   6. task_run_logs records the run (status may be error if the agent SDK
#      chokes on the mock response — acceptable per the task, as long as pod
#      mechanics + proxy + metering all pass).
#
# Volume mode: PVC. kind is single-node, so the default `standard` StorageClass
# (RWO) is fine — the orchestrator and every agent pod land on the one node, so
# ReadWriteOnce is satisfied even though production multi-node PVC mode wants
# RWX. hostPath mode is NOT used because kind's "node" is itself a container:
# hostPath would need the paths to exist on the kind node's filesystem, which is
# awkward to seed; a PVC with kind's dynamic provisioner is cleaner and closer
# to the hosted SaaS shape.
#
# Idempotent + re-runnable: deletes and recreates the cluster each run. Target
# runtime < ~15 min (dominated by the two image builds; kind load + deploy is
# fast). Always deletes the cluster on exit (trap), even on failure.
#
# Usage:
#   deploy/k8s/smoke-test.sh                 # build images, run, assert
#   SKIP_BUILD=1 deploy/k8s/smoke-test.sh    # reuse already-built local images
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
CLUSTER=labor-smoke
NS=nanoclaw-tenant-smoke
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENT_IMAGE=nanoclaw-agent:smoke
ORCH_IMAGE=nanoclaw-orchestrator:smoke
PROFILE=smoke                       # LABOR_PROFILE
PROFILE_DIR=/data/profiles/${PROFILE}
GROUP_FOLDER=smoke
GROUP_JID=slack:C-SMOKE             # a slack: JID so the Slack channel owns it
TIMEOUT_KUBECTL=180s

# Where the PVC is mounted in the orchestrator + seed job. The orchestrator
# resolves PROFILE_DIR as <cwd>/profiles/<LABOR_PROFILE> == /app/profiles/smoke,
# so the PVC's `profile` subPath is mounted there. See the deployment manifest
# and the "PVC layout" note in docs/KUBERNETES.md.
ORCH_PROFILE_MOUNT=/app/profiles/${PROFILE}

pass_count=0
fail_count=0
declare -a RESULTS=()

log()  { printf '\n\033[1;36m=== %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
check() {
  # check "<name>" <0|1 pass/fail> ["detail"]
  local name="$1" ok="$2" detail="${3:-}"
  if [[ "$ok" == "0" ]]; then
    RESULTS+=("PASS  ${name}")
    pass_count=$((pass_count + 1))
    printf '\033[1;32m[PASS]\033[0m %s %s\n' "$name" "$detail"
  else
    RESULTS+=("FAIL  ${name}  ${detail}")
    fail_count=$((fail_count + 1))
    printf '\033[1;31m[FAIL]\033[0m %s %s\n' "$name" "$detail"
  fi
}

cleanup() {
  local code=$?
  log "Teardown"
  # Dump orchestrator logs on failure to aid debugging.
  if [[ $code -ne 0 || $fail_count -gt 0 ]]; then
    info "orchestrator logs (tail):"
    kubectl -n "$NS" logs deploy/nanoclaw-orchestrator --tail=80 2>/dev/null | sed 's/^/      /' || true
  fi
  kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
  print_summary
  # Preserve a non-zero exit if any assertion failed.
  if [[ $fail_count -gt 0 && $code -eq 0 ]]; then exit 1; fi
  exit $code
}
trap cleanup EXIT

print_summary() {
  log "SMOKE TEST SUMMARY"
  printf '%s\n' "${RESULTS[@]}"
  printf '\n  %d passed, %d failed\n\n' "$pass_count" "$fail_count"
}

# ---------------------------------------------------------------------------
# 0. Preconditions
# ---------------------------------------------------------------------------
log "Preconditions"
for bin in docker kind kubectl; do
  command -v "$bin" >/dev/null || { echo "missing required tool: $bin"; exit 2; }
done
docker info >/dev/null 2>&1 || { echo "docker daemon not reachable"; exit 2; }
info "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null), kind $(kind version 2>/dev/null | head -1)"

# ---------------------------------------------------------------------------
# 1. Cluster
# ---------------------------------------------------------------------------
log "Create kind cluster: $CLUSTER"
kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
kind create cluster --name "$CLUSTER" --wait 120s

# ---------------------------------------------------------------------------
# 2. Images: build + load into kind
# ---------------------------------------------------------------------------
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  log "Build agent image ($AGENT_IMAGE)"
  ( cd "$REPO_ROOT/container" && CONTAINER_RUNTIME=docker ./build.sh smoke >/dev/null )
  # build.sh tags nanoclaw-agent:smoke via TAG arg
  docker tag nanoclaw-agent:smoke "$AGENT_IMAGE" 2>/dev/null || true

  log "Build orchestrator image ($ORCH_IMAGE)"
  docker build -f "$REPO_ROOT/deploy/docker/Dockerfile.orchestrator" \
    -t "$ORCH_IMAGE" "$REPO_ROOT" >/dev/null
else
  info "SKIP_BUILD=1 — using existing local images"
fi

log "Load images into kind"
kind load docker-image "$AGENT_IMAGE" --name "$CLUSTER"
kind load docker-image "$ORCH_IMAGE" --name "$CLUSTER"

# ---------------------------------------------------------------------------
# 3. Namespace + RBAC + PVC + mock upstream + secret + seed + orchestrator
# ---------------------------------------------------------------------------
log "Apply namespace + RBAC + PVC"
kubectl apply -f - <<YAML
apiVersion: v1
kind: Namespace
metadata:
  name: ${NS}
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: nanoclaw-orchestrator
  namespace: ${NS}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: nanoclaw-agent-runner
  namespace: ${NS}
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["create", "get", "list", "watch", "delete"]
  - apiGroups: [""]
    resources: ["pods/attach"]
    verbs: ["create", "get"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: nanoclaw-agent-runner-binding
  namespace: ${NS}
subjects:
  - kind: ServiceAccount
    name: nanoclaw-orchestrator
    namespace: ${NS}
roleRef:
  kind: Role
  name: nanoclaw-agent-runner
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: nanoclaw-data
  namespace: ${NS}
spec:
  accessModes: ["ReadWriteOnce"]      # kind single node -> RWO is sufficient
  storageClassName: standard          # kind's default dynamic provisioner
  resources:
    requests:
      storage: 1Gi
YAML

log "Deploy mock Anthropic upstream"
# A ~20-line node HTTP server returning a canned non-streaming /v1/messages
# response with a usage block, and logging each request path so we can prove
# the agent pod reached it through the proxy.
# The mock server source is written to a temp file and loaded into a ConfigMap
# with `kubectl create --from-file`, which is robust regardless of shell
# heredoc quoting. The Deployment + Service are applied separately below.
cat > /tmp/smoke-mock-server.js <<'JS'
// Minimal mock Anthropic upstream. Answers /v1/messages both ways:
//   - non-streaming JSON (with a usage block) for a plain request, and
//   - a proper SSE stream (message_start .. message_delta w/ usage .. message_stop)
//     when the client asks for streaming (the claude-code CLI does).
// Either way the proxy can parse a usage block, so metering is exercised. The
// SSE path gives the agent SDK the best chance to complete cleanly.
const http = require('http');
function sse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (event, data) =>
    res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  send('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_smoke', type: 'message', role: 'assistant', model: 'claude-smoke-1',
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } });
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } });
  send('message_stop', { type: 'message_stop' });
  res.end();
}
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    // Log every hit so proxy->upstream forwarding is observable in the logs.
    console.log('MOCK_UPSTREAM_HIT ' + req.method + ' ' + req.url);
    if (req.url.startsWith('/v1/messages')) {
      let wantsStream = false;
      try { wantsStream = JSON.parse(body || '{}').stream === true; } catch (_) {}
      if (wantsStream || (req.headers.accept || '').includes('text/event-stream')) {
        sse(res);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_smoke', type: 'message', role: 'assistant', model: 'claude-smoke-1',
        stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});
server.listen(8080, '0.0.0.0', () => console.log('mock-anthropic on 8080'));
JS
kubectl -n "$NS" delete configmap mock-anthropic >/dev/null 2>&1 || true
kubectl -n "$NS" create configmap mock-anthropic --from-file=server.js=/tmp/smoke-mock-server.js

kubectl apply -f - <<YAML
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mock-anthropic
  namespace: ${NS}
spec:
  replicas: 1
  selector:
    matchLabels: { app: mock-anthropic }
  template:
    metadata:
      labels: { app: mock-anthropic }
    spec:
      containers:
        - name: mock
          image: node:22-slim
          command: ["node", "/srv/server.js"]
          ports: [{ containerPort: 8080 }]
          volumeMounts:
            - name: src
              mountPath: /srv
      volumes:
        - name: src
          configMap:
            name: mock-anthropic
---
apiVersion: v1
kind: Service
metadata:
  name: mock-anthropic
  namespace: ${NS}
spec:
  selector: { app: mock-anthropic }
  ports:
    - port: 80
      targetPort: 8080
YAML

log "Create tenant secret (.env for the orchestrator)"
# The credential proxy + Slack channel read config process.env-first with a
# .env fallback. We deliver a .env via a Secret mounted at /app/.env so the
# proxy sees ANTHROPIC_* and the Slack channel connects offline with dummy
# creds (its auth.test() failure is caught, so channels.length > 0 holds and
# the orchestrator does not exit).
cat > /tmp/smoke.env <<ENV
ANTHROPIC_API_KEY=smoke-dummy
ANTHROPIC_BASE_URL=http://mock-anthropic.${NS}.svc.cluster.local
SLACK_BOT_TOKEN=xoxb-smoke-dummy
SLACK_RECEIVER_MODE=http
SLACK_SIGNING_SECRET=smoke-signing-secret
SLACK_HTTP_PORT=3012
# FLAT_ACCESS defaults ON (cooperative mode: every group is treated as main).
# A "main" group mounts the project ROOT (process.cwd()=/app, the image code)
# read-only into the agent pod — which cannot be satisfied from the tenant PVC
# (the project lives in the image, not the PVC) and also tries to stub
# /app/store (not writable by the non-root user). The hosted tenant case is a
# normal NON-main group, so pin FLAT_ACCESS=false. See docs/KUBERNETES.md.
FLAT_ACCESS=false
ENV
kubectl -n "$NS" delete secret nanoclaw-env >/dev/null 2>&1 || true
kubectl -n "$NS" create secret generic nanoclaw-env --from-file=.env=/tmp/smoke.env

log "Seed the PVC (profile + registered group + due 'once' task)"
# A Job runs the orchestrator image (which has better-sqlite3) to write a
# minimal self-contained profile into the PVC and register a group + a 'once'
# scheduled task whose next_run is in the past, so the scheduler fires it
# immediately at orchestrator boot. The profile is written inline (not copied
# from a baked template) so the seed does not depend on image internals.
#
# PVC layout contract (see docs/KUBERNETES.md "Path translation"): the
# orchestrator mounts the PVC's `profile` subPath at PROFILE_DIR, and agent
# pods use per-mount subPaths `profile/...`. So the seed must place the profile
# at the PVC-internal path `profile/` — i.e. mount the PVC at /data and write to
# /data/profile (NOT /data/profiles/<name>).
kubectl apply -f - <<YAML
apiVersion: batch/v1
kind: Job
metadata:
  name: seed
  namespace: ${NS}
spec:
  backoffLimit: 1
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: seed
          image: ${ORCH_IMAGE}
          imagePullPolicy: IfNotPresent
          workingDir: /app
          command: ["node", "-e"]
          args:
            - |
              const fs = require('fs');
              const path = require('path');
              const Database = require('better-sqlite3');
              const dst = '/data/profile';
              fs.mkdirSync(dst, { recursive: true });
              // Minimal profile.config.json — sharedKbGroup points at slack_main
              // (its context/ dir is mounted read-only into agent pods).
              fs.writeFileSync(path.join(dst, 'profile.config.json'), JSON.stringify({
                assistantName: 'Aide', orgName: 'Smoke Org',
                sharedKbGroup: 'slack_main', timezone: 'UTC', enabledSkills: [],
              }, null, 2));
              // Group folders: the smoke group, global (non-main guidance), and
              // the shared-KB group's context dir.
              const groups = path.join(dst, 'groups', '${GROUP_FOLDER}');
              fs.mkdirSync(groups, { recursive: true });
              fs.writeFileSync(path.join(groups, 'CLAUDE.md'), '# smoke group\n');
              fs.mkdirSync(path.join(dst, 'groups', 'global'), { recursive: true });
              fs.writeFileSync(path.join(dst, 'groups', 'global', 'CLAUDE.md'), '# global\n');
              fs.mkdirSync(path.join(dst, 'groups', 'slack_main', 'context'), { recursive: true });
              const storeDir = path.join(dst, 'store');
              fs.mkdirSync(storeDir, { recursive: true });
              fs.mkdirSync(path.join(dst, 'data'), { recursive: true });
              const db = new Database(path.join(storeDir, 'messages.db'));
              db.exec(\`CREATE TABLE IF NOT EXISTS chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT, channel TEXT, is_group INTEGER DEFAULT 0);\`);
              db.exec(\`CREATE TABLE IF NOT EXISTS registered_groups (jid TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE, trigger_pattern TEXT NOT NULL, added_at TEXT NOT NULL, container_config TEXT, requires_trigger INTEGER DEFAULT 1, is_main INTEGER DEFAULT 0);\`);
              db.exec(\`CREATE TABLE IF NOT EXISTS scheduled_tasks (id TEXT PRIMARY KEY, group_folder TEXT NOT NULL, chat_jid TEXT NOT NULL, prompt TEXT NOT NULL, schedule_type TEXT NOT NULL, schedule_value TEXT NOT NULL, next_run TEXT, last_run TEXT, last_result TEXT, status TEXT DEFAULT 'active', created_at TEXT NOT NULL, context_mode TEXT DEFAULT 'isolated', script TEXT);\`);
              const now = new Date().toISOString();
              db.prepare('INSERT OR REPLACE INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)').run('${GROUP_JID}', 'smoke', now, 'slack', 1);
              db.prepare('INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger, is_main) VALUES (?, ?, ?, ?, ?, 0, 0)').run('${GROUP_JID}', 'smoke', '${GROUP_FOLDER}', '@Aide', now);
              const past = new Date(Date.now() - 60000).toISOString();
              db.prepare("INSERT OR REPLACE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at, context_mode) VALUES (?, ?, ?, ?, 'once', '', ?, 'active', ?, 'isolated')").run('smoke-task-1', '${GROUP_FOLDER}', '${GROUP_JID}', 'Say ok and stop.', past, now);
              db.close();
              console.log('SEED_DONE profile=' + dst);
          volumeMounts:
            - name: data
              mountPath: /data
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: nanoclaw-data
YAML

kubectl -n "$NS" wait --for=condition=complete job/seed --timeout="$TIMEOUT_KUBECTL" \
  || { kubectl -n "$NS" logs job/seed | sed 's/^/      /'; check "seed job completed" 1 "job did not complete"; exit 1; }
check "seed job completed" 0

log "Wait for mock upstream to be ready"
kubectl -n "$NS" rollout status deploy/mock-anthropic --timeout="$TIMEOUT_KUBECTL"

log "Deploy the orchestrator"
kubectl apply -f - <<YAML
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nanoclaw-orchestrator
  namespace: ${NS}
  labels: { app: nanoclaw-orchestrator }
spec:
  replicas: 1
  strategy: { type: Recreate }
  selector:
    matchLabels: { app: nanoclaw-orchestrator }
  template:
    metadata:
      labels: { app: nanoclaw-orchestrator }
    spec:
      serviceAccountName: nanoclaw-orchestrator
      containers:
        - name: orchestrator
          image: ${ORCH_IMAGE}
          imagePullPolicy: IfNotPresent
          env:
            - name: CONTAINER_RUNTIME
              value: "kubernetes"
            - name: K8S_NAMESPACE
              value: "${NS}"
            - name: K8S_VOLUME_MODE
              value: "pvc"
            - name: K8S_DATA_PVC_NAME
              value: "nanoclaw-data"
            - name: LABOR_PROFILE
              value: "${PROFILE}"
            - name: CONTAINER_IMAGE
              value: "${AGENT_IMAGE}"
            - name: LOG_LEVEL
              value: "debug"
            - name: K8S_POD_IP
              valueFrom: { fieldRef: { fieldPath: status.podIP } }
            - name: K8S_NODE_NAME
              valueFrom: { fieldRef: { fieldPath: spec.nodeName } }
          ports:
            - containerPort: 3001
          volumeMounts:
            # Mount the PVC's "profile" subPath at PROFILE_DIR
            # (<cwd>/profiles/<LABOR_PROFILE>). Agent pods mount the same PVC
            # (root) and use per-mount subPaths "profile/...", so both see the
            # same files. See docs/KUBERNETES.md "Path translation".
            # (No backticks here: this is an unquoted heredoc — backticks would
            # be shell command substitution.)
            - name: data
              mountPath: ${ORCH_PROFILE_MOUNT}
              subPath: profile
            # .env with ANTHROPIC_* + Slack dummy creds.
            - name: env
              mountPath: /app/.env
              subPath: .env
              readOnly: true
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: nanoclaw-data
        - name: env
          secret:
            secretName: nanoclaw-env
            items:
              - key: .env
                path: .env
YAML

# ---------------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------------
# Log/exec helpers that always target the CURRENT orchestrator pod. Reading
# via `deploy/<name>` (not a name captured once) is race-free: kubectl resolves
# the deployment's live pod each call, so a rescheduled pod doesn't strand us on
# a stale name. --tail=-1 forces the full log (some kubectl builds default to a
# recent slice when following a deploy).
orch_logs() { kubectl -n "$NS" logs "deploy/nanoclaw-orchestrator" --tail=-1 2>/dev/null; }
orch_pod() { kubectl -n "$NS" get pod -l app=nanoclaw-orchestrator \
  --field-selector=status.phase=Running \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null; }

log "(a) orchestrator Ready + credential proxy started"
if kubectl -n "$NS" rollout status deploy/nanoclaw-orchestrator --timeout="$TIMEOUT_KUBECTL"; then
  check "(a1) orchestrator pod Ready" 0
else
  check "(a1) orchestrator pod Ready" 1 "rollout did not complete"
fi
info "orchestrator pod: $(orch_pod)"

# Wait up to ~90s for the proxy log line (no readiness probe, so Ready fires at
# container start — main()'s proxy boot lands a moment later).
proxy_up=1
for _ in $(seq 1 45); do
  if orch_logs | grep -q "Credential proxy started"; then proxy_up=0; break; fi
  sleep 2
done
check "(a2) logs show 'Credential proxy started'" "$proxy_up"

log "(b) scheduled trigger spawns an agent pod (nanoclaw-*)"
# The 'once' task's next_run is in the past, so the first scheduler tick (<=60s)
# fires it. Catch the pod directly, or the spawn log line if the pod is already
# gone (fast runs). Allow ~120s (scheduler poll + pod schedule + short run).
agent_seen=1
AGENT_POD=""
for _ in $(seq 1 60); do
  AGENT_POD="$(kubectl -n "$NS" get pods -l app=nanoclaw-agent -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [[ -n "$AGENT_POD" ]]; then agent_seen=0; break; fi
  if orch_logs | grep -q "Spawning container agent"; then agent_seen=0; break; fi
  sleep 2
done
check "(b) agent pod created (nanoclaw-*)" "$agent_seen" "pod=${AGENT_POD:-<caught via log>}"

log "(c) agent pod reached the credential proxy -> mock upstream"
# The mock logs MOCK_UPSTREAM_HIT for every forwarded request. Give the agent
# run time to make at least one /v1/messages call.
upstream_hit=1
for _ in $(seq 1 60); do
  if kubectl -n "$NS" logs deploy/mock-anthropic 2>/dev/null | grep -q "MOCK_UPSTREAM_HIT"; then
    upstream_hit=0; break
  fi
  sleep 2
done
if [[ "$upstream_hit" != "0" ]]; then
  # Fallback signal: proxy forwarded (its own debug logs) even if the SDK never
  # got a clean /v1/messages in.
  orch_logs | grep -qi "proxy" && info "proxy active in orchestrator logs"
fi
check "(c) agent reached proxy/upstream" "$upstream_hit" \
  "$(kubectl -n "$NS" logs deploy/mock-anthropic 2>/dev/null | grep -c MOCK_UPSTREAM_HIT || true) upstream hits"

log "(d) api_usage row landed in tenant SQLite"
# sqlite3 isn't in the image; query via node + the orchestrator's bundled
# better-sqlite3 against the PVC-backed store.
usage_rows="$(kubectl -n "$NS" exec "$(orch_pod)" -- node -e "
  const D=require('better-sqlite3');
  const db=new D('${ORCH_PROFILE_MOUNT}/store/messages.db',{readonly:true});
  try { console.log(db.prepare('SELECT COUNT(*) c FROM api_usage').get().c); }
  catch(e){ console.log('0'); }
" 2>/dev/null | tr -d '[:space:]' || echo 0)"
if [[ "${usage_rows:-0}" -ge 1 ]]; then
  check "(d) api_usage row present" 0 "${usage_rows} row(s)"
else
  check "(d) api_usage row present" 1 "0 rows"
fi

log "(e) agent pod deleted after run (--rm parity)"
agent_gone=1
for _ in $(seq 1 60); do
  remaining="$(kubectl -n "$NS" get pods -l app=nanoclaw-agent -o jsonpath='{.items[*].metadata.name}' 2>/dev/null || true)"
  if [[ -z "$remaining" ]]; then agent_gone=0; break; fi
  sleep 2
done
check "(e) agent pod removed" "$agent_gone" "${remaining:+still present: $remaining}"

log "(f) task_run_logs records the run"
task_rows="$(kubectl -n "$NS" exec "$(orch_pod)" -- node -e "
  const D=require('better-sqlite3');
  const db=new D('${ORCH_PROFILE_MOUNT}/store/messages.db',{readonly:true});
  try { const r=db.prepare('SELECT status FROM task_run_logs ORDER BY run_at DESC LIMIT 1').get(); console.log(r?('1 '+r.status):'0'); }
  catch(e){ console.log('0'); }
" 2>/dev/null || echo 0)"
info "task_run_logs latest: ${task_rows}"
if [[ "${task_rows}" == 1* ]]; then
  check "(f) task_run_logs has a run" 0 "status=${task_rows#1 }"
else
  check "(f) task_run_logs has a run" 1 "no run logged"
fi

# Summary + teardown handled by the EXIT trap.
