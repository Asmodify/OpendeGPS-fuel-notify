// In-memory stand-in for the SQLite Store (src/db.js), so the cloud backend runs the very same
// Engine code as the local program. Each request or tick loads what it needs from Postgres
// into a MemDb, runs the Engine synchronously against it, and then writes back the changes the
// MemDb recorded (see store.js). Method names, arguments and row shapes follow db.js.
import { LEDGER_TYPES } from '../db.js';
import { isPendingDrain } from '../ledger.js';

const nz = (x) => (x === undefined || (typeof x === 'number' && !Number.isFinite(x)) ? null : x);
const SAMPLE_COLS = ['t', 'f', 'spd', 'ign', 'pwr', 'lat', 'lng', 'odo'];
const VEHICLE_COLS = ['name', 'group_name', 'device', 'plate', 'sim', 'has_fuel', 'last_seen', 'server_seen', 'lat', 'lng', 'speed', 'angle', 'ign', 'pwr', 'fuel_raw', 'odometer_km', 'status'];

/** Distance / engine time / max speed over samples in time order: the same sums as the
 *  motionStats SQL in db.js (null without samples). */
export function motionStatsOf(rows, thr24 = 26400, thr12 = 13300) {
  if (!rows.length) return null;
  let odoM = 0;
  let odoPairs = 0;
  let engineMs = 0;
  let maxSpd = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.spd !== null && r.spd !== undefined && (maxSpd === null || r.spd > maxSpd)) maxSpd = r.spd;
    if (i === 0) continue;
    const p = rows[i - 1];
    const dt = r.t - p.t;
    if (p.odo !== null && p.odo !== undefined && r.odo !== null && r.odo !== undefined) {
      odoPairs++;
      if (r.odo >= p.odo && r.odo - p.odo <= dt * 0.07 + 1000) odoM += r.odo - p.odo;
    }
    const pspd = p.spd ?? null;
    const pign = p.ign ?? null;
    const ppwr = p.pwr ?? null;
    const on = (pspd !== null && pspd >= 3 && (pign === null || pign !== 0))
      || ((pspd === null || pspd < 3) && pign === 1 && (ppwr === null || ppwr >= (ppwr > 18000 ? thr24 : thr12)));
    if (dt <= 300000 && on) engineMs += dt;
  }
  return { n: rows.length, odo_m: odoM, odo_pairs: odoPairs, engine_ms: engineMs, max_spd: maxSpd };
}

export class MemDb {
  /**
   * data (all optional):
   *   vehicles      rows of fuel.vehicles (db.js column names)
   *   settings      { key: value }
   *   alerts        alert rows already known (ongoing ones, ones the detectors may update, ...)
   *   nextAlertId   first id for new alerts (the tick is the only writer of new alerts)
   *   lastT         Map imei -> newest stored sample time
   *   lastLevel     Map imei -> { t, mv }
   *   samples       Map imei -> stored sample rows (time order) the request may read
   *   sampleTimes   Map imei -> { from, times: Set } stored sample times from `from` on
   *   activeCounts  rows { imei, severity, n }
   *   queryAlerts   rows for queryAlerts()
   *   levels        rows { imei, t, mv } (time order) for levelsRange / levelsAll / lastLevelBefore
   *   levelsBefore  Map imei -> { t, mv } (last level before the summary period)
   *   fuelEvents    rows for fuelEvents()
   *   alertSums     rows for alertSums()
   *   motion        Map `${imei}:${from}:${to}` -> motionStats row
   *   ledgerAlerts  rows for ledgerAlerts()
   *   meta          { key: value }
   */
  constructor(data = {}) {
    this.vehicleRows = data.vehicles || [];
    this.settings = new Map(Object.entries(data.settings || {}));
    this.alerts = new Map();
    this.alertKeys = new Map();
    for (const a of data.alerts || []) this.addKnownAlert(a);
    this.nextAlertId = data.nextAlertId ?? 1;
    this.lastT = data.lastT || new Map();
    this.lastLevels = data.lastLevel || new Map();
    this.samples = data.samples || new Map();
    this.sampleTimes = data.sampleTimes || new Map();
    this.activeCountRows = data.activeCounts || [];
    this.queryAlertRows = data.queryAlerts || [];
    this.levelRows = data.levels || [];
    this.levelsBefore = data.levelsBefore || new Map();
    this.fuelEventRows = data.fuelEvents || [];
    this.alertSumRows = data.alertSums || [];
    this.motion = data.motion || new Map();
    this.ledgerAlertRows = data.ledgerAlerts || [];
    this.meta = { ...(data.meta || {}) };
    // changes to write back
    this.out = {
      vehicles: new Map(), // imei -> row
      samples: [], // { imei, t, f, spd, ign, pwr, lat, lng, odo }
      levels: new Map(), // `${imei}:${t}` -> { imei, t, mv }
      newAlerts: new Map(), // id -> row
      alertUpdates: new Set(), // ids changed by the detectors / offline checks (content columns)
      alertReviews: new Set(), // ids acked / reviewed (owner columns)
      settings: new Map(), // key -> value | null (delete)
    };
  }

