/**
 * PM-orchestration loop (issue #31).
 *
 * Periodically (weekly by default) does a cheap deterministic pre-pass over the
 * KB task graph and — only when there's something to act on — wakes the
 * container agent with a structured PM brief. The agent (guided by the
 * `pm-orchestration` skill) optimistically applies re-estimates / plan
 * adjustments and DMs the people on the critical path, then asks them to
 * confirm. No agent run (and no API spend) happens when nothing is
 * blocked/overdue/due-soon.
 *
 * Loop shape mirrors the reminder engine / GitHub sync (interval from config,
 * `loopRunning` + `tickInFlight` guards, `unref`). The agent run reuses the
 * scheduler's `runContainerAgent` + GroupQueue machinery.
 */

import { ChildProcess } from 'child_process';

import {
  ASSISTANT_NAME,
  isPrivilegedGroup,
  MCP_SERVERS,
  PM_DM_COOLDOWN_MS,
  PM_DUE_SOON_DAYS,
  PM_LEAD,
  PM_ORCHESTRATION_INTERVAL_MS,
  PM_ORCHESTRATION_TARGET_GROUP,
  SHARED_KB_GROUP,
} from '../config.js';
import { ContainerOutput, runContainerAgent } from '../container-runner.js';
import { getRecentPmDms, recordPmDm } from '../db.js';
import { GroupQueue } from '../group-queue.js';
import { logger } from '../logger.js';
import {
  buildPmBrief,
  classify,
  dmCandidates,
  isBriefEmpty,
  type DmCandidate,
  type PmTask,
} from '../pm-orchestration.js';
import { RegisteredGroup } from '../types.js';

const DAY_MS = 86_400_000;

export interface PmOrchestrationDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
  loadTasks: () => PmTask[];
  intervalMs?: number;
  now?: () => number;
}

function candidateKey(d: DmCandidate): string {
  return `${d.person} ${d.taskId} ${d.reason}`;
}

function buildPrompt(brief: string): string {
  return [
    'Run the PM orchestration routine. Use the `pm-orchestration` skill for how',
    'to act (optimistically apply updates, then DM the affected people to',
    'confirm; honor the "do NOT re-ping" list; reserve DMs for blockers/overdue).',
    '',
    'Here is the deterministic PM brief for this run:',
    '',
    brief,
  ].join('\n');
}

const DUE_SOON_MS = PM_DUE_SOON_DAYS * DAY_MS;

/**
 * Build a PM run from the current task list: classify, split DM candidates into
 * fresh vs. cooldown-suppressed, and compose the agent prompt + brief. Shared by
 * the scheduled loop and the chat trigger. Does not enqueue or record anything.
 */
export function buildPmRun(
  tasks: PmTask[],
  nowMs: number,
): { prompt: string; fresh: DmCandidate[]; isEmpty: boolean } {
  const c = classify(tasks, nowMs, DUE_SOON_MS);
  const all = dmCandidates(c);
  const recentKeys = new Set(
    getRecentPmDms(new Date(nowMs - PM_DM_COOLDOWN_MS).toISOString()).map((r) =>
      candidateKey({
        person: r.person,
        taskId: r.task_id,
        reason: r.reason as DmCandidate['reason'],
      }),
    ),
  );
  const fresh = all.filter((d) => !recentKeys.has(candidateKey(d)));
  const recentlyNotified = all.filter((d) => recentKeys.has(candidateKey(d)));
  const brief = buildPmBrief(
    c,
    fresh,
    recentlyNotified,
    nowMs,
    PM_LEAD || undefined,
  );
  return { prompt: buildPrompt(brief), fresh, isEmpty: isBriefEmpty(c) };
}

/** Resolve the group whose chat the PM run targets (PM target → shared KB). */
function resolveTargetGroup(
  groups: Record<string, RegisteredGroup>,
): { jid: string; group: RegisteredGroup } | null {
  const wanted = PM_ORCHESTRATION_TARGET_GROUP || SHARED_KB_GROUP;
  const entry = Object.entries(groups).find(([, g]) => g.folder === wanted);
  return entry ? { jid: entry[0], group: entry[1] } : null;
}

