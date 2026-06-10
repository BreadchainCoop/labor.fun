import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';
import matter from 'gray-matter';
import nodemailer from 'nodemailer';

import {
  DATA_DIR,
  FLAT_ACCESS,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  isMembershipChannel,
  PROJECT_ROOT,
  SERVICE_USER,
  SHARED_KB_GROUP,
  TIMEZONE,
} from './config.js';
import { PersonCandidate, resolveDmTarget } from './integrations/dm-resolve.js';
import { readEnvFile } from './env.js';
import { AvailableGroup } from './container-runner.js';
import {
  createTask,
  deleteTask,
  getTaskById,
  updateTask,
  createMeetingSummary,
  getMeetingSummaryById,
  createProposedTasksBatch,
  getProposedTask,
  updateProposedTaskStatus,
  createExpense,
  getExpense,
  updateExpenseApproval,
  attachReceipt,
  markReimbursed,
  cancelExpense,
  Expense,
  ExpenseStatus,
  isBotMessage,
  getRecentBotMessages,
  logKbAudit,
} from './db.js';
import { writeApprovedTaskFile } from './kb-tasks.js';
import { writeOutboundSnapshot } from './container-runner.js';
import { isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import type { DiscordHistoryMessage } from './channels/discord.js';
import { RegisteredGroup } from './types.js';

// --- Email whitelist and transporter ---
// Comma-separated list of allowed inbound/outbound email addresses.
// If empty, all emails are rejected (safe default).
const EMAIL_WHITELIST = (process.env.EMAIL_WHITELIST || '')
  .split(',')
  .map((e) => e.trim())
  .filter(Boolean);

if (EMAIL_WHITELIST.length === 0) {
  logger.warn(
    'EMAIL_WHITELIST not set — all email send/receive will be rejected',
  );
}

const emailEnv = readEnvFile(['BREADBRICH_EMAIL', 'BREADBRICH_EMAIL_PASSWORD']);

let emailTransporter: nodemailer.Transporter | null = null;

function getEmailTransporter(): nodemailer.Transporter | null {
  if (emailTransporter) return emailTransporter;
  const user = process.env.BREADBRICH_EMAIL || emailEnv.BREADBRICH_EMAIL;
  const pass =
    process.env.BREADBRICH_EMAIL_PASSWORD || emailEnv.BREADBRICH_EMAIL_PASSWORD;
  if (!user || !pass) {
    logger.warn(
      'BREADBRICH_EMAIL or BREADBRICH_EMAIL_PASSWORD not set — email disabled',
    );
    return null;
  }
  emailTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: { user, pass },
  });
  return emailTransporter;
}

// --- KB file modification access control ---

const KB_CONTEXT_DIR = path.join(GROUPS_DIR, SHARED_KB_GROUP, 'context');

/**
 * Resolve a KB-relative path against `KB_CONTEXT_DIR` and refuse anything
 * that escapes it. Returns the absolute path on success, or null when the
 * input is empty / non-string / resolves outside the KB context dir.
 * Using `path.resolve` + a prefix check is the canonical Node pattern;
 * substring-replacing `..` is fragile (e.g. `....//` survives).
 */
function resolveKbPath(input: unknown): string | null {
  if (typeof input !== 'string' || input.trim() === '') return null;
  // Strip leading slashes so absolute-looking inputs are treated as
  // relative to KB_CONTEXT_DIR rather than re-anchoring at filesystem root.
  const rel = input.replace(/^\/+/, '');
  const resolved = path.resolve(KB_CONTEXT_DIR, rel);
  const prefix = KB_CONTEXT_DIR.endsWith(path.sep)
    ? KB_CONTEXT_DIR
    : KB_CONTEXT_DIR + path.sep;
  if (resolved !== KB_CONTEXT_DIR && !resolved.startsWith(prefix)) {
    return null;
  }
  return resolved;
}

/**
 * Resolve the service user's numeric uid/gid once at startup so KB writes
 * can transfer ownership without spawning a shell. The user comes from
 * SERVICE_USER (the active profile's serviceUser, overridable per env).
 * Returns null when that user isn't present on this host (typical in dev),
 * in which case the chown step is skipped — the orchestrator runs as the
 * service user in production, so the write already lands with the right
 * owner. The shell-out (previously `execSync(chown ...)`) was a
 * command-injection sink whose input was agent-controlled; switching to
 * `fs.chownSync` with cached numeric ids closes that.
 */
let kbOwnerIdsCached: { uid: number; gid: number } | null | undefined;
function getKbOwnerIds(): { uid: number; gid: number } | null {
  if (kbOwnerIdsCached !== undefined) return kbOwnerIdsCached;
  try {
    // execFileSync (no shell) with a literal username — no interpolation.
    // `--` ends option parsing so a SERVICE_USER starting with `-` is treated
    // as a username, not a flag.
    const uid = parseInt(
      execFileSync('id', ['-u', '--', SERVICE_USER]).toString().trim(),
      10,
    );
    const gid = parseInt(
      execFileSync('id', ['-g', '--', SERVICE_USER]).toString().trim(),
      10,
    );
    if (!Number.isFinite(uid) || !Number.isFinite(gid)) {
      kbOwnerIdsCached = null;
    } else {
      kbOwnerIdsCached = { uid, gid };
    }
  } catch {
    kbOwnerIdsCached = null;
  }
  return kbOwnerIdsCached;
}

// Flat permission model: any allowlisted (known) sender can write any KB
// file. Unknown senders are rejected. Callers are responsible for
// normalizing the path and confirming it resolves under KB_CONTEXT_DIR
// before invoking fs writes — this helper only owns the identity gate.
function canModifyKbFile(senderCtx: IpcSenderCtx | null): {
  allowed: boolean;
  reason: string;
} {
  if (!senderCtx) {
    return { allowed: false, reason: 'Unknown sender — no identity mapping' };
  }
  return { allowed: true, reason: 'Allowlisted sender' };
}

/**
 * Validated per-IPC-call sender context. A non-null value means the
 * orchestrator resolved the sender to a known KB person; `user_id` is the
 * single authoritative attribution field downstream code may rely on.
 */
interface IpcSenderCtx {
  user_id: string;
  display_name: string;
  tags: string[];
}

/**
 * Parse and validate a raw sender_context payload. Returns null when
 * `user_id` is missing or not a non-empty string — the orchestrator never
 * writes a context without one, so a missing `user_id` means corrupted /
 * untrusted input and must not pass any allowlist gate.
 */
function parseSenderCtx(raw: unknown): IpcSenderCtx | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const userId = typeof obj.user_id === 'string' ? obj.user_id.trim() : '';
  if (!userId) return null;
  const displayName =
    typeof obj.display_name === 'string' && obj.display_name.trim() !== ''
      ? obj.display_name
      : userId;
  const tags = Array.isArray(obj.tags)
    ? obj.tags.filter((t): t is string => typeof t === 'string')
    : [];
  return { user_id: userId, display_name: displayName, tags };
}

/**
 * Read the per-IPC-call sender context written by the orchestrator.
 * Returns null when absent (scheduled-task triggers carry no sender) or
 * when the file fails validation. Used by the IPC watcher during its
 * directory scan; the equivalent helper anchored at DATA_DIR is
 * `readSenderContext(sourceGroup)` below.
 */
