// Core state: one record per vehicle (last known position/status + its VehicleDetector),
// alert creation/de-duplication, settings (config.json base + dashboard overrides in the DB),
// and the JSON views served by the HTTP API.
import { DEFAULT_THRESHOLDS, DEFAULT_CALIBRATION, CHECK_MIN_MINUTES, CHECK_MAX_MINUTES, clampCheckMinutes } from './config.js';
import { LEDGER_TYPES } from './db.js';
import { ledgerEntry, litersAt, fuelPct, amountLitres, fuelEventLitres, isPendingDrain, parseExtra } from './ledger.js';
import {
  log, errText, num, int01, clamp, round, fromApiDate, shortName, haversineM, fmtDuration, fmtLocal,
  tzOffsetMinutes, parseHHMM, isPlainObject, deepMerge,
} from './util.js';

const SEVERITIES = ['critical', 'warning', 'info'];
const HOUR = 3600e3;
const MIN = 60e3;
const DRAIN_CONFIRM_MS = 5 * HOUR; // a fuel drop must stay down this long before it is alerted
const PENDING_TITLE = 'Possible fuel drop — checking (5 h)';
const FALSE_ALARM_TITLE = 'False alarm — fuel sensor misreading (level came back)';
const HOLD_MIN_MS = 20 * MIN; // after a gap in the data, wait at least this long for the backlog
const HOLD_MAX_MS = 2 * HOUR; // ...and at most this long

