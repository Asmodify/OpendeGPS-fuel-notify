// Fuel receipts (e.g. from the fuel station's card statement) checked against the refuels the
// fuel sensor recorded: a receipt for more litres than went into the tank - or more than the tank
// could even hold - is the "paid for fuel that never reached the truck" kind of theft, which the
// tank sensor alone cannot see.
//
// Receipts are pasted from Excel (vehicle, date [time], litres; other columns are ignored), kept
// in the settings under 'receipts', and matched on demand: the dashboard, the Excel ledger and
// the local engine's alerts all use matchReceipts().
import { litersAt } from './ledger.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
export const RECEIPTS_KEY = 'receipts';
export const RECEIPTS_MAX = 5000;
// a receipt is "short" when at least this much of it is missing from the tank
export const MISSING_MIN_L = 20;
export const MISSING_MIN_PCT = 5;
// a receipt without a time can match a refuel on its date (local), from 1 h before to 3 h after
const DAY_BEFORE_MS = 1 * HOUR;
const DAY_AFTER_MS = 3 * HOUR;
const TIME_WINDOW_MS = 3 * HOUR; // with a time: +- this
// until this long after its window, a receipt without a matching refuel is "waiting" (the
// tracker's data for that time may not be in yet)
const WAIT_MS = 6 * HOUR;

const round1 = (x) => Math.round(x * 10) / 10;

// ---- vehicle names ---------------------------------------------------------------------------
// Latin letters that look like Cyrillic ones (a plate typed on a Latin keyboard)
const LOOKALIKE = { A: 'А', B: 'В', E: 'Е', K: 'К', M: 'М', H: 'Н', O: 'О', P: 'Р', C: 'С', T: 'Т', X: 'Х', Y: 'У' };
export function normName(s) {
  return String(s ?? '')
    .replace(/\/.*$/, '') // "1234ӨМЕ/Түлшний мэдрэгчтэй/" -> "1234ӨМЕ"
    .toUpperCase()
    .replace(/[A-Z]/g, (c) => LOOKALIKE[c] ?? c)
    .replace(/Ө/g, 'О').replace(/Ү/g, 'У') // "1234OME" typed for 1234ӨМЕ
    .replace(/[\s\-_.]/g, '');
}

// ---- dates -----------------------------------------------------------------------------------
/** 'YYYY-MM-DD[ HH:MM]', 'YYYY.MM.DD', 'DD.MM.YYYY', 'M/D/YYYY' (D/M when the first part > 12)
 *  -> { date: 'YYYY-MM-DD', time: 'HH:MM' | null } or null. */
export function parseDateCell(s) {
  const t = String(s ?? '').trim();
  let m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::\d{2})?)?$/.exec(t);
  let y, mo, d, hh = null, mm = null;
  if (m) [, y, mo, d, hh, mm] = m;
  else if ((m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::\d{2})?)?$/.exec(t))) {
    let a = +m[1], b = +m[2];
    if (t.includes('/') && a <= 12) [a, b] = [b, a]; // Excel's US format M/D/YYYY
    [d, mo, y, hh, mm] = [a, b, m[3], m[4], m[5]];
  } else return null;
  y = +y; mo = +mo; d = +d;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  const date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const time = hh != null && +hh < 24 && +mm < 60 ? `${String(+hh).padStart(2, '0')}:${mm}` : null;
  return { date, time };
}
/** A date cell that names two days, as receipt sheets write a fill-up spread over two days:
 *  '2026.09.24/25', '2026-09-17,18', '2026.09.30/10.01' -> { date, dateTo } or null. */
