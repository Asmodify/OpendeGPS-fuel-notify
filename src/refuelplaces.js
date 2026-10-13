// Where a refuel actually happened. A refuel alert's own position is where the detector
// noticed the rise; for a fill that is only seen after the truck drove off that is past the
// pump, often by kilometres. The fill spot comes from the stored track instead: the stop in
// the refuel's window where the raw fuel reading rose, or the one spot the truck never left.
// Refuels at the same spot are one place; places can be given names in config.local.json:
//   "refuelPlaces": [{ "name": "…", "lat": 43.6476, "lng": 105.5637, "radiusM": 400 }]
import { haversineM } from './util.js';

const MIN = 60e3;
// samples to look at: from a little before the refuel's start (from_t) to a little after its t
export const FILL_BEFORE_MS = 10 * MIN;
export const FILL_AFTER_MS = 5 * MIN;
const STOP_SPEED = 3; // km/h: slower is standing still (as the engine's status)
const STOP_SPOT_M = 200; // consecutive stationary samples this close together are one stop
const NEVER_LEFT_M = 500; // every position within this of the stop: the truck never left
const EDGE_READINGS = 3; // readings just before / after a stop that give the level then
const MIN_VALID_MV = 100; // lower raw readings: sensor unpowered (master switch off) or broken
const MIN_RISE_MV = 300; // the detector's default refuelMv
const MAX_WINDOW_MS = 24 * 60 * MIN; // never look further back than this before the alert
export const PLACE_RADIUS_M = 400;

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
export const validPos = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/**
 * The spot a refuel was filled at, or null when the track does not show it.
 *   samples: { t, f, spd, lat, lng } in time order, covering
 *            [from_t - FILL_BEFORE_MS, t + FILL_AFTER_MS] of the refuel alert
 * Returns { lat, lng, t } (t: when the truck stopped there).
 */
export function fillSpot(samples) {
  // stops: consecutive stationary samples at one spot (a tracker may send nothing for a
  // while at the pump, so a gap in time does not end a stop)
  const runs = [];
  let cur = null;
  samples.forEach((s, i) => {
    const still = (s.spd ?? 0) < STOP_SPEED && validPos(s.lat, s.lng);
    if (still && cur && haversineM(cur.lat, cur.lng, s.lat, s.lng) < STOP_SPOT_M) {
      cur.last = i;
      return;
    }
    if (cur) runs.push(cur);
    cur = still ? { lat: s.lat, lng: s.lng, t: s.t, first: i, last: i } : null;
  });
  if (cur) runs.push(cur);
  if (!runs.length) return null;

  // the stop across which the tank level rose the most: from the readings just before it (or
  // its first ones) to the readings just after it (or its last ones). Readings may be missing
  // while the fuel goes in, or the sensor may be off then (master switch), so the ones taken
  // while driving in and out count too.
  const ok = (s) => Number.isFinite(s.f) && s.f > MIN_VALID_MV;
  const levels = (from, to) => samples.slice(Math.max(0, from), Math.max(0, to)).filter(ok).map((s) => s.f);
  const med = (a) => (a.length ? median(a) : null);
  let best = null;
  for (const r of runs) {
    const inside = levels(r.first, r.last + 1);
    const k = Math.max(1, Math.min(EDGE_READINGS, Math.floor(inside.length / 2)));
    const prev = levels(0, r.first).slice(-EDGE_READINGS);
    const next = levels(r.last + 1, samples.length).slice(0, EDGE_READINGS);
    const before = [med(prev), med(inside.slice(0, k))].filter((x) => x !== null);
    const after = [med(inside.slice(-k)), med(next)].filter((x) => x !== null);
    if (!before.length || !after.length) continue;
    const rise = Math.max(...after) - Math.min(...before);
    if (!best || rise > best.rise) best = { r, rise };
  }
  if (best && best.rise >= MIN_RISE_MV) return { lat: best.r.lat, lng: best.r.lng, t: best.r.t };

  // no rise to see, but the truck stood at one spot the whole time
  const home = runs[0];
  const never = samples.every((s) => !validPos(s.lat, s.lng) || haversineM(home.lat, home.lng, s.lat, s.lng) < NEVER_LEFT_M);
  return never ? { lat: home.lat, lng: home.lng, t: home.t } : null;
}

