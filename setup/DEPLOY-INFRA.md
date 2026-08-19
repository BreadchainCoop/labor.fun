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
| `setup/auto-deploy.sh` | `/opt/breadbrich-backups/auto-deploy.sh` | root:root, 755 |
| `setup/systemd/breadbrich-auto-deploy.service` | `/etc/systemd/system/breadbrich-auto-deploy.service` | root:root, 644 |
| `setup/systemd/breadbrich-auto-deploy.timer` | `/etc/systemd/system/breadbrich-auto-deploy.timer` | root:root, 644 |
| `setup/breadbrich-deploy.env` | `/opt/breadbrich/setup/breadbrich-deploy.env` *(via rsync)* | breadbrich:breadbrich, 644 |
| `setup/logrotate/labor.fun.conf.in` | `/etc/logrotate.d/<service>` *(rendered, `${DEPLOY_ROOT}` filled)* | root:root, 644 |

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

## Log rotation (disk-fill safety net)

The services write to `${DEPLOY_ROOT}/logs/*.log` and `*.error.log` via
systemd `StandardOutput/StandardError=append:…`. Nothing rotated these, and a
hot-path WARN once flooded an error log to **682MB and filled the droplet's
disk**. Every deploy now installs a logrotate policy that caps them.

- **Template:** `setup/logrotate/labor.fun.conf.in`
  (`${DEPLOY_ROOT}/logs/*.log` — the `*.log` glob also matches `*.error.log`).
- **Installed to:** `/etc/logrotate.d/<service>` by `safe-deploy.sh` **step
  7a-ter**, rendered with this org's `DEPLOY_ROOT` via `envsubst` (same
  mechanism as the systemd units). Idempotent byte-compare; non-fatal so a bad
  logrotate config can't roll back an otherwise-healthy deploy.
- **Policy:** `size 100M`, `rotate 3`, `compress`, `missingok`, `notifempty`,
  **`copytruncate`**.
- **Why `copytruncate`:** the app holds each log's file descriptor open for the
  life of the process (systemd `append:`). A rename+create rotation (the
  default, or `create`) would leave the process writing to the now-rotated
  inode — the "current" log would freeze while the rotated file grew unbounded,
  defeating rotation. `copytruncate` copies then truncates the file in place, so
  the held fd keeps writing to the same (now-empty) inode. The app's log
  transport is unchanged; rotation is entirely external. (There is no clean
  systemd-native size cap for `append:` files short of switching to journald,
  which we don't; logrotate + copytruncate is the mechanism.)
- Rotation is gated by **size, not time**: a flood fills the disk in hours, well
  before a daily/weekly rotate would fire. The system logrotate cron/timer runs
  the check periodically and rotates whenever a file is past 100M.

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

# Install the logrotate policy (renders ${DEPLOY_ROOT}). safe-deploy.sh
# re-installs this on every run, so this is only needed if you want it in
# place before the first deploy.
DEPLOY_ROOT=/opt/breadbrich envsubst '${DEPLOY_ROOT}' \
  < /opt/breadbrich-git/setup/logrotate/labor.fun.conf.in \
  > /etc/logrotate.d/breadbrich
chmod 644 /etc/logrotate.d/breadbrich
```

From here on, just merge changes to `main` and run
`/opt/breadbrich-backups/safe-deploy.sh` — it will keep itself and the
units up-to-date.

## Auto-deploy on merge

`breadbrich-auto-deploy.timer` polls `origin/main` every 2 minutes via
`git ls-remote` (refs only, no object fetch) and runs `safe-deploy.sh`
when the mirror is behind. Auth piggybacks on the credential helper
`safe-deploy.sh` already configured (PAT in
`/home/breadbrich/.git-credentials`) — no GitHub Secrets, no inbound
ports.

Manual + auto deploys are serialized through a `flock` on
`/run/breadbrich-deploy.lock` taken at the top of `safe-deploy.sh`. If
one is already running, the other exits fast (exit 0, so the timer
doesn't record a failure).

Logs land in `/opt/breadbrich/logs/auto-deploy.log` and `…/auto-deploy.error.log`.
Status:

```bash
systemctl status breadbrich-auto-deploy.timer
journalctl -u breadbrich-auto-deploy.service -n 20
tail -f /opt/breadbrich/logs/auto-deploy.log
```

To stop polling temporarily: `systemctl stop breadbrich-auto-deploy.timer`.
To stop forever: `systemctl disable --now breadbrich-auto-deploy.timer`.
