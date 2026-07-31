import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ASSISTANT_NAME } from './config.js';
import {
  _initTestDatabase,
  completeAgentRun,
  getDb,
  getMessagesSince,
  getRecentMessages,
  logAssistantEvent,
  setRegisteredGroup,
  setRouterState,
  startAgentRun,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import {
  clearInFlightRetentionFloor,
  getInFlightRetentionFloor,
  registerInFlightRetentionFloor,
  runRetentionSweep,
  startRetentionSweeper,
} from './retention.js';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-07-19T12:00:00.000Z');

/** ISO timestamp `hoursAgo` hours before NOW. */
function ago(hoursAgo: number): string {
  return new Date(NOW - hoursAgo * HOUR).toISOString();
}

let seq = 0;
function store(chatJid: string, timestamp: string, content = 'hello world') {
  storeChatMetadata(chatJid, timestamp);
  storeMessage({
    id: `m${++seq}`,
    chat_jid: chatJid,
    sender: 'user1',
    sender_name: 'User One',
    content,
    timestamp,
    is_from_me: false,
  });
}

/** All stored rows for a chat (bot rows included), oldest-first. */
function allRows(chatJid: string) {
  return getRecentMessages(chatJid, 1000);
}

/** Run `fn` with the process clock pinned, so DB writers stamp `at`. */
function atTime<T>(at: string, fn: () => T): T {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(at));
  try {
    return fn();
  } finally {
    vi.useRealTimers();
  }
}

/** A completed agent run recorded at `at` (agent_runs has an FK to chats). */
function completedRun(chatJid: string, at: string, content: string) {
  storeChatMetadata(chatJid, at);
  const id = atTime(at, () =>
    startAgentRun({
      chatJid,
      channel: 'telegram',
      groupName: 'g',
      groupFolder: 'g',
      triggerContent: content,
      messageCount: 1,
    }),
  );
  atTime(at, () => completeAgentRun(id, 'success', 10, 5));
  return id;
}

function countRows(table: 'agent_runs' | 'assistant_events'): number {
  return (
    getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  ).n;
}

function register(jid: string, folder: string) {
  setRegisteredGroup(jid, {
    name: folder,
    folder,
    trigger: '@bot',
    added_at: new Date(NOW).toISOString(),
  });
}

beforeEach(() => {
  _initTestDatabase();
  seq = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runRetentionSweep — age rule', () => {
  it('deletes messages older than the retention window, keeps newer ones', () => {
    // Unregistered chat: no watermark guard applies, only age + 1h floor.
    store('tg:100', ago(50));
    store('tg:100', ago(30));
    store('tg:100', ago(2));

    const res = runRetentionSweep({
      retentionHours: 24,
      maxPerChat: 0,
      now: NOW,
    });

    expect(res.deletedMessages).toBe(2);
    const left = allRows('tg:100');
    expect(left).toHaveLength(1);
    expect(left[0].timestamp).toBe(ago(2));
  });

  it('never deletes rows from the last hour, even beyond the cap/age', () => {
    store('tg:100', ago(0.9)); // 54 minutes old
    store('tg:100', ago(0.8));
    store('tg:100', ago(0.7));

    // Aggressive settings that would otherwise delete the two oldest rows.
    const res = runRetentionSweep({
      retentionHours: 0.5,
      maxPerChat: 1,
      now: NOW,
    });

    expect(res.deletedMessages).toBe(0);
    expect(allRows('tg:100')).toHaveLength(3);
  });
});

describe('runRetentionSweep — per-chat cap', () => {
  it('keeps the newest N messages per chat', () => {
    for (let i = 10; i >= 3; i--) store('tg:200', ago(i)); // 8 rows, 3–10h old
    store('tg:999', ago(9)); // another chat: under its own cap

    const res = runRetentionSweep({
      retentionHours: 0,
      maxPerChat: 3,
      now: NOW,
    });

    expect(res.deletedMessages).toBe(5);
    const left = allRows('tg:200');
    expect(left.map((m) => m.timestamp)).toEqual([ago(5), ago(4), ago(3)]);
    // Other chat untouched (only 1 row, below the cap).
    expect(allRows('tg:999')).toHaveLength(1);
  });
});

