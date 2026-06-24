import { describe, it, expect } from 'vitest';

import { classifyDeliverability, jidPlatform } from './ipc-delivery.js';

describe('jidPlatform', () => {
  it('maps known prefixes to platform names', () => {
    expect(jidPlatform('tg:123456')).toBe('Telegram');
    expect(jidPlatform('slack:C0123456789')).toBe('Slack');
    expect(jidPlatform('dc:998877')).toBe('Discord');
  });

  it('recognizes WhatsApp JIDs by suffix', () => {
    expect(jidPlatform('120363012345678901@g.us')).toBe('WhatsApp');
    expect(jidPlatform('15551234567@s.whatsapp.net')).toBe('WhatsApp');
  });

  it('returns null for unrecognized JIDs', () => {
    expect(jidPlatform('unknown:999')).toBeNull();
    expect(jidPlatform('garbage')).toBeNull();
  });
});

describe('classifyDeliverability', () => {
  it('is deliverable when a connected channel can route the JID', () => {
    // Registration status is irrelevant once a channel can route it — the
    // framework intentionally supports cross-channel sends to raw JIDs that
    // aren't registered groups.
    expect(
      classifyDeliverability('tg:123', {
        hasChannel: true,
        isRegistered: true,
      }),
    ).toEqual({ deliverable: true });
    expect(
      classifyDeliverability('tg:123', {
        hasChannel: true,
        isRegistered: false,
      }),
    ).toEqual({ deliverable: true });
  });

  it('rejects an unroutable target and names the platform (the #95 incident)', () => {
    // Escalating to Slack on a deployment with no Slack channel: this used to
    // succeed silently. Now it must be classified undeliverable with a clear,
    // actionable reason.
    const verdict = classifyDeliverability('slack:C0123456789', {
      hasChannel: false,
      isRegistered: false,
    });
    expect(verdict.deliverable).toBe(false);
    if (verdict.deliverable) throw new Error('expected undeliverable');
    expect(verdict.reason).toContain('slack:C0123456789');
    expect(verdict.reason).toContain('Slack messages');
    expect(verdict.reason).toContain('no connected channel');
    // Unregistered targets get the "is it configured / correct?" hint.
    expect(verdict.reason).toContain('configured');
  });

  it('distinguishes a registered chat whose channel is down', () => {
    const verdict = classifyDeliverability('tg:42', {
      hasChannel: false,
      isRegistered: true,
    });
    expect(verdict.deliverable).toBe(false);
    if (verdict.deliverable) throw new Error('expected undeliverable');
    expect(verdict.reason).toContain('registered');
    expect(verdict.reason).toContain('not connected');
    expect(verdict.reason).toContain('Telegram messages');
  });

  it('falls back to a generic destination for unrecognized JIDs', () => {
    const verdict = classifyDeliverability('unknown:999', {
      hasChannel: false,
      isRegistered: false,
    });
    expect(verdict.deliverable).toBe(false);
    if (verdict.deliverable) throw new Error('expected undeliverable');
    expect(verdict.reason).toContain('that destination');
  });

  it('produces a reason that embeds cleanly in a source-chat notice', () => {
    const verdict = classifyDeliverability('slack:CXXX', {
      hasChannel: false,
      isRegistered: false,
    });
    if (verdict.deliverable) throw new Error('expected undeliverable');
    // Mirrors the watcher's `Your message ${reason}.` phrasing — the clause
    // has no leading capital and no trailing period so it reads naturally.
    const notice = `Your message ${verdict.reason}.`;
    expect(notice).toContain("Your message couldn't be delivered to");
    expect(notice.endsWith('.')).toBe(true);
    expect(verdict.reason.endsWith('.')).toBe(false);
  });
});
