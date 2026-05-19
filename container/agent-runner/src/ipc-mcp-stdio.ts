/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'modify_kb_file',
  "Create or update a file in the organization knowledge base. Use this to modify tasks, calendar events, artifacts, spaces, or other KB files. The orchestrator enforces access control — your permissions are checked against the sender context (admin, coordinator, etc.). Paths are relative to the KB context directory (e.g. 'tasks/TASK-001.md', 'calendar/upcoming.md').",
  {
    file_path: z.string().describe('Relative path within the KB context directory (e.g. "tasks/TASK-001.md", "calendar/2026-04-09-event.md")'),
    content: z.string().describe('Full file content to write (including YAML frontmatter)'),
    action: z.enum(['write', 'delete']).optional().describe('Action: "write" (default) to create/overwrite, "delete" to remove the file'),
  },
  async (args) => {
    const data = {
      type: 'modify_kb_file',
      filePath: args.file_path,
      content: args.content || '',
      action: args.action || 'write',
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: `KB file modification queued: ${args.action || 'write'} ${args.file_path}` }] };
  },
);

server.tool(
  'send_email',
  'Send an email from the configured Breadbrich Engels address. RESTRICTED: can only send to addresses in the orchestrator-configured whitelist (EMAIL_WHITELIST env var). Sends to any other address will be rejected by the orchestrator. The orchestrator handles SMTP.',
  {
    to: z.string().describe('Recipient email address. Must be on the orchestrator whitelist.'),
    subject: z.string().describe('Email subject line'),
    body: z.string().describe('Email body text (plain text)'),
  },
  async (args) => {
    const data = {
      type: 'email',
      to: args.to,
      subject: args.subject,
      body: args.body,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: `Email queued to ${args.to}.` }] };
  },
);

server.tool(
  'send_message',
  "Send a message to the current chat, OR to a different channel using target_jid. To send cross-channel (e.g. Slack→Telegram), set target_jid to the recipient's JID like 'tg:1234567890'. Without target_jid, the message goes to the current chat. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    target_jid: z
      .string()
      .optional()
      .describe(
        'Target channel JID for cross-channel messaging. Examples: "tg:1234567890" (Telegram), "slack:CXXXXXXXXX" (Slack). Omit to send to current chat. Admin/coordinator senders are authorized automatically.',
      ),
    sender: z
      .string()
      .optional()
      .describe(
        'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
      ),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid: args.target_jid || chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'delete_message',
  `Delete a message you previously sent. Use list_my_recent_messages to find the message_id. Restrictions: you can only delete your own bot messages, not user messages. Telegram bots can only delete their own messages within 48 hours of sending. Slack requires chat:write scope and the workspace must allow bot deletions.`,
  {
    message_id: z
      .string()
      .describe('The message ID to delete (from list_my_recent_messages).'),
    target_jid: z
      .string()
      .optional()
      .describe(
        'Target chat JID. Omit to operate on the current chat. Cross-chat deletion has the same authorization as send_message (main/admin only).',
      ),
  },
  async (args) => {
    const data = {
      type: 'delete_message',
      chatJid: args.target_jid || chatJid,
      messageId: args.message_id,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MESSAGES_DIR, data);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Delete queued for message ${args.message_id}.`,
        },
      ],
    };
  },
);

server.tool(
  'edit_message',
  `Edit (replace the text of) a message you previously sent. Use list_my_recent_messages to find the message_id. Restrictions: you can only edit your own bot messages. Telegram bot edits work indefinitely for text messages. Slack requires chat:write scope.`,
  {
    message_id: z
      .string()
      .describe('The message ID to edit (from list_my_recent_messages).'),
    text: z.string().describe('The new message text.'),
    target_jid: z
      .string()
      .optional()
      .describe(
        'Target chat JID. Omit to operate on the current chat. Cross-chat edits have the same authorization as send_message (main/admin only).',
      ),
  },
  async (args) => {
    const data = {
      type: 'edit_message',
      chatJid: args.target_jid || chatJid,
      messageId: args.message_id,
      text: args.text,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MESSAGES_DIR, data);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Edit queued for message ${args.message_id}.`,
        },
      ],
    };
  },
);

server.tool(
  'list_my_recent_messages',
  `List your (the bot's) most recent messages in the current chat with their IDs. Use this before calling delete_message or edit_message — those tools need the message_id from this list. Returns up to 10 messages, newest first.`,
  {},
  async () => {
    const file = path.join(IPC_DIR, 'recent_outbound.json');
    try {
      if (!fs.existsSync(file)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No recent bot messages recorded yet.',
            },
          ],
        };
      }
      const messages = JSON.parse(fs.readFileSync(file, 'utf-8')) as Array<{
        id: string;
        content: string;
        timestamp: string;
      }>;
      if (messages.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No recent bot messages.' },
          ],
        };
      }
      const formatted = messages
        .map((m) => {
          const preview =
            m.content.length > 120
              ? m.content.slice(0, 120) + '...'
              : m.content;
          return `- [${m.id}] (${m.timestamp}) ${preview}`;
        })
        .join('\n');
      return {
        content: [
          {
            type: 'text' as const,
            text: `Recent bot messages (newest first):\n${formatted}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading recent messages: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z
      .string()
      .describe(
        'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
      ),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .describe(
        'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
      ),
    schedule_value: z
      .string()
      .describe(
        'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .default('group')
      .describe(
        'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
      ),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
      ),
    script: z
      .string()
      .optional()
      .describe(
        'Optional bash script to run before waking the agent. Script must output JSON on the last line of stdout: { "wakeAgent": boolean, "data"?: any }. If wakeAgent is false, the agent is not called. Test your script with bash -c "..." before scheduling.',
      ),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (
        /[Zz]$/.test(args.schedule_value) ||
        /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      script: args.script || undefined,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter(
            (t: { groupFolder: string }) => t.groupFolder === groupFolder,
          );

      if (tasks.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const formatted = tasks
        .map(
          (t: {
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return {
        content: [
          { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} pause requested.`,
        },
      ],
    };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} resume requested.`,
        },
      ],
    };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} cancellation requested.`,
        },
      ],
    };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .optional()
      .describe('New schedule type'),
    schedule_value: z
      .string()
      .optional()
      .describe('New schedule value (see schedule_task for format)'),
    script: z
      .string()
      .optional()
      .describe(
        'New script for the task. Set to empty string to remove the script.',
      ),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (
      args.schedule_type === 'cron' ||
      (!args.schedule_type && args.schedule_value)
    ) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid cron: "${args.schedule_value}".`,
              },
            ],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.script !== undefined) data.script = args.script;
    if (args.schedule_type !== undefined)
      data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined)
      data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} update requested.`,
        },
      ],
    };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z
      .string()
      .describe(
        'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
      ),
    name: z.string().describe('Display name for the group'),
    folder: z
      .string()
      .describe(
        'Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")',
      ),
    trigger: z.string().describe('Trigger word (e.g., "@Breadbrich Engels")'),
    requiresTrigger: z
      .boolean()
      .optional()
      .describe(
        'Whether messages must start with the trigger word. Default: false (respond to all messages). Set to true for busy groups with many participants where you only want the agent to respond when explicitly mentioned.',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      requiresTrigger: args.requiresTrigger ?? false,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
        },
      ],
    };
  },
);

