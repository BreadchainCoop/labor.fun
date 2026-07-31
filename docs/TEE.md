# TEE deployment mode (dstack / Phala Intel-TDX)

This document describes the `TEE_MODE` deployment: running the **entire**
labor.fun stack for an org inside a single [dstack](https://github.com/Dstack-TEE/dstack)
Confidential VM (CVM) on Intel TDX (hosted on [Phala Cloud](https://phala.com),
or self-hosted with your own dstack KMS + gateway).

Unlike hosted-Kubernetes mode — where a tenant's orchestrator runs on shared
infra and its plaintext messages transit the control-plane ingress — TEE mode
terminates Signal's end-to-end encryption **inside the enclave**, keeps org
state on **encrypted volumes** sealed to the CVM measurement, proxies inference
to **NEAR AI** (which itself runs in a GPU TEE), and lets any user
cryptographically verify the running code with `!verify <nonce>`.

The deploy artifacts live in [`deploy/tee/`](../deploy/tee/) (compose stack,
`.env.tee.example`, quickstart README). This doc is the design + runbook behind
them.

- Signal channel + `!verify`: [`src/channels/signal.ts`](../src/channels/signal.ts)
- Attestation client: [`src/tee-attest.ts`](../src/tee-attest.ts)
- Agent spawner (sibling containers): [`src/container-runner.ts`](../src/container-runner.ts)
- Credential injection: [`src/credential-proxy.ts`](../src/credential-proxy.ts)

---

## 1. Architecture

Everything an org needs runs in one CVM. No service publishes a host port; the
only ingress is Signal (E2E), the only egress is the NEAR AI inference API.

```
                        Intel TDX Confidential VM (dstack CVM)
   ┌──────────────────────────────────────────────────────────────────────┐
   │                                                                        │
   │   ┌──────────────┐        signal-cli JSON-RPC (TCP 7583)               │
   │   │  signal-cli  │◀───────────────────────────────┐                   │
   │   │   daemon     │   E2E keys on encrypted vol     │                   │
   │   │ (--tcp mode) │                                 │                   │
   │   └──────┬───────┘                          ┌──────┴────────────┐      │
   │          │ Signal E2E terminates here       │   orchestrator    │      │
   │          │                                  │ (node dist/index) │      │
   │          ▼                                  │  - Signal channel │      │
   │   Signal secondary device                   │  - !verify        │      │
   │   (linked to platform's                     │  - spawns agents  │      │
   │    ONE Signal account)                      └───┬───────────┬───┘      │
   │                                                 │           │          │
   │                        docker.sock (sibling run)│           │ RO       │
   │                                                 ▼           ▼          │
   │                                        ┌────────────────┐ ┌──────────┐ │
   │                                        │ agent container│ │ dstack   │ │
   │                                        │ (per turn,     │ │  .sock   │ │
   │                                        │  Claude Agent  │ │ (guest   │ │
   │                                        │  SDK sandbox)  │ │  API)    │ │
   │                                        └───────┬────────┘ └────┬─────┘ │
   │                                                │               │       │
   │   Encrypted volumes (sealed to CVM measurement)│    GetQuote / GetKey  │
   │   ┌──────────┬──────────┬──────────┬──────────┐│    / Info             │
   │   │ profiles │  store   │   data   │ signal-  ││                       │
   │   │  (KB,    │ (SQLite  │(sessions,│  data    ││                       │
   │   │  memory) │  msgs)   │  IPC)    │ (keys)   ││                       │
   │   └──────────┴──────────┴──────────┴──────────┘│                       │
   └───────────────────────────────────┼────────────┼──────────────────────┘
                                        │            │
                     inference (HTTPS)  ▼            │ verifiable via
                            ┌────────────────────┐   │ proof.phala.network
                            │      NEAR AI        │   │ (compose_hash +
                            │  (remote GPU TEE)   │   │  report_data = nonce)
                            └────────────────────┘   ▼
                                                  end user
```

**Components**

| Component | What it is | Trust boundary |
|---|---|---|
| `orchestrator` | `node dist/index.js`; registers the Signal channel, answers `!verify`, spawns agent containers via `docker.sock` | inside CVM |
| `signal-cli` | signal-cli daemon in **TCP JSON-RPC** mode (`--tcp=0.0.0.0:7583`) — Signal E2E terminates here | inside CVM |
| agent container | short-lived per-turn Claude Agent SDK sandbox, spawned as a **sibling** (not nested) inside the same CVM | inside CVM |
| dstack guest socket | `/var/run/dstack.sock` — quote generation + KMS key derivation | CVM ↔ host TDX module |
| encrypted volumes | `profiles/`, `store`, `data`, `signal-data` — sealed to the CVM measurement | at-rest, host cannot read |
| NEAR AI | remote inference API (GPU TEE); the only egress besides Signal | separate enclave |

**Why signal-cli in TCP JSON-RPC mode (not the REST image):**
`src/channels/signal.ts` connects with Node's `net` module to a signal-cli
daemon over newline-delimited JSON-RPC on a TCP socket (default `127.0.0.1:7583`),
writing `send`/`sendReaction`/`sendTyping` requests and reading `receive`
notifications on the same socket. That is exactly the surface
`signal-cli -a "$SIGNAL_ACCOUNT" daemon --tcp 0.0.0.0:7583` provides — **not**
the `bbernhard/signal-cli-rest-api` HTTP API. The channel speaks native
JSON-RPC, so TEE mode runs signal-cli directly.

**Why sibling containers (docker.sock), not nested:**
The orchestrator mounts the CVM's `docker.sock` and runs each agent turn with
`docker run` against the **same** dockerd the dstack runtime uses. The agent
therefore executes inside the CVM's measured boundary, next to the orchestrator
rather than nested inside it. See `src/container-runner.ts`.

---

## 2. Attestation and the dstack guest API

The dstack guest agent exposes an HTTP API over `/var/run/dstack.sock` (host is
ignored; we use `http://dstack`). `src/tee-attest.ts` uses two endpoints:

| Method + path | Request | Response fields we use |
|---|---|---|
| `GET /Info` | — | `app_id`, `instance_id`, `compose_hash` |
| `POST /GetQuote` | `{ "report_data": "<hex, ≤64 bytes>" }` | `quote` (hex TDX quote), `report_data` |

(The full API also offers `POST /GetKey`, `POST /GetTlsKey`, `POST /Sign`,
`POST /EmitEvent` — we use `GetKey` for the secret model below.)

**report_data binding.** `report_data` is limited to 64 bytes. `!verify`'s
nonce is 8–64 url-safe chars, so it is embedded **verbatim** (the verifier
recovers it with `echo -n '<nonce>' | xxd -p`). Any over-64-byte value is
reduced with **SHA-512/256** to a 32-byte digest (verify with
`openssl dgst -sha512-256`). This is the freshness proof: the quote could only
have been generated after the user supplied their nonce.

---

## 3. The `!verify` UX

Send `!verify <nonce>` in any chat the bot is registered in (nonce = 8–64
url-safe chars, `[A-Za-z0-9_-]`). Gating: the command is only intercepted when
`TEE_MODE=true`; even then `src/tee-attest.ts` checks the dstack socket exists
before attesting, so a misconfigured flag on a non-TEE host replies honestly
("not running in a TEE") instead of crashing.

The reply contains:

1. **Nonce echo** — confirms which challenge was bound.
2. **Report data (hex)** — the exact bytes embedded in the quote, with the
   command to reproduce them.
3. **TEE info** — `app_id`, `instance_id`, and **`compose_hash`**.
4. **TDX quote (hex)** — chunked at 64 chars for readability on Signal.
5. **Verification steps** — paste the quote at
   [proof.phala.network](https://proof.phala.network), confirm `report_data`
   matches the nonce hex, and confirm `compose_hash` matches the published
   [`deploy/tee/docker-compose.tee.yaml`](../deploy/tee/docker-compose.tee.yaml).

What this proves to the user:

- **Freshness** — the quote embeds *their* nonce, so it was generated now.
- **Genuine TDX hardware** — Intel signs the quote; proof.phala.network checks it.
- **Exact code** — `compose_hash` binds the running compose document; comparing
  it to the published file proves the code is what was published.

The NEAR AI inference leg is attested **separately** (NEAR AI publishes its own
GPU-TEE attestation); this covers the labor.fun stack up to the inference call.

---

## 4. Secret model — KMS provisioning after attestation

Secrets are **never** baked into the image or the compose document (which is why
`compose_hash` can be public — it contains no secrets). Instead:

```
  1. CVM boots → dstack measures the image(s) + compose → produces a TDX quote.
  2. dstack KMS validates that measurement against the app's allowed policy.
  3. ONLY on a valid measurement, the KMS releases:
       (a) the encryption keys for the profiles/store/data/signal-data volumes
           (so the disks decrypt — a wrong/tampered image gets garbage), and
       (b) the encrypted environment (.env.tee: SIGNAL_ACCOUNT, NEAR_AI_*, the
           agent image ref, etc.), provisioned into the orchestrator's env.
  4. The orchestrator's credential-proxy (src/credential-proxy.ts) injects the
     inference credential into agent turns; the agent never sees raw secrets.
```

`.env.tee` is provided to the dstack CLI at deploy time and stored as an
**encrypted environment**; it is delivered to the CVM only after step 2. So a
malicious host operator who swaps the image gets a **different measurement**,
the KMS refuses to release keys, the encrypted volumes stay opaque, and the
secrets never arrive — the tampered stack simply cannot start with real data.

**Deterministic in-enclave keys (optional).** For keys the app derives itself
(e.g. a signing key bound to the app identity), dstack's `POST /GetKey`
(`{ path, purpose }`) returns a deterministic key bound to `app_id`: the same
path yields the same key for this app across restarts, and a different app can
never derive it. This is available to future features that need an
enclave-sealed key without an external secret.

### Re-seal on upgrade — why every image change re-measures

The measurement covers the **image digests** and the **compose document**.
Changing either — a new orchestrator image, a new agent image, an edited
compose line — produces a **new** `compose_hash`/measurement. Consequences:

- The KMS re-evaluates the new measurement against policy before releasing keys
  and the encrypted env again (secrets are **re-sealed** to the new measurement).
- `!verify` will report the **new** `compose_hash`; users should re-check it
  against the updated published compose. A published upgrade is therefore
  publicly visible and verifiable.
- This is why `deploy/tee/docker-compose.tee.yaml` pins every image by
  `@sha256` digest: a floating `:latest` would let the host swap code **without**
  changing `compose_hash`, defeating the attestation. (The per-turn agent image
  is referenced from `.env.tee` and is **not** part of `compose_hash`; pin it by
  digest and record it here for out-of-band verification — see below.)

**Agent image digest (record here on each release):**

```
labor-orchestrator  @sha256:REPLACE_ON_RELEASE   (measured in compose_hash)
labor-agent         @sha256:REPLACE_ON_RELEASE   (referenced from .env.tee)
signal-cli          @sha256:REPLACE_ON_RELEASE   (measured in compose_hash)
```

---

## 5. Signal: secondary-device linking and the split-brain rule

labor.fun as a platform holds **one** Signal account (the shared number).
Signal supports **linked (secondary) devices** — up to a small fixed number all
sharing that identity. TEE mode links the CVM as **one such secondary device**;
it does **not** register a new number.

**Who holds what:**

- The **primary** device is held by the platform's CP gateway (the shared,
  hosted-mode ingress).
- The **TEE** links as a **secondary device**, sharing the same Signal identity.

**Linking flow** (documented for the runbook — actual commands in
`deploy/tee/README.md`):

1. From inside the running `signal-cli` container, generate a device-link URI:
   `signal-cli link -n "labor.fun TEE (<profile>)"` → prints an
   `sgnl://linkdevice?...` URI (a QR payload).
2. Approve it from the **primary** device (Signal → Settings → Linked Devices →
   scan / paste), the same way you'd link Signal Desktop.
3. signal-cli completes the exchange and writes the secondary-device keys onto
   the encrypted `signal-data` volume — sealed to this CVM. The keys never exist
   in plaintext at rest and never leave the enclave.

### The split-brain rule (which side answers which groups)

Because both the CP gateway (primary) and the TEE (secondary) receive **the
same** inbound Signal envelopes for the shared account, exactly one side must
act on any given group, or a message gets two replies.

**Rule: each side acts ONLY on the groups/DMs belonging to ITS orgs.**

- Both sides key on the registered-group set (`registeredGroups()` in
  `src/channels/signal.ts`): an inbound message for a chat that side has **not**
  registered is ignored (the channel already drops unregistered chats — see the
  "Message from unregistered Signal chat" path).
- A **TEE-mode org's** groups are registered **only** in that org's TEE CVM, so
  only the TEE acts on them (and its replies come from inside the enclave).
- A **hosted-mode org's** groups are registered **only** on the CP gateway, so
  only the gateway acts on them.
- The two registration sets are **disjoint by construction** (a group belongs to
  exactly one org, and each org runs in exactly one mode), so no message is ever
  double-handled. `!verify` is answered by whichever side owns the group — for a
  TEE org, that's the enclave, which is the point.

Operationally: never register the same Signal group on both a TEE CVM and the
CP gateway. Onboarding an org into TEE mode means moving its group registrations
out of the shared gateway and into its CVM's profile.

---

## 6. What is and isn't protected

| Concern | TEE-mode org | Hosted-mode org |
|---|---|---|
| Signal transport | E2E, terminates inside the enclave | E2E, terminates at the shared gateway |
| Messages in memory during a turn | inside the CVM only | on shared infra |
| Org memory / KB / SQLite at rest | encrypted, sealed to CVM measurement | on shared/tenant storage |
| Inference | NEAR AI GPU TEE (separately attested) | provider-dependent |
| Host operator can read plaintext? | **No** (sealed volumes + injected secrets) | Depends on hosting trust |
| User can verify the running code? | **Yes** (`!verify` → compose_hash) | No hardware attestation |

**Explicitly NOT protected, even in TEE mode:**

- **What leaves the enclave by design.** The NEAR AI inference request carries
  the prompt to NEAR AI's enclave; trust there rests on NEAR AI's own GPU-TEE
  attestation, not this one. Anything the user asks the agent to send outward
  (a GitHub comment, an email) leaves the enclave by intent.
- **Hosted-mode orgs' messages.** Only TEE-mode orgs get enclave protection.
  Orgs on the shared gateway are unchanged — their messages exit the enclave
  boundary (they were never inside it).
- **Endpoint security.** `!verify` proves the *server* runs the published code
  in genuine TDX; it says nothing about the user's own device.
- **Metadata.** Signal already minimizes metadata, but the fact that traffic
  and NEAR AI egress exist is observable to the host at the network level (not
  the plaintext).

---

## 7. Operational limits

TEE mode trades scale-out for verifiability. Known constraints:

- **Single CVM, no HA.** One org = one CVM. There is no multi-node failover or
  horizontal scaling; a CVM restart is a brief outage. (This mirrors the
  single-orchestrator model of `src/index.ts` — TEE mode adds sealing, not a
  cluster.) Sizing is via the dstack instance type (e.g. `tdx.medium`).
- **Upgrade = re-attest + re-provision.** Any image or compose change
  re-measures the app; the KMS re-releases keys/secrets only after the new
  measurement validates (§4). Expect a short restart and a **new** `compose_hash`
  that users should re-verify. Publish the new digests (§4 table).
- **Volumes are sealed to the measurement.** A drastic change that fails the KMS
  policy can leave volumes undecryptable until policy is updated to allow the
  new measurement — treat measurement-policy changes with the same care as key
  rotation.
- **One Signal device slot consumed.** The CVM occupies one of the shared
  account's linked-device slots. Re-linking after a full CVM rebuild consumes a
  slot again; prune stale linked devices from the primary.
- **agent image not in compose_hash.** The per-turn agent image is referenced
  from `.env.tee`, so its digest is not covered by `compose_hash`. Pin it by
  digest and verify it out-of-band (§4) — otherwise a swapped agent image would
  not show up in `!verify`.
- **No inbound admin port.** With no public ports, all operator actions go
  through `docker exec` into the CVM (e.g. Signal linking) or the dstack/phala
  control surface — there is no KB dashboard exposed from a TEE CVM.

---

## 8. Privacy posture: ephemeral mode & retention (toggle)

By default labor.fun **persists everything**: `messages.db` is both the chat
history and the queue that drives the agent poller, and TEE mode seals it to
encrypted disks. For orgs that want sigstack-bot-style data retention —
conversations living in TEE-protected **memory only**, bounded to roughly the
last ~50 messages / 24 hours, total loss on restart — the framework offers an
**opt-in toggle with two independent layers**. Nothing changes unless you turn
them on.

### Layer 1 — retention sweeper (any deployment mode, env-gated)

Two env vars, both defaulting to `0` = **off** = today's keep-everything
behavior, byte-identical:

| Env var | Meaning | Recommended (sigstack-parity) |
|---|---|---|
| `MESSAGE_RETENTION_HOURS` | delete stored messages older than N hours | `24` |
| `MESSAGE_RETENTION_MAX_PER_CHAT` | keep only the newest N messages per chat | `200` |

When either is set, an hourly sweeper ([`src/retention.ts`](../src/retention.ts))
deletes expired/overflow rows from the SQLite `messages` table. The message
**queue mechanism is untouched** — the sweeper never deletes a message the
agent poller hasn't processed yet (it honors each chat's processed watermark,
an in-process floor for runs currently dispatched — whose cursor can still be
rolled back for retry — plus an absolute "never touch the last hour" floor; see
the module header for the exact composite guard). Works identically on a
droplet, in Kubernetes, or in a TEE.

`MESSAGE_RETENTION_HOURS` additionally age-prunes the two other
content-bearing tables, so message text can't survive as a copy:
`agent_runs.trigger_content` (up to 500 chars of each run's trigger message)
and `assistant_events.question_text` (the analytics question text, subject to
`ASSISTANT_ANALYTICS_PRIVACY`). Both are post-dispatch records — nothing reads
them back for delivery — so they get the age rule and the 1-hour floor, but no
watermark guard. `MESSAGE_RETENTION_MAX_PER_CHAT` is a `messages`-only rule; if
you care about bounding the analytics tables, set the hours knob.

**Honest limitation — a never-triggered group retains everything.** The
watermark guard is deliberately fail-safe: a *registered* chat with no
processed watermark (no `last_agent_timestamp` cursor and no bot reply yet) is
skipped entirely, because every row in it might still be owed to the agent. In
practice that means a trigger-mode group where the assistant has never been
triggered accumulates messages **indefinitely**, no matter how low
`MESSAGE_RETENTION_HOURS` is set — retention starts applying to that chat only
once the agent has processed something in it. There is intentionally no
override to force-delete unprocessed backlog: losing messages the agent still
owes a response to is the worse failure. If you need a hard guarantee for such
groups, use the ephemeral compose variant below (restart wipes everything) or
don't register the group at all.

### Layer 2 — ephemeral compose variant (TEE only, chosen at deploy time)

The privacy mode is selected by **which compose you deploy**:

| Compose file | Posture |
|---|---|
| [`deploy/tee/docker-compose.tee.yaml`](../deploy/tee/docker-compose.tee.yaml) | default — org state on encrypted **persistent** disks |
| [`deploy/tee/docker-compose.tee-ephemeral.yaml`](../deploy/tee/docker-compose.tee-ephemeral.yaml) | opt-in — content-bearing state on **tmpfs (RAM only)** |

In the ephemeral variant the three content-bearing volumes (`labor-profiles`,
`labor-store` with `messages.db`, `labor-data` with sessions/IPC) are
tmpfs-backed named volumes: chat content only ever exists in the CVM's
TDX-encrypted guest memory and is destroyed on restart. Named-volume tmpfs (not
container tmpfs) is required so the sibling agent-container bind mounts keep
working — see the variant's header. The retention env vars are declared in its
orchestrator environment (dstack only injects declared vars); set them in
`.env.tee` for the full sigstack-parity window.

**The selling point of toggle-by-variant: the privacy mode is attestable.**
dstack measures the exact compose document into `compose_hash`, which appears
in the TDX quote `!verify <nonce>` returns. The two variants necessarily hash
differently, so a user can *cryptographically prove* whether the deployment
they're talking to is the ephemeral one — the operator can't claim ephemerality
while running the persistent template. Publish both files; verifiers match the
reported `compose_hash` against the claimed variant.

### What survives a restart (ephemeral mode)

| Data | Survives? | Why |
|---|---|---|
| Signal device keys (`signal-data`) | **yes** (encrypted disk) | keys, not content; losing them forces a Signal re-link |
| static docker CLI (`docker-cli`) | yes | tooling, no org data |
| chat history / `messages.db` | **no — by design** | RAM only |
| agent sessions/transcripts, IPC state | **no — by design** | RAM only |
| group registrations | no — re-created automatically on first inbound message (`SIGNAL_AUTO_REGISTER_GROUPS=true`) | RAM only |
| translate preferences (`!translate-on` / `!translate-me`) | no — users re-issue them | RAM only |
| org profile / per-group `CLAUDE.md` | reseeded from the orchestrator image on every boot — see "Profile seeding" below (bake your profile into the image) | RAM only |

### Profile seeding (ephemeral mode)

A tmpfs-backed named volume is **empty every boot**, so `LABOR_PROFILE` would
point at a missing directory and [`src/profile.ts`](../src/profile.ts) would
throw on startup — a crash loop — unless something repopulates it. Docker's
named-volume copy-up does **not** solve this: copy-up happens when the volume
is *created*, while the local driver mounts the tmpfs on first use and
unmounts (destroys) it as soon as the volume's refcount hits zero, so the
content is gone before the orchestrator process starts. A dedicated seeding
init-service fails for the same reason — its exit drops the refcount to zero
and wipes what it just wrote.

The seeding therefore happens **inside the orchestrator container, while it
holds the mount**:

1. [`deploy/docker/Dockerfile.orchestrator`](../deploy/docker/Dockerfile.orchestrator)
   snapshots the baked profiles to `/app/profiles.dist` — deliberately outside
   `/app/profiles`, so the volume mount cannot shadow it.
2. The ephemeral variant overrides the orchestrator `command:` to
   `cp -a /app/profiles.dist/. /app/profiles/ && exec node dist/index.js`.

This runs on every start, so it self-heals across restarts and reboots. Bake
your org's profile into the image (`COPY profiles/<org> ./profiles/<org>` then
`RUN cp -a /app/profiles/. /app/profiles.dist/`) — it is then covered by the
pinned image digest that `!verify` attests. A profile pushed onto the volume
out-of-band is not reproducible and will not come back after a restart.

### Log hygiene

Ephemerality is defeated if content leaks into container logs — CVM logs can
be made public (`phala deploy --public-logs`, used only to scrape the Signal
link URI on first boot). The framework logs message **lengths, ids, and
counts** at INFO and above, never message content (content is permitted at
DEBUG only; keep `LOG_LEVEL=info` in production). The retention sweeper itself
logs only row counts. **Turn `--public-logs` OFF in production** once Signal
linking is done.

### Honest comparison with sigstack-bot

With both layers toggled on, labor.fun matches sigstack's core posture:
conversation content exists only in TEE-protected RAM, retention is bounded
(24h / N-messages window, hourly background cleanup vs sigstack's in-process
map eviction), a restart is total conversation loss, and nothing
content-bearing is ever written to disk. Differences to be honest about:

- **Preferences also reset.** sigstack persists user preferences (e.g.
  translation settings) encrypted at rest; labor.fun's ephemeral variant wipes
  translate prefs and group registrations with everything else — users
  re-issue `!translate-on` after a restart. (Registrations self-heal via
  `SIGNAL_AUTO_REGISTER_GROUPS`.)
- **Sweep cadence.** sigstack evicts continuously in-process; labor.fun's
  sweeper runs hourly and never touches the most recent hour or unprocessed
  messages, so the effective window normally exceeds the configured bound by up
  to ~an hour — and in the never-triggered-group case above it is unbounded
  until the agent first runs there. In ephemeral mode a restart is the backstop.
- **Storage medium during the window.** Inside the retention window sigstack
  holds messages in a process map; labor.fun holds them in SQLite — in
  ephemeral mode that file lives on tmpfs, so the medium is still RAM, but it
  is a file-shaped one shared with the (sibling, in-enclave) agent containers.