/** Alert types the backend itself can produce, plus fallbacks for the detector's types. */
export const BACKEND_ALERT_TYPES = {
  fuel_drain: { severity: 'critical', label: 'Fuel drain' },
  power_cut: { severity: 'critical', label: 'Tracker power cut' },
  sensor_lost: { severity: 'warning', label: 'Fuel sensor lost' },
  low_fuel: { severity: 'warning', label: 'Low fuel' },
  long_idle: { severity: 'warning', label: 'Long idle' },
  overspeed: { severity: 'warning', label: 'Overspeed' },
  offline: { severity: 'warning', label: 'Offline' },
  server_event: { severity: 'warning', label: 'GPS server event' },
  after_hours: { severity: 'warning', label: 'After-hours movement' },
  refuel: { severity: 'info', label: 'Refuel' },
  sensor_restored: { severity: 'info', label: 'Fuel sensor restored' },
  power_restored: { severity: 'info', label: 'Power restored' },
  back_online: { severity: 'info', label: 'Back online' },
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const KNOWN_ALERT_FIELDS = new Set(['key', 'imei', 'name', 'type', 'severity', 't', 'fromT', 'lat', 'lng', 'title', 'detail', 'amountMv', 'ongoing']);
// alert fields a detector update may change directly; other keys (e.g. toMv) go into `extra`
const PATCH_COLUMNS = new Set(['title', 'detail', 'amountMv', 'ongoing', 'severity', 'lat', 'lng']);

/** Owner's verdict on an alert (stored as null / 'confirmed' / 'false_alarm'). */
export const VERDICTS = ['unchecked', 'confirmed', 'false_alarm'];
export const NOTE_MAX = 500;

export class Engine {
  constructor({ cfg, db, hub }) {
    this.cfg = cfg;
    this.db = db;
    this.hub = hub;
    this.notifier = null; // set by server.js
    this.ledger = null; // Excel fuel ledger (set by main.js): told about refuel / fuel_drain changes
    this.recs = new Map(); // imei -> vehicle record
    this.DetectorClass = null;
    this.detectorError = null;
    this.alertTypes = { ...BACKEND_ALERT_TYPES };
    this.detectorCallsOnLevel = false;
    this.backendAfterHours = true;
    this.fakeId = 0; // negative ids handed to detectors for alerts suppressed during replay
    this.settingsCache = new Map();
    this.summaryCache = new Map();
    this.tzOffsetMin = tzOffsetMinutes(cfg.timezone);
    this.stats = { alertsCreated: 0, samplesIngested: 0, lateRows: 0, heldVehicles: 0, replaySamples: 0, replayMs: 0, detectorErrors: 0 };
    this.startedAt = Date.now();
    this.historyReady = false; // set by the poller once the start-up backfill is done
    this.backfilling = false; // true while the poller loads history (the Excel ledger waits for the end)
    this.lastObjCount = 0; // vehicles in the last USER_GET_OBJECTS answer
    this.lastObjectsAt = null; // when the fleet's newest points were last fetched (statuses are judged as of then)
    this.eventFirstSeen = new Map(); // server events without a time: key -> first seen
    this.learned = this.db.settingsWithPrefix('learned:'); // detector state kept across restarts
    this.loadSettings();
  }

  // =============================================================================
  // startup
  // =============================================================================
  async loadDetector() {
    try {
      const mod = await import('./detector.js');
      this.DetectorClass = typeof mod.VehicleDetector === 'function' ? mod.VehicleDetector : null;
      if (!this.DetectorClass) throw new Error('detector.js does not export VehicleDetector');
      if (isPlainObject(mod.ALERT_TYPES)) {
        for (const [type, meta] of Object.entries(mod.ALERT_TYPES)) {
          if (!isPlainObject(meta)) continue;
          this.alertTypes[type] = { ...(this.alertTypes[type] || {}), ...meta };
          if (!SEVERITIES.includes(this.alertTypes[type].severity)) this.alertTypes[type].severity = 'warning';
          if (!this.alertTypes[type].label) this.alertTypes[type].label = type;
        }
      }
      const src = Function.prototype.toString.call(this.DetectorClass);
      // Final detector reports trusted levels through onLevel; the early draft did not, in
      // which case we sample its state after every push instead.
      this.detectorCallsOnLevel = /onLevel/.test(src);
      // Movement after hours is done here unless the detector implements it itself.
      this.backendAfterHours = !/after_hours/.test(src);
    } catch (e) {
      this.detectorError = errText(e);
      log('error', 'Could not load src/detector.js - running without fuel/anomaly detection:', e);
    }
  }

  /** Build records for vehicles known from the database (before the API has answered). */
  loadVehiclesFromDb() {
    for (const row of this.db.loadVehicles()) {
      const rec = this.addRec(row.imei, {
        name: row.name ?? row.imei,
        group: row.group_name ?? null,
        device: row.device ?? null,
        plate: row.plate ?? null,
        sim: row.sim ?? null,
        lastSeen: row.last_seen ?? null,
        serverSeen: row.server_seen ?? null,
        lat: row.lat, lng: row.lng, speed: row.speed ?? 0, angle: row.angle,
        ign: row.ign, pwr: row.pwr, fuelRaw: row.fuel_raw, odometerKm: row.odometer_km,
        status: row.status ?? null,
      }, !!row.has_fuel);
      rec.dbStatus = row.status ?? null;
    }
  }

  addRec(imei, info, hasFuel) {
    const rec = {
      imei,
      v: { imei, name: info.name ?? imei, hasFuel: !!hasFuel }, // object handed to the detector
      info: { ...info },
      det: null,
      mode: 'live', // 'replay' | 'backfill' | 'live' while samples are being pushed
      detT: -Infinity, // last sample time pushed to the detector
      lastT: this.db.lastSampleT(imei), // last stored sample time
      fetchedSeen: null, // dt_tracker at the last successful fetch
      historicalNext: true, // next fetch is a (historical) backfill
      fetchFloor: null,
      fetching: false,
      lastLevel: this.db.lastLevel(imei), // last stored trusted level {t, mv}
      polledLevelT: null,
      offline: undefined, // unknown until the first objects poll
      offlineFrom: null,
      dbStatus: null,
      afterHoursNight: null,
      detErrors: 0,
      lastPushed: null, // last sample handed to the detector
      hold: null, // { from, since }: data gap after activity - waiting for the tracker's backlog
      staleOfflineChecked: false,
      learnedJson: JSON.stringify(this.learned[imei] ?? null),
      futureLogged: false,
    };
    rec.det = this.makeDetector(rec);
    this.recs.set(imei, rec);
    return rec;
  }

  makeDetector(rec) {
    if (!this.DetectorClass) return null;
    try {
      return new this.DetectorClass(
        rec.v,
        () => this.settingsFor(rec.imei),
        (alert) => this.onDetectorEmit(rec, alert),
        (id, patch) => this.onDetectorUpdate(rec, id, patch),
        (t, mv) => this.onLevel(rec, t, mv, false),
      );
    } catch (e) {
      log('error', `Detector for ${rec.imei} could not be created:`, e);
      return null;
    }
  }

  /** Re-feed recently stored samples so detectors resume where they were before a restart.
   *  Alerts found again are matched to stored ones by key; nothing new is created. */
  replay() {
    const t0 = Date.now();
    const cut = t0 - this.cfg.replayHours * HOUR;
    let n = 0;
    for (const rec of this.recs.values()) {
      if (!rec.det || rec.lastT == null) continue;
      const start = this.db.replayStart(rec.imei, cut);
      if (start == null) continue;
      const rows = this.db.samplesFrom(rec.imei, start);
      this.pushSamples(rec, rows, 'replay');
      n += rows.length;
    }
    this.stats.replaySamples = n;
    this.stats.replayMs = Date.now() - t0;
    log('info', `Replayed ${n} stored samples for ${this.recs.size} vehicles in ${this.stats.replayMs} ms`);
  }

  allRecs() {
    return [...this.recs.values()];
  }

  // =============================================================================
  // settings
  // =============================================================================
  loadSettings() {
    const g = this.db.getSetting('global', {});
    this.globalOverrides = {
      thresholds: isPlainObject(g?.thresholds) ? g.thresholds : {},
      notify: isPlainObject(g?.notify) ? g.notify : {},
      poll: isPlainObject(g?.poll) ? g.poll : {},
    };
    delete this.globalOverrides.notify.telegram; // (removed feature; may still be stored)
    this.vehicleSettings = this.db.settingsWithPrefix('vehicle:');
    this.settingsCache.clear();
  }

  thresholds() {
    return { ...this.cfg.thresholds, ...this.globalOverrides.thresholds };
  }

  notifySettings() {
    return deepMerge(this.cfg.notify, this.globalOverrides.notify);
  }

  /** "Check every": minutes between GPS-server checks (dashboard setting > config.json). */
  checkEveryMinutes() {
    return clampCheckMinutes(this.globalOverrides.poll.checkMinutes, this.cfg.checkEveryMinutes);
  }

  checkEveryMs() {
    return this.checkEveryMinutes() * MIN;
  }

  /** Effective calibration: user setting > table from calibrations.json > config default.
   *  `source` tells which; `table` ([[mV, litres], ...]) only when the GPS-server table applies. */
  vehicleCal(imei) {
    const base = { ...DEFAULT_CALIBRATION, ...this.cfg.defaultCalibration };
    const file = this.cfg.calibrations?.[imei];
    const over = this.vehicleSettings[imei]?.cal;
    const linear = file ? { emptyMv: file.emptyMv, fullMv: file.fullMv, tankLiters: file.tankLiters } : {};
    if (isPlainObject(over) && Object.keys(over).length) return { ...base, ...linear, ...over, source: 'user' };
    if (file) return { ...base, ...linear, table: file.table, source: 'gps-server' };
    return { ...base, source: 'default' };
  }

  /** Litres in the tank for a sensor reading (table interpolation when available). */
  litersAt(mv, cal) {
    return litersAt(mv, cal);
  }

  /** getSettings() for detectors: { th, cal }. Cached; called for every sample. */
  settingsFor(imei) {
    let s = this.settingsCache.get(imei);
    if (!s) {
      const vth = this.vehicleSettings[imei]?.th;
      // tzOffsetMinutes: local-time offset for the detector's after-hours window
      const th = { tzOffsetMinutes: this.tzOffsetMin, ...this.thresholds(), ...(isPlainObject(vth) ? vth : {}) };
      // consumption the detector learned before the last restart (seeds it once)
      const lr = this.learned[imei]?.rates;
      if (Array.isArray(lr)) th.learnedRates = lr;
      s = { th, cal: this.vehicleCal(imei) };
      this.settingsCache.set(imei, s);
    }
    return s;
  }

  isMuted(imei) {
    return !!this.vehicleSettings[imei]?.muted;
  }

  settingsView() {
    const n = this.notifySettings();
    const vehicles = {};
    for (const rec of this.recs.values()) {
      const vs = this.vehicleSettings[rec.imei] || {};
      vehicles[rec.imei] = { cal: this.vehicleCal(rec.imei), th: isPlainObject(vs.th) ? vs.th : {}, muted: !!vs.muted };
    }
    return {
      thresholds: this.thresholds(),
      baseThresholds: { ...this.cfg.thresholds },
      defaultCalibration: { ...DEFAULT_CALIBRATION, ...this.cfg.defaultCalibration },
      notify: {
        windowsToast: !!n.windowsToast,
        severities: Array.isArray(n.severities) ? n.severities : ['critical', 'warning'],
        throttleMinutes: Number(n.throttleMinutes ?? 10),
      },
      poll: { checkMinutes: this.checkEveryMinutes(), baseCheckMinutes: this.cfg.checkEveryMinutes, minMinutes: CHECK_MIN_MINUTES, maxMinutes: CHECK_MAX_MINUTES },
      vehicles,
    };
  }

  static cleanThresholds(obj, what = 'thresholds') {
    if (!isPlainObject(obj)) throw bad(`${what} must be an object`);
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k)) throw bad(`invalid threshold name "${k}"`);
      if (v === null) {
        out[k] = null; // remove override
        continue;
      }
      const def = DEFAULT_THRESHOLDS[k];
      if (k === 'afterHoursStart' || k === 'afterHoursEnd') {
        const m = parseHHMM(v);
        if (m === null) throw bad(`${k} must be a time like "22:00"`);
        out[k] = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      } else if (typeof def === 'boolean' || (def === undefined && typeof v === 'boolean')) {
        if (typeof v !== 'boolean') throw bad(`${k} must be true or false`);
        out[k] = v;
      } else {
        const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
        if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw bad(`${k} must be a number >= 0`);
        out[k] = n;
      }
    }
    return out;
  }

  static applyOverrides(current, changes) {
    const out = { ...(isPlainObject(current) ? current : {}) };
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) delete out[k];
      else out[k] = v;
    }
    return out;
  }

  /** PUT /api/settings */
  putSettings(body) {
    if (!isPlainObject(body)) throw bad('body must be a JSON object');
    const next = { thresholds: { ...this.globalOverrides.thresholds }, notify: structuredClone(this.globalOverrides.notify), poll: { ...this.globalOverrides.poll } };
    if (body.thresholds !== undefined) {
      next.thresholds = Engine.applyOverrides(next.thresholds, Engine.cleanThresholds(body.thresholds));
    }
    if (body.notify !== undefined) {
      const n = body.notify;
      if (!isPlainObject(n)) throw bad('notify must be an object');
      if (n.windowsToast !== undefined) {
        if (typeof n.windowsToast !== 'boolean') throw bad('notify.windowsToast must be true or false');
        next.notify.windowsToast = n.windowsToast;
      }
      if (n.severities !== undefined) {
        if (!Array.isArray(n.severities) || n.severities.some((s) => !SEVERITIES.includes(s))) {
          throw bad('notify.severities must be a list of critical / warning / info');
        }
        next.notify.severities = [...new Set(n.severities)];
      }
      if (n.throttleMinutes !== undefined) {
        const t = Number(n.throttleMinutes);
        if (!Number.isFinite(t) || t < 0 || t > 1440) throw bad('notify.throttleMinutes must be 0..1440');
        next.notify.throttleMinutes = t;
      }
    }
    if (body.poll !== undefined) {
      if (!isPlainObject(body.poll)) throw bad('poll must be an object');
      if (body.poll.checkMinutes !== undefined) {
        if (body.poll.checkMinutes === null) delete next.poll.checkMinutes;
        else {
          const m = Number(body.poll.checkMinutes);
          if (!Number.isFinite(m) || m < CHECK_MIN_MINUTES || m > CHECK_MAX_MINUTES) throw bad(`poll.checkMinutes must be ${CHECK_MIN_MINUTES}..${CHECK_MAX_MINUTES} (minutes)`);
          next.poll.checkMinutes = Math.round(m);
        }
      }
    }
    this.db.setSetting('global', next);
    this.loadSettings();
    this.summaryCache.clear();
    return this.settingsView();
  }

  /** PUT /api/vehicles/:imei/settings */
  putVehicleSettings(imei, body) {
    const rec = this.recs.get(imei);
    if (!rec) throw new HttpError(404, 'unknown vehicle');
    if (!isPlainObject(body)) throw bad('body must be a JSON object');
    const cur = this.vehicleSettings[imei] || {};
    const next = { ...cur };
    if (body.cal !== undefined) {
      if (body.cal === null) delete next.cal;
      else {
        if (!isPlainObject(body.cal)) throw bad('cal must be an object');
        const cal = { ...(isPlainObject(cur.cal) ? cur.cal : {}) };
        for (const k of ['emptyMv', 'fullMv']) {
          if (body.cal[k] === undefined) continue;
          if (body.cal[k] === null) {
            delete cal[k];
            continue;
          }
          const v = Number(body.cal[k]);
          if (!Number.isFinite(v) || v < -1000 || v > 100000) throw bad(`cal.${k} must be a number of millivolts`);
          cal[k] = v;
        }
        if (body.cal.tankLiters !== undefined) {
          const tl = body.cal.tankLiters;
          if (tl === null || tl === '' || tl === 0) cal.tankLiters = null;
          else {
            const v = Number(tl);
            if (!Number.isFinite(v) || v <= 0 || v > 100000) throw bad('cal.tankLiters must be a positive number of litres (or null)');
            cal.tankLiters = v;
          }
        }
        const eff = { ...DEFAULT_CALIBRATION, ...this.cfg.defaultCalibration, ...cal };
        if (eff.fullMv === eff.emptyMv) throw bad('cal.fullMv and cal.emptyMv must be different');
        // The dashboard sends the calibration shown in its form with every save (e.g. when
        // only "mute" was changed). If it equals what the vehicle inherits anyway (the GPS
        // server's table or the config default), keep no override, so the exact piecewise
        // table stays in use instead of being replaced by its linear end points.
        const file = this.cfg.calibrations?.[imei];
        const inherited = file
          ? { emptyMv: file.emptyMv, fullMv: file.fullMv, tankLiters: file.tankLiters }
          : { ...DEFAULT_CALIBRATION, ...this.cfg.defaultCalibration };
        const same = (a, b) => (a ?? null) === (b ?? null) || (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.5);
        const isInherited = ['emptyMv', 'fullMv', 'tankLiters'].every((k) => same(k in cal ? cal[k] : inherited[k], inherited[k]));
        if (isInherited) delete next.cal;
        else next.cal = cal;
      }
    }
    if (body.th !== undefined) {
      if (body.th === null) delete next.th;
      else next.th = Engine.applyOverrides(cur.th, Engine.cleanThresholds(body.th, 'th'));
      if (next.th && !Object.keys(next.th).length) delete next.th;
    }
    if (body.muted !== undefined) {
      if (typeof body.muted !== 'boolean') throw bad('muted must be true or false');
      if (body.muted) next.muted = true;
      else delete next.muted;
    }
    this.db.setSetting(`vehicle:${imei}`, Object.keys(next).length ? next : null);
    this.loadSettings();
    this.summaryCache.clear();
    if (body.cal !== undefined) this.ledger?.touch('calibration'); // litres in the Excel ledger follow the tank size
    const vs = this.vehicleSettings[imei] || {};
    return {
      vehicle: this.vehicleView(rec, this.db.activeCounts().get(imei), Date.now()),
      settings: { cal: this.vehicleCal(imei), th: isPlainObject(vs.th) ? vs.th : {}, muted: !!vs.muted },
    };
  }

  // =============================================================================
  // objects poll -> vehicle state, status, offline / back online
  // =============================================================================
  applyObjects(objs, now = Date.now()) {
    const c = this.cfg;
    let added = 0;
    let seen = 0;
    this.lastObjectsAt = now;
    // a tracker clock in the future must not freeze the vehicle's status / data fetching
    const notFuture = (t) => (t === null ? null : Math.min(t, now));
    for (const o of objs) {
      if (!isPlainObject(o) || o.imei === undefined || o.imei === null || o.imei === '') continue;
      seen++;
      const imei = String(o.imei).trim();
      const p = isPlainObject(o.params) ? o.params : {};
      const info = {
        name: String(o.name ?? imei),
        group: o.group_name === undefined || o.group_name === '' ? null : o.group_name,
        device: o.device ?? null,
        plate: o.plate_number || null,
        sim: o.sim_number || null,
        lastSeen: notFuture(fromApiDate(o.dt_tracker)),
        serverSeen: notFuture(fromApiDate(o.dt_server)),
        lat: num(o.lat),
        lng: num(o.lng),
        speed: num(o.speed) ?? 0,
        angle: num(o.angle),
        ign: int01(p[c.ignitionParam]),
        pwr: num(p[c.powerParam]),
        fuelRaw: num(p[c.fuelParam]),
        odometerKm: num(o.odometer),
      };
      const hasFuel = p[c.fuelParam] !== undefined;
      let rec = this.recs.get(imei);
      if (!rec) {
        rec = this.addRec(imei, info, hasFuel);
        added++;
      } else {
        Object.assign(rec.info, info);
        rec.v.name = info.name;
        if (hasFuel) rec.v.hasFuel = true;
      }
      // the newest point as an OBJECT_GET_MESSAGES row, for objects-first polling (poller.js)
      rec.objRow = [o.dt_tracker, o.lat, o.lng, o.altitude, o.angle, o.speed, p];
    }
    // An answer missing most of the fleet is a server glitch, not the fleet going offline.
    const partial = this.lastObjCount >= 4 && seen < this.lastObjCount * 0.5;
    if (partial) log('warn', `GPS server listed only ${seen} of ${this.lastObjCount} vehicles - offline checks skipped this time`);
    else this.lastObjCount = seen;
    for (const rec of this.recs.values()) {
      const st = this.computeStatus(rec, now);
      rec.info.status = st;
      if (!partial) this.checkOffline(rec, st, now);
    }
    try {
      this.db.upsertVehicles([...this.recs.values()].map((r) => ({ ...r.info, imei: r.imei, hasFuel: r.v.hasFuel })), now);
    } catch (e) {
      log('error', 'Saving vehicles failed:', e);
    }
    return { total: this.recs.size, added };
  }

  computeStatus(rec, now = Date.now()) {
    const i = rec.info;
    if (!i.lastSeen) return 'offline';
    const th = this.settingsFor(rec.imei).th;
    // Judged as of the last objects poll: a vehicle is "offline" when the GPS server had heard
    // nothing from it for offlineMinutes *at that time*. The checks may be 30 min or more apart,
    // and a report the tracker sent since then is simply not known yet.
    const asOf = this.lastObjectsAt === null ? now : Math.min(now, this.lastObjectsAt);
    const age = asOf - i.lastSeen;
    const stationary = !((i.speed ?? 0) >= 3);
    // parked trackers report only about hourly, so they get extra time before "offline"
    const limit = (Number(th.offlineMinutes) || 60) * MIN + (stationary ? this.cfg.parkedReportMinutes * MIN : 0);
    if (age > limit) return 'offline';
    if (!stationary) return 'moving';
    // Idling = stopped with the engine running, and only while the tracker still reports
    // frequently (hourly "parked" reporting is not idling). Ignition alone is stuck at 1 on
    // many trackers, so the engine must also be charging (the detector's rule) or the
    // detector must be in an idle episode.
    if (i.ign === 0 || age > 15 * MIN) return 'parked';
    // (idle needs the frequent reports of a running engine: with sparse checks it falls back
    // to the detector's judgement of the last samples)
    const st = this.detState(rec);
    if (Number.isFinite(st?.idleSince)) return 'idle';
    if (i.ign === 1 && this.engineOnPower(i.pwr, st?.runV)) return 'idle';
    return 'parked';
  }

  /** Engine-running voltage rule shared with the detector and the report: 26.4 V on 24 V
   *  systems (13.3 V on 12 V), or 1 V under the vehicle's own driving voltage if lower. */
  engineOnPower(pwr, runV) {
    if (pwr === null || pwr === undefined) return true;
    const base = pwr > 18000 ? 26400 : 13300;
    return pwr >= (Number.isFinite(runV) ? Math.min(base, runV - 1000) : base);
  }

  checkOffline(rec, st, now) {
    const i = rec.info;
    const tz = this.cfg.timezone;
    if (st === 'offline') {
      const firstLook = rec.offline === undefined;
      const wasOnline = rec.offline === false
        // first look after a restart: it was online when we last saw it and went quiet recently
        || (firstLook && rec.dbStatus && rec.dbStatus !== 'offline' && i.lastSeen && now - i.lastSeen < 24 * HOUR);
      if (rec.offline !== true) rec.offlineFrom = i.lastSeen ?? null;
      if (wasOnline && i.lastSeen) {
        const moving = (i.speed ?? 0) >= 3;
        // went quiet while the program was not running: recorded, but not popped up as news
        const mode = firstLook && i.lastSeen < this.startedAt ? 'backfill' : 'live';
        this.raiseAlert({
          imei: rec.imei, name: rec.v.name, type: 'offline', severity: 'warning', t: now, fromT: i.lastSeen,
          lat: i.lat, lng: i.lng, ongoing: true,
          title: 'Tracker stopped reporting',
          detail: `No data for ${fmtDuration(now - i.lastSeen)} (last report ${fmtLocal(i.lastSeen, tz)}, ` +
            `${moving ? `moving at ${Math.round(i.speed)} km/h` : 'stopped'}). Possible causes: no mobile coverage, tracker unplugged or powered off.`,
        }, mode);
      }
      rec.offline = true;
    } else {
      if (rec.offline === true && rec.offlineFrom && i.lastSeen && i.lastSeen > rec.offlineFrom) {
        const from = rec.offlineFrom;
        this.raiseAlert({
          imei: rec.imei, name: rec.v.name, type: 'back_online', severity: 'info', t: i.lastSeen, fromT: from,
          lat: i.lat, lng: i.lng,
          title: 'Tracker back online',
          detail: `Reporting again after ${fmtDuration(i.lastSeen - from)} without data (silent since ${fmtLocal(from, tz)}).`,
        }, 'live');
        // close only this outage's alert; one outage never closes another
        for (const row of this.db.ongoingAlerts(rec.imei, 'offline')) {
          if ((row.from_t ?? from) !== from) continue;
          this.patchAlert(row.id, {
            ongoing: false,
            detail: `No data from ${fmtLocal(from, tz)} until ${fmtLocal(i.lastSeen, tz)} (${fmtDuration(i.lastSeen - from)}).`,
          }, true);
        }
      }
      rec.offline = false;
      rec.offlineFrom = null;
      if (!rec.staleOfflineChecked && this.historyReady) this.closeStaleOffline(rec);
    }
    rec.dbStatus = null;
  }

  /** Offline alerts still "ongoing" from an outage that ended while the program was not
   *  running (or before a restart): end each at the first stored report after it. */
  closeStaleOffline(rec) {
    rec.staleOfflineChecked = true;
    const tz = this.cfg.timezone;
    const i = rec.info;
    for (const row of this.db.ongoingAlerts(rec.imei, 'offline')) {
      const from = row.from_t ?? row.t;
      const end = this.db.firstSampleAfter(rec.imei, from) ?? (i.lastSeen && i.lastSeen > from ? i.lastSeen : null);
      if (end === null) continue;
      this.patchAlert(row.id, {
        ongoing: false,
        detail: `No data from ${fmtLocal(from, tz)} until ${fmtLocal(end, tz)} (${fmtDuration(end - from)}).`,
      }, true);
      this.raiseAlert({
        imei: rec.imei, name: rec.v.name, type: 'back_online', severity: 'info', t: end, fromT: from,
        lat: i.lat, lng: i.lng,
        title: 'Tracker back online',
        detail: `Reporting again after ${fmtDuration(end - from)} without data (silent since ${fmtLocal(from, tz)}).`,
      }, 'backfill');
    }
  }

  // =============================================================================
  // samples -> detector
  // =============================================================================
  parseRow(r) {
    if (!Array.isArray(r) || r.length < 6) return null;
    const t = fromApiDate(r[0]);
    if (t === null) return null;
    const c = this.cfg;
    const p = isPlainObject(r[6]) ? r[6] : {};
    return {
      t,
      f: num(p[c.fuelParam]),
      spd: num(r[5]) ?? 0,
      ign: int01(p[c.ignitionParam]),
      pwr: num(p[c.powerParam]),
      lat: num(r[1]),
      lng: num(r[2]),
      odo: num(p[c.odometerParam]),
    };
  }

  /**
   * Store API message rows for a vehicle (INSERT OR IGNORE, so re-fetched rows are harmless
   * and rows that reach the GPS server late fill their gap) and feed the detector every stored
   * sample newer than what it has seen. Returns the number of newly stored rows.
   *
   * Trackers that lose coverage while driving upload their backlog later, often newest first.
   * When new data starts after a silence that began while the vehicle was active, the samples
   * after the gap are held back (stored, not judged) until the backlog has arrived: the
   * poller keeps re-fetching from the gap start while the server receives old records
   * (dt_server well ahead of dt_tracker), for at least HOLD_MIN_MS and at most HOLD_MAX_MS.
   * opts: { now, backlog (server still receiving old records), allowHold (live polling) }
   */
  ingest(rec, rows, mode, { now = Date.now(), backlog = false, allowHold = false } = {}) {
    if (!Array.isArray(rows)) return 0;
    let samples = [];
    for (const r of rows) {
      const s = this.parseRow(r);
      if (!s) continue;
      if (s.t > now + 10 * MIN) {
        if (!rec.futureLogged) log('warn', `${rec.v.name} (${rec.imei}): ignoring messages dated in the future (${fmtLocal(s.t, this.cfg.timezone)}) - tracker clock wrong?`);
        rec.futureLogged = true;
        continue;
      }
      samples.push(s);
    }
    samples.sort((a, b) => a.t - b.t);
    samples = samples.filter((s, i) => i === 0 || s.t !== samples[i - 1].t);
    const prevLastT = rec.lastT ?? -Infinity;
    let inserted = 0;
    if (samples.length) {
      inserted = this.db.insertSamples(rec.imei, samples); // throws -> caller records the error, nothing pushed
      const newest = samples[samples.length - 1].t;
      if (newest > prevLastT) rec.lastT = newest;
      this.stats.samplesIngested += inserted;
    }
    const late = inserted - samples.filter((s) => s.t > prevLastT).length;
    if (late > 0) {
      this.stats.lateRows += late;
      log('info', `${rec.v.name} (${rec.imei}): ${late} message(s) arrived late at the GPS server and were added`);
    }
    this.feed(rec, samples, mode, { now, backlog: backlog || late > 0, allowHold });
    return inserted;
  }

  feed(rec, samples, mode, { now, backlog, allowHold }) {
    let fresh = samples.filter((s) => s.t > rec.detT);
    if (rec.hold) {
      const age = now - rec.hold.since;
      if (allowHold && age < HOLD_MAX_MS && (age < HOLD_MIN_MS || backlog)) return;
      log('info', `${rec.v.name} (${rec.imei}): judging the data after the gap since ${fmtLocal(rec.hold.from, this.cfg.timezone)}`);
      rec.hold = null;
      fresh = this.db.samplesFrom(rec.imei, Math.floor(rec.detT) + 1);
    } else if (allowHold && fresh.length) {
      let prev = rec.lastPushed;
      for (let k = 0; k < fresh.length; k++) {
        const s = fresh[k];
        const gap = prev ? s.t - prev.t : 0;
        if (prev && gap > 10 * MIN && (this.active(rec, prev) || gap > 90 * MIN) && prev.t > now - this.cfg.backfillHours * HOUR) {
          this.pushSamples(rec, fresh.slice(0, k), mode);
          rec.hold = { from: prev.t, since: now };
          log('info', `${rec.v.name} (${rec.imei}): no data for ${fmtDuration(gap)} after ${fmtLocal(prev.t, this.cfg.timezone)} - waiting for the tracker's backlog before judging it`);
          return;
        }
        prev = s;
      }
    }
    this.pushSamples(rec, fresh, mode);
  }

  /** Moving or engine running (a tracker then reports every few seconds, so silence = no coverage). */
  active(rec, s) {
    if ((s.spd ?? 0) >= 3) return true;
    return s.ign === 1 && s.pwr !== null && s.pwr !== undefined && this.engineOnPower(s.pwr, this.detState(rec)?.runV);
  }

  /** Samples are missing before the next ones (older than the backfill window). */
  markGap(rec) {
    try {
      if (typeof rec.det?.gap === 'function') rec.det.gap();
    } catch (e) {
      log('error', `Detector gap() failed for ${rec.imei}:`, e);
    }
  }

  pushSamples(rec, samples, mode) {
    rec.mode = mode;
    try {
      for (const row of samples) {
        if (!(row.t > rec.detT)) continue;
        rec.detT = row.t;
        const s = {
          t: row.t, f: row.f ?? null, spd: row.spd ?? 0, ign: row.ign ?? null, pwr: row.pwr ?? null,
          lat: row.lat ?? null, lng: row.lng ?? null, odo: row.odo ?? null,
        };
        rec.lastPushed = s;
        if (rec.det) {
          try {
            rec.det.push(s);
          } catch (e) {
            rec.detErrors++;
            this.stats.detectorErrors++;
            if (rec.detErrors <= 3 || rec.detErrors % 1000 === 0) log('error', `Detector error for ${rec.v.name} (${rec.imei}) #${rec.detErrors}:`, e);
          }
          if (!this.detectorCallsOnLevel && mode !== 'replay') this.pollLevel(rec);
        }
        if (this.backendAfterHours) this.checkAfterHours(rec, s);
      }
    } finally {
      rec.mode = 'live';
    }
  }

  /** Persist what the detectors learned (consumption rates), so a restart judges trips the same way. */
  saveLearned() {
    for (const rec of this.recs.values()) {
      const d = rec.det;
      if (!d || typeof d.exportState !== 'function') continue;
      let st;
      try {
        st = d.exportState();
      } catch {
        continue;
      }
      const json = JSON.stringify(st ?? null);
      if (json === rec.learnedJson) continue;
      if (rec.learnedJson === 'null' && !(Array.isArray(st?.rates) && st.rates.length)) continue; // nothing learned yet
      try {
        this.db.setSetting(`learned:${rec.imei}`, st ?? null);
        rec.learnedJson = json;
      } catch (e) {
        log('error', 'Saving learned detector state failed:', e);
        return;
      }
    }
  }

  heldCount() {
    let n = 0;
    for (const rec of this.recs.values()) if (rec.hold) n++;
    return n;
  }

  detState(rec) {
    const d = rec.det;
    if (!d) return null;
    try {
      if (typeof d.getState === 'function') return d.getState() || null;
    } catch (e) {
      return null;
    }
    // early detector draft had no getState()
    return {
      level: Number.isFinite(d.level) ? d.level : null,
      levelT: Number.isFinite(d.levelT) ? d.levelT : null,
      sensorOk: typeof d.sensorLost === 'boolean' ? !d.sensorLost : null,
      stopped: d.stop != null,
      idleSince: Number.isFinite(d.idleStart) ? d.idleStart : null,
      consumptionMvPerHour: this.settingsFor(rec.imei).th.consumptionMvPerHour,
    };
  }

  pollLevel(rec) {
    const st = this.detState(rec);
    if (st && Number.isFinite(st.level) && Number.isFinite(st.levelT) && st.levelT !== rec.polledLevelT) {
      rec.polledLevelT = st.levelT;
      this.onLevel(rec, st.levelT, st.level, true);
    }
  }

  /** Trusted fuel level from the detector -> levels table (thinned: >= 15 mV change or 10 min). */
  onLevel(rec, t, mv, polled) {
    if (!polled) this.detectorCallsOnLevel = true;
    if (rec.mode === 'replay') return; // already stored the first time round
    t = Number(t);
    mv = Number(mv);
    if (!Number.isFinite(t) || !Number.isFinite(mv)) return;
    const last = rec.lastLevel;
    if (last && t <= last.t) return;
    if (last && Math.abs(mv - last.mv) < 15 && t - last.t < 10 * MIN) return;
    rec.lastLevel = { t, mv };
    try {
      this.db.insertLevel(rec.imei, t, mv);
    } catch (e) {
      log('error', 'Saving fuel level failed:', e);
    }
  }

  checkAfterHours(rec, s) {
    const th = this.settingsFor(rec.imei).th;
    if (!th.afterHoursEnabled || !(s.spd >= 5)) return;
    const start = parseHHMM(th.afterHoursStart);
    const end = parseHHMM(th.afterHoursEnd);
    if (start === null || end === null || start === end) return;
    const local = s.t + this.tzOffsetMin * MIN;
    const minute = Math.floor(local / MIN) % 1440;
    const day = Math.floor(local / (24 * HOUR));
    let inside;
    let night;
    if (start < end) {
      inside = minute >= start && minute < end;
      night = day;
    } else {
      inside = minute >= start || minute < end;
      night = minute >= start ? day : day - 1;
    }
    if (!inside || rec.afterHoursNight === night) return;
    rec.afterHoursNight = night;
    this.onDetectorEmit(rec, {
      imei: rec.imei, name: rec.v.name, type: 'after_hours', severity: 'warning', t: s.t, fromT: s.t, lat: s.lat, lng: s.lng,
      title: 'Moving outside working hours',
      detail: `Moving at ${Math.round(s.spd)} km/h at ${fmtLocal(s.t, this.cfg.timezone)} (after-hours window ${th.afterHoursStart}-${th.afterHoursEnd}).`,
    });
  }

  // =============================================================================
  // alerts
  // =============================================================================
  onDetectorEmit(rec, a) {
    if (!isPlainObject(a)) return --this.fakeId;
    return this.raiseAlert({ ...a, imei: a.imei ?? rec.imei, name: a.name ?? rec.v.name }, rec.mode);
  }

  onDetectorUpdate(rec, id, patch) {
    if (rec.mode === 'replay' || !isPlainObject(patch)) return;
    this.patchAlert(id, patch, rec.mode === 'live');
  }

  /**
   * Create an alert unless one with the same key exists. Returns the alert id.
   * mode 'live'     -> historical=0, pushed to dashboard + notifications
   * mode 'backfill' -> historical=1, stored silently
   * mode 'replay'   -> never stored; returns the existing id (or a negative dummy id)
   */
  raiseAlert(a, mode = 'live') {
    const type = String(a.type || 'unknown');
    const meta = this.alertTypes[type];
    let severity = SEVERITIES.includes(a.severity) ? a.severity : meta?.severity || 'warning';
    const t = Number.isFinite(a.t) ? Math.round(a.t) : Date.now();
    const fromT = Number.isFinite(a.fromT) ? Math.round(a.fromT) : null;
    const imei = a.imei === undefined || a.imei === null ? null : String(a.imei);
    const key = typeof a.key === 'string' && a.key ? a.key : `${imei}:${type}:${fromT ?? t}`;
    if (mode === 'replay') {
      try {
        return this.db.alertIdByKey(key) ?? --this.fakeId;
      } catch {
        return --this.fakeId;
      }
    }
    const extra = {};
    for (const [k, v] of Object.entries(a)) if (!KNOWN_ALERT_FIELDS.has(k) && v !== undefined) extra[k] = v;
    let title = a.title ? String(a.title) : meta?.label || type;
    // Sensors sometimes misread: a fuel drop is held back as "checking" for DRAIN_CONFIRM_MS and
    // only becomes a critical alert if the level has not come back by then (checkPendingDrains).
    const pending = type === 'fuel_drain' && severity === 'critical';
    if (pending) {
      Object.assign(extra, { pending: true, pendingUntil: t + DRAIN_CONFIRM_MS, origTitle: title });
      severity = 'info';
      title = PENDING_TITLE;
    }
    const row = {
      key, imei, name: a.name ?? imei, type, severity, t, fromT,
      lat: num(a.lat), lng: num(a.lng),
      title,
      detail: a.detail === undefined || a.detail === null ? '' : String(a.detail),
      amountMv: num(a.amountMv),
      ongoing: !!a.ongoing,
      historical: mode !== 'live',
      extra: Object.keys(extra).length ? JSON.stringify(extra).slice(0, 20000) : null,
    };
    let res;
    try {
      res = this.db.insertAlert(row);
    } catch (e) {
      log('error', 'Saving alert failed:', e);
      return --this.fakeId;
    }
    if (res.inserted) {
      this.stats.alertsCreated++;
      this.summaryCache.clear();
      if (LEDGER_TYPES.includes(type)) this.ledger?.touch('new fuel event');
      // a refuel after a drop: the level coming back no longer proves the drop was a misreading
      if (type === 'refuel' && imei) this.markRefuelAfterDrains(imei, fromT ?? t);
      if (pending) {
        log('info', `Fuel drop on ${shortName(row.name ?? imei)} held for a ${DRAIN_CONFIRM_MS / HOUR} h check - ${row.detail}`);
      } else if (mode === 'live') {
        const view = this.alertView(this.db.getAlert(res.id));
        log('info', `ALERT [${severity}] ${view.shortName || imei}: ${view.title} - ${view.detail}`);
        this.hub?.broadcast('alert', view);
        try {
          this.notifier?.enqueue(view);
        } catch (e) {
          log('error', 'Notification failed:', e);
        }
      }
    }
    return res.id ?? --this.fakeId;
  }

  patchAlert(id, patch, broadcast) {
    if (!(Number(id) > 0) || !isPlainObject(patch)) return;
    try {
      const row = this.db.getAlert(Number(id));
      if (!row) return;
      const cols = {};
      const more = {}; // e.g. toMv (level after a refuel / drain): kept in the alert's extra JSON
      for (const [k, v] of Object.entries(patch)) {
        if (PATCH_COLUMNS.has(k)) cols[k] = v;
        else if (v !== undefined && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k)) more[k] = v;
      }
      if (isPendingDrain(row)) {
        if (cols.severity === 'info' && 'amountMv' in cols && cols.amountMv === null) {
          // the detector saw the level come back while the drop was still being checked
          cols.title = FALSE_ALARM_TITLE;
          Object.assign(more, { pending: false, falseAlarm: true });
        } else {
          // still being checked: stays quiet; the detector's title is used once confirmed
          if ('title' in cols) { more.origTitle = cols.title; delete cols.title; }
          delete cols.severity;
        }
        broadcast = false;
      }
      // a drain whose level came back loses its amount; the size of the dip stays on record
      if (row.type === 'fuel_drain' && 'amountMv' in cols && cols.amountMv === null && row.amount_mv !== null && more.dipMv === undefined) {
        more.dipMv = row.amount_mv;
      }
      if (Object.keys(more).length) {
        let extra = {};
        try {
          extra = row.extra ? JSON.parse(row.extra) : {};
        } catch {
          extra = {};
        }
        const json = JSON.stringify({ ...(isPlainObject(extra) ? extra : {}), ...more });
        if (json.length <= 20000) cols.extra = json;
      }
      if (!this.db.updateAlert(row.id, cols)) return;
      this.summaryCache.clear();
      if (LEDGER_TYPES.includes(row.type)) this.ledger?.touch('fuel event updated');
      if (broadcast) {
        const updated = this.db.getAlert(row.id);
        if (updated) this.hub?.broadcast('alert', this.alertView(updated));
      }
    } catch (e) {
      log('error', 'Updating alert failed:', e);
    }
  }

  /** Marks drops still being checked on this vehicle that a refuel at time t followed. */
  markRefuelAfterDrains(imei, t) {
    for (const row of this.pendingDrainRows()) {
      if (row.imei !== imei || t < (row.from_t ?? row.t)) continue;
      const x = parseExtra(row.extra);
      if (!x.refuelSeen) this.db.updateAlert(row.id, { extra: JSON.stringify({ ...x, refuelSeen: true }) });
    }
  }

  pendingDrainRows() {
    try {
      return this.db.pendingDrains?.() ?? [];
    } catch (e) {
      log('error', 'Reading fuel drops being checked failed:', e);
      return [];
    }
  }

  /**
   * Settles the fuel drops held back as "checking" (raiseAlert): a drop whose level has come back
   * (and no refuel since) was a sensor misreading and is closed as a false alarm; one still down
   * after DRAIN_CONFIRM_MS becomes a critical alert and is notified then. Runs after each check.
   */
  checkPendingDrains(now = Date.now()) {
    for (const row of this.pendingDrainRows()) {
      try {
        const x = parseExtra(row.extra);
        const st = row.imei ? this.recs.get(row.imei)?.det?.getState?.() : null;
        const fromMv = num(x.fromMv);
        const amount = num(row.amount_mv);
        const level = st && Number.isFinite(st.level) && st.levelT > row.t ? st.level : null;
        let cols = null;
        let confirmed = false;
        if (!x.refuelSeen && level !== null && fromMv !== null && amount && fromMv - level <= Math.max(100, 0.25 * amount)) {
          cols = {
            severity: 'info', title: FALSE_ALARM_TITLE, amountMv: null,
            extra: JSON.stringify({ ...x, pending: false, falseAlarm: true, dipMv: amount, recoveredMv: Math.round(level) }),
          };
        } else if (now >= (num(x.pendingUntil) ?? row.t + DRAIN_CONFIRM_MS)) {
          confirmed = true;
          cols = {
            severity: 'critical', title: x.origTitle || 'Fuel drop',
            detail: `${row.detail || ''} Level still down after ${DRAIN_CONFIRM_MS / HOUR} h.`.trim(),
            // a live alert is dated when it is confirmed, so the dashboard treats it as new
            t: row.historical ? row.t : now,
            extra: JSON.stringify({ ...x, pending: false, confirmedAt: now, detectedT: row.t }),
          };
        }
        if (!cols || !this.db.updateAlert(row.id, cols)) continue;
        this.summaryCache.clear();
        this.ledger?.touch(confirmed ? 'fuel drop confirmed' : 'fuel drop was a misreading');
        const view = this.alertView(this.db.getAlert(row.id));
        log('info', `${confirmed ? 'ALERT [critical]' : 'False alarm (level came back):'} ${view.shortName || row.imei}: ${view.title} - ${view.detail}`);
        if (confirmed && !row.historical) {
          this.hub?.broadcast('alert', view);
          try {
            this.notifier?.enqueue(view);
          } catch (e) {
            log('error', 'Notification failed:', e);
          }
        }
      } catch (e) {
        log('error', 'Checking a fuel drop failed:', e);
      }
    }
  }

  /** Litres of a refuel / drain amount (see ledger.js amountLitres). */
  amountLitres(type, amountMv, extraJson, cal) {
    return amountLitres(type, amountMv, extraJson, cal);
  }

  /** Litres of one refuel / drain as the fuel ledger and the Report count it (ledger.js). */
  fuelEventLitres(row, mv, cal = row.imei ? this.vehicleCal(row.imei) : null) {
    return fuelEventLitres(row, mv, cal);
  }

  alertView(row) {
    if (!row) return null;
    const rec = row.imei ? this.recs.get(row.imei) : null;
    const cal = row.imei ? this.vehicleCal(row.imei) : null;
    const litres = this.amountLitres(row.type, row.amount_mv, row.extra, cal);
    const amountL = litres === null ? null : round(litres, 1);
    return {
      id: row.id,
      key: row.key,
      imei: row.imei,
      name: row.name ?? rec?.v.name ?? row.imei,
      shortName: shortName(rec?.v.name ?? row.name ?? row.imei ?? ''),
      group: rec?.info.group ?? null,
      type: row.type,
      severity: row.severity,
      t: row.t,
      fromT: row.from_t,
      title: row.title,
      detail: row.detail,
      amountMv: row.amount_mv === null ? null : round(row.amount_mv),
      amountL,
      lat: row.lat,
      lng: row.lng,
      ongoing: !!row.ongoing,
      acked: !!row.acked,
      ackedAt: row.acked_at,
      historical: !!row.historical,
      pending: isPendingDrain(row),
      verdict: VERDICTS.includes(row.verdict) ? row.verdict : 'unchecked',
      note: row.note ?? '',
      reviewedAt: row.reviewed_at ?? null,
    };
  }

  queryAlerts(q) {
    return this.db.queryAlerts(q).map((r) => this.alertView(r));
  }

  /**
   * PUT /api/alerts/:id/review  body { verdict?, note? }
   * verdict: 'unchecked' | 'confirmed' | 'false_alarm' (fuel drains only); note: text, at most
   * NOTE_MAX characters after trimming ('' or null clears it). A verdict also acknowledges the
   * alert (it has clearly been looked at). Returns the updated alert view, or null if unknown.
   */
  reviewAlert(id, body) {
    if (!isPlainObject(body)) throw bad('body must be a JSON object');
    if (body.verdict === undefined && body.note === undefined) throw bad('nothing to change: send verdict and/or note');
    const row = this.db.getAlert(id);
    if (!row) return null;
    let verdict = VERDICTS.includes(row.verdict) ? row.verdict : 'unchecked';
    let note = row.note ?? null;
    if (body.verdict !== undefined) {
      const v = body.verdict === null ? 'unchecked' : body.verdict;
      if (typeof v !== 'string' || !VERDICTS.includes(v)) throw bad(`verdict must be one of ${VERDICTS.join(', ')}`);
      if (v !== 'unchecked' && row.type !== 'fuel_drain') throw bad('a verdict can only be given for fuel drain alerts');
      verdict = v;
    }
    if (body.note !== undefined) {
      if (body.note !== null && typeof body.note !== 'string') throw bad('note must be text');
      // keep line breaks and tabs, drop other control characters
      const text = String(body.note ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
      if (text.length > NOTE_MAX) throw bad(`note is too long (${text.length} characters, at most ${NOTE_MAX})`);
      note = text || null;
    }
    const now = Date.now();
    this.db.setReview(row.id, verdict === 'unchecked' ? null : verdict, note, now);
    if (body.verdict !== undefined && verdict !== 'unchecked' && !row.acked) this.db.ackAlert(row.id, true, now);
    this.summaryCache.clear(); // the Report's totals leave out false alarms
    const view = this.alertView(this.db.getAlert(row.id));
    this.hub?.broadcast('alert', view);
    if (LEDGER_TYPES.includes(row.type)) this.ledger?.touch('review');
    return view;
  }

  ackAlert(id, acked = true) {
    if (!this.db.ackAlert(id, acked)) return null;
    const view = this.alertView(this.db.getAlert(id));
    this.hub?.broadcast('alert', view);
    return view;
  }

  ackAll(imei) {
    const n = this.db.ackAll(imei || null);
    this.hub?.broadcast('acked', { imei: imei || null, count: n });
    return n;
  }

  // ---- GPS server events (unknown shape: keep raw JSON, pick what we can) ---------------
  ingestServerEvents(res, mode) {
    const items = flattenEvents(res);
    let created = 0;
    for (const ev of items) {
      const imei = String(ev.imei ?? ev.object_imei ?? ev.IMEI ?? ev.object ?? '').trim() || null;
      const rec = imei ? this.recs.get(imei) : null;
      const desc = String(ev.event_desc ?? ev.desc ?? ev.event ?? ev.event_name ?? ev.type ?? ev.name ?? 'event').slice(0, 200);
      const parsedT = fromApiDate(ev.dt_tracker ?? ev.dt_server ?? ev.dt ?? ev.time ?? ev.date ?? null);
      let t = parsedT;
      let key = `${imei}:server_event:${t}:${hashStr(desc)}`;
      if (t === null) {
        // no usable time: identify the event by its content, dated when first seen, so the
        // same event listed again by the next poll is not a new alert
        key = `${imei}:server_event:raw:${hashStr(JSON.stringify(ev.row ?? ev))}`;
        t = this.eventFirstSeen.get(key) ?? Date.now();
        this.eventFirstSeen.set(key, t);
        if (this.eventFirstSeen.size > 5000) this.eventFirstSeen.delete(this.eventFirstSeen.keys().next().value);
      }
      const lat = num(ev.lat);
      const lng = num(ev.lng);
      const spd = num(ev.speed);
      const critical = /\b(sos|pwrcut|power ?cut|tow|jamming|dismount|disassem|fuel|theft|drain)\b/i.test(desc);
      const before = this.stats.alertsCreated;
      this.raiseAlert({
        key,
        imei, name: rec?.v.name ?? (ev.event_desc !== undefined ? ev.name : undefined) ?? imei, type: 'server_event', severity: critical ? 'critical' : 'warning',
        t, lat, lng,
        title: `GPS server: ${desc}`,
        detail: `Event "${desc}" reported by the GPS server${spd !== null ? ` at ${Math.round(spd)} km/h` : ''}.`,
        raw: ev,
      }, mode);
      if (this.stats.alertsCreated > before) created++;
    }
    return { received: items.length, created };
  }

  // =============================================================================
  // views
  // =============================================================================
  fuelPct(mv, cal) {
    return fuelPct(mv, cal);
  }

  vehicleView(rec, counts, now = Date.now()) {
    const i = rec.info;
    const cal = this.vehicleCal(rec.imei);
    const st = this.detState(rec);
    let fuel = null;
    if (rec.v.hasFuel) {
      let mv = Number.isFinite(st?.level) ? st.level : null;
      let trustedAt = Number.isFinite(st?.levelT) ? st.levelT : null;
      if (mv === null && rec.lastLevel) {
        mv = rec.lastLevel.mv;
        trustedAt = rec.lastLevel.t;
      }
      const liters = mv === null ? null : this.litersAt(mv, cal);
      const pct = mv === null ? null : cal.table && cal.tankLiters ? clamp((liters / cal.tankLiters) * 100, 0, 100) : this.fuelPct(mv, cal);
      fuel = {
        mv: mv === null ? null : round(mv),
        pct: pct === null ? null : round(pct, 1),
        liters: liters === null ? null : round(liters, 1),
        trustedAt,
        sensorOk: typeof st?.sensorOk === 'boolean' ? st.sensorOk : null,
        rawMv: i.fuelRaw ?? null,
      };
    }
    return {
      imei: rec.imei,
      name: rec.v.name,
      shortName: shortName(rec.v.name),
      group: i.group ?? null,
      device: i.device ?? null,
      plate: i.plate ?? null,
      hasFuel: rec.v.hasFuel,
      lat: i.lat ?? null,
      lng: i.lng ?? null,
      speed: i.speed ?? 0,
      angle: i.angle ?? null,
      ign: i.ign ?? null,
      pwrMv: i.pwr ?? null,
      status: this.computeStatus(rec, now),
      lastSeen: i.lastSeen ?? null,
      fuel,
      activeAlerts: counts ? { ...counts } : { critical: 0, warning: 0, info: 0 },
      cal,
      muted: this.isMuted(rec.imei),
      idleSince: Number.isFinite(st?.idleSince) ? st.idleSince : null,
      odometerKm: i.odometerKm ?? null,
    };
  }

  vehiclesView(now = Date.now()) {
    const counts = this.db.activeCounts();
    return [...this.recs.values()]
      .map((r) => this.vehicleView(r, counts.get(r.imei), now))
      .sort((a, b) => a.shortName.localeCompare(b.shortName, 'mn') || a.imei.localeCompare(b.imei));
  }

  groups() {
    const s = new Set();
    for (const r of this.recs.values()) if (r.info.group) s.add(r.info.group);
    return [...s].sort((a, b) => a.localeCompare(b, 'mn'));
  }

  /** GET /api/vehicles/:imei/history */
  history(imei, hours) {
    const rec = this.recs.get(imei);
    if (!rec) throw new HttpError(404, 'unknown vehicle');
    const h = clamp(num(hours) ?? 24, 1, 168);
    const to = Date.now();
    const from = to - h * HOUR;
    const rows = this.db.samplesRange(imei, from, to);
    return {
      imei,
      from,
      to,
      samples: downsample(rows, 4000),
      levels: this.db.levelsRange(imei, from, to).map((r) => [r.t, round(r.mv)]),
      alerts: this.queryAlerts({ imei, since: from, limit: 2000 }),
      track: thinTrack(rows, 1500),
    };
  }

  /**
   * GET /api/summary
   * distanceKm  - sum of odometer (io16) increases between consecutive messages, ignoring
   *               jumps faster than ~250 km/h; GPS (haversine) distance while moving if no odometer.
   * engineHours - time between consecutive messages (gaps > 5 min ignored) while the engine ran:
   *               moving, or stopped with ignition on and the voltage at charging level (the same
   *               rule as the detector; ignition alone is stuck at 1 on many trackers).
   * fuelUsedMv  - fuel balance over the trusted (parked, settled) levels, starting from the last
   *               trusted level before the period: level decreases of more than 50 mV, plus the
   *               consumption hidden behind a refuel between two trusted levels (earlier level +
   *               refuel - later level), minus fuel_drain amounts inside that span (theft is not
   *               usage). While the vehicle stands still (no driving, < 15 min engine) only the net
   *               change counts, so sensor wander on a parked truck is not "used". null when it
   *               cannot be known (dead sensor, or the vehicle moved without two trusted levels).
   * refuelMv / drainMv - sums of refuel / fuel_drain alert amounts in the period, counted exactly
   *               as in the Excel fuel ledger (ledgerEntry): drains marked "false alarm" and
   *               cancelled drains (level came back) are left out, unless the owner confirmed one.
   *               refuelL / drainL are the per-alert litres (tank table) summed, and
   *               alerts.fuel_drain is the number of counted drains.
   */
  summary(hours) {
    const h = clamp(num(hours) ?? 24, 1, 24 * 90);
    const cached = this.summaryCache.get(h);
    if (cached && Date.now() - cached.at < 60e3) return cached.data;
    const to = Date.now();
    const from = to - h * HOUR;
    const sums = new Map();
    for (const r of this.db.alertSums(from, to)) {
      let s = sums.get(r.imei);
      if (!s) sums.set(r.imei, (s = { alerts: {} }));
      s.alerts[r.type] = r.n;
    }
    const levels = groupBy(this.db.levelsAll(from, to));
    const fuelRows = this.db.fuelEvents(from, to);
    // refuels / thefts as the Excel fuel ledger counts them
    const ledgerRows = groupBy(fuelRows);
    // fuel balance: measured amounts; a drain the owner called a false alarm is not "not usage"
    const fuelEvents = groupBy(fuelRows.filter((e) => e.amount_mv !== null && !(e.type === 'fuel_drain' && e.verdict === 'false_alarm')));
    const out = [];
    for (const rec of this.recs.values()) {
      const stRunV = this.detState(rec)?.runV;
      const runV = Number.isFinite(stRunV) ? stRunV - 1000 : Infinity;
      const thr24 = Math.min(26400, runV);
      const thr12 = Math.min(13300, runV);
      const m = this.db.motionStats(rec.imei, from, to, thr24, thr12);
      let distanceM = 0;
      if (m) distanceM = m.odo_pairs > 0 ? m.odo_m : gpsDistance(this.db.samplesRange(rec.imei, from, to));
      const s = sums.get(rec.imei) || { alerts: {} };
      const cal = this.vehicleCal(rec.imei);
      const span = Math.abs(cal.fullMv - cal.emptyMv) || 1;
      const toL = (mv) => (mv !== null && cal.tankLiters ? round((mv / span) * cal.tankLiters, 1) : null);
      let used = null;
      let fuelKm = null; // distance driven between the first and last trusted level used
      if (rec.v.hasFuel && this.detState(rec)?.sensorOk !== false) {
        const pts = (levels.get(rec.imei) || []).map((r) => ({ t: r.t, mv: r.mv }));
        const before = this.db.lastLevelBefore(rec.imei, from);
        if (before && from - before.t < 48 * HOUR) pts.unshift({ t: before.t, mv: before.mv });
        const litres = cal.tankLiters ? (mv) => this.litersAt(mv, cal) : null;
        const drainL = (e) => this.amountLitres(e.type, e.amount_mv, e.extra, cal);
        if (pts.length >= 2) {
          const idx = motionIndex(this.db.samplesRange(rec.imei, pts[0].t, pts[pts.length - 1].t), thr24, thr12);
          used = fuelBalance(pts, fuelEvents.get(rec.imei) || [], litres, drainL, (a, b) => idx.parked(a.t, b.t));
          const fm = this.db.motionStats(rec.imei, pts[0].t, pts[pts.length - 1].t, thr24, thr12);
          fuelKm = fm && fm.odo_pairs > 0 ? round(fm.odo_m / 1000, 1) : fm ? round(gpsDistance(this.db.samplesRange(rec.imei, pts[0].t, pts[pts.length - 1].t)) / 1000, 1) : 0;
        }
        else if (distanceM < 1000 && (m?.engine_ms || 0) < 0.25 * HOUR) used = { mv: 0, l: litres ? 0 : null };
      }
      // refuels / suspected thefts: counted and sized exactly as in the Excel fuel ledger
      // (per-alert litres from the tank table, as the alert texts quote them)
      const f = { refuelMv: 0, refuelL: 0, drainMv: 0, drainL: 0, drains: 0 };
      for (const e of ledgerRows.get(rec.imei) || []) {
        const x = ledgerEntry(e);
        if (!x.counted) continue;
        const L = cal.tankLiters && x.mv !== null ? this.fuelEventLitres(e, x.mv, cal) ?? 0 : 0;
        if (e.type === 'refuel') {
          f.refuelMv += x.mv ?? 0;
          f.refuelL += L;
        } else {
          f.drains++;
          f.drainMv += x.mv ?? 0;
          f.drainL += L;
        }
      }
      const alerts = { ...s.alerts };
      if (f.drains) alerts.fuel_drain = f.drains;
      else delete alerts.fuel_drain;
      out.push({
        imei: rec.imei,
        name: rec.v.name,
        shortName: shortName(rec.v.name),
        group: rec.info.group ?? null,
        hasFuel: rec.v.hasFuel,
        distanceKm: round(distanceM / 1000, 1),
        engineHours: round((m?.engine_ms || 0) / HOUR, 2),
        maxSpeed: m?.max_spd ?? null,
        fuelUsedMv: used === null ? null : round(used.mv),
        fuelUsedL: used === null ? null : used.l !== null ? round(used.l, 1) : toL(used.mv),
        fuelKm, // km covered by the fuel-used figure (for litres per 100 km)
        refuelMv: round(f.refuelMv),
        refuelL: cal.tankLiters ? round(f.refuelL, 1) : null,
        drainMv: round(f.drainMv),
        drainL: cal.tankLiters ? round(f.drainL, 1) : null,
        alerts,
      });
    }
    out.sort((a, b) => a.shortName.localeCompare(b.shortName, 'mn') || a.imei.localeCompare(b.imei));
    this.summaryCache.set(h, { at: Date.now(), data: out });
    return out;
  }
}

