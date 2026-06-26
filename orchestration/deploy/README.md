# Deploying the Smithers sidecar (remote env)

Everything the droplet needs to run `orchestration/`. None of this is on by
default — the orchestrator is unaffected until you set `SMITHERS_BRIDGE_ENABLED`.

Follows the framework's hard rule: **push → merge → deploy.** Do this after the
migration PR is merged and `safe-deploy.sh` has pulled it.

## 1. Install Bun (once)

The orchestrator is Node; the sidecar is Bun.

```bash
curl -fsSL https://bun.sh/install | bash   # or your distro's package
cd /opt/breadbrich/orchestration && bun install
```

## 2. Enable the bridge on the orchestrator

The bridge is a localhost-only, token-authed endpoint inside the main process
that runs one workflow step through `runContainerAgent` (keeps sandbox + proxy +
RBAC). Add to the install's `.env`:

```bash
SMITHERS_BRIDGE_ENABLED=true
SMITHERS_BRIDGE_PORT=3002
SMITHERS_BRIDGE_TOKEN=$(openssl rand -hex 32)   # keep secret; never commit
```

`systemd` doesn't load `.env` globally, so these are read via `config.ts`'s
allowlist (already added). Restart the orchestrator the proper way:

```bash
/opt/breadbrich-backups/safe-deploy.sh   # or: systemctl restart breadbrich
```

Verify: `curl -s -H "Authorization: Bearer $SMITHERS_BRIDGE_TOKEN" \
http://127.0.0.1:3002/health` → `{"status":"success","result":"ok"}`.

## 3. Point the sidecar at the bridge

The sidecar reads the same values:

```bash
export SMITHERS_BRIDGE_URL=http://127.0.0.1:3002
export SMITHERS_BRIDGE_TOKEN=...   # same token as the orchestrator
```

## 4. Smithers state (persistent + gitignored)

Smithers checkpoints runs to SQLite under `orchestration/.smithers/`. It must be
**persistent** (survives restarts) and is already gitignored. Back it up
alongside `profiles/<org>/store/` if run history matters.

## 5. Run a workflow (initial remote test)

On-demand is the right model to start — the bridge is the resident part; the
sidecar is invoked per run:

```bash
cd /opt/breadbrich/orchestration
bun run transcript     # bunx smithers-orchestrator up workflows/transcript.tsx
bunx smithers-orchestrator ps
bunx smithers-orchestrator up workflows/transcript.tsx --run-id <id> --resume true
```

## 6. (Optional) resident runner via systemd

Only if you later want a long-lived/queued runner rather than on-demand. A
template unit is in `breadbrich-smithers.service` — set `ExecStart` to whatever
trigger model you choose, then add the unit to `safe-deploy.sh` so deploys
restart it. Until then, on-demand (step 5) is sufficient.

## Verify-on-install checklist

- [ ] `bun install` resolves `smithers-orchestrator` + `zod`.
- [ ] Pin Smithers API names against the installed package (BaseAgent.run,
      createSmithers, `<Task>` props) — see the verify-on-install notes in
      `agents/container-agent.ts` and `workflows/*.tsx`.
- [ ] `/health` returns ok with the token; 401 without it.
- [ ] A transcript run checkpoints and `--resume` works after a forced kill.
