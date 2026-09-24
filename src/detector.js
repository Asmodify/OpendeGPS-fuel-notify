// Streaming anomaly detector: one instance per vehicle, fed tracker samples in time order.
//
// Pure and deterministic: no I/O, no timers, no Date.now(). Every alert time is derived
// from sample timestamps, so replaying the same samples reproduces the same alerts
// (the backend dedupes on `${imei}:${type}:${fromT ?? t}`).
//
// Sample: { t (ms UTC), f (fuel mV | null), spd (km/h), ign (0|1|null), pwr (external mV | null), lat, lng,
//           odo (odometer m | null, optional) }
//
// How fuel is judged (tuned on 7 days of real fleet data with tools/replay.mjs):
//  * While driving, the analog fuel reading sloshes by thousands of mV, so levels are only
//    trusted from *settled* readings taken while stopped: the median of a trailing window
//    that is flat (no trend between its halves) and not dominated by outliers.
//  * Parked readings are steady (±1-2 quantisation steps of ~44 mV), so a drop of a few
//    hundred mV between two settled levels of the same stop is meaningful - including across
//    a master-switch power-off, during which the sensor reads ~0 and is simply ignored.
//    Trackers in hourly "parked" reporting need three agreeing readings over 2 h before a
//    change counts, and a drop whose level later returns is downgraded to a sensor dip.
//  * Some probes stick at their maximum after a rough drive and then drain down to the true
//    level over ~30 min. A stop's first level that sits at the vehicle's ceiling right after
//    driving is only trusted once it has held for a long time.
//  * Moving even 100 m (other slope, dump body up/down) can shift the reading by ~400 mV, so
//    comparisons *between* stops get an extra slope margin, and losses between stops must
//    exceed a generous consumption allowance (engine-hours x 1.5 x the vehicle's high learned
//    rate, never below the configured normal rate; km x rate for distance driven unseen).
//  * The 10th percentile of 10 min of powered driving predicts the next settled level well
//    (sloshing spikes are mostly upward), so stops that never settle (short stops, master
//    switch cut right away, departure right after a drop) are judged from the drive-in /
//    drive-out estimates with a wide margin, and only when a second estimate or the next
//    settled level agrees.
//  * Many trackers report ignition=1 permanently, so "engine running" also requires the
//    external voltage to be at alternator-charging level for that vehicle.
//  * A silence of more than 2 h in which the vehicle may have moved (odometer changed or
//    unknown) is a discontinuity: whatever happened in it can't be judged, so the open stop
//    and every "before" level are dropped instead of being compared across the hole.

const MIN = 60_000;
const HOUR = 3_600_000;

export const ALERT_TYPES = {
  fuel_drain: { severity: 'critical', label: 'Fuel drain' },
  power_cut: { severity: 'critical', label: 'Tracker power cut' },
  sensor_lost: { severity: 'warning', label: 'Fuel sensor fault' },
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

export const DEFAULT_THRESHOLDS = {
  drainParkedMv: 300,
  drainTripMv: 600,
  consumptionMvPerHour: 600,
  refuelMv: 300,
  sensorMinValidMv: 100,
  lowFuelPct: 10,
  overspeedKmh: 90,
  idleMinutes: 30,
  offlineMinutes: 60,
  powerCutMv: 5000,
  afterHoursEnabled: false,
  afterHoursStart: '22:00',
  afterHoursEnd: '06:00',
  tzOffsetMinutes: 480, // Asia/Ulaanbaatar; only used for the after-hours window
};

const DEFAULT_CAL = { emptyMv: 0, fullMv: 10000, tankLiters: null };

// ---- internal tuning ------------------------------------------------------------------
const MOVE_KMH = 3; // GPS speed at/above this = moving
const DEPART_KMH = 10; // one sample this fast ends a stop; slower needs two in a row
const SETTLE_MS = 90_000; // ignore fuel readings right after stopping
const WINDOW_MS = 4 * MIN; // trailing window for the settled level
const TAIL_MS = 3 * MIN; // window used for the level at departure
const LEVEL_TOL_MV = 100; // readings within this of the median are inliers
const TREND_TOL_MV = 75; // max difference between first- and second-half medians
const CONFIRM_MS = 5 * MIN; // an in-stop drop/rise must hold this long before alerting
const SPARSE_GAP_MS = 20 * MIN; // readings this far apart = sparse (hourly "parked" reporting)
const SPARSE_CONFIRM_MS = 2 * HOUR; // ...where a change needs 3 flat readings spanning this
const EVENT_QUIET_MS = 15 * MIN; // an ongoing drain/refuel closes after this long without change
const WATCH_MS = 6 * HOUR; // a closed parked drain stays watched (recovery / continuation)
const REBASE_MS = 3 * HOUR; // slowly re-anchor the in-stop reference (thermal / idle creep)
const PIN_CONFIRM_MS = 45 * MIN; // a ceiling-level first reading after a drive must hold this long
const PIN_RELEASE_MS = 15 * MIN; // ...and once it leaves the ceiling, let the probe drain this long
const SLOPE_MV = 300; // extra margin when comparing levels from different parking spots
const ROUGH_MARGIN_MV = 1000; // extra margin when the "before" level is only a driving median
const P10_MARGIN_MV = 500; // extra margin when a level is a drive-in / drive-out estimate
const P10_WINDOW_MS = 10 * MIN; // driving window for those estimates
const DRIVE_OUT_CONFIRM_MS = 10 * MIN; // second (confirming) drive-out window: the next 10 min
const DRIVE_OUT_MAX_MS = 60 * MIN; // a drive-out check must be settled within this after departure
const CONFIRM_TOL_MV = 300; // the confirming level may be at most this much above the estimate
const SHORT_STOP_MS = 2 * MIN; // stops shorter than this are not judged on their own
const BRIEF_SPREAD_MV = 200; // a few readings this close count as a brief level (master switch)
const TRIP_HEADROOM = 1.5; // trip allowance = engine-hours x rate x this
const IDLE_BURN_FACTOR = 0.25; // idling burns this fraction of the driving rate
const AVG_KMH = 40; // mV per km = mV per engine-hour / this (for distance driven unseen)
const GAP_MS = 10 * MIN; // silence longer than this = data gap
const HOLE_MS = 2 * HOUR; // gap longer than this without proof of standing still = discontinuity
const GAP_MOVED_M = 500; // position jump across a data gap = the vehicle moved unseen
const ODO_STILL_M = 300; // odometer change below this across a gap = did not move
const REFUEL_MERGE_MS = 60 * MIN; // a refuel starting this soon after the previous one extends it
const SENSOR_BAD_MS = 2 * MIN; // ~0 reading this long (and 5+ samples) = sensor lost
const SENSOR_GOOD_MS = 30 * MIN; // good reading this long (and 10+ samples) = restored
const FROZEN_MOVING_MS = 90 * MIN; // unchanged reading over this much driving = frozen sensor
const FROZEN_TOL_MV = 20;
const OVERSPEED_COOLDOWN_MS = 10 * MIN;
const POWER_CUT_KMH = 15; // power loss at this speed (2+ samples) = tracker cut while driving
const LEARN_MIN_ENGINE_H = 0.75; // shorter trips don't teach the consumption rate
const LEARN_MIN_FACTOR = 0.25; // learned rates below this x the normal rate are noise (slope)
const RATES_KEEP = 15; // learned trip rates kept per vehicle
const RATE_PERCENTILE = 0.75; // trip allowance uses this percentile of the learned rates
const RUN_V_MARGIN_MV = 1000; // engine running = voltage within this of the driving voltage

function median(values) {
  const a = [...values].sort((x, y) => x - y);
  const n = a.length;
  if (!n) return null;
  return n % 2 ? a[n >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

function percentile(values, p) {
  const a = [...values].sort((x, y) => x - y);
  if (!a.length) return null;
  const k = (a.length - 1) * p;
  const lo = Math.floor(k);
  const hi = Math.ceil(k);
  return a[lo] + (a[hi] - a[lo]) * (k - lo);
}

function distanceM(lat1, lng1, lat2, lng2) {
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return 0;
  const r = Math.PI / 180;
  const x = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 2 * 6371e3 * Math.asin(Math.sqrt(x));
}

function hhmmToMin(s, dflt) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? ''));
  return m ? (+m[1] * 60 + +m[2]) % 1440 : dflt;
}

