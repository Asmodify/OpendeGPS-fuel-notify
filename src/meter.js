// What the fuel meter itself shows around a theft alert: the raw readings of the fuel sensor
// taken while the vehicle stood still (sloshing while driving is not a level), not the
// detector's settled levels. The evidence pack and its list use it so that a refuel, a sensor
// fault or a drop the meter does not show is never presented as theft.
//
// verdict
//   drop       the meter fell while the truck stood still; lost = the smaller of that fall and
//              the alert's amount, so evidence never claims more than either shows
//   trip       on the road the meter fell by more than the detector allowed for the trip: that
//              rests on an average consumption, not on the meter alone, so it is set aside
//   refuel     the meter went up, not down: a refuel, not theft
//   recovered  the meter dipped and came back up: not a loss
//   no_drop    the meter shows no fall of that size
//   short      receipt: the meter rose clearly less than the receipt (beyond tank-table error)
//   norefuel   receipt: the meter shows no refuel at all
//   full       receipt: the meter rose by (about) the receipt's litres
//   sensor     readings at the sensor's 10 V limit or outside the tank, or a meter that never
//              moves while the truck drives
//   nodata     too few settled readings standing still to tell (a receipt: or the fill was at a
//              stop too short to read, its rise only seen across a drive)
import { litersAt } from './ledger.js';

const MIN = 60e3;
const HOUR = 60 * MIN;
const MOVE_KMH = 3;
const LOOK = 6 * HOUR; // how far back / ahead the level before / after may be taken
const NEAR = 5; // readings nearest the event that make the level before / after
const SETTLE = 10 * MIN; // fuel sloshes for minutes after the truck pulls up: no level before that
const PEGGED_MV = 9950; // the probes are 0-10 V: a reading at the limit is a wiring fault, not a level
export const CONFIRMS = new Set(['drop', 'short', 'norefuel']);

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

/** Rolling median, so a single jumpy reading is not a fall or a rise. Narrower on short series:
 *  a 5-wide median over a handful of readings would flatten a real step. */
function smooth(vals) {
  const k = vals.length >= 9 ? 5 : vals.length >= 5 ? 3 : 1;
  const h = k >> 1;
  return vals.map((_, i) => median(vals.slice(Math.max(0, i - h), i + h + 1)));
}
/** The largest fall and the largest rise along a series (in time order), with where the
 *  largest rise starts (lo) and ends (hi). */
function swings(vals) {
  let drop = 0;
  let rise = 0;
  let hi = null;
  let lo = null;
  let loAt = 0;
  let rise0 = 0;
  let rise1 = 0;
  vals.forEach((v, i) => {
    if (hi === null || v > hi) hi = v;
    if (lo === null || v < lo) { lo = v; loAt = i; }
    drop = Math.max(drop, hi - v);
    if (v - lo > rise) { rise = v - lo; rise0 = loAt; rise1 = i; }
  });
  return { drop, rise, rise0, rise1 };
}

/** The pieces both checks share, for one vehicle's tank (cal) and thresholds (th). */
function kit(cal, th = {}) {
  const sensorMin = Number.isFinite(th.sensorMinValidMv) ? th.sensorMinValidMv : 100;
  const powerCut = Number.isFinite(th.powerCutMv) ? th.powerCutMv : 5000;
  const tank = cal?.tankLiters || null;
  const table = Array.isArray(cal?.table) && cal.table.length >= 2 ? cal.table : null;
  const hasL = !!(tank || table);
  // a full tank: litres (tank size, else the table's top), or mV without either
  const full = hasL ? tank || table[table.length - 1][1] : Number.isFinite(cal?.fullMv) ? cal.fullMv : null;
  const val = (mv) => (hasL ? litersAt(mv, cal) : mv);
  const valid = (s) => s.f !== null && s.f !== undefined && s.f >= sensorMin && (s.pwr === null || s.pwr === undefined || s.pwr >= powerCut);
  const moving = (s) => (s.spd ?? 0) >= MOVE_KMH;
  const minU = hasL ? 10 : 150; // smallest change that counts: 10 L, or 150 mV without a tank table
  const outside = (v) => {
    if (!Number.isFinite(v)) return false;
    if (tank) return v > tank * 1.15 || v < -tank * 0.05;
    return hasL ? false : (cal && Number.isFinite(cal.fullMv) ? v > cal.fullMv * 1.15 : false);
  };
  const pegged = (xs) => xs.some((s) => valid(s) && s.f >= PEGGED_MV);
  /** A meter that does not move across half an hour or more of driving is stuck (dead probe): the
   *  same level at the stops either side of the drive, or the same reading all along it. */
  const flat = (xs) => {
    const v = xs.map((s) => val(s.f));
    return v.length > 1 && Math.max(...v) - Math.min(...v) < minU / 2;
  };
  /** An hour (minMs) or more of real driving (not creeping in a queue): about 30 L burnt an hour,
   *  which any live probe shows. */
  const long = (d, minMs = HOUR) => {
    let ms = 0;
    for (let i = 1; i < d.length; i++) if (d[i].t - d[i - 1].t <= 10 * MIN) ms += d[i].t - d[i - 1].t;
    return d.length >= 20 && ms >= minMs && median(d.map((s) => s.spd ?? 0)) >= 15;
  };
  const stuck = (xs, minMs = HOUR) => {
    const ok = xs.filter(valid);
    const still = ok.filter((s) => !moving(s));
    const between = still.length > 1 ? xs.filter((s) => moving(s) && s.t > still[0].t && s.t < still[still.length - 1].t) : [];
    return (long(between, minMs) && flat(still)) || (long(ok.filter(moving), minMs) && flat(ok));
  };
  return { tank, full, hasL, unit: hasL ? 'L' : 'mV', val, valid, moving, minU, outside, pegged, stuck };
}

