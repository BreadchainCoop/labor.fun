/**
 * GitHub mentions channel — the bot's INBOUND GitHub trigger.
 *
 * Polls the authenticated account's GitHub notifications and, when someone
 * @-mentions the bot in an issue / PR / comment, routes that mention into the
 * agent like any other inbound message. The agent's reply is posted straight
 * back into the same thread as a GitHub comment (this channel's sendMessage).
 *
 * AUTHORIZATION: only members of the configured GitHub org (`GITHUB_ORG`, i.e.
 * the active profile's `githubOrg`) can trigger a response. A mention from a
 * non-member is acknowledged (marked read so we don't re-evaluate it) and
 * dropped — outsiders cannot make the bot act. This is the whole point of the
 * feature gate: a public repo means anyone can @-mention you, but only the
 * co-op should be able to drive the agent.
 *
 * Design mirrors the email poller (recurring poll + deliver) and the Discord
 * DM auto-registration (an inbound from an authorized principal lazily
 * registers a group so the message loop will act on it). The bot's account
 * needs `notifications`/`repo` (read notifications + comment) and `read:org`
 * (membership check) on its PAT — the same `GITHUB_PERSONAL_ACCESS_TOKEN` the
 * github MCP server and project-sync already use. For mention detection to be
 * meaningful the PAT should belong to a DEDICATED bot account, since the
 * notifications API reports mentions of the *authenticated user*.
 *
 * Opt-in: disabled unless `GITHUB_MENTIONS_ENABLED` is truthy (a token alone
 * isn't enough — it's shared with other GitHub features that must not start a
 * notifications poller everywhere).
 */
import { GITHUB_ORG } from '../config.js';
import { getGitHubToken } from '../integrations/github-projects.js';
import { logger as rootLogger } from '../logger.js';
import { ChannelOpts } from './registry.js';
import { registerChannel } from './registry.js';
import { Channel, NewMessage, RegisteredGroup, SendMessageOpts } from '../types.js';

const GH_API = 'https://api.github.com';
const JID_PREFIX = 'gh:';
/** Shared workspace folder for all GitHub threads (per-thread jids keep their
 * own message history in the DB; the folder is just the agent's workspace). */
const GH_GROUP_FOLDER = 'github';
const POLL_INTERVAL_MS = 60_000;
/** Notification `reason`s that mean "the bot was tagged". */
const MENTION_REASONS = new Set(['mention', 'team_mention']);
/** Org-membership lookups are stable; cache them briefly so a busy thread
 * doesn't hammer the API, while still picking up membership changes. */
const MEMBERSHIP_TTL_MS = 10 * 60_000;
/** Defensive cap so one poll can't fan out unboundedly. */
const MAX_PER_POLL = 20;

export interface GithubJid {
  owner: string;
  repo: string;
  number: number;
}