function fmtDuration(ms) {
  const m = Math.max(1, Math.round(ms / MIN));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

const num = (x) => (x == null || x === '' || !Number.isFinite(+x) ? null : +x);

// Level from a run of readings: median of inliers, provided the run spans enough time
// (1 min of dense engine-on reporting, 2 min of 1/min reporting, or two hourly reports),
// most readings agree, and the first and second halves don't differ (no settling trend).
function flatLevel(win) {
  const n = win.length;
  if (n < 2) return null;
  const span = win[n - 1].t - win[0].t;
  if (span < (n >= 5 ? MIN : n >= 3 ? 2 * MIN : 10 * MIN)) return null;
  const m = median(win.map((r) => r.f));
  const inl = win.filter((r) => Math.abs(r.f - m) <= LEVEL_TOL_MV);
  if (inl.length < (n === 2 ? 2 : Math.max(3, Math.ceil((n * 2) / 3)))) return null;
  if (n >= 3) {
    const h = Math.max(1, n >> 1);
    const a = median(win.slice(0, h).map((r) => r.f));
    const b = median(win.slice(n - h).map((r) => r.f));
    if (Math.abs(a - b) > TREND_TOL_MV) return null;
  }
  return Math.round(median(inl.map((r) => r.f)));
}

// ---- snapshot / restore (cloud backend: a fresh process per poll) -------------------------
// The state is plain data (numbers, strings, booleans, null, arrays, plain objects, no shared
// references), so it survives JSON once non-finite numbers (Infinity start values) are
// encoded; the callbacks and the vehicle object are handed in again by restore().
const SNAPSHOT_VERSION = 1;
const SNAPSHOT_SKIP = new Set(['v', 'getSettings', 'emit', 'update', 'onLevel', 'trace']);

function encodeState(x) {
  if (typeof x === 'number') return Number.isFinite(x) ? x : { $nf: Number.isNaN(x) ? 'NaN' : x > 0 ? 'Infinity' : '-Infinity' };
  if (Array.isArray(x)) return x.map(encodeState);
  if (x && typeof x === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(x)) if (v !== undefined && typeof v !== 'function') o[k] = encodeState(v);
    return o;
  }
  return x === undefined ? null : x;
}

function decodeState(x) {
  if (Array.isArray(x)) return x.map(decodeState);
  if (x && typeof x === 'object') {
    const keys = Object.keys(x);
    if (keys.length === 1 && keys[0] === '$nf') return x.$nf === 'Infinity' ? Infinity : x.$nf === '-Infinity' ? -Infinity : NaN;
    const o = {};
    for (const k of keys) o[k] = decodeState(x[k]);
    return o;
  }
  return x;
}

export class VehicleDetector {
  constructor(vehicle, getSettings, emit, update, onLevel) {
    this.v = vehicle; // { imei, name, hasFuel }
    this.getSettings = getSettings;
    this.emit = emit;
    this.update = update;
    this.onLevel = onLevel || null;
    this.trace = null; // optional debug hook (tools/replay.mjs)

    this.last = null; // previous accepted sample
    this.engineMs = 0; // cumulative engine-running time
    this.movingMs = 0; // cumulative moving time
    this.gapKm = 0; // cumulative distance driven while the tracker was silent (odometer)
    this.unknownGaps = 0; // silences in which the vehicle moved an unknown distance
    this.runV = null; // typical external voltage while driving (alternator charging)
    this.runVs = []; // recent driving voltages; their median is runV (converges fast after restart)
    this.forceGap = false; // backend: data is missing before the next sample
    this.seeded = false;

    this.stop = null; // current stop, see newStop()
    this.departPending = false;

    // fuel level
    this.level = null; // last trusted level (mV)
    this.levelT = null;
    this.lastEmittedLevel = null;
    this.prevStopLevel = null; // last trusted level before the current trip
    this.ceil = 0; // highest valid reading seen more than once: probes that stick do so near here
    this.ceilCands = []; // higher readings seen only once so far (a one-off glitch never repeats)
    this.jumpRate = 0; // share of driving readings that jump >1500 mV (sloshy/sticky probe)
    this.recent = []; // valid readings of the last 10 min, moving or not
    this.roughMin = null; // lowest 10-min median since the last trusted level { level, t }
    this.drivingRefuelFrom = null; // prevStopLevel.t for which a refuel was already reported
    this.tripDrainFrom = null; // prevStopLevel.t for which a loss was already reported
    this.pendingOut = null; // stop left without a final level; judged from the drive-out estimate
    this.lastRefuel = null; // { id, fromT, fromLevel, toLevel, endT } for merging split refuels
    this.lastRefuelT = -Infinity;
    this.levelMin = Infinity; // range of trusted levels seen: proves the sensor responds
    this.levelMax = -Infinity;
    this.rates = []; // learned consumption { t (trip end), r (mV per engine-hour) }
    this.lowFuel = false;
    this.seenAboveLow = false;

    // sensor health
    this.sensorEverValid = false;
    this.lastValidF = null;
    this.badSince = null;
    this.badCount = 0;
    this.goodSince = null;
    this.goodCount = 0;
    this.sensorLost = null; // { since, alertId|null }
    this.emptyTank = false; // reading slid below the valid range: tank run (nearly) empty
    this.frozen = null; // { value, since, movingMs, off, alertId, done }

    this.pwrOff = null; // { since, fastCount, alertId }
    this.over = null; // { fromT, max, count, alertId }
    this.overCooldownUntil = -Infinity;
    this.afterHoursNight = null;
  }

  settings() {
    const s = this.getSettings() || {};
    return {
      th: { ...DEFAULT_THRESHOLDS, ...(s.th || {}) },
      cal: { ...DEFAULT_CAL, ...(s.cal || {}) },
    };
  }

  getState() {
    const { th } = this.settings();
    let sensorOk = null;
    if (this.v.hasFuel && (this.sensorEverValid || this.badCount > 0 || this.sensorLost)) {
      sensorOk = this.sensorEverValid && !this.sensorLost && !(this.frozen && this.frozen.done);
    }
    const rates = this.rates.map((x) => x.r);
    return {
      level: this.level,
      levelT: this.levelT,
      sensorOk,
      stopped: !!this.stop,
      idleSince: this.stop && this.stop.idle ? this.stop.idle.start : null,
      consumptionMvPerHour: Math.round(rates.length >= 3 ? median(rates) : th.consumptionMvPerHour),
      // extras (not in the original contract): engine state of the last sample and the
      // vehicle's charging voltage, so the backend applies the same engine-running rule
      engineOn: this.last ? !!this.last.engine : null,
      runV: this.runV,
      lastT: this.last ? this.last.t : null,
    };
  }

  // Learned state worth keeping across restarts (the backend stores it and hands it back as
  // settings.th.learnedRates). Rates carry their trip's end time, so a replay of the same
  // trips does not count them twice.
  exportState() {
    return { rates: this.rates.map((x) => [x.t, Math.round(x.r)]) };
  }

  // Backend: samples are missing before the next one (history older than the backfill window).
  gap() {
    this.forceGap = true;
  }

  // The complete detector state as JSON-safe data. VehicleDetector.restore() turns it back into
  // a detector that continues exactly as this one would (same alerts, updates and levels), so a
  // backend without a long-running process can feed samples in chunks.
  snapshot() {
    const state = {};
    for (const [k, v] of Object.entries(this)) if (!SNAPSHOT_SKIP.has(k)) state[k] = encodeState(v);
    return { v: SNAPSHOT_VERSION, state };
  }

  // A detector continuing from snapshot() (an unknown / missing snapshot gives a fresh one).
  static restore(snap, vehicle, getSettings, emit, update, onLevel) {
    const d = new VehicleDetector(vehicle, getSettings, emit, update, onLevel);
    const st = snap && snap.v === SNAPSHOT_VERSION && snap.state && typeof snap.state === 'object' ? snap.state : null;
    if (st) for (const k of Object.keys(d)) if (!SNAPSHOT_SKIP.has(k) && k in st) d[k] = decodeState(st[k]);
    return d;
  }

  seed(th) {
    this.seeded = true;
    const lr = th.learnedRates;
    if (!Array.isArray(lr)) return;
    for (const x of lr) {
      const t = num(Array.isArray(x) ? x[0] : x?.t);
      const r = num(Array.isArray(x) ? x[1] : x?.r);
      if (t != null && r != null && r >= 0 && r <= 3000) this.rates.push({ t, r });
    }
    this.rates.sort((a, b) => a.t - b.t);
    if (this.rates.length > RATES_KEEP) this.rates = this.rates.slice(-RATES_KEEP);
  }

  mark() {
    return { engineMs: this.engineMs, movingMs: this.movingMs, gapKm: this.gapKm, unknownGaps: this.unknownGaps };
  }

  push(raw) {
    if (!raw || !Number.isFinite(raw.t)) return;
    if (this.last && raw.t <= this.last.t) return;
    const s = {
      t: raw.t, f: num(raw.f), spd: num(raw.spd) ?? 0, ign: num(raw.ign), pwr: num(raw.pwr),
      lat: num(raw.lat), lng: num(raw.lng), odo: num(raw.odo),
    };
    const prev = this.last;
    this.last = s;
    const { th, cal } = this.settings();
    if (!this.seeded) this.seed(th);
    const dt = prev ? s.t - prev.t : 0;
    const powered = s.pwr == null || s.pwr >= th.powerCutMv;

    if (powered && s.pwr != null && s.spd >= 20) {
      this.runVs.push(s.pwr);
      if (this.runVs.length > 31) this.runVs.shift();
      if (this.runVs.length >= 5) this.runV = median(this.runVs);
    }
    s.engine = this.engineRunning(s);
    // time accounting runs on the previous sample's state
    if (prev) {
      if (dt <= GAP_MS) {
        if (prev.engine) this.engineMs += dt;
        if (prev.spd >= MOVE_KMH) this.movingMs += dt;
      } else {
        this.accountGap(prev, s, dt);
      }
    }
    while (this.recent.length && this.recent[0].t < s.t - 10 * MIN) this.recent.shift();
    if (prev && (dt > HOLE_MS || this.forceGap) && !this.stoodStill(prev, s, dt)) this.discontinuity(prev);
    this.forceGap = false;

    this.trackMotion(prev, s, dt, th, cal);
    this.checkPower(s, powered, th);
    this.checkOverspeed(s, th);
    this.checkAfterHours(s, th);
    this.checkIdle(prev, s, th);
    if (this.v.hasFuel) this.checkFuel(s, dt, powered, th, cal);
  }

