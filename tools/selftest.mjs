// Synthetic checks for the detector: injects known events into real cached history (and a
// few purely synthetic streams) and verifies each is reported exactly as expected. Also
// checks that a backend restart (replaying the last 12 h into a fresh detector) doesn't
// create alerts the uninterrupted run didn't have.
//
//   node --no-warnings tools/selftest.mjs [dataDir]
//
// dataDir (default testdata/, not published) holds objects.json and hist/<imei>.json (see
// tools/fetch-history.mjs). The vehicles used for the injected events can be named in
// <dataDir>/selftest-vehicles.json: { "parked": "<name prefix or IMEI>", "refuel": ..., "shortStop": ... }
// (vehicles with clean data); without it they are picked automatically.
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_DATA_DIR, loadObjects, loadHistory, rowToSample, runVehicle, fmtLocal, shortName, hasFuelSensor,
} from './lib.mjs';

const dir = process.argv[2] || DEFAULT_DATA_DIR;
const objects = loadObjects(dir);
const MIN = 60_000;
const HOUR = 3_600_000;
let failed = 0;

function check(name, ok, info) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  -- ${info}` : ''}`);
}

let roles = {};
try { roles = JSON.parse(fs.readFileSync(path.join(dir, 'selftest-vehicles.json'), 'utf8')); } catch { /* pick automatically */ }
const samplesOf = (o) => loadHistory(dir, o.imei).map(rowToSample);
/** The vehicle for a test: named in selftest-vehicles.json, else the first with a fuel sensor
 *  whose history has the stop the test needs and no fuel drain of its own. */
function vehicleFor(role, minStop, maxStop = Infinity) {
  const want = roles[role];
  if (want) return objects.find((o) => (o.imei === want || shortName(o.name).startsWith(want)) && hasFuelSensor(o));
  return objects.find((o) => {
    if (!hasFuelSensor(o) || !(loadHistory(dir, o.imei)?.length > 100)) return false;
    const s = samplesOf(o);
    return findStop(s, minStop, maxStop) && fuelAlerts(runVehicle(o, s), 'fuel_drain').length === 0;
  });
}
const clone = (xs) => xs.map((x) => ({ ...x }));
const fuelAlerts = (res, type) => res.alerts.filter((a) => a.type === type);
const describe = (a) => a ? `${a.type} ${a.amountMv ?? ''} mV, from ${fmtLocal(a.fromT)} detected ${fmtLocal(a.t)}: ${a.detail}` : 'none';

// Stationary, powered run with valid fuel readings lasting at least `minMs`.
function findStop(samples, minMs, maxMs = Infinity) {
  let start = null;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const still = s.spd < 3 && (s.pwr == null || s.pwr >= 5000) && s.f >= 100;
    if (still && start == null) start = i;
    if (!still || i === samples.length - 1) {
      if (start != null) {
        const end = still ? i : i - 1;
        const dur = samples[end].t - samples[start].t;
        if (dur >= minMs && dur <= maxMs && end - start >= 8) return { start, end, t0: samples[start].t, t1: samples[end].t };
      }
      start = null;
    }
  }
  return null;
}

// Shift fuel readings from time `from` on by `delta`, ramping in over `rampMs`.
function injectStep(samples, from, delta, rampMs) {
  for (const s of samples) {
    if (s.t < from || s.f == null || s.f < 100) continue;
    const k = Math.min(1, (s.t - from) / rampMs);
    s.f = Math.round(s.f + delta * k);
  }
}

// ---- 1. baseline vs. 800 mV drain injected into a long parked stop ----------------------
{
  const o = vehicleFor('parked', 8 * HOUR);
  const base = samplesOf(o);
  const stop = findStop(base, 6 * HOUR);
  const t = stop.t0 + 2 * HOUR;
  const mod = clone(base);
  injectStep(mod, t, -800, 10 * MIN);
  const before = fuelAlerts(runVehicle(o, base), 'fuel_drain');
  const res = runVehicle(o, mod);
  const drains = fuelAlerts(res, 'fuel_drain');
  const a = drains.find((x) => x.t >= t && x.t <= t + 30 * MIN);
  check(`800 mV drain in parked stop (${shortName(o.name)}, ${fmtLocal(t)})`,
    before.length === 0 && drains.length === 1 && a && Math.abs(a.amountMv - 800) <= 100 && Math.abs(a.fromT - t) <= 5 * MIN,
    describe(a));
}

