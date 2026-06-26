import { afterEach, describe, expect, it } from 'vitest';

import {
  _clearChatFlows,
  findChatFlow,
  registerChatFlow,
  type ChatFlow,
} from './registry.js';

function makeFlow(name: string, jids: string[]): ChatFlow {
  return {
    name,
    matches: (jid) => jids.includes(jid),
    allowedTools: ['Read'],
    systemPrompt: 'persona',
    onAgentResult: async (output) => output,
  };
}

describe('chat-flow registry', () => {
  afterEach(() => _clearChatFlows());

  it('finds the flow claiming a JID, none otherwise', () => {
    registerChatFlow(makeFlow('intake', ['dc:123']));
    expect(findChatFlow('dc:123')?.name).toBe('intake');
    expect(findChatFlow('dc:999')).toBeUndefined();
  });

  it('first registered flow wins when several match', () => {
    registerChatFlow(makeFlow('first', ['dc:1']));
    registerChatFlow(makeFlow('second', ['dc:1']));
    expect(findChatFlow('dc:1')?.name).toBe('first');
  });

  it('re-registering the same name overwrites in place', () => {
    registerChatFlow(makeFlow('intake', ['dc:1']));
    registerChatFlow(makeFlow('intake', ['dc:2']));
    expect(findChatFlow('dc:1')).toBeUndefined();
    expect(findChatFlow('dc:2')?.name).toBe('intake');
  });
});