  // Ignition alone is unreliable here (many units report 1 permanently), so while stopped
  // the external voltage must also be at charging level: 26.4 V (13.3 V on 12 V systems),
  // or lower for a vehicle whose alternator measurably runs lower while driving.
  engineRunning(s) {
    if (s.spd >= MOVE_KMH) return s.ign !== 0;
    if (s.ign === 0) return false;
    if (s.pwr == null) return s.ign === 1;
    const base = s.pwr > 18000 ? 26400 : 13300; // 24 V / 12 V systems
    return s.pwr >= (this.runV != null ? Math.min(base, this.runV - RUN_V_MARGIN_MV) : base);
  }

  // ---- data gaps -------------------------------------------------------------------------
  // Distance driven between two samples from the odometer (km), or null when unknown.
  odoKm(prev, s, dt) {
    if (prev.odo == null || s.odo == null) return null;
    const d = s.odo - prev.odo;
    if (d < -1000 || d > (dt / 1000) * 70 + 2000) return null; // reset or glitch
    return Math.max(0, d) / 1000;
  }

  stoodStill(prev, s, dt) {
    const km = this.odoKm(prev, s, dt);
    return km != null && km * 1000 < ODO_STILL_M;
  }

  // A silence: distance driven in it (odometer) is allowed for at the trip check; when the
  // vehicle moved an unknown distance the trip's fuel loss can't be judged at all.
  accountGap(prev, s, dt) {
    const d = Math.min(dt, 12 * HOUR);
    const km = this.odoKm(prev, s, dt);
    if (km != null && km * 1000 >= ODO_STILL_M) {
      this.gapKm += km;
    } else if (km == null && (prev.spd >= MOVE_KMH || distanceM(prev.lat, prev.lng, s.lat, s.lng) > GAP_MOVED_M)) {
      this.unknownGaps++;
    } else if (prev.engine) {
      this.engineMs += d; // stood still with the engine on (idled through the silence)
    }
  }

  // Data missing for a long time (or the vehicle may have moved in it): the open stop is
  // closed without being judged, and no fuel loss is judged across the hole (engine time,
  // distance and refuels in it are unknown). A clear rise still shows as a refuel.
  discontinuity(prev) {
    const stop = this.stop;
    if (stop) {
      if (stop.event) {
        const ev = stop.event;
        stop.event = null;
        this.update(ev.id, { ongoing: false });
      }
      if (stop.idle) {
        if (stop.idle.offSince == null) stop.idle.offSince = stop.idle.lastOnT;
        this.endIdle(stop, prev);
      }
      if (stop.last) {
        this.prevStopLevel = { ...stop.last };
        this.reportLevel(stop.last.t, stop.last.level, true);
      }
      this.stop = null;
    }
    this.departPending = false;
    this.unknownGaps++;
    this.pendingOut = null;
    this.recent = [];
    this.lastRefuel = null;
    if (this.trace) this.trace({ kind: 'discontinuity', t: prev.t });
  }

  alert(s, type, title, detail, extra = {}) {
    return this.emit({
      imei: this.v.imei, name: this.v.name, type, severity: ALERT_TYPES[type].severity,
      t: s.t, lat: s.lat, lng: s.lng, title, detail, ...extra,
    });
  }

  // ---- motion: stops and trips ---------------------------------------------------------
  newStop(s, afterDrive) {
    const inWin = this.windowBefore(s.t);
    return {
      startT: s.t, lat: s.lat, lng: s.lng, afterDrive,
      startMark: this.mark(),
      readings: [], // valid, powered, stationary, post-settle readings { t, f }
      lastReadingT: null,
      skipNext: false, // drop the first reading after power returns
      ref: null, // in-stop reference { level, t, lastRawT, engineMs }
      last: null, // latest trusted level { level, t, engineMs, movingMs, gapKm, unknownGaps }
      pinSince: null,
      pinReleasedAt: null,
      pending: null, // { type, since } in-stop drop/rise awaiting confirmation
      event: null, // ongoing drain/refuel alert
      watch: null, // closed drain still watched { ev, until }
      powerOffSinceRef: false,
      idle: null,
      // drive-in level estimates (for stops that never settle / master-switch stops)
      arrivalRough: this.calmMedian(inWin, 400),
      arrivalP10: this.p10Level(inWin),
      early: [], // stationary readings before the first power cut
      preOff: null, // best level before the power cut { level, t, margin, kind, engineMs }
      postOn: [], // readings since power last came back
      bridged: false,
    };
  }

  // Readings of the 10 min up to t, without crossing a data gap.
  windowBefore(t) {
    const w = this.recent.filter((x) => x.t >= t - P10_WINDOW_MS && x.t <= t);
    if (w.length && t - w[w.length - 1].t > GAP_MS) return [];
    for (let i = w.length - 1; i > 0; i--) if (w[i].t - w[i - 1].t > GAP_MS) return w.slice(i);
    return w;
  }

  // Median of recent readings when they are calm enough to mean something.
  calmMedian(list, maxSpread) {
    const n = list.length;
    if (n < 10 || this.jumpRate > 0.005) return null;
    const v = list.map((x) => x.f).sort((a, b) => a - b);
    if (v[Math.floor(n * 0.9)] - v[Math.floor(n * 0.1)] > maxSpread) return null;
    return v[n >> 1];
  }

  // 10th percentile of a driving window: sloshing throws readings mostly upwards, so this
  // tracks the settled level closely. Readings at the probe's ceiling (stuck probe) are left
  // out, and windows that jump around too much are not used.
  p10Level(list) {
    const n = list.length;
    if (n < 10 || list[n - 1].t - list[0].t < 5 * MIN || this.jumpRate > 0.05) return null;
    let jumps = 0;
    for (let i = 1; i < n; i++) if (Math.abs(list[i].f - list[i - 1].f) >= 1500) jumps++;
    if (jumps > (n - 1) * 0.2) return null;
    const v = list.filter((x) => !this.nearCeiling(x.f)).map((x) => x.f).sort((a, b) => a - b);
    if (v.length < Math.max(8, n * 0.5)) return null;
    return v[Math.floor(v.length * 0.1)];
  }

  // A few consecutive readings that agree (the minute before a power cut or after it).
  briefLevel(list) {
    const w = list.slice(-6);
    if (w.length < 2) return null;
    const v = w.map((x) => x.f).sort((a, b) => a - b);
    if (v[v.length - 1] - v[0] > BRIEF_SPREAD_MV) return null;
    return { level: Math.round(median(v)), t: w[w.length - 1].t };
  }

  trackMotion(prev, s, dt, th, cal) {
    const moving = s.spd >= MOVE_KMH;
    if (this.stop) {
      // a data gap with a position jump (or odometer change) means the vehicle moved unseen
      if (prev && dt > GAP_MS) {
        const km = this.odoKm(prev, s, dt);
        if (distanceM(this.stop.lat, this.stop.lng, s.lat, s.lng) > GAP_MOVED_M || (km != null && km * 1000 >= ODO_STILL_M)) {
          this.endStop(prev, th, cal);
          if (!moving) this.stop = this.newStop(s, true);
          return;
        }
      }
      if (moving) {
        if (s.spd >= DEPART_KMH || this.departPending) this.endStop(s, th, cal);
        else this.departPending = true;
      } else {
        this.departPending = false;
      }
    } else if (!moving) {
      this.stop = this.newStop(s, !!prev);
      this.departPending = false;
    }
  }

  endStop(s, th, cal) {
    const stop = this.stop;
    if (this.v.hasFuel) this.evaluateDeparture(stop, s, th, cal);
    this.stop = null;
    this.departPending = false;
    const hadEvent = !!stop.event;
    if (stop.event) this.closeEvent(stop);
    if (stop.idle) this.endIdle(stop, s);
    if (stop.last) {
      this.prevStopLevel = { ...stop.last };
      this.reportLevel(stop.last.t, stop.last.level, true);
    }
    if (this.v.hasFuel && !hadEvent) this.planDriveOut(stop, s);
  }