/** `gh:owner/repo/123` → parts (null if it isn't a well-formed GitHub jid). */
export function parseGithubJid(jid: string): GithubJid | null {
  if (!jid.startsWith(JID_PREFIX)) return null;
  const rest = jid.slice(JID_PREFIX.length);
  const m = rest.match(/^([^/]+)\/([^/]+)\/(\d+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

export function makeGithubJid(owner: string, repo: string, number: number): string {
  return `${JID_PREFIX}${owner}/${repo}/${number}`;
}

/** Result of one HTTP call: status + parsed JSON body (null on empty/204). */
export interface GhResponse {
  status: number;
  data: any;
}
export type GhRequest = (
  method: string,
  pathOrUrl: string,
  body?: unknown,
) => Promise<GhResponse>;

interface GithubChannelDeps {
  request: GhRequest;
  org: string;
  /** Authenticated bot login — used to skip the bot's own comments. */
  login: string;
  logger?: typeof rootLogger;
  now?: () => number;
  pollIntervalMs?: number;
}

export class GithubMentionsChannel implements Channel {
  readonly name = 'github';
  private opts: ChannelOpts;
  private deps: GithubChannelDeps;
  private log: typeof rootLogger;
  private now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private connected = false;
  private polling = false;
  private membership = new Map<string, { member: boolean; at: number }>();

  constructor(opts: ChannelOpts, deps: GithubChannelDeps) {
    this.opts = opts;
    this.deps = deps;
    this.log = deps.logger ?? rootLogger;
    this.now = deps.now ?? Date.now;
  }

  async connect(): Promise<void> {
    this.connected = true;
    // Resolve the bot's own login so we can skip its own comments (loop guard).
    if (!this.deps.login) {
      try {
        const me = await this.deps.request('GET', '/user');
        if (me.status < 300 && me.data?.login) this.deps.login = me.data.login;
      } catch (err) {
        this.log.warn({ err }, 'GitHub mentions: could not resolve bot login');
      }
    }
    this.log.info(
      { org: this.deps.org, login: this.deps.login },
      'GitHub mentions channel connected — polling notifications',
    );
    await this.poll();
    const interval = this.deps.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.timer = setInterval(() => {
      this.poll().catch((err) =>
        this.log.error({ err }, 'GitHub mentions poll failed'),
      );
    }, interval);
    this.timer.unref?.();
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Post the agent's reply back into the issue/PR thread as a comment. */
  async sendMessage(jid: string, text: string, _opts?: SendMessageOpts): Promise<void> {
    const parts = parseGithubJid(jid);
    if (!parts) {
      this.log.warn({ jid }, 'GitHub sendMessage: unparseable jid');
      return;
    }
    if (!text.trim()) return;
    // The issues comment endpoint works for both issues AND pull requests.
    const path = `/repos/${parts.owner}/${parts.repo}/issues/${parts.number}/comments`;
    const res = await this.deps.request('POST', path, { body: text });
    if (res.status >= 300) {
      this.log.error(
        { jid, status: res.status },
        'GitHub sendMessage: comment post failed',
      );
    }
  }

  /** One polling pass over unread, participating notifications. */
  async poll(): Promise<void> {
    if (this.polling) return; // never overlap a slow poll with the next tick
    this.polling = true;
    try {
      const res = await this.deps.request(
        'GET',
        '/notifications?all=false&participating=true&per_page=50',
      );
      if (res.status === 401 || res.status === 403) {
        this.log.warn(
          { status: res.status },
          'GitHub mentions: token lacks notifications/read:org scope — disabling poll',
        );
        await this.disconnect();
        return;
      }
      if (res.status >= 300 || !Array.isArray(res.data)) return;

      const threads = res.data
        .filter((n: any) => MENTION_REASONS.has(n?.reason))
        .slice(0, MAX_PER_POLL);

      for (const n of threads) {
        try {
          await this.processThread(n);
        } catch (err) {
          // Leave unread so the next poll retries this thread.
          this.log.error(
            { err, threadId: n?.id },
            'GitHub mentions: thread processing failed',
          );
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async processThread(n: any): Promise<void> {
    const fullName: string = n?.repository?.full_name ?? '';
    const [owner, repo] = fullName.split('/');
    const subjectUrl: string = n?.subject?.latest_comment_url || n?.subject?.url || '';
    const number = Number(n?.subject?.url?.split('/').pop());
    if (!owner || !repo || !Number.isInteger(number) || !subjectUrl) {
      await this.markRead(n.id);
      return;
    }

    // Fetch the triggering comment/issue to learn the author + body.
    const src = await this.deps.request('GET', subjectUrl);
    if (src.status >= 300 || !src.data) {
      await this.markRead(n.id);
      return;
    }
    const author: string = src.data.user?.login ?? '';
    const body: string = src.data.body ?? '';
    const htmlUrl: string = src.data.html_url ?? '';
    const title: string = n?.subject?.title ?? `${repo}#${number}`;

    // Never react to our own comments (loop guard).
    if (!author || author.toLowerCase() === this.deps.login.toLowerCase()) {
      await this.markRead(n.id);
      return;
    }

    // AUTHORIZATION: only org members can trigger a response.
    if (!(await this.isOrgMember(author))) {
      this.log.info(
        { author, repo: fullName, number },
        'GitHub mention from non-org-member — ignoring',
      );
      await this.markRead(n.id);
      return;
    }

    const jid = makeGithubJid(owner, repo, number);
    const ts = new Date(this.now()).toISOString();
    this.opts.onChatMetadata(jid, ts, `${fullName}#${number}`, 'github', true);

    // Lazily register the GitHub group so the message loop will act on it.
    // requiresTrigger:false — the @-mention IS the explicit ask.
    if (!this.opts.registeredGroups()[jid]) {
      const group: RegisteredGroup = {
        name: `GitHub ${fullName}#${number}`,
        folder: GH_GROUP_FOLDER,
        trigger: `@${this.deps.login}`,
        added_at: ts,
        requiresTrigger: false,
      };
      this.opts.registerGroup(jid, group);
    }

    const msg: NewMessage = {
      id: `gh-${n.id}-${src.data.id ?? number}`,
      chat_jid: jid,
      sender: author,
      sender_name: author,
      content:
        `GitHub: @${author} mentioned you in ${fullName}#${number} — "${title}"\n\n` +
        `${body}\n\n` +
        `(Reply with a GitHub comment. Thread: ${htmlUrl})`,
      timestamp: ts,
    };
    this.log.info(
      { jid, author, repo: fullName, number },
      'GitHub mention from org member — delivering to agent',
    );
    this.opts.onMessage(jid, msg);
    await this.markRead(n.id);
  }

  /** Cached org-membership check. GET /orgs/{org}/members/{user} → 204 member. */
  private async isOrgMember(login: string): Promise<boolean> {
    const key = login.toLowerCase();
    const cached = this.membership.get(key);
    if (cached && this.now() - cached.at < MEMBERSHIP_TTL_MS) {
      return cached.member;
    }
    let member = false;
    try {
      const res = await this.deps.request(
        'GET',
        `/orgs/${this.deps.org}/members/${login}`,
      );
      member = res.status === 204;
    } catch (err) {
      this.log.warn({ err, login }, 'GitHub org-membership check failed');
      member = false;
    }
    this.membership.set(key, { member, at: this.now() });
    return member;
  }

  private async markRead(threadId: string): Promise<void> {
    try {
      await this.deps.request('PATCH', `/notifications/threads/${threadId}`);
    } catch (err) {
      this.log.debug({ err, threadId }, 'GitHub mentions: mark-read failed');
    }
  }
}

/** Build a token-authenticated GitHub REST request function. */
export function makeGhRequest(token: string): GhRequest {
  return async (method, pathOrUrl, body) => {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GH_API}${pathOrUrl}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'nanoclaw-github-channel',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data: any = null;
    if (res.status !== 204) {
      const text = await res.text();
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
    }
    return { status: res.status, data };
  };
}

registerChannel('github', (opts: ChannelOpts): Channel | null => {
  const enabled = (process.env.GITHUB_MENTIONS_ENABLED || '').toLowerCase();
  if (enabled !== 'true' && enabled !== '1') return null;

  const token = getGitHubToken();
  if (!token) {
    rootLogger.warn(
      'GITHUB_MENTIONS_ENABLED set but GITHUB_PERSONAL_ACCESS_TOKEN missing — GitHub channel skipped',
    );
    return null;
  }
  if (!GITHUB_ORG) {
    rootLogger.warn(
      'GITHUB_MENTIONS_ENABLED set but no GitHub org configured (profile githubOrg / GITHUB_ORG) — GitHub channel skipped',
    );
    return null;
  }

  const request = makeGhRequest(token);
  // Bot login is resolved on connect (GET /user) unless pinned via env; the
  // class uses it only as a best-effort guard against replying to itself.
  return new GithubMentionsChannel(opts, {
    request,
    org: GITHUB_ORG,
    login: process.env.GITHUB_BOT_LOGIN || '',
  });
});
