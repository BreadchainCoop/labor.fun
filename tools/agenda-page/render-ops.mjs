// Operational-report page generator (issue #34).
//
// Turns an OperationalReport (src/operational-report.ts) into a SELF-CONTAINED,
// zero-dependency, dark-themed READ-ONLY HTML page: what's late (by team, then
// by person, with days-overdue + severity), bottlenecks (blocking downstream),
// and a load-vs-capacity table carrying the "declared, not verified" caveat.
//
// The raw markdown DM'd to a leader is unreadable; this is the readable form.
// It's rendered to plaintext HTML server-side and StatiCrypt-encrypted before
// serving (see serve.mjs), so the page never carries interactivity — unlike the
// agenda corrector, it's purely a report to read.
//
// Usage:  node render-ops.mjs <ops.json> [out.html]
//   (or import { renderOpsReport } and pass the parsed object.)
//
// The `data` object is the OperationalReport plus { orgName, generatedAt,
// audience }. All rendering happens here (no client script), so the page is a
// pure function of the JSON and trivially StatiCrypt-wrappable.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** Minimal HTML escape for text injected into markup (XSS-safe). */
function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Days a task is overdue, given `daysOverdue` (preferred) or a deadline. */
function overdueDays(t) {
  if (typeof t.daysOverdue === 'number') return t.daysOverdue;
  return null;
}

/** Severity class from days overdue: >14d is "very overdue". */
function severityClass(days) {
  if (days == null) return '';
  if (days >= 14) return ' sev-high';
  if (days >= 3) return ' sev-mid';
  return '';
}

/** A human "Nd overdue" / "due <date>" suffix for a task row. */
function whenLabel(t) {
  const days = overdueDays(t);
  if (days != null && days > 0) return `${days}d overdue`;
  if (t.deadline) return `due ${t.deadline}`;
  return '';
}

/** Render one overdue/blocking task <li>. */
function taskItem(t, { showOwner = true, extra = '' } = {}) {
  const days = overdueDays(t);
  const when = whenLabel(t);
  const owner =
    showOwner && (t.owner || (t.owners && t.owners.length))
      ? `<span class="owner">${esc(t.owner || (t.owners || []).join(', '))}</span>`
      : '';
  const title = t.url
    ? `<a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.title)}</a>`
    : esc(t.title);
  const id = t.id ? `<span class="id">${esc(t.id)}</span> ` : '';
  const whenBadge = when
    ? `<span class="badge${severityClass(days)}">${esc(when)}</span>`
    : '';
  return (
    `<li class="task${severityClass(days)}">` +
    `<div class="tmain">${id}${title}${extra}</div>` +
    `<div class="tmeta">${owner}${owner && whenBadge ? ' · ' : ''}${whenBadge}</div>` +
    `</li>`
  );
}

