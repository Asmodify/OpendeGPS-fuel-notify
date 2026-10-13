// Link to Open Tee (our fleet app and admin web): refuels, fuel drains, low fuel and fuel sensor
// faults are sent to the Open Tee API (POST /api/v1/integrations/fuel-warner/events), which
// stores them next to its own fuel events. The admin web lists them (staff can mark a drain
// confirmed / false alarm there) and the driver app shows them on the vehicle's fuel card.
//
// Off until a key is set: "openTee": { "key": "..." } in config.local.json (never config.json -
// the repository is public) or the OPENTEE_KEY environment variable. The API address defaults
// to https://api.opendevelopment.mn ("openTee": { "url": ... } or OPENTEE_URL to change it).
//
// Every minute the alerts that changed since the last successful send (alerts.updated_at, kept
// as a cursor in the meta table) are sent in batches of 200. Nothing is lost while the API or
// the internet is down: the cursor only moves after the API accepted a batch. A drop still
// being checked (the 5 h hold) is sent once it is settled. OPENTEE_RESEND=1 sends everything
// again from the start (e.g. after trucks were added to Open Tee).
//
// Refuel receipts drivers upload in the Open Tee app come the other way: they are added to this
// program's receipt list, checked against the refuels the fuel sensor saw (receipts.js), and the
// result - how much went into the tank, how much is missing - is sent back to the API, where the
// admin web's fuel ledger shows it.
import crypto from 'node:crypto';
import { log, errText, num, round, shortName } from './util.js';
import { parseExtra, isPendingDrain, ledgerEntry, litersAt, fuelEventLitres } from './ledger.js';
import { mnTitle, mnDetail } from './mn.js';
import { RECEIPTS_KEY, RECEIPTS_MAX } from './receipts.js';

const DEFAULT_URL = 'https://api.opendevelopment.mn';
const PATH = '/api/v1/integrations/fuel-warner/events';
const CURSOR_KEY = 'opentee.cursor';
const BATCH = 200;
const EVERY_MS = 60 * 1000;
const TIMEOUT_MS = 30 * 1000;
const RECEIPTS_PATH = '/api/v1/integrations/fuel-warner/receipts';
const CHECKS_PATH = '/api/v1/integrations/fuel-warner/receipt-checks';
const RECEIPT_CURSOR_KEY = 'opentee.receiptCursor';
const CHECKS_KEY = 'opentee.receiptChecks'; // { entryId: what was last sent }
const NO_TRACKER_KEY = 'opentee.receiptsNoTracker'; // receipts for vehicles without a known tracker
// a driver may upload the receipt hours after filling up: the receipt is matched to a refuel on
// the day it was uploaded or the day before (from 18 h before the upload)
const UPLOAD_LATE_MS = 18 * 3600 * 1000;

/** Warner alert type -> Open Tee fuel event type. Other alert types are not sent. */
const TYPE_MAP = {
  refuel: 'REFUEL',
  fuel_drain: 'POSSIBLE_DRAIN',
  low_fuel: 'LOW_FUEL',
  sensor_lost: 'FUEL_SENSOR_INVALID',
};
export const OPENTEE_TYPES = Object.keys(TYPE_MAP);

