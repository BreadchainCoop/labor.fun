/**
 * Operational report — pure analysis + rendering layer (issue #34).
 *
 * Leadership needs a *recurring* readout of operational state rather than
 * asking for it ad-hoc: what's late (by team and by person), how loaded each
 * member is against the hours/points they're meant to work, a soft flag where
 * that load looks unsustainable, and a bottleneck digest. This module turns the
 * KB task graph (the same `PmTask[]` the PM orchestrator uses) plus declared
 * member capacities (src/member-profiles.ts) into that report, then renders it
 * to markdown.
 *
 * It deliberately *reuses* the PM layer's `classify()` (src/pm-orchestration.ts)
 * for the blocked/blocking/overdue/due-soon split — the report is a read-only
 * view over the same analysis the PM loop acts on, so the two never disagree.
 *
 * Design decisions taken for the issue's open questions (see
 * rules/integrations/operational-reports.md for the rationale):
 *
 *  - **Effort estimation**: route (a) — the AI estimate (`estimate`) is taken
 *    optimistically and humans correct it after the fact (consistent with the
 *    PM orchestration philosophy). Load is summed from those estimates.
 *  - **Hours verification**: we have no verified time tracking, so capacity is
 *    *self-declared* on member profiles and every hours/load figure is labelled
 *    "declared, not verified". We never fabricate hours. Overload is only ever a
 *    *soft* flag, and only raised when a member has actually declared a capacity.
 *  - **Audience**: rendering takes an `audience`/`granularity` toggle so the same
 *    report can go to a private leadership channel (full per-person detail) or
 *    be posted co-op-wide (team-level aggregates, gentler framing). The loop
 *    that delivers it (src/integrations/operational-report.ts) chooses where.
 *
 * Everything here is pure and deterministic (takes `nowMs` as input) so it can
 * be table-tested without a clock.
 */

import { isDoneStatus, parseDeadline } from './reminder-engine.js';
import { classify, type PmTask } from './pm-orchestration.js';
import type { MemberCapacity } from './member-profiles.js';

const UNASSIGNED_OWNER = 'unassigned';
const UNASSIGNED_TEAM = 'No team';

export type ReportAudience = 'leaders' | 'coop';

/** Per-member load + declared capacity. `name` matches task `owners` entries. */
export interface MemberLoad {
  name: string;
  team?: string;
  openCount: number;
  /** Summed `estimate` (story points) of the member's open tasks. */
  estimateSum: number;
  overdueCount: number;
  /** Declared (self-reported, unverified) hours/week. */
  expectedHoursPerWeek?: number;
  /** Declared sprint capacity in story points. */
  capacityPoints?: number;
  /** estimateSum / capacityPoints, when capacity is declared. */
  loadRatio?: number;
  /** Soft flag: load looks unsustainable vs the member's *declared* capacity. */
  overloaded: boolean;
  payParityNote?: string;
}

/** Per-team rollup of load + what's late. */
export interface TeamLoad {
  team: string;
  members: string[];
  openCount: number;
  estimateSum: number;
  overdueTasks: PmTask[];
}

export interface OperationalReport {
  generatedAtMs: number;
  totalOpen: number;
  /** Not done, deadline passed. */
  overdue: PmTask[];
  /** Not done, deadline within the due-soon window. */
  dueSoon: PmTask[];
  /** Not done, a downstream task still depends on it (bottlenecks). */
  blocking: PmTask[];
  /** Not done, waiting on an open upstream. */
  blocked: PmTask[];
  /** All members with open load and/or a declared capacity, by load desc. */
  members: MemberLoad[];
  /** Per-team rollup, by team name. */
  teams: TeamLoad[];
  /** The soft-flagged subset of `members`. */
  overloaded: MemberLoad[];
}

export interface BuildReportOptions {
  /**
   * Soft-flag a member as overloaded when their open estimate exceeds
   * declared capacity by this ratio. Default 1.0 (any over-capacity).
   */
  overloadRatio?: number;
}

function ownersOf(t: PmTask): string[] {
  return t.owners.length ? t.owners : [UNASSIGNED_OWNER];
}

/**
 * Build the operational report from the task list + declared capacities.
 * Reuses the PM `classify()` for the dependency/deadline split, then layers on
 * per-member and per-team rollups joined to capacity by display name.
 */
