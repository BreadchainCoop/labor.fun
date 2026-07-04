# Running labor.fun on Kubernetes

This document describes the `CONTAINER_RUNTIME=kubernetes` backend: what it
maps to from the Docker model, the constraints that come with running
pod-per-agent-run instead of container-per-agent-run, and a quickstart for
self-hosting a single tenant on a cluster you control.

It also describes the target shape for hosted multi-tenant SaaS: one
Kubernetes **namespace per tenant**, with the orchestrator running as a
`Deployment` in that namespace and each agent run becoming a `Pod` in the same
namespace. The OSS repo ships the primitives (`CONTAINER_RUNTIME=kubernetes`,
example manifests); the multi-tenant control plane that provisions namespaces
per customer is out of scope for this doc.

## Why pod-per-run, same as container-per-run

Today (`src/container-runner.ts`) every agent turn spawns exactly one
short-lived `docker run -i --rm ...` process: JSON goes in on stdin, streamed
JSON comes out on stdout between `---NANOCLAW_OUTPUT_START/END---` markers,
and the container is torn down (`--rm`) when it exits or is force-stopped on
timeout/idle. There is no long-running agent container — the orchestrator
process is the only long-lived thing.

The Kubernetes backend preserves this model exactly: one Pod per agent run,
deleted when the run ends. It does **not** move to a Job/CronJob model or a
warm-pool of agent pods — that would be a bigger behavioral change than this
task calls for, and it would complicate the idle-timeout/streaming-output
semantics `container-runner.ts` already depends on (a `close` event on the
child process, non-zero exit meaning error unless output already streamed,
etc). A pod is the closest Kubernetes primitive to "one container, `-i --rm`,
attached stdio."

## Feature mapping

| Docker today | Kubernetes equivalent |
|---|---|
| `docker run -i --rm --name <n> <image>` | `kubectl run <n> --rm -i --restart=Never --image=<image> --overrides=<pod spec JSON>` |
| `-v host:container[:ro]` bind mounts | `volumes` + `volumeMounts` in the pod spec (hostPath or PVC+subPath, see below) |
| `--add-host=host.docker.internal:host-gateway` | No equivalent — instead the agent pod gets `ANTHROPIC_BASE_URL=http://<orchestrator-pod-ip>:<port>` injected as a literal env value (see "Credential proxy reachability") |
| `-e NAME=value` / `-e NAME` (passthrough) | `env: [{name, value}]` in the pod spec overrides |
| `--user uid:gid` | `securityContext.runAsUser` / `runAsGroup` at the pod or container level |
| `--rm` (auto-delete on exit) | `kubectl run --rm` deletes the pod once attach detaches; the backend also explicitly `kubectl delete pod` as a belt-and-suspenders cleanup on error/timeout paths, since `--rm`'s cleanup is best-effort if the CLI process itself is killed |
| `docker stop -t 1 <name>` (timeout kill) | `kubectl delete pod <name> --grace-period=1 --now` |
| `docker ps --filter name=nanoclaw-` (orphan sweep) | `kubectl get pods -l app=nanoclaw-agent -o name` |
| Memory/CPU/pids-limit flags (`--memory`, `--cpus`, `--pids-limit`) | `resources.limits.memory` / `resources.limits.cpu`; **no direct equivalent for pids-limit** (see below) |
| Single Docker host | One Kubernetes **namespace per tenant**; RBAC scopes the orchestrator's ServiceAccount to that namespace only |

### pids-limit has no Kubernetes equivalent

Docker's `--pids-limit` caps the number of processes/threads a container can
fork, defended against fork bombs. Kubernetes has no pod-level knob for this
via the public API — the underlying mechanism (the `pids` cgroup controller)
is configured cluster-wide by the kubelet (`PodPidsLimit` / `--pod-max-pids`
kubelet flag), not per-pod. The k8s backend reads `AGENT_CONTAINER_PIDS_LIMIT`
for parity with the docker backend's env surface, logs a one-time warning
that it has no effect, and does not fail — operators who need this must set
the kubelet's `--pod-max-pids` (or a `PodSecurityPolicy`/admission-controller
equivalent) at the cluster level, not per-tenant.

## stdin/stdout strategy: `kubectl run --rm -i`, not create+attach+delete

Two approaches were considered:

1. **`kubectl run <name> --rm -i --restart=Never --image=... --overrides=<json>`**
   Creates the pod, attaches to its stdio, streams stdin, streams stdout back
   to the local process's stdout, and deletes the pod when the attached
   session ends. This is the closest match to `docker run -i --rm`: one CLI
   invocation, one child process, no separate polling step.

2. **Create pod (`stdin: true, stdinOnce: true`) → `kubectl attach -i` →
   `kubectl delete pod`.** Three separate `kubectl` invocations. Requires the
   backend to poll for the pod to reach `Running` before attach will succeed
   (attach fails immediately if the container isn't started yet), and to
   handle attach reconnection if the initial attach races the container
   start.

**Decision: use `kubectl run --rm -i`.** It maps 1:1 onto the existing
`spawn(CONTAINER_RUNTIME_BIN, args, {stdio: ['pipe','pipe','pipe']})` call in
`container-runner.ts` — same child-process lifecycle, same stdin-write /
stdout-stream / close-event handling, no polling loop to write and test.
`kubectl run --rm` is documented as effectively sugar for
create+attach+delete, so it does not lose functionality; it just means the
backend does not have to reimplement that orchestration itself.

The known rough edge: if `kubectl run --rm`'s implicit delete doesn't fire
(e.g. the local `kubectl` process is SIGKILLed before it can clean up), the
pod can leak. This is the same category of risk Docker already has (an
orphaned `nanoclaw-*` container if the host process dies mid-run), and it's
handled the same way: an orphan-sweep pass. See "Orphan cleanup" below.

`--overrides` is used for everything `kubectl run`'s flags can't express
(volumes, resources, security context, node affinity, extra env). Verified
support: `--overrides` takes a full serialized API object
(`{"apiVersion": "v1", "spec": {...}}` for `--overrides-embedded-name`-style
pod overrides, or a full `Pod` object) merged on top of what `kubectl run`
generates from its own flags — `volumes`, `volumeMounts`, `env`, `resources`,
and `securityContext` are all normal fields of `PodSpec`/`Container`, so they
all work through `--overrides`. The backend never relies on `kubectl run`'s
own flags (`--env`, `--limits`, etc.) for anything — the whole pod spec is
built as one JSON object in code and handed to `--overrides`, which keeps
`buildK8sPodOverrides()` a single pure function with one shape of output to
test.

## Volumes: hostPath vs PVC

`container-runner.ts` computes a `VolumeMount[]` of **host paths** (group
dir, shared KB, sessions, IPC, agent-runner source, store, etc.) — see
`buildVolumeMounts()`. Docker bind-mounts those host paths directly. On
Kubernetes there is no "host path of the orchestrator process" concept the
agent pod can share automatically, because the orchestrator and the agent pod
are different pods and may be scheduled on different nodes. Two supported
modes, selected by `K8S_VOLUME_MODE`:

### `K8S_VOLUME_MODE=hostPath` (default)

The orchestrator publishes its own node name via the downward API
(`K8S_NODE_NAME`, from `spec.nodeName`). The agent pod spec gets:

```json
{
  "spec": {
    "nodeName": "<value of K8S_NODE_NAME>",
    "volumes": [
      {"name": "v0", "hostPath": {"path": "/abs/host/path/from/mount", "type": "DirectoryOrCreate"}}
    ]
  }
}
```

`nodeName` (not `nodeAffinity`) is used because it's a hard, unambiguous
placement — exactly what's needed since the whole point is "same node as the
orchestrator, so the same hostPath resolves to the same files." This is the
simplest mode and matches self-host-on-a-single-node clusters (k3s, kind,
minikube, a single-VM cluster) closely — same trust model as Docker on one
host. It does not work across a multi-node cluster unless every node happens
to share the same underlying filesystem (e.g. NFS-backed node storage), which
defeats the point of hostPath.

### `K8S_VOLUME_MODE=pvc`

For real multi-node clusters (the hosted SaaS case), both the orchestrator
Deployment and every agent Pod mount the **same** `PersistentVolumeClaim**
(`K8S_DATA_PVC_NAME`), which must be backed by a `ReadWriteMany` (RWX)
StorageClass (e.g. NFS, EFS, Filestore, Longhorn with RWX, CephFS). Instead of
one `hostPath` volume per mount, the agent pod gets one shared PVC volume with
per-mount `subPath`:

```json
{
  "spec": {
    "volumes": [{"name": "data", "persistentVolumeClaim": {"claimName": "<K8S_DATA_PVC_NAME>"}}],
    "containers": [{
      "volumeMounts": [
        {"name": "data", "mountPath": "/workspace/group", "subPath": "groups/acme-org/context", "readOnly": false}
      ]
    }]
  }
}
```

### Path translation is the hard part

`buildVolumeMounts()` returns **absolute host paths** computed from
`PROFILE_DIR`, `GROUPS_DIR`, `DATA_DIR`, `STORE_DIR`, `process.cwd()`, etc.
Those are meaningless as PVC subPaths (a subPath is relative to the volume
root, not an absolute host filesystem path). The k8s backend therefore needs
a **path translator** that maps each computed host path to a
PVC-relative subPath, by stripping a known root prefix:

- In hostPath mode: pass the absolute host path straight through as
  `hostPath.path` — no translation needed, since it's still "a path on a
  node's disk."
- In PVC mode: the translator requires every mount's `hostPath` to fall
  under one of a small set of known roots (`PROFILE_DIR`, `process.cwd()` for
  the read-only project-root mount, `DATA_DIR` for sessions/agent-runner-src)
  and rewrites it to `<root-name>/<relative-path>`, e.g.
  `PROFILE_DIR/groups/acme/context` → subPath `profile/groups/acme/context`.
  This assumes the operator's PVC is provisioned with the *same relative
  layout* as the profile directory on the orchestrator's own PVC-backed mount
  (i.e. the orchestrator Deployment itself mounts the PVC at a path that
  matches `PROFILE_DIR`/`DATA_DIR`, so both orchestrator and agent pods see
  the identical relative structure). A host path that doesn't fall under a
  known root (e.g. an operator-added `additionalMounts` entry pointing
  somewhere arbitrary on the host) cannot be translated safely in PVC mode and
  is rejected with a clear error rather than silently mounted wrong — the
  hostPath mode has no such restriction because there is no translation.
- `-v host:/workspace/project/.env:ro` pointed at `/dev/null` (the .env
  shadow mount) has no PVC-relative meaning either — the k8s backend
  special-cases this one mount and uses an `emptyDir` volume instead of
  trying to express "shadow with /dev/null" as a subPath, since the intent
  (an empty read-only mount that shadows the file) is what matters, not the
  literal source path.

This is the honest constraint the task called out: **the orchestrator pod and
agent pods must share volume access** — either by being pinned to the same
node (hostPath) or by both mounting the same RWX-capable volume (PVC). There
is no way around this without changing the mount model to something
network-based (e.g. syncing over the IPC channel instead of sharing a
filesystem), which is a much larger change than this task scopes.

## Credential proxy reachability

Docker's `host.docker.internal:host-gateway` has no Kubernetes equivalent —
pods reach other pods by pod IP or Service DNS, not by a magic host alias.
Two things change when `CONTAINER_RUNTIME=kubernetes`:

1. **The proxy binds to `0.0.0.0`** (or, more precisely, whatever address the
   pod's network namespace presents — binding `0.0.0.0` inside a pod is safe
   in a way it isn't on a bare-metal Docker host, because the pod's network
   namespace is not the node's; nothing outside the namespace/Service reaches
   it unless a Service or NetworkPolicy exposes it). `src/container-runtime.ts`
   already has a `detectProxyBindHost()` seam for this — under
   `CONTAINER_RUNTIME=kubernetes` it now returns `0.0.0.0` unconditionally
   (still overridable via `CREDENTIAL_PROXY_HOST` for anyone who wants a
   NetworkPolicy-restricted address instead).

2. **The orchestrator learns its own pod IP via the downward API**
   (`K8S_POD_IP`, from `status.podIP`) and passes
   `ANTHROPIC_BASE_URL=http://<K8S_POD_IP>:<CREDENTIAL_PROXY_PORT>` to the
   agent pod as a literal env value in the overrides JSON — there is no
   `host.docker.internal`-style args helper needed on the k8s side because
   the value is computed once in Node (`process.env.K8S_POD_IP`) and baked
   into the pod spec, not passed as a CLI flag.

Deployment snippet (see `deploy/k8s/tenant-example/deployment.yaml` for the
full file):

```yaml
env:
  - name: K8S_POD_IP
    valueFrom:
      fieldRef:
        fieldPath: status.podIP
  - name: K8S_NODE_NAME
    valueFrom:
      fieldRef:
        fieldPath: spec.nodeName
  - name: CONTAINER_RUNTIME
    value: "kubernetes"
```

Pod IPs are ephemeral (they change if the orchestrator pod is rescheduled),
but that's fine here: the orchestrator reads its own `K8S_POD_IP` at process
start and stamps it into every agent pod spec it creates from then on, so
there's no stale-IP problem — a rescheduled orchestrator restarts with a
fresh `K8S_POD_IP` and every subsequent agent pod gets the current value.

## Namespace

`K8S_NAMESPACE` (env) selects the namespace `kubectl run`/`kubectl delete`
target. Default: whatever the current kubeconfig context's namespace is (i.e.
the flag is simply omitted and `kubectl` uses its configured default) — this
matches how Docker has no namespace concept at all, so an unset env var
should not force a specific namespace. In the tenant-per-namespace SaaS
model, each tenant's orchestrator Deployment sets `K8S_NAMESPACE` explicitly
(and its ServiceAccount/RBAC is scoped to only that namespace — see below).