// --- Tour management tools ---

server.tool(
  'create_tour_slot',
  'Create a custom tour slot for a specific date and time. Use when someone asks to schedule a tour on a particular day, or to add a special tour tied to an event.',
  {
    slot_date: z.string().describe('Tour date in YYYY-MM-DD format'),
    slot_time: z.string().optional().default('14:00').describe('Tour time in HH:MM format (default 14:00)'),
    max_capacity: z.number().optional().default(10).describe('Maximum number of guests'),
    slot_type: z.enum(['regular', 'special']).optional().default('regular').describe('regular for weekly tours, special for event-linked tours'),
    event_id: z.string().optional().describe('UUID of a linked event (makes slot_type special)'),
    notes: z.string().optional().describe('Optional notes about this tour slot'),
  },
  async (args) => {
    const data = {
      type: 'create_tour_slot',
      slot_date: args.slot_date,
      slot_time: args.slot_time,
      max_capacity: args.max_capacity,
      slot_type: args.event_id ? 'special' : args.slot_type,
      event_id: args.event_id || null,
      notes: args.notes || null,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Tour slot created for ${args.slot_date} at ${args.slot_time}. Capacity: ${args.max_capacity} guests.` }] };
  },
);

server.tool(
  'generate_weekly_tour_slots',
  'Generate recurring tour slots for the next 4 weeks on Fridays and Mondays at 2:00 PM. Idempotent -- skips dates that already have slots. Use when asked to set up the tour schedule or refresh upcoming slots.',
  {},
  async () => {
    const data = {
      type: 'generate_weekly_tour_slots',
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: 'Generating weekly tour slots for the next 4 weeks (Fridays and Mondays at 2:00 PM). Existing slots will not be duplicated.' }] };
  },
);

server.tool(
  'claim_tour_shift',
  'Assign a guide to a tour slot. Use when someone volunteers to lead a tour. Creates the user if they do not already exist in the system.',
  {
    tour_slot_id: z.string().describe('UUID of the tour slot'),
    guide_name: z.string().describe('Name of the guide claiming the shift'),
    shift_type: z.enum(['lead']).optional().default('lead').describe('Shift role (currently only lead)'),
  },
  async (args) => {
    const data = {
      type: 'claim_tour_shift',
      tour_slot_id: args.tour_slot_id,
      guide_name: args.guide_name,
      shift_type: args.shift_type,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `${args.guide_name} has been assigned as tour guide for slot ${args.tour_slot_id}.` }] };
  },
);

server.tool(
  'request_tour',
  'Log a tour request from a visitor. Use when someone asks to visit the organization or requests a tour. Captures contact info and group size. Requests are informational -- no approval workflow.',
  {
    tour_slot_id: z.string().describe('UUID of the tour slot the request is for'),
    requester_name: z.string().describe('Name of the person requesting the tour'),
    group_size: z.number().optional().default(1).describe('Number of people in the group'),
    requester_email: z.string().optional().describe('Contact email'),
    requester_phone: z.string().optional().describe('Contact phone number'),
    preferred_date: z.string().optional().describe('Visitor preferred date if different from slot (YYYY-MM-DD)'),
    notes: z.string().optional().describe('Special requests or additional context'),
  },
  async (args) => {
    const data = {
      type: 'request_tour',
      tour_slot_id: args.tour_slot_id,
      requester_name: args.requester_name,
      group_size: args.group_size,
      requester_email: args.requester_email || null,
      requester_phone: args.requester_phone || null,
      preferred_date: args.preferred_date || null,
      notes: args.notes || null,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Tour request logged for ${args.requester_name} (group of ${args.group_size}). Status: pending.` }] };
  },
);

// --- Tour read tools ---

interface ToursSnapshotShift {
  id: string;
  user_id: string;
  user_name: string;
  shift_type: string;
}

interface ToursSnapshotRequest {
  id: string;
  requester_name: string;
  requester_email: string | null;
  requester_phone: string | null;
  group_size: number;
  preferred_date: string | null;
  notes: string | null;
  status: string;
  created_at: string;
}

interface ToursSnapshotSlot {
  id: string;
  event_id: string | null;
  event_title: string | null;
  slot_date: string;
  slot_time: string;
  slot_type: string;
  max_capacity: number;
  notes: string | null;
  shifts: ToursSnapshotShift[];
  requests: ToursSnapshotRequest[];
  confirmed_guests: number;
}

interface ToursSnapshotPotential {
  event_id: string;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string;
  location: string | null;
}

interface ToursSnapshot {
  upcoming: ToursSnapshotSlot[];
  past: ToursSnapshotSlot[];
  potential: ToursSnapshotPotential[];
}

function readToursSnapshot(): ToursSnapshot | null {
  const toursFile = path.join(IPC_DIR, 'current_tours.json');
  if (!fs.existsSync(toursFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(toursFile, 'utf-8')) as ToursSnapshot;
  } catch {
    return null;
  }
}