  // At departure, the last flat run of readings gives the stop's final level. It can
  // reveal a drop that happened too close to departure to be confirmed in-stop (a short
  // stop to siphon fuel), or provide the first level of a stop that never settled earlier.
  evaluateDeparture(stop, s, th, cal) {
    const tail = this.tailLevel(stop);
    this.departBridge(stop, s, tail, th, cal);
    if (tail == null) return;
    const at = { ...s };
    if (!stop.ref) {
      if (stop.pinSince != null || (stop.afterDrive && this.nearCeiling(tail.level))) return;
      this.startRef(stop, at, tail.level, tail.t, th, cal);
      return;
    }
    stop.last = { level: tail.level, t: tail.t, ...this.mark() };
    if (stop.event || tail.t <= stop.ref.t) return;
    const ref = stop.ref;
    const allowance = this.idleAllowance(ref, th);
    const drop = ref.level - tail.level;
    if (drop - allowance >= th.drainParkedMv) {
      this.openEvent(stop, at, 'fuel_drain', tail.level, allowance, th, cal, true);
    } else if (tail.level - Math.min(ref.level, ref.low.level) >= th.refuelMv) {
      this.openEvent(stop, at, 'refuel', tail.level, allowance, th, cal, true);
    }
  }

  // ---- master-switch bridge -------------------------------------------------------------
  levelBeforeCut(stop) {
    if (stop.last) return { level: stop.last.level, t: stop.ref.lastRawT, margin: 0, kind: 'settled', engineMs: stop.last.engineMs };
    const brief = this.jumpRate <= 0.005 ? this.briefLevel(stop.early) : null;
    if (brief && !(stop.afterDrive && this.nearCeiling(brief.level))) return { ...brief, margin: SLOPE_MV, kind: 'brief', engineMs: this.engineMs };
    if (stop.arrivalP10 != null) return { level: stop.arrivalP10, t: stop.startT, margin: P10_MARGIN_MV, kind: 'p10', engineMs: stop.startMark.engineMs };
    if (stop.arrivalRough != null) return { level: stop.arrivalRough, t: stop.startT, margin: ROUGH_MARGIN_MV, kind: 'rough', engineMs: stop.startMark.engineMs };
    return null;
  }

  // Leaving a stop that had a power cut: if no settled level came after the power
  // returned, use the brief run of readings before departure, else judge on the way out.
  departBridge(stop, s, tail, th, cal) {
    if (!stop.preOff || stop.bridged) return;
    stop.bridged = true;
    const onT = stop.postOn[0]?.t ?? Infinity;
    if (stop.ref && stop.last && stop.last.t > onT) return; // settled after power-on: in-stop logic judged it
    const tailAfter = tail && tail.t >= onT;
    if (tailAfter && stop.ref) return; // settled before the cut, flat run after it: judged at departure
    const post = tailAfter ? { level: tail.level, t: tail.t, margin: 0 } : this.briefLevel(stop.postOn);
    if (post) {
      this.bridgeCheck(s, stop.preOff, { margin: SLOPE_MV, ...post }, 0, th, cal);
    } else if (stop.postOn.length || s.pwr == null || s.pwr >= th.powerCutMv) {
      this.pendingOut = { pre: stop.preOff, departT: s.t, ...this.mark(), bridge: true, out1: null, out1T: null };
    }
  }

  // Leaving a stop whose final level is unknown: a short stop that never settled, or one
  // with readings after its last settled level. The drive-out estimate judges it.
  planDriveOut(stop, s) {
    if (this.pendingOut && (this.pendingOut.departT === s.t || this.pendingOut.out1 != null)) return;
    let pre = null;
    if (stop.ref && stop.last) {
      if (stop.lastReadingT != null && stop.lastReadingT - stop.last.t > 2 * MIN && !stop.preOff) {
        pre = { level: stop.last.level, t: stop.last.t, margin: 0, kind: 'settled', engineMs: stop.last.engineMs };
      }
    } else if (!stop.ref && !stop.preOff && s.t - stop.startT >= SHORT_STOP_MS && stop.arrivalP10 != null) {
      pre = { level: stop.arrivalP10, t: stop.startT, margin: P10_MARGIN_MV, kind: 'p10', engineMs: stop.startMark.engineMs };
    }
    this.pendingOut = pre ? { pre, departT: s.t, ...this.mark(), bridge: false, out1: null, out1T: null } : null;
  }

  driveOutAllowance(po, th) {
    const idleH = Math.max(0, po.engineMs - po.pre.engineMs) / HOUR;
    const driveH = Math.max(0, this.engineMs - po.engineMs) / HOUR;
    const rate = this.tripRate(th);
    return idleH * th.consumptionMvPerHour * 0.5 + driveH * rate + (this.gapKm - po.gapKm) * (rate / AVG_KMH);
  }

  // Driving after such a stop: a P10 estimate of the level 10 min out; a suspicious drop
  // must be confirmed by a second estimate ~20 min later (or the next settled level).
  checkDriveOut(s, th, cal) {
    const po = this.pendingOut;
    if (s.t - po.departT > DRIVE_OUT_MAX_MS) { this.pendingOut = null; return; }
    if (po.out1 == null) {
      if (s.t - po.departT < P10_WINDOW_MS) return;
      const win = this.recent.filter((x) => x.t > po.departT);
      // P10 leaves out readings at the probe's top; a calm median (wider margin) covers a
      // tank filled up to there
      const p10 = this.p10Level(win);
      const out = p10 ?? this.calmMedian(win, 300);
      if (out == null) return;
      const allowance = this.driveOutAllowance(po, th);
      const margin = Math.max(po.pre.margin, p10 != null ? P10_MARGIN_MV : ROUGH_MARGIN_MV);
      if (this.trace) this.trace({ kind: 'driveout', t: s.t, pre: po.pre, out, allowance, margin });
      if (out - po.pre.level >= th.refuelMv + margin) {
        // clearly more fuel on the way out (P10 is biased low, so this is conservative)
        this.pendingOut = null;
        if (this.prevStopLevel) this.drivingRefuelFrom = this.prevStopLevel.t;
        this.refuelAlert(s, po.pre.t, po.pre.level, out, 'Refuel',
          (from, to) => `Fuel rose by about ${this.fmtChange(from, to, cal)} at a stop${po.bridge ? " with the vehicle's power (master switch) off" : ''} ` +
            `(about ${this.fmtLevel(from, cal)} before, about ${this.fmtLevel(to, cal)} while driving on).`, false);
        return;
      }
      if (po.pre.level - out - allowance < th.drainParkedMv + margin) { this.pendingOut = null; return; }
      po.out1 = out;
      po.out1T = s.t;
      return;
    }
    if (s.t - po.out1T < DRIVE_OUT_CONFIRM_MS) return;
    const win2 = this.recent.filter((x) => x.t > po.out1T);
    const out2 = this.p10Level(win2) ?? this.calmMedian(win2, 300);
    if (out2 == null) return;
    this.pendingOut = null;
    if (out2 <= po.out1 + CONFIRM_TOL_MV) this.driveOutAlert(s, po, po.out1, false, cal);
  }

  // The next settled level decides a drive-out check still open.
  resolveDriveOut(s, level, th, cal) {
    const po = this.pendingOut;
    this.pendingOut = null;
    if (s.t - po.departT > DRIVE_OUT_MAX_MS || this.unknownGaps !== po.unknownGaps) return;
    if (po.out1 != null) {
      if (level <= po.out1 + CONFIRM_TOL_MV) this.driveOutAlert(s, po, po.out1, false, cal);
      return;
    }
    if (po.pre.kind === 'settled') return; // the trip check compares that stop's level anyway
    const allowance = this.driveOutAllowance(po, th);
    const margin = Math.max(po.pre.margin, SLOPE_MV);
    if (po.pre.level - level - allowance >= th.drainParkedMv + margin) this.driveOutAlert(s, po, level, true, cal);
  }

  driveOutAlert(s, po, post, settled, cal) {
    const pre = po.pre;
    const drop = pre.level - post;
    if (this.prevStopLevel) this.tripDrainFrom = this.prevStopLevel.t; // not again at the trip check
    const est = settled ? `${this.fmtLevel(post, cal)} at the next stop` : `about ${this.fmtLevel(post, cal)} while driving on`;
    const before = `${pre.kind === 'settled' ? '' : 'about '}${this.fmtLevel(pre.level, cal)}`;
    if (po.bridge) {
      this.alert(s, 'fuel_drain', 'Fuel drop while power was off',
        `Fuel fell by about ${this.fmtChange(pre.level, post, cal)} across a stop with the vehicle's power (master switch) off ` +
        `(${before} before the power was cut, ${est}). Possible theft.`,
        { fromT: pre.t, amountMv: Math.round(drop), fromMv: Math.round(pre.level), toMv: Math.round(post) });
    } else {
      this.alert(s, 'fuel_drain', 'Fuel drop at a stop',
        `Fuel fell by about ${this.fmtChange(pre.level, post, cal)} at a stop of ${fmtDuration(po.departT - pre.t)} ` +
        `(${before} ${pre.kind === 'settled' ? 'while parked' : 'when it stopped'}, ${est}). Possible theft.`,
        { fromT: pre.t, amountMv: Math.round(drop), fromMv: Math.round(pre.level), toMv: Math.round(post) });
    }
  }

