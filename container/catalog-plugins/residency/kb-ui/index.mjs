// Residency dashboard slice (kb-ui plugin module).
//
// Ported from lil_salem control_panel/apps.mjs (residency page + APIs), re-cut
// for the labor.fun kb-ui plugin-route hook (kb-ui/plugin-mount.mjs):
//   - mounted at /residency (page: GET /residency, APIs: /residency/api/*)
//   - EVERYTHING here is coordinator/admin only — the page renders the same
//     resident/guest PII (who lives where, with whom, when) that the /api
//     routes 403 on, so both are gated by the one role check; mutations
//     additionally pass an exact-host same-origin check
//   - schema is owned by src/db.ts (single owner — no DDL here); this module
//     only reads/writes rows over its own better-sqlite3 connection
//   - building geometry comes from <PROFILE_DIR>/buildings.json (per-org data,
//     see ./buildings.mjs); absent file → mapping UI is hidden, the rest works
//   - the 3D map is the R3 module: its buttons render disabled until a `map`
//     plugin ships. R3 assign-mode contract (documented for the map module):
//       /map?building=<mappingBuildingId>&assign=<roomId>&assignName=<name>
//     — clicking a room on the map writes building_id/floor_id/map_room_id
//     back onto residency room <roomId> and redirects to /residency.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Router } from 'express';

import { buildMapPicker, loadBuildings } from './buildings.mjs';
import { renderGantt } from './gantt.mjs';

// ── venue-local civil day ────────────────────────────────────────────────────
// Occupancy windows are calendar dates in the org's timezone, not the server's
// UTC clock (mirrors lil_salem's venue-time semantics, minimally). Timezone
// precedence mirrors src/config.ts resolveConfigTimezone() exactly:
//   process.env.TZ → install .env `TZ` → profile.config.json `timezone`
//   → system zone → UTC.
function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read one key out of the install `.env`, the same way src/env.ts does
 * (`<cwd>/.env`, `#` comments skipped, surrounding quotes stripped, last
 * non-empty assignment wins) — but dependency-free and never throwing.
 *
 * kb-ui's systemd unit does NOT load .env into the process environment, while
 * the orchestrator's src/config.ts DOES read it (setup/timezone.ts writes TZ
 * there). Without this the dashboard's day buckets / today-marker can be a
 * full day off from the orchestrator's residencyToday().
 */
export function readInstallEnvValue(key, cwd = process.cwd()) {
  let content;
  try {
    content = fs.readFileSync(path.join(cwd, '.env'), 'utf-8');
  } catch {
    return undefined; // no .env (containers, dev checkouts) — normal
  }
  let found;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    if (trimmed.slice(0, eqIdx).trim() !== key) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) found = value;
  }
  return found;
}

export function resolveTimezone(profileDir, env = process.env, cwd = process.cwd()) {
  const candidates = [env.TZ, readInstallEnvValue('TZ', cwd)];
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(profileDir, 'profile.config.json'), 'utf-8'),
    );
    candidates.push(cfg.timezone);
  } catch {
    /* no profile config — fall through */
  }
  candidates.push(Intl.DateTimeFormat().resolvedOptions().timeZone);
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}

