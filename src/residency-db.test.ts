import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createOccupancy,
  createResidencyRequest,
  createRoom,
  createUser,
  deleteOccupancy,
  deleteRoom,
  getAllRooms,
  getResidencyRequest,
  getRoomOccupantCount,
  listResidencyRequestsByStatus,
  residencyToday,
  storeChatMetadata,
  updateOccupancy,
  updateResidencyRequestStatus,
  updateRoom,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('rooms', () => {
  it('creates a room with defaults and reads it back', () => {
    const room = createRoom({ room_number: 12 });
    expect(room.id).toBeTruthy();
    expect(room.room_number).toBe(12);
    expect(room.room_name).toBeNull();
    expect(room.capacity).toBe(1);
    expect(room.building_id).toBeNull();
    expect(room.floor_id).toBeNull();
    expect(room.map_room_id).toBeNull();
    expect(room.created_at).toBeTruthy();
  });

  it('creates a room with map columns first-class (the upstream split-brain fix)', () => {
    const room = createRoom({
      room_number: 3,
      room_name: 'North Suite',
      capacity: 2,
      notes: 'corner room',
      building_id: 'example-hall',
      floor_id: 'f1',
      map_room_id: 'f1-r3',
    });
    expect(room.building_id).toBe('example-hall');
    expect(room.floor_id).toBe('f1');
    expect(room.map_room_id).toBe('f1-r3');
    // And it survives a round-trip through getAllRooms.
    const [read] = getAllRooms();
    expect(read.map_room_id).toBe('f1-r3');
    expect(read.occupancy).toEqual([]);
  });

  it('enforces UNIQUE room_number (orchestrator DDL wins over the panel copy)', () => {
    createRoom({ room_number: 7 });
    expect(() => createRoom({ room_number: 7 })).toThrow(/UNIQUE/);
  });

  it('updates fields selectively, including clearing a mapping', () => {
    const room = createRoom({
      room_number: 5,
      building_id: 'example-hall',
      floor_id: 'f1',
      map_room_id: 'f1-r5',
    });
    let updated = updateRoom(room.id, { room_name: 'Renamed', capacity: 3 });
    expect(updated?.room_name).toBe('Renamed');
    expect(updated?.capacity).toBe(3);
    expect(updated?.map_room_id).toBe('f1-r5'); // untouched
    updated = updateRoom(room.id, {
      building_id: null,
      floor_id: null,
      map_room_id: null,
    });
    expect(updated?.building_id).toBeNull();
    expect(updated?.map_room_id).toBeNull();
  });

  it('updateRoom with no fields is a no-op read', () => {
    const room = createRoom({ room_number: 9, room_name: 'Nine' });
    const same = updateRoom(room.id, {});
    expect(same?.room_name).toBe('Nine');
  });

  it('deleteRoom removes the room and its occupancy records', () => {
    const room = createRoom({ room_number: 1 });
    createOccupancy({
      room_id: room.id,
      guest_name: 'Visitor',
      is_guest: true,
      start_date: '2026-01-01',
    });
    deleteRoom(room.id);
    expect(getAllRooms()).toEqual([]);
    expect(getRoomOccupantCount(room.id)).toBe(0);
  });
});