// =============================================================================
// helpers
// =============================================================================
function groupBy(rows, key = 'imei') {
  const m = new Map();
  for (const r of rows) {
    let l = m.get(r[key]);
    if (!l) m.set(r[key], (l = []));
    l.push(r);
  }
  return m;
}

/**
 * Fuel used between the first and last trusted level of `pts` ([{t, mv}] in time order).
 * Falls of the level by more than a 50 mV deadband count as use (rises above it restart the
 * count). While the vehicle stood still (`parked(a, b)`: no driving, under 15 min of engine)
 * nothing is burnt, so such spans count nothing: a parked level wandering up and down is
 * sensor noise, and a real parked loss is a fuel drain, not use (drains inside those spans are
 * therefore not subtracted either). When a refuel started between two trusted levels, the
 * level just before it is taken as (later level - refuel amount), so the fuel burnt on the way
 * to the pump is counted too. fuel_drain amounts found between stops are subtracted.
 * `litres(mv)` (optional) converts levels with the tank table so litres follow the tank's shape.
 */
function fuelBalance(allPts, events, litres, drainLitres, parked = () => false) {
  const DEADBAND = 50;
  const start = (e) => e.from_t ?? e.t;
  // keep only the ends of each run of parked levels
  const pts = [allPts[0]];
  for (let i = 1; i < allPts.length - 1; i++) {
    if (parked(allPts[i - 1], allPts[i]) && parked(allPts[i], allPts[i + 1])) continue;
    pts.push(allPts[i]);
  }
  if (allPts.length > 1) pts.push(allPts[allPts.length - 1]);
  const refuels = events.filter((e) => e.type === 'refuel' && start(e) >= pts[0].t).sort((a, b) => start(a) - start(b));
  let mv = 0;
  let l = litres ? 0 : null;
  const use = (a, b) => {
    mv += a - b;
    if (litres) l += litres(a) - litres(b);
  };
  const still = []; // [from, to] spans where the vehicle stood still
  let ref = pts[0].mv;
  let j = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    let refuel = 0;
    while (j < refuels.length && start(refuels[j]) < b.t) {
      if (start(refuels[j]) >= a.t) refuel += refuels[j].amount_mv;
      j++;
    }
    if (parked(a, b)) {
      still.push([a.t, b.t]);
      ref = b.mv; // the level it drives off with
    } else if (refuel > 0) {
      const pre = b.mv - refuel;
      if (ref - pre > DEADBAND) use(ref, pre);
      ref = b.mv;
    } else if (b.mv < ref - DEADBAND) {
      use(ref, b.mv);
      ref = b.mv;
    } else if (b.mv > ref + DEADBAND) {
      ref = b.mv; // refuel (or a real rise) without an alert: start counting from the new level
    }
  }
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  for (const e of events) {
    if (e.type !== 'fuel_drain' || start(e) < t0 || e.t > t1) continue;
    // lost while standing still (in-stop drain): that drop was not counted as use either;
    // losses judged between stops (trip / drive-out) start at a stop's last level and count
    if (still.some(([a, b]) => start(e) >= a && start(e) < b && e.t <= b + 5 * MIN)) continue;
    mv -= e.amount_mv;
    if (litres) l -= drainLitres(e) ?? 0;
  }
  return { mv: Math.max(0, mv), l: l === null ? null : Math.max(0, l) };
}