function renderSlotSummary(slot: ToursSnapshotSlot): string {
  const dow = new Date(slot.slot_date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' });
  const [hh, mm] = slot.slot_time.split(':');
  const h = parseInt(hh, 10);
  const timeLabel = `${((h + 11) % 12) + 1}:${mm}${h >= 12 ? ' PM' : ' AM'}`;
  const guides = slot.shifts.length > 0
    ? slot.shifts.map((s) => s.user_name).join(', ')
    : 'no guides';
  const confirmedCount = slot.requests.filter((r) => r.status === 'confirmed').length;
  const pendingCount = slot.requests.filter((r) => r.status === 'pending').length;
  const badge = slot.slot_type === 'special' ? ' [Special]' : '';
  const event = slot.event_title ? ` (during "${slot.event_title}")` : '';
  return `- [${slot.id}] ${dow} ${slot.slot_date} ${timeLabel}${badge}${event}\n`
    + `    Guides: ${guides}\n`
    + `    Capacity: ${slot.confirmed_guests}/${slot.max_capacity} confirmed guests`
    + (pendingCount > 0 ? ` (+${pendingCount} pending)` : '')
    + (confirmedCount === 0 && pendingCount === 0 ? ' — no requests' : '');
}

server.tool(
  'list_tour_slots',
  'List tour slots from the live dashboard snapshot. Use when someone asks what tours are coming up, what is scheduled, or wants to see past tours. Returns slot IDs so you can pair with get_tour_slot, claim_tour_shift, release_tour_shift, or request_tour.',
  {
    filter: z.enum(['upcoming', 'past', 'all']).optional().default('upcoming').describe('Which slots to return (default upcoming).'),
  },
  async (args) => {
    const snapshot = readToursSnapshot();
    if (!snapshot) {
      return { content: [{ type: 'text' as const, text: 'Tour data not available yet.' }] };
    }
    const filter = args.filter || 'upcoming';
    const sections: string[] = [];
    if (filter === 'upcoming' || filter === 'all') {
      if (snapshot.upcoming.length === 0) {
        sections.push('Upcoming tours: none scheduled.');
      } else {
        sections.push(`Upcoming tours (${snapshot.upcoming.length}):\n` + snapshot.upcoming.map(renderSlotSummary).join('\n'));
      }
    }
    if (filter === 'past' || filter === 'all') {
      if (snapshot.past.length === 0) {
        sections.push('Past tours (last 30 days): none.');
      } else {
        sections.push(`Past tours (last 30 days):\n` + snapshot.past.map(renderSlotSummary).join('\n'));
      }
    }
    return { content: [{ type: 'text' as const, text: sections.join('\n\n') }] };
  },
);

server.tool(
  'get_tour_slot',
  'Get full detail for one tour slot: date, capacity, assigned guides (with shift IDs), and all requests (with request IDs and status). Use before releasing a shift or confirming/cancelling a request so you have the right IDs.',
  {
    tour_slot_id: z.string().describe('UUID of the tour slot'),
  },
  async (args) => {
    const snapshot = readToursSnapshot();
    if (!snapshot) {
      return { content: [{ type: 'text' as const, text: 'Tour data not available yet.' }] };
    }
    const slot = [...snapshot.upcoming, ...snapshot.past].find((s) => s.id === args.tour_slot_id);
    if (!slot) {
      return { content: [{ type: 'text' as const, text: `Tour slot ${args.tour_slot_id} not found.` }] };
    }
    const guideLines = slot.shifts.length > 0
      ? slot.shifts.map((s) => `    - ${s.user_name} [shift_id: ${s.id}] (${s.shift_type})`).join('\n')
      : '    (none)';
    const requestLines = slot.requests.length > 0
      ? slot.requests.map((r) => {
          const contact = [r.requester_email, r.requester_phone].filter(Boolean).join(', ');
          const contactStr = contact ? ` — ${contact}` : '';
          const notesStr = r.notes ? `\n      notes: ${r.notes}` : '';
          return `    - ${r.requester_name} (${r.group_size}) [request_id: ${r.id}] status: ${r.status}${contactStr}${notesStr}`;
        }).join('\n')
      : '    (none)';
    const body = [
      `Tour slot ${slot.id}`,
      `  Date: ${slot.slot_date} ${slot.slot_time}`,
      `  Type: ${slot.slot_type}${slot.event_title ? ` (during "${slot.event_title}")` : ''}`,
      `  Capacity: ${slot.confirmed_guests}/${slot.max_capacity} confirmed guests`,
      slot.notes ? `  Notes: ${slot.notes}` : null,
      `  Guides:\n${guideLines}`,
      `  Requests:\n${requestLines}`,
    ].filter(Boolean).join('\n');
    return { content: [{ type: 'text' as const, text: body }] };
  },
);

server.tool(
  'list_potential_tour_dates',
  'List upcoming calendar events that are NOT yet linked to a tour slot. Use when someone asks about special tour opportunities, or when you want to suggest scheduling a tour during an upcoming event. Pair with create_tour_slot (passing event_id) to schedule one.',
  {},
  async () => {
    const snapshot = readToursSnapshot();
    if (!snapshot) {
      return { content: [{ type: 'text' as const, text: 'Tour data not available yet.' }] };
    }
    if (snapshot.potential.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No upcoming events are currently unlinked from tour slots.' }] };
    }
    const lines = snapshot.potential.map((e) => {
      const loc = e.location ? `\n    Location: ${e.location}` : '';
      const desc = e.description ? `\n    ${e.description}` : '';
      return `- [${e.event_id}] ${e.title}\n    ${e.start_time} → ${e.end_time}${loc}${desc}`;
    }).join('\n\n');
    return { content: [{ type: 'text' as const, text: `Potential tour dates (events without linked slots):\n\n${lines}` }] };
  },
);

server.tool(
  'release_tour_shift',
  'Remove a guide from a tour slot. Use when a guide steps down, swaps, or cancels. Requires the shift_id -- use get_tour_slot first to find it.',
  {
    shift_id: z.string().describe('UUID of the tour_shift to remove'),
  },
  async (args) => {
    const data = {
      type: 'release_tour_shift',
      shift_id: args.shift_id,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Releasing shift ${args.shift_id}.` }] };
  },
);

server.tool(
  'update_tour_request_status',
  'Confirm or cancel a tour request. Use when a coordinator approves a request ("confirm the Smith request") or it is withdrawn ("cancel the Monday request from Alex"). Requires the request_id -- use get_tour_slot first to find it.',
  {
    request_id: z.string().describe('UUID of the tour_request'),
    status: z.enum(['confirmed', 'cancelled', 'pending']).describe('New status for the request'),
  },
  async (args) => {
    const data = {
      type: 'update_tour_request_status',
      request_id: args.request_id,
      status: args.status,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Updating request ${args.request_id} to ${args.status}.` }] };
  },
);

// --- Residency tools (main group only) ---

