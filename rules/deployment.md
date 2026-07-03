# Deployment

**Shipping a change is automatic. Do not tell users a human must "run the
deploy" or that a change "isn't live until someone deploys it."** The only human
step is reviewing and merging the pull request.

## How a change reaches production

1. **Open a PR** to `main`. CI (`.github/workflows/ci.yml`) runs format check,
   typecheck, and tests.
2. **Merge to `main`.** That is the ship action.
3. **Auto-deploy takes over.** A host systemd timer
   (`breadbrich-auto-deploy.timer`) runs `setup/auto-deploy.sh` about **every 2
   minutes**. When it sees `origin/main` has advanced, it runs `safe-deploy.sh`
   (git reset -> rsync preserving state -> pull the CI-built container image ->
   restart -> health-check -> rollback on failure).
4. **Drain safety.** Auto-deploy **defers while an agent container
   (`nanoclaw-*`) is mid-run**, so live requests aren't killed, retrying each
   tick up to a ~15-minute cap. So a deploy may land a few minutes after the
   merge, especially if the assistant itself is busy.
5. **Confirmation.** On success `safe-deploy.sh` posts a
   `Deployed to production` comment on the merged PR. That comment - not the
   merge - is the signal that it's live.

## Container image

The agent container image is built + published to GHCR by
`.github/workflows/container.yml` **only when `container/**` changes** on push to
`main`. Auto-deploy pulls that SHA-pinned image; an idle reconciler in
`auto-deploy.sh` retags `nanoclaw-agent:latest` once CI finishes publishing.
Changes that don't touch `container/**` reuse the existing image - no rebuild.

## `scripts/deploy.sh` is a manual override

`./scripts/deploy.sh` (SSH -> host `safe-deploy.sh`) exists for **manual /
emergency** deploys and for `--status` / `--logs`. It is **not** the normal
path - normal shipping is merge-and-wait. Don't instruct users to run it as if a
deploy won't happen otherwise.

## What this means for answering users

- "Is it live?" -> merged? then it auto-deploys within ~2 min (longer if the
  assistant is busy); the PR gets a `Deployed to production` comment when done.
- Never say "someone needs to run the deploy" or name a person to run it.
- Deploying/infra access is only an [escalation](escalation.md) when a change
  genuinely needs host/secret access a merge can't provide - not for ordinary
  merges, which ship themselves.
