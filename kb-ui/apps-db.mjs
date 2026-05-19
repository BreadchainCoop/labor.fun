/**
 * Database schema and operations for Events, Tours, and Residency apps.
 * Uses the same SQLite database as the main Breadbrich Engels orchestrator.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const DB_PATH = process.env.APPS_DB_PATH || process.env.DB_PATH || '/opt/breadbrich/store/messages.db';

let _db = null;

function getDb() {
  if (!_db) {
    const Database = require('better-sqlite3');
    _db = new Database(DB_PATH);
    createAppsSchema(_db);
  }
  return _db;
}

function createAppsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      google_calendar_id TEXT UNIQUE,
      title TEXT NOT NULL,
      description TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      location TEXT,
      tours_eligible INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS event_assignments (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (event_id) REFERENCES events(id),
      FOREIGN KEY (user_id) REFERENCES app_users(id)
    );

    CREATE TABLE IF NOT EXISTS tour_slots (
      id TEXT PRIMARY KEY,
      event_id TEXT,
      slot_date TEXT NOT NULL,
      slot_time TEXT NOT NULL,
      slot_type TEXT NOT NULL DEFAULT 'regular',
      max_capacity INTEGER NOT NULL DEFAULT 10,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (event_id) REFERENCES events(id)
    );

    CREATE TABLE IF NOT EXISTS tour_shifts (
      id TEXT PRIMARY KEY,
      tour_slot_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      shift_type TEXT NOT NULL DEFAULT 'lead',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (tour_slot_id) REFERENCES tour_slots(id),
      FOREIGN KEY (user_id) REFERENCES app_users(id)
    );

    CREATE TABLE IF NOT EXISTS tour_requests (
      id TEXT PRIMARY KEY,
      tour_slot_id TEXT NOT NULL,
      requester_name TEXT NOT NULL,
      requester_email TEXT,
      requester_phone TEXT,
      preferred_date TEXT,
      group_size INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (tour_slot_id) REFERENCES tour_slots(id)
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      room_number INTEGER NOT NULL,
      room_name TEXT,
      capacity INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS room_occupancy (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      user_id TEXT,
      guest_name TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT,
      is_guest INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (room_id) REFERENCES rooms(id),
      FOREIGN KEY (user_id) REFERENCES app_users(id)
    );
  `);

  // Migration: add google_calendar_id if missing
  try {
    db.exec('ALTER TABLE events ADD COLUMN google_calendar_id TEXT UNIQUE');
  } catch { /* column already exists */ }

  // Migration: add preferred_date to tour_requests if missing
  try {
    db.exec('ALTER TABLE tour_requests ADD COLUMN preferred_date TEXT');
  } catch { /* column already exists */ }
}

function uuid() {
  return crypto.randomUUID();
}

function normalizeSlotTime(t) {
  if (!t) return '00:00:00';
  const parts = t.split(':');
  while (parts.length < 3) parts.push('00');
  return parts.map(p => p.padStart(2, '0')).join(':');
}

// --- Users ---

export function getAllUsers() {
  return getDb().prepare('SELECT * FROM app_users ORDER BY name').all();
}

export function createUser(name) {
  const id = uuid();
  const now = new Date().toISOString();
  getDb().prepare('INSERT INTO app_users (id, name, created_at) VALUES (?, ?, ?)').run(id, name, now);
  return { id, name, created_at: now };
}

// --- Events ---

export function getAllEvents() {
  return getDb().prepare('SELECT * FROM events ORDER BY start_time ASC').all();
}

export function getEventById(id) {
  return getDb().prepare('SELECT * FROM events WHERE id = ?').get(id);
}

/**
 * Sync events from Google Calendar iCal feed.
 * Upserts by google_calendar_id — creates new events, updates existing ones.
 * Only keeps future events.
 */
