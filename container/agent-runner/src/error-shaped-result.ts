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

// This framework's own quota refusals. When src/usage-budget.ts checkQuota()
// refuses a request, the host's credential proxy (src/credential-proxy.ts)
// answers it with a 429 whose message is the refusal reason, and the CLI
// renders that as "API Error: Request rejected (429) · <reason>". Those
// reasons are deliberate, human-written billing messages, and they are a
// hosted tenant's only signal that its budget is spent or its workspace is
// suspended, canceled or out of sync, so they are posted exactly as before
// rather than withheld and retried. Each alternative is the fixed opening of
// one checkQuota() reason; src/error-shaped-result-quota.test.ts fails if a
// reason is reworded without updating this list. Anthropic's own 429s,
// including the CLI's fallback ("this may be a temporary capacity issue —
// check status.anthropic.com"), are transient and stay error-shaped.
const QUOTA_REFUSAL =
  /^API Error: Request rejected \(429\) · (?:Monthly token budget exceeded|Monthly cost budget exceeded|This workspace is suspended|This workspace subscription is canceled|Entitlement information is stale)/;

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
 * merely QUOTE or discuss an error:
 *  - "API Error" matches only as the CLI's own prefix: case-sensitive, leading
 *    the text, and followed by ": " ("API Error: …"), by " (<model>): " (the
 *    Bedrock model-id template) or by nothing. "API error rates look normal."
 *    and "API Error (500) on /checkout is back to normal after the deploy."
 *    still go out. The CLI's auth-failure templates, which put "API Error"
 *    mid-string ("Failed to authenticate. API Error: …", "Please run /login ·
 *    API Error: …"), are deliberately left unmatched: they are permanent and
 *    actionable, so they stay visible.
 *  - "Request timed out" matches only as the whole text, the CLI's bare
 *    transient timeout result, so "Request timed out while fetching the
 *    sheet, …" still goes out.
 *  - "error code: NNN" matches only as the whole text ("error code: 502",
 *    "502 error code: 502"), never inside a sentence, so "The webhook
 *    returned error code 404, so I recreated it." still goes out.
 *  - rate-limit notices match only in the shapes the bundled CLI builds (see
 *    CLI_RATE_LIMIT_NOTICE), so a reply like "you've hit your limit of 10
 *    hearts" still goes out. Receipt: on 2026-09-11, "You've hit your limit
 *    · resets 10pm (America/New_York)" was posted verbatim into a group chat,
 *    by chat replies and a scheduled task alike.
 *  - the framework's own budget and entitlement refusals are never
 *    error-shaped, even though they lead with "API Error" (see QUOTA_REFUSAL).
 */
export function isErrorShapedResult(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  if (QUOTA_REFUSAL.test(t)) return false;
  if (/^API Error(?:: | \([^)]*\): |$)/.test(t)) return true;
  if (/^Request timed out$/.test(t)) return true;
  if (/^(?:\d{3} )?error code: \d{3}$/i.test(t)) return true;
  if (t.length <= 300 && CLI_RATE_LIMIT_NOTICE.test(t)) return true;
  return false;
}
