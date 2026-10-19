// What the fuel meter itself shows around a theft alert: the raw readings of the fuel sensor
// taken while the vehicle stood still and the fuel had settled (sloshing while driving is not a
// level), not the detector's settled levels. The evidence pack and its list use it so that a
// refuel, a sensor fault or a drop the meter does not show is never presented as theft. A sensor
// that reads steadily on the move (a damped one) gives its level from the nearest drive when a
// side has no settled standing reading (level.moving = true).
//
// Against the fall the meter shows stands the most the truck could have burnt meanwhile (BURN):
// a hard ceiling per km driven, per hour idling with the engine on and per hour of GPS silence
// after which the truck turned up elsewhere. Never an average consumption: a driver cannot argue
// that fuel beyond the ceiling went into the engine. Only what fell beyond it is a loss.
//
// verdict
//   drop       the meter fell while the truck stood still, by more than idling could burn;
//              lost = the smaller of that excess and the alert's amount, so evidence never
//              claims more than either shows
//   road       between two stops the meter fell by more than the road could burn at the ceiling;
//              lost = that excess (capped by the alert's amount)
//   burnt      the meter fell, but by no more than driving, idling or the GPS silence could
//              burn: no proof (note 'silent': an hour or more of silence in which the truck
//              moved away explains it on its own)
//   refuel     the meter went up, not down: a refuel, not theft
//   recovered  the meter dipped and came back up: not a loss
//   no_drop    the meter shows no fall of that size
//   short      receipt: the meter rose clearly less than the receipt (beyond tank-table error)
//   norefuel   receipt: the meter shows no refuel at all
//   full       receipt: the meter rose by (about) the receipt's litres
//   sensor     readings at the sensor's 10 V limit or outside the tank, a meter that never moves
//              while the truck drives, or one that swings up and down by tens of litres while it
//              stands (note 'flicker': a reading that follows the supply, a loose float)
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
const GAP = 15 * MIN; // a longer silence between two readings is "no data" (as the pack's facts count it)
const RUN_MIN = 10 * MIN; // a drive this long, or RUN_KM far, ends a stop; a shorter move (up to the
const RUN_KM = 3; //          pump, across the yard) does not, though the fuel still settles after it
const PAUSE = 5 * MIN; // a halt this short inside a drive (a gate, a queue) does not split it
const THERMAL = 0.025; // diesel shrinks about 0.08 % a degree: a 30-degree night takes 2.5 % off the level
const STEADY_MIN = 20 * MIN; // a sensor steady on the move: this long a drive next to the event
const MOVE_BIAS = 0.05; // of the tank: how far a reading on the move may sit from the level at rest
//                         (slope, braking); allowed for when only one side's level is on the move
const RUN_V = [26400, 13300]; // the voltage (24 V / 12 V systems) above which the engine runs
/** The most a loaded coal truck can burn: ceilings, not averages (a heavy loaded run on a dirt
 *  road is about 0.8-0.9 L a km). */
export const BURN = {
  perKm: 1.3, // litres a km on the road
  perHourMoving: 50, // litres an hour rolling: slow heavy going, where litres a km run high
  idle: 6, // litres an hour standing with the engine on (heater, PTO, high idle)
  silentMoved: 100, // litres an hour of GPS silence after which the truck turned up a km or more
  //                   away: as if it drove at road speed the whole time
};
export const CONFIRMS = new Set(['drop', 'road', 'short', 'norefuel']);

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const pos = (s) => Number.isFinite(s.lat) && Number.isFinite(s.lng) && !(s.lat === 0 && s.lng === 0) && Math.abs(s.lat) <= 90 && Math.abs(s.lng) <= 180;
function haversineKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(Math.min(1, h)));
}
/** Kilometres between two readings: by GPS when both have a position (a jump faster than 250 km/h
 *  is a GPS error), else by their speed over the time between them. */
function legKm(a, b) {
  const h = (b.t - a.t) / HOUR;
  if (pos(a) && pos(b)) {
    const d = haversineKm(a, b);
    if (d <= h * 250 + 0.1) return d;
  }
  return (((a.spd ?? 0) + (b.spd ?? 0)) / 2) * h;
}