/** Settings from cfg.openTee and the environment. */
export function openTeeSettings(cfg, env = process.env) {
  const c = cfg?.openTee && typeof cfg.openTee === 'object' ? cfg.openTee : {};
  const key = String(env.OPENTEE_KEY || c.key || '').trim();
  const url = String(env.OPENTEE_URL || c.url || DEFAULT_URL).trim().replace(/\/+$/, '');
  return { enabled: key.length >= 24 && /^https?:\/\//.test(url), key, url, resend: env.OPENTEE_RESEND === '1' || c.resend === true };
}

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const litres = (mv, cal) => {
  if (mv === null || !cal?.tankLiters) return null;
  const L = litersAt(mv, cal);
  return Number.isFinite(L) ? round(L, 1) : null;
};

/**
 * One alert row (alerts table) -> the event Open Tee stores, or null when it is not sent.
 * `cal`: the vehicle's tank calibration (engine.vehicleCal), for litres.
 */
export function toOpenTeeEvent(row, cal) {
  const type = TYPE_MAP[row?.type];
  if (!type || !row.imei || isPendingDrain(row)) return null;
  const x = parseExtra(row.extra);
  const fromMv = num(x.fromMv);
  let status = row.ongoing ? 'open' : 'closed';
  let severity = row.severity;
  let beforeMv = null;
  let afterMv = null;
  let deltaMv = null;
  let deltaL = null;
  if (row.type === 'refuel' || row.type === 'fuel_drain') {
    const entry = ledgerEntry(row);
    const mv = entry.mv;
    const sign = row.type === 'refuel' ? 1 : -1;
    if (entry.cancelled) {
      status = 'recovered';
      severity = 'info';
    }
    if (mv !== null) {
      deltaMv = round(sign * mv);
      const L = fuelEventLitres(row, mv, cal);
      deltaL = L === null ? null : round(sign * L, 1);
      if (fromMv !== null) {
        beforeMv = round(fromMv);
        afterMv = round(fromMv + sign * mv);
      }
    }
  }
  // levels outside the tank table (e.g. two tanks summed above 10 V) give no usable litre level:
  // the change is still sent, the before / after litres only when they agree with it
  let beforeL = litres(beforeMv, cal);
  let afterL = litres(afterMv, cal);
  if (beforeL === null || afterL === null || deltaL === null || Math.abs(afterL - beforeL - deltaL) > 1) beforeL = afterL = null;
  const title = mnTitle(row.title || '');
  const detail = mnDetail(row.detail || '');
  return {
    // the alert key is stable even if the local database is rebuilt; hashed so it carries no IMEI
    id: crypto.createHash('sha256').update(String(row.key)).digest('hex').slice(0, 40),
    imei: String(row.imei),
    type,
    status,
    severity,
    startedAt: iso(row.from_t ?? row.t),
    detectedAt: iso(num(x.detectedT) ?? row.t),
    endedAt: row.ongoing ? null : iso(row.t),
    unit: 'raw',
    beforeValue: beforeMv,
    afterValue: afterMv,
    deltaValue: deltaMv,
    beforeLiters: beforeL,
    afterLiters: afterL,
    deltaLiters: deltaL,
    lat: num(row.lat),
    lng: num(row.lng),
    detail: [title, detail].filter(Boolean).join('. ').slice(0, 1000),
    history: !!row.historical,
    verdict: row.verdict === 'confirmed' || row.verdict === 'false_alarm' ? row.verdict : null,
    note: row.note ?? '',
  };
}

const localDate = (ms, tzMin) => new Date(ms + tzMin * 60000).toISOString().slice(0, 10);

/**
 * A receipt from the Open Tee API ({ id, imei, plateNumber, liters, station, at }) -> an entry of
 * this program's receipt list (receipts.js), or null when its vehicle has no tracker known here.
 */
export function toWarnerReceipt(x, engine, tzMin = 480, now = Date.now()) {
  const imei = x?.imei ? String(x.imei) : null;
  const rec = imei ? engine.recs?.get(imei) : null;
  const at = Date.parse(x?.at);
  const litres = Number(x?.liters);
  if (!rec || !Number.isFinite(at) || !(litres > 0) || !x.id) return null;
  const date = localDate(at - UPLOAD_LATE_MS, tzMin);
  const to = localDate(at, tzMin);
  return {
    id: `ot-${x.id}`,
    entryId: String(x.id),
    source: 'opentee',
    imei,
    vehicle: shortName(rec.v?.name ?? x.plateNumber ?? imei),
    date,
    ...(to !== date ? { dateTo: to } : {}),
    time: null,
    litres: round(litres, 1),
    station: typeof x.station === 'string' ? x.station.slice(0, 100) : '',
    addedAt: now,
  };
}

/** A matched receipt (receipts.js matchReceipts) -> the check the Open Tee API stores. */
export function toReceiptCheck(r) {
  const f = r.refuel;
  return {
    id: r.entryId,
    status: r.status,
    tankLiters: f ? f.wentIn : null,
    missingLiters: r.status === 'norefuel' ? r.litres : r.missing ?? null,
    roomLiters: r.room ?? null,
    noFit: !!r.nofit,
    beforeLiters: f?.before ?? null,
    afterLiters: f?.after ?? null,
    refuelAt: f ? iso(f.fromT) : null,
  };
}

const checkHash = (c) => JSON.stringify(c);

export class OpenTeeLink {
  /** @param {{cfg: object, engine: object, db: object, fetchImpl?: Function}} o */
  constructor({ cfg, engine, db, fetchImpl = globalThis.fetch }) {
    this.settings = openTeeSettings(cfg);
    this.engine = engine;
    this.store = db;
    this.fetch = fetchImpl;
    this.timer = null;
    this.running = null;
    this.pauseUntil = 0;
    this.lastError = null;
    this.status = { enabled: this.settings.enabled, url: this.settings.url, sent: 0, lastOkAt: null, lastError: null, lastErrorAt: null, unmatched: [] };
    const types = OPENTEE_TYPES.map(() => '?').join(',');
    this.changed = db.db.prepare(
      `SELECT * FROM alerts WHERE type IN (${types}) AND (updated_at > ? OR (updated_at = ? AND id > ?)) ORDER BY updated_at, id LIMIT ${BATCH}`,
    );
  }

  start() {
    if (!this.settings.enabled) {
      log('info', 'Open Tee link is off (no openTee key in config.local.json / OPENTEE_KEY).');
      return;
    }
    if (this.settings.resend) {
      this.store.setMeta(CURSOR_KEY, '0:0');
      log('info', 'Open Tee: sending every fuel event again from the start.');
    }
    log('info', `Open Tee link on: fuel events go to ${this.settings.url}`);
    this.timer = setInterval(() => this.sync(), EVERY_MS);
    this.timer.unref?.();
    setTimeout(() => this.sync(), 15000).unref?.();
  }

  cursor() {
    const [u, id] = String(this.store.getMeta(CURSOR_KEY) || '0:0').split(':').map(Number);
    return { u: Number.isFinite(u) ? u : 0, id: Number.isFinite(id) ? id : 0 };
  }

  /** Sends everything changed since the cursor. Never runs twice at once. */
  sync() {
    if (!this.settings.enabled || Date.now() < this.pauseUntil) return Promise.resolve();
    if (!this.running) this.running = this.syncAll().finally(() => (this.running = null));
    return this.running;
  }

  async syncAll() {
    try {
      await this.sendEvents();
      await this.pullReceipts();
      await this.pushReceiptChecks();
    } catch (e) {
      const msg = errText(e);
      this.status.lastError = msg;
      this.status.lastErrorAt = Date.now();
      // a wrong key will not fix itself: try again in 10 minutes, otherwise next minute
      if (e.status === 401) this.pauseUntil = Date.now() + 10 * EVERY_MS;
      if (msg !== this.lastError) log('warn', `Open Tee: the link failed (will retry): ${msg}`);
      this.lastError = msg;
    }
  }

  /** Sends the fuel alerts changed since the cursor. */
  async sendEvents() {
    for (;;) {
      const c = this.cursor();
      const rows = this.changed.all(...OPENTEE_TYPES, c.u, c.u, c.id);
      if (!rows.length) return;
      const events = [];
      for (const row of rows) {
        const ev = toOpenTeeEvent(row, this.engine.vehicleCal(row.imei));
        if (ev) events.push(ev);
      }
      if (events.length) await this.post(events);
      const last = rows[rows.length - 1];
      this.store.setMeta(CURSOR_KEY, `${last.updated_at}:${last.id}`);
      if (rows.length < BATCH) return;
    }
  }

  /** One call to the API (JSON in, JSON out); throws with .status on an HTTP error. */
  async request(method, path, payload) {
    const res = await this.fetch(`${this.settings.url}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.settings.key}` },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const err = new Error(res.status === 401 ? 'the Open Tee key is wrong (HTTP 401)' : `HTTP ${res.status}${body?.message ? `: ${body.message}` : ''}`);
      err.status = res.status;
      throw err;
    }
    this.status.lastOkAt = Date.now();
    if (this.lastError) log('info', 'Open Tee: the link works again.');
    this.lastError = null;
    this.status.lastError = null;
    return body;
  }

  async post(events) {
    const body = await this.request('POST', PATH, { events });
    this.status.sent += events.length;
    const unmatched = Array.isArray(body?.unmatchedImeis) ? body.unmatchedImeis.map(String) : [];
    const fresh = unmatched.filter((i) => !this.status.unmatched.includes(i));
    if (fresh.length) {
      this.status.unmatched = [...new Set([...this.status.unmatched, ...fresh])].slice(-200);
      const names = fresh.map((i) => this.engine.recs?.get(i)?.v?.name || 'unknown vehicle');
      log('warn', `Open Tee does not know these trackers yet, their fuel events were skipped: ${names.join(', ')}. ` +
        'Add them in the admin web (GPS devices), then restart once with OPENTEE_RESEND=1.');
    }
    return body;
  }

  // ---- driver refuel receipts ------------------------------------------------------------
  // Receipts drivers upload in the Open Tee app are added to this program's receipt list (the
  // same list as receipts pasted from Excel, see receipts.js), checked against the refuels the
  // fuel sensor recorded, and each result is sent back so the admin web's fuel ledger shows how
  // much of the receipt reached the tank.

  /** Fetches receipts changed since the last time and adds / updates them in the list. */
  async pullReceipts(now = Date.now()) {
    let changed = false;
    const noTracker = new Set(this.metaJson(NO_TRACKER_KEY, []));
    for (;;) {
      const cursor = this.store.getMeta(RECEIPT_CURSOR_KEY) || '';
      const body = await this.request('GET', `${RECEIPTS_PATH}?cursor=${encodeURIComponent(cursor)}&limit=500`);
      const list = Array.isArray(body?.receipts) ? body.receipts : [];
      if (list.length) {
        const stored = this.engine.receiptsStored();
        const byId = new Map(stored.map((r) => [r.id, r]));
        for (const x of list) {
          const r = toWarnerReceipt(x, this.engine, this.tzMin(), now);
          if (!r) {
            if (x?.id) noTracker.add(String(x.id));
            continue;
          }
          noTracker.delete(r.entryId);
          const old = byId.get(r.id);
          if (old && old.litres === r.litres && old.imei === r.imei && old.date === r.date && old.dateTo === r.dateTo) continue;
          if (old) Object.assign(old, r, { addedAt: old.addedAt });
          else {
            stored.push(r);
            byId.set(r.id, r);
          }
          changed = true;
        }
        if (changed) this.engine.db.setSetting(RECEIPTS_KEY, stored.slice(-RECEIPTS_MAX));
      }
      if (body?.cursor) this.store.setMeta(RECEIPT_CURSOR_KEY, String(body.cursor));
      if (!body?.more) break;
    }
    this.store.setMeta(NO_TRACKER_KEY, JSON.stringify([...noTracker].slice(-2000)));
    if (changed) {
      this.engine.ledger?.touch('Open Tee receipts');
      try {
        this.engine.checkReceipts(now);
      } catch (e) {
        log('error', 'Checking the Open Tee receipts failed:', e);
      }
    }
  }

  /** Sends the check of every Open Tee receipt whose result changed. */
  async pushReceiptChecks(now = Date.now()) {
    const sentHashes = this.metaJson(CHECKS_KEY, {});
    const checks = [];
    for (const r of this.engine.receiptResults(now)) {
      if (!r.entryId) continue;
      checks.push(toReceiptCheck(r));
    }
    for (const id of this.metaJson(NO_TRACKER_KEY, [])) checks.push({ id, status: 'nosensor' });
    const changed = checks.filter((c) => sentHashes[c.id] !== checkHash(c));
    for (let i = 0; i < changed.length; i += 500) {
      const batch = changed.slice(i, i + 500);
      await this.request('POST', CHECKS_PATH, { checks: batch.map((c) => ({ ...c, checkedAt: new Date(now).toISOString() })) });
      for (const c of batch) sentHashes[c.id] = checkHash(c);
      this.store.setMeta(CHECKS_KEY, JSON.stringify(sentHashes));
    }
  }

  tzMin() {
    return Number.isFinite(this.engine.tzOffsetMin) ? this.engine.tzOffsetMin : 480;
  }

  metaJson(key, fallback) {
    try {
      const v = JSON.parse(this.store.getMeta(key) || 'null');
      return v && typeof v === 'object' ? v : fallback;
    } catch {
      return fallback;
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    return this.running || Promise.resolve();
  }
}