server.tool(
  'add_room',
  'Create a new room in the residency system. Use when someone asks to add, register, or set up a room.',
  {
    room_number: z.number().int().positive().describe('Room number (must be unique)'),
    room_name: z.string().optional().describe('Human-friendly room name, e.g. "Chapel Room", "Attic Suite"'),
    capacity: z.number().int().positive().default(1).describe('Max occupants the room can hold'),
    notes: z.string().optional().describe('Any notes about the room (amenities, restrictions, etc.)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Residency tools are only available in the main group.' }], isError: true };
    }
    const data = {
      type: 'add_room',
      room_number: args.room_number,
      room_name: args.room_name || null,
      capacity: args.capacity || 1,
      notes: args.notes || null,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Room ${args.room_number}${args.room_name ? ` (${args.room_name})` : ''} created with capacity ${args.capacity || 1}.` }] };
  },
);

server.tool(
  'add_resident',
  'Assign a community member (resident) to a room. Use when someone says a person is moving in, living in, or being assigned to a room. Creates the app_user if the name does not already exist.',
  {
    room_number: z.number().int().positive().describe('The room number to assign the resident to'),
    resident_name: z.string().describe('Full name of the resident (community member)'),
    start_date: z.string().describe('Move-in date in YYYY-MM-DD format'),
    end_date: z.string().optional().describe('Move-out date in YYYY-MM-DD format. Omit for permanent/ongoing residents.'),
    notes: z.string().optional().describe('Notes about the stay'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Residency tools are only available in the main group.' }], isError: true };
    }
    if (args.end_date && args.end_date < args.start_date) {
      return { content: [{ type: 'text' as const, text: 'Error: end date must be on or after start date.' }] };
    }
    const data = {
      type: 'add_occupancy',
      room_number: args.room_number,
      resident_name: args.resident_name,
      is_guest: false,
      start_date: args.start_date,
      end_date: args.end_date || null,
      notes: args.notes || null,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    const duration = args.end_date ? `${args.start_date} to ${args.end_date}` : `${args.start_date} (ongoing)`;
    return { content: [{ type: 'text' as const, text: `${args.resident_name} assigned to room ${args.room_number}: ${duration}.` }] };
  },
);

server.tool(
  'add_guest',
  'Add a guest (non-community-member) to a room. Use when someone mentions a visitor, guest, or temporary occupant staying at the organization.',
  {
    room_number: z.number().int().positive().describe('The room number for the guest'),
    guest_name: z.string().describe('Full name of the guest'),
    start_date: z.string().describe('Check-in date in YYYY-MM-DD format'),
    end_date: z.string().optional().describe('Check-out date in YYYY-MM-DD format. Omit if unknown.'),
    notes: z.string().optional().describe('Notes about the guest or their stay'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Residency tools are only available in the main group.' }], isError: true };
    }
    if (args.end_date && args.end_date < args.start_date) {
      return { content: [{ type: 'text' as const, text: 'Error: end date must be on or after start date.' }] };
    }
    const data = {
      type: 'add_occupancy',
      room_number: args.room_number,
      guest_name: args.guest_name,
      is_guest: true,
      start_date: args.start_date,
      end_date: args.end_date || null,
      notes: args.notes || null,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    const duration = args.end_date ? `${args.start_date} to ${args.end_date}` : `${args.start_date} (open-ended)`;
    return { content: [{ type: 'text' as const, text: `Guest ${args.guest_name} added to room ${args.room_number}: ${duration}.` }] };
  },
);

server.tool(
  'check_room_availability',
  'Check which rooms are available (empty or under capacity) on a given date or date range. Use when someone asks about room availability, open rooms, or where to put someone.',
  {
    date: z.string().describe('Date to check availability for (YYYY-MM-DD). Defaults to today.'),
    end_date: z.string().optional().describe('End of date range to check. If omitted, checks single date.'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Residency tools are only available in the main group.' }], isError: true };
    }
    const data = {
      type: 'check_room_availability',
      date: args.date,
      end_date: args.end_date || null,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Checking room availability for ${args.date}${args.end_date ? ' to ' + args.end_date : ''}. Results will be returned shortly.` }] };
  },
);

server.tool(
  'edit_occupancy',
  'Update the dates or notes on an existing room occupancy. Use when someone asks to change move-in/move-out dates or update notes for a current occupant.',
  {
    resident_or_guest_name: z.string().describe('Name of the occupant whose record to update'),
    room_number: z.number().int().positive().describe('Room number the occupant is in'),
    start_date: z.string().optional().describe('New start date (YYYY-MM-DD)'),
    end_date: z.string().optional().describe('New end date (YYYY-MM-DD). Use "clear" to remove end date (make ongoing).'),
    notes: z.string().optional().describe('Updated notes'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Residency tools are only available in the main group.' }], isError: true };
    }
    if (args.end_date && args.start_date && args.end_date !== 'clear' && args.end_date < args.start_date) {
      return { content: [{ type: 'text' as const, text: 'Error: end date must be on or after start date.' }] };
    }
    const data = {
      type: 'edit_occupancy',
      name: args.resident_or_guest_name,
      room_number: args.room_number,
      start_date: args.start_date || undefined,
      end_date: args.end_date === 'clear' ? null : args.end_date,
      notes: args.notes,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Occupancy record for ${args.resident_or_guest_name} in room ${args.room_number} updated.` }] };
  },
);

server.tool(
  'remove_occupancy',
  'Remove an occupant from a room. Use when someone has moved out, a guest has left, or an assignment needs to be cancelled.',
  {
    resident_or_guest_name: z.string().describe('Name of the occupant to remove'),
    room_number: z.number().int().positive().describe('Room number they are being removed from'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Residency tools are only available in the main group.' }], isError: true };
    }
    const data = {
      type: 'remove_occupancy',
      name: args.resident_or_guest_name,
      room_number: args.room_number,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `${args.resident_or_guest_name} removed from room ${args.room_number}.` }] };
  },
);

// --- Residency request (application) tools ---

server.tool(
  'submit_residency_request',
  'Log a residency application from someone asking to stay at the organization as a resident or a guest. Use when a person expresses interest in moving in, visiting for an extended stay, or applying for a room. Available from any group. Routes the request to the main group for review.',
  {
    requester_name: z.string().describe('Full name of the person requesting residency'),
    request_type: z.enum(['resident', 'guest']).describe('"resident" for long-term community members, "guest" for visitors'),
    requested_start_date: z.string().describe('Requested move-in / check-in date in YYYY-MM-DD format'),
    requested_end_date: z.string().optional().describe('Requested end date in YYYY-MM-DD. Omit for ongoing resident stays.'),
    requester_contact: z.string().optional().describe('Contact info (email, phone, handle) if provided'),
    room_preference: z.string().optional().describe('Preferred room number or name, if mentioned'),
    notes: z.string().optional().describe('Additional context: reason, references, special needs, etc.'),
  },
  async (args) => {
    if (args.requested_end_date && args.requested_end_date < args.requested_start_date) {
      return { content: [{ type: 'text' as const, text: 'Error: end date must be on or after start date.' }], isError: true };
    }
    const data = {
      type: 'submit_residency_request',
      requester_name: args.requester_name,
      request_type: args.request_type,
      requested_start_date: args.requested_start_date,
      requested_end_date: args.requested_end_date || null,
      requester_contact: args.requester_contact || null,
      room_preference: args.room_preference || null,
      notes: args.notes || null,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    const range = args.requested_end_date
      ? `${args.requested_start_date} to ${args.requested_end_date}`
      : `${args.requested_start_date} (ongoing)`;
    return { content: [{ type: 'text' as const, text: `Residency request logged for ${args.requester_name} (${args.request_type}, ${range}). Status: pending review.` }] };
  },
);

server.tool(
  'review_residency_request',
  'Approve or reject a pending residency request. Main group only (enforced). Reviewer role (admin / operations / house tag) is a process guideline defined in rules/residency/requests.md and in this group\'s CLAUDE.md — only make this call when a qualified reviewer has instructed you to do so. The originating chat is notified of the decision.',
  {
    request_id: z.string().describe('The residency request ID (e.g. "rr-...")'),
    decision: z.enum(['approve', 'reject']).describe('"approve" or "reject"'),
    resolution_notes: z.string().optional().describe('Reason for the decision, follow-up steps, or onboarding notes (included in the notification to the requester chat)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Residency request reviews are only available in the main group.' }], isError: true };
    }
    const data = {
      type: 'review_residency_request',
      request_id: args.request_id,
      decision: args.decision,
      resolution_notes: args.resolution_notes || null,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    const pastTense = args.decision === 'approve' ? 'approved' : 'rejected';
    return { content: [{ type: 'text' as const, text: `Residency request ${args.request_id} marked as ${pastTense}. The originating chat will be notified.` }] };
  },
);

server.tool(
  'list_residency_requests',
  'List residency requests, optionally filtered by status. Main group only. Use when a reviewer asks which applications are pending, or wants a history of past decisions.',
  {
    status: z.enum(['pending', 'approved', 'rejected', 'onboarded']).optional().describe('Filter by status. Omit to list all.'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Residency request review tools are only available in the main group.' }], isError: true };
    }
    const data = {
      type: 'list_residency_requests',
      status: args.status || null,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Fetching residency requests${args.status ? ` with status "${args.status}"` : ''}. Results will be returned shortly.` }] };
  },
);

