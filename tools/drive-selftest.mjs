// Synthetic checks for the driving-without-rest rule (detector.js checkDriving):
//   node --no-warnings tools/drive-selftest.mjs
import { VehicleDetector } from '../src/detector.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
let failed = 0;
const check = (name, ok, info) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  -- ${info}` : ''}`);
};

/** Runs a script of [minutes, km/h, everyMinutes?] legs; returns alerts with their updates. */
function run(legs, th = {}) {
  const alerts = [];
  const det = new VehicleDetector(
    { imei: 'T1', name: 'TEST', hasFuel: false },
    () => ({ th }),
    (a) => { if (a.type.startsWith('drive_')) alerts.push({ ...a, at: a.driveMin, updates: [] }); return a.type.startsWith('drive_') ? alerts.length : -1; },
    (id, patch) => { if (id > 0) Object.assign(alerts[id - 1], patch); if (id > 0) alerts[id - 1].updates.push(patch); },
  );
  let t = Date.UTC(2026, 10, 4, 0, 0);
  let odo = 0;
  for (const [minutes, kmh, every = 1, opts = {}] of legs) {
    const end = t + minutes * MIN;
    if (opts.silent) {
      // tracker silent for the whole leg; one sample at its end
      odo += (opts.km ?? 0) * 1000;
      t = end;
      det.push({ t, spd: kmh, ign: 1, pwr: 27000, lat: 43.5, lng: 105.4, odo });
      continue;
    }
    while (t < end) {
      t += every * MIN;
      odo += (kmh * every * 1000) / 60;
      det.push({ t, spd: kmh, ign: 1, pwr: 27000, lat: 43.5, lng: 105.4, odo });
    }
  }
  return alerts;
}
const of = (alerts, type) => alerts.filter((a) => a.type === type);

{
  const a = run([[6 * 60 + 5, 60]]);
  const soon = of(a, 'drive_rest_soon');
  const over = of(a, 'drive_no_rest');
  check('6 h 05 non-stop: one early warning', soon.length === 1);
  check('6 h 05 non-stop: one limit alert, still open', over.length === 1 && over[0].ongoing === true);
  check('6 h 05 non-stop: early warning closed when the limit is reached', soon[0]?.ongoing === false);
  check('6 h 05 non-stop: two reminders (5 h 30, 6 h)', over[0]?.remind === 2, `remind ${over[0]?.remind}`);
  check('limit alert at 5 h of driving', over[0] && over[0].at === 300, `at ${over[0]?.at}`);
}
{
  const a = run([[4 * 60, 60], [50, 0], [4 * 60, 60]]);
  check('4 h + 50 min rest + 4 h: no alert', a.length === 0, a.map((x) => x.type).join(','));
}
{
  const a = run([[3 * 60, 60], [40, 0], [2 * 60 + 30, 60]]);
  check('3 h + 40 min stop + 2 h 30: short stop does not reset (limit reached)', of(a, 'drive_no_rest').length === 1);
}
{
  const a = run([[4 * 60 + 40, 60], [50, 0], [60, 60]]);
  const soon = of(a, 'drive_rest_soon');
  check('4 h 40 + rest: early warning only, closed with the rest time', soon.length === 1 && soon[0].ongoing === false && Number.isFinite(soon[0].restT) && of(a, 'drive_no_rest').length === 0);
}
{
  const a = run([[5 * 60 + 10, 60], [50, 0, 1]]);
  const over = of(a, 'drive_no_rest');
  check('limit then rest: limit alert closed, rest time set', over.length === 1 && over[0].ongoing === false && Number.isFinite(over[0].restT));
}
{
  // parked overnight, tracker in hourly reporting, odometer still: a rest
  const a = run([[4 * 60, 60], [8 * 60, 0, 60], [2 * 60, 60]]);
  check('4 h + parked overnight (hourly samples) + 2 h: no alert', a.length === 0, a.map((x) => x.type).join(','));
}
{
  // tracker silent 3 h while covering 150 km: driving, no rest
  const a = run([[3 * 60, 60], [3 * 60, 60, 1, { silent: true, km: 150 }], [10, 60]]);
  check('3 h + 3 h silent over 150 km: counted as driving', of(a, 'drive_no_rest').length === 1);
}
{
  // tracker silent 3 h but moved only 40 km: 48 min of driving, over 2 h standing = a rest
  const a = run([[4 * 60, 60], [3 * 60, 60, 1, { silent: true, km: 40 }], [3 * 60, 60]]);
  check('silence mostly spent standing still counts as a rest', of(a, 'drive_no_rest').length === 0, a.map((x) => x.type).join(','));
}
{
  // creeping queue: 1 min moving at 5 km/h every 10 min for 8 h -> 48 min of driving, no alert
  const legs = [];
  for (let i = 0; i < 48; i++) legs.push([1, 5], [9, 0]);
  const a = run([[4 * 60, 60], ...legs]);
  check('4 h + 8 h creeping queue: queue time is not driving', of(a, 'drive_no_rest').length === 0);
}
{
  const a = run([[6 * 60, 60]], { driveRestEnabled: false });
  check('rule switched off: no alerts', a.length === 0);
}
{
  const a = run([[6 * 60, 60]], { driveLimitMinutes: 240, driveWarnMinutes: 210 });
  check('limit setting is honoured (4 h)', of(a, 'drive_no_rest')[0]?.at === 240);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll driving-rest checks passed');
process.exit(failed ? 1 : 0);