/** [from, to] of the samples fillSpot() needs for a refuel alert (alertView: t, fromT). */
export function fillWindow(a) {
  const start = Number.isFinite(a.fromT) ? a.fromT : a.t;
  return [Math.max(start - FILL_BEFORE_MS, a.t - MAX_WINDOW_MS), a.t + FILL_AFTER_MS];
}

/**
 * Fill spot of every refuel among `alerts` (alertView objects): Map alert id -> spot | null.
 *   samplesFor(imei, from, to) -> samples in time order (empty when no longer stored)
 */
export function refuelFillSpots(alerts, samplesFor) {
  const out = new Map();
  for (const a of alerts) {
    if (a.type !== 'refuel' || !a.imei || !Number.isFinite(a.t)) continue;
    const [from, to] = fillWindow(a);
    out.set(a.id, fillSpot(samplesFor(a.imei, from, to) || []));
  }
  return out;
}

/** Valid named places from the config: [{ name, lat, lng, radiusM }]. */
export function namedPlaces(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && typeof p.name === 'string' && p.name.trim() && validPos(Number(p.lat), Number(p.lng)))
    .map((p) => ({
      name: p.name.trim().slice(0, 100),
      lat: Number(p.lat),
      lng: Number(p.lng),
      radiusM: Number.isFinite(Number(p.radiusM)) ? Math.min(5000, Math.max(50, Number(p.radiusM))) : PLACE_RADIUS_M,
    }));
}

/**
 * Group fill spots into places. `spots`: [{ lat, lng }] (null entries are skipped). A spot
 * inside a named place (the nearest, within its radius) belongs to it; the others are grouped
 * around the busiest spots (the one with the most others within PLACE_RADIUS_M first, so the
 * grouping does not depend on the order of the spots) and numbered "Газар 1, 2, …" by how
 * many refuels each has.
 * Returns { placeOf: [place | null] (same order as spots), places: [place] (most used first) }
 * place: { name, lat, lng, named, count }
 */
export function groupPlaces(spots, named = []) {
  const places = named.map((p) => ({ ...p, named: true, count: 0 }));
  const placeOf = spots.map(() => null);
  const free = [];
  spots.forEach((s, i) => {
    if (!s || !validPos(s.lat, s.lng)) return;
    let hit = null;
    let hitM = Infinity;
    for (const p of places) {
      const m = haversineM(p.lat, p.lng, s.lat, s.lng);
      if (m <= p.radiusM && m < hitM) { hit = p; hitM = m; }
    }
    if (hit) {
      hit.count++;
      placeOf[i] = hit;
    } else free.push(i);
  });

  // grid cells at least PLACE_RADIUS_M wide (up to 55° N), so neighbours are in the 3 x 3 around
  const cell = (s) => [Math.floor(s.lat / 0.004), Math.floor(s.lng / 0.008)];
  const grid = new Map();
  for (const i of free) {
    const k = cell(spots[i]).join();
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  const neighbours = (i) => {
    const [a, b] = cell(spots[i]);
    const out = [];
    for (let da = -1; da <= 1; da++) {
      for (let db = -1; db <= 1; db++) {
        for (const j of grid.get(`${a + da},${b + db}`) || []) {
          if (haversineM(spots[i].lat, spots[i].lng, spots[j].lat, spots[j].lng) < PLACE_RADIUS_M) out.push(j);
        }
      }
    }
    return out;
  };
  const near = new Map(free.map((i) => [i, neighbours(i)]));
  const order = [...free].sort((a, b) => near.get(b).length - near.get(a).length || a - b);
  const auto = [];
  for (const c of order) {
    if (placeOf[c]) continue;
    const members = near.get(c).filter((j) => !placeOf[j]);
    const place = {
      name: null,
      lat: members.reduce((a, j) => a + spots[j].lat, 0) / members.length,
      lng: members.reduce((a, j) => a + spots[j].lng, 0) / members.length,
      named: false,
      count: members.length,
    };
    for (const j of members) placeOf[j] = place;
    auto.push(place);
  }
  auto.sort((a, b) => b.count - a.count);
  auto.forEach((c, i) => { c.name = `Газар ${i + 1}`; });
  const out = [...places.filter((p) => p.count), ...auto].sort((a, b) => b.count - a.count);
  return { placeOf, places: out };
}