  bridgeCheck(s, pre, post, allowance, th, cal) {
    const margin = Math.max(pre.margin, post.margin);
    if (this.trace) this.trace({ kind: 'bridge', t: s.t, pre, post, margin, allowance });
    const drop = pre.level - post.level;
    const levels = `about ${this.fmtLevel(pre.level, cal)} before the power was cut, ${this.fmtLevel(post.level, cal)} after it came back`;
    const a = this.prevStopLevel;
    if (drop - allowance >= th.drainParkedMv + margin) {
      if (a) this.tripDrainFrom = a.t;
      this.alert(s, 'fuel_drain', 'Fuel drop while power was off',
        `Fuel fell by ${this.fmtChange(pre.level, post.level, cal)} while the vehicle's power (master switch) was off (${levels}). Possible theft.`,
        { fromT: pre.t, amountMv: Math.round(drop), fromMv: Math.round(pre.level), toMv: Math.round(post.level) });
    } else if (-drop >= th.refuelMv + margin) {
      if (a) this.drivingRefuelFrom = a.t;
      this.refuelAlert(s, pre.t, pre.level, post.level, 'Refuel',
        (from, to) => `Fuel rose by about ${this.fmtChange(from, to, cal)} while the vehicle's power was off (about ${this.fmtLevel(from, cal)} before the power was cut, ${this.fmtLevel(to, cal)} after it came back).`, false);
    }
  }

  tailLevel(stop) {
    const r = stop.readings;
    if (!r.length) return null;
    const end = r[r.length - 1].t;
    const win = r.filter((x) => x.t >= end - TAIL_MS);
    const level = win.length >= 3 ? flatLevel(win) : null;
    return level == null ? null : { level, t: end };
  }

  // ---- power / tamper ------------------------------------------------------------------
  // Trucks routinely cut power with the battery master switch when parking (even while
  // still rolling at walking pace), so only a loss at real driving speed is a tamper sign.
  checkPower(s, powered, th) {
    if (s.pwr == null) return;
    if (!powered) {
      if (!this.pwrOff) this.pwrOff = { since: s.t, fastCount: 0, alertId: null };
      const p = this.pwrOff;
      if (s.spd >= POWER_CUT_KMH) p.fastCount++;
      if (p.alertId == null && p.fastCount >= 2) {
        p.alertId = this.alert(s, 'power_cut', 'Tracker power cut while driving',
          `External power fell to ${(s.pwr / 1000).toFixed(1)} V while driving at ${Math.round(s.spd)} km/h - the tracker may have been disconnected.`,
          { fromT: p.since, ongoing: true });
      }
    } else if (this.pwrOff) {
      const p = this.pwrOff;
      this.pwrOff = null;
      if (p.alertId != null) {
        this.update(p.alertId, { ongoing: false });
        this.alert(s, 'power_restored', 'Tracker power restored',
          `External power back at ${(s.pwr / 1000).toFixed(1)} V after ${fmtDuration(s.t - p.since)}.`, { fromT: s.t });
      }
    }
  }

  // ---- overspeed: two samples over the limit (single GPS spikes are common) ------------
  checkOverspeed(s, th) {
    const limit = th.overspeedKmh;
    if (!(limit > 0)) return;
    if (s.spd > limit) {
      if (!this.over) this.over = { fromT: s.t, max: 0, count: 0, alertId: null };
      const o = this.over;
      o.count++;
      o.max = Math.max(o.max, s.spd);
      if (o.alertId == null && o.count >= 2 && o.fromT >= this.overCooldownUntil) {
        o.alertId = this.alert(s, 'overspeed', 'Overspeed',
          `${Math.round(s.spd)} km/h (limit ${limit} km/h).`, { fromT: o.fromT, ongoing: true });
      }
    } else if (this.over && s.spd <= limit - 5) {
      const o = this.over;
      this.over = null;
      if (o.alertId != null) {
        this.overCooldownUntil = s.t + OVERSPEED_COOLDOWN_MS;
        this.update(o.alertId, {
          ongoing: false,
          detail: `Up to ${Math.round(o.max)} km/h for ${fmtDuration(s.t - o.fromT)} (limit ${limit} km/h).`,
        });
      }
    }
  }

  // ---- after-hours driving (optional; at most once per night) --------------------------
  checkAfterHours(s, th) {
    if (!th.afterHoursEnabled || s.spd < DEPART_KMH) return;
    const local = s.t + (th.tzOffsetMinutes ?? 480) * MIN;
    const minOfDay = Math.floor((((local % 86_400_000) + 86_400_000) % 86_400_000) / MIN);
    const start = hhmmToMin(th.afterHoursStart, 22 * 60);
    const end = hhmmToMin(th.afterHoursEnd, 6 * 60);
    const inWindow = start <= end ? minOfDay >= start && minOfDay < end : minOfDay >= start || minOfDay < end;
    if (!inWindow) return;
    const night = Math.floor((local - start * MIN) / 86_400_000); // local date the window opened
    if (this.afterHoursNight === night) return;
    this.afterHoursNight = night;
    const hhmm = `${String(Math.floor(minOfDay / 60)).padStart(2, '0')}:${String(minOfDay % 60).padStart(2, '0')}`;
    this.alert(s, 'after_hours', 'Driving outside working hours',
      `Driving at ${Math.round(s.spd)} km/h at ${hhmm} local time (quiet hours ${th.afterHoursStart}-${th.afterHoursEnd}).`);
  }

  // ---- long idle: engine running while stopped; short engine-off blips don't end it,
  // but a data gap does (we can't tell whether it idled through the gap) -------------
  checkIdle(prev, s, th) {
    const stop = this.stop;
    if (!stop) return;
    if (s.engine) {
      if (stop.idle && s.t - stop.idle.lastOnT > 20 * MIN) {
        stop.idle.offSince = stop.idle.lastOnT;
        this.endIdle(stop, s);
      }
      if (!stop.idle) stop.idle = { start: s.t, lastOnT: s.t, offSince: null, alertId: null };
      const idle = stop.idle;
      idle.lastOnT = s.t;
      idle.offSince = null;
      if (idle.alertId == null && th.idleMinutes > 0 && s.t - idle.start >= th.idleMinutes * MIN) {
        idle.alertId = this.alert(s, 'long_idle', 'Long engine idle',
          `Engine running without moving for ${fmtDuration(s.t - idle.start)}.`, { fromT: idle.start, ongoing: true });
      }
    } else if (stop.idle) {
      const idle = stop.idle;
      if (idle.offSince == null) idle.offSince = s.t;
      if (s.t - idle.offSince >= 3 * MIN) this.endIdle(stop, s);
    }
  }

  endIdle(stop, s) {
    const idle = stop.idle;
    stop.idle = null;
    if (idle.alertId != null) {
      const end = idle.offSince ?? s.t;
      this.update(idle.alertId, { ongoing: false, detail: `Engine ran without moving for ${fmtDuration(end - idle.start)}.` });
    }
  }

  // ---- fuel ----------------------------------------------------------------------------
  checkFuel(s, dt, powered, th, cal) {
    const f = s.f;
    const valid = f != null && f >= th.sensorMinValidMv;
    if (valid && powered) {
      this.trackCeiling(f);
      if (s.spd >= MOVE_KMH && this.lastValidF != null) {
        this.jumpRate += ((Math.abs(f - this.lastValidF) >= 1500 ? 1 : 0) - this.jumpRate) * 0.005;
      }
      this.recent.push({ t: s.t, f });
      // Rough level from 10 min of readings taken after the last trusted level. Its minimum
      // shows how low the tank got before a refuel that happened during a stop too short (or
      // a data gap too long) to settle.
      const after = this.levelT == null ? this.recent : this.recent.filter((x) => x.t > this.levelT);
      if (after.length >= 10 && s.t - after[0].t >= 5 * MIN) {
        const r = median(after.map((x) => x.f));
        if (!this.roughMin || r < this.roughMin.level) this.roughMin = { level: r, t: s.t };
      }
      if (!this.stop && this.recent.length >= 10 && s.t - this.recent[0].t >= 5 * MIN) {
        this.checkDrivingRefuel(s, this.recent.map((x) => x.f).sort((a, b) => a - b), th, cal);
      }
    }
    this.checkSensor(s, dt, powered, valid, th, cal);

    if (!this.stop && this.pendingOut && valid && powered) this.checkDriveOut(s, th, cal);

    const stop = this.stop;
    if (!stop || s.spd >= MOVE_KMH) return;
    if (!powered) {
      // master switch off: the sensor reads ~0; the reference level survives the outage
      if (!stop.preOff && !stop.bridged) stop.preOff = this.levelBeforeCut(stop);
      if (stop.readings.length) stop.readings = [];
      if (stop.ref) stop.powerOffSinceRef = true;
      stop.postOn = [];
      stop.skipNext = true;
      return;
    }
    if (!valid) return;
    if (!stop.preOff && s.t - stop.startT >= 20_000) {
      stop.early.push({ t: s.t, f });
      if (stop.early.length > 20) stop.early.shift();
    }
    if (s.t - stop.startT < SETTLE_MS) return;
    if (stop.skipNext) { stop.skipNext = false; return; }
    if (stop.preOff) stop.postOn.push({ t: s.t, f });
    stop.lastReadingT = s.t;

    if (stop.pinSince != null && !stop.ref && stop.pinReleasedAt == null && !this.nearCeiling(f)) stop.pinReleasedAt = s.t;
    if (stop.ref && !stop.pending && !stop.event && Math.abs(f - stop.ref.level) <= LEVEL_TOL_MV) stop.ref.lastRawT = s.t;
    stop.readings.push({ t: s.t, f });
    while (stop.readings.length > 60 || (stop.readings.length > 3 && stop.readings[0].t < s.t - 3 * HOUR)) stop.readings.shift();

    let win = stop.readings.filter((r) => r.t >= s.t - WINDOW_MS);
    let level = null;
    let sparse = false;
    let weak = false;
    if (win.length >= 3) {
      level = flatLevel(win);
    } else {
      // sparse reporting (e.g. hourly while parked): last three, or last two far apart
      const r = stop.readings;
      sparse = r.length >= 2 && r[r.length - 1].t - r[r.length - 2].t >= SPARSE_GAP_MS;
      win = r.slice(-3);
      level = win.length === 3 ? flatLevel(win) : null;
      if (level == null) {
        level = flatLevel((win = r.slice(-2)));
        weak = level != null;
      }
    }
    if (level == null) return;
    // how long the window has consistently shown this level (confirms sparse reports)
    const solidMs = win.every((r) => Math.abs(r.f - level) <= LEVEL_TOL_MV) ? win[win.length - 1].t - win[0].t : 0;
    this.onSettled(s, level, solidMs, sparse, weak, th, cal);
  }

