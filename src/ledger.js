// Excel fuel ledger: every refuel and every suspected fuel theft (fuel_drain alert) as a
// workbook the owner can open, filter and share. The database is the record; the file is
// rebuilt from it in full every time (so it never has duplicate or missing rows):
//
//   - ~30 s after a refuel / fuel drain is created or changes (amount, ongoing, review), at
//     most 5 min after the first of a burst of changes,
//   - once the start-up history backfill has finished,
//   - hourly as a safety net (only if something changed or the file is gone).
//
// Written atomically (temp file + rename, see xlsx.js). If the file is open in Excel (locked),
// nothing is lost: the write stays pending, is retried every minute, and /api/status shows it.
// A file that cannot be written for good (read-only, no permission to the file or folder) is
// reported as such and not retried every minute: only on the next change / hourly check.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { log, errText, num, clamp, round, shortName, tzOffsetMinutes } from './util.js';

const MIN = 60e3;
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const DEBOUNCE_MS = 30e3;
const MAX_WAIT_MS = 5 * MIN;
const RETRY_MS = 60e3;
const SAFETY_MS = HOUR;
const START_CHECK_MS = 3 * MIN; // see start()

export const LOCKED_MESSAGE = 'Excel file is open — it will be updated when you close it';
// write errors that waiting does not fix (xlsx.js codes, and fs errors creating the file)
const BLOCKED_CODES = new Set(['READONLY', 'NOACCESS', 'EACCES', 'EPERM', 'EROFS']);

const VERDICT_LABEL = { unchecked: 'Unchecked', confirmed: 'Confirmed theft', false_alarm: 'False alarm' };
const CANCELLED = 'Cancelled — level came back';
const DT = 'yyyy-mm-dd hh:mm';
const L1 = '#,##0.0';
const L0 = '#,##0';

function parseExtra(json) {
  if (!json) return {};
  if (typeof json === 'object') return Array.isArray(json) ? {} : json;
  try {
    const x = JSON.parse(json);
    return x && typeof x === 'object' && !Array.isArray(x) ? x : {};
  } catch {
    return {};
  }
}

/** A fuel drain whose level came back (the detector downgraded it to an info "sensor dip"). */
export function isCancelledDrain(row) {
  return row.type === 'fuel_drain' && (row.severity === 'info' || /level recovered/i.test(row.title || ''));
}

/**
 * How one refuel / fuel_drain alert row (a DB row) counts in the fuel ledger. The Excel file and
 * the dashboard's Report both use this, so their totals agree.
 *   cancelled: a drain whose level came back; verdict: the owner's review;
 *   counted:   in the totals. A drain counts unless the level came back or the owner marked it a
 *              false alarm; the owner's "confirmed theft" always counts. Refuels always count.
 *   mv:        its size in mV (for a cancelled drain: the size of the dip), null if unknown.
 * Litres: fuelEventLitres(row, mv, cal).
 */
export function ledgerEntry(row) {
  const verdict = row.verdict === 'confirmed' || row.verdict === 'false_alarm' ? row.verdict : 'unchecked';
  if (row.type !== 'fuel_drain') return { cancelled: false, verdict, counted: true, mv: num(row.amount_mv) };
  const cancelled = isCancelledDrain(row);
  const mv = cancelled ? num(parseExtra(row.extra).dipMv) : num(row.amount_mv);
  return { cancelled, verdict, counted: verdict === 'confirmed' || (!cancelled && verdict !== 'false_alarm'), mv };
}

/** Fuel level in % of the linear calibration span (null without a span). */
export function fuelPct(mv, cal) {
  const span = cal.fullMv - cal.emptyMv;
  if (!span) return null;
  return clamp(((mv - cal.emptyMv) / span) * 100, 0, 100);
}

/** Litres in the tank for a sensor reading (table interpolation when available). */
export function litersAt(mv, cal) {
  const tb = cal.table;
  if (Array.isArray(tb) && tb.length >= 2) {
    if (mv <= tb[0][0]) return tb[0][1];
    for (let i = 1; i < tb.length; i++) {
      if (mv <= tb[i][0]) {
        const [x0, y0] = tb[i - 1];
        const [x1, y1] = tb[i];
        return y0 + ((mv - x0) / (x1 - x0)) * (y1 - y0);
      }
    }
    return tb[tb.length - 1][1];
  }
  const pct = fuelPct(mv, cal);
  return pct !== null && cal.tankLiters ? (pct / 100) * cal.tankLiters : null;
}

/** Litres of a refuel / drain amount. The detector passes the level the change started from
 *  (extra.fromMv), so the tank table gives the exact figure its alert text quotes; without
 *  it the amount is converted linearly. `extra`: the alert's extra fields (object or JSON). */
