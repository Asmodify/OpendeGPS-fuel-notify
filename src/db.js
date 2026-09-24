// SQLite storage (built-in node:sqlite). One file: <DATA_DIR>/fuel.db
//
// vehicles  last known state of each tracker (from USER_GET_OBJECTS)
// samples   raw tracker messages, PK (imei, t), kept `keepHours`
// levels    trusted (settled, stationary) fuel levels from the detector, kept `keepDays`
// alerts    everything the user is warned about, unique `key` for de-duplication; refuel and
//           fuel_drain alerts are the fuel ledger (Excel file) and are never pruned. verdict /
//           note / reviewed_at: the owner's review of an alert (added by migration)
// settings  JSON key/value: dashboard changes to thresholds, notification and per-vehicle settings
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS vehicles (
  imei TEXT PRIMARY KEY,
  name TEXT, group_name TEXT, device TEXT, plate TEXT, sim TEXT,
  has_fuel INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER, server_seen INTEGER,
  lat REAL, lng REAL, speed REAL, angle REAL,
  ign INTEGER, pwr REAL, fuel_raw REAL, odometer_km REAL,
  status TEXT,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS samples (
  imei TEXT NOT NULL,
  t INTEGER NOT NULL,
  f REAL, spd REAL, ign INTEGER, pwr REAL, lat REAL, lng REAL, odo REAL,
  PRIMARY KEY (imei, t)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS levels (
  imei TEXT NOT NULL,
  t INTEGER NOT NULL,
  mv REAL NOT NULL,
  PRIMARY KEY (imei, t)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS levels_t ON levels (t);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  imei TEXT,
  name TEXT,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  t INTEGER NOT NULL,
  from_t INTEGER,
  lat REAL, lng REAL,
  title TEXT, detail TEXT,
  amount_mv REAL,
  ongoing INTEGER NOT NULL DEFAULT 0,
  acked INTEGER NOT NULL DEFAULT 0,
  acked_at INTEGER,
  historical INTEGER NOT NULL DEFAULT 0,
  extra TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS alerts_t ON alerts (t);
CREATE INDEX IF NOT EXISTS alerts_imei_t ON alerts (imei, t);
CREATE INDEX IF NOT EXISTS alerts_unacked ON alerts (acked, imei);
CREATE INDEX IF NOT EXISTS alerts_ongoing ON alerts (ongoing, imei, type);
CREATE INDEX IF NOT EXISTS alerts_type_t ON alerts (type, t);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

// Columns added after the first release: [name, SQL type]. Added with ALTER TABLE when an
// existing database does not have them yet (new databases get them the same way).
const ALERT_COLUMNS = [
  ['verdict', 'TEXT'], // null = unchecked | 'confirmed' | 'false_alarm'
  ['note', 'TEXT'],
  ['reviewed_at', 'INTEGER'],
];

/** Alert types that make up the fuel ledger: kept forever, written to the Excel file. */
export const LEDGER_TYPES = ['refuel', 'fuel_drain'];

const nz = (x) => (x === undefined || (typeof x === 'number' && !Number.isFinite(x)) ? null : x);

export class Store {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'fuel.db');
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY;');
    this.db.exec(SCHEMA);
    this.migrate();
    const p = (sql) => this.db.prepare(sql);
    this.st = {
      upsertVehicle: p(`INSERT INTO vehicles (imei, name, group_name, device, plate, sim, has_fuel, last_seen, server_seen,
          lat, lng, speed, angle, ign, pwr, fuel_raw, odometer_km, status, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT (imei) DO UPDATE SET name=excluded.name, group_name=excluded.group_name, device=excluded.device,
          plate=excluded.plate, sim=excluded.sim, has_fuel=excluded.has_fuel, last_seen=excluded.last_seen,
          server_seen=excluded.server_seen, lat=excluded.lat, lng=excluded.lng, speed=excluded.speed, angle=excluded.angle,
          ign=excluded.ign, pwr=excluded.pwr, fuel_raw=excluded.fuel_raw, odometer_km=excluded.odometer_km,
          status=excluded.status, updated_at=excluded.updated_at`),
      loadVehicles: p('SELECT * FROM vehicles'),
      insertSample: p('INSERT OR IGNORE INTO samples (imei, t, f, spd, ign, pwr, lat, lng, odo) VALUES (?,?,?,?,?,?,?,?,?)'),
      lastSampleT: p('SELECT MAX(t) AS t FROM samples WHERE imei = ?'),
      firstSampleT: p('SELECT MIN(t) AS t FROM samples WHERE imei = ?'),
      firstSampleAfter: p('SELECT MIN(t) AS t FROM samples WHERE imei = ? AND t > ?'),
      lastMovingBefore: p('SELECT MAX(t) AS t FROM samples WHERE imei = ? AND t <= ? AND spd >= 3'),
      samplesFrom: p('SELECT t, f, spd, ign, pwr, lat, lng, odo FROM samples WHERE imei = ? AND t >= ? ORDER BY t'),
      samplesRange: p('SELECT t, f, spd, ign, pwr, lat, lng, odo FROM samples WHERE imei = ? AND t >= ? AND t <= ? ORDER BY t'),
      pruneSamples: p('DELETE FROM samples WHERE imei = ? AND t < ?'),
      sampleImeis: p('SELECT imei FROM vehicles'),
      insertLevel: p('INSERT OR REPLACE INTO levels (imei, t, mv) VALUES (?,?,?)'),
      levelsRange: p('SELECT t, mv FROM levels WHERE imei = ? AND t >= ? AND t <= ? ORDER BY t'),
      levelsAll: p('SELECT imei, t, mv FROM levels WHERE t >= ? AND t <= ? ORDER BY imei, t'),
      lastLevel: p('SELECT t, mv FROM levels WHERE imei = ? ORDER BY t DESC LIMIT 1'),
      lastLevelBefore: p('SELECT t, mv FROM levels WHERE imei = ? AND t < ? ORDER BY t DESC LIMIT 1'),
      insertAlert: p(`INSERT OR IGNORE INTO alerts (key, imei, name, type, severity, t, from_t, lat, lng, title, detail,
          amount_mv, ongoing, acked, historical, extra, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)`),
      alertIdByKey: p('SELECT id FROM alerts WHERE key = ?'),
      getAlert: p('SELECT * FROM alerts WHERE id = ?'),
      ack: p('UPDATE alerts SET acked = ?, acked_at = ?, updated_at = ? WHERE id = ?'),
      ackAll: p('UPDATE alerts SET acked = 1, acked_at = ?, updated_at = ? WHERE acked = 0'),
      ackAllImei: p('UPDATE alerts SET acked = 1, acked_at = ?, updated_at = ? WHERE acked = 0 AND imei = ?'),
      activeCounts: p('SELECT imei, severity, COUNT(*) AS n FROM alerts WHERE acked = 0 GROUP BY imei, severity'),
      ongoing: p('SELECT * FROM alerts WHERE ongoing = 1 AND imei = ? AND type = ?'),
      alertSums: p(`SELECT imei, type, COUNT(*) AS n, SUM(amount_mv) AS amount FROM alerts
        WHERE t >= ? AND t <= ? GROUP BY imei, type`),
      getSetting: p('SELECT v FROM settings WHERE k = ?'),
      setSetting: p('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v'),
      delSetting: p('DELETE FROM settings WHERE k = ?'),
      settingsLike: p('SELECT k, v FROM settings WHERE k LIKE ?'),
      pruneLevels: p('DELETE FROM levels WHERE t < ?'),
      // refuels and fuel drains are the permanent fuel ledger: never pruned
      pruneAlerts: p(`DELETE FROM alerts WHERE t < ? AND type NOT IN (${LEDGER_TYPES.map((x) => `'${x}'`).join(', ')})`),
      ledgerAlerts: p(`SELECT * FROM alerts WHERE type IN (${LEDGER_TYPES.map((x) => `'${x}'`).join(', ')})
        ORDER BY t DESC, id DESC`),
      setReview: p('UPDATE alerts SET verdict = ?, note = ?, reviewed_at = ?, updated_at = ? WHERE id = ?'),
      firstSampleEver: p('SELECT MIN(t) AS t FROM samples'),
      getMeta: p('SELECT v FROM meta WHERE k = ?'),
      setMeta: p('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v'),
      groups: p('SELECT DISTINCT group_name AS g FROM vehicles WHERE group_name IS NOT NULL ORDER BY group_name'),
      // Per vehicle (uses the samples primary key). Engine time follows the detector's rule:
      // moving with ignition not off, or stopped with ignition on AND the external voltage at
      // alternator-charging level (many trackers report ignition=1 with the engine off).
      // Parameters: thr24 (24 V systems), thr12 (12 V systems), imei, from, to.
      motionStats: p(`SELECT COUNT(*) AS n,
          SUM(CASE WHEN podo IS NOT NULL AND odo IS NOT NULL AND odo >= podo AND (odo - podo) <= (t - pt) * 0.07 + 1000
                   THEN odo - podo ELSE 0 END) AS odo_m,
          SUM(CASE WHEN podo IS NOT NULL AND odo IS NOT NULL THEN 1 ELSE 0 END) AS odo_pairs,
          SUM(CASE WHEN t - pt <= 300000 AND (
                     (pspd >= 3 AND (pign IS NULL OR pign <> 0))
                     OR ((pspd IS NULL OR pspd < 3) AND pign = 1
                         AND (ppwr IS NULL OR ppwr >= (CASE WHEN ppwr > 18000 THEN ? ELSE ? END))))
                   THEN t - pt ELSE 0 END) AS engine_ms,
          MAX(spd) AS max_spd
        FROM (SELECT t, odo, spd,
                     LAG(t) OVER w AS pt, LAG(odo) OVER w AS podo, LAG(ign) OVER w AS pign,
                     LAG(spd) OVER w AS pspd, LAG(pwr) OVER w AS ppwr
              FROM samples WHERE imei = ? AND t >= ? AND t <= ?
              WINDOW w AS (ORDER BY t))`),
      fuelEvents: p(`SELECT imei, type, severity, title, t, from_t, amount_mv, extra, verdict FROM alerts
        WHERE type IN (${LEDGER_TYPES.map((x) => `'${x}'`).join(', ')}) AND t >= ? AND t <= ?
        ORDER BY imei, COALESCE(from_t, t)`),
    };
  }

  /** Brings an existing database up to date (safe to run on every start). */
  migrate() {
    const have = new Set(this.db.prepare('PRAGMA table_info(alerts)').all().map((c) => c.name));
    for (const [name, type] of ALERT_COLUMNS) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE alerts ADD COLUMN ${name} ${type}`);
    }
    this.db.prepare("INSERT INTO meta (k, v) VALUES ('schema', '2') ON CONFLICT (k) DO UPDATE SET v = excluded.v").run();
  }

  getMeta(k) {
    return this.st.getMeta.get(k)?.v ?? null;
  }

  setMeta(k, v) {
    this.st.setMeta.run(k, String(v));
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  // ---- vehicles ----------------------------------------------------------------
  upsertVehicles(list, now = Date.now()) {
    this.tx(() => {
      for (const v of list) {
        this.st.upsertVehicle.run(v.imei, nz(v.name), nz(v.group), nz(v.device), nz(v.plate), nz(v.sim), v.hasFuel ? 1 : 0,
          nz(v.lastSeen), nz(v.serverSeen), nz(v.lat), nz(v.lng), nz(v.speed), nz(v.angle), nz(v.ign), nz(v.pwr),
          nz(v.fuelRaw), nz(v.odometerKm), nz(v.status), now);
      }
    });
  }

  loadVehicles() {
    return this.st.loadVehicles.all();
  }

  groups() {
    return this.st.groups.all().map((r) => r.g);
  }

  // ---- samples -----------------------------------------------------------------
  /** samples: [{t,f,spd,ign,pwr,lat,lng,odo}] sorted; returns number inserted */
  insertSamples(imei, samples) {
    if (!samples.length) return 0;
    return this.tx(() => {
      let n = 0;
      for (const s of samples) {
        n += Number(this.st.insertSample.run(imei, s.t, nz(s.f), nz(s.spd), nz(s.ign), nz(s.pwr), nz(s.lat), nz(s.lng), nz(s.odo)).changes);
      }
      return n;
    });
  }

  lastSampleT(imei) {
    return this.st.lastSampleT.get(imei)?.t ?? null;
  }

  firstSampleAfter(imei, t) {
    return this.st.firstSampleAfter.get(imei, t)?.t ?? null;
  }

  /** Where to start replaying: the last moving sample before `cut` (so replay begins in a
   *  trip, not in the middle of a stop), or the oldest stored sample. */
  replayStart(imei, cut) {
    return this.st.lastMovingBefore.get(imei, cut)?.t ?? this.st.firstSampleT.get(imei)?.t ?? null;
  }

  samplesFrom(imei, fromT) {
    return this.st.samplesFrom.all(imei, fromT);
  }

  samplesRange(imei, from, to) {
    return this.st.samplesRange.all(imei, from, to);
  }

  /** Distance / engine time / max speed of one vehicle (null without samples);
   *  thr24 / thr12 = external voltage (mV) above which a stopped engine counts as running. */
  motionStats(imei, from, to, thr24 = 26400, thr12 = 13300) {
    const r = this.st.motionStats.get(thr24, thr12, imei, from, to);
    return r && r.n ? r : null;
  }

  /** refuel / fuel_drain alerts detected in [from, to] (also cancelled drains, whose amount is
   *  null, and the owner's verdict: see ledger.js ledgerEntry). */
  fuelEvents(from, to) {
    return this.st.fuelEvents.all(from, to);
  }

  // ---- levels ------------------------------------------------------------------
  insertLevel(imei, t, mv) {
    this.st.insertLevel.run(imei, t, mv);
  }

  levelsRange(imei, from, to) {
    return this.st.levelsRange.all(imei, from, to);
  }

  levelsAll(from, to) {
    return this.st.levelsAll.all(from, to);
  }

  lastLevel(imei) {
    return this.st.lastLevel.get(imei) ?? null;
  }

  lastLevelBefore(imei, t) {
    return this.st.lastLevelBefore.get(imei, t) ?? null;
  }

  // ---- alerts ------------------------------------------------------------------
  /** Insert unless the key exists. Returns { id, inserted }. */
  insertAlert(a, now = Date.now()) {
    const r = this.st.insertAlert.run(a.key, nz(a.imei), nz(a.name), a.type, a.severity, a.t, nz(a.fromT), nz(a.lat), nz(a.lng),
      nz(a.title), nz(a.detail), nz(a.amountMv), a.ongoing ? 1 : 0, a.historical ? 1 : 0, nz(a.extra), now, now);
    if (Number(r.changes) > 0) return { id: Number(r.lastInsertRowid), inserted: true };
    return { id: this.alertIdByKey(a.key), inserted: false };
  }

  alertIdByKey(key) {
    return this.st.alertIdByKey.get(key)?.id ?? null;
  }

  getAlert(id) {
    return this.st.getAlert.get(id) ?? null;
  }

  /** patch: subset of { title, detail, amountMv, ongoing, severity, lat, lng, extra (JSON text) } */
  updateAlert(id, patch, now = Date.now()) {
    const cols = { title: 'title', detail: 'detail', amountMv: 'amount_mv', ongoing: 'ongoing', severity: 'severity', lat: 'lat', lng: 'lng', extra: 'extra' };
    const sets = [];
    const vals = [];
    for (const [k, col] of Object.entries(cols)) {
      if (!(k in patch)) continue;
      let v = patch[k];
      if (k === 'ongoing') v = v ? 1 : 0;
      if (k === 'severity' && !['critical', 'warning', 'info'].includes(v)) continue;
      if ((k === 'amountMv' || k === 'lat' || k === 'lng') && v !== null && !Number.isFinite(Number(v))) continue;
      sets.push(`${col} = ?`);
      vals.push(nz(v));
    }
    if (!sets.length) return false;
    sets.push('updated_at = ?');
    vals.push(now, id);
    return Number(this.db.prepare(`UPDATE alerts SET ${sets.join(', ')} WHERE id = ?`).run(...vals).changes) > 0;
  }

  queryAlerts({ imei, severities, types, since, until, unacked, limit = 200, beforeId } = {}) {
    const where = [];
    const vals = [];
    if (imei) {
      where.push('imei = ?');
      vals.push(imei);
    }
    if (severities?.length) {
      where.push(`severity IN (${severities.map(() => '?').join(',')})`);
      vals.push(...severities);
    }
    if (types?.length) {
      where.push(`type IN (${types.map(() => '?').join(',')})`);
      vals.push(...types);
    }
    if (Number.isFinite(since)) {
      where.push('t >= ?');
      vals.push(since);
    }
    if (Number.isFinite(until)) {
      where.push('t <= ?');
      vals.push(until);
    }
    if (unacked) where.push('acked = 0');
    if (Number.isFinite(beforeId)) {
      where.push('id < ?');
      vals.push(beforeId);
    }
    const sql = `SELECT * FROM alerts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t DESC, id DESC LIMIT ?`;
    vals.push(limit);
    return this.db.prepare(sql).all(...vals);
  }

  ackAlert(id, acked = true, now = Date.now()) {
    return Number(this.st.ack.run(acked ? 1 : 0, acked ? now : null, now, id).changes) > 0;
  }

  ackAll(imei, now = Date.now()) {
    const r = imei ? this.st.ackAllImei.run(now, now, imei) : this.st.ackAll.run(now, now);
    return Number(r.changes);
  }

  activeCounts() {
    const m = new Map();
    for (const r of this.st.activeCounts.all()) {
      let c = m.get(r.imei);
      if (!c) m.set(r.imei, (c = { critical: 0, warning: 0, info: 0 }));
      if (r.severity in c) c[r.severity] = r.n;
    }
    return m;
  }

  ongoingAlerts(imei, type) {
    return this.st.ongoing.all(imei, type);
  }

  /** Owner's review: verdict null (unchecked) | 'confirmed' | 'false_alarm', note text or null. */
  setReview(id, verdict, note, now = Date.now()) {
    return Number(this.st.setReview.run(verdict ?? null, note ?? null, now, now, id).changes) > 0;
  }

  /** Every refuel and fuel_drain alert ever stored, newest first (the fuel ledger). */
  ledgerAlerts() {
    return this.st.ledgerAlerts.all();
  }

  /** Oldest stored sample of any vehicle (null without samples). */
  firstSampleEver() {
    return this.st.firstSampleEver.get()?.t ?? null;
  }

  alertSums(from, to) {
    return this.st.alertSums.all(from, to);
  }

  // ---- settings ----------------------------------------------------------------
  getSetting(k, fallback = null) {
    const r = this.st.getSetting.get(k);
    if (!r) return fallback;
    try {
      return JSON.parse(r.v);
    } catch {
      return fallback;
    }
  }

  setSetting(k, v) {
    if (v === null || v === undefined) this.st.delSetting.run(k);
    else this.st.setSetting.run(k, JSON.stringify(v));
  }

  settingsWithPrefix(prefix) {
    const out = {};
    for (const r of this.st.settingsLike.all(prefix + '%')) {
      try {
        out[r.k.slice(prefix.length)] = JSON.parse(r.v);
      } catch {
        /* skip broken */
      }
    }
    return out;
  }

  // ---- maintenance ---------------------------------------------------------------
  prune(samplesBefore, oldBefore) {
    let samples = 0;
    this.tx(() => {
      for (const { imei } of this.st.sampleImeis.all()) samples += Number(this.st.pruneSamples.run(imei, samplesBefore).changes);
    });
    const levels = Number(this.st.pruneLevels.run(oldBefore).changes);
    const alerts = Number(this.st.pruneAlerts.run(oldBefore).changes);
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;');
    } catch {
      /* ignore */
    }
    return { samples, levels, alerts };
  }

  close() {
    try {
      this.db.exec('PRAGMA optimize;');
    } catch {
      /* ignore */
    }
    this.db.close();
  }
}

export function openDb(dataDir) {
  return new Store(dataDir);
}
