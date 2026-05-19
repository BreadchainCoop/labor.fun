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

  // --- Tour / app tables ---
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS tour_slots (
      id TEXT PRIMARY KEY,
      event_id TEXT,
      slot_date TEXT NOT NULL,
      slot_time TEXT NOT NULL,
      slot_type TEXT NOT NULL DEFAULT 'regular',
      max_capacity INTEGER NOT NULL DEFAULT 10,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (event_id) REFERENCES events(id)
    );
    CREATE TABLE IF NOT EXISTS tour_shifts (
      id TEXT PRIMARY KEY,
      tour_slot_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      shift_type TEXT NOT NULL DEFAULT 'lead',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (tour_slot_id) REFERENCES tour_slots(id),
      FOREIGN KEY (user_id) REFERENCES app_users(id)
    );
    CREATE TABLE IF NOT EXISTS tour_requests (
      id TEXT PRIMARY KEY,
      tour_slot_id TEXT NOT NULL,
      requester_name TEXT NOT NULL,
      requester_email TEXT,
      requester_phone TEXT,
      preferred_date TEXT,
      group_size INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (tour_slot_id) REFERENCES tour_slots(id)
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
      FOREIGN KEY (chat_jid) REFERENCES chats(jid),
      FOREIGN KEY (event_id) REFERENCES events(id)
    );
    CREATE INDEX IF NOT EXISTS idx_expenses_status ON expenses(status);
    CREATE INDEX IF NOT EXISTS idx_expenses_requester ON expenses(requester_user_id);
    CREATE INDEX IF NOT EXISTS idx_expenses_event ON expenses(event_id);
  `);

  // --- Residency tables (rooms, room_occupancy, residency_requests) ---
  database.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      room_number INTEGER NOT NULL UNIQUE,
      room_name TEXT,
      capacity INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rooms_number ON rooms(room_number);

    CREATE TABLE IF NOT EXISTS room_occupancy (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      user_id TEXT,
      guest_name TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT,
      is_guest INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (room_id) REFERENCES rooms(id),
      FOREIGN KEY (user_id) REFERENCES app_users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_occupancy_room ON room_occupancy(room_id, start_date);

    CREATE TABLE IF NOT EXISTS residency_requests (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      source_group TEXT,
      requester_user_id TEXT,
      requester_name TEXT NOT NULL,
      requester_contact TEXT,
      request_type TEXT NOT NULL DEFAULT 'resident',
      requested_start_date TEXT NOT NULL,
      requested_end_date TEXT,
      room_preference TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_by TEXT,
      resolved_at TEXT,
      resolution_notes TEXT,
      FOREIGN KEY (chat_jid) REFERENCES chats(jid),
      FOREIGN KEY (requester_user_id) REFERENCES app_users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_residency_requests_status ON residency_requests(status, created_at);

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

  // --- Event intake / booking tables ---
  database.exec(`
    CREATE TABLE IF NOT EXISTS event_bookings (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      requester_user_id TEXT NOT NULL,
      requester_name TEXT NOT NULL,
      requester_email TEXT,
      requester_phone TEXT,

      event_name TEXT,
      event_type TEXT,
      event_date TEXT,
      start_time TEXT,
      end_time TEXT,
      expected_headcount INTEGER,
      preferred_space TEXT,

      base_venue_fee REAL,
      portfolio_discount INTEGER DEFAULT 0,
      av_line_item REAL,
      cleaning_fee REAL,
      catering_passthrough REAL,
      damage_deposit REAL,
      total_quote REAL,
      deposit_pct REAL,
      final_payment_due TEXT,

      on_site_lead_user_id TEXT,
      greeter_user_id TEXT,
      bar_kitchen_user_id TEXT,
      cleaner_user_id TEXT,
      outside_vendors TEXT,

      intake_date TEXT,
      intake_owner_user_id TEXT,
      status TEXT NOT NULL DEFAULT 'inquiry',
      proposal_sent_at TEXT,
      contract_sent_at TEXT,
      contract_signed_date TEXT,
      deposit_paid_date TEXT,
      calendar_entry_code TEXT,
      cancellation_reason TEXT,
      post_event_state TEXT,

      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_by TEXT,
      resolved_at TEXT,

      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_event_bookings_status ON event_bookings(status);
    CREATE INDEX IF NOT EXISTS idx_event_bookings_event_date ON event_bookings(event_date);
    CREATE INDEX IF NOT EXISTS idx_event_bookings_intake_owner ON event_bookings(intake_owner_user_id);

    CREATE TABLE IF NOT EXISTS event_intake_answers (
      booking_id TEXT NOT NULL,
      question_key TEXT NOT NULL,
      answer TEXT,
      PRIMARY KEY (booking_id, question_key),
      FOREIGN KEY (booking_id) REFERENCES event_bookings(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS proposal_approvals (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL,
      requested_by_user_id TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      decided_by_user_id TEXT,
      decided_at TEXT,
      decision_notes TEXT,
      FOREIGN KEY (booking_id) REFERENCES event_bookings(id) ON DELETE CASCADE
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

  // Tag hierarchy: which tags can assign which other tags
  database.exec(`
    CREATE TABLE IF NOT EXISTS tag_hierarchy (
      parent_tag TEXT NOT NULL,
      child_tag TEXT NOT NULL,
      PRIMARY KEY (parent_tag, child_tag)
    )
  `);

  // Seed tag hierarchy (idempotent)
  const seedHierarchy = database.prepare(
    `INSERT OR IGNORE INTO tag_hierarchy (parent_tag, child_tag) VALUES (?, ?)`,
  );
  const adminChildren = [
    'admin',
    'leadership',
    'engineering',
    'creative',
    'operations',
    'community',
  ];
  const leadershipChildren = [
    'engineering',
    'creative',
    'operations',
    'community',
  ];
  for (const child of adminChildren) seedHierarchy.run('admin', child);
  for (const child of leadershipChildren)
    seedHierarchy.run('leadership', child);

  // Seed known user identities (idempotent) from SEED_IDENTITIES env var.
  // Format: JSON array of {platform_id, platform, kb_person} objects.
  // Example: SEED_IDENTITIES='[{"platform_id":"cli:ops","platform":"cli","kb_person":"ops"}]'
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
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

// --- Residency accessors ---

export interface AppUser {
  id: string;
  name: string;
  created_at: string;
}

export interface Room {
  id: string;
  room_number: number;
  room_name: string | null;
  capacity: number;
  notes: string | null;
  created_at: string;
  occupancy?: RoomOccupancy[];
}

export interface RoomOccupancy {
  id: string;
  room_id: string;
  user_id: string | null;
  guest_name: string | null;
  user_name?: string | null;
  start_date: string;
  end_date: string | null;
  is_guest: number;
  notes: string | null;
  created_at: string;
}

export function getAllRooms(): Room[] {
  const rooms = db
    .prepare('SELECT * FROM rooms ORDER BY room_number')
    .all() as Room[];
  for (const room of rooms) {
    room.occupancy = db
      .prepare(
        `
      SELECT ro.*, au.name as user_name
      FROM room_occupancy ro
      LEFT JOIN app_users au ON ro.user_id = au.id
      WHERE ro.room_id = ?
      ORDER BY ro.start_date
    `,
      )
      .all(room.id) as RoomOccupancy[];
  }
  return rooms;
}

export function createRoom(data: {
  room_number: number;
  room_name: string | null;
  capacity: number;
  notes: string | null;
}): Room {
  const id = generateId();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO rooms (id, room_number, room_name, capacity, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, data.room_number, data.room_name, data.capacity, data.notes, now);
  return {
    id,
    room_number: data.room_number,
    room_name: data.room_name,
    capacity: data.capacity,
    notes: data.notes,
    created_at: now,
  };
}

export function deleteRoom(id: string): void {
  db.prepare('DELETE FROM room_occupancy WHERE room_id = ?').run(id);
  db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
}

export function createOccupancy(data: {
  room_id: string;
  user_id: string | null;
  guest_name: string | null;
  start_date: string;
  end_date: string | null;
  is_guest: boolean;
  notes: string | null;
}): void {
  const id = generateId();
  db.prepare(
    'INSERT INTO room_occupancy (id, room_id, user_id, guest_name, start_date, end_date, is_guest, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    data.room_id,
    data.user_id,
    data.guest_name,
    data.start_date,
    data.end_date,
    data.is_guest ? 1 : 0,
    data.notes,
  );
}

export function updateOccupancy(
  id: string,
  updates: { start_date?: string; end_date?: string | null; notes?: string },
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.start_date !== undefined) {
    fields.push('start_date = ?');
    values.push(updates.start_date);
  }
  if (updates.end_date !== undefined) {
    fields.push('end_date = ?');
    values.push(updates.end_date);
  }
  if (updates.notes !== undefined) {
    fields.push('notes = ?');
    values.push(updates.notes);
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE room_occupancy SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function deleteOccupancy(id: string): void {
  db.prepare('DELETE FROM room_occupancy WHERE id = ?').run(id);
}

// --- Residency request accessors ---

export interface ResidencyRequest {
  id: string;
  chat_jid: string;
  source_group: string | null;
  requester_user_id: string | null;
  requester_name: string;
  requester_contact: string | null;
  request_type: string;
  requested_start_date: string;
  requested_end_date: string | null;
  room_preference: string | null;
  notes: string | null;
  status: string;
  created_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_notes: string | null;
}

export function createResidencyRequest(params: {
  id?: string;
  chat_jid: string;
  source_group?: string | null;
  requester_user_id?: string | null;
  requester_name: string;
  requester_contact?: string | null;
  request_type?: string;
  requested_start_date: string;
  requested_end_date?: string | null;
  room_preference?: string | null;
  notes?: string | null;
}): ResidencyRequest {
  const id =
    params.id || `rr-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const now = new Date().toISOString();
  const request: ResidencyRequest = {
    id,
    chat_jid: params.chat_jid,
    source_group: params.source_group || null,
    requester_user_id: params.requester_user_id || null,
    requester_name: params.requester_name,
    requester_contact: params.requester_contact || null,
    request_type: params.request_type || 'resident',
    requested_start_date: params.requested_start_date,
    requested_end_date: params.requested_end_date || null,
    room_preference: params.room_preference || null,
    notes: params.notes || null,
    status: 'pending',
    created_at: now,
    resolved_by: null,
    resolved_at: null,
    resolution_notes: null,
  };
  db.prepare(
    `INSERT INTO residency_requests
       (id, chat_jid, source_group, requester_user_id, requester_name, requester_contact,
        request_type, requested_start_date, requested_end_date, room_preference, notes,
        status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    request.id,
    request.chat_jid,
    request.source_group,
    request.requester_user_id,
    request.requester_name,
    request.requester_contact,
    request.request_type,
    request.requested_start_date,
    request.requested_end_date,
    request.room_preference,
    request.notes,
    request.status,
    request.created_at,
  );
  return request;
}

export function getResidencyRequest(id: string): ResidencyRequest | undefined {
  return db.prepare('SELECT * FROM residency_requests WHERE id = ?').get(id) as
    | ResidencyRequest
    | undefined;
}

export function listResidencyRequestsByStatus(
  status?: string,
): ResidencyRequest[] {
  if (status) {
    return db
      .prepare(
        'SELECT * FROM residency_requests WHERE status = ? ORDER BY created_at DESC',
      )
      .all(status) as ResidencyRequest[];
  }
  return db
    .prepare('SELECT * FROM residency_requests ORDER BY created_at DESC')
    .all() as ResidencyRequest[];
}

export function updateResidencyRequestStatus(
  id: string,
  status: string,
  resolvedBy: string | null,
  resolutionNotes: string | null,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE residency_requests
     SET status = ?, resolved_by = ?, resolved_at = ?, resolution_notes = ?
     WHERE id = ?`,
  ).run(status, resolvedBy, now, resolutionNotes, id);
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

// --- Tour tables (app_users, tour_slots, tour_shifts, tour_requests) ---

export interface TourSlot {
  id: string;
  event_id: string | null;
  slot_date: string;
  slot_time: string;
  slot_type: string;
  max_capacity: number;
  notes: string | null;
  created_at: string;
}

export interface TourShift {
  id: string;
  tour_slot_id: string;
  user_id: string;
  shift_type: string;
  created_at: string;
  user_name?: string;
}

export interface TourRequest {
  id: string;
  tour_slot_id: string;
  requester_name: string;
  requester_email: string | null;
  requester_phone: string | null;
  preferred_date: string | null;
  group_size: number;
  notes: string | null;
  status: string;
  created_at: string;
}

// --- Event accessors ---

function generateId(): string {
  return crypto.randomUUID();
}

function normalizeSlotTime(time: string): string {
  // Normalize HH:MM to HH:MM:SS
  const parts = time.split(':');
  if (parts.length === 2) return `${parts[0]}:${parts[1]}:00`;
  return time;
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

export function createTourSlot(params: {
  slot_date: string;
  slot_time: string;
  slot_type?: string;
  event_id?: string | null;
  max_capacity?: number;
  notes?: string | null;
}): TourSlot {
  const id = generateId();
  const now = new Date().toISOString();
  const slot: TourSlot = {
    id,
    event_id: params.event_id || null,
    slot_date: params.slot_date,
    slot_time: normalizeSlotTime(params.slot_time),
    slot_type: params.slot_type || 'regular',
    max_capacity: params.max_capacity ?? 10,
    notes: params.notes || null,
    created_at: now,
  };
  db.prepare(
    `INSERT INTO tour_slots (id, event_id, slot_date, slot_time, slot_type, max_capacity, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    slot.id,
    slot.event_id,
    slot.slot_date,
    slot.slot_time,
    slot.slot_type,
    slot.max_capacity,
    slot.notes,
    slot.created_at,
  );
  return slot;
}

const SHIFTS_FOR_SLOT_SQL = `
  SELECT s.*, u.name AS user_name
  FROM tour_shifts s
  LEFT JOIN app_users u ON s.user_id = u.id
  WHERE s.tour_slot_id = ?
  ORDER BY s.created_at
`;

const REQUESTS_FOR_SLOT_SQL = `
  SELECT * FROM tour_requests WHERE tour_slot_id = ? ORDER BY created_at
`;

export function getTourSlotById(
  id: string,
): (TourSlot & { shifts: TourShift[]; requests: TourRequest[] }) | undefined {
  const slot = db.prepare('SELECT * FROM tour_slots WHERE id = ?').get(id) as
    | TourSlot
    | undefined;
  if (!slot) return undefined;
  const shifts = db.prepare(SHIFTS_FOR_SLOT_SQL).all(id) as TourShift[];
  const requests = db.prepare(REQUESTS_FOR_SLOT_SQL).all(id) as TourRequest[];
  return { ...slot, shifts, requests };
}

export function getAllTourSlots(): (TourSlot & {
  shifts: TourShift[];
  requests: TourRequest[];
})[] {
  const slots = db
    .prepare('SELECT * FROM tour_slots ORDER BY slot_date, slot_time')
    .all() as TourSlot[];
  return slots.map((slot) => {
    const shifts = db.prepare(SHIFTS_FOR_SLOT_SQL).all(slot.id) as TourShift[];
    const requests = db
      .prepare(REQUESTS_FOR_SLOT_SQL)
      .all(slot.id) as TourRequest[];
    return { ...slot, shifts, requests };
  });
}

export function getUpcomingTourSlots(): (TourSlot & {
  shifts: TourShift[];
  requests: TourRequest[];
})[] {
  const today = new Date().toISOString().split('T')[0];
  const slots = db
    .prepare(
      'SELECT * FROM tour_slots WHERE slot_date >= ? ORDER BY slot_date, slot_time',
    )
    .all(today) as TourSlot[];
  return slots.map((slot) => {
    const shifts = db.prepare(SHIFTS_FOR_SLOT_SQL).all(slot.id) as TourShift[];
    const requests = db
      .prepare(REQUESTS_FOR_SLOT_SQL)
      .all(slot.id) as TourRequest[];
    return { ...slot, shifts, requests };
  });
}

export function getPastTourSlots(sinceDays = 30): (TourSlot & {
  shifts: TourShift[];
  requests: TourRequest[];
})[] {
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const sinceDate = new Date(today.getTime() - sinceDays * 86400000);
  const sinceStr = sinceDate.toISOString().split('T')[0];
  const slots = db
    .prepare(
      'SELECT * FROM tour_slots WHERE slot_date < ? AND slot_date >= ? ORDER BY slot_date DESC, slot_time',
    )
    .all(todayStr, sinceStr) as TourSlot[];
  return slots.map((slot) => {
    const shifts = db.prepare(SHIFTS_FOR_SLOT_SQL).all(slot.id) as TourShift[];
    const requests = db
      .prepare(REQUESTS_FOR_SLOT_SQL)
      .all(slot.id) as TourRequest[];
    return { ...slot, shifts, requests };
  });
}

export function getTourShiftById(
  id: string,
): (TourShift & { slot_date?: string; slot_time?: string }) | undefined {
  return db
    .prepare(
      `SELECT s.*, u.name AS user_name, ts.slot_date, ts.slot_time
       FROM tour_shifts s
       LEFT JOIN app_users u ON s.user_id = u.id
       LEFT JOIN tour_slots ts ON s.tour_slot_id = ts.id
       WHERE s.id = ?`,
    )
    .get(id) as
    | (TourShift & { slot_date?: string; slot_time?: string })
    | undefined;
}

export function getTourRequestById(id: string): TourRequest | undefined {
  return db.prepare('SELECT * FROM tour_requests WHERE id = ?').get(id) as
    | TourRequest
    | undefined;
}

export function generateWeeklySlots(): TourSlot[] {
  const created: TourSlot[] = [];
  const now = new Date();

  for (let week = 0; week < 4; week++) {
    for (const dayOffset of [1, 5]) {
      // Monday=1, Friday=5
      const date = new Date(now);
      // Move to next occurrence of this weekday
      const currentDay = date.getDay();
      let daysUntil = dayOffset - currentDay;
      if (daysUntil <= 0) daysUntil += 7;
      date.setDate(date.getDate() + daysUntil + week * 7);

      const slotDate = date.toISOString().split('T')[0];

      // Check if slot already exists for this date+time
      const existing = db
        .prepare(
          'SELECT id FROM tour_slots WHERE slot_date = ? AND slot_time = ?',
        )
        .get(slotDate, '14:00:00');
      if (existing) continue;

      const slot = createTourSlot({
        slot_date: slotDate,
        slot_time: '14:00',
        slot_type: 'regular',
      });
      created.push(slot);
    }
  }

  return created;
}

export function createTourShift(params: {
  tour_slot_id: string;
  user_id: string;
  shift_type?: string;
}): TourShift {
  const id = generateId();
  const now = new Date().toISOString();
  const shift: TourShift = {
    id,
    tour_slot_id: params.tour_slot_id,
    user_id: params.user_id,
    shift_type: params.shift_type || 'lead',
    created_at: now,
  };
  db.prepare(
    `INSERT INTO tour_shifts (id, tour_slot_id, user_id, shift_type, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    shift.id,
    shift.tour_slot_id,
    shift.user_id,
    shift.shift_type,
    shift.created_at,
  );
  return shift;
}

export function deleteTourShift(id: string): void {
  db.prepare('DELETE FROM tour_shifts WHERE id = ?').run(id);
}

export function createTourRequest(params: {
  tour_slot_id: string;
  requester_name: string;
  requester_email?: string | null;
  requester_phone?: string | null;
  preferred_date?: string | null;
  group_size?: number;
  notes?: string | null;
}): TourRequest {
  const id = generateId();
  const now = new Date().toISOString();
  const request: TourRequest = {
    id,
    tour_slot_id: params.tour_slot_id,
    requester_name: params.requester_name,
    requester_email: params.requester_email || null,
    requester_phone: params.requester_phone || null,
    preferred_date: params.preferred_date || null,
    group_size: params.group_size ?? 1,
    notes: params.notes || null,
    status: 'pending',
    created_at: now,
  };
  db.prepare(
    `INSERT INTO tour_requests (id, tour_slot_id, requester_name, requester_email, requester_phone, preferred_date, group_size, notes, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    request.id,
    request.tour_slot_id,
    request.requester_name,
    request.requester_email,
    request.requester_phone,
    request.preferred_date,
    request.group_size,
    request.notes,
    request.status,
    request.created_at,
  );
  return request;
}

export function updateTourRequestStatus(id: string, status: string): void {
  db.prepare('UPDATE tour_requests SET status = ? WHERE id = ?').run(
    status,
    id,
  );
}

export function deleteTourRequest(id: string): void {
  db.prepare('DELETE FROM tour_requests WHERE id = ?').run(id);
}

export interface Event {
  id: string;
  google_calendar_id: string | null;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string;
  location: string | null;
  tours_eligible: number;
  created_at: string;
  updated_at: string;
}

export interface EventAssignment {
  id: string;
  event_id: string;
  user_id: string;
  role: string;
  notes: string | null;
  created_at: string;
  user_name?: string;
}

export function getAllEvents(): Event[] {
  return db
    .prepare('SELECT * FROM events ORDER BY start_time ASC')
    .all() as Event[];
}

export function getEventsWithoutTourSlots(): Event[] {
  const nowIso = new Date().toISOString();
  return db
    .prepare(
      `SELECT e.* FROM events e
       LEFT JOIN tour_slots ts ON ts.event_id = e.id
       WHERE ts.id IS NULL AND e.start_time >= ?
       ORDER BY e.start_time ASC`,
    )
    .all(nowIso) as Event[];
}

export function getEventById(id: string): Event | undefined {
  return db.prepare('SELECT * FROM events WHERE id = ?').get(id) as
    | Event
    | undefined;
}

export function getAssignmentsForEvent(eventId: string): EventAssignment[] {
  return db
    .prepare(
      `SELECT ea.*, au.name as user_name
       FROM event_assignments ea
       JOIN app_users au ON ea.user_id = au.id
       WHERE ea.event_id = ?`,
    )
    .all(eventId) as EventAssignment[];
}

export function createAssignment(data: {
  event_id: string;
  user_id: string;
  role: string;
  notes: string | null;
}): EventAssignment {
  const id = generateId();
  db.prepare(
    `INSERT INTO event_assignments (id, event_id, user_id, role, notes) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, data.event_id, data.user_id, data.role, data.notes);
  return { id, ...data, created_at: new Date().toISOString() };
}

export function deleteAssignment(id: string): void {
  db.prepare('DELETE FROM event_assignments WHERE id = ?').run(id);
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

export function getExpensesByEvent(eventId: string): Expense[] {
  return db
    .prepare('SELECT * FROM expenses WHERE event_id = ? ORDER BY created_at')
    .all(eventId) as Expense[];
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

// --- Event booking accessors ---

export type EventBookingStatus =
  | 'inquiry'
  | 'proposal_sent'
  | 'contract_out'
  | 'confirmed'
  | 'complete'
  | 'cancelled';

export interface EventBooking {
  id: string;
  chat_jid: string;
  requester_user_id: string;
  requester_name: string;
  requester_email: string | null;
  requester_phone: string | null;

  event_name: string | null;
  event_type: string | null;
  event_date: string | null;
  start_time: string | null;
  end_time: string | null;
  expected_headcount: number | null;
  preferred_space: string | null;

  base_venue_fee: number | null;
  portfolio_discount: number;
  av_line_item: number | null;
  cleaning_fee: number | null;
  catering_passthrough: number | null;
  damage_deposit: number | null;
  total_quote: number | null;
  deposit_pct: number | null;
  final_payment_due: string | null;

  on_site_lead_user_id: string | null;
  greeter_user_id: string | null;
  bar_kitchen_user_id: string | null;
  cleaner_user_id: string | null;
  outside_vendors: string | null;

  intake_date: string | null;
  intake_owner_user_id: string | null;
  status: EventBookingStatus;
  proposal_sent_at: string | null;
  contract_sent_at: string | null;
  contract_signed_date: string | null;
  deposit_paid_date: string | null;
  calendar_entry_code: string | null;
  cancellation_reason: string | null;
  post_event_state: string | null;

  created_at: string;
  updated_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
}

export interface EventIntakeAnswer {
  booking_id: string;
  question_key: string;
  answer: string | null;
}

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

/**
 * Generate the next monotonic event-booking code (EVT-001, EVT-002, ...).
 * Scans existing IDs and returns max+1, zero-padded to 3 digits.
 */
export function nextEventBookingCode(): string {
  const row = db
    .prepare(
      `SELECT id FROM event_bookings WHERE id LIKE 'EVT-%' ORDER BY CAST(SUBSTR(id, 5) AS INTEGER) DESC LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  const lastN = row ? parseInt(row.id.slice(4), 10) : 0;
  const next = (Number.isFinite(lastN) ? lastN : 0) + 1;
  return `EVT-${String(next).padStart(3, '0')}`;
}

export function createEventBooking(
  data: {
    id: string;
    chat_jid: string;
    requester_user_id: string;
    requester_name: string;
    requester_email?: string | null;
    requester_phone?: string | null;
    event_name?: string | null;
    event_type?: string | null;
    event_date?: string | null;
    start_time?: string | null;
    end_time?: string | null;
    expected_headcount?: number | null;
    preferred_space?: string | null;
    status?: EventBookingStatus;
    created_at?: string;
  },
  answers?: Record<string, string>,
): void {
  const now = data.created_at ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO event_bookings (
       id, chat_jid, requester_user_id, requester_name, requester_email, requester_phone,
       event_name, event_type, event_date, start_time, end_time, expected_headcount, preferred_space,
       status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    data.id,
    data.chat_jid,
    data.requester_user_id,
    data.requester_name,
    data.requester_email ?? null,
    data.requester_phone ?? null,
    data.event_name ?? null,
    data.event_type ?? null,
    data.event_date ?? null,
    data.start_time ?? null,
    data.end_time ?? null,
    data.expected_headcount ?? null,
    data.preferred_space ?? null,
    data.status ?? 'inquiry',
    now,
    now,
  );

  if (answers && Object.keys(answers).length > 0) {
    const insert = db.prepare(
      `INSERT OR REPLACE INTO event_intake_answers (booking_id, question_key, answer) VALUES (?, ?, ?)`,
    );
    const tx = db.transaction((entries: [string, string][]) => {
      for (const [key, value] of entries) {
        insert.run(data.id, key, value ?? null);
      }
    });
    tx(Object.entries(answers));
  }
}

export function getEventBooking(
  id: string,
): (EventBooking & { answers: Record<string, string> }) | undefined {
  const row = db
    .prepare('SELECT * FROM event_bookings WHERE id = ?')
    .get(id) as EventBooking | undefined;
  if (!row) return undefined;
  const answerRows = db
    .prepare(
      'SELECT question_key, answer FROM event_intake_answers WHERE booking_id = ?',
    )
    .all(id) as Array<{ question_key: string; answer: string | null }>;
  const answers: Record<string, string> = {};
  for (const ar of answerRows) {
    if (ar.answer !== null) answers[ar.question_key] = ar.answer;
  }
  return { ...row, answers };
}

export function getEventBookingsByStatus(
  status: EventBookingStatus,
): EventBooking[] {
  return db
    .prepare(
      'SELECT * FROM event_bookings WHERE status = ? ORDER BY event_date ASC, created_at ASC',
    )
    .all(status) as EventBooking[];
}

export function getEventBookingsByDateRange(
  fromDate: string,
  toDate: string,
): EventBooking[] {
  return db
    .prepare(
      `SELECT * FROM event_bookings
       WHERE event_date IS NOT NULL AND event_date >= ? AND event_date <= ?
       ORDER BY event_date ASC`,
    )
    .all(fromDate, toDate) as EventBooking[];
}

export function getAllEventBookings(): EventBooking[] {
  return db
    .prepare('SELECT * FROM event_bookings ORDER BY created_at DESC')
    .all() as EventBooking[];
}

export function updateEventBookingPricing(
  id: string,
  fields: {
    base_venue_fee?: number | null;
    portfolio_discount?: number;
    av_line_item?: number | null;
    cleaning_fee?: number | null;
    catering_passthrough?: number | null;
    damage_deposit?: number | null;
    total_quote?: number | null;
    deposit_pct?: number | null;
    final_payment_due?: string | null;
  },
  actor: string,
): void {
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    cols.push(`${k} = ?`);
    vals.push(v);
  }
  if (cols.length === 0) return;
  cols.push('updated_at = ?');
  vals.push(new Date().toISOString());
  cols.push('resolved_by = ?');
  vals.push(actor);
  vals.push(id);
  db.prepare(`UPDATE event_bookings SET ${cols.join(', ')} WHERE id = ?`).run(
    ...vals,
  );
}

export function updateEventBookingStaffing(
  id: string,
  fields: {
    on_site_lead_user_id?: string | null;
    greeter_user_id?: string | null;
    bar_kitchen_user_id?: string | null;
    cleaner_user_id?: string | null;
    outside_vendors?: string | null;
  },
  actor: string,
): void {
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    cols.push(`${k} = ?`);
    vals.push(v);
  }
  if (cols.length === 0) return;
  cols.push('updated_at = ?');
  vals.push(new Date().toISOString());
  cols.push('resolved_by = ?');
  vals.push(actor);
  vals.push(id);
  db.prepare(`UPDATE event_bookings SET ${cols.join(', ')} WHERE id = ?`).run(
    ...vals,
  );
}

export function setEventBookingMeta(
  id: string,
  fields: {
    intake_owner_user_id?: string | null;
    intake_date?: string | null;
    calendar_entry_code?: string | null;
  },
): void {
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    cols.push(`${k} = ?`);
    vals.push(v);
  }
  if (cols.length === 0) return;
  cols.push('updated_at = ?');
  vals.push(new Date().toISOString());
  vals.push(id);
  db.prepare(`UPDATE event_bookings SET ${cols.join(', ')} WHERE id = ?`).run(
    ...vals,
  );
}

const ALLOWED_TRANSITIONS: Record<EventBookingStatus, EventBookingStatus[]> = {
  inquiry: ['proposal_sent', 'cancelled'],
  proposal_sent: ['contract_out', 'cancelled'],
  contract_out: ['confirmed', 'cancelled'],
  confirmed: ['complete', 'cancelled'],
  complete: [],
  cancelled: [],
};

/**
 * Move a booking to a new lifecycle state, enforcing required-field guards.
 * Throws if the transition is illegal or required fields are missing.
 */
export function transitionEventBooking(
  id: string,
  newStatus: EventBookingStatus,
  actor: string,
  meta: {
    contract_signed_date?: string;
    deposit_paid_date?: string;
    cancellation_reason?: string;
    post_event_state?: string;
  } = {},
): EventBooking {
  const booking = db
    .prepare('SELECT * FROM event_bookings WHERE id = ?')
    .get(id) as EventBooking | undefined;
  if (!booking) throw new Error(`Booking ${id} not found`);

  const allowed = ALLOWED_TRANSITIONS[booking.status] ?? [];
  if (!allowed.includes(newStatus)) {
    throw new Error(
      `Cannot transition ${id} from ${booking.status} to ${newStatus}`,
    );
  }

  // Required-field guards per target state
  if (newStatus === 'proposal_sent') {
    const missing: string[] = [];
    if (booking.total_quote == null) missing.push('total_quote');
    if (booking.deposit_pct == null) missing.push('deposit_pct');
    if (!booking.final_payment_due) missing.push('final_payment_due');
    if (missing.length > 0) {
      throw new Error(
        `Cannot send proposal — missing pricing: ${missing.join(', ')}`,
      );
    }
    // Admin approval gate: require an APPROVED proposal_approvals row
    const approval = db
      .prepare(
        `SELECT * FROM proposal_approvals
         WHERE booking_id = ? AND status = 'approved'
         ORDER BY decided_at DESC LIMIT 1`,
      )
      .get(id) as ProposalApproval | undefined;
    if (!approval) {
      throw new Error(
        `Cannot send proposal — admin approval required (none on file)`,
      );
    }
  }
  if (newStatus === 'confirmed') {
    if (!meta.contract_signed_date && !booking.contract_signed_date) {
      throw new Error('Cannot confirm — contract_signed_date required');
    }
    if (!meta.deposit_paid_date && !booking.deposit_paid_date) {
      throw new Error('Cannot confirm — deposit_paid_date required');
    }
  }
  if (newStatus === 'complete') {
    if (!meta.post_event_state && !booking.post_event_state) {
      throw new Error('Cannot complete — post_event_state required');
    }
  }
  if (newStatus === 'cancelled' && !meta.cancellation_reason) {
    throw new Error('Cannot cancel — cancellation_reason required');
  }

  const now = new Date().toISOString();
  const cols = ['status = ?', 'updated_at = ?', 'resolved_by = ?'];
  const vals: unknown[] = [newStatus, now, actor];

  if (newStatus === 'proposal_sent') {
    cols.push('proposal_sent_at = ?');
    vals.push(now);
  }
  if (newStatus === 'contract_out') {
    cols.push('contract_sent_at = ?');
    vals.push(now);
  }
  if (newStatus === 'confirmed') {
    if (meta.contract_signed_date) {
      cols.push('contract_signed_date = ?');
      vals.push(meta.contract_signed_date);
    }
    if (meta.deposit_paid_date) {
      cols.push('deposit_paid_date = ?');
      vals.push(meta.deposit_paid_date);
    }
  }
  if (newStatus === 'complete') {
    if (meta.post_event_state) {
      cols.push('post_event_state = ?');
      vals.push(meta.post_event_state);
    }
    cols.push('resolved_at = ?');
    vals.push(now);
  }
  if (newStatus === 'cancelled') {
    cols.push('cancellation_reason = ?');
    vals.push(meta.cancellation_reason);
    cols.push('resolved_at = ?');
    vals.push(now);
  }

  vals.push(id);
  db.prepare(`UPDATE event_bookings SET ${cols.join(', ')} WHERE id = ?`).run(
    ...vals,
  );

  return db
    .prepare('SELECT * FROM event_bookings WHERE id = ?')
    .get(id) as EventBooking;
}

// --- Proposal approval accessors ---

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