  addKnownAlert(a) {
    const row = { ...a };
    this.alerts.set(Number(row.id), row);
    this.alertKeys.set(row.key, Number(row.id));
  }

  // ---- vehicles -----------------------------------------------------------------
  loadVehicles() {
    return this.vehicleRows;
  }

  groups() {
    return [...new Set(this.vehicleRows.map((r) => r.group_name).filter((g) => g !== null && g !== undefined))].sort();
  }

  upsertVehicles(list, now = Date.now()) {
    for (const v of list) {
      this.out.vehicles.set(v.imei, {
        imei: v.imei, name: nz(v.name), group_name: nz(v.group), device: nz(v.device), plate: nz(v.plate), sim: nz(v.sim),
        has_fuel: !!v.hasFuel, last_seen: nz(v.lastSeen), server_seen: nz(v.serverSeen), lat: nz(v.lat), lng: nz(v.lng),
        speed: nz(v.speed), angle: nz(v.angle), ign: nz(v.ign), pwr: nz(v.pwr), fuel_raw: nz(v.fuelRaw),
        odometer_km: nz(v.odometerKm), status: nz(v.status), updated_at: now,
      });
    }
  }

  // ---- samples ------------------------------------------------------------------
  /** Stores rows whose time is not stored yet; returns how many were new. */
  insertSamples(imei, samples) {
    if (!samples.length) return 0;
    let known = this.sampleTimes.get(imei);
    if (!known) this.sampleTimes.set(imei, (known = { from: Infinity, times: new Set() }));
    const last = this.lastT.get(imei) ?? -Infinity;
    let n = 0;
    let list = this.samples.get(imei);
    for (const s of samples) {
      // stored before: in the loaded range and listed, or older than that range and not after the newest stored one
      if (known.times.has(s.t) || (s.t < known.from && s.t <= last)) continue;
      known.times.add(s.t);
      const row = { t: s.t, f: nz(s.f), spd: nz(s.spd), ign: nz(s.ign), pwr: nz(s.pwr), lat: nz(s.lat), lng: nz(s.lng), odo: nz(s.odo) };
      this.out.samples.push({ imei, ...row });
      if (!list) this.samples.set(imei, (list = []));
      list.push(row);
      n++;
    }
    if (list) list.sort((a, b) => a.t - b.t);
    const newest = samples.reduce((m, s) => Math.max(m, s.t), last);
    this.lastT.set(imei, newest);
    return n;
  }

  lastSampleT(imei) {
    return this.lastT.get(imei) ?? null;
  }

  firstSampleAfter(imei, t) {
    for (const r of this.samples.get(imei) || []) if (r.t > t) return r.t;
    return null;
  }

  replayStart() {
    return null; // the cloud keeps detector snapshots instead of replaying
  }

  samplesFrom(imei, fromT) {
    return (this.samples.get(imei) || []).filter((r) => r.t >= fromT).map((r) => ({ ...r }));
  }

  samplesRange(imei, from, to) {
    return (this.samples.get(imei) || []).filter((r) => r.t >= from && r.t <= to).map((r) => ({ ...r }));
  }

  motionStats(imei, from, to, thr24 = 26400, thr12 = 13300) {
    const k = `${imei}:${from}:${to}`;
    if (this.motion.has(k)) return this.motion.get(k);
    return motionStatsOf(this.samplesRange(imei, from, to), thr24, thr12);
  }

  fuelEvents(from, to) {
    return this.fuelEventRows.filter((r) => r.t >= from && r.t <= to);
  }

  firstSampleEver() {
    return this.meta.firstSampleEver ?? null;
  }

  // ---- levels -------------------------------------------------------------------
  insertLevel(imei, t, mv) {
    this.out.levels.set(`${imei}:${t}`, { imei, t, mv });
    this.lastLevels.set(imei, { t, mv });
  }

  levelsRange(imei, from, to) {
    return this.levelRows.filter((r) => r.imei === imei && r.t >= from && r.t <= to).map((r) => ({ t: r.t, mv: r.mv }));
  }

  levelsAll(from, to) {
    return this.levelRows.filter((r) => r.t >= from && r.t <= to);
  }

  lastLevel(imei) {
    return this.lastLevels.get(imei) ?? null;
  }

  lastLevelBefore(imei, t) {
    let best = this.levelsBefore.get(imei) ?? null;
    if (best && best.t >= t) best = null;
    for (const r of this.levelRows) if (r.imei === imei && r.t < t && (!best || r.t > best.t)) best = { t: r.t, mv: r.mv };
    return best;
  }

