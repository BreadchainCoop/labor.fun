// buildings.json loader + validator for the residency plugin.
//
// Geometry is PER-ORG DATA, not code: it lives at `<PROFILE_DIR>/buildings.json`
// (a tenant asset — lil_salem hardcoded its real geometry in server.mjs; here
// each org ships its own file, see profiles/example/buildings.json).
//
// Schema (all coordinates in HALF-FEET — a w of 20 is a 10ft-wide room):
//   {
//     residencyMappingBuildingId: string,   // which building the residency
//                                           // room-mapping picker offers
//     buildings: [{
//       id: string, name: string, address?: string,
//       shape: 'rect' | 'l',                // footprint ('l' uses the notch)
//       width: number, depth: number,
//       notchWidth?: number, notchDepth?: number,
//       floorOrder?: string[],              // display order of floor ids
//       meta?: object,                      // free-form (R3 3D map may use it)
//       floors: [{
//         id: string, name: string, subtitle?: string, color?: string,
//         rooms: [{
//           id: string, name: string,
//           x: number, y: number, w: number, h: number,
//           sqft?: number,
//           common?: boolean,               // halls/baths/etc — excluded from
//                                           // the residency mapping picker
//           dimensions?: string, ceiling?: string
//         }]
//       }]
//     }]
//   }
//
// Absent file → `load()` returns null and the residency page hides the
// physical-room assignment UI (graceful; occupancy tracking still works).
import fs from 'fs';
import path from 'path';

/** Validate the parsed buildings.json shape. Returns a list of problems ('' = ok). */
export function validateBuildings(data) {
  const errs = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return ['buildings.json must be a JSON object'];
  }
  if (!Array.isArray(data.buildings)) {
    errs.push('`buildings` must be an array');
    return errs;
  }
  data.buildings.forEach((b, i) => {
    const at = `buildings[${i}]`;
    if (!b || typeof b !== 'object') return void errs.push(`${at} must be an object`);
    if (typeof b.id !== 'string' || !b.id) errs.push(`${at}.id must be a non-empty string`);
    if (typeof b.name !== 'string' || !b.name) errs.push(`${at}.name must be a non-empty string`);
    if (b.shape !== undefined && !['rect', 'l'].includes(String(b.shape).toLowerCase())) {
      errs.push(`${at}.shape must be 'rect' or 'l'`);
    }
    for (const k of ['width', 'depth']) {
      if (typeof b[k] !== 'number' || !(b[k] > 0)) errs.push(`${at}.${k} must be a positive number`);
    }
    if (!Array.isArray(b.floors)) {
      errs.push(`${at}.floors must be an array`);
      return;
    }
    b.floors.forEach((f, j) => {
      const fat = `${at}.floors[${j}]`;
      if (!f || typeof f !== 'object') return void errs.push(`${fat} must be an object`);
      if (typeof f.id !== 'string' || !f.id) errs.push(`${fat}.id must be a non-empty string`);
      if (typeof f.name !== 'string' || !f.name) errs.push(`${fat}.name must be a non-empty string`);
      if (!Array.isArray(f.rooms)) {
        errs.push(`${fat}.rooms must be an array`);
        return;
      }
      f.rooms.forEach((r, k) => {
        const rat = `${fat}.rooms[${k}]`;
        if (!r || typeof r !== 'object') return void errs.push(`${rat} must be an object`);
        if (typeof r.id !== 'string' || !r.id) errs.push(`${rat}.id must be a non-empty string`);
        if (typeof r.name !== 'string' || !r.name) errs.push(`${rat}.name must be a non-empty string`);
        for (const dim of ['x', 'y', 'w', 'h']) {
          if (typeof r[dim] !== 'number') errs.push(`${rat}.${dim} must be a number`);
        }
      });
    });
  });
  if (
    data.residencyMappingBuildingId !== undefined &&
    typeof data.residencyMappingBuildingId !== 'string'
  ) {
    errs.push('`residencyMappingBuildingId` must be a string (a building id)');
  }
  return errs;
}

/**
 * Load `<profileDir>/buildings.json`. Returns
 *   { buildings: [...], mappingBuildingId: string|null }
 * or null when the file is absent (residency then hides the mapping UI) or
 * invalid (logged — a broken tenant file must not crash the dashboard).
 */
export function loadBuildings(profileDir, logger = console) {
  const file = path.join(profileDir, 'buildings.json');
  if (!fs.existsSync(file)) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    logger.error(`[residency] buildings.json is not valid JSON — ignoring: ${err.message}`);
    return null;
  }
  const errs = validateBuildings(data);
  if (errs.length) {
    logger.error(`[residency] buildings.json failed validation — ignoring: ${errs.join('; ')}`);
    return null;
  }
  return {
    buildings: data.buildings,
    mappingBuildingId: data.residencyMappingBuildingId || null,
  };
}

/**
 * Build the two structures the residency page needs from loaded buildings:
 *   - lookup: "<buildingId>/<floorId>/<roomId>" -> { buildingName, floorName, roomName }
 *     (resolves ANY existing mapping, even to a building the picker no longer offers)
 *   - picker: [{ id, name, floors: [{ id, name, subtitle, rooms: [{id, name}] }] }]
 *     — ONLY the mapping building, with `common` rooms (halls/baths) excluded.
 * With `loaded` null (no buildings.json) both come back empty and the page
 * hides the physical-room assignment UI.
 */
export function buildMapPicker(loaded) {
  const lookup = {};
  const picker = [];
  if (!loaded) return { lookup, picker };
  for (const b of loaded.buildings) {
    const floors = [];
    for (const f of b.floors || []) {
      const rooms = (f.rooms || [])
        .filter((r) => !r.common)
        .map((r) => {
          lookup[`${b.id}/${f.id}/${r.id}`] = {
            buildingName: b.name,
            floorName: f.name,
            roomName: r.name,
          };
          return { id: r.id, name: r.name };
        });
      if (rooms.length) {
        floors.push({ id: f.id, name: f.name, subtitle: f.subtitle || '', rooms });
      }
    }
    if (b.id === loaded.mappingBuildingId) {
      picker.push({ id: b.id, name: b.name, floors });
    }
  }
  return { lookup, picker };
}
