import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  _initTestDatabase,
  analyticsPrivacyMode,
  redactQuestionText,
  resolveStoredQuestion,
  looksLikeQuestion,
  detectKnowledgeGapMarker,
  coarseTopic,
  logAssistantEvent,
  getEventVolumeByDay,
  getEventGroupBreakdown,
  getResolutionStats,
  getTopUnanswered,
  getMostActiveGroups,
  getMostActiveUsers,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

const ORIGINAL_PRIVACY = process.env.ASSISTANT_ANALYTICS_PRIVACY;

afterEach(() => {
  if (ORIGINAL_PRIVACY === undefined) {
    delete process.env.ASSISTANT_ANALYTICS_PRIVACY;
  } else {
    process.env.ASSISTANT_ANALYTICS_PRIVACY = ORIGINAL_PRIVACY;
  }
});

// --- analyticsPrivacyMode ---

describe('analyticsPrivacyMode', () => {
  it('defaults to main-only when unset', () => {
    delete process.env.ASSISTANT_ANALYTICS_PRIVACY;
    expect(analyticsPrivacyMode()).toBe('main-only');
  });

  it('accepts full and redacted, case/whitespace-insensitively', () => {
    process.env.ASSISTANT_ANALYTICS_PRIVACY = '  FULL ';
    expect(analyticsPrivacyMode()).toBe('full');
    process.env.ASSISTANT_ANALYTICS_PRIVACY = 'Redacted';
    expect(analyticsPrivacyMode()).toBe('redacted');
  });

  it('falls back to main-only for an unrecognized value', () => {
    process.env.ASSISTANT_ANALYTICS_PRIVACY = 'bogus';
    expect(analyticsPrivacyMode()).toBe('main-only');
  });
});

// --- redactQuestionText ---

describe('redactQuestionText', () => {
  it('collapses whitespace', () => {
    expect(redactQuestionText('hello   \n\n  world')).toBe('hello world');
  });

  it('redacts email addresses', () => {
    expect(redactQuestionText('contact me at ron.t@example.com please')).toBe(
      'contact me at <email> please',
    );
  });

  it('redacts long digit runs (phone-like)', () => {
    expect(redactQuestionText('call 555-123-4567 now')).toBe(
      'call <number> now',
    );
  });

  it('truncates to ~120 chars with an ellipsis', () => {
    const long = 'a'.repeat(200);
    const result = redactQuestionText(long);
    expect(result.length).toBe(118); // 117 chars + ellipsis
    expect(result.endsWith('…')).toBe(true);
  });

  it('leaves short, PII-free text unchanged', () => {
    expect(redactQuestionText('how do I submit an expense report?')).toBe(
      'how do I submit an expense report?',
    );
  });
});

// --- resolveStoredQuestion ---

describe('resolveStoredQuestion', () => {
  it('returns null for empty/whitespace-only input', () => {
    expect(
      resolveStoredQuestion('   ', { isMain: true, mode: 'full' }),
    ).toEqual({ question_text: null });
    expect(resolveStoredQuestion(null, { isMain: true, mode: 'full' })).toEqual(
      { question_text: null },
    );
  });

  it('full mode stores full text (capped at 500 chars) for any group', () => {
    const text = 'what is the expense policy';
    expect(
      resolveStoredQuestion(text, { isMain: false, mode: 'full' }),
    ).toEqual({ question_text: text });
    const long = 'x'.repeat(600);
    expect(
      resolveStoredQuestion(long, { isMain: false, mode: 'full' }).question_text
        ?.length,
    ).toBe(500);
  });

  it('redacted mode always redacts, even for the main group', () => {
    const text = 'email me at a@b.com';
    expect(
      resolveStoredQuestion(text, { isMain: true, mode: 'redacted' }),
    ).toEqual({ question_text: redactQuestionText(text) });
  });

  it('main-only mode stores full text for main, redacted for others', () => {
    const text = 'my number is 555-000-1111';
    expect(
      resolveStoredQuestion(text, { isMain: true, mode: 'main-only' }),
    ).toEqual({ question_text: text.trim().slice(0, 500) });
    expect(
      resolveStoredQuestion(text, { isMain: false, mode: 'main-only' }),
    ).toEqual({ question_text: redactQuestionText(text) });
  });
});