/** Cumulative moving time, engine time and odometer over samples, to ask whether a vehicle
 *  stood still between two times (engine rule as in motionStats). */
function motionIndex(rows, thr24, thr12) {
  const n = rows.length;
  const T = new Float64Array(n);
  const mov = new Float64Array(n);
  const eng = new Float64Array(n);
  const dist = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const r = rows[k];
    T[k] = r.t;
    if (k === 0) continue;
    const p = rows[k - 1];
    const dt = r.t - p.t;
    const short = dt <= 5 * MIN;
    mov[k] = mov[k - 1] + (short && (p.spd ?? 0) >= 3 ? dt : 0);
    const pOn = (p.spd ?? 0) >= 3 ? p.ign !== 0
      : p.ign === 1 && (p.pwr === null || p.pwr >= (p.pwr > 18000 ? thr24 : thr12));
    eng[k] = eng[k - 1] + (short && pOn ? dt : 0);
    let d = 0;
    if (Number.isFinite(p.odo) && Number.isFinite(r.odo) && r.odo >= p.odo && r.odo - p.odo <= dt * 0.07 + 1000) d = r.odo - p.odo;
    else if ((p.spd ?? 0) >= 3 && p.lat && p.lng && r.lat && r.lng) d = Math.min(haversineM(p.lat, p.lng, r.lat, r.lng), (dt / 1000) * 70 + 100);
    dist[k] = dist[k - 1] + d;
  }
  // index of the last sample at or before t (-1 if none)
  const at = (t) => {
    let lo = 0;
    let hi = n - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (T[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  };
  return {
    parked(a, b) {
      const i = at(a);
      const j = at(b);
      if (i < 0 || j < 0) return false;
      return mov[j] - mov[i] < 2 * MIN && eng[j] - eng[i] < 15 * MIN && dist[j] - dist[i] < 300;
    },
  };
}

function gpsDistance(rows) {
  let d = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    if (!(a.spd >= 3 || b.spd >= 3)) continue;
    if (!a.lat || !a.lng || !b.lat || !b.lng) continue;
    const seg = haversineM(a.lat, a.lng, b.lat, b.lng);
    if (seg <= ((b.t - a.t) / 1000) * 70 + 100) d += seg;
  }
  return d;
}