describe('runRetentionSweep — disabled (0/0)', () => {
  it('deletes nothing when both knobs are 0', () => {
    store('tg:300', ago(1000));
    const res = runRetentionSweep({
      retentionHours: 0,
      maxPerChat: 0,
      now: NOW,
    });
    expect(res).toEqual({
      deletedMessages: 0,
      chatsSwept: 0,
      deletedAgentRuns: 0,
      deletedAssistantEvents: 0,
    });
    expect(allRows('tg:300')).toHaveLength(1);
  });

  it('startRetentionSweeper is a true no-op (no timer) with default 0/0 config', () => {
    // LABOR_PROFILE=example test env sets neither retention var, so the
    // config-driven entry point must not create any timer.
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const timer = startRetentionSweeper();
    expect(timer).toBeNull();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});

describe('runRetentionSweep — unprocessed-message guard', () => {
  it('does NOT delete a registered chat backlog newer than the processed watermark', () => {
    // Backlog older than retention, but the agent's cursor is even older —
    // these rows are still owed to the poller and must survive.
    register('tg:400', 'group_400');
    store('tg:400', ago(60)); // processed long ago
    store('tg:400', ago(50)); // unprocessed backlog…
    store('tg:400', ago(40));
    setRouterState(
      'last_agent_timestamp',
      JSON.stringify({ 'tg:400': ago(60) }),
    );

    const res = runRetentionSweep({
      retentionHours: 24,
      maxPerChat: 0,
      now: NOW,
    });

    // Only the processed row (at the watermark) is deletable.
    expect(res.deletedMessages).toBe(1);
    const left = allRows('tg:400');
    expect(left.map((m) => m.timestamp)).toEqual([ago(50), ago(40)]);
    // The poller can still fetch the surviving backlog since its cursor.
    expect(getMessagesSince('tg:400', ago(60), ASSISTANT_NAME)).toHaveLength(2);
  });

  it('falls back to the last bot reply as watermark, and skips registered chats with neither', () => {
    // Chat A: no cursor in router_state, but the bot replied at ago(30) —
    // same recovery rule the poller uses (getOrRecoverCursor).
    register('tg:500', 'group_500');
    store('tg:500', ago(60));
    storeMessage({
      id: 'bot1',
      chat_jid: 'tg:500',
      sender: 'bot',
      sender_name: ASSISTANT_NAME,
      content: 'done',
      timestamp: ago(30),
      is_from_me: true,
      is_bot_message: true,
    });
    store('tg:500', ago(28)); // arrived after the bot reply → unprocessed

    // Chat B: registered, never processed, no bot reply → fully skipped.
    register('tg:600', 'group_600');
    store('tg:600', ago(200));

    const res = runRetentionSweep({
      retentionHours: 24,
      maxPerChat: 0,
      now: NOW,
    });

    expect(res.deletedMessages).toBe(2); // ago(60) + the bot row itself
    expect(allRows('tg:500').map((m) => m.timestamp)).toEqual([ago(28)]);
    expect(allRows('tg:600')).toHaveLength(1);
  });
});

describe('runRetentionSweep — content-bearing side tables', () => {
  it('age-prunes agent_runs.trigger_content and assistant_events.question_text', () => {
    // Both tables copy message text (trigger_content / question_text), so
    // retention must bound them or content outlives the messages table.
    completedRun('tg:800', ago(50), 'ancient question?');
    completedRun('tg:800', ago(2), 'recent question?');
    atTime(ago(50), () =>
      logAssistantEvent({
        chatJid: 'tg:800',
        groupFolder: 'g',
        isMain: true,
        questionText: 'ancient question?',
        outcome: 'answered',
      }),
    );
    atTime(ago(2), () =>
      logAssistantEvent({
        chatJid: 'tg:800',
        groupFolder: 'g',
        isMain: true,
        questionText: 'recent question?',
        outcome: 'answered',
      }),
    );

    const res = runRetentionSweep({
      retentionHours: 24,
      maxPerChat: 0,
      now: NOW,
    });

    expect(res.deletedAgentRuns).toBe(1);
    expect(res.deletedAssistantEvents).toBe(1);
    expect(countRows('agent_runs')).toBe(1);
    expect(countRows('assistant_events')).toBe(1);
    const runs = getDb()
      .prepare(`SELECT trigger_content AS c FROM agent_runs`)
      .all() as Array<{ c: string }>;
    expect(runs.map((r) => r.c)).toEqual(['recent question?']);
  });

  it('spares a still-running agent run row (its completion must find it)', () => {
    storeChatMetadata('tg:810', ago(50));
    atTime(ago(50), () =>
      startAgentRun({
        chatJid: 'tg:810',
        channel: 'telegram',
        groupName: 'g',
        groupFolder: 'g',
        triggerContent: 'long-running',
        messageCount: 1,
      }),
    );

    const res = runRetentionSweep({
      retentionHours: 24,
      maxPerChat: 0,
      now: NOW,
    });

    expect(res.deletedAgentRuns).toBe(0);
    expect(countRows('agent_runs')).toBe(1);
  });

  it('leaves the side tables alone when only the per-chat cap is set', () => {
    // The cap is a messages-only rule — there is no per-chat ordering to
    // apply to the run/analytics logs, so only the age rule prunes them.
    for (let i = 10; i >= 3; i--) store('tg:820', ago(i));
    completedRun('tg:820', ago(50), 'old');
    atTime(ago(50), () =>
      logAssistantEvent({
        chatJid: 'tg:820',
        groupFolder: 'g',
        isMain: true,
        questionText: 'old?',
        outcome: 'answered',
      }),
    );

    const res = runRetentionSweep({
      retentionHours: 0,
      maxPerChat: 3,
      now: NOW,
    });

    expect(res.deletedMessages).toBe(5);
    expect(res.deletedAgentRuns).toBe(0);
    expect(res.deletedAssistantEvents).toBe(0);
    expect(countRows('agent_runs')).toBe(1);
    expect(countRows('assistant_events')).toBe(1);
  });
});

describe('runRetentionSweep — in-flight dispatch floor', () => {
  // src/index.ts advances the persisted cursor at DISPATCH and rolls it back
  // when the run errors without sending output. Mid-run the watermark
  // therefore over-reports progress; the in-flight floor pins the sweeper to
  // the pre-dispatch cursor so a rollback never retries deleted rows.
  const JID = 'tg:900';

  afterEach(() => clearInFlightRetentionFloor(JID));

  function seedDispatchedRun() {
    register(JID, 'group_900');
    store(JID, ago(60)); // processed before this run
    store(JID, ago(50)); // the dispatched batch — rollback would retry these
    store(JID, ago(40));
    // Cursor as persisted AT DISPATCH (advanced to the batch's last message).
    setRouterState('last_agent_timestamp', JSON.stringify({ [JID]: ago(40) }));
  }

  it('does NOT delete rows a dispatched run could still roll back to', () => {
    seedDispatchedRun();
    registerInFlightRetentionFloor(JID, ago(60)); // pre-dispatch cursor

    const res = runRetentionSweep({
      retentionHours: 24,
      maxPerChat: 0,
      now: NOW,
    });

    expect(res.deletedMessages).toBe(1); // only the pre-dispatch row
    expect(allRows(JID).map((m) => m.timestamp)).toEqual([ago(50), ago(40)]);
    // A rollback to the pre-dispatch cursor still finds the whole batch.
    expect(getMessagesSince(JID, ago(60), ASSISTANT_NAME)).toHaveLength(2);
  });

  it('deletes the batch once the run completes and the floor is cleared', () => {
    seedDispatchedRun();
    registerInFlightRetentionFloor(JID, ago(60));
    runRetentionSweep({ retentionHours: 24, maxPerChat: 0, now: NOW });

    clearInFlightRetentionFloor(JID); // run finished — no rollback possible
    const res = runRetentionSweep({
      retentionHours: 24,
      maxPerChat: 0,
      now: NOW,
    });

    expect(res.deletedMessages).toBe(2);
    expect(allRows(JID)).toHaveLength(0);
  });

  it('lower-wins: a later advance in the same run cannot raise the floor', () => {
    // The message loop's pipe path advances the cursor again mid-run; the
    // rollback target is still the FIRST pre-dispatch value.
    registerInFlightRetentionFloor(JID, ago(60));
    registerInFlightRetentionFloor(JID, ago(40));
    expect(getInFlightRetentionFloor(JID)).toBe(ago(60));

    // An empty pre-dispatch cursor (no prior run) blocks the chat entirely.
    registerInFlightRetentionFloor(JID, '');
    expect(getInFlightRetentionFloor(JID)).toBe('');

    clearInFlightRetentionFloor(JID);
    expect(getInFlightRetentionFloor(JID)).toBeUndefined();
  });

  it('an empty in-flight floor protects the whole chat while the run is live', () => {
    register(JID, 'group_900');
    store(JID, ago(60));
    store(JID, ago(50));
    setRouterState('last_agent_timestamp', JSON.stringify({ [JID]: ago(50) }));
    registerInFlightRetentionFloor(JID, ''); // first-ever run for this chat

    const res = runRetentionSweep({
      retentionHours: 24,
      maxPerChat: 0,
      now: NOW,
    });

    expect(res.deletedMessages).toBe(0);
    expect(allRows(JID)).toHaveLength(2);
  });
});

describe('runRetentionSweep — log hygiene', () => {
  it('logs counts only, never message content', () => {
    const secret = 'SUPER-SECRET-PAYLOAD-42';
    store('tg:700', ago(50), secret);
    store('tg:700', ago(2), 'recent');

    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      });
    runRetentionSweep({ retentionHours: 24, maxPerChat: 0, now: NOW });
    spy.mockRestore();

    const logged = writes.join('');
    expect(logged).toContain('retention: swept expired messages');
    expect(logged).toContain('deletedMessages');
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain('recent');
  });
});
