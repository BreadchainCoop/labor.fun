import crypto from 'crypto';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

/** Expose the DB instance for modules that need direct access (e.g., permissions). */
export function getDb(): Database.Database {
  return db;
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      delivery TEXT NOT NULL DEFAULT 'channel',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
  `);

  // --- App users + expenses ---
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      requester_user_id TEXT NOT NULL,
      request_type TEXT NOT NULL CHECK (request_type IN ('prospective', 'retrospective')),
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      description TEXT NOT NULL,
      category TEXT,
      vendor TEXT,
      justification TEXT,
      expected_date TEXT,
      incurred_date TEXT,
      -- Free-form nullable tag, no referent. The events table was removed; the
      -- prior FK to events(id) was dropped. Kept to avoid a destructive
      -- migration on existing deployed SQLite DBs.
      event_id TEXT,
      approver_user_id TEXT,
      approved_amount_cents INTEGER,
      approver_notes TEXT,
      receipt_path TEXT,
      receipt_submitted_at TEXT,
      actual_amount_cents INTEGER,
      reimbursed_by TEXT,
      reimbursed_at TEXT,
      reimbursement_method TEXT,
      status TEXT NOT NULL DEFAULT 'pending_approval',
      created_at TEXT NOT NULL,
      resolved_by TEXT,
      resolved_at TEXT,
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_expenses_status ON expenses(status);
    CREATE INDEX IF NOT EXISTS idx_expenses_requester ON expenses(requester_user_id);
    CREATE INDEX IF NOT EXISTS idx_expenses_event ON expenses(event_id);
  `);

  // --- Meeting summaries ---
  database.exec(`
    CREATE TABLE IF NOT EXISTS meeting_summaries (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      title TEXT NOT NULL,
      transcript_text TEXT NOT NULL,
      summary_html TEXT,
      action_items TEXT,
      extracted_events TEXT,
      extracted_people TEXT,
      extracted_tasks TEXT,
      extracted_documents TEXT,
      clarification_questions TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_meeting_summaries_group ON meeting_summaries(group_folder);
    CREATE INDEX IF NOT EXISTS idx_meeting_summaries_status ON meeting_summaries(status);
  `);

  // --- Transcript task approval queue ---
  database.exec(`
    CREATE TABLE IF NOT EXISTS proposed_tasks (
      id TEXT PRIMARY KEY,
      summary_id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      requester_user_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      proposed_assignee TEXT,
      proposed_due_date TEXT,
      source_quote TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_by TEXT,
      resolved_at TEXT,
      resulting_task_id TEXT,
      rejection_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_proposed_tasks_status ON proposed_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_proposed_tasks_summary ON proposed_tasks(summary_id);
  `);

  // --- Proposal approvals ---
  database.exec(`
    CREATE TABLE IF NOT EXISTS proposal_approvals (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL,
      requested_by_user_id TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      decided_by_user_id TEXT,
      decided_at TEXT,
      decision_notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_proposal_approvals_pending ON proposal_approvals(status, booking_id);
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add delivery column if it doesn't exist (migration for existing DBs).
  // Defaults to 'channel' so every pre-existing task keeps its current
  // behavior (result posts to chat_jid); only tasks explicitly scheduled
  // 'silent' suppress their channel narration.
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN delivery TEXT NOT NULL DEFAULT 'channel'`,
    );
  } catch {
    /* column already exists */
  }

  // Add script column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 0 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

  // Add reply context columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT`);
    database.exec(
      `ALTER TABLE messages ADD COLUMN reply_to_message_content TEXT`,
    );
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_sender_name TEXT`);
  } catch {
    /* columns already exist */
  }

  // Add thread_id column for Slack/Telegram thread support
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN thread_id TEXT`);
  } catch {
    /* column already exists */
  }

  // Add is_reply_to_bot column for auto-trigger on replies to bot messages
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_reply_to_bot INTEGER DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }

  // --- Reactions log ---
  database.exec(`
    CREATE TABLE IF NOT EXISTS reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      message_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      action TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    )
  `);
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_reactions_chat ON reactions(chat_jid, timestamp)`,
  );

  // --- KB audit log ---
  database.exec(`
    CREATE TABLE IF NOT EXISTS kb_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      action TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      changes TEXT,
      timestamp TEXT NOT NULL
    )
  `);
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_kb_audit ON kb_audit_log(file_path, timestamp)`,
  );

  // --- Agent runs log ---
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      channel TEXT NOT NULL,
      group_name TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      trigger_sender TEXT,
      trigger_content TEXT,
      message_count INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      output_length INTEGER,
      error TEXT,
      duration_ms INTEGER,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    )
  `);
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_agent_runs_chat ON agent_runs(chat_jid, started_at)`,
  );
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_agent_runs_channel ON agent_runs(channel, started_at)`,
  );

  // --- Permissions tables ---

  // Maps platform sender IDs to KB people
  database.exec(`
    CREATE TABLE IF NOT EXISTS user_identities (
      platform_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      kb_person TEXT NOT NULL,
      PRIMARY KEY (platform_id, platform)
    )
  `);

  // --- Reminder engine ---

  // Records which escalation-ladder rungs have already fired for a
  // deadline-bearing item, so the periodic reminder sweep is idempotent (a
  // rung is sent at most once). `deadline` is stored so a moved deadline can be
  // detected and the item's rungs reset. See src/reminder-engine.ts.
  database.exec(`
    CREATE TABLE IF NOT EXISTS reminder_log (
      item_id TEXT NOT NULL,
      rung TEXT NOT NULL,
      deadline TEXT NOT NULL,
      fired_at TEXT NOT NULL,
      PRIMARY KEY (item_id, rung)
    )
  `);

  // --- PM orchestration ---

  // Throttle ledger for the PM-orchestration loop (#31): one row per
  // (person, task, reason) the loop has asked the agent to follow up on, so a
  // person isn't re-pinged about the same blocked/overdue item within the
  // cooldown window. See src/integrations/pm-orchestration.ts.
  database.exec(`
    CREATE TABLE IF NOT EXISTS pm_dm_log (
      person  TEXT NOT NULL,
      task_id TEXT NOT NULL,
      reason  TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      PRIMARY KEY (person, task_id, reason)
    )
  `);

  // Idempotency ledger for the operational-report loop (#34): one row per
  // period (e.g. ISO week `2026-W23`) that has already been delivered, so the
  // report is sent at most once per period regardless of restarts / sweep
  // cadence. See src/integrations/operational-report.ts.
  database.exec(`
    CREATE TABLE IF NOT EXISTS ops_report_log (
      period  TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      PRIMARY KEY (period)
    )
  `);

  // Seed known user identities (idempotent) from SEED_IDENTITIES env var.
  // Format: JSON array of {platform_id, platform, kb_person} objects.
  // Example: SEED_IDENTITIES='[{"platform_id":"cli:jane-doe","platform":"cli","kb_person":"jane-doe"}]'
  // If unset, no identities are seeded (existing rows in user_identities are preserved).
  const seedIdentitiesJson = process.env.SEED_IDENTITIES;
  if (seedIdentitiesJson) {
    try {
      const seeds = JSON.parse(seedIdentitiesJson) as Array<{
        platform_id: string;
        platform: string;
        kb_person: string;
      }>;
      const seedIdentity = database.prepare(
        `INSERT OR IGNORE INTO user_identities (platform_id, platform, kb_person) VALUES (?, ?, ?)`,
      );
      for (const seed of seeds) {
        seedIdentity.run(seed.platform_id, seed.platform, seed.kb_person);
      }
      logger.info(
        { count: seeds.length },
        'Seeded user identities from SEED_IDENTITIES',
      );
    } catch (err) {
      logger.warn(
        { err },
        'Failed to parse SEED_IDENTITIES env var — skipping identity seeding',
      );
    }
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/** @internal - for tests only. */
export function _closeDatabase(): void {
  db.close();
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, reply_to_message_id, reply_to_message_content, reply_to_sender_name, thread_id, is_reply_to_bot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.reply_to_message_id ?? null,
    msg.reply_to_message_content ?? null,
    msg.reply_to_sender_name ?? null,
    msg.thread_id ?? null,
    msg.is_reply_to_bot ? 1 : 0,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

/**
 * Store an outbound (bot-sent) message.
 */
export function storeOutboundMessage(
  chatJid: string,
  messageId: string,
  content: string,
  botName: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
  ).run(messageId, chatJid, 'bot', botName, content, new Date().toISOString());
}

export function isBotMessage(chatJid: string, messageId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM messages WHERE chat_jid = ? AND id = ? AND is_bot_message = 1 LIMIT 1`,
    )
    .get(chatJid, messageId);
  return row !== undefined;
}