export function amountLitres(type, amountMv, extra, cal) {
  if (amountMv === null || amountMv === undefined || !cal?.tankLiters) return null;
  const fromMv = extra && (type === 'refuel' || type === 'fuel_drain') ? num(parseExtra(extra).fromMv) : null;
  if (fromMv !== null) {
    const to = type === 'refuel' ? fromMv + amountMv : fromMv - amountMv;
    const a = litersAt(fromMv, cal);
    const b = litersAt(to, cal);
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return Math.abs(a - b);
  }
  const span = Math.abs(cal.fullMv - cal.emptyMv);
  return span ? (amountMv / span) * cal.tankLiters : null;
}

/** Litres of one refuel / drain as the fuel ledger and the Report count it: `mv` from
 *  ledgerEntry(row) (for a cancelled drain, its dip), rounded per alert like the alert text. */
export function fuelEventLitres(row, mv, cal) {
  const L = amountLitres(row.type, mv, row.extra, cal);
  return L === null || !Number.isFinite(L) ? null : round(L, 1);
}

/** Where / how a refuel or drain happened, from the detector's alert title and text. */
export function situationOf(row) {
  const title = String(row.title || '');
  const d = String(row.detail || '');
  const master = /master switch|power was off|power was cut/i.test(d) || /power was off/i.test(title);
  if (row.type === 'fuel_drain') {
    if (/between stops/i.test(title) || /on the way/i.test(d)) return 'During trip';
    if (/at a stop/i.test(title)) {
      if (master) return 'At a stop, master switch off';
      return /when it stopped/i.test(d) ? 'At a short stop' : 'At a stop (seen driving off)';
    }
    if (/power was off/i.test(title)) return 'Parked, master switch off';
    if (/while parked/i.test(d) || /parked/i.test(title)) {
      if (master) return 'Parked, master switch off';
      if (/just before driving off/i.test(d)) return 'Parked, just before driving off';
      return 'Parked';
    }
    return master ? 'Master switch off' : '';
  }
  if (master) return 'Parked, master switch off';
  if (/at a short stop/i.test(d)) return 'At a short stop';
  if (/between stops/i.test(d)) return 'Between stops (seen after the trip)';
  if (/while stopped/i.test(d)) return 'Parked';
  if (/at a stop/i.test(d)) return 'At a stop (seen driving off)';
  if (/while driving/i.test(d)) return 'While driving (first reading)';
  return '';
}

const validPos = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
const mapLink = (lat, lng) => (validPos(lat, lng) ? { text: 'Open map', url: `https://maps.google.com/?q=${lat.toFixed(6)},${lng.toFixed(6)}` } : null);

export class Ledger {
  constructor({ cfg, engine, db }) {
    this.cfg = cfg;
    this.engine = engine;
    this.db = db;
    this.file = cfg.excelFile || null; // null: no automatic file (download only)
    this.onStatus = null; // called when the status shown in /api/status changes (set by main.js)
    this.state = {
      lastWrittenAt: null,
      lastAttemptAt: null,
      nextRetryAt: null,
      pending: false,
      locked: false,
      blocked: false, // cannot be written until the owner fixes something (read-only, permissions)
      lastError: null,
    };
    this.events = null; // counts in the file as last written
    this.timer = null;
    this.firstTouchAt = null;
    this.safetyTimer = null;
    this.startTimer = null;
    this.writing = null;
    this.again = false;
    this.lastSig = null;
    this.lastStat = null;
    this.xlsxPromise = null;
    this.stopped = false;
    this.changeSeq = 0; // bumped by every touch(); a write covers the changes up to its start
  }

  start() {
    if (!this.file) {
      log('info', 'Excel fuel ledger file disabled (excelFile is empty); the dashboard download still works');
      return;
    }
    log('info', `Excel fuel ledger: ${this.file}`);
    this.safetyTimer = setInterval(() => this.flush('hourly check', true), SAFETY_MS);
    this.safetyTimer.unref?.();
    // Normally the file is written when the start-up history has loaded. If the GPS server does
    // not answer (no internet, wrong key, call limit), that never happens: then make sure a
    // file exists anyway, from what the database already holds.
    this.startTimer = setTimeout(() => {
      if (this.stopped || this.engine.historyReady || this.engine.backfilling || this.writing) return;
      if (this.state.pending || !fs.existsSync(this.file)) this.flush('start-up (GPS server not answering yet)', false);
    }, START_CHECK_MS);
    this.startTimer.unref?.();
  }