// --- looksLikeQuestion ---

describe('looksLikeQuestion', () => {
  it('detects trailing question marks', () => {
    expect(looksLikeQuestion('what time is the meeting?')).toBe(true);
  });

  it('detects leading question words without a question mark', () => {
    expect(looksLikeQuestion('who is the point of contact')).toBe(true);
    expect(looksLikeQuestion('can you tell me the address')).toBe(true);
  });

  it('detects "how to" / "how do i" phrasing', () => {
    expect(looksLikeQuestion('how to submit an expense')).toBe(true);
    expect(looksLikeQuestion('please explain how do I get reimbursed')).toBe(
      true,
    );
  });

  it('returns false for statements/commands and empty input', () => {
    expect(looksLikeQuestion('send the report now')).toBe(false);
    expect(looksLikeQuestion('')).toBe(false);
    expect(looksLikeQuestion(null)).toBe(false);
    expect(looksLikeQuestion(undefined)).toBe(false);
  });
});

// --- detectKnowledgeGapMarker ---

describe('detectKnowledgeGapMarker', () => {
  it('detects common "cannot answer" phrasing', () => {
    expect(
      detectKnowledgeGapMarker("I don't have that information on hand."),
    ).toBe(true);
    expect(detectKnowledgeGapMarker('Sorry, I could not find anything.')).toBe(
      true,
    );
    expect(detectKnowledgeGapMarker('That is not in the knowledge base.')).toBe(
      true,
    );
  });

  it('returns false for a normal, confident answer', () => {
    expect(
      detectKnowledgeGapMarker('The expense policy caps meals at $50/day.'),
    ).toBe(false);
  });

  it('returns false for empty/null output', () => {
    expect(detectKnowledgeGapMarker('')).toBe(false);
    expect(detectKnowledgeGapMarker(null)).toBe(false);
    expect(detectKnowledgeGapMarker(undefined)).toBe(false);
  });
});

// --- coarseTopic ---

describe('coarseTopic', () => {
  it('buckets known keywords into topics', () => {
    expect(coarseTopic('how do I file an expense report')).toBe('expenses');
    expect(coarseTopic('when is the next calendar event')).toBe('calendar');
    expect(coarseTopic('who is the assignee for this task')).toBe('tasks');
  });

  it('returns null when nothing matches', () => {
    expect(coarseTopic('the weather is nice today')).toBeNull();
    expect(coarseTopic(null)).toBeNull();
  });
});

// --- logAssistantEvent + aggregation helpers ---

describe('logAssistantEvent', () => {
  it('inserts a row and is_question reflects the heuristic', () => {
    const id = logAssistantEvent({
      chatJid: 'jid-1',
      groupFolder: 'main',
      isMain: true,
      senderName: 'Alice',
      questionText: 'what is the expense policy?',
      outcome: 'answered',
    });
    expect(id).toBeGreaterThan(0);

    const stats = getResolutionStats();
    expect(stats.total).toBe(1);
    expect(stats.questions).toBe(1);
    expect(stats.answered).toBe(1);
  });

  it('applies the default main-only privacy policy at insert time', () => {
    logAssistantEvent({
      chatJid: 'jid-main',
      groupFolder: 'main',
      isMain: true,
      senderName: 'Alice',
      questionText: 'contact me at alice@example.com',
      outcome: 'knowledge_gap',
      gapSource: 'agent_signal',
    });
    logAssistantEvent({
      chatJid: 'jid-other',
      groupFolder: 'other-group',
      isMain: false,
      senderName: 'Bob',
      questionText: 'contact me at bob@example.com',
      outcome: 'knowledge_gap',
      gapSource: 'agent_signal',
    });

    const top = getTopUnanswered();
    const mainRow = top.find((r) => r.question.includes('alice'));
    const otherRow = top.find((r) => r.question.includes('<email>'));
    expect(mainRow?.question).toBe('contact me at alice@example.com');
    expect(otherRow).toBeTruthy();
    expect(otherRow?.question).toBe('contact me at <email>');

    // Sender is suppressed for non-main groups under main-only.
    const users = getMostActiveUsers();
    expect(users.some((u) => u.name === 'Alice')).toBe(true);
    expect(users.some((u) => u.name === 'Bob')).toBe(false);
  });

  it('never throws for missing optional fields', () => {
    expect(() =>
      logAssistantEvent({
        chatJid: 'jid-x',
        groupFolder: 'group-x',
        isMain: false,
        outcome: 'error',
      }),
    ).not.toThrow();
  });
});