  // ---- alerts -------------------------------------------------------------------
  insertAlert(a, now = Date.now()) {
    const have = this.alertKeys.get(a.key);
    if (have !== undefined) return { id: have, inserted: false };
    const id = this.nextAlertId++;
    const row = {
      id, key: a.key, imei: nz(a.imei), name: nz(a.name), type: a.type, severity: a.severity, t: a.t, from_t: nz(a.fromT),
      lat: nz(a.lat), lng: nz(a.lng), title: nz(a.title), detail: nz(a.detail), amount_mv: nz(a.amountMv),
      ongoing: !!a.ongoing, acked: false, acked_at: null, historical: !!a.historical, extra: nz(a.extra),
      verdict: null, note: null, reviewed_at: null, created_at: now, updated_at: now,
    };
    this.addKnownAlert(row);
    this.out.newAlerts.set(id, row);
    return { id, inserted: true };
  }

  alertIdByKey(key) {
    return this.alertKeys.get(key) ?? null;
  }

  getAlert(id) {
    const row = this.alerts.get(Number(id));
    return row ? { ...row } : null;
  }

  /** patch: subset of { title, detail, amountMv, ongoing, severity, lat, lng, extra } (as db.js) */
  updateAlert(id, patch, now = Date.now()) {
    const row = this.alerts.get(Number(id));
    if (!row) return false;
    const cols = { title: 'title', detail: 'detail', amountMv: 'amount_mv', ongoing: 'ongoing', severity: 'severity', lat: 'lat', lng: 'lng', extra: 'extra', t: 't' };
    let changed = false;
    for (const [k, col] of Object.entries(cols)) {
      if (!(k in patch)) continue;
      let v = patch[k];
      if (k === 'ongoing') v = !!v;
      if (k === 'severity' && !['critical', 'warning', 'info'].includes(v)) continue;
      if ((k === 'amountMv' || k === 'lat' || k === 'lng') && v !== null && !Number.isFinite(Number(v))) continue;
      if ((k === 'amountMv' || k === 'lat' || k === 'lng') && v !== null) v = Number(v);
      if (k === 't') { if (!Number.isFinite(Number(v))) continue; v = Number(v); }
      row[col] = nz(v);
      changed = true;
    }
    if (!changed) return false;
    row.updated_at = now;
    if (this.out.newAlerts.has(row.id)) this.out.newAlerts.set(row.id, row);
    else this.out.alertUpdates.add(row.id);
    return true;
  }

  /** Fuel drops held back for the 5 h check, among the alerts this tick loaded (tick.js loadBase). */
  pendingDrains() {
    return [...this.alerts.values()].filter((a) => isPendingDrain(a)).map((a) => ({ ...a }));
  }

  queryAlerts() {
    return this.queryAlertRows;
  }

  ackAlert(id, acked = true, now = Date.now()) {
    const row = this.alerts.get(Number(id));
    if (!row) return false;
    row.acked = !!acked;
    row.acked_at = acked ? now : null;
    row.updated_at = now;
    this.out.alertReviews.add(row.id);
    return true;
  }

  ackAll() {
    throw new Error('MemDb.ackAll: done directly in SQL');
  }

  activeCounts() {
    const m = new Map();
    for (const r of this.activeCountRows) {
      let c = m.get(r.imei);
      if (!c) m.set(r.imei, (c = { critical: 0, warning: 0, info: 0 }));
      if (r.severity in c) c[r.severity] = Number(r.n);
    }
    return m;
  }

  ongoingAlerts(imei, type) {
    return [...this.alerts.values()].filter((a) => a.ongoing && a.imei === imei && a.type === type).map((a) => ({ ...a }));
  }

  setReview(id, verdict, note, now = Date.now()) {
    const row = this.alerts.get(Number(id));
    if (!row) return false;
    row.verdict = verdict ?? null;
    row.note = note ?? null;
    row.reviewed_at = now;
    row.updated_at = now;
    this.out.alertReviews.add(row.id);
    return true;
  }

  ledgerAlerts() {
    return this.ledgerAlertRows;
  }

  alertSums() {
    return this.alertSumRows; // loaded for the requested period
  }

  // ---- settings / meta ------------------------------------------------------------
  getSetting(k, fallback = null) {
    return this.settings.has(k) ? structuredClone(this.settings.get(k)) : fallback;
  }

  setSetting(k, v) {
    if (v === null || v === undefined) this.settings.delete(k);
    else this.settings.set(k, structuredClone(v));
    this.out.settings.set(k, v === undefined ? null : v);
  }

  settingsWithPrefix(prefix) {
    const out = {};
    for (const [k, v] of this.settings) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = structuredClone(v);
    return out;
  }

  getMeta(k) {
    return this.meta[k] ?? null;
  }

  setMeta(k, v) {
    this.meta[k] = String(v);
  }

  tx(fn) {
    return fn();
  }

  prune() {
    return { samples: 0, levels: 0, alerts: 0 };
  }

  close() {}
}

export { LEDGER_TYPES, SAMPLE_COLS, VEHICLE_COLS };