/** Build the self-contained HTML string from an OperationalReport object. */
export function renderOpsReport(data) {
  const orgName = data.orgName || '';
  const generatedAt =
    data.generatedAt ||
    (data.generatedAtMs
      ? new Date(data.generatedAtMs).toISOString().slice(0, 10)
      : '');
  const audience = data.audience === 'coop' ? 'coop' : 'leaders';
  const isLeaders = audience === 'leaders';

  const overdue = data.overdue || [];
  const teams = data.teams || [];
  const blocking = data.blocking || [];
  const members = data.members || [];
  const totalOpen = data.totalOpen ?? 0;
  const bottleneckCount = data.blocking ? data.blocking.length : 0;

  const title = orgName
    ? `${esc(orgName)} — operational report`
    : 'Operational report';
  const summary =
    `${totalOpen} open · ${overdue.length} overdue · ` +
    `${bottleneckCount} bottleneck${bottleneckCount === 1 ? '' : 's'}`;

  // --- What's late: by team ---
  const lateTeams = teams.filter((t) => (t.overdueTasks || []).length);
  let byTeamHtml;
  if (!overdue.length) {
    byTeamHtml = `<p class="empty">Nothing late 🎉</p>`;
  } else if (!lateTeams.length) {
    byTeamHtml = `<p class="empty">(no team mapping on overdue work)</p>`;
  } else {
    byTeamHtml = lateTeams
      .map(
        (t) =>
          `<div class="group"><h3>${esc(t.team)} ` +
          `<span class="count">${t.overdueTasks.length} late</span></h3>` +
          `<ul>${t.overdueTasks
            .map((task) => taskItem(task, { showOwner: isLeaders }))
            .join('')}</ul></div>`,
      )
      .join('');
  }

  // --- What's late: by person (leaders only) ---
  let byPersonHtml = '';
  if (isLeaders && overdue.length) {
    const byPerson = new Map();
    for (const task of overdue) {
      const owners =
        task.owners && task.owners.length
          ? task.owners
          : [task.owner || 'unassigned'];
      for (const o of owners) {
        const arr = byPerson.get(o) || [];
        arr.push(task);
        byPerson.set(o, arr);
      }
    }
    const rows = [...byPerson.keys()]
      .sort()
      .map((owner) => {
        const list = byPerson.get(owner);
        return (
          `<div class="group"><h3>${esc(owner)} ` +
          `<span class="count">${list.length} late</span></h3>` +
          `<ul>${list
            .map((task) => taskItem(task, { showOwner: false }))
            .join('')}</ul></div>`
        );
      })
      .join('');
    byPersonHtml =
      `<section class="card"><h2>What's late — by person</h2>${rows}</section>`;
  }

  // --- Bottlenecks ---
  let bottleneckHtml;
  if (!blocking.length) {
    bottleneckHtml = `<p class="empty">Nothing is blocking downstream work. 🎉</p>`;
  } else {
    bottleneckHtml =
      `<ul>${blocking
        .map((t) => {
          const waiting =
            t.downstream && t.downstream.length
              ? ` <span class="blocks">blocks: ${esc(t.downstream.join(', '))}</span>`
              : '';
          return taskItem(t, { showOwner: isLeaders, extra: waiting });
        })
        .join('')}</ul>`;
  }

  // --- Load vs capacity (leaders: per-person; coop: team aggregates) ---
  let loadHtml;
  if (isLeaders) {
    const rows = members
      .map((m) => {
        const cap = m.capacityPoints != null ? `${esc(m.capacityPoints)} pts` : '—';
        const hours =
          m.expectedHoursPerWeek != null ? ` / ${esc(m.expectedHoursPerWeek)}h` : '';
        const ratio =
          m.loadRatio != null
            ? `${Math.round(m.loadRatio * 100)}%`
            : '—';
        const note = m.payParityNote ? esc(m.payParityNote) : '';
        return (
          `<tr${m.overloaded ? ' class="over"' : ''}>` +
          `<td>${esc(m.name)}</td>` +
          `<td>${m.team ? esc(m.team) : '—'}</td>` +
          `<td class="num">${esc(m.openCount)}</td>` +
          `<td class="num">${esc(m.estimateSum)}</td>` +
          `<td>${cap}${hours}</td>` +
          `<td class="num">${ratio}${m.overloaded ? ' ⚠️' : ''}</td>` +
          `<td>${note}</td>` +
          `</tr>`
        );
      })
      .join('');
    loadHtml =
      `<table><thead><tr>` +
      `<th>Member</th><th>Team</th><th>Open</th><th>Est. pts</th>` +
      `<th>Capacity</th><th>Load</th><th>Note</th>` +
      `</tr></thead><tbody>${rows}</tbody></table>`;
  } else {
    const rows = teams
      .map(
        (t) =>
          `<tr><td>${esc(t.team)}</td>` +
          `<td class="num">${esc((t.members || []).length)}</td>` +
          `<td class="num">${esc(t.openCount)}</td>` +
          `<td class="num">${esc(t.estimateSum)}</td></tr>`,
      )
      .join('');
    loadHtml =
      `<table><thead><tr>` +
      `<th>Team</th><th>Members</th><th>Open</th><th>Est. pts</th>` +
      `</tr></thead><tbody>${rows}</tbody></table>`;
  }

  const caveat =
    `The hours and points below are <b>self-declared, not verified</b> — we have ` +
    `no time tracking. Treat over-capacity as a <b>prompt to check in, not a verdict</b>: ` +
    `members work different amounts and are not all paid the same.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}${generatedAt ? ` — ${esc(generatedAt)}` : ''}</title>
<style>
  :root { --bg:#0a0a0a; --card:#131313; --line:#222; --line2:#252525; --fg:#eee;
          --mut:#9aa; --link:#7eb8da; --accent:#4a9eda; --warn:#f0ad4e;
          --danger:#e0623f; --ok:#5cb85c; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         line-height:1.5; padding-bottom:48px; }
  a { color:var(--link); }
  header { background:#111; border-bottom:1px solid var(--line); padding:22px 24px; }
  header h1 { margin:0 0 6px; font-size:22px; }
  header .summary { color:var(--mut); font-size:14.5px; }
  header .summary b { color:var(--fg); }
  .wrap { max-width:920px; margin:0 auto; padding:24px; }
  section.card { background:var(--card); border:1px solid var(--line); border-radius:10px;
                 padding:16px 20px; margin-bottom:18px; }
  section.card > h2 { font-size:17px; margin:0 0 14px; }
  .group { margin:0 0 16px; }
  .group:last-child { margin-bottom:0; }
  .group h3 { font-size:14.5px; margin:0 0 8px; color:#dfe7ef; }
  .count { color:var(--mut); font-weight:400; font-size:12.5px; }
  ul { list-style:none; margin:0; padding:0; }
  li.task { padding:9px 0; border-top:1px solid #1c1c1c; }
  li.task:first-child { border-top:none; }
  .tmain { font-size:14.5px; }
  .tmain a { text-decoration:none; }
  .tmain a:hover { text-decoration:underline; }
  .id { color:var(--mut); font-size:12px; font-family:ui-monospace,Menlo,monospace; }
  .tmeta { font-size:12.5px; color:var(--mut); margin-top:2px; }
  .owner { color:#cdd; }
  .badge { display:inline-block; background:#1e1e1e; border:1px solid var(--line2);
           color:var(--mut); border-radius:4px; padding:0 7px; font-size:11.5px; }
  .badge.sev-mid { color:var(--warn); border-color:#4a3d1e; }
  .badge.sev-high { color:#fff; background:var(--danger); border-color:var(--danger); }
  li.sev-high .tmain { font-weight:600; }
  .blocks { color:var(--warn); font-size:12.5px; margin-left:6px; }
  .empty { color:var(--mut); font-style:italic; margin:4px 0; }
  .caveat { background:#15151f; border:1px solid #2a2a3a; border-radius:8px;
            padding:12px 14px; color:#cdd; font-size:13.5px; margin:0 0 16px; }
  table { width:100%; border-collapse:collapse; font-size:13.5px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid #1c1c1c; }
  th { color:var(--mut); font-weight:600; font-size:12px; text-transform:uppercase;
       letter-spacing:.03em; border-bottom:1px solid var(--line2); }
  td.num, th.num { text-align:right; }
  tr.over td { background:#241a15; }
  tr.over { color:var(--warn); }
  footer { color:var(--mut); font-size:12px; text-align:center; padding:8px 24px 0; }
</style>
</head>
<body>
<header>
  <h1>🗒️ ${title}</h1>
  <div class="summary">${generatedAt ? esc(generatedAt) + ' · ' : ''}<b>${esc(summary)}</b></div>
</header>
<div class="wrap">
  <section class="card">
    <h2>What's late${isLeaders ? ' — by team' : ''}</h2>
    ${byTeamHtml}
  </section>
  ${byPersonHtml}
  <section class="card">
    <h2>Bottlenecks <span class="count">— blocking others</span></h2>
    ${bottleneckHtml}
  </section>
  <section class="card">
    <h2>Load vs. capacity</h2>
    <div class="caveat">${caveat}</div>
    ${loadHtml}
  </section>
  <footer>Read-only operational report · generated by the assistant.</footer>
</div>
</body>
</html>`;
}

// --- CLI ---
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const inPath = process.argv[2] || path.join(here, 'ops-sample.json');
  const outPath = process.argv[3] || inPath.replace(/\.json$/, '.html');
  const data = JSON.parse(fs.readFileSync(inPath, 'utf-8'));
  fs.writeFileSync(outPath, renderOpsReport(data));
  console.log('wrote ' + outPath);
}
