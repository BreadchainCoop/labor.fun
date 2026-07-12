# labor.fun — TEE deployment mode (dstack / Phala Intel-TDX)

Run the **entire** labor.fun stack inside a single [dstack](https://github.com/Dstack-TEE/dstack)
Confidential VM (CVM) on Intel TDX, hosted on [Phala Cloud](https://phala.com).
Signal end-to-end encryption terminates **inside** the enclave, inference is
proxied to **NEAR AI**, and users can cryptographically verify the running code
with `!verify <nonce>`.

> Deep dive on the architecture, threat model, secret provisioning, and
> Signal secondary-device linking: [`docs/TEE.md`](../../docs/TEE.md).

## What runs in the CVM

| Service | Role | Ports |
|---|---|---|
| `docker-cli-fetch` | init container: fetches + sha256-verifies the static docker CLI onto a shared volume (the orchestrator image ships none), then exits | none |
| `orchestrator` | labor.fun (`node dist/index.js`); runs as **root** and installs the fetched docker CLI on boot; Signal channel + `!verify`; spawns agent containers | none |
| `signal-cli` | signal-cli daemon in **TCP JSON-RPC** mode (`--tcp=0.0.0.0:7583`) — the E2E endpoint; **self-links** on first boot (see step 4) | none |
| *agent* | short-lived per-turn sandbox, spawned by the orchestrator via `docker.sock` | none |
| NEAR AI | **remote** inference API (no local container) | egress only |

No service publishes a host port. The enclave's only ingress is Signal (E2E);
its only egress is the NEAR AI HTTPS API.

## Prerequisites

- A Phala Cloud account and the `phala` CLI (`npm i -g phala`), **or** a
  self-hosted dstack KMS + gateway.
- Docker Buildx to build **linux/amd64** images (Intel TDX runs amd64).
- The platform's Signal number, already registered, with a free device slot to
  link (the TEE joins as a **secondary device** — see `docs/TEE.md`).

## Quickstart

### 1. Build & push images (linux/amd64), then pin digests

```bash
# Orchestrator (build context = repo root)
docker buildx build --platform linux/amd64 \
  -f deploy/docker/Dockerfile.orchestrator \
  -t YOUR_REGISTRY/labor-orchestrator:tee --push .

# Agent (build context = ./container)
docker buildx build --platform linux/amd64 \
  -f container/Dockerfile \
  -t YOUR_REGISTRY/labor-agent:tee --push ./container

# Resolve immutable digests
docker inspect --format='{{index .RepoDigests 0}}' YOUR_REGISTRY/labor-orchestrator:tee
docker inspect --format='{{index .RepoDigests 0}}' YOUR_REGISTRY/labor-agent:tee
```

Put the **orchestrator** digest into `docker-compose.tee.yaml` (`orchestrator.image`)
— that line is measured into `compose_hash`. Put the **agent** digest into
`.env.tee` (`AGENT_IMAGE`) and record it in `docs/TEE.md` for out-of-band
verification (the agent digest is not part of `compose_hash`; see the compose
header for why).

Also pin the `signal-cli` image digest in `docker-compose.tee.yaml`.

### 2. Configure secrets

```bash
cp deploy/tee/.env.tee.example deploy/tee/.env.tee
$EDITOR deploy/tee/.env.tee   # LABOR_PROFILE, SIGNAL_ACCOUNT, NEAR_AI_*, AGENT_IMAGE
```

`.env.tee` is provisioned to the CVM as an **encrypted environment** by dstack
**after** attestation validates — secrets never enter `compose_hash`.

### 3. Deploy the CVM

```bash
phala deploy \
  -c deploy/tee/docker-compose.tee.yaml \
  -e deploy/tee/.env.tee \
  -t tdx.medium \
  --wait
```

(Self-hosted dstack: `dstack deploy -c deploy/tee/docker-compose.tee.yaml`.)

### 4. Link Signal as a secondary device

A production CVM has **no public ports and no shell** (SSH needs `--dev-os`,
which weakens attestation), so you can't `docker exec` into it. Instead the
`signal-cli` service **self-links on first boot**: when `signal-data` has no
`accounts.json` yet, its entrypoint runs `signal-cli link` and prints the
device-link URI to the container logs, wrapped in delimiter lines:

```
===LINK URI BELOW===
sgnl://linkdevice?uuid=...&pub_key=...
===LINK URI ABOVE===
```

Read the newest URI from the logs (this needs public logs — deploy with
`phala deploy ... --public-logs`, or enable it on a running CVM with
`phala deploy --public-logs`):

```bash
phala logs labor-signal-cli   # scrape the latest ===LINK URI BELOW=== block
```

Then approve that URI from the platform's **primary** Signal device (held by
the CP gateway). `signal-cli link` blocks until approval, so the container stays
alive (unhealthy, not exited) for the whole window — the generous healthcheck
`start_period` keeps it from flapping, and each restart regenerates a fresh URI.
Full flow — including the split-brain rule for which side handles which groups —
is in `docs/TEE.md` ("Signal device linking").

Once approved, keys land on the encrypted `signal-data` volume, sealed to this
CVM. **Note:** any compose change re-measures the app and resets the
`signal-data` volume, so you'll need to re-link after an upgrade (see below).

### 5. Verify from any Signal chat

Send `!verify <nonce>` (nonce = 8–64 url-safe chars) to the bot. It replies with
a fresh Intel-TDX quote binding your nonce, the `compose_hash`, and a
[proof.phala.network](https://proof.phala.network) verification link. Confirm
`compose_hash` matches this published `docker-compose.tee.yaml`. See
`docs/TEE.md` for the full verification walkthrough.

## Files

| File | Purpose |
|---|---|
| `docker-compose.tee.yaml` | The measured CVM stack (orchestrator + signal-cli) |
| `.env.tee.example` | Copy-me secrets/config template |
| `README.md` | This quickstart |

## Upgrades = re-attest + re-provision

Any image or compose change re-measures the app (new `compose_hash`), so the
dstack KMS re-provisions secrets only after the **new** measurement validates.
`!verify` will report the new `compose_hash`; users should re-check it against
the updated published compose. Operational limits (single CVM, no HA) are
covered in `docs/TEE.md`.