function readSenderCtxFromDir(
  ipcBaseDir: string,
  sourceGroup: string,
): IpcSenderCtx | null {
  try {
    const ctxPath = path.join(
      ipcBaseDir,
      sourceGroup,
      'input',
      'sender_context.json',
    );
    if (!fs.existsSync(ctxPath)) return null;
    return parseSenderCtx(JSON.parse(fs.readFileSync(ctxPath, 'utf-8')));
  } catch {
    return null;
  }
}

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  deleteMessage: (jid: string, messageId: string) => Promise<void>;
  editMessage: (jid: string, messageId: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  /**
   * Open / fetch a DM channel with a Discord user and send a message.
   * Used by the `dm_user` IPC op.
   *
   * Returns the DM channel id on success. Returns `null` when the
   * Discord channel isn't wired up (no token / factory bailed) so the
   * IPC handler can render an unambiguous "Discord not connected"
   * message instead of a misleading recipient-side failure. Throws on
   * permission / visibility errors (DiscordAPIError) so those can be
   * surfaced with their underlying message.
   */
  dmDiscordUser?: (userId: string, text: string) => Promise<string | null>;
  /**
   * Fetch a Discord channel's message history (request/response IPC, unlike
   * the fire-and-forget ops above). Returns the messages, or `null` when the
   * Discord channel isn't wired up so the handler can render a clear "not
   * connected" message. Used by the `fetch_discord_history` request op.
   */
  fetchDiscordHistory?: (
    channelId: string,
    opts: { limit?: number; before?: string; sinceIso?: string },
  ) => Promise<DiscordHistoryMessage[] | null>;
  onTasksChanged: () => void;
}

