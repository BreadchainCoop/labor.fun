import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach } from 'vitest';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import {
  _initTestDatabase,
  createMeetingSummary,
  createProposedTasksBatch,
  createTask,
  getAllTasks,
  getProposedTask,
  getProposedTasksBySummary,
  getRegisteredGroup,
  getTaskById,
  setRegisteredGroup,
  storeChatMetadata,
} from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

function writeSenderContext(
  sourceGroup: string,
  ctx: {
    user_id: string;
    display_name?: string;
    tags?: string[];
  },
): void {
  const inputDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'input');
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(
    path.join(inputDir, 'sender_context.json'),
    JSON.stringify({
      user_id: ctx.user_id,
      display_name: ctx.display_name ?? ctx.user_id,
      tags: ctx.tags ?? [],
    }),
  );
}

function clearSenderContext(sourceGroup: string): void {
  const ctxPath = path.join(
    DATA_DIR,
    'ipc',
    sourceGroup,
    'input',
    'sender_context.json',
  );
  if (fs.existsSync(ctxPath)) fs.unlinkSync(ctxPath);
}

// Set up registered groups used across tests
const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Breadbrich Engels',
  added_at: '2024-01-01T00:00:00.000Z',
};

const THIRD_GROUP: RegisteredGroup = {
  name: 'Third',
  folder: 'third-group',
  trigger: '@Breadbrich Engels',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
    'third@g.us': THIRD_GROUP,
  };

  // Populate DB as well
  setRegisteredGroup('main@g.us', MAIN_GROUP);
  setRegisteredGroup('other@g.us', OTHER_GROUP);
  setRegisteredGroup('third@g.us', THIRD_GROUP);

  deps = {
    sendMessage: async () => {},
    canDeliver: () => true,
    deleteMessage: async () => {},
    editMessage: async () => {},
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
      setRegisteredGroup(jid, group);
      // Mock the fs.mkdirSync that registerGroup does
    },
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
  };
});

// --- schedule_task authorization ---

describe('schedule_task authorization', () => {
  it('main group can schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'do something',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // Verify task was created in DB for the other group
    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group can schedule for itself', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'self task',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group cannot schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'unauthorized',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'main@g.us',
      },
      'other-group',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });

  it('rejects schedule_task for unregistered target JID', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no target',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'unknown@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });
});

// --- pause_task authorization ---

describe('pause_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-main',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'main task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'task-other',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'other task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main group can pause any task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group can pause its own task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group cannot pause another groups task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-main' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-main')!.status).toBe('active');
  });
});

// --- resume_task authorization ---

describe('resume_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-paused',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'paused task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'paused',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main group can resume any task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group can resume its own task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group cannot resume another groups task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'third-group',
      false,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('paused');
  });
});

// --- cancel_task authorization ---

describe('cancel_task authorization', () => {
  it('main group can cancel any task', async () => {
    createTask({
      id: 'task-to-cancel',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'cancel me',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-to-cancel' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-to-cancel')).toBeUndefined();
  });

  it('non-main group can cancel its own task', async () => {
    createTask({
      id: 'task-own',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'my task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-own' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-own')).toBeUndefined();
  });

  it('non-main group cannot cancel another groups task', async () => {
    createTask({
      id: 'task-foreign',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'not yours',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-foreign' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-foreign')).toBeDefined();
  });
});

// --- register_group authorization ---

describe('register_group authorization', () => {
  it('non-main group cannot register a group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Breadbrich Engels',
      },
      'other-group',
      false,
      deps,
    );

    // registeredGroups should not have changed
    expect(groups['new@g.us']).toBeUndefined();
  });

  it('main group cannot register with unsafe folder path', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: '../../outside',
        trigger: '@Breadbrich Engels',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(groups['new@g.us']).toBeUndefined();
  });
});

// --- refresh_groups authorization ---

describe('refresh_groups authorization', () => {
  it('non-main group cannot trigger refresh', async () => {
    // This should be silently blocked (no crash, no effect)
    await processTaskIpc(
      { type: 'refresh_groups' },
      'other-group',
      false,
      deps,
    );
    // If we got here without error, the auth gate worked
  });
});

// --- IPC message authorization ---
// Tests the authorization pattern from startIpcWatcher (ipc.ts).
// The logic: isMain || (targetGroup && targetGroup.folder === sourceGroup)

