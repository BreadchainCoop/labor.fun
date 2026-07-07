import { describe, it, expect } from 'vitest';

import { buildBatchSenderContext, platformForChatJid } from './index.js';
import { NewMessage } from './types.js';

function msg(sender: string, is_from_me = false): NewMessage {
  return {
    id: `${sender}-${Math.random()}`,
    chat_jid: 'slack:C1',
    sender,
    sender_name: sender,
    content: 'hi',
    timestamp: new Date().toISOString(),
    is_from_me,
  };
}

// A stub resolver so the test needs no KB/database.
const resolve = (id: string) =>
  id.startsWith('U_')
    ? { user_id: id.slice(2).toLowerCase(), display_name: id, tags: [] }
    : undefined;

describe('platformForChatJid', () => {
  it('maps known prefixes and defaults unknown', () => {
    expect(platformForChatJid('tg:123')).toBe('telegram');
    expect(platformForChatJid('slack:C1')).toBe('slack');
    expect(platformForChatJid('dc:9')).toBe('unknown');
    expect(platformForChatJid('9999@g.us')).toBe('unknown');
  });
});

describe('buildBatchSenderContext', () => {
  it('returns null when nothing resolves (fail closed → caller unlinks)', () => {
    const ctx = buildBatchSenderContext(
      [msg('UNKNOWN1'), msg('UNKNOWN2')],
      'slack',
      resolve,
    );
    expect(ctx).toBeNull();
  });

  it('collects EVERY distinct resolved sender into the roster', () => {
    const ctx = buildBatchSenderContext(
      [msg('U_ALICE'), msg('U_BOB'), msg('U_ALICE')],
      'slack',
      resolve,
    )!;
    expect(ctx.senders.map((s) => s.platform_sender_id)).toEqual([
      'U_ALICE',
      'U_BOB',
    ]);
    // Back-compat top-level identity == the LAST distinct sender (Bob).
    expect(ctx.user_id).toBe('bob');
  });

  it('drops unresolved and own-messages, keeps only allowlisted humans', () => {
    const ctx = buildBatchSenderContext(
      [msg('U_ALICE'), msg('UNKNOWN'), msg('BOT', true), msg('U_BOB')],
      'slack',
      resolve,
    )!;
    expect(ctx.senders.map((s) => s.user_id)).toEqual(['alice', 'bob']);
  });

  it('a single-sender batch yields a one-element roster (unambiguous)', () => {
    const ctx = buildBatchSenderContext([msg('U_BOB')], 'slack', resolve)!;
    expect(ctx.senders).toHaveLength(1);
    expect(ctx.senders[0].platform_sender_id).toBe('U_BOB');
    expect(ctx.user_id).toBe('bob');
  });
});
