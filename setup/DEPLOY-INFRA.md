# Deploy infrastructure (systemd units + safe-deploy.sh)

Everything the droplet needs to run Breadbrich Engels — short of secrets — is
checked in. Changes ship the same way feature code does:

```
edit setup/... → push → merge → safe-deploy.sh
```

## Files

| Path | Installed to | Owner |
|------|-------------|-------|
| `setup/systemd/breadbrich.service` | `/etc/systemd/system/breadbrich.service` | root:root, 644 |
| `setup/systemd/breadbrich-kb.service` | `/etc/systemd/system/breadbrich-kb.service` | root:root, 644 |
| `setup/safe-deploy.sh` | `/opt/breadbrich-backups/safe-deploy.sh` | root:root, 755 |
| `setup/breadbrich-deploy.env` | `/opt/breadbrich/setup/breadbrich-deploy.env` *(via rsync)* | breadbrich:breadbrich, 644 |

## How updates propagate (steady state)

`safe-deploy.sh` on the droplet does two extra things during every run:

1. **Step 7a — Unit install**: byte-compares each `setup/systemd/*.service` in
   the mirror against `/etc/systemd/system/`; copies any that differ and runs
   `systemctl daemon-reload` once. The subsequent `systemctl restart` (step
   7b) picks up the new unit definition.
2. **Step 9 — Self-update**: byte-compares `setup/safe-deploy.sh` in the
   mirror against `/opt/breadbrich-backups/safe-deploy.sh` and replaces the
   on-disk copy *after* the rest of the deploy succeeds. The new version
   takes effect on the **next** run — never mid-flight.

Net result: once this is bootstrapped, you never touch the droplet for
deploy-infra changes. Edit the file in the repo, merge, deploy.

## Per-deployment customization

Non-secret deployment values (`KB_PORT`, `CONTEXT_DIR`, `USERS_FILE`,
`KB_ADMINS`, `KB_SUPERADMINS`, `DB_PATH`, `CREDENTIAL_PROXY_HOST`,
`NODE_ENV`) live in `setup/breadbrich-deploy.env` and are loaded by both
units via `EnvironmentFile=-/opt/breadbrich/setup/breadbrich-deploy.env`.
The leading `-` tolerates a missing file (Node server-side defaults still
apply).

To change one of these: edit `setup/breadbrich-deploy.env`, merge, run
`safe-deploy.sh`. The rsync step writes the new file before unit-install
+ restart, so the service starts with the new values on the same deploy.

Operator-level secrets (`DISCORD_BOT_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
`GITHUB_PERSONAL_ACCESS_TOKEN`, …) are **not** in the units and **not** in
the repo — they live in `/opt/breadbrich/.env` (gitignored, 0600,
`breadbrich`-owned) and are loaded by `readEnvFile` at process startup.
See `.env.example` for the full list.

## First-time bootstrap on a fresh droplet

```bash
# As root, with the repo already cloned to /opt/breadbrich-git and
# /opt/breadbrich populated (see existing setup/ tooling for the
# bootstrap proper):
mkdir -p /opt/breadbrich-backups/pre-deploy

# Install the unit files
install -m 644 -o root -g root \
  /opt/breadbrich-git/setup/systemd/breadbrich.service \
  /etc/systemd/system/breadbrich.service
install -m 644 -o root -g root \
  /opt/breadbrich-git/setup/systemd/breadbrich-kb.service \
  /etc/systemd/system/breadbrich-kb.service
systemctl daemon-reload
systemctl enable --now breadbrich breadbrich-kb

# Install safe-deploy.sh
install -m 755 -o root -g root \
  /opt/breadbrich-git/setup/safe-deploy.sh \
  /opt/breadbrich-backups/safe-deploy.sh
```

From here on, just merge changes to `main` and run
`/opt/breadbrich-backups/safe-deploy.sh` — it will keep itself and the
units up-to-date.
