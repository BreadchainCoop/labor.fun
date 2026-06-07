/**
 * PM orchestration — pure analysis layer (issue #31).
 *
 * Turns the KB task list (GitHub-synced + hand-authored, sharing `upstream`/
 * `downstream` dependency edges and an optional `estimate`) into a structured
 * "PM brief": what's blocked, what's blocking others, what's overdue or due
 * soon, and per-owner load. The brief is fed to the container agent, which
 * (per the pm-orchestration skill) optimistically applies re-estimates / plan
 * adjustments and DMs the people on the critical path, then asks them to
 * confirm.
 *
 * Everything here is pure and deterministic (takes `now` as input) so it can be
 * table-tested without a clock and run cheaply each tick before any LLM spend.
 * No graph object is built — classification reads edges directly off the tasks
 * via a simple id→task lookup.
 */

import { isDoneStatus, parseDeadline } from './reminder-engine.js';

/** A task as the PM layer sees it (superset of the reminder DeadlineItem). */
export interface PmTask {
  id: string;
  title: string;
  deadline?: string;
  owners: string[];
  status?: string;
  estimate?: string;
  /** Ids this task is blocked by (must finish first). */
  upstream: string[];
  /** Ids that depend on this task (this task blocks them). */
  downstream: string[];
  ref?: string;
}

export interface OwnerLoad {
  openCount: number;
  estimateSum: number;
}

export interface PmClassification {
  /** Not done, and at least one upstream dependency is still open. */
  blocked: PmTask[];
  /** Not done, and at least one task that depends on it is still open. */
  blocking: PmTask[];
  /** Not done, deadline already passed. */
  overdue: PmTask[];
  /** Not done, deadline within the due-soon window. */
  dueSoon: PmTask[];
  /** Per-owner open-task count + summed estimate (story points). */
  perOwnerLoad: Map<string, OwnerLoad>;
}

export type DmReason = 'blocking' | 'overdue';

/** A person the agent should follow up with, and why. */
export interface DmCandidate {
  person: string;
  taskId: string;
  reason: DmReason;
}