// ---- 2. 300/250 mV drops: threshold boundary ------------------------------------------
{
  const o = vehicleFor('parked', 8 * HOUR);
  const base = samplesOf(o);
  const stop = findStop(base, 6 * HOUR);
  const t = stop.t0 + 2 * HOUR;
  const m1 = clone(base); injectStep(m1, t, -350, 10 * MIN);
  const m2 = clone(base); injectStep(m2, t, -200, 10 * MIN);
  const d1 = fuelAlerts(runVehicle(o, m1), 'fuel_drain');
  const d2 = fuelAlerts(runVehicle(o, m2), 'fuel_drain');
  check('350 mV drain caught (threshold 300)', d1.length === 1, describe(d1[0]));
  check('200 mV drop ignored (below threshold)', d2.length === 0, describe(d2[0]));
}

// ---- 3. refuel injected into a parked stop ----------------------------------------------
{
  const o = vehicleFor('refuel', 3 * HOUR);
  const base = samplesOf(o);
  const stop = findStop(base, 3 * HOUR);
  const t = stop.t0 + HOUR;
  const mod = clone(base);
  injectStep(mod, t, +2500, 4 * MIN);
  const before = fuelAlerts(runVehicle(o, base), 'refuel').length;
  const res = runVehicle(o, mod);
  const refuels = fuelAlerts(res, 'refuel');
  const a = refuels.find((x) => x.t >= t && x.t <= t + 30 * MIN);
  const drains = fuelAlerts(res, 'fuel_drain');
  check(`2500 mV refuel in parked stop (${shortName(o.name)}, ${fmtLocal(t)})`,
    a && Math.abs(a.amountMv - 2500) <= 150 && refuels.length === before + 1 && drains.length === 0, describe(a));
}

// ---- 4. master switch off for 3 h, level 700 mV lower when power returns ---------------
{
  const o = vehicleFor('parked', 8 * HOUR);
  const base = samplesOf(o);
  const stop = findStop(base, 8 * HOUR);
  const off0 = stop.t0 + 2 * HOUR;
  const off1 = off0 + 3 * HOUR;
  const make = (delta) => {
    const mod = clone(base);
    for (const s of mod) {
      if (s.t >= off0 && s.t < off1) { s.pwr = 0; s.f = s.t % 2 ? 43 : 87; s.ign = 0; }
    }
    if (delta) injectStep(mod, off1, delta, 1);
    return mod;
  };
  const resTheft = runVehicle(o, make(-700));
  const d = fuelAlerts(resTheft, 'fuel_drain');
  const a = d.find((x) => x.t >= off1 && x.t <= off1 + 30 * MIN);
  check('master switch off/on with 700 mV less fuel -> drain',
    d.length === 1 && a && /master switch/.test(a.detail) && Math.abs(a.amountMv - 700) <= 100, describe(a));
  const resClean = runVehicle(o, make(0));
  const bad = resClean.alerts.filter((x) => ['fuel_drain', 'sensor_lost', 'power_cut'].includes(x.type));
  check('master switch off/on with unchanged fuel -> no alert', bad.length === 0, bad.map(describe).join(' | '));
}