function refreshOutboundSnapshot(groupFolder: string, chatJid: string): void {
  try {
    const messages = getRecentBotMessages(chatJid, 10);
    writeOutboundSnapshot(groupFolder, messages);
  } catch (err) {
    logger.warn(
      { groupFolder, chatJid, err },
      'Failed to refresh outbound snapshot',
    );
  }
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups, and the set of folders
    // belonging to external membership-intake channels (untrusted/sandboxed).
    const folderIsMain = new Map<string, boolean>();
    const membershipFolders = new Set<string>();
    for (const [jid, group] of Object.entries(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
      if (isMembershipChannel(jid)) membershipFolders.add(group.folder);
    }

    for (const sourceGroup of groupFolders) {
      // External membership-intake channels are sandboxed and have no IPC
      // write tools; defense in depth — ignore ALL IPC from them so a
      // prompt-injected intake run can never reach a privileged op.
      if (membershipFolders.has(sourceGroup)) {
        try {
          for (const sub of ['messages', 'tasks']) {
            const d = path.join(ipcBaseDir, sourceGroup, sub);
            if (!fs.existsSync(d)) continue;
            for (const f of fs.readdirSync(d)) {
              if (f.endsWith('.json')) fs.unlinkSync(path.join(d, f));
            }
          }
        } catch {
          /* best-effort cleanup */
        }
        logger.warn(
          { sourceGroup },
          'Ignoring IPC from external membership channel (sandboxed)',
        );
        continue;
      }
      // Flat-access (cooperative) mode: every group authorizes IPC ops as
      // main. Restore the sandbox with FLAT_ACCESS=false.
      const isMain = folderIsMain.get(sourceGroup) === true || FLAT_ACCESS;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Flat permission model: any registered group can send to
                // its own chat; cross-group sends require an allowlisted
                // human sender (or main-group origin / scheduled-task in
                // the destination group itself).
                const targetGroup = registeredGroups[data.chatJid];
                const isSameGroup =
                  targetGroup && targetGroup.folder === sourceGroup;
                const senderCtx = readSenderCtxFromDir(ipcBaseDir, sourceGroup);
                const hasSenderCtx = senderCtx !== null;

                if (isMain || isSameGroup || hasSenderCtx) {
                  await deps.sendMessage(data.chatJid, data.text);
                  refreshOutboundSnapshot(sourceGroup, data.chatJid);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup, hasSenderCtx },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (
                (data.type === 'delete_message' ||
                  data.type === 'edit_message') &&
                data.chatJid &&
                data.messageId
              ) {
                const targetGroup = registeredGroups[data.chatJid];
                const isSameGroup =
                  targetGroup && targetGroup.folder === sourceGroup;
                const senderCtx = readSenderCtxFromDir(ipcBaseDir, sourceGroup);
                const hasSenderCtx = senderCtx !== null;
                const authorized = isMain || isSameGroup || hasSenderCtx;
                if (!authorized) {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup, type: data.type },
                    'Unauthorized IPC message edit/delete blocked',
                  );
                } else if (!isBotMessage(data.chatJid, data.messageId)) {
                  logger.warn(
                    {
                      chatJid: data.chatJid,
                      messageId: data.messageId,
                      sourceGroup,
                      type: data.type,
                    },
                    'Edit/delete blocked — message is not a bot message',
                  );
                } else if (data.type === 'delete_message') {
                  await deps.deleteMessage(data.chatJid, data.messageId);
                  refreshOutboundSnapshot(sourceGroup, data.chatJid);
                  logger.info(
                    {
                      chatJid: data.chatJid,
                      messageId: data.messageId,
                      sourceGroup,
                    },
                    'IPC message deleted',
                  );
                } else if (data.type === 'edit_message' && data.text) {
                  await deps.editMessage(
                    data.chatJid,
                    data.messageId,
                    data.text,
                  );
                  refreshOutboundSnapshot(sourceGroup, data.chatJid);
                  logger.info(
                    {
                      chatJid: data.chatJid,
                      messageId: data.messageId,
                      sourceGroup,
                    },
                    'IPC message edited',
                  );
                }
              } else if (
                data.type === 'email' &&
                data.to &&
                data.subject &&
                data.body
              ) {
                // Email sending via SMTP — whitelist enforced
                const recipient = data.to.toLowerCase().trim();
                if (!EMAIL_WHITELIST.includes(recipient)) {
                  logger.warn(
                    { to: data.to, sourceGroup },
                    'Email blocked — recipient not in whitelist',
                  );
                } else {
                  const transport = getEmailTransporter();
                  if (transport) {
                    try {
                      await transport.sendMail({
                        from: `Breadbrich Engels <${process.env.BREADBRICH_EMAIL}>`,
                        to: data.to,
                        subject: data.subject,
                        text: data.body,
                      });
                      logger.info(
                        { to: data.to, subject: data.subject, sourceGroup },
                        'Email sent',
                      );
                    } catch (emailErr) {
                      logger.error(
                        { to: data.to, emailErr },
                        'Failed to send email',
                      );
                    }
                  }
                }
              } else if (data.type === 'modify_kb_file' && data.filePath) {
                // KB file modification — flat permission model: any
                // allowlisted sender (or main-group origin / same-group
                // scheduled task) may modify any KB file.
                let senderCtx: IpcSenderCtx | null = readSenderCtxFromDir(
                  ipcBaseDir,
                  sourceGroup,
                );
                if (!senderCtx && isMain) {
                  // Main-group origin without an attached sender (e.g. a
                  // scheduled task fired in the control channel) is
                  // implicitly authorized; attribute the audit trail to a
                  // synthetic system identity so the gate stays
                  // semantically a *validated* allowlist hit.
                  senderCtx = {
                    user_id: `system:scheduled@${sourceGroup}`,
                    display_name: 'scheduled task',
                    tags: [],
                  };
                }

                const { allowed, reason } = canModifyKbFile(senderCtx);

                if (!allowed) {
                  logger.warn(
                    { filePath: data.filePath, sourceGroup, reason },
                    'KB file modification blocked — insufficient permissions',
                  );
                } else {
                  const fullPath = resolveKbPath(data.filePath);
                  if (!fullPath) {
                    logger.warn(
                      { filePath: data.filePath, sourceGroup },
                      'KB file modification blocked — path escapes KB context dir',
                    );
                  } else {
                    const normalized = path.relative(KB_CONTEXT_DIR, fullPath);
                    const action = data.action || 'write';

                    if (action === 'delete') {
                      if (fs.existsSync(fullPath)) {
                        fs.unlinkSync(fullPath);
                        logger.info(
                          { filePath: normalized, sourceGroup, reason },
                          'KB file deleted via IPC',
                        );
                      }
                    } else {
                      // Ensure parent directory exists
                      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
                      fs.writeFileSync(fullPath, data.content || '');
                      // Fix ownership when running as a user other than
                      // breadbrich (e.g. when the orchestrator runs as
                      // root in some bootstrap paths). Uses cached
                      // numeric ids + fs.chownSync — no shell, no
                      // interpolation of agent-controlled paths.
                      const ids = getKbOwnerIds();
                      if (ids && process.getuid?.() !== ids.uid) {
                        try {
                          fs.chownSync(fullPath, ids.uid, ids.gid);
                        } catch {
                          /* best-effort; permissions failure is logged elsewhere */
                        }
                      }
                      logger.info(
                        { filePath: normalized, sourceGroup, reason },
                        'KB file written via IPC',
                      );
                    }
                  }
                }
              } else if (
                data.type === 'add_kb_user' &&
                data.username &&
                data.target_telegram_jid
              ) {
                // Create a KB-UI auth entry + DM the credentials.
                // Flat model: any allowlisted sender may invoke. This op
                // creates auth credentials so we require a validated
                // sender_context with a real user_id for attribution —
                // implicit isMain (scheduled task in the control channel)
                // does NOT pass; the orchestrator must attach a sender.
                const senderCtx = readSenderCtxFromDir(ipcBaseDir, sourceGroup);

                if (!senderCtx) {
                  logger.warn(
                    {
                      sourceGroup,
                      isMain,
                      username: data.username,
                    },
                    'add_kb_user rejected — requires validated allowlisted sender (user_id)',
                  );
                } else if (!/^[a-z][a-z0-9_-]{0,31}$/.test(data.username)) {
                  logger.warn(
                    { username: data.username, sourceGroup },
                    'add_kb_user rejected — invalid username format',
                  );
                } else {
                  const usersFile =
                    process.env.USERS_FILE ||
                    path.join(PROJECT_ROOT, 'kb-ui', 'users.json');
                  let users: Record<string, string> = {};
                  try {
                    if (fs.existsSync(usersFile)) {
                      users = JSON.parse(fs.readFileSync(usersFile, 'utf-8'));
                    }
                  } catch (err) {
                    logger.error(
                      { err, usersFile },
                      'add_kb_user — could not read users file',
                    );
                  }

                  if (users[data.username]) {
                    logger.warn(
                      { username: data.username, sourceGroup },
                      'add_kb_user rejected — username already exists',
                    );
                  } else {
                    const crypto = await import('crypto');
                    const password = `cnvt-${data.username.slice(0, 2)}-${crypto
                      .randomBytes(6)
                      .toString('base64url')}`;
                    users[data.username] = password;
                    try {
                      fs.writeFileSync(
                        usersFile,
                        JSON.stringify(users, null, 2),
                      );
                      const dmText = `Your Breadbrich Engels KB-UI account is ready.\n\nUsername: ${data.username}\nPassword: ${password}\nLogin: https://kb.example.com\n\n(Password sent via DM only; please log in and change/note it.)`;
                      await deps.sendMessage(data.target_telegram_jid, dmText);
                      logger.info(
                        {
                          username: data.username,
                          target: data.target_telegram_jid,
                          sourceGroup,
                          createdBy: senderCtx.user_id,
                        },
                        "KB user created and credentials DM'd",
                      );
                    } catch (err) {
                      logger.error(
                        { err, username: data.username },
                        'add_kb_user — write or DM failed',
                      );
                    }
                  }
                }
              } else if (
                data.type === 'modify_group_claude_md' &&
                data.target_folder &&
                typeof data.new_content === 'string'
              ) {
                // Rewrite another group's CLAUDE.md. Flat model: any
                // allowlisted sender may invoke. This op rewrites another
                // group's agent memory and is audited; we require a
                // validated sender_context (user_id) so every entry in
                // kb_audit_log is attributable to a real allowlisted user.
                const senderCtx = readSenderCtxFromDir(ipcBaseDir, sourceGroup);
                handleModifyGroupClaudeMd(
                  {
                    target_folder: data.target_folder,
                    new_content: data.new_content,
                    summary:
                      typeof data.summary === 'string'
                        ? data.summary
                        : undefined,
                  },
                  { sourceGroup, isMain, senderCtx },
                );
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc; it reads
              // sender_context.json itself to decide allowlist gates.
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }

      // Process request/response ops from this group's IPC directory. Unlike
      // messages/tasks (fire-and-forget), a request expects a reply written
      // back to `responses/<requestId>.json` for the agent to read. Each
      // request file is consumed (deleted) on read, then handled
      // asynchronously so a slow fetch never blocks the watcher loop.
      //
      // Handlers run concurrently but are capped at MAX_INFLIGHT_REQUESTS to
      // bound Discord API pagination fan-out (rate-limit / memory pressure).
      // When at capacity we leave remaining request files untouched so the
      // next poll tick picks them up — natural backpressure.
      const requestsDir = path.join(ipcBaseDir, sourceGroup, 'requests');
      try {
        if (fs.existsSync(requestsDir)) {
          const requestFiles = fs
            .readdirSync(requestsDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of requestFiles) {
            if (inFlightRequests >= MAX_INFLIGHT_REQUESTS) break;
            const filePath = path.join(requestsDir, file);
            let data: Record<string, unknown>;
            try {
              data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error parsing IPC request — moving to errors',
              );
              // Best-effort quarantine. If the move itself fails, delete the
              // file so a poison request can't be retried every tick.
              try {
                const errorDir = path.join(ipcBaseDir, 'errors');
                fs.mkdirSync(errorDir, { recursive: true });
                fs.renameSync(
                  filePath,
                  path.join(errorDir, `${sourceGroup}-${file}`),
                );
              } catch (moveErr) {
                logger.warn(
                  { file, sourceGroup, moveErr },
                  'Failed to quarantine bad request — unlinking instead',
                );
                try {
                  fs.unlinkSync(filePath);
                } catch {
                  /* already gone */
                }
              }
              continue;
            }
            // Consume immediately so the next tick can't reprocess it.
            try {
              fs.unlinkSync(filePath);
            } catch {
              /* already gone */
            }
            // Fire-and-forget the handler; it writes its own response file.
            // Release the in-flight slot when it settles (success or throw).
            inFlightRequests++;
            void handleRequestIpc(
              data,
              {
                sourceGroup,
                isMain,
                ipcBaseDir,
              },
              deps,
            ).finally(() => {
              inFlightRequests--;
            });
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC requests directory',
        );
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

// --- Request/response IPC ---
//
// The request/response channel is the read-direction counterpart to the
// fire-and-forget message/task ops. The agent writes a request to
// `<group>/requests/`, the orchestrator handles it and writes the reply to
// `<group>/responses/<requestId>.json`, which the agent polls and reads.
// Response files are written atomically (tmp + rename) so the agent never
// observes a partial JSON.

/** Max messages a single fetch_discord_history request may return. */
const DISCORD_HISTORY_MAX = 2000;

/**
 * Cap on concurrently-running request handlers across all groups. Bounds
 * Discord API pagination fan-out; excess requests wait for the next poll tick.
 */
const MAX_INFLIGHT_REQUESTS = 4;
let inFlightRequests = 0;

/**
 * A request id must be a plain filename token — it's interpolated into the
 * response path (`responses/<requestId>.json`). Rejecting anything with path
 * separators, dots, or other unsafe characters prevents a crafted request
 * from steering the orchestrator's write outside the responses dir.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Write a request's response into the group's `responses/` dir, atomically.
 * The temp file is given an explicit world-readable mode and chowned to the
 * service user (mirrors the KB-write path) *before* the rename, so the agent
 * — which may run under a different uid — never observes a present-but-
 * unreadable file in the window between rename and a post-hoc chown.
 */
function writeIpcResponse(
  ipcBaseDir: string,
  sourceGroup: string,
  requestId: string,
  payload: unknown,
): void {
  const responsesDir = path.join(ipcBaseDir, sourceGroup, 'responses');
  fs.mkdirSync(responsesDir, { recursive: true });
  const outPath = path.join(responsesDir, `${requestId}.json`);
  const tmpPath = `${outPath}.tmp`;
  // 0o644: readable by the container regardless of a restrictive host umask.
  fs.writeFileSync(tmpPath, JSON.stringify(payload), { mode: 0o644 });
  const ids = getKbOwnerIds();
  if (ids && process.getuid?.() !== ids.uid) {
    try {
      fs.chownSync(tmpPath, ids.uid, ids.gid);
    } catch {
      /* best-effort; same uid in prod, so usually a no-op */
    }
  }
  // Rename last — the agent only ever sees the final, owned, readable file.
  fs.renameSync(tmpPath, outPath);
}

/**
 * Handle a single request-op IPC file. Always writes exactly one response
 * (success or error) keyed by `requestId` so the agent's poll terminates.
 * Authorization follows the flat model used elsewhere: main-group origin or
 * an allowlisted sender (validated sender_context with a user_id).
 */
export async function handleRequestIpc(
  data: Record<string, unknown>,
  ctx: { sourceGroup: string; isMain: boolean; ipcBaseDir: string },
  deps: IpcDeps,
): Promise<void> {
  // requestId is interpolated into the response file path, so it must be a
  // safe filename token — reject path separators / traversal outright. An
  // invalid id is dropped (no response written): we have nowhere safe to put
  // one, and a well-behaved agent never produces such an id.
  const requestId =
    typeof data.requestId === 'string' && SAFE_REQUEST_ID.test(data.requestId)
      ? data.requestId
      : null;
  if (!requestId) {
    logger.warn(
      {
        sourceGroup: ctx.sourceGroup,
        type: data.type,
        requestId: data.requestId,
      },
      'Request IPC missing or unsafe requestId — cannot respond, dropping',
    );
    return;
  }

  const respond = (payload: Record<string, unknown>) =>
    writeIpcResponse(ctx.ipcBaseDir, ctx.sourceGroup, requestId, payload);

  try {
    if (data.type !== 'fetch_discord_history') {
      respond({ ok: false, error: `Unknown request type: ${data.type}` });
      return;
    }

    // Authorization: allowlisted sender OR main-group origin. Reading a
    // channel's backlog is privacy-sensitive, so unauthenticated scheduled
    // runs in a non-main group are rejected.
    const senderCtx = readSenderCtxFromDir(ctx.ipcBaseDir, ctx.sourceGroup);
    if (!ctx.isMain && senderCtx === null) {
      logger.warn(
        { sourceGroup: ctx.sourceGroup },
        'fetch_discord_history blocked — requires allowlisted sender or main group',
      );
      respond({
        ok: false,
        error:
          'Unauthorized: fetching channel history requires an allowlisted sender or the main group.',
      });
      return;
    }

    if (!deps.fetchDiscordHistory) {
      respond({ ok: false, error: 'Discord channel is not connected.' });
      return;
    }

    const channelId = String(data.channelId ?? '')
      .replace(/^dc:/, '')
      .trim();
    if (!channelId) {
      respond({ ok: false, error: '`channel_id` is required.' });
      return;
    }

    const rawLimit =
      typeof data.limit === 'number' && Number.isFinite(data.limit)
        ? Math.floor(data.limit)
        : undefined;
    const limit =
      rawLimit !== undefined
        ? Math.min(Math.max(rawLimit, 1), DISCORD_HISTORY_MAX)
        : undefined;
    // Trim and coerce blank strings to undefined — an empty `before`/`since`
    // would otherwise reach Discord as a malformed cursor and error opaquely.
    const trimToUndef = (v: unknown): string | undefined => {
      if (typeof v !== 'string') return undefined;
      const t = v.trim();
      return t === '' ? undefined : t;
    };
    const before = trimToUndef(data.before);
    const sinceIso = trimToUndef(data.sinceIso);

    const messages = await deps.fetchDiscordHistory(channelId, {
      limit,
      before,
      sinceIso,
    });
    if (messages === null) {
      respond({ ok: false, error: 'Discord channel is not connected.' });
      return;
    }

    respond({ ok: true, channelId, count: messages.length, messages });
    logger.info(
      {
        channelId,
        count: messages.length,
        sourceGroup: ctx.sourceGroup,
        authedBy: senderCtx?.user_id ?? 'main',
      },
      'fetch_discord_history served',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { sourceGroup: ctx.sourceGroup, requestId, err: msg },
      'fetch_discord_history failed',
    );
    respond({ ok: false, error: msg });
  }
}

// --- Cross-group CLAUDE.md modification ---
//
// Any allowlisted sender (from any registered group) can rewrite any other
// group's CLAUDE.md via this IPC. Because the write is silent and
// privileged (it changes how another group's agent behaves) we require a
// validated sender_context — implicit isMain (a scheduled task in the
// control channel without an attached user) is NOT accepted, so every
// kb_audit_log entry is attributable to a real allowlisted user_id.
// Read-direction visibility (G1: /workspace/all-groups mount) lets agents
// learn what's happening; this is the write-direction counterpart.
//
// Gates compose AND, not OR:
//   1. allowlisted    — sender_context with a validated user_id is present
//   2. valid folder   — isValidGroupFolder rejects path-traversal attempts
//   3. size cap       — refuses pathological payloads
//
// Silent by design: no notification to the target group's members. Every
// successful write inserts a kb_audit_log row including the sender, source
// group, byte sizes before/after, and an optional human-readable summary.

const CLAUDE_MD_MAX_BYTES = 200 * 1024; // 200 KB ceiling

export interface ModifyGroupClaudeMdInput {
  target_folder: string;
  new_content: string;
  summary?: string;
}

export interface ModifyGroupClaudeMdResult {
  status: 'ok' | 'rejected' | 'error';
  reason?: string;
  bytesBefore?: number;
  bytesAfter?: number;
}

export function handleModifyGroupClaudeMd(
  input: ModifyGroupClaudeMdInput,
  ctx: {
    sourceGroup: string;
    isMain: boolean;
    senderCtx: IpcSenderCtx | null;
  },
): ModifyGroupClaudeMdResult {
  const { target_folder, new_content, summary } = input;

  if (!ctx.senderCtx) {
    logger.warn(
      {
        sourceGroup: ctx.sourceGroup,
        isMain: ctx.isMain,
        target_folder,
      },
      'modify_group_claude_md rejected — requires validated allowlisted sender (user_id)',
    );
    return { status: 'rejected', reason: 'unauthorized' };
  }

  if (typeof target_folder !== 'string' || !isValidGroupFolder(target_folder)) {
    logger.warn(
      { sourceGroup: ctx.sourceGroup, target_folder },
      'modify_group_claude_md rejected — invalid target_folder',
    );
    return { status: 'rejected', reason: 'invalid_target_folder' };
  }

  if (typeof new_content !== 'string') {
    return { status: 'rejected', reason: 'invalid_new_content' };
  }

  const bytesAfter = Buffer.byteLength(new_content, 'utf-8');
  if (bytesAfter > CLAUDE_MD_MAX_BYTES) {
    logger.warn(
      { sourceGroup: ctx.sourceGroup, target_folder, bytesAfter },
      'modify_group_claude_md rejected — new_content exceeds size cap',
    );
    return { status: 'rejected', reason: 'oversized' };
  }

  const targetPath = path.join(
    resolveGroupFolderPath(target_folder),
    'CLAUDE.md',
  );

  let bytesBefore = 0;
  try {
    if (fs.existsSync(targetPath)) {
      bytesBefore = fs.statSync(targetPath).size;
    }
  } catch {
    /* treat as new file */
  }

  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const tmpPath = `${targetPath}.tmp`;
    fs.writeFileSync(tmpPath, new_content);
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    logger.error(
      { err, sourceGroup: ctx.sourceGroup, target_folder, targetPath },
      'modify_group_claude_md — write failed',
    );
    return { status: 'error', reason: 'write_failed' };
  }

  try {
    logKbAudit({
      filePath: targetPath,
      action: 'modify_group_claude_md',
      changedBy: ctx.senderCtx.user_id,
      changes: {
        sourceGroup: ctx.sourceGroup,
        targetFolder: target_folder,
        bytesBefore,
        bytesAfter,
        summary: summary ?? null,
      },
    });
  } catch (err) {
    // Don't roll back the write — the file is updated; audit failure is a
    // secondary concern logged for follow-up.
    logger.error(
      { err, sourceGroup: ctx.sourceGroup, target_folder },
      'modify_group_claude_md — audit log insert failed (file was written)',
    );
  }

  logger.info(
    {
      sourceGroup: ctx.sourceGroup,
      target_folder,
      bytesBefore,
      bytesAfter,
      hasSummary: Boolean(summary),
    },
    'modify_group_claude_md applied',
  );
  return { status: 'ok', bytesBefore, bytesAfter };
}

/**
 * Build the allowlisted-member candidate list for `dm_user` from the
 * Discord-members sync's output: every `<sharedKb>/context/people/*.md`
 * whose frontmatter has a `discord_id`. Cheap to call on demand (~25
 * files, sub-ms with gray-matter). No caching — the periodic members
 * sync rewrites files in place and we want a fresh view each call.
 */
function loadDiscordCandidates(): PersonCandidate[] {
  const dir = path.join(GROUPS_DIR, SHARED_KB_GROUP, 'context', 'people');
  if (!fs.existsSync(dir)) return [];
  const out: PersonCandidate[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    if (f.startsWith('.')) continue;
    try {
      const parsed = matter(fs.readFileSync(path.join(dir, f), 'utf-8'));
      const fm = parsed.data as Record<string, unknown>;
      const id = typeof fm.discord_id === 'string' ? fm.discord_id : null;
      if (!id) continue;
      out.push({
        slug: f.replace(/\.md$/, ''),
        discordId: id,
        title: typeof fm.title === 'string' ? fm.title : '',
        discordUsername:
          typeof fm.discord_username === 'string' ? fm.discord_username : '',
        discordDisplayName:
          typeof fm.discord_display_name === 'string'
            ? fm.discord_display_name
            : '',
      });
    } catch {
      // Skip unparseable files — they're not the source of truth here.
    }
  }
  return out;
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // Shared optional fields used across task/expense operations
    date?: string;
    event_id?: string;
    notes?: string;
    status?: string;
    // For meeting summaries
    summaryId?: string;
    title?: string;
    transcript_text?: string;
    summary_html?: string;
    action_items?: string;
    extracted_events?: string;
    extracted_people?: string;
    extracted_tasks?: string;
    extracted_documents?: string;
    clarification_questions?: string;
    // For transcript task approval
    summary_id?: string;
    tasks?: Array<{
      title: string;
      description?: string;
      proposed_assignee?: string;
      proposed_due_date?: string;
      source_quote?: string;
    }>;
    items?: Array<{
      proposed_task_id: string;
      final_title?: string;
      final_assignee?: string;
      final_due_date?: string;
    }>;
    proposed_task_id?: string;
    reason?: string | null;
    // For expense operations
    expense_id?: string;
    request_type?: 'prospective' | 'retrospective' | string;
    decision?: 'approve' | 'deny' | 'modify' | string;
    amount_cents?: number;
    approved_amount_cents?: number;
    actual_amount_cents?: number;
    currency?: string;
    description?: string;
    category?: string | null;
    vendor?: string | null;
    justification?: string | null;
    expected_date?: string | null;
    incurred_date?: string | null;
    approver_notes?: string | null;
    receipt_path?: string | null;
    reimbursement_method?: string;
    // For dm_user
    target?: string;
    text?: string;
    sourceJid?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();
  // Allowlisted-sender check: a human-triggered run carries a sender
  // context written by the orchestrator. Scheduled-task runs do not.
  const hasSenderCtx = readSenderContext(sourceGroup) !== null;

  switch (data.type) {
    case 'dm_user': {
      const target = (data.target || '').trim();
      const text = (data.text || '').trim();
      const sourceJid = data.sourceJid;
      // Best-effort fallback: resolve source-group JID from registered_groups
      // if the tool didn't pass one along.
      const notifyJid =
        sourceJid ||
        Object.entries(registeredGroups).find(
          ([, g]) => g.folder === sourceGroup,
        )?.[0] ||
        null;

      const notify = async (msg: string) => {
        if (!notifyJid) {
          logger.warn(
            { sourceGroup, msg },
            'dm_user: no source JID to send feedback to',
          );
          return;
        }
        try {
          await deps.sendMessage(notifyJid, msg);
        } catch (err) {
          logger.warn(
            { notifyJid, err },
            'dm_user: failed to post feedback to source chat',
          );
        }
      };

      if (!target || !text) {
        await notify(
          '`dm_user` rejected: both `target` and `text` are required.',
        );
        break;
      }
      if (!deps.dmDiscordUser) {
        await notify(
          '`dm_user` is unavailable: Discord channel not connected.',
        );
        break;
      }

      const resolution = resolveDmTarget(target, loadDiscordCandidates());
      if ('error' in resolution) {
        const sug =
          resolution.suggestions && resolution.suggestions.length > 0
            ? `\nDid you mean: ${resolution.suggestions.join(', ')}?`
            : '';
        await notify(`Couldn't DM "${target}": ${resolution.error}${sug}`);
        logger.warn(
          { target, sourceGroup, error: resolution.error },
          'dm_user: resolve failed',
        );
        break;
      }

      const person = resolution.person;
      try {
        const dmChannelId = await deps.dmDiscordUser(person.discordId, text);
        if (dmChannelId === null) {
          // Discord channel isn't wired up. Surface that explicitly
          // instead of falling through to a recipient-blaming message.
          await notify(
            '`dm_user` is unavailable: Discord channel not connected.',
          );
          logger.warn(
            { sourceGroup, target },
            'dm_user: Discord channel not connected',
          );
          break;
        }
        logger.info(
          {
            sourceGroup,
            target,
            resolved: person.slug,
            dmChannelId,
            length: text.length,
          },
          'dm_user: sent',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Only blame the recipient when the Discord API actually
        // reports a permission-class refusal:
        //   50007 — Cannot send messages to this user (DMs off / blocked)
        //   50001 — Missing access (no shared guild, can't fetch user)
        //   10013 — Unknown user
        const code = (err as { code?: unknown })?.code;
        const isRecipientIssue =
          code === 50007 || code === 50001 || code === 10013;
        const hint = isRecipientIssue
          ? ' They may have DMs disabled, blocked the bot, or share no guild with it.'
          : '';
        await notify(
          `Failed to DM ${person.title || person.slug}: ${msg}.${hint}`,
        );
        logger.warn(
          { target, resolved: person.slug, err: msg, code },
          'dm_user: send failed',
        );
      }
      break;
    }

    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization (flat model): allowlisted human, main group, or
        // scheduling for the source group itself.
        if (!isMain && !hasSenderCtx && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (
          task &&
          (isMain || hasSenderCtx || task.group_folder === sourceGroup)
        ) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (
          task &&
          (isMain || hasSenderCtx || task.group_folder === sourceGroup)
        ) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (
          task &&
          (isMain || hasSenderCtx || task.group_folder === sourceGroup)
        ) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && !hasSenderCtx && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Flat model: any allowlisted sender (or main-group origin) can
      // request a group metadata refresh.
      if (isMain || hasSenderCtx) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          isMain,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Flat model: any allowlisted sender (or main-group origin) can
      // register a new group.
      if (!isMain && !hasSenderCtx) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    // --- Meeting summary IPC handler ---

    case 'save_meeting_summary': {
      if (!data.summaryId || !data.title || !data.transcript_text) {
        logger.warn(
          { sourceGroup },
          'save_meeting_summary: missing required fields',
        );
        break;
      }

      const targetJid =
        data.chatJid ||
        Object.entries(registeredGroups).find(
          ([, g]) => g.folder === sourceGroup,
        )?.[0];

      if (!targetJid) {
        logger.warn(
          { sourceGroup },
          'save_meeting_summary: cannot resolve chat JID',
        );
        break;
      }

      // Status is 'completed' only when summary_html and action_items are present
      const summaryStatus =
        data.summary_html && data.action_items ? 'completed' : 'pending';

      createMeetingSummary({
        id: data.summaryId,
        chat_jid: targetJid,
        group_folder: sourceGroup,
        title: data.title,
        transcript_text: data.transcript_text,
        summary_html: data.summary_html || null,
        action_items: data.action_items || null,
        extracted_events: data.extracted_events || null,
        extracted_people: data.extracted_people || null,
        extracted_tasks: data.extracted_tasks || null,
        extracted_documents: data.extracted_documents || null,
        clarification_questions: data.clarification_questions || null,
        status: summaryStatus,
      });

      deps.onTasksChanged();
      logger.info(
        { summaryId: data.summaryId, title: data.title, sourceGroup },
        'Meeting summary saved',
      );
      break;
    }

    // --- Transcript task approval handlers ---

    case 'propose_meeting_tasks': {
      if (
        !data.summary_id ||
        !Array.isArray(data.tasks) ||
        data.tasks.length === 0
      ) {
        logger.warn(
          { sourceGroup },
          'propose_meeting_tasks: missing summary_id or tasks',
        );
        break;
      }

      const summary = getMeetingSummaryById(data.summary_id);
      if (!summary) {
        logger.warn(
          { sourceGroup, summaryId: data.summary_id },
          'propose_meeting_tasks: unknown summary_id',
        );
        break;
      }
      if (summary.group_folder !== sourceGroup) {
        logger.warn(
          {
            sourceGroup,
            summaryId: data.summary_id,
            summaryGroup: summary.group_folder,
          },
          'propose_meeting_tasks: summary belongs to a different group — refusing cross-group attach',
        );
        break;
      }

      const proposerCtx = readSenderContext(sourceGroup);
      const senderUserId = proposerCtx?.user_id ?? null;

      const batchTs = Date.now();
      const batchSuffix = Math.random().toString(36).slice(2, 8);
      const rows = data.tasks.map((t, idx) => ({
        id: `PT-${batchTs}-${batchSuffix}-${idx}`,
        summary_id: data.summary_id!,
        chat_jid: summary.chat_jid,
        group_folder: sourceGroup,
        requester_user_id: senderUserId,
        title: t.title,
        description: t.description ?? null,
        proposed_assignee: t.proposed_assignee ?? null,
        proposed_due_date: t.proposed_due_date ?? null,
        source_quote: t.source_quote ?? null,
      }));

      createProposedTasksBatch(rows);

      const mainGroupJid = Object.entries(registeredGroups).find(
        ([, g]) => g.isMain,
      )?.[0];
      if (mainGroupJid) {
        const lines = rows.map((r, i) => {
          const meta = [
            r.proposed_assignee ? `proposed: ${r.proposed_assignee}` : null,
            r.proposed_due_date ? `due ${r.proposed_due_date}` : null,
          ]
            .filter(Boolean)
            .join(' · ');
          const metaSuffix = meta ? ` — ${meta}` : '';
          return `${i + 1}. *${r.title}*${metaSuffix}\n   id: \`${r.id}\``;
        });
        const body =
          `📝 Review needed: *${rows.length}* proposed task(s) from "${summary.title}"\n\n` +
          lines.join('\n\n') +
          `\n\nReply with "approve PT-..." or "reject PT-..." for each item.`;
        await deps.sendMessage(mainGroupJid, body);
      }

      deps.onTasksChanged();
      logger.info(
        { summaryId: data.summary_id, count: rows.length, sourceGroup },
        'Proposed tasks created; reviewers notified',
      );
      break;
    }

    case 'approve_proposed_tasks': {
      if (!Array.isArray(data.items) || data.items.length === 0) {
        logger.warn({ sourceGroup }, 'approve_proposed_tasks: missing items');
        break;
      }

      const senderCtx = readSenderContext(sourceGroup);
      const mainGroupJid = findMainGroupJid(registeredGroups);

      // Fail closed: every approval must be traceable to a real allowlisted
      // user_id for audit purposes. We do NOT fabricate identity just
      // because the call originated from the main group.
      if (!senderCtx) {
        logger.warn(
          { sourceGroup, isMain },
          'approve_proposed_tasks: rejected — no allowlisted sender identity',
        );
        if (mainGroupJid) {
          await deps.sendMessage(
            mainGroupJid,
            '⚠️ Approving proposed tasks requires an allowlisted sender (caller must have a sender_context with a user_id).',
          );
        }
        break;
      }

      const approverId = senderCtx.user_id;

      const created: Array<{
        proposedId: string;
        taskId: string;
        title: string;
      }> = [];
      const skipped: string[] = [];

      const failed: string[] = [];

      for (const item of data.items) {
        const proposed = getProposedTask(item.proposed_task_id);
        if (!proposed) {
          skipped.push(`${item.proposed_task_id} (not found)`);
          continue;
        }
        // Process pending rows (the normal case) and approved rows (left over
        // from a previous attempt where the KB write failed). 'created' and
        // 'rejected' are terminal and skipped.
        if (proposed.status !== 'pending' && proposed.status !== 'approved') {
          skipped.push(`${proposed.id} (status=${proposed.status})`);
          continue;
        }

        if (proposed.status === 'pending') {
          updateProposedTaskStatus(proposed.id, 'approved', approverId);
        }

        let taskId: string;
        try {
          taskId = writeApprovedTaskFile(proposed, {
            title: item.final_title,
            assignee: item.final_assignee,
            due_date: item.final_due_date,
            approved_by: approverId,
          });
        } catch (err) {
          // Revert so the row stays approve-able on retry.
          updateProposedTaskStatus(proposed.id, 'pending', null);
          logger.error(
            { proposedId: proposed.id, err },
            'Failed to write approved task file — reverted to pending',
          );
          failed.push(`${proposed.id} (write failed)`);
          continue;
        }

        updateProposedTaskStatus(proposed.id, 'created', approverId, {
          resulting_task_id: taskId,
        });

        created.push({
          proposedId: proposed.id,
          taskId,
          title: item.final_title || proposed.title,
        });
      }

      if (
        mainGroupJid &&
        (created.length > 0 || skipped.length > 0 || failed.length > 0)
      ) {
        const parts: string[] = [];
        if (created.length > 0) {
          parts.push(
            `✅ Approved ${created.length} task(s):\n` +
              created.map((c) => `• *${c.title}* → ${c.taskId}`).join('\n'),
          );
        }
        if (skipped.length > 0) {
          parts.push(`Skipped: ${skipped.join(', ')}`);
        }
        if (failed.length > 0) {
          parts.push(
            `⚠️ Failed: ${failed.join(', ')} — see logs and retry approve_proposed_tasks.`,
          );
        }
        await deps.sendMessage(mainGroupJid, parts.join('\n\n'));
      }

      deps.onTasksChanged();
      logger.info(
        {
          createdCount: created.length,
          skippedCount: skipped.length,
          failedCount: failed.length,
          approver: approverId,
        },
        'Proposed tasks approved batch processed',
      );
      break;
    }

    case 'reject_proposed_task': {
      if (!data.proposed_task_id) {
        logger.warn(
          { sourceGroup },
          'reject_proposed_task: missing proposed_task_id',
        );
        break;
      }

      const senderCtx = readSenderContext(sourceGroup);
      const mainGroupJid = findMainGroupJid(registeredGroups);

      // Fail closed: same reasoning as approve_proposed_tasks. We require a
      // real user_id in resolved_by; isMain alone is not enough.
      if (!senderCtx) {
        logger.warn(
          { sourceGroup, isMain },
          'reject_proposed_task: rejected — no allowlisted sender identity',
        );
        if (mainGroupJid) {
          await deps.sendMessage(
            mainGroupJid,
            '⚠️ Rejecting proposed tasks requires an allowlisted sender (caller must have a sender_context with a user_id).',
          );
        }
        break;
      }

      const proposed = getProposedTask(data.proposed_task_id);
      if (!proposed || proposed.status !== 'pending') {
        logger.warn(
          { id: data.proposed_task_id, status: proposed?.status },
          'reject_proposed_task: not pending',
        );
        break;
      }

      const approverId = senderCtx.user_id;
      updateProposedTaskStatus(proposed.id, 'rejected', approverId, {
        rejection_reason: data.reason ?? null,
      });

      if (mainGroupJid) {
        await deps.sendMessage(
          mainGroupJid,
          `❌ Rejected: *${proposed.title}*${data.reason ? ` — ${data.reason}` : ''}`,
        );
      }

      deps.onTasksChanged();
      logger.info(
        { proposedId: proposed.id, reason: data.reason, approver: approverId },
        'Proposed task rejected',
      );
      break;
    }

    // --- Expense IPC handlers ---

    // --- Expense IPC handlers ---

    case 'expense_request': {
      if (
        !data.amount_cents ||
        !data.description ||
        !data.request_type ||
        !data.chatJid
      ) {
        logger.warn(
          { sourceGroup },
          'expense_request: missing required fields',
        );
        break;
      }
      if (data.amount_cents <= 0) {
        logger.warn({ sourceGroup }, 'expense_request: non-positive amount');
        break;
      }
      if (
        data.request_type === 'retrospective' &&
        (!data.incurred_date || !data.receipt_path || !data.justification)
      ) {
        logger.warn(
          { sourceGroup },
          'retrospective expense missing incurred_date, receipt_path, or justification',
        );
        break;
      }

      const senderCtx = readSenderContext(sourceGroup);
      const requesterUserId =
        senderCtx?.user_id || data.groupFolder || sourceGroup;

      const expenseId = generateExpenseId();
      const initialStatus: ExpenseStatus =
        data.request_type === 'prospective'
          ? 'pending_approval'
          : 'submitted_retro';

      createExpense({
        id: expenseId,
        chat_jid: data.chatJid,
        requester_user_id: requesterUserId,
        request_type: data.request_type as 'prospective' | 'retrospective',
        amount_cents: data.amount_cents,
        currency: data.currency || 'USD',
        description: data.description,
        category: data.category ?? null,
        vendor: data.vendor ?? null,
        justification: data.justification ?? null,
        expected_date: data.expected_date ?? null,
        incurred_date: data.incurred_date ?? null,
        event_id: data.event_id ?? null,
        receipt_path: data.receipt_path ?? null,
        status: initialStatus,
        created_at: new Date().toISOString(),
      });

      const mainGroupJid = findMainGroupJid(registeredGroups);
      const pathLabel =
        data.request_type === 'prospective' ? 'prospective' : 'RETROSPECTIVE';
      const requesterLabel = senderCtx?.display_name || requesterUserId;
      const approvalActions =
        data.request_type === 'prospective'
          ? 'approve / deny / modify'
          : 'approve / deny';
      if (mainGroupJid) {
        await deps.sendMessage(
          mainGroupJid,
          `New ${pathLabel} expense ${expenseId}: ${formatMoney(data.amount_cents, data.currency || 'USD')} — ${data.description} (requested by ${requesterLabel}). Reply to ${approvalActions}.`,
        );
      }

      deps.onTasksChanged();
      logger.info(
        {
          expenseId,
          requester: requesterUserId,
          amount: data.amount_cents,
          type: data.request_type,
        },
        'Expense created',
      );
      break;
    }

    case 'expense_decision': {
      if (
        !data.expense_id ||
        !data.decision ||
        !['approve', 'deny', 'modify'].includes(data.decision)
      ) {
        logger.warn({ sourceGroup }, 'expense_decision: missing fields');
        break;
      }
      const expense = getExpense(data.expense_id);
      if (!expense) {
        logger.warn({ id: data.expense_id }, 'expense not found');
        break;
      }
      if (!isDecidableStatus(expense.status)) {
        logger.warn(
          { id: data.expense_id, status: expense.status },
          'expense already resolved',
        );
        break;
      }

      const approverCtx = readSenderContext(sourceGroup);
      if (!approverCtx) {
        logger.warn({ sourceGroup }, 'expense_decision: no sender context');
        break;
      }
      if (approverCtx.user_id === expense.requester_user_id) {
        logger.warn(
          { user: approverCtx.user_id, expenseId: expense.id },
          'Requester cannot approve own expense',
        );
        const requesterChat = expense.chat_jid;
        await deps.sendMessage(
          requesterChat,
          `You cannot approve your own expense ${expense.id}. Another approver must review it.`,
        );
        break;
      }
      if (
        data.decision === 'modify' &&
        expense.request_type === 'retrospective'
      ) {
        logger.warn({ id: expense.id }, 'Cannot modify retrospective expense');
        break;
      }
      if (
        data.decision === 'modify' &&
        (!data.approved_amount_cents || data.approved_amount_cents <= 0)
      ) {
        logger.warn(
          { id: expense.id, approved_amount_cents: data.approved_amount_cents },
          'modify decision requires positive approved_amount_cents',
        );
        break;
      }

      let newStatus: ExpenseStatus;
      if (data.decision === 'approve') {
        newStatus =
          expense.request_type === 'prospective'
            ? 'receipt_pending'
            : 'approved_retro';
      } else if (data.decision === 'deny') {
        newStatus =
          expense.request_type === 'prospective' ? 'denied' : 'denied_retro';
      } else {
        newStatus = 'receipt_pending';
      }

      const approvedAmount =
        data.decision === 'modify' && data.approved_amount_cents
          ? data.approved_amount_cents
          : expense.amount_cents;

      updateExpenseApproval(
        expense.id,
        newStatus,
        approverCtx.user_id,
        approvedAmount,
        data.approver_notes ?? null,
      );

      await deps.sendMessage(
        expense.chat_jid,
        renderDecisionMessage(
          expense,
          data.decision as 'approve' | 'deny' | 'modify',
          approvedAmount,
          data.approver_notes ?? null,
        ),
      );

      if (
        expense.request_type === 'retrospective' &&
        data.decision === 'approve'
      ) {
        const mainJid = findMainGroupJid(registeredGroups);
        if (mainJid) {
          await deps.sendMessage(
            mainJid,
            `Retrospective expense ${expense.id} approved — finance please reimburse (${formatMoney(approvedAmount, expense.currency)}).`,
          );
        }
      }

      deps.onTasksChanged();
      logger.info(
        {
          expenseId: expense.id,
          decision: data.decision,
          approver: approverCtx.user_id,
          newStatus,
        },
        'Expense decision processed',
      );
      break;
    }

    case 'expense_receipt': {
      if (!data.expense_id || !data.receipt_path) {
        logger.warn({ sourceGroup }, 'expense_receipt: missing fields');
        break;
      }
      const rExpense = getExpense(data.expense_id);
      if (!rExpense) {
        logger.warn({ id: data.expense_id }, 'expense not found');
        break;
      }
      if (rExpense.status !== 'receipt_pending') {
        logger.warn(
          { id: data.expense_id, status: rExpense.status },
          'receipt submitted in wrong state',
        );
        break;
      }

      const submitterCtx = readSenderContext(sourceGroup);
      if (
        !submitterCtx ||
        submitterCtx.user_id !== rExpense.requester_user_id
      ) {
        logger.warn(
          {
            submitter: submitterCtx?.user_id,
            requester: rExpense.requester_user_id,
          },
          'non-requester tried to attach receipt',
        );
        break;
      }

      attachReceipt(
        data.expense_id,
        data.receipt_path,
        data.actual_amount_cents ?? null,
      );

      const mainJid = findMainGroupJid(registeredGroups);
      if (
        data.actual_amount_cents &&
        rExpense.approved_amount_cents !== null &&
        data.actual_amount_cents !== rExpense.approved_amount_cents &&
        mainJid
      ) {
        await deps.sendMessage(
          mainJid,
          `Heads up: expense ${data.expense_id} receipt is ${formatMoney(data.actual_amount_cents, rExpense.currency)} vs approved ${formatMoney(rExpense.approved_amount_cents, rExpense.currency)}.`,
        );
      }
      if (mainJid) {
        await deps.sendMessage(
          mainJid,
          `Receipt received for ${data.expense_id} — ready for reimbursement.`,
        );
      }

      deps.onTasksChanged();
      logger.info(
        { expenseId: data.expense_id, actual: data.actual_amount_cents },
        'Receipt submitted',
      );
      break;
    }

    case 'expense_reimburse': {
      if (!data.expense_id || !data.reimbursement_method) {
        logger.warn({ sourceGroup }, 'expense_reimburse: missing fields');
        break;
      }
      const rbExpense = getExpense(data.expense_id);
      if (!rbExpense) {
        logger.warn({ id: data.expense_id }, 'expense not found');
        break;
      }
      if (
        rbExpense.status !== 'receipt_submitted' &&
        rbExpense.status !== 'approved_retro'
      ) {
        logger.warn(
          { id: data.expense_id, status: rbExpense.status },
          'reimbursement attempted in wrong state',
        );
        break;
      }
      const reimburserCtx = readSenderContext(sourceGroup);
      if (!reimburserCtx) {
        logger.warn(
          { sourceGroup },
          'reimbursement requires an allowlisted sender',
        );
        break;
      }

      markReimbursed(
        data.expense_id,
        reimburserCtx.user_id,
        data.reimbursement_method,
      );
      await deps.sendMessage(
        rbExpense.chat_jid,
        `Reimbursement processed for expense ${data.expense_id} via ${data.reimbursement_method}.`,
      );

      deps.onTasksChanged();
      logger.info(
        {
          expenseId: data.expense_id,
          method: data.reimbursement_method,
          by: reimburserCtx.user_id,
        },
        'Expense reimbursed',
      );
      break;
    }

    case 'expense_cancel': {
      if (!data.expense_id) {
        logger.warn({ sourceGroup }, 'expense_cancel: missing expense_id');
        break;
      }
      const cExpense = getExpense(data.expense_id);
      if (!cExpense) break;
      if (
        cExpense.status === 'reimbursed' ||
        cExpense.status === 'cancelled' ||
        cExpense.status === 'denied' ||
        cExpense.status === 'denied_retro'
      ) {
        logger.warn(
          { id: data.expense_id, status: cExpense.status },
          'cannot cancel terminal expense',
        );
        break;
      }
      const cancellerCtx = readSenderContext(sourceGroup);
      if (
        !cancellerCtx ||
        cancellerCtx.user_id !== cExpense.requester_user_id
      ) {
        logger.warn(
          {
            canceller: cancellerCtx?.user_id,
            requester: cExpense.requester_user_id,
          },
          'only requester can cancel expense',
        );
        break;
      }

      const cancelReason =
        typeof data.reason === 'string' ? data.reason.trim() : '';
      cancelExpense(data.expense_id, cancellerCtx.user_id);
      await deps.sendMessage(
        cExpense.chat_jid,
        cancelReason
          ? `Expense ${data.expense_id} cancelled. Reason: ${cancelReason}`
          : `Expense ${data.expense_id} cancelled.`,
      );
      deps.onTasksChanged();
      logger.info(
        {
          expenseId: data.expense_id,
          by: cancellerCtx.user_id,
          reason: cancelReason || undefined,
        },
        'Expense cancelled',
      );
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

// --- Expense helpers ---

type IpcSenderContext = IpcSenderCtx;

// Convenience wrapper around `readSenderCtxFromDir` anchored at DATA_DIR,
// for helpers defined outside `startIpcWatcher`'s closure (where the IPC
// base directory isn't already in scope).
function readSenderContext(sourceGroup: string): IpcSenderContext | null {
  return readSenderCtxFromDir(path.join(DATA_DIR, 'ipc'), sourceGroup);
}

function findMainGroupJid(
  registeredGroups: Record<string, RegisteredGroup>,
): string | undefined {
  return Object.entries(registeredGroups).find(([, g]) => g.isMain)?.[0];
}

function generateExpenseId(): string {
  return `exp-${crypto.randomUUID()}`;
}

function formatMoney(cents: number, currency: string = 'USD'): string {
  const amount = (cents / 100).toFixed(2);
  return currency === 'USD' ? `$${amount}` : `${amount} ${currency}`;
}

function isDecidableStatus(status: ExpenseStatus): boolean {
  return status === 'pending_approval' || status === 'submitted_retro';
}

function renderDecisionMessage(
  expense: Expense,
  decision: 'approve' | 'deny' | 'modify',
  approvedAmount: number,
  notes: string | null,
): string {
  const amount = formatMoney(approvedAmount, expense.currency);
  const originalAmount = formatMoney(expense.amount_cents, expense.currency);
  const notesLine = notes ? ` — ${notes}` : '';
  if (decision === 'approve') {
    return `Expense ${expense.id} approved for ${amount}. ${expense.request_type === 'prospective' ? 'Submit a receipt with submit_receipt after you spend.' : 'Finance will process reimbursement.'}${notesLine}`;
  }
  if (decision === 'deny') {
    return `Expense ${expense.id} denied${notesLine}`;
  }
  return `Expense ${expense.id} approved at ${amount} (requested ${originalAmount})${notesLine}. Submit a receipt via submit_receipt when you spend, or cancel_expense if the new amount doesn't work.`;
}

// --- Event intake / booking helpers ---

function findChatJidForGroup(
  registeredGroups: Record<string, RegisteredGroup>,
  groupFolder: string,
): string | undefined {
  return Object.entries(registeredGroups).find(
    ([, g]) => g.folder === groupFolder,
  )?.[0];
}