/**
 * kind      'parked' (drain at a stop / while parked / power off), 'trip' (more fuel used between
 *           two stops than the trip explains) or 'receipt' (a receipt the tank does not show)
 * rows      raw samples {t, f, spd, pwr} in time order, covering t0 - 6 h .. t + 24 h
 *           (receipts: t + 6 h, or t + 30 h without a refuel)
 * t0, t     start and end (detection) of the event; for a receipt without a refuel, t is the
 *           receipt's time (its day's 00:00 when it has no time: dayOnly)
 * amount    the alert's amount in litres (amountL) or, without a tank table, in mV (amountMv)
 * fromMv / toMv   the trip's start and end levels (trip drains: what the trip should have used)
 * receiptL  the receipt's litres; missingL: what the detector found missing of it;
 *           refuelSeen: the receipt was matched to a refuel (fromT known)
 */
export function meterCheck({ kind, rows, t0, t, amountL = null, amountMv = null, fromMv = null, toMv = null, receiptL = null, missingL = null, refuelSeen = false, dayOnly = false, cal = null, th = {} }) {
  const { hasL, unit, val, valid, moving, minU, outside, pegged, stuck } = kit(cal, th);
  const out = (verdict, extra = {}) => ({ verdict, unit, ...extra });

  // a driving run = two moving readings in a row (one is GPS jitter at a stop)
  const drivingAt = (i) => moving(rows[i]) && ((i > 0 && moving(rows[i - 1])) || (i + 1 < rows.length && moving(rows[i + 1])));
  // how long the truck had been standing at each reading (since its last driving)
  const stood = new Array(rows.length);
  let lastDrive = -Infinity;
  for (let i = 0; i < rows.length; i++) {
    if (drivingAt(i)) lastDrive = rows[i].t;
    stood[i] = rows[i].t - lastDrive;
  }
  /** Settled standing-still readings next to `edge`, back to (dir -1) or on from (dir +1) the
   *  nearest driving. Readings in the first SETTLE of a stop are skipped: the fuel is still
   *  settling, and a level taken then would show a "drop" that is only sloshing. */
  const nearStill = (edge, dir) => {
    const got = [];
    let i = dir < 0 ? lastIdx(rows, edge) : firstIdx(rows, edge);
    for (; i >= 0 && i < rows.length && got.length < NEAR; i += dir) {
      const s = rows[i];
      if (Math.abs(s.t - edge) > LOOK) break;
      if (drivingAt(i)) break;
      if (valid(s) && !moving(s) && stood[i] >= SETTLE) got.push(s);
    }
    return dir < 0 ? got.reverse() : got;
  };
  const level = (xs) => (xs.length ? { t: xs[xs.length >> 1].t, mv: Math.round(median(xs.map((s) => s.f))) } : null);
  const withVal = (lv) => (lv ? { ...lv, v: round1(val(lv.mv)) } : null);
  const span = (from, to) => rows.filter((s) => s.t >= from && s.t <= to);
  const capped = (x) => (Number.isFinite(x) ? x : Infinity);

  if (kind === 'receipt') {
    if (!hasL || !Number.isFinite(receiptL)) return out('nodata');
    const from = refuelSeen ? t0 - 3 * HOUR : dayOnly ? t - 6 * HOUR : t - 4 * HOUR;
    const to = refuelSeen ? t + 3 * HOUR : dayOnly ? t + 30 * HOUR : t + 4 * HOUR;
    const win = span(from, to);
    // settled standing readings only, as for a drain: a reading in the first minutes of a stop
    // can sit at the top of the scale and would pass for a fill
    const still = [];
    const drove = [0]; // drives up to each of them, so a rise across a drive can be told
    let drives = 0;
    for (let i = 0; i < rows.length; i++) {
      const s = rows[i];
      if (s.t < from || s.t > to) continue;
      if (drivingAt(i) && !(i > 0 && drivingAt(i - 1))) drives++;
      if (valid(s) && !moving(s) && stood[i] >= SETTLE) { still.push(s); drove[still.length - 1] = drives; }
    }
    if (still.length < 3) return out('nodata');
    if (pegged(win)) return out('sensor', { note: 'limit' });
    const m = smooth(still.map((s) => val(s.f)));
    if (m.some(outside)) return out('sensor', { note: 'outside' });
    // a probe that is dead for the whole window, or dies in it and then reads flat
    const tail = win.slice(Math.max(0, win.length - 60));
    if (stuck(win) || stuck(tail)) return out('sensor', { note: 'stuck' });
    const { rise, rise0, rise1 } = swings(m);
    const tol = Math.max(40, receiptL * 0.15); // tank tables are 10-15 % off near the top; fills splash
    const need = Math.max(30, receiptL * 0.25);
    if (rise >= need) {
      // the refuel itself: the meter at the bottom and at the top of its largest rise, inside one
      // stop where it can (no drive between: the fill measured whole)
      let r = { rise, v0: m[rise0], v1: m[rise1], i0: rise0, i1: rise1 };
      let one = drove[rise0] === drove[rise1];
      for (let a = 0; !one && a < still.length;) {
        let b = a;
        while (b + 1 < still.length && drove[b + 1] === drove[a]) b++;
        const g = smooth(still.slice(a, b + 1).map((s) => val(s.f)));
        const sw = swings(g);
        // the stop's own rise is the fill when it is (about) all of the rise across the drives
        if (sw.rise >= rise - Math.max(20, rise * 0.15) && sw.rise >= need) {
          r = { rise: sw.rise, v0: g[sw.rise0], v1: g[sw.rise1], i0: a + sw.rise0, i1: a + sw.rise1 };
          one = true;
        }
        a = b + 1;
      }
      const before = { t: still[r.i0].t, mv: still[r.i0].f, v: round1(r.v0) };
      const after = { t: still[r.i1].t, mv: still[r.i1].f, v: round1(r.v1) };
      const lost = Math.min(receiptL - r.rise, capped(missingL));
      // the rise only seen across a drive (filled at a stop too short for a settled reading):
      // more went in than it shows (the drive burnt some), so only "all of it" can be told
      if (!one && lost > tol) return out('nodata', { wentIn: round1(r.rise), before, after });
      return lost > tol
        ? out('short', { wentIn: round1(r.rise), lost: round1(lost), before, after })
        : out('full', { wentIn: round1(r.rise), before, after });
    }
    const before = withVal(level(still.slice(0, NEAR)));
    const after = withVal(level(still.slice(-NEAR)));
    // "no refuel at all" only when no standing reading, settled or not, shows a fill either: a
    // short stop at the pump has none settled
    const any = smooth(win.filter((s) => valid(s) && !moving(s)).map((s) => val(s.f)));
    if (swings(any).rise >= need) return out('nodata', { before, after });
    const lost = Math.min(receiptL - Math.max(0, rise), capped(missingL));
    return out('norefuel', { wentIn: round1(Math.max(0, rise)), lost: round1(lost), before, after });
  }

  const pre = nearStill(t0, -1);
  const post = nearStill(t, 1);
  const before = withVal(level(pre));
  const after = withVal(level(post));
  const amount = hasL ? amountL : amountMv;
  const need = Math.max(minU, Number.isFinite(amount) ? amount * 0.5 : minU * 2);
  if (pegged(span(pre.length ? pre[0].t : t0, post.length ? post[post.length - 1].t : t))) return out('sensor', { note: 'limit', before, after });
  if ([before?.v, after?.v].some(outside)) return out('sensor', { note: 'outside', before, after });
  // the probe died at the event: the same level at every stop of the next day's driving
  if (stuck(span(t, t + 24 * HOUR))) return out('sensor', { note: 'stuck', before, after });

  if (kind === 'trip') {
    if (!before || !after || !Number.isFinite(fromMv) || !Number.isFinite(toMv) || !Number.isFinite(amount)) return out('nodata', { before, after });
    // what the detector allowed for the trip itself (its fall minus the excess it flagged)
    const used = Math.max(0, (hasL ? val(fromMv) - val(toMv) : fromMv - toMv) - amount);
    const fell = before.v - after.v;
    const excess = fell - used;
    // strict: a fall on the road is only "too much" against an average consumption, which is no
    // proof; never theft evidence on its own
    if (excess >= need) return out('trip', { fell: round1(fell), before, after });
    if (fell <= -minU) return out('refuel', { fell: round1(fell), before, after });
    return out('no_drop', { fell: round1(fell), before, after });
  }

  // at a stop: the meter while standing still, from just before the event to just after it
  const a = pre.length ? pre[0].t : t0;
  const b = post.length ? post[post.length - 1].t : t;
  const still = rows.filter((s) => s.t >= a && s.t <= b && valid(s) && !moving(s));
  if (still.length < 3) return out('nodata', { before, after });
  const m = smooth(still.map((s) => val(s.f)));
  if (m.some(outside)) return out('sensor', { note: 'outside', before, after });
  const { drop, rise } = swings(m);
  // what the meter shows from before to after (to the last reading at the stop if none after)
  const fell = before && after ? before.v - after.v : (before ? before.v : m[0]) - m[m.length - 1];
  // strict: a theft needs a settled level both before and after it
  if (fell >= need && !(before && after)) return out('nodata', { fell: round1(fell), before, after });
  if (fell >= need) return out('drop', { lost: round1(Math.min(capped(amount), fell)), fell: round1(fell), drop: round1(drop), rise: round1(rise), before, after });
  if (fell <= -minU) return out('refuel', { fell: round1(fell), rise: round1(rise), before, after });
  if (rise >= need) return out('recovered', { fell: round1(fell), drop: round1(drop), rise: round1(rise), before, after });
  return out('no_drop', { fell: round1(fell), drop: round1(drop), before, after });
}