// ---- 5. quick theft in a short stop, right before driving off -------------------------
{
  const o = vehicleFor('shortStop', 12 * MIN, 25 * MIN);
  const base = samplesOf(o);
  const stop = findStop(base, 12 * MIN, 25 * MIN);
  const t = stop.t0 + 5 * MIN;
  const mod = clone(base);
  // remove 600 mV over 3 minutes, then the level stays low until the vehicle leaves
  injectStep(mod, t, -600, 3 * MIN);
  const d = fuelAlerts(runVehicle(o, mod), 'fuel_drain').filter((x) => x.t >= t && x.t <= stop.t1 + 5 * MIN);
  check(`600 mV theft in a ${Math.round((stop.t1 - stop.t0) / MIN)} min stop (${shortName(o.name)}, ${fmtLocal(t)})`,
    d.length === 1, describe(d[0]));
}

// ---- 6. purely synthetic streams -------------------------------------------------------
function synth(segments, start = Date.UTC(2026, 8, 20, 0, 0, 0)) {
  // segments: [{ minutes, every (s), spd, f (number | fn(i)), ign, pwr }]
  const out = [];
  let t = start;
  for (const seg of segments) {
    const n = Math.round((seg.minutes * 60) / seg.every);
    for (let i = 0; i < n; i++) {
      const f = typeof seg.f === 'function' ? seg.f(i, n) : seg.f;
      out.push({ t, f, spd: seg.spd ?? 0, ign: seg.ign ?? 0, pwr: seg.pwr ?? 25500, lat: 47.9 + (seg.spd ? i * 1e-4 : 0), lng: 106.9 });
      t += seg.every * 1000;
    }
  }
  return out;
}
const fake = { imei: 'TEST', name: 'TEST/Түлшний мэдрэгчтэй/', params: { io9: '1' } };
{
  // parked 2 h, sensor cut for 40 min (flickering), then working again for 1 h
  let k = 0;
  const flicker = (i) => ((i * 7) % 11 === 0 ? 3000 + (k++ % 5) * 400 : 43);
  const res = runVehicle(fake, synth([
    { minutes: 120, every: 60, f: 6000 },
    { minutes: 40, every: 30, f: flicker, ign: 1, pwr: 27500 },
    { minutes: 60, every: 60, f: 6000 },
  ]));
  const lost = fuelAlerts(res, 'sensor_lost');
  const restored = fuelAlerts(res, 'sensor_restored');
  check('flickering cut sensor -> exactly one sensor_lost + one restored', lost.length === 1 && restored.length === 1,
    `${describe(lost[0])} / ${describe(restored[0])}`);
}
{
  // a sensor that never worked (reads 43 all along) -> no alerts, state says no signal
  const res = runVehicle(fake, synth([{ minutes: 600, every: 60, f: 43, ign: 0, pwr: 25500 }]));
  check('dead-from-start sensor -> no alert, sensorOk=false', res.alerts.length === 0 && res.det.getState().sensorOk === false,
    res.alerts.map(describe).join(' | '));
}
{
  // driving normally, then external power lost at 60 km/h for 10 min
  const res = runVehicle(fake, synth([
    { minutes: 30, every: 10, spd: 60, f: 5000, ign: 1, pwr: 27800 },
    { minutes: 10, every: 10, spd: 60, f: 5000, ign: 0, pwr: 0 },
    { minutes: 10, every: 10, spd: 60, f: 5000, ign: 1, pwr: 27800 },
  ]));
  check('power cut while driving -> power_cut + power_restored',
    fuelAlerts(res, 'power_cut').length === 1 && fuelAlerts(res, 'power_restored').length === 1,
    describe(fuelAlerts(res, 'power_cut')[0]));
}
{
  // parking with the master switch while still rolling at 6 km/h is normal
  const res = runVehicle(fake, synth([
    { minutes: 10, every: 10, spd: 40, f: 5000, ign: 1, pwr: 27800 },
    { minutes: 1, every: 10, spd: 6, f: 5000, ign: 0, pwr: 0 },
    { minutes: 120, every: 60, spd: 0, f: 40, ign: 0, pwr: 0 },
  ]));
  check('master switch while rolling slowly -> no power_cut', fuelAlerts(res, 'power_cut').length === 0);
}
{
  // sloshing drive (true level 5400, readings 5300..9000) between two steady stops
  let x = 7;
  const slosh = () => { x = (x * 1103515245 + 12345) % 2 ** 31; return 5300 + (x % 3700); };
  const res = runVehicle(fake, synth([
    { minutes: 60, every: 60, f: 5600 },
    { minutes: 120, every: 10, spd: 45, f: slosh, ign: 1, pwr: 27800 },
    { minutes: 60, every: 60, f: 5400 },
  ]));
  const bad = res.alerts.filter((a) => ['fuel_drain', 'refuel'].includes(a.type));
  check('heavy slosh while driving -> no drain/refuel', bad.length === 0, bad.map(describe).join(' | '));
}
{
  // engine idling 45 min, then overspeed 100 km/h for 2 min
  const res = runVehicle(fake, synth([
    { minutes: 45, every: 30, f: 5000, ign: 1, pwr: 27800 },
    { minutes: 10, every: 10, spd: 60, f: 5000, ign: 1, pwr: 27800 },
    { minutes: 2, every: 10, spd: 100, f: 5000, ign: 1, pwr: 27800 },
    { minutes: 10, every: 10, spd: 60, f: 5000, ign: 1, pwr: 27800 },
  ]));
  check('45 min idle -> long_idle; 2 min at 100 km/h -> one overspeed',
    fuelAlerts(res, 'long_idle').length === 1 && fuelAlerts(res, 'overspeed').length === 1);
}
{
  // ignition wire stuck at 1 but the engine is off (battery voltage) -> not idling
  const res = runVehicle(fake, synth([
    { minutes: 20, every: 10, spd: 50, f: 5000, ign: 1, pwr: 27800 },
    { minutes: 180, every: 60, f: 5000, ign: 1, pwr: 25200 },
  ]));
  check('ign=1 at battery voltage -> no long_idle', fuelAlerts(res, 'long_idle').length === 0);
}

