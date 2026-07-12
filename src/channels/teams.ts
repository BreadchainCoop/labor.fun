/**
 * Microsoft Teams channel — a Bot Framework (Azure Bot Service) bot.
 *
 * Teams is the #2 team-chat platform (~360M MAU) and the default in large /
 * regulated enterprises, so this closes the most-requested channel gap.
 *
 * ARCHITECTURE: unlike Slack (Socket Mode, outbound WebSocket) or Discord
 * (Gateway, outbound WebSocket), the Bot Framework model is INBOUND HTTP:
 * Azure Bot Service (or Teams directly, in gov/sovereign clouds) POSTs
 * "activities" to a messaging endpoint we own and serve. So this channel, like
 * web.ts, opens its own plain `http` server (env `TEAMS_MESSAGING_PORT`) and is
 * responsible for authenticating each inbound request itself. We use the
 * official `botbuilder` SDK's `CloudAdapter` for that — it validates the
 * inbound JWT (signed by Microsoft, audience = our App ID) so we never hand-roll
 * Bot Framework auth, which is the single easiest place to get this wrong.
 *
 * botbuilder's CloudAdapter.process() expects an Express/Restify-shaped
 * request (`{ body, headers, method }`, already JSON-parsed) and response
 * (`{ status(), header(), send(), end() }`) — not Node's raw
 * IncomingMessage/ServerResponse. `toBotBuilderReq`/`toBotBuilderRes` below are
 * a minimal shim so we can keep using plain `http.createServer` (matching
 * web.ts) instead of pulling in Express/Restify as a second HTTP framework.
 *
 * CONVERSATION REFERENCE: Bot Framework has no "reply to this jid" primitive
 * of its own — sending a message OUTSIDE the current turn (proactive, which is
 * exactly what sendMessage() below needs to do since it's called by the
 * orchestrator well after the inbound HTTP request has completed) requires a
 * `ConversationReference` (serviceUrl + conversation/user/bot IDs) captured
 * from a prior inbound activity. We capture it from every inbound activity
 * (turnContext.activity via TurnContext.getConversationReference) and cache it
 * by jid, then use `adapter.continueConversationAsync()` to resume that
 * conversation and post the reply. This mirrors Slack's thread_ts caching and
 * Discord's channel-object caching — just Teams' equivalent primitive.
 *
 * SAFETY / OPT-IN: fully inert unless TEAMS_ENABLED=true AND both
 * TEAMS_APP_ID + TEAMS_APP_PASSWORD are set (fail-closed, matching the other
 * gated channels) — otherwise the factory returns null and no port is opened.
 *
 * SECRETS: TEAMS_APP_PASSWORD (the Azure AD app registration's client secret)
 * is read via readEnvFile/process.env only, passed straight to
 * ConfigurationBotFrameworkAuthentication, and never logged.
 */
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';

import {
  ActivityTypes,
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  ConversationReference,
  TurnContext,
} from 'botbuilder';

import { ASSISTANT_NAME } from '../config.js';
import { storeOutboundMessage } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, RegisteredGroup, SendMessageOpts } from '../types.js';

/** Bot Framework message size guidance is much larger than Slack/Discord, but
 * Teams renders very long single messages poorly. Split defensively at the
 * same order of magnitude as the other channels. */
const MAX_MESSAGE_LENGTH = 20000;

/** Cap on cached conversation references (one per jid), LRU-evicted — mirrors
 * the bounded caches in slack.ts/discord.ts/web.ts so a long-running process
 * with many distinct Teams conversations can't grow this map unboundedly. */
const CONVERSATION_REF_MAX = 5000;

export interface TeamsChannelConfig {
  appId: string;
  appPassword: string;
  /** Azure AD app tenant ID — required for single-tenant app registrations. */
  appTenantId?: string;
  port: number;
  host: string;
}

/** Minimal shape of an inbound Teams/Bot Framework activity that we read.
 * Kept narrow (vs. importing the full `Activity` type everywhere) so tests can
 * construct plain objects without the SDK's zod validation machinery. */
interface InboundActivityLike {
  type: string;
  id?: string;
  text?: string;
  timestamp?: string | Date;
  from?: { id?: string; name?: string };
  conversation?: { id?: string; conversationType?: string; name?: string };
  recipient?: { id?: string; name?: string };
  channelData?: { team?: { id?: string; name?: string } };
}

export class TeamsChannel implements Channel {
  name = 'teams';

  private opts: ChannelOpts;
  private cfg: TeamsChannelConfig;
  private adapter: CloudAdapter;
  private server: Server | null = null;

  /** jid → captured ConversationReference, used by continueConversationAsync
   * to send proactive replies outside the inbound HTTP turn. LRU-capped. */
  private conversationRefs = new Map<string, Partial<ConversationReference>>();