/**
 * Is a fuel probe that still gives readings broken all the same? Judged from its last day of raw
 * readings, for the fleet screen's fuel meter state (next to the detector's own "no signal" and
 * "frozen" checks, which miss these). { code } or null (looks alive, or too little to tell):
 *   limit    reads at the 10 V limit nearly all through its last 6 h: a wiring fault
 *   outside  standing still, reads well past a full tank
 *   stuck    the same level through 2 h or more of driving (dead probe); not near the top of
 *            the tank, where a full tank holds a live probe still
 */
export function probeFault({ rows, cal = null, th = {} }) {
  const { full, hasL, val, valid, moving, outside, stuck } = kit(cal, th);
  const ok = rows.filter(valid);
  if (ok.length < 20) return null;
  const last = ok[ok.length - 1].t;
  const recent = ok.filter((s) => s.t >= last - 6 * HOUR);
  if (recent.length >= 20 && last - recent[0].t >= 2 * HOUR && recent.filter((s) => s.f >= PEGGED_MV).length >= recent.length * 0.9) {
    return { code: 'limit' };
  }
  const still = ok.filter((s) => !moving(s)).slice(-NEAR);
  if (still.length >= 3 && outside(median(still.map((s) => val(s.f))))) return { code: 'outside' };
  if (stuck(rows, 2 * HOUR)) {
    const lv = val(median(ok.map((s) => s.f)));
    const top = Number.isFinite(full) && lv >= (hasL ? full * 0.9 : full - 300);
    if (!top) return { code: 'stuck' };
  }
  return null;
}

/** Index of the last row at or before ms (-1 if none). */
function lastIdx(rows, ms) {
  let lo = 0;
  let hi = rows.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].t <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
/** Index of the first row at or after ms (rows.length if none). */
function firstIdx(rows, ms) {
  let lo = 0;
  let hi = rows.length - 1;
  let ans = rows.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].t >= ms) { ans = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return ans;
}
