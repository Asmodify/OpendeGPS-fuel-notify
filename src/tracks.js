// Where a truck went: its path simplified for the map, the places it stood still and how far it drove.
// Used by the fleet map trails (GET /api/tracks) and the truck page map (history.stops).
import { haversineM, round } from './util.js';

const MIN_STEP_M = 25; // a new raw point only after the truck moved this far (parked clusters fold away)
const SIMPLIFY_M = 12; // path simplification: drop points closer than this to the line (keeps bends)
const STOP_RADIUS_M = 300; // still "the same place" within this distance
const STOP_MIN_MS = 20 * 60e3; // a stop shown on the map lasts at least 20 min
const JUMP_KMH = 250; // a GPS jump faster than this is ignored
const GAP_MS = 20 * 60e3; // no position for this long while the truck moved on: drawn as a gap
const GAP_M = 2000;

const okPos = (r) => Number.isFinite(r.lat) && Number.isFinite(r.lng) && !(r.lat === 0 && r.lng === 0) && Math.abs(r.lat) <= 90 && Math.abs(r.lng) <= 180;

/** Douglas-Peucker on [t, lat, lng] points, tolerance in metres (local flat projection). */
export function simplify(pts, tolM) {
  if (pts.length < 3) return pts.slice();
  const lat0 = (pts[0][1] * Math.PI) / 180;
  const kx = 111320 * Math.cos(lat0);
  const ky = 110540;
  const xy = pts.map((p) => [p[2] * kx, p[1] * ky]);
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const tol2 = tolM * tolM;
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = xy[a];
    const [bx, by] = xy[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let best = -1;
    let bestD = tol2;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = xy[i];
      let d2;
      if (len2 === 0) d2 = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        const u = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d2 = (px - ax - u * dx) ** 2 + (py - ay - u * dy) ** 2;
      }
      if (d2 > bestD) { bestD = d2; best = i; }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * rows: samples ordered by time ({ t, lat, lng, spd }).
 * Returns { pts: [[t, lat, lng, gap], ...], stops: [[fromT, toT, lat, lng], ...], km }.
 * gap = 1 on a point reached after a GPS silence (no position for 20+ min over 2+ km): the map
 * draws that stretch dashed instead of as a road. pts keeps at most maxPts points; the path is
 * simplified so straight roads take few points and bends keep theirs.
 */
export function routeOf(rows, maxPts = 1500) {
  const valid = rows.filter(okPos);
  const segs = [[]];
  const stops = [];
  let km = 0;
  let last = null; // last accepted position
  let stop = null; // { t0, t1, lat, lng } current still period
  const closeStop = () => {
    if (stop && stop.t1 - stop.t0 >= STOP_MIN_MS) stops.push([stop.t0, stop.t1, round(stop.lat, 5), round(stop.lng, 5)]);
    stop = null;
  };
  for (const r of valid) {
    if (!last) {
      segs[0].push([r.t, r.lat, r.lng]);
      last = r;
      if ((r.spd ?? 0) < 3) stop = { t0: r.t, t1: r.t, lat: r.lat, lng: r.lng };
      continue;
    }
    const d = haversineM(last.lat, last.lng, r.lat, r.lng);
    const dt = r.t - last.t;
    if (dt > 0 && d / 1000 / (dt / 3600e3) > JUMP_KMH && d > 2000) continue; // GPS jump
    if (stop && haversineM(stop.lat, stop.lng, r.lat, r.lng) <= STOP_RADIUS_M && (r.spd ?? 0) < 5) stop.t1 = r.t;
    else {
      closeStop();
      if ((r.spd ?? 0) < 3) stop = { t0: r.t, t1: r.t, lat: r.lat, lng: r.lng };
    }
    if (d >= MIN_STEP_M) {
      km += d / 1000;
      if (dt > GAP_MS && d > GAP_M) segs.push([]);
      segs[segs.length - 1].push([r.t, r.lat, r.lng]);
      last = r;
    } else if (r === valid[valid.length - 1]) {
      segs[segs.length - 1].push([r.t, r.lat, r.lng]); // the path always ends where the truck is
    }
  }
  closeStop();
  const raw = segs.reduce((n, s) => n + s.length, 0);
  let tol = SIMPLIFY_M;
  let out = [];
  for (let pass = 0; pass < 8; pass++) {
    out = [];
    segs.forEach((seg, i) => {
      simplify(seg, tol).forEach((p, j) => out.push([p[0], round(p[1], 5), round(p[2], 5), i > 0 && j === 0 ? 1 : 0]));
    });
    if (out.length <= maxPts || raw <= maxPts) break;
    tol *= 2;
  }
  return { pts: out, stops, km: round(km, 1) };
}
