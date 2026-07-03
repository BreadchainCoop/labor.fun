# Breadbrich Engels State Recovery Map

**Purpose:** if something is lost, find it here. Every Breadbrich Engels state surface + its recovery procedure + disaster scenarios with RTO/data-loss bounds.

**Authoritative version.** Memory file `reference_breadbrich_state_recovery.md` is a pointer to this file.

**Last verified:** 2026-04-21

## Latest pre-migration backup (reference point)

| Attribute | Value |
|---|---|
| Created | 2026-04-21 04:05 UTC |
| On droplet | `/opt/breadbrich-backups/pre-migration/breadbrich-premig-20260421-040545.tar.gz` |
| Offsite (local Mac) | `~/Documents/Code/Claude/breadbrich-backups/pre-migration-2026-04-21/` |
| Size | 31 MB |
| SHA256 | `0aa656d10cf5088bcba95a009f15f665142fb79fb69614d638b5d22e9fb4ad8f` |
| Encryption | Not yet GPG-encrypted (flagged for pre-cutover) |
| Contents | Standard backup.sh output + gap-items (SSH keys, .netrc, systemd, cron, tunnel token, journal, dpkg, docker state) |

## Quick index

| ID | Lost thing | Restore from | Recovery time |
|---|---|---|---|
| R-01 | Messages DB | Tarball T1-01 or `.backup` sidecar | 5min |
| R-02 | .env | Tarball T1-03 + T1-04 (both must be updated) | 2min |
| R-03 | KB markdown file | `git checkout` from cvnt/main if committed; else tarball | 1min |
| R-04 | Session transcript | Tarball T1-06 | 5min |
| R-05 | KB UI users.json | Tarball T1-07 | 1min |
| R-06 | SSH deploy key | Tarball T1-09 gap-items/ssh/breadbrich-home-ssh/ | 2min + chmod 600 |
| R-07 | GitHub PAT | Tarball T1-11 gap-items/ssh/netrc | 1min |
| R-08 | systemd unit files | Tarball gap-items/systemd/ | 5min + daemon-reload |
| R-09 | cron files | Tarball gap-items/cron/ | 2min |
| R-10 | Cloudflare tunnel token | Tarball gap-items/tunnel/running-cloudflared-cmd.txt OR regenerate | 5min OR 30min (if regenerating) |
| R-11 | node_modules / dist | `npm install && npm run build` | 5min |
| R-12 | Docker image | `./container/build.sh` | 10min |
| R-13 | Whole droplet | New DO droplet + restore tarball + safe-deploy | ~2h |

## Per-surface recovery procedures

### R-01: messages.db corrupted

```bash
# On droplet
systemctl stop breadbrich breadbrich-kb
cp /opt/breadbrich/store/messages.db /opt/breadbrich/store/messages.db.broken-$(date +%Y%m%d-%H%M%S)

# Option 1: restore from most recent .backup sidecar
LATEST_BAK=$(ls -t /opt/breadbrich/store/messages.db.bak.* | head -1)
cp "$LATEST_BAK" /opt/breadbrich/store/messages.db

# Option 2: restore from pre-deploy backup tarball
TARBALL=$(ls -t /opt/breadbrich-backups/pre-deploy/breadbrich-pre-deploy-*.tar.gz | head -1)
tar -xzf "$TARBALL" -C / opt/breadbrich/store/messages.db

chown breadbrich:breadbrich /opt/breadbrich/store/messages.db
sqlite3 /opt/breadbrich/store/messages.db "PRAGMA integrity_check;"  # expect "ok"

systemctl start breadbrich breadbrich-kb
```

### R-02: .env restoration (both paths)

```bash
# Must update BOTH paths to stay in sync
TARBALL=$(ls -t /opt/breadbrich-backups/pre-deploy/breadbrich-pre-deploy-*.tar.gz | head -1)
tar -xzf "$TARBALL" -C /tmp opt/breadbrich/.env home/breadbrich/.config/nanoclaw/.env
cp /tmp/opt/breadbrich/.env /opt/breadbrich/.env
cp /tmp/home/breadbrich/.config/nanoclaw/.env /home/breadbrich/.config/nanoclaw/.env
chown breadbrich:breadbrich /opt/breadbrich/.env /home/breadbrich/.config/nanoclaw/.env
chmod 600 /opt/breadbrich/.env /home/breadbrich/.config/nanoclaw/.env
diff /opt/breadbrich/.env /home/breadbrich/.config/nanoclaw/.env  # should be empty (or only comments differ)
systemctl restart breadbrich
```

