import express from 'express';
import basicAuth from 'express-basic-auth';
import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { marked } from 'marked';
import { createRequire } from 'module';
// better-sqlite3 is in the parent /opt/breadbrich/node_modules, not kb-ui's
let Database;
try { Database = (await import('better-sqlite3')).default; } catch {
  try { const r = createRequire(import.meta.url); Database = r('better-sqlite3'); } catch {
    try { const r = createRequire('/opt/breadbrich/package.json'); Database = r('better-sqlite3'); } catch { Database = null; }
  }
}
import { createAppsRouter } from './apps.mjs';
const require = createRequire(import.meta.url);

const app = express();
app.use(express.json());
const PORT = process.env.KB_PORT || 8080;
const CONTEXT_DIR = process.env.CONTEXT_DIR || '/opt/breadbrich/groups/slack_main/context';

// --- Auth & Users ---
// Role membership is driven by env vars (comma-separated lowercase usernames).
// All four are required for full functionality; unset = empty role.
const splitCsv = (v) => (v || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const ADMINS = splitCsv(process.env.KB_ADMINS);
const SUPERADMINS = splitCsv(process.env.KB_SUPERADMINS);
const COORDINATORS = splitCsv(process.env.KB_COORDINATORS);
const RESIDENTS = splitCsv(process.env.KB_RESIDENTS);

if (ADMINS.length === 0) {
  console.warn('[kb-ui] KB_ADMINS not set — no admin access available');
}

const USERS_FILE = process.env.USERS_FILE || '/opt/breadbrich/kb-ui/users.json';

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
  } catch {
    return { admin: process.env.KB_DEFAULT_PASSWORD || 'changeme' };
  }
}

app.use(basicAuth({
  authorizer: (username, password) => {
    const users = loadUsers();
    return users[username] && basicAuth.safeCompare(password, users[username]);
  },
  authorizeAsync: false,
  challenge: true,
  realm: 'Breadbrich Engels Knowledge Base',
}));

function isAdmin(username) {
  return ADMINS.includes(username.toLowerCase());
}

function isSuperAdmin(username) {
  return SUPERADMINS.includes(username.toLowerCase());
}

function isCoordinator(username) {
  return COORDINATORS.includes(username.toLowerCase());
}

function isResident(username) {
  return RESIDENTS.includes(username.toLowerCase());
}

// --- File reading ---

function readDoc(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const { data: frontmatter, content } = matter(raw);
  return { frontmatter, content, raw };
}

function canView(frontmatter, username) {
  const visibility = frontmatter.visibility || 'open';
  if (visibility === 'open') return true;
  if (isAdmin(username)) return true;
  if (frontmatter.created_by && frontmatter.created_by.toLowerCase() === username.toLowerCase()) return true;
  return false;
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function walkDir(dir, basePath = '') {
  const entries = [];
  if (!fs.existsSync(dir)) return entries;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, item.name);
    const relPath = path.join(basePath, item.name);
    if (item.isDirectory()) {
      entries.push(...walkDir(fullPath, relPath));
    } else if (item.name.endsWith('.md')) {
      entries.push({ fullPath, relPath, name: item.name });
    }
  }
  return entries;
}

// --- HTML Templates ---

const CATEGORY_ICONS = {
  people: '\u{1F465}',
  tasks: '\u{2705}',
  artifacts: '\u{1F4E6}',
  calendar: '\u{1F4C5}',
  spaces: '\u{1F3E0}',
};

const CATEGORY_LABELS = { calendar: "Events" };

const VISIBILITY_BADGES = {
  open: '<span class="badge open">Open</span>',
  restricted: '<span class="badge restricted">Restricted</span>',
  private: '<span class="badge private">Private</span>',
};

