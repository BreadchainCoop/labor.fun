---
name: redeploy-breadbrich
description: Trigger a Breadbrich Engels redeployment from the latest merged main branch. Requires an allowlisted user. Follows the push → merge → deploy workflow — only deploys code already in git.
---

# /redeploy-breadbrich — Trigger Redeployment

Trigger a Breadbrich Engels redeployment on the droplet. This skill follows the **push → merge → deploy** rule — it only deploys code already merged to `main` on GitHub.

## Who Can Use This

Any allowlisted user. Unknown senders are denied — respond with:
> Redeployments require an allowlisted user. If you don't see yourself in `context/people/`, ask someone who is already allowlisted to add you.

## Pre-Flight Checks

Before triggering a deploy, verify:

1. **Identity**: Confirm the requester resolves to a KB person
2. **Clean state**: Ask if there are any uncommitted changes or open PRs that should be merged first
3. **Reason**: Log why the redeployment is being triggered

## How to Deploy

The deployment runs on the configured droplet (set `DROPLET_HOST` in `.env`). The standard flow:

```bash
# Option 1: From a machine with SSH access to the droplet
ssh "$DROPLET_HOST" "su - breadbrich -c '/opt/breadbrich-backups/safe-deploy.sh'"

# Option 2: From local checkout (Mac)
cd ~/Documents/Code/Claude/breadbrich && ./scripts/deploy.sh
```

### What safe-deploy.sh Does

1. Takes a pre-deploy backup snapshot
2. Pulls latest from GitHub main
3. Rsyncs code (preserving stateful paths: `.env`, `store/`, `data/`, `groups/`, `kb-ui/users.json`)
4. Runs `npm install` (if deps changed)
5. Runs `npm run build`
6. Rebuilds container if `container/` sources changed
7. Restarts `breadbrich.service`
8. Health check (24s timeout)
9. **Automatic rollback on any failure**

### From Inside a Container (IPC)

If triggered from inside a Breadbrich Engels container (no direct SSH), create an IPC task:

```bash
echo '{"type": "redeploy", "reason": "Triggered by <requester>", "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > /workspace/ipc/tasks/redeploy_$(date +%s).json
```

> **Note**: IPC-based redeployment requires the orchestrator to have a handler for `type: "redeploy"`. If this handler doesn't exist yet, the requester needs SSH access to the droplet.

## Post-Deploy

After deployment:
1. Verify Breadbrich Engels is responding (send a test message)
2. Check `/status` for health
3. Log the deployment in the KB

## Restrictions

- **Never deploy unmerged code** — all changes must be in git on `main`
- **Never modify `.env`, `store/`, or `groups/` during deploy** — these are stateful and preserved
- **Never skip the backup step** — `safe-deploy.sh` handles this automatically

## Rollback

If a deploy goes wrong and auto-rollback didn't catch it:

```bash
# Manual rollback from latest pre-deploy snapshot
ssh "$DROPLET_HOST"
systemctl stop breadbrich
cd /
tar -xzf /opt/breadbrich-backups/pre-deploy/breadbrich-pre-deploy-LATEST.tar.gz
su - breadbrich -c "cd /opt/breadbrich && npm install --no-audit --no-fund"
systemctl start breadbrich
```

## Related

- [DEPLOY.md](/workspace/project/docs/DEPLOY.md) — Full deployment documentation
- [Access Control](/workspace/project/rules/access-control/README.md) — Role permissions