describe('room_occupancy', () => {
  it('creates a resident stay joined to app_users and a guest stay', () => {
    const room = createRoom({ room_number: 2 });
    const user = createUser('Ada Lovelace');
    const stay = createOccupancy({
      room_id: room.id,
      user_id: user.id,
      start_date: '2026-07-01',
      end_date: '2026-08-01',
      notes: 'summer',
    });
    expect(stay.user_name).toBe('Ada Lovelace');
    expect(stay.is_guest).toBe(0);
    const guest = createOccupancy({
      room_id: room.id,
      guest_name: 'Drop-in Guest',
      is_guest: true,
      start_date: '2026-07-10',
    });
    expect(guest.guest_name).toBe('Drop-in Guest');
    expect(guest.is_guest).toBe(1);
    expect(guest.end_date).toBeNull(); // ongoing
    const [read] = getAllRooms();
    expect(read.occupancy).toHaveLength(2);
    // Ordered by start_date.
    expect(read.occupancy?.[0].user_name).toBe('Ada Lovelace');
  });

  it('updates dates/notes and deletes a stay', () => {
    const room = createRoom({ room_number: 4 });
    const stay = createOccupancy({
      room_id: room.id,
      guest_name: 'G',
      is_guest: true,
      start_date: '2026-01-01',
    });
    const updated = updateOccupancy(stay.id, {
      start_date: '2026-02-01',
      end_date: '2026-03-01',
      notes: 'moved',
    });
    expect(updated?.start_date).toBe('2026-02-01');
    expect(updated?.end_date).toBe('2026-03-01');
    expect(updated?.notes).toBe('moved');
    deleteOccupancy(stay.id);
    const [read] = getAllRooms();
    expect(read.occupancy).toEqual([]);
  });

  it('getRoomOccupantCount counts only stays covering the venue-local today', () => {
    const room = createRoom({ room_number: 6 });
    const today = residencyToday();
    // Current: started in the past, no end (ongoing).
    createOccupancy({
      room_id: room.id,
      guest_name: 'Current',
      is_guest: true,
      start_date: '2000-01-01',
    });
    // Current: ends exactly today (inclusive).
    createOccupancy({
      room_id: room.id,
      guest_name: 'Ends today',
      is_guest: true,
      start_date: '2000-01-01',
      end_date: today,
    });
    // Past and future stays don't count.
    createOccupancy({
      room_id: room.id,
      guest_name: 'Past',
      is_guest: true,
      start_date: '2000-01-01',
      end_date: '2000-02-01',
    });
    createOccupancy({
      room_id: room.id,
      guest_name: 'Future',
      is_guest: true,
      start_date: '2999-01-01',
    });
    expect(getRoomOccupantCount(room.id)).toBe(2);
  });

  it('residencyToday returns YYYY-MM-DD and tolerates an invalid date', () => {
    expect(residencyToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(residencyToday(new Date('nope'))).toBe('');
  });
});

describe('residency_requests', () => {
  // chat_jid carries a FOREIGN KEY to chats(jid) (better-sqlite3 enforces FKs
  // by default), so requests must reference a stored chat — as in production,
  // where the intake always originates from a known chat.
  beforeEach(() => {
    storeChatMetadata('chat@g.us', '2026-01-01T00:00:00Z', 'Chat');
    storeChatMetadata('c1', '2026-01-01T00:00:00Z', 'C1');
    storeChatMetadata('c2', '2026-01-01T00:00:00Z', 'C2');
  });

  it('creates a request with defaults and fetches it', () => {
    const req = createResidencyRequest({
      chat_jid: 'chat@g.us',
      requester_name: 'Sam Applicant',
      requested_start_date: '2026-09-01',
    });
    expect(req.id).toMatch(/^rr-/);
    expect(req.status).toBe('pending');
    expect(req.request_type).toBe('resident');
    const fetched = getResidencyRequest(req.id);
    expect(fetched?.requester_name).toBe('Sam Applicant');
    expect(fetched?.requested_end_date).toBeNull();
  });

  it('lists by status and updates status with resolution', () => {
    const a = createResidencyRequest({
      chat_jid: 'c1',
      requester_name: 'A',
      requested_start_date: '2026-09-01',
    });
    createResidencyRequest({
      chat_jid: 'c2',
      requester_name: 'B',
      requested_start_date: '2026-10-01',
      request_type: 'guest',
      room_preference: 'quiet',
    });
    expect(listResidencyRequestsByStatus('pending')).toHaveLength(2);
    updateResidencyRequestStatus(a.id, 'approved', 'coordinator-jo', 'ok!');
    expect(listResidencyRequestsByStatus('pending')).toHaveLength(1);
    const approved = listResidencyRequestsByStatus('approved');
    expect(approved).toHaveLength(1);
    expect(approved[0].resolved_by).toBe('coordinator-jo');
    expect(approved[0].resolution_notes).toBe('ok!');
    expect(approved[0].resolved_at).toBeTruthy();
    // No status filter → everything.
    expect(listResidencyRequestsByStatus()).toHaveLength(2);
  });
});
