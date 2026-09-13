// Rate-limit notices the bundled Claude CLI emits as a result's text (x0z/_h6
// and the Opus off-switch in @anthropic-ai/claude-agent-sdk 0.2.107's cli.js):
//   "You've hit your limit" / "…session limit" / "…weekly limit" /
//   "…Opus limit" / "…Sonnet limit" / "…usage limit"
//   "You're out of extra usage"
// each followed by " · resets <when>" only when the API sent a reset time;
// "Opus is experiencing high load, please use /model to switch to Sonnet";
// and the older CLI's "Claude AI usage limit reached|<epoch>".
const CLI_RATE_LIMIT_NOTICE =
  /^(?:(?:you['’]ve hit your (?:(?:session|weekly|opus|sonnet|usage) )?limit|you['’]re out of extra usage)(?:\s*[·∙•]\s*resets\b|\s*$)|opus is experiencing high load\b|claude ai usage limit reached\|\d+)/i;

/**
 * Detect "error-shaped" agent results: text a runner emitted as a SUCCESS
 * result whose content is actually a raw API/proxy failure, e.g.
 * "API Error: 502 error code: 502" after Claude Code exhausted its internal
 * retries against a dead model proxy, or an upstream policy-refusal blob.
 *
 * These must be classified as run ERRORS and never posted to a chat as if
 * the agent said them. Receipt: on 2026-08-06 at 18:06 and 18:10 UTC, a
 * production deployment delivered the raw 502 text verbatim to a user's DM.
 *
 * Kept deliberately conservative to avoid swallowing legitimate replies that
 * merely QUOTE an error string:
 *  - "API Error" must lead the text (the SDK emits it as a prefix), or
 *  - "error code: NNN" matches only when the whole text is short enough to
 *    plainly be an error blob rather than prose.
 *  - rate-limit notices match only in the shapes the bundled CLI builds (see
 *    CLI_RATE_LIMIT_NOTICE), so a reply like "you've hit your limit of 10
 *    hearts" still goes out. Receipt: on 2026-09-11, "You've hit your limit
 *    · resets 10pm (America/New_York)" was posted verbatim into a group chat,
 *    by chat replies and a scheduled task alike.
 */
export function isErrorShapedResult(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  if (/^API Error\b/i.test(t)) return true;
  if (t.length <= 300 && /\berror code:? \d{3}\b/i.test(t)) return true;
  if (t.length <= 300 && CLI_RATE_LIMIT_NOTICE.test(t)) return true;
  return false;
}