/** Turns along a series: a rise after a fall or a fall after a rise, each of `step` or more. */
function reversals(vals, step) {
  let n = 0;
  let dir = 0; // +1 rising, -1 falling, 0 none yet
  let ext = vals.length ? vals[0] : 0; // the last extreme (the start until the first step)
  for (let i = 1; i < vals.length; i++) {
    const v = vals[i];
    if (dir === 0) {
      if (Math.abs(v - ext) >= step) { dir = v > ext ? 1 : -1; ext = v; }
    } else if ((dir > 0 && v >= ext) || (dir < 0 && v <= ext)) ext = v;
    else if (Math.abs(v - ext) >= step) { dir = -dir; ext = v; n++; }
  }
  return n;
}
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
  // the engine runs: the tracker's flag, or the alternator's voltage (the flag is a key signal on
  // some trucks; a battery at rest sits well under RUN_V)
  const running = (s) => s.ign === 1 || (Number.isFinite(s.pwr) && s.pwr >= (s.pwr > 18000 ? RUN_V[0] : RUN_V[1]));
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
  return { tank, full, hasL, unit: hasL ? 'L' : 'mV', val, valid, moving, running, minU, outside, pegged, stuck };
}

/**
 * kind      'parked' (drain at a stop / while parked / power off), 'trip' (more fuel used between
 *           two stops than the trip explains) or 'receipt' (a receipt the tank does not show)
 * rows      raw samples {t, f, spd, pwr, ign?, lat?, lng?} in time order, covering t0 - 6 h ..
 *           t + 24 h (receipts: t + 6 h, or t + 30 h without a refuel)
 * t0, t     start and end (detection) of the event; for a receipt without a refuel, t is the
 *           receipt's time (its day's 00:00 when it has no time: dayOnly)
 * amount    the alert's amount in litres (amountL) or, without a tank table, in mV (amountMv)
 * receiptL  the receipt's litres; missingL: what the detector found missing of it;
 *           refuelSeen: the receipt was matched to a refuel (fromT known)
 * (fromMv / toMv, the detector's trip levels, are accepted and not used: a trip is judged against
 * the burn ceiling, never against the detector's average consumption)
 */