export interface RecentBotMessage {
  id: string;
  content: string;
  timestamp: string;
}

export function getRecentBotMessages(
  chatJid: string,
  limit: number = 10,
): RecentBotMessage[] {
  const rows = db
    .prepare(
      `SELECT id, content, timestamp FROM messages
       WHERE chat_jid = ? AND is_bot_message = 1
       ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(chatJid, limit) as RecentBotMessage[];
  return rows;
}

/**
 * Log a reaction that Breadbrich Engels added or removed.
 */
export function logReaction(
  chatJid: string,
  messageId: string,
  emoji: string,
  action: 'add' | 'remove',
): void {
  db.prepare(
    `INSERT INTO reactions (chat_jid, message_id, emoji, action, timestamp) VALUES (?, ?, ?, ?, ?)`,
  ).run(chatJid, messageId, emoji, action, new Date().toISOString());
}

export function logKbAudit(entry: {
  filePath: string;
  action: string;
  changedBy: string;
  changes?: unknown;
}): void {
  db.prepare(
    `INSERT INTO kb_audit_log (file_path, action, changed_by, changes, timestamp) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    entry.filePath,
    entry.action,
    entry.changedBy,
    entry.changes === undefined ? null : JSON.stringify(entry.changes),
    new Date().toISOString(),
  );
}

