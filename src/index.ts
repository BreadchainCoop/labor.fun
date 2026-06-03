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
  MAX_MESSAGES_PER_PROMPT,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
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
  getAllSessions,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
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
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { startEmailPoller } from './email-poller.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
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
import './integrations/index.js';
import { startRegisteredIntegrations } from './integrations/registry.js';
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

  const prompt = formatMessages(missedMessages, TIMEZONE);

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

  // Write sender context to IPC so the container agent knows who it's talking to
  const lastMsg = missedMessages[missedMessages.length - 1];
  if (lastMsg && !lastMsg.is_from_me) {
    const channelName = chatJid.startsWith('tg:')
      ? 'telegram'
      : chatJid.startsWith('slack:')
        ? 'slack'
        : 'unknown';
    const senderCtx = getSenderContext(lastMsg.sender, channelName);
    if (senderCtx) {
      const ipcInputDir = resolveGroupIpcPath(group.folder) + '/input';
      fs.mkdirSync(ipcInputDir, { recursive: true });
      fs.writeFileSync(
        path.join(ipcInputDir, 'sender_context.json'),
        JSON.stringify(senderCtx),
      );
    }
  }

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

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
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
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

  // Calculate output length for logging
  const outputText = typeof output === 'string' ? output : '';
  const runDuration = Date.now() - runStartTime;

  if (output === 'error' || hadError) {
    completeAgentRun(
      runId,
      'error',
      outputText.length,
      runDuration,
      outputSentToUser
        ? 'Agent returned error (partial output sent to user)'
        : 'Agent returned error (no output sent)',
    );
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

  completeAgentRun(runId, 'success', outputText.length, runDuration);
  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  // Flat-access (cooperative) mode elevates every group to main-equivalent
  // mounts/IPC auth. isMain here drives container mounts, the NANOCLAW_IS_MAIN
  // env, and the tasks/groups snapshots.
  const isMain = isPrivilegedGroup(group);
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

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  //
  // Order matters. Disconnect the channels FIRST so each gateway session is
  // cleanly torn down (DiscordChannel.disconnect() → client.destroy()) before
  // anything that can block. Previously channels were disconnected LAST, after
  // proxyServer.close() + queue.shutdown(): proxyServer.close() waits for
  // in-flight credential-proxy connections (a running agent container streaming
  // a model response holds one open), which can outlast systemd's stop timeout.
  // systemd then SIGKILLs the process before disconnect() ever runs, leaving the
  // Discord gateway half-open — and the NEXT orchestrator inherits a "connected
  // but receives no events" zombie session, so the bot silently stops
  // responding until it is restarted again.
  //
  // A force-exit backstop guarantees we exit well within systemd's stop window
  // even if a disconnect/close/drain hangs, so the process terminates cleanly
  // rather than being SIGKILLed. `shuttingDown` guards a second racing signal.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received');

    const force = setTimeout(() => {
      logger.warn('Graceful shutdown exceeded 8s — forcing exit');
      process.exit(0);
    }, 8000);
    force.unref();

    // 1. Close channel gateways first — bounded so a slow disconnect can't hang.
    await Promise.race([
      Promise.allSettled(channels.map((ch) => ch.disconnect())),
      new Promise((resolve) => setTimeout(resolve, 4000)),
    ]);

    // 2. Best-effort drain of everything else; none of it can resurrect the
    //    gateway, so it's safe even if the force-exit fires mid-drain.
    proxyServer.close();
    await queue.shutdown(3000);

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

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
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
  };

  // Load the active profile's plugins so org-specific channels/flows
  // self-register before we wire channels and start integrations. (Core
  // channels/flows are registered by the barrel imports at the top of file.)
  await loadProfilePlugins();

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
    logger.fatal('No channels connected');
    process.exit(1);
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
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
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
