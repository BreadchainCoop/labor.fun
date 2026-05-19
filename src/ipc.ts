import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';
import nodemailer from 'nodemailer';

import {
  DATA_DIR,
  FLAT_ACCESS,
  IPC_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
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
import { isSenderAdmin } from './permissions.js';
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

const KB_CONTEXT_DIR = '/opt/breadbrich/groups/slack_main/context';

// Directories coordinators can write to
const COORDINATOR_WRITABLE = ['calendar', 'tasks', 'artifacts', 'spaces'];

// Directories only admins can write to
const ADMIN_ONLY = ['people'];

function canModifyKbFile(
  filePath: string,
  senderCtx: { is_admin: boolean; tags?: string[] } | null,
): { allowed: boolean; reason: string } {
  if (!senderCtx) {
    return { allowed: false, reason: 'Unknown sender — no identity mapping' };
  }

  // Normalize path — strip leading slashes, prevent traversal
  const normalized = filePath.replace(/^\/+/, '').replace(/\.\./g, '');
  const topDir = normalized.split('/')[0];

  // Admin can write anything
  if (senderCtx.is_admin) {
    return { allowed: true, reason: 'Admin access' };
  }

  // Coordinator can write to specific directories
  const isCoordinator = (senderCtx.tags || []).includes('coordinator');
  if (isCoordinator) {
    if (COORDINATOR_WRITABLE.includes(topDir)) {
      // Block personnel_notes content
      return { allowed: true, reason: `Coordinator access to ${topDir}/` };
    }
    if (ADMIN_ONLY.includes(topDir)) {
      return { allowed: false, reason: `${topDir}/ requires admin access` };
    }
    return {
      allowed: false,
      reason: `Coordinators cannot write to ${topDir}/`,
    };
  }

  // Everyone else: no KB writes
  return { allowed: false, reason: 'Insufficient permissions for KB writes' };
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

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
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
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                const isSameGroup =
                  targetGroup && targetGroup.folder === sourceGroup;

                // Check if the triggering user is admin (from sender_context.json)
                let senderIsAdmin = false;
                if (!isMain && !isSameGroup) {
                  try {
                    const ctxPath = path.join(
                      ipcBaseDir,
                      sourceGroup,
                      'input',
                      'sender_context.json',
                    );
                    if (fs.existsSync(ctxPath)) {
                      const ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf-8'));
                      senderIsAdmin = ctx.is_admin === true;
                    }
                  } catch {
                    // Ignore parse errors
                  }
                }

                if (isMain || isSameGroup || senderIsAdmin) {
                  await deps.sendMessage(data.chatJid, data.text);
                  refreshOutboundSnapshot(sourceGroup, data.chatJid);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup, senderIsAdmin },
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

                let senderIsAdmin = false;
                if (!isMain && !isSameGroup) {
                  try {
                    const ctxPath = path.join(
                      ipcBaseDir,
                      sourceGroup,
                      'input',
                      'sender_context.json',
                    );
                    if (fs.existsSync(ctxPath)) {
                      const ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf-8'));
                      senderIsAdmin = ctx.is_admin === true;
                    }
                  } catch {
                    // Ignore parse errors
                  }
                }

                const authorized = isMain || isSameGroup || senderIsAdmin;
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
                // KB file modification — RBAC enforced
                let senderCtx: { is_admin: boolean; tags?: string[] } | null =
                  null;
                try {
                  const ctxPath = path.join(
                    ipcBaseDir,
                    sourceGroup,
                    'input',
                    'sender_context.json',
                  );
                  if (fs.existsSync(ctxPath)) {
                    senderCtx = JSON.parse(fs.readFileSync(ctxPath, 'utf-8'));
                  }
                } catch {
                  // Ignore parse errors
                }

                // Main group always has access
                if (isMain) {
                  senderCtx = { is_admin: true, tags: ['admin'] };
                }

                const { allowed, reason } = canModifyKbFile(
                  data.filePath,
                  senderCtx,
                );

                if (allowed) {
                  const normalized = data.filePath
                    .replace(/^\/+/, '')
                    .replace(/\.\./g, '');
                  const fullPath = path.join(KB_CONTEXT_DIR, normalized);
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
                    // Fix ownership
                    try {
                      const { execSync } = await import('child_process');
                      execSync(`chown breadbrich:breadbrich "${fullPath}"`);
                    } catch {
                      /* ignore */
                    }
                    logger.info(
                      { filePath: normalized, sourceGroup, reason },
                      'KB file written via IPC',
                    );
                  }
                } else {
                  logger.warn(
                    { filePath: data.filePath, sourceGroup, reason },
                    'KB file modification blocked — insufficient permissions',
                  );
                }
              } else if (
                data.type === 'add_kb_user' &&
                data.username &&
                data.target_telegram_jid
              ) {
                // PRIVILEGED: create a KB-UI auth entry + DM the credentials.
                // Requires source group is_main=1 AND sender is admin.
                let senderIsAdmin = false;
                try {
                  const ctxPath = path.join(
                    ipcBaseDir,
                    sourceGroup,
                    'input',
                    'sender_context.json',
                  );
                  if (fs.existsSync(ctxPath)) {
                    const ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf-8'));
                    senderIsAdmin = ctx.is_admin === true;
                  }
                } catch {
                  /* ignore */
                }

                if (!isMain || !senderIsAdmin) {
                  logger.warn(
                    {
                      sourceGroup,
                      isMain,
                      senderIsAdmin,
                      username: data.username,
                    },
                    'add_kb_user rejected — requires admin sender in is_main DM',
                  );
                } else if (!/^[a-z][a-z0-9_-]{0,31}$/.test(data.username)) {
                  logger.warn(
                    { username: data.username, sourceGroup },
                    'add_kb_user rejected — invalid username format',
                  );
                } else {
                  const usersFile =
                    process.env.USERS_FILE ||
                    '/opt/breadbrich/kb-ui/users.json';
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
                // PRIVILEGED: rewrite another group's CLAUDE.md from main.
                // See handleModifyGroupClaudeMd for the gate composition.
                let senderIsAdmin = false;
                let senderId: string | null = null;
                try {
                  const ctxPath = path.join(
                    ipcBaseDir,
                    sourceGroup,
                    'input',
                    'sender_context.json',
                  );
                  if (fs.existsSync(ctxPath)) {
                    const ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf-8'));
                    senderIsAdmin = ctx.is_admin === true;
                    // SenderContext shape from src/permissions.ts uses user_id
                    senderId =
                      typeof ctx.user_id === 'string' ? ctx.user_id : null;
                  }
                } catch {
                  /* ignore */
                }
                handleModifyGroupClaudeMd(
                  {
                    target_folder: data.target_folder,
                    new_content: data.new_content,
                    summary:
                      typeof data.summary === 'string'
                        ? data.summary
                        : undefined,
                  },
                  { sourceGroup, isMain, senderIsAdmin, senderId },
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
              // Pass source group identity to processTaskIpc for authorization
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
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

// --- Phase G3: privileged main-only CLAUDE.md modification ---
//
// Main-group admins can rewrite any non-self group's CLAUDE.md via this IPC.
// Read-direction visibility (G1: /workspace/all-groups mount) lets main agents
// learn what's happening; this is the write-direction counterpart.
//
// Gates compose AND, not OR:
//   1. isMain         — source must be a main group
//   2. senderIsAdmin  — explicit admin context check, NOT auto-elevated from isMain
//   3. valid folder   — isValidGroupFolder rejects path-traversal attempts
//   4. size cap       — refuses pathological payloads
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
    senderIsAdmin: boolean;
    senderId: string | null;
  },
): ModifyGroupClaudeMdResult {
  const { target_folder, new_content, summary } = input;

  if (!ctx.isMain || !ctx.senderIsAdmin) {
    logger.warn(
      {
        sourceGroup: ctx.sourceGroup,
        isMain: ctx.isMain,
        senderIsAdmin: ctx.senderIsAdmin,
        target_folder,
      },
      'modify_group_claude_md rejected — requires admin sender in is_main DM',
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
      changedBy: ctx.senderId ?? `unknown@${ctx.sourceGroup}`,
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
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
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

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
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
        if (task && (isMain || task.group_folder === sourceGroup)) {
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
        if (task && (isMain || task.group_folder === sourceGroup)) {
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
        if (task && (isMain || task.group_folder === sourceGroup)) {
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
        if (!isMain && task.group_folder !== sourceGroup) {
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
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
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
      // Only main group can register new groups
      if (!isMain) {
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
          `📝 Coordinator review needed: *${rows.length}* proposed task(s) from "${summary.title}"\n\n` +
          lines.join('\n\n') +
          `\n\nReply with "approve PT-..." or "reject PT-..." for each item.`;
        await deps.sendMessage(mainGroupJid, body);
      }

      deps.onTasksChanged();
      logger.info(
        { summaryId: data.summary_id, count: rows.length, sourceGroup },
        'Proposed tasks created; coordinator notified',
      );
      break;
    }

    case 'approve_proposed_tasks': {
      if (!Array.isArray(data.items) || data.items.length === 0) {
        logger.warn({ sourceGroup }, 'approve_proposed_tasks: missing items');
        break;
      }

      const senderCtx = readSenderContext(sourceGroup);
      const isCoordinator =
        senderCtx !== null &&
        (senderCtx.is_admin ||
          senderCtx.tags.includes('coordinator') ||
          senderCtx.tags.includes('admin'));

      const mainGroupJid = findMainGroupJid(registeredGroups);

      // Fail closed: without a valid sender_context.json declaring coordinator
      // or admin authority, refuse. We do NOT fabricate identity just because
      // the call originated from the main group — every approval must be
      // traceable to a real user_id for audit purposes.
      if (!isCoordinator) {
        logger.warn(
          { sourceGroup, hasSenderCtx: senderCtx !== null, isMain },
          'approve_proposed_tasks: rejected — no valid coordinator identity',
        );
        if (mainGroupJid) {
          await deps.sendMessage(
            mainGroupJid,
            '⚠️ Only coordinators can approve proposed tasks. The caller must have a sender_context with the coordinator or admin tag.',
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
      const isCoordinator =
        senderCtx !== null &&
        (senderCtx.is_admin ||
          senderCtx.tags.includes('coordinator') ||
          senderCtx.tags.includes('admin'));

      const mainGroupJid = findMainGroupJid(registeredGroups);

      // Fail closed: same reasoning as approve_proposed_tasks. We require a
      // real user_id in resolved_by; isMain alone is not enough.
      if (!isCoordinator) {
        logger.warn(
          { sourceGroup, hasSenderCtx: senderCtx !== null, isMain },
          'reject_proposed_task: rejected — no valid coordinator identity',
        );
        if (mainGroupJid) {
          await deps.sendMessage(
            mainGroupJid,
            '⚠️ Only coordinators can reject proposed tasks. The caller must have a sender_context with the coordinator or admin tag.',
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
        !canApprove(approverCtx, expense.amount_cents, expense.request_type)
      ) {
        logger.warn(
          {
            approver: approverCtx.user_id,
            amount: expense.amount_cents,
            tags: approverCtx.tags,
          },
          'Unauthorized approval attempt',
        );
        const mainJid = findMainGroupJid(registeredGroups);
        if (mainJid) {
          await deps.sendMessage(
            mainJid,
            `${approverCtx.display_name} does not have authority to approve expense ${expense.id} (${formatMoney(expense.amount_cents, expense.currency)}). See rules/finance/expenses.md.`,
          );
        }
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
      if (!reimburserCtx || !hasFinanceAuthority(reimburserCtx)) {
        logger.warn(
          { user: reimburserCtx?.user_id, tags: reimburserCtx?.tags },
          'non-finance user tried to reimburse',
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

interface IpcSenderContext {
  user_id: string;
  display_name: string;
  tags: string[];
  is_admin: boolean;
}

function readSenderContext(sourceGroup: string): IpcSenderContext | null {
  try {
    const ctxPath = path.join(
      DATA_DIR,
      'ipc',
      sourceGroup,
      'input',
      'sender_context.json',
    );
    if (!fs.existsSync(ctxPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(ctxPath, 'utf-8'));
    if (typeof parsed?.user_id !== 'string') return null;
    return {
      user_id: parsed.user_id,
      display_name: parsed.display_name || parsed.user_id,
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      is_admin: parsed.is_admin === true,
    };
  } catch {
    return null;
  }
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

function hasFinanceAuthority(ctx: IpcSenderContext): boolean {
  return ctx.is_admin || ctx.tags.includes('finance');
}

function canApprove(
  ctx: IpcSenderContext,
  amountCents: number,
  requestType: 'prospective' | 'retrospective',
): boolean {
  // Retrospective approvals require admin — no coordinator shortcut for past spending
  if (requestType === 'retrospective') return ctx.is_admin;

  // Admin can approve any amount
  if (ctx.is_admin) return true;

  // Coordinator can approve under $500 (50000 cents)
  if (ctx.tags.includes('coordinator') && amountCents < 50000) return true;

  return false;
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

function senderHasAnyTag(
  ctx: IpcSenderContext | null,
  tags: string[],
): boolean {
  if (!ctx) return false;
  if (ctx.is_admin) return true;
  return (ctx.tags ?? []).some((t) => tags.includes(t));
}

function findChatJidForGroup(
  registeredGroups: Record<string, RegisteredGroup>,
  groupFolder: string,
): string | undefined {
  return Object.entries(registeredGroups).find(
    ([, g]) => g.folder === groupFolder,
  )?.[0];
}