/**
 * Start an agent run log entry. Returns the row ID for later completion.
 */
export function startAgentRun(opts: {
  chatJid: string;
  channel: string;
  groupName: string;
  groupFolder: string;
  triggerSender?: string;
  triggerContent?: string;
  messageCount: number;
}): number {
  const result = db
    .prepare(
      `INSERT INTO agent_runs (chat_jid, channel, group_name, group_folder, trigger_sender, trigger_content, message_count, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
    )
    .run(
      opts.chatJid,
      opts.channel,
      opts.groupName,
      opts.groupFolder,
      opts.triggerSender ?? null,
      opts.triggerContent ? opts.triggerContent.substring(0, 500) : null,
      opts.messageCount,
      new Date().toISOString(),
    );
  return Number(result.lastInsertRowid);
}

/**
 * Complete an agent run log entry.
 */
/**
 * On orchestrator startup, mark any `agent_runs` still flagged `running`
 * (because the previous process exited mid-run) as `interrupted` so they
 * don't sit forever as zombie rows and skew duration/stats. Returns the
 * number of rows touched.
 */
export function markOrphanedRunsAsInterrupted(): number {
  const result = db
    .prepare(
      `UPDATE agent_runs
       SET status = 'interrupted',
           error = COALESCE(error, 'Orchestrator restarted before run completed'),
           completed_at = ?
       WHERE status = 'running' AND completed_at IS NULL`,
    )
    .run(new Date().toISOString());
  return result.changes;
}

export function completeAgentRun(
  runId: number,
  status: 'success' | 'error' | 'timeout',
  outputLength: number,
  durationMs: number,
  error?: string,
): void {
  db.prepare(
    `UPDATE agent_runs SET status = ?, output_length = ?, duration_ms = ?, error = ?, completed_at = ? WHERE id = ?`,
  ).run(
    status,
    outputLength,
    durationMs,
    error ?? null,
    new Date().toISOString(),
    runId,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name,
             is_reply_to_bot
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name,
             is_reply_to_bot
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

export function getLastBotMessageTimestamp(
  chatJid: string,
  botPrefix: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT MAX(timestamp) as ts FROM messages
       WHERE chat_jid = ? AND (is_bot_message = 1 OR content LIKE ?)`,
    )
    .get(chatJid, `${botPrefix}:%`) as { ts: string | null } | undefined;
  return row?.ts ?? undefined;
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, delivery, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.script || null,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.delivery === 'silent' ? 'silent' : 'channel',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'script'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.script !== undefined) {
    fields.push('script = ?');
    values.push(updates.script || null);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- App user accessors ---

export interface AppUser {
  id: string;
  name: string;
  created_at: string;
}

function generateId(): string {
  return crypto.randomUUID();
}

export function getAllUsers(): AppUser[] {
  return db.prepare('SELECT * FROM app_users ORDER BY name').all() as AppUser[];
}

export function createUser(name: string): AppUser {
  const id = generateId();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO app_users (id, name, created_at) VALUES (?, ?, ?)',
  ).run(id, name, now);
  return { id, name, created_at: now };
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function deleteSession(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );
}

