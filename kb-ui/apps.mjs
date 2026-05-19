/**
 * Events, Tours, and Residency apps.
 * Server-rendered HTML pages + JSON API endpoints.
 */
import { Router } from 'express';
import * as db from './apps-db.mjs';
import { syncGoogleCalendar } from './sync-calendar.mjs';

export function createAppsRouter(layout) {
  const router = Router();
  router.use(express_json_middleware);

  // ============================================================
  // Shared styles for all app pages
  // ============================================================
  const APP_STYLES = `
    .app-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; }
    .app-header h2 { font-size: 22px; color: #fff; margin: 0; }
    .app-actions { display: flex; gap: 8px; flex-wrap: wrap; }

    .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; border: 1px solid #333; background: #1a1a1a; color: #ddd; transition: all 0.15s; }
    .btn:hover { background: #252525; border-color: #444; text-decoration: none; }
    .btn-primary { background: #1a3a5a; border-color: #2a5a8a; color: #7eb8da; }
    .btn-primary:hover { background: #2a4a6a; }
    .btn-danger { background: #3a1a1a; border-color: #5a2a2a; color: #d9534f; }
    .btn-danger:hover { background: #4a2a2a; }
    .btn-sm { padding: 4px 10px; font-size: 12px; }
    .btn-ghost { background: transparent; border-color: transparent; }
    .btn-ghost:hover { background: #1a1a1a; }

    .card { background: #131313; border: 1px solid #222; border-radius: 8px; overflow: hidden; }
    .card-header { padding: 16px 20px 12px; }
    .card-content { padding: 0 20px 16px; }
    .card-title { font-size: 17px; font-weight: 600; color: #ddd; margin: 0; }
    .card-desc { font-size: 13px; color: #666; margin-top: 4px; }

    .grid-2 { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; }
    .grid-3 { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
    .grid-4 { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }

    .meta { display: flex; flex-wrap: wrap; gap: 12px; font-size: 13px; color: #888; }
    .meta-item { display: flex; align-items: center; gap: 4px; }

    .badge-sm { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 500; }
    .badge-green { background: #1a3a1a; color: #5cb85c; }
    .badge-blue { background: #1a2a3a; color: #4a9eda; }
    .badge-yellow { background: #3a3a1a; color: #f0ad4e; }
    .badge-red { background: #3a1a1a; color: #d9534f; }
    .badge-gray { background: #1a1a1a; color: #666; }
    .badge-purple { background: #2a1a3a; color: #9b7ed8; }
    .badge-orange { background: #3a2a1a; color: #e0a050; }
    .badge-teal { background: #1a2a2a; color: #5cb8b8; }

    .role-host { background: #2a1a1a; color: #e07070; }
    .role-setup { background: #1a2a1a; color: #70c070; }
    .role-cleanup { background: #1a1a2a; color: #7070c0; }
    .role-catering { background: #2a2a1a; color: #c0c070; }
    .role-security { background: #2a1a2a; color: #c070c0; }
    .role-other { background: #1a1a1a; color: #888; }

    .assignments-group { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 4px; }
    .assignments-group .role-label { font-size: 11px; }
    .assignments-group .names { font-size: 13px; color: #999; }

    .section-title { font-size: 18px; font-weight: 600; color: #fff; margin-bottom: 16px; }
    .section-muted { color: #666; }

    .empty-state { text-align: center; padding: 48px 24px; color: #555; }
    .empty-state p { margin: 4px 0; }

    .divider { border: none; border-top: 1px solid #222; margin: 12px 0; }

    /* Modal/Dialog */
    .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 100; justify-content: center; align-items: center; }
    .modal-overlay.active { display: flex; }
    .modal { background: #161616; border: 1px solid #333; border-radius: 10px; width: 90%; max-width: 480px; max-height: 80vh; overflow-y: auto; padding: 24px; }
    .modal h3 { color: #fff; font-size: 17px; margin: 0 0 4px; }
    .modal .modal-desc { color: #666; font-size: 13px; margin-bottom: 16px; }

    .form-group { margin-bottom: 14px; }
    .form-group label { display: block; font-size: 13px; font-weight: 500; color: #aaa; margin-bottom: 4px; }
    .form-group input, .form-group select, .form-group textarea { width: 100%; padding: 8px 12px; background: #0d0d0d; border: 1px solid #333; border-radius: 6px; color: #ddd; font-size: 13px; }
    .form-group input:focus, .form-group select:focus, .form-group textarea:focus { border-color: #4a9eda; outline: none; }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .form-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }

    .checkbox-group { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
    .checkbox-group input[type=checkbox] { width: 16px; height: 16px; accent-color: #4a9eda; }
    .checkbox-group label { font-size: 13px; color: #aaa; cursor: pointer; margin: 0; }

    .list-item { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: #0f0f0f; border: 1px solid #1a1a1a; border-radius: 6px; margin-bottom: 6px; }
    .list-item .info { flex: 1; }
    .list-item .info .name { font-size: 13px; font-weight: 500; color: #ddd; }
    .list-item .info .detail { font-size: 12px; color: #666; }
    .list-item .actions { display: flex; gap: 4px; }

    .status-pending { color: #f0ad4e; }
    .status-confirmed { color: #5cb85c; }
    .status-cancelled { color: #666; }

    .card-dashed { border-style: dashed; opacity: 0.75; }
    .card-accent { border-color: #2a5a8a; }

    .tag-bar { display: flex; gap: 8px; padding: 8px 12px; background: #0f0f0f; border-radius: 6px; margin-bottom: 12px; font-size: 13px; color: #888; }

    .app-nav { display: flex; gap: 0; margin-bottom: 24px; border-bottom: 1px solid #222; }
    .app-nav a { padding: 10px 20px; font-size: 14px; color: #888; border-bottom: 2px solid transparent; transition: all 0.15s; }
    .app-nav a:hover { color: #ddd; text-decoration: none; }
    .app-nav a.active { color: #7eb8da; border-bottom-color: #7eb8da; }

    @media (max-width: 600px) {
      .grid-2, .grid-3, .grid-4 { grid-template-columns: 1fr; }
      .form-row { grid-template-columns: 1fr; }
    }
  `;

  function appLayout(title, body, username, activeTab) {
    const nav = `
      <div class="app-nav">
        <a href="/events" class="${activeTab === 'events' ? 'active' : ''}">Events</a>
        <a href="/tours" class="${activeTab === 'tours' ? 'active' : ''}">Tours</a>
        <a href="/residency" class="${activeTab === 'residency' ? 'active' : ''}">Residency</a>
      </div>`;
    return layout(title, `<style>${APP_STYLES}</style>${nav}${body}`, username);
  }

  // ============================================================
  // Helper: format date for display
  // ============================================================
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  }
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    let h = d.getUTCHours();
    const m = d.getUTCMinutes().toString().padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m} ${ampm}`;
  }
  function fmtSlotTime(timeStr) {
    if (!timeStr) return '';
    const [h, m] = timeStr.split(':');
    const hour = parseInt(h);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const h12 = hour % 12 || 12;
    return `${h12}:${m} ${ampm}`;
  }
  function fmtShortDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00Z');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
  }
  function fmtDayName(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00Z');
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return days[d.getUTCDay()];
  }
  function fmtLongDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00Z');
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
  }
  function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escJsStr(str) {
    // Safe for embedding inside JS single-quoted string literals in HTML attributes
    return JSON.stringify(String(str || '')).slice(1, -1);
  }
  const VALID_ROLES = new Set(['host', 'setup', 'cleanup', 'catering', 'security', 'other']);
  const VALID_STATUSES = new Set(['pending', 'confirmed', 'cancelled']);

  // ============================================================
  // EVENTS PAGE
  // ============================================================
  router.get('/events', async (req, res) => {
    const username = req.auth.user;

    // Auto-sync with Google Calendar on page load
    await syncGoogleCalendar();

    const events = db.getAllEvents();

    // Get assignments for each event
    for (const evt of events) {
      evt.assignments = db.getAssignmentsForEvent(evt.id);
    }

    const now = new Date().toISOString();
    const upcoming = events.filter(e => e.start_time >= now);
    const past = events.filter(e => e.start_time < now);

    function renderEventCard(evt) {
      const grouped = {};
      for (const a of evt.assignments) {
        if (!grouped[a.role]) grouped[a.role] = [];
        grouped[a.role].push(a);
      }

      let assignmentsHtml = '';
      if (Object.keys(grouped).length > 0) {
        for (const [role, assigns] of Object.entries(grouped)) {
          const safeRole = VALID_ROLES.has(role) ? role : 'other';
          const names = assigns.map(a => escHtml(a.user_name)).join(', ');
          assignmentsHtml += `<div class="assignments-group"><span class="badge-sm role-${safeRole}">${escHtml(role)}</span> <span class="names">${names}</span></div>`;
        }
      } else {
        assignmentsHtml = '<p style="font-size:13px;color:#555">No assignments yet</p>';
      }

      let calendarLink = '';
      if (evt.google_calendar_id) {
        const eid = Buffer.from(evt.google_calendar_id).toString('base64');
        calendarLink = `<a href="https://www.google.com/calendar/event?eid=${escHtml(eid)}" target="_blank" rel="noopener noreferrer" style="font-size:13px;color:#7eb8da">View in Calendar</a>`;
      }

      return `
        <div class="card" data-event-id="${evt.id}">
          <div class="card-header">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
              <div>
                <p class="card-title">${escHtml(evt.title)}</p>
                ${evt.description ? `<p class="card-desc">${escHtml(evt.description)}</p>` : ''}
              </div>
              ${evt.tours_eligible ? '<span class="badge-sm badge-teal">Tours OK</span>' : ''}
            </div>
          </div>
          <div class="card-content">
            <div class="meta" style="margin-bottom:12px">
              <span class="meta-item">${fmtDate(evt.start_time)}</span>
              <span class="meta-item">${fmtTime(evt.start_time)} - ${fmtTime(evt.end_time)}</span>
              ${evt.location ? `<span class="meta-item">${escHtml(evt.location)}</span>` : ''}
              ${calendarLink}
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
              <span style="font-size:13px;font-weight:500;color:#ddd">Assignments</span>
              <button class="btn btn-sm assign-btn" data-event-id="${evt.id}" data-event-title="${escHtml(evt.title)}">Assign</button>
            </div>
            <div class="card-assignments">${assignmentsHtml}</div>
          </div>
        </div>`;
    }

    let body = `
      <div class="app-header">
        <h2>Events</h2>
        <p style="font-size:13px;color:#666;margin-top:4px">Synced from Google Calendar</p>
      </div>`;

    if (upcoming.length > 0) {
      body += `<h3 class="section-title">Upcoming Events</h3><div class="grid-2">${upcoming.map(renderEventCard).join('')}</div>`;
    }
    if (past.length > 0) {
      body += `<h3 class="section-title section-muted" style="margin-top:32px">Past Events</h3><div class="grid-2" style="opacity:0.75">${past.map(renderEventCard).join('')}</div>`;
    }
    if (events.length === 0) {
      body += '<div class="empty-state"><p style="font-size:16px;font-weight:500">No events yet</p><p>Events will appear here once synced from Google Calendar.</p></div>';
    }

    // Assignment Modal
    body += `
      <div class="modal-overlay" id="assign-modal">
        <div class="modal">
          <h3 id="assign-modal-title">Assign People</h3>
          <p class="modal-desc">Add or remove assignments for this event.</p>
          <div style="display:flex;gap:8px;margin-bottom:12px">
            <select id="assign-user" style="flex:1;padding:8px;background:#0d0d0d;border:1px solid #333;border-radius:6px;color:#ddd;font-size:13px">
              <option value="">Select person...</option>
            </select>
            <select id="assign-role" style="width:120px;padding:8px;background:#0d0d0d;border:1px solid #333;border-radius:6px;color:#ddd;font-size:13px">
              <option value="">Role...</option>
              <option value="host">host</option>
              <option value="setup">setup</option>
              <option value="cleanup">cleanup</option>
              <option value="catering">catering</option>
              <option value="security">security</option>
              <option value="other">other</option>
            </select>
            <button class="btn btn-primary btn-sm" onclick="addAssignment()">Add</button>
          </div>
          <div style="margin-bottom:12px">
            <input id="new-user-name" placeholder="Or type a new name..." style="width:calc(100% - 80px);padding:8px;background:#0d0d0d;border:1px solid #333;border-radius:6px;color:#ddd;font-size:13px;margin-right:8px">
            <button class="btn btn-sm" onclick="createNewUser()">Create</button>
          </div>
          <div id="assign-current"></div>
          <div class="form-actions">
            <button class="btn" onclick="closeModal('assign-modal')">Done</button>
          </div>
        </div>
      </div>`;

    // Script
    body += `
      <script>
        let currentEventId = null;
        let allUsers = [];

        function openModal(id) {
          const el = document.getElementById(id);
          el.classList.add('active');
          const first = el.querySelector('input,select,textarea');
          if (first) first.focus();
        }
        function closeModal(id) { document.getElementById(id).classList.remove('active'); }

        document.addEventListener('keydown', function(e) {
          if (e.key === 'Escape') {
            document.querySelectorAll('.modal-overlay.active').forEach(function(el) { el.classList.remove('active'); });
          }
        });

        document.querySelectorAll('.modal-overlay').forEach(el => {
          el.addEventListener('click', (e) => { if (e.target === el) el.classList.remove('active'); });
        });

        function populateSelect(sel, placeholder, users) {
          sel.textContent = '';
          const def = document.createElement('option');
          def.value = '';
          def.textContent = placeholder;
          sel.appendChild(def);
          users.forEach(u => {
            const opt = document.createElement('option');
            opt.value = u.id;
            opt.textContent = u.name;
            sel.appendChild(opt);
          });
        }

        async function loadUsers() {
          const res = await fetch('/api/users');
          allUsers = await res.json();
          populateSelect(document.getElementById('assign-user'), 'Select person...', allUsers);
        }
        loadUsers();

        // Helper: re-render the assignment HTML on a card without reloading
        async function refreshCardAssignments(eventId) {
          const res = await fetch('/api/events/' + eventId + '/assignments');
          const assignments = await res.json();
          const card = document.querySelector('.card[data-event-id="' + eventId + '"]');
          if (!card) return;
          const container = card.querySelector('.card-assignments');
          if (!container) return;
          if (assignments.length === 0) {
            container.innerHTML = '<p style="font-size:13px;color:#555">No assignments yet</p>';
            return;
          }
          const grouped = {};
          assignments.forEach(function(a) {
            if (!grouped[a.role]) grouped[a.role] = [];
            grouped[a.role].push(a);
          });
          let html = '';
          const validRoles = new Set(['host','setup','cleanup','catering','security','other']);
          for (const role of Object.keys(grouped)) {
            const safeRole = validRoles.has(role) ? role : 'other';
            const names = grouped[role].map(function(a) { return a.user_name; }).join(', ');
            html += '<div class="assignments-group"><span class="badge-sm role-' + safeRole + '">' + role + '</span> <span class="names">' + names + '</span></div>';
          }
          container.innerHTML = html;
        }

        // Use data attributes instead of inline onclick for assign buttons
        document.querySelectorAll('.assign-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const eventId = btn.dataset.eventId;
            const title = btn.dataset.eventTitle;
            currentEventId = eventId;
            document.getElementById('assign-modal-title').textContent = 'Assign People to ' + title;
            loadAssignments(eventId);
            openModal('assign-modal');
          });
        });

        async function loadAssignments(eventId) {
          const res = await fetch('/api/events/' + eventId + '/assignments');
          const assignments = await res.json();
          const container = document.getElementById('assign-current');
          container.textContent = '';
          if (assignments.length === 0) {
            container.innerHTML = '<p style="font-size:13px;color:#555">No assignments yet</p>';
            return;
          }
          const header = document.createElement('p');
          header.style.cssText = 'font-size:13px;font-weight:500;color:#ddd;margin-bottom:8px';
          header.textContent = 'Current Assignments';
          container.appendChild(header);
          assignments.forEach(a => {
            const row = document.createElement('div');
            row.className = 'list-item';
            const info = document.createElement('div');
            info.className = 'info';
            const nameEl = document.createElement('span');
            nameEl.className = 'name';
            nameEl.textContent = a.user_name;
            const detail = document.createElement('span');
            detail.className = 'detail';
            detail.textContent = ' as ' + a.role;
            info.appendChild(nameEl);
            info.appendChild(detail);
            const actions = document.createElement('div');
            actions.className = 'actions';
            const rmBtn = document.createElement('button');
            rmBtn.className = 'btn btn-ghost btn-sm';
            rmBtn.textContent = 'Remove';
            rmBtn.addEventListener('click', () => removeAssignment(a.id));
            actions.appendChild(rmBtn);
            row.appendChild(info);
            row.appendChild(actions);
            container.appendChild(row);
          });
        }

        async function addAssignment() {
          const userId = document.getElementById('assign-user').value;
          const role = document.getElementById('assign-role').value;
          if (!userId || !role) return;
          await fetch('/api/assignments', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ event_id: currentEventId, user_id: userId, role }) });
          await loadAssignments(currentEventId);
          await refreshCardAssignments(currentEventId);
        }

        async function removeAssignment(id) {
          await fetch('/api/assignments/' + id, { method: 'DELETE' });
          await loadAssignments(currentEventId);
          await refreshCardAssignments(currentEventId);
        }

        async function createNewUser() {
          const name = document.getElementById('new-user-name').value.trim();
          if (!name) return;
          await fetch('/api/users', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name }) });
          document.getElementById('new-user-name').value = '';
          await loadUsers();
        }
      </script>`;

    res.send(appLayout('Events', body, username, 'events'));
  });

  // ============================================================
  // TOURS PAGE
  // ============================================================
  router.get('/tours', async (req, res) => {
    const username = req.auth.user;

    // Auto-sync with Google Calendar on page load
    await syncGoogleCalendar();

    const slots = db.getAllTourSlots();
    const events = db.getAllEvents();

    const today = new Date().toISOString().split('T')[0];
    const upcomingSlots = slots.filter(s => s.slot_date >= today);
    const pastSlots = slots.filter(s => s.slot_date < today);

    // Events that could be tour dates but don't have slots yet
    const now = new Date().toISOString();
    const upcomingEvents = events.filter(e => e.start_time >= now);
    const eventsWithoutSlots = upcomingEvents.filter(e => !slots.some(s => s.event_id === e.id));

    function renderTourSlotCard(slot, isPast) {
      const confirmedReqs = (slot.requests || []).filter(r => r.status === 'confirmed');
      const pendingReqs = (slot.requests || []).filter(r => r.status === 'pending');
      const totalGuests = confirmedReqs.reduce((sum, r) => sum + r.group_size, 0);

      let shiftsHtml = '';
      if (slot.shifts && slot.shifts.length > 0) {
        shiftsHtml = slot.shifts.map(s => `
          <div class="list-item" data-shift-id="${s.id}">
            <span class="name">${escHtml(s.user_name)}</span>
            ${!isPast ? `<button class="btn btn-ghost btn-sm release-shift-btn" data-shift-id="${s.id}" data-slot-id="${slot.id}">Release</button>` : ''}
          </div>`).join('');
      } else {
        shiftsHtml = '<p style="font-size:13px;color:#555">No guides assigned</p>';
      }

      // Slot date/time for request modal title
      const slotDateLabel = fmtLongDate(slot.slot_date);
      const slotTimeLabel = fmtSlotTime(slot.slot_time);

      return `
        <div class="card ${slot.slot_type === 'special' ? 'card-accent' : ''}" data-slot-id="${slot.id}">
          <div class="card-header">
            <div style="display:flex;justify-content:space-between;align-items:flex-start">
              <div>
                <p class="card-title">${fmtDayName(slot.slot_date)} Tour</p>
                <div class="meta" style="margin-top:4px">
                  <span class="meta-item">${fmtShortDate(slot.slot_date)}</span>
                </div>
              </div>
              <span class="badge-sm ${slot.slot_type === 'special' ? 'badge-blue' : 'badge-gray'}">${slot.slot_type === 'special' ? 'Special' : 'Regular'}</span>
            </div>
          </div>
          <div class="card-content">
            <div class="meta" style="margin-bottom:12px">
              <span class="meta-item">${fmtSlotTime(slot.slot_time)}</span>
              <span class="meta-item">${totalGuests}/${slot.max_capacity} guests</span>
            </div>
            ${slot.event_title ? `<div class="tag-bar"><span style="font-weight:500;color:#ddd">During:</span> ${escHtml(slot.event_title)}</div>` : ''}

            <div style="margin-bottom:8px">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                <span style="font-size:13px;font-weight:500;color:#ddd">Tour Guides</span>
              </div>
              <div class="card-guides">${shiftsHtml}</div>
              ${!isPast ? `
                <input class="shift-claim-input" data-slot="${slot.id}" placeholder="Type name + Enter to claim" style="width:100%;padding:8px;background:#0d0d0d;border:1px solid #333;border-radius:6px;color:#ddd;font-size:13px;margin-top:6px">` : ''}
            </div>

            <hr class="divider">

            <div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                <span style="font-size:13px;font-weight:500;color:#ddd">Tour Requests</span>
                ${!isPast ? `<button class="btn btn-sm request-btn" data-slot-id="${slot.id}" data-slot-date="${escHtml(slotDateLabel)}" data-slot-time="${escHtml(slotTimeLabel)}">Request</button>` : ''}
              </div>
              <div class="meta">
                <span>${confirmedReqs.length} confirmed (${totalGuests} guests)</span>
                ${pendingReqs.length > 0 ? `<span class="status-pending">${pendingReqs.length} pending</span>` : ''}
              </div>
            </div>
          </div>
        </div>`;
    }

    function renderEventCard(evt) {
      return `
        <div class="card card-dashed" style="border-color:#2a5a8a50">
          <div class="card-header">
            <div style="display:flex;justify-content:space-between;align-items:flex-start">
              <div>
                <p class="card-title">${escHtml(evt.title)}</p>
                <div class="meta" style="margin-top:4px">
                  <span class="meta-item">${fmtDate(evt.start_time)}</span>
                </div>
              </div>
              <span class="badge-sm badge-teal">Potential Tour</span>
            </div>
          </div>
          <div class="card-content">
            <div class="meta" style="margin-bottom:8px">
              <span class="meta-item">${fmtTime(evt.start_time)}</span>
              ${evt.location ? `<span class="meta-item">${escHtml(evt.location)}</span>` : ''}
            </div>
            ${evt.description ? `<p style="font-size:13px;color:#666;margin-bottom:8px">${escHtml(evt.description)}</p>` : ''}
            <p style="font-size:12px;color:#555;font-style:italic">Use "Add Slot" to schedule a tour during this event</p>
          </div>
        </div>`;
    }

    let body = `
      <div class="app-header">
        <h2>Tours</h2>
        <div class="app-actions">
          <button class="btn" onclick="generateWeekly()">Generate Weekly</button>
          <button class="btn btn-primary" onclick="openModal('add-slot-modal')">+ Add Slot</button>
        </div>
      </div>`;

    if (eventsWithoutSlots.length > 0) {
      body += `<h3 class="section-title">Upcoming Events (Potential Tour Dates)</h3>
        <p style="font-size:13px;color:#666;margin-bottom:16px">These events can be set up as tour opportunities.</p>
        <div class="grid-3">${eventsWithoutSlots.map(renderEventCard).join('')}</div>`;
    }

    if (upcomingSlots.length > 0) {
      body += `<h3 class="section-title" style="margin-top:32px">Scheduled Tours</h3><div class="grid-3">${upcomingSlots.map(s => renderTourSlotCard(s, false)).join('')}</div>`;
    }

    if (pastSlots.length > 0) {
      body += `<h3 class="section-title section-muted" style="margin-top:32px">Past Tours</h3><div class="grid-3" style="opacity:0.6">${pastSlots.map(s => renderTourSlotCard(s, true)).join('')}</div>`;
    }

    if (slots.length === 0 && eventsWithoutSlots.length === 0) {
      body += '<div class="empty-state"><p style="font-size:16px;font-weight:500">No tour slots yet</p><p>Generate weekly slots or add custom tour times.</p></div>';
    }

    // Add Slot Modal — show all upcoming events (not just tours_eligible)
    const eligibleEvents = upcomingEvents;
    body += `
      <div class="modal-overlay" id="add-slot-modal">
        <div class="modal">
          <h3>Add Tour Slot</h3>
          <p class="modal-desc">Create a custom tour time slot.</p>
          <form onsubmit="addTourSlot(event)">
            <div class="form-row">
              <div class="form-group"><label>Date</label><input name="slot_date" type="date" required></div>
              <div class="form-group"><label>Time</label><input name="slot_time" type="time" required value="14:00"></div>
            </div>
            <div class="form-group"><label>Max Capacity</label><input name="max_capacity" type="number" value="10" min="1"></div>
            ${eligibleEvents.length > 0 ? `
              <div class="form-group">
                <label>Link to Event (Optional)</label>
                <select name="event_id" style="width:100%;padding:8px;background:#0d0d0d;border:1px solid #333;border-radius:6px;color:#ddd;font-size:13px">
                  <option value="">No event - regular slot</option>
                  ${eligibleEvents.map(e => `<option value="${e.id}">${escHtml(e.title)}</option>`).join('')}
                </select>
              </div>` : ''}
            <div class="form-group"><label>Notes</label><textarea name="notes" rows="2" placeholder="Optional notes..." style="width:100%;padding:8px 12px;background:#0d0d0d;border:1px solid #333;border-radius:6px;color:#ddd;font-size:13px;font-family:inherit;resize:vertical"></textarea></div>
            <div class="form-actions">
              <button type="button" class="btn" onclick="closeModal('add-slot-modal')">Cancel</button>
              <button type="submit" class="btn btn-primary">Add Slot</button>
            </div>
          </form>
        </div>
      </div>`;

    // Tour Request Modal
    body += `
      <div class="modal-overlay" id="request-modal">
        <div class="modal">
          <h3 id="request-modal-title">Tour Requests</h3>
          <p class="modal-desc">Add tour requests for this slot.</p>
          <form onsubmit="addTourRequest(event)" style="border:1px solid #222;border-radius:6px;padding:12px;margin-bottom:16px">
            <p style="font-size:13px;font-weight:500;color:#ddd;margin-bottom:8px">New Request</p>
            <div class="form-row">
              <div class="form-group"><label>Name</label><input name="requester_name" required placeholder="John Doe"></div>
              <div class="form-group"><label>Group Size</label><input name="group_size" type="number" value="1" min="1"></div>
            </div>
            <div class="form-group"><label>Preferred Date</label><input name="preferred_date" type="date"></div>
            <div class="form-group"><label>Email</label><input name="requester_email" type="email" placeholder="john@example.com"></div>
            <div class="form-group"><label>Phone</label><input name="requester_phone" placeholder="555-1234"></div>
            <div class="form-group"><label>Notes</label><input name="notes" placeholder="Any special requests..."></div>
            <button type="submit" class="btn btn-sm btn-primary">Add Request</button>
          </form>
          <div id="request-list"></div>
          <div class="form-actions">
            <button class="btn" onclick="closeModal('request-modal')">Done</button>
          </div>
        </div>
      </div>`;

    // Script
    body += `
      <script>
        let currentSlotId = null;
        let allUsers = [];

        function openModal(id) {
          const el = document.getElementById(id);
          el.classList.add('active');
          const first = el.querySelector('input,select,textarea');
          if (first) first.focus();
        }
        function closeModal(id) { document.getElementById(id).classList.remove('active'); }

        document.addEventListener('keydown', function(e) {
          if (e.key === 'Escape') {
            document.querySelectorAll('.modal-overlay.active').forEach(function(el) { el.classList.remove('active'); });
          }
        });

        document.querySelectorAll('.modal-overlay').forEach(el => {
          el.addEventListener('click', (e) => { if (e.target === el) el.classList.remove('active'); });
        });

        function populateSelect(sel, placeholder, users) {
          sel.textContent = '';
          const def = document.createElement('option');
          def.value = '';
          def.textContent = placeholder;
          sel.appendChild(def);
          users.forEach(u => {
            const opt = document.createElement('option');
            opt.value = u.id;
            opt.textContent = u.name;
            sel.appendChild(opt);
          });
        }

        async function findOrCreateUser(name) {
          const res = await fetch('/api/users');
          const users = await res.json();
          const existing = users.find(u => u.name.toLowerCase() === name.toLowerCase());
          if (existing) return existing.id;
          const created = await fetch('/api/users', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name }) });
          const user = await created.json();
          return user.id;
        }

        // Helper: fetch a single slot and update the card in place
        async function refreshSlotCard(slotId) {
          const res = await fetch('/api/tour-slots/' + slotId);
          if (!res.ok) return;
          const slot = await res.json();
          const card = document.querySelector('.card[data-slot-id="' + slotId + '"]');
          if (!card) return;

          // Update guides section
          const guidesContainer = card.querySelector('.card-guides');
          if (guidesContainer) {
            if (slot.shifts && slot.shifts.length > 0) {
              guidesContainer.innerHTML = slot.shifts.map(function(s) {
                return '<div class="list-item" data-shift-id="' + s.id + '">' +
                  '<span class="name">' + s.user_name + '</span>' +
                  '<button class="btn btn-ghost btn-sm release-shift-btn" data-shift-id="' + s.id + '" data-slot-id="' + slotId + '">Release</button>' +
                  '</div>';
              }).join('');
              // Re-bind release buttons
              guidesContainer.querySelectorAll('.release-shift-btn').forEach(function(btn) {
                btn.addEventListener('click', function() { releaseShift(btn.dataset.shiftId, btn.dataset.slotId); });
              });
            } else {
              guidesContainer.innerHTML = '<p style="font-size:13px;color:#555">No guides assigned</p>';
            }
          }

          // Update capacity display
          var confirmedReqs = (slot.requests || []).filter(function(r) { return r.status === 'confirmed'; });
          var totalGuests = confirmedReqs.reduce(function(sum, r) { return sum + r.group_size; }, 0);
          var metaItems = card.querySelectorAll('.meta .meta-item');
          metaItems.forEach(function(item) {
            if (item.textContent.indexOf('guests') !== -1) {
              item.textContent = totalGuests + '/' + slot.max_capacity + ' guests';
            }
          });
        }

        document.querySelectorAll('.shift-claim-input').forEach(input => {
          input.addEventListener('keydown', async (e) => {
            if (e.key !== 'Enter') return;
            const name = input.value.trim();
            if (!name) return;
            input.disabled = true;
            const userId = await findOrCreateUser(name);
            const slotId = input.dataset.slot;
            await fetch('/api/tour-shifts', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ tour_slot_id: slotId, user_id: userId, shift_type: 'lead' })});
            input.value = '';
            input.disabled = false;
            await refreshSlotCard(slotId);
          });
        });

        // Bind release shift buttons via event delegation
        document.addEventListener('click', function(e) {
          const btn = e.target.closest('.release-shift-btn');
          if (btn) {
            releaseShift(btn.dataset.shiftId, btn.dataset.slotId);
          }
        });

        async function addTourSlot(e) {
          e.preventDefault();
          const fd = new FormData(e.target);
          const eventId = fd.get('event_id');
          await fetch('/api/tour-slots', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({
            slot_date: fd.get('slot_date'),
            slot_time: fd.get('slot_time'),
            max_capacity: parseInt(fd.get('max_capacity')) || 10,
            event_id: eventId || null,
            slot_type: eventId ? 'special' : 'regular',
            notes: fd.get('notes'),
          })});
          location.reload();
        }

        async function generateWeekly() {
          if (!confirm('Generate tour slots for the next 4 weeks on Fridays and Mondays at 2:00 PM?')) return;
          await fetch('/api/tour-slots/generate-weekly', { method: 'POST' });
          location.reload();
        }

        async function releaseShift(shiftId, slotId) {
          await fetch('/api/tour-shifts/' + shiftId, { method: 'DELETE' });
          await refreshSlotCard(slotId);
        }

        // Request modal: use data attributes for slot context
        document.querySelectorAll('.request-btn').forEach(function(btn) {
          btn.addEventListener('click', function() {
            var slotId = btn.dataset.slotId;
            var slotDate = btn.dataset.slotDate;
            var slotTime = btn.dataset.slotTime;
            currentSlotId = slotId;
            document.getElementById('request-modal-title').textContent = 'Tour Requests \\u2014 ' + slotDate + ' at ' + slotTime;
            loadRequests(slotId);
            openModal('request-modal');
          });
        });

        async function loadRequests(slotId) {
          const res = await fetch('/api/tour-slots/' + slotId + '/requests');
          const requests = await res.json();
          const container = document.getElementById('request-list');
          container.textContent = '';
          if (requests.length === 0) {
            container.innerHTML = '<p style="font-size:13px;color:#555">No requests yet</p>';
            return;
          }
          const statusBadge = { pending: 'badge-yellow', confirmed: 'badge-green', cancelled: 'badge-gray' };
          const header = document.createElement('p');
          header.style.cssText = 'font-size:13px;font-weight:500;color:#ddd;margin-bottom:8px';
          header.textContent = 'Current Requests';
          container.appendChild(header);
          requests.forEach(r => {
            const row = document.createElement('div');
            row.className = 'list-item';
            const info = document.createElement('div');
            info.className = 'info';
            const top = document.createElement('div');
            top.style.cssText = 'display:flex;align-items:center;gap:6px';
            const nameEl = document.createElement('span');
            nameEl.className = 'name';
            nameEl.textContent = r.requester_name;
            const badge = document.createElement('span');
            badge.className = 'badge-sm ' + (statusBadge[r.status] || 'badge-gray');
            badge.textContent = r.status;
            top.appendChild(nameEl);
            top.appendChild(badge);
            const detail = document.createElement('span');
            detail.className = 'detail';
            let detailText = r.group_size + (r.group_size === 1 ? ' person' : ' people');
            if (r.requester_email) detailText += ' \\u2022 ' + r.requester_email;
            if (r.preferred_date) detailText += ' \\u2022 pref: ' + r.preferred_date;
            detail.textContent = detailText;
            info.appendChild(top);
            info.appendChild(detail);
            row.appendChild(info);
            container.appendChild(row);
          });
        }

        async function addTourRequest(e) {
          e.preventDefault();
          const fd = new FormData(e.target);
          await fetch('/api/tour-requests', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({
            tour_slot_id: currentSlotId,
            requester_name: fd.get('requester_name'),
            requester_email: fd.get('requester_email'),
            requester_phone: fd.get('requester_phone'),
            preferred_date: fd.get('preferred_date') || null,
            group_size: parseInt(fd.get('group_size')) || 1,
            notes: fd.get('notes'),
          })});
          e.target.reset();
          await loadRequests(currentSlotId);
        }
      </script>`;

    res.send(appLayout('Tours', body, username, 'tours'));
  });

  // ============================================================
  // Gantt chart renderer for residency occupancy
  // ============================================================
  function renderGantt(rooms, todayStr) {
    // Collect all occupancies across rooms
    const allOcc = [];
    for (const room of rooms) {
      for (const o of (room.occupancy || [])) {
        allOcc.push({ ...o, roomName: room.room_name || 'Room ' + room.room_number });
      }
    }

    // Determine timeline range: earliest start to latest end (or today + 90 days)
    const todayMs = new Date(todayStr + 'T00:00:00Z').getTime();
    const msPerDay = 86400000;
    let minDate = todayMs;
    let maxDate = todayMs + 90 * msPerDay;

    for (const o of allOcc) {
      const s = new Date(o.start_date + 'T00:00:00Z').getTime();
      const e = o.end_date ? new Date(o.end_date + 'T00:00:00Z').getTime() : todayMs + 90 * msPerDay;
      if (s < minDate) minDate = s;
      if (e > maxDate) maxDate = e;
    }

    // Pad by 7 days on each side
    minDate -= 7 * msPerDay;
    maxDate += 7 * msPerDay;
    const totalDays = Math.ceil((maxDate - minDate) / msPerDay);

    // Layout constants
    const labelW = 110;
    const chartW = 700;
    const rowH = 28;
    const padTop = 30;
    // Show ALL rooms, not just those with occupancies
    const allRooms = rooms;
    const svgH = padTop + allRooms.length * rowH + 10;
    const totalW = labelW + chartW + 20;

    function dayToX(dateStr) {
      const ms = new Date(dateStr + 'T00:00:00Z').getTime();
      return labelW + ((ms - minDate) / (maxDate - minDate)) * chartW;
    }

    // Month labels
    let monthLabels = '';
    const cursor = new Date(minDate);
    cursor.setUTCDate(1);
    if (cursor.getTime() < minDate) cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    while (cursor.getTime() < maxDate) {
      const x = labelW + ((cursor.getTime() - minDate) / (maxDate - minDate)) * chartW;
      if (x >= labelW && x <= labelW + chartW) {
        monthLabels += `<text x="${x}" y="16" fill="#666" font-size="10">${months[cursor.getUTCMonth()]} ${cursor.getUTCFullYear()}</text>`;
        monthLabels += `<line x1="${x}" y1="20" x2="${x}" y2="${svgH}" stroke="#1a1a1a" stroke-width="1"/>`;
      }
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }

    // Today marker
    const todayX = labelW + ((todayMs - minDate) / (maxDate - minDate)) * chartW;
    let todayMarker = '';
    if (todayX >= labelW && todayX <= labelW + chartW) {
      todayMarker = `<line x1="${todayX}" y1="${padTop - 5}" x2="${todayX}" y2="${svgH}" stroke="#d9534f" stroke-width="1.5" stroke-dasharray="4,3"/>`;
      todayMarker += `<text x="${todayX}" y="${padTop - 8}" fill="#d9534f" font-size="9" text-anchor="middle">today</text>`;
    }

    // Room rows
    let rowsSvg = '';
    const barColors = ['#2a5a3a', '#1a4a6a', '#4a3a5a', '#5a4a1a', '#1a5a5a', '#5a2a3a'];
    const guestColor = '#3a3a1a';
    let colorIdx = 0;

    allRooms.forEach((room, i) => {
      const y = padTop + i * rowH;

      // Room label
      const rName = escHtml(room.room_name || 'Room ' + room.room_number);
      rowsSvg += `<text x="${labelW - 8}" y="${y + rowH / 2 + 4}" fill="#999" font-size="11" text-anchor="end">${rName}</text>`;

      // Row background
      rowsSvg += `<rect x="${labelW}" y="${y + 2}" width="${chartW}" height="${rowH - 4}" rx="2" fill="#0d0d0d"/>`;

      // Occupancy bars
      for (const o of (room.occupancy || [])) {
        const startX = dayToX(o.start_date);
        const endDateStr = o.end_date || new Date(todayMs + 90 * msPerDay).toISOString().split('T')[0];
        let endX = dayToX(endDateStr);
        // Clamp
        const x1 = Math.max(startX, labelW);
        const x2 = Math.min(endX, labelW + chartW);
        if (x2 <= x1) continue;

        const color = o.is_guest ? guestColor : barColors[colorIdx % barColors.length];
        const barY = y + 4;
        const barH = rowH - 8;
        const name = escHtml(o.is_guest ? o.guest_name : o.user_name);
        const tooltipEnd = o.end_date || 'ongoing';
        const tooltipText = `${o.is_guest ? o.guest_name : o.user_name}: ${o.start_date} - ${tooltipEnd}`;

        // Clickable bar that opens edit modal
        rowsSvg += `<rect class="gantt-bar" data-occ-id="${o.id}" data-occ-name="${escHtml(o.is_guest ? o.guest_name : o.user_name)}" data-occ-guest="${o.is_guest ? 1 : 0}" data-occ-start="${o.start_date}" data-occ-end="${o.end_date || ''}" data-occ-notes="${escHtml(o.notes || '')}" x="${x1}" y="${barY}" width="${x2 - x1}" height="${barH}" rx="3" fill="${color}" stroke="${o.is_guest ? '#666' : '#5cb85c'}" stroke-width="0.5" style="cursor:pointer"><title>${escHtml(tooltipText)}</title></rect>`;

        // Name label if bar is wide enough
        if (x2 - x1 > 40) {
          rowsSvg += `<text x="${x1 + 4}" y="${barY + barH - 4}" fill="#ddd" font-size="10" style="pointer-events:none">${name}${!o.end_date ? ' (ongoing)' : ''}</text>`;
        }

        if (!o.is_guest) colorIdx++;
      }
    });

    return `
      <div style="margin-bottom:24px;overflow-x:auto;background:#111;border:1px solid #222;border-radius:8px;padding:12px">
        <h3 style="font-size:14px;color:#999;margin:0 0 8px;font-weight:500">Occupancy Timeline</h3>
        <svg width="${totalW}" height="${svgH}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
          ${monthLabels}
          ${todayMarker}
          ${rowsSvg}
        </svg>
        <div style="display:flex;gap:16px;margin-top:8px;font-size:11px;color:#666">
          <div style="display:flex;align-items:center;gap:4px"><div style="width:12px;height:8px;border-radius:2px;background:#2a5a3a;border:0.5px solid #5cb85c"></div>Resident</div>
          <div style="display:flex;align-items:center;gap:4px"><div style="width:12px;height:8px;border-radius:2px;background:#3a3a1a;border:0.5px solid #666"></div>Guest</div>
          <div style="display:flex;align-items:center;gap:4px"><div style="width:2px;height:10px;background:#d9534f"></div>Today</div>
        </div>
      </div>`;
  }

  // ============================================================
  // RESIDENCY PAGE
  // ============================================================
  router.get('/residency', (req, res) => {
    const username = req.auth.user;
    const rooms = db.getAllRooms();
    const users = db.getAllUsers();

    const today = new Date().toISOString().split('T')[0];

    function getCurrentOccupants(room) {
      return (room.occupancy || []).filter(o => {
        return o.start_date <= today && (!o.end_date || o.end_date >= today);
      });
    }

    const occupiedCount = rooms.filter(r => getCurrentOccupants(r).length > 0).length;
    const emptyCount = rooms.length - occupiedCount;

    function renderRoomCard(room) {
      const current = getCurrentOccupants(room);
      const isEmpty = current.length === 0;
      const currentCount = current.length;

      let occupantsHtml = '';
      if (current.length > 0) {
        occupantsHtml = current.map(o => `
          <div class="list-item" data-occ-id="${o.id}">
            <div class="info">
              <div style="display:flex;align-items:center;gap:6px">
                <span class="name">${escHtml(o.is_guest ? o.guest_name : o.user_name)}</span>
                ${o.is_guest ? '<span class="badge-sm badge-orange">Guest</span>' : ''}
              </div>
              <span class="detail">${fmtShortDate(o.start_date)}${o.end_date ? ' - ' + fmtShortDate(o.end_date) : ' - ongoing'}</span>
            </div>
            <div class="actions">
              <button class="btn btn-ghost btn-sm edit-occ-btn" data-occ-id="${o.id}" data-occ-name="${escHtml(o.is_guest ? o.guest_name : o.user_name)}" data-occ-guest="${o.is_guest ? 1 : 0}" data-occ-start="${o.start_date}" data-occ-end="${o.end_date || ''}" data-occ-notes="${escHtml(o.notes || '')}">Edit</button>
              <button class="btn btn-ghost btn-sm remove-occ-btn" data-room-id="${room.id}" data-occ-id="${o.id}">Remove</button>
            </div>
          </div>`).join('');
      } else {
        occupantsHtml = '<p style="font-size:13px;color:#555">No current occupants</p>';
      }

      return `
        <div class="card ${isEmpty ? 'card-dashed' : ''}" style="${!isEmpty ? 'border-color:#1a3a1a50' : ''}" data-room-id="${room.id}">
          <div class="card-header">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div>
                <p class="card-title">${escHtml(room.room_name || 'Room ' + room.room_number)}</p>
                <p style="font-size:12px;color:#666;margin:2px 0 0">${currentCount}/${room.capacity} occupied</p>
              </div>
              <span class="badge-sm ${isEmpty ? 'badge-gray' : 'badge-green'}">${isEmpty ? 'Empty' : 'Occupied'}</span>
            </div>
          </div>
          <div class="card-content">
            <div class="card-occupants">${occupantsHtml}</div>
            <button class="btn btn-sm occ-btn" style="width:100%;margin-top:8px" data-room-id="${room.id}" data-room-name="${escHtml(room.room_name || 'Room ' + room.room_number)}">${isEmpty ? 'Add Resident or Guest' : 'Add Another'}</button>
            <div style="margin-top:6px;text-align:right">
              <button class="btn btn-sm btn-danger delete-room-btn" data-room-id="${room.id}" data-occupant-count="${currentCount}">Delete Room</button>
            </div>
          </div>
        </div>`;
    }

    let body = `
      <div class="app-header">
        <h2>Residency</h2>
        <div class="app-actions">
          <button class="btn btn-primary" onclick="openModal('add-room-modal')">+ Add Room</button>
        </div>
      </div>`;

    if (rooms.length > 0) {
      body += `
        <div class="tag-bar" style="margin-bottom:24px">
          <div style="display:flex;align-items:center;gap:6px"><div style="width:10px;height:10px;border-radius:50%;background:#5cb85c"></div><span>Occupied (${occupiedCount})</span></div>
          <div style="display:flex;align-items:center;gap:6px"><div style="width:10px;height:10px;border-radius:50%;background:#333"></div><span>Empty (${emptyCount})</span></div>
        </div>`;

      // --- Gantt Chart ---
      body += renderGantt(rooms, today);

      body += `<div class="grid-4">${rooms.map(renderRoomCard).join('')}</div>`;
    } else {
      body += '<div class="empty-state"><p style="font-size:16px;font-weight:500">No rooms yet</p><p>Add rooms to start tracking residency.</p></div>';
    }

    // Add Room Modal
    body += `
      <div class="modal-overlay" id="add-room-modal">
        <div class="modal">
          <h3>Add Room</h3>
          <p class="modal-desc">Create a new room.</p>
          <form onsubmit="addRoom(event)">
            <div class="form-row">
              <div class="form-group"><label>Room Number</label><input name="room_number" type="number" required min="1"></div>
              <div class="form-group"><label>Room Name</label><input name="room_name" placeholder="Optional name..."></div>
            </div>
            <div class="form-group"><label>Capacity</label><input name="capacity" type="number" value="1" min="1"></div>
            <div class="form-group"><label>Notes</label><input name="notes" placeholder="Optional notes..."></div>
            <div class="form-actions">
              <button type="button" class="btn" onclick="closeModal('add-room-modal')">Cancel</button>
              <button type="submit" class="btn btn-primary">Add Room</button>
            </div>
          </form>
        </div>
      </div>`;

    // Add Occupancy Modal
    body += `
      <div class="modal-overlay" id="occupancy-modal">
        <div class="modal">
          <h3 id="occupancy-modal-title">Add Occupant</h3>
          <p class="modal-desc">Add a resident or guest to this room.</p>
          <form onsubmit="addOccupancy(event)">
            <div class="checkbox-group">
              <input type="checkbox" id="is-guest-check" onchange="toggleGuestMode()">
              <label for="is-guest-check">This is a guest (not a community member)</label>
            </div>
            <div id="resident-name-area">
              <div class="form-group"><label>Name</label><input name="resident_name" placeholder="Type a name..."></div>
            </div>
            <div id="guest-name-area" style="display:none">
              <div class="form-group"><label>Guest Name</label><input name="guest_name" placeholder="Guest name"></div>
            </div>
            <div class="form-row">
              <div class="form-group"><label>Start Date</label><input name="start_date" type="date" required value="${today}"></div>
              <div class="form-group"><label>End Date</label><input name="end_date" type="date"></div>
            </div>
            <p style="font-size:12px;color:#555;margin-bottom:14px">Leave end date empty for permanent residents.</p>
            <div class="form-group"><label>Notes</label><input name="notes" placeholder="Optional notes..."></div>
            <div class="form-actions">
              <button type="button" class="btn" onclick="closeModal('occupancy-modal')">Cancel</button>
              <button type="submit" class="btn btn-primary">Add</button>
            </div>
          </form>
        </div>
      </div>`;

    // Edit Occupancy Modal
    body += `
      <div class="modal-overlay" id="edit-occ-modal">
        <div class="modal">
          <h3>Edit Occupancy</h3>
          <p class="modal-desc">Update dates or notes for this occupant.</p>
          <form onsubmit="saveOccupancy(event)">
            <input type="hidden" id="edit-occ-id">
            <div class="form-group">
              <label>Name</label>
              <p id="edit-occ-name" style="padding:8px 0;color:#ddd;font-size:13px;margin:0"></p>
              <span style="font-size:11px;color:#555">To change occupant, remove and re-add.</span>
            </div>
            <div class="form-row">
              <div class="form-group"><label>Start Date</label><input id="edit-occ-start" name="start_date" type="date" required></div>
              <div class="form-group"><label>End Date</label><input id="edit-occ-end" name="end_date" type="date"></div>
            </div>
            <p style="font-size:12px;color:#555;margin-bottom:14px">Leave end date empty for permanent residents.</p>
            <div class="form-group"><label>Notes</label><input id="edit-occ-notes" name="notes" placeholder="Optional notes..."></div>
            <div class="form-actions">
              <button type="button" class="btn" onclick="closeModal('edit-occ-modal')">Cancel</button>
              <button type="submit" class="btn btn-primary">Save</button>
            </div>
          </form>
        </div>
      </div>`;

    // Script
    body += `
      <script>
        let currentRoomId = null;
        let allUsers = [];

        function openModal(id) {
          const el = document.getElementById(id);
          el.classList.add('active');
          const first = el.querySelector('input:not([type=hidden]):not([disabled]),select,textarea');
          if (first) first.focus();
        }
        function closeModal(id) { document.getElementById(id).classList.remove('active'); }

        document.addEventListener('keydown', function(e) {
          if (e.key === 'Escape') {
            document.querySelectorAll('.modal-overlay.active').forEach(function(el) { el.classList.remove('active'); });
          }
        });

        document.querySelectorAll('.modal-overlay').forEach(el => {
          el.addEventListener('click', (e) => { if (e.target === el) el.classList.remove('active'); });
        });

        async function findOrCreateUser(name) {
          const res = await fetch('/api/users');
          const users = await res.json();
          const existing = users.find(u => u.name.toLowerCase() === name.toLowerCase());
          if (existing) return existing.id;
          const created = await fetch('/api/users', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name }) });
          const user = await created.json();
          return user.id;
        }

        function toggleGuestMode() {
          const isGuest = document.getElementById('is-guest-check').checked;
          document.getElementById('resident-name-area').style.display = isGuest ? 'none' : 'block';
          document.getElementById('guest-name-area').style.display = isGuest ? 'block' : 'none';
        }

        async function addRoom(e) {
          e.preventDefault();
          const fd = new FormData(e.target);
          await fetch('/api/rooms', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({
            room_number: parseInt(fd.get('room_number')),
            room_name: fd.get('room_name'),
            capacity: parseInt(fd.get('capacity')) || 1,
            notes: fd.get('notes'),
          })});
          location.reload();
        }

        // Delete room with occupant count warning
        document.querySelectorAll('.delete-room-btn').forEach(function(btn) {
          btn.addEventListener('click', async function() {
            const roomId = btn.dataset.roomId;
            const count = parseInt(btn.dataset.occupantCount) || 0;
            let msg = 'Delete this room and all its occupancy records?';
            if (count > 0) {
              msg = 'This room has ' + count + ' current occupant' + (count > 1 ? 's' : '') + '. Delete room and all occupancy records?';
            }
            if (!confirm(msg)) return;
            await fetch('/api/rooms/' + roomId, { method: 'DELETE' });
            location.reload();
          });
        });

        // Use data attributes instead of inline onclick for occupancy buttons
        document.querySelectorAll('.occ-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            currentRoomId = btn.dataset.roomId;
            document.getElementById('occupancy-modal-title').textContent = 'Add to ' + btn.dataset.roomName;
            document.getElementById('is-guest-check').checked = false;
            toggleGuestMode();
            openModal('occupancy-modal');
          });
        });

        async function addOccupancy(e) {
          e.preventDefault();
          const fd = new FormData(e.target);
          const isGuest = document.getElementById('is-guest-check').checked;
          const startDate = fd.get('start_date');
          const endDate = fd.get('end_date');
          if (endDate && startDate && endDate < startDate) {
            alert('End date must be on or after start date.');
            return;
          }
          let userId = null;
          if (!isGuest) {
            const name = fd.get('resident_name')?.trim();
            if (!name) return;
            userId = await findOrCreateUser(name);
          }
          await fetch('/api/room-occupancy', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({
            room_id: currentRoomId,
            user_id: userId,
            guest_name: isGuest ? fd.get('guest_name') : null,
            start_date: startDate,
            end_date: endDate || null,
            is_guest: isGuest,
            notes: fd.get('notes'),
          })});
          location.reload();
        }

        // Remove occupancy: update card in place instead of reloading
        document.addEventListener('click', function(e) {
          const btn = e.target.closest('.remove-occ-btn');
          if (!btn) return;
          if (!confirm('Remove this occupant?')) return;
          const occId = btn.dataset.occId;
          fetch('/api/room-occupancy/' + occId, { method: 'DELETE' }).then(function() {
            // Remove the list-item from DOM
            const listItem = btn.closest('.list-item');
            if (listItem) listItem.remove();
          });
        });

        // Edit occupancy - bind edit buttons (cards and gantt bars)
        function openEditOccModal(occId, occName, occStart, occEnd, occNotes) {
          document.getElementById('edit-occ-id').value = occId;
          document.getElementById('edit-occ-name').textContent = occName;
          document.getElementById('edit-occ-start').value = occStart;
          document.getElementById('edit-occ-end').value = occEnd;
          document.getElementById('edit-occ-notes').value = occNotes;
          openModal('edit-occ-modal');
        }

        document.querySelectorAll('.edit-occ-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            openEditOccModal(btn.dataset.occId, btn.dataset.occName, btn.dataset.occStart, btn.dataset.occEnd, btn.dataset.occNotes);
          });
        });

        // Gantt bar clicks
        document.querySelectorAll('.gantt-bar').forEach(function(bar) {
          bar.addEventListener('click', function() {
            openEditOccModal(bar.dataset.occId, bar.dataset.occName, bar.dataset.occStart, bar.dataset.occEnd, bar.dataset.occNotes);
          });
        });

        async function saveOccupancy(e) {
          e.preventDefault();
          const id = document.getElementById('edit-occ-id').value;
          const startDate = document.getElementById('edit-occ-start').value;
          const endDate = document.getElementById('edit-occ-end').value;
          if (endDate && startDate && endDate < startDate) {
            alert('End date must be on or after start date.');
            return;
          }
          const notes = document.getElementById('edit-occ-notes').value;
          await fetch('/api/room-occupancy/' + id, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({
            start_date: startDate,
            end_date: endDate || null,
            notes: notes || null,
          })});
          location.reload();
        }
      </script>`;

    res.send(appLayout('Residency', body, username, 'residency'));
  });

  // ============================================================
  // API ENDPOINTS
  // ============================================================

  // CSRF protection: check Origin/Referer for state-changing requests
  router.use('/api', (req, res, next) => {
    if (req.method === 'GET') return next();
    const origin = req.headers.origin || '';
    const referer = req.headers.referer || '';
    const host = req.headers.host || '';
    if (origin && !origin.includes(host)) {
      return res.status(403).json({ error: 'cross-origin request blocked' });
    }
    if (!origin && referer && !referer.includes(host)) {
      return res.status(403).json({ error: 'cross-origin request blocked' });
    }
    next();
  });

  // --- Users ---
  router.get('/api/users', (req, res) => {
    res.json(db.getAllUsers());
  });

  router.post('/api/users', (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    res.json(db.createUser(name));
  });

  // --- Events ---
  router.get('/api/events', (req, res) => {
    res.json(db.getAllEvents());
  });

  // --- Event Assignments ---
  router.get('/api/events/:id/assignments', (req, res) => {
    res.json(db.getAssignmentsForEvent(req.params.id));
  });

  router.post('/api/assignments', (req, res) => {
    const { event_id, user_id, role, notes } = req.body;
    if (!event_id || !user_id || !role) return res.status(400).json({ error: 'event_id, user_id, role required' });
    if (!VALID_ROLES.has(role)) return res.status(400).json({ error: 'invalid role, must be one of: ' + [...VALID_ROLES].join(', ') });
    res.json(db.createAssignment({ event_id, user_id, role, notes }));
  });

  router.delete('/api/assignments/:id', (req, res) => {
    db.deleteAssignment(req.params.id);
    res.json({ ok: true });
  });

  // --- Tour Slots ---
  router.get('/api/tour-slots', (req, res) => {
    res.json(db.getAllTourSlots());
  });

  router.get('/api/tour-slots/:id', (req, res) => {
    const slot = db.getTourSlotById(req.params.id);
    if (!slot) return res.status(404).json({ error: 'not found' });
    res.json(slot);
  });

  router.post('/api/tour-slots', (req, res) => {
    const { slot_date, slot_time, slot_type, event_id, max_capacity, notes } = req.body;
    if (!slot_date || !slot_time) return res.status(400).json({ error: 'slot_date, slot_time required' });
    // Normalize slot_time to HH:MM:SS
    const normalizedTime = normalizeTime(slot_time);
    res.json(db.createTourSlot({ slot_date, slot_time: normalizedTime, slot_type, event_id, max_capacity, notes }));
  });

  router.post('/api/tour-slots/generate-weekly', (req, res) => {
    res.json(db.generateWeeklySlots());
  });

  router.get('/api/tour-slots/:id/requests', (req, res) => {
    res.json(db.getTourRequestsBySlotId(req.params.id));
  });

  // --- Tour Shifts ---
  router.post('/api/tour-shifts', (req, res) => {
    const { tour_slot_id, user_id, shift_type } = req.body;
    if (!tour_slot_id || !user_id) return res.status(400).json({ error: 'tour_slot_id, user_id required' });
    res.json(db.createTourShift({ tour_slot_id, user_id, shift_type }));
  });

  router.delete('/api/tour-shifts/:id', (req, res) => {
    db.deleteTourShift(req.params.id);
    res.json({ ok: true });
  });

  // --- Tour Requests ---
  router.post('/api/tour-requests', (req, res) => {
    const { tour_slot_id, requester_name, requester_email, requester_phone, preferred_date, group_size, notes } = req.body;
    if (!tour_slot_id || !requester_name) return res.status(400).json({ error: 'tour_slot_id, requester_name required' });
    res.json(db.createTourRequest({ tour_slot_id, requester_name, requester_email, requester_phone, preferred_date, group_size, notes }));
  });

  // --- Rooms ---
  router.get('/api/rooms', (req, res) => {
    res.json(db.getAllRooms());
  });

  router.post('/api/rooms', (req, res) => {
    const { room_number, room_name, capacity, notes } = req.body;
    if (!room_number) return res.status(400).json({ error: 'room_number required' });
    res.json(db.createRoom({ room_number, room_name, capacity, notes }));
  });

  router.delete('/api/rooms/:id', (req, res) => {
    db.deleteRoom(req.params.id);
    res.json({ ok: true });
  });

  // --- Room Occupancy ---
  router.post('/api/room-occupancy', (req, res) => {
    const { room_id, user_id, guest_name, start_date, end_date, is_guest, notes } = req.body;
    if (!room_id || !start_date) return res.status(400).json({ error: 'room_id, start_date required' });
    if (end_date && start_date && end_date < start_date) {
      return res.status(400).json({ error: 'end_date must be on or after start_date' });
    }
    res.json(db.createOccupancy({ room_id, user_id, guest_name, start_date, end_date, is_guest, notes }));
  });

  router.patch('/api/room-occupancy/:id', (req, res) => {
    const { start_date, end_date, notes } = req.body;
    if (end_date && start_date && end_date < start_date) {
      return res.status(400).json({ error: 'end_date must be on or after start_date' });
    }
    res.json(db.updateOccupancy(req.params.id, { start_date, end_date, notes }));
  });

  router.delete('/api/room-occupancy/:id', (req, res) => {
    db.deleteOccupancy(req.params.id);
    res.json({ ok: true });
  });

  return router;
}

// Normalize time string to HH:MM:SS
function normalizeTime(t) {
  if (!t) return '00:00:00';
  const parts = t.split(':');
  while (parts.length < 3) parts.push('00');
  return parts.map(p => p.padStart(2, '0')).join(':');
}

// JSON body parser middleware with size limit
function express_json_middleware(req, res, next) {
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (ct.startsWith('application/json') && !req.body) {
    let data = '';
    let size = 0;
    const MAX_SIZE = 1024 * 1024; // 1MB
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_SIZE) { req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      try { req.body = JSON.parse(data); } catch { req.body = {}; }
      next();
    });
  } else {
    next();
  }
}
