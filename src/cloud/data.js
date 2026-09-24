// Loading shared by the tick and the dashboard API (Postgres -> plain rows), with small
// per-instance caches: a warm Vercel instance serves many requests, and every byte read from
// Supabase counts against its egress allowance.
const MIN = 60e3;

export const VEHICLE_SELECT = 'imei, name, group_name, device, plate, sim, has_fuel, last_seen, server_seen, lat, lng, speed, angle, ign, pwr, fuel_raw, odometer_km, status';

let calCache = null; // { at, rows }

/** Tank calibration tables (rarely change: re-read every 10 min). */
export async function loadCalibrationRows(sql, now = Date.now()) {
  if (calCache && now - calCache.at < 10 * MIN) return calCache.rows;
  const rows = await sql`select imei, points from fuel.calibrations`;
  calCache = { at: now, rows: rows.map((r) => ({ imei: r.imei, points: r.points })) };
  return calCache.rows;
}

export function clearDataCaches() {
  calCache = null;
}

export const plain = (rows) => rows.map((r) => ({ ...r }));

/** settings rows -> { key: value } */
export function settingsObject(rows) {
  const out = {};
  for (const r of rows) out[r.k] = r.v;
  return out;
}

/** Maps for MemDb / CloudEngine from vehicle rows with rec / det_state. */
export function vehicleMaps(rows) {
  const recStates = new Map();
  const detStates = new Map();
  const lastT = new Map();
  const lastLevel = new Map();
  for (const r of rows) {
    if (r.rec) {
      recStates.set(r.imei, r.rec);
      if (Number.isFinite(r.rec.lastT)) lastT.set(r.imei, r.rec.lastT);
      if (r.rec.lastLevel) lastLevel.set(r.imei, r.rec.lastLevel);
    }
    if (r.det_state) detStates.set(r.imei, r.det_state);
  }
  return { recStates, detStates, lastT, lastLevel };
}
