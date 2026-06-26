// Weekly-agenda corrector page generator.
//
// Turns a structured agenda JSON (what Breadrich drafted optimistically for a
// week) into a SELF-CONTAINED, zero-dependency interactive HTML page where each
// member can: filter to just their sections, correct/keep/remove anything the
// bot drafted, add work GitHub couldn't see, then Copy a Breadrich-ready message
// to clipboard and paste it back (a DM to Breadrich files it via the
// file-an-update routine). No backend — the page is all client-side, so it can
// be StatiCrypt-encrypted and served from a static port.
//
// Usage:  node render.mjs <agenda.json> [out.html]
//   (or import { renderAgendaPage } and pass the parsed object.)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** Minimal HTML escape for text injected into markup. */
function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Build the self-contained HTML string from an agenda data object. */
export function renderAgendaPage(data) {
  // The data object is embedded verbatim and all rendering happens client-side,
  // so the page is a pure function of the JSON and trivially StatiCrypt-wrappable.
  const json = JSON.stringify(data);
  const week = esc(data.week || '');
  const facilitator = esc(data.facilitator || 'TBD');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Weekly Agenda — ${week}</title>
<style>
  :root { --bg:#0a0a0a; --card:#131313; --line:#222; --line2:#252525; --fg:#eee;
          --mut:#9aa; --link:#7eb8da; --accent:#4a9eda; --warn:#f0ad4e; --ok:#5cb85c;
          --bot:#8a7eda; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         line-height:1.5; padding-bottom:96px; }
  a { color:var(--link); }
  header { background:#111; border-bottom:1px solid var(--line); padding:20px 24px; }
  header h1 { margin:0 0 4px; font-size:22px; }
  header .meta { color:var(--mut); font-size:14px; }
  .wrap { max-width:880px; margin:0 auto; padding:24px; }
  .note { background:#15151f; border:1px solid #2a2a3a; border-radius:8px;
          padding:12px 14px; color:#cdd; font-size:13.5px; margin-bottom:18px; }
  .filters { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 20px; position:sticky;
             top:0; background:var(--bg); padding:12px 0; z-index:5; border-bottom:1px solid var(--line); }
  .chip { background:#1a1a1a; border:1px solid var(--line2); color:var(--fg);
          border-radius:999px; padding:6px 14px; font-size:13px; cursor:pointer; }
  .chip.active { background:var(--accent); border-color:var(--accent); color:#fff; }
  section.card { background:var(--card); border:1px solid var(--line); border-radius:10px;
                 padding:16px 18px; margin-bottom:16px; }
  section.card h2 { font-size:16px; margin:0 0 10px; }
  .owner { font-weight:600; }
  .proj { margin:14px 0 6px; font-weight:600; color:#dfe7ef; }
  .item { display:flex; gap:10px; align-items:flex-start; padding:7px 0;
          border-top:1px solid #1c1c1c; }
  .item:first-child { border-top:none; }
  .tag { font-size:10.5px; text-transform:uppercase; letter-spacing:.04em; color:#fff;
         background:var(--bot); border-radius:4px; padding:1px 6px; margin-top:3px; white-space:nowrap; }
  .tag.added { background:#2c6b3f; }
  .txt { flex:1; background:#0f0f0f; border:1px solid var(--line2); color:var(--fg);
         border-radius:6px; padding:6px 8px; font:inherit; font-size:14px; min-height:34px; }
  .txt:focus { outline:none; border-color:var(--accent); }
  .removed .txt { text-decoration:line-through; opacity:.45; }
  .x { background:none; border:1px solid var(--line2); color:var(--mut); border-radius:6px;
       cursor:pointer; padding:4px 9px; font-size:13px; }
  .x:hover { color:#fff; border-color:#444; }
  .invite { color:var(--mut); font-style:italic; font-size:13.5px; padding:4px 0; }
  .add { background:none; border:1px dashed var(--line2); color:var(--link); border-radius:6px;
         cursor:pointer; padding:5px 10px; font-size:13px; margin-top:8px; }
  .ref a { font-size:12px; color:var(--mut); margin-left:2px; }
  .goal-read, .dl { color:#cdd; font-size:13.5px; }
  .dl.past { color:var(--warn); }
  footer { position:fixed; bottom:0; left:0; right:0; background:#111;
           border-top:1px solid var(--line); padding:12px 24px; display:flex;
           gap:12px; align-items:center; justify-content:center; }
  .btn { background:var(--accent); border:none; color:#fff; border-radius:8px;
         padding:10px 18px; font-size:14px; font-weight:600; cursor:pointer; }
  .btn.sec { background:#1a1a1a; border:1px solid var(--line2); color:var(--fg); font-weight:500; }
  .btn:active { transform:translateY(1px); }
  .toast { position:fixed; bottom:74px; left:50%; transform:translateX(-50%);
           background:var(--ok); color:#06210f; padding:9px 16px; border-radius:8px;
           font-size:13.5px; font-weight:600; opacity:0; transition:opacity .2s; pointer-events:none; }
  .toast.show { opacity:1; }
  .hidden { display:none !important; }
</style>
</head>
<body>
<header>
  <h1>🗓️ Weekly Core Meeting — <span id="wk"></span></h1>
  <div class="meta">Facilitator: <span id="fac"></span> · <a id="doclink" target="_blank" rel="noopener">open the agenda doc ↗</a></div>
</header>
<div class="wrap">
  <div class="note">
    🤖 <b>Breadrich drafted this optimistically</b> from GitHub and the strategic directives —
    it's a <b>starting point, not a verdict</b>. Filter to <b>your name</b>, correct anything that's off
    (merged PRs only show a slice of engineering — add the design/BD/community/care/organizing work it can't see),
    then hit <b>Copy my updates</b> and paste it to Breadrich.
  </div>
  <div class="filters" id="filters"></div>
  <div id="brief"></div>
  <div id="goals"></div>
  <div id="deadlines"></div>
  <div id="members"></div>
</div>
<footer>
  <button class="btn" id="copyMine">📋 Copy my updates</button>
  <button class="btn sec" id="copyAll">Copy everything</button>
</footer>
<div class="toast" id="toast"></div>

<script id="agenda-data" type="application/json">${json.replaceAll('<', '\\u003c')}</script>
<script>
const DATA = JSON.parse(document.getElementById('agenda-data').textContent);
let filter = '__all__';

document.getElementById('wk').textContent = DATA.week || '';
document.getElementById('fac').textContent = DATA.facilitator || 'TBD';
const dl = document.getElementById('doclink');
if (DATA.docUrl) dl.href = DATA.docUrl; else dl.classList.add('hidden');

// --- Filter chips ---
const filters = document.getElementById('filters');
function chip(label, val) {
  const b = document.createElement('button');
  b.className = 'chip' + (val === filter ? ' active' : '');
  b.textContent = label;
  b.onclick = () => { filter = val; render(); };
  return b;
}
function renderFilters() {
  filters.innerHTML = '';
  filters.appendChild(chip('Everyone', '__all__'));
  (DATA.members || []).forEach(m => filters.appendChild(chip(m.name || m.slug, m.slug)));
}

// --- helpers to build editable item rows ---
function itemRow(item, added) {
  const row = document.createElement('div');
  row.className = 'item' + (item._removed ? ' removed' : '');
  const tag = document.createElement('span');
  tag.className = 'tag' + (added ? ' added' : '');
  tag.textContent = added ? 'you added' : 'bot draft';
  const ta = document.createElement('textarea');
  ta.className = 'txt'; ta.rows = 1;
  ta.value = item.text + (item.ref ? ' (' + item.ref + ')' : '');
  ta.oninput = () => { item.text = ta.value; item.ref = ''; };
  const x = document.createElement('button');
  x.className = 'x'; x.textContent = item._removed ? '↺' : '✕';
  x.title = item._removed ? 'keep it' : 'remove it';
  x.onclick = () => { item._removed = !item._removed; render(); };
  row.append(tag, ta, x);
  return row;
}

function render() {
  renderFilters();
  // Brief
  const brief = document.getElementById('brief');
  brief.innerHTML = '';
  if (DATA.brief && (filter === '__all__')) {
    const c = document.createElement('section'); c.className = 'card';
    c.innerHTML = '<h2>📣 This Week in Brief</h2>';
    const ta = document.createElement('textarea'); ta.className = 'txt'; ta.rows = 3;
    ta.value = DATA.brief; ta.oninput = () => DATA.brief = ta.value;
    c.appendChild(ta); brief.appendChild(c);
  }
  // Goals (read-only-ish context; editable, no per-person framing)
  const goals = document.getElementById('goals');
  goals.innerHTML = '';
  if ((DATA.goals || []).length && filter === '__all__') {
    const c = document.createElement('section'); c.className = 'card';
    c.innerHTML = '<h2>🎯 Goals Review <span style="color:var(--mut);font-weight:400;font-size:12px">— status on the work, not on people</span></h2>';
    DATA.goals.forEach(g => {
      const d = document.createElement('div'); d.className = 'proj';
      d.textContent = g.priority;
      const r = document.createElement('div'); r.className = 'goal-read';
      const ta = document.createElement('textarea'); ta.className = 'txt'; ta.rows = 1;
      ta.value = g.read; ta.oninput = () => g.read = ta.value;
      c.append(d); c.append(ta);
    });
    goals.appendChild(c);
  }
  // Deadlines
  const deadlines = document.getElementById('deadlines');
  deadlines.innerHTML = '';
  if ((DATA.deadlines || []).length && filter === '__all__') {
    const c = document.createElement('section'); c.className = 'card';
    c.innerHTML = '<h2>📅 Upcoming Deadlines</h2>';
    DATA.deadlines.forEach(t => {
      const d = document.createElement('div'); d.className = 'dl' + (t.pastDue ? ' past' : '');
      const link = t.url ? '<a href="' + t.url + '" target="_blank" rel="noopener">' + (t.text) + '</a>' : t.text;
      d.innerHTML = (t.pastDue ? '⏳ past due — worth a check-in: ' : '• ') + link +
        ' <span style="color:var(--mut)">— ' + (t.date||'') + (t.owner ? ' · ' + t.owner : '') + '</span>';
      c.appendChild(d);
    });
    deadlines.appendChild(c);
  }
  // Members
  const wrap = document.getElementById('members');
  wrap.innerHTML = '';
  (DATA.members || []).forEach(m => {
    if (filter !== '__all__' && m.slug !== filter) return;
    const c = document.createElement('section'); c.className = 'card';
    const h = document.createElement('h2');
    h.innerHTML = '🌱 <span class="owner">' + (m.name || m.slug) + '</span>';
    c.appendChild(h);
    (m.projects || []).forEach(p => {
      const ph = document.createElement('div'); ph.className = 'proj'; ph.textContent = p.project;
      c.appendChild(ph);
      p.items = p.items || [];
      const real = p.items.filter(i => !i._added);
      if (!real.length && !p.items.some(i => i._added)) {
        const inv = document.createElement('div'); inv.className = 'invite';
        inv.textContent = '— space for ' + (m.name || m.slug) + "'s update —";
        c.appendChild(inv);
      }
      p.items.forEach(i => c.appendChild(itemRow(i, i._added)));
      const add = document.createElement('button'); add.className = 'add';
      add.textContent = '+ add work the bot missed';
      add.onclick = () => { p.items.push({ text: '', _added: true }); render(); };
      c.appendChild(add);
    });
    wrap.appendChild(c);
  });
}

// --- Serialize corrections into a Breadrich-ready message ---
function buildMessage(slugs) {
  const lines = ['Weekly agenda update — ' + (DATA.week || '') + ' (corrected via the agenda page)', ''];
  (DATA.members || []).forEach(m => {
    if (!slugs.includes(m.slug)) return;
    (m.projects || []).forEach(p => {
      const kept = (p.items || []).filter(i => !i._removed && (i.text || '').trim());
      lines.push('**' + p.project + '** (' + (m.name || m.slug) + '):');
      if (!kept.length) lines.push('- (nothing to add this week)');
      kept.forEach(i => lines.push('- ' + i.text.trim() + (i.ref ? ' (' + i.ref + ')' : '')));
      lines.push('');
    });
  });
  return lines.join('\\n').trim();
}

function copy(text) {
  const done = () => showToast('Copied! Paste it to Breadrich (a DM works).');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t);
  t.select(); try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(t); done();
}
let toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

document.getElementById('copyMine').onclick = () => {
  const slugs = filter === '__all__' ? (DATA.members || []).map(m => m.slug) : [filter];
  if (filter === '__all__') showToast('Tip: filter to your name first — copying everyone.');
  copy(buildMessage(slugs));
};
document.getElementById('copyAll').onclick = () => copy(buildMessage((DATA.members || []).map(m => m.slug)));

render();
</script>
</body>
</html>`;
}

// --- CLI ---
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const inPath = process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), 'sample.json');
  const outPath = process.argv[3] || inPath.replace(/\.json$/, '.html');
  const data = JSON.parse(fs.readFileSync(inPath, 'utf-8'));
  fs.writeFileSync(outPath, renderAgendaPage(data));
  console.log('wrote ' + outPath);
}