  /** Stop the timers; write once more if changes are still waiting (bounded by a timeout). */
  async stop(timeoutMs = 8000) {
    clearInterval(this.safetyTimer);
    clearTimeout(this.timer);
    clearTimeout(this.startTimer);
    // (whatever the poller was doing: the file is rebuilt from the database, which has it all)
    const due = this.state.pending && this.file && !this.stopped;
    this.stopped = true;
    if (!due) return;
    let t;
    await Promise.race([
      (this.writing || Promise.resolve()).then(() => this.writeNow('shutdown', false)),
      new Promise((resolve) => { t = setTimeout(resolve, timeoutMs); }),
    ]).catch(() => {});
    clearTimeout(t);
  }

  statusView() {
    return {
      enabled: !!this.file,
      file: this.file,
      ...this.state,
      events: this.events ? { ...this.events } : null,
    };
  }

  emitStatus() {
    try {
      this.onStatus?.();
    } catch {
      /* status broadcast must never break writing */
    }
  }

  /** A refuel / fuel drain was created or changed (or something shown in the file). */
  touch(reason = 'change') {
    if (!this.file || this.stopped) return;
    this.changeSeq++;
    const was = this.state.pending;
    this.state.pending = true;
    if (!was) this.emitStatus();
    // while the history backfill runs, alerts arrive by the hundred: historyReady() writes once
    // at the end. (Only then: when the GPS server is not answering there is no backfill, and the
    // owner's reviews must still reach the file.)
    if (this.engine.backfilling) return;
    if (this.state.locked || this.state.nextRetryAt) {
      // the retry timer writes everything; if that retry is being written right now, this
      // change may be too late for it: write again afterwards
      if (this.writing) this.again = true;
      return;
    }
    this.schedule(DEBOUNCE_MS, reason);
  }

  /** The start-up backfill is done (or skipped): write the ledger now. */
  historyReady() {
    if (!this.file || this.stopped) return;
    this.flush('history loaded', false);
  }