### R-03: KB markdown file accidentally deleted

```bash
# If committed to git
cd /path/to/local/breadbrich-repo
git log --all --diff-filter=D -- groups/slack_main/context/tasks/TASK-XXX.md
git checkout <commit-before-delete> -- groups/slack_main/context/tasks/TASK-XXX.md
# Commit + PR + safe-deploy

# If NOT in git (e.g. created on droplet)
# Extract from tarball
TARBALL=$(ls -t /opt/breadbrich-backups/pre-deploy/breadbrich-pre-deploy-*.tar.gz | head -1)
tar -xzf "$TARBALL" -C /tmp opt/breadbrich/groups/slack_main/context/tasks/TASK-XXX.md
cp /tmp/opt/breadbrich/groups/slack_main/context/tasks/TASK-XXX.md /opt/breadbrich/groups/slack_main/context/tasks/
chown breadbrich:breadbrich /opt/breadbrich/groups/slack_main/context/tasks/TASK-XXX.md
```

### R-06: SSH deploy key lost

```bash
# From backup
TARBALL=$(ls -t /opt/breadbrich-backups/pre-migration/breadbrich-premig-*.tar.gz | head -1)
tar -xOf "$TARBALL" gap-items.tar.gz | tar -xzf - -C /tmp
cp -a /tmp/gap/ssh/breadbrich-home-ssh /home/breadbrich/.ssh
chown -R breadbrich:breadbrich /home/breadbrich/.ssh
chmod 700 /home/breadbrich/.ssh
chmod 600 /home/breadbrich/.ssh/github_deploy

# Verify access
sudo -u breadbrich ssh -T git@github.com

# If key was compromised and needs rotation
sudo -u breadbrich ssh-keygen -t ed25519 -f /home/breadbrich/.ssh/github_deploy_new
# Add new pubkey to github.com/BreadchainCoop/breadbrich-engels/settings/keys
# Remove old pubkey from same page
mv /home/breadbrich/.ssh/github_deploy_new /home/breadbrich/.ssh/github_deploy
mv /home/breadbrich/.ssh/github_deploy_new.pub /home/breadbrich/.ssh/github_deploy.pub
```

### R-10: Cloudflare tunnel token rotation

Coordinate with the Cloudflare account owner.

```bash
# If just rotating the existing tunnel token (not recreating the tunnel)
# The infra owner rotates in Cloudflare dashboard → gets new --token value
# On droplet:
systemctl stop cloudflared
# Edit /etc/systemd/system/cloudflared.service — replace --token <new_value>
systemctl daemon-reload
systemctl start cloudflared
# Verify kb.example.com still serves

# If recreating the tunnel from scratch
cloudflared tunnel delete <old-uuid>  # requires logged-in cloudflared
cloudflared tunnel create breadbrich  # gets new UUID + credentials.json
cloudflared tunnel route dns <new-uuid> kb.example.com  # updates CNAME
# Update /etc/systemd/system/cloudflared.service with new UUID
systemctl daemon-reload && systemctl restart cloudflared
# Wait for DNS TTL
```

### R-13: whole droplet lost / compromised

