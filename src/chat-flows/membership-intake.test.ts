import { describe, it, expect } from 'vitest';

import {
  INTAKE_ALLOWED_TOOLS,
  INTAKE_SYSTEM_PROMPT,
  MEMBERSHIP_INTEREST_SENTINEL,
  hasInterestSentinel,
  stripInterestSentinel,
  buildMembershipRecord,
  buildInterestNotice,
  membershipRecordId,
  type MembershipInterest,
} from './membership-intake.js';

const interest: MembershipInterest = {
  senderId: 'discord:123',
  senderName: 'Alice',
  chatJid: 'dc:999',
  at: '2026-06-10T12:00:00.000Z',
  context: 'I would love to join and help with design',
};

describe('intake tool sandbox', () => {
  it('allows only read-only tools — no write/exec/IPC/integration tools', () => {
    expect(INTAKE_ALLOWED_TOOLS).toEqual(['Read', 'Glob', 'Grep', 'WebFetch']);
    for (const banned of [
      'Bash',
      'Write',
      'Edit',
      'Task',
      'mcp__nanoclaw__*',
      'mcp__github__*',
      'mcp__gws__*',
    ]) {
      expect(INTAKE_ALLOWED_TOOLS).not.toContain(banned);
    }
  });

  it('the persona documents the sentinel and treats input as untrusted', () => {
    expect(INTAKE_SYSTEM_PROMPT).toContain(MEMBERSHIP_INTEREST_SENTINEL);
    expect(INTAKE_SYSTEM_PROMPT.toLowerCase()).toContain('untrusted');
  });
});

describe('interest sentinel', () => {
  it('detects the sentinel on its own line', () => {
    expect(
      hasInterestSentinel(`Welcome!\n${MEMBERSHIP_INTEREST_SENTINEL}`),
    ).toBe(true);
    expect(hasInterestSentinel('just a question')).toBe(false);
  });

  it('strips the sentinel from the user-facing reply', () => {
    const out = stripInterestSentinel(
      `Great to have you!\n${MEMBERSHIP_INTEREST_SENTINEL}`,
    );
    expect(out).toBe('Great to have you!');
    expect(out).not.toContain(MEMBERSHIP_INTEREST_SENTINEL);
  });
});

describe('membership record', () => {
  it('builds a record attributed to the real sender', () => {
    const md = buildMembershipRecord(interest);
    expect(md).toContain('type: membership-interest');
    expect(md).toContain('Alice');
    expect(md).toContain('discord:123');
    expect(md).toContain('visibility: restricted');
    expect(md).toContain('I would love to join');
  });

  it('builds a stable filename id from date + sender', () => {
    expect(membershipRecordId(interest)).toBe('MEMBER-2026-06-10-discord-123');
  });

  it('builds a one-line onboarding notice', () => {
    expect(buildInterestNotice(interest)).toContain('Alice');
    expect(buildInterestNotice(interest)).toContain('membership interest');
  });
});