describe('IPC message authorization', () => {
  // Replicate the exact check from the IPC watcher
  function isMessageAuthorized(
    sourceGroup: string,
    isMain: boolean,
    targetChatJid: string,
    registeredGroups: Record<string, RegisteredGroup>,
  ): boolean {
    const targetGroup = registeredGroups[targetChatJid];
    return isMain || (!!targetGroup && targetGroup.folder === sourceGroup);
  }

  it('main group can send to any group', () => {
    expect(
      isMessageAuthorized('whatsapp_main', true, 'other@g.us', groups),
    ).toBe(true);
    expect(
      isMessageAuthorized('whatsapp_main', true, 'third@g.us', groups),
    ).toBe(true);
  });

  it('non-main group can send to its own chat', () => {
    expect(
      isMessageAuthorized('other-group', false, 'other@g.us', groups),
    ).toBe(true);
  });

  it('non-main group cannot send to another groups chat', () => {
    expect(isMessageAuthorized('other-group', false, 'main@g.us', groups)).toBe(
      false,
    );
    expect(
      isMessageAuthorized('other-group', false, 'third@g.us', groups),
    ).toBe(false);
  });

  it('non-main group cannot send to unregistered JID', () => {
    expect(
      isMessageAuthorized('other-group', false, 'unknown@g.us', groups),
    ).toBe(false);
  });

  it('main group can send to unregistered JID', () => {
    // Main is always authorized regardless of target
    expect(
      isMessageAuthorized('whatsapp_main', true, 'unknown@g.us', groups),
    ).toBe(true);
  });
});

// --- schedule_task with cron and interval types ---

describe('schedule_task schedule types', () => {
  it('creates task with cron schedule and computes next_run', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'cron task',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *', // every day at 9am
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('cron');
    expect(tasks[0].next_run).toBeTruthy();
    // next_run should be a valid ISO date in the future
    expect(new Date(tasks[0].next_run!).getTime()).toBeGreaterThan(
      Date.now() - 60000,
    );
  });

  it('rejects invalid cron expression', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad cron',
        schedule_type: 'cron',
        schedule_value: 'not a cron',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('creates task with interval schedule', async () => {
    const before = Date.now();

    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'interval task',
        schedule_type: 'interval',
        schedule_value: '3600000', // 1 hour
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('interval');
    // next_run should be ~1 hour from now
    const nextRun = new Date(tasks[0].next_run!).getTime();
    expect(nextRun).toBeGreaterThanOrEqual(before + 3600000 - 1000);
    expect(nextRun).toBeLessThanOrEqual(Date.now() + 3600000 + 1000);
  });

  it('rejects invalid interval (non-numeric)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad interval',
        schedule_type: 'interval',
        schedule_value: 'abc',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid interval (zero)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'zero interval',
        schedule_type: 'interval',
        schedule_value: '0',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid once timestamp', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad once',
        schedule_type: 'once',
        schedule_value: 'not-a-date',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });
});

// --- context_mode defaulting ---

describe('schedule_task context_mode', () => {
  it('accepts context_mode=group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'group context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'group',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('group');
  });

  it('accepts context_mode=isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'isolated context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'isolated',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults invalid context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'bogus' as any,
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults missing context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no context mode',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });
});

// --- register_group success path ---

describe('register_group success', () => {
  it('main group can register a new group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Breadbrich Engels',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // Verify group was registered in DB
    const group = getRegisteredGroup('new@g.us');
    expect(group).toBeDefined();
    expect(group!.name).toBe('New Group');
    expect(group!.folder).toBe('new-group');
    expect(group!.trigger).toBe('@Breadbrich Engels');
  });

  it('register_group rejects request with missing fields', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'partial@g.us',
        name: 'Partial',
        // missing folder and trigger
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('partial@g.us')).toBeUndefined();
  });
});

// --- transcript task approval workflow ---

