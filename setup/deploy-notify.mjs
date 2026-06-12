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
// Auth — reuses the app's existing GitHub token (the same
// `GITHUB_PERSONAL_ACCESS_TOKEN` the bot already uses for the GitHub MCP server
// and project sync, so it already has PR/issue write). No new token or file.
// Resolved in order:
//   1. $DEPLOY_NOTIFY_TOKEN            (env — optional override)
//   2. $GITHUB_PERSONAL_ACCESS_TOKEN / $GH_TOKEN   (env, if exported)
//   3. the same keys parsed out of $DEPLOY_ROOT/.env   (mirrors src/env.ts)
// If none resolves, the feature simply stays dormant (logs + returns).
//
// Config:
//   $NOTIFY_REPO   owner/repo   (default: BreadchainCoop/labor.fun)
//   $DEPLOY_ROOT   app dir holding .env   (default: /opt/breadbrich)
//
// Requires Node 18+ for global fetch (the app runs Node 22 — see .nvmrc).

import { readFileSync } from 'node:fs';

const log = (m) => console.log(`[deploy-notify] ${m}`);

const sha = process.argv[2];
const repo = process.env.NOTIFY_REPO || 'BreadchainCoop/labor.fun';
const deployRoot = process.env.DEPLOY_ROOT || process.cwd();

const TOKEN_KEYS = ['DEPLOY_NOTIFY_TOKEN', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'GH_TOKEN'];

// Parse selected keys out of $DEPLOY_ROOT/.env without loading them into the
// environment — same approach (and same file) as src/env.ts readEnvFile, so we
// pick up exactly the token the app itself uses.
function readEnvFileTokens() {
  const found = {};
  let content;
  try {
    content = readFileSync(`${deployRoot}/.env`, 'utf8');
  } catch {
    return found; // no .env reachable — caller falls back to nothing
  }
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const key = t.slice(0, i).trim();
    if (!TOKEN_KEYS.includes(key) || found[key]) continue;
    let v = t.slice(i + 1).trim();
    if (
      v.length >= 2 &&
      ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
    ) {
      v = v.slice(1, -1);
    }
    if (v) found[key] = v;
  }
  return found;
}

function resolveToken() {
  for (const k of TOKEN_KEYS) {
    const v = (process.env[k] || '').trim();
    if (v) return v;
  }
  const fromFile = readEnvFileTokens();
  for (const k of TOKEN_KEYS) {
    if (fromFile[k]) return fromFile[k];
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
    log('no GitHub token (GITHUB_PERSONAL_ACCESS_TOKEN in .env or env) — skipping');
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