  schedule(delay, reason) {
    const now = Date.now();
    if (this.firstTouchAt === null) this.firstTouchAt = now;
    const at = Math.min(now + delay, this.firstTouchAt + MAX_WAIT_MS);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      // a backfill started meanwhile: historyReady() writes when it is done (pending stays set)
      if (this.engine.backfilling) return;
      this.flush(reason, false);
    }, Math.max(0, at - now));
    this.timer.unref?.();
  }

  /** Write now (or right after the write in progress). onlyIfChanged: skip when the content
   *  and the file on disk are the same as last written. */
  flush(reason = 'change', onlyIfChanged = false) {
    if (!this.file || this.stopped) return Promise.resolve();
    if (this.writing) {
      this.again = true;
      return this.writing;
    }
    clearTimeout(this.timer);
    this.timer = null;
    this.firstTouchAt = null;
    this.writing = this.writeNow(reason, onlyIfChanged).finally(() => {
      this.writing = null;
      if (this.again && !this.stopped) {
        this.again = false;
        // (still locked: the retry timer already covers these changes)
        if (!this.state.nextRetryAt) this.schedule(1000, 'more changes');
      }
    });
    return this.writing;
  }

  fileUnchanged() {
    try {
      const st = fs.statSync(this.file);
      return !!this.lastStat && st.size === this.lastStat.size && st.mtimeMs === this.lastStat.mtimeMs;
    } catch {
      return false;
    }
  }

  async loadXlsx() {
    if (!this.xlsxPromise) {
      this.xlsxPromise = import('./xlsx.js').then((m) => {
        if (typeof m.buildXlsx !== 'function' || typeof m.writeFileAtomic !== 'function') {
          throw new Error('src/xlsx.js does not export buildXlsx / writeFileAtomic');
        }
        return m;
      });
    }
    try {
      return await this.xlsxPromise;
    } catch (e) {
      this.xlsxPromise = null;
      throw new Error(`the Excel writer (src/xlsx.js) could not be loaded: ${errText(e)}`);
    }
  }

  xlsxOpts(at) {
    return ledgerXlsxOpts(tzOffsetMinutes(this.cfg.timezone, at));
  }

  /** The workbook as a Buffer (GET /api/export/fuel-events.xlsx). */
  async buildBuffer(now = Date.now()) {
    const mod = await this.loadXlsx();
    const { sheets } = this.build(now);
    return mod.buildXlsx(sheets, this.xlsxOpts(now));
  }

  async writeNow(reason, onlyIfChanged) {
    const now = Date.now();
    const st = this.state;
    st.lastAttemptAt = now;
    const seq = this.changeSeq;
    let changed = true;
    try {
      const mod = await this.loadXlsx();
      const built = this.build(now);
      if (onlyIfChanged && built.sig === this.lastSig && this.fileUnchanged()) {
        changed = false;
      } else {
        const buf = mod.buildXlsx(built.sheets, this.xlsxOpts(now));
        await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
        await mod.writeFileAtomic(this.file, buf);
        try {
          const s = fs.statSync(this.file);
          this.lastStat = { size: s.size, mtimeMs: s.mtimeMs };
        } catch {
          this.lastStat = null;
        }
        this.lastSig = built.sig;
        this.events = built.counts;
        st.lastWrittenAt = Date.now();
        if (built.periodStart !== null) this.rememberPeriodStart(built.periodStart);
        log('info', `Excel fuel ledger saved (${reason}): ${built.counts.refuels} refuels, ${built.counts.thefts} suspected thefts` +
          `${built.counts.cancelled ? `, ${built.counts.cancelled} cancelled` : ''} -> ${this.file}`);
      }
      const wasShown = st.locked || st.lastError || st.pending;
      st.pending = this.changeSeq !== seq; // changed again while writing
      st.locked = false;
      st.blocked = false;
      st.lastError = null;
      st.nextRetryAt = null;
      // make sure those changes get a write of their own (touch() does not schedule one while
      // a lock retry is running; a timer set during the write is kept)
      if (st.pending && !this.stopped && !this.timer) this.schedule(DEBOUNCE_MS, 'more changes');
      if (changed || wasShown) this.emitStatus();
    } catch (e) {
      const locked = e?.code === 'LOCKED';
      const blocked = BLOCKED_CODES.has(e?.code);
      const msg = locked ? LOCKED_MESSAGE : blocked ? blockedText(e, this.file) : errText(e);
      if (locked && !st.locked) log('warn', `Excel fuel ledger not saved: ${this.file} is open in another program - retrying every minute until it is closed`);
      else if (!locked && st.lastError !== msg) log('warn', `Excel fuel ledger not saved (${reason}): ${msg}${blocked ? ' - tried again on the next change' : ' - retrying in a minute'}`);
      st.pending = true;
      st.locked = locked;
      st.blocked = blocked;
      st.lastError = msg;
      st.nextRetryAt = null;
      // waiting does not fix these: the next change (touch) or the hourly check tries again
      if (!this.stopped && !blocked) {
        st.nextRetryAt = Date.now() + RETRY_MS;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          st.nextRetryAt = null;
          this.flush('retry', false);
        }, RETRY_MS);
        this.timer.unref?.();
      }
      this.emitStatus();
    }
  }

  rememberPeriodStart(t) {
    try {
      const cur = num(this.db.getMeta('ledgerSince'));
      if (cur === null || t < cur) this.db.setMeta('ledgerSince', Math.round(t));
    } catch {
      /* not important */
    }
  }

  /** Explorer window with the file selected (POST /api/excel/open-folder; Windows only). */
  openFolder() {
    if (!this.file) return { ok: false, error: 'No Excel file is configured (excelFile is empty).' };
    if (process.platform !== 'win32') return { ok: false, error: 'Opening the folder only works on Windows.' };
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const exists = fs.existsSync(this.file);
    // the path comes from config.json / EXCEL_FILE only (never from the request); Windows paths
    // cannot contain double quotes, so quoting it verbatim is safe
    const arg = exists ? `/select,"${this.file}"` : `"${dir}"`;
    const child = spawn('explorer.exe', [arg], { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true });
    child.on('error', (e) => log('warn', 'Could not open Explorer:', e.message));
    child.unref();
    return { ok: true, file: this.file, selected: exists };
  }

  // ===========================================================================
  // workbook content
  // ===========================================================================
  /** Sheets for xlsx.js buildXlsx, the content signature (without the generated time) and counts. */
  build(now = Date.now()) {
    const e = this.engine;
    const alerts = this.db.ledgerAlerts().map((row) => ({ ...e.alertView(row), amountMv: row.amount_mv, extra: parseExtra(row.extra) }));
    const calibrations = {};
    for (const a of alerts) if (a.imei && !calibrations[a.imei]) calibrations[a.imei] = e.vehicleCal(a.imei);
    const vehicles = [...e.recs.values()].map((rec) => ({
      imei: rec.imei, name: rec.v.name, shortName: shortName(rec.v.name), group: rec.info.group ?? null, hasFuel: rec.v.hasFuel, cal: e.vehicleCal(rec.imei),
    }));
    let periodStart = null;
    try {
      for (const t of [num(this.db.getMeta('ledgerSince')), this.db.firstSampleEver()]) {
        if (t !== null && (periodStart === null || t < periodStart)) periodStart = t;
      }
    } catch {
      /* keep the events' own range */
    }
    return buildLedger({
      alerts, vehicles, calibrations, tzOffsetMinutes: tzOffsetMinutes(this.cfg.timezone, now), generatedAt: now,
      periodStart, timezone: this.cfg.timezone || 'local',
    });
  }
}