  constructor(
    opts: ChannelOpts,
    cfg: TeamsChannelConfig,
    adapter?: CloudAdapter,
  ) {
    this.opts = opts;
    this.cfg = cfg;
    this.adapter =
      adapter ||
      new CloudAdapter(
        new ConfigurationBotFrameworkAuthentication({
          MicrosoftAppId: cfg.appId,
          MicrosoftAppPassword: cfg.appPassword,
          MicrosoftAppTenantId: cfg.appTenantId,
          MicrosoftAppType: cfg.appTenantId ? 'SingleTenant' : 'MultiTenant',
        } as any),
      );
    this.adapter.onTurnError = async (context, err) => {
      logger.error({ err }, 'Teams: unhandled turn error');
      try {
        await context.sendActivity(
          'Sorry, something went wrong processing that message.',
        );
      } catch (_sendErr) {
        // best effort — nothing more we can do if even the error reply fails
      }
    };
  }

  // --- Channel interface ---

  async connect(): Promise<void> {
    const server = createServer((req, res) => {
      void this.handleRequest(req, res).catch((err) => {
        logger.warn({ err }, 'Teams: unhandled request error');
        try {
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal error' }));
          } else {
            res.end();
          }
        } catch (_endErr) {
          // response already torn down — nothing to do
        }
      });
    });

    return new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.cfg.port, this.cfg.host, () => {
        this.server = server;
        logger.info(
          { port: this.cfg.port, host: this.cfg.host },
          'Teams channel listening',
        );
        resolve();
      });
    });
  }

  async disconnect(): Promise<void> {
    this.conversationRefs.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      logger.info('Teams channel stopped');
    }
  }

  isConnected(): boolean {
    return this.server !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('teams:');
  }

  async sendMessage(
    jid: string,
    text: string,
    _opts?: SendMessageOpts,
  ): Promise<boolean> {
    const reference = this.conversationRefs.get(jid);
    if (!reference) {
      // No inbound activity has been seen for this jid yet (or the process
      // restarted and lost the in-memory cache) — there is no way to send a
      // proactive Bot Framework message without a conversation reference.
      // Matches the other channels' best-effort, fire-and-forget semantics
      // (web.ts drops with no offline queue; slack.ts/discord.ts queue-until-
      // connect, which doesn't help here since the reference itself is
      // missing, not just the connection).
      logger.warn(
        { jid },
        'Teams: no conversation reference cached for jid — message dropped',
      );
      return false;
    }

    const chunks = this.splitMessage(text);
    try {
      for (const chunk of chunks) {
        await this.adapter.continueConversationAsync(
          this.cfg.appId,
          reference,
          async (turnContext: TurnContext) => {
            const res = await turnContext.sendActivity(chunk);
            if (res?.id) {
              try {
                storeOutboundMessage(jid, res.id, chunk, ASSISTANT_NAME);
              } catch (err) {
                logger.warn(
                  { err, jid },
                  'storeOutboundMessage failed (continuing)',
                );
              }
            }
          },
        );
      }
      logger.info({ jid, length: text.length }, 'Teams message sent');
      return true;
    } catch (err) {
      logger.warn({ jid, err }, 'Failed to send Teams message');
      return false;
    }
  }

  // Bot Framework has a typing activity (ActivityTypes.Typing) but it is only
  // meaningful INSIDE a turn (as a reply to the activity that triggered it) —
  // there is no proactive/out-of-turn typing indicator, unlike Slack (which
  // has none at all) or Discord (which supports channel.sendTyping()
  // proactively). Since setTyping() here is invoked well outside any inbound
  // turn, we no-op rather than send a typing activity with no anchor.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: proactive typing indicators aren't supported by Bot Framework
  }

  // --- Request handling (extracted so tests can drive it with duck-typed
  // req/res, matching web.ts's pattern) ---

  async handleRequest(
    req: Pick<IncomingMessage, 'headers' | 'method'> & {
      on(event: string, cb: (...args: any[]) => void): unknown;
    },
    res: Pick<ServerResponse, 'writeHead' | 'end' | 'headersSent'>,
  ): Promise<void> {
    const method = (req as IncomingMessage).method || 'GET';

    if (method === 'GET') {
      // Health check — Azure Bot Service / load balancers may probe this.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }

    let body: unknown;
    try {
      body = await this.readJsonBody(req);
    } catch (err) {
      logger.warn({ err }, 'Teams: failed to parse inbound body');
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid json' }));
      return;
    }

    const botReq = {
      body: body as Record<string, unknown>,
      headers: req.headers as Record<string, string | string[] | undefined>,
      method,
    };
    const botRes = this.toBotBuilderRes(res as ServerResponse);

    // CloudAdapter.process() verifies the inbound JWT (signed by Microsoft,
    // audience = our App ID) BEFORE invoking the logic callback below — an
    // unauthenticated or forged request never reaches handleActivity().
    await this.adapter.process(botReq as any, botRes as any, (turnContext) =>
      this.handleActivity(turnContext),
    );
  }

  private async handleActivity(turnContext: TurnContext): Promise<void> {
    const activity = turnContext.activity as unknown as InboundActivityLike;

    if (activity.type !== ActivityTypes.Message) {
      // Conversation-update, invoke, etc. — not a chat message. Nothing to
      // route to the orchestrator.
      return;
    }

    const conversationId = activity.conversation?.id;
    if (!conversationId) return;

    const jid = `teams:${conversationId}`;

    // Capture/refresh the conversation reference on EVERY inbound activity
    // (not just the first) so serviceUrl/etc. stay current if Teams ever
    // rotates them, and so a process restart re-learns it on the next message.
    const reference = TurnContext.getConversationReference(
      turnContext.activity,
    );
    this.rememberConversationRef(jid, reference);

    const isGroup = activity.conversation?.conversationType !== 'personal';
    const timestamp = activity.timestamp
      ? new Date(activity.timestamp).toISOString()
      : new Date().toISOString();
    const name =
      activity.conversation?.name ||
      activity.channelData?.team?.name ||
      undefined;

    this.opts.onChatMetadata(jid, timestamp, name, 'teams', isGroup);

    const groups = this.opts.registeredGroups();
    if (!groups[jid]) return;

    if (!activity.text) return;

    // Strip the bot's own @mention (Teams renders it as a <at> entity, encoded
    // inline in `text` as "@BotName rest of message") so the agent sees clean
    // text, matching Slack's <@BOTID> stripping. TurnContext.removeRecipientMention
    // handles the entity-aware removal (it also trims the resulting whitespace).
    const content = TurnContext.removeRecipientMention(
      turnContext.activity,
    ).trim();

    const senderName = activity.from?.name || activity.from?.id || 'unknown';

    this.opts.onMessage(jid, {
      id: activity.id || '',
      chat_jid: jid,
      sender: activity.from?.id || '',
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });
  }

  // --- Helpers ---

  private rememberConversationRef(
    jid: string,
    reference: Partial<ConversationReference>,
  ): void {
    // Refresh LRU position on update.
    this.conversationRefs.delete(jid);
    this.conversationRefs.set(jid, reference);
    if (this.conversationRefs.size > CONVERSATION_REF_MAX) {
      const oldest = this.conversationRefs.keys().next().value;
      if (oldest !== undefined) this.conversationRefs.delete(oldest);
    }
  }

  private splitMessage(text: string): string[] {
    if (text.length <= MAX_MESSAGE_LENGTH) return [text];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
      chunks.push(text.slice(i, i + MAX_MESSAGE_LENGTH));
    }
    return chunks;
  }

  private readJsonBody(req: {
    on(event: string, cb: (...args: any[]) => void): unknown;
  }): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(err as Error);
        }
      });
      req.on('error', reject);
    });
  }

  /** Adapt a raw Node `http.ServerResponse` to the minimal
   * `{ status, header, send, end }` shape `CloudAdapter.process()` expects
   * (it's written against Express/Restify's Response interface). Lets us keep
   * using plain `http.createServer` like every other channel instead of
   * pulling in Express/Restify as a second HTTP framework just for this one
   * dependency. */
  private toBotBuilderRes(res: ServerResponse): {
    status(code: number): void;
    header(name: string, value: unknown): void;
    send(body?: unknown): void;
    end(): void;
    socket: unknown;
  } {
    let statusCode = 200;
    const headers: Record<string, string> = {};
    let ended = false;
    return {
      status(code: number) {
        statusCode = code;
      },
      header(name: string, value: unknown) {
        headers[name] = String(value);
      },
      send(body?: unknown) {
        if (ended) return;
        ended = true;
        if (body === undefined) {
          res.writeHead(statusCode, headers);
          res.end();
          return;
        }
        const payload = typeof body === 'string' ? body : JSON.stringify(body);
        if (!headers['content-type']) {
          headers['content-type'] = 'application/json';
        }
        res.writeHead(statusCode, headers);
        res.end(payload);
      },
      end() {
        if (ended) return;
        ended = true;
        res.writeHead(statusCode, headers);
        res.end();
      },
      socket: (res as unknown as { socket?: unknown }).socket,
    };
  }
}