  // The ceiling moves only to a value read at least twice: a one-off glitch reading
  // (e.g. a voltage spike) must not hide a probe that is pinned at its real top.
  trackCeiling(f) {
    if (f <= this.ceil) return;
    const k = this.ceilCands.findIndex((c) => Math.abs(c - f) <= 30);
    if (k >= 0) {
      this.ceil = Math.min(f, this.ceilCands[k]);
      this.ceilCands = this.ceilCands.filter((c) => c > this.ceil);
    } else {
      this.ceilCands.push(f);
      if (this.ceilCands.length > 16) this.ceilCands.shift();
    }
  }

  nearCeiling(level) {
    return this.ceil > 0 && level >= this.ceil - Math.max(100, this.ceil * 0.015);
  }

  onSettled(s, level, solidMs, sparse, weak, th, cal) {
    const stop = this.stop;
    if (!stop.ref) {
      // After a drive a probe may still be stuck at its ceiling, or draining from it.
      if (stop.afterDrive && this.nearCeiling(level)) {
        if (stop.pinSince == null) stop.pinSince = s.t;
        if (s.t - stop.pinSince < PIN_CONFIRM_MS) return;
      } else if (stop.pinSince != null && s.t - (stop.pinReleasedAt ?? s.t) < PIN_RELEASE_MS) {
        return;
      }
      this.startRef(stop, s, level, s.t, th, cal);
      return;
    }

    if (stop.event) {
      if (weak) return;
      stop.last = { level, t: s.t, ...this.mark() };
      this.setLevel(s.t, level, th, cal);
      this.trackEvent(s, stop, level, th, cal);
      return;
    }

    const ref = stop.ref;
    if (stop.watch && s.t > stop.watch.until) stop.watch = null;
    const allowance = this.idleAllowance(ref, th);
    const drop = ref.level - level;
    let type = null;
    if (stop.watch && level >= stop.watch.ev.fromLevel - th.drainParkedMv / 2 && level > ref.level + LEVEL_TOL_MV) type = 'recover';
    else if (drop - allowance >= th.drainParkedMv) type = 'fuel_drain';
    else if (level - Math.min(ref.level, ref.low.level) >= th.refuelMv) type = 'refuel';
    // Hourly reports: a change is trusted only once three readings spanning 2 h agree
    // (a two-reading dip is a common probe artefact on parked trucks).
    if (type && sparse && (weak || solidMs < SPARSE_CONFIRM_MS)) return;

    stop.last = { level, t: s.t, ...this.mark() };
    this.setLevel(s.t, level, th, cal);
    if (level <= ref.low.level + 20) ref.low = { level: Math.min(level, ref.low.level), t: s.t };

    if (!type) {
      stop.pending = null;
      // slow re-anchoring absorbs thermal drift and idle burn; theft is much faster
      if (s.t - ref.t >= REBASE_MS && Math.abs(drop) < th.drainParkedMv / 2) {
        stop.ref = { level, t: s.t, lastRawT: s.t, engineMs: this.engineMs, low: { level, t: s.t } };
        stop.powerOffSinceRef = false;
      }
      return;
    }
    if (!stop.pending || stop.pending.type !== type) stop.pending = { type, since: s.t };
    if (!sparse && s.t - stop.pending.since < CONFIRM_MS && solidMs < CONFIRM_MS) return;
    if (type === 'recover') this.recoverDrain(stop, s, level, th, cal);
    else if (type === 'fuel_drain' && stop.watch) this.reopenDrain(stop, s, level, th, cal);
    else this.openEvent(stop, s, type, level, allowance, th, cal, false);
  }

  startRef(stop, s, level, t, th, cal) {
    const rough = this.roughMin;
    stop.ref = { level, t, lastRawT: t, engineMs: this.engineMs, low: { level, t } };
    stop.powerOffSinceRef = false;
    stop.last = { level, t, ...this.mark() };
    this.setLevel(t, level, th, cal);
    if (stop.preOff && !stop.bridged) {
      stop.bridged = true;
      this.bridgeCheck(s, stop.preOff, { level, t, margin: 0 }, 0, th, cal);
    }
    if (this.pendingOut) this.resolveDriveOut(s, level, th, cal);
    if (this.prevStopLevel) {
      this.checkTrip(s, level, rough, th, cal);
    } else if (rough && level - rough.level >= th.refuelMv + ROUGH_MARGIN_MV) {
      // first trusted level ever: compare with the driving median, with a wide margin
      this.refuelAlert(s, rough.t, rough.level, level, 'Refuel',
        (from, to) => `Fuel rose by about ${this.fmtChange(from, to, cal)} (from roughly ${this.fmtLevel(from, cal)} while driving to ${this.fmtLevel(to, cal)}).`, false);
    }
  }

  idleAllowance(ref, th) {
    return ((this.engineMs - ref.engineMs) / HOUR) * th.consumptionMvPerHour * IDLE_BURN_FACTOR;
  }

  openEvent(stop, s, type, level, allowance, th, cal, atDeparture) {
    const ref = stop.ref;
    stop.pending = null;
    stop.watch = null;
    const fromLow = type === 'refuel' && ref.low.level < ref.level;
    const ev = {
      type, fromLevel: fromLow ? ref.low.level : ref.level, fromT: fromLow ? ref.low.t : ref.lastRawT,
      extreme: level, lastChangeT: s.t, powerOff: stop.powerOffSinceRef, allowance, atDeparture, id: null,
    };
    if (type === 'refuel') {
      ev.id = this.refuelAlert(s, ev.fromT, ev.fromLevel, level, 'Refuel',
        (from, to) => this.describeEvent({ ...ev, fromLevel: from, extreme: to }, s.t, th, cal), !atDeparture);
      const lr = this.lastRefuel;
      if (lr && lr.id === ev.id) { ev.fromLevel = lr.fromLevel; ev.fromT = lr.fromT; }
    } else {
      ev.id = this.alert(s, type, 'Fuel drop while parked', this.describeEvent(ev, s.t, th, cal),
        { fromT: ev.fromT, amountMv: Math.abs(Math.round(level - ev.fromLevel)), fromMv: Math.round(ev.fromLevel), toMv: Math.round(level), ongoing: !atDeparture });
    }
    if (!atDeparture) stop.event = ev;
  }

  trackEvent(s, stop, level, th, cal) {
    const ev = stop.event;
    const further = ev.type === 'fuel_drain' ? level < ev.extreme - 50 : level > ev.extreme + 50;
    if (further) {
      ev.extreme = level;
      ev.lastChangeT = s.t;
      this.update(ev.id, { amountMv: Math.abs(Math.round(level - ev.fromLevel)), toMv: Math.round(level), detail: this.describeEvent(ev, s.t, th, cal) });
      if (ev.type === 'refuel' && this.lastRefuel && this.lastRefuel.id === ev.id) {
        this.lastRefuel.toLevel = level;
        this.lastRefuel.endT = s.t;
      }
      return;
    }
    if (ev.type === 'fuel_drain' && level >= ev.fromLevel - th.drainParkedMv / 2) {
      // the level came back: more likely a tilt/sensor artefact than a loss
      stop.event = null;
      stop.watch = { ev, until: s.t };
      this.recoverDrain(stop, s, level, th, cal);
      return;
    }
    if (s.t - ev.lastChangeT >= EVENT_QUIET_MS) this.closeEvent(stop);
  }

  closeEvent(stop, detail) {
    const ev = stop.event;
    stop.event = null;
    stop.pending = null;
    this.update(ev.id, detail ? { ongoing: false, detail } : { ongoing: false });
    // a closed drain stays watched: its level may come back (sensor dip) or keep falling
    // (slow siphon), which updates this alert instead of raising new ones
    if (ev.type === 'fuel_drain' && this.last) stop.watch = { ev, until: this.last.t + WATCH_MS };
    if (stop.last) {
      const { level, t, engineMs } = stop.last;
      stop.ref = { level, t, lastRawT: t, engineMs, low: { level, t } };
    }
    stop.powerOffSinceRef = false;
  }

