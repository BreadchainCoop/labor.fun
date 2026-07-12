import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  isPrivilegedGroup,
  LOCAL_LLM_BASE_URL,
  LOCAL_LLM_MODEL,
  MAX_MESSAGES_PER_PROMPT,
  MCP_SERVERS,
  FRESH_SESSION_BACKFILL_MESSAGES,
  OPS_REPORT_AUDIENCE,
  OPS_REPORT_INTERVAL_MS,
  OPS_REPORT_OVERLOAD_RATIO,
  OPS_REPORT_PERIOD,
  OPS_REPORT_DUE_SOON_DAYS,
  OPS_REPORT_TARGET_GROUP,
  OPS_REPORT_WEB_BASE_URL,
  OPS_REPORT_PAGEDATA_DIR,
  ORG_NAME,
  NANOCLAW_BACKEND,
  POLL_INTERVAL,
  REMINDER_ESCALATION_CONTACT,
  REMINDER_LADDER,
  REMINDER_SWEEP_INTERVAL_MS,
  REMINDER_TARGET_JID,
  SHARED_KB_GROUP,
  SMITHERS_BRIDGE_ENABLED,
  SMITHERS_BRIDGE_PORT,
  SMITHERS_BRIDGE_TOKEN,
  TIMEZONE,
} from './config.js';
import { startCredentialProxy, UsageEvent } from './credential-proxy.js';
import { estimateCostUsd } from './model-pricing.js';
import {
  checkQuota as checkUsageQuota,
  onUsageRecorded,
} from './usage-budget.js';
import { startSmithersBridge } from './smithers-bridge.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import type {
  DiscordHistoryMessage,
  FetchChannelHistoryOpts,
} from './channels/discord.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getRegisteredGroup,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getRecentMessages,
  getNewMessages,
  getRouterState,
  initDatabase,
  deleteRegisteredGroup,
  markOrphanedRunsAsInterrupted,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  startAgentRun,
  completeAgentRun,
  logAssistantEvent,
  detectKnowledgeGapMarker,
  coarseTopic,
  recordPmDm,
  insertApiUsage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { startEmailPoller } from './email-poller.js';
import { startSlackMembersSyncLoop } from './integrations/slack-members-sync.js';
import { startIpcWatcher } from './ipc.js';
import {
  findChannel,
  formatMessages,
  formatOutbound,
  stripInternalTags,
} from './router.js';
import { selectPromptMessages } from './context-window.js';
import './chat-flows/index.js';
import {
  findChatFlow,
  type ChatFlow,
  type ChatFlowHost,
} from './chat-flows/registry.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { startReminderEngine } from './reminder-engine.js';
import {
  startPmOrchestration,
  buildPmRun,
} from './integrations/pm-orchestration.js';
import { isPmCommand } from './pm-orchestration.js';
import {
  startOperationalReport,
  type OpsPageData,
} from './integrations/operational-report.js';
import { loadMemberCapacitiesFromKb } from './member-profiles.js';
import {
  loadDeadlineItemsFromKb,
  loadPmTasksFromKb,
  sharedKbTasksDir,
} from './kb-task-source.js';
import './integrations/index.js';
import { startRegisteredIntegrations } from './integrations/registry.js';
import { runWhatsAppPairingBroker } from './integrations/whatsapp-pairing-broker.js';
import { loadProfilePlugins } from './plugin-loader.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import {
  loadPeopleFromKB,
  resolveUser,
  getSenderContext,
} from './permissions.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

/**
 * One resolved human sender in a processed batch, carrying the platform id the
 * orchestrator used to resolve them. This platform id is the TRUSTED handle the
 * host verifies an agent's per-decision claim against (see
 * `resolveActorFromSenderContext` in ipc.ts) — the agent never gets to assert an
 * approver identity by string; it can only point at a message/sender that the
 * orchestrator already resolved from real platform data.
 */
export interface BatchSender {
  user_id: string;
  display_name: string;
  tags: string[];
  platform_sender_id: string;
}

/**
 * The sender_context.json payload written per run. The top-level
 * `user_id`/`display_name`/`tags` preserve the historical single-sender shape
 * (equal to the LAST resolved sender in the batch) so existing consumers that
 * only need "some allowlisted human triggered this" (flat KB write allowlist,
 * add_kb_user, etc.) keep working unchanged. `senders` is the full distinct
 * roster used to disambiguate WHO issued a specific gated decision.
 */
export interface BatchSenderContext {
  user_id: string;
  display_name: string;
  tags: string[];
  senders: BatchSender[];
}

/** Map a chat JID prefix to the platform key used in `user_identities`. */
export function platformForChatJid(chatJid: string): string {
  if (chatJid.startsWith('tg:')) return 'telegram';
  if (chatJid.startsWith('slack:')) return 'slack';
  return 'unknown';
}

