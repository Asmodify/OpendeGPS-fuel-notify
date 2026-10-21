// Distance and engine time from raw tracker messages, shared by the Report (engine.js summary)
// and the cloud backend's in-memory store.
import { haversineM } from './util.js';

/** An odometer increase between two messages (in time order) that is real driving: no faster
 *  than ~250 km/h, and a step over 1000 km (a tracker that reset its counter to 0 and later
 *  comes back on its real reading) only when the straight line between the two fixes makes it
 *  possible. */
export function odoStepOk(p, r) {
  if (!Number.isFinite(p.odo) || !Number.isFinite(r.odo) || r.odo < p.odo) return false;
  const d = r.odo - p.odo;
  if (d > (r.t - p.t) * 0.07 + 1000) return false;
  if (d <= 1e6) return true;
  return !!(p.lat && p.lng && r.lat && r.lng) && d <= 3 * haversineM(p.lat, p.lng, r.lat, r.lng) + 5000;
}

/** Odometer distance / engine time / max speed over samples in time order (null without
 *  samples). Engine running = moving, or stopped with ignition on and the voltage at charging
 *  level (thr24 / thr12 mV); gaps over 5 min are not counted. */
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
      if (odoStepOk(p, r)) odoM += r.odo - p.odo;
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

/** The rows with lo <= t <= hi, from rows in time order (binary search, no copy of the rest). */
export function sliceByTime(rows, lo, hi) {
  const first = (t) => {
    let a = 0;
    let b = rows.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (rows[m].t < t) a = m + 1; else b = m;
    }
    return a;
  };
  let end = first(hi);
  while (end < rows.length && rows[end].t === hi) end++;
  return rows.slice(first(lo), end);
}