{
  // Master switch cut within a minute of stopping and driving off two minutes after power
  // returns (the usual pattern here): brief levels on both sides of an 8 h outage.
  // (driving readings occasionally slosh 1000 mV high, so the parked level isn't the ceiling)
  const drive = (f) => ({ minutes: 20, every: 10, spd: 50, f: (i) => (i % 7 ? f : f + 1000), ign: 1, pwr: 27800 });
  const scenario = (after) => synth([
    drive(6000),
    { minutes: 1, every: 10, f: 6000, ign: 1, pwr: 27800 }, // stopped, engine on
    { minutes: 480, every: 600, f: 40, ign: 0, pwr: 0 }, // master switch off
    { minutes: 2, every: 10, f: after, ign: 1, pwr: 27800 }, // power back, warming up
    drive(after),
  ]);
  const theft = runVehicle(fake, scenario(5000));
  const d = fuelAlerts(theft, 'fuel_drain');
  check('master switch, brief levels both sides, 1000 mV less -> drain', d.length === 1 && /power/.test(d[0].detail), describe(d[0]));
  const clean = runVehicle(fake, scenario(6000));
  check('master switch, brief levels both sides, unchanged -> nothing',
    clean.alerts.filter((a) => ['fuel_drain', 'refuel', 'sensor_lost', 'power_cut'].includes(a.type)).length === 0);
  const small = runVehicle(fake, scenario(5550));
  check('master switch, brief levels, 450 mV less (below 600 brief margin) -> nothing', fuelAlerts(small, 'fuel_drain').length === 0);
}
{
  // Power cut the moment it stops and driven off the moment it returns: only the drive-in
  // and drive-out estimates are available (a drop must hold in two consecutive 10-min
  // driving windows, so the drive after the stop lasts 40 min).
  const scenario = (after) => synth([
    { minutes: 20, every: 10, spd: 50, f: 7000, ign: 1, pwr: 27800 },
    { minutes: 600, every: 600, f: 40, ign: 0, pwr: 0 },
    { minutes: 40, every: 10, spd: 50, f: after, ign: 1, pwr: 27800 },
  ]);
  const theft = runVehicle(fake, scenario(5000));
  const d = fuelAlerts(theft, 'fuel_drain');
  check('master switch, rough drive-in/out only, 2000 mV less -> drain', d.length === 1, describe(d[0]));
  const clean = runVehicle(fake, scenario(6900));
  check('master switch, rough drive-in/out only, normal burn -> nothing', fuelAlerts(clean, 'fuel_drain').length === 0);
  const refuel = runVehicle(fake, scenario(9000));
  check('master switch, rough drive-in/out only, +2000 mV -> refuel', fuelAlerts(refuel, 'refuel').length === 1, describe(fuelAlerts(refuel, 'refuel')[0]));
}
{
  // hourly reporting while parked (common here): a 900 mV drop between reports
  const res = runVehicle(fake, synth([
    { minutes: 600, every: 3600, f: 6000 },
    { minutes: 600, every: 3600, f: 5100 },
  ]));
  const d = fuelAlerts(res, 'fuel_drain');
  check('hourly reports while parked, 900 mV drop -> drain', d.length === 1, describe(d[0]));
}

