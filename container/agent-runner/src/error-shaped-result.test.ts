import { describe, expect, it } from 'vitest';

import { isErrorShapedResult } from './error-shaped-result.js';

describe('isErrorShapedResult', () => {
  it('classifies the exact 2026-08-06 502 blob as an error', () => {
    expect(isErrorShapedResult('API Error: 502 error code: 502\n')).toBe(true);
  });

  it('classifies proxy 503 overload blobs as errors', () => {
    expect(
      isErrorShapedResult(
        'API Error: 503 {"type":"error","error":{"type":"overloaded_error","message":"Account broker unavailable before upstream request."}}',
      ),
    ).toBe(true);
  });

  it('classifies policy-refusal API Error blobs as errors', () => {
    expect(
      isErrorShapedResult(
        'API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy',
      ),
    ).toBe(true);
  });

  it('classifies short bare error-code blobs as errors', () => {
    expect(isErrorShapedResult('error code: 502')).toBe(true);
    expect(isErrorShapedResult('502 error code: 502')).toBe(true);
  });

  it('classifies the "API Error" templates the bundled CLI leads with', () => {
    expect(isErrorShapedResult('API Error')).toBe(true);
    expect(
      isErrorShapedResult(
        'API Error (claude-opus-4-1): model not found. Run /model to pick a different model.',
      ),
    ).toBe(true);
    expect(isErrorShapedResult('API Error (claude-opus-5): Overloaded')).toBe(
      true,
    );
    expect(
      isErrorShapedResult(
        'API Error: Request rejected (429) · this may be a temporary capacity issue — check status.anthropic.com',
      ),
    ).toBe(true);
  });

  it('does NOT flag a lowercase "api error" prefix, which the CLI never emits', () => {
    expect(isErrorShapedResult('api error: 502')).toBe(false);
  });

  it("does NOT flag the CLI's auth-failure templates, which stay visible by design", () => {
    expect(
      isErrorShapedResult(
        'Failed to authenticate. API Error: 401 {"type":"error"}',
      ),
    ).toBe(false);
  });

  it('classifies the bare "Request timed out" result the CLI emits as an error', () => {
    expect(isErrorShapedResult('Request timed out')).toBe(true);
  });

  it('does NOT flag a reply that only starts like the timeout result', () => {
    expect(
      isErrorShapedResult(
        "Request timed out while fetching the sheet, so i used yesterday's copy",
      ),
    ).toBe(false);
  });

  it('does NOT flag normal replies', () => {
    expect(isErrorShapedResult('done. all-hands tomorrow 11:30-12:30')).toBe(
      false,
    );
    expect(isErrorShapedResult('')).toBe(false);
    expect(isErrorShapedResult('   ')).toBe(false);
  });

  it('does NOT flag short replies that mention an error code or API errors', () => {
    expect(
      isErrorShapedResult(
        'The webhook returned error code 404, so I recreated it.',
      ),
    ).toBe(false);
    expect(isErrorShapedResult('API error rates look normal.')).toBe(false);
    expect(
      isErrorShapedResult(
        'API Error (500) on /checkout is back to normal after the deploy.',
      ),
    ).toBe(false);
  });

  it('does NOT flag long replies that merely quote an error string', () => {
    const longReply =
      'here is what happened yesterday: the proxy returned error code: 502 ' +
      'for about four minutes, which is why some messages were delayed. ' +
      'everything recovered on its own and no action is needed. '.repeat(3);
    expect(isErrorShapedResult(longReply)).toBe(false);
  });

  it('does NOT flag replies that mention API errors mid-sentence', () => {
    expect(
      isErrorShapedResult(
        'the deploy failed because the API Error handling was missing a retry, i patched it and pushed. the fix adds a classifier so raw failures never reach the chat, plus a regression test covering the 502 and 503 shapes we saw in the logs yesterday evening around six.',
      ),
    ).toBe(false);
  });
  it('classifies the 2026-09-11 subscription usage-limit notice as an error', () => {
    expect(
      isErrorShapedResult(
        "You've hit your limit · resets 10pm (America/New_York)",
      ),
    ).toBe(true);
    expect(
      isErrorShapedResult('You’ve hit your usage limit ∙ resets 3am'),
    ).toBe(true);
  });

  it('classifies the legacy CLI usage-limit blob as an error', () => {
    expect(
      isErrorShapedResult('Claude AI usage limit reached|1757624400'),
    ).toBe(true);
  });

  it("does NOT flag replies about limits that aren't the CLI notice", () => {
    expect(
      isErrorShapedResult(
        "you've hit your limit of 10 hearts this month, it resets on the 1st",
      ),
    ).toBe(false);
    expect(
      isErrorShapedResult("you've hit your limit - resets tomorrow morning"),
    ).toBe(false);
    expect(
      isErrorShapedResult(
        'Claude AI usage limit reached yesterday, which is why i went quiet',
      ),
    ).toBe(false);
  });
  it('classifies every rate-limit shape the bundled CLI builds', () => {
    const resets = ' · resets 10pm (America/New_York)';
    for (const kind of [
      'limit',
      'session limit',
      'weekly limit',
      'Opus limit',
      'Sonnet limit',
      'usage limit',
    ]) {
      expect(isErrorShapedResult(`You've hit your ${kind}${resets}`)).toBe(
        true,
      );
      expect(isErrorShapedResult(`You've hit your ${kind}`)).toBe(true);
    }
    expect(isErrorShapedResult(`You're out of extra usage${resets}`)).toBe(
      true,
    );
    expect(isErrorShapedResult("You're out of extra usage")).toBe(true);
    expect(
      isErrorShapedResult(
        'Opus is experiencing high load, please use /model to switch to Sonnet',
      ),
    ).toBe(true);
  });

  it('does NOT flag a reply that only starts like a limit notice', () => {
    expect(
      isErrorShapedResult(
        "you're out of extra usage credits on the team account, ask an admin",
      ),
    ).toBe(false);
    expect(
      isErrorShapedResult("you've hit your limit for hearts this month"),
    ).toBe(false);
  });
});
