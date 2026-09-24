// Shared helpers for the offline detector tools (replay, selftest, fetch-history).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VehicleDetector, DEFAULT_THRESHOLDS } from '../src/detector.js';

// Real fleet data is never published: it lives in testdata/ (git-ignored), or in the folder
// given on the command line or in $FTW_TESTDATA.
export const DEFAULT_DATA_DIR = process.env.FTW_TESTDATA || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testdata');

export const DEFAULT_CAL = { emptyMv: 0, fullMv: 10000, tankLiters: null };
export const UB_OFFSET_MS = 8 * 3_600_000; // Asia/Ulaanbaatar, no DST

export function loadObjects(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'objects.json'), 'utf8'));
}

export function loadHistory(dir, imei) {
  const file = path.join(dir, 'hist', `${imei}.json`);
  if (!fs.existsSync(file)) return null;
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(rows) ? rows : [];
}

export const hasFuelSensor = (o) => o && o.params && o.params.io9 !== undefined;

export const shortName = (name) => String(name || '')
  .replace(/\s*\/\s*т[үу]лш[^/]*\/\s*/i, '').trim();

const num = (x) => (x == null || x === '' || !Number.isFinite(+x) ? null : +x);

// OBJECT_GET_MESSAGES row: [dt, lat, lng, altitude, angle, speed, params]
export function rowToSample(r) {
  const p = r[6] || {};
  return {
    t: Date.parse(String(r[0]).replace(' ', 'T') + 'Z'),
    f: num(p.io9),
    spd: num(r[5]) ?? 0,
    ign: num(p.io239),
    pwr: num(p.io66),
    lat: num(r[1]),
    lng: num(r[2]),
    odo: num(p.io16),
  };
}

export function fmtLocal(ms) {
  if (ms == null) return '-';
  return new Date(ms + UB_OFFSET_MS).toISOString().slice(5, 16).replace('T', ' ');
}

// "2026-09-23 16:36" (UB local) or any ISO string with an explicit zone
export function parseLocal(s) {
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(s)) return Date.parse(s);
  return Date.parse(s.replace(' ', 'T') + (s.length <= 16 ? ':00' : '') + '+08:00');
}

// Runs one vehicle through a detector with a backend-like alert store
// (dedupe key imei:type:(fromT ?? t), emit returns the existing id on duplicates).
export function runVehicle(obj, samples, { th = {}, cal = DEFAULT_CAL, store } = {}) {
  const alerts = store || { byId: new Map(), byKey: new Map(), seq: 0 };
  const levels = [];
  const vehicle = { imei: obj.imei, name: obj.name, hasFuel: hasFuelSensor(obj) };
  const settings = { th: { ...DEFAULT_THRESHOLDS, ...th }, cal };
  const det = new VehicleDetector(vehicle, () => settings,
    (a) => {
      const key = `${a.imei}:${a.type}:${a.fromT ?? a.t}`;
      if (alerts.byKey.has(key)) return alerts.byKey.get(key);
      const id = ++alerts.seq;
      alerts.byId.set(id, { id, key, ...a });
      alerts.byKey.set(key, id);
      return id;
    },
    (id, patch) => { const a = alerts.byId.get(id); if (a) Object.assign(a, patch); },
    (t, mv) => levels.push([t, mv]));
  for (const s of samples) det.push(s);
  return { det, levels, alerts: [...alerts.byId.values()].filter((a) => a.imei === obj.imei) };
}
