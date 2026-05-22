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
  'dm_user',
  "Send a direct message to an allowlisted Discord member without needing their numeric ID. " +
    "Accepts any of: KB slug ('josh-tbs'), Discord ID ('511575159929438224'), " +
    "Discord username ('theblockchainsocialist'), display name ('Josh | TBS'), " +
    "or the title from their KB people file ('Josh'). " +
    "Resolution is restricted to people already in the KB / user_identities — " +
    "the bot will refuse to DM users it doesn't already know. " +
    "On failure (ambiguous match, not found, recipient has DMs disabled, etc.) " +
    "an error is posted back in the current chat. " +
    "Long messages are auto-split at the Discord 2000-char limit.",
  {
    target: z
      .string()
      .describe(
        "Recipient — slug, Discord ID, username, display name, or title. " +
          "Use a slug or ID when the display name is ambiguous.",
      ),
    text: z.string().describe('Message body to send.'),
  },
  async (args) => {
    const data = {
      type: 'dm_user',
      target: args.target,
      text: args.text,
      sourceJid: chatJid,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return {
      content: [
        {
          type: 'text' as const,
          text: `DM to "${args.target}" queued. If it fails (ambiguous, unknown, blocked), you'll see an error message in this chat.`,
        },
      ],
    };
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
      .describe('Short human-readable description of the change for the audit log (e.g. "Update reminder cadence"). Optional but recommended.'),
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
