import { describe, it, expect } from 'vitest';

import {
  approvalRequestResult,
  gatedActionClassesEnv,
  parseGatedActionClasses,
} from './approval-gate.js';

describe('parseGatedActionClasses', () => {
  it('returns null when the host did not set the list', () => {
    expect(parseGatedActionClasses(undefined)).toBeNull();
  });

  it('splits, trims and drops empties', () => {
    expect(parseGatedActionClasses(' github_write, payout ,,')).toEqual([
      'github_write',
      'payout',
    ]);
    expect(parseGatedActionClasses('')).toEqual([]);
  });
});

describe('approvalRequestResult', () => {
  const gated = ['github_write', 'kb_delete'];

  it('tells the agent to proceed for an ungated class', () => {
    const text = approvalRequestResult('github_review', gated);
    expect(text).toMatch(/No approval needed/);
    expect(text).toMatch(/Proceed with the action now/);
  });

  it('tells the agent to stop for a gated class', () => {
    const text = approvalRequestResult('github_write', gated);
    expect(text).toMatch(/is a gated action class/);
    expect(text).toMatch(/STOP/);
  });

  it('matches the class after trimming', () => {
    expect(approvalRequestResult(' kb_delete ', gated)).toMatch(/STOP/);
  });

  it('keeps the non-committal reply when the list is unknown', () => {
    expect(approvalRequestResult('github_review', null)).toMatch(
      /If this class is gated/,
    );
  });
});

describe('gatedActionClassesEnv', () => {
  it('forwards the variable when set, even when empty', () => {
    expect(
      gatedActionClassesEnv({ NANOCLAW_GATED_ACTION_CLASSES: 'a,b' }),
    ).toEqual({ NANOCLAW_GATED_ACTION_CLASSES: 'a,b' });
    expect(
      gatedActionClassesEnv({ NANOCLAW_GATED_ACTION_CLASSES: '' }),
    ).toEqual({ NANOCLAW_GATED_ACTION_CLASSES: '' });
  });

  it('forwards nothing when unset', () => {
    expect(gatedActionClassesEnv({})).toEqual({});
  });
});
