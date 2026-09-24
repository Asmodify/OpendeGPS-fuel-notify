// Checks that VehicleDetector.snapshot() / VehicleDetector.restore() lose nothing: every
// vehicle's samples are fed once in one go and once in chunks, with the detector saved to JSON
// and rebuilt from it between chunks (as the cloud backend does every minute). Both runs must
// give identical alerts, alert updates, trusted levels and final state.
//
//   node --no-warnings tools/snapshot-test.mjs <dataDir> [--cal calibrations.json] [--vehicle <imei>]
//
//   dataDir  folder of <imei>.json files: { cols: [t, lat, lng, spd, f_mV, ign, pwr_mV, odo_m], rows: [[...], ...] }
//            (or set SNAPSHOT_DATA_DIR)
import fs from 'node:fs';
import path from 'node:path';
import { VehicleDetector, DEFAULT_THRESHOLDS } from '../src/detector.js';
import { loadCalibrations } from '../src/config.js';

const args = process.argv.slice(2);
let dir = process.env.SNAPSHOT_DATA_DIR || null;
let calFile = null;
let only = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--cal') calFile = args[++i];
  else if (args[i] === '--vehicle') only = args[++i];
  else dir = args[i];
}
if (!dir || !fs.existsSync(dir)) {
  console.error('usage: node tools/snapshot-test.mjs <dataDir> [--cal calibrations.json] [--vehicle <imei>]');
  process.exit(2);
}
const cals = calFile ? loadCalibrations(path.resolve(calFile)).vehicles : {};

// small deterministic PRNG, so a failure can be reproduced
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function toSample(r, idx) {
  const n = (x) => (x === null || x === undefined || x === '' || !Number.isFinite(+x) ? null : +x);
  return { t: n(r[idx.t]), lat: n(r[idx.lat]), lng: n(r[idx.lng]), spd: n(r[idx.spd]) ?? 0, f: n(r[idx.f_mV]), ign: n(r[idx.ign]), pwr: n(r[idx.pwr_mV]), odo: n(r[idx.odo_m]) };
}

/** Feeds `samples`; chunks = null -> one detector for everything, else chunk sizes to cut at. */
function run(vehicle, samples, settings, chunks) {
  const log = { alerts: [], updates: [], levels: [] };
  let nextId = 1;
  let snaps = 0;
  let maxBytes = 0;
  const cb = () => [
    (a) => {
      const id = nextId++;
      log.alerts.push({ id, ...a });
      return id;
    },
    (id, patch) => log.updates.push([id, patch]),
    (t, mv) => log.levels.push([t, mv]),
  ];
  const getSettings = () => settings;
  let det = new VehicleDetector({ ...vehicle }, getSettings, ...cb());
  let i = 0;
  const cuts = chunks ? [...chunks] : [samples.length];
  while (i < samples.length) {
    const n = Math.max(1, cuts.shift() ?? samples.length);
    for (const s of samples.slice(i, i + n)) det.push(s);
    i += n;
    if (chunks) {
      const json = JSON.stringify(det.snapshot());
      snaps++;
      maxBytes = Math.max(maxBytes, json.length);
      det = VehicleDetector.restore(JSON.parse(json), { ...vehicle }, getSettings, ...cb());
    }
  }
  return { log, state: det.getState(), snapshot: JSON.stringify(det.snapshot()), snaps, maxBytes };
}

const files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f) && (!only || f === `${only}.json`)).sort();
let failed = 0;
let totalSamples = 0;
let totalAlerts = 0;
let totalSnaps = 0;
let maxBytes = 0;
const t0 = Date.now();
for (const [k, f] of files.entries()) {
  const imei = f.replace(/\.json$/, '');
  const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const idx = Object.fromEntries(data.cols.map((c, j) => [c, j]));
  const samples = data.rows.map((r) => toSample(r, idx)).filter((s) => Number.isFinite(s.t)).sort((a, b) => a.t - b.t);
  const hasFuel = samples.some((s) => s.f !== null);
  const vehicle = { imei, name: `vehicle ${k + 1}`, hasFuel };
  const settings = { th: { ...DEFAULT_THRESHOLDS, tzOffsetMinutes: 480, afterHoursEnabled: true }, cal: cals[imei] ?? { emptyMv: 0, fullMv: 10000, tankLiters: null } };
  const rand = rng(k + 17);
  // mostly minute-sized chunks (a cloud tick), some large ones, and single samples
  const chunks = [];
  for (let n = 0; n < samples.length;) {
    const r = rand();
    const c = r < 0.3 ? 1 : r < 0.8 ? 1 + Math.floor(rand() * 30) : 1 + Math.floor(rand() * 800);
    chunks.push(c);
    n += c;
  }
  const a = run(vehicle, samples, settings, null);
  const b = run(vehicle, samples, settings, chunks);
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const problems = [];
  if (!same(a.log.alerts, b.log.alerts)) problems.push(`alerts differ (${a.log.alerts.length} vs ${b.log.alerts.length})`);
  if (!same(a.log.updates, b.log.updates)) problems.push(`updates differ (${a.log.updates.length} vs ${b.log.updates.length})`);
  if (!same(a.log.levels, b.log.levels)) problems.push(`levels differ (${a.log.levels.length} vs ${b.log.levels.length})`);
  if (!same(a.state, b.state)) problems.push('final getState() differs');
  if (a.snapshot !== b.snapshot) problems.push('final snapshot differs');
  totalSamples += samples.length;
  totalAlerts += a.log.alerts.length;
  totalSnaps += b.snaps;
  maxBytes = Math.max(maxBytes, b.maxBytes);
  const line = `${imei}  ${String(samples.length).padStart(6)} samples  ${String(a.log.alerts.length).padStart(3)} alerts  ${String(a.log.updates.length).padStart(4)} updates  ${String(a.log.levels.length).padStart(4)} levels  ${String(b.snaps).padStart(5)} snapshots (max ${(b.maxBytes / 1024).toFixed(1)} KB)`;
  if (problems.length) {
    failed++;
    console.log(`FAIL ${line}\n     ${problems.join('; ')}`);
  } else console.log(`ok   ${line}`);
}
console.log(`\n${files.length - failed}/${files.length} vehicles identical; ${totalSamples} samples, ${totalAlerts} alerts, ${totalSnaps} snapshot/restore round trips (largest ${(maxBytes / 1024).toFixed(1)} KB) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(failed || !files.length ? 1 : 0);
