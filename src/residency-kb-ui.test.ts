// Router-level tests for the residency kb-ui plugin slice
// (container/catalog-plugins/residency/kb-ui/index.mjs): a real express app +
// node http server + fetch, a temp SQLite DB whose schema is created by the
// single owner (src/db.ts), and stub auth deps mirroring kb-ui/server.mjs.
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { _closeDatabase, _initTestDatabase } from './db.js';

const CATALOG_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'container',
  'catalog-plugins',
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let plugin: any;
let tmpRoot: string;
let dbPath: string;
let profileDir: string; // no buildings.json
let profileDirWithBuildings: string;
let server: http.Server;
let base: string; // http://127.0.0.1:<port>
let currentProfileDir: string;

const silentLogger = { info() {}, warn() {}, error() {} };

function makeDeps() {
  return {
    layout: (title: string, body: string, username: string) =>
      `<!DOCTYPE html><html><head><title>${title}</title></head><body data-user="${username}">${body}</body></html>`,
    esc: (s: unknown) =>
      String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;'),
    isAdmin: (u: string) => u === 'root',
    isSuperAdmin: (u: string) => u === 'root',
    isCoordinator: (u: string) => u === 'coord',
    isResident: (u: string) => u === 'res',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    usernameFromReq: (req: any) => req.auth?.user,
    Database,
    DB_PATH: dbPath,
    get PROFILE_DIR() {
      return currentProfileDir;
    },
    CONTEXT_DIR: tmpRoot,
    logger: silentLogger,
  };
}

// Node's fetch Response types json() as Promise<unknown>; the tests assert on
// dynamic JSON shapes, so loosen it once here instead of casting at every site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseResponse = Omit<Response, 'json'> & { json(): Promise<any> };

async function get(
  pathname: string,
  user = 'viewer',
  headers: Record<string, string> = {},
): Promise<LooseResponse> {
  return fetch(base + pathname, {
    headers: { 'x-test-user': user, ...headers },
  });
}

async function send(
  method: string,
  pathname: string,
  body: unknown,
  user = 'coord',
  headers: Record<string, string> = {},
): Promise<LooseResponse> {
  return fetch(base + pathname, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-test-user': user,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function resetTables() {
  const db = new Database(dbPath);
  db.exec(
    'DELETE FROM room_occupancy; DELETE FROM rooms; DELETE FROM app_users;',
  );
  db.close();
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'residency-kbui-'));
  dbPath = path.join(tmpRoot, 'messages.db');
  profileDir = path.join(tmpRoot, 'profile-plain');
  profileDirWithBuildings = path.join(tmpRoot, 'profile-buildings');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(profileDirWithBuildings, { recursive: true });
  fs.copyFileSync(
    path.resolve(
      CATALOG_DIR,
      '..',
      '..',
      'profiles',
      'example',
      'buildings.json',
    ),
    path.join(profileDirWithBuildings, 'buildings.json'),
  );
  currentProfileDir = profileDir;

  // Schema comes from the single owner (src/db.ts createSchema) on the temp
  // file; the plugin then opens its OWN connections against the same file —
  // exactly the production topology (orchestrator owns DDL, kb-ui reads/writes).
  _initTestDatabase(dbPath);
  _closeDatabase();

  plugin = await import(
    pathToFileURL(path.join(CATALOG_DIR, 'residency', 'kb-ui', 'index.mjs'))
      .href
  );

  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  // Stub Basic Auth the way kb-ui/server.mjs shapes it (req.auth.user).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use((req: any, _res, next) => {
    req.auth = { user: req.headers['x-test-user'] || 'viewer' };
    next();
  });
  app.use('/residency', plugin.createRoutes(makeDeps()));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  currentProfileDir = profileDir;
  resetTables();
});