export function syncCalendarEvents(parsedEvents) {
  const db = getDb();
  const now = new Date().toISOString();
  let synced = 0;
  let updated = 0;

  for (const evt of parsedEvents) {
    const existing = db.prepare(
      'SELECT id FROM events WHERE google_calendar_id = ?'
    ).get(evt.uid);

    if (existing) {
      db.prepare(`
        UPDATE events SET title = ?, description = ?, location = ?, start_time = ?, end_time = ?, updated_at = ?
        WHERE google_calendar_id = ?
      `).run(evt.summary, evt.description || null, evt.location || null, evt.start, evt.end, now, evt.uid);
      updated++;
    } else {
      const id = uuid();
      db.prepare(`
        INSERT INTO events (id, google_calendar_id, title, description, location, start_time, end_time, tours_eligible, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(id, evt.uid, evt.summary, evt.description || null, evt.location || null, evt.start, evt.end, now, now);
      synced++;
    }
  }

  return { synced, updated };
}

// --- Event Assignments ---

export function getAssignmentsForEvent(eventId) {
  return getDb().prepare(`
    SELECT ea.*, u.name as user_name
    FROM event_assignments ea
    JOIN app_users u ON ea.user_id = u.id
    WHERE ea.event_id = ?
    ORDER BY ea.role, ea.created_at
  `).all(eventId);
}

export function createAssignment({ event_id, user_id, role, notes }) {
  const id = uuid();
  const now = new Date().toISOString();
  getDb().prepare(
    'INSERT INTO event_assignments (id, event_id, user_id, role, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, event_id, user_id, role, notes || null, now);
  return getDb().prepare(`
    SELECT ea.*, u.name as user_name
    FROM event_assignments ea
    JOIN app_users u ON ea.user_id = u.id
    WHERE ea.id = ?
  `).get(id);
}

export function deleteAssignment(id) {
  getDb().prepare('DELETE FROM event_assignments WHERE id = ?').run(id);
}

// --- Tour Slots ---

export function getAllTourSlots() {
  const slots = getDb().prepare(`
    SELECT ts.*, e.title as event_title, e.tours_eligible as event_tours_eligible
    FROM tour_slots ts
    LEFT JOIN events e ON ts.event_id = e.id
    ORDER BY ts.slot_date DESC, ts.slot_time
  `).all();

  for (const slot of slots) {
    slot.shifts = getDb().prepare(`
      SELECT s.*, u.name as user_name
      FROM tour_shifts s
      JOIN app_users u ON s.user_id = u.id
      WHERE s.tour_slot_id = ?
    `).all(slot.id);
    slot.requests = getDb().prepare(
      'SELECT * FROM tour_requests WHERE tour_slot_id = ? ORDER BY created_at'
    ).all(slot.id);
  }

  return slots;
}

export function getTourSlotById(id) {
  const slot = getDb().prepare(`
    SELECT ts.*, e.title as event_title
    FROM tour_slots ts
    LEFT JOIN events e ON ts.event_id = e.id
    WHERE ts.id = ?
  `).get(id);
  if (!slot) return null;
  slot.shifts = getDb().prepare(`
    SELECT s.*, u.name as user_name
    FROM tour_shifts s
    JOIN app_users u ON s.user_id = u.id
    WHERE s.tour_slot_id = ?
  `).all(slot.id);
  slot.requests = getDb().prepare(
    'SELECT * FROM tour_requests WHERE tour_slot_id = ? ORDER BY created_at'
  ).all(slot.id);
  return slot;
}

export function createTourSlot({ slot_date, slot_time, slot_type, event_id, max_capacity, notes }) {
  const id = uuid();
  const now = new Date().toISOString();
  const normalizedTime = normalizeSlotTime(slot_time);
  getDb().prepare(
    'INSERT INTO tour_slots (id, event_id, slot_date, slot_time, slot_type, max_capacity, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, event_id || null, slot_date, normalizedTime, slot_type || 'regular', max_capacity || 10, notes || null, now);
  return getDb().prepare('SELECT * FROM tour_slots WHERE id = ?').get(id);
}

export function getTourRequestsBySlotId(slotId) {
  return getDb().prepare(
    'SELECT * FROM tour_requests WHERE tour_slot_id = ? ORDER BY created_at'
  ).all(slotId);
}

export function generateWeeklySlots() {
  const db = getDb();
  const now = new Date();
  const created = [];

  // Generate slots for next 4 weeks on Fridays and Mondays
  for (let weekOffset = 0; weekOffset < 4; weekOffset++) {
    for (const targetDay of [1, 5]) { // Monday=1, Friday=5
      const date = new Date(now);
      const currentDay = date.getDay();
      let daysAhead = targetDay - currentDay;
      if (daysAhead <= 0) daysAhead += 7;
      date.setDate(date.getDate() + daysAhead + (weekOffset * 7));

      const slotDate = date.toISOString().split('T')[0];
      const slotTime = '14:00:00';

      // Check if slot already exists
      const existing = db.prepare(
        'SELECT id FROM tour_slots WHERE slot_date = ? AND slot_time = ?'
      ).get(slotDate, slotTime);

      if (!existing) {
        const id = uuid();
        db.prepare(
          'INSERT INTO tour_slots (id, slot_date, slot_time, slot_type, max_capacity, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(id, slotDate, slotTime, 'regular', 10, new Date().toISOString());
        created.push({ id, slot_date: slotDate, slot_time: slotTime });
      }
    }
  }

  return created;
}

// --- Tour Shifts ---

export function createTourShift({ tour_slot_id, user_id, shift_type }) {
  const id = uuid();
  const now = new Date().toISOString();
  getDb().prepare(
    'INSERT INTO tour_shifts (id, tour_slot_id, user_id, shift_type, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, tour_slot_id, user_id, shift_type || 'lead', now);
  return getDb().prepare(`
    SELECT s.*, u.name as user_name
    FROM tour_shifts s
    JOIN app_users u ON s.user_id = u.id
    WHERE s.id = ?
  `).get(id);
}

export function deleteTourShift(id) {
  getDb().prepare('DELETE FROM tour_shifts WHERE id = ?').run(id);
}

// --- Tour Requests ---

export function createTourRequest({ tour_slot_id, requester_name, requester_email, requester_phone, preferred_date, group_size, notes }) {
  const id = uuid();
  const now = new Date().toISOString();
  getDb().prepare(
    'INSERT INTO tour_requests (id, tour_slot_id, requester_name, requester_email, requester_phone, preferred_date, group_size, notes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, tour_slot_id, requester_name, requester_email || null, requester_phone || null, preferred_date || null, group_size || 1, notes || null, 'pending', now);
  return getDb().prepare('SELECT * FROM tour_requests WHERE id = ?').get(id);
}

export function updateTourRequestStatus(id, status) {
  getDb().prepare('UPDATE tour_requests SET status = ? WHERE id = ?').run(status, id);
  return getDb().prepare('SELECT * FROM tour_requests WHERE id = ?').get(id);
}

export function deleteTourRequest(id) {
  getDb().prepare('DELETE FROM tour_requests WHERE id = ?').run(id);
}

// --- Rooms ---

export function getAllRooms() {
  const rooms = getDb().prepare('SELECT * FROM rooms ORDER BY room_number').all();
  for (const room of rooms) {
    room.occupancy = getDb().prepare(`
      SELECT ro.*, u.name as user_name
      FROM room_occupancy ro
      LEFT JOIN app_users u ON ro.user_id = u.id
      WHERE ro.room_id = ?
      ORDER BY ro.start_date
    `).all(room.id);
  }
  return rooms;
}

export function createRoom({ room_number, room_name, capacity, notes }) {
  const id = uuid();
  const now = new Date().toISOString();
  getDb().prepare(
    'INSERT INTO rooms (id, room_number, room_name, capacity, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, room_number, room_name || null, capacity || 1, notes || null, now);
  return getDb().prepare('SELECT * FROM rooms WHERE id = ?').get(id);
}

export function getRoomOccupantCount(roomId) {
  const today = new Date().toISOString().split('T')[0];
  const row = getDb().prepare(
    'SELECT COUNT(*) as cnt FROM room_occupancy WHERE room_id = ? AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)'
  ).get(roomId, today, today);
  return row ? row.cnt : 0;
}

export function deleteRoom(id) {
  const db = getDb();
  db.prepare('DELETE FROM room_occupancy WHERE room_id = ?').run(id);
  db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
}

// --- Room Occupancy ---

export function createOccupancy({ room_id, user_id, guest_name, start_date, end_date, is_guest, notes }) {
  const id = uuid();
  const now = new Date().toISOString();
  getDb().prepare(
    'INSERT INTO room_occupancy (id, room_id, user_id, guest_name, start_date, end_date, is_guest, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, room_id, user_id || null, guest_name || null, start_date, end_date || null, is_guest ? 1 : 0, notes || null, now);
  return getDb().prepare(`
    SELECT ro.*, u.name as user_name
    FROM room_occupancy ro
    LEFT JOIN app_users u ON ro.user_id = u.id
    WHERE ro.id = ?
  `).get(id);
}

export function updateOccupancy(id, { start_date, end_date, notes }) {
  const fields = [];
  const values = [];
  if (start_date !== undefined) { fields.push('start_date = ?'); values.push(start_date); }
  if (end_date !== undefined) { fields.push('end_date = ?'); values.push(end_date); }
  if (notes !== undefined) { fields.push('notes = ?'); values.push(notes); }
  if (fields.length === 0) return getDb().prepare('SELECT * FROM room_occupancy WHERE id = ?').get(id);
  values.push(id);
  getDb().prepare(`UPDATE room_occupancy SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getDb().prepare(`
    SELECT ro.*, u.name as user_name
    FROM room_occupancy ro
    LEFT JOIN app_users u ON ro.user_id = u.id
    WHERE ro.id = ?
  `).get(id);
}

export function deleteOccupancy(id) {
  getDb().prepare('DELETE FROM room_occupancy WHERE id = ?').run(id);
}