  // A parked drop whose level came back: downgrade it to an info-level sensor dip.
  recoverDrain(stop, s, level, th, cal) {
    const ev = stop.watch.ev;
    stop.watch = null;
    stop.pending = null;
    this.update(ev.id, {
      severity: 'info', title: 'Fuel sensor dip (level recovered)', ongoing: false, amountMv: null,
      dipMv: Math.round(ev.fromLevel - ev.extreme), // the size of the dip, kept for the fuel ledger
      recoveredMv: Math.round(level), // ...and the level it came back to
      detail: `${this.describeEvent(ev, ev.lastChangeT, th, cal, true)} The reading later returned to ${this.fmtLevel(level, cal)}, ` +
        'so this was most likely a sensor or tilt artefact, not a loss.',
    });
    stop.ref = { level, t: s.t, lastRawT: s.t, engineMs: this.engineMs, low: { level, t: s.t } };
    stop.powerOffSinceRef = false;
  }

  // A closed drain keeps going (slow siphon or leak): extend the same alert.
  reopenDrain(stop, s, level, th, cal) {
    const ev = stop.watch.ev;
    stop.watch = null;
    stop.pending = null;
    ev.extreme = Math.min(ev.extreme, level);
    ev.lastChangeT = s.t;
    ev.powerOff = ev.powerOff || stop.powerOffSinceRef;
    stop.event = ev;
    this.update(ev.id, { ongoing: true, amountMv: Math.round(ev.fromLevel - ev.extreme), toMv: Math.round(ev.extreme), detail: this.describeEvent(ev, s.t, th, cal) });
  }

  describeEvent(ev, now, th, cal, recovered = false) {
    const levels = `${this.fmtLevel(ev.fromLevel, cal)} → ${this.fmtLevel(ev.extreme, cal)}`;
    if (ev.type === 'refuel') return `Fuel rose by ${this.fmtChange(ev.fromLevel, ev.extreme, cal)} while stopped (${levels}).`;
    let d = `Fuel fell by ${this.fmtChange(ev.fromLevel, ev.extreme, cal)} within ${fmtDuration(now - ev.fromT)} while parked (${levels})`;
    if (ev.powerOff) d += ', across a period with vehicle power (master switch) off';
    if (ev.atDeparture) d += ', just before driving off';
    if (ev.allowance >= 20) d += `; idling explains at most ${this.fmtAmount(ev.allowance, cal)}`;
    return recovered ? `${d}.` : `${d}. Possible theft or leak.`;
  }

  // Refuel alert; a refuel starting within an hour of the previous one (the same fill-up seen
  // in two steps, e.g. the truck crept forward at the pump, or by two detection paths)
  // extends that alert instead.
  refuelAlert(s, fromT, fromLevel, toLevel, title, describe, ongoing) {
    const lr = this.lastRefuel;
    this.lastRefuelT = s.t;
    if (lr && fromT >= lr.fromT - REFUEL_MERGE_MS && fromT <= lr.endT + REFUEL_MERGE_MS && fromLevel <= lr.toLevel + SLOPE_MV) {
      if (toLevel > lr.toLevel + 50) {
        lr.toLevel = toLevel;
        lr.endT = s.t;
        this.update(lr.id, { amountMv: Math.round(toLevel - lr.fromLevel), toMv: Math.round(toLevel), detail: describe(lr.fromLevel, toLevel), ongoing: !!ongoing });
      }
      return lr.id;
    }
    const id = this.alert(s, 'refuel', title, describe(fromLevel, toLevel),
      { fromT, amountMv: Math.round(toLevel - fromLevel), fromMv: Math.round(fromLevel), toMv: Math.round(toLevel), ...(ongoing ? { ongoing: true } : {}) });
    this.lastRefuel = { id, fromT, fromLevel, toLevel, endT: s.t };
    return id;
  }

  // First trusted level of a stop vs. the last one before the trip.
  checkTrip(s, level, rough, th, cal) {
    const a = this.prevStopLevel;
    this.prevStopLevel = null;
    if (!a) return;
    const engineH = (this.engineMs - a.engineMs) / HOUR;
    const movingH = (this.movingMs - a.movingMs) / HOUR;
    const gapKm = this.gapKm - (a.gapKm ?? this.gapKm);
    const unknown = this.unknownGaps !== (a.unknownGaps ?? this.unknownGaps);
    const change = level - a.level;
    const span = fmtDuration(s.t - a.t);
    const rate = this.tripRate(th);
    const expected = engineH * rate + gapKm * (rate / AVG_KMH);
    if (this.trace) this.trace({ kind: 'trip', fromT: a.t, t: s.t, from: a.level, to: level, engineH, movingH, gapKm, unknown, rate, expected });
    const r = rough && rough.t > a.t ? rough : null;
    const roughRise = r ? level - r.level : -Infinity;
    if (change >= th.refuelMv + SLOPE_MV || roughRise >= th.refuelMv + ROUGH_MARGIN_MV) {
      if (this.drivingRefuelFrom === a.t) return; // already reported while driving
      const low = roughRise > change ? r : { level: a.level, t: a.t };
      this.refuelAlert(s, low.t, low.level, level, 'Refuel',
        (from, to) => `Fuel rose by at least ${this.fmtChange(from, to, cal)} between stops (${this.fmtLevel(from, cal)} → ${this.fmtLevel(to, cal)}, ${span}).`, false);
      return;
    }
    // the tracker was silent while the vehicle moved an unknown distance: no verdict
    if (unknown) return;
    const loss = -change;
    if (loss - expected >= th.drainTripMv && this.tripDrainFrom !== a.t) {
      const unseen = gapKm >= 1 ? ` and ${Math.round(gapKm)} km driven while the tracker was silent` : '';
      this.alert(s, 'fuel_drain', 'Abnormal fuel loss between stops',
        `Fuel fell by ${this.fmtChange(a.level, level, cal)} over ${span} (${this.fmtLevel(a.level, cal)} → ${this.fmtLevel(level, cal)}); ` +
        `${engineH.toFixed(1)} engine-hours${unseen} explain at most ${this.fmtAmount(expected, cal)}. Possible theft or leak on the way.`,
        { fromT: a.t, amountMv: Math.round(loss - expected), fromMv: Math.round(a.level), toMv: Math.round(level) });
      return;
    }
    // learn from real drives only (not trips that were mostly idling or had silences);
    // near-zero rates come from slope differences between parking spots, not from driving
    if (gapKm === 0 && engineH >= LEARN_MIN_ENGINE_H && movingH >= engineH * 0.5 && change < th.refuelMv / 2) {
      const rt = loss / engineH;
      if (rt >= th.consumptionMvPerHour * LEARN_MIN_FACTOR && rt <= 3000 && !this.rates.some((x) => Math.abs(x.t - s.t) < 1000)) {
        this.rates.push({ t: s.t, r: rt });
        this.rates.sort((x, y) => x.t - y.t);
        if (this.rates.length > RATES_KEEP) this.rates.shift();
      }
    }
  }

  // A refuel at a stop too short to settle shows up as a clearly higher level on the way
  // out. Only trusted when the driving readings are calm (narrow 10-90% spread) on a
  // vehicle whose sensor doesn't habitually jump while driving (sloshing / sticking probes).
  checkDrivingRefuel(s, sorted, th, cal) {
    const a = this.prevStopLevel;
    if (!a || this.drivingRefuelFrom === a.t || s.spd < MOVE_KMH || this.jumpRate > 0.005) return;
    const n = sorted.length;
    if (sorted[Math.floor(n * 0.9)] - sorted[Math.floor(n * 0.1)] > 300) return;
    const med = sorted[n >> 1];
    if (med - a.level < th.refuelMv + ROUGH_MARGIN_MV) return;
    // "from" = the lowest point seen before the refuel, so every detection path (and a
    // replay after restart) yields the same alert key
    const r = this.roughMin;
    const low = r && r.t > a.t && r.level < a.level ? r : { level: a.level, t: a.t };
    this.drivingRefuelFrom = a.t;
    this.refuelAlert(s, low.t, low.level, med, 'Refuel',
      (from, to) => `Fuel rose by about ${this.fmtChange(from, to, cal)} at a short stop (${this.fmtLevel(from, cal)} → about ${this.fmtLevel(to, cal)} while driving on).`, false);
  }

  // High percentile of the learned trip rates: loaded trucks burn far more than empty ones.
  learnedRate() {
    return this.rates.length >= 3 ? percentile(this.rates.map((x) => x.r), RATE_PERCENTILE) : null;
  }

  // Generous rate for the trip-loss check, never below the configured normal rate.
  tripRate(th) {
    return Math.max(this.learnedRate() ?? 0, th.consumptionMvPerHour) * TRIP_HEADROOM;
  }

  setLevel(t, level, th, cal) {
    this.level = level;
    this.levelT = t;
    this.roughMin = null;
    this.levelMin = Math.min(this.levelMin, level);
    this.levelMax = Math.max(this.levelMax, level);
    this.reportLevel(t, level, false);
    this.checkLowFuel(t, level, th, cal);
  }

