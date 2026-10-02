import { describe, it, expect } from 'vitest';

import {
  isDuplicateOfSentText,
  normalizeReply,
  sameChatSendText,
} from './duplicate-reply.js';

describe('sameChatSendText', () => {
  const send = (input: unknown) => ({
    type: 'tool_use',
    name: 'mcp__nanoclaw__send_message',
    input,
  });

  it('returns the text of a same-chat send', () => {
    expect(sameChatSendText(send({ text: 'hello' }))).toBe('hello');
  });

  it('ignores cross-channel sends', () => {
    expect(sameChatSendText(send({ text: 'hi', target_jid: 'tg:1' }))).toBe(
      null,
    );
  });

  it('ignores other tools, text blocks and malformed input', () => {
    expect(
      sameChatSendText({
        type: 'tool_use',
        name: 'Bash',
        input: { text: 'x' },
      }),
    ).toBe(null);
    expect(sameChatSendText({ type: 'text' })).toBe(null);
    expect(sameChatSendText(send(undefined))).toBe(null);
    expect(sameChatSendText(send({ text: 42 }))).toBe(null);
    expect(sameChatSendText(undefined)).toBe(null);
  });
});

describe('normalizeReply', () => {
  it('strips internal blocks and collapses whitespace like the orchestrator', () => {
    expect(
      normalizeReply('  <internal>plan</internal>Done.\n\n  All   set. '),
    ).toBe('Done. All set.');
  });
});

describe('isDuplicateOfSentText', () => {
  it('flags a final reply that repeats a sent message', () => {
    expect(
      isDuplicateOfSentText('The answer is 4.', ['The answer is 4.']),
    ).toBe(true);
  });

  it('treats whitespace and internal blocks as insignificant', () => {
    expect(
      isDuplicateOfSentText('<internal>check</internal>The answer\nis 4.', [
        'The answer is 4.  ',
      ]),
    ).toBe(true);
  });

  it('matches any send in the turn', () => {
    expect(
      isDuplicateOfSentText('Here it is.', ['On it…', 'Here it is.']),
    ).toBe(true);
  });

  // Regression: an acknowledgement followed by a real answer with no tool use
  // in between must still deliver the answer.
  it('delivers an answer that follows a different acknowledgement', () => {
    expect(isDuplicateOfSentText('The answer is 4.', ['On it…'])).toBe(false);
  });

  it('never flags empty or internal-only output', () => {
    expect(isDuplicateOfSentText('', [''])).toBe(false);
    expect(isDuplicateOfSentText(null, ['x'])).toBe(false);
    expect(isDuplicateOfSentText('<internal>x</internal>', [''])).toBe(false);
  });

  it('delivers when nothing was sent this turn', () => {
    expect(isDuplicateOfSentText('Hello.', [])).toBe(false);
  });
});