// --- Event tools ---

server.tool(
  'list_events',
  'List upcoming events from the community calendar. Use when someone asks what events are happening, what is coming up, or needs to find an event to assign people to.',
  {
    include_past: z.boolean().optional().describe('Include past events (default false)'),
  },
  async (args) => {
    const eventsFile = path.join(IPC_DIR, 'current_events.json');

    try {
      if (!fs.existsSync(eventsFile)) {
        return {
          content: [{ type: 'text' as const, text: 'No events data available yet.' }],
        };
      }

      const allEvents = JSON.parse(fs.readFileSync(eventsFile, 'utf-8')) as Array<{
        id: string;
        title: string;
        description: string | null;
        start_time: string;
        end_time: string;
        location: string | null;
        assignments: Array<{ id: string; user_name: string; role: string; notes: string | null }>;
      }>;

      const now = new Date().toISOString();
      const upcoming = allEvents.filter(e => e.end_time >= now);
      const past = args.include_past ? allEvents.filter(e => e.end_time < now) : [];
      const events = [...upcoming, ...past];

      if (events.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No events found.' }],
        };
      }

      const formatted = events.map(e => {
        const assignmentList = e.assignments.length > 0
          ? `\n  Assignments: ${e.assignments.map(a => `${a.user_name} (${a.role})`).join(', ')}`
          : '';
        return `- [${e.id}] ${e.title}\n  ${e.start_time} → ${e.end_time}${e.location ? `\n  Location: ${e.location}` : ''}${assignmentList}`;
      }).join('\n\n');

      return {
        content: [{ type: 'text' as const, text: `Events:\n\n${formatted}` }],
      };
    } catch (err) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error reading events: ${err instanceof Error ? err.message : String(err)}`,
        }],
      };
    }
  },
);

server.tool(
  'get_event_assignments',
  'Get the current role assignments for a specific event. Use when someone asks who is assigned, who is hosting, who is doing setup, etc.',
  {
    event_id: z.string().describe('The event ID to look up assignments for'),
  },
  async (args) => {
    const eventsFile = path.join(IPC_DIR, 'current_events.json');

    try {
      if (!fs.existsSync(eventsFile)) {
        return {
          content: [{ type: 'text' as const, text: 'No events data available yet.' }],
        };
      }

      const allEvents = JSON.parse(fs.readFileSync(eventsFile, 'utf-8')) as Array<{
        id: string;
        title: string;
        assignments: Array<{ id: string; user_name: string; role: string; notes: string | null }>;
      }>;

      const event = allEvents.find(e => e.id === args.event_id);
      if (!event) {
        return {
          content: [{ type: 'text' as const, text: `Event ${args.event_id} not found.` }],
        };
      }

      if (event.assignments.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No assignments for "${event.title}" yet.` }],
        };
      }

      const formatted = event.assignments
        .map(a => `- ${a.user_name}: ${a.role}${a.notes ? ` (${a.notes})` : ''} [assignment_id: ${a.id}]`)
        .join('\n');

      return {
        content: [{ type: 'text' as const, text: `Assignments for "${event.title}":\n${formatted}` }],
      };
    } catch (err) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error reading assignments: ${err instanceof Error ? err.message : String(err)}`,
        }],
      };
    }
  },
);

server.tool(
  'assign_event_role',
  'Assign a person to a role for an event. Use when someone says to assign, add, or put a person on an event for a specific duty (host, setup, cleanup, catering, security, other).',
  {
    event_id: z.string().describe('The event ID to assign to'),
    person_name: z.string().describe('Name of the person to assign. Will be matched or created in app_users.'),
    role: z.enum(['host', 'setup', 'cleanup', 'catering', 'security', 'other']).describe('The role for this assignment'),
    notes: z.string().optional().describe('Optional notes about the assignment'),
  },
  async (args) => {
    const data = {
      type: 'assign_event_role',
      event_id: args.event_id,
      person_name: args.person_name,
      role: args.role,
      notes: args.notes || null,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{
        type: 'text' as const,
        text: `Assigning ${args.person_name} as ${args.role} for the event.`,
      }],
    };
  },
);

server.tool(
  'remove_event_assignment',
  'Remove a person from an event assignment. Use when someone asks to unassign or remove a person from an event role.',
  {
    assignment_id: z.string().describe('The assignment ID to remove'),
  },
  async (args) => {
    const data = {
      type: 'remove_event_assignment',
      assignment_id: args.assignment_id,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Removing assignment.' }] };
  },
);

// --- Transcript / meeting summary tools ---

server.tool(
  'save_meeting_summary',
  `Save a processed meeting transcript summary. Use after you have analyzed a transcript and extracted action items, events, people, tasks, and documents. The summary_html should be a self-contained HTML slideshow that summarizes the meeting.

Call this AFTER you have:
1. Analyzed the transcript text
2. Extracted all action items, events, people, tasks, and documents
3. Identified clarification questions for unclear items
4. Generated the HTML slideshow summary