/** Today's YYYY-MM-DD in `tz` (en-CA yields ISO date order). */
export function localToday(tz, now = new Date()) {
  if (isNaN(now.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

// ── request-body validation ──────────────────────────────────────────────────
// Dates and numbers coming off these endpoints are stored verbatim, compared
// as strings, and echoed back into HTML attributes by the page + Gantt. A lax
// field is therefore both a data-integrity bug AND an injection sink, so they
// are validated at the door: escaping on output is the second layer, not the
// only one.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Strict YYYY-MM-DD that is also a REAL calendar date (rejects 2026-02-31). */
export function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** YYYY-MM with a real month (01–12) — the Gantt window query (?gw). */
const YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export function isYearMonth(value) {
  return typeof value === 'string' && YEAR_MONTH_RE.test(value);
}

/** Coerce a JSON number-ish field to a safe integer, or null when it isn't. */
export function toInteger(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/**
 * Optional free-text field → trimmed string or null. Returns `undefined` for
 * anything that isn't a scalar: better-sqlite3 treats a bound object as a
 * named-parameter bag and fails with "Too few parameter values", which would
 * surface as a 500 instead of the 400 the caller earned.
 */
export function optionalText(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined; // not a scalar → caller 400s
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtShortDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return '';
  return `${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// ── CSRF: exact-host same-origin check ───────────────────────────────────────
// Ported inline from lil_salem's mutation-origin pattern (URL-parsed host, so
// `kb.example.evil.test` does NOT pass a substring check; absent Origin AND
// Referer is allowed — Basic Auth is not replayed cross-origin, so such a
// request cannot be a browser CSRF). The full mutation-origin module (canonical
// KB_PUBLIC_ORIGIN scheme binding) arrives in a later wave.
function sameHostHeader(value, host) {
  if (!value) return null;
  try {
    return new URL(value).host === host;
  } catch {
    return false;
  }
}

export function isCrossOrigin(req) {
  const host = req.headers.host || '';
  const originOk = sameHostHeader(req.headers.origin, host);
  const refererOk = sameHostHeader(req.headers.referer, host);
  return originOk === false || (originOk === null && refererOk === false);
}

// ── DB access ────────────────────────────────────────────────────────────────
// kb-ui process opens its own short-lived connections against the shared
// SQLite file (same idiom as server.mjs's per-request `new Database(...)`),
// plus a busy_timeout so a concurrent orchestrator write never surfaces as
// SQLITE_BUSY to the dashboard.
function withDb(deps, fn) {
  if (!deps.Database) throw new Error('better-sqlite3 unavailable in kb-ui');
  const db = new deps.Database(deps.DB_PATH);
  try {
    db.pragma('busy_timeout = 5000');
    return fn(db);
  } finally {
    db.close();
  }
}

/** The residency tables are created by the orchestrator (src/db.ts). */
function tablesReady(db) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rooms'")
    .get();
  return !!row;
}

function getAllRooms(db) {
  const rooms = db.prepare('SELECT * FROM rooms ORDER BY room_number').all();
  const occStmt = db.prepare(
    `SELECT ro.*, au.name as user_name
     FROM room_occupancy ro
     LEFT JOIN app_users au ON ro.user_id = au.id
     WHERE ro.room_id = ?
     ORDER BY ro.start_date`,
  );
  for (const room of rooms) room.occupancy = occStmt.all(room.id);
  return rooms;
}

function readOccupancy(db, id) {
  return db
    .prepare(
      `SELECT ro.*, au.name as user_name
       FROM room_occupancy ro
       LEFT JOIN app_users au ON ro.user_id = au.id
       WHERE ro.id = ?`,
    )
    .get(id);
}

// ── page styles (residency subset of Salem's APP_STYLES, scoped via layout) ──
const RESIDENCY_STYLES = `
  .app-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; }
  .app-header h2 { font-size: 22px; color: #fff; margin: 0; }
  .app-actions { display: flex; gap: 8px; flex-wrap: wrap; }

  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; border: 1px solid #333; background: #1a1a1a; color: #ddd; transition: all 0.15s; }
  .btn:hover { background: #252525; border-color: #444; text-decoration: none; }
  .btn[disabled] { opacity: 0.45; cursor: not-allowed; }
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
  .card-dashed { border-style: dashed; opacity: 0.75; }

  .grid-4 { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }

  .badge-sm { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 500; }
  .badge-green { background: #1a3a1a; color: #5cb85c; }
  .badge-blue { background: #1a2a3a; color: #4a9eda; }
  .badge-gray { background: #1a1a1a; color: #666; }
  .badge-orange { background: #3a2a1a; color: #e0a050; }

  .empty-state { text-align: center; padding: 48px 24px; color: #555; }
  .empty-state p { margin: 4px 0; }

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
  .form-row select { width: 100%; padding: 8px 12px; background: #0d0d0d; border: 1px solid #333; border-radius: 6px; color: #ddd; font-size: 13px; }
  .form-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }

  .checkbox-group { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
  .checkbox-group input[type=checkbox] { width: 16px; height: 16px; accent-color: #4a9eda; }
  .checkbox-group label { font-size: 13px; color: #aaa; cursor: pointer; margin: 0; }

  .list-item { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: #0f0f0f; border: 1px solid #1a1a1a; border-radius: 6px; margin-bottom: 6px; }
  .list-item .info { flex: 1; }
  .list-item .info .name { font-size: 13px; font-weight: 500; color: #ddd; }
  .list-item .info .detail { font-size: 12px; color: #666; }
  .list-item .actions { display: flex; gap: 4px; }
  .list-item.occ-faded { opacity: 0.6; }
  .list-item.occ-faded .info .name { color: #aaa; }

  .tag-bar { display: flex; gap: 8px; padding: 8px 12px; background: #0f0f0f; border-radius: 6px; margin-bottom: 12px; font-size: 13px; color: #888; }

  @media (max-width: 600px) {
    .grid-4 { grid-template-columns: 1fr; }
    .form-row { grid-template-columns: 1fr; }
  }
`;

/**
 * Home-page nav card (kb-ui plugin-route hook contract). Role-restricted to
 * match the route gate below: everything under /residency is resident/guest
 * PII, so the card must not be advertised to users who would only get a 403.
 */
export function navCards() {
  return [
    {
      href: '/residency',
      title: 'Residency',
      desc: 'Rooms & occupancy',
      icon: '🛏️',
      roles: ['coordinator', 'admin'],
    },
  ];
}

/**
 * Build the /residency express.Router. `deps` is the kb-ui plugin-route hook
 * injection surface: { layout, esc, isAdmin, isCoordinator, isResident,
 * usernameFromReq, Database, DB_PATH, PROFILE_DIR, CONTEXT_DIR, logger }.
 */
export function createRoutes(deps) {
  const { layout, esc, usernameFromReq } = deps;
  const logger = deps.logger || console;
  const router = Router();

  // kb-ui's esc() short-circuits on falsy input (`esc(0) === ''`), so numeric
  // attribute values are stringified first — escaped, but 0 still renders "0".
  const escAttr = (v) => esc(v === null || v === undefined ? '' : String(v));

  const timezone = resolveTimezone(deps.PROFILE_DIR);
  const isCoord = (u) =>
    !!(deps.isCoordinator && deps.isCoordinator(u)) ||
    !!(deps.isAdmin && deps.isAdmin(u));

  // Building geometry: per-org data, reloaded per page view so a tenant can
  // drop in / fix buildings.json without a dashboard restart (it's one small
  // file; the DB is the hot path, not this).
  function mapData() {
    return buildMapPicker(loadBuildings(deps.PROFILE_DIR, logger));
  }

  // The 3D map is the R3 module. Until a `map` plugin ships a kb-ui slice,
  // the map buttons render disabled (assign-mode contract in header comment).
  function hasMapModule() {
    return (
      fs.existsSync(path.join(deps.PROFILE_DIR, 'plugins', 'map', 'kb-ui', 'index.mjs')) ||
      fs.existsSync(new URL('../../map/kb-ui/index.mjs', import.meta.url))
    );
  }

  // ── PII gate for every PAGE route ──────────────────────────────────────────
  // The occupancy grid and the Gantt name every resident and guest, i.e. the
  // exact data the /api gate below 403s on. Gating only the API would leak it
  // to any authenticated kb-ui user (a resident-role account included), so the
  // page routes mirror that role check. /api keeps its own gate so the two
  // can never drift into a hole (and so it answers in JSON).
  router.use((req, res, next) => {
    if (req.path === '/api' || req.path.startsWith('/api/')) return next();
    const username = usernameFromReq(req);
    if (isCoord(username)) return next();
    return res
      .status(403)
      .send(
        layout(
          'Residency',
          `<style>${RESIDENCY_STYLES}</style><div class="empty-state"><p style="font-size:16px;font-weight:500">Not authorized</p><p>Residency data is restricted to coordinators and admins.</p></div>`,
          username,
        ),
      );
  });

  // ── page ───────────────────────────────────────────────────────────────────
  router.get('/', (req, res) => {
    const username = usernameFromReq(req);
    // Belt to the gate's suspenders: edit affordances are derived STRICTLY
    // from mutation eligibility, so if the page gate above is ever relaxed the
    // markup degrades to view-only instead of offering writes that would 403.
    const readOnly = !isCoord(username);

    let rooms;
    let ready = true;
    try {
      withDb(deps, (db) => {
        ready = tablesReady(db);
        if (!ready) return;
        rooms = getAllRooms(db);
      });
    } catch (err) {
      logger.error(`[residency] page query failed: ${err.message}`);
      ready = false;
    }
    if (!ready) {
      return res.send(
        layout(
          'Residency',
          `<style>${RESIDENCY_STYLES}</style><div class="empty-state"><p style="font-size:16px;font-weight:500">Residency data not initialized</p><p>The orchestrator creates the residency tables on startup — redeploy/restart it, then reload.</p></div>`,
          username,
        ),
      );
    }
    const { lookup: mapRoomLookup, picker: mapPicker } = mapData();
    const hasBuildings = mapPicker.length > 0 || Object.keys(mapRoomLookup).length > 0;
    const mapEnabled = hasMapModule();
    const mappingBuildingId = mapPicker.length > 0 ? mapPicker[0].id : '';

    function mapLocationLabel(room) {
      if (!room || !room.building_id || !room.floor_id || !room.map_room_id) return null;
      const hit = mapRoomLookup[`${room.building_id}/${room.floor_id}/${room.map_room_id}`];
      if (!hit) return null;
      return `${hit.buildingName} · ${hit.floorName} · ${hit.roomName}`;
    }

    const today = localToday(timezone);

    function getCurrentOccupants(room) {
      return (room.occupancy || []).filter(
        (o) => o.start_date <= today && (!o.end_date || o.end_date >= today),
      );
    }

    // Classify a stay relative to today.
    function occStatus(o) {
      if (o.start_date > today) return 'upcoming';
      if (o.end_date && o.end_date < today) return 'past';
      return 'current';
    }
    const STATUS_BADGE = {
      current: '<span class="badge-sm badge-green">Now</span>',
      upcoming: '<span class="badge-sm badge-blue">Upcoming</span>',
      past: '<span class="badge-sm badge-gray">Past</span>',
    };
    const STATUS_ORDER = { current: 0, upcoming: 1, past: 2 };

    const occupiedCount = rooms.filter((r) => getCurrentOccupants(r).length > 0).length;
    const emptyCount = rooms.length - occupiedCount;

    function renderRoomCard(room) {
      const current = getCurrentOccupants(room);
      const isEmpty = current.length === 0;
      const currentCount = current.length;
      const roomLabel = room.room_name || 'Room ' + room.room_number;
      const loc = mapLocationLabel(room);

      // Show ALL stays (current, upcoming, past) so any can be edited or
      // removed, not just the ones overlapping today.
      const allStays = (room.occupancy || []).slice().sort((a, b) => {
        const sa = occStatus(a),
          sb = occStatus(b);
        if (sa !== sb) return STATUS_ORDER[sa] - STATUS_ORDER[sb];
        return a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : 0;
      });

      let occupantsHtml = '';
      if (allStays.length > 0) {
        occupantsHtml = allStays
          .map((o) => {
            const st = occStatus(o);
            return `
          <div class="list-item ${st !== 'current' ? 'occ-faded' : ''}" data-occ-id="${escAttr(o.id)}">
            <div class="info">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                <span class="name">${esc(o.is_guest ? o.guest_name : o.user_name)}</span>
                ${o.is_guest ? '<span class="badge-sm badge-orange">Guest</span>' : ''}
                ${STATUS_BADGE[st]}
              </div>
              <span class="detail">${fmtShortDate(o.start_date)}${o.end_date ? ' - ' + fmtShortDate(o.end_date) : ' - ongoing'}</span>
            </div>
            ${
              readOnly
                ? ''
                : `<div class="actions">
              <button class="btn btn-ghost btn-sm edit-occ-btn" data-occ-id="${esc(o.id)}" data-occ-name="${esc(o.is_guest ? o.guest_name : o.user_name)}" data-occ-guest="${o.is_guest ? 1 : 0}" data-occ-start="${esc(o.start_date)}" data-occ-end="${esc(o.end_date || '')}" data-occ-notes="${esc(o.notes || '')}">Edit</button>
              <button class="btn btn-ghost btn-sm remove-occ-btn" data-room-id="${esc(room.id)}" data-occ-id="${esc(o.id)}">Remove</button>
            </div>`
            }
          </div>`;
          })
          .join('');
      } else {
        occupantsHtml = '<p style="font-size:13px;color:#555">No stays scheduled</p>';
      }

      // Location line — only meaningful when the org ships buildings.json.
      const locHtml = !hasBuildings
        ? ''
        : loc
          ? `<p class="room-loc" title="${esc(loc)}" style="font-size:12px;color:#5a7a9a;margin:3px 0 0;cursor:help">📍 ${esc(loc)}</p>`
          : `<p style="font-size:12px;color:#555;margin:3px 0 0">📍 <span style="opacity:.7">Not mapped</span></p>`;

      return `
        <div class="card ${isEmpty ? 'card-dashed' : ''}" style="${!isEmpty ? 'border-color:#1a3a1a50' : ''}" data-room-id="${escAttr(room.id)}">
          <div class="card-header">
            <div style="display:flex;justify-content:space-between;align-items:start">
              <div>
                <p class="card-title">${esc(roomLabel)}</p>
                <p style="font-size:12px;color:#666;margin:2px 0 0">${escAttr(currentCount)}/${escAttr(room.capacity)} occupied now</p>
                ${locHtml}
              </div>
              <span class="badge-sm ${isEmpty ? 'badge-gray' : 'badge-green'}">${isEmpty ? 'Empty' : 'Occupied'}</span>
            </div>
          </div>
          <div class="card-content">
            <div class="card-occupants">${occupantsHtml}</div>
            ${
              readOnly
                ? ''
                : `<button class="btn btn-sm occ-btn" style="width:100%;margin-top:8px" data-room-id="${escAttr(room.id)}" data-room-name="${esc(roomLabel)}">+ Add Stay</button>
            <div style="margin-top:6px;display:flex;justify-content:space-between;gap:6px">
              <button class="btn btn-sm edit-room-btn"
                data-room-id="${esc(room.id)}"
                data-room-number="${escAttr(room.room_number)}"
                data-room-name="${esc(room.room_name || '')}"
                data-capacity="${escAttr(room.capacity)}"
                data-notes="${esc(room.notes || '')}"
                data-building="${esc(room.building_id || '')}"
                data-floor="${esc(room.floor_id || '')}"
                data-maproom="${esc(room.map_room_id || '')}">Edit${hasBuildings ? ' / Map' : ''}</button>
              <button class="btn btn-sm btn-danger delete-room-btn" data-room-id="${escAttr(room.id)}" data-occupant-count="${escAttr(currentCount)}">Delete</button>
            </div>`
            }
          </div>
        </div>`;
    }

    // Header. The 3D map arrives with the R3 map module; until then the button
    // is disabled (see the assign-mode contract in the file header comment).
    const mapBtn = mapEnabled
      ? `<a class="btn" href="/map?building=${esc(mappingBuildingId)}">🏗️ 3D Map</a>`
      : `<button class="btn" disabled title="3D map arrives with the map module">🏗️ 3D Map</button>`;
    let body = `
      <div class="app-header">
        <h2>Residency${readOnly ? ' <span class="badge-sm badge-gray" style="vertical-align:middle;margin-left:8px">View only</span>' : ''}</h2>
        <div class="app-actions">
          ${mapBtn}
          ${readOnly ? '' : `<button class="btn btn-primary" onclick="openModal('add-room-modal')">+ Add Room</button>`}
        </div>
      </div>`;

    if (rooms.length > 0) {
      body += `
        <div class="tag-bar" style="margin-bottom:24px">
          <div style="display:flex;align-items:center;gap:6px"><div style="width:10px;height:10px;border-radius:50%;background:#5cb85c"></div><span>Occupied (${occupiedCount})</span></div>
          <div style="display:flex;align-items:center;gap:6px"><div style="width:10px;height:10px;border-radius:50%;background:#333"></div><span>Empty (${emptyCount})</span></div>
        </div>`;

      // --- Gantt (3-month window; navigable via ?gw=YYYY-MM) ---
      // The month must be 01–12: `\d{2}` also matched 00 and 13–99, which the
      // renderer turned into an Invalid Date and a RangeError 500. Anything
      // that isn't a real month falls back to the default (today's) window.
      const gwRaw = typeof req.query.gw === 'string' ? req.query.gw : '';
      const gwStart = isYearMonth(gwRaw) ? gwRaw + '-01' : null;
      body += renderGantt(rooms, today, gwStart, { esc, mapLocationLabel });

      body += `<div class="grid-4">${rooms.map(renderRoomCard).join('')}</div>`;
    } else {
      body +=
        '<div class="empty-state"><p style="font-size:16px;font-weight:500">No rooms yet</p><p>Add rooms to start tracking residency.</p></div>';
    }

    // Mapping picker markup, only when the org ships buildings.json.
    const pickerBlock = (prefix) =>
      !hasBuildings
        ? ''
        : `<div class="form-group" style="border-top:1px solid #222;padding-top:12px">
              <label>Building floor-map location <span style="color:#555;font-weight:400">(optional)</span></label>
              <div class="form-row">
                <select id="${prefix}-building" onchange="onPickerChange('${prefix}')"><option value="">— Building —</option></select>
                <select id="${prefix}-floor" onchange="onPickerChange('${prefix}')" disabled><option value="">— Floor —</option></select>
              </div>
              <select id="${prefix}-maproom" style="margin-top:8px" disabled><option value="">— Room on map —</option></select>
              ${
                prefix === 'edit'
                  ? mapEnabled
                    ? `<button type="button" class="btn btn-sm" style="margin-top:8px" onclick="pickOnMap()">📍 Pick on 3D map</button>
              <p style="font-size:11px;color:#555;margin:6px 0 0">Opens the 3D map — click a room there to set this location. Save other changes first.</p>`
                    : `<button type="button" class="btn btn-sm" style="margin-top:8px" disabled title="3D map arrives with the map module">📍 Pick on 3D map</button>`
                  : ''
              }
            </div>`;

    // Edit modals — all edit affordances, so the whole block is skipped for
    // read-only viewers (server-side /api gating is the real control; this
    // keeps dead edit markup out of the view-only DOM).
    if (!readOnly) {
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
            ${pickerBlock('add')}
            <div class="form-actions">
              <button type="button" class="btn" onclick="closeModal('add-room-modal')">Cancel</button>
              <button type="submit" class="btn btn-primary">Add Room</button>
            </div>
          </form>
        </div>
      </div>

      <div class="modal-overlay" id="edit-room-modal">
        <div class="modal">
          <h3>Edit Room</h3>
          <p class="modal-desc">Update room details${hasBuildings ? ' and map it to a physical room on the building floor map' : ''}.</p>
          <form onsubmit="saveRoom(event)">
            <input type="hidden" id="edit-room-id">
            <div class="form-row">
              <div class="form-group"><label>Room Number</label><input id="edit-room-number" type="number" required min="1"></div>
              <div class="form-group"><label>Room Name</label><input id="edit-room-name" placeholder="Optional name..."></div>
            </div>
            <div class="form-group"><label>Capacity</label><input id="edit-room-capacity" type="number" min="1"></div>
            <div class="form-group"><label>Notes</label><input id="edit-room-notes" placeholder="Optional notes..."></div>
            ${pickerBlock('edit')}
            <div class="form-actions">
              <button type="button" class="btn" onclick="closeModal('edit-room-modal')">Cancel</button>
              <button type="submit" class="btn btn-primary">Save</button>
            </div>
          </form>
        </div>
      </div>

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
            <p id="occ-flash" style="font-size:12px;color:#5cb85c;margin:0 0 10px;min-height:14px"></p>
            <div class="form-actions">
              <button type="button" class="btn" onclick="closeModal('occupancy-modal')">Cancel</button>
              <button type="submit" class="btn">Save &amp; add another</button>
              <button type="button" class="btn btn-primary" onclick="addOccupancy(event, true)">Save &amp; close</button>
            </div>
          </form>
        </div>
      </div>

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
            <div class="form-actions" style="justify-content:space-between">
              <button type="button" class="btn btn-danger" onclick="removeOccupancyById(document.getElementById('edit-occ-id').value)">Remove stay</button>
              <div style="display:flex;gap:8px">
                <button type="button" class="btn" onclick="closeModal('edit-occ-modal')">Cancel</button>
                <button type="submit" class="btn btn-primary">Save</button>
              </div>
            </div>
          </form>
        </div>
      </div>`;
    }

    // Script (APIs live under /residency/api/*).
    body += `
      <script>
        const READ_ONLY = ${readOnly ? 'true' : 'false'};
        const API = '/residency/api';
        let currentRoomId = null;

        // Building floor-map data for the room → physical-room mapping selects.
        const HAS_MAP_PICKER = ${hasBuildings ? 'true' : 'false'};
        const MAP_PICKER = ${JSON.stringify(mapPicker).replace(/</g, '\\u003c')};

        function getBuilding(id) { return MAP_PICKER.find(b => b.id === id); }

        function fillSelect(sel, items, placeholder, selectedId) {
          sel.innerHTML = '';
          const ph = document.createElement('option');
          ph.value = ''; ph.textContent = placeholder;
          sel.appendChild(ph);
          for (const it of items) {
            const o = document.createElement('option');
            o.value = it.id;
            o.textContent = it.name + (it.subtitle ? ' · ' + it.subtitle : '');
            if (it.id === selectedId) o.selected = true;
            sel.appendChild(o);
          }
          sel.disabled = items.length === 0;
        }

        // Set the full building/floor/room picker for a prefix ('add' | 'edit').
        function setPicker(prefix, buildingId, floorId, maproomId) {
          if (!HAS_MAP_PICKER) return;
          const bSel = document.getElementById(prefix + '-building');
          if (!bSel) return;
          const fSel = document.getElementById(prefix + '-floor');
          const rSel = document.getElementById(prefix + '-maproom');
          fillSelect(bSel, MAP_PICKER, '— Building —', buildingId || '');
          bSel.disabled = MAP_PICKER.length === 0;
          const b = getBuilding(buildingId);
          fillSelect(fSel, b ? b.floors : [], '— Floor —', floorId || '');
          const f = b && b.floors.find(x => x.id === floorId);
          fillSelect(rSel, f ? f.rooms : [], '— Room on map —', maproomId || '');
        }

        // Re-cascade after a building or floor change, preserving still-valid choices.
        function onPickerChange(prefix) {
          const bId = document.getElementById(prefix + '-building').value;
          const fSel = document.getElementById(prefix + '-floor');
          const rSel = document.getElementById(prefix + '-maproom');
          const prevFloor = fSel.value, prevRoom = rSel.value;
          const b = getBuilding(bId);
          const floors = b ? b.floors : [];
          fillSelect(fSel, floors, '— Floor —', floors.some(x => x.id === prevFloor) ? prevFloor : '');
          const f = b && b.floors.find(x => x.id === fSel.value);
          const rooms = f ? f.rooms : [];
          fillSelect(rSel, rooms, '— Room on map —', rooms.some(x => x.id === prevRoom) ? prevRoom : '');
        }

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

        // find-or-create a resident against the shared app_users roster.
        async function findOrCreateUser(name) {
          const res = await fetch(API + '/users');
          const users = await res.json();
          const existing = users.find(u => u.name.toLowerCase() === name.toLowerCase());
          if (existing) return existing.id;
          const created = await fetch(API + '/users', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name }) });
          const user = await created.json();
          return user.id;
        }

        function toggleGuestMode() {
          const isGuest = document.getElementById('is-guest-check').checked;
          document.getElementById('resident-name-area').style.display = isGuest ? 'none' : 'block';
          document.getElementById('guest-name-area').style.display = isGuest ? 'block' : 'none';
        }

        // Build the building/floor/room selects once on load.
        if (!READ_ONLY) { setPicker('add', '', '', ''); setPicker('edit', '', '', ''); }

        // The room being edited, including any mapping the picker can't display
        // (e.g. a legacy mapping to a building no longer offered).
        let editOrigMapping = { building_id: '', floor_id: '', map_room_id: '' };

        // The floor-map mapping is only meaningful when building + floor + room
        // are all chosen. Persist it all-or-nothing so we never store a partial
        // mapping that resolves to "Not mapped". With no buildings.json the
        // selects don't exist — return {} so PATCH leaves any stored mapping alone.
        function mappingFields(prefix) {
          if (!HAS_MAP_PICKER) return {};
          const b = document.getElementById(prefix + '-building').value;
          const f = document.getElementById(prefix + '-floor').value;
          const r = document.getElementById(prefix + '-maproom').value;
          if (b && f && r) return { building_id: b, floor_id: f, map_room_id: r };
          // Selects are empty/incomplete. On edit, if the room's existing mapping
          // points at a building the picker can't show, the selects simply
          // couldn't display it — preserve it rather than wiping it when the
          // user only changed name/capacity/notes.
          if (prefix === 'edit') {
            const orig = editOrigMapping;
            const origShowable = !orig.building_id || MAP_PICKER.some(x => x.id === orig.building_id);
            if (!origShowable) {
              return {
                building_id: orig.building_id || null,
                floor_id: orig.floor_id || null,
                map_room_id: orig.map_room_id || null,
              };
            }
          }
          return { building_id: null, floor_id: null, map_room_id: null };
        }

        async function addRoom(e) {
          e.preventDefault();
          const fd = new FormData(e.target);
          await fetch(API + '/rooms', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({
            room_number: parseInt(fd.get('room_number')),
            room_name: fd.get('room_name'),
            capacity: parseInt(fd.get('capacity')) || 1,
            notes: fd.get('notes'),
            ...mappingFields('add'),
          })});
          location.reload();
        }

        // Edit room (rename, capacity, notes, floor-map mapping)
        document.querySelectorAll('.edit-room-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            document.getElementById('edit-room-id').value = btn.dataset.roomId;
            document.getElementById('edit-room-number').value = btn.dataset.roomNumber;
            document.getElementById('edit-room-name').value = btn.dataset.roomName || '';
            document.getElementById('edit-room-capacity').value = btn.dataset.capacity;
            document.getElementById('edit-room-notes').value = btn.dataset.notes || '';
            editOrigMapping = {
              building_id: btn.dataset.building || '',
              floor_id: btn.dataset.floor || '',
              map_room_id: btn.dataset.maproom || '',
            };
            setPicker('edit', btn.dataset.building, btn.dataset.floor, btn.dataset.maproom);
            openModal('edit-room-modal');
          });
        });

        // R3 assign-mode contract: jump to the 3D map in "assign" mode for the
        // room being edited; clicking a room there writes the location back and
        // returns here. Query contract: ?assign=<roomId>&assignName=<label>.
        // Inert until the map module (R3) ships — the button is disabled then.
        function pickOnMap() {
          const id = document.getElementById('edit-room-id').value;
          if (!id) return;
          const name = document.getElementById('edit-room-name').value
            || ('Room ' + document.getElementById('edit-room-number').value);
          window.location.href = '/map?building=${esc(mappingBuildingId)}&assign=' + encodeURIComponent(id)
            + '&assignName=' + encodeURIComponent(name);
        }

        async function saveRoom(e) {
          e.preventDefault();
          const id = document.getElementById('edit-room-id').value;
          await fetch(API + '/rooms/' + id, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({
            room_number: parseInt(document.getElementById('edit-room-number').value),
            room_name: document.getElementById('edit-room-name').value,
            capacity: parseInt(document.getElementById('edit-room-capacity').value) || 1,
            notes: document.getElementById('edit-room-notes').value,
            ...mappingFields('edit'),
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
            await fetch(API + '/rooms/' + roomId, { method: 'DELETE' });
            location.reload();
          });
        });

        document.querySelectorAll('.occ-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            currentRoomId = btn.dataset.roomId;
            document.getElementById('occupancy-modal-title').textContent = 'Add stay to ' + btn.dataset.roomName;
            const form = document.querySelector('#occupancy-modal form');
            form.reset();
            const sd = form.querySelector('[name=start_date]');
            if (sd) sd.value = '${today}';
            document.getElementById('is-guest-check').checked = false;
            toggleGuestMode();
            const flash = document.getElementById('occ-flash');
            if (flash) flash.textContent = '';
            openModal('occupancy-modal');
          });
        });

        // close = true → save and close (reload). Otherwise save and keep the
        // modal open so several stays can be added back-to-back.
        async function addOccupancy(e, close) {
          if (e && e.preventDefault) e.preventDefault();
          const form = document.querySelector('#occupancy-modal form');
          const fd = new FormData(form);
          const isGuest = document.getElementById('is-guest-check').checked;
          const startDate = fd.get('start_date');
          const endDate = fd.get('end_date');
          if (!startDate) { alert('Start date is required.'); return; }
          if (endDate && startDate && endDate < startDate) {
            alert('End date must be on or after start date.');
            return;
          }
          let userId = null;
          let displayName = '';
          if (!isGuest) {
            const name = (fd.get('resident_name') || '').trim();
            if (!name) { alert('Enter a name.'); return; }
            displayName = name;
            userId = await findOrCreateUser(name);
          } else {
            displayName = (fd.get('guest_name') || '').trim();
            if (!displayName) { alert('Enter a guest name.'); return; }
          }
          await fetch(API + '/room-occupancy', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({
            room_id: currentRoomId,
            user_id: userId,
            guest_name: isGuest ? fd.get('guest_name') : null,
            start_date: startDate,
            end_date: endDate || null,
            is_guest: isGuest,
            notes: fd.get('notes'),
          })});
          if (close) { location.reload(); return; }
          // Keep modal open for the next stay; clear name/notes/end, keep dates handy.
          ['resident_name', 'guest_name', 'notes', 'end_date'].forEach(n => {
            const el = form.querySelector('[name=' + n + ']');
            if (el) el.value = '';
          });
          const flash = document.getElementById('occ-flash');
          if (flash) flash.textContent = 'Added ' + displayName + '. Add another, or close when done.';
          const focusEl = isGuest ? form.querySelector('[name=guest_name]') : form.querySelector('[name=resident_name]');
          if (focusEl) focusEl.focus();
        }

        // Remove occupancy from a card: update in place instead of reloading
        document.addEventListener('click', function(e) {
          const btn = e.target.closest('.remove-occ-btn');
          if (!btn) return;
          if (!confirm('Remove this stay?')) return;
          const occId = btn.dataset.occId;
          fetch(API + '/room-occupancy/' + occId, { method: 'DELETE' }).then(function() {
            const listItem = btn.closest('.list-item');
            if (listItem) listItem.remove();
          });
        });

        // Remove a stay from the edit modal (also covers gantt-only stays).
        async function removeOccupancyById(id) {
          if (!id) return;
          if (!confirm('Remove this stay?')) return;
          await fetch(API + '/room-occupancy/' + id, { method: 'DELETE' });
          location.reload();
        }

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

        // Gantt bar clicks — open the edit modal, unless the viewer is read-only.
        if (!READ_ONLY) {
          document.querySelectorAll('.gantt-bar').forEach(function(bar) {
            bar.addEventListener('click', function() {
              openEditOccModal(bar.dataset.occId, bar.dataset.occName, bar.dataset.occStart, bar.dataset.occEnd, bar.dataset.occNotes);
            });
          });
        } else {
          document.querySelectorAll('.gantt-bar').forEach(function(bar) {
            bar.style.cursor = 'default';
          });
        }

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
          await fetch(API + '/room-occupancy/' + id, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({
            start_date: startDate,
            end_date: endDate || null,
            notes: notes || null,
          })});
          location.reload();
        }
      </script>`;

    res.send(layout('Residency', `<style>${RESIDENCY_STYLES}</style>${body}`, username));
  });

  // ── API endpoints ────────────────────────────────────────────────────────
  // Whole API is coordinator/admin (GETs expose resident PII — who lives
  // where; writes are destructive). Mutations additionally pass the
  // exact-host same-origin check (Salem H1 + L1).
  router.use('/api', (req, res, next) => {
    const user = usernameFromReq(req);
    if (!isCoord(user)) {
      return res.status(403).json({ error: 'coordinator or admin role required' });
    }
    if (req.method !== 'GET' && isCrossOrigin(req)) {
      return res.status(403).json({ error: 'cross-origin request blocked' });
    }
    next();
  });

  // Residency tables are created by the orchestrator (single schema owner).
  router.use('/api', (req, res, next) => {
    let ready = false;
    try {
      ready = withDb(deps, (db) => tablesReady(db));
    } catch {
      ready = false;
    }
    if (!ready) {
      return res.status(503).json({ error: 'residency tables not initialized' });
    }
    next();
  });

  // --- Users (find-or-create residents against the shared app_users table) ---
  router.get('/api/users', (req, res) => {
    res.json(withDb(deps, (db) => db.prepare('SELECT * FROM app_users ORDER BY name').all()));
  });

  router.post('/api/users', (req, res) => {
    const { name } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name required' });
    }
    const user = withDb(deps, (db) => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare('INSERT INTO app_users (id, name, created_at) VALUES (?, ?, ?)').run(
        id,
        name.trim(),
        now,
      );
      return { id, name: name.trim(), created_at: now };
    });
    res.json(user);
  });

  // --- Rooms ---
  router.get('/api/rooms', (req, res) => {
    res.json(withDb(deps, (db) => getAllRooms(db)));
  });

  /**
   * Shared room-body validation for POST/PATCH. Returns either
   * `{ error }` (→ 400) or `{ values: { … } }` holding only the keys the
   * caller supplied, already coerced to bind-safe scalars.
   */
  function validateRoomBody(body, { requireNumber }) {
    const out = {};
    const { room_number, room_name, capacity, notes, building_id, floor_id, map_room_id } =
      body;

    if (requireNumber && !room_number) return { error: 'room_number required' };
    if (room_number !== undefined) {
      const n = toInteger(room_number);
      if (n === null) return { error: 'room_number must be an integer' };
      out.room_number = n;
    }
    if (capacity !== undefined) {
      // Legacy leniency: an empty capacity means "default 1", not an error.
      if (capacity === null || capacity === '' || capacity === 0) {
        out.capacity = 1;
      } else {
        const c = toInteger(capacity);
        if (c === null) return { error: 'capacity must be an integer' };
        out.capacity = c;
      }
    }
    for (const [key, raw] of Object.entries({
      room_name,
      notes,
      building_id,
      floor_id,
      map_room_id,
    })) {
      if (raw === undefined) continue;
      const text = optionalText(raw);
      if (text === undefined) return { error: `${key} must be a string` };
      out[key] = text;
    }
    return { values: out };
  }

  /** UNIQUE(room_number) is a caller error (400), not a server fault (500). */
  function roomWriteError(err) {
    if (/UNIQUE/.test(String(err && err.message))) {
      return { status: 400, error: 'room_number already exists' };
    }
    return null;
  }

  router.post('/api/rooms', (req, res) => {
    const parsed = validateRoomBody(req.body || {}, { requireNumber: true });
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const v = parsed.values;
    try {
      const room = withDb(deps, (db) => {
        const id = crypto.randomUUID();
        db.prepare(
          `INSERT INTO rooms (id, room_number, room_name, capacity, notes, building_id, floor_id, map_room_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          v.room_number,
          v.room_name ?? null,
          v.capacity ?? 1,
          v.notes ?? null,
          v.building_id ?? null,
          v.floor_id ?? null,
          v.map_room_id ?? null,
          new Date().toISOString(),
        );
        return db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
      });
      res.json(room);
    } catch (err) {
      const mapped = roomWriteError(err);
      if (mapped) return res.status(mapped.status).json({ error: mapped.error });
      throw err;
    }
  });

  router.patch('/api/rooms/:id', (req, res) => {
    // Same validation + error mapping as POST — a duplicate room_number on
    // PATCH used to escape as an unhandled UNIQUE constraint (500).
    const parsed = validateRoomBody(req.body || {}, { requireNumber: false });
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const entries = Object.entries(parsed.values);
    let room;
    try {
      room = withDb(deps, (db) => {
        if (entries.length > 0) {
          const fields = entries.map(([k]) => `${k} = ?`);
          const values = entries.map(([, val]) => val);
          values.push(req.params.id);
          db.prepare(`UPDATE rooms SET ${fields.join(', ')} WHERE id = ?`).run(...values);
        }
        return db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
      });
    } catch (err) {
      const mapped = roomWriteError(err);
      if (mapped) return res.status(mapped.status).json({ error: mapped.error });
      throw err;
    }
    if (!room) return res.status(404).json({ error: 'not found' });
    res.json(room);
  });

  router.delete('/api/rooms/:id', (req, res) => {
    withDb(deps, (db) => {
      db.prepare('DELETE FROM room_occupancy WHERE room_id = ?').run(req.params.id);
      db.prepare('DELETE FROM rooms WHERE id = ?').run(req.params.id);
    });
    res.json({ ok: true });
  });

  // --- Room Occupancy ---
  router.post('/api/room-occupancy', (req, res) => {
    const { room_id, user_id, guest_name, start_date, end_date, is_guest, notes } =
      req.body || {};
    if (!room_id || !start_date) {
      return res.status(400).json({ error: 'room_id, start_date required' });
    }
    // Dates are stored verbatim and rendered into HTML attributes — they must
    // be real YYYY-MM-DD calendar dates, not "any truthy string".
    if (!isIsoDate(start_date)) {
      return res.status(400).json({ error: 'start_date must be a YYYY-MM-DD date' });
    }
    if (end_date !== undefined && end_date !== null && end_date !== '' && !isIsoDate(end_date)) {
      return res.status(400).json({ error: 'end_date must be a YYYY-MM-DD date' });
    }
    if (end_date && end_date < start_date) {
      return res.status(400).json({ error: 'end_date must be on or after start_date' });
    }
    const roomIdText = optionalText(room_id);
    const userIdText = optionalText(user_id);
    const guestText = optionalText(guest_name);
    const notesText = optionalText(notes);
    if (
      roomIdText === undefined ||
      userIdText === undefined ||
      guestText === undefined ||
      notesText === undefined
    ) {
      return res.status(400).json({ error: 'room_id, user_id, guest_name, notes must be strings' });
    }

    const result = withDb(deps, (db) => {
      // Resolve the FKs up front: an unknown room_id/user_id is a caller
      // error, not a 500 out of SQLite's foreign-key enforcement.
      const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(roomIdText);
      if (!room) return { status: 404, error: 'room not found' };
      if (userIdText !== null) {
        const user = db.prepare('SELECT id FROM app_users WHERE id = ?').get(userIdText);
        if (!user) return { status: 400, error: 'unknown user_id' };
      }
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO room_occupancy (id, room_id, user_id, guest_name, start_date, end_date, is_guest, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        roomIdText,
        userIdText,
        guestText,
        start_date,
        end_date || null,
        is_guest ? 1 : 0,
        notesText,
        new Date().toISOString(),
      );
      return { occ: readOccupancy(db, id) };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.occ);
  });

  router.patch('/api/room-occupancy/:id', (req, res) => {
    const { start_date, end_date, notes } = req.body || {};
    if (start_date !== undefined && !isIsoDate(start_date)) {
      return res.status(400).json({ error: 'start_date must be a YYYY-MM-DD date' });
    }
    if (end_date !== undefined && end_date !== null && end_date !== '' && !isIsoDate(end_date)) {
      return res.status(400).json({ error: 'end_date must be a YYYY-MM-DD date' });
    }
    const notesText = notes === undefined ? undefined : optionalText(notes);
    if (notesText === undefined && notes !== undefined) {
      return res.status(400).json({ error: 'notes must be a string' });
    }

    const result = withDb(deps, (db) => {
      const existing = readOccupancy(db, req.params.id);
      if (!existing) return { status: 404, error: 'not found' };
      // Range check against the EFFECTIVE stay, not just this request body:
      // PATCH {end_date} alone must still be compared to the STORED
      // start_date, or an inverted range slips in one field at a time.
      const effStart = start_date !== undefined ? start_date : existing.start_date;
      const effEnd = end_date !== undefined ? end_date || null : existing.end_date;
      if (effEnd && effStart && effEnd < effStart) {
        return { status: 400, error: 'end_date must be on or after start_date' };
      }
      const fields = [];
      const values = [];
      if (start_date !== undefined) { fields.push('start_date = ?'); values.push(start_date); }
      if (end_date !== undefined) { fields.push('end_date = ?'); values.push(end_date || null); }
      if (notes !== undefined) { fields.push('notes = ?'); values.push(notesText); }
      if (fields.length > 0) {
        values.push(req.params.id);
        db.prepare(`UPDATE room_occupancy SET ${fields.join(', ')} WHERE id = ?`).run(...values);
      }
      return { occ: readOccupancy(db, req.params.id) };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.occ);
  });

  router.delete('/api/room-occupancy/:id', (req, res) => {
    withDb(deps, (db) => {
      db.prepare('DELETE FROM room_occupancy WHERE id = ?').run(req.params.id);
    });
    res.json({ ok: true });
  });

  return router;
}