registerChannel('teams', (opts: ChannelOpts) => {
  const env = readEnvFile([
    'TEAMS_ENABLED',
    'TEAMS_APP_ID',
    'TEAMS_APP_PASSWORD',
    'TEAMS_APP_TENANT_ID',
    'TEAMS_MESSAGING_PORT',
    'TEAMS_HOST',
  ]);
  const get = (k: string): string =>
    process.env[k] || env[k] || (undefined as unknown as string) || '';

  if (get('TEAMS_ENABLED') !== 'true') {
    // Not enabled — inert, no server, no port opened.
    return null;
  }

  const appId = get('TEAMS_APP_ID');
  const appPassword = get('TEAMS_APP_PASSWORD');
  if (!appId || !appPassword) {
    logger.warn(
      'Teams: TEAMS_ENABLED=true but TEAMS_APP_ID/TEAMS_APP_PASSWORD not set — skipping',
    );
    return null;
  }

  const cfg: TeamsChannelConfig = {
    appId,
    appPassword,
    appTenantId: get('TEAMS_APP_TENANT_ID') || undefined,
    port: Number(get('TEAMS_MESSAGING_PORT') || 3978),
    host: get('TEAMS_HOST') || '0.0.0.0',
  };

  return new TeamsChannel(opts, cfg);
});

// Exported for tests only — lets a test construct an activity payload without
// hand-rolling the Bot Framework schema.
export type { InboundActivityLike };