/** <= max rows of [t, f, spd, ign, pwr]; keeps the min and max reading of each bucket. */
function downsample(rows, max) {
  const toArr = (r) => [r.t, r.f, r.spd, r.ign, r.pwr];
  if (rows.length <= max) return rows.map(toArr);
  const useFuel = rows.some((r) => r.f !== null);
  const val = useFuel ? (r) => r.f : (r) => r.spd;
  const buckets = Math.floor(max / 2);
  const size = rows.length / buckets;
  const out = [];
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * size);
    const e = Math.min(rows.length, Math.floor((b + 1) * size));
    if (e <= s) continue;
    let lo = -1;
    let hi = -1;
    for (let k = s; k < e; k++) {
      const v = val(rows[k]);
      if (v === null || v === undefined) continue;
      if (lo < 0 || v < val(rows[lo])) lo = k;
      if (hi < 0 || v > val(rows[hi])) hi = k;
    }
    if (lo < 0) {
      out.push(toArr(rows[s]));
      continue;
    }
    if (lo === hi) out.push(toArr(rows[lo]));
    else if (lo < hi) out.push(toArr(rows[lo]), toArr(rows[hi]));
    else out.push(toArr(rows[hi]), toArr(rows[lo]));
  }
  return out;
}

/** [[t, lat, lng, spd]] with at most `max` points, skipping invalid positions. */
function thinTrack(rows, max) {
  const valid = rows.filter((r) => r.lat && r.lng);
  const step = Math.max(1, Math.ceil(valid.length / max));
  const out = [];
  for (let i = 0; i < valid.length; i += step) out.push([valid[i].t, valid[i].lat, valid[i].lng, valid[i].spd]);
  const last = valid[valid.length - 1];
  if (last && out[out.length - 1]?.[0] !== last.t) out.push([last.t, last.lat, last.lng, last.spd]);
  return out;
}