export function meterCheck({ kind, rows, t0, t, amountL = null, amountMv = null, receiptL = null, missingL = null, refuelSeen = false, dayOnly = false, cal = null, th = {} }) {
  const { full, hasL, unit, val, valid, moving, running, minU, outside, pegged, stuck } = kit(cal, th);
  const out = (verdict, extra = {}) => ({ verdict, unit, ...extra });
  const FLICK = Math.max(2 * minU, hasL && full ? full * 0.05 : 0); // a swing that counts as flicker
  const STEADY = Math.max(minU, hasL && full ? full * 0.02 : 0); // how still a sensor on the move must hold

  // a driving reading = moving, next to another moving reading (one alone is GPS jitter at a stop)
  const drivingAt = (i) => moving(rows[i]) && ((i > 0 && moving(rows[i - 1])) || (i + 1 < rows.length && moving(rows[i + 1])));
  // how long the truck had been standing at each reading (since its last driving reading: any
  // move, however short, sets the fuel sloshing again)
  const stood = new Array(rows.length);
  let lastDrive = -Infinity;
  for (let i = 0; i < rows.length; i++) {
    if (drivingAt(i)) lastDrive = rows[i].t;
    stood[i] = rows[i].t - lastDrive;
  }
  // a drive (driving readings, with halts up to PAUSE inside it) that ends a stop: RUN_MIN long
  // or RUN_KM far; the settled readings either side of a shorter move belong to one stop
  const big = new Uint8Array(rows.length);
  for (let i = 0; i < rows.length;) {
    if (!drivingAt(i)) { i++; continue; }
    let j = i;
    let km = 0;
    for (let k = i + 1; k < rows.length; k++) {
      if (drivingAt(k)) {
        for (let q = j + 1; q <= k; q++) km += legKm(rows[q - 1], rows[q]);
        j = k;
      } else if (rows[k].t - rows[j].t > PAUSE) break;
    }
    if (rows[j].t - rows[i].t >= RUN_MIN || km >= RUN_KM) big.fill(1, i, j + 1);
    i = j + 1;
  }
  /** Settled standing-still readings next to `edge`, back to (dir -1) or on from (dir +1) the
   *  nearest drive. Readings in the first SETTLE of a stop (or after a short move) are skipped:
   *  the fuel is still settling, and a level taken then would show a "drop" that is only
   *  sloshing. */
  const nearStill = (edge, dir) => {
    const got = [];
    let i = dir < 0 ? lastIdx(rows, edge) : firstIdx(rows, edge);
    for (; i >= 0 && i < rows.length && got.length < NEAR; i += dir) {
      const s = rows[i];
      if (Math.abs(s.t - edge) > LOOK) break;
      if (big[i]) break;
      if (valid(s) && !moving(s) && stood[i] >= SETTLE) got.push(s);
    }
    return dir < 0 ? got.reverse() : got;
  };
  /** A level on the move, for a side with no settled standing reading: the nearest drive's
   *  readings within STEADY_MIN of `edge`, when they hold within STEADY around their trend (the
   *  consumption slopes them): a damped sensor, readable while driving. */
  const steadyMoving = (edge, dir) => {
    const xs = [];
    let i = dir < 0 ? lastIdx(rows, edge) : firstIdx(rows, edge);
    for (; i >= 0 && i < rows.length; i += dir) {
      const s = rows[i];
      if (Math.abs(s.t - edge) > LOOK) break;
      if (xs.length && Math.abs(s.t - xs[0].t) > STEADY_MIN) break;
      if (drivingAt(i) && valid(s)) xs.push(s);
    }
    if (xs.length < 10) return null;
    const v = xs.map((s) => val(s.f));
    const tx = xs.map((s) => (s.t - xs[0].t) / HOUR);
    const n = v.length;
    const mx = tx.reduce((p, q) => p + q, 0) / n;
    const my = v.reduce((p, q) => p + q, 0) / n;
    let sxy = 0;
    let sxx = 0;
    for (let k = 0; k < n; k++) { sxy += (tx[k] - mx) * (v[k] - my); sxx += (tx[k] - mx) ** 2; }
    const slope = sxx ? sxy / sxx : 0;
    const res = smooth(v.map((y, k) => y - slope * (tx[k] - mx)));
    if (Math.max(...res) - Math.min(...res) > STEADY) return null;
    const near = xs.slice(0, NEAR);
    return dir < 0 ? near.reverse() : near;
  };
  const level = (xs) => (xs.length ? { t: xs[xs.length >> 1].t, mv: Math.round(median(xs.map((s) => s.f))) } : null);
  const withVal = (lv) => (lv ? { ...lv, v: round1(val(lv.mv)) } : null);
  const span = (from, to) => rows.filter((s) => s.t >= from && s.t <= to);
  const capped = (x) => (Number.isFinite(x) ? x : Infinity);
  /** The most the truck could have burnt between two times, at BURN's ceilings: the km driven (or
   *  the hours rolling, whichever gives more), the hours standing with the engine on, and the GPS
   *  silences: at road speed when the truck turned up a km or more away, idling when the engine
   *  was on at either end, nothing when it was off (the tracker sleeps with the engine). */
  const burnOf = (from, to) => {
    const xs = span(from, to);
    let km = 0;
    let movingMs = 0;
    let idleMs = 0;
    let silentMs = 0;
    let silentMovedMs = 0;
    let silentIdleMs = 0;
    for (let i = 1; i < xs.length; i++) {
      const p = xs[i - 1];
      const s = xs[i];
      const dt = s.t - p.t;
      if (dt > GAP) {
        silentMs += dt;
        if (pos(p) && pos(s) && haversineKm(p, s) >= 1) silentMovedMs += dt;
        else if (running(p) || running(s)) silentIdleMs += dt;
        continue;
      }
      if (moving(p) || moving(s)) { movingMs += dt; km += legKm(p, s); } else if (running(p)) idleMs += dt;
    }
    const h = (ms) => ms / HOUR;
    const liters = Math.max(BURN.perKm * km, BURN.perHourMoving * h(movingMs)) + BURN.idle * h(idleMs + silentIdleMs) + BURN.silentMoved * h(silentMovedMs);
    return { liters: round1(liters), km: round1(km), movingMs, idleMs: idleMs + silentIdleMs, silentMs, silentMovedMs };
  };

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
      if (big[i] && !(i > 0 && big[i - 1])) drives++;
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
  // a side with no settled standing reading: a sensor steady on the move gives its level from
  // the nearest drive instead (marked moving)
  const preM = pre.length ? null : steadyMoving(t0, -1);
  const postM = post.length ? null : steadyMoving(t, 1);
  const preAll = pre.length ? pre : preM || [];
  const postAll = post.length ? post : postM || [];
  const mark = (lv, onMove) => (lv && onMove ? { ...lv, moving: true } : lv);
  const before = mark(withVal(level(preAll)), !!preM);
  const after = mark(withVal(level(postAll)), !!postM);
  const amount = hasL ? amountL : amountMv;
  // the fall that counts: the alert's half at least, never under minU, nor under what a cold
  // night takes off the level (THERMAL of the level before)
  const need = Math.max(minU, Number.isFinite(amount) ? amount * 0.5 : minU * 2, hasL && before ? before.v * THERMAL : 0);
  // from the first reading before to the last one after
  const a = preAll.length ? preAll[0].t : t0;
  const b = postAll.length ? postAll[postAll.length - 1].t : t;
  if (pegged(span(a, b))) return out('sensor', { note: 'limit', before, after });
  if ([before?.v, after?.v].some(outside)) return out('sensor', { note: 'outside', before, after });
  // the probe died at the event: the same level at every stop of the next day's driving
  if (stuck(span(t, t + 24 * HOUR))) return out('sensor', { note: 'stuck', before, after });
  // a reading that swings up and down by FLICK or more, three turns or more, while the truck
  // stands (within 2 h of the event): it follows the supply or a loose float, not the fuel
  const settled = (from, to) => rows.filter((s, i) => s.t >= from && s.t <= to && valid(s) && !moving(s) && stood[i] >= SETTLE);
  if (reversals(smooth(settled(a - 2 * HOUR, b + 2 * HOUR).map((s) => val(s.f))), FLICK) >= 3) return out('sensor', { note: 'flicker', before, after });
  // the most that could have burnt between those readings (litres only: no ceiling in mV), plus
  // the allowance for a level read on the move when the other side's was read at rest (two
  // levels on the move sit off by the same amount, so none then)
  const burn = hasL ? burnOf(a, b) : null;
  if (burn) {
    burn.moveBias = !!before?.moving !== !!after?.moving && full ? round1(full * MOVE_BIAS) : 0;
    burn.total = round1(burn.liters + burn.moveBias);
  }
  const allow = burn ? burn.total : 0;
  const bn = allow > 0 ? burn : null; // quoted only when it took something off
  const silent = burn && burn.silentMovedMs >= HOUR ? { note: 'silent' } : {};
  const cap = (x) => round1(Math.min(capped(amount), x));

  if (kind === 'trip') {
    if (!before || !after || !hasL) return out('nodata', { before, after });
    const fell = before.v - after.v;
    const excess = fell - allow;
    if (excess >= need) return out('road', { lost: cap(excess), fell: round1(fell), burn: bn, before, after });
    if (fell <= -minU) return out('refuel', { fell: round1(fell), before, after });
    if (fell >= minU) return out('burnt', { fell: round1(fell), burn, ...silent, before, after });
    return out('no_drop', { fell: round1(fell), burn: bn, before, after });
  }

  // at a stop: the meter while standing still, from just before the event to just after it
  const still = span(a, b).filter((s) => valid(s) && !moving(s));
  if (still.length < 3 && !(before && after)) return out('nodata', { before, after });
  const m = still.length >= 3 ? smooth(still.map((s) => val(s.f))) : [];
  if (m.some(outside)) return out('sensor', { note: 'outside', before, after });
  const { drop, rise } = m.length ? swings(m) : { drop: 0, rise: 0 };
  // what the meter shows from before to after (to the last reading at the stop if none after)
  const fell = before && after ? before.v - after.v : (before ? before.v : m[0]) - m[m.length - 1];
  const excess = fell - allow;
  // strict: a theft needs a level both before and after it
  if (excess >= need && !(before && after)) return out('nodata', { fell: round1(fell), before, after });
  // the level back up within 3 h, the truck still standing: a dip (sloshing, a misreading that
  // came back), not a loss
  if (before && fell >= minU) {
    let end = b;
    for (let i = firstIdx(rows, b); i < rows.length && rows[i].t <= t + 3 * HOUR; i++) { if (big[i]) break; end = rows[i].t; }
    const later = smooth(settled(b + 1, end).map((s) => val(s.f)));
    const back = later.length >= 3 ? Math.max(...later) : -Infinity;
    // back to about the level before (a refuel overshoots it)
    if (Math.abs(back - before.v) <= Math.max(minU, need / 2)) {
      return out('recovered', { fell: round1(fell), drop: round1(drop), rise: round1(Math.max(...later) - (after ? after.v : m[m.length - 1])), before, after });
    }
  }
  if (excess >= need) return out('drop', { lost: cap(excess), fell: round1(fell), drop: round1(drop), rise: round1(rise), burn: bn, before, after });
  if (fell <= -minU) return out('refuel', { fell: round1(fell), rise: round1(rise), before, after });
  if (rise >= need) return out('recovered', { fell: round1(fell), drop: round1(drop), rise: round1(rise), before, after });
  if (fell >= need) return out('burnt', { fell: round1(fell), drop: round1(drop), burn, ...silent, before, after });
  return out('no_drop', { fell: round1(fell), drop: round1(drop), burn: bn, before, after });
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