function layout(title, body, username) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} \u2014 Breadbrich Engels</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e0e0e0; min-height: 100vh; }
  a { color: #7eb8da; text-decoration: none; }
  a:hover { text-decoration: underline; }

  .topbar { background: #111; border-bottom: 1px solid #222; padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; }
  .topbar h1 { font-size: 18px; font-weight: 600; color: #fff; }
  .topbar .user { font-size: 13px; color: #888; }
  .topbar .user .role { color: #f0c040; margin-left: 6px; }

  .container { max-width: 960px; margin: 0 auto; padding: 24px; }

  .nav { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; margin-bottom: 32px; }
  .nav-card { background: #161616; border: 1px solid #252525; border-radius: 8px; padding: 16px; transition: border-color 0.15s; }
  .nav-card:hover { border-color: #444; text-decoration: none; }
  .nav-card .icon { font-size: 28px; margin-bottom: 8px; }
  .nav-card .label { font-size: 15px; font-weight: 500; color: #ddd; }
  .nav-card .count { font-size: 12px; color: #666; margin-top: 4px; }

  .breadcrumb { font-size: 13px; color: #666; margin-bottom: 16px; }
  .breadcrumb a { color: #888; }

  .doc-list { list-style: none; }
  .doc-list li { background: #131313; border: 1px solid #222; border-radius: 6px; margin-bottom: 8px; }
  .doc-list li a { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; }
  .doc-list li:hover { border-color: #383838; }
  .doc-title { font-weight: 500; color: #ddd; }
  .doc-meta { font-size: 12px; color: #555; display: flex; gap: 10px; align-items: center; }

  .badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 500; }
  .badge.open { background: #1a3a1a; color: #5cb85c; }
  .badge.restricted { background: #3a3a1a; color: #f0ad4e; }
  .badge.private { background: #3a1a1a; color: #d9534f; }
  .badge.super { background: #1a1a3a; color: #7e7eda; }

  .doc-content { background: #131313; border: 1px solid #222; border-radius: 8px; padding: 24px 28px; line-height: 1.7; }
  .doc-content h1 { font-size: 22px; margin-bottom: 12px; color: #fff; }
  .doc-content h2 { font-size: 17px; margin: 20px 0 8px; color: #ccc; border-bottom: 1px solid #222; padding-bottom: 6px; }
  .doc-content h3 { font-size: 15px; margin: 16px 0 6px; color: #bbb; }
  .doc-content ul, .doc-content ol { padding-left: 24px; margin: 8px 0; }
  .doc-content li { margin: 4px 0; }
  .doc-content code { background: #1a1a2e; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
  .doc-content pre { background: #0d0d1a; padding: 14px; border-radius: 6px; overflow-x: auto; margin: 12px 0; }
  .doc-content pre code { background: none; padding: 0; }
  .doc-content table { width: 100%; border-collapse: collapse; margin: 12px 0; }
  .doc-content th, .doc-content td { border: 1px solid #222; padding: 8px 12px; text-align: left; }
  .doc-content th { background: #1a1a1a; color: #aaa; font-weight: 500; }
  .doc-content strong { color: #fff; }
  .doc-content blockquote { border-left: 3px solid #333; padding-left: 14px; color: #888; margin: 12px 0; }

  .frontmatter-bar { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; padding: 12px 16px; background: #0f0f0f; border: 1px solid #1a1a1a; border-radius: 6px; font-size: 13px; color: #666; }
  .frontmatter-bar .fm-item { display: flex; gap: 4px; }
  .frontmatter-bar .fm-label { color: #555; }
  .frontmatter-bar .fm-value { color: #999; }

  .tag { display: inline-block; background: #1a1a2e; color: #7eb8da; font-size: 11px; padding: 2px 8px; border-radius: 10px; margin-right: 4px; }

  .section-header { color: #fff; margin-bottom: 16px; font-size: 18px; display: flex; align-items: center; gap: 8px; }

  .empty { text-align: center; padding: 48px; color: #444; font-style: italic; }

  .filter-bar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; align-items: center; }
  .filter-input { flex: 1; min-width: 200px; background: #131313; border: 1px solid #2a2a2a; border-radius: 6px; padding: 8px 12px; color: #ddd; font-size: 13px; font-family: inherit; }
  .filter-input:focus { outline: none; border-color: #4a9eda; }
  .filter-select { background: #131313; border: 1px solid #2a2a2a; border-radius: 6px; padding: 8px 12px; color: #ddd; font-size: 13px; font-family: inherit; cursor: pointer; }
  .filter-clear { background: transparent; border: 1px solid #2a2a2a; border-radius: 6px; padding: 8px 14px; color: #888; font-size: 12px; cursor: pointer; font-family: inherit; }
  .filter-clear:hover { border-color: #444; color: #ccc; }

  .tag-bar { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
  .tag-chip { background: #161616; border: 1px solid #252525; color: #888; font-size: 11px; padding: 4px 10px; border-radius: 12px; cursor: pointer; font-family: inherit; transition: border-color 0.15s, color 0.15s; }
  .tag-chip:hover { border-color: #444; color: #ccc; }
  .tag-chip.active { background: #1a1a2e; border-color: #4a9eda; color: #7eb8da; }

  .artifact-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
  .artifact-card { display: block; background: #131313; border: 1px solid #222; border-radius: 8px; padding: 14px 16px; transition: border-color 0.15s; text-decoration: none; }
  .artifact-card:hover { border-color: #383838; text-decoration: none; }
  .artifact-card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; margin-bottom: 8px; }
  .artifact-title { font-weight: 500; color: #ddd; font-size: 14px; line-height: 1.4; }
  .artifact-excerpt { font-size: 12px; color: #666; line-height: 1.5; margin-bottom: 10px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .artifact-meta { font-size: 11px; color: #555; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .artifact-meta-sep { flex: 0 0 100%; height: 0; }
  .folder-pill { background: #1a2a1a; color: #6a9a6a; padding: 1px 6px; border-radius: 8px; font-size: 10px; }

  .artifact-group { margin-bottom: 24px; }
  .artifact-group-head { font-size: 13px; color: #888; font-weight: 500; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid #1a1a1a; display: flex; align-items: center; gap: 8px; }
  .artifact-group-count { font-size: 11px; color: #555; background: #1a1a1a; padding: 2px 8px; border-radius: 10px; }

  @media (max-width: 600px) {
    .nav { grid-template-columns: 1fr 1fr; }
    .container { padding: 16px; }
    .artifact-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
  <div class="topbar">
    <h1><a href="/" style="color:#fff">Breadbrich Engels</a></h1>
    <div class="user">${username} ${isSuperAdmin(username) ? '<span class="role">admin</span> <span class="role" style="color:#7e7eda">super</span>' : isCoordinator(username) ? '<span class="role" style="color:#e0a050">coordinator</span>' : isAdmin(username) ? '<span class="role">admin</span>' : isResident(username) ? '<span class="role" style="color:#34d399">resident</span>' : ''}</div>
  </div>
  <div class="container">${body}</div>
</body>
</html>`;
}

// --- Routes ---

app.get('/', (req, res) => {
  const username = req.auth.user;
  const categories = ['people', 'tasks', 'artifacts', 'calendar', 'spaces'];

  // Count items per category
  const catCounts = {};
  for (const cat of categories) {
    const catDir = path.join(CONTEXT_DIR, cat);
    const files = walkDir(catDir);
    const viewable = files.filter(f => {
      if (f.name === 'README.md') return false;
      try {
        const { frontmatter } = readDoc(f.fullPath);
        return canView(frontmatter, username);
      } catch { return true; }
    });
    catCounts[cat] = viewable.length;
  }

  // --- Dashboards section ---
  let dashboardCards = '';
  dashboardCards += `<a href="/projects" class="nav-card" style="border-color:#1a2a1a"><div class="icon">\u{1F4CA}</div><div class="label">Projects</div><div class="count">Project tracker</div></a>`;
  dashboardCards += `<a href="/events" class="nav-card" style="border-color:#2a1a2a"><div class="icon">\u{1F389}</div><div class="label">Events</div><div class="count">Manage events</div></a>`;
  dashboardCards += `<a href="/tours" class="nav-card" style="border-color:#1a2a1a"><div class="icon">\u{1F6B6}</div><div class="label">Tours</div><div class="count">Tour scheduling</div></a>`;
  dashboardCards += `<a href="/residency" class="nav-card" style="border-color:#2a2a1a"><div class="icon">\u{1F3E0}</div><div class="label">Residency</div><div class="count">Room management</div></a>`;
  dashboardCards += `<a href="/map" class="nav-card" style="border-color:#2a1a2a"><div class="icon">\u{1F3D7}\u{FE0F}</div><div class="label">Building Map</div><div class="count">3D floor plans + tasks</div></a>`;

  // --- Raw Data section ---
  let rawDataCards = '';
  for (const cat of categories) {
    const icon = CATEGORY_ICONS[cat] || '\u{1F4C4}';
    const label = CATEGORY_LABELS[cat] || (cat.charAt(0).toUpperCase() + cat.slice(1));
    rawDataCards += `<a href="/category/${cat}" class="nav-card"><div class="icon">${icon}</div><div class="label">${label}</div><div class="count">${catCounts[cat]} item${catCounts[cat] !== 1 ? 's' : ''}</div></a>`;
  }

  rawDataCards += `<a href="/linkages" class="nav-card" style="border-color:#1a2a2a"><div class="icon">🔗</div><div class="label">Linkages</div><div class="count">Tasks ↔ Events</div></a>`;
  // --- Admin section ---
  let adminCards = '';
  if (isAdmin(username)) {
    adminCards += `<a href="/logs" class="nav-card" style="border-color:#2a2a1a"><div class="icon">\u{1F4CB}</div><div class="label">Request Logs</div><div class="count">All Breadbrich Engels requests</div></a>`;
    adminCards += `<a href="/architecture" class="nav-card" style="border-color:#1a1a2a"><div class="icon">\u{1F3D7}\u{FE0F}</div><div class="label">Architecture</div><div class="count">System diagram</div></a>`;
  }
  if (isSuperAdmin(username)) {
    adminCards += `<a href="/admin" class="nav-card" style="border-color:#333"><div class="icon">\u{1F512}</div><div class="label">Admin</div><div class="count">Permissions & access</div></a>`;
  }

  // Read index.md for summary
  let summary = '';
  const indexPath = path.join(CONTEXT_DIR, 'index.md');
  if (fs.existsSync(indexPath)) {
    const { content } = readDoc(indexPath);
    summary = `<div class="doc-content" style="margin-top:24px">${marked(content)}</div>`;
  }

  let body = '<h2 class="section-header">\u{1F4CA} Dashboards</h2>';
  body += `<div class="nav">${dashboardCards}</div>`;
  body += '<h2 class="section-header" style="margin-top:8px">\u{1F4C2} Raw Data</h2>';
  body += `<div class="nav">${rawDataCards}</div>`;
  if (adminCards) {
    body += '<h2 class="section-header" style="margin-top:8px">\u{1F512} Admin</h2>';
    body += `<div class="nav">${adminCards}</div>`;
  }
  body += summary;

  res.send(layout('Home', body, username));
});

app.get('/category/:name', (req, res) => {
  const username = req.auth.user;
  const cat = req.params.name;
  const catDir = path.join(CONTEXT_DIR, cat);

  if (!fs.existsSync(catDir)) {
    res.status(404).send(layout('Not Found', '<p class="empty">Category not found.</p>', username));
    return;
  }

  const files = walkDir(catDir);
  const icon = CATEGORY_ICONS[cat] || '\u{1F4C4}';

  // Special swimlane view for tasks
  if (cat === 'tasks') {
    const priorityOrder = ['critical', 'high', 'medium', 'low'];
    const priorityLabels = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
    const priorityColors = { critical: '#d9534f', high: '#e0a050', medium: '#4a9eda', low: '#666' };
    const statusColors = { open: '#5cb85c', in_progress: '#4a9eda', blocked: '#d9534f', done: '#555', cancelled: '#444' };
    const lanes = { critical: [], high: [], medium: [], low: [] };

    for (const f of files) {
      if (f.name === 'README.md' || f.name === 'active.md') continue;
      let fm = {};
      try { fm = readDoc(f.fullPath).frontmatter; } catch {}
      if (!canView(fm, username)) continue;
      const p = lanes.hasOwnProperty(fm.priority) ? fm.priority : 'medium';
      lanes[p].push({ ...fm, file: f.name });
    }

    let swimlanes = '';
    for (const p of priorityOrder) {
      const tasks = lanes[p] || [];
      const color = priorityColors[p];
      let cards = '';
      if (tasks.length === 0) {
        cards = '<div style="padding:16px;color:#444;font-style:italic;font-size:13px">No tasks</div>';
      } else {
        for (const t of tasks) {
          const title = esc(t.title || t.file.replace('.md', ''));
          const sColor = statusColors[t.status] || '#888';
          const owners = esc((t.owners || []).join(', '));
          const dates = esc([t.start_date, t.end_date].filter(Boolean).join(' \u2192 '));
          cards += `<a href="/doc/tasks/${encodeURIComponent(t.file)}" style="text-decoration:none;display:block;background:#131313;border:1px solid #222;border-left:3px solid ${sColor};border-radius:6px;padding:10px 14px;margin-bottom:6px;transition:border-color 0.15s">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span style="font-size:11px;color:#555;font-weight:600">${esc(t.id)}</span>
              <span style="font-size:10px;color:${sColor};text-transform:uppercase;font-weight:600">${esc((t.status || 'open').replace('_', ' '))}</span>
            </div>
            <div style="color:#ddd;font-size:13px;font-weight:500;margin:4px 0">${title}</div>
            <div style="display:flex;justify-content:space-between;font-size:11px;color:#555">
              <span>${owners || 'Unassigned'}</span>
              <span>${dates}</span>
            </div>
          </a>`;
        }
      }
      swimlanes += `<div style="flex:1;min-width:220px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding-bottom:8px;border-bottom:2px solid ${color}">
          <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color}"></span>
          <span style="font-size:14px;font-weight:600;color:#ddd">${priorityLabels[p]}</span>
          <span style="font-size:12px;color:#555">(${tasks.length})</span>
        </div>
        ${cards}
      </div>`;
    }

    // --- Table view ---
    const allTasks = [];
    for (const p of priorityOrder) {
      for (const t of (lanes[p] || [])) {
        allTasks.push(t);
      }
    }

    // Build project ID -> name map
    const projectMap = {};
    const projDir = path.join(CONTEXT_DIR, 'projects');
    if (fs.existsSync(projDir)) {
      for (const pf of fs.readdirSync(projDir).filter(n => n.startsWith('PROJECT-') && n.endsWith('.md'))) {
        try {
          const { frontmatter: pfm } = readDoc(path.join(projDir, pf));
          const pid = pfm.id || pf.replace('.md', '');
          if (pfm.title) projectMap[pid] = pfm.title;
        } catch {}
      }
    }

    // Serialize tasks as JSON for client-side sorting/filtering
    const taskDataJson = JSON.stringify(allTasks.map(t => ({
      id: t.id || '',
      title: t.title || t.file || '',
      status: t.status || 'open',
      priority: t.priority || 'medium',
      owner: t.assigned_to || (t.owners || []).join(', ') || '',
      project: t.project ? (projectMap[t.project] || t.project) : '',
      created_at: t.created_at || '',
      created_by: t.created_by || '',
      updated_at: t.updated_at || t.created_at || '',
      file: t.file || '',
    }))).replace(/</g, '\\u003c');

    const statusLabels = { open: 'Open', in_progress: 'In Progress', blocked: 'Blocked', backlog: 'Backlog', closed: 'Closed', done: 'Done', cancelled: 'Cancelled' };

    const body = `
      <div class="breadcrumb"><a href="/">Home</a> / ${icon} Tasks</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h2 class="section-header" style="margin:0">Tasks</h2>
        <div style="display:flex;gap:8px;align-items:center">
          <a href="/projects" style="font-size:13px;color:#7eb8da;padding:6px 14px;border:1px solid #333;border-radius:6px;text-decoration:none">Projects</a>
        </div>
      </div>

      <!-- View toggle -->
      <div style="display:flex;gap:0;margin-bottom:16px;border:1px solid #333;border-radius:6px;overflow:hidden;width:fit-content">
        <button onclick="switchTaskView('board')" id="btn-board" style="padding:8px 16px;background:#222;color:#ddd;border:none;cursor:pointer;font-size:12px;font-weight:600;border-right:1px solid #333">Board</button>
        <button onclick="switchTaskView('table')" id="btn-table" style="padding:8px 16px;background:transparent;color:#888;border:none;cursor:pointer;font-size:12px;font-weight:600">Table</button>
      </div>

      <!-- Board view (swimlanes) -->
      <div id="view-board" style="display:flex;gap:16px;overflow-x:auto;padding-bottom:16px">${swimlanes}</div>

      <!-- Table view -->
      <div id="view-table" style="display:none">
        <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
          <!-- Grouping buttons -->
          <div style="display:flex;gap:0;border:1px solid #333;border-radius:6px;overflow:hidden">
            <button onclick="switchGrouping('priority')" id="grp-priority" class="grp-btn" style="padding:6px 14px;background:#1a1a2e;color:#ddd;border:none;cursor:pointer;font-size:11px;font-weight:600;border-right:1px solid #333">By Priority</button>
            <button onclick="switchGrouping('status')" id="grp-status" class="grp-btn" style="padding:6px 14px;background:transparent;color:#888;border:none;cursor:pointer;font-size:11px;font-weight:600;border-right:1px solid #333">By Status</button>
            <button onclick="switchGrouping('owner')" id="grp-owner" class="grp-btn" style="padding:6px 14px;background:transparent;color:#888;border:none;cursor:pointer;font-size:11px;font-weight:600;border-right:1px solid #333">By Owner</button>
            <button onclick="switchGrouping('project')" id="grp-project" class="grp-btn" style="padding:6px 14px;background:transparent;color:#888;border:none;cursor:pointer;font-size:11px;font-weight:600;border-right:1px solid #333">By Project</button>
            <button onclick="switchGrouping('none')" id="grp-none" class="grp-btn" style="padding:6px 14px;background:transparent;color:#888;border:none;cursor:pointer;font-size:11px;font-weight:600">Flat</button>
          </div>

          <!-- Filter closed checkbox -->
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#888;cursor:pointer;user-select:none">
            <input type="checkbox" id="filter-closed" checked onchange="renderTaskTable()" style="accent-color:#4a9eda">
            Hide closed
          </label>
        </div>

        <div style="overflow-x:auto">
          <table id="task-table" style="width:100%;border-collapse:collapse">
            <thead><tr style="border-bottom:2px solid #333">
              <th onclick="sortTable('id')" style="text-align:left;padding:8px 10px;color:#888;font-size:11px;font-weight:600;cursor:pointer;user-select:none;white-space:nowrap">ID <span id="sort-id" style="color:#555">↕</span></th>
              <th onclick="sortTable('title')" style="text-align:left;padding:8px 10px;color:#888;font-size:11px;font-weight:600;cursor:pointer;user-select:none">Title <span id="sort-title" style="color:#555">↕</span></th>
              <th onclick="sortTable('status')" style="text-align:left;padding:8px 10px;color:#888;font-size:11px;font-weight:600;cursor:pointer;user-select:none">Status <span id="sort-status" style="color:#555">↕</span></th>
              <th onclick="sortTable('priority')" style="text-align:left;padding:8px 10px;color:#888;font-size:11px;font-weight:600;cursor:pointer;user-select:none">Priority <span id="sort-priority" style="color:#555">↕</span></th>
              <th onclick="sortTable('owner')" style="text-align:left;padding:8px 10px;color:#888;font-size:11px;font-weight:600;cursor:pointer;user-select:none">Owner <span id="sort-owner" style="color:#555">↕</span></th>
              <th onclick="sortTable('project')" style="text-align:left;padding:8px 10px;color:#888;font-size:11px;font-weight:600;cursor:pointer;user-select:none">Project <span id="sort-project" style="color:#555">↕</span></th>
              <th onclick="sortTable('created_at')" style="text-align:left;padding:8px 10px;color:#888;font-size:11px;font-weight:600;cursor:pointer;user-select:none;white-space:nowrap">Created <span id="sort-created_at" style="color:#555">↕</span></th>
              <th onclick="sortTable('created_by')" style="text-align:left;padding:8px 10px;color:#888;font-size:11px;font-weight:600;cursor:pointer;user-select:none;white-space:nowrap">By <span id="sort-created_by" style="color:#555">↕</span></th>
              <th onclick="sortTable('updated_at')" style="text-align:left;padding:8px 10px;color:#888;font-size:11px;font-weight:600;cursor:pointer;user-select:none;white-space:nowrap">Updated <span id="sort-updated_at" style="color:#555">↕</span></th>
            </tr></thead>
            <tbody id="task-tbody"></tbody>
          </table>
        </div>
      </div>

      <script>
      var _taskData = ${taskDataJson};
      var _currentGroup = 'priority';
      var _sortField = null;
      var _sortAsc = true;

      var _priorityOrder = {critical:0, high:1, medium:2, low:3};
      var _statusOrder = {open:0, in_progress:1, blocked:2, backlog:3, done:4, closed:5, cancelled:6};
      var _priorityColors = {critical:'#d9534f', high:'#e0a050', medium:'#4a9eda', low:'#666'};
      var _statusColors = {open:'#5cb85c', in_progress:'#4a9eda', blocked:'#d9534f', backlog:'#888', done:'#555', closed:'#555', cancelled:'#444'};
      var _groupColors = {priority: _priorityColors, status: _statusColors};

      function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

      function sortTable(field) {
        if (_sortField === field) { _sortAsc = !_sortAsc; }
        else { _sortField = field; _sortAsc = true; }
        renderTaskTable();
      }

      function renderTaskTable() {
        var filterClosed = document.getElementById('filter-closed').checked;
        var tasks = _taskData.filter(function(t) {
          if (filterClosed && (t.status === 'closed' || t.status === 'done' || t.status === 'cancelled')) return false;
          return true;
        });

        // Sort if a sort field is set
        if (_sortField) {
          tasks = tasks.slice().sort(function(a, b) {
            var va = a[_sortField] || '';
            var vb = b[_sortField] || '';
            // Special ordering for priority and status
            if (_sortField === 'priority') { va = _priorityOrder[va] !== undefined ? _priorityOrder[va] : 99; vb = _priorityOrder[vb] !== undefined ? _priorityOrder[vb] : 99; }
            else if (_sortField === 'status') { va = _statusOrder[va] !== undefined ? _statusOrder[va] : 99; vb = _statusOrder[vb] !== undefined ? _statusOrder[vb] : 99; }
            else { va = String(va).toLowerCase(); vb = String(vb).toLowerCase(); }
            if (va < vb) return _sortAsc ? -1 : 1;
            if (va > vb) return _sortAsc ? 1 : -1;
            return 0;
          });
        }

        // Update sort indicators
        ['id','title','status','priority','owner','project','created_at','created_by','updated_at'].forEach(function(f) {
          var el = document.getElementById('sort-' + f);
          if (el) el.textContent = f === _sortField ? (_sortAsc ? '↑' : '↓') : '↕';
          if (el) el.style.color = f === _sortField ? '#ddd' : '#555';
        });

        // Group tasks
        var groups = {};
        var groupField = _currentGroup;
        if (groupField === 'none') {
          groups['all'] = tasks;
        } else {
          tasks.forEach(function(t) {
            var key;
            if (groupField === 'owner') key = t.owner || 'unassigned';
            else key = t[groupField] || 'unknown';
            if (!groups[key]) groups[key] = [];
            groups[key].push(t);
          });
        }

        // Sort group keys
        var keys = Object.keys(groups);
        if (groupField === 'priority') keys.sort(function(a,b) { return (_priorityOrder[a]||99) - (_priorityOrder[b]||99); });
        else if (groupField === 'status') keys.sort(function(a,b) { return (_statusOrder[a]||99) - (_statusOrder[b]||99); });
        else keys.sort();

        var html = '';
        keys.forEach(function(key) {
          var items = groups[key];
          if (groupField !== 'none') {
            var colorMap = _groupColors[groupField] || {};
            var color = colorMap[key] || '#888';
            var label = key.replace(/_/g, ' ');
            html += '<tr><td colspan="9" style="background:#0a0a0a;padding:10px 14px;border-bottom:2px solid ' + color + ';font-weight:600;color:#ddd;text-transform:capitalize">'
              + '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + color + ';margin-right:8px"></span>'
              + esc(label) + ' <span style="color:#555;font-weight:400">(' + items.length + ')</span></td></tr>';
          }
          items.forEach(function(t) {
            var sColor = _statusColors[t.status] || '#888';
            var pColor = _priorityColors[t.priority] || '#888';
            html += '<tr style="border-bottom:1px solid #1a1a1a">'
              + '<td style="padding:8px 10px;font-size:11px;color:#555;font-weight:600;white-space:nowrap"><a href="/doc/tasks/' + encodeURIComponent(t.file) + '" style="color:#555;text-decoration:none">' + esc(t.id) + '</a></td>'
              + '<td style="padding:8px 10px"><a href="/doc/tasks/' + encodeURIComponent(t.file) + '" style="color:#ddd;text-decoration:none;font-size:13px">' + esc(t.title) + '</a></td>'
              + '<td style="padding:8px 10px;font-size:11px;text-transform:uppercase;font-weight:600;color:' + sColor + '">' + esc(t.status.replace(/_/g, ' ')) + '</td>'
              + '<td style="padding:8px 10px;font-size:11px;color:' + pColor + '">' + esc(t.priority) + '</td>'
              + '<td style="padding:8px 10px;font-size:12px;color:#888">' + esc(t.owner) + '</td>'
              + '<td style="padding:8px 10px;font-size:11px;color:#555">' + esc(t.project) + '</td>'
              + '<td style="padding:8px 10px;font-size:11px;color:#555;white-space:nowrap">' + esc(t.created_at) + '</td>'
              + '<td style="padding:8px 10px;font-size:11px;color:#555">' + esc(t.created_by) + '</td>'
              + '<td style="padding:8px 10px;font-size:11px;color:#555;white-space:nowrap">' + esc(t.updated_at) + '</td>'
              + '</tr>';
          });
        });

        document.getElementById('task-tbody').innerHTML = html;
      }

      function switchTaskView(view) {
        document.getElementById('view-board').style.display = view === 'board' ? 'flex' : 'none';
        document.getElementById('view-table').style.display = view === 'table' ? 'block' : 'none';
        document.getElementById('btn-board').style.background = view === 'board' ? '#222' : 'transparent';
        document.getElementById('btn-board').style.color = view === 'board' ? '#ddd' : '#888';
        document.getElementById('btn-table').style.background = view === 'table' ? '#222' : 'transparent';
        document.getElementById('btn-table').style.color = view === 'table' ? '#ddd' : '#888';
        if (view === 'table') renderTaskTable();
      }

      function switchGrouping(group) {
        _currentGroup = group;
        ['priority','status','owner','project','none'].forEach(function(g) {
          var el = document.getElementById('grp-' + g);
          if (el) { el.style.background = g === group ? '#1a1a2e' : 'transparent'; el.style.color = g === group ? '#ddd' : '#888'; }
        });
        renderTaskTable();
      }
      // --- Notion-like table enhancements ---
      (function() {
        var table = document.getElementById('task-table');
        if (!table) return;
        var thead = table.querySelector('thead tr');
        if (!thead) return;
        var ths = Array.from(thead.querySelectorAll('th'));

        // Inject styles
        var style = document.createElement('style');
        style.textContent = [
          '#task-table { table-layout:fixed; }',
          '#task-table td { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; transition:white-space 0.1s; }',
          '#task-table td.wrap-on { white-space:normal; word-break:break-word; }',
          '#task-table thead th { position:sticky; top:0; z-index:5; background:#0d0d0d; }',
          '#task-table tbody tr:hover td { background:#1a1a2e !important; }',
          '#task-table tbody tr { transition:background 0.1s; }',
          '.col-menu { position:absolute; right:20px; top:50%; transform:translateY(-50%); display:none; cursor:pointer; font-size:10px; color:#555; padding:2px 4px; border-radius:3px; z-index:6; }',
          '.col-menu:hover { color:#ddd; background:#333; }',
          'th:hover .col-menu { display:inline-block; }',
          '.col-dropdown { position:absolute; top:100%; right:0; background:#1a1a1a; border:1px solid #333; border-radius:6px; padding:4px 0; z-index:20; min-width:140px; box-shadow:0 4px 12px rgba(0,0,0,0.5); display:none; }',
          '.col-dropdown.open { display:block; }',
          '.col-dropdown-item { padding:6px 12px; font-size:11px; color:#ccc; cursor:pointer; display:flex; align-items:center; gap:6px; }',
          '.col-dropdown-item:hover { background:#222; }',
          '.col-dropdown-item .icon { width:14px; text-align:center; font-size:12px; }',
          '.resize-handle { position:absolute; right:0; top:0; bottom:0; width:5px; cursor:col-resize; z-index:10; }',
          '.resize-handle:hover, .resize-handle.active { border-right:2px solid #4a9eda; }',
          // Density
          '#task-table.density-compact td, #task-table.density-compact th { padding:4px 8px !important; font-size:11px !important; }',
          '#task-table.density-comfortable td, #task-table.density-comfortable th { padding:10px 12px !important; }',
          // Search
          '#task-search { background:#111; border:1px solid #333; color:#ddd; padding:6px 10px; border-radius:6px; font-size:12px; width:200px; outline:none; }',
          '#task-search:focus { border-color:#4a9eda; }',
          '#task-search::placeholder { color:#555; }',
        ].join('');
        document.head.appendChild(style);

        // Track column state
        var colState = {};
        var colKeys = ['id','title','status','priority','owner','project','created_at','created_by','updated_at'];
        colKeys.forEach(function(k) {
          colState[k] = { wrap: false, visible: true };
        });

        // Default widths
        var defaultWidths = [70, 0, 90, 80, 100, 140, 90, 80, 90];
        ths.forEach(function(th, i) {
          if (defaultWidths[i] > 0) th.style.width = defaultWidths[i] + 'px';
          th.style.position = 'relative';
          th.style.overflow = 'visible';
        });

        // Add column menus and resize handles
        ths.forEach(function(th, i) {
          var colKey = colKeys[i];

          // Column dropdown menu button
          var menuBtn = document.createElement('span');
          menuBtn.className = 'col-menu';
          menuBtn.textContent = '⋮';
          menuBtn.onclick = function(e) {
            e.stopPropagation();
            // Close any open dropdowns
            document.querySelectorAll('.col-dropdown.open').forEach(function(d) { d.classList.remove('open'); });
            dropdown.classList.toggle('open');
          };
          th.appendChild(menuBtn);

          // Dropdown menu
          var dropdown = document.createElement('div');
          dropdown.className = 'col-dropdown';

          // Wrap text toggle
          var wrapItem = document.createElement('div');
          wrapItem.className = 'col-dropdown-item';
          wrapItem.innerHTML = '<span class="icon">↩</span><span>Wrap text</span>';
          wrapItem.onclick = function(e) {
            e.stopPropagation();
            colState[colKey].wrap = !colState[colKey].wrap;
            applyWrap(i, colState[colKey].wrap);
            wrapItem.innerHTML = '<span class="icon">' + (colState[colKey].wrap ? '✓' : '↩') + '</span><span>Wrap text</span>';
            dropdown.classList.remove('open');
          };
          dropdown.appendChild(wrapItem);

          // Hide column
          if (colKey !== 'title') { // Don't allow hiding title
            var hideItem = document.createElement('div');
            hideItem.className = 'col-dropdown-item';
            hideItem.innerHTML = '<span class="icon">👁</span><span>Hide column</span>';
            hideItem.onclick = function(e) {
              e.stopPropagation();
              colState[colKey].visible = false;
              applyVisibility();
              dropdown.classList.remove('open');
              updateHiddenColumnsBar();
            };
            dropdown.appendChild(hideItem);
          }

          // Sort asc
          var sortAscItem = document.createElement('div');
          sortAscItem.className = 'col-dropdown-item';
          sortAscItem.innerHTML = '<span class="icon">↑</span><span>Sort ascending</span>';
          sortAscItem.onclick = function(e) {
            e.stopPropagation();
            _sortField = colKey; _sortAsc = true;
            renderTaskTable();
            dropdown.classList.remove('open');
          };
          dropdown.appendChild(sortAscItem);

          // Sort desc
          var sortDescItem = document.createElement('div');
          sortDescItem.className = 'col-dropdown-item';
          sortDescItem.innerHTML = '<span class="icon">↓</span><span>Sort descending</span>';
          sortDescItem.onclick = function(e) {
            e.stopPropagation();
            _sortField = colKey; _sortAsc = false;
            renderTaskTable();
            dropdown.classList.remove('open');
          };
          dropdown.appendChild(sortDescItem);

          th.appendChild(dropdown);

          // Resize handle
          if (i < ths.length - 1) {
            var handle = document.createElement('div');
            handle.className = 'resize-handle';
            handle.addEventListener('mousedown', function(e) {
              e.preventDefault();
              e.stopPropagation();
              handle.classList.add('active');
              var startX = e.pageX;
              var startW = th.offsetWidth;
              var nextTh = ths[i + 1];
              var nextW = nextTh ? nextTh.offsetWidth : 0;
              function onMove(e2) {
                var dx = e2.pageX - startX;
                var newW = Math.max(40, startW + dx);
                th.style.width = newW + 'px';
                if (nextTh && nextW - dx > 40) nextTh.style.width = (nextW - dx) + 'px';
              }
              function onUp() {
                handle.classList.remove('active');
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
              }
              document.addEventListener('mousemove', onMove);
              document.addEventListener('mouseup', onUp);
            });
            th.appendChild(handle);
          }
        });

        // Close dropdowns on outside click
        document.addEventListener('click', function() {
          document.querySelectorAll('.col-dropdown.open').forEach(function(d) { d.classList.remove('open'); });
        });

        // Wrap text toggle
        function applyWrap(colIdx, wrap) {
          table.querySelectorAll('tbody tr').forEach(function(row) {
            var cells = row.querySelectorAll('td');
            if (cells[colIdx]) {
              if (wrap) cells[colIdx].classList.add('wrap-on');
              else cells[colIdx].classList.remove('wrap-on');
            }
          });
        }

        // Column visibility
        function applyVisibility() {
          colKeys.forEach(function(k, i) {
            var display = colState[k].visible ? '' : 'none';
            ths[i].style.display = display;
            table.querySelectorAll('tbody tr').forEach(function(row) {
              var cells = row.querySelectorAll('td');
              if (cells[i]) cells[i].style.display = display;
            });
          });
        }

        // Hidden columns bar
        function updateHiddenColumnsBar() {
          var bar = document.getElementById('hidden-cols-bar');
          if (!bar) {
            bar = document.createElement('div');
            bar.id = 'hidden-cols-bar';
            bar.style.cssText = 'margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;';
            table.parentNode.insertBefore(bar, table);
          }
          var hidden = colKeys.filter(function(k) { return !colState[k].visible; });
          if (hidden.length === 0) { bar.style.display = 'none'; return; }
          bar.style.display = 'flex';
          bar.innerHTML = '<span style="font-size:11px;color:#555">Hidden:</span>';
          hidden.forEach(function(k) {
            var chip = document.createElement('span');
            chip.style.cssText = 'font-size:11px;color:#888;background:#1a1a1a;border:1px solid #333;border-radius:4px;padding:2px 8px;cursor:pointer;';
            chip.textContent = k.replace(/_/g, ' ');
            chip.title = 'Click to show';
            chip.onclick = function() {
              colState[k].visible = true;
              applyVisibility();
              updateHiddenColumnsBar();
            };
            bar.appendChild(chip);
          });
        }

        // Re-apply wrap/visibility after table re-renders
        var origRender = window.renderTaskTable;
        window.renderTaskTable = function() {
          origRender();
          colKeys.forEach(function(k, i) {
            if (colState[k].wrap) applyWrap(i, true);
          });
          applyVisibility();
        };

        // Add search + density controls to the toolbar
        var toolbar = document.querySelector('#view-table > div:first-child');
        if (toolbar) {
          // Search
          var searchWrap = document.createElement('div');
          searchWrap.style.cssText = 'margin-left:auto;display:flex;gap:8px;align-items:center;';
          var searchInput = document.createElement('input');
          searchInput.type = 'text';
          searchInput.id = 'task-search';
          searchInput.placeholder = 'Search tasks...';
          searchInput.oninput = function() { filterBySearch(this.value); };
          searchWrap.appendChild(searchInput);

          // Density toggle
          var densityBtn = document.createElement('button');
          densityBtn.style.cssText = 'padding:4px 8px;background:transparent;border:1px solid #333;border-radius:4px;color:#888;cursor:pointer;font-size:11px;';
          densityBtn.textContent = '☰';
          densityBtn.title = 'Toggle density';
          var density = 0; // 0=default, 1=compact, 2=comfortable
          var densityNames = ['default','compact','comfortable'];
          densityBtn.onclick = function() {
            density = (density + 1) % 3;
            table.className = density > 0 ? 'density-' + densityNames[density] : '';
            densityBtn.title = densityNames[density];
          };
          searchWrap.appendChild(densityBtn);

          toolbar.appendChild(searchWrap);
        }

        // Search filter
        function filterBySearch(query) {
          var q = query.toLowerCase().trim();
          table.querySelectorAll('tbody tr').forEach(function(row) {
            if (row.querySelector('td[colspan]')) { row.style.display = ''; return; } // group headers
            var text = row.textContent.toLowerCase();
            row.style.display = q && text.indexOf(q) === -1 ? 'none' : '';
          });
        }
      })();
      </script>`;

    res.send(layout('Tasks', body, username));
    return;
  }

  // Rich filter/sort/group view for artifacts
  if (cat === 'artifacts') {
    const artifacts = [];
    for (const f of files) {
      if (f.name === 'README.md') continue;
      let fm = {};
      let content = '';
      try {
        const doc = readDoc(f.fullPath);
        fm = doc.frontmatter;
        content = doc.content;
      } catch {}
      if (!canView(fm, username)) continue;
      const folder = f.relPath.includes(path.sep) ? f.relPath.split(path.sep)[0] : '';
      artifacts.push({
        file: f.relPath,
        title: fm.title || f.name.replace('.md', ''),
        tags: Array.isArray(fm.tags) ? fm.tags : [],
        visibility: fm.visibility || 'open',
        created_by: fm.created_by || '',
        created_at: fm.created_at || '',
        folder,
        excerpt: content.replace(/^[#*\->\s]+/gm, ' ').replace(/\s+/g, ' ').trim().slice(0, 140),
      });
    }

    const artifactsJson = JSON.stringify(artifacts).replace(/</g, '\\u003c');

    const body = `
      <div class="breadcrumb"><a href="/">Home</a> / ${icon} Artifacts</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:12px">
        <h2 class="section-header" style="margin:0">Artifacts</h2>
        <div id="artifact-count" style="font-size:13px;color:#666"></div>
      </div>

      <div class="filter-bar">
        <input type="search" id="artifact-search" placeholder="Search title, creator, body..." class="filter-input" />
        <select id="artifact-visibility" class="filter-select">
          <option value="">All visibility</option>
          <option value="open">Open only</option>
          <option value="restricted">Restricted only</option>
          <option value="private">Private only</option>
        </select>
        <select id="artifact-sort" class="filter-select">
          <option value="date_desc">Newest first</option>
          <option value="date_asc">Oldest first</option>
          <option value="title_asc">Title A→Z</option>
          <option value="title_desc">Title Z→A</option>
          <option value="creator_asc">Creator A→Z</option>
        </select>
        <select id="artifact-group" class="filter-select">
          <option value="">No grouping</option>
          <option value="tag">Group by tag</option>
          <option value="folder">Group by folder</option>
          <option value="creator">Group by creator</option>
          <option value="visibility">Group by visibility</option>
        </select>
        <button id="artifact-clear" class="filter-clear">Clear</button>
      </div>

      <div id="artifact-tags" class="tag-bar"></div>
      <div id="artifact-list"></div>

      <script>
      (function() {
        const ARTIFACTS = JSON.parse(${JSON.stringify(artifactsJson)});
        const allTags = Array.from(new Set(ARTIFACTS.flatMap(a => a.tags))).sort();

        const state = { q: '', tags: new Set(), visibility: '', sort: 'date_desc', group: '' };

        function readHash() {
          const h = location.hash.startsWith('#') ? location.hash.slice(1) : '';
          if (!h) return;
          const params = new URLSearchParams(h);
          state.q = params.get('q') || '';
          state.visibility = params.get('visibility') || '';
          state.sort = params.get('sort') || 'date_desc';
          state.group = params.get('group') || '';
          const t = params.get('tags');
          state.tags = new Set(t ? t.split(',').filter(Boolean) : []);
        }

        function writeHash() {
          const params = new URLSearchParams();
          if (state.q) params.set('q', state.q);
          if (state.tags.size) params.set('tags', Array.from(state.tags).join(','));
          if (state.visibility) params.set('visibility', state.visibility);
          if (state.sort && state.sort !== 'date_desc') params.set('sort', state.sort);
          if (state.group) params.set('group', state.group);
          const h = params.toString();
          history.replaceState(null, '', h ? '#' + h : location.pathname + location.search);
        }

        function escHtml(s) {
          return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        function matches(a) {
          if (state.visibility && a.visibility !== state.visibility) return false;
          if (state.tags.size) {
            for (const t of state.tags) if (!a.tags.includes(t)) return false;
          }
          if (state.q) {
            const q = state.q.toLowerCase();
            const hay = (a.title + ' ' + a.created_by + ' ' + a.excerpt + ' ' + a.tags.join(' ')).toLowerCase();
            if (!hay.includes(q)) return false;
          }
          return true;
        }

        function sortFn(a, b) {
          switch (state.sort) {
            case 'date_asc': return (a.created_at || '').localeCompare(b.created_at || '');
            case 'title_asc': return a.title.localeCompare(b.title);
            case 'title_desc': return b.title.localeCompare(a.title);
            case 'creator_asc': return (a.created_by || '').localeCompare(b.created_by || '');
            case 'date_desc':
            default: return (b.created_at || '').localeCompare(a.created_at || '');
          }
        }

        function renderCard(a) {
          const tagsHtml = a.tags.map(t => '<span class="tag">' + escHtml(t) + '</span>').join('');
          const meta = [];
          if (a.created_at) meta.push('<span>' + escHtml(a.created_at) + '</span>');
          if (a.created_by) meta.push('<span>by ' + escHtml(a.created_by) + '</span>');
          if (a.folder) meta.push('<span class="folder-pill">' + escHtml(a.folder) + '</span>');
          const badge =
            a.visibility === 'restricted' ? '<span class="badge restricted">Restricted</span>' :
            a.visibility === 'private' ? '<span class="badge private">Private</span>' :
            '<span class="badge open">Open</span>';
          return '<a class="artifact-card" href="/doc/artifacts/' + encodeURIComponent(a.file) + '">' +
            '<div class="artifact-card-head">' +
              '<span class="artifact-title">' + escHtml(a.title) + '</span>' +
              badge +
            '</div>' +
            (a.excerpt ? '<div class="artifact-excerpt">' + escHtml(a.excerpt) + '</div>' : '') +
            '<div class="artifact-meta">' +
              tagsHtml +
              '<span class="artifact-meta-sep"></span>' +
              meta.join(' · ') +
            '</div>' +
          '</a>';
        }

        function groupKey(a) {
          switch (state.group) {
            case 'tag': return a.tags.length ? a.tags : ['(no tag)'];
            case 'folder': return [a.folder || '(root)'];
            case 'creator': return [a.created_by || '(unknown)'];
            case 'visibility': return [a.visibility || 'open'];
            default: return [null];
          }
        }

        function renderList() {
          const visible = ARTIFACTS.filter(matches).sort(sortFn);
          const countEl = document.getElementById('artifact-count');
          countEl.textContent = visible.length === ARTIFACTS.length
            ? ARTIFACTS.length + ' artifact' + (ARTIFACTS.length === 1 ? '' : 's')
            : visible.length + ' of ' + ARTIFACTS.length + ' visible';

          const listEl = document.getElementById('artifact-list');
          if (!visible.length) {
            listEl.innerHTML = '<p class="empty">No artifacts match your filters.</p>';
            return;
          }

          if (!state.group) {
            listEl.innerHTML = '<div class="artifact-grid">' + visible.map(renderCard).join('') + '</div>';
            return;
          }

          const groups = new Map();
          for (const a of visible) {
            for (const k of groupKey(a)) {
              if (!groups.has(k)) groups.set(k, []);
              groups.get(k).push(a);
            }
          }
          const sortedGroups = Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
          listEl.innerHTML = sortedGroups.map(function(entry) {
            const k = entry[0], arts = entry[1];
            return '<div class="artifact-group"><h3 class="artifact-group-head">' + escHtml(k) +
              ' <span class="artifact-group-count">' + arts.length + '</span></h3>' +
              '<div class="artifact-grid">' + arts.map(renderCard).join('') + '</div></div>';
          }).join('');
        }

        function renderTagChips() {
          const tagsEl = document.getElementById('artifact-tags');
          if (!allTags.length) { tagsEl.innerHTML = ''; return; }
          tagsEl.innerHTML = allTags.map(function(t) {
            const active = state.tags.has(t);
            return '<button class="tag-chip' + (active ? ' active' : '') +
              '" data-tag="' + escHtml(t) + '">' + escHtml(t) + '</button>';
          }).join('');
          tagsEl.querySelectorAll('.tag-chip').forEach(function(btn) {
            btn.addEventListener('click', function() {
              const t = btn.getAttribute('data-tag');
              if (state.tags.has(t)) state.tags.delete(t); else state.tags.add(t);
              writeHash();
              renderTagChips();
              renderList();
            });
          });
        }

        function syncControls() {
          document.getElementById('artifact-search').value = state.q;
          document.getElementById('artifact-visibility').value = state.visibility;
          document.getElementById('artifact-sort').value = state.sort;
          document.getElementById('artifact-group').value = state.group;
        }

        document.getElementById('artifact-search').addEventListener('input', function(e) {
          state.q = e.target.value; writeHash(); renderList();
        });
        document.getElementById('artifact-visibility').addEventListener('change', function(e) {
          state.visibility = e.target.value; writeHash(); renderList();
        });
        document.getElementById('artifact-sort').addEventListener('change', function(e) {
          state.sort = e.target.value; writeHash(); renderList();
        });
        document.getElementById('artifact-group').addEventListener('change', function(e) {
          state.group = e.target.value; writeHash(); renderList();
        });
        document.getElementById('artifact-clear').addEventListener('click', function() {
          state.q = ''; state.tags.clear(); state.visibility = ''; state.sort = 'date_desc'; state.group = '';
          writeHash(); syncControls(); renderTagChips(); renderList();
        });
        window.addEventListener('hashchange', function() {
          readHash(); syncControls(); renderTagChips(); renderList();
        });

        readHash();
        syncControls();
        renderTagChips();
        renderList();
      })();
      </script>`;

    res.send(layout('Artifacts', body, username));
    return;
  }

  let items = '';
  for (const f of files) {
    if (f.name === 'README.md') continue;
    let fm = {};
    try { fm = readDoc(f.fullPath).frontmatter; } catch {}
    if (!canView(fm, username)) continue;

    const title = fm.title || f.name.replace('.md', '');
    const vis = fm.visibility || 'open';
    const tags = (fm.tags || []).map(t => `<span class="tag">${t}</span>`).join('');
    const badge = VISIBILITY_BADGES[vis] || '';
    const created = fm.created_at || '';

    items += `<li><a href="/doc/${cat}/${encodeURIComponent(f.name)}"><div><span class="doc-title">${title}</span> ${tags}</div><div class="doc-meta">${created ? `<span>${created}</span>` : ''}${badge}</div></a></li>`;
  }

  if (!items) {
    items = '<p class="empty">No documents yet.</p>';
  }

  const body = `
    <div class="breadcrumb"><a href="/">Home</a> / ${icon} ${cat.charAt(0).toUpperCase() + cat.slice(1)}</div>
    <ul class="doc-list">${items}</ul>`;

  res.send(layout(cat.charAt(0).toUpperCase() + cat.slice(1), body, username));
});

app.get('/doc/:category/:file', (req, res) => {
  const username = req.auth.user;
  const cat = req.params.category;
  const relPath = decodeURIComponent(req.params.file);
  const fullPath = path.join(CONTEXT_DIR, cat, relPath);

  if (!fs.existsSync(fullPath)) {
    res.status(404).send(layout('Not Found', '<p class="empty">Document not found.</p>', username));
    return;
  }

  const { frontmatter: fm, content } = readDoc(fullPath);

  if (!canView(fm, username)) {
    res.status(403).send(layout('Restricted', '<p class="empty">This document is restricted. Contact an admin for access.</p>', username));
    return;
  }

  const title = fm.title || relPath.replace('.md', '');
  const vis = fm.visibility || 'open';
  const badge = VISIBILITY_BADGES[vis] || '';
  const tags = (fm.tags || []).map(t => `<span class="tag">${t}</span>`).join(' ');
  const icon = CATEGORY_ICONS[cat] || '\u{1F4C4}';

  const fmBar = `<div class="frontmatter-bar">
    <div class="fm-item"><span class="fm-label">Visibility:</span> ${badge}</div>
    ${fm.created_by ? `<div class="fm-item"><span class="fm-label">Created by:</span> <span class="fm-value">${fm.created_by}</span></div>` : ''}
    ${fm.created_at ? `<div class="fm-item"><span class="fm-label">Created:</span> <span class="fm-value">${fm.created_at}</span></div>` : ''}
    ${fm.editable_by ? `<div class="fm-item"><span class="fm-label">Editable by:</span> <span class="fm-value">${fm.editable_by}</span></div>` : ''}
    ${tags ? `<div class="fm-item"><span class="fm-label">Tags:</span> ${tags}</div>` : ''}
  </div>`;

  // Strip ## Personnel Notes section for non-admin users
  let visibleContent = content;
  if (!isAdmin(username)) {
    visibleContent = content.replace(/^## Personnel Notes[\s\S]*?(?=^## |\s*$)/m, '');
  }

  const html = marked(visibleContent);

  const body = `
    <div class="breadcrumb"><a href="/">Home</a> / <a href="/category/${cat}">${icon} ${cat.charAt(0).toUpperCase() + cat.slice(1)}</a> / ${title}</div>
    ${fmBar}
    <div class="doc-content">${html}</div>`;

  res.send(layout(title, body, username));
});

// --- Task PATCH API (drag-and-drop status/priority updates) ---

app.patch('/api/tasks/:file', (req, res) => {
  const origin = req.headers.origin || '';
  const referer = req.headers.referer || '';
  const host = req.headers.host || '';
  if (origin && !origin.includes(host)) {
    return res.status(403).json({ error: 'Cross-origin request blocked' });
  }
  if (!origin && referer && !referer.includes(host)) {
    return res.status(403).json({ error: 'Cross-origin request blocked' });
  }

  const username = req.auth.user;
  if (!isAdmin(username) && !isCoordinator(username)) {
    return res.status(403).json({ error: 'Permission denied' });
  }
  const file = req.params.file;
  if (!/^TASK-\d+\.md$/.test(file)) {
    return res.status(400).json({ error: 'Invalid task file' });
  }
  const filePath = path.join(CONTEXT_DIR, 'tasks', file);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Task not found' });
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = matter(raw);
    const allowed = ['status', 'priority', 'assigned_to'];
    const validStatus = ['backlog', 'open', 'in_progress', 'in_review', 'blocked', 'done', 'closed', 'cancelled'];
    const validPriority = ['critical', 'high', 'medium', 'low'];

    if (req.body.status !== undefined && !validStatus.includes(req.body.status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    if (req.body.priority !== undefined && !validPriority.includes(req.body.priority)) {
      return res.status(400).json({ error: 'Invalid priority' });
    }

    let changed = false;
    for (const key of allowed) {
      if (req.body[key] !== undefined && parsed.data[key] !== req.body[key]) {
        parsed.data[key] = req.body[key];
        changed = true;
      }
    }
    if (!changed) {
      return res.json({ ok: true, id: parsed.data.id || file.replace('.md', ''), updated: false });
    }

    parsed.data.updated_at = new Date().toISOString().slice(0, 10);
    const updated = matter.stringify(parsed.content, parsed.data);
    fs.writeFileSync(filePath, updated, 'utf-8');

    // Audit log
    try {
      if (!Database) throw new Error('better-sqlite3 not available');
      const auditDb = new Database(process.env.DB_PATH || '/opt/breadbrich/store/messages.db');
      auditDb.exec('CREATE TABLE IF NOT EXISTS kb_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL, action TEXT NOT NULL, changed_by TEXT NOT NULL, changes TEXT, timestamp TEXT NOT NULL)');
      auditDb.prepare('INSERT INTO kb_audit_log (file_path, action, changed_by, changes, timestamp) VALUES (?, ?, ?, ?, ?)').run(
        'tasks/' + file, 'update', username, JSON.stringify(req.body), new Date().toISOString()
      );
      auditDb.close();
    } catch (auditErr) {
      console.error('Audit log failed:', auditErr);
    }

    res.json({ ok: true, id: parsed.data.id || file.replace('.md', ''), updated: true });
  } catch (e) {
    console.error('Failed to update task:', filePath, e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Linkages Visualization ---

app.get('/linkages', (req, res) => {
  const username = req.auth.user;

  // Load all tasks
  const tasksDir = path.join(CONTEXT_DIR, 'tasks');
  const taskFiles = walkDir(tasksDir).filter(f => f.name.startsWith('TASK-') && f.name.endsWith('.md'));
  const tasks = [];
  for (const f of taskFiles) {
    try {
      const { frontmatter: fm, content } = readDoc(f.fullPath);
      if (!canView(fm, username)) continue;
      tasks.push({ ...fm, file: f.name, content });
    } catch {}
  }

  // Load all events
  const calDir = path.join(CONTEXT_DIR, 'calendar');
  const eventFiles = walkDir(calDir).filter(f => f.name !== 'README.md' && f.name !== 'upcoming.md' && f.name.endsWith('.md'));
  const events = [];
  for (const f of eventFiles) {
    try {
      const { frontmatter: fm, content } = readDoc(f.fullPath);
      if (!canView(fm, username)) continue;
      events.push({ ...fm, file: f.name, content });
    } catch {}
  }

  // Build linkage data
  const links = [];
  const linkedTaskIds = new Set();
  const linkedEventIds = new Set();

  for (const task of tasks) {
    const taskEvents = task.linked_events || [];
    for (const evtId of taskEvents) {
      const evt = events.find(e => e.id === evtId);
      if (evt) {
        links.push({ taskId: task.id, taskTitle: task.title, eventId: evt.id, eventTitle: evt.title, taskFile: task.file, eventFile: evt.file });
        linkedTaskIds.add(task.id);
        linkedEventIds.add(evt.id);
      }
    }
  }

  for (const evt of events) {
    const evtTasks = evt.linked_tasks || [];
    for (const taskId of evtTasks) {
      if (links.find(l => l.taskId === taskId && l.eventId === evt.id)) continue;
      const task = tasks.find(t => t.id === taskId);
      if (task) {
        links.push({ taskId: task.id, taskTitle: task.title, eventId: evt.id, eventTitle: evt.title, taskFile: task.file, eventFile: evt.file });
        linkedTaskIds.add(task.id);
        linkedEventIds.add(evt.id);
      }
    }
  }

  // Build graph visualization (SVG)
  const nodeRadius = 8;
  const taskNodes = tasks.map((t, i) => ({
    id: t.id, title: t.title, file: t.file, type: 'task',
    x: 180, y: 60 + i * 80,
    status: t.status || 'open', priority: t.priority || 'medium',
    linked: linkedTaskIds.has(t.id),
    owners: (t.owners || []).join(', '),
  }));
  const eventNodes = events.map((e, i) => ({
    id: e.id, title: e.title, file: e.file, type: 'event',
    x: 620, y: 60 + i * 80,
    status: e.status || 'upcoming',
    linked: linkedEventIds.has(e.id),
  }));

  const svgHeight = Math.max(taskNodes.length, eventNodes.length) * 80 + 60;

  // Build SVG edges
  let edges = '';
  for (const link of links) {
    const tNode = taskNodes.find(n => n.id === link.taskId);
    const eNode = eventNodes.find(n => n.id === link.eventId);
    if (tNode && eNode) {
      edges += `<line x1="${tNode.x + 140}" y1="${tNode.y}" x2="${eNode.x - 140}" y2="${eNode.y}" stroke="#4a9eda" stroke-width="2" stroke-dasharray="6,3" opacity="0.7"/>`;
      // Arrow
      const midX = (tNode.x + 140 + eNode.x - 140) / 2;
      const midY = (tNode.y + eNode.y) / 2;
      edges += `<circle cx="${midX}" cy="${midY}" r="3" fill="#4a9eda"/>`;
    }
  }

  // Task-to-task dependency edges
  let depEdges = '';
  for (const task of tasks) {
    const downstream = task.downstream || [];
    for (const depId of downstream) {
      const srcNode = taskNodes.find(n => n.id === task.id);
      const dstNode = taskNodes.find(n => n.id === depId);
      if (srcNode && dstNode) {
        depEdges += `<line x1="${srcNode.x - 10}" y1="${srcNode.y + 12}" x2="${dstNode.x - 10}" y2="${dstNode.y - 12}" stroke="#e0a050" stroke-width="1.5" marker-end="url(#arrowYellow)" opacity="0.6"/>`;
      }
    }
  }

  // Build SVG task nodes
  const statusColors = { open: '#5cb85c', in_progress: '#4a9eda', blocked: '#d9534f', done: '#666', cancelled: '#444' };
  const priorityBorders = { critical: '#d9534f', high: '#e0a050', medium: '#4a9eda', low: '#666' };
  const eventStatusColors = { upcoming: '#5cb85c', recurring: '#4a9eda', cancelled: '#d9534f', completed: '#666' };

  let taskSvg = '';
  for (const n of taskNodes) {
    const color = statusColors[n.status] || '#888';
    const border = priorityBorders[n.priority] || '#444';
    const opacity = n.linked ? '1' : '0.5';
    taskSvg += `
      <g opacity="${opacity}">
        <rect x="${n.x - 140}" y="${n.y - 22}" width="280" height="44" rx="6" fill="#161616" stroke="${border}" stroke-width="1.5"/>
        <circle cx="${n.x - 125}" cy="${n.y}" r="5" fill="${color}"/>
        <a href="/doc/tasks/${encodeURIComponent(n.file)}">
          <text x="${n.x - 112}" y="${n.y + 1}" fill="#ddd" font-size="13" font-weight="500" dominant-baseline="middle">${n.id}</text>
          <text x="${n.x - 70}" y="${n.y + 1}" fill="#aaa" font-size="12" dominant-baseline="middle">${n.title.length > 25 ? n.title.slice(0, 25) + '...' : n.title}</text>
        </a>
        <text x="${n.x + 130}" y="${n.y + 1}" fill="#555" font-size="10" text-anchor="end" dominant-baseline="middle">${n.owners || ''}</text>
      </g>`;
  }

  let eventSvg = '';
  for (const n of eventNodes) {
    const color = eventStatusColors[n.status] || '#888';
    const opacity = n.linked ? '1' : '0.5';
    eventSvg += `
      <g opacity="${opacity}">
        <rect x="${n.x - 140}" y="${n.y - 22}" width="280" height="44" rx="6" fill="#161616" stroke="#2a4a2a" stroke-width="1.5"/>
        <circle cx="${n.x - 125}" cy="${n.y}" r="5" fill="${color}"/>
        <a href="/doc/calendar/${encodeURIComponent(n.file)}">
          <text x="${n.x - 112}" y="${n.y + 1}" fill="#ddd" font-size="13" font-weight="500" dominant-baseline="middle">${n.id || 'EVT'}</text>
          <text x="${n.x - 70}" y="${n.y + 1}" fill="#aaa" font-size="12" dominant-baseline="middle">${n.title.length > 25 ? n.title.slice(0, 25) + '...' : n.title}</text>
        </a>
      </g>`;
  }

  const svg = `<svg width="100%" viewBox="0 0 800 ${svgHeight}" xmlns="http://www.w3.org/2000/svg" style="background:#0a0a0a;border-radius:8px">
    <defs>
      <marker id="arrowYellow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#e0a050"/>
      </marker>
    </defs>
    <!-- Column headers -->
    <text x="180" y="25" fill="#666" font-size="14" font-weight="600" text-anchor="middle">Tasks</text>
    <text x="620" y="25" fill="#666" font-size="14" font-weight="600" text-anchor="middle">Events</text>
    <!-- Edges -->
    ${depEdges}
    ${edges}
    <!-- Nodes -->
    ${taskSvg}
    ${eventSvg}
    <!-- Legend -->
    <g transform="translate(20, ${svgHeight - 30})">
      <line x1="0" y1="0" x2="20" y2="0" stroke="#4a9eda" stroke-width="2" stroke-dasharray="6,3"/>
      <text x="25" y="4" fill="#555" font-size="10">Task \u2194 Event link</text>
      <line x1="150" y1="0" x2="170" y2="0" stroke="#e0a050" stroke-width="1.5"/>
      <text x="175" y="4" fill="#555" font-size="10">Task dependency</text>
      <circle cx="310" cy="0" r="5" fill="#5cb85c"/><text x="320" y="4" fill="#555" font-size="10">Open/Upcoming</text>
      <circle cx="420" cy="0" r="5" fill="#4a9eda"/><text x="430" y="4" fill="#555" font-size="10">In Progress</text>
      <circle cx="520" cy="0" r="5" fill="#d9534f"/><text x="530" y="4" fill="#555" font-size="10">Blocked/Cancelled</text>
    </g>
  </svg>`;

  // Linkage table
  let linkRows = '';
  if (links.length === 0) {
    linkRows = '<tr><td colspan="4" style="color:#555;text-align:center;font-style:italic">No linkages yet. Add linked_events to tasks or linked_tasks to events.</td></tr>';
  } else {
    for (const l of links) {
      linkRows += `<tr>
        <td><a href="/doc/tasks/${encodeURIComponent(l.taskFile)}" style="color:#7eb8da">${l.taskId}</a></td>
        <td style="color:#ddd">${l.taskTitle}</td>
        <td><a href="/doc/calendar/${encodeURIComponent(l.eventFile)}" style="color:#7eb8da">${l.eventId}</a></td>
        <td style="color:#ddd">${l.eventTitle}</td>
      </tr>`;
    }
  }

  // Unlinked items
  const unlinkedTasks = tasks.filter(t => !linkedTaskIds.has(t.id));
  const unlinkedEvents = events.filter(e => !linkedEventIds.has(e.id));

  let unlinkedHtml = '';
  if (unlinkedTasks.length > 0 || unlinkedEvents.length > 0) {
    let items = '';
    for (const t of unlinkedTasks) {
      items += `<li><a href="/doc/tasks/${encodeURIComponent(t.file)}">${t.id}: ${t.title}</a> <span style="color:#555">(no linked events)</span></li>`;
    }
    for (const e of unlinkedEvents) {
      items += `<li><a href="/doc/calendar/${encodeURIComponent(e.file)}">${e.id || 'EVT'}: ${e.title}</a> <span style="color:#555">(no linked tasks)</span></li>`;
    }
    unlinkedHtml = `
      <h2 class="section-header" style="margin-top:24px">\u{26A0}\u{FE0F} Unlinked Items</h2>
      <div class="doc-content" style="margin-bottom:24px;padding:16px">
        <p style="color:#888;margin-bottom:12px">These items have no cross-references:</p>
        <ul style="list-style:none;padding:0">${items}</ul>
      </div>`;
  }

  // Task dependency table
  let depRows = '';
  const tasksWithDeps = tasks.filter(t => (t.upstream && t.upstream.length) || (t.downstream && t.downstream.length));
  if (tasksWithDeps.length > 0) {
    for (const t of tasksWithDeps) {
      const up = (t.upstream || []).join(', ') || '\u2014';
      const down = (t.downstream || []).join(', ') || '\u2014';
      depRows += `<tr>
        <td><a href="/doc/tasks/${encodeURIComponent(t.file)}" style="color:#7eb8da">${t.id}</a></td>
        <td style="color:#ddd">${t.title}</td>
        <td style="color:#999">${up}</td>
        <td style="color:#999">${down}</td>
      </tr>`;
    }
  } else {
    depRows = '<tr><td colspan="4" style="color:#555;text-align:center;font-style:italic">No task dependencies defined yet.</td></tr>';
  }

  const body = `
    <div class="breadcrumb"><a href="/">Home</a> / \u{1F517} Linkages</div>

    <h2 class="section-header">\u{1F5FA}\u{FE0F} Task \u2194 Event Graph</h2>
    <div class="doc-content" style="margin-bottom:24px;padding:16px;overflow-x:auto">
      ${svg}
    </div>

    <h2 class="section-header">\u{1F517} Active Linkages</h2>
    <div class="doc-content" style="margin-bottom:24px;padding:16px">
      <table>
        <thead><tr><th>Task ID</th><th>Task</th><th>Event ID</th><th>Event</th></tr></thead>
        <tbody>${linkRows}</tbody>
      </table>
    </div>

    <h2 class="section-header">\u{1F504} Task Dependencies</h2>
    <div class="doc-content" style="margin-bottom:24px;padding:16px">
      <table>
        <thead><tr><th>Task ID</th><th>Task</th><th>Upstream (blocks this)</th><th>Downstream (blocked by this)</th></tr></thead>
        <tbody>${depRows}</tbody>
      </table>
    </div>

    ${unlinkedHtml}
  `;

  res.send(layout('Linkages', body, username));
});

// --- Request Logs (admin only) ---

app.get('/logs', (req, res) => {
  const username = req.auth.user;
  if (!isAdmin(username)) {
    res.status(403).send(layout('Forbidden', '<p class="empty">Access restricted to admins.</p>', username));
    return;
  }

  // Read the request log markdown file
  const logPath = path.join(CONTEXT_DIR, 'artifacts', 'request_log.md');
  let logContent = '';
  if (fs.existsSync(logPath)) {
    const { content } = readDoc(logPath);
    logContent = marked(content);
  }

  // Also read live message stats from DB
  let dbStats = '';
  try {
    const Database = require('better-sqlite3');
    const db = new Database('/opt/breadbrich/store/messages.db');

    const totalMessages = db.prepare("SELECT COUNT(*) as c FROM messages WHERE is_from_me = 0 AND is_bot_message = 0").get();
    const byUser = db.prepare("SELECT sender_name, COUNT(*) as c FROM messages WHERE is_from_me = 0 AND is_bot_message = 0 GROUP BY sender_name ORDER BY c DESC").all();
    const byChannel = db.prepare("SELECT chat_jid, COUNT(*) as c FROM messages WHERE is_from_me = 0 AND is_bot_message = 0 GROUP BY chat_jid ORDER BY c DESC").all();
    const recentMessages = db.prepare("SELECT sender_name, chat_jid, content, timestamp FROM messages WHERE is_from_me = 0 AND is_bot_message = 0 ORDER BY timestamp DESC LIMIT 10").all();

    db.close();

    // KB_CHANNEL_NAMES env var: JSON object mapping JID -> display name.
    // If unset or invalid, the raw JID is shown instead.
    let channelNames = {};
    if (process.env.KB_CHANNEL_NAMES) {
      try { channelNames = JSON.parse(process.env.KB_CHANNEL_NAMES); }
      catch (e) { console.warn('[kb-ui] KB_CHANNEL_NAMES invalid JSON, falling back to raw JIDs'); }
    }

    let userStatsRows = byUser.map(r =>
      `<tr><td style="color:#ddd">${r.sender_name}</td><td style="color:#999">${r.c}</td></tr>`
    ).join('');

    let channelStatsRows = byChannel.map(r =>
      `<tr><td style="color:#ddd">${channelNames[r.chat_jid] || r.chat_jid}</td><td style="color:#999">${r.c}</td></tr>`
    ).join('');

    let recentRows = recentMessages.map(r => {
      const date = new Date(r.timestamp);
      const dateStr = date.toISOString().slice(0, 10);
      const timeStr = date.toISOString().slice(11, 16);
      const channel = channelNames[r.chat_jid] || r.chat_jid;
      const summary = r.content.length > 80 ? r.content.slice(0, 80) + '...' : r.content;
      const escapedSummary = summary.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<tr><td style="color:#999;font-size:12px">${dateStr}</td><td style="color:#999;font-size:12px">${timeStr}</td><td style="color:#ddd">${r.sender_name}</td><td style="color:#999;font-size:12px">${channel}</td><td style="color:#888;font-size:12px">${escapedSummary}</td></tr>`;
    }).join('');

    dbStats = `
      <h2 class="section-header">\u{1F4CA} Live Stats</h2>
      <div class="doc-content" style="margin-bottom:24px;padding:16px">
        <p style="color:#888;margin-bottom:16px">Total inbound messages: <strong>${totalMessages.c}</strong></p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
          <div>
            <h3 style="color:#aaa;font-size:14px;margin-bottom:8px">By User</h3>
            <table><thead><tr><th>User</th><th>Messages</th></tr></thead><tbody>${userStatsRows}</tbody></table>
          </div>
          <div>
            <h3 style="color:#aaa;font-size:14px;margin-bottom:8px">By Channel</h3>
            <table><thead><tr><th>Channel</th><th>Messages</th></tr></thead><tbody>${channelStatsRows}</tbody></table>
          </div>
        </div>
      </div>

      <h2 class="section-header">\u{1F551} Recent Messages (Live)</h2>
      <div class="doc-content" style="margin-bottom:24px;padding:16px">
        <table>
          <thead><tr><th>Date</th><th>Time</th><th>User</th><th>Channel</th><th>Message</th></tr></thead>
          <tbody>${recentRows}</tbody>
        </table>
      </div>`;
  } catch (e) {
    dbStats = `<div class="doc-content" style="margin-bottom:24px;padding:16px"><p style="color:#666">Live stats unavailable: ${e.message}</p></div>`;
  }

  const body = `
    <div class="breadcrumb"><a href="/">Home</a> / \u{1F4CB} Request Logs</div>
    ${dbStats}
    <h2 class="section-header">\u{1F4DD} Breadbrich Engels Request Log</h2>
    <div class="doc-content" style="padding:16px">${logContent}</div>`;

  res.send(layout('Request Logs', body, username));
});

// --- Admin Dashboard (superadmin only: alice, bob) ---

app.get('/admin', (req, res) => {
  const username = req.auth.user;
  if (!isSuperAdmin(username)) {
    res.status(403).send(layout('Forbidden', '<p class="empty">Access restricted to superadmins.</p>', username));
    return;
  }

  const users = loadUsers();

  // Display-only roster for the superadmin /admin page. Slack/Telegram IDs are
  // intentionally not hardcoded here \u2014 the source of truth is each person's KB
  // file (groups/slack_main/context/people/<name>.md) and the JID rosters in
  // groups/*/CLAUDE.md. The dashes below render as "\u2014" in the table; if you
  // need richer per-user identity display, derive it from those files at
  // request time.
  const userData = {
    alice: { display: 'Alice Adams', tags: ['admin', 'leadership'], admin: true, superadmin: true, slack: '\u2014', telegram: '\u2014', kb: 'All docs', crossSend: 'Yes' },
    bob: { display: 'Bob Baker', tags: ['admin', 'leadership', 'engineering'], admin: true, superadmin: true, slack: '\u2014', telegram: '\u2014', kb: 'All docs', crossSend: 'Yes' },
    carol: { display: 'Carol Cole', tags: ['admin', 'leadership'], admin: true, superadmin: false, slack: '\u2014', telegram: '\u2014', kb: 'All docs', crossSend: 'Yes' },
    ops: { display: 'Ops', tags: ['admin', 'engineering'], admin: true, superadmin: false, slack: '\u2014', telegram: '\u2014', kb: 'All docs', crossSend: 'Yes' },
    dave: { display: 'Dave Doyle', tags: ['coordinator', 'operations', 'engineering'], admin: true, superadmin: false, slack: '\u2014', telegram: '\u2014', kb: 'All docs', crossSend: 'Yes' },
    guest: { display: 'Guest', tags: [], admin: false, superadmin: false, slack: '\u2014', telegram: '\u2014', kb: 'Open only', crossSend: 'No' },
  };

  let userRows = '';
  for (const [uname, pwd] of Object.entries(users)) {
    const u = userData[uname] || { display: uname, tags: [], admin: false, superadmin: false, slack: '\u2014', telegram: '\u2014', kb: 'Open only', crossSend: 'No' };
    const tagBadges = u.tags.map(t => `<span class="tag">${t}</span>`).join(' ') || '<span style="color:#555">\u2014</span>';
    const adminBadge = u.admin ? '<span class="badge open">Yes</span>' : '<span class="badge private">No</span>';
    const superBadge = u.superadmin ? '<span class="badge super">Yes</span>' : '<span style="color:#555">\u2014</span>';
    userRows += `<tr>
      <td style="color:#fff;font-weight:500">${u.display}</td>
      <td><code>${uname}</code></td>
      <td><code style="color:#666">${pwd}</code></td>
      <td>${tagBadges}</td>
      <td>${adminBadge}</td>
      <td>${superBadge}</td>
      <td style="font-size:12px;color:#888">${u.kb}</td>
    </tr>`;
  }

  let identityRows = '';
  for (const [uname, u] of Object.entries(userData)) {
    if (uname === 'guest') continue;
    identityRows += `<tr>
      <td style="color:#ddd">${u.display}</td>
      <td style="font-size:12px"><code>${u.slack}</code></td>
      <td style="font-size:12px"><code>${u.telegram}</code></td>
      <td>${u.crossSend === 'Yes' ? '<span class="badge open">Yes</span>' : '<span class="badge private">No</span>'}</td>
    </tr>`;
  }

  const hierarchyRows = `
    <tr><td><span class="tag">admin</span></td><td style="color:#999">admin, leadership, engineering, creative, operations, community, coordinator</td></tr>
    <tr><td><span class="tag">leadership</span></td><td style="color:#999">engineering, creative, operations, community</td></tr>
    <tr><td><span class="tag">coordinator</span></td><td style="color:#999">operations, community</td></tr>
    <tr><td colspan="2" style="color:#555;font-style:italic">Other tags cannot assign tags</td></tr>`;

  const body = `
    <div class="breadcrumb"><a href="/">Home</a> / \u{1F512} Admin Dashboard</div>

    <h2 class="section-header">\u{1F465} Users & Credentials</h2>
    <div class="doc-content" style="margin-bottom:24px;padding:16px">
      <table>
        <thead><tr><th>Name</th><th>Login</th><th>Password</th><th>Tags</th><th>Admin</th><th>Super</th><th>KB Access</th></tr></thead>
        <tbody>${userRows}</tbody>
      </table>
    </div>

    <h2 class="section-header">\u{2709}\u{FE0F} Breadbrich Engels Service Accounts</h2>
    <div class="doc-content" style="margin-bottom:24px;padding:16px">
      <table>
        <thead><tr><th>Service</th><th>Account</th><th>Credential</th></tr></thead>
        <tbody>
          <tr><td style="color:#ddd">Email</td><td><code>${process.env.BREADBRICH_EMAIL || '<unset>'}</code></td><td style="color:#555">Password in .env (BREADBRICH_EMAIL_PASSWORD)</td></tr>
          <tr><td style="color:#ddd">Telegram Bot</td><td><code>@${process.env.TELEGRAM_BOT_USERNAME || '<unset>'}</code></td><td style="color:#555">Token in .env</td></tr>
          <tr><td style="color:#ddd">Slack Bot</td><td><code>${process.env.SLACK_BOT_USERNAME || 'breadbrich'}</code></td><td style="color:#555">Token in .env</td></tr>
        </tbody>
      </table>
    </div>

    <h2 class="section-header">\u{1F517} Platform Identities</h2>
    <div class="doc-content" style="margin-bottom:24px;padding:16px">
      <table>
        <thead><tr><th>Person</th><th>Slack ID</th><th>Telegram JID</th><th>Cross-Send</th></tr></thead>
        <tbody>${identityRows}</tbody>
      </table>
    </div>

    <h2 class="section-header">\u{1F3F7}\u{FE0F} Tag Hierarchy</h2>
    <div class="doc-content" style="margin-bottom:24px;padding:16px">
      <p style="color:#888;margin-bottom:12px">Which tags can assign which other tags:</p>
      <table>
        <thead><tr><th>Holder of Tag</th><th>Can Assign</th></tr></thead>
        <tbody>${hierarchyRows}</tbody>
      </table>
    </div>

    <h2 class="section-header">\u{1F6E1}\u{FE0F} Permission Matrix</h2>
    <div class="doc-content" style="margin-bottom:24px;padding:16px">
      <table>
        <thead><tr><th>Permission</th><th>Granted To</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td style="color:#ddd">cross_send</td><td><span class="tag">admin</span> <span class="tag">coordinator</span></td><td style="color:#888">Send messages across channels (Slack\u2194Telegram)</td></tr>
          <tr><td style="color:#ddd">manage_tasks</td><td><span class="tag">admin</span></td><td style="color:#888">Create/modify scheduled tasks across groups</td></tr>
          <tr><td style="color:#ddd">manage_groups</td><td><span class="tag">admin</span></td><td style="color:#888">Register/modify chat groups</td></tr>
          <tr><td style="color:#ddd">manage_kb</td><td><span class="tag">admin</span> <span class="tag">leadership</span> <span class="tag">coordinator</span></td><td style="color:#888">Create/edit knowledge base documents</td></tr>
          <tr><td style="color:#ddd">manage_tags</td><td><span class="tag">admin</span> <span class="tag">leadership</span></td><td style="color:#888">Assign tags to users (subject to hierarchy)</td></tr>
          <tr><td style="color:#ddd">view_admin</td><td><span class="tag">superadmin</span></td><td style="color:#888">Access this admin dashboard (credentials visible)</td></tr>
          <tr><td style="color:#ddd">view_personnel_notes</td><td><span class="tag">admin</span></td><td style="color:#888">See Personnel Notes sections in people files</td></tr>
          <tr><td style="color:#ddd">edit_structure</td><td><span class="tag">superadmin</span></td><td style="color:#888">Modify KB directory structure, DB schema, system config</td></tr>
        </tbody>
      </table>
    </div>

    <h2 class="section-header">\u{1F4CA} KB Directory Access by Role</h2>
    <div class="doc-content" style="margin-bottom:24px;padding:16px">
      <p style="color:#888;margin-bottom:12px">Read/Write access per KB directory, by role:</p>
      <table>
        <thead><tr><th>Directory</th><th>Admin</th><th>Coordinator</th><th>Contributor</th><th>Guest</th></tr></thead>
        <tbody>
          <tr><td style="color:#ddd">people/</td><td><span class="badge open">R/W</span></td><td><span class="badge restricted">Read</span></td><td style="color:#555">\u2014</td><td style="color:#555">\u2014</td></tr>
          <tr><td style="color:#ddd">\u2514 personnel_notes</td><td><span class="badge open">R/W</span></td><td style="color:#555">\u2014</td><td style="color:#555">\u2014</td><td style="color:#555">\u2014</td></tr>
          <tr><td style="color:#ddd">calendar/</td><td><span class="badge open">R/W</span></td><td><span class="badge open">R/W</span></td><td><span class="badge restricted">Read</span></td><td><span class="badge restricted">Read</span></td></tr>
          <tr><td style="color:#ddd">tasks/</td><td><span class="badge open">R/W</span></td><td><span class="badge open">R/W</span></td><td><span class="badge restricted">Read (open)</span></td><td><span class="badge restricted">Read (open)</span></td></tr>
          <tr><td style="color:#ddd">artifacts/</td><td><span class="badge open">R/W</span></td><td><span class="badge open">R/W</span></td><td><span class="badge restricted">Read (open)</span></td><td><span class="badge restricted">Read (open)</span></td></tr>
          <tr><td style="color:#ddd">spaces/</td><td><span class="badge open">R/W</span></td><td><span class="badge open">R/W</span></td><td><span class="badge restricted">Read (open)</span></td><td><span class="badge restricted">Read (open)</span></td></tr>
        </tbody>
      </table>
    </div>

    <h2 class="section-header">\u{1F4E1} Channel Access by Role</h2>
    <div class="doc-content" style="margin-bottom:24px;padding:16px">
      <p style="color:#888;margin-bottom:12px">What each role can do from each channel:</p>
      <table>
        <thead><tr><th>Channel</th><th>Role</th><th>Read KB</th><th>Write KB</th><th>Cross-Send</th><th>Manage Groups</th><th>View Credentials</th></tr></thead>
        <tbody>
          <tr><td style="color:#ddd" rowspan="3">Telegram</td><td><span class="tag">admin</span></td><td><span class="badge open">All</span></td><td><span class="badge open">All</span></td><td><span class="badge open">Yes</span></td><td><span class="badge open">Yes</span></td><td style="color:#555">\u2014</td></tr>
          <tr><td><span class="tag">coordinator</span></td><td><span class="badge open">All</span></td><td><span class="badge restricted">Non-private*</span></td><td><span class="badge open">Yes</span></td><td style="color:#555">No</td><td style="color:#555">\u2014</td></tr>
          <tr><td style="color:#888">contributor</td><td><span class="badge restricted">Open</span></td><td style="color:#555">No</td><td style="color:#555">No</td><td style="color:#555">No</td><td style="color:#555">\u2014</td></tr>
          <tr><td style="color:#ddd" rowspan="3">Slack</td><td><span class="tag">admin</span></td><td><span class="badge open">All</span></td><td><span class="badge open">All</span></td><td><span class="badge open">Yes</span></td><td><span class="badge open">Yes</span></td><td style="color:#555">\u2014</td></tr>
          <tr><td><span class="tag">coordinator</span></td><td><span class="badge open">All</span></td><td><span class="badge restricted">Non-private*</span></td><td><span class="badge open">Yes</span></td><td style="color:#555">No</td><td style="color:#555">\u2014</td></tr>
          <tr><td style="color:#888">contributor</td><td><span class="badge restricted">Open</span></td><td style="color:#555">No</td><td style="color:#555">No</td><td style="color:#555">No</td><td style="color:#555">\u2014</td></tr>
          <tr><td style="color:#ddd">CLI</td><td><span class="tag">admin</span></td><td><span class="badge open">All</span></td><td><span class="badge open">All</span></td><td><span class="badge open">Yes</span></td><td><span class="badge open">Yes</span></td><td style="color:#555">\u2014</td></tr>
          <tr><td style="color:#ddd">KB Web UI</td><td style="color:#888">all roles</td><td colspan="2" style="color:#888">Read-only (per visibility)</td><td style="color:#555">\u2014</td><td style="color:#555">\u2014</td><td><span class="badge super">Superadmin only</span></td></tr>
        </tbody>
      </table>
      <p style="color:#666;margin-top:12px;font-size:12px">* Non-private = all directories except people profiles, personnel notes, and credentials. Coordinator can write to calendar, tasks, artifacts, and spaces.</p>
    </div>
  `;

  res.send(layout('Admin Dashboard', body, username));
});

// --- Architecture Diagram (admin only) ---

app.get('/architecture', (req, res) => {
  const username = req.auth.user;
  if (!isAdmin(username)) {
    res.status(403).send(layout('Forbidden', '<p class="empty">Access restricted to admins.</p>', username));
    return;
  }

  const body = `
    <div class="breadcrumb"><a href="/">Home</a> / \u{1F3D7}\u{FE0F} Architecture</div>
    <style>
      .arch-diagram { position: relative; width: 100%; overflow-x: auto; }
      .arch-svg { width: 100%; min-width: 900px; }
      .arch-svg text { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace; }
      .arch-svg .box { rx: 6; ry: 6; }
      .arch-svg .box-header { font-weight: 600; font-size: 12px; fill: #fff; }
      .arch-svg .box-sub { font-size: 10px; fill: #999; }
      .arch-svg .col-label { font-size: 9px; fill: #666; font-weight: 500; letter-spacing: 0.5px; }
      .arch-svg .field { font-size: 9.5px; fill: #bbb; font-family: 'SF Mono', 'Fira Code', monospace; }
      .arch-svg .field-pk { fill: #f0c040; }
      .arch-svg .field-fk { fill: #7eb8da; }
      .arch-svg .section-title { font-size: 14px; fill: #fff; font-weight: 600; }
      .arch-svg .section-sub { font-size: 10px; fill: #666; }
      .arch-svg .conn { stroke-width: 1.5; fill: none; }
      .arch-svg .conn-data { stroke: #4a9eda; stroke-dasharray: 5,3; }
      .arch-svg .conn-flow { stroke: #5cb85c; marker-end: url(#arrowGreen); }
      .arch-svg .conn-deploy { stroke: #e0a050; stroke-dasharray: 3,2; }
      .arch-svg .zone { rx: 8; ry: 8; }

      .arch-legend { display: flex; gap: 20px; flex-wrap: wrap; margin: 16px 0; padding: 12px 16px; background: #0f0f0f; border: 1px solid #1a1a1a; border-radius: 6px; font-size: 12px; color: #888; }
      .arch-legend-item { display: flex; align-items: center; gap: 6px; }
      .arch-legend-swatch { width: 12px; height: 12px; border-radius: 2px; }

      .arch-tabs { display: flex; gap: 4px; margin-bottom: 16px; }
      .arch-tab { padding: 8px 16px; background: #161616; border: 1px solid #252525; border-radius: 6px 6px 0 0; cursor: pointer; color: #888; font-size: 13px; font-weight: 500; transition: all 0.15s; }
      .arch-tab:hover { border-color: #444; color: #ccc; }
      .arch-tab.active { background: #1a1a2e; border-color: #4a9eda; color: #7eb8da; }
      .arch-panel { display: none; }
      .arch-panel.active { display: block; }
    </style>

    <div class="arch-tabs">
      <div class="arch-tab active" onclick="showTab('db')">Database Schema</div>
      <div class="arch-tab" onclick="showTab('files')">Files & Memory</div>
      <div class="arch-tab" onclick="showTab('flow')">Message Flow</div>
      <div class="arch-tab" onclick="showTab('deploy')">Deployment</div>
    </div>

    <!-- ═══ TAB 1: DATABASE SCHEMA ═══ -->
    <div class="arch-panel active" id="panel-db">
      <div class="arch-legend">
        <div class="arch-legend-item"><div class="arch-legend-swatch" style="background:#f0c040"></div> Primary Key</div>
        <div class="arch-legend-item"><div class="arch-legend-swatch" style="background:#7eb8da"></div> Foreign Key</div>
        <div class="arch-legend-item"><svg width="30" height="12"><line x1="0" y1="6" x2="30" y2="6" stroke="#4a9eda" stroke-width="1.5" stroke-dasharray="5,3"/></svg> Relationship</div>
      </div>
      <div class="arch-diagram">
        <svg class="arch-svg" viewBox="0 0 920 720" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <marker id="arrowBlue" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#4a9eda"/></marker>
            <marker id="arrowGreen2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#5cb85c"/></marker>
          </defs>

          <!-- Background zones -->
          <rect class="zone" x="10" y="10" width="440" height="700" fill="#0d0d12" stroke="#1a1a2e" stroke-width="1"/>
          <text x="24" y="32" class="section-title">Core Tables</text>

          <rect class="zone" x="470" y="10" width="440" height="440" fill="#0d120d" stroke="#1a2a1a" stroke-width="1"/>
          <text x="484" y="32" class="section-title">Operational Tables</text>

          <rect class="zone" x="470" y="465" width="440" height="245" fill="#120d0d" stroke="#2a1a1a" stroke-width="1"/>
          <text x="484" y="487" class="section-title">Identity & Config</text>

          <!-- ═══ chats ═══ -->
          <rect class="box" x="24" y="48" width="200" height="130" fill="#161622" stroke="#2a2a44"/>
          <text x="34" y="66" class="box-header">chats</text>
          <text x="34" y="78" class="box-sub">Chat/group metadata</text>
          <line x1="24" y1="84" x2="224" y2="84" stroke="#2a2a44"/>
          <text x="34" y="98" class="field field-pk">\u{1F511} jid</text>
          <text x="34" y="112" class="field">name</text>
          <text x="34" y="126" class="field">last_message_time</text>
          <text x="34" y="140" class="field">channel</text>
          <text x="34" y="154" class="field">is_group</text>

          <!-- ═══ messages ═══ -->
          <rect class="box" x="24" y="195" width="200" height="200" fill="#161622" stroke="#2a2a44"/>
          <text x="34" y="213" class="box-header">messages</text>
          <text x="34" y="225" class="box-sub">Full message history</text>
          <line x1="24" y1="231" x2="224" y2="231" stroke="#2a2a44"/>
          <text x="34" y="245" class="field field-pk">\u{1F511} id, chat_jid</text>
          <text x="34" y="259" class="field field-fk">\u{1F517} chat_jid \u2192 chats</text>
          <text x="34" y="273" class="field">sender / sender_name</text>
          <text x="34" y="287" class="field">content</text>
          <text x="34" y="301" class="field">timestamp</text>
          <text x="34" y="315" class="field">is_from_me / is_bot_message</text>
          <text x="34" y="329" class="field">reply_to_* (3 cols)</text>
          <text x="34" y="343" class="field">thread_id</text>
          <text x="34" y="357" class="field">is_reply_to_bot</text>

          <!-- chats -> messages relationship -->
          <line x1="124" y1="178" x2="124" y2="195" class="conn conn-data" marker-end="url(#arrowBlue)"/>

          <!-- ═══ registered_groups ═══ -->
          <rect class="box" x="24" y="415" width="200" height="170" fill="#161622" stroke="#2a2a44"/>
          <text x="34" y="433" class="box-header">registered_groups</text>
          <text x="34" y="445" class="box-sub">Group registration & config</text>
          <line x1="24" y1="451" x2="224" y2="451" stroke="#2a2a44"/>
          <text x="34" y="465" class="field field-pk">\u{1F511} jid</text>
          <text x="34" y="479" class="field">name</text>
          <text x="34" y="493" class="field">folder (UNIQUE)</text>
          <text x="34" y="507" class="field">trigger_pattern</text>
          <text x="34" y="521" class="field">requires_trigger</text>
          <text x="34" y="535" class="field">container_config (JSON)</text>
          <text x="34" y="549" class="field">is_main</text>
          <text x="34" y="563" class="field">added_at</text>

          <!-- ═══ sessions ═══ -->
          <rect class="box" x="240" y="415" width="190" height="90" fill="#161622" stroke="#2a2a44"/>
          <text x="250" y="433" class="box-header">sessions</text>
          <text x="250" y="445" class="box-sub">Claude SDK session IDs</text>
          <line x1="240" y1="451" x2="430" y2="451" stroke="#2a2a44"/>
          <text x="250" y="465" class="field field-pk">\u{1F511} group_folder</text>
          <text x="250" y="479" class="field">session_id</text>

          <!-- registered_groups -> sessions -->
          <line x1="224" y1="460" x2="240" y2="460" class="conn conn-data" marker-end="url(#arrowBlue)"/>

          <!-- ═══ router_state ═══ -->
          <rect class="box" x="240" y="195" width="190" height="80" fill="#161622" stroke="#2a2a44"/>
          <text x="250" y="213" class="box-header">router_state</text>
          <text x="250" y="225" class="box-sub">KV store for state</text>
          <line x1="240" y1="231" x2="430" y2="231" stroke="#2a2a44"/>
          <text x="250" y="245" class="field field-pk">\u{1F511} key</text>
          <text x="250" y="259" class="field">value (JSON)</text>

          <!-- ═══ scheduled_tasks ═══ -->
          <rect class="box" x="484" y="48" width="210" height="195" fill="#162216" stroke="#1a3a1a"/>
          <text x="494" y="66" class="box-header">scheduled_tasks</text>
          <text x="494" y="78" class="box-sub">Cron / interval / one-time tasks</text>
          <line x1="484" y1="84" x2="694" y2="84" stroke="#1a3a1a"/>
          <text x="494" y="98" class="field field-pk">\u{1F511} id</text>
          <text x="494" y="112" class="field field-fk">\u{1F517} group_folder</text>
          <text x="494" y="126" class="field field-fk">\u{1F517} chat_jid</text>
          <text x="494" y="140" class="field">prompt / script</text>
          <text x="494" y="154" class="field">schedule_type (cron|interval|once)</text>
          <text x="494" y="168" class="field">schedule_value</text>
          <text x="494" y="182" class="field">context_mode</text>
          <text x="494" y="196" class="field">next_run / last_run</text>
          <text x="494" y="210" class="field">status (active|paused|done)</text>
          <text x="494" y="224" class="field">last_result / created_at</text>

          <!-- ═══ task_run_logs ═══ -->
          <rect class="box" x="710" y="48" width="190" height="140" fill="#162216" stroke="#1a3a1a"/>
          <text x="720" y="66" class="box-header">task_run_logs</text>
          <text x="720" y="78" class="box-sub">Execution history</text>
          <line x1="710" y1="84" x2="900" y2="84" stroke="#1a3a1a"/>
          <text x="720" y="98" class="field field-pk">\u{1F511} id (autoincrement)</text>
          <text x="720" y="112" class="field field-fk">\u{1F517} task_id \u2192 scheduled_tasks</text>
          <text x="720" y="126" class="field">run_at</text>
          <text x="720" y="140" class="field">duration_ms</text>
          <text x="720" y="154" class="field">status (ok|error)</text>
          <text x="720" y="168" class="field">result / error</text>

          <!-- scheduled_tasks -> task_run_logs -->
          <line x1="694" y1="100" x2="710" y2="100" class="conn conn-data" marker-end="url(#arrowBlue)"/>

          <!-- ═══ user_identities ═══ -->
          <rect class="box" x="484" y="505" width="210" height="110" fill="#221616" stroke="#3a1a1a"/>
          <text x="494" y="523" class="box-header">user_identities</text>
          <text x="494" y="535" class="box-sub">Platform \u2192 KB person mapping</text>
          <line x1="484" y1="541" x2="694" y2="541" stroke="#3a1a1a"/>
          <text x="494" y="555" class="field field-pk">\u{1F511} platform_id + platform</text>
          <text x="494" y="569" class="field">kb_person</text>
          <text x="494" y="590" class="box-sub">e.g. UXXXXXXXXX/slack \u2192 person</text>
          <text x="494" y="602" class="box-sub">e.g. NNNNNNNNN/telegram \u2192 person</text>

          <!-- ═══ tag_hierarchy ═══ -->
          <rect class="box" x="710" y="505" width="190" height="110" fill="#221616" stroke="#3a1a1a"/>
          <text x="720" y="523" class="box-header">tag_hierarchy</text>
          <text x="720" y="535" class="box-sub">RBAC permission tree</text>
          <line x1="710" y1="541" x2="900" y2="541" stroke="#3a1a1a"/>
          <text x="720" y="555" class="field field-pk">\u{1F511} parent_tag + child_tag</text>
          <text x="720" y="576" class="box-sub">admin \u2192 leadership, engineering,</text>
          <text x="720" y="588" class="box-sub">creative, operations, community</text>
          <text x="720" y="600" class="box-sub">leadership \u2192 eng, creative, ops, ...</text>

          <!-- Cross-zone relationships -->
          <!-- registered_groups -> scheduled_tasks (group_folder) -->
          <path d="M 224 470 Q 350 350 484 112" class="conn conn-data" stroke-dasharray="4,4" opacity="0.5"/>

          <!-- chats -> scheduled_tasks (chat_jid) -->
          <path d="M 224 110 Q 350 80 484 126" class="conn conn-data" stroke-dasharray="4,4" opacity="0.5"/>

          <!-- Counts -->
          <rect x="484" y="280" width="200" height="90" rx="6" fill="#111" stroke="#333"/>
          <text x="494" y="300" class="box-header" style="font-size:11px">Indices</text>
          <line x1="484" y1="306" x2="684" y2="306" stroke="#333"/>
          <text x="494" y="322" class="field">messages(timestamp)</text>
          <text x="494" y="336" class="field">scheduled_tasks(next_run, status)</text>
          <text x="494" y="350" class="field">task_run_logs(task_id, run_at)</text>

          <rect x="484" y="385" width="200" height="55" rx="6" fill="#111" stroke="#333"/>
          <text x="494" y="405" class="box-header" style="font-size:11px">Storage</text>
          <line x1="484" y1="411" x2="684" y2="411" stroke="#333"/>
          <text x="494" y="427" class="field">store/messages.db (SQLite via better-sqlite3)</text>
        </svg>
      </div>
    </div>

    <!-- ═══ TAB 2: FILES & MEMORY ═══ -->
    <div class="arch-panel" id="panel-files">
      <div class="arch-diagram">
        <svg class="arch-svg" viewBox="0 0 920 680" xmlns="http://www.w3.org/2000/svg">
          <!-- Per-group memory -->
          <rect class="zone" x="10" y="10" width="430" height="360" fill="#0d0d12" stroke="#1a1a2e"/>
          <text x="24" y="32" class="section-title">Per-Group Memory</text>
          <text x="24" y="46" class="section-sub">groups/{name}/CLAUDE.md \u2014 isolated per container</text>

          <rect class="box" x="24" y="60" width="190" height="120" fill="#161622" stroke="#2a2a44"/>
          <text x="34" y="78" class="box-header">groups/global/</text>
          <line x1="24" y1="84" x2="214" y2="84" stroke="#2a2a44"/>
          <text x="34" y="98" class="field">CLAUDE.md</text>
          <text x="34" y="110" class="box-sub">Global instructions for all groups</text>
          <text x="34" y="126" class="field">personality.md</text>
          <text x="34" y="138" class="box-sub">Lauryn Hill-inspired voice</text>
          <text x="34" y="154" class="field">\u2192 mounted read-only in containers</text>

          <rect class="box" x="230" y="60" width="190" height="100" fill="#161622" stroke="#2a2a44"/>
          <text x="240" y="78" class="box-header">groups/main/</text>
          <line x1="230" y1="84" x2="420" y2="84" stroke="#2a2a44"/>
          <text x="240" y="98" class="field">CLAUDE.md</text>
          <text x="240" y="110" class="box-sub">Main control group (elevated)</text>
          <text x="240" y="126" class="field">is_main=true</text>
          <text x="240" y="138" class="box-sub">Has project root access (ro)</text>

          <rect class="box" x="24" y="195" width="190" height="80" fill="#161622" stroke="#2a2a44"/>
          <text x="34" y="213" class="box-header">groups/telegram_example/</text>
          <line x1="24" y1="219" x2="214" y2="219" stroke="#2a2a44"/>
          <text x="34" y="233" class="field">CLAUDE.md</text>
          <text x="34" y="245" class="box-sub">Telegram DM context</text>

          <rect class="box" x="230" y="195" width="190" height="80" fill="#161622" stroke="#2a2a44"/>
          <text x="240" y="213" class="box-header">groups/slack_main/</text>
          <line x1="230" y1="219" x2="420" y2="219" stroke="#2a2a44"/>
          <text x="240" y="233" class="field">CLAUDE.md + context/</text>
          <text x="240" y="245" class="box-sub">Slack main channel + KB</text>

          <!-- Format spec -->
          <rect class="box" x="24" y="290" width="396" height="65" fill="#111" stroke="#333"/>
          <text x="34" y="308" class="box-header" style="font-size:11px">CLAUDE.md Format</text>
          <line x1="24" y1="314" x2="420" y2="314" stroke="#333"/>
          <text x="34" y="330" class="field">Markdown with YAML frontmatter: title, tags, visibility, created_by</text>
          <text x="34" y="344" class="field">Versioned via Git \u2014 groups/ tracked in repo</text>

          <!-- KB Context -->
          <rect class="zone" x="470" y="10" width="440" height="360" fill="#0d120d" stroke="#1a3a1a"/>
          <text x="484" y="32" class="section-title">Knowledge Base (KB Context)</text>
          <text x="484" y="46" class="section-sub">groups/slack_main/context/ \u2014 deployed to /opt/breadbrich/</text>

          <rect class="box" x="484" y="60" width="200" height="80" fill="#162216" stroke="#1a3a1a"/>
          <text x="494" y="78" class="box-header">\u{1F465} people/</text>
          <line x1="484" y1="84" x2="684" y2="84" stroke="#1a3a1a"/>
          <text x="494" y="98" class="field">bob.md, alice.md, carol.md, ...</text>
          <text x="494" y="112" class="field">Personnel Notes (admin-only section)</text>
          <text x="494" y="124" class="box-sub">visibility: restricted</text>

          <rect class="box" x="700" y="60" width="200" height="80" fill="#162216" stroke="#1a3a1a"/>
          <text x="710" y="78" class="box-header">\u{2705} tasks/</text>
          <line x1="700" y1="84" x2="900" y2="84" stroke="#1a3a1a"/>
          <text x="710" y="98" class="field">TASK-001.md, TASK-002.md, ...</text>
          <text x="710" y="112" class="field">owners, priority, linked_events</text>
          <text x="710" y="124" class="box-sub">visibility: open/restricted</text>

          <rect class="box" x="484" y="155" width="200" height="65" fill="#162216" stroke="#1a3a1a"/>
          <text x="494" y="173" class="box-header">\u{1F4C5} calendar/</text>
          <line x1="484" y1="179" x2="684" y2="179" stroke="#1a3a1a"/>
          <text x="494" y="193" class="field">Events, upcoming.md</text>
          <text x="494" y="205" class="box-sub">linked_tasks for cross-refs</text>

          <rect class="box" x="700" y="155" width="200" height="65" fill="#162216" stroke="#1a3a1a"/>
          <text x="710" y="173" class="box-header">\u{1F4E6} artifacts/</text>
          <line x1="700" y1="179" x2="900" y2="179" stroke="#1a3a1a"/>
          <text x="710" y="193" class="field">Project artifacts, deliverables</text>
          <text x="710" y="205" class="box-sub">visibility: open/restricted</text>

          <rect class="box" x="484" y="235" width="200" height="55" fill="#162216" stroke="#1a3a1a"/>
          <text x="494" y="253" class="box-header">\u{1F3E0} spaces/</text>
          <line x1="484" y1="259" x2="684" y2="259" stroke="#1a3a1a"/>
          <text x="494" y="273" class="field">Physical spaces metadata</text>

          <rect class="box" x="700" y="235" width="200" height="55" fill="#162216" stroke="#1a3a1a"/>
          <text x="710" y="253" class="box-header">\u{1F4C4} index.md</text>
          <line x1="700" y1="259" x2="900" y2="259" stroke="#1a3a1a"/>
          <text x="710" y="273" class="field">KB root doc, ## Admins section</text>

          <!-- KB File format -->
          <rect class="box" x="484" y="305" width="416" height="50" fill="#111" stroke="#333"/>
          <text x="494" y="323" class="box-header" style="font-size:11px">KB Document Format</text>
          <line x1="484" y1="329" x2="900" y2="329" stroke="#333"/>
          <text x="494" y="343" class="field">YAML frontmatter: title, tags[], visibility (open|restricted|private), created_by, created_at, editable_by</text>

          <!-- Versioning -->
          <rect class="zone" x="10" y="385" width="900" height="140" fill="#120d0d" stroke="#2a1a1a"/>
          <text x="24" y="407" class="section-title">Versioning & Git</text>

          <rect class="box" x="24" y="420" width="260" height="90" fill="#221616" stroke="#3a1a1a"/>
          <text x="34" y="438" class="box-header">Git Remotes</text>
          <line x1="24" y1="444" x2="284" y2="444" stroke="#3a1a1a"/>
          <text x="34" y="460" class="field">origin \u2192 github.com/qwibitai/nanoclaw</text>
          <text x="34" y="474" class="field">slack  \u2192 github.com/qwibitai/nanoclaw-slack</text>
          <text x="34" y="488" class="field">telegram \u2192 github.com/qwibitai/nanoclaw-telegram</text>

          <rect class="box" x="300" y="420" width="210" height="90" fill="#221616" stroke="#3a1a1a"/>
          <text x="310" y="438" class="box-header">Branching</text>
          <line x1="300" y1="444" x2="510" y2="444" stroke="#3a1a1a"/>
          <text x="310" y="460" class="field">main \u2014 core Breadbrich Engels</text>
          <text x="310" y="474" class="field">skill/add-slack \u2014 Slack channel</text>
          <text x="310" y="488" class="field">skill/add-telegram \u2014 Telegram channel</text>

          <rect class="box" x="526" y="420" width="190" height="90" fill="#221616" stroke="#3a1a1a"/>
          <text x="536" y="438" class="box-header">Package</text>
          <line x1="526" y1="444" x2="716" y2="444" stroke="#3a1a1a"/>
          <text x="536" y="460" class="field">Breadbrich Engels v1.2.47</text>
          <text x="536" y="474" class="field">CHANGELOG.md</text>
          <text x="536" y="488" class="field">Husky pre-commit hooks</text>

          <rect class="box" x="732" y="420" width="170" height="90" fill="#221616" stroke="#3a1a1a"/>
          <text x="742" y="438" class="box-header">KB Versioning</text>
          <line x1="732" y1="444" x2="902" y2="444" stroke="#3a1a1a"/>
          <text x="742" y="460" class="field">Git-tracked files</text>
          <text x="742" y="474" class="field">frontmatter timestamps</text>
          <text x="742" y="488" class="field">No migrations (file-based)</text>

          <!-- Container Skills -->
          <rect class="zone" x="10" y="540" width="900" height="125" fill="#0d0d12" stroke="#1a1a2e"/>
          <text x="24" y="562" class="section-title">Container Skills & IPC</text>

          <rect class="box" x="24" y="575" width="170" height="75" fill="#161622" stroke="#2a2a44"/>
          <text x="34" y="593" class="box-header">container/skills/</text>
          <line x1="24" y1="599" x2="194" y2="599" stroke="#2a2a44"/>
          <text x="34" y="613" class="field">browser, status, formatting</text>
          <text x="34" y="627" class="field">Loaded inside agents at runtime</text>

          <rect class="box" x="210" y="575" width="220" height="75" fill="#161622" stroke="#2a2a44"/>
          <text x="220" y="593" class="box-header">data/ipc/{group}/</text>
          <line x1="210" y1="599" x2="430" y2="599" stroke="#2a2a44"/>
          <text x="220" y="613" class="field">messages/ \u2014 outbound messages</text>
          <text x="220" y="627" class="field">tasks/ \u2014 task scheduling, group ops</text>

          <rect class="box" x="446" y="575" width="220" height="75" fill="#161622" stroke="#2a2a44"/>
          <text x="456" y="593" class="box-header">Container Mounts</text>
          <line x1="446" y1="599" x2="666" y2="599" stroke="#2a2a44"/>
          <text x="456" y="613" class="field">/workspace/group \u2190 group folder (rw)</text>
          <text x="456" y="627" class="field">/workspace/global \u2190 global KB (ro)</text>

          <rect class="box" x="682" y="575" width="220" height="75" fill="#161622" stroke="#2a2a44"/>
          <text x="692" y="593" class="box-header">Container Limits</text>
          <line x1="682" y1="599" x2="902" y2="599" stroke="#2a2a44"/>
          <text x="692" y="613" class="field">Timeout: 30min | Max output: 10MB</text>
          <text x="692" y="627" class="field">Max concurrent: 5 containers</text>
        </svg>
      </div>
    </div>

    <!-- ═══ TAB 3: MESSAGE FLOW ═══ -->
    <div class="arch-panel" id="panel-flow">
      <div class="arch-diagram">
        <svg class="arch-svg" viewBox="0 0 920 520" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <marker id="arrowGreen" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#5cb85c"/></marker>
            <marker id="arrowOrange" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#e0a050"/></marker>
            <marker id="arrowPurple" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#7e7eda"/></marker>
          </defs>

          <text x="20" y="22" class="section-title">Inbound Message Flow</text>

          <!-- Channel boxes -->
          <rect class="box" x="20" y="40" width="120" height="40" fill="#1a2a1a" stroke="#3a5a3a"/>
          <text x="50" y="64" class="box-header" style="fill:#5cb85c">Slack</text>

          <rect class="box" x="20" y="95" width="120" height="40" fill="#1a2a1a" stroke="#3a5a3a"/>
          <text x="38" y="119" class="box-header" style="fill:#5cb85c">Telegram</text>

          <rect class="box" x="20" y="150" width="120" height="40" fill="#1a1a1a" stroke="#333"/>
          <text x="55" y="174" class="box-header" style="fill:#888">CLI</text>

          <!-- Arrow: channels -> SQLite -->
          <line x1="140" y1="60" x2="200" y2="100" stroke="#5cb85c" stroke-width="1.5" marker-end="url(#arrowGreen)"/>
          <line x1="140" y1="115" x2="200" y2="108" stroke="#5cb85c" stroke-width="1.5" marker-end="url(#arrowGreen)"/>
          <line x1="140" y1="170" x2="200" y2="116" stroke="#5cb85c" stroke-width="1.5" marker-end="url(#arrowGreen)"/>

          <!-- SQLite -->
          <rect class="box" x="200" y="80" width="130" height="55" fill="#222" stroke="#444"/>
          <text x="220" y="104" class="box-header">\u{1F4BE} SQLite</text>
          <text x="220" y="120" class="field">messages + chats</text>

          <!-- Arrow: SQLite -> Router -->
          <line x1="330" y1="108" x2="380" y2="108" stroke="#e0a050" stroke-width="1.5" marker-end="url(#arrowOrange)"/>
          <text x="335" y="100" class="col-label">2s poll</text>

          <!-- Router -->
          <rect class="box" x="380" y="70" width="140" height="80" fill="#2a2a1a" stroke="#444a1a"/>
          <text x="410" y="94" class="box-header" style="fill:#e0a050">Router Loop</text>
          <text x="390" y="110" class="field">Trigger check</text>
          <text x="390" y="124" class="field">Identity resolution</text>
          <text x="390" y="138" class="field">XML context build</text>

          <!-- Arrow: Router -> Container -->
          <line x1="520" y1="108" x2="580" y2="108" stroke="#7e7eda" stroke-width="1.5" marker-end="url(#arrowPurple)"/>
          <text x="528" y="100" class="col-label">stdin</text>

          <!-- Container -->
          <rect class="box" x="580" y="55" width="160" height="110" fill="#1a1a2a" stroke="#2a2a5a"/>
          <text x="610" y="79" class="box-header" style="fill:#7e7eda">Container</text>
          <text x="590" y="95" class="field">Docker / Apple Container</text>
          <text x="590" y="109" class="field">Claude Agent SDK</text>
          <text x="590" y="123" class="field">MCP tools + skills</text>
          <text x="590" y="137" class="field">Credential proxy :3001</text>
          <text x="590" y="151" class="field">Isolated filesystem</text>

          <!-- Arrow: Container -> IPC -->
          <line x1="740" y1="108" x2="790" y2="108" stroke="#d9534f" stroke-width="1.5" marker-end="url(#arrowOrange)"/>

          <!-- IPC -->
          <rect class="box" x="790" y="80" width="115" height="55" fill="#2a1a1a" stroke="#5a2a2a"/>
          <text x="810" y="104" class="box-header" style="fill:#d9534f">IPC Watcher</text>
          <text x="800" y="120" class="field">data/ipc/{group}/</text>

          <!-- Return flow -->
          <text x="20" y="220" class="section-title">Outbound / Response Flow</text>

          <rect class="box" x="790" y="240" width="115" height="40" fill="#2a1a1a" stroke="#5a2a2a"/>
          <text x="800" y="264" class="box-header" style="fill:#d9534f">IPC tasks/</text>

          <line x1="790" y1="260" x2="700" y2="260" stroke="#d9534f" stroke-width="1.5" marker-end="url(#arrowOrange)"/>

          <rect class="box" x="540" y="240" width="160" height="40" fill="#2a2a1a" stroke="#444a1a"/>
          <text x="565" y="264" class="box-header" style="fill:#e0a050">Router Dispatch</text>

          <line x1="700" y1="260" x2="700" y2="260" stroke="#e0a050" stroke-width="1.5"/>
          <line x1="540" y1="260" x2="380" y2="260" stroke="#5cb85c" stroke-width="1.5" marker-end="url(#arrowGreen)"/>

          <rect class="box" x="220" y="240" width="160" height="55" fill="#1a2a1a" stroke="#3a5a3a"/>
          <text x="240" y="264" class="box-header" style="fill:#5cb85c">Channel Send</text>
          <text x="230" y="280" class="field">Slack: ack + edit pattern</text>

          <!-- Scheduler flow -->
          <text x="20" y="330" class="section-title">Scheduled Tasks</text>

          <rect class="box" x="20" y="345" width="140" height="55" fill="#162216" stroke="#1a3a1a"/>
          <text x="30" y="368" class="box-header" style="fill:#5cb85c">Task Scheduler</text>
          <text x="30" y="383" class="field">60s poll interval</text>

          <line x1="160" y1="370" x2="220" y2="370" stroke="#5cb85c" stroke-width="1.5" marker-end="url(#arrowGreen)"/>

          <rect class="box" x="220" y="345" width="140" height="55" fill="#222" stroke="#444"/>
          <text x="230" y="368" class="box-header">scheduled_tasks</text>
          <text x="230" y="383" class="field">next_run < now?</text>

          <line x1="360" y1="370" x2="420" y2="370" stroke="#e0a050" stroke-width="1.5" marker-end="url(#arrowOrange)"/>

          <rect class="box" x="420" y="345" width="140" height="55" fill="#1a1a2a" stroke="#2a2a5a"/>
          <text x="440" y="368" class="box-header" style="fill:#7e7eda">Container</text>
          <text x="430" y="383" class="field">Runs prompt / script</text>

          <line x1="560" y1="370" x2="620" y2="370" stroke="#d9534f" stroke-width="1.5" marker-end="url(#arrowOrange)"/>

          <rect class="box" x="620" y="345" width="140" height="55" fill="#222" stroke="#444"/>
          <text x="630" y="368" class="box-header">task_run_logs</text>
          <text x="630" y="383" class="field">duration, status, result</text>

          <!-- Model routing -->
          <text x="20" y="435" class="section-title">Model Routing</text>

          <rect class="box" x="20" y="450" width="200" height="55" fill="#1a1a2a" stroke="#2a2a5a"/>
          <text x="30" y="468" class="box-header" style="fill:#7e7eda">Orchestrator</text>
          <text x="30" y="485" class="field">claude-opus-4-6</text>

          <rect class="box" x="240" y="450" width="200" height="55" fill="#1a1a2a" stroke="#2a2a5a"/>
          <text x="250" y="468" class="box-header" style="fill:#7e7eda">Sub-agents</text>
          <text x="250" y="485" class="field">claude-sonnet-4-6</text>

          <rect class="box" x="460" y="450" width="200" height="55" fill="#222" stroke="#444"/>
          <text x="470" y="468" class="box-header">Credentials</text>
          <text x="470" y="485" class="field">OneCLI Agent Vault (proxy :3001)</text>
        </svg>
      </div>
    </div>

    <!-- ═══ TAB 4: DEPLOYMENT ═══ -->
    <div class="arch-panel" id="panel-deploy">
      <div class="arch-diagram">
        <svg class="arch-svg" viewBox="0 0 920 540" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <marker id="arrowWhite" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#888"/></marker>
          </defs>

          <!-- Internet -->
          <rect class="zone" x="10" y="10" width="900" height="70" fill="#0a0f0a" stroke="#1a2a1a"/>
          <text x="24" y="32" class="section-title" style="fill:#5cb85c">External Services</text>

          <rect class="box" x="24" y="42" width="110" height="28" fill="#162216" stroke="#1a3a1a"/>
          <text x="40" y="60" class="field" style="fill:#5cb85c">Slack API</text>

          <rect class="box" x="150" y="42" width="130" height="28" fill="#162216" stroke="#1a3a1a"/>
          <text x="162" y="60" class="field" style="fill:#5cb85c">Telegram Bot API</text>

          <rect class="box" x="296" y="42" width="110" height="28" fill="#162216" stroke="#1a3a1a"/>
          <text x="310" y="60" class="field" style="fill:#5cb85c">Gmail SMTP</text>

          <rect class="box" x="422" y="42" width="130" height="28" fill="#162216" stroke="#1a3a1a"/>
          <text x="436" y="60" class="field" style="fill:#5cb85c">Anthropic API</text>

          <rect class="box" x="568" y="42" width="120" height="28" fill="#162216" stroke="#1a3a1a"/>
          <text x="580" y="60" class="field" style="fill:#5cb85c">GitHub</text>

          <rect class="box" x="704" y="42" width="120" height="28" fill="#162216" stroke="#1a3a1a"/>
          <text x="710" y="60" class="field" style="fill:#5cb85c">Cloudflare Tunnel</text>

          <!-- Droplet -->
          <rect class="zone" x="10" y="95" width="560" height="310" fill="#0d0d12" stroke="#1a1a2e"/>
          <text x="24" y="117" class="section-title">DigitalOcean Droplet</text>
          <text x="24" y="131" class="section-sub">${process.env.BREADBRICH_DROPLET_LABEL || 'configured droplet'} \u2014 Ubuntu</text>

          <!-- NanoClaw process -->
          <rect class="box" x="24" y="145" width="230" height="110" fill="#161622" stroke="#2a2a44"/>
          <text x="34" y="163" class="box-header">Breadbrich Engels Process</text>
          <text x="34" y="175" class="box-sub">node dist/index.js (systemd)</text>
          <line x1="24" y1="181" x2="254" y2="181" stroke="#2a2a44"/>
          <text x="34" y="197" class="field">\u{25B6} Channel registry (Slack + TG)</text>
          <text x="34" y="211" class="field">\u{25B6} Router loop (2s poll)</text>
          <text x="34" y="225" class="field">\u{25B6} Task scheduler (60s poll)</text>
          <text x="34" y="239" class="field">\u{25B6} IPC watcher</text>

          <!-- SQLite -->
          <rect class="box" x="270" y="145" width="140" height="55" fill="#222" stroke="#444"/>
          <text x="280" y="163" class="box-header">\u{1F4BE} SQLite</text>
          <text x="280" y="179" class="field">store/messages.db</text>
          <text x="280" y="191" class="box-sub">9 tables</text>

          <!-- Credential Proxy -->
          <rect class="box" x="270" y="215" width="140" height="40" fill="#2a1a2a" stroke="#4a2a4a"/>
          <text x="280" y="233" class="box-header" style="fill:#b07eb8">OneCLI Vault</text>
          <text x="280" y="247" class="field">:3001 credential proxy</text>

          <!-- Containers -->
          <rect class="box" x="24" y="270" width="530" height="120" fill="#111" stroke="#333"/>
          <text x="34" y="288" class="box-header">Docker Containers (max 5 concurrent)</text>
          <line x1="24" y1="294" x2="554" y2="294" stroke="#333"/>

          <rect x="34" y="305" width="115" height="70" rx="4" fill="#1a1a2a" stroke="#2a2a5a"/>
          <text x="44" y="323" class="field" style="fill:#7e7eda">Agent 1</text>
          <text x="44" y="337" class="field">slack_main</text>
          <text x="44" y="351" class="field">Claude SDK</text>
          <text x="44" y="365" class="box-sub">rw: group + store</text>

          <rect x="159" y="305" width="115" height="70" rx="4" fill="#1a1a2a" stroke="#2a2a5a"/>
          <text x="169" y="323" class="field" style="fill:#7e7eda">Agent 2</text>
          <text x="169" y="337" class="field">tg_example</text>
          <text x="169" y="351" class="field">Claude SDK</text>
          <text x="169" y="365" class="box-sub">rw: group only</text>

          <rect x="284" y="305" width="115" height="70" rx="4" fill="#1a1a2a" stroke="#2a2a5a" stroke-dasharray="4,2"/>
          <text x="294" y="323" class="field" style="fill:#555">Agent 3</text>
          <text x="294" y="337" class="field" style="fill:#555">(idle)</text>

          <rect x="409" y="305" width="135" height="70" rx="4" fill="#111" stroke="#333"/>
          <text x="419" y="330" class="field">node:22-slim</text>
          <text x="419" y="344" class="field">Chromium + fonts</text>
          <text x="419" y="358" class="field">agent-browser</text>
          <text x="419" y="372" class="box-sub">Base image</text>

          <!-- KB UI -->
          <rect class="zone" x="590" y="95" width="320" height="200" fill="#120d0d" stroke="#2a1a1a"/>
          <text x="604" y="117" class="section-title">KB Web Dashboard</text>
          <text x="604" y="131" class="section-sub">Express :8080 \u2014 via Cloudflare Tunnel</text>

          <rect class="box" x="604" y="145" width="140" height="135" fill="#221616" stroke="#3a1a1a"/>
          <text x="614" y="163" class="box-header">Routes</text>
          <line x1="604" y1="169" x2="744" y2="169" stroke="#3a1a1a"/>
          <text x="614" y="185" class="field">/ \u2014 Dashboard home</text>
          <text x="614" y="199" class="field">/category/:name</text>
          <text x="614" y="213" class="field">/doc/:cat/:file</text>
          <text x="614" y="227" class="field">/linkages</text>
          <text x="614" y="241" class="field">/logs (admin)</text>
          <text x="614" y="255" class="field">/admin (superadmin)</text>
          <text x="614" y="269" class="field" style="fill:#f0c040">/architecture (admin)</text>

          <rect class="box" x="758" y="145" width="140" height="80" fill="#221616" stroke="#3a1a1a"/>
          <text x="768" y="163" class="box-header">Auth</text>
          <line x1="758" y1="169" x2="898" y2="169" stroke="#3a1a1a"/>
          <text x="768" y="185" class="field">Basic Auth</text>
          <text x="768" y="199" class="field">users.json</text>
          <text x="768" y="213" class="field">Role: admin/super/coord</text>

          <!-- Logs dir -->
          <rect class="zone" x="590" y="310" width="320" height="95" fill="#0d0d0d" stroke="#222"/>
          <text x="604" y="332" class="section-title" style="font-size:12px">Logs & Data</text>

          <text x="604" y="355" class="field">logs/breadbrich.log (stdout)</text>
          <text x="604" y="369" class="field">logs/breadbrich.error.log (stderr)</text>
          <text x="604" y="383" class="field">data/ipc/{group}/ (task files)</text>
          <text x="604" y="397" class="field">data/env/env (container .env mirror)</text>

          <!-- Deploy flow -->
          <rect class="zone" x="10" y="420" width="900" height="110" fill="#0a0a0f" stroke="#1a1a2e"/>
          <text x="24" y="442" class="section-title">Deploy Pipeline</text>

          <rect class="box" x="24" y="455" width="130" height="50" fill="#161622" stroke="#2a2a44"/>
          <text x="34" y="475" class="box-header">git push</text>
          <text x="34" y="489" class="field">qwibitai/nanoclaw</text>

          <line x1="154" y1="480" x2="190" y2="480" stroke="#888" stroke-width="1.5" marker-end="url(#arrowWhite)"/>

          <rect class="box" x="190" y="455" width="130" height="50" fill="#161622" stroke="#2a2a44"/>
          <text x="200" y="475" class="box-header">SSH deploy.sh</text>
          <text x="200" y="489" class="field">rsync + build</text>

          <line x1="320" y1="480" x2="356" y2="480" stroke="#888" stroke-width="1.5" marker-end="url(#arrowWhite)"/>

          <rect class="box" x="356" y="455" width="140" height="50" fill="#161622" stroke="#2a2a44"/>
          <text x="366" y="475" class="box-header">npm run build</text>
          <text x="366" y="489" class="field">tsc \u2192 dist/</text>

          <line x1="496" y1="480" x2="532" y2="480" stroke="#888" stroke-width="1.5" marker-end="url(#arrowWhite)"/>

          <rect class="box" x="532" y="455" width="160" height="50" fill="#161622" stroke="#2a2a44"/>
          <text x="542" y="475" class="box-header">systemctl restart</text>
          <text x="542" y="489" class="field">breadbrich service</text>

          <line x1="692" y1="480" x2="728" y2="480" stroke="#888" stroke-width="1.5" marker-end="url(#arrowWhite)"/>

          <rect class="box" x="728" y="455" width="170" height="50" fill="#162216" stroke="#1a3a1a"/>
          <text x="738" y="475" class="box-header" style="fill:#5cb85c">container/build.sh</text>
          <text x="738" y="489" class="field">Rebuild agent image</text>
        </svg>
      </div>
    </div>

    <script>
      function showTab(id) {
        document.querySelectorAll('.arch-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.arch-panel').forEach(p => p.classList.remove('active'));
        document.getElementById('panel-' + id).classList.add('active');
        event.target.classList.add('active');
      }
    </script>
  `;

  res.send(layout('Architecture', body, username));
});

// --- Task Location API ---

const BUILDING_FLOORS = {
  school: new Set(['basement', 'ground', 'first', 'second', 'third']),
  organization: new Set(['basement', 'ground', 'first', 'second', 'third']),
};

app.get('/api/tasks/located', (req, res) => {
  const username = req.auth.user;
  const rawBuilding = req.query.building;
  const buildingFilter =
    typeof rawBuilding === 'string' && Object.prototype.hasOwnProperty.call(BUILDING_FLOORS, rawBuilding)
      ? rawBuilding
      : null;
  const tasksDir = path.join(CONTEXT_DIR, 'tasks');
  if (!fs.existsSync(tasksDir)) return res.json([]);
  const files = walkDir(tasksDir).filter(f => f.name.startsWith('TASK-'));
  const located = [];
  for (const f of files) {
    try {
      const { frontmatter } = readDoc(f.fullPath);
      if (!canView(frontmatter, username)) continue;
      if (frontmatter.location_floor) {
        // Pre-multi-building tasks default to "school" (the original single building).
        const building = frontmatter.location_building || 'school';
        if (buildingFilter && building !== buildingFilter) continue;
        located.push({
          id: frontmatter.id,
          title: frontmatter.title,
          status: frontmatter.status,
          priority: frontmatter.priority,
          building,
          floor: frontmatter.location_floor,
          x: frontmatter.location_x,
          z: frontmatter.location_z,
          room: frontmatter.location_room || null,
        });
      }
    } catch {}
  }
  res.json(located);
});

app.post('/api/tasks', (req, res) => {
  const username = req.auth.user;
  if (!isAdmin(username) && !isCoordinator(username)) {
    return res.status(403).json({ error: 'Permission denied' });
  }

  const { title, description, priority, building, floor, x, z, room } = req.body;
  if (!title || !floor || x == null || z == null) {
    return res.status(400).json({ error: 'Missing required fields: title, floor, x, z' });
  }
  const buildingId = building || 'school';
  if (!Object.prototype.hasOwnProperty.call(BUILDING_FLOORS, buildingId)) {
    return res.status(400).json({ error: 'Invalid building' });
  }
  if (!BUILDING_FLOORS[buildingId].has(floor)) {
    return res.status(400).json({ error: 'Invalid floor for building' });
  }
  const locationX = Number(x);
  const locationZ = Number(z);
  if (!Number.isFinite(locationX) || !Number.isFinite(locationZ)) {
    return res.status(400).json({ error: 'x and z must be finite numbers' });
  }

  const tasksDir = path.join(CONTEXT_DIR, 'tasks');
  if (!fs.existsSync(tasksDir)) fs.mkdirSync(tasksDir, { recursive: true });

  // Find next TASK-NNN ID
  const existing = fs.readdirSync(tasksDir).filter(f => /^TASK-\d+\.md$/.test(f));
  const maxId = existing.reduce((max, f) => {
    const n = parseInt(f.match(/TASK-(\d+)/)[1], 10);
    return n > max ? n : max;
  }, 0);
  const nextId = `TASK-${String(maxId + 1).padStart(3, '0')}`;
  const today = new Date().toISOString().slice(0, 10);

  const content = `---
title: "${title.replace(/"/g, '\\"')}"
id: ${nextId}
status: open
priority: ${priority || 'medium'}
created_by: ${username}
created_at: ${today}
last_edited: ${today}
owners: [${username}]
stakeholders: []
upstream: []
downstream: []
linked_events: []
tags: [building, location-pinned]
visibility: open
editable_by: open
location_building: "${buildingId}"
location_floor: "${floor}"
location_x: ${locationX}
location_z: ${locationZ}
${room ? `location_room: "${room.replace(/"/g, '\\"')}"` : ''}
---

# ${title}

## Description

${description || 'Task created from building map pin.'}

## Checklist

- [ ] (add subtasks)

## Dependencies

None.

## Comments

| Date | User | Comment |
|------|------|---------|
| ${today} | ${username} | Created via building map pin drop (Building: ${buildingId}, Floor: ${floor}${room ? ', Room: ' + room : ''}) |
`;

  const filePath = path.join(tasksDir, `${nextId}.md`);
  fs.writeFileSync(filePath, content, 'utf-8');

  res.json({ id: nextId, file: `${nextId}.md` });
});

// --- Building Map Route ---

app.get('/map', (req, res) => {
  const username = req.auth.user;
  const canCreate = isAdmin(username) || isCoordinator(username);
  const requested = (req.query.building || 'school').toString();
  const buildingId = (requested === 'organization' ? 'organization' : 'school');

  const BUILDING_META = {
    school: {
      name: 'the annex',
      address: '456 Example Avenue',
      tag: 'Community space & cultural hub',
      totalArea: '18,000 sf',
      built: '1930',
      style: 'Romanesque Revival',
      floorCount: '4 levels',
    },
    organization: {
      name: 'the organization',
      address: '123 Example Street',
      tag: 'Offices &amp; studios',
      totalArea: '4,754 sf',
      built: '—',
      style: 'Loft',
      floorCount: '3 floors',
    },
  };
  const meta = BUILDING_META[buildingId];

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Building Map — ${meta.name}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a0a; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  #canvas { width: 100vw; height: 100vh; display: block; }

  #panel {
    position: fixed; left: 20px; top: 20px; width: 280px; z-index: 100;
    background: rgba(10,10,15,0.85); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
    border-radius: 14px; border: 1px solid rgba(255,255,255,0.08);
    padding: 20px 16px; color: #fff; user-select: none;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    max-height: calc(100vh - 40px); overflow-y: auto;
  }
  #panel h1 { font-family: Georgia,"Times New Roman",serif; font-size: 18px; font-weight: 400; letter-spacing: 0.12em; margin-bottom: 2px; }
  #panel .sub { font-size: 11px; color: rgba(255,255,255,0.5); margin-bottom: 4px; }
  #panel .tag { font-size: 10px; color: rgba(255,255,255,0.3); font-style: italic; margin-bottom: 16px; }
  .divider { height: 1px; background: rgba(255,255,255,0.08); margin: 0 0 14px 0; }
  .section-label { font-size: 9px; font-weight: 600; letter-spacing: 0.1em; color: rgba(255,255,255,0.35); text-transform: uppercase; margin-bottom: 8px; }

  .floor-btn {
    width: 100%; padding: 10px 12px; margin-bottom: 4px; border-radius: 8px;
    border: 1px solid transparent; background: rgba(255,255,255,0.03); color: #fff;
    cursor: pointer; display: flex; flex-direction: column; align-items: flex-start;
    transition: all 0.2s ease; outline: none; text-align: left; font-family: inherit;
  }
  .floor-btn:hover { background: rgba(255,255,255,0.06); }

  .bld-btn {
    flex: 1; padding: 7px 8px; border-radius: 6px; text-align: center;
    background: rgba(255,255,255,0.04); color: rgba(255,255,255,0.55);
    border: 1px solid rgba(255,255,255,0.08); text-decoration: none;
    font-size: 11px; font-weight: 500; letter-spacing: 0.02em;
    transition: all 0.2s ease;
  }
  .bld-btn:hover { background: rgba(255,255,255,0.08); color: #fff; }
  .bld-btn.active { background: rgba(59,130,246,0.18); color: #fff; border-color: rgba(59,130,246,0.4); }

  .floor-btn .fname { font-size: 13px; font-weight: 500; line-height: 1.3; }
  .floor-btn .fsub { font-size: 10px; opacity: 0.45; margin-top: 1px; }
  .floor-btn .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 8px; vertical-align: middle; }

  .ctrl-btn {
    width: 100%; padding: 8px 12px; margin-bottom: 4px; border-radius: 8px;
    border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.04);
    color: rgba(255,255,255,0.7); cursor: pointer; font-size: 12px; font-weight: 400;
    transition: all 0.2s ease; outline: none; text-align: left; font-family: inherit;
    display: flex; align-items: center; gap: 8px;
  }
  .ctrl-btn:hover { background: rgba(255,255,255,0.08); color: #fff; }
  .ctrl-btn.active { border-color: rgba(239,68,68,0.5); background: rgba(239,68,68,0.12); color: #f87171; }

  #info-toggle {
    width: 100%; padding: 8px 0; margin-top: 10px; background: none; border: none;
    color: rgba(255,255,255,0.35); cursor: pointer; font-size: 10px; font-weight: 500;
    letter-spacing: 0.08em; text-transform: uppercase; outline: none;
    display: flex; align-items: center; justify-content: space-between; font-family: inherit;
    transition: color 0.2s ease;
  }
  #info-toggle:hover { color: rgba(255,255,255,0.6); }
  #info-panel { overflow: hidden; transition: max-height 0.3s ease, opacity 0.3s ease; max-height: 0; opacity: 0; }
  #info-panel.open { max-height: 200px; opacity: 1; }
  .info-row { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
  .info-row .il { font-size: 11px; color: rgba(255,255,255,0.35); }
  .info-row .iv { font-size: 11px; color: rgba(255,255,255,0.7); font-weight: 500; }

  .controls-help { font-size: 10px; color: rgba(255,255,255,0.4); line-height: 1.7; }
  .controls-help .row { display: flex; justify-content: space-between; }
  .controls-help .key { color: rgba(255,255,255,0.55); font-family: monospace; }

  /* Task form modal */
  #task-modal {
    display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    z-index: 200; background: rgba(15,15,20,0.95); backdrop-filter: blur(20px);
    border: 1px solid rgba(255,255,255,0.12); border-radius: 14px;
    padding: 24px; width: 360px; color: #fff;
    box-shadow: 0 16px 64px rgba(0,0,0,0.6);
  }
  #task-modal.visible { display: block; }
  #task-modal h2 { font-size: 16px; margin-bottom: 4px; }
  #task-modal .modal-sub { font-size: 11px; color: rgba(255,255,255,0.4); margin-bottom: 16px; }
  #task-modal label { font-size: 11px; color: rgba(255,255,255,0.5); display: block; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.05em; }
  #task-modal input, #task-modal textarea, #task-modal select {
    width: 100%; padding: 8px 10px; margin-bottom: 12px; border-radius: 6px;
    border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.06);
    color: #fff; font-family: inherit; font-size: 13px; outline: none;
  }
  #task-modal input:focus, #task-modal textarea:focus, #task-modal select:focus { border-color: rgba(255,255,255,0.25); }
  #task-modal textarea { resize: vertical; min-height: 60px; }
  #task-modal select option { background: #1a1a2a; }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
  .modal-actions button {
    padding: 8px 16px; border-radius: 6px; border: none; cursor: pointer;
    font-size: 13px; font-weight: 500; font-family: inherit;
  }
  .btn-cancel { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.6); }
  .btn-cancel:hover { background: rgba(255,255,255,0.12); }
  .btn-create { background: rgba(59,130,246,0.8); color: #fff; }
  .btn-create:hover { background: rgba(59,130,246,1); }

  /* Overlay for modal */
  #modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 190; }
  #modal-overlay.visible { display: block; }

  /* Pin mode indicator */
  #pin-mode-banner {
    display: none; position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
    z-index: 150; background: rgba(239,68,68,0.9); color: #fff; padding: 8px 20px;
    border-radius: 20px; font-size: 13px; font-weight: 500;
    box-shadow: 0 4px 16px rgba(239,68,68,0.3); pointer-events: none;
  }
  #pin-mode-banner.visible { display: block; }

  /* Back link */
  .back-link {
    display: inline-block; font-size: 11px; color: rgba(255,255,255,0.4);
    margin-bottom: 12px; text-decoration: none; letter-spacing: 0.05em;
  }
  .back-link:hover { color: rgba(255,255,255,0.7); }

  /* Task pin tooltip */
  #pin-tooltip {
    display: none; position: fixed; z-index: 160;
    background: rgba(15,15,20,0.95); backdrop-filter: blur(12px);
    border: 1px solid rgba(255,255,255,0.12); border-radius: 8px;
    padding: 10px 14px; color: #fff; pointer-events: none; max-width: 240px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  }
  #pin-tooltip.visible { display: block; }
  #pin-tooltip .tt-id { font-size: 10px; color: rgba(255,255,255,0.35); }
  #pin-tooltip .tt-title { font-size: 13px; font-weight: 500; margin: 2px 0; }
  #pin-tooltip .tt-meta { font-size: 11px; color: rgba(255,255,255,0.5); }
</style>
</head>
<body>

<canvas id="canvas"></canvas>

<div id="pin-mode-banner">Click on any floor to place a task pin — Press Escape to cancel</div>

<div id="pin-tooltip">
  <div class="tt-id"></div>
  <div class="tt-title"></div>
  <div class="tt-meta"></div>
</div>

<div id="modal-overlay"></div>
<div id="task-modal">
  <h2>New Task Pin</h2>
  <div class="modal-sub" id="modal-location"></div>
  <label>Title</label>
  <input type="text" id="task-title" placeholder="What needs to be done here?" />
  <label>Description</label>
  <textarea id="task-desc" placeholder="Details (optional)"></textarea>
  <label>Priority</label>
  <select id="task-priority">
    <option value="low">Low</option>
    <option value="medium" selected>Medium</option>
    <option value="high">High</option>
    <option value="critical">Critical</option>
  </select>
  <input type="hidden" id="task-floor" />
  <input type="hidden" id="task-x" />
  <input type="hidden" id="task-z" />
  <input type="hidden" id="task-room" />
  <div class="modal-actions">
    <button class="btn-cancel" id="modal-cancel">Cancel</button>
    <button class="btn-create" id="modal-create">Create Task</button>
  </div>
</div>

<div id="panel">
  <a href="/" class="back-link">&larr; Back to KB</a>
  <h1>${meta.name.toUpperCase()}</h1>
  <p class="sub">${meta.address}</p>
  <p class="tag">${meta.tag}</p>
  <div class="divider"></div>
  <div class="section-label">Building</div>
  <div id="building-switcher" style="display:flex;gap:4px;margin-bottom:10px">
    <a href="/map?building=school" class="bld-btn${buildingId === 'school' ? ' active' : ''}">the annex</a>
    <a href="/map?building=organization" class="bld-btn${buildingId === 'organization' ? ' active' : ''}">the organization</a>
  </div>
  <div class="divider"></div>
  <div class="section-label">Floors</div>
  <div id="floor-buttons"></div>
  <div class="divider"></div>
  <div class="section-label">View Controls</div>
  <div style="margin-top:14px">
    ${canCreate ? '<button class="ctrl-btn" id="btn-pin"><span style="font-size:14px">&#x1F4CC;</span> Drop Task Pin</button>' : ''}
    <button class="ctrl-btn" id="btn-spread"><span style="font-size:14px">&#x25CB;</span> Spread Floor Plans</button>
    <button class="ctrl-btn" id="btn-showall"><span style="font-size:14px">&#x229E;</span> Show All</button>
    <button class="ctrl-btn" id="btn-reset"><span style="font-size:14px">&#x21BA;</span> Reset Camera</button>
  </div>
  <button id="info-toggle">Building Info <span id="info-arrow" style="transition:transform 0.3s ease;font-size:10px">&#x25BC;</span></button>
  <div id="info-panel">
    <div class="info-row"><span class="il">Total Area</span><span class="iv">${meta.totalArea}</span></div>
    <div class="info-row"><span class="il">Built</span><span class="iv">${meta.built}</span></div>
    <div class="info-row"><span class="il">Style</span><span class="iv">${meta.style}</span></div>
    <div class="info-row"><span class="il">Floors</span><span class="iv">${meta.floorCount}</span></div>
  </div>
  <div class="divider"></div>
  <div class="section-label">Controls</div>
  <div class="controls-help">
    <div class="row"><span class="key">W A S D</span><span>Move</span></div>
    <div class="row"><span class="key">Q / E</span><span>Down / Up</span></div>
    <div class="row"><span class="key">Shift</span><span>Move faster</span></div>
    <div class="row"><span class="key">Arrows</span><span>Pan / Tilt</span></div>
    <div class="row"><span class="key">Mouse</span><span>Orbit / Zoom</span></div>
  </div>
</div>

<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.164.1/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.164.1/examples/jsm/"
  }
}
</script>

<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ─── Constants ───────────────────────────────────────────────────────────────
const SCALE = 0.3048;
const FT = ft => ft * SCALE;
const UNIT = 0.5 * SCALE;

const FLOOR_HEIGHT = FT(13);
const WALL_THICKNESS = FT(1.5);
const SLAB_THICKNESS = 0.25;
const INTERIOR_WALL_THICKNESS = 0.15;
const FLOOR_GAP = FLOOR_HEIGHT * 0.8;
const SLOT_HEIGHT = FLOOR_HEIGHT + FLOOR_GAP;
const SPREAD_GAP = 2;

const R = (x, y, w, h) => ({ x: x*UNIT, y: y*UNIT, w: w*UNIT, h: h*UNIT });

// ─── Building Data ───────────────────────────────────────────────────────────
const BUILDING_ID = '${buildingId}';

const BUILDINGS = {}; /* building geometry redacted from history */;

const B = BUILDINGS[BUILDING_ID] || BUILDINGS.school;
const BUILDING_WIDTH = B.width;
const BUILDING_DEPTH = B.depth;
const NOTCH_WIDTH = B.notchWidth || 0;
const NOTCH_DEPTH = B.notchDepth || 0;
const IS_L_SHAPED = B.shape === 'L';
const floorsData = B.floors;
const FLOOR_ORDER = B.floorOrder;
const floorConfigs = B.floorConfigs;

function computeSpreadPositions() {
  const n = FLOOR_ORDER.length;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const stepX = BUILDING_WIDTH + SPREAD_GAP;
  const stepZ = BUILDING_DEPTH + SPREAD_GAP;
  const positions = {};
  FLOOR_ORDER.forEach((id, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    positions[id] = [
      (col - (cols - 1) / 2) * stepX,
      (row - (rows - 1) / 2) * stepZ,
    ];
  });
  return positions;
}
const SPREAD_POSITIONS = computeSpreadPositions();

// ─── State ───────────────────────────────────────────────────────────────────
let selectedFloor = null;
let spreadView = false;
let pinMode = false;
const canCreate = ${canCreate};

// ─── Renderer Setup ──────────────────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xC8D6E5, 100, 250);

const stackHeight = 4 * FLOOR_HEIGHT * 1.8;
const cameraDistance = Math.max(BUILDING_WIDTH, BUILDING_DEPTH) * 2.0;
const defaultCamPos = new THREE.Vector3(cameraDistance*0.5, cameraDistance*0.4, cameraDistance*0.5);
const defaultTarget = new THREE.Vector3(0, stackHeight*0.35, 0);

const camera = new THREE.PerspectiveCamera(40, window.innerWidth/window.innerHeight, 0.1, 500);
camera.position.copy(defaultCamPos);

const controls = new OrbitControls(camera, canvas);
controls.target.copy(defaultTarget);
controls.maxPolarAngle = Math.PI * 0.85;
controls.minDistance = 3;
controls.maxDistance = 200;
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.update();

// ─── Lighting ────────────────────────────────────────────────────────────────
const sunPos = [30, 50, 20];
const dirLight = new THREE.DirectionalLight(0xFFF5E0, 2.5);
dirLight.position.set(...sunPos);
dirLight.castShadow = true;
const shadowExtent = Math.max(BUILDING_WIDTH, BUILDING_DEPTH) * 0.8;
dirLight.shadow.mapSize.set(2048, 2048);
dirLight.shadow.camera.left = -shadowExtent;
dirLight.shadow.camera.right = shadowExtent;
dirLight.shadow.camera.top = shadowExtent;
dirLight.shadow.camera.bottom = -shadowExtent;
dirLight.shadow.camera.near = 1;
dirLight.shadow.camera.far = 120;
dirLight.shadow.bias = -0.0001;
scene.add(dirLight);

scene.add(new THREE.AmbientLight(0xB0C4DE, 0.4));
scene.add(new THREE.HemisphereLight(0x87CEEB, 0x8B7355, 0.6));

const intLightPositions = [
  [0, -FLOOR_HEIGHT+1.5, 0], [-2, 1.5, 4], [4, 1.5, -6], [0, FLOOR_HEIGHT+1.5, 0]
];
intLightPositions.forEach(p => {
  const pl = new THREE.PointLight(0xFFE4B5, 0.3, 12, 2);
  pl.position.set(...p);
  scene.add(pl);
});

// Ground
const groundGeo = new THREE.PlaneGeometry(50, 50);
const groundMat = new THREE.MeshStandardMaterial({ color: 0x707070, roughness: 0.9, metalness: 0.1 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI/2;
ground.position.y = -FLOOR_HEIGHT;
ground.receiveShadow = true;
scene.add(ground);

const sidewalk = new THREE.Mesh(
  new THREE.PlaneGeometry(BUILDING_WIDTH+6, BUILDING_DEPTH+6),
  new THREE.MeshStandardMaterial({ color: 0xA0A0A0, roughness: 0.85, metalness: 0.05 })
);
sidewalk.rotation.x = -Math.PI/2;
sidewalk.position.y = -FLOOR_HEIGHT + 0.01;
sidewalk.receiveShadow = true;
scene.add(sidewalk);

const gridHelper = new THREE.GridHelper(50, 50, 0x505050, 0x606060);
gridHelper.position.y = -FLOOR_HEIGHT + 0.02;
scene.add(gridHelper);

// ─── Textures ────────────────────────────────────────────────────────────────
function createFloorTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#3D2B1F';
  ctx.fillRect(0, 0, 512, 512);
  const pw = Math.round((0.12/2)*512);
  const np = Math.ceil(512/pw);
  const colors = ['#3D2B1F','#35261A','#453022','#2E2016','#4A3528','#382A1D'];
  for (let i=0; i<np; i++) {
    const x = i*pw;
    ctx.fillStyle = colors[i%colors.length];
    ctx.fillRect(x, 0, pw, 512);
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 1;
    for (let g=0; g<8; g++) {
      const gx = x + Math.random()*pw;
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx+(Math.random()-0.5)*4, 512); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 512); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 8);
  return tex;
}

const floorTexture = createFloorTexture();

// ─── Geometry helpers ────────────────────────────────────────────────────────
function createLShapedSlab() {
  const boxA = new THREE.BoxGeometry(BUILDING_WIDTH, SLAB_THICKNESS, BUILDING_DEPTH - NOTCH_DEPTH);
  boxA.translate(0, 0, (BUILDING_DEPTH - NOTCH_DEPTH)/2 + NOTCH_DEPTH - BUILDING_DEPTH/2);
  const boxB = new THREE.BoxGeometry(BUILDING_WIDTH - NOTCH_WIDTH, SLAB_THICKNESS, NOTCH_DEPTH);
  boxB.translate((BUILDING_WIDTH - NOTCH_WIDTH)/2 + NOTCH_WIDTH - BUILDING_WIDTH/2, 0, NOTCH_DEPTH/2 - BUILDING_DEPTH/2);

  const positions = [], normals = [], uvs = [], indices = [];
  let offset = 0;
  for (const g of [boxA, boxB]) {
    const pos = g.getAttribute('position');
    const norm = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    for (let i=0; i<pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      normals.push(norm.getX(i), norm.getY(i), norm.getZ(i));
      uvs.push(uv.getX(i), uv.getY(i));
    }
    const idx = g.getIndex();
    for (let i=0; i<idx.count; i++) indices.push(idx.array[i] + offset);
    offset += pos.count;
    g.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  merged.setIndex(indices);
  return merged;
}

function createRectSlab() {
  return new THREE.BoxGeometry(BUILDING_WIDTH, SLAB_THICKNESS, BUILDING_DEPTH);
}

const slabGeometry = IS_L_SHAPED ? createLShapedSlab() : createRectSlab();

// ─── Text Sprite helper ─────────────────────────────────────────────────────
function makeTextSprite(text, color, fontSize, maxWidth) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const scale = 4;
  const fSize = (fontSize || 14) * scale;
  c.width = (maxWidth || 200) * scale;
  c.height = fSize * (text.split('\\n').length + 1) * 1.5;

  ctx.fillStyle = 'transparent';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.font = \`\${fSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif\`;
  ctx.fillStyle = color || '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const lines = text.split('\\n');
  const lineH = fSize * 1.4;
  lines.forEach((line, i) => {
    ctx.fillText(line, c.width/2, i * lineH + fSize*0.2);
  });

  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  const aspect = c.width / c.height;
  const spriteHeight = lines.length * 0.4;
  sprite.scale.set(spriteHeight * aspect, spriteHeight, 1);
  return sprite;
}

function makeTitleSprite(text, color) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const scale = 4;
  const fSize = 20 * scale;
  c.width = 600 * scale;
  c.height = fSize * 2;

  ctx.font = \`bold \${fSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif\`;
  ctx.fillStyle = color || '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, c.width/2, c.height/2);

  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  const aspect = c.width / c.height;
  sprite.scale.set(1.2 * aspect, 1.2, 1);
  return sprite;
}

// ─── Build Floor Groups ──────────────────────────────────────────────────────
const floorGroups = {};
const floorSlabs = {}; // For raycasting

function buildFloorGroup(floorDef) {
  const group = new THREE.Group();
  const halfW = BUILDING_WIDTH / 2;
  const halfD = BUILDING_DEPTH / 2;
  const wallHeight = FLOOR_HEIGHT - SLAB_THICKNESS;

  const slabMat = new THREE.MeshStandardMaterial({ map: floorTexture.clone(), roughness: 0.6 });
  const slab = new THREE.Mesh(slabGeometry.clone(), slabMat);
  slab.userData.floorId = floorDef.id;
  group.add(slab);
  floorSlabs[floorDef.id] = slab;

  const t = WALL_THICKNESS * 0.4;
  const segments = IS_L_SHAPED ? [
    [-halfW + NOTCH_WIDTH, -halfD, halfW, -halfD],
    [halfW, -halfD, halfW, halfD],
    [halfW, halfD, -halfW, halfD],
    [-halfW, halfD, -halfW, -halfD + NOTCH_DEPTH],
    [-halfW, -halfD + NOTCH_DEPTH, -halfW + NOTCH_WIDTH, -halfD + NOTCH_DEPTH],
    [-halfW + NOTCH_WIDTH, -halfD + NOTCH_DEPTH, -halfW + NOTCH_WIDTH, -halfD],
  ] : [
    [-halfW, -halfD, halfW, -halfD],
    [halfW, -halfD, halfW, halfD],
    [halfW, halfD, -halfW, halfD],
    [-halfW, halfD, -halfW, -halfD],
  ];
  const outlineMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(floorDef.color), roughness: 0.7, transparent: true, opacity: 0.35
  });
  segments.forEach(([x1,z1,x2,z2]) => {
    const dx = x2-x1, dz = z2-z1;
    const len = Math.sqrt(dx*dx + dz*dz);
    const cx = (x1+x2)/2, cz = (z1+z2)/2;
    const angle = -Math.atan2(dz, dx);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(len, wallHeight, t), outlineMat);
    mesh.position.set(cx, SLAB_THICKNESS + wallHeight/2, cz);
    mesh.rotation.y = angle;
    group.add(mesh);
  });

  const wallMat = new THREE.MeshStandardMaterial({ color: 0xF5F0E8, roughness: 0.9 });
  floorDef.rooms.forEach(room => {
    const cx = room.x - halfW;
    const cz = room.y - halfD;

    if (room.y > 0.5) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(room.w, wallHeight, INTERIOR_WALL_THICKNESS), wallMat);
      m.position.set(cx + room.w/2, SLAB_THICKNESS + wallHeight/2, cz);
      group.add(m);
    }
    if (room.y + room.h < BUILDING_DEPTH - 0.5) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(room.w, wallHeight, INTERIOR_WALL_THICKNESS), wallMat);
      m.position.set(cx + room.w/2, SLAB_THICKNESS + wallHeight/2, cz + room.h);
      group.add(m);
    }
    if (room.x > 0.5) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(INTERIOR_WALL_THICKNESS, wallHeight, room.h), wallMat);
      m.position.set(cx, SLAB_THICKNESS + wallHeight/2, cz + room.h/2);
      group.add(m);
    }
    if (room.x + room.w < BUILDING_WIDTH - 0.5) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(INTERIOR_WALL_THICKNESS, wallHeight, room.h), wallMat);
      m.position.set(cx + room.w, SLAB_THICKNESS + wallHeight/2, cz + room.h/2);
      group.add(m);
    }

    const tintMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(room.color), transparent: true, opacity: 0.2, side: THREE.DoubleSide
    });
    const tint = new THREE.Mesh(new THREE.PlaneGeometry(room.w - 0.02, room.h - 0.02), tintMat);
    tint.rotation.x = -Math.PI/2;
    tint.position.set(cx + room.w/2, SLAB_THICKNESS + 0.02, cz + room.h/2);
    group.add(tint);

    let label = room.name;
    if (room.sqft > 0) {
      label += '\\n' + room.sqft.toLocaleString() + ' sf';
      if (room.dimensions) label += '\\n' + room.dimensions;
    }
    const sprite = makeTextSprite(label, floorDef.accentColor, 12, Math.max(60, room.w / UNIT * 2));
    sprite.position.set(cx + room.w/2, SLAB_THICKNESS + 0.5, cz + room.h/2);
    group.add(sprite);
  });

  if (floorDef.id === '1') {
    const aud = floorDef.rooms.find(r => r.id === 'redacted-room');
    if (aud) {
      const cx = aud.x - halfW, cz = aud.y - halfD;
      const ceilingY = FLOOR_HEIGHT - 0.05;
      const beamDepth = 0.08, beamWidth = 0.06;
      const spacingX = aud.w / 6, spacingZ = aud.h / 8;
      const beamMat = new THREE.MeshStandardMaterial({ color: 0xF0EBE0, roughness: 0.85 });
      for (let i=0; i<=8; i++) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(aud.w, beamDepth, beamWidth), beamMat);
        m.position.set(cx + aud.w/2, ceilingY, cz + i*spacingZ);
        group.add(m);
      }
      for (let i=0; i<=6; i++) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(beamWidth, beamDepth, aud.h), beamMat);
        m.position.set(cx + i*spacingX, ceilingY, cz + aud.h/2);
        group.add(m);
      }
    }
  }

  const title = makeTitleSprite(floorDef.name + ' \\u2014 ' + floorDef.subtitle, floorDef.accentColor);
  title.position.set(0, SLAB_THICKNESS + 0.5, -BUILDING_DEPTH/2 - 2.0);
  group.add(title);

  return group;
}

FLOOR_ORDER.forEach(id => {
  const def = floorsData.find(f => f.id === id);
  const group = buildFloorGroup(def);
  scene.add(group);
  floorGroups[id] = group;
});

// ─── Update floor positions/visibility ───────────────────────────────────────
function updateFloors() {
  FLOOR_ORDER.forEach((id, index) => {
    const group = floorGroups[id];
    const hasSelection = selectedFloor !== null;
    const isSelected = selectedFloor === id;
    group.visible = !hasSelection || isSelected;

    if (spreadView) {
      const offset = SPREAD_POSITIONS[id] || [0,0];
      group.position.set(offset[0], 0, offset[1]);
    } else {
      group.position.set(0, index * SLOT_HEIGHT, 0);
    }
  });
  // Update pin positions when floors move
  updatePinPositions();
}

// Hoist taskPins before updateFloors() — updatePinPositions() references it
const taskPins = []; // { mesh, data: { id, title, status, priority, floor, x, z, room } }

updateFloors();

// ─── WASD Controls ───────────────────────────────────────────────────────────
const keys = {};
window.addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'Escape' && pinMode) {
    pinMode = false;
    updatePinModeUI();
  }
});
window.addEventListener('keyup', e => { keys[e.code] = false; });

const fwd = new THREE.Vector3();
const rgt = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);

function updateWASD(delta) {
  const baseSpeed = 5;
  const speed = (keys.ShiftLeft || keys.ShiftRight ? baseSpeed*2 : baseSpeed) * delta;

  camera.getWorldDirection(fwd);
  rgt.crossVectors(fwd, up).normalize().negate();

  const move = new THREE.Vector3();
  if (keys.KeyW) move.add(fwd.clone().multiplyScalar(speed));
  if (keys.KeyS) move.add(fwd.clone().multiplyScalar(-speed));
  if (keys.KeyA) move.add(rgt.clone().multiplyScalar(speed));
  if (keys.KeyD) move.add(rgt.clone().multiplyScalar(-speed));
  if (keys.KeyE) move.y += speed;
  if (keys.KeyQ) move.y -= speed;

  const rotSpeed = 1.5 * delta;
  if (keys.ArrowLeft || keys.ArrowRight || keys.ArrowUp || keys.ArrowDown) {
    const euler = new THREE.Euler(0, 0, 0, 'YXZ');
    euler.setFromQuaternion(camera.quaternion, 'YXZ');
    if (keys.ArrowLeft) euler.y += rotSpeed;
    if (keys.ArrowRight) euler.y -= rotSpeed;
    if (keys.ArrowUp) euler.x += rotSpeed;
    if (keys.ArrowDown) euler.x -= rotSpeed;
    euler.x = Math.max(-Math.PI/2 + 0.01, Math.min(Math.PI/2 - 0.01, euler.x));
    camera.quaternion.setFromEuler(euler);
    const dist = controls.target.distanceTo(camera.position);
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    controls.target.copy(camera.position).add(dir.multiplyScalar(dist));
  }

  if (move.lengthSq() === 0) return;
  camera.position.add(move);
  controls.target.add(move);
}

// ─── Task Pins ───────────────────────────────────────────────────────────────
const pinGroup = new THREE.Group();
scene.add(pinGroup);
// taskPins declared above updateFloors() to avoid temporal dead zone

const PRIORITY_COLORS = {
  critical: 0xef4444,
  high: 0xf97316,
  medium: 0xeab308,
  low: 0x22c55e,
};

const STATUS_COLORS = {
  open: 0xef4444,
  in_progress: 0xf59e0b,
  blocked: 0x8b5cf6,
  done: 0x22c55e,
  cancelled: 0x6b7280,
};

function createPinMesh(color) {
  const group = new THREE.Group();

  // Pin shaft
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.02, 0.6, 8),
    new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.8, roughness: 0.3 })
  );
  shaft.position.y = 0.3;
  group.add(shaft);

  // Pin head (sphere)
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 16, 12),
    new THREE.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.4, emissive: new THREE.Color(color), emissiveIntensity: 0.3 })
  );
  head.position.y = 0.65;
  group.add(head);

  // Glow ring
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.08, 0.18, 16),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  group.add(ring);

  return group;
}

function addPin(data) {
  const color = STATUS_COLORS[data.status] || 0xef4444;
  const mesh = createPinMesh(color);
  mesh.userData.taskData = data;
  pinGroup.add(mesh);
  taskPins.push({ mesh, data });
  updatePinPositions();
}

function updatePinPositions() {
  for (const pin of taskPins) {
    const floorGroup = floorGroups[pin.data.floor];
    if (!floorGroup) continue;
    pin.mesh.visible = floorGroup.visible;
    // Pin x/z are in floor-local coords; add the floor group position offset
    pin.mesh.position.set(
      pin.data.x + floorGroup.position.x,
      floorGroup.position.y + SLAB_THICKNESS,
      pin.data.z + floorGroup.position.z
    );
  }
}

// Load existing located tasks
async function loadLocatedTasks() {
  try {
    const resp = await fetch('/api/tasks/located?building=' + encodeURIComponent(BUILDING_ID));
    const tasks = await resp.json();
    for (const t of tasks) {
      addPin(t);
    }
  } catch (e) {
    console.error('Failed to load located tasks:', e);
  }
}
loadLocatedTasks();

// ─── Pin Placement (Raycasting) ──────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

function getSlabTargets() {
  // Return visible floor slabs for raycasting
  return FLOOR_ORDER
    .filter(id => floorGroups[id].visible)
    .map(id => floorSlabs[id]);
}

function findRoomAtPoint(floorId, localX, localZ) {
  const halfW = BUILDING_WIDTH / 2;
  const halfD = BUILDING_DEPTH / 2;
  const def = floorsData.find(f => f.id === floorId);
  if (!def) return null;
  for (const room of def.rooms) {
    const rx = room.x - halfW;
    const rz = room.y - halfD;
    if (localX >= rx && localX <= rx + room.w && localZ >= rz && localZ <= rz + room.h) {
      return room.name;
    }
  }
  return null;
}

function updatePinModeUI() {
  const banner = document.getElementById('pin-mode-banner');
  const btn = document.getElementById('btn-pin');
  if (pinMode) {
    banner.classList.add('visible');
    if (btn) { btn.classList.add('active'); }
    canvas.style.cursor = 'crosshair';
  } else {
    banner.classList.remove('visible');
    if (btn) { btn.classList.remove('active'); }
    canvas.style.cursor = '';
  }
}

// Pin tooltip on hover
const tooltip = document.getElementById('pin-tooltip');
let hoveredPin = null;

canvas.addEventListener('mousemove', (e) => {
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

  if (!pinMode) {
    // Check for pin hover
    raycaster.setFromCamera(mouse, camera);
    const pinMeshes = taskPins.map(p => {
      // Raycast against the head sphere (second child)
      return p.mesh.children[1];
    }).filter(Boolean);

    const hits = raycaster.intersectObjects(pinMeshes, false);
    if (hits.length > 0) {
      const hitMesh = hits[0].object;
      const pin = taskPins.find(p => p.mesh.children[1] === hitMesh);
      if (pin) {
        hoveredPin = pin;
        const td = pin.data;
        tooltip.querySelector('.tt-id').textContent = td.id;
        tooltip.querySelector('.tt-title').textContent = td.title;
        tooltip.querySelector('.tt-meta').textContent =
          (td.status || 'open') + ' \\u00B7 ' + (td.priority || 'medium') + (td.room ? ' \\u00B7 ' + td.room : '');
        tooltip.style.left = (e.clientX + 12) + 'px';
        tooltip.style.top = (e.clientY - 10) + 'px';
        tooltip.classList.add('visible');
        canvas.style.cursor = 'pointer';
        return;
      }
    }
    if (hoveredPin) {
      hoveredPin = null;
      tooltip.classList.remove('visible');
      canvas.style.cursor = '';
    }
  }
});

canvas.addEventListener('click', (e) => {
  if (!pinMode) {
    // Click on pin to navigate to task
    if (hoveredPin) {
      window.open('/doc/tasks/' + hoveredPin.data.id + '.md', '_blank');
      return;
    }
    return;
  }

  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);

  const targets = getSlabTargets();
  const hits = raycaster.intersectObjects(targets, false);
  if (hits.length === 0) return;

  const hit = hits[0];
  const slab = hit.object;
  const floorId = slab.userData.floorId;
  const floorGroup = floorGroups[floorId];

  // Convert hit point to floor-local coordinates
  const localX = hit.point.x - floorGroup.position.x;
  const localZ = hit.point.z - floorGroup.position.z;

  const room = findRoomAtPoint(floorId, localX, localZ);
  const floorDef = floorsData.find(f => f.id === floorId);
  const floorName = floorDef ? floorDef.name : floorId;

  // Show task creation modal
  document.getElementById('task-floor').value = floorId;
  document.getElementById('task-x').value = localX.toFixed(4);
  document.getElementById('task-z').value = localZ.toFixed(4);
  document.getElementById('task-room').value = room || '';
  document.getElementById('modal-location').textContent =
    floorName + (room ? ' \\u2014 ' + room : ' \\u2014 Common area');
  document.getElementById('task-title').value = '';
  document.getElementById('task-desc').value = '';
  document.getElementById('task-priority').value = 'medium';

  document.getElementById('task-modal').classList.add('visible');
  document.getElementById('modal-overlay').classList.add('visible');
  document.getElementById('task-title').focus();

  pinMode = false;
  updatePinModeUI();
});

// Modal actions
document.getElementById('modal-cancel').addEventListener('click', closeModal);
document.getElementById('modal-overlay').addEventListener('click', closeModal);

function closeModal() {
  document.getElementById('task-modal').classList.remove('visible');
  document.getElementById('modal-overlay').classList.remove('visible');
}

document.getElementById('modal-create').addEventListener('click', async () => {
  const title = document.getElementById('task-title').value.trim();
  if (!title) { document.getElementById('task-title').style.borderColor = '#ef4444'; return; }

  const body = {
    title,
    description: document.getElementById('task-desc').value.trim(),
    priority: document.getElementById('task-priority').value,
    building: BUILDING_ID,
    floor: document.getElementById('task-floor').value,
    x: parseFloat(document.getElementById('task-x').value),
    z: parseFloat(document.getElementById('task-z').value),
    room: document.getElementById('task-room').value || undefined,
  };

  const btn = document.getElementById('modal-create');
  btn.textContent = 'Creating...';
  btn.disabled = true;

  try {
    const resp = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await resp.json();
    if (resp.ok) {
      addPin({
        id: result.id,
        title: body.title,
        status: 'open',
        priority: body.priority,
        building: BUILDING_ID,
        floor: body.floor,
        x: body.x,
        z: body.z,
        room: body.room || null,
      });
      closeModal();
    } else {
      console.error('Task creation failed:', result.error);
    }
  } catch (e) {
    console.error('Task creation error:', e);
  } finally {
    btn.textContent = 'Create Task';
    btn.disabled = false;
  }
});

// Pin mode button
const pinBtn = document.getElementById('btn-pin');
if (pinBtn) {
  pinBtn.addEventListener('click', () => {
    pinMode = !pinMode;
    updatePinModeUI();
  });
}

// ─── Render Loop ─────────────────────────────────────────────────────────────
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  updateWASD(delta);
  controls.update();

  // Animate pin glow rings
  const t = Date.now() * 0.003;
  for (const pin of taskPins) {
    if (pin.mesh.children[2]) {
      pin.mesh.children[2].material.opacity = 0.2 + Math.sin(t) * 0.1;
    }
  }

  renderer.render(scene, camera);
}
animate();

// ─── Resize ──────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ─── UI Wiring ───────────────────────────────────────────────────────────────
const btnContainer = document.getElementById('floor-buttons');
floorConfigs.forEach(fc => {
  const btn = document.createElement('button');
  btn.className = 'floor-btn';
  btn.dataset.id = fc.id;
  btn.innerHTML = '<span class="fname"><span class="dot" style="background:' + fc.color + '"></span>' + fc.name + '</span><span class="fsub">' + fc.subtitle + '</span>';
  btn.addEventListener('click', () => {
    selectedFloor = selectedFloor === fc.id ? null : fc.id;
    updateFloors();
    updateFloorButtons();
  });
  btnContainer.appendChild(btn);
});

function updateFloorButtons() {
  document.querySelectorAll('.floor-btn').forEach(btn => {
    const fc = floorConfigs.find(f => f.id === btn.dataset.id);
    const isSelected = selectedFloor === fc.id;
    btn.style.borderColor = isSelected ? fc.color : 'transparent';
    btn.style.background = isSelected ? fc.colorFaded : 'rgba(255,255,255,0.03)';
  });
  const spreadBtn = document.getElementById('btn-spread');
  spreadBtn.style.borderColor = spreadView ? 'rgba(139,92,246,0.5)' : 'rgba(255,255,255,0.1)';
  spreadBtn.style.background = spreadView ? 'rgba(139,92,246,0.12)' : 'rgba(255,255,255,0.04)';
  spreadBtn.style.color = spreadView ? '#a78bfa' : 'rgba(255,255,255,0.7)';
}

document.getElementById('btn-spread').addEventListener('click', () => {
  spreadView = !spreadView;
  updateFloors();
  updateFloorButtons();
});

document.getElementById('btn-showall').addEventListener('click', () => {
  selectedFloor = null;
  updateFloors();
  updateFloorButtons();
});

document.getElementById('btn-reset').addEventListener('click', () => {
  camera.position.copy(defaultCamPos);
  controls.target.copy(defaultTarget);
  controls.update();
});

document.getElementById('info-toggle').addEventListener('click', () => {
  const panel = document.getElementById('info-panel');
  const arrow = document.getElementById('info-arrow');
  panel.classList.toggle('open');
  arrow.style.transform = panel.classList.contains('open') ? 'rotate(180deg)' : 'rotate(0deg)';
});

updateFloorButtons();
</script>
</body>
</html>`);
});

// --- Projects Dashboard ---

app.get('/projects', (req, res) => {
  const username = req.auth.user;
  const tasksDir = path.join(CONTEXT_DIR, 'tasks');
  const projectsDir = path.join(CONTEXT_DIR, 'projects');

  // Load tasks
  const taskFiles = walkDir(tasksDir).filter(f => f.name.startsWith('TASK-') && f.name.endsWith('.md'));
  const tasks = [];
  for (const f of taskFiles) {
    try {
      const { frontmatter: fm } = readDoc(f.fullPath);
      if (!canView(fm, username)) continue;
      tasks.push({
        id: fm.id || f.name.replace('.md', ''),
        title: fm.title || f.name.replace('.md', ''),
        status: fm.status || 'open',
        priority: fm.priority || 'medium',
        owner: (fm.owners && fm.owners[0]) || fm.assigned_to || 'Unassigned',
        project: fm.project || '',
        tags: fm.tags || [],
        created_at: fm.created_at || '',
        start_date: fm.start_date || '',
        end_date: fm.end_date || '',
        file: f.name,
      });
    } catch {}
  }

  // Load projects
  const projFiles = fs.existsSync(projectsDir)
    ? fs.readdirSync(projectsDir).filter(f => f.startsWith('PROJECT-') && f.endsWith('.md'))
    : [];
  const projects = [];
  for (const pf of projFiles) {
    try {
      const { frontmatter: fm } = readDoc(path.join(projectsDir, pf));
      projects.push({
        id: fm.id || pf.replace('.md', ''),
        title: fm.title || pf.replace('.md', ''),
        status: fm.status || 'active',
        owner: fm.owner || 'Unassigned',
        created_at: fm.created_at || '',
        tags: fm.tags || [],
        file: pf,
      });
    } catch {}
  }

  // Project summary cards
  const statusColors = { active: '#5cb85c', completed: '#666', paused: '#e0a050' };
  const sortedProjects = [...projects].sort((a, b) => {
    const order = { active: 0, paused: 1, completed: 2 };
    return (order[a.status] ?? 1) - (order[b.status] ?? 1);
  });
  let projectCards = '';
  for (const p of sortedProjects) {
    const color = statusColors[p.status] || '#888';
    const opacity = p.status === 'completed' ? '0.6' : '1';
    const taskCount = tasks.filter(t => t.project === p.id).length;
    projectCards += `<div class="nav-card" style="opacity:${opacity}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color}"></span>
        <span style="font-weight:600;color:#fff;font-size:14px">${p.title}</span>
      </div>
      <div style="font-size:12px;color:#888">${p.owner} &middot; ${taskCount} task${taskCount !== 1 ? 's' : ''}</div>
      <div style="margin-top:4px">${p.tags.map(t => '<span class="tag">' + t + '</span>').join(' ')}</div>
    </div>`;
  }

  const body = `
    <div class="breadcrumb"><a href="/">Home</a> / \u{1F4CA} Projects</div>

    <h2 class="section-header">\u{1F4CB} Projects</h2>
    <div class="nav" style="margin-bottom:24px">${projectCards}</div>

    <div id="projects-app"></div>

    <style>
      .filter-bar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:16px; padding:12px 16px; background:#0f0f0f; border:1px solid #1a1a1a; border-radius:6px; }
      .filter-bar select { background:#1a1a1a; color:#ddd; border:1px solid #333; border-radius:4px; padding:6px 10px; font-size:12px; cursor:pointer; }
      .filter-bar select:focus { outline:none; border-color:#4a9eda; }
      .filter-bar button { background:#222; color:#999; border:1px solid #333; border-radius:4px; padding:6px 12px; font-size:13px; cursor:pointer; }
      .filter-bar button:hover { background:#333; color:#ddd; }
      .view-toggle { display:flex; gap:4px; }
      .view-toggle button { background:#161616; border:1px solid #252525; color:#888; padding:6px 14px; border-radius:4px; cursor:pointer; font-size:13px; }
      .view-toggle button.active { background:#1a1a2e; border-color:#4a9eda; color:#7eb8da; }

      .kanban { display:flex; gap:12px; overflow-x:auto; padding-bottom:12px; }
      .kanban-col { min-width:220px; flex:1; background:#0f0f0f; border:1px solid #1a1a1a; border-radius:8px; padding:12px; }
      .kanban-col-header { font-size:13px; font-weight:600; color:#aaa; margin-bottom:10px; padding-bottom:8px; border-bottom:1px solid #222; display:flex; justify-content:space-between; }
      .kanban-col-header .count { font-weight:400; color:#555; }
      .kanban-card { background:#131313; border:1px solid #222; border-radius:6px; padding:10px 12px; margin-bottom:6px; transition:border-color 0.15s, opacity 0.15s; }
      .kanban-card[draggable=true] { cursor:grab; user-select:none; }
      .kanban-card:hover { border-color:#383838; }
      .kanban-card.dragging { opacity:0.4; }
      .swimlane-drop-zone.drag-over { background:rgba(74,158,218,0.08) !important; }
      .kanban-card .task-id { font-size:12px; color:#7eb8da; font-weight:600; }
      .kanban-card .task-title { font-size:13px; color:#ddd; margin-top:2px; }
      .kanban-card .task-meta { font-size:11px; color:#555; margin-top:6px; display:flex; gap:8px; flex-wrap:wrap; }
      .kanban-card .priority-dot { display:inline-block; width:8px; height:8px; border-radius:50%; }

      .list-table { width:100%; border-collapse:collapse; }
      .list-table th { background:#111; color:#888; font-size:12px; font-weight:500; padding:8px 12px; text-align:left; border-bottom:1px solid #222; cursor:pointer; user-select:none; }
      .list-table th:hover { color:#ddd; }
      .list-table td { padding:8px 12px; border-bottom:1px solid #1a1a1a; font-size:13px; color:#ddd; }
      .list-table tr:hover td { background:#0f0f0f; }
    </style>

    <script>
    (function() {
      const tasks = ${JSON.stringify(tasks)};
      const projects = ${JSON.stringify(projects)};
      const canEdit = ${isAdmin(username) || isCoordinator(username)};
      window.__tasks = tasks;
      window.__projects = projects;

      const priorityColors = { critical:'#d9534f', high:'#e0a050', medium:'#4a9eda', low:'#666' };
      const statusColors = { open:'#5cb85c', in_progress:'#4a9eda', blocked:'#d9534f', done:'#666', cancelled:'#444' };

      const app = document.getElementById('projects-app');
      let currentView = 'kanban';
      let groupBy = 'status';
      let swimlaneCols = 'status';
      let swimlaneRows = 'priority';
      let filters = { owner:'', status:'', project:'', priority:'' };
      let hideClosed = true;
      let sortCol = 'id', sortDir = 1;

      function unique(arr, key) {
        const vals = new Set();
        arr.forEach(t => { if (t[key]) vals.add(t[key]); });
        return [...vals].sort();
      }

      function filtered() {
        return tasks.filter(t => {
          if (hideClosed && (t.status === 'closed' || t.status === 'done' || t.status === 'cancelled')) return false;
          if (filters.owner && t.owner !== filters.owner) return false;
          if (filters.status && t.status !== filters.status) return false;
          if (filters.project && t.project !== filters.project) return false;
          if (filters.priority && t.priority !== filters.priority) return false;
          return true;
        });
      }

      function render() {
        const ft = filtered();
        let html = '';

        // Filter bar
        html += '<div class="filter-bar">';
        html += '<div class="view-toggle">';
        html += '<button class="' + (currentView==='kanban'?'active':'') + '" onclick="window.__setView(&#39;kanban&#39;)">Kanban</button>';
        html += '<button class="' + (currentView==='list'?'active':'') + '" onclick="window.__setView(&#39;list&#39;)">List</button>';
        html += '<button class="' + (currentView==='gantt'?'active':'') + '" onclick="window.__setView(&#39;gantt&#39;)">Gantt</button>';
        html += '</div>';
        html += sel('owner', 'Owner', unique(tasks,'owner'));
        html += sel('status', 'Status', unique(tasks,'status'));
        html += sel('project', 'Project', unique(tasks,'project'));
        html += sel('priority', 'Priority', unique(tasks,'priority'));
        if (currentView === 'kanban') {
          var dims = ['status','priority','owner','project'];
          html += '<span style="margin-left:auto;display:flex;gap:6px;align-items:center;font-size:12px;color:#888">';
          html += '<span>Cols:</span><select onchange="window.__setSwimlaneCols(this.value)">';
          dims.forEach(g => { html += '<option value="' + g + '"' + (swimlaneCols===g?' selected':'') + '>' + g.charAt(0).toUpperCase()+g.slice(1) + '</option>'; });
          html += '</select>';
          html += '<span>Rows:</span><select onchange="window.__setSwimlaneRows(this.value)">';
          dims.forEach(g => { html += '<option value="' + g + '"' + (swimlaneRows===g?' selected':'') + '>' + g.charAt(0).toUpperCase()+g.slice(1) + '</option>'; });
          html += '</select>';
          html += '</span>';
        }
        html += '<label style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#888;cursor:pointer"><input type="checkbox"' + (hideClosed ? ' checked' : '') + ' onchange="window.__toggleHideClosed()" style="accent-color:#4a9eda"> Hide closed</label>';
        html += '<button onclick="window.__clearFilters()">Clear filters</button>';
        html += '</div>';

        if (currentView === 'kanban') {
          html += renderKanban(ft);
        } else if (currentView === 'gantt') {
          html += renderGantt(ft);
        } else {
          html += renderList(ft);
        }
        app.innerHTML = html;

        // Wire up drag-and-drop for kanban cards (admin/coordinator only)
        if (currentView === 'kanban' && canEdit) {
          var draggedEl = null;
          var allCards = app.querySelectorAll('.kanban-card[draggable]');
          var allZones = app.querySelectorAll('.swimlane-drop-zone');

          allCards.forEach(function(card) {
            card.addEventListener('dragstart', function(e) {
              draggedEl = card;
              card.classList.add('dragging');
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', card.dataset.file);
            });
            card.addEventListener('dragend', function() {
              if (draggedEl) draggedEl.classList.remove('dragging');
              draggedEl = null;
              allZones.forEach(function(z) { z.classList.remove('drag-over'); });
            });
          });

          allZones.forEach(function(zone) {
            zone.addEventListener('dragover', function(e) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              zone.classList.add('drag-over');
            });
            zone.addEventListener('dragleave', function() {
              zone.classList.remove('drag-over');
            });
            zone.addEventListener('drop', function(e) {
              e.preventDefault();
              zone.classList.remove('drag-over');
              if (!draggedEl) return;

              var file = draggedEl.dataset.file;
              var colKey = zone.dataset.colKey;
              var colVal = zone.dataset.colVal;
              var rowKey = zone.dataset.rowKey;
              var rowVal = zone.dataset.rowVal;

              // Build update payload — only update status/priority (the editable dimensions)
              var update = {};
              if (colKey === 'status' || rowKey === 'status') update.status = colKey === 'status' ? colVal : rowVal;
              if (colKey === 'priority' || rowKey === 'priority') update.priority = colKey === 'priority' ? colVal : rowVal;

              if (Object.keys(update).length === 0) {
                // Non-editable dimensions (owner, project) — just move visually
                zone.appendChild(draggedEl);
                draggedEl.classList.remove('dragging');
                return;
              }

              // Update local data
              var task = tasks.find(function(t) { return t.file === file; });
              if (task) {
                if (update.status) task.status = update.status;
                if (update.priority) task.priority = update.priority;
              }

              // Move card to new zone
              zone.appendChild(draggedEl);
              draggedEl.classList.remove('dragging');

              // Persist to server — clean origin URL (no embedded credentials)
              var cleanOrigin = window.location.protocol + '//' + window.location.host;
              fetch(cleanOrigin + '/api/tasks/' + encodeURIComponent(file), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(update)
              }).then(function(r) {
                if (!r.ok) {
                  r.json().then(function(d) { console.error('Task update failed:', d.error); });
                  render(); // revert
                }
              }).catch(function(err) {
                console.error('Task update error:', err);
                render(); // revert
              });
            });
          });
        }
      }

      var plurals = { Status: 'Statuses', Priority: 'Priorities' };
      function sel(key, label, options) {
        var plural = plurals[label] || (label + 's');
        let h = '<select onchange="window.__setFilter(&#39;' + key + '&#39;, this.value)">';
        h += '<option value="">All ' + plural + '</option>';
        options.forEach(o => {
          var display = o;
          if (key === 'project') {
            var p = projects.find(function(pr) { return pr.id === o; });
            if (p) display = p.title;
          }
          h += '<option value="' + o + '"' + (filters[key]===o?' selected':'') + '>' + display + '</option>';
        });
        h += '</select>';
        return h;
      }

      function renderKanban(ft) {
        var colKey = swimlaneCols;
        var rowKey = swimlaneRows;

        // Orderings for known dimensions
        var orderings = {
          status: ['open','in_progress','blocked','backlog','closed','done','cancelled'],
          priority: ['critical','high','medium','low'],
        };
        var colorMaps = {
          status: statusColors,
          priority: priorityColors,
        };

        // Collect unique column and row values
        var colVals = new Set();
        var rowVals = new Set();
        ft.forEach(t => {
          colVals.add(t[colKey] || 'Unassigned');
          rowVals.add(t[rowKey] || 'Unassigned');
        });

        // Sort using known ordering, fallback to alpha
        function sortDim(vals, key) {
          var order = orderings[key];
          var arr = [...vals];
          if (order) {
            arr.sort((a, b) => {
              var ai = order.indexOf(a); var bi = order.indexOf(b);
              if (ai === -1) ai = 999; if (bi === -1) bi = 999;
              return ai - bi;
            });
          } else {
            arr.sort();
          }
          return arr;
        }

        var cols = sortDim(colVals, colKey);
        var rows = sortDim(rowVals, rowKey);

        // Build lookup: matrix[row][col] = [tasks]
        var matrix = {};
        rows.forEach(r => { matrix[r] = {}; cols.forEach(c => { matrix[r][c] = []; }); });
        ft.forEach(t => {
          var c = t[colKey] || 'Unassigned';
          var r = t[rowKey] || 'Unassigned';
          if (matrix[r] && matrix[r][c]) matrix[r][c].push(t);
        });

        var colColors = colorMaps[colKey] || {};
        var rowColors = colorMaps[rowKey] || {};

        // Label resolver — show project titles instead of IDs
        function dimLabel(val, key) {
          if (key === 'project') {
            var p = projects.find(function(pr) { return pr.id === val; });
            return p ? p.title : val;
          }
          return val;
        }

        // Render card helper — draggable for status/priority dimensions
        function card(t) {
          var pc = priorityColors[t.priority] || '#666';
          var projLabel = t.project ? (projects.find(p => p.id === t.project) || {}).title || t.project : '';
          var dragAttr = canEdit ? ' draggable="true"' : '';
          var h = '<div class="kanban-card"' + dragAttr + ' data-file="' + t.file + '" data-status="' + (t.status||'') + '" data-priority="' + (t.priority||'') + '">';
          h += '<div style="display:flex;justify-content:space-between;align-items:center"><span class="task-id">' + t.id + '</span><span class="priority-dot" style="background:' + pc + '" title="' + t.priority + '"></span></div>';
          h += '<a href="/doc/tasks/' + encodeURIComponent(t.file) + '" style="text-decoration:none" onclick="event.stopPropagation()"><div class="task-title">' + t.title + '</div></a>';
          h += '<div class="task-meta">';
          if (t.owner) h += '<span>' + t.owner + '</span>';
          if (projLabel) h += '<span style="color:#7eb8da">' + projLabel + '</span>';
          h += '</div></div>';
          return h;
        }

        // Render swimlane grid — fill viewport width
        var html = '<div style="overflow-x:auto;width:100%">';
        html += '<table style="width:100%;min-width:100%;border-collapse:collapse">';

        // Column headers
        html += '<thead><tr>';
        html += '<th style="width:120px;min-width:120px;padding:10px;background:#0a0a0a;border:1px solid #1a1a1a;position:sticky;left:0;z-index:2">';
        html += '<span style="font-size:11px;color:#555;text-transform:uppercase">' + rowKey + ' \\ ' + colKey + '</span></th>';
        cols.forEach(c => {
          var cc = colColors[c] || '#888';
          html += '<th style="padding:10px;background:#0a0a0a;border:1px solid #1a1a1a;min-width:200px">';
          html += '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + cc + ';margin-right:6px"></span>';
          html += '<span style="font-size:13px;font-weight:600;color:#ccc">' + dimLabel(c, colKey) + '</span>';
          var colCount = 0; rows.forEach(r => { colCount += matrix[r][c].length; });
          html += ' <span style="color:#555;font-weight:400;font-size:12px">(' + colCount + ')</span>';
          html += '</th>';
        });
        html += '</tr></thead>';

        // Rows
        html += '<tbody>';
        rows.forEach(r => {
          var rc = rowColors[r] || '#888';
          var rowCount = 0; cols.forEach(c => { rowCount += matrix[r][c].length; });
          html += '<tr>';
          // Row header (sticky left)
          html += '<td style="vertical-align:top;padding:10px;background:#0a0a0a;border:1px solid #1a1a1a;position:sticky;left:0;z-index:1">';
          html += '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + rc + ';margin-right:6px"></span>';
          html += '<span style="font-size:13px;font-weight:600;color:#ccc">' + dimLabel(r, rowKey) + '</span>';
          html += ' <span style="color:#555;font-size:12px">(' + rowCount + ')</span>';
          html += '</td>';
          // Cells
          cols.forEach(c => {
            var items = matrix[r][c];
            // Drop zone: data attributes encode the col/row values for this cell
            var dzData = ' data-col-key="' + colKey + '" data-col-val="' + c + '" data-row-key="' + rowKey + '" data-row-val="' + r + '"';
            html += '<td style="vertical-align:top;padding:0;border:1px solid #1a1a1a;background:#0d0d0d">';
            html += '<div class="swimlane-drop-zone"' + dzData + ' style="min-height:48px;padding:8px;transition:background 0.15s">';
            if (items.length === 0) {
              html += '<div style="color:#333;font-size:11px;font-style:italic;padding:8px">—</div>';
            } else {
              items.forEach(t => { html += card(t); });
            }
            html += '</div></td>';
          });
          html += '</tr>';
        });
        html += '</tbody></table></div>';
        return html;
      }

      function renderList(ft) {
        const sorted = [...ft].sort((a,b) => {
          const av = a[sortCol] || '', bv = b[sortCol] || '';
          return (av < bv ? -1 : av > bv ? 1 : 0) * sortDir;
        });
        let html = '<div class="doc-content" style="padding:0;overflow-x:auto"><table class="list-table">';
        html += '<thead><tr>';
        ['id','title','status','priority','owner','project'].forEach(col => {
          const arrow = sortCol===col ? (sortDir===1?' \u25B2':' \u25BC') : '';
          html += '<th onclick="window.__setSort(&#39;' + col + '&#39;)">' + col.charAt(0).toUpperCase()+col.slice(1) + arrow + '</th>';
        });
        html += '</tr></thead><tbody>';
        for (const t of sorted) {
          const sc = statusColors[t.status] || '#888';
          const pc = priorityColors[t.priority] || '#666';
          const projLabel = t.project ? (projects.find(p => p.id === t.project)?.title || t.project) : '';
          html += '<tr>';
          html += '<td><a href="/doc/tasks/' + encodeURIComponent(t.file) + '" style="color:#7eb8da;font-weight:600">' + t.id + '</a></td>';
          html += '<td>' + t.title + '</td>';
          html += '<td><span style="display:inline-flex;align-items:center;gap:6px"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + sc + '"></span>' + t.status + '</span></td>';
          html += '<td><span style="display:inline-flex;align-items:center;gap:6px"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + pc + '"></span>' + t.priority + '</span></td>';
          html += '<td style="color:#999">' + t.owner + '</td>';
          html += '<td style="color:#7eb8da">' + projLabel + '</td>';
          html += '</tr>';
        }
        html += '</tbody></table></div>';
        return html;
      }

      function renderGantt(ft) {
        var priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        var sorted = [...ft].sort(function(a, b) {
          var pa = priorityOrder[a.priority] !== undefined ? priorityOrder[a.priority] : 2;
          var pb = priorityOrder[b.priority] !== undefined ? priorityOrder[b.priority] : 2;
          if (pa !== pb) return pa - pb;
          var da = a.start_date || '9999';
          var db = b.start_date || '9999';
          return da < db ? -1 : da > db ? 1 : 0;
        });

        // Group by project
        var byProject = {};
        sorted.forEach(function(t) {
          var pKey = t.project || '_none';
          if (!byProject[pKey]) byProject[pKey] = [];
          byProject[pKey].push(t);
        });

        var today = new Date().toISOString().slice(0, 10);
        var minDate = today, maxDate = today;
        sorted.forEach(function(t) {
          if (t.start_date && t.start_date < minDate) minDate = t.start_date;
          if (t.end_date && t.end_date > maxDate) maxDate = t.end_date;
          if (t.created_at && t.created_at < minDate) minDate = t.created_at;
        });

        function padDate(dateStr, days) {
          var clean = (dateStr || '').slice(0, 10);
          if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(clean)) return new Date().toISOString().slice(0, 10);
          var d = new Date(clean + 'T00:00:00Z');
          if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
          d.setUTCDate(d.getUTCDate() + days);
          return d.toISOString().slice(0, 10);
        }
        minDate = padDate(minDate, -7);
        maxDate = padDate(maxDate, 14);

        var dayMs = 86400000;
        var startMs = new Date(minDate + 'T00:00:00Z').getTime();
        var endMs = new Date(maxDate + 'T00:00:00Z').getTime();
        var totalDays = Math.min(Math.ceil((endMs - startMs) / dayMs), 365);
        var dayWidth = 28;
        var chartWidth = totalDays * dayWidth;
        var rowHeight = 34;
        var headerHeight = 50;
        var labelWidth = 220;

        // Build row list with project group headers
        var rows = [];
        var projOrder = Object.keys(byProject).sort(function(a, b) {
          if (a === '_none') return 1;
          if (b === '_none') return -1;
          return a < b ? -1 : 1;
        });
        projOrder.forEach(function(pKey) {
          var projTitle = pKey === '_none' ? 'No Project' : (projects.find(function(p) { return p.id === pKey; }) || {}).title || pKey;
          rows.push({ type: 'header', title: projTitle, count: byProject[pKey].length });
          byProject[pKey].forEach(function(t) { rows.push({ type: 'task', task: t }); });
        });

        var chartHeight = headerHeight + rows.length * rowHeight + 20;

        // Date headers and grid
        var dateHeaders = '';
        var gridLines = '';
        var monthLabels = [];
        var lastMonth = '';
        var monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        for (var i = 0; i < totalDays; i++) {
          var d = new Date(startMs + i * dayMs);
          var dateStr = d.toISOString().slice(0, 10);
          var dayNum = d.getUTCDate();
          var monthKey = d.toISOString().slice(0, 7);
          var x = i * dayWidth;
          var isToday = dateStr === today;
          var isWeekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;

          if (isWeekend) {
            gridLines += '<rect x="' + x + '" y="0" width="' + dayWidth + '" height="' + chartHeight + '" fill="rgba(255,255,255,0.02)"/>';
          }
          if (isToday) {
            gridLines += '<rect x="' + x + '" y="0" width="' + dayWidth + '" height="' + chartHeight + '" fill="rgba(239,68,68,0.08)"/>';
            gridLines += '<line x1="' + (x + dayWidth/2) + '" y1="0" x2="' + (x + dayWidth/2) + '" y2="' + chartHeight + '" stroke="#ef4444" stroke-width="1.5" stroke-dasharray="4,3" opacity="0.6"/>';
          }
          if (dayWidth >= 20 || dayNum % 2 === 1) {
            dateHeaders += '<text x="' + (x + dayWidth/2) + '" y="42" fill="' + (isToday ? '#ef4444' : '#555') + '" font-size="10" text-anchor="middle" font-weight="' + (isToday ? '700' : '400') + '">' + dayNum + '</text>';
          }
          if (monthKey !== lastMonth) {
            monthLabels.push({ x: x, label: monthNames[d.getUTCMonth()] + ' ' + d.getUTCFullYear() });
            lastMonth = monthKey;
          }
          if (dayNum === 1) {
            gridLines += '<line x1="' + x + '" y1="0" x2="' + x + '" y2="' + chartHeight + '" stroke="#333" stroke-width="0.5"/>';
          }
        }

        var monthHeaders = '';
        monthLabels.forEach(function(m) {
          monthHeaders += '<text x="' + (m.x + 4) + '" y="16" fill="#888" font-size="12" font-weight="600">' + m.label + '</text>';
        });

        // Task bars and labels
        var taskBars = '';
        var taskLabelsHtml = '';

        rows.forEach(function(row, idx) {
          var y = headerHeight + idx * rowHeight;
          if (row.type === 'header') {
            taskLabelsHtml += '<div style="height:' + rowHeight + 'px;display:flex;align-items:center;padding:0 12px;background:#161616;border-bottom:1px solid #222;font-size:12px;font-weight:700;color:#7eb8da">' + row.title + ' <span style="color:#555;font-weight:400;margin-left:6px">(' + row.count + ')</span></div>';
            taskBars += '<rect x="0" y="' + y + '" width="' + chartWidth + '" height="' + rowHeight + '" fill="#0c0c0c"/>';
            taskBars += '<line x1="0" y1="' + (y + rowHeight) + '" x2="' + chartWidth + '" y2="' + (y + rowHeight) + '" stroke="#222" stroke-width="0.5"/>';
            return;
          }
          var t = row.task;
          var pColor = priorityColors[t.priority] || '#666';
          var title = t.title || t.id || t.file;
          var truncTitle = title.length > 22 ? title.slice(0, 22) + '...' : title;
          taskLabelsHtml += '<div style="height:' + rowHeight + 'px;display:flex;align-items:center;gap:8px;padding:0 12px;border-bottom:1px solid #1a1a1a">'
            + '<span style="width:8px;height:8px;border-radius:50%;background:' + pColor + ';flex-shrink:0"></span>'
            + '<a href="/doc/tasks/' + encodeURIComponent(t.file) + '" style="color:#ddd;font-size:12px;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + title + '">' + (t.id ? t.id + ' ' : '') + truncTitle + '</a>'
            + '</div>';

          var barStart = t.start_date || t.created_at || today;
          var barEnd = t.end_date || (t.start_date ? t.start_date : today);
          var barStartMs = new Date(barStart + 'T00:00:00Z').getTime();
          var barEndMs = new Date(barEnd + 'T00:00:00Z').getTime();
          var barX = ((barStartMs - startMs) / dayMs) * dayWidth;
          var barW = Math.max(((barEndMs - barStartMs) / dayMs) * dayWidth, dayWidth * 0.5);
          var barY = y + 6;
          var barH = rowHeight - 12;
          var isDone = t.status === 'done' || t.status === 'cancelled';
          var barOpacity = isDone ? '0.4' : '0.85';

          taskBars += '<line x1="0" y1="' + (y + rowHeight) + '" x2="' + chartWidth + '" y2="' + (y + rowHeight) + '" stroke="#1a1a1a" stroke-width="0.5"/>';
          taskBars += '<a href="/doc/tasks/' + encodeURIComponent(t.file) + '">'
            + '<rect x="' + barX + '" y="' + barY + '" width="' + barW + '" height="' + barH + '" rx="4" fill="' + pColor + '" opacity="' + barOpacity + '" style="cursor:pointer"/>'
            + '<text x="' + (barX + 6) + '" y="' + (barY + barH/2 + 1) + '" fill="#fff" font-size="10" font-weight="500" dominant-baseline="middle" style="pointer-events:none">' + (barW > 60 ? (t.id || '') : '') + '</text>'
            + '</a>';

          if (!t.start_date && !t.end_date) {
            var mx = ((new Date((t.created_at || today) + 'T00:00:00Z').getTime() - startMs) / dayMs) * dayWidth;
            taskBars += '<polygon points="' + mx + ',' + (barY + barH/2 - 6) + ' ' + (mx+6) + ',' + (barY + barH/2) + ' ' + mx + ',' + (barY + barH/2 + 6) + ' ' + (mx-6) + ',' + (barY + barH/2) + '" fill="' + pColor + '" opacity="0.7"/>';
          }
        });

        var legend = '<div style="display:flex;gap:12px;align-items:center;font-size:11px;color:#666;margin-bottom:12px">'
          + '<span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#d9534f;margin-right:4px"></span>Critical</span>'
          + '<span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#e0a050;margin-right:4px"></span>High</span>'
          + '<span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#4a9eda;margin-right:4px"></span>Medium</span>'
          + '<span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#666;margin-right:4px"></span>Low</span>'
          + '<span style="margin-left:8px;color:#ef4444">| Today</span>'
          + '</div>';

        var html = legend;
        html += '<div style="background:#0d0d0d;border:1px solid #222;border-radius:8px;overflow:hidden">';
        html += '<div style="display:flex">';
        html += '<div style="width:' + labelWidth + 'px;flex-shrink:0;border-right:1px solid #222;background:#111">';
        html += '<div style="height:' + headerHeight + 'px;display:flex;align-items:end;padding:0 12px 6px;font-size:11px;color:#555;font-weight:600;border-bottom:1px solid #222">Task</div>';
        html += taskLabelsHtml;
        html += '</div>';
        html += '<div style="flex:1;overflow-x:auto">';
        html += '<svg width="' + chartWidth + '" height="' + chartHeight + '" xmlns="http://www.w3.org/2000/svg" style="display:block">';
        html += gridLines;
        html += '<g>' + monthHeaders + '</g>';
        html += '<line x1="0" y1="24" x2="' + chartWidth + '" y2="24" stroke="#333" stroke-width="0.5"/>';
        html += '<g>' + dateHeaders + '</g>';
        html += '<line x1="0" y1="' + headerHeight + '" x2="' + chartWidth + '" y2="' + headerHeight + '" stroke="#333" stroke-width="1"/>';
        html += taskBars;
        html += '</svg>';
        html += '</div></div></div>';
        html += '<div style="margin-top:12px;font-size:11px;color:#444;text-align:center">Tasks without start/end dates appear as diamonds at their creation date. Faded bars indicate completed or cancelled tasks.</div>';
        return html;
      }

      window.__setView = function(v) { currentView = v; render(); };
      window.__setGroup = function(g) { groupBy = g; render(); };
      window.__setSwimlaneCols = function(v) { swimlaneCols = v; render(); };
      window.__setSwimlaneRows = function(v) { swimlaneRows = v; render(); };
      window.__setFilter = function(k, v) { filters[k] = v; render(); };
      window.__clearFilters = function() { filters = { owner:'', status:'', project:'', priority:'' }; render(); };
      window.__toggleHideClosed = function() { hideClosed = !hideClosed; render(); };
      window.__setSort = function(col) {
        if (sortCol === col) sortDir *= -1;
        else { sortCol = col; sortDir = 1; }
        render();
      };

      render();
    })();
    </script>
  `;

  res.send(layout('Projects', body, username));
});

// --- Apps (Events, Tours, Residency) ---
app.use(createAppsRouter(layout));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Knowledge Base UI running at http://0.0.0.0:${PORT}`);
});