{
  // after-hours driving (UB local 23:00 = 15:00 UTC), only when enabled; once per night
  const night = Date.UTC(2026, 8, 20, 15, 0, 0);
  const stream = synth([
    { minutes: 30, every: 10, spd: 50, f: 5000, ign: 1, pwr: 27800 },
    { minutes: 30, every: 60, f: 5000 },
    { minutes: 30, every: 10, spd: 50, f: 5000, ign: 1, pwr: 27800 },
  ], night);
  const off = runVehicle(fake, stream);
  const on = runVehicle(fake, stream, { th: { afterHoursEnabled: true } });
  check('after-hours: disabled -> none; enabled -> exactly one per night',
    fuelAlerts(off, 'after_hours').length === 0 && fuelAlerts(on, 'after_hours').length === 1, describe(fuelAlerts(on, 'after_hours')[0]));
}
{
  // low fuel: 15% -> 8% while parked (one alert), stays low (no repeat), refuel clears it
  const res = runVehicle(fake, synth([
    { minutes: 60, every: 60, f: 1500 },
    { minutes: 30, every: 10, spd: 40, f: 1200, ign: 1, pwr: 27800 },
    { minutes: 60, every: 60, f: 800 },
    { minutes: 30, every: 10, spd: 40, f: 750, ign: 1, pwr: 27800 },
    { minutes: 60, every: 60, f: 700 },
  ]));
  check('low fuel: one alert on crossing 10%, no repeats', fuelAlerts(res, 'low_fuel').length === 1, describe(fuelAlerts(res, 'low_fuel')[0]));
}

// ---- 7. restart: replay the last 12 h into a fresh detector -----------------------------
{
  let extra = 0;
  let replayExtra = 0; // alerts the silent replay itself would add (stored as historical)
  let total = 0;
  for (const o of objects) {
    if (!hasFuelSensor(o)) continue;
    const rows = loadHistory(dir, o.imei);
    if (!rows || rows.length < 100) continue;
    const samples = rows.map(rowToSample);
    const full = runVehicle(o, samples);
    const keys = new Set(full.alerts.map((a) => a.key));
    total += keys.size;
    for (const cutH of [20, 30, 40]) {
      const cut = samples[0].t + cutH * HOUR;
      const replay = samples.filter((s) => s.t >= cut - 12 * HOUR);
      const res = runVehicle(o, replay);
      for (const a of res.alerts) {
        if (keys.has(a.key) || !['fuel_drain', 'refuel', 'sensor_lost', 'low_fuel', 'power_cut'].includes(a.type)) continue;
        if (a.t >= cut) extra++; else replayExtra++;
        console.log(`      restart@${cutH}h ${a.t >= cut ? 'LIVE' : 'replay'} new key ${shortName(o.name)} ${describe(a)}`);
      }
    }
  }
  check('restart replay (3 cut points x all vehicles) adds no new fuel/power alerts', extra === 0, `${extra} extra live, ${replayExtra} extra historical during replay, ${total} alerts in full run`);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