export function buildOperationalReport(
  tasks: PmTask[],
  capacities: MemberCapacity[],
  nowMs: number,
  dueSoonMs: number,
  opts: BuildReportOptions = {},
): OperationalReport {
  const overloadRatio = opts.overloadRatio ?? 1.0;
  const c = classify(tasks, nowMs, dueSoonMs);

  // Capacity lookup keyed by both display name and slug so either resolves.
  const capByKey = new Map<string, MemberCapacity>();
  for (const cap of capacities) {
    capByKey.set(cap.name, cap);
    if (cap.slug) capByKey.set(cap.slug, cap);
  }
  const teamOf = (owner: string): string | undefined =>
    capByKey.get(owner)?.team;

  // Overdue count per owner (perOwnerLoad already has open count + estimate).
  const overdueByOwner = new Map<string, number>();
  for (const t of c.overdue) {
    for (const owner of ownersOf(t)) {
      overdueByOwner.set(owner, (overdueByOwner.get(owner) ?? 0) + 1);
    }
  }

  // Union of owners who carry open work and members who declared a capacity, so
  // a fully-idle member with a declared capacity still shows up.
  const ownerNames = new Set<string>(c.perOwnerLoad.keys());
  for (const cap of capacities) ownerNames.add(cap.name);

  const members: MemberLoad[] = [];
  for (const name of ownerNames) {
    const load = c.perOwnerLoad.get(name) ?? { openCount: 0, estimateSum: 0 };
    const cap = capByKey.get(name);
    const capacityPoints = cap?.capacityPoints;
    const loadRatio =
      capacityPoints && capacityPoints > 0
        ? load.estimateSum / capacityPoints
        : undefined;
    members.push({
      name,
      team: cap?.team,
      openCount: load.openCount,
      estimateSum: load.estimateSum,
      overdueCount: overdueByOwner.get(name) ?? 0,
      expectedHoursPerWeek: cap?.expectedHoursPerWeek,
      capacityPoints,
      loadRatio,
      // Only flag when capacity is actually declared — never invent overload.
      overloaded: loadRatio !== undefined && loadRatio > overloadRatio,
      payParityNote: cap?.payParityNote,
    });
  }
  members.sort(
    (a, b) =>
      b.estimateSum - a.estimateSum ||
      b.openCount - a.openCount ||
      a.name.localeCompare(b.name),
  );

  // Per-team rollup. A member's team comes from their profile; tasks inherit the
  // teams of their owners. Work with no team (or no owner) lands in "No team".
  const teamMap = new Map<string, TeamLoad>();
  const team = (name: string): TeamLoad => {
    let tl = teamMap.get(name);
    if (!tl) {
      tl = {
        team: name,
        members: [],
        openCount: 0,
        estimateSum: 0,
        overdueTasks: [],
      };
      teamMap.set(name, tl);
    }
    return tl;
  };
  for (const m of members) {
    const tl = team(m.team || UNASSIGNED_TEAM);
    tl.members.push(m.name);
    tl.openCount += m.openCount;
    tl.estimateSum += m.estimateSum;
  }
  for (const t of c.overdue) {
    const teams = new Set(ownersOf(t).map((o) => teamOf(o) || UNASSIGNED_TEAM));
    for (const tn of teams) team(tn).overdueTasks.push(t);
  }
  const teams = [...teamMap.values()].sort((a, b) =>
    a.team.localeCompare(b.team),
  );

  let totalOpen = 0;
  for (const t of tasks) if (!isDoneStatus(t.status)) totalOpen++;

  return {
    generatedAtMs: nowMs,
    totalOpen,
    overdue: c.overdue,
    dueSoon: c.dueSoon,
    blocking: c.blocking,
    blocked: c.blocked,
    members,
    teams,
    overloaded: members.filter((m) => m.overloaded),
  };
}

/**
 * Sanitize a free-text value for interpolation into a markdown table cell:
 * escape `|` (column separator) and collapse newlines, so a name/team/note
 * can't break the table or inject extra columns.
 */
function mdCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\s*\r?\n\s*/g, ' ');
}

function taskLine(t: PmTask, nowMs: number, withOwners = true): string {
  const owners = t.owners.length ? t.owners.join(', ') : 'unassigned';
  let when = '';
  if (t.deadline) {
    const dMs = parseDeadline(t.deadline);
    if (!Number.isNaN(dMs)) {
      const days = Math.ceil((nowMs - dMs) / 86_400_000);
      when = days > 0 ? ` — ${days}d overdue` : ` — due ${t.deadline}`;
    } else {
      when = ` — due ${t.deadline}`;
    }
  }
  const who = withOwners ? ` (${owners})` : '';
  return `- ${t.id} — ${t.title}${who}${when}`;
}

export interface RenderReportOptions {
  /**
   * 'leaders' → full per-person hours/load detail (private channel).
   * 'coop'    → team-level aggregates + gentler framing, no per-person hours.
   */
  audience?: ReportAudience;
  orgName?: string;
}

/**
 * Render the report to markdown. The `audience` toggle controls granularity:
 * leadership sees per-person hours/load; a co-op-wide post stays at the team
 * level and drops per-person hours to avoid singling people out.
 */
