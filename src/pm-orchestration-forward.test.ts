import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PM_ORCHESTRATION_TARGET_GROUP, SHARED_KB_GROUP } from './config.js';
import { _initTestDatabase } from './db.js';
import type { PmTask } from './pm-orchestration.js';

// What the (mocked) container run reports through the streaming callback.
const run = vi.hoisted(() => ({
  status: 'success' as 'success' | 'error',
  result: null as string | null,
  error: undefined as string | undefined,
  // The stock runner follows every query, a failed one included, with a
  // { status: 'success', result: null } session-update marker.
  sessionMarker: true,
  release: undefined as (() => void) | undefined,
}));

vi.mock('./container-runner.js', () => ({
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
      if (run.sessionMarker) {
        await onOutput({ status: 'success', result: null });
      }
      // Like the real runner, the container stays up waiting for more input
      // until the host closes its stdin, or until the ~30.5 min hard timeout.
      await new Promise<void>((resolve) => {
        run.release = resolve;
        setTimeout(resolve, 1_830_000);
      });
      // Streaming mode: a clean exit resolves with a bare completion marker;
      // the run's result or error only ever arrives through onOutput.
      return { status: 'success', result: null };
    },
  ),
}));

import { runPmOrchestrationTick } from './integrations/pm-orchestration.js';

const JID = 'tg:-1001234567890';
const CLOSE_DELAY_MS = 10_000;
const NOW = Date.parse('2026-09-14T09:00:00Z');

// An overdue task gives the tick something to act on, so it runs the agent.
const TASKS: PmTask[] = [
  {
    id: 'T1',
    title: 'Publish the release notes',
    owners: ['Alice'],
    status: 'open',
    upstream: [],
    downstream: [],
    deadline: '2026-09-01',
  },
];

async function runPmTick(
  sendMessage: (jid: string, text: string) => Promise<void>,
) {
  const queue = {
    enqueueTask: (_jid: string, _id: string, fn: () => Promise<void>) => {
      void fn();
      return true;
    },
    closeStdin: vi.fn(() => run.release?.()),
    notifyIdle: vi.fn(),
  };
  const tick = await runPmOrchestrationTick({
    registeredGroups: () => ({
      [JID]: {
        name: 'Team',
        folder: PM_ORCHESTRATION_TARGET_GROUP || SHARED_KB_GROUP,
        trigger: '@Assistant',
        added_at: '2026-09-01T00:00:00.000Z',
      } as any,
    }),
    getSessions: () => ({}),
    queue: queue as any,
    onProcess: () => {},
    sendMessage,
    loadTasks: () => TASKS,
    now: () => NOW,
  });
  expect(tick.enqueued).toBe(true);
  // Past the PM run's close delay, far short of the runner's hard timeout.
  await vi.advanceTimersByTimeAsync(CLOSE_DELAY_MS + 10);
  return queue;
}

describe('PM orchestration result forwarding', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.useFakeTimers();
    run.status = 'success';
    run.result = null;
    run.error = undefined;
    run.sessionMarker = true;
    run.release = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not send an error-shaped result, and still closes the container', async () => {
    run.result = "You've hit your limit · resets 10pm (America/New_York)";
    const sendMessage = vi.fn(async () => {});

    const queue = await runPmTick(sendMessage);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(queue.closeStdin).toHaveBeenCalledWith(JID);
  });

  it('classifies what is left after stripping <internal> blocks', async () => {
    // Anchored pattern: the raw string starts with "<internal>", so this is
    // only suppressed if the guard classifies the stripped text.
    run.result =
      "<internal>read the brief</internal>You've hit your limit · resets 10pm (America/New_York)";
    const sendMessage = vi.fn(async () => {});

    await runPmTick(sendMessage);

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('sends a normal result verbatim and closes the container', async () => {
    run.result =
      'Moved the release notes to Friday and asked Alice to confirm.';
    const sendMessage = vi.fn(async () => {});

    const queue = await runPmTick(sendMessage);

    expect(sendMessage).toHaveBeenCalledWith(JID, run.result);
    expect(queue.closeStdin).toHaveBeenCalledWith(JID);
  });

  it("closes the container on a runner error from an agent-customized runner that doesn't emit the session marker", async () => {
    // The one case the close-on-error branch exists for: with the stock
    // runner, the session marker after the error already schedules the close.
    run.sessionMarker = false;
    run.status = 'error';
    run.error = "You've hit your limit · resets 10pm (America/New_York)";
    const sendMessage = vi.fn(async () => {});

    const queue = await runPmTick(sendMessage);

    expect(queue.closeStdin).toHaveBeenCalledWith(JID);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
