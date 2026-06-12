#!/usr/bin/env node
// deploy-notify.mjs — after a successful deploy of a NEW commit, comment on the
// merged PR @-mentioning whoever merged it, letting them know their change is
// live in production.
//
// Invoked by safe-deploy.sh on the success path, ONLY when HEAD actually
// advanced (see the `$OLD != $NEW` guard there), with the deployed commit SHA:
//
//   node setup/deploy-notify.mjs <deployed-sha>
//
// Best-effort by design: this script NEVER exits non-zero and never throws out
// of `main()`. A failed/owner-missing token, a direct push with no PR, or a
// GitHub hiccup all just log a line and return — a notification must never be
// able to fail (or roll back) an otherwise-healthy deploy.
//
// Auth — a GitHub token with `pull_requests: write` (fine-grained) or classic
// `repo` scope on the framework repo, resolved in order:
//   1. $DEPLOY_NOTIFY_TOKEN          (env)
//   2. $DEPLOY_ROOT/repo-tokens/notify   (file — preferred on the droplet)
//   3. $DEPLOY_ROOT/repo-tokens/github   (file — fallback)
// If none is found the feature simply stays dormant (logs + returns).
//
// Config:
//   $NOTIFY_REPO   owner/repo            (default: BreadchainCoop/labor.fun)
//   $DEPLOY_ROOT   where repo-tokens/ is (default: /opt/breadbrich)
//
// Requires Node 18+ for global fetch (the app runs Node 22 — see .nvmrc).

import { readFileSync } from 'node:fs';

const log = (m) => console.log(`[deploy-notify] ${m}`);

const sha = process.argv[2];
const repo = process.env.NOTIFY_REPO || 'BreadchainCoop/labor.fun';
const deployRoot = process.env.DEPLOY_ROOT || '/opt/breadbrich';

function resolveToken() {
  const fromEnv = (process.env.DEPLOY_NOTIFY_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  for (const name of ['notify', 'github']) {
    try {
      const t = readFileSync(`${deployRoot}/repo-tokens/${name}`, 'utf8').trim();
      if (t) return t;
    } catch {
      /* file absent/unreadable — try the next candidate */
    }
  }
  return '';
}

async function main() {
  if (!sha) {
    log('no deployed SHA argument — skipping');
    return;
  }
  const token = resolveToken();
  if (!token) {
    log('no token (DEPLOY_NOTIFY_TOKEN or repo-tokens/{notify,github}) — skipping');
    return;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'labor.fun-deploy-notify',
  };

  // Which PR did this commit come from? GitHub associates the commit that
  // landed on main (merge, squash, or rebase) with its PR.
  const lookup = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}/pulls`, { headers });
  if (!lookup.ok) {
    log(`commit→PR lookup failed (HTTP ${lookup.status}) — skipping`);
    return;
  }
  const prs = await lookup.json();
  const pr = Array.isArray(prs) ? prs[0] : null;
  if (!pr) {
    log(`no PR associated with ${sha} (direct push?) — skipping`);
    return;
  }

  // Prefer who merged it; fall back to the PR author.
  const who = pr.merged_by?.login || pr.user?.login || '';
  const short = sha.slice(0, 7);
  const mention = who ? `@${who} ` : '';
  const body =
    `🚀 **Deployed to production** — ${mention}your changes from #${pr.number} ` +
    `are now live (commit \`${short}\`).`;

  const post = await fetch(`https://api.github.com/repos/${repo}/issues/${pr.number}/comments`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (post.ok) {
    log(`notified ${who ? '@' + who : '(no user)'} on PR #${pr.number} — ${short} live`);
  } else {
    log(`WARN: failed to comment on PR #${pr.number} (HTTP ${post.status})`);
  }
}

main().catch((e) => log(`WARN: ${e?.message || e} — skipping`));