  // Trusted levels for the backend, thinned out: on real change, hourly, and each stop's
  // final level. Nothing while the reading is frozen (a stuck value is not a level).
  reportLevel(t, level, force) {
    if (!this.onLevel || (this.frozen && this.frozen.done)) return;
    const le = this.lastEmittedLevel;
    if (le && le.t >= t) return;
    if (!force && le && Math.abs(le.level - level) < 30 && t - le.t < HOUR) return;
    this.lastEmittedLevel = { t, level };
    this.onLevel(t, level);
  }

  checkLowFuel(t, level, th, cal) {
    const pct = this.pct(level, cal);
    if (pct >= th.lowFuelPct) this.seenAboveLow = true;
    if (!this.lowFuel && pct < th.lowFuelPct) {
      this.lowFuel = true;
      // only on a transition we observed, so a replay after restart doesn't repeat it
      if (this.seenAboveLow && this.getState().sensorOk !== false) {
        this.alert({ ...this.last, t }, 'low_fuel', 'Low fuel',
          `Fuel is down to ${this.fmtLevel(level, cal)} (alert below ${th.lowFuelPct}%).`);
      }
    } else if (this.lowFuel && pct > th.lowFuelPct + 5) {
      this.lowFuel = false;
    }
  }

  // ---- sensor health -------------------------------------------------------------------
  // "Lost": reads ~0 while the vehicle has power. A flickering sensor stays in one episode
  // until it reads well for SENSOR_GOOD_MS. "Frozen": a valid-looking value that doesn't
  // change over long driving (disconnected input or probe stuck at its end stop).
  // Alerts need proof the sensor worked while we watched (a real trusted level, or trusted
  // levels that changed); otherwise only the no-signal state is shown. This keeps dead
  // sensors, restarts and tanks run nearly empty (reading bottoms out) from spamming.
  checkSensor(s, dt, powered, valid, th, cal) {
    if (!powered || s.f == null) return;
    if (valid) {
      this.sensorEverValid = true;
      this.lastValidF = s.f;
      this.badSince = null;
      this.badCount = 0;
      this.emptyTank = false;
      if (this.goodSince == null) this.goodSince = s.t;
      this.goodCount++;
      if (this.sensorLost && this.goodCount >= 10 && s.t - this.goodSince >= SENSOR_GOOD_MS) {
        const lost = this.sensorLost;
        this.sensorLost = null;
        if (lost.alertId != null) {
          this.update(lost.alertId, { ongoing: false });
          this.alert(s, 'sensor_restored', 'Fuel sensor working again',
            `Fuel sensor reads normally again (${Math.round(s.f)} mV) after ${fmtDuration(this.goodSince - lost.since)} without a valid signal.`,
            { fromT: this.goodSince });
        }
      }
      this.checkFrozen(s, dt, cal);
    } else {
      this.goodSince = null;
      this.goodCount = 0;
      if (this.badSince == null) this.badSince = s.t;
      this.badCount++;
      if (!this.sensorLost && !this.emptyTank && this.badCount >= 5 && s.t - this.badSince >= SENSOR_BAD_MS) {
        if (this.nearlyEmpty(th, cal)) {
          // the reading slid down gradually from an already low level: the tank ran (nearly)
          // dry; a cut wire drops to ~0 at once
          this.emptyTank = true;
          if (!this.lowFuel) {
            this.lowFuel = true;
            this.alert(s, 'low_fuel', 'Tank nearly empty',
              `The fuel reading slid gradually below the sensor's range (now ${Math.round(s.f)} mV; last trusted level ${this.fmtLevel(this.level, cal)}) - the tank is (nearly) empty.`);
          }
          return;
        }
        this.sensorLost = { since: this.badSince, alertId: null };
        if (this.level != null && this.level >= th.sensorMinValidMv + 300) {
          this.sensorLost.alertId = this.alert(s, 'sensor_lost', 'Fuel sensor not reading',
            `Fuel sensor reads ${Math.round(s.f)} mV while the vehicle has power - cut wire, unplugged or failed sensor. ` +
            `Last trusted level ${this.fmtLevel(this.level, cal)}.`,
            { fromT: this.badSince, ongoing: true });
        }
      }
    }
  }

  nearlyEmpty(th, cal) {
    if (this.level == null || this.lastValidF == null) return false;
    if (this.pct(this.level, cal) >= 2 * th.lowFuelPct) return false;
    const slid = this.lastValidF < th.sensorMinValidMv + 300;
    const lowRough = this.roughMin != null && this.pct(this.roughMin.level, cal) < 2 * th.lowFuelPct;
    return slid || (lowRough && this.lastValidF < th.sensorMinValidMv + 600);
  }

  checkFrozen(s, dt, cal) {
    const fr = this.frozen;
    if (fr && Math.abs(s.f - fr.value) <= FROZEN_TOL_MV) {
      fr.off = 0;
      if (s.spd >= MOVE_KMH) fr.movingMs += Math.min(dt, 5 * MIN);
      if (!fr.done && fr.movingMs >= FROZEN_MOVING_MS) {
        // a full tank holds the probe at its top end: that is not a frozen sensor
        const seenWorking = this.levelMax - this.levelMin >= 1000;
        const high = this.pct(fr.value, cal) >= 50 || fr.value >= cal.fullMv - 100;
        const atTop = high && (fr.value >= cal.fullMv - 100 || this.nearCeiling(fr.value) ||
          (seenWorking && fr.value >= this.levelMax - 100) || s.t - this.lastRefuelT < 6 * HOUR);
        if (atTop) {
          fr.movingMs = 0;
          return;
        }
        fr.done = true;
        if (!this.sensorLost && this.levelMax - this.levelMin >= 100) {
          fr.alertId = this.alert(s, 'sensor_lost', 'Fuel sensor reading frozen',
            `Fuel reading has stayed at ${Math.round(fr.value)} mV through ${fmtDuration(fr.movingMs)} of driving - sensor disconnected or stuck.`,
            { fromT: fr.since, ongoing: true });
        }
      }
      return;
    }
    // occasional spikes don't unfreeze it; a sustained different reading does
    if (fr && ++fr.off < 5) return;
    if (fr && fr.alertId != null) {
      this.update(fr.alertId, { ongoing: false });
      this.alert(s, 'sensor_restored', 'Fuel sensor working again',
        `Fuel reading is changing again (${Math.round(s.f)} mV).`, { fromT: s.t });
    }
    this.frozen = { value: s.f, since: s.t, movingMs: 0, off: 0, alertId: null, done: false };
  }

  // ---- formatting ----------------------------------------------------------------------
  // cal = { emptyMv, fullMv, tankLiters }; an optional cal.table [[mV, litres], ...]
  // (the GPS server's piecewise tank calibration) makes litre figures exact.
  litres(mv, cal) {
    const tb = Array.isArray(cal.table) && cal.table.length >= 2 ? cal.table : null;
    if (tb) {
      if (mv <= tb[0][0]) return tb[0][1];
      for (let i = 1; i < tb.length; i++) {
        const [x1, y1] = tb[i];
        const [x0, y0] = tb[i - 1];
        if (mv <= x1) return x1 === x0 ? y1 : y0 + ((mv - x0) * (y1 - y0)) / (x1 - x0);
      }
      return tb[tb.length - 1][1];
    }
    if (!cal.tankLiters) return null;
    return (Math.max(0, Math.min(100, this.pct(mv, cal))) / 100) * cal.tankLiters;
  }

  pct(mv, cal) {
    const tb = Array.isArray(cal.table) && cal.table.length >= 2 ? cal.table : null;
    if (tb) {
      const full = tb[tb.length - 1][1];
      return full > 0 ? (this.litres(mv, cal) / full) * 100 : 0;
    }
    const span = cal.fullMv - cal.emptyMv;
    return span > 0 ? ((mv - cal.emptyMv) / span) * 100 : 0;
  }

  // size of a change between two levels
  fmtChange(fromMv, toMv, cal) {
    const d = Math.abs(toMv - fromMv);
    const l1 = this.litres(fromMv, cal);
    const l2 = this.litres(toMv, cal);
    if (l1 != null && l2 != null) return `${Math.round(Math.abs(l2 - l1))} L (${Math.round(d)} mV)`;
    return this.fmtAmount(d, cal);
  }

  // size of an allowance (no absolute level): linear approximation
  fmtAmount(mv, cal) {
    const span = cal.fullMv - cal.emptyMv;
    const pct = span > 0 ? (mv / span) * 100 : 0;
    if (cal.tankLiters) return `${Math.round((pct / 100) * cal.tankLiters)} L (${Math.round(mv)} mV)`;
    return `${Math.round(mv)} mV (≈${pct.toFixed(pct < 10 ? 1 : 0)}% of tank)`;
  }

  fmtLevel(mv, cal) {
    const l = this.litres(mv, cal);
    if (l != null) return `${Math.round(l)} L`;
    const pct = Math.max(0, Math.min(100, this.pct(mv, cal)));
    return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
  }
}
