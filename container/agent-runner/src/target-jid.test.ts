import { describe, expect, it } from 'vitest';

import { resolveTargetJid } from './target-jid.js';

const GROUP = 'tg:-1001234567890';

describe('resolveTargetJid', () => {
  it('defaults to the current chat when target is omitted or blank', () => {
    expect(resolveTargetJid(undefined, GROUP)).toEqual({
      ok: true,
      jid: GROUP,
    });
    expect(resolveTargetJid('', GROUP)).toEqual({ ok: true, jid: GROUP });
    expect(resolveTargetJid('   ', GROUP)).toEqual({ ok: true, jid: GROUP });
  });

  it('routes the bare id of the current chat to it (the lost 2026-09-12 announcement)', () => {
    expect(resolveTargetJid('-1001234567890', GROUP)).toEqual({
      ok: true,
      jid: GROUP,
    });
    expect(resolveTargetJid(' -1001234567890 ', GROUP)).toEqual({
      ok: true,
      jid: GROUP,
    });
  });

  it('routes the bare id of the current chat even when that id contains colons', () => {
    const teams = 'teams:19:abc123@thread.v2';
    const web = 'web:site1:sess1';
    const signalGroup = 'signal:group:QUJDREVG+/=';
    expect(resolveTargetJid('19:abc123@thread.v2', teams)).toEqual({
      ok: true,
      jid: teams,
    });
    expect(resolveTargetJid('site1:sess1', web)).toEqual({
      ok: true,
      jid: web,
    });
    expect(resolveTargetJid('group:QUJDREVG+/=', signalGroup)).toEqual({
      ok: true,
      jid: signalGroup,
    });
  });

  it('rewrites the spelled-out telegram: prefix', () => {
    expect(resolveTargetJid('telegram:-1001234567890', GROUP)).toEqual({
      ok: true,
      jid: GROUP,
    });
    expect(resolveTargetJid('Telegram:987654321', GROUP)).toEqual({
      ok: true,
      jid: 'tg:987654321',
    });
  });

  it('canonicalizes a known prefix in the wrong case without touching the id', () => {
    expect(resolveTargetJid('TG:-1001', GROUP)).toEqual({
      ok: true,
      jid: 'tg:-1001',
    });
    expect(resolveTargetJid('SLACK:C0ABCDEF', GROUP)).toEqual({
      ok: true,
      jid: 'slack:C0ABCDEF',
    });
  });

  it('passes well-formed jids through untouched', () => {
    expect(resolveTargetJid('tg:987654321', GROUP)).toEqual({
      ok: true,
      jid: 'tg:987654321',
    });
    expect(resolveTargetJid('slack:C0123456789', GROUP)).toEqual({
      ok: true,
      jid: 'slack:C0123456789',
    });
    expect(resolveTargetJid(GROUP, 'tg:987654321')).toEqual({
      ok: true,
      jid: GROUP,
    });
  });

  it('passes WhatsApp jids through, including device jids containing a colon', () => {
    expect(resolveTargetJid('120363@g.us', GROUP)).toEqual({
      ok: true,
      jid: '120363@g.us',
    });
    expect(resolveTargetJid('15551234567:12@s.whatsapp.net', GROUP)).toEqual({
      ok: true,
      jid: '15551234567:12@s.whatsapp.net',
    });
  });

  it('passes unknown prefixes through for other and plugin-registered channels', () => {
    expect(resolveTargetJid('gh:org/repo/12', GROUP)).toEqual({
      ok: true,
      jid: 'gh:org/repo/12',
    });
    expect(resolveTargetJid('dc-dm:123456789', GROUP)).toEqual({
      ok: true,
      jid: 'dc-dm:123456789',
    });
  });

  it('rejects any other bare id and shows the full-JID shapes', () => {
    const r = resolveTargetJid('987654321', GROUP);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('nothing was sent');
      expect(r.error).toContain('"tg:1234567890" (Telegram DM)');
      expect(r.error).toContain('omit target_jid');
    }
  });

  it("doesn't steer a cross-channel send onto the current chat's platform", () => {
    const r = resolveTargetJid('987654321', 'slack:C0123456789');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain('slack:987654321');
  });

  it('rejects a leading-colon value rather than treating it as prefixed', () => {
    expect(resolveTargetJid(':-1001234567890', GROUP).ok).toBe(false);
  });

  it('names the parameter it rejected', () => {
    const r = resolveTargetJid('123', GROUP, 'target_group_jid');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('target_group_jid "123"');
      expect(r.error).toContain('omit target_group_jid');
    }
  });
});