describe('getResolutionStats', () => {
  it('computes resolution rate excluding errors from the denominator', () => {
    logAssistantEvent({
      chatJid: 'a',
      groupFolder: 'main',
      isMain: true,
      outcome: 'answered',
    });
    logAssistantEvent({
      chatJid: 'b',
      groupFolder: 'main',
      isMain: true,
      outcome: 'answered',
    });
    logAssistantEvent({
      chatJid: 'c',
      groupFolder: 'main',
      isMain: true,
      outcome: 'answered',
    });
    logAssistantEvent({
      chatJid: 'd',
      groupFolder: 'main',
      isMain: true,
      outcome: 'knowledge_gap',
      gapSource: 'heuristic',
    });
    logAssistantEvent({
      chatJid: 'e',
      groupFolder: 'main',
      isMain: true,
      outcome: 'error',
    });

    const stats = getResolutionStats();
    expect(stats.total).toBe(5);
    expect(stats.answered).toBe(3);
    expect(stats.knowledgeGap).toBe(1);
    expect(stats.error).toBe(1);
    // 3 / (3 + 1) = 0.75, errors excluded from the denominator.
    expect(stats.resolutionRate).toBeCloseTo(0.75, 5);
  });

  it('returns zero rate (not NaN) when there is no data', () => {
    const stats = getResolutionStats();
    expect(stats.total).toBe(0);
    expect(stats.resolutionRate).toBe(0);
  });

  it('can scope to a single group', () => {
    logAssistantEvent({
      chatJid: 'a',
      groupFolder: 'main',
      isMain: true,
      outcome: 'answered',
    });
    logAssistantEvent({
      chatJid: 'b',
      groupFolder: 'other',
      isMain: false,
      outcome: 'knowledge_gap',
      gapSource: 'heuristic',
    });

    const mainStats = getResolutionStats({ groupFolder: 'main' });
    expect(mainStats.total).toBe(1);
    expect(mainStats.answered).toBe(1);
  });
});

describe('getEventGroupBreakdown', () => {
  it('aggregates per group with a resolution rate per row', () => {
    logAssistantEvent({
      chatJid: 'a',
      groupFolder: 'main',
      groupName: 'Main Group',
      isMain: true,
      outcome: 'answered',
    });
    logAssistantEvent({
      chatJid: 'b',
      groupFolder: 'main',
      groupName: 'Main Group',
      isMain: true,
      outcome: 'knowledge_gap',
      gapSource: 'agent_signal',
    });
    logAssistantEvent({
      chatJid: 'c',
      groupFolder: 'ops',
      groupName: 'Ops',
      isMain: false,
      outcome: 'answered',
    });

    const rows = getEventGroupBreakdown();
    const main = rows.find((r) => r.groupFolder === 'main')!;
    const ops = rows.find((r) => r.groupFolder === 'ops')!;
    expect(main.total).toBe(2);
    expect(main.resolutionRate).toBeCloseTo(0.5, 5);
    expect(ops.total).toBe(1);
    expect(ops.resolutionRate).toBe(1);
  });
});

