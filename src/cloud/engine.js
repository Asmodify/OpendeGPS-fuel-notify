// The local Engine (src/engine.js) adapted to short-lived cloud function runs: its data comes
// from a MemDb filled from Postgres, each vehicle's detector is restored from its snapshot only
// when it gets new samples, and the per-vehicle backend state (offline flags, data holds, ...)
// is carried between runs in fuel.vehicles.rec.
import { Engine, HttpError } from '../engine.js';
import { isPlainObject, clamp } from '../util.js';

export const CHECK_INTERVAL_DEFAULT = 30; // minutes between checks of the GPS server
export const CHECK_INTERVAL_MIN = 5;
export const CHECK_INTERVAL_MAX = 120;

/** checkIntervalMinutes from the 'global' setting (default 30, clamped to 5 .. 120). */
export function checkIntervalOf(global) {
  const n = Number(global?.checkIntervalMinutes);
  return Number.isFinite(n) ? clamp(Math.round(n), CHECK_INTERVAL_MIN, CHECK_INTERVAL_MAX) : CHECK_INTERVAL_DEFAULT;
}

/** rec fields kept between ticks. */
const fin = (x) => (Number.isFinite(x) ? x : null);

export function recStateOf(rec) {
  return {
    detT: fin(rec.detT),
    lastT: fin(rec.lastT),
    lastLevel: rec.lastLevel ?? null,
    lastPushed: rec.lastPushed ?? null,
    hold: rec.hold ?? null,
    offline: typeof rec.offline === 'boolean' ? rec.offline : null,
    offlineFrom: fin(rec.offlineFrom),
    afterHoursNight: rec.afterHoursNight ?? null,
    polledLevelT: fin(rec.polledLevelT),
    fetchedSeen: fin(rec.fetchedSeen),
    fetchedServerSeen: fin(rec.fetchedServerSeen),
    fetchedAt: fin(rec.fetchedAt),
    detErrors: rec.detErrors || 0,
    futureLogged: !!rec.futureLogged,
    backfilled: !!rec.backfilled,
    dueSince: fin(rec.dueSince),
  };
}

function applyRecState(rec, s) {
  if (!isPlainObject(s)) return;
  rec.detT = Number.isFinite(s.detT) ? s.detT : -Infinity;
  rec.lastT = fin(s.lastT);
  rec.lastLevel = s.lastLevel ?? null;
  rec.lastPushed = s.lastPushed ?? null;
  rec.hold = s.hold ?? null;
  rec.offline = typeof s.offline === 'boolean' ? s.offline : undefined;
  rec.offlineFrom = fin(s.offlineFrom);
  rec.afterHoursNight = s.afterHoursNight ?? null;
  rec.polledLevelT = fin(s.polledLevelT);
  rec.fetchedSeen = fin(s.fetchedSeen);
  rec.fetchedServerSeen = fin(s.fetchedServerSeen);
  rec.fetchedAt = fin(s.fetchedAt);
  rec.detErrors = s.detErrors || 0;
  rec.futureLogged = !!s.futureLogged;
  rec.backfilled = !!s.backfilled;
  rec.dueSince = fin(s.dueSince);
  rec.historicalNext = !rec.backfilled;
}

export class CloudEngine extends Engine {
  /**
   * recStates: Map imei -> saved rec state; detStates: Map imei -> the detector's getState()
   * from its last run (used for vehicles whose detector is not restored in this run).
   */
  constructor({ cfg, db, recStates = new Map(), detStates = new Map(), startedAt = null }) {
    super({ cfg, db, hub: null });
    this.recStates = recStates;
    this.detStates = detStates;
    if (Number.isFinite(cfg.tzOffsetMinutes)) this.tzOffsetMin = cfg.tzOffsetMinutes;
    this.historyReady = true;
    if (Number.isFinite(startedAt)) this.startedAt = startedAt; // first tick of the service
  }

  async init() {
    await this.loadDetector();
    this.loadVehiclesFromDb();
    return this;
  }

  addRec(imei, info, hasFuel) {
    const rec = super.addRec(imei, info, hasFuel);
    rec.staleOfflineChecked = true; // outages are followed across ticks through rec.offline
    applyRecState(rec, this.recStates.get(imei));
    return rec;
  }

  /** Detectors are created on demand (ensureDetector), only for vehicles that get samples. */
  makeDetector() {
    return null;
  }

  /** The vehicle's detector, restored from `snap` (VehicleDetector.snapshot()) or new. */
  ensureDetector(rec, snap) {
    if (rec.det || !this.DetectorClass) return rec.det;
    const D = this.DetectorClass;
    const args = [
      rec.v,
      () => this.settingsFor(rec.imei),
      (alert) => this.onDetectorEmit(rec, alert),
      (id, patch) => this.onDetectorUpdate(rec, id, patch),
      (t, mv) => this.onLevel(rec, t, mv, false),
    ];
    try {
      rec.det = snap && typeof D.restore === 'function' ? D.restore(snap, ...args) : new D(...args);
    } catch (e) {
      rec.det = null;
      throw e;
    }
    return rec.det;
  }

  detState(rec) {
    if (rec.det) return super.detState(rec);
    const s = this.detStates.get(rec.imei);
    return isPlainObject(s) ? s : null;
  }

  /** The detector snapshot keeps learned consumption rates; nothing else to save. */
  saveLearned() {}

  checkIntervalMinutes() {
    return checkIntervalOf(this.db.getSetting('global', {}));
  }

  settingsView() {
    const v = super.settingsView();
    if (v.notify) delete v.notify.windowsToast; // no desktop pop-ups in the cloud
    v.checkIntervalMinutes = this.checkIntervalMinutes();
    v.checkIntervalRange = [CHECK_INTERVAL_MIN, CHECK_INTERVAL_MAX];
    return v;
  }

  /** PUT /api/settings: as local, plus checkIntervalMinutes (minutes between GPS server checks). */
  putSettings(body) {
    if (!isPlainObject(body)) throw new HttpError(400, 'body must be a JSON object');
    let interval = this.checkIntervalMinutes();
    if (body.checkIntervalMinutes !== undefined) {
      const n = Number(body.checkIntervalMinutes);
      if (!Number.isFinite(n) || n < CHECK_INTERVAL_MIN || n > CHECK_INTERVAL_MAX) {
        throw new HttpError(400, `checkIntervalMinutes must be a number of minutes between ${CHECK_INTERVAL_MIN} and ${CHECK_INTERVAL_MAX}`);
      }
      interval = Math.round(n);
    }
    if (isPlainObject(body.notify)) {
      const { windowsToast, telegram, ...rest } = body.notify; // eslint-disable-line no-unused-vars
      body = { ...body, notify: rest };
    }
    super.putSettings(body); // stores { thresholds, notify } under 'global'
    this.db.setSetting('global', { ...this.db.getSetting('global', {}), checkIntervalMinutes: interval });
    return this.settingsView();
  }
}