/**
 * Build the per-run sender context from the processed message batch. Resolves
 * EACH distinct inbound sender (deduped by platform id, first-seen wins for
 * display info) against the KB; unresolved (unknown/unallowlisted) senders are
 * dropped exactly as the previous single-sender path dropped a null resolution.
 * Returns null when nothing resolves (caller unlinks the file — fail closed).
 *
 * Pure and injectable (`resolve`) so it can be unit-tested without the KB.
 */
export function buildBatchSenderContext(
  messages: NewMessage[],
  platform: string,
  resolve: (
    platformId: string,
    platform: string,
  ) => { user_id: string; display_name: string; tags: string[] } | undefined,
): BatchSenderContext | null {
  const seen = new Set<string>();
  const senders: BatchSender[] = [];
  for (const m of messages) {
    if (m.is_from_me || !m.sender || seen.has(m.sender)) continue;
    const ctx = resolve(m.sender, platform);
    if (!ctx) continue;
    seen.add(m.sender);
    senders.push({
      user_id: ctx.user_id,
      display_name: ctx.display_name,
      tags: ctx.tags,
      platform_sender_id: m.sender,
    });
  }
  if (senders.length === 0) return null;
  // Back-compat top-level identity == the LAST resolved sender in the batch,
  // matching the previous "last message's sender" behavior for single-sender
  // batches (the overwhelmingly common case).
  const last = senders[senders.length - 1];
  return {
    user_id: last.user_id,
    display_name: last.display_name,
    tags: last.tags,
    senders,
  };
}

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      // Templates use the {{ASSISTANT_NAME}} token so any org/profile can
      // brand its agent without the framework hardcoding a product name.
      const content = fs
        .readFileSync(templateFile, 'utf-8')
        .replaceAll('{{ASSISTANT_NAME}}', ASSISTANT_NAME);
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