const EVENT_KEYS = ['event_desc', 'desc', 'event', 'event_name', 'dt_tracker', 'dt_server', 'dt', 'imei'];
const IMEI_RE = /^\d{14,17}$/;
const DT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const TEXT_RE = /[A-Za-zА-Яа-яӨөҮү]/;
const scalar = (v) => v === null || typeof v !== 'object';

/** The GPS server's event list format is undocumented: accept arrays, objects keyed by IMEI,
 *  rows of plain values (optionally ending in a params object, like message rows) and plain
 *  objects of any field names, and return a flat list of event-like objects. */
export function flattenEvents(x, out = [], imeiHint = null, depth = 0) {
  if (x === null || x === undefined || depth > 6) return out;
  if (Array.isArray(x)) {
    const params = x.length >= 2 && isPlainObject(x[x.length - 1]) ? x[x.length - 1] : null;
    const vals = params ? x.slice(0, -1) : x;
    if (vals.length && vals.every(scalar)) {
      const s = vals.map((v) => (v === null ? '' : String(v)));
      out.push({
        imei: s.find((v) => IMEI_RE.test(v)) ?? imeiHint,
        dt: s.find((v) => DT_RE.test(v)) ?? null,
        event_desc: s.find((v) => TEXT_RE.test(v) && !/^\d{4}-\d{2}-\d{2}/.test(v)) ?? 'event',
        lat: vals.length >= 3 && Number.isFinite(Number(vals[1])) && DT_RE.test(s[0]) ? vals[1] : undefined,
        lng: vals.length >= 3 && Number.isFinite(Number(vals[2])) && DT_RE.test(s[0]) ? vals[2] : undefined,
        params: params ?? undefined,
        row: x,
      });
      return out;
    }
    for (const y of x) flattenEvents(y, out, imeiHint, depth + 1);
    return out;
  }
  if (typeof x === 'object') {
    if (EVENT_KEYS.some((k) => k in x)) {
      out.push({ imei: imeiHint, ...x });
      return out;
    }
    const entries = Object.entries(x);
    // a flat object with other field names (e.g. { object, name, date }) is one event
    if (entries.length && !('error' in x) && entries.every(([k, v]) => scalar(v) || (k === 'params' && isPlainObject(v)))) {
      const s = entries.map(([, v]) => (scalar(v) && v !== null ? String(v) : ''));
      out.push({
        ...x,
        imei: s.find((v) => IMEI_RE.test(v)) ?? imeiHint,
        dt: s.find((v) => DT_RE.test(v)) ?? null,
        row: x,
      });
      return out;
    }
    for (const [k, v] of entries) flattenEvents(v, out, /^\d{6,20}$/.test(k) ? k : imeiHint, depth + 1);
  }
  return out;
}