export function deleteRegisteredGroup(jid: string): void {
  db.prepare('DELETE FROM registered_groups WHERE jid = ?').run(jid);
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

// --- Reminder log accessors ---

/** Whether a given ladder rung has already fired for an item. */
export function hasReminderFired(itemId: string, rung: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM reminder_log WHERE item_id = ? AND rung = ?')
    .get(itemId, rung);
  return row !== undefined;
}

/** Record that a ladder rung fired for an item (idempotent on item_id+rung). */
export function recordReminderFired(
  itemId: string,
  rung: string,
  deadline: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO reminder_log (item_id, rung, deadline, fired_at)
     VALUES (?, ?, ?, ?)`,
  ).run(itemId, rung, deadline, new Date().toISOString());
}

/**
 * Reset an item's fired rungs if its deadline has moved. Returns true when a
 * reset happened. Lets the ladder re-fire against the new schedule instead of
 * staying silent because earlier rungs were already logged for the old date.
 */
export function resetRemindersOnDeadlineChange(
  itemId: string,
  deadline: string,
): boolean {
  const rows = db
    .prepare('SELECT DISTINCT deadline FROM reminder_log WHERE item_id = ?')
    .all(itemId) as Array<{ deadline: string }>;
  if (rows.length > 0 && rows.some((r) => r.deadline !== deadline)) {
    db.prepare('DELETE FROM reminder_log WHERE item_id = ?').run(itemId);
    return true;
  }
  return false;
}

// --- PM orchestration DM throttle ---

/** Record that a PM follow-up for (person, task, reason) was raised now. */
export function recordPmDm(
  person: string,
  taskId: string,
  reason: string,
): void {
  db.prepare(
    `INSERT INTO pm_dm_log (person, task_id, reason, sent_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(person, task_id, reason) DO UPDATE SET sent_at = excluded.sent_at`,
  ).run(person, taskId, reason, new Date().toISOString());
}

/** PM follow-ups raised since `sinceIso` (used to suppress re-pings). */
export function getRecentPmDms(
  sinceIso: string,
): Array<{ person: string; task_id: string; reason: string; sent_at: string }> {
  return db
    .prepare(
      `SELECT person, task_id, reason, sent_at FROM pm_dm_log WHERE sent_at >= ?`,
    )
    .all(sinceIso) as Array<{
    person: string;
    task_id: string;
    reason: string;
    sent_at: string;
  }>;
}

// --- Operational report idempotency ---

/** Whether the operational report for `period` has already been delivered. */
export function hasOpsReportFired(period: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM ops_report_log WHERE period = ?`)
    .get(period);
  return row !== undefined;
}

/** Record that the operational report for `period` was delivered now. */
export function recordOpsReportFired(period: string): void {
  db.prepare(
    `INSERT INTO ops_report_log (period, sent_at) VALUES (?, ?)
     ON CONFLICT(period) DO UPDATE SET sent_at = excluded.sent_at`,
  ).run(period, new Date().toISOString());
}

// --- Meeting summary accessors ---

export interface MeetingSummary {
  id: string;
  chat_jid: string;
  group_folder: string;
  title: string;
  transcript_text: string;
  summary_html: string | null;
  action_items: string | null;
  extracted_events: string | null;
  extracted_people: string | null;
  extracted_tasks: string | null;
  extracted_documents: string | null;
  clarification_questions: string | null;
  status: string;
  created_at: string;
}

export function createMeetingSummary(data: {
  id: string;
  chat_jid: string;
  group_folder: string;
  title: string;
  transcript_text: string;
  summary_html: string | null;
  action_items: string | null;
  extracted_events: string | null;
  extracted_people: string | null;
  extracted_tasks: string | null;
  extracted_documents: string | null;
  clarification_questions: string | null;
  status: string;
}): void {
  db.prepare(
    `INSERT INTO meeting_summaries
     (id, chat_jid, group_folder, title, transcript_text, summary_html,
      action_items, extracted_events, extracted_people, extracted_tasks,
      extracted_documents, clarification_questions, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    data.id,
    data.chat_jid,
    data.group_folder,
    data.title,
    data.transcript_text,
    data.summary_html,
    data.action_items,
    data.extracted_events,
    data.extracted_people,
    data.extracted_tasks,
    data.extracted_documents,
    data.clarification_questions,
    data.status,
    new Date().toISOString(),
  );
}

export function getMeetingSummaryById(id: string): MeetingSummary | undefined {
  return db.prepare('SELECT * FROM meeting_summaries WHERE id = ?').get(id) as
    | MeetingSummary
    | undefined;
}

export function getMeetingSummariesByGroup(
  groupFolder: string,
): MeetingSummary[] {
  return db
    .prepare(
      'SELECT * FROM meeting_summaries WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as MeetingSummary[];
}

export function updateMeetingSummary(
  id: string,
  updates: Partial<
    Pick<
      MeetingSummary,
      'summary_html' | 'status' | 'action_items' | 'clarification_questions'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.summary_html !== undefined) {
    fields.push('summary_html = ?');
    values.push(updates.summary_html);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.action_items !== undefined) {
    fields.push('action_items = ?');
    values.push(updates.action_items);
  }
  if (updates.clarification_questions !== undefined) {
    fields.push('clarification_questions = ?');
    values.push(updates.clarification_questions);
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(
    `UPDATE meeting_summaries SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

// --- Proposed task (transcript approval queue) accessors ---

export type ProposedTaskStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'created';

export interface ProposedTask {
  id: string;
  summary_id: string;
  chat_jid: string;
  group_folder: string;
  requester_user_id: string | null;
  title: string;
  description: string | null;
  proposed_assignee: string | null;
  proposed_due_date: string | null;
  source_quote: string | null;
  status: ProposedTaskStatus;
  created_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
  resulting_task_id: string | null;
  rejection_reason: string | null;
}

export interface ProposedTaskInput {
  id: string;
  summary_id: string;
  chat_jid: string;
  group_folder: string;
  requester_user_id: string | null;
  title: string;
  description: string | null;
  proposed_assignee: string | null;
  proposed_due_date: string | null;
  source_quote: string | null;
}

export function createProposedTasksBatch(rows: ProposedTaskInput[]): void {
  if (rows.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO proposed_tasks
     (id, summary_id, chat_jid, group_folder, requester_user_id, title, description,
      proposed_assignee, proposed_due_date, source_quote, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  );
  const insertMany = db.transaction((items: ProposedTaskInput[]) => {
    const now = new Date().toISOString();
    for (const r of items) {
      stmt.run(
        r.id,
        r.summary_id,
        r.chat_jid,
        r.group_folder,
        r.requester_user_id,
        r.title,
        r.description,
        r.proposed_assignee,
        r.proposed_due_date,
        r.source_quote,
        now,
      );
    }
  });
  insertMany(rows);
}

export function getProposedTask(id: string): ProposedTask | undefined {
  return db.prepare('SELECT * FROM proposed_tasks WHERE id = ?').get(id) as
    | ProposedTask
    | undefined;
}

export function getProposedTasksBySummary(summaryId: string): ProposedTask[] {
  return db
    .prepare(
      'SELECT * FROM proposed_tasks WHERE summary_id = ? ORDER BY created_at',
    )
    .all(summaryId) as ProposedTask[];
}

export function getProposedTasksByStatus(
  status: ProposedTaskStatus,
): ProposedTask[] {
  return db
    .prepare(
      'SELECT * FROM proposed_tasks WHERE status = ? ORDER BY created_at',
    )
    .all(status) as ProposedTask[];
}

export function updateProposedTaskStatus(
  id: string,
  status: ProposedTaskStatus,
  resolvedBy: string | null,
  opts?: { resulting_task_id?: string; rejection_reason?: string | null },
): void {
  const now = new Date().toISOString();
  const fields: string[] = ['status = ?', 'resolved_by = ?', 'resolved_at = ?'];
  const values: unknown[] = [status, resolvedBy, now];
  if (opts?.resulting_task_id !== undefined) {
    fields.push('resulting_task_id = ?');
    values.push(opts.resulting_task_id);
  }
  if (opts?.rejection_reason !== undefined) {
    fields.push('rejection_reason = ?');
    values.push(opts.rejection_reason);
  }
  values.push(id);
  db.prepare(`UPDATE proposed_tasks SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

// --- Expense accessors ---

export type ExpenseStatus =
  | 'pending_approval'
  | 'submitted_retro'
  | 'receipt_pending'
  | 'receipt_submitted'
  | 'approved_retro'
  | 'reimbursed'
  | 'denied'
  | 'denied_retro'
  | 'cancelled';

export interface Expense {
  id: string;
  chat_jid: string;
  requester_user_id: string;
  request_type: 'prospective' | 'retrospective';
  amount_cents: number;
  currency: string;
  description: string;
  category: string | null;
  vendor: string | null;
  justification: string | null;
  expected_date: string | null;
  incurred_date: string | null;
  // Free-form nullable tag, no referent (events table removed). See expenses DDL.
  event_id: string | null;
  approver_user_id: string | null;
  approved_amount_cents: number | null;
  approver_notes: string | null;
  receipt_path: string | null;
  receipt_submitted_at: string | null;
  actual_amount_cents: number | null;
  reimbursed_by: string | null;
  reimbursed_at: string | null;
  reimbursement_method: string | null;
  status: ExpenseStatus;
  created_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
}

export function createExpense(data: {
  id: string;
  chat_jid: string;
  requester_user_id: string;
  request_type: 'prospective' | 'retrospective';
  amount_cents: number;
  currency?: string;
  description: string;
  category?: string | null;
  vendor?: string | null;
  justification?: string | null;
  expected_date?: string | null;
  incurred_date?: string | null;
  event_id?: string | null;
  approver_user_id?: string | null;
  receipt_path?: string | null;
  status: ExpenseStatus;
  created_at: string;
}): void {
  db.prepare(
    `INSERT INTO expenses
     (id, chat_jid, requester_user_id, request_type, amount_cents, currency,
      description, category, vendor, justification, expected_date, incurred_date,
      event_id, approver_user_id, receipt_path, receipt_submitted_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    data.id,
    data.chat_jid,
    data.requester_user_id,
    data.request_type,
    data.amount_cents,
    data.currency || 'USD',
    data.description,
    data.category ?? null,
    data.vendor ?? null,
    data.justification ?? null,
    data.expected_date ?? null,
    data.incurred_date ?? null,
    data.event_id ?? null,
    data.approver_user_id ?? null,
    data.receipt_path ?? null,
    data.receipt_path ? new Date().toISOString() : null,
    data.status,
    data.created_at,
  );
}

export function getExpense(id: string): Expense | undefined {
  return db.prepare('SELECT * FROM expenses WHERE id = ?').get(id) as
    | Expense
    | undefined;
}

export function getExpensesByStatus(status: ExpenseStatus): Expense[] {
  return db
    .prepare('SELECT * FROM expenses WHERE status = ? ORDER BY created_at')
    .all(status) as Expense[];
}

export function getExpensesByRequester(userId: string): Expense[] {
  return db
    .prepare(
      'SELECT * FROM expenses WHERE requester_user_id = ? ORDER BY created_at DESC',
    )
    .all(userId) as Expense[];
}

export function getPendingApprovalQueue(): Expense[] {
  return db
    .prepare(
      `SELECT * FROM expenses
       WHERE status IN ('pending_approval', 'submitted_retro')
       ORDER BY created_at`,
    )
    .all() as Expense[];
}

export function updateExpenseApproval(
  id: string,
  newStatus: ExpenseStatus,
  approverUserId: string,
  approvedAmountCents: number,
  approverNotes: string | null,
): void {
  // resolved_* is only set for terminal states; non-terminal approvals
  // (receipt_pending, approved_retro) are still in flight.
  const isTerminal = newStatus === 'denied' || newStatus === 'denied_retro';
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE expenses
     SET status = ?, approver_user_id = ?, approved_amount_cents = ?,
         approver_notes = ?, resolved_by = ?, resolved_at = ?
     WHERE id = ?`,
  ).run(
    newStatus,
    approverUserId,
    approvedAmountCents,
    approverNotes,
    isTerminal ? approverUserId : null,
    isTerminal ? now : null,
    id,
  );
}

export function attachReceipt(
  id: string,
  receiptPath: string,
  actualAmountCents: number | null,
): void {
  db.prepare(
    `UPDATE expenses
     SET receipt_path = ?, receipt_submitted_at = ?, actual_amount_cents = ?,
         status = 'receipt_submitted'
     WHERE id = ?`,
  ).run(receiptPath, new Date().toISOString(), actualAmountCents, id);
}

export function markReimbursed(
  id: string,
  reimburserUserId: string,
  method: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE expenses
     SET reimbursed_by = ?, reimbursed_at = ?, reimbursement_method = ?,
         status = 'reimbursed', resolved_by = ?, resolved_at = ?
     WHERE id = ?`,
  ).run(reimburserUserId, now, method, reimburserUserId, now, id);
}

export function cancelExpense(id: string, requesterUserId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE expenses
     SET status = 'cancelled', resolved_by = ?, resolved_at = ?
     WHERE id = ?`,
  ).run(requesterUserId, now, id);
}

// --- Proposal approval accessors ---

export interface ProposalApproval {
  id: string;
  booking_id: string;
  requested_by_user_id: string;
  requested_at: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  decided_by_user_id: string | null;
  decided_at: string | null;
  decision_notes: string | null;
}

export function createProposalApproval(
  bookingId: string,
  requestedByUserId: string,
): ProposalApproval {
  // Generate a sequential ID per booking: PA-EVT-014-1, -2, ...
  const existing = db
    .prepare(
      `SELECT COUNT(*) as n FROM proposal_approvals WHERE booking_id = ?`,
    )
    .get(bookingId) as { n: number };
  const id = `PA-${bookingId}-${existing.n + 1}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO proposal_approvals (id, booking_id, requested_by_user_id, requested_at, status)
     VALUES (?, ?, ?, ?, 'pending')`,
  ).run(id, bookingId, requestedByUserId, now);
  return {
    id,
    booking_id: bookingId,
    requested_by_user_id: requestedByUserId,
    requested_at: now,
    status: 'pending',
    decided_by_user_id: null,
    decided_at: null,
    decision_notes: null,
  };
}

export function getPendingProposalApproval(
  bookingId: string,
): ProposalApproval | undefined {
  return db
    .prepare(
      `SELECT * FROM proposal_approvals
       WHERE booking_id = ? AND status = 'pending'
       ORDER BY requested_at DESC LIMIT 1`,
    )
    .get(bookingId) as ProposalApproval | undefined;
}

export function decideProposalApproval(
  approvalId: string,
  decision: 'approved' | 'rejected',
  decidedBy: string,
  notes?: string,
): void {
  db.prepare(
    `UPDATE proposal_approvals
     SET status = ?, decided_by_user_id = ?, decided_at = ?, decision_notes = ?
     WHERE id = ?`,
  ).run(
    decision,
    decidedBy,
    new Date().toISOString(),
    notes ?? null,
    approvalId,
  );
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