describe('page rendering', () => {
  it('renders 200 for a coordinator and shows room names', async () => {
    await send('POST', '/residency/api/rooms', {
      room_number: 12,
      room_name: 'North Suite',
    });
    const res = await get('/residency', 'coord');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('North Suite');
    expect(html).toContain('Occupancy Timeline'); // gantt renders
  });

  it('shows edit affordances to coordinator and admin', async () => {
    for (const user of ['coord', 'root']) {
      const html = await (await get('/residency', user)).text();
      expect(html).not.toContain('View only');
      expect(html).toContain('add-room-modal');
    }
  });

  it('without buildings.json the grid still renders, mapping UI hidden, 3D map disabled', async () => {
    await send('POST', '/residency/api/rooms', {
      room_number: 3,
      room_name: 'Plain',
    });
    const html = await (await get('/residency', 'coord')).text();
    expect(html).toContain('Plain');
    expect(html).not.toContain('Not mapped</span>'); // no location line at all
    expect(html).not.toContain('add-building'); // no picker selects
    expect(html).toContain('3D map arrives with the map module'); // disabled button
    expect(html).toContain('disabled');
  });

  it('with buildings.json the picker + location labels appear (mapped and unmapped)', async () => {
    currentProfileDir = profileDirWithBuildings;
    await send('POST', '/residency/api/rooms', {
      room_number: 101,
      room_name: 'Mapped Room',
      building_id: 'example-hall',
      floor_id: '1',
      map_room_id: '1-r101',
    });
    await send('POST', '/residency/api/rooms', {
      room_number: 102,
      room_name: 'Loose Room',
    });
    const html = await (await get('/residency', 'coord')).text();
    expect(html).toContain('Example Hall · First Floor · Room 101');
    expect(html).toContain('Not mapped</span>');
    expect(html).toContain('add-building'); // cascading picker present
    expect(html).toContain('MAP_PICKER');
    // Picker data excludes common rooms (Lobby) but has real rooms.
    expect(html).not.toContain('Lobby');
  });

  it('accepts ?gw=YYYY-MM gantt window navigation', async () => {
    await send('POST', '/residency/api/rooms', { room_number: 8 });
    const res = await get('/residency?gw=2027-01', 'coord');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Jan 2027'); // window label reflects ?gw
  });

  it('out-of-range ?gw months fall back to the default window instead of 500ing', async () => {
    // `\d{4}-\d{2}` also matched 00 and 13-99; the renderer turned those into
    // an Invalid Date and threw RangeError out of toISOString() (500 for any
    // authenticated user).
    await send('POST', '/residency/api/rooms', { room_number: 9 });
    const windowLabel = (html: string) =>
      html.match(/margin-left:6px">([^<]+)<\/span>/)?.[1];
    const defaultLabel = windowLabel(await (await get('/residency', 'coord')).text());
    expect(defaultLabel).toBeTruthy();

    for (const gw of ['2026-13', '0000-00', '9999-99', '2026-1', 'nope', '']) {
      const res = await get(`/residency?gw=${encodeURIComponent(gw)}`, 'coord');
      expect(res.status, `?gw=${gw}`).toBe(200);
      const html = await res.text();
      expect(html).toContain('Occupancy Timeline');
      expect(windowLabel(html), `?gw=${gw}`).toBe(defaultLabel); // default window
      expect(html).not.toContain('gw=2026-13');
    }
  });
});

describe('page PII gate (finding 2)', () => {
  it('403s the page for a plain viewer and for a resident-role user', async () => {
    await send('POST', '/residency/api/rooms', {
      room_number: 77,
      room_name: 'Private Suite',
    });
    for (const user of ['viewer', 'res']) {
      const res = await get('/residency', user);
      expect(res.status, user).toBe(403);
      const html = await res.text();
      // Not one byte of occupancy PII, and no edit markup either.
      expect(html).not.toContain('Private Suite');
      expect(html).not.toContain('Occupancy Timeline');
      expect(html).not.toContain('add-room-modal');
      expect(html).toContain('Not authorized');
    }
  });

  it('403s every non-/api page path, not just the index', async () => {
    for (const p of ['/residency/', '/residency/anything']) {
      expect((await get(p, 'res')).status).toBe(403);
    }
  });

  it('coordinator and admin still get 200', async () => {
    for (const user of ['coord', 'root']) {
      expect((await get('/residency', user)).status, user).toBe(200);
    }
  });
});

describe('API authorization', () => {
  it('rejects a non-coordinator on every /api route (reads included — PII)', async () => {
    expect((await get('/residency/api/rooms', 'viewer')).status).toBe(403);
    expect((await get('/residency/api/users', 'res')).status).toBe(403);
    expect(
      (await send('POST', '/residency/api/rooms', { room_number: 1 }, 'viewer'))
        .status,
    ).toBe(403);
    expect(
      (await send('DELETE', '/residency/api/rooms/xyz', undefined, 'res'))
        .status,
    ).toBe(403);
  });

  it('blocks cross-origin mutations (exact-host, not substring) but allows same-origin', async () => {
    const evil = await send(
      'POST',
      '/residency/api/rooms',
      { room_number: 66 },
      'coord',
      { origin: 'http://evil.test' },
    );
    expect(evil.status).toBe(403);
    // Suffix-spoof: host embedded in a longer registrable domain must NOT pass.
    const spoof = await send(
      'POST',
      '/residency/api/rooms',
      { room_number: 66 },
      'coord',
      { origin: `http://${new URL(base).host}.evil.test` },
    );
    expect(spoof.status).toBe(403);
    const ok = await send(
      'POST',
      '/residency/api/rooms',
      { room_number: 66 },
      'coord',
      { origin: base },
    );
    expect(ok.status).toBe(200);
    // Cross-origin GETs are fine (no CSRF risk on reads).
    expect(
      (
        await get('/residency/api/rooms', 'coord', {
          origin: 'http://evil.test',
        })
      ).status,
    ).toBe(200);
  });
});

describe('room CRUD', () => {
  it('round-trips create (with map fields) → patch → delete', async () => {
    const created = await (
      await send('POST', '/residency/api/rooms', {
        room_number: 21,
        room_name: 'Suite',
        capacity: 2,
        building_id: 'example-hall',
        floor_id: '2',
        map_room_id: '2-r201',
      })
    ).json();
    expect(created.room_number).toBe(21);
    expect(created.map_room_id).toBe('2-r201'); // map columns are first-class

    const patched = await (
      await send('PATCH', `/residency/api/rooms/${created.id}`, {
        room_name: 'Renamed Suite',
        building_id: null,
        floor_id: null,
        map_room_id: null,
      })
    ).json();
    expect(patched.room_name).toBe('Renamed Suite');
    expect(patched.map_room_id).toBeNull();
    expect(patched.capacity).toBe(2); // untouched

    const list = await (await get('/residency/api/rooms', 'coord')).json();
    expect(list).toHaveLength(1);

    expect(
      (await send('DELETE', `/residency/api/rooms/${created.id}`, undefined))
        .status,
    ).toBe(200);
    expect(await (await get('/residency/api/rooms', 'coord')).json()).toEqual(
      [],
    );
  });

  it('rejects a missing or duplicate room_number', async () => {
    expect((await send('POST', '/residency/api/rooms', {})).status).toBe(400);
    await send('POST', '/residency/api/rooms', { room_number: 5 });
    const dup = await send('POST', '/residency/api/rooms', { room_number: 5 });
    expect(dup.status).toBe(400);
    expect((await dup.json()).error).toMatch(/already exists/);
  });

  it('PATCH maps a duplicate room_number to 400, not 500 (finding 5)', async () => {
    await send('POST', '/residency/api/rooms', { room_number: 30 });
    const other = await (
      await send('POST', '/residency/api/rooms', { room_number: 31 })
    ).json();
    const dup = await send('PATCH', `/residency/api/rooms/${other.id}`, {
      room_number: 30,
    });
    expect(dup.status).toBe(400);
    expect((await dup.json()).error).toMatch(/already exists/);
    // The row is untouched.
    const list = await (await get('/residency/api/rooms', 'coord')).json();
    expect(list.map((r: { room_number: number }) => r.room_number).sort()).toEqual(
      [30, 31],
    );
  });

  it('rejects non-integer room_number / capacity on POST and PATCH (findings 1b, 5)', async () => {
    const created = await (
      await send('POST', '/residency/api/rooms', { room_number: 40 })
    ).json();
    for (const body of [
      { room_number: '12" onload="alert(1)' },
      { room_number: 1.5 },
      { room_number: {} },
      { capacity: {} }, // used to 500 with "Too few parameter values"
      { capacity: 'many' },
      { capacity: [] },
      { room_name: {} },
      { notes: [] },
    ]) {
      const post = await send('POST', '/residency/api/rooms', {
        room_number: 99,
        ...body,
      });
      expect(post.status, `POST ${JSON.stringify(body)}`).toBe(400);
      const patch = await send('PATCH', `/residency/api/rooms/${created.id}`, body);
      expect(patch.status, `PATCH ${JSON.stringify(body)}`).toBe(400);
    }
    // Numeric strings from the form layer are still accepted.
    const ok = await send('PATCH', `/residency/api/rooms/${created.id}`, {
      room_number: '41',
      capacity: '3',
    });
    expect(ok.status).toBe(200);
    const row = await ok.json();
    expect(row.room_number).toBe(41);
    expect(row.capacity).toBe(3);
  });
});

describe('stored-XSS regression (finding 1)', () => {
  // The Gantt renders for anyone who can see the page, so an injected
  // attribute reaches privileged sessions. Both layers are asserted:
  // the API refuses the payload, and the renderer escapes it if it ever lands.
  const XSS = '2026-01-01" onload="alert(1)';

  it('the API refuses the payload outright', async () => {
    const room = await (
      await send('POST', '/residency/api/rooms', { room_number: 55 })
    ).json();
    expect(
      (
        await send('POST', '/residency/api/room-occupancy', {
          room_id: room.id,
          guest_name: 'X',
          is_guest: true,
          start_date: XSS,
        })
      ).status,
    ).toBe(400);
  });

  it('a row that bypassed the API (direct DB write) renders escaped, not as an attribute', async () => {
    const room = await (
      await send('POST', '/residency/api/rooms', { room_number: 56 })
    ).json();
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO room_occupancy (id, room_id, guest_name, start_date, end_date, is_guest, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    ).run('occ-xss', room.id, 'Mallory', XSS, XSS, new Date().toISOString());
    // room_number/capacity are INTEGER columns; SQLite happily stores text.
    db.prepare('UPDATE rooms SET capacity = ? WHERE id = ?').run(
      '1" onload="alert(2)',
      room.id,
    );
    db.close();

    const html = await (await get('/residency', 'coord')).text();
    expect(html).not.toContain('onload="alert(1)');
    expect(html).not.toContain('onload="alert(2)');
    expect(html).toContain('&quot; onload=&quot;alert(1)');
    expect(html).toContain('&quot; onload=&quot;alert(2)');
    // The payload only ever appears with its quotes entity-encoded, so no
    // real `onload="…"` attribute is ever produced anywhere in the document.
    expect(html).not.toMatch(/\sonload\s*=\s*["']/);
  });
});

describe('stay CRUD (resident vs guest) + date validation', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let room: any;
  beforeEach(async () => {
    room = await (
      await send('POST', '/residency/api/rooms', { room_number: 1 })
    ).json();
  });

  it('find-or-create resident flow: user create + occupancy joins user_name', async () => {
    const user = await (
      await send('POST', '/residency/api/users', { name: 'Ada Lovelace' })
    ).json();
    expect(user.id).toBeTruthy();
    const roster = await (await get('/residency/api/users', 'coord')).json();
    expect(roster.map((u: { name: string }) => u.name)).toEqual([
      'Ada Lovelace',
    ]);

    const stay = await (
      await send('POST', '/residency/api/room-occupancy', {
        room_id: room.id,
        user_id: user.id,
        start_date: '2026-07-01',
        end_date: '2026-08-01',
      })
    ).json();
    expect(stay.user_name).toBe('Ada Lovelace');
    expect(stay.is_guest).toBe(0);
  });

  it('guest stay stores free-text guest_name with no app_users row', async () => {
    const stay = await (
      await send('POST', '/residency/api/room-occupancy', {
        room_id: room.id,
        guest_name: 'Weekend Guest',
        is_guest: true,
        start_date: '2026-07-10',
      })
    ).json();
    expect(stay.guest_name).toBe('Weekend Guest');
    expect(stay.is_guest).toBe(1);
    expect(stay.user_id).toBeNull();
    expect(stay.end_date).toBeNull(); // ongoing
    expect(await (await get('/residency/api/users', 'coord')).json()).toEqual(
      [],
    );
  });

  it('patches dates/notes and deletes a stay', async () => {
    const stay = await (
      await send('POST', '/residency/api/room-occupancy', {
        room_id: room.id,
        guest_name: 'G',
        is_guest: true,
        start_date: '2026-01-01',
      })
    ).json();
    const patched = await (
      await send('PATCH', `/residency/api/room-occupancy/${stay.id}`, {
        start_date: '2026-02-01',
        end_date: '2026-03-01',
        notes: 'shifted',
      })
    ).json();
    expect(patched.start_date).toBe('2026-02-01');
    expect(patched.end_date).toBe('2026-03-01');
    expect(patched.notes).toBe('shifted');
    expect(
      (
        await send(
          'DELETE',
          `/residency/api/room-occupancy/${stay.id}`,
          undefined,
        )
      ).status,
    ).toBe(200);
    const rooms = await (await get('/residency/api/rooms', 'coord')).json();
    expect(rooms[0].occupancy).toEqual([]);
  });

  it('rejects end_date before start_date on create AND edit (server layer)', async () => {
    const bad = await send('POST', '/residency/api/room-occupancy', {
      room_id: room.id,
      guest_name: 'X',
      is_guest: true,
      start_date: '2026-05-10',
      end_date: '2026-05-01',
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/on or after/);

    const stay = await (
      await send('POST', '/residency/api/room-occupancy', {
        room_id: room.id,
        guest_name: 'X',
        is_guest: true,
        start_date: '2026-05-01',
      })
    ).json();
    const badPatch = await send(
      'PATCH',
      `/residency/api/room-occupancy/${stay.id}`,
      {
        start_date: '2026-05-10',
        end_date: '2026-05-01',
      },
    );
    expect(badPatch.status).toBe(400);
  });

  it('rejects malformed dates on create AND patch (finding 1b)', async () => {
    const xssDate = '2026-01-01" onload="alert(1)';
    for (const body of [
      { start_date: xssDate },
      { start_date: '2026-1-1' },
      { start_date: '2026-02-31' }, // shaped right, not a real day
      { start_date: '20260101' },
      { start_date: 12345 },
      { start_date: '2026-01-01', end_date: xssDate },
      { start_date: '2026-01-01', end_date: '2026-13-01' },
    ]) {
      const res = await send('POST', '/residency/api/room-occupancy', {
        room_id: room.id,
        guest_name: 'X',
        is_guest: true,
        ...body,
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error).toMatch(/YYYY-MM-DD/);
    }

    const stay = await (
      await send('POST', '/residency/api/room-occupancy', {
        room_id: room.id,
        guest_name: 'X',
        is_guest: true,
        start_date: '2026-05-01',
      })
    ).json();
    for (const body of [{ start_date: xssDate }, { end_date: xssDate }]) {
      const res = await send(
        'PATCH',
        `/residency/api/room-occupancy/${stay.id}`,
        body,
      );
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('PATCH end_date alone is range-checked against the STORED start_date (finding 4)', async () => {
    const stay = await (
      await send('POST', '/residency/api/room-occupancy', {
        room_id: room.id,
        guest_name: 'X',
        is_guest: true,
        start_date: '2026-05-10',
      })
    ).json();
    // Body omits start_date — used to skip the check entirely and store an
    // inverted stay (end 2020 < start 2026).
    const bad = await send(
      'PATCH',
      `/residency/api/room-occupancy/${stay.id}`,
      { end_date: '2020-01-01' },
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/on or after/);
    const after = await (await get('/residency/api/rooms', 'coord')).json();
    expect(after[0].occupancy[0].end_date).toBeNull(); // unchanged

    // Symmetric: moving start_date past the STORED end_date is rejected too.
    await send('PATCH', `/residency/api/room-occupancy/${stay.id}`, {
      end_date: '2026-06-01',
    });
    expect(
      (
        await send('PATCH', `/residency/api/room-occupancy/${stay.id}`, {
          start_date: '2026-07-01',
        })
      ).status,
    ).toBe(400);

    // A legitimate single-field patch still works.
    const ok = await send('PATCH', `/residency/api/room-occupancy/${stay.id}`, {
      end_date: '2026-08-01',
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).end_date).toBe('2026-08-01');
  });

  it('4xx (not 500) for a bogus room_id / user_id on create (finding 5)', async () => {
    const bogusRoom = await send('POST', '/residency/api/room-occupancy', {
      room_id: 'no-such-room',
      guest_name: 'X',
      is_guest: true,
      start_date: '2026-01-01',
    });
    expect(bogusRoom.status).toBe(404);
    expect((await bogusRoom.json()).error).toMatch(/room not found/);

    const bogusUser = await send('POST', '/residency/api/room-occupancy', {
      room_id: room.id,
      user_id: 'no-such-user',
      start_date: '2026-01-01',
    });
    expect(bogusUser.status).toBe(400);
    expect((await bogusUser.json()).error).toMatch(/user_id/);
  });

  it('4xx (not 500) for non-scalar text fields (finding 5)', async () => {
    for (const body of [{ guest_name: {} }, { notes: [] }, { room_id: {} }]) {
      const res = await send('POST', '/residency/api/room-occupancy', {
        room_id: room.id,
        is_guest: true,
        start_date: '2026-01-01',
        ...body,
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('requires room_id and start_date on create', async () => {
    expect(
      (
        await send('POST', '/residency/api/room-occupancy', {
          room_id: room.id,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send('POST', '/residency/api/room-occupancy', {
          start_date: '2026-01-01',
        })
      ).status,
    ).toBe(400);
  });
});

describe('buildings.json loader', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let buildings: any;
  beforeAll(async () => {
    buildings = await import(
      pathToFileURL(
        path.join(CATALOG_DIR, 'residency', 'kb-ui', 'buildings.mjs'),
      ).href
    );
  });

  it('loads and validates the example profile geometry', () => {
    const loaded = buildings.loadBuildings(
      profileDirWithBuildings,
      silentLogger,
    );
    expect(loaded.mappingBuildingId).toBe('example-hall');
    const { picker, lookup } = buildings.buildMapPicker(loaded);
    expect(picker).toHaveLength(1);
    expect(picker[0].floors.length).toBe(2);
    // common rooms excluded from the picker but every room resolvable in lookup
    expect(
      picker[0].floors[0].rooms.some(
        (r: { name: string }) => r.name === 'Lobby',
      ),
    ).toBe(false);
    expect(lookup['example-hall/1/1-r101'].roomName).toBe('Room 101');
  });

  it('returns null for an absent file and for invalid JSON/schema (never throws)', () => {
    expect(buildings.loadBuildings(profileDir, silentLogger)).toBeNull();
    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-buildings-'));
    try {
      fs.writeFileSync(path.join(badDir, 'buildings.json'), '{not json');
      expect(buildings.loadBuildings(badDir, silentLogger)).toBeNull();
      fs.writeFileSync(
        path.join(badDir, 'buildings.json'),
        JSON.stringify({ buildings: [{ id: 'x' }] }),
      );
      expect(buildings.loadBuildings(badDir, silentLogger)).toBeNull();
    } finally {
      fs.rmSync(badDir, { recursive: true, force: true });
    }
  });

  it('validateBuildings reports precise problems', () => {
    expect(buildings.validateBuildings(null)).toEqual([
      'buildings.json must be a JSON object',
    ]);
    const errs = buildings.validateBuildings({
      buildings: [{ id: 'b', name: 'B', width: -1, depth: 10, floors: [] }],
      residencyMappingBuildingId: 42,
    });
    expect(errs.join(' ')).toMatch(/width/);
    expect(errs.join(' ')).toMatch(/residencyMappingBuildingId/);
  });
});

describe('timezone resolution (finding 6)', () => {
  const tzDirs: string[] = [];
  let tzRoot: string;
  let tzProfile: string;

  function tzTmp(prefix: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tzDirs.push(dir);
    return dir;
  }
  function writeEnv(dir: string, body: string) {
    fs.writeFileSync(path.join(dir, '.env'), body);
  }

  beforeEach(() => {
    tzRoot = tzTmp('residency-tz-');
    tzProfile = path.join(tzRoot, 'profiles', 'acme');
    fs.mkdirSync(tzProfile, { recursive: true });
    fs.writeFileSync(
      path.join(tzProfile, 'profile.config.json'),
      JSON.stringify({ timezone: 'Asia/Tokyo' }),
    );
  });

  afterAll(() => {
    while (tzDirs.length) fs.rmSync(tzDirs.pop()!, { recursive: true, force: true });
  });

  it('process.env.TZ wins over the install .env and the profile', () => {
    writeEnv(tzRoot, 'TZ=Europe/Berlin\n');
    expect(plugin.resolveTimezone(tzProfile, { TZ: 'America/New_York' }, tzRoot)).toBe(
      'America/New_York',
    );
  });

  it('the install .env TZ wins over profile.config.json (the kb-ui/orchestrator drift)', () => {
    // kb-ui's systemd unit does not load .env, so before the fix this file was
    // invisible here while src/config.ts read it — the two could disagree.
    writeEnv(tzRoot, '# comment\nOTHER=x\nTZ="Europe/Berlin"\n');
    expect(plugin.resolveTimezone(tzProfile, {}, tzRoot)).toBe('Europe/Berlin');
  });

  it('falls back to profile.config.json when .env has no TZ, then to a system zone', () => {
    writeEnv(tzRoot, 'OTHER=x\n');
    expect(plugin.resolveTimezone(tzProfile, {}, tzRoot)).toBe('Asia/Tokyo');
    // No .env at all, no profile config → still resolves to a usable zone.
    const bare = tzTmp('residency-tz-bare-');
    const resolved = plugin.resolveTimezone(bare, {}, bare);
    expect(typeof resolved).toBe('string');
    expect(resolved.length).toBeGreaterThan(0);
  });

  it('skips invalid candidates instead of adopting them', () => {
    writeEnv(tzRoot, 'TZ=Not/AZone\n');
    expect(plugin.resolveTimezone(tzProfile, { TZ: 'Also/Bogus' }, tzRoot)).toBe(
      'Asia/Tokyo',
    );
  });

  it('readInstallEnvValue is non-throwing and honours quoting/comments/last-wins', () => {
    expect(plugin.readInstallEnvValue('TZ', '/nonexistent/dir')).toBeUndefined();
    writeEnv(tzRoot, "#TZ=Ignored\nTZ='UTC'\nTZ=Europe/Paris\n");
    expect(plugin.readInstallEnvValue('TZ', tzRoot)).toBe('Europe/Paris');
    expect(plugin.readInstallEnvValue('NOPE', tzRoot)).toBeUndefined();
  });
});

describe('plugin manifest', () => {
  it('exports navCards for the home page and the orchestrator entry declares id "residency"', async () => {
    const cards = plugin.navCards();
    expect(cards).toEqual([
      expect.objectContaining({
        href: '/residency',
        title: 'Residency',
        // Not advertised to users the route gate would 403 (finding 2).
        roles: ['coordinator', 'admin'],
      }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry: any = await import(
      pathToFileURL(path.join(CATALOG_DIR, 'residency.mjs')).href
    );
    expect(entry.id).toBe('residency');
    expect(typeof entry.default).toBe('function');
  });
});
