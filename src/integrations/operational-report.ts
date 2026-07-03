/**
 * Operational-report loop (issue #34).
 *
 * Delivers a *recurring* leadership readout of operational state — what's late
 * (by team / by person), per-member load vs. declared capacity with a soft
 * over-capacity flag, and a bottleneck digest — so leadership stops asking for
 * it ad-hoc. The heavy lifting is pure (src/operational-report.ts, reusing the
 * PM layer's classify()); this loop just sweeps on a cadence, posts once per
 * period, and writes a rolling digest to the KB.
 *
 * Unlike the PM-orchestration loop, this is a deterministic *report* — it never
 * wakes the container agent and so costs no API spend. Loop shape mirrors the
 * reminder engine (interval from config, `loopRunning` + `tickInFlight` guards,
 * `unref`). Idempotency is per-period (ISO week / month) via `ops_report_log`,
 * so a restart or a tighter sweep interval can't double-post.
 */

import { hasOpsReportFired, recordOpsReportFired } from '../db.js';
import { logger } from '../logger.js';
import type { MemberCapacity } from '../member-profiles.js';
import {
  buildOperationalReport,
  renderOperationalReport,
  type OperationalReport,
  type ReportAudience,
} from '../operational-report.js';
import { parseDeadline } from '../reminder-engine.js';
import type { PmTask } from '../pm-orchestration.js';

const DAY_MS = 86_400_000;

/** A minimal, plain-data task shape for the HTML page (no TS types leak in). */
export interface OpsPageTask {
  id: string;
  title: string;
  url?: string;
  owner?: string;
  owners: string[];
  team?: string;
  deadline?: string;
  /** Whole days past deadline (>0 = overdue); omitted when no deadline. */
  daysOverdue?: number;
  /** Downstream task ids this one blocks (bottleneck view). */
  downstream: string[];
}

/**
 * The exact JSON the ops page (tools/agenda-page/render-ops.mjs) renders. A
 * clean, explicit serializable projection of the OperationalReport plus meta —
 * so the renderer never depends on internal TS types and the page-data on disk
 * stays stable.
 */
export interface OpsPageData {
  orgName?: string;
  generatedAt: string;
  audience: ReportAudience;
  totalOpen: number;
  overdue: OpsPageTask[];
  blocking: OpsPageTask[];
  teams: {
    team: string;
    members: string[];
    openCount: number;
    estimateSum: number;
    overdueTasks: OpsPageTask[];
  }[];
  members: {
    name: string;
    team?: string;
    openCount: number;
    estimateSum: number;
    overdueCount: number;
    expectedHoursPerWeek?: number;
    capacityPoints?: number;
    loadRatio?: number;
    overloaded: boolean;
    payParityNote?: string;
  }[];
}

/** Days a task is past its deadline (whole days, >0 = overdue), or undefined. */
function daysOverdueOf(t: PmTask, nowMs: number): number | undefined {
  if (!t.deadline) return undefined;
  const dMs = parseDeadline(t.deadline);
  if (Number.isNaN(dMs)) return undefined;
  const days = Math.ceil((nowMs - dMs) / DAY_MS);
  return days > 0 ? days : undefined;
}

function toPageTask(t: PmTask, nowMs: number): OpsPageTask {
  return {
    id: t.id,
    title: t.title,
    url: t.ref || undefined,
    owner: t.owners.length ? t.owners.join(', ') : undefined,
    owners: t.owners,
    deadline: t.deadline,
    daysOverdue: daysOverdueOf(t, nowMs),
    downstream: t.downstream ?? [],
  };
}

/** Project the OperationalReport into the serializable page-data the HTML wants. */
export function toOpsPageData(
  report: OperationalReport,
  meta: { orgName?: string; audience: ReportAudience },
): OpsPageData {
  const nowMs = report.generatedAtMs;
  return {
    orgName: meta.orgName,
    generatedAt: new Date(nowMs).toISOString().slice(0, 10),
    audience: meta.audience,
    totalOpen: report.totalOpen,
    overdue: report.overdue.map((t) => toPageTask(t, nowMs)),
    blocking: report.blocking.map((t) => toPageTask(t, nowMs)),
    teams: report.teams.map((tm) => ({
      team: tm.team,
      members: tm.members,
      openCount: tm.openCount,
      estimateSum: tm.estimateSum,
      overdueTasks: tm.overdueTasks.map((t) => toPageTask(t, nowMs)),
    })),
    members: report.members.map((m) => ({
      name: m.name,
      team: m.team,
      openCount: m.openCount,
      estimateSum: m.estimateSum,
      overdueCount: m.overdueCount,
      expectedHoursPerWeek: m.expectedHoursPerWeek,
      capacityPoints: m.capacityPoints,
      loadRatio: m.loadRatio,
      overloaded: m.overloaded,
      payParityNote: m.payParityNote,
    })),
  };
}

export interface OperationalReportDeps {
  /** Deliver the report to a chat JID. */
  sendMessage: (jid: string, text: string) => Promise<void>;
  /** Resolve the delivery target lazily (groups may register after startup). */
  resolveTargetJid: () => string | null;
  /** Load the current task graph. */
  loadTasks: () => PmTask[];
  /** Load declared member capacities. */
  loadCapacities: () => MemberCapacity[];
  /** Persist the rendered report (optional; e.g. write to the shared KB). */
  writeDigest?: (markdown: string) => void;
  /**
   * Publish the report as a StatiCrypt-encrypted HTML page and return its public
   * URL (or null if web delivery isn't configured). When it returns a URL, the
   * leader is DM'd the link instead of the raw markdown; when absent or it
   * returns null, delivery falls back to the markdown DM.
   * `pageId` is the period key (e.g. `2026-W26`) → page `ops-2026-W26.html`.
   */
  publishPage?: (pageId: string, pageData: OpsPageData) => string | null;
  /** Sweep cadence in ms; <= 0 disables the loop. */
  intervalMs?: number;
  /** Days before a deadline a task counts as "due soon". */
  dueSoonDays?: number;
  /** Over-capacity soft-flag ratio (estimateSum / capacityPoints). */
  overloadRatio?: number;
  /** Rendering audience (granularity / framing). */
  audience?: ReportAudience;
  /** Reporting period for idempotency: weekly (ISO week) or monthly. */
  period?: 'weekly' | 'monthly';
  /** Org name for the report title. */
  orgName?: string;
  /** Clock injection for tests. */
  now?: () => number;
}