/** One PM pass. Returns whether an agent run was enqueued. */
export async function runPmOrchestrationTick(
  deps: PmOrchestrationDeps,
): Promise<{ enqueued: boolean }> {
  const nowMs = (deps.now ?? Date.now)();
  const run = buildPmRun(deps.loadTasks(), nowMs);

  if (run.isEmpty) {
    logger.info('PM: nothing blocked/overdue/due-soon — skipping agent run');
    return { enqueued: false };
  }

  const target = resolveTargetGroup(deps.registeredGroups());
  if (!target) {
    logger.warn(
      { wanted: PM_ORCHESTRATION_TARGET_GROUP || SHARED_KB_GROUP },
      'PM: target group not registered yet — skipping (will retry next tick)',
    );
    return { enqueued: false };
  }

  const { prompt, fresh } = run;
  const { jid, group } = target;
  const isMain = isPrivilegedGroup(group);
  const sessionId = deps.getSessions()[group.folder];

  // Close the container promptly after the run (single-turn, like a scheduled task).
  const CLOSE_DELAY_MS = 10_000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleClose = () => {
    if (closeTimer) return;
    closeTimer = setTimeout(() => deps.queue.closeStdin(jid), CLOSE_DELAY_MS);
  };

  const enqueued = deps.queue.enqueueTask(jid, 'pm-orchestration', async () => {
    try {
      await runContainerAgent(
        group,
        {
          prompt,
          sessionId,
          groupFolder: group.folder,
          chatJid: jid,
          isMain,
          isScheduledTask: true,
          assistantName: ASSISTANT_NAME,
          mcpServers: MCP_SERVERS,
        },
        (proc, containerName) =>
          deps.onProcess(jid, proc, containerName, group.folder),
        async (out: ContainerOutput) => {
          if (out.result) {
            await deps.sendMessage(jid, out.result);
            scheduleClose();
          }
          if (out.status === 'success') {
            deps.queue.notifyIdle(jid);
            scheduleClose();
          }
        },
      );
    } catch (err) {
      logger.error({ err }, 'PM orchestration run failed');
    } finally {
      if (closeTimer) clearTimeout(closeTimer);
    }
  });

  if (!enqueued) {
    // A pm-orchestration run is already queued/running for this group — that
    // run will cover the current state, so don't record (or we'd suppress the
    // next legit follow-up) and don't claim we scheduled one.
    logger.debug('PM: a run is already queued/running — skipping this tick');
    return { enqueued: false };
  }

  // Record the fresh follow-ups so they're suppressed within the cooldown.
  for (const c of fresh) recordPmDm(c.person, c.taskId, c.reason);

  logger.info({ candidates: fresh.length }, 'PM orchestration run enqueued');
  return { enqueued: true };
}

let loopRunning = false;
let loopTimer: NodeJS.Timeout | null = null;
let tickInFlight = false;

export function startPmOrchestration(deps: PmOrchestrationDeps): void {
  if (loopRunning) {
    logger.debug('PM orchestration already running');
    return;
  }
  const interval = deps.intervalMs ?? PM_ORCHESTRATION_INTERVAL_MS;
  if (interval <= 0) {
    logger.info('PM orchestration disabled (interval=0)');
    return;
  }
  loopRunning = true;

  const tick = async () => {
    if (tickInFlight) {
      logger.debug('PM orchestration tick already in flight — skipping');
      return;
    }
    tickInFlight = true;
    try {
      await runPmOrchestrationTick(deps);
    } catch (err) {
      logger.error({ err }, 'PM orchestration tick failed');
    } finally {
      tickInFlight = false;
    }
  };

  logger.info({ intervalMs: interval }, 'PM orchestration loop started');
  void tick();
  loopTimer = setInterval(tick, interval);
  loopTimer.unref?.();
}

export function stopPmOrchestration(): void {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
  loopRunning = false;
  tickInFlight = false;
}

/** @internal - for tests only. */
export function _resetPmLoopForTests(): void {
  stopPmOrchestration();
}
