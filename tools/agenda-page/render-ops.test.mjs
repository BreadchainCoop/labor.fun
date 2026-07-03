import { describe, expect, it } from 'vitest';

import { renderOpsReport } from './render-ops.mjs';

/** A representative page-data object (as toOpsPageData would produce). */
function sample(over = {}) {
  return {
    orgName: 'Breadchain',
    generatedAt: '2026-06-22',
    audience: 'leaders',
    totalOpen: 5,
    overdue: [
      {
        id: 'T1',
        title: 'Ship the payout script',
        url: 'https://github.com/x/1',
        owner: 'Alice',
        owners: ['Alice'],
        daysOverdue: 20,
        downstream: [],
      },
      {
        id: 'T2',
        title: 'Design the landing page',
        owner: 'Bob',
        owners: ['Bob'],
        daysOverdue: 2,
        downstream: [],
      },
    ],
    blocking: [
      {
        id: 'T1',
        title: 'Ship the payout script',
        owner: 'Alice',
        owners: ['Alice'],
        daysOverdue: 20,
        downstream: ['T7', 'T8'],
      },
    ],
    teams: [
      {
        team: 'Engineering',
        members: ['Alice'],
        openCount: 3,
        estimateSum: 12,
        overdueTasks: [
          {
            id: 'T1',
            title: 'Ship the payout script',
            owner: 'Alice',
            owners: ['Alice'],
            daysOverdue: 20,
            downstream: [],
          },
        ],
      },
    ],
    members: [
      {
        name: 'Alice',
        team: 'Engineering',
        openCount: 3,
        estimateSum: 12,
        overdueCount: 1,
        expectedHoursPerWeek: 20,
        capacityPoints: 8,
        loadRatio: 1.5,
        overloaded: true,
        payParityNote: 'part-time',
      },
    ],
    ...over,
  };
}

describe('renderOpsReport', () => {
  it('renders overdue items, the bottleneck, the load table and the caveat', () => {
    const html = renderOpsReport(sample());
    // header summary
    expect(html).toContain('Breadchain — operational report');
    expect(html).toContain('5 open · 2 overdue · 1 bottleneck');
    // overdue items (by team + by person)
    expect(html).toContain('Ship the payout script');
    expect(html).toContain('Design the landing page');
    expect(html).toContain('20d overdue');
    expect(html).toContain("What's late — by person");
    expect(html).toContain('Alice');
    expect(html).toContain('Bob');
    // bottleneck with what it blocks
    expect(html).toContain('blocks: T7, T8');
    // load-vs-capacity table
    expect(html).toContain('Load vs. capacity');
    expect(html).toContain('<table>');
    expect(html).toContain('Est. pts');
    expect(html).toContain('150%'); // loadRatio 1.5
    expect(html).toContain('part-time');
    // the declared-not-verified caveat, prominently
    expect(html).toContain('self-declared, not verified');
    expect(html).toContain('prompt to check in, not a verdict');
    expect(html).toContain('not all paid the same');
  });

  it('renders very-overdue items with high severity styling', () => {
    const html = renderOpsReport(sample());
    // 20d overdue → sev-high badge class present
    expect(html).toContain('badge sev-high');
  });

  it('renders a graceful "nothing late" page for an empty report', () => {
    const html = renderOpsReport({
      orgName: 'Breadchain',
      generatedAt: '2026-06-22',
      audience: 'leaders',
      totalOpen: 0,
      overdue: [],
      blocking: [],
      teams: [],
      members: [],
    });
    expect(html).toContain('Nothing late 🎉');
    expect(html).toContain('Nothing is blocking downstream work');
    expect(html).toContain('0 open · 0 overdue · 0 bottlenecks');
    // still a valid, self-contained page
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Load vs. capacity');
  });

  it('escapes injected task titles (XSS-safe)', () => {
    const evil = '<script>alert(1)</script>';
    const html = renderOpsReport(
      sample({
        overdue: [
          {
            id: 'X',
            title: evil,
            owner: '"><img src=x>',
            owners: ['"><img src=x>'],
            daysOverdue: 3,
            downstream: [],
          },
        ],
        blocking: [],
        teams: [
          {
            team: 'Eng',
            members: [],
            openCount: 0,
            estimateSum: 0,
            overdueTasks: [
              {
                id: 'X',
                title: evil,
                owner: 'x',
                owners: ['x'],
                daysOverdue: 3,
                downstream: [],
              },
            ],
          },
        ],
      }),
    );
    // The raw script tag must never appear unescaped.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // Attribute-breaking owner is escaped too.
    expect(html).not.toContain('"><img src=x>');
  });

  it('drops per-person detail for the coop audience', () => {
    const html = renderOpsReport(sample({ audience: 'coop' }));
    expect(html).not.toContain("What's late — by person");
    // coop load table is team-level (no per-person Capacity column)
    expect(html).toContain('>Team<');
    expect(html).not.toContain('part-time');
  });
});