/** Options for xlsx.js buildXlsx(sheets, opts) that go with the ledger sheets. */
export function ledgerXlsxOpts(tzOffsetMin = 480) {
  return { tzOffsetMinutes: tzOffsetMin, creator: 'Fuel Tank Warner', title: 'Fuel ledger — refuels and suspected fuel thefts' };
}

/** An alert as /api/alerts returns it (camelCase; extra fields in `extra` (object or JSON) or at
 *  the top level) -> the DB-row shape ledgerEntry / situationOf / fuelEventLitres use. */
function ledgerRow(a) {
  const extra = { ...parseExtra(a.extra) };
  for (const k of ['fromMv', 'toMv', 'dipMv', 'recoveredMv']) if (extra[k] === undefined && a[k] !== undefined) extra[k] = a[k];
  return {
    id: num(a.id) ?? 0, imei: a.imei ?? null, name: a.name ?? null, shortName: a.shortName ?? null, group: a.group ?? null,
    type: a.type, severity: a.severity, t: num(a.t), from_t: num(a.fromT ?? a.from_t), title: a.title ?? '', detail: a.detail ?? '',
    amount_mv: num(a.amountMv ?? a.amount_mv), lat: num(a.lat), lng: num(a.lng), ongoing: !!a.ongoing,
    verdict: a.verdict ?? null, note: a.note || null, extra,
  };
}

const zoneLabel = (m) => `UTC${m < 0 ? '-' : '+'}${String(Math.floor(Math.abs(m) / 60)).padStart(2, '0')}:${String(Math.abs(m) % 60).padStart(2, '0')}`;

/**
 * The fuel-ledger workbook content, without any I/O (the local file writer and the cloud
 * download both use it).
 *   alerts:       refuel / fuel_drain alerts as /api/alerts returns them (other types are ignored);
 *                 extra fields (fromMv, toMv, dipMv, recoveredMv) in `extra` or at the top level
 *   vehicles:     [{ imei, name, shortName, group, cal, hasFuel? }] (cal = effective calibration)
 *   calibrations: optional { imei: cal } for alerts whose vehicle is not in `vehicles`
 *   periodStart:  optional ms: start of the period covered (else the oldest event)
 * Returns { sheets, sig (content hash without the generated time), counts, periodStart }.
 */
