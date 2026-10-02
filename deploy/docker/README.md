# Plain-Docker deployment

Run labor.fun from the published images with a compose file and an `.env` — no
host build, no systemd units. Suits a single VPS, run by hand or by a
container-management UI.

Other shapes: [`setup/DEPLOY-INFRA.md`](../../setup/DEPLOY-INFRA.md) for the
systemd + auto-deploy host (the reference production path),
[`deploy/tee/`](../tee/) for a confidential VM, and
[`docs/KUBERNETES.md`](../../docs/KUBERNETES.md) for pod-per-run.

## What the host must provide

The orchestrator spawns **one sibling container per agent turn** through the
host's docker socket. That is the whole reason this cannot run on a PaaS such
as Fly, Railway, Render, or Heroku: those sandbox your container with no socket
to spawn from, so the orchestrator starts cleanly and then fails every turn.

- **Docker** with a reachable `/var/run/docker.sock`
- **linux/amd64** — CI publishes amd64 images only
- **~8 GB RAM.** The agent image carries Chromium, and a container stays warm
  per active group for `IDLE_TIMEOUT` (30 min default), so they stack. 4 GB is
  the floor for a single group.
- **~40 GB disk** — agent image, orchestrator image, volumes, backups

## Quickstart

```bash
cp deploy/docker/.env.example deploy/docker/.env
$EDITOR deploy/docker/.env          # LABOR_PROFILE, credential, channel tokens
```

Seed your org profile into the volume — it is deliberately **not** baked into
the image, and the orchestrator exits if it is missing:

```bash
docker volume create labor_labor-profiles
docker run --rm -v labor_labor-profiles:/dst -v "$PWD/profiles:/src:ro" \
  alpine:3.20 cp -a /src/<your-org> /dst/
```

Start it:

```bash
docker compose -f deploy/docker/docker-compose.yaml up -d
docker compose -f deploy/docker/docker-compose.yaml logs -f orchestrator
```

Add `--profile kb` to also run the KB dashboard on `127.0.0.1:8080`.

Pre-pulling the agent image (`docker pull "$AGENT_IMAGE"`) keeps the first
agent turn from timing out while several GB download.

## Behind a container-management UI

A UI that deploys this compose file for you changes a few things compared with
a plain `docker compose up`.

**Environment.** A variable set in the UI reaches the orchestrator's environment
only if this compose file references it as `${VAR}`. Everything else, including
the model credential and channel tokens, is read from `.env`. The compose
mounts its own directory read-only at `/app/host-config` and links `/app/.env`
to the `.env` there, which is where a UI writes the variables you set. It
mounts the directory rather than the file because the UI only writes `.env` at
deploy time: a file mount's source wouldn't exist yet when the UI parses the
compose, and it would pre-create it as a directory. After the first deploy,
confirm the link resolved:

```bash
docker exec <orchestrator-container> grep -c = /app/.env
```

**Names.** UIs commonly prefix volume names and may rename containers. Seed the
profile into the volume names the UI actually creates (`docker volume ls`), not
`labor_labor-profiles`. If the orchestrator's container name differs from
`labor-orchestrator`, set `DOCKER_SELF_CONTAINER` to it.

**Host access.** Two steps still happen on the host over SSH: seeding the
profile volume (above) and, if you use the KB dashboard, writing
`profiles/<LABOR_PROFILE>/kb-users.json`.

**Shared daemon.** A UI that manages this host's Docker daemon also sees, and
can stop, the agent containers this stack spawns. They share one socket by
design.

## Verifying

```bash
# The orchestrator can see its own mount table (sibling translation works)
docker exec labor-orchestrator docker inspect labor-orchestrator --format '{{len .Mounts}}'

# An agent turn actually spawns a container
docker compose -f deploy/docker/docker-compose.yaml logs orchestrator | grep -i 'credential proxy'
docker ps --filter name=nanoclaw-
```

A `docker-sibling: self mount table empty` or `failed to inspect self container`
warning in the logs means agent mounts are **not** being translated — the agent
will get paths that exist only inside the orchestrator. Check that
`DOCKER_SELF_CONTAINER` matches the running container's name.

If agent turns fail to reach Anthropic, the credential proxy is not reachable at
the bridge gateway. Compare `CREDENTIAL_PROXY_BIND_IP` against:

```bash
docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}'
```

## State and backups

Everything durable lives in one named volume, `labor-profiles`: identity, KB,
per-group memory, and the profile's `store/` (SQLite) and `data/` (sessions,
IPC). Nothing in this compose backs it up. Don't tar the live database: the
orchestrator can write between any checkpoint and the copy. `VACUUM INTO` takes
a consistent snapshot from a read transaction while it keeps running:

```bash
P=<your-org>   # your LABOR_PROFILE
STAMP=$(date -u +%Y%m%d-%H%M%S)
# The orchestrator image ships the better-sqlite3 binding, not the sqlite3 CLI.
docker run --rm -v labor_labor-profiles:/p -v "$PWD:/out" alpine:3.20 \
  sh -c "apk add -q sqlite && sqlite3 /p/$P/store/messages.db \"VACUUM INTO '/out/messages-$STAMP.db'\""
docker run --rm -v labor_labor-profiles:/p -v "$PWD:/out" alpine:3.20 \
  tar czf /out/labor-backup-$STAMP.tar.gz -C / p out/messages-$STAMP.db
```

The archive also holds the live `messages.db`, which may be mid-write. Restore
from the snapshot instead: copy it to `<your-org>/store/messages.db` in the
volume.

### Upgrading from three volumes

Earlier versions of this compose mounted separate `labor-store` and `labor-data`
volumes over the profile's `store/` and `data/`. This version doesn't mount
them, so after upgrading the orchestrator would open the profile volume's own,
empty `store/`, and start on a fresh database without an error. Copy them in
first:

```bash
P=<your-org>   # your LABOR_PROFILE
docker compose -f deploy/docker/docker-compose.yaml down
docker run --rm -v labor_labor-profiles:/p -v labor_labor-store:/s \
  -v labor_labor-data:/d alpine:3.20 sh -c \
  "mkdir -p /p/$P/store /p/$P/data && cp -a /s/. /p/$P/store/ && cp -a /d/. /p/$P/data/"
```

Keep the old volumes until the upgraded deploy has run cleanly.

## Updating

```bash
docker compose -f deploy/docker/docker-compose.yaml pull
docker compose -f deploy/docker/docker-compose.yaml up -d
```

Volumes are untouched by a pull. Pin `ORCHESTRATOR_IMAGE` / `AGENT_IMAGE` to a
`:<sha>` tag if you would rather choose when the code moves.
