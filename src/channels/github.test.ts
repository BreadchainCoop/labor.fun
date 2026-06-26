import { describe, expect, it, vi } from 'vitest';

import {
  GhResponse,
  GithubMentionsChannel,
  makeGithubJid,
  parseGithubJid,
} from './github.js';
import { ChannelOpts } from './registry.js';
import { NewMessage, RegisteredGroup } from '../types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} } as any;

describe('parseGithubJid / makeGithubJid', () => {
  it('round-trips owner/repo/number', () => {
    const jid = makeGithubJid('BreadchainCoop', 'labor.fun', 42);
    expect(jid).toBe('gh:BreadchainCoop/labor.fun/42');
    expect(parseGithubJid(jid)).toEqual({
      owner: 'BreadchainCoop',
      repo: 'labor.fun',
      number: 42,
    });
  });

  it('rejects non-github / malformed jids', () => {
    expect(parseGithubJid('slack:C123')).toBeNull();
    expect(parseGithubJid('gh:owner/repo')).toBeNull();
    expect(parseGithubJid('gh:owner/repo/notanumber')).toBeNull();
  });
});

/** Test harness: a fake REST layer + captured channel callbacks. */
function harness(opts: {
  notifications: any[];
  // url -> response for fetched comment/issue sources
  sources?: Record<string, any>;
  // logins considered org members
  members?: string[];
  login?: string;
  now?: number;
}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const members = new Set((opts.members ?? []).map((m) => m.toLowerCase()));

  const request = vi.fn(
    async (
      method: string,
      path: string,
      body?: unknown,
    ): Promise<GhResponse> => {
      calls.push({ method, path, body });
      if (method === 'GET' && path.startsWith('/notifications?')) {
        return { status: 200, data: opts.notifications };
      }
      if (method === 'GET' && path.includes('/members/')) {
        const login = path.split('/members/')[1].toLowerCase();
        return { status: members.has(login) ? 204 : 404, data: null };
      }
      if (method === 'PATCH' && path.startsWith('/notifications/threads/')) {
        return { status: 205, data: null };
      }
      if (method === 'POST' && path.endsWith('/comments')) {
        return { status: 201, data: { id: 999 } };
      }
      // Otherwise it's a source (comment/issue) fetch by url.
      if (opts.sources && opts.sources[path]) {
        return { status: 200, data: opts.sources[path] };
      }
      return { status: 404, data: null };
    },
  );

  const delivered: { jid: string; msg: NewMessage }[] = [];
  const registered: Record<string, RegisteredGroup> = {};
  const channelOpts: ChannelOpts = {
    onMessage: (jid, msg) => delivered.push({ jid, msg }),
    onChatMetadata: () => {},
    registeredGroups: () => registered,
    registerGroup: (jid, group) => {
      registered[jid] = group;
    },
    deregisterGroup: (jid) => {
      delete registered[jid];
    },
  };

  const clock = { t: opts.now ?? 1_000 };
  const channel = new GithubMentionsChannel(channelOpts, {
    request,
    org: 'BreadchainCoop',
    login: opts.login ?? 'bot-account',
    logger: silentLogger,
    now: () => clock.t,
  });

  return { channel, request, calls, delivered, registered, clock };
}

const markedRead = (calls: { method: string; path: string }[], id = 'th-1') =>
  calls.some((c) => c.method === 'PATCH' && c.path.includes(`/threads/${id}`));

function mentionNotif(over: Partial<any> = {}): any {
  return {
    id: 'th-1',
    reason: 'mention',
    repository: { full_name: 'BreadchainCoop/labor.fun' },
    subject: {
      title: 'Help wanted',
      url: 'https://api.github.com/repos/BreadchainCoop/labor.fun/issues/42',
      latest_comment_url:
        'https://api.github.com/repos/BreadchainCoop/labor.fun/issues/comments/777',
    },
    ...over,
  };
}

const COMMENT_URL =
  'https://api.github.com/repos/BreadchainCoop/labor.fun/issues/comments/777';