describe('getTopUnanswered', () => {
  it('groups case/whitespace-insensitively and orders by count desc', () => {
    for (const q of [
      'What is the expense policy?',
      'what is the expense policy?',
      '  WHAT IS THE EXPENSE POLICY?  ',
      'when is the holiday party?',
    ]) {
      logAssistantEvent({
        chatJid: 'jid',
        groupFolder: 'main',
        isMain: true,
        questionText: q,
        outcome: 'knowledge_gap',
        gapSource: 'heuristic',
      });
    }

    const top = getTopUnanswered();
    expect(top[0].count).toBe(3);
    expect(top[0].question.toLowerCase()).toContain('expense policy');
    expect(top[1].count).toBe(1);
  });

  it('excludes rows with redacted-to-null question text', () => {
    process.env.ASSISTANT_ANALYTICS_PRIVACY = 'redacted';
    logAssistantEvent({
      chatJid: 'jid',
      groupFolder: 'main',
      isMain: true,
      questionText: '   ', // trims to empty -> null question_text
      outcome: 'knowledge_gap',
      gapSource: 'heuristic',
    });

    expect(getTopUnanswered()).toHaveLength(0);
  });

  it('only surfaces knowledge_gap outcomes, not answered/error', () => {
    logAssistantEvent({
      chatJid: 'jid',
      groupFolder: 'main',
      isMain: true,
      questionText: 'answered one',
      outcome: 'answered',
    });
    logAssistantEvent({
      chatJid: 'jid',
      groupFolder: 'main',
      isMain: true,
      questionText: 'errored one',
      outcome: 'error',
    });

    expect(getTopUnanswered()).toHaveLength(0);
  });

  it('respects the limit option', () => {
    for (let i = 0; i < 5; i++) {
      logAssistantEvent({
        chatJid: 'jid',
        groupFolder: 'main',
        isMain: true,
        questionText: `unique question ${i}`,
        outcome: 'knowledge_gap',
        gapSource: 'heuristic',
      });
    }
    expect(getTopUnanswered({ limit: 2 })).toHaveLength(2);
  });
});

describe('getEventVolumeByDay', () => {
  it('buckets events by day with per-outcome counts', () => {
    logAssistantEvent({
      chatJid: 'a',
      groupFolder: 'main',
      isMain: true,
      outcome: 'answered',
    });
    logAssistantEvent({
      chatJid: 'b',
      groupFolder: 'main',
      isMain: true,
      outcome: 'knowledge_gap',
      gapSource: 'heuristic',
    });

    const volume = getEventVolumeByDay({ days: 1 });
    expect(volume).toHaveLength(1);
    expect(volume[0].total).toBe(2);
    expect(volume[0].answered).toBe(1);
    expect(volume[0].knowledgeGap).toBe(1);
  });

  it('respects an explicit sinceIso filter', () => {
    logAssistantEvent({
      chatJid: 'a',
      groupFolder: 'main',
      isMain: true,
      outcome: 'answered',
    });
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(getEventVolumeByDay({ sinceIso: future })).toHaveLength(0);
  });
});

describe('getMostActiveGroups', () => {
  it('orders groups by event count desc, preferring display name', () => {
    logAssistantEvent({
      chatJid: 'a',
      groupFolder: 'main',
      groupName: 'Main Group',
      isMain: true,
      outcome: 'answered',
    });
    logAssistantEvent({
      chatJid: 'b',
      groupFolder: 'main',
      groupName: 'Main Group',
      isMain: true,
      outcome: 'answered',
    });
    logAssistantEvent({
      chatJid: 'c',
      groupFolder: 'ops',
      isMain: false,
      outcome: 'answered',
    });

    const active = getMostActiveGroups();
    expect(active[0]).toEqual({ name: 'Main Group', count: 2 });
    expect(active[1]).toEqual({ name: 'ops', count: 1 });
  });
});

describe('getMostActiveUsers', () => {
  it('excludes null/blank sender rows', () => {
    logAssistantEvent({
      chatJid: 'a',
      groupFolder: 'main',
      isMain: true,
      senderName: 'Alice',
      outcome: 'answered',
    });
    logAssistantEvent({
      chatJid: 'b',
      groupFolder: 'main',
      isMain: true,
      outcome: 'answered', // no senderName
    });

    const users = getMostActiveUsers();
    expect(users).toEqual([{ name: 'Alice', count: 1 }]);
  });
});