describe('transcript task approval IPC handlers', () => {
  let sent: Array<{ jid: string; text: string }>;

  // A meeting_summary owned by 'other-group'. Used across most tests.
  const summaryId = 'mtg-test-001';

  beforeEach(() => {
    sent = [];
    deps.sendMessage = async (jid: string, text: string) => {
      sent.push({ jid, text });
    };
    storeChatMetadata('main@g.us', '2026-04-23T00:00:00.000Z');
    storeChatMetadata('other@g.us', '2026-04-23T00:00:00.000Z');
    storeChatMetadata('third@g.us', '2026-04-23T00:00:00.000Z');

    createMeetingSummary({
      id: summaryId,
      chat_jid: 'other@g.us',
      group_folder: 'other-group',
      title: 'Standup 2026-04-25',
      transcript_text: 'Alex: we should email the landlord. Dave: I will.',
      summary_html: '<html></html>',
      action_items: '[]',
      extracted_events: null,
      extracted_people: null,
      extracted_tasks: null,
      extracted_documents: null,
      clarification_questions: null,
      status: 'completed',
    });

    // Clean up sender_context files from previous tests
    for (const group of ['other-group', 'whatsapp_main', 'third-group']) {
      clearSenderContext(group);
    }
  });

  it('propose_meeting_tasks rejects when summary belongs to a different group', async () => {
    // 'third-group' tries to attach proposed tasks to other-group's summary
    await processTaskIpc(
      {
        type: 'propose_meeting_tasks',
        summary_id: summaryId,
        tasks: [{ title: 'spoof task' }],
      },
      'third-group',
      false,
      deps,
    );

    expect(getProposedTasksBySummary(summaryId)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('propose_meeting_tasks creates rows and notifies main group', async () => {
    writeSenderContext('other-group', {
      user_id: 'alex',
      display_name: 'Alex',
      tags: [],
    });

    await processTaskIpc(
      {
        type: 'propose_meeting_tasks',
        summary_id: summaryId,
        tasks: [
          { title: 'Email landlord', proposed_assignee: 'dave' },
          { title: 'Order supplies' },
        ],
      },
      'other-group',
      false,
      deps,
    );

    const rows = getProposedTasksBySummary(summaryId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
    expect(rows[0].requester_user_id).toBe('alex');
    expect(rows[0].group_folder).toBe('other-group');

    expect(sent).toHaveLength(1);
    expect(sent[0].jid).toBe('main@g.us');
    expect(sent[0].text).toContain('Review needed');
    expect(sent[0].text).toContain('Email landlord');
    expect(sent[0].text).toContain(rows[0].id);
  });

  it('approve_proposed_tasks: any allowlisted sender can approve (flat model)', async () => {
    writeSenderContext('whatsapp_main', {
      user_id: 'contributor',
      tags: ['community'],
    });
    createProposedTasksBatch([
      {
        id: 'PT-flat-1',
        summary_id: summaryId,
        chat_jid: 'other@g.us',
        group_folder: 'other-group',
        requester_user_id: 'alex',
        title: 'task',
        description: null,
        proposed_assignee: null,
        proposed_due_date: null,
        source_quote: null,
      },
    ]);

    const tasksDir = path.join(GROUPS_DIR, 'other-group', 'context', 'tasks');
    const before = fs.existsSync(tasksDir)
      ? new Set(fs.readdirSync(tasksDir))
      : new Set<string>();

    try {
      await processTaskIpc(
        {
          type: 'approve_proposed_tasks',
          items: [{ proposed_task_id: 'PT-flat-1' }],
        },
        'whatsapp_main',
        true,
        deps,
      );

      expect(getProposedTask('PT-flat-1')!.status).toBe('created');
      expect(getProposedTask('PT-flat-1')!.resolved_by).toBe('contributor');
    } finally {
      const after = fs.existsSync(tasksDir)
        ? new Set(fs.readdirSync(tasksDir))
        : new Set<string>();
      for (const f of after) {
        if (!before.has(f)) fs.unlinkSync(path.join(tasksDir, f));
      }
    }
  });

  it('approve_proposed_tasks is rejected when sender_context is missing (even in main)', async () => {
    createProposedTasksBatch([
      {
        id: 'PT-nocontext-1',
        summary_id: summaryId,
        chat_jid: 'other@g.us',
        group_folder: 'other-group',
        requester_user_id: 'alex',
        title: 'task',
        description: null,
        proposed_assignee: null,
        proposed_due_date: null,
        source_quote: null,
      },
    ]);

    await processTaskIpc(
      {
        type: 'approve_proposed_tasks',
        items: [{ proposed_task_id: 'PT-nocontext-1' }],
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getProposedTask('PT-nocontext-1')!.status).toBe('pending');
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('allowlisted sender');
  });

  it('approve_proposed_tasks pending → created and writes a TASK-NNN file', async () => {
    writeSenderContext('whatsapp_main', {
      user_id: 'dave',
      display_name: 'Dave',
      tags: ['coordinator'],
    });
    createProposedTasksBatch([
      {
        id: 'PT-ok-1',
        summary_id: summaryId,
        chat_jid: 'other@g.us',
        group_folder: 'other-group',
        requester_user_id: 'alex',
        title: 'Email landlord re: lease',
        description: 'Follow up before end of month',
        proposed_assignee: 'dave',
        proposed_due_date: '2026-05-15',
        source_quote: 'Dave: I will email the landlord',
      },
    ]);

    // Snapshot the tasks dir so we can identify the new file
    const tasksDir = path.join(GROUPS_DIR, 'other-group', 'context', 'tasks');
    const before = fs.existsSync(tasksDir)
      ? new Set(fs.readdirSync(tasksDir))
      : new Set<string>();

    try {
      await processTaskIpc(
        {
          type: 'approve_proposed_tasks',
          items: [{ proposed_task_id: 'PT-ok-1' }],
        },
        'whatsapp_main',
        true,
        deps,
      );

      const row = getProposedTask('PT-ok-1')!;
      expect(row.status).toBe('created');
      expect(row.resolved_by).toBe('dave');
      expect(row.resulting_task_id).toMatch(/^TASK-\d{3}$/);

      // KB file should exist
      const after = new Set(fs.readdirSync(tasksDir));
      const newFiles = [...after].filter((f) => !before.has(f));
      expect(newFiles).toContain(`${row.resulting_task_id}.md`);
      const body = fs.readFileSync(
        path.join(tasksDir, `${row.resulting_task_id}.md`),
        'utf-8',
      );
      // Colons in the title force YAML quoting — verify the escaped form
      expect(body).toContain('title: "Email landlord re: lease"');
      expect(body).toContain('created_by: dave');
      expect(body).toContain('owners: [dave]');

      expect(sent.some((s) => s.text.includes('Approved'))).toBe(true);
    } finally {
      // Clean up generated TASK file so reruns are deterministic
      const after = fs.existsSync(tasksDir)
        ? new Set(fs.readdirSync(tasksDir))
        : new Set<string>();
      for (const f of after) {
        if (!before.has(f)) fs.unlinkSync(path.join(tasksDir, f));
      }
    }
  });

  it('approve_proposed_tasks: admin tag (no coordinator tag) passes', async () => {
    writeSenderContext('whatsapp_main', {
      user_id: 'alice',
      display_name: 'Alice',
      tags: ['admin'],
    });
    createProposedTasksBatch([
      {
        id: 'PT-admin-1',
        summary_id: summaryId,
        chat_jid: 'other@g.us',
        group_folder: 'other-group',
        requester_user_id: 'alex',
        title: 'Admin-only approval test',
        description: null,
        proposed_assignee: null,
        proposed_due_date: null,
        source_quote: null,
      },
    ]);

    const tasksDir = path.join(GROUPS_DIR, 'other-group', 'context', 'tasks');
    const before = fs.existsSync(tasksDir)
      ? new Set(fs.readdirSync(tasksDir))
      : new Set<string>();

    try {
      await processTaskIpc(
        {
          type: 'approve_proposed_tasks',
          items: [{ proposed_task_id: 'PT-admin-1' }],
        },
        'whatsapp_main',
        true,
        deps,
      );

      const row = getProposedTask('PT-admin-1')!;
      expect(row.status).toBe('created');
      expect(row.resolved_by).toBe('alice');
      expect(row.resulting_task_id).toMatch(/^TASK-\d{3}$/);
    } finally {
      const after = fs.existsSync(tasksDir)
        ? new Set(fs.readdirSync(tasksDir))
        : new Set<string>();
      for (const f of after) {
        if (!before.has(f)) fs.unlinkSync(path.join(tasksDir, f));
      }
    }
  });

  it('approve_proposed_tasks: TASK-NNN ids increment across approvals', async () => {
    writeSenderContext('whatsapp_main', {
      user_id: 'dave',
      tags: ['coordinator'],
    });
    createProposedTasksBatch([
      {
        id: 'PT-seq-1',
        summary_id: summaryId,
        chat_jid: 'other@g.us',
        group_folder: 'other-group',
        requester_user_id: 'alex',
        title: 'First',
        description: null,
        proposed_assignee: null,
        proposed_due_date: null,
        source_quote: null,
      },
      {
        id: 'PT-seq-2',
        summary_id: summaryId,
        chat_jid: 'other@g.us',
        group_folder: 'other-group',
        requester_user_id: 'alex',
        title: 'Second',
        description: null,
        proposed_assignee: null,
        proposed_due_date: null,
        source_quote: null,
      },
    ]);

    const tasksDir = path.join(GROUPS_DIR, 'other-group', 'context', 'tasks');
    const before = fs.existsSync(tasksDir)
      ? new Set(fs.readdirSync(tasksDir))
      : new Set<string>();

    try {
      // Two separate approve calls so the second has to look at the result of
      // the first when picking the next TASK-NNN id.
      await processTaskIpc(
        {
          type: 'approve_proposed_tasks',
          items: [{ proposed_task_id: 'PT-seq-1' }],
        },
        'whatsapp_main',
        true,
        deps,
      );
      await processTaskIpc(
        {
          type: 'approve_proposed_tasks',
          items: [{ proposed_task_id: 'PT-seq-2' }],
        },
        'whatsapp_main',
        true,
        deps,
      );

      const id1 = getProposedTask('PT-seq-1')!.resulting_task_id!;
      const id2 = getProposedTask('PT-seq-2')!.resulting_task_id!;

      const num1 = parseInt(id1.replace('TASK-', ''), 10);
      const num2 = parseInt(id2.replace('TASK-', ''), 10);
      expect(num2).toBe(num1 + 1);

      // Both KB files should be on disk
      const after = new Set(fs.readdirSync(tasksDir));
      expect(after.has(`${id1}.md`)).toBe(true);
      expect(after.has(`${id2}.md`)).toBe(true);
    } finally {
      const after = fs.existsSync(tasksDir)
        ? new Set(fs.readdirSync(tasksDir))
        : new Set<string>();
      for (const f of after) {
        if (!before.has(f)) fs.unlinkSync(path.join(tasksDir, f));
      }
    }
  });

  it('reject_proposed_task pending → rejected when coordinator calls it', async () => {
    writeSenderContext('whatsapp_main', {
      user_id: 'dave',
      tags: ['coordinator'],
    });
    createProposedTasksBatch([
      {
        id: 'PT-rej-1',
        summary_id: summaryId,
        chat_jid: 'other@g.us',
        group_folder: 'other-group',
        requester_user_id: 'alex',
        title: 'Useless task',
        description: null,
        proposed_assignee: null,
        proposed_due_date: null,
        source_quote: null,
      },
    ]);

    await processTaskIpc(
      {
        type: 'reject_proposed_task',
        proposed_task_id: 'PT-rej-1',
        reason: 'duplicate',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const row = getProposedTask('PT-rej-1')!;
    expect(row.status).toBe('rejected');
    expect(row.resolved_by).toBe('dave');
    expect(row.rejection_reason).toBe('duplicate');
    expect(sent.some((s) => s.text.includes('Rejected'))).toBe(true);
  });

  it('reject_proposed_task: any allowlisted sender can reject (flat model)', async () => {
    writeSenderContext('whatsapp_main', {
      user_id: 'contributor',
      tags: ['community'],
    });
    createProposedTasksBatch([
      {
        id: 'PT-rej-2',
        summary_id: summaryId,
        chat_jid: 'other@g.us',
        group_folder: 'other-group',
        requester_user_id: 'alex',
        title: 'task',
        description: null,
        proposed_assignee: null,
        proposed_due_date: null,
        source_quote: null,
      },
    ]);

    await processTaskIpc(
      {
        type: 'reject_proposed_task',
        proposed_task_id: 'PT-rej-2',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getProposedTask('PT-rej-2')!.status).toBe('rejected');
    expect(getProposedTask('PT-rej-2')!.resolved_by).toBe('contributor');
    expect(sent.some((s) => s.text.includes('Rejected'))).toBe(true);
  });
});