The extracted fields (action_items, extracted_events, etc.) are JSON strings. The summary_html is a complete HTML document with inline CSS for the slideshow.`,
  {
    title: z.string().describe('Meeting title (e.g. "Weekly Standup 2026-04-14")'),
    transcript_text: z.string().describe('The raw transcript text that was processed'),
    summary_html: z.string().describe('Self-contained HTML slideshow summarizing the meeting. Must include inline CSS and JS for slide navigation.'),
    action_items: z.string().describe('JSON array of action items: [{description, assignee, due_date, priority, status}]'),
    extracted_events: z.string().optional().describe('JSON array of new events to create: [{title, date, time, location, description}]'),
    extracted_people: z.string().optional().describe('JSON array of new people mentioned: [{name, role, context}]'),
    extracted_tasks: z.string().optional().describe('JSON array of tasks (new or updates to existing): [{task_id?, title, description, assignee, priority, status}]'),
    extracted_documents: z.string().optional().describe('JSON array of documents to gather: [{title, description, owner, type}]'),
    clarification_questions: z.string().optional().describe('JSON array of questions for unclear items: [{item_type, item_description, questions: string[]}]'),
  },
  async (args) => {
    const summaryId = `mtg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'save_meeting_summary',
      summaryId,
      chatJid: chatJid,
      title: args.title,
      transcript_text: args.transcript_text,
      summary_html: args.summary_html,
      action_items: args.action_items,
      extracted_events: args.extracted_events || null,
      extracted_people: args.extracted_people || null,
      extracted_tasks: args.extracted_tasks || null,
      extracted_documents: args.extracted_documents || null,
      clarification_questions: args.clarification_questions || null,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{
        type: 'text' as const,
        text: `Meeting summary "${args.title}" saved (ID: ${summaryId}). HTML slideshow stored.`,
      }],
    };
  },
);

// --- Transcript task approval tools ---

server.tool(
  'propose_meeting_tasks',
  `Submit action items extracted from a meeting transcript for coordinator approval. Use this INSTEAD of creating TASK-NNN files directly when the items came from a transcript. The coordinator will review each one and approve or reject; approved tasks become real KB tasks automatically.

Call AFTER save_meeting_summary -- pass the summary_id you got back. One call covers the whole batch from a single transcript. Updates to existing tasks, and new people/events extracted from the same transcript, do NOT go through this tool -- use modify_kb_file for those.`,
  {
    summary_id: z
      .string()
      .describe('summary_id returned by save_meeting_summary'),
    tasks: z
      .array(
        z.object({
          title: z
            .string()
            .describe(
              'Short imperative title, e.g. "Email landlord re: lease extension"',
            ),
          description: z
            .string()
            .optional()
            .describe('Fuller context from the transcript'),
          proposed_assignee: z
            .string()
            .optional()
            .describe('KB person name if identified, e.g. "dave"'),
          proposed_due_date: z
            .string()
            .optional()
            .describe('YYYY-MM-DD if mentioned in the transcript'),
          source_quote: z
            .string()
            .optional()
            .describe(
              'Verbatim line from the transcript that justified this task',
            ),
        }),
      )
      .min(1)
      .describe('Array of proposed tasks to send to the coordinator'),
  },
  async (args) => {
    const data = {
      type: 'propose_meeting_tasks',
      summary_id: args.summary_id,
      tasks: args.tasks,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Submitted ${args.tasks.length} proposed task(s) for coordinator approval. The coordinator will see a numbered list with PT-IDs they can approve or reject.`,
        },
      ],
    };
  },
);

server.tool(
  'approve_proposed_tasks',
  `Approve one or more proposed tasks from a meeting transcript. Only call this when the sender is tagged "coordinator" -- the host enforces this and rejects unauthorized callers. Approving creates a real TASK-NNN entry in the KB and notifies the assignee. Self-approval is allowed (the coordinator who submitted the transcript may approve its tasks).

Pass an array of items even when approving just one. Use overrides only when the coordinator explicitly asked to change the title, assignee, or due date.`,
  {
    items: z
      .array(
        z.object({
          proposed_task_id: z
            .string()
            .describe('ID of the proposed_task row, e.g. PT-1714060800000-0'),
          final_title: z
            .string()
            .optional()
            .describe('Override title if coordinator requested a refinement'),
          final_assignee: z
            .string()
            .optional()
            .describe('Override assignee'),
          final_due_date: z
            .string()
            .optional()
            .describe('Override due date (YYYY-MM-DD)'),
        }),
      )
      .min(1)
      .describe('Array of approvals -- one per proposed task'),
  },
  async (args) => {
    const data = {
      type: 'approve_proposed_tasks',
      items: args.items,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Approval submitted for ${args.items.length} proposed task(s). Host will create the TASK-NNN entries.`,
        },
      ],
    };
  },
);

server.tool(
  'reject_proposed_task',
  `Reject a proposed task from a meeting transcript. Only call this when the sender is tagged "coordinator". The proposed task is marked rejected; no KB entry is created. Use one call per rejected task; include a short reason if the coordinator gave one.`,
  {
    proposed_task_id: z.string().describe('ID of the proposed_task row'),
    reason: z
      .string()
      .optional()
      .describe('Short reason coordinator gave (audit trail)'),
  },
  async (args) => {
    const data = {
      type: 'reject_proposed_task',
      proposed_task_id: args.proposed_task_id,
      reason: args.reason || null,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Rejection recorded for ${args.proposed_task_id}.`,
        },
      ],
    };
  },
);

// --- Expense tools ---

server.tool(
  'request_expense',
  'Submit a PROSPECTIVE expense request — use when a user wants approval BEFORE spending money. This is the preferred path. Always prefer this over submit_retrospective_expense.',
  {
    amount_cents: z.number().int().positive().describe('Amount in cents, e.g. 4500 for $45.00'),
    currency: z.string().length(3).optional().default('USD'),
    description: z.string().min(3).describe('What the money is for'),
    category: z.enum(['supplies', 'travel', 'food', 'av', 'cleaning', 'other']).optional(),
    vendor: z.string().optional().describe('Who is being paid'),
    justification: z.string().optional().describe('Why this expense is needed'),
    expected_date: z.string().optional().describe('ISO date (YYYY-MM-DD) when the spend will occur'),
    event_id: z.string().optional().describe('Link to an event if this expense is part of one'),
  },
  async (args) => {
    const data = {
      type: 'expense_request',
      request_type: 'prospective' as const,
      chatJid,
      amount_cents: args.amount_cents,
      currency: args.currency || 'USD',
      description: args.description,
      category: args.category || null,
      vendor: args.vendor || null,
      justification: args.justification || null,
      expected_date: args.expected_date || null,
      event_id: args.event_id || null,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Expense request submitted for approval. I'll notify you once it's reviewed.` }] };
  },
);

