import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getTaskById } from './db.js';

// What the (mocked) container run reports through the streaming callback.
const run = vi.hoisted(() => ({
  status: 'success' as 'success' | 'error',
  result: null as string | null,
  error: undefined as string | undefined,
  release: undefined as (() => void) | undefined,
}));

vi.mock('./container-runner.js', () => ({
  writeTasksSnapshot: vi.fn(),
  runContainerAgent: vi.fn(
    async (
      _group: unknown,
      _input: unknown,
      _onProcess: unknown,
      onOutput: (o: {
        status: string;
        result: string | null;
        error?: string;
      }) => Promise<void>,
    ) => {
      await onOutput({
        status: run.status,
        result: run.result,
        error: run.error,
      });
      // Like the real runner, the container stays up waiting for more input
      // until the host closes its stdin, or until the ~30.5 min hard timeout.
      await new Promise<void>((resolve) => {
        run.release = resolve;
        setTimeout(resolve, 1_830_000);
      });
      // Streaming mode: the real runner always finishes with result: null.
      return { status: run.status, result: null, error: run.error };
    },
  ),
}));

// runTask mkdirs the group folder; keep that out of the repo.
vi.mock('./group-folder.js', async () => {
  const os = await import('os');
  return { resolveGroupFolderPath: () => os.tmpdir() };
});

import {
  _resetSchedulerLoopForTests,
  startSchedulerLoop,
} from './task-scheduler.js';

const JID = 'tg:-1001234567890';
const FOLDER = 'team';
const TASK_CLOSE_DELAY_MS = 10_000;

function createDueTask(id: string, delivery?: 'channel' | 'silent'): void {
  createTask({
    id,
    group_folder: FOLDER,
    chat_jid: JID,
    prompt: 'post the rotation',
    schedule_type: 'once',
    schedule_value: '2026-09-14T08:00:00',
    context_mode: 'isolated',
    delivery,
    next_run: new Date(Date.now() - 60_000).toISOString(),
    status: 'active',
    created_at: '2026-09-13T00:00:00.000Z',
  });
}

async function runDueTasks(
  sendMessage: (jid: string, text: string) => Promise<void>,
) {
  const queue = {
    enqueueTask: (_jid: string, _id: string, fn: () => Promise<void>) => {
      void fn();
    },
    closeStdin: vi.fn(() => run.release?.()),
    notifyIdle: vi.fn(),
  };
  startSchedulerLoop({
    registeredGroups: () => ({
      [JID]: {
        name: 'Team',
        folder: FOLDER,
        trigger: '@Assistant',
        added_at: '2026-09-01T00:00:00.000Z',
      } as any,
    }),
    getSessions: () => ({}),
    queue: queue as any,
    onProcess: () => {},
    sendMessage,
  });
  // Past the scheduler's close delay, far short of the runner's hard timeout.
  await vi.advanceTimersByTimeAsync(TASK_CLOSE_DELAY_MS + 10);
  return queue;
}

describe('scheduled task result forwarding', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
    run.status = 'success';
    run.result = null;
    run.error = undefined;
    run.release = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('suppresses a usage-limit notice and records the run as an error (2026-09-11)', async () => {
    run.result = "You've hit your limit · resets 10pm (America/New_York)";
    createDueTask('t-limit');
    const sendMessage = vi.fn(async () => {});

    await runDueTasks(sendMessage);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(getTaskById('t-limit')?.last_result).toBe(
      "Error: You've hit your limit · resets 10pm (America/New_York)",
    );
  });

  it('classifies what is left after stripping <internal> blocks', async () => {
    // Anchored pattern: the raw string starts with "<internal>", so this is
    // only suppressed if the guard classifies the stripped text.
    run.result =
      "<internal>checked the rotation file</internal>You've hit your limit · resets 10pm (America/New_York)";
    createDueTask('t-internal-then-limit');
    const sendMessage = vi.fn(async () => {});

    await runDueTasks(sendMessage);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(getTaskById('t-internal-then-limit')?.last_result).toBe(
      "Error: You've hit your limit · resets 10pm (America/New_York)",
    );
  });

  it('still forwards a normal result verbatim', async () => {
    run.result = 'today: Alice on call, Bob on release review';
    createDueTask('t-normal');
    const sendMessage = vi.fn(async () => {});

    await runDueTasks(sendMessage);

    expect(sendMessage).toHaveBeenCalledWith(JID, run.result);
    expect(getTaskById('t-normal')?.last_result).toBe(run.result);
  });

  it('still forwards an internal-only result for the channel layer to strip', async () => {
    run.result = '<internal>not a rotation day, nothing to post</internal>';
    createDueTask('t-internal-only');
    const sendMessage = vi.fn(async () => {});

    await runDueTasks(sendMessage);

    expect(sendMessage).toHaveBeenCalledWith(JID, run.result);
  });

  it('releases the container promptly when the runner itself reports an error', async () => {
    // The container-side classifier turns a limit notice into status:error
    // with no result. Without a close, the task container (and the group's
    // chat, which can't be piped into it) is held until the hard timeout.
    run.status = 'error';
    run.error = "You've hit your limit · resets 10pm (America/New_York)";
    createDueTask('t-runner-error');
    const sendMessage = vi.fn(async () => {});

    const queue = await runDueTasks(sendMessage);

    expect(queue.closeStdin).toHaveBeenCalledWith(JID);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(getTaskById('t-runner-error')?.last_result).toBe(
      "Error: You've hit your limit · resets 10pm (America/New_York)",
    );
  });

  it("records an error-shaped result as an error for a 'silent' task too", async () => {
    // 'silent' already keeps it out of the chat; the guard is what stops it
    // from being recorded as the task's successful result.
    run.result = "You've hit your limit · resets 10pm (America/New_York)";
    createDueTask('t-silent-limit', 'silent');
    const sendMessage = vi.fn(async () => {});

    await runDueTasks(sendMessage);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(getTaskById('t-silent-limit')?.last_result).toBe(
      "Error: You've hit your limit · resets 10pm (America/New_York)",
    );
  });

  it("records a 'silent' task's normal result without posting it", async () => {
    run.result = 'reminder sent to the requester by DM';
    createDueTask('t-silent-normal', 'silent');
    const sendMessage = vi.fn(async () => {});

    await runDueTasks(sendMessage);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(getTaskById('t-silent-normal')?.last_result).toBe(run.result);
  });
});