export function parseDateRange(s) {
  const m = /^(\d{4})[-.](\d{1,2})[-.](\d{1,2})\s*[/,]\s*(?:(\d{1,2})[-.])?(\d{1,2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const from = parseDateCell(`${m[1]}-${m[2]}-${m[3]}`);
  const to = parseDateCell(`${m[1]}-${m[4] ?? m[2]}-${m[5]}`);
  if (!from || !to || to.date <= from.date) return null;
  return { date: from.date, dateTo: to.date };
}
const TIME_RE = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;
const parseNum = (s) => {
  const t = String(s ?? '').trim().replace(/\s/g, '').replace(/,(?=\d{3}(\D|$))/g, '').replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
};

/** Local date/time -> epoch ms (tzMin = the zone's offset from UTC in minutes). */
export function localMs(date, time, tzMin) {
  return Date.parse(`${date}T${time || '00:00'}:00Z`) - tzMin * 60e3;
}

/**
 * Receipt rows from text pasted from Excel (tab separated; ; or , work too). Each row needs a
 * vehicle (a known vehicle's name or plate), a date and the receipt litres. With a header row,
 * the litres column is the one named like the station / "litres" (not "GPS" / "difference");
 * without one, the first number after the date. vehicles: [{ imei, name, plate }].
 * Returns { rows: [{ imei, vehicle, date, time, litres, line }], skipped: [{ line, text, reason }] }.
 */
export function parseReceiptText(text, vehicles) {
  const byName = new Map();
  for (const v of vehicles) {
    for (const n of [v.name, v.shortName, v.plate]) {
      const k = normName(n);
      if (k && !byName.has(k)) byName.set(k, v);
    }
  }
  const lines = String(text ?? '').split(/\r?\n/);
  const rows = [];
  const skipped = [];
  let litresCol = null;
  lines.forEach((raw, i) => {
    const line = i + 1;
    if (!raw.trim()) return;
    const sep = raw.includes('\t') ? '\t' : raw.includes(';') ? ';' : ',';
    const cells = raw.split(sep).map((c) => c.trim().replace(/^"|"$/g, ''));
    const di = cells.findIndex((c) => parseDateCell(c) || parseDateRange(c));
    if (di < 0) {
      // a header row: remember which column holds the receipt litres
      const h = cells.findIndex((c) => /шунхлай|литр|litre|liter|receipt|баримт|хэмжээ|quantity|qty|түлш|^л$/i.test(c) && !/gps|зөрүү|diff|машин|огноо/i.test(c));
      if (h >= 0) litresCol = h;
      else if (rows.length || cells.some((c) => parseNum(c) !== null)) skipped.push({ line, text: raw.slice(0, 120), reason: 'no date' });
      return;
    }
    const v = cells.map((c) => byName.get(normName(c))).find(Boolean);
    if (!v) { skipped.push({ line, text: raw.slice(0, 120), reason: 'unknown vehicle' }); return; }
    const range = parseDateRange(cells[di]);
    const dt = range ? { date: range.date, time: null } : parseDateCell(cells[di]);
    const tcell = range ? null : cells.find((c, j) => j !== di && TIME_RE.test(c));
    const time = dt.time ?? (tcell ? `${tcell.split(':')[0].padStart(2, '0')}:${tcell.split(':')[1]}` : null);
    let litres = litresCol !== null ? parseNum(cells[litresCol]) : null;
    if (litres === null) litres = cells.slice(di + 1).map(parseNum).find((n) => n !== null) ?? null;
    if (!(litres > 0 && litres < 5000)) { skipped.push({ line, text: raw.slice(0, 120), reason: 'no litres' }); return; }
    rows.push({ imei: v.imei, vehicle: v.shortName || normName(v.name), date: dt.date, ...(range ? { dateTo: range.dateTo } : {}), time, litres: round1(litres), line });
  });
  return { rows, skipped };
}

/** Refuel alert DB rows (local or cloud, extra as JSON text or object) -> the shape matchReceipts uses. */
export function refuelsFromRows(rows) {
  const out = [];
  for (const row of rows || []) {
    if (!row || row.type !== 'refuel') continue;
    let x = row.extra;
    if (typeof x === 'string') { try { x = JSON.parse(x); } catch { x = null; } }
    const n = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
    out.push({
      id: n(row.id), imei: row.imei == null ? null : String(row.imei), t: n(row.t), fromT: n(row.from_t ?? row.fromT),
      lat: n(row.lat), lng: n(row.lng), amountMv: n(row.amount_mv ?? row.amountMv), fromMv: n(x?.fromMv), toMv: n(x?.toMv),
    });
  }
  return out;
}

/** Stable id of a receipt (so pasting the same rows again adds nothing). */
export function receiptId(r) {
  const s = `${r.imei}|${r.date}${r.dateTo ? '/' + r.dateTo : ''}|${r.time || ''}|${r.litres}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `r${h.toString(36)}${s.length.toString(36)}`;
}

/**
 * Checks each receipt against the refuels.
 *   receipts: stored rows { id, imei, vehicle, date, time, litres, addedAt }
 *   refuels:  refuel alerts { id, imei, t, fromT, lat, lng, amountMv, amountL, fromMv, toMv }
 *   calFor(imei) -> calibration; hasFuel(imei) -> boolean; tzMin; now
 *   dataFrom  ms: the oldest data this program has (receipts before it cannot be checked)
 *   hasData(imei, from, to) -> boolean (optional): the vehicle reported fuel levels then
 * Each result: the receipt plus
 *   status   'ok' | 'short' (litres missing) | 'norefuel' (none recorded) | 'waiting' |
 *            'nodata' (no data from the vehicle then) | 'nosensor'
 *   refuel   { id, t, fromT, lat, lng, before, after, wentIn } | null
 *   missing  receipt - went in (L), room = tank - level before (L), nofit = receipt > room
 */
export function matchReceipts(receipts, refuels, { calFor, hasFuel = () => true, tzMin = 480, now = Date.now(), dataFrom = null, hasData = null } = {}) {
  const byImei = new Map();
  for (const a of refuels) {
    if (!a || !a.imei) continue;
    if (!byImei.has(a.imei)) byImei.set(a.imei, []);
    byImei.get(a.imei).push(a);
  }
  const taken = new Set();
  const out = new Map();
  // big receipts first, so each takes the big refuel of its day and the top-ups go to small ones
  for (const r of [...receipts].sort((a, b) => b.litres - a.litres)) {
    const res = { ...r, status: 'ok', refuel: null, missing: null, room: null, nofit: false };
    out.set(r.id, res);
    if (!hasFuel(r.imei)) { res.status = 'nosensor'; continue; }
    const cal = calFor(r.imei) || {};
    const L = (mv) => (Number.isFinite(mv) ? litersAt(mv, cal) : null);
    const at = localMs(r.date, r.time, tzMin);
    const from = r.time ? at - TIME_WINDOW_MS : at - DAY_BEFORE_MS;
    // a receipt dated over two days ('24/25') may match a refuel on either day
    const to = r.time ? at + TIME_WINDOW_MS : localMs(r.dateTo || r.date, null, tzMin) + DAY + DAY_AFTER_MS;
    let best = null;
    for (const a of byImei.get(r.imei) || []) {
      const t = a.fromT ?? a.t;
      if (taken.has(a.id) || t < from || t > to) continue;
      const before = L(a.fromMv);
      const after = L(a.toMv ?? (Number.isFinite(a.fromMv) && Number.isFinite(a.amountMv) ? a.fromMv + a.amountMv : null));
      const wentIn = before !== null && after !== null ? after - before : Number.isFinite(a.amountL) ? a.amountL : null;
      if (wentIn === null) continue;
      const score = Math.abs(wentIn - r.litres) + (r.time ? Math.abs(t - at) / (10 * 60e3) : 0);
      if (!best || score < best.score) best = { a, before, after, wentIn, score };
    }
    if (!best) {
      if (Number.isFinite(dataFrom) && from < dataFrom) res.status = 'nodata';
      else if (now < to + WAIT_MS) res.status = 'waiting';
      else if (hasData && !hasData(r.imei, from, to)) res.status = 'nodata';
      else res.status = 'norefuel';
      continue;
    }
    taken.add(best.a.id);
    const { a, before, after, wentIn } = best;
    res.refuel = {
      id: a.id, t: a.t, fromT: a.fromT ?? a.t, lat: a.lat ?? null, lng: a.lng ?? null,
      before: before === null ? null : round1(before), after: after === null ? null : round1(after), wentIn: round1(wentIn),
    };
    res.missing = round1(r.litres - wentIn);
    if (before !== null && Number.isFinite(cal.tankLiters)) {
      // the tank holds at least what it reached in this fill-up (full tanks read past the table)
      res.room = round1(Math.max(cal.tankLiters, after ?? 0) - before);
      res.nofit = r.litres > res.room + 5;
    }
    if (res.missing >= Math.max(MISSING_MIN_L, (r.litres * MISSING_MIN_PCT) / 100)) res.status = 'short';
  }
  return receipts.map((r) => out.get(r.id)).sort((a, b) => b.date.localeCompare(a.date) || (b.time || '').localeCompare(a.time || '') || a.vehicle.localeCompare(b.vehicle));
}

/** Totals for a list of matched receipts. */
export function receiptTotals(list) {
  const t = { receipts: list.length, litres: 0, wentIn: 0, missing: 0, short: 0, norefuel: 0, waiting: 0, nodata: 0, ok: 0, nofit: 0 };
  for (const r of list) {
    t.litres += r.litres;
    if (r.refuel) t.wentIn += r.refuel.wentIn;
    if (r.status === 'short') { t.short++; t.missing += r.missing; }
    if (r.status === 'norefuel') { t.norefuel++; t.missing += r.litres; }
    if (r.status === 'waiting') t.waiting++;
    if (r.status === 'nodata') t.nodata++;
    if (r.status === 'ok') t.ok++;
    if (r.nofit) t.nofit++;
  }
  for (const k of ['litres', 'wentIn', 'missing']) t[k] = round1(t[k]);
  return t;
}