server.tool(
  'submit_retrospective_expense',
  'Submit a RETROSPECTIVE expense — money was already spent WITHOUT prior approval. DISCOURAGED path. Before calling, you MUST tell the user that prospective requests are preferred and this should not become a habit. Receipt must be attached at submission.',
  {
    amount_cents: z.number().int().positive().describe('Amount in cents'),
    currency: z.string().length(3).optional().default('USD'),
    description: z.string().min(3),
    category: z.enum(['supplies', 'travel', 'food', 'av', 'cleaning', 'other']).optional(),
    vendor: z.string().optional(),
    justification: z.string().min(3).describe('Required — why was this spent without approval?'),
    incurred_date: z.string().describe('ISO date (YYYY-MM-DD) the spend actually happened'),
    receipt_path: z.string().describe('Receipt must be attached at submission time (KB path or URL)'),
    event_id: z.string().optional(),
  },
  async (args) => {
    const data = {
      type: 'expense_request',
      request_type: 'retrospective' as const,
      chatJid,
      amount_cents: args.amount_cents,
      currency: args.currency || 'USD',
      description: args.description,
      category: args.category || null,
      vendor: args.vendor || null,
      justification: args.justification,
      incurred_date: args.incurred_date,
      receipt_path: args.receipt_path,
      event_id: args.event_id || null,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Retrospective expense submitted. Note: prospective requests are preferred — please loop in the approver before spending next time.` }] };
  },
);

server.tool(
  'approve_expense',
  'Approve an expense as-submitted. Only usable by approvers (coordinator/admin) with authority for the amount tier. The orchestrator enforces tier rules.',
  {
    expense_id: z.string(),
    approver_notes: z.string().optional(),
  },
  async (args) => {
    const data = {
      type: 'expense_decision',
      decision: 'approve' as const,
      expense_id: args.expense_id,
      approver_notes: args.approver_notes || null,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Expense ${args.expense_id} approval submitted.` }] };
  },
);

server.tool(
  'deny_expense',
  'Deny an expense. Requires a reason visible to the requester.',
  {
    expense_id: z.string(),
    approver_notes: z.string().min(3).describe('Reason — visible to requester'),
  },
  async (args) => {
    const data = {
      type: 'expense_decision',
      decision: 'deny' as const,
      expense_id: args.expense_id,
      approver_notes: args.approver_notes,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Expense ${args.expense_id} denial submitted.` }] };
  },
);

server.tool(
  'modify_expense',
  'Approve at a different amount than requested. Use when the expense is reasonable but the amount needs adjustment. Not available for retrospective expenses.',
  {
    expense_id: z.string(),
    approved_amount_cents: z.number().int().positive(),
    approver_notes: z.string().describe('Explain the modification — visible to requester'),
  },
  async (args) => {
    const data = {
      type: 'expense_decision',
      decision: 'modify' as const,
      expense_id: args.expense_id,
      approved_amount_cents: args.approved_amount_cents,
      approver_notes: args.approver_notes,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Expense ${args.expense_id} modification submitted.` }] };
  },
);

server.tool(
  'submit_receipt',
  'Attach a receipt to an approved prospective expense. Transitions status from receipt_pending to receipt_submitted. Only the original requester can submit.',
  {
    expense_id: z.string(),
    receipt_path: z.string().describe('KB path or URL where the receipt is stored'),
    actual_amount_cents: z.number().int().positive().optional().describe('If the final cost differed from approved, provide it here for reconciliation'),
  },
  async (args) => {
    const data = {
      type: 'expense_receipt',
      expense_id: args.expense_id,
      receipt_path: args.receipt_path,
      actual_amount_cents: args.actual_amount_cents || null,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Receipt submitted for expense ${args.expense_id}.` }] };
  },
);

server.tool(
  'process_reimbursement',
  'Mark an expense as reimbursed. Terminal transition. Only usable by finance-tagged members.',
  {
    expense_id: z.string(),
    reimbursement_method: z.enum(['venmo', 'zelle', 'check', 'ach', 'cash']),
  },
  async (args) => {
    const data = {
      type: 'expense_reimburse',
      expense_id: args.expense_id,
      reimbursement_method: args.reimbursement_method,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Reimbursement submitted for expense ${args.expense_id} via ${args.reimbursement_method}.` }] };
  },
);

server.tool(
  'cancel_expense',
  'Requester cancels their own expense before reimbursement. Only works on non-terminal states.',
  {
    expense_id: z.string(),
    reason: z.string().optional(),
  },
  async (args) => {
    const data = {
      type: 'expense_cancel',
      expense_id: args.expense_id,
      reason: args.reason || null,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Cancellation submitted for expense ${args.expense_id}.` }] };
  },
);

// --- Event intake / booking workflow ---
// See rules/events/intake.md for the lifecycle and authorization rules.

server.tool(
  'submit_event_intake',
  'Submit a host-side event intake. Use after the host has answered the required public-form fields (host name, contact, event name, type, date, headcount, preferred space). Optional answers can be passed via the answers map (slugged keys → raw text). Open to any group.',
  {
    requester_name: z.string().min(1).describe('Host organization or individual'),
    requester_email: z.string().optional().describe('Host email'),
    requester_phone: z.string().optional().describe('Host phone'),
    event_name: z.string().min(1),
    event_type: z.string().describe('e.g. dinner, talk, launch'),
    event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Primary requested date YYYY-MM-DD'),
    start_time: z.string().regex(/^\d{2}:\d{2}$/).optional().describe('HH:MM'),
    end_time: z.string().regex(/^\d{2}:\d{2}$/).optional().describe('HH:MM'),
    expected_headcount: z.number().int().positive().optional(),
    preferred_space: z.string().optional(),
    answers: z.record(z.string(), z.string()).optional().describe('Full public-form answers, slug → text. Optional fields the host volunteered.'),
  },
  async (args) => {
    const data = {
      type: 'event_intake_submitted',
      ...args,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Intake submitted. The booking ID will be confirmed once ops picks it up.` }] };
  },
);

server.tool(
  'record_internal_intake',
  'Record internal pricing and/or staffing for an existing event booking. Restricted to main group operations/coordinator. Status stays as inquiry — does NOT transition. Use this to fill Section 1 (pricing) and Section 2 (staffing) of the internal intake form.',
  {
    booking_id: z.string().regex(/^EVT-\d+$/).describe('Booking code, e.g. EVT-014'),
    pricing: z.object({
      base_venue_fee: z.number().nonnegative().optional(),
      portfolio_discount: z.boolean().optional(),
      av_line_item: z.number().nonnegative().optional(),
      cleaning_fee: z.number().nonnegative().optional(),
      catering_passthrough: z.number().optional(),
      damage_deposit: z.number().nonnegative().optional(),
      total_quote: z.number().positive().optional(),
      deposit_pct: z.number().min(0).max(100).optional(),
      final_payment_due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).optional(),
    staffing: z.object({
      on_site_lead: z.string().optional().describe('Organization team member name'),
      greeter: z.string().optional(),
      bar_kitchen: z.string().optional(),
      cleaner: z.string().optional(),
      outside_vendors: z.string().optional().describe('Free-form: names, roles, contacts'),
    }).optional(),
    intake_owner: z.string().optional().describe('KB person name owning this booking'),
    intake_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'record_internal_intake is restricted to the main group.' }], isError: true };
    }
    const data = {
      type: 'event_internal_intake_recorded',
      ...args,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Internal intake update queued for ${args.booking_id}.` }] };
  },
);

server.tool(
  'request_proposal_approval',
  'Open an admin sign-off request for transitioning a booking to proposal_sent. Required before transition_event_booking can move it. Pricing fields (total_quote, deposit_pct, final_payment_due) must already be set. Restricted to main group operations/coordinator.',
  {
    booking_id: z.string().regex(/^EVT-\d+$/),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'request_proposal_approval is restricted to the main group.' }], isError: true };
    }
    const data = {
      type: 'event_proposal_approval_requested',
      booking_id: args.booking_id,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Proposal approval requested for ${args.booking_id}. Admins will be pinged.` }] };
  },
);