/** ISO-week key like `2026-W23` (UTC). */
function isoWeekKey(nowMs: number): string {
  const d = new Date(nowMs);
  // ISO week: shift to the Thursday of this week, then count from Jan 1.
  const date = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      (date.getTime() - firstThursday.getTime()) / (7 * DAY_MS) -
        ((firstThursday.getUTCDay() + 6) % 7) / 7,
    );
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Period key (idempotency bucket) for `nowMs`. */
export function periodKey(nowMs: number, period: 'weekly' | 'monthly'): string {
  if (period === 'monthly') {
    return new Date(nowMs).toISOString().slice(0, 7); // YYYY-MM
  }
  return isoWeekKey(nowMs);
}

/** One report pass. Returns whether a report was delivered this tick. */
export async function runOperationalReportTick(
  deps: OperationalReportDeps,
): Promise<{ sent: boolean }> {
  const nowMs = (deps.now ?? Date.now)();
  const tasks = deps.loadTasks();
  const capacities = deps.loadCapacities();
  const dueSoonMs = (deps.dueSoonDays ?? 7) * DAY_MS;

  const report = buildOperationalReport(tasks, capacities, nowMs, dueSoonMs, {
    overloadRatio: deps.overloadRatio,
  });
  const markdown = renderOperationalReport(report, {
    audience: deps.audience,
    orgName: deps.orgName,
  });

  // Always refresh the rolling digest (cheap, read by leadership on demand).
  if (deps.writeDigest) {
    try {
      deps.writeDigest(markdown);
    } catch (err) {
      logger.warn({ err }, 'Operational report: failed to write digest');
    }
  }

  // Nothing to report on at all — don't post an empty readout.
  if (report.totalOpen === 0 && report.members.length === 0) {
    logger.info('Operational report: no open tasks or members — skipping post');
    return { sent: false };
  }

  const period = periodKey(nowMs, deps.period ?? 'weekly');
  if (hasOpsReportFired(period)) {
    logger.debug(
      { period },
      'Operational report: already delivered this period',
    );
    return { sent: false };
  }

  const targetJid = deps.resolveTargetJid();
  if (!targetJid) {
    logger.warn(
      'Operational report: no target JID resolved — skipping (will retry)',
    );
    return { sent: false };
  }

  // Prefer the readable web page: publish the StatiCrypt-encrypted HTML and DM a
  // short link. Fall back to the raw markdown DM when web delivery isn't wired
  // (publishPage absent) or fails to produce a URL. The rolling digest above is
  // always the markdown, regardless.
  let pageUrl: string | null = null;
  if (deps.publishPage) {
    try {
      pageUrl = deps.publishPage(
        period,
        toOpsPageData(report, {
          orgName: deps.orgName,
          audience: deps.audience ?? 'leaders',
        }),
      );
    } catch (err) {
      logger.warn(
        { err, period },
        'Operational report: publishPage failed — falling back to markdown',
      );
      pageUrl = null;
    }
  }

  const message = pageUrl
    ? `🗒️ Your ${deps.orgName ? `${deps.orgName} ` : ''}operational report for ${period} is ready — ` +
      `what's late, bottlenecks, and load vs. capacity, in a readable page:\n${pageUrl}\n` +
      `(password-protected — use the shared agenda page password.)`
    : markdown;

  try {
    await deps.sendMessage(targetJid, message);
    recordOpsReportFired(period);
    logger.info(
      {
        period,
        overdue: report.overdue.length,
        overloaded: report.overloaded.length,
        delivery: pageUrl ? 'link' : 'markdown',
      },
      'Operational report delivered',
    );
    return { sent: true };
  } catch (err) {
    // Don't record on failure so the next sweep retries this period.
    logger.error(
      { err, period },
      'Operational report send failed — will retry',
    );
    return { sent: false };
  }
}

let loopRunning = false;
let loopTimer: NodeJS.Timeout | null = null;
let tickInFlight = false;

export function startOperationalReport(deps: OperationalReportDeps): void {
  if (loopRunning) {
    logger.debug('Operational report loop already running');
    return;
  }
  const interval = deps.intervalMs ?? 0;
  if (interval <= 0) {
    logger.info('Operational report disabled (interval=0)');
    return;
  }
  loopRunning = true;

  const tick = async () => {
    if (tickInFlight) {
      logger.debug('Operational report tick already in flight — skipping');
      return;
    }
    tickInFlight = true;
    try {
      await runOperationalReportTick(deps);
    } catch (err) {
      logger.error({ err }, 'Operational report tick failed');
    } finally {
      tickInFlight = false;
    }
  };

  logger.info({ intervalMs: interval }, 'Operational report loop started');
  void tick();
  loopTimer = setInterval(tick, interval);
  loopTimer.unref?.();
}

export function stopOperationalReport(): void {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
  loopRunning = false;
  tickInFlight = false;
}

/** @internal - for tests only. */
export function _resetOpsReportLoopForTests(): void {
  stopOperationalReport();
}
