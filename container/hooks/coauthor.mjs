import fs from 'fs';

// Auto co-authorship for agent commits.
//
// The assistant makes commits on behalf of the human who triggered the turn.
// Crediting them used to rely on the agent remembering to add a Co-Authored-By
// trailer (a docs rule it could forget). This runs as a container-global
// `prepare-commit-msg` hook so EVERY commit the agent makes is co-authored to
// the requester automatically — sourced from the per-turn sender context the
// orchestrator writes, so it can't be forgotten and can't attribute the wrong
// person across container reuse.

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Return the commit message with the requester appended as a Co-Authored-By
 * trailer. Pure (no IO). Idempotent — won't add a duplicate, and won't touch
 * merge/squash commits (a co-author there is noise).
 *
 * @param {string} message         the current commit message
 * @param {string|undefined} githubUsername  requester's GitHub handle
 * @param {string|undefined} source prepare-commit-msg's 2nd arg (message/merge/squash/commit/template/'')
 * @returns {string} the (possibly unchanged) message
 */
export function appendCoauthor(message, githubUsername, source) {
  if (source === 'merge' || source === 'squash') return message;
  const login = (githubUsername || '').trim();
  if (!login) return message;

  // Already credited (any email form)? Leave it alone.
  const already = new RegExp(
    `^Co-Authored-By:.*\\b${escapeRegExp(login)}\\b`,
    'im',
  );
  if (already.test(message)) return message;

  const trailer = `Co-Authored-By: ${login} <${login}@users.noreply.github.com>`;
  const trimmed = message.replace(/\s+$/, '');
  // If a trailer block already exists, extend it (single newline); otherwise
  // start one after a blank line.
  const hasTrailerBlock = /^Co-Authored-By:/im.test(trimmed);
  const sep = hasTrailerBlock ? '\n' : '\n\n';
  return `${trimmed}${sep}${trailer}\n`;
}

/**
 * Read the requester's GitHub handle from the orchestrator-written sender
 * context. Returns undefined when absent/unparseable (fail open — never block a
 * commit over attribution).
 */
export function readGithubUsername(senderContextPath) {
  try {
    const raw = fs.readFileSync(senderContextPath, 'utf8');
    const gh = JSON.parse(raw).github_username;
    return typeof gh === 'string' && gh.trim() ? gh.trim() : undefined;
  } catch {
    return undefined;
  }
}

function main() {
  const [msgFile, source] = process.argv.slice(2);
  if (!msgFile) return;
  const ctxPath =
    process.env.SENDER_CONTEXT_PATH ||
    '/workspace/ipc/input/sender_context.json';
  const login = readGithubUsername(ctxPath);
  if (!login) return;
  let message;
  try {
    message = fs.readFileSync(msgFile, 'utf8');
  } catch {
    return;
  }
  const updated = appendCoauthor(message, login, source);
  if (updated !== message) {
    try {
      fs.writeFileSync(msgFile, updated);
    } catch {
      /* never fail the commit over attribution */
    }
  }
}

// Run only when invoked as the hook, not when imported by tests.
if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  main();
}