export function renderOperationalReport(
  report: OperationalReport,
  opts: RenderReportOptions = {},
): string {
  const audience: ReportAudience = opts.audience ?? 'leaders';
  const isLeaders = audience === 'leaders';
  const nowMs = report.generatedAtMs;
  const date = new Date(nowMs).toISOString().slice(0, 10);
  const title = opts.orgName
    ? `${opts.orgName} — operational report`
    : 'Operational report';

  const lines: string[] = [
    `# ${title} — ${date}`,
    '',
    `_${report.totalOpen} open task(s) • ${report.overdue.length} overdue • ` +
      `${report.blocking.length} bottleneck(s)._`,
    '',
  ];

  // --- What's late ---
  // The coop view stays at the team level: no per-person breakdown and no
  // owner names on task lines, so a co-op-wide post never carries
  // individual-level performance signals (those are the leaders view's job).
  lines.push("## What's late", '');
  if (!report.overdue.length) {
    lines.push('- Nothing overdue. 🎉', '');
  } else {
    lines.push('### By team', '');
    const lateTeams = report.teams.filter((t) => t.overdueTasks.length);
    if (lateTeams.length) {
      for (const t of lateTeams) {
        lines.push(`**${t.team}** (${t.overdueTasks.length} late)`);
        for (const task of t.overdueTasks)
          lines.push(taskLine(task, nowMs, isLeaders));
        lines.push('');
      }
    } else {
      lines.push('- (no team mapping on overdue work)', '');
    }
    if (isLeaders) {
      lines.push('### By person', '');
      const byPerson = new Map<string, PmTask[]>();
      for (const task of report.overdue) {
        for (const owner of ownersOf(task)) {
          const arr = byPerson.get(owner) || [];
          arr.push(task);
          byPerson.set(owner, arr);
        }
      }
      for (const owner of [...byPerson.keys()].sort()) {
        lines.push(`**${owner}** (${byPerson.get(owner)!.length} late)`);
        for (const task of byPerson.get(owner)!)
          lines.push(taskLine(task, nowMs));
        lines.push('');
      }
    }
  }

  // --- Bottlenecks (from the PM orchestration layer) ---
  lines.push('## Bottlenecks (blocking others)', '');
  if (!report.blocking.length) {
    lines.push('- None — nothing is blocking downstream work.', '');
  } else {
    for (const t of report.blocking) {
      const waiting = t.downstream.join(', ');
      lines.push(
        taskLine(t, nowMs, isLeaders) +
          (waiting ? ` — blocks: ${waiting}` : ''),
      );
    }
    lines.push('');
  }

  // --- Due soon (forward look) ---
  if (report.dueSoon.length) {
    lines.push('## Due soon', '');
    for (const t of report.dueSoon) lines.push(taskLine(t, nowMs, isLeaders));
    lines.push('');
  }

  // --- Load vs capacity ---
  if (isLeaders) {
    lines.push('## Load vs. capacity (declared, not verified)', '');
    lines.push(
      '> Hours/points below are **self-declared** — we have no verified time ' +
        'tracking. Treat over-capacity as a prompt to check in, not a verdict. ' +
        'Members work different amounts and are not all paid the same.',
      '',
    );
    lines.push('| Member | Team | Open | Est. pts | Capacity | Load | Note |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const m of report.members) {
      const cap = m.capacityPoints != null ? `${m.capacityPoints} pts` : '—';
      const hours =
        m.expectedHoursPerWeek != null ? ` / ${m.expectedHoursPerWeek}h` : '';
      const ratio =
        m.loadRatio != null
          ? `${Math.round(m.loadRatio * 100)}%${m.overloaded ? ' ⚠️' : ''}`
          : '—';
      const note = m.payParityNote ? mdCell(m.payParityNote) : '';
      lines.push(
        `| ${mdCell(m.name)} | ${m.team ? mdCell(m.team) : '—'} | ` +
          `${m.openCount} | ${m.estimateSum} | ${cap}${hours} | ${ratio} | ${note} |`,
      );
    }
    lines.push('');
    if (report.overloaded.length) {
      lines.push('### Possibly over capacity — worth a check-in', '');
      for (const m of report.overloaded) {
        const note = m.payParityNote ? ` (${m.payParityNote})` : '';
        lines.push(
          `- ${m.name}${note}: ${m.estimateSum} pts open vs ` +
            `${m.capacityPoints} declared` +
            (m.loadRatio != null ? ` (${Math.round(m.loadRatio * 100)}%)` : ''),
        );
      }
      lines.push('');
    }
  } else {
    // Co-op-wide: team aggregates only, no per-person hours.
    lines.push('## Load by team', '');
    lines.push('| Team | Members | Open | Est. pts |');
    lines.push('|---|---|---|---|');
    for (const t of report.teams) {
      lines.push(
        `| ${mdCell(t.team)} | ${t.members.length} | ${t.openCount} | ${t.estimateSum} |`,
      );
    }
    lines.push('');
    if (report.overloaded.length) {
      lines.push(
        `> ${report.overloaded.length} member(s) are carrying more than their ` +
          'declared capacity — leadership is following up privately.',
        '',
      );
    }
  }

  return lines.join('\n');
}