function numericEstimate(estimate?: string): number {
  if (!estimate) return 0;
  const n = Number(estimate);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Whether a chat message is a request to run the PM orchestration routine.
 * Matches `/pm`, "pm orchestration", or "pm routine" (case-insensitive),
 * after any leading @-mention/trigger. Kept narrow to avoid false positives.
 */
export function isPmCommand(text: string): boolean {
  const t = (text || '').toLowerCase();
  return (
    /(^|\s)\/pm(\b|$)/.test(t) ||
    /\bpm\s+orchestration\b/.test(t) ||
    /\bpm\s+routine\b/.test(t)
  );
}

/**
 * Classify the task list. `nowMs` and `dueSoonMs` are injected so the result is
 * deterministic. Dangling edge ids (pointing at tasks not in the list) are
 * ignored; cycles are harmless (each task is judged independently, no traversal).
 */
export function classify(
  tasks: PmTask[],
  nowMs: number,
  dueSoonMs: number,
): PmClassification {
  const byId = new Map<string, PmTask>();
  for (const t of tasks) byId.set(t.id, t);

  const isOpen = (id: string): boolean => {
    const t = byId.get(id);
    return t ? !isDoneStatus(t.status) : false; // dangling → not counted
  };

  const blocked: PmTask[] = [];
  const blocking: PmTask[] = [];
  const overdue: PmTask[] = [];
  const dueSoon: PmTask[] = [];
  const perOwnerLoad = new Map<string, OwnerLoad>();

  for (const t of tasks) {
    if (isDoneStatus(t.status)) continue;

    // Per-owner load (open tasks only).
    const est = numericEstimate(t.estimate);
    for (const owner of t.owners.length ? t.owners : ['unassigned']) {
      const cur = perOwnerLoad.get(owner) ?? { openCount: 0, estimateSum: 0 };
      cur.openCount += 1;
      cur.estimateSum += est;
      perOwnerLoad.set(owner, cur);
    }

    if (t.upstream.some(isOpen)) blocked.push(t);
    if (t.downstream.some(isOpen)) blocking.push(t);

    if (t.deadline) {
      const dMs = parseDeadline(t.deadline);
      if (!Number.isNaN(dMs)) {
        const delta = dMs - nowMs;
        if (delta <= 0) overdue.push(t);
        else if (delta <= dueSoonMs) dueSoon.push(t);
      }
    }
  }

  return { blocked, blocking, overdue, dueSoon, perOwnerLoad };
}

/** True when there's nothing worth spending an agent run on. */
export function isBriefEmpty(c: PmClassification): boolean {
  return (
    c.blocked.length === 0 &&
    c.blocking.length === 0 &&
    c.overdue.length === 0 &&
    c.dueSoon.length === 0
  );
}

/**
 * The people the agent should DM and why: owners of blocking tasks (they're on
 * the critical path) and owners of overdue tasks. Deduped by (person, task,
 * reason). Routine due-soon items are intentionally NOT personal pings.
 */
export function dmCandidates(c: PmClassification): DmCandidate[] {
  const seen = new Set<string>();
  const out: DmCandidate[] = [];
  const add = (task: PmTask, reason: DmReason) => {
    for (const person of task.owners) {
      const key = `${person} ${task.id} ${reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ person, taskId: task.id, reason });
    }
  };
  for (const t of c.blocking) add(t, 'blocking');
  for (const t of c.overdue) add(t, 'overdue');
  return out;
}

function line(t: PmTask, extra = ''): string {
  const owners = t.owners.length ? t.owners.join(', ') : 'unassigned';
  return `- ${t.id} — ${t.title} (owners: ${owners})${extra}`;
}

/**
 * Render the brief markdown that becomes the agent's prompt context. Includes
 * the classification, the DM candidate list, and a "recently followed up — do
 * not re-ping" list so the agent honors the cooldown.
 */
export function buildPmBrief(
  c: PmClassification,
  candidates: DmCandidate[],
  recentlyNotified: DmCandidate[],
  nowMs: number,
  pmLead?: string,
): string {
  const lines: string[] = [
    `# PM brief — ${new Date(nowMs).toISOString().slice(0, 10)}`,
    '',
  ];

  if (c.blocking.length) {
    lines.push('## Blocking others (on the critical path)', '');
    for (const t of c.blocking) {
      const waiting = t.downstream.join(', ');
      lines.push(line(t, waiting ? ` — blocks: ${waiting}` : ''));
    }
    lines.push('');
  }
  if (c.overdue.length) {
    lines.push('## Overdue', '');
    for (const t of c.overdue) lines.push(line(t, ` — due ${t.deadline}`));
    lines.push('');
  }
  if (c.blocked.length) {
    lines.push('## Blocked (waiting on upstream)', '');
    for (const t of c.blocked) {
      lines.push(line(t, ` — blocked by: ${t.upstream.join(', ')}`));
    }
    lines.push('');
  }
  if (c.dueSoon.length) {
    lines.push('## Due soon', '');
    for (const t of c.dueSoon) lines.push(line(t, ` — due ${t.deadline}`));
    lines.push('');
  }

  // Unassigned but actionable (overdue or blocking with no owner). These have
  // no one to DM — surface them so the agent can find/assign an owner or raise
  // them to the PM lead / channel rather than letting them fall through.
  const unownedSeen = new Set<string>();
  const unowned = [...c.overdue, ...c.blocking].filter((t) => {
    if (t.owners.length > 0 || unownedSeen.has(t.id)) return false;
    unownedSeen.add(t.id);
    return true;
  });
  if (unowned.length) {
    lines.push('## Unassigned — needs an owner (overdue or blocking)', '');
    for (const t of unowned) {
      lines.push(line(t, t.deadline ? ` — due ${t.deadline}` : ' — blocking'));
    }
    lines.push(
      pmLead
        ? `> No owner to DM. Find/assign an owner, or raise these to the PM lead **${pmLead}** and post them in this channel.`
        : '> No owner to DM. Find/assign an owner, or post these in this channel so someone picks them up.',
      '',
    );
  }

  lines.push('## Per-owner load (open tasks / est. points)', '');
  for (const owner of [...c.perOwnerLoad.keys()].sort()) {
    const l = c.perOwnerLoad.get(owner)!;
    lines.push(`- ${owner}: ${l.openCount} open / ${l.estimateSum} pts`);
  }
  lines.push('');

  lines.push(
    '## DM these people (optimistically act, then ask to confirm)',
    '',
  );
  if (candidates.length) {
    for (const d of candidates) {
      lines.push(`- ${d.person} — ${d.reason} on ${d.taskId}`);
    }
  } else {
    lines.push('- (none this run)');
  }
  lines.push('');

  if (recentlyNotified.length) {
    lines.push('## Already followed up recently — do NOT re-ping', '');
    for (const d of recentlyNotified) {
      lines.push(`- ${d.person} — ${d.reason} on ${d.taskId}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