function deregisterGroup(jid: string): void {
  const group = registeredGroups[jid];
  if (!group) return;
  delete registeredGroups[jid];
  deleteRegisteredGroup(jid);
  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group deregistered (folder + data preserved)',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/** Resolve the shared-KB group's chat JID, if it's registered. */
function sharedKbGroupJid(): string | null {
  const entry = Object.entries(registeredGroups).find(
    ([, g]) => g.folder === SHARED_KB_GROUP,
  );
  return entry?.[0] ?? null;
}

/** Privileged operations lent to a chat flow's onAgentResult. */
const chatFlowHost: ChatFlowHost = {
  async notify(jid: string, text: string): Promise<void> {
    const ch = findChannel(channels, jid);
    if (ch) await ch.sendMessage(jid, formatOutbound(text));
  },
  sharedKbChatJid: sharedKbGroupJid,
};

/**
 * Run a registered chat flow on its (external) channel. Suppresses the general
 * assistant: runs a sandboxed (non-privileged) agent restricted to the flow's
 * tools with the flow's persona appended, responds to anyone (no trigger
 * gate), and lets the flow post-process the output on the privileged side.
 */
async function processChatFlow(
  chatJid: string,
  group: RegisteredGroup,
  channel: Channel,
  flow: ChatFlow,
): Promise<boolean> {
  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );
  if (missedMessages.length === 0) return true;

  const inbound = missedMessages.filter((m) => !m.is_from_me);
  const lastTs = missedMessages[missedMessages.length - 1].timestamp;
  if (inbound.length === 0) {
    lastAgentTimestamp[chatJid] = lastTs;
    saveState();
    return true;
  }

  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] = lastTs;
  saveState();

  const triggerMsg = inbound[inbound.length - 1];
  const prompt = formatMessages(missedMessages, TIMEZONE);

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let sentReply = false;

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    async (result) => {
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // A broken flow must not take down message processing.
        let reply = '';
        try {
          reply = await flow.onAgentResult(
            stripInternalTags(raw),
            triggerMsg,
            chatJid,
            chatFlowHost,
          );
        } catch (err) {
          logger.error(
            { err, chatJid, flow: flow.name },
            'Chat flow failed to handle agent result',
          );
        }
        if (reply) {
          await channel.sendMessage(chatJid, reply, {
            replyToMessageId: triggerMsg.id,
          });
          sentReply = true;
        }
      }
      if (result.status === 'error') hadError = true;
    },
    {
      forceNonPrivileged: true,
      allowedTools: flow.allowedTools,
      systemPromptAppend: flow.systemPrompt,
    },
  );

  await channel.setTyping?.(chatJid, false);

  if (output === 'error' || hadError) {
    // Roll back the cursor for retry only if we never replied (avoid dupes).
    if (!sentReply) {
      lastAgentTimestamp[chatJid] = previousCursor;
      saveState();
      return false;
    }
  }
  return true;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  // Chat-flow channel (e.g. membership intake, #30): the general assistant is
  // suppressed entirely; only the sandboxed flow runs here.
  const chatFlow = findChatFlow(chatJid);
  if (chatFlow) {
    return await processChatFlow(chatJid, group, channel, chatFlow);
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        // Explicit trigger (@mention or trigger pattern)
        (triggerPattern.test(m.content.trim()) &&
          (m.is_from_me ||
            isTriggerAllowed(chatJid, m.sender, allowlistCfg))) ||
        // Implicit trigger: replying to the bot's own message
        (m.is_reply_to_bot &&
          !m.is_from_me &&
          isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  // On-demand PM orchestration: an allowlisted user can trigger the routine
  // from chat (e.g. "@<bot> run pm orchestration" / "/pm"). Replace the normal
  // conversational turn with the deterministic PM brief so the agent runs the
  // routine here, in this chat, and acts per the pm-orchestration skill.
  // Gated on the sender being allowlisted — the routine has GitHub/KB side
  // effects and spends API credits, so it must not be invokable by anyone.
  const pmAllowlistCfg = loadSenderAllowlist();
  const pmTriggered = missedMessages.some(
    (m) =>
      !m.is_from_me &&
      isPmCommand(m.content) &&
      isTriggerAllowed(chatJid, m.sender, pmAllowlistCfg),
  );
  let prompt: string;
  if (pmTriggered) {
    const run = buildPmRun(loadPmTasksFromKb(), Date.now());
    prompt = run.prompt;
    // Record at dispatch (same as the scheduled loop) so the cooldown applies.
    for (const c of run.fresh) recordPmDm(c.person, c.taskId, c.reason);
    logger.info({ group: group.name }, 'PM orchestration triggered from chat');
  } else {
    // Continuity: a resumed session already holds the prior conversation in its
    // transcript, so only the new (since-cursor) messages are needed. A FRESH
    // session has no memory — the since-cursor slice can be a single message —
    // so backfill the recent thread so the agent can resolve references like
    // "this" without the user replying to a specific message. Trigger/cursor
    // logic above still keys off `missedMessages`; only the prompt gets richer.
    const hasSession = Boolean(sessions[group.folder]);
    const recentHistory = hasSession
      ? []
      : getRecentMessages(chatJid, FRESH_SESSION_BACKFILL_MESSAGES);
    const promptMessages = selectPromptMessages(
      hasSession,
      missedMessages,
      recentHistory,
    );
    if (!hasSession && promptMessages.length > missedMessages.length) {
      logger.info(
        {
          group: group.name,
          backfilled: promptMessages.length,
          sinceCursor: missedMessages.length,
        },
        'Fresh session — backfilled recent history for continuity',
      );
    }
    prompt = formatMessages(promptMessages, TIMEZONE);
  }

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Determine channel for logging
  const channelRoute = chatJid.startsWith('tg:')
    ? 'telegram'
    : chatJid.startsWith('slack:')
      ? 'slack'
      : chatJid.startsWith('dc:')
        ? 'discord'
        : 'unknown';

  // Log the agent run start
  const triggerMsg = missedMessages[missedMessages.length - 1];
  const runStartTime = Date.now();
  const runId = startAgentRun({
    chatJid,
    channel: channelRoute,
    groupName: group.name,
    groupFolder: group.folder,
    triggerSender: triggerMsg?.sender_name,
    triggerContent: triggerMsg?.content,
    messageCount: missedMessages.length,
  });

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  // Write sender context to IPC so the container agent knows who it's talking
  // to — and, crucially, CLEAR any stale context when this run has no
  // validated sender. The orchestrator's IPC handlers treat the presence of
  // sender_context.json as proof of an allowlisted human; leaving a previous
  // run's file in place would let a later scheduled/unauthenticated run
  // inherit that identity and pass allowlist gates (e.g. fetch_discord_history,
  // modify_kb_file). Fail closed: write when present, unlink when absent.
  const lastMsg = missedMessages[missedMessages.length - 1];
  // Resolve EVERY distinct sender in the batch, not just the last message's —
  // otherwise an approve/decision command from one sender could be attributed
  // to whoever happened to speak last, defeating the self-approval guard and
  // the approver-tier check (see resolveActorFromSenderContext in ipc.ts).
  const senderCtx = buildBatchSenderContext(
    missedMessages,
    platformForChatJid(chatJid),
    getSenderContext,
  );
  {
    const ipcInputDir = resolveGroupIpcPath(group.folder) + '/input';
    const senderCtxPath = path.join(ipcInputDir, 'sender_context.json');
    fs.mkdirSync(ipcInputDir, { recursive: true });
    if (senderCtx) {
      fs.writeFileSync(senderCtxPath, JSON.stringify(senderCtx));
    } else {
      try {
        fs.unlinkSync(senderCtxPath);
      } catch {
        /* nothing to clear */
      }
    }
  }

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;
  // Sum of the actual text the agent sent the user, accumulated across the
  // streaming callbacks below. completeAgentRun() is given this — NOT the
  // length of runAgent()'s return value, which is just the status string
  // ('success'/'error'), and which previously made agent_runs.output_length
  // always 7 ("success") or 5 ("error") regardless of the real reply.
  let outputLength = 0;
  // Accumulated agent reply text, used by the analytics knowledge-gap heuristic
  // (detectKnowledgeGapMarker) after the run completes.
  let agentReplyText = '';

  // ACK pattern: react with a thinking emoji on the triggering message,
  // then swap to a checkmark when processing completes.
  const triggerMessageId = lastMsg?.id;
  const supportsReactions = !!channel.addReaction;
  if (supportsReactions && triggerMessageId) {
    await channel.removeReaction!(chatJid, triggerMessageId, 'eyes');
    await channel.addReaction!(chatJid, triggerMessageId, 'thinking_face');
  }

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
      if (text) {
        // Anchor the reply to the message that triggered this run so it lands
        // in the right thread even if another message arrived (in a different
        // thread/conversation) while the agent was working. Without this the
        // channel resolves the target from a mutable "last inbound" slot that
        // the concurrent message overwrites, posting the reply in the wrong
        // place. See #46.
        await channel.sendMessage(chatJid, text, {
          replyToMessageId: triggerMessageId,
        });
        outputSentToUser = true;
        outputLength += text.length;
        agentReplyText += text + '\n';
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  // Remove the thinking reaction on completion. Intentionally no follow-up
  // reaction (e.g. ✅) — the agent's response itself is the completion
  // signal and a trailing reaction adds visual noise.
  if (supportsReactions && triggerMessageId) {
    await channel.removeReaction!(chatJid, triggerMessageId, 'thinking_face');
  }

  const runDuration = Date.now() - runStartTime;

  // Analytics: an explicit knowledge-gap signal from the agent arrives as a
  // sentinel flag file written by the IPC handler (report_knowledge_gap tool).
  // Read-and-clear it so it's attributed to THIS run and never leaks into the
  // next. Falls back to the output heuristic when no explicit signal is present.
  let agentSignaledGap = false;
  try {
    const gapFlag = path.join(
      resolveGroupIpcPath(group.folder),
      'analytics',
      'knowledge_gap.flag',
    );
    if (fs.existsSync(gapFlag)) {
      agentSignaledGap = true;
      fs.unlinkSync(gapFlag);
    }
  } catch {
    /* best-effort — never let analytics break the message loop */
  }

  // Record a single analytics event for this run (best-effort; guarded so a
  // logging failure never affects message handling). Privacy redaction is
  // applied inside logAssistantEvent per the ASSISTANT_ANALYTICS_PRIVACY stance.
  const recordEvent = (
    outcome: 'answered' | 'knowledge_gap' | 'error',
    gapSource: 'agent_signal' | 'heuristic' | null,
  ) => {
    try {
      logAssistantEvent({
        runId,
        chatJid,
        channel: channelRoute,
        groupName: group.name,
        groupFolder: group.folder,
        isMain: isMainGroup,
        senderName: triggerMsg?.sender_name,
        questionText: triggerMsg?.content,
        outcome,
        gapSource,
        topic: coarseTopic(triggerMsg?.content),
      });
    } catch (err) {
      logger.warn(
        { group: group.name, err },
        'Failed to record assistant analytics event',
      );
    }
  };

  if (output === 'error' || hadError) {
    completeAgentRun(
      runId,
      'error',
      outputLength,
      runDuration,
      outputSentToUser
        ? 'Agent returned error (partial output sent to user)'
        : 'Agent returned error (no output sent)',
    );
    recordEvent('error', null);
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  completeAgentRun(runId, 'success', outputLength, runDuration);
  // Knowledge-gap on a successful run: prefer the explicit agent signal, else
  // fall back to the (lower-precision) output heuristic.
  if (agentSignaledGap) {
    recordEvent('knowledge_gap', 'agent_signal');
  } else if (detectKnowledgeGapMarker(agentReplyText)) {
    recordEvent('knowledge_gap', 'heuristic');
  } else {
    recordEvent('answered', null);
  }
  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  opts?: {
    /** Force a non-privileged (sandboxed) run regardless of FLAT_ACCESS. */
    forceNonPrivileged?: boolean;
    /** Restrict the agent to exactly these tools. */
    allowedTools?: string[];
    /** Append this to the system prompt (e.g. an intake persona). */
    systemPromptAppend?: string;
  },
): Promise<'success' | 'error'> {
  // Flat-access (cooperative) mode elevates every group to main-equivalent
  // mounts/IPC auth. isMain here drives container mounts, the NANOCLAW_IS_MAIN
  // env, and the tasks/groups snapshots. External/sandboxed flows force this
  // off so an untrusted channel never gets privileged mounts/IPC.
  const isMain = opts?.forceNonPrivileged ? false : isPrivilegedGroup(group);
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        allowedTools: opts?.allowedTools,
        systemPromptAppend: opts?.systemPromptAppend,
        mcpServers: MCP_SERVERS,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  const orphaned = markOrphanedRunsAsInterrupted();
  if (orphaned > 0) {
    logger.info(
      { count: orphaned },
      'Marked orphaned agent_runs as interrupted (from previous process)',
    );
  }

  // Load KB people for permissions enforcement
  // Try each registered group's context dir; the primary KB is usually in slack_main
  for (const group of Object.values(getAllRegisteredGroups())) {
    const contextDir = resolveGroupFolderPath(group.folder) + '/context';
    const peopleDir = contextDir + '/people';
    if (fs.existsSync(peopleDir)) {
      loadPeopleFromKB(contextDir);
      break;
    }
  }

  loadState();
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this).
  // Skipped in local-LLM mode — no Anthropic traffic to proxy; the container
  // talks directly to the OpenAI-compatible endpoint (LOCAL_LLM_BASE_URL).
  //
  // Usage-metering hooks (OSS "API cost tracking & budgets" foundation):
  // onUsage persists every observed /v1/messages call to api_usage with an
  // estimated cost; checkQuota gates new requests against env-configured
  // monthly budgets (src/usage-budget.ts). Both are no-ops unless the
  // relevant env vars are set, so default behavior is unchanged.
  const proxyServer =
    NANOCLAW_BACKEND === 'local'
      ? null
      : await startCredentialProxy(CREDENTIAL_PROXY_PORT, PROXY_BIND_HOST, {
          onUsage: (usage: UsageEvent) => {
            const estCostUsd = estimateCostUsd({
              model: usage.model || '',
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cacheReadTokens,
              cacheWriteTokens: usage.cacheWriteTokens,
            });
            try {
              insertApiUsage({
                runTag: usage.runTag,
                model: usage.model,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheReadTokens: usage.cacheReadTokens,
                cacheWriteTokens: usage.cacheWriteTokens,
                estCostUsd,
                statusCode: usage.statusCode,
              });
              onUsageRecorded({
                totalTokens:
                  usage.inputTokens +
                  usage.outputTokens +
                  usage.cacheReadTokens +
                  usage.cacheWriteTokens,
                costUsd: estCostUsd,
              });
            } catch (err) {
              logger.error({ err, usage }, 'Failed to record API usage');
            }
          },
          checkQuota: () => checkUsageQuota(),
        });

  if (NANOCLAW_BACKEND === 'local') {
    logger.info(
      { backend: 'local', baseUrl: LOCAL_LLM_BASE_URL, model: LOCAL_LLM_MODEL },
      'Backend=local: credential proxy disabled, routing to OpenAI-compatible endpoint',
    );
  } else {
    logger.info({ backend: 'claude' }, 'Backend=claude');
  }

  // Optionally start the Smithers durable-workflow bridge (orchestration/).
  // Off by default; runs one workflow step through runContainerAgent so the
  // step keeps the container sandbox/proxy/RBAC. See docs/SMITHERS-ORCHESTRATION.md.
  let smithersBridge: import('http').Server | undefined;
  if (SMITHERS_BRIDGE_ENABLED) {
    if (!SMITHERS_BRIDGE_TOKEN) {
      logger.warn(
        'SMITHERS_BRIDGE_ENABLED but SMITHERS_BRIDGE_TOKEN is empty — bridge NOT started',
      );
    } else {
      smithersBridge = await startSmithersBridge({
        port: SMITHERS_BRIDGE_PORT,
        token: SMITHERS_BRIDGE_TOKEN,
        runStep: async ({ chatJid, prompt, modelOverride, allowedTools }) => {
          const group = getRegisteredGroup(chatJid);
          if (!group) {
            return {
              status: 'error',
              result: null,
              error: `unknown group for jid ${chatJid}`,
            };
          }
          // The agent-runner emits its one-shot result marker and then LINGERS
          // (MCP/credential-proxy handles keep the process alive — it does not
          // self-exit; normal message runs are torn down by the group queue). A
          // bridge step has no queue lifecycle, so we manage the container here:
          // capture the streamed result, then STOP the container as soon as the
          // result (or an error) arrives. We `docker kill` by container NAME —
          // killing the `docker run` client process does NOT stop the container
          // (that's the known orphan leak). Without this the container orphans
          // and runContainerAgent waits out the hard timeout. Streaming mode also
          // returns result:null on the resolved value, so we read it off the
          // stream rather than the resolved output.
          let containerName: string | undefined;
          let streamedResult: string | null = null;
          let streamedError = false;
          const stopContainer = () => {
            if (containerName) {
              execFile('docker', ['kill', containerName], () => {});
              containerName = undefined; // once
            }
          };
          const output = await runContainerAgent(
            group,
            {
              prompt,
              groupFolder: group.folder,
              chatJid,
              isMain: isPrivilegedGroup(group),
              isScheduledTask: true,
              modelOverride,
              allowedTools,
              mcpServers: MCP_SERVERS,
              // We stop the container ourselves below — keep the runner from
              // logging the resulting non-zero exit as an error.
              expectExternalStop: true,
            },
            (_p, name) => {
              containerName = name;
            },
            async (out) => {
              if (out.status === 'error') {
                streamedError = true;
                stopContainer();
                return;
              }
              if (out.result != null) {
                streamedResult = out.result;
                stopContainer();
              }
            },
          );
          if (streamedResult != null) {
            return { status: 'success', result: streamedResult };
          }
          return {
            status:
              streamedError || output.status === 'error' ? 'error' : 'success',
            result: output.result,
          };
        },
      });
    }
  }

  // Graceful shutdown handlers
  //
  // Tear the channel gateways down FIRST and make sure that step actually
  // completes. DiscordChannel.disconnect() calls client.destroy(), which is
  // what cleanly ends the Discord gateway session. Previously this ran LAST,
  // after proxyServer.close() and queue.shutdown(); the risk is that the
  // process never reaches/finishes it. The unit logs around the observed
  // failure showed "State 'final-sigterm' timed out. Killing." with detached
  // agent `docker run` children keeping the cgroup alive past systemd's stop
  // timeout — i.e. the process can be SIGKILLed mid-stop. If that happens
  // before client.destroy() completes, the gateway is left half-open and the
  // NEXT orchestrator inherits a "connected but receives no events" zombie
  // session, so the bot silently stops responding until restarted again.
  // Doing the teardown first (and bounding it) makes the one step that must
  // happen the first thing that does.
  //
  // The force-exit backstop guarantees we terminate within systemd's stop
  // window instead of being SIGKILLed; it exits non-zero so a genuine
  // shutdown hang is still visible to systemd/monitoring. `shuttingDown`
  // guards a second signal racing the first.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received');

    const force = setTimeout(() => {
      logger.warn('Graceful shutdown exceeded 8s — forcing exit');
      process.exit(1);
    }, 8000);
    force.unref();

    // 1. Destroy channel gateways first, bounded so a wedged socket can't hang
    //    us; allSettled so one channel's failure doesn't skip the others.
    await Promise.race([
      Promise.allSettled(channels.map((ch) => ch.disconnect())),
      new Promise((resolve) => setTimeout(resolve, 4000)),
    ]);

    // 2. Best-effort cleanup of the rest — both return promptly and neither can
    //    resurrect the gateway: proxyServer.close() just stops accepting new
    //    connections, and GroupQueue.shutdown() only marks the queue closed and
    //    detaches (does not kill) in-flight agent containers — it does not drain,
    //    so it takes no grace period.
    //    proxyServer is null in local-LLM mode — close() is null-safe.
    proxyServer?.close();
    smithersBridge?.close();
    await queue.shutdown(0);

    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before
      // storing. Chat-flow channels (e.g. membership intake) are exempt — they
      // are public by design and accept messages from unknown senders (the flow
      // is sandboxed, so there's no privileged surface to protect there).
      if (
        !msg.is_from_me &&
        !msg.is_bot_message &&
        registeredGroups[chatJid] &&
        !findChatFlow(chatJid)
      ) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      // Resolve sender identity from KB
      if (!msg.is_from_me && !msg.is_bot_message && msg.sender) {
        const channelName = chatJid.startsWith('tg:')
          ? 'telegram'
          : chatJid.startsWith('slack:')
            ? 'slack'
            : chatJid.endsWith('@s.whatsapp.net') || chatJid.endsWith('@g.us')
              ? 'whatsapp'
              : 'unknown';
        const kbPerson = resolveUser(msg.sender, channelName);
        if (kbPerson) msg.user_id = kbPerson;
      }

      storeMessage(msg);

      // Immediate ACK: react to triggered messages on receipt so the sender
      // knows Breadbrich Engels saw it, even if processing is queued behind other groups.
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const group = registeredGroups[chatJid];
        const isMain = group.isMain === true;
        const needsTrigger = !isMain && group.requiresTrigger !== false;
        const triggered =
          !needsTrigger ||
          getTriggerPattern(group.trigger).test(msg.content.trim());
        if (triggered) {
          const ch = findChannel(channels, chatJid);
          if (ch?.addReaction) {
            ch.addReaction(chatJid, msg.id, 'eyes').catch(() => {});
          }
        }
      }
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    registerGroup,
    deregisterGroup,
    // Auto-register a 1:1 DM whose sender resolves to a known KB person, so any
    // teammate can DM the bot without a per-DM admin step. Unknown senders stay
    // unregistered (dropped). The DM group needs no trigger (like a solo chat).
    ensureDmRegistered: (jid: string, platform: string, senderId: string) => {
      if (registeredGroups[jid]) return true;
      const kbPerson = resolveUser(senderId, platform);
      if (!kbPerson) return false;
      registerGroup(jid, {
        name: `${kbPerson} DM`,
        folder: `${platform}_dm_${kbPerson}`,
        trigger: DEFAULT_TRIGGER,
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        isMain: false,
      });
      // registerGroup silently rejects an invalid folder (e.g. an over-long
      // slug) without registering; only report success when the row landed.
      const ok = !!registeredGroups[jid];
      if (ok) {
        logger.info(
          { jid, platform, kbPerson },
          'Auto-registered DM for KB person',
        );
      }
      return ok;
    },
  };

  // Load the active profile's plugins so org-specific channels/flows
  // self-register before we wire channels and start integrations. (Core
  // channels/flows are registered by the barrel imports at the top of file.)
  await loadProfilePlugins();

  // Hosted-mode WhatsApp pairing broker: when WHATSAPP_PAIRING_PHONE +
  // CONTROL_PLANE_URL are set and no creds exist yet, drive pairing (relaying
  // pairing codes to the control plane) BEFORE connecting channels, so the
  // WhatsApp channel's connect() below picks up the freshly-saved creds
  // in-process. No-op otherwise; never throws.
  await runWhatsAppPairingBroker();

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    if (process.env.CONTROL_PLANE_URL) {
      // SaaS tenant instance: a fresh org has no channels until the user
      // connects one in the dashboard. The control plane delivers credentials
      // by patching this pod's env Secret and rolling the deployment, so
      // exiting here would just crashloop until then. Stay alive instead.
      logger.warn(
        'No channels connected yet — idling until the control plane delivers channel credentials',
      );
    } else {
      logger.fatal('No channels connected');
      process.exit(1);
    }
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  // Background flows self-register via ./integrations/index.js (mirrors the
  // channel registry). Each checks its own config and no-ops when disabled.
  startRegisteredIntegrations();

  // Escalating-deadline reminder engine (#25). Sweeps the shared KB tasks for
  // approaching deadlines and posts escalating reminders to the team channel.
  // Disabled when the sweep interval or ladder is empty.
  startReminderEngine({
    intervalMs: REMINDER_SWEEP_INTERVAL_MS,
    ladderSpecs: REMINDER_LADDER,
    escalationDefault: REMINDER_ESCALATION_CONTACT || undefined,
    loadItems: () => loadDeadlineItemsFromKb(),
    resolveTargetJid: () => {
      if (REMINDER_TARGET_JID) return REMINDER_TARGET_JID;
      // Default to the shared-KB group's chat — the channel the team watches.
      const entry = Object.entries(registeredGroups).find(
        ([, g]) => g.folder === SHARED_KB_GROUP,
      );
      return entry?.[0] ?? null;
    },
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'Reminder: no channel owns JID, cannot send');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
    writeDigest: (markdown) => {
      const digestPath = path.join(
        path.dirname(sharedKbTasksDir()),
        'deadline-digest.md',
      );
      const tmp = `${digestPath}.tmp`;
      fs.mkdirSync(path.dirname(digestPath), { recursive: true });
      fs.writeFileSync(tmp, markdown);
      fs.renameSync(tmp, digestPath);
    },
  });

  // PM orchestration (#31): weekly review of the GitHub-synced + hand-authored
  // task graph that wakes the agent to re-estimate/re-plan and DM blockers /
  // overdue owners. Disabled when PM_ORCHESTRATION_INTERVAL_MS=0. Reuses the
  // scheduler's agent-run closures.
  startPmOrchestration({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'PM: no channel owns JID, cannot send');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
    loadTasks: () => loadPmTasksFromKb(),
  });

  // Operational reports (#34): recurring leadership readout of what's late (by
  // team/person), per-member load vs. declared capacity (soft over-capacity
  // flag), and a bottleneck digest. Deterministic — no agent run / API spend.
  // Disabled when OPS_REPORT_INTERVAL_MS=0. Posts at most once per period.
  startOperationalReport({
    intervalMs: OPS_REPORT_INTERVAL_MS,
    dueSoonDays: OPS_REPORT_DUE_SOON_DAYS,
    overloadRatio: OPS_REPORT_OVERLOAD_RATIO,
    audience: OPS_REPORT_AUDIENCE,
    period: OPS_REPORT_PERIOD,
    orgName: ORG_NAME,
    loadTasks: () => loadPmTasksFromKb(),
    loadCapacities: () => loadMemberCapacitiesFromKb(),
    resolveTargetJid: () => {
      const wanted = OPS_REPORT_TARGET_GROUP || SHARED_KB_GROUP;
      const entry = Object.entries(registeredGroups).find(
        ([, g]) => g.folder === wanted,
      );
      return entry?.[0] ?? null;
    },
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'Operational report: no channel owns JID');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
    writeDigest: (markdown) => {
      const digestPath = path.join(
        path.dirname(sharedKbTasksDir()),
        'operational-report.md',
      );
      const tmp = `${digestPath}.tmp`;
      fs.mkdirSync(path.dirname(digestPath), { recursive: true });
      fs.writeFileSync(tmp, markdown);
      fs.renameSync(tmp, digestPath);
    },
    // Web delivery (#34): when OPS_REPORT_WEB_BASE_URL is set, write the page-data
    // JSON the agenda-web service (serve.mjs) renders + StatiCrypt-encrypts into
    // ops-<id>.html, and return the public link. Empty base URL → return null so
    // the loop falls back to the markdown DM. Atomic tmp+rename, mkdir -p.
    publishPage: OPS_REPORT_WEB_BASE_URL
      ? (pageId: string, pageData: OpsPageData): string | null => {
          const dir =
            OPS_REPORT_PAGEDATA_DIR ||
            path.join(path.dirname(sharedKbTasksDir()), 'ops-pages');
          try {
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `ops-${pageId}.json`);
            const tmp = `${file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(pageData));
            fs.renameSync(tmp, file);
            return `${OPS_REPORT_WEB_BASE_URL}/ops-${pageId}.html`;
          } catch (err) {
            logger.warn(
              { err, pageId },
              'Operational report: failed to write page-data — falling back to markdown',
            );
            return null;
          }
        }
      : undefined,
  });

  startIpcWatcher({
    sendMessage: (jid, text) => {
      // Route only to a *connected* channel that owns the JID (mirrors
      // routeOutbound). A channel object that exists but isn't connected would
      // otherwise accept the send and silently drop it.
      const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    // Mirror the send path above (a *connected* owning channel) so the watcher
    // can pre-flight a target's routability and surface undeliverable sends
    // instead of dropping them.
    canDeliver: (jid) =>
      channels.some((c) => c.ownsJid(jid) && c.isConnected()),
    deleteMessage: async (jid, messageId) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.deleteMessage) {
        throw new Error(
          `Channel "${channel.name}" does not support deleteMessage`,
        );
      }
      await channel.deleteMessage(jid, messageId);
    },
    editMessage: async (jid, messageId, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.updateStatus) {
        throw new Error(
          `Channel "${channel.name}" does not support editMessage`,
        );
      }
      await channel.updateStatus(jid, messageId, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    dmDiscordUser: async (
      userId: string,
      text: string,
    ): Promise<string | null> => {
      // Find the Discord channel by name. Returns null when Discord
      // isn't wired up (no token, factory bailed) so the IPC handler
      // can render a clear "tool unavailable" message instead of a
      // recipient-side failure. Other platforms would need their own
      // DM primitive — out of scope; the IPC handler only calls this
      // when the target resolved to a Discord identity anyway.
      const discord = channels.find(
        (c) =>
          c.name === 'discord' &&
          (c as unknown as { dmUser?: unknown }).dmUser !== undefined,
      ) as unknown as
        | { dmUser: (userId: string, text: string) => Promise<string> }
        | undefined;
      if (!discord) return null;
      return discord.dmUser(userId, text);
    },
    fetchDiscordHistory: async (channelId, opts) => {
      // Mirror of dmDiscordUser: locate the Discord channel by name and the
      // presence of its fetchChannelHistory primitive. Returns null when
      // Discord isn't wired up so the IPC handler renders a clear "not
      // connected" message instead of an opaque failure.
      const discord = channels.find(
        (c) =>
          c.name === 'discord' &&
          typeof (c as unknown as { fetchChannelHistory?: unknown })
            .fetchChannelHistory === 'function',
      ) as unknown as
        | {
            fetchChannelHistory: (
              channelId: string,
              opts: FetchChannelHistoryOpts,
            ) => Promise<DiscordHistoryMessage[]>;
          }
        | undefined;
      if (!discord) return null;
      return discord.fetchChannelHistory(channelId, opts);
    },
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, isPrivilegedGroup(group), taskRows);
      }
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);

  // Start email poller — routes whitelisted emails to the configured Slack channel.
  // Set EMAIL_FORWARD_SLACK_CHANNEL in .env (e.g. slack:CXXXXXXXXX) to enable the relay.
  const emailForwardJid = process.env.EMAIL_FORWARD_SLACK_CHANNEL;
  if (emailForwardJid) {
    startEmailPoller({
      onEmail: async (from, subject, body) => {
        const channel = findChannel(channels, emailForwardJid);
        if (channel) {
          const text = `📧 *Email from ${from}*\n*Subject:* ${subject}\n\n${body}`;
          await channel.sendMessage(emailForwardJid, text);
        }
      },
    }).catch((err) => logger.error({ err }, 'Email poller failed to start'));
  } else {
    logger.warn(
      'EMAIL_FORWARD_SLACK_CHANNEL not set — email→Slack relay disabled',
    );
  }

  // Keep KB people files + identity rows in sync with the Slack workspace
  // roster. Opt-in via SLACK_MEMBERS_SYNC_INTERVAL_MS; no-op when disabled or
  // no Slack token is configured.
  startSlackMembersSyncLoop();

  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