## RBAC

The orchestrator needs a ServiceAccount, bound to a `Role` (namespaced, not
`ClusterRole` — a tenant orchestrator must never be able to touch another
tenant's namespace) granting exactly:

```yaml
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
```

`pods/attach` is required because `kubectl run --rm -i` attaches under the
hood. `pods/log` is a defense-in-depth extra (useful for debugging a stuck
pod via `kubectl logs`, not required for the core run loop, but cheap to
grant). No `exec` permission is needed or granted — the backend never execs
into a running pod. See `deploy/k8s/tenant-example/rbac.yaml`.

## Resource limits

The docker backend (being added in parallel — see `AGENT_CONTAINER_MEMORY` /
`AGENT_CONTAINER_CPUS` / `AGENT_CONTAINER_PIDS_LIMIT` env vars) maps onto pod
resources as:

| Env var | Docker flag | k8s pod field |
|---|---|---|
| `AGENT_CONTAINER_MEMORY` (e.g. `2g`) | `--memory 2g` | `resources.limits.memory: "2Gi"` (the backend converts `g`→`Gi`/`m`→`Mi` suffixes; Kubernetes quantity suffixes are binary, Docker's are usually treated as decimal-ish but commonly written the same way in practice — the conversion function documents this and is unit-tested) |
| `AGENT_CONTAINER_CPUS` (e.g. `2`) | `--cpus 2` | `resources.limits.cpu: "2"` (same value, k8s accepts bare core counts or millicpu `2000m` — the backend passes the value through unchanged) |
| `AGENT_CONTAINER_PIDS_LIMIT` | `--pids-limit` | **no effect** — logged once at startup as a warning; see "pids-limit has no Kubernetes equivalent" above |

`resources.requests` are set equal to `resources.limits` by default (no
separate "requests" env var in this task) — this is the simplest safe
default (Guaranteed QoS class) and can be revisited later if operators want
burstable scheduling.

## Timeout/kill parity

`container-runner.ts`'s `killOnTimeout()` currently calls
`stopContainer(name)` (docker) which the k8s backend's equivalent
(`deletePod(name)`, `kubectl delete pod <name> --grace-period=1 --now`)
plugs into via the same seam — `container-runtime.ts` re-exports a runtime-
selected `stopContainer` that dispatches to the docker or k8s implementation
based on `CONTAINER_RUNTIME`, so `container-runner.ts` itself needed no
changes to its timeout-handling code path.

## Orphan cleanup

Docker's `cleanupOrphans()` lists containers by name prefix
(`docker ps --filter name=nanoclaw-`). The k8s equivalent lists pods by label
selector (`kubectl get pods -l app=nanoclaw-agent -n <namespace> -o name`)
instead of name prefix, since pod names in the examples/tests use the same
`nanoclaw-<group>-<timestamp>` scheme but label selectors are the idiomatic
k8s way to scope a list query safely.

## Images: agent + orchestrator

Two images are published to GHCR by `.github/workflows/container.yml`
(linux/amd64, tagged `latest` + the commit SHA):

| Image | Dockerfile | Build context | Role |
|---|---|---|---|
| `ghcr.io/<owner>/nanoclaw-agent` | `container/Dockerfile` | `./container` | short-lived per-run sandbox (`CONTAINER_IMAGE`) |
| `ghcr.io/<owner>/nanoclaw-orchestrator` | `deploy/docker/Dockerfile.orchestrator` | repo root | long-lived per-tenant `node dist/index.js` process |

The **orchestrator** image is the one a tenant Deployment runs; the hosted
control plane references it as `TENANT_ORCHESTRATOR_IMAGE`. It bundles a pinned
`kubectl` (needed to spawn agent pods) plus the runtime assets the orchestrator
reads relative to its working directory (`container/skills/`,
`container/agent-runner/`, `scripts/`, `rules/`, `setup/`, `docs/`). It does
**not** bake any `profiles/<org>/` data — that comes from the tenant's PVC or
hostPath mount, selected by `LABOR_PROFILE`. Build it locally with:

```bash
docker build -f deploy/docker/Dockerfile.orchestrator -t nanoclaw-orchestrator:latest .
```

## Self-host-on-Kubernetes quickstart

This walks through a **single-node** cluster (k3s, kind, minikube, or a
single-VM cluster) using `K8S_VOLUME_MODE=hostPath` — the simplest mode, and
the one that matches "one org, one droplet" self-hosting most closely.

For a fully-scripted, self-contained single-node run on kind (build both images,
seed a minimal tenant, deploy, and assert the whole spawn→proxy→metering→cleanup
loop), see `deploy/k8s/smoke-test.sh` — it is the executable version of this
quickstart.

1. **Build and push both images** (or use GHCR as the existing droplet deploy
   already does):
   ```bash
   ./container/build.sh
   docker tag nanoclaw-agent:latest <registry>/<you>/nanoclaw-agent:latest
   docker push <registry>/<you>/nanoclaw-agent:latest

   docker build -f deploy/docker/Dockerfile.orchestrator -t nanoclaw-orchestrator:latest .
   docker tag nanoclaw-orchestrator:latest <registry>/<you>/nanoclaw-orchestrator:latest
   docker push <registry>/<you>/nanoclaw-orchestrator:latest
   ```

2. **Prepare the host paths.** Since `K8S_VOLUME_MODE=hostPath` pins agent
   pods to the orchestrator's node, put the profile dir somewhere on that
   node's disk — same layout as running directly on a VM (`profiles/<org>/`).

3. **Apply the example manifests** (`deploy/k8s/tenant-example/`):
   ```bash
   kubectl apply -f deploy/k8s/tenant-example/namespace.yaml
   kubectl apply -f deploy/k8s/tenant-example/rbac.yaml
   kubectl apply -f deploy/k8s/tenant-example/pvc.yaml   # only if using pvc mode
   kubectl apply -f deploy/k8s/tenant-example/deployment.yaml
   ```
   Edit `deployment.yaml` first: set the image, `PROFILE_DIR`/mount hostPaths
   (or PVC name), `K8S_NAMESPACE`, and secrets (`ANTHROPIC_API_KEY` etc. —
   still via whatever secret mechanism the orchestrator already reads from
   `.env`/OneCLI; this doc does not change credential sourcing, only container
   spawning).

4. **Verify:**
   ```bash
   kubectl -n nanoclaw-tenant-example get pods -w
   kubectl -n nanoclaw-tenant-example logs deploy/nanoclaw-orchestrator
   ```
   Send a message through whatever channel is configured; watch for a
   `nanoclaw-<group>-<ts>` pod to appear and disappear.

5. **Multi-node / hosted SaaS**: switch `K8S_VOLUME_MODE=pvc`, provision an
   RWX-capable StorageClass, and point both the orchestrator Deployment and
   `K8S_DATA_PVC_NAME` at the same claim. Each tenant gets its own namespace,
   its own PVC, its own orchestrator Deployment, and its own scoped RBAC
   Role — the manifests in `deploy/k8s/tenant-example/` are templated per
   tenant by whatever provisioning tooling creates new tenants (out of scope
   here; this repo ships the primitives, not the provisioner).

## What this doc does not cover (and why)

- **Ingress / TLS for channel webhooks** (Slack Events API, Discord
  interactions, etc.) — orthogonal to container runtime; whatever ingress
  strategy a cluster uses today applies unchanged.
- **Multi-tenant provisioning automation** (the thing that creates a new
  namespace + PVC + Deployment + RBAC per signup) — that's product/control-
  plane work on top of these primitives, not part of the container-runtime
  abstraction this task adds.
- **Autoscaling agent pod concurrency** — `MAX_CONCURRENT_CONTAINERS` already
  caps how many runs the orchestrator starts at once; nothing about k8s
  changes that logic, since concurrency is enforced in the orchestrator
  process, not by the runtime backend.
