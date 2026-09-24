// Replays cached OBJECT_GET_MESSAGES history through the detector and reports what it finds.
//
//   node --no-warnings tools/replay.mjs [dataDir] [options]
//
//   dataDir                 folder with objects.json and hist/<imei>.json
//                           (default: testdata/, not published; fill it with tools/fetch-history.mjs)
//   --vehicle <imei>        only this vehicle
//   --refuels               also list refuel alerts
//   --all                   list every alert
//   --state                 print each vehicle's final detector state
//   --around <imei> "<YYYY-MM-DD HH:MM>" [minutes=60]
//                           dump the raw series around a (UB local) time, with alerts and
//                           trusted levels marked, to judge an alert by eye
//   --th key=value          override a threshold (repeatable), e.g. --th drainParkedMv=400
//
// Times are printed in Asia/Ulaanbaatar local time (UTC+8).
import { ALERT_TYPES } from '../src/detector.js';
import {
  DEFAULT_DATA_DIR, loadObjects, loadHistory, rowToSample, runVehicle, fmtLocal, parseLocal, shortName, hasFuelSensor,
} from './lib.mjs';

const args = process.argv.slice(2);
const opt = { dir: DEFAULT_DATA_DIR, th: {} };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--vehicle') opt.vehicle = args[++i];
  else if (a === '--refuels') opt.refuels = true;
  else if (a === '--all') opt.all = true;
  else if (a === '--state') opt.state = true;
  else if (a === '--th') { const [k, v] = args[++i].split('='); opt.th[k] = v === 'true' ? true : v === 'false' ? false : isNaN(+v) ? v : +v; }
  else if (a === '--around') {
    opt.around = { imei: args[++i], t: parseLocal(args[++i]) };
    if (args[i + 1] && /^\d+$/.test(args[i + 1])) opt.around.minutes = +args[++i];
  } else if (!a.startsWith('--')) opt.dir = a;
  else { console.error(`unknown option ${a}`); process.exit(2); }
}

const objects = loadObjects(opt.dir);
const FUEL_TYPES = new Set(['fuel_drain', 'refuel', 'sensor_lost', 'sensor_restored', 'low_fuel']);

let all = [];
let nVehicles = 0;
let nSamples = 0;
const states = [];
for (const o of objects) {
  if (opt.vehicle && o.imei !== opt.vehicle) continue;
  if (opt.around && o.imei !== opt.around.imei) continue;
  const rows = loadHistory(opt.dir, o.imei);
  if (!rows) continue;
  const samples = rows.map(rowToSample);
  nVehicles++;
  nSamples += samples.length;
  const res = runVehicle(o, samples, { th: opt.th });
  all.push(...res.alerts.map((a) => ({ ...a, short: shortName(o.name) })));
  states.push({ o, st: res.det.getState(), n: samples.length });
  if (opt.around) dumpAround(o, samples, res);
}

if (opt.around) process.exit(0);

console.log(`Replayed ${nVehicles} vehicles, ${nSamples} samples from ${opt.dir}\n`);
const counts = {};
for (const t of Object.keys(ALERT_TYPES)) counts[t] = 0;
for (const a of all) counts[a.type] = (counts[a.type] || 0) + 1;
console.log('Alert counts:');
for (const [t, n] of Object.entries(counts)) console.log(`  ${t.padEnd(16)} ${String(n).padStart(4)}   (${ALERT_TYPES[t]?.severity ?? '?'})`);

all.sort((a, b) => a.t - b.t);
const line = (a) => `  ${a.short.padEnd(9)} ${a.imei}  ${fmtLocal(a.fromT)} → ${fmtLocal(a.t)}  ${a.type.padEnd(15)} ` +
  `${a.amountMv != null ? String(a.amountMv).padStart(5) + ' mV ' : '          '}${a.ongoing ? '[ongoing] ' : ''}${a.detail}`;

console.log('\nFuel-related critical/warning alerts (UB local time):');
for (const a of all.filter((a) => (FUEL_TYPES.has(a.type) || a.type === 'power_cut') && a.severity !== 'info')) console.log(line(a));
if (opt.refuels) {
  console.log('\nRefuels:');
  for (const a of all.filter((a) => a.type === 'refuel')) console.log(line(a));
}
if (opt.all) {
  console.log('\nAll alerts:');
  for (const a of all) console.log(line(a));
}
if (opt.state) {
  console.log('\nFinal detector state:');
  for (const { o, st, n } of states) {
    if (!hasFuelSensor(o)) continue;
    console.log(`  ${shortName(o.name).padEnd(9)} ${o.imei} n=${String(n).padStart(5)} level=${String(st.level ?? '-').padStart(5)} at ${fmtLocal(st.levelT)} sensorOk=${st.sensorOk} stopped=${st.stopped} rate=${st.consumptionMvPerHour}`);
  }
}

function dumpAround(o, samples, res) {
  const minutes = opt.around.minutes ?? 60;
  const from = opt.around.t - minutes * 60_000;
  const to = opt.around.t + minutes * 60_000;
  console.log(`${shortName(o.name)} ${o.imei}  ${fmtLocal(from)} .. ${fmtLocal(to)} (UB local)`);
  console.log('  time         gap_s  spd     f  ign   pwr   trusted  events');
  const levels = new Map(res.levels.map(([t, mv]) => [t, mv]));
  let prevT = null;
  for (const s of samples) {
    if (s.t < from || s.t > to) { prevT = s.t; continue; }
    const marks = [];
    for (const a of res.alerts) {
      if (a.t === s.t) marks.push(`<< ${a.type} detected${a.amountMv != null ? ` ${a.amountMv} mV` : ''}`);
      if (a.fromT === s.t && a.fromT !== a.t) marks.push(`>> ${a.type} starts`);
    }
    const lv = levels.has(s.t) ? String(levels.get(s.t)).padStart(6) : '      ';
    const gap = prevT == null ? '' : Math.round((s.t - prevT) / 1000);
    console.log(`  ${new Date(s.t + 8 * 3_600_000).toISOString().slice(5, 19).replace('T', ' ')} ${String(gap).padStart(6)} ${String(s.spd).padStart(4)} ${String(s.f ?? '-').padStart(5)}  ${s.ign ?? '-'}  ${String(s.pwr ?? '-').padStart(6)}  ${lv}  ${marks.join('; ')}`);
    prevT = s.t;
  }
  console.log('\nAlerts for this vehicle:');
  for (const a of res.alerts) console.log(`  ${fmtLocal(a.fromT)} → ${fmtLocal(a.t)} ${a.type} ${a.amountMv ?? ''} ${a.detail}`);
}
