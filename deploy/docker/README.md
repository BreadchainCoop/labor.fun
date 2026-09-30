# Plain-Docker deployment

Run labor.fun from the published images with a compose file and an `.env` — no
host build, no systemd units. Suits a single VPS, and works behind a
container-management UI such as Coolify, Dokploy, or Portainer.

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

## Coolify / Dokploy

Create a **Docker Compose** resource pointing at
`deploy/docker/docker-compose.yaml`, then paste the `.env.example` keys into the
UI's environment editor. A UI variable reaches the orchestrator's environment
only if this compose file references it as `${VAR}`; everything else — the
Anthropic credential and channel tokens included — is read from the mounted
`.env`. After the first deploy, confirm it resolved to a file:

```bash
docker exec <orchestrator-container> grep -c = /app/.env
```

Coolify rewrites names. Named volumes become `<uuid>_<name>`, so seed the
profile into the names shown under *Configuration → Persistent Storage* rather
than `labor_labor-profiles`. If the orchestrator's container name differs from
`labor-orchestrator`, set `DOCKER_SELF_CONTAINER` to it.

Two things still have to happen on the host over SSH: seeding the profile
volume (above) and, if you use the KB dashboard, writing
`profiles/<LABOR_PROFILE>/kb-users.json`.

Give Coolify its own server, or at least expect it to manage the docker daemon
this stack also uses — they share one socket by design.

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

Everything durable lives in three named volumes — `labor-profiles` (identity, KB,
per-group memory), `labor-store` (SQLite), `labor-data` (sessions, IPC). Nothing
in this compose backs them up. Checkpoint the DB before copying it, or the
tarball can catch a torn write:

```bash
# The orchestrator image ships the better-sqlite3 binding, not the sqlite3 CLI.
docker run --rm -v labor_labor-store:/s alpine:3.20 \
  sh -c 'apk add -q sqlite && sqlite3 /s/messages.db "PRAGMA wal_checkpoint(TRUNCATE);"'
docker run --rm -v labor_labor-profiles:/p -v labor_labor-store:/s -v labor_labor-data:/d \
  -v "$PWD:/out" alpine:3.20 tar czf /out/labor-backup-$(date -u +%Y%m%d).tar.gz /p /s /d
```

## Updating

```bash
docker compose -f deploy/docker/docker-compose.yaml pull
docker compose -f deploy/docker/docker-compose.yaml up -d
```

Volumes are untouched by a pull. Pin `ORCHESTRATOR_IMAGE` / `AGENT_IMAGE` to a
`:<sha>` tag if you would rather choose when the code moves.