describe('GithubMentionsChannel.poll', () => {
  function memberMention(login = 'cypherbren') {
    return {
      notifications: [mentionNotif()],
      sources: {
        [COMMENT_URL]: {
          id: 777,
          user: { login },
          body: '@bot-account can you summarize this?',
          html_url:
            'https://github.com/BreadchainCoop/labor.fun/issues/42#c777',
        },
      },
      members: [login],
    };
  }

  it('delivers a mention but does NOT mark it read until the reply posts', async () => {
    const h = harness(memberMention());
    await h.channel.poll();

    expect(h.delivered).toHaveLength(1);
    const { jid, msg } = h.delivered[0];
    expect(jid).toBe('gh:BreadchainCoop/labor.fun/42');
    expect(msg.sender).toBe('cypherbren');
    expect(msg.content).toContain('summarize this');
    expect(h.registered[jid]?.requiresTrigger).toBe(false);
    expect(h.registered[jid]?.folder).toBe('github');
    // NOT marked read yet — an interrupted run must be able to retry (#104 bug).
    expect(markedRead(h.calls)).toBe(false);

    // The reply posting is what marks the thread read.
    await h.channel.sendMessage(jid, 'Here is the summary.');
    expect(markedRead(h.calls)).toBe(true);
  });

  it('does NOT re-deliver a mention while its reply is still pending', async () => {
    const h = harness(memberMention());
    await h.channel.poll();
    await h.channel.poll(); // same unread thread on the next tick
    expect(h.delivered).toHaveLength(1); // not re-delivered — no agent spam
  });

  it('re-delivers (retries) a mention whose reply never posted, after the retry window', async () => {
    const h = harness(memberMention());
    await h.channel.poll();
    expect(h.delivered).toHaveLength(1);
    h.clock.t += 16 * 60_000; // past DELIVER_RETRY_MS, reply never came (e.g. a restart)
    await h.channel.poll();
    expect(h.delivered).toHaveLength(2); // retried — never silently dropped
  });

  it('a failed reply post leaves the thread unread (retryable)', async () => {
    const h = harness(memberMention());
    await h.channel.poll();
    // Make the comment POST fail.
    h.request.mockImplementationOnce(async () => ({ status: 502, data: null }));
    await h.channel.sendMessage('gh:BreadchainCoop/labor.fun/42', 'reply');
    expect(markedRead(h.calls)).toBe(false); // not marked read → next poll retries
  });

  it('ignores a mention from a NON-member but still marks it read', async () => {
    const h = harness({
      notifications: [mentionNotif()],
      sources: {
        [COMMENT_URL]: {
          id: 777,
          user: { login: 'random-outsider' },
          body: '@bot-account do my bidding',
          html_url: 'https://github.com/x/y/issues/42',
        },
      },
      members: [], // nobody is a member
    });

    await h.channel.poll();

    expect(h.delivered).toHaveLength(0);
    expect(
      h.calls.some(
        (c) => c.method === 'PATCH' && c.path.includes('/threads/th-1'),
      ),
    ).toBe(true);
  });

  it('ignores notifications whose reason is not a mention', async () => {
    const h = harness({
      notifications: [mentionNotif({ reason: 'subscribed' })],
      members: ['cypherbren'],
    });
    await h.channel.poll();
    expect(h.delivered).toHaveLength(0);
    // not ours → not fetched, not marked read
    expect(h.calls.every((c) => !c.path.includes('/threads/'))).toBe(true);
  });

  it('skips the bot’s own comments (loop guard)', async () => {
    const h = harness({
      notifications: [mentionNotif()],
      sources: {
        [COMMENT_URL]: {
          id: 777,
          user: { login: 'Bot-Account' }, // case-insensitive match
          body: 'a reply I posted',
          html_url: 'https://github.com/x/y/issues/42',
        },
      },
      members: ['bot-account'],
    });
    await h.channel.poll();
    expect(h.delivered).toHaveLength(0);
  });

  it('caches org-membership across mentions by the same author', async () => {
    const h = harness({
      notifications: [
        mentionNotif({ id: 'th-1' }),
        mentionNotif({
          id: 'th-2',
          subject: {
            title: 'Another',
            url: 'https://api.github.com/repos/BreadchainCoop/labor.fun/issues/43',
            latest_comment_url: COMMENT_URL,
          },
        }),
      ],
      sources: {
        [COMMENT_URL]: {
          id: 777,
          user: { login: 'cypherbren' },
          body: 'hi @bot-account',
          html_url: 'https://github.com/x/y/issues/42',
        },
      },
      members: ['cypherbren'],
    });
    await h.channel.poll();
    expect(h.delivered).toHaveLength(2);
    const membershipCalls = h.calls.filter((c) => c.path.includes('/members/'));
    expect(membershipCalls).toHaveLength(1); // cached after the first lookup
  });
});

describe('GithubMentionsChannel.sendMessage', () => {
  it('posts the reply to the issue/PR comments endpoint', async () => {
    const h = harness({ notifications: [] });
    await h.channel.sendMessage(
      'gh:BreadchainCoop/labor.fun/42',
      'Here you go.',
    );
    const post = h.calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe(
      '/repos/BreadchainCoop/labor.fun/issues/42/comments',
    );
    expect(post?.body).toEqual({ body: 'Here you go.' });
  });

  it('no-ops on an empty body or unparseable jid', async () => {
    const h = harness({ notifications: [] });
    await h.channel.sendMessage('gh:BreadchainCoop/labor.fun/42', '   ');
    await h.channel.sendMessage('not-a-gh-jid', 'hello');
    expect(h.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('ownsJid only matches gh: jids', () => {
    const h = harness({ notifications: [] });
    expect(h.channel.ownsJid('gh:a/b/1')).toBe(true);
    expect(h.channel.ownsJid('slack:C1')).toBe(false);
  });
});