server.tool(
  'decide_proposal_approval',
  'Approve or reject a pending proposal-approval request. Restricted to admin tag in main group. After approve, ops can call transition_event_booking to move the booking to proposal_sent.',
  {
    booking_id: z.string().regex(/^EVT-\d+$/),
    decision: z.enum(['approved', 'rejected']),
    notes: z.string().optional(),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'decide_proposal_approval is restricted to the main group.' }], isError: true };
    }
    const data = {
      type: 'event_proposal_decided',
      booking_id: args.booking_id,
      decision: args.decision,
      notes: args.notes,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Decision (${args.decision}) recorded for ${args.booking_id}.` }] };
  },
);

server.tool(
  'transition_event_booking',
  'Move a booking to the next lifecycle state (proposal_sent, contract_out, confirmed, complete, cancelled). The host validates required fields; will refuse illegal moves. Restricted to main group operations/coordinator. For proposal_sent: an approved proposal_approvals row must exist (use request_proposal_approval first).',
  {
    booking_id: z.string().regex(/^EVT-\d+$/),
    new_status: z.enum(['proposal_sent', 'contract_out', 'confirmed', 'complete', 'cancelled']),
    contract_signed_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Required for confirmed'),
    deposit_paid_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Required for confirmed'),
    cancellation_reason: z.string().optional().describe('Required for cancelled'),
    post_event_state: z.string().optional().describe('Required for complete — short note on cleanup state'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'transition_event_booking is restricted to the main group.' }], isError: true };
    }
    const data = {
      type: 'event_booking_transitioned',
      ...args,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Transition request for ${args.booking_id} → ${args.new_status} sent.` }] };
  },
);

server.tool(
  'list_event_bookings',
  'List event bookings, optionally filtered by status or event date range. Returns id, host, event_date, status, total_quote. Reads a snapshot file the host writes; data may lag a few seconds behind transitions. Restricted to main group.',
  {
    status: z.enum(['inquiry', 'proposal_sent', 'contract_out', 'confirmed', 'complete', 'cancelled']).optional(),
    from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'list_event_bookings is restricted to the main group.' }], isError: true };
    }
    const snapshotPath = path.join(IPC_DIR, 'event_bookings_snapshot.json');
    if (!fs.existsSync(snapshotPath)) {
      return { content: [{ type: 'text' as const, text: 'No bookings snapshot available yet.' }] };
    }
    type Row = {
      id: string;
      requester_name: string;
      event_name: string | null;
      event_date: string | null;
      status: string;
      total_quote: number | null;
    };
    let rows: Row[] = [];
    try {
      rows = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8')) as Row[];
    } catch {
      return { content: [{ type: 'text' as const, text: 'Bookings snapshot is unreadable.' }], isError: true };
    }
    if (args.status) rows = rows.filter((r) => r.status === args.status);
    if (args.from_date) rows = rows.filter((r) => r.event_date && r.event_date >= args.from_date!);
    if (args.to_date) rows = rows.filter((r) => r.event_date && r.event_date <= args.to_date!);
    if (rows.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No bookings match.' }] };
    }
    const formatted = rows
      .map((r) => `- ${r.id} | ${r.requester_name} | ${r.event_name ?? '?'} | ${r.event_date ?? 'TBD'} | ${r.status} | ${r.total_quote != null ? `$${r.total_quote}` : 'no quote'}`)
      .join('\n');
    return { content: [{ type: 'text' as const, text: `Bookings:\n${formatted}` }] };
  },
);

server.tool(
  'add_kb_user',
  'Create a new KB-UI dashboard user with a generated password and DM the credentials to a target Telegram chat. PRIVILEGED: requires caller to be in an admin DM (is_main=1 group with admin sender). Password is generated server-side and never appears in the response — it is only sent via the DM. Returns status only.',
  {
    username: z
      .string()
      .describe('Lowercase username for KB UI auth (e.g. "kai"). Must match /^[a-z][a-z0-9_-]{0,31}$/.'),
    target_telegram_jid: z
      .string()
      .describe('Telegram JID to DM the credentials to (format: "tg:<chat_id>", e.g. "tg:459838633").'),
  },
  async (args) => {
    const data = {
      type: 'add_kb_user',
      username: args.username,
      target_telegram_jid: args.target_telegram_jid,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MESSAGES_DIR, data);
    return {
      content: [
        {
          type: 'text' as const,
          text: `KB user creation queued for ${args.username}; credentials will be DM'd to ${args.target_telegram_jid}. Will be rejected by the orchestrator if caller is not an admin in an admin DM.`,
        },
      ],
    };
  },
);

server.tool(
  'modify_group_claude_md',
  'Rewrite another group\'s CLAUDE.md (per-group memory file). PRIVILEGED: requires caller to be in an admin DM (is_main=1 group with admin sender). The write is silent — no notification to the target group\'s members — and audited (kb_audit_log row inserted). Full-replace, not patch: pass the entire new file contents. Use sparingly; this changes how the target group\'s the personal assistant behaves.',
  {
    target_folder: z
      .string()
      .describe('Group folder name to modify (e.g. "telegram_emma", "slack_main"). Must pass isValidGroupFolder validation — no slashes, no path traversal.'),
    new_content: z
      .string()
      .describe('Full new contents of the target CLAUDE.md, in markdown. Replaces the existing file entirely. Hard cap of 200 KB.'),
    summary: z
      .string()
      .optional()
      .describe('Short human-readable description of the change for the audit log (e.g. "Add residency reminder cadence"). Optional but recommended.'),
  },
  async (args) => {
    const data = {
      type: 'modify_group_claude_md',
      target_folder: args.target_folder,
      new_content: args.new_content,
      summary: args.summary,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MESSAGES_DIR, data);
    return {
      content: [
        {
          type: 'text' as const,
          text: `CLAUDE.md modification queued for ${args.target_folder}. Will be rejected by the orchestrator if caller is not an admin in an admin DM, or if the target_folder is invalid, or if new_content exceeds 200 KB.`,
        },
      ],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
