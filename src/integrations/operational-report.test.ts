import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from '../db.js';
import {
  periodKey,
  runOperationalReportTick,
  type OperationalReportDeps,
} from './operational-report.js';
import type { PmTask } from '../pm-orchestration.js';

const NOW = Date.parse('2026-06-15T12:00:00Z'); // a Monday

function task(over: Partial<PmTask> = {}): PmTask {
  return {
    id: 'T1',
    title: 'Task one',
    owners: ['Alice'],
    status: 'open',
    upstream: [],
    downstream: [],
    ...over,
  };
}

describe('periodKey', () => {
  it('produces an ISO-week key for weekly', () => {
    expect(periodKey(Date.parse('2026-06-15T00:00:00Z'), 'weekly')).toBe(
      '2026-W24',
    );
  });

  it('produces a YYYY-MM key for monthly', () => {
    expect(periodKey(Date.parse('2026-06-15T00:00:00Z'), 'monthly')).toBe(
      '2026-06',
    );
  });

  it('keeps the same key across a week', () => {
    const mon = periodKey(Date.parse('2026-06-15T00:00:00Z'), 'weekly');
    const fri = periodKey(Date.parse('2026-06-19T00:00:00Z'), 'weekly');
    expect(mon).toBe(fri);
  });
});

describe('runOperationalReportTick', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  function deps(over: Partial<OperationalReportDeps> = {}): {
    deps: OperationalReportDeps;
    sent: string[];
    digests: string[];
  } {
    const sent: string[] = [];
    const digests: string[] = [];
    return {
      sent,
      digests,
      deps: {
        sendMessage: async (_jid, text) => {
          sent.push(text);
        },
        resolveTargetJid: () => 'slack:leaders',
        loadTasks: () => [task()],
        loadCapacities: () => [],
        writeDigest: (md) => digests.push(md),
        now: () => NOW,
        ...over,
      },
    };
  }

  it('posts once and writes a digest', async () => {
    const { deps: d, sent, digests } = deps();
    const r = await runOperationalReportTick(d);
    expect(r.sent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(digests).toHaveLength(1);
  });

  it('does not re-post within the same period (idempotent)', async () => {
    const { deps: d, sent, digests } = deps();
    await runOperationalReportTick(d);
    const r = await runOperationalReportTick(d);
    expect(r.sent).toBe(false);
    expect(sent).toHaveLength(1); // not re-sent
    expect(digests).toHaveLength(2); // digest still refreshed each tick
  });

  it('skips posting when there are no tasks and no members', async () => {
    const { deps: d, sent } = deps({
      loadTasks: () => [],
      loadCapacities: () => [],
    });
    const r = await runOperationalReportTick(d);
    expect(r.sent).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('does not record the period when no target resolves (retries later)', async () => {
    const { deps: d, sent } = deps({ resolveTargetJid: () => null });
    const r1 = await runOperationalReportTick(d);
    expect(r1.sent).toBe(false);
    expect(sent).toHaveLength(0);
    // Target now resolves → it should still post (period wasn't recorded).
    const r2 = await runOperationalReportTick({
      ...d,
      resolveTargetJid: () => 'slack:leaders',
    });
    expect(r2.sent).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('DMs the link (not the markdown) when publishPage returns a URL', async () => {
    const pages: { id: string; data: unknown }[] = [];
    const {
      deps: d,
      sent,
      digests,
    } = deps({
      publishPage: (id, data) => {
        pages.push({ id, data });
        return `https://host:8091/ops-${id}.html`;
      },
    });
    const r = await runOperationalReportTick(d);
    expect(r.sent).toBe(true);
    expect(sent).toHaveLength(1);
    // The DM carries the link and mentions the password, and does NOT dump md.
    expect(sent[0]).toContain('https://host:8091/ops-2026-W24.html');
    expect(sent[0].toLowerCase()).toContain('password');
    expect(sent[0]).not.toContain('## What'); // no markdown sections dumped
    // The page-data was published under the period key.
    expect(pages).toHaveLength(1);
    expect(pages[0].id).toBe('2026-W24');
    // Digest is still the full markdown.
    expect(digests).toHaveLength(1);
    expect(digests[0]).toContain("What's late");
  });

  it('falls back to the markdown DM when publishPage returns null', async () => {
    const { deps: d, sent } = deps({
      publishPage: () => null,
    });
    const r = await runOperationalReportTick(d);
    expect(r.sent).toBe(true);
    expect(sent).toHaveLength(1);
    // The DM is the markdown report itself.
    expect(sent[0]).toContain("What's late");
    expect(sent[0]).not.toContain('ops-2026');
  });

  it('falls back to markdown when publishPage is absent (backwards compatible)', async () => {
    const { deps: d, sent } = deps(); // no publishPage
    const r = await runOperationalReportTick(d);
    expect(r.sent).toBe(true);
    expect(sent[0]).toContain("What's late");
  });

  it('web delivery preserves once-per-period idempotency', async () => {
    let calls = 0;
    const {
      deps: d,
      sent,
      digests,
    } = deps({
      publishPage: (id) => {
        calls++;
        return `https://host:8091/ops-${id}.html`;
      },
    });
    await runOperationalReportTick(d);
    const r = await runOperationalReportTick(d);
    expect(r.sent).toBe(false);
    expect(sent).toHaveLength(1); // link DM'd once
    expect(calls).toBe(1); // page published once
    expect(digests).toHaveLength(2); // digest still refreshed every tick
  });
});