export function buildLedger({ alerts = [], vehicles = [], calibrations = {}, tzOffsetMinutes: tzMin = 480, generatedAt, periodStart: since = null, timezone } = {}) {
  const now = num(generatedAt) ?? Date.now();
  const vmap = new Map();
  for (const v of vehicles || []) if (v && v.imei !== undefined && v.imei !== null) vmap.set(String(v.imei), v);
  const calOf = (imei) => vmap.get(imei)?.cal ?? calibrations?.[imei] ?? null;
  const rows = (alerts || []).filter((a) => a && (a.type === 'refuel' || a.type === 'fuel_drain')).map(ledgerRow)
    .filter((r) => r.t !== null)
    .sort((a, b) => b.t - a.t || b.id - a.id);
  const thefts = [];
  const refuels = [];
  const perVehicle = new Map(); // imei -> totals
  const perDay = new Map(); // local day number -> totals
  const vehTotals = (imei) => {
    let v = perVehicle.get(imei);
    if (!v) perVehicle.set(imei, (v = { refuels: 0, refuelL: 0, refuelMv: 0, thefts: 0, lostL: 0, lostMv: 0, confirmed: 0, lastTheft: null }));
    return v;
  };
  const dayOf = (t) => Math.floor((t + tzMin * MIN) / DAY);
  const dayTotals = (t) => {
    const k = dayOf(t);
    let d = perDay.get(k);
    if (!d) perDay.set(k, (d = { refuels: 0, refuelL: 0, thefts: 0, lostL: 0 }));
    return d;
  };
  const counts = { refuels: 0, thefts: 0, cancelled: 0, falseAlarms: 0, confirmed: 0, total: rows.length };
  let earliest = null;

  for (const row of rows) {
    const imei = row.imei ?? '';
    const cal = row.imei ? calOf(row.imei) : null;
    const hasLitres = !!cal?.tankLiters;
    const x = parseExtra(row.extra);
    const fromMv = num(x.fromMv);
    let toMv = num(x.toMv);
    const start = row.from_t ?? row.t;
    if (earliest === null || start < earliest) earliest = start;
    const litres = (mv) => (hasLitres && mv !== null ? round(litersAt(mv, cal), 0) : null);
    const name = row.shortName || shortName(row.name) || imei;
    const group = row.group ?? vmap.get(imei)?.group ?? null;
    const tot = vehTotals(imei);

    // counted / size exactly as the dashboard's Report counts them (ledgerEntry)
    const { cancelled, verdict, counted, mv } = ledgerEntry(row);
    const L = fuelEventLitres(row, mv, cal);

    if (row.type === 'refuel') {
      if (toMv === null && fromMv !== null && mv !== null) toMv = fromMv + mv;
      counts.refuels++;
      tot.refuels++;
      if (L !== null) tot.refuelL += L;
      if (mv !== null) tot.refuelMv += mv;
      const d = dayTotals(start);
      d.refuels++;
      if (L !== null) d.refuelL += L;
      refuels.push([
        start, row.t, name, group, L, litres(fromMv), litres(toMv), situationOf(row), mapLink(row.lat, row.lng),
        row.note || null, row.ongoing ? 'Ongoing' : 'Complete', mv === null ? null : Math.round(mv), imei, row.detail || '', row.id,
      ]);
      continue;
    }

    // fuel_drain = suspected theft
    if (cancelled) {
      // the level came back: "after" is where it came back to (older alerts did not record
      // it: left empty rather than showing the bottom of the dip)
      toMv = num(x.recoveredMv);
    } else if (toMv === null && fromMv !== null && mv !== null && !/between stops/i.test(row.title || '')) {
      toMv = fromMv - mv;
    }
    // not counted: a cancelled drain (unless confirmed), or a false alarm
    if (cancelled && verdict !== 'confirmed') counts.cancelled++;
    else if (verdict === 'false_alarm') counts.falseAlarms++;
    if (verdict === 'confirmed') counts.confirmed++;
    if (counted) {
      counts.thefts++;
      tot.thefts++;
      if (L !== null) tot.lostL += L;
      if (mv !== null) tot.lostMv += mv;
      if (verdict === 'confirmed') tot.confirmed++;
      if (tot.lastTheft === null || start > tot.lastTheft) tot.lastTheft = start;
      const d = dayTotals(start);
      d.thefts++;
      if (L !== null) d.lostL += L;
    }
    thefts.push([
      start, row.t, name, group, cancelled && verdict !== 'confirmed' ? null : L, litres(fromMv), litres(toMv), situationOf(row),
      row.from_t !== null && row.from_t !== undefined ? Math.max(0, Math.round((row.t - row.from_t) / MIN)) : null,
      mapLink(row.lat, row.lng), VERDICT_LABEL[verdict] || 'Unchecked', row.note || null,
      cancelled ? CANCELLED : row.ongoing ? 'Ongoing' : 'Closed', mv === null ? null : Math.round(mv), imei, row.detail || '', row.id,
    ]);
  }
  thefts.sort((a, b) => b[0] - a[0] || b[16] - a[16]);
  refuels.sort((a, b) => b[0] - a[0] || b[14] - a[14]);

  // ---- by vehicle: every vehicle with a fuel sensor, plus any other with events ----------
  for (const [imei, v] of vmap) if (v.hasFuel !== false) vehTotals(imei);
  const vrows = [];
  const total = { refuels: 0, refuelL: 0, thefts: 0, lostL: 0, confirmed: 0, lastTheft: null };
  for (const [imei, v] of perVehicle) {
    const veh = vmap.get(imei);
    const cal = imei ? calOf(imei) : null;
    const hasLitres = !!cal?.tankLiters;
    const name = veh ? shortName(veh.name ?? veh.shortName ?? imei) : shortName(rows.find((r) => (r.imei ?? '') === imei)?.name) || imei || 'Unknown vehicle';
    total.refuels += v.refuels;
    total.thefts += v.thefts;
    total.confirmed += v.confirmed;
    if (hasLitres) {
      total.refuelL += v.refuelL;
      total.lostL += v.lostL;
    }
    if (v.lastTheft !== null && (total.lastTheft === null || v.lastTheft > total.lastTheft)) total.lastTheft = v.lastTheft;
    vrows.push([
      name, veh?.group ?? null, hasLitres ? round(cal.tankLiters, 0) : null,
      v.refuels, hasLitres ? round(v.refuelL, 1) : null, v.thefts, hasLitres ? round(v.lostL, 1) : null, v.confirmed, v.lastTheft,
      Math.round(v.refuelMv), Math.round(v.lostMv),
    ]);
  }
  vrows.sort((a, b) => (b[6] ?? -1) - (a[6] ?? -1) || b[5] - a[5] || (b[4] ?? -1) - (a[4] ?? -1) || String(a[0]).localeCompare(String(b[0]), 'mn'));

  // ---- by day: every local date of the period, newest first ------------------------------------
  let periodStart = earliest;
  if (num(since) !== null && (periodStart === null || since < periodStart)) periodStart = num(since);
  const drows = [];
  const dayTot = { refuels: 0, refuelL: 0, thefts: 0, lostL: 0 };
  if (periodStart !== null) {
    const last = dayOf(now);
    for (let k = last; k >= dayOf(periodStart) && last - k < 3660; k--) {
      const d = perDay.get(k) || { refuels: 0, refuelL: 0, thefts: 0, lostL: 0 };
      dayTot.refuels += d.refuels;
      dayTot.refuelL += d.refuelL;
      dayTot.thefts += d.thefts;
      dayTot.lostL += d.lostL;
      drows.push([k * DAY - tzMin * MIN, d.refuels, round(d.refuelL, 1), d.thefts, round(d.lostL, 1)]);
    }
  }

  const local = (t) => new Date(t + tzMin * MIN).toISOString().slice(0, 16).replace('T', ' ');
  // Column widths: left to xlsx.js (widest value, or the header plus room for the filter
  // button), except the long free-text columns, which wrap instead.
  const sheets = [
    {
      name: 'Thefts',
      freezeHeader: true,
      autoFilter: true,
      columns: [
        { header: 'Start time', type: 'datetime', numFmt: DT },
        { header: 'Detected at', type: 'datetime', numFmt: DT },
        { header: 'Vehicle', type: 'string' },
        { header: 'Group', type: 'string' },
        { header: 'Litres lost', type: 'number', numFmt: L1 },
        { header: 'Level before (L)', type: 'number', numFmt: L0 },
        { header: 'Level after (L)', type: 'number', numFmt: L0 },
        { header: 'Situation', type: 'string' },
        { header: 'Duration (min)', type: 'number', numFmt: L0 },
        { header: 'Map', type: 'link' },
        { header: 'Verdict', type: 'string' },
        { header: 'Note', type: 'string', width: 36, wrap: true },
        { header: 'Status', type: 'string' },
        { header: 'mV', type: 'number', numFmt: L0 },
        { header: 'IMEI', type: 'string' },
        { header: 'Details', type: 'string', width: 60, wrap: true },
        { header: 'Alert ID', type: 'number', numFmt: '0' },
      ],
      rows: thefts,
    },
    {
      name: 'Refuels',
      freezeHeader: true,
      autoFilter: true,
      columns: [
        { header: 'Start time', type: 'datetime', numFmt: DT },
        { header: 'Detected at', type: 'datetime', numFmt: DT },
        { header: 'Vehicle', type: 'string' },
        { header: 'Group', type: 'string' },
        { header: 'Litres added', type: 'number', numFmt: L1 },
        { header: 'Level before (L)', type: 'number', numFmt: L0 },
        { header: 'Level after (L)', type: 'number', numFmt: L0 },
        { header: 'Situation', type: 'string' },
        { header: 'Map', type: 'link' },
        { header: 'Note', type: 'string', width: 36, wrap: true },
        { header: 'Status', type: 'string' },
        { header: 'mV', type: 'number', numFmt: L0 },
        { header: 'IMEI', type: 'string' },
        { header: 'Details', type: 'string', width: 60, wrap: true },
        { header: 'Alert ID', type: 'number', numFmt: '0' },
      ],
      rows: refuels,
    },
    {
      name: 'By vehicle',
      freezeHeader: true,
      autoFilter: true,
      fitToWidth: true,
      columns: [
        { header: 'Vehicle', type: 'string' },
        { header: 'Group', type: 'string' },
        { header: 'Tank size (L)', type: 'number', numFmt: L0 },
        { header: 'Refuels', type: 'number', numFmt: L0 },
        { header: 'Litres refuelled', type: 'number', numFmt: L1 },
        { header: 'Suspected thefts', type: 'number', numFmt: L0 },
        { header: 'Litres lost', type: 'number', numFmt: L1 },
        { header: 'Confirmed thefts', type: 'number', numFmt: L0 },
        { header: 'Last theft', type: 'datetime', numFmt: DT },
        { header: 'Refuelled (mV)', type: 'number', numFmt: L0 },
        { header: 'Lost (mV)', type: 'number', numFmt: L0 },
      ],
      rows: vrows,
      totalRow: ['TOTAL', null, null, total.refuels, round(total.refuelL, 1), total.thefts, round(total.lostL, 1), total.confirmed, total.lastTheft, null, null],
    },
    {
      name: 'By day',
      freezeHeader: true,
      autoFilter: true,
      fitToWidth: true,
      columns: [
        { header: 'Date', type: 'date', numFmt: 'yyyy-mm-dd' },
        { header: 'Refuels', type: 'number', numFmt: L0 },
        { header: 'Litres refuelled', type: 'number', numFmt: L1 },
        { header: 'Suspected thefts', type: 'number', numFmt: L0 },
        { header: 'Litres lost', type: 'number', numFmt: L1 },
      ],
      rows: drows,
      totalRow: ['TOTAL', dayTot.refuels, round(dayTot.refuelL, 1), dayTot.thefts, round(dayTot.lostL, 1)],
    },
  ];
  const sig = crypto.createHash('sha1').update(JSON.stringify(sheets)).digest('hex');
  const withL = (n, l) => `${n}${l ? ` (${fmtL(l)} L where the tank size is known)` : ''}`;
  const zone = timezone || zoneLabel(tzMin);
  const notCounted = [
    counts.cancelled ? `${counts.cancelled} cancelled (level came back)` : '',
    counts.falseAlarms ? `${counts.falseAlarms} marked as false alarm` : '',
  ].filter(Boolean);
  const p = (text, more = {}) => ({ text, wrap: true, ...more }); // a paragraph, wrapped in column A
  sheets.push({
    name: 'About',
    width: 100,
    orientation: 'portrait',
    fitToWidth: true,
    titleLines: [
      'Fuel ledger — every refuel and suspected fuel theft',
      `Generated: ${local(now)} (${zone} time)`,
      p(periodStart !== null ? `Period covered: ${local(periodStart)} – ${local(now)} (from the oldest data this program has stored)` : 'Period covered: no data yet'),
      p(`Refuels: ${withL(counts.refuels, total.refuelL)}. Suspected thefts: ${withL(counts.thefts, total.lostL)}` +
        `${notCounted.length ? ` (not counting ${notCounted.join(' and ')})` : ''}. Confirmed thefts: ${counts.confirmed}.`),
      '',
      p('This file is rewritten automatically by Fuel Tank Warner. Add notes and verdicts in the dashboard — they are saved here. ' +
        'If you want to edit the file yourself, save a copy under another name.', { bold: true }),
      '',
      { text: 'SHEETS', bold: true },
      p('Thefts — every suspected fuel theft or leak (a "Fuel drain" alert), newest first.'),
      p('  Start time: the last normal reading before the fuel went missing. Detected at: when the program was sure.'),
      p('  Litres lost: how much fuel disappeared. For losses on a trip ("During trip") it is the part that normal driving does not explain, so it can be less than Level before minus Level after.'),
      p('  Level before / Level after: litres in the tank before and after (for a cancelled drain: the level it came back to). Situation: parked, master switch off, at a short stop, during a trip, ...'),
      p('  Duration (min): minutes from the start to the detection. Map: opens the place in Google Maps.'),
      p('  Verdict: Unchecked, Confirmed theft or False alarm — set with the buttons on the alert in the dashboard. Note: your note from the dashboard.'),
      p('  Status: Ongoing (the level is still falling), Closed, or Cancelled — level came back (a sensor or tilt effect, not a loss).'),
      p('  mV: the size of the change in the sensor\'s own unit (millivolts). IMEI: the tracker. Details: the alert text. Alert ID: the number in the program.'),
      p('Refuels — every refuel, newest first: vehicle, litres added, the level before and after, where it happened, your note.'),
      p('  Start time: the last reading before the fuel rose. Detected at: when the program saw the new level. The refuel happened between the two ' +
        '(usually minutes apart; for a refuel first seen after a trip it can be hours, so compare with the fuel station receipt).'),
      p('By vehicle — per vehicle: tank size, number of refuels and litres refuelled, suspected thefts and litres lost, confirmed thefts, the last theft.'),
      p('By day — per day (the local date of the Start time): refuels, litres refuelled, suspected thefts, litres lost.'),
      '',
      { text: 'HOW THE NUMBERS ARE MADE', bold: true },
      p('Litres come from the tank calibration tables on the GPS server (or a tank size entered in Settings). Vehicles without one show only mV; their litres cells are empty and they are not in the litre totals.'),
      p('Drains marked "False alarm" and cancelled drains (the level came back) are listed but not counted in the totals, suspected thefts or litres lost, ' +
        'unless you mark a cancelled one as "Confirmed theft": then it counts, with the size of its dip. The dashboard\'s Report counts the same way.'),
      p('Times are local time (' + zone + '). The fuel level is measured from steady readings while a vehicle stands still, because the reading jumps around while driving.'),
    ],
  });
  return { sheets, sig, counts, periodStart };
}

/** The ledger's sheets for xlsx.js buildXlsx (see buildLedger). */
export function buildLedgerSheets(opts = {}) {
  return buildLedger(opts).sheets;
}

/** What to tell the owner about a write that fails for good. */
function blockedText(e, file) {
  if (e.code === 'READONLY') return `${path.basename(file)} is marked read-only, so it cannot be updated — in Explorer, right-click it, choose Properties and untick "Read-only"`;
  if (e.code === 'NOACCESS') return `No permission to change ${file} — check its permissions, or set another excelFile in config.json`;
  return `No permission to write ${file} (${e.code}) — check the folder's permissions, or set another excelFile in config.json`;
}

function fmtL(x) {
  return Math.round(x).toLocaleString('en-US');
}