```bash
# 1. Create new droplet (Ubuntu 22.04, same spec, DigitalOcean console)
# 2. Install prerequisites
apt update && apt install -y nodejs npm sqlite3 git cloudflared docker.io

# 3. Create breadbrich user
useradd -m -s /bin/bash breadbrich
mkdir -p /opt/breadbrich
chown breadbrich:breadbrich /opt/breadbrich

# 4. Restore from master tarball
scp local-mac:~/Documents/Code/Claude/breadbrich-backups/pre-migration-2026-04-21/breadbrich-premig-*.tar.gz /tmp/
tar -xzf /tmp/breadbrich-premig-*.tar.gz -C /tmp

# 5. Extract standard backup
tar -xzf /tmp/breadbrich-pre-deploy-*.tar.gz -C /
# This restores: /opt/breadbrich/{.env,store,data,groups,kb-ui/users.json,repo-tokens,src,dist,package*}
#                /home/breadbrich/.config/nanoclaw/.env

# 6. Extract gap-items
tar -xzf /tmp/gap-items.tar.gz -C /tmp
cp -a /tmp/gap/ssh/breadbrich-home-ssh /home/breadbrich/.ssh
cp /tmp/gap/ssh/netrc /home/breadbrich/.netrc
cp -a /tmp/gap/ssh/root-ssh/* /root/.ssh/
cp /tmp/gap/systemd/*.service /etc/systemd/system/
cp /tmp/gap/cron/breadbrich-* /etc/cron.d/

# 7. Ownership + perms
chown -R breadbrich:breadbrich /opt/breadbrich /home/breadbrich
chmod 600 /home/breadbrich/.netrc /home/breadbrich/.ssh/github_deploy /opt/breadbrich/.env /home/breadbrich/.config/nanoclaw/.env

# 8. Rebuild derived artifacts
cd /opt/breadbrich && sudo -u breadbrich npm install && sudo -u breadbrich npm run build
./container/build.sh  # rebuild docker image

# 9. Start services
systemctl daemon-reload
systemctl enable breadbrich breadbrich-kb cloudflared
systemctl start breadbrich breadbrich-kb cloudflared

# 10. Update DNS (new droplet IP if changed)
# In Cloudflare dashboard: point kb.example.com tunnel to new droplet
# OR update A record if using direct IP

# 11. Verify
systemctl status breadbrich breadbrich-kb cloudflared
curl http://localhost:8080/  # KB UI
# Send a test message via TG/Slack
```

## Disaster scenarios (RTO + loss bounds)

| Scenario | First action | RTO | Data loss bound |
|---|---|---|---|
| messages.db corrupted | R-01 (restore from .bak sidecar) | 5min | Hours to 1 day |
| KB file deleted | R-03 (git checkout or tarball) | 1-5min | None if committed |
| .env tokens compromised | Rotate at platform → R-02 (update both .env) → restart | 15min | None |
| Bot token rotation | BotFather/Slack/Anthropic console → R-02 | 15min | None |
| Cloudflare tunnel fails | Escalate to the infra owner → R-10 | 30min + DNS TTL | None |
| SSH keys compromised | R-06 (rotate keys, update GitHub) | 10min | None |
| Droplet wiped | R-13 | ~2h | Last backup interval (≤24h daily, ≤pre-deploy for recent) |
| Local memory files lost | Re-derive from `~/.claude/workflows/session-log.md` | Hours | Some context |
| Local repo lost | `git clone` | 5min | Uncommitted work |
| Source divergence between droplet + git | Already resolved 2026-04-21; re-verify via diff if suspected | 10min | None |

## Pre-flight checks before any destructive op

Run these before any migration phase that touches prod:

```bash
# 1. Verify latest pre-migration backup exists + checksums
ssh "$DROPLET_HOST" 'ls -lh /opt/breadbrich-backups/pre-migration/'
ls -lh ~/Documents/Code/Claude/breadbrich-backups/pre-migration-2026-04-21/
shasum -a 256 ~/Documents/Code/Claude/breadbrich-backups/pre-migration-2026-04-21/breadbrich-premig-*.tar.gz
# Must match expected SHA256 above

# 2. Take a fresh pre-deploy snapshot
ssh "$DROPLET_HOST" '/opt/breadbrich-backups/backup.sh pre-deploy'

# 3. Verify git in sync
cd ~/Documents/Code/Claude/breadbrich
git fetch cvnt
git status
git rev-list --left-right --count HEAD...cvnt/main
# Both counts should be 0 on the feature branch's base commit

# 4. Verify service health
ssh "$DROPLET_HOST" 'systemctl is-active breadbrich breadbrich-kb cloudflared'
# All should return "active"

# 5. Verify no in-flight critical operations
ssh "$DROPLET_HOST" 'docker ps && find /opt/breadbrich/data/ipc -name "*.json" | grep -v current_ | grep -v available_'
# Should show no urgent in-flight messages
```

## Third-copy offsite (recommended, not yet done)

The current backup has two copies (droplet + local Mac). Before the orchestrator refactor ships, add a third:

- Option A: DigitalOcean Spaces (S3-compatible, cheap)
- Option B: User's iCloud Drive (automatic, no new infra)
- Option C: External hard drive (cold storage)

Any of these is fine. Two is the minimum for critical; three is the target for pre-migration state.

## Update protocol

- Edit this file in the same PR as any new state surface introduction
- Re-verify disaster scenarios at least quarterly (pick one, actually run R-01 on staging)
- Re-generate a pre-migration backup at least monthly (replaces the 2026-04-21 baseline)
