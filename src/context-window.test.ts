import { describe, it, expect } from 'vitest';

import { selectPromptMessages } from './context-window.js';
import { NewMessage } from './types.js';

function msg(id: string): NewMessage {
  return {
    id,
    chat_jid: 'dc:1',
    sender: 'u',
    sender_name: 'User',
    content: id,
    timestamp: `2026-07-03T00:00:0${id}.000Z`,
  };
}

describe('selectPromptMessages', () => {
  const since = [msg('8'), msg('9')];
  const recent = [msg('1'), msg('2'), msg('3'), msg('4'), msg('8'), msg('9')];

  it('resumed session: sends only the since-cursor messages (transcript has the rest)', () => {
    expect(selectPromptMessages(true, since, recent)).toBe(since);
  });

  it('fresh session: backfills the richer recent history', () => {
    expect(selectPromptMessages(false, since, recent)).toBe(recent);
  });

  it('fresh session but no extra history: falls back to since-cursor', () => {
    // recent no longer than since — nothing to gain; keep the triggering msgs.
    expect(selectPromptMessages(false, since, [msg('9')])).toBe(since);
    expect(selectPromptMessages(false, since, [])).toBe(since);
  });

  it('never returns fewer messages than the since-cursor slice', () => {
    const out = selectPromptMessages(false, since, [msg('9')]);
    expect(out.length).toBeGreaterThanOrEqual(since.length);
  });
});
