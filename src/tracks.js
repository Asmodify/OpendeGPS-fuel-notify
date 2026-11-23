// Where a truck went: its path thinned for the map, the places it stood still and how far it drove.
// Used by the fleet map trails (GET /api/tracks) and the truck page map (history.stops).
import { haversineM, round } from './util.js';

const MIN_STEP_M = 120; // a new path point only after the truck moved this far (parked clusters fold away)
const STOP_RADIUS_M = 300; // still "the same place" within this distance
const STOP_MIN_MS = 20 * 60e3; // a stop shown on the map lasts at least 20 min
const JUMP_KMH = 250; // a GPS jump faster than this is ignored

const okPos = (r) => Number.isFinite(r.lat) && Number.isFinite(r.lng) && !(r.lat === 0 && r.lng === 0) && Math.abs(r.lat) <= 90 && Math.abs(r.lng) <= 180;

/**
 * rows: samples ordered by time ({ t, lat, lng, spd }).
 * Returns { pts: [[t, lat, lng], ...], stops: [[fromT, toT, lat, lng], ...], km }.
 * pts keeps at most maxPts points (evenly dropped if longer; first and last always kept).
 */
export function routeOf(rows, maxPts = 800) {
  const valid = rows.filter(okPos);
  const pts = [];
  const stops = [];
  let km = 0;
  let last = null; // last accepted position
  let stop = null; // { t0, t1, lat, lng } current still period
  const closeStop = () => {
    if (stop && stop.t1 - stop.t0 >= STOP_MIN_MS) stops.push([stop.t0, stop.t1, round(stop.lat, 5), round(stop.lng, 5)]);
    stop = null;
  };
  for (const r of valid) {
    if (last) {
      const d = haversineM(last.lat, last.lng, r.lat, r.lng);
      const dtH = (r.t - last.t) / 3600e3;
      if (dtH > 0 && d / 1000 / dtH > JUMP_KMH && d > 2000) continue; // GPS jump
      if (stop && haversineM(stop.lat, stop.lng, r.lat, r.lng) <= STOP_RADIUS_M && (r.spd ?? 0) < 5) stop.t1 = r.t;
      else {
        closeStop();
        if ((r.spd ?? 0) < 3) stop = { t0: r.t, t1: r.t, lat: r.lat, lng: r.lng };
      }
      if (d >= MIN_STEP_M) {
        km += d / 1000;
        pts.push([r.t, round(r.lat, 5), round(r.lng, 5)]);
        last = r;
      }
    } else {
      pts.push([r.t, round(r.lat, 5), round(r.lng, 5)]);
      last = r;
      if ((r.spd ?? 0) < 3) stop = { t0: r.t, t1: r.t, lat: r.lat, lng: r.lng };
    }
  }
  closeStop();
  const end = valid[valid.length - 1];
  if (end && pts.length && pts[pts.length - 1][0] !== end.t && last !== end && okPos(end)) {
    const lastPt = pts[pts.length - 1];
    if (haversineM(lastPt[1], lastPt[2], end.lat, end.lng) < 5000) pts.push([end.t, round(end.lat, 5), round(end.lng, 5)]);
  }
  let out = pts;
  if (pts.length > maxPts) {
    const step = pts.length / maxPts;
    out = [];
    for (let i = 0; i < maxPts - 1; i++) out.push(pts[Math.floor(i * step)]);
    out.push(pts[pts.length - 1]);
  }
  return { pts: out, stops, km: round(km, 1) };
}
