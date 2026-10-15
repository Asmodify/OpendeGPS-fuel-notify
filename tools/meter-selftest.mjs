// Self-test for the fuel-meter check of theft alerts (src/meter.js): synthetic raw readings
// around drains and receipts, and the verdict the evidence pack shows for each; and the probe
// check behind the fleet screen's fuel meter state. Nothing is fetched or stored.
//
//   node --no-warnings tools/meter-selftest.mjs
import { meterCheck, CONFIRMS, probeFault } from '../src/meter.js';

let failed = 0;
let passed = 0;
function check(name, ok, info) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info !== undefined ? `  -- ${typeof info === 'string' ? info : JSON.stringify(info)}` : ''}`);
}

const MIN = 60e3;
const HOUR = 60 * MIN;
const T = Date.UTC(2026, 9, 10, 4, 0);
const cal = { tankLiters: 500, table: [[0, 0], [10000, 500]] }; // 20 mV a litre
const mv = (l) => l * 20;
const th = { sensorMinValidMv: 100, powerCutMv: 5000 };

/** Readings every `step` from `start`: each segment {min, from, to (litres), spd} runs for `min` minutes.
 *  Driving readings slosh by up to ±5 L around the line. */
function series(start, segs, step = 2 * MIN) {
  const rows = [];
  let t = start;
  let i = 0;
  for (const s of segs) {
    const n = Math.max(1, Math.round((s.min * MIN) / step));
    for (let k = 0; k < n; k++, i++, t += step) {
      const l = s.from + ((s.to ?? s.from) - s.from) * (k / n);
      const slosh = s.spd ? (((i * 37) % 11) - 5) : 0;
      rows.push({ t, f: s.mv ?? mv(l + slosh), spd: s.spd ?? 0, pwr: s.pwr ?? 27000 });
    }
  }
  return rows;
}
const at = (rows, i) => rows[i].t;

// 1. parked: 300 L, 80 L go in 40 min, 220 L after
{
  const rows = series(T - 7 * HOUR, [{ min: 420, from: 300 }, { min: 40, from: 300, to: 220 }, { min: 420, from: 220 }]);
  const m = meterCheck({ kind: 'parked', rows, t0: T, t: T + 40 * MIN, amountL: 80, cal, th });
  check('parked drop -> drop, the meter\'s litres', m.verdict === 'drop' && m.lost === 80 && m.before.v === 300 && m.after.v === 220, m);
  check('drop confirms', CONFIRMS.has(m.verdict));
  const big = meterCheck({ kind: 'parked', rows, t0: T, t: T + 40 * MIN, amountL: 50, cal, th });
  check('never more than the alert says', big.verdict === 'drop' && big.lost === 50, big);
}
// 2. a "drain" where the meter went up: a refuel, not theft
{
  const rows = series(T - 7 * HOUR, [{ min: 420, from: 300 }, { min: 20, from: 300, to: 450 }, { min: 420, from: 450 }]);
  const m = meterCheck({ kind: 'parked', rows, t0: T, t: T + 20 * MIN, amountL: 60, cal, th });
  check('meter went up -> refuel', m.verdict === 'refuel' && !CONFIRMS.has(m.verdict) && m.lost === undefined, m);
}
// 3. a dip that came back
{
  const rows = series(T - 7 * HOUR, [{ min: 420, from: 300 }, { min: 20, from: 300, to: 250 }, { min: 20, from: 250, to: 300 }, { min: 400, from: 300 }]);
  const m = meterCheck({ kind: 'parked', rows, t0: T, t: T + 40 * MIN, amountL: 50, cal, th });
  check('dip and back -> recovered', m.verdict === 'recovered' && !CONFIRMS.has(m.verdict), m);
}
// 4. a probe stuck at its 10 V limit
{
  const rows = series(T - 7 * HOUR, [{ min: 420, from: 0, mv: 10000 }, { min: 40, from: 300, to: 220 }, { min: 420, from: 220 }]);
  const m = meterCheck({ kind: 'parked', rows, t0: T - 10 * MIN, t: T + 40 * MIN, amountL: 300, cal, th });
  check('reading at 10 V -> sensor', m.verdict === 'sensor', m);
}
// 5. a trip that used 100 L more than it should have
{
  const rows = series(T - 7 * HOUR, [{ min: 400, from: 400 }, { min: 120, from: 400, to: 250, spd: 60 }, { min: 400, from: 250 }]);
  // the detector's trip runs from the last level of one stop to the first level of the next
  const t0 = T - 22 * MIN;
  const t = T + 104 * MIN;
  const m = meterCheck({ kind: 'trip', rows, t0, t, amountL: 100, fromMv: mv(400), toMv: mv(250), cal, th });
  check('trip excess -> drop of the excess', m.verdict === 'drop' && Math.abs(m.lost - 100) < 1 && Math.abs(m.used - 50) < 1, m);
  const refuel = series(T - 7 * HOUR, [{ min: 400, from: 300 }, { min: 120, from: 300, to: 260, spd: 60 }, { min: 10, from: 260, to: 460 }, { min: 400, from: 460 }]);
  const r = meterCheck({ kind: 'trip', rows: refuel, t0, t: T + 114 * MIN, amountL: 80, fromMv: mv(300), toMv: mv(160), cal, th });
  check('trip ending fuller -> refuel', r.verdict === 'refuel', r);
}
// 6. the probe dies: 300 L "falls" to 12 L, then reads 12 L flat while the truck drives
{
  const rows = series(T - 7 * HOUR, [{ min: 420, from: 300 }, { min: 10, from: 300, to: 12 }, { min: 30, from: 12 }, { min: 300, from: 12, mv: mv(12), spd: 60 }, { min: 120, from: 12 }]);
  const m = meterCheck({ kind: 'parked', rows, t0: T, t: T + 10 * MIN, amountL: 288, cal, th });
  check('dead probe after the "drop" -> sensor', m.verdict === 'sensor' && m.note === 'stuck', m);
}
// 6b. the probe dies at night: parked 8 h at the "empty" reading, then a day's driving with it flat
{
  const rows = series(T - 7 * HOUR, [{ min: 420, from: 400 }, { min: 10, from: 400, to: 12 }, { min: 480, from: 12 }, { min: 180, from: 12, mv: mv(12), spd: 60 }, { min: 120, from: 12 }]);
  const m = meterCheck({ kind: 'parked', rows, t0: T, t: T + 10 * MIN, amountL: 388, cal, th });
  check('dead by the next day\'s drive -> sensor', m.verdict === 'sensor' && m.note === 'stuck', m);
}
// 6c. a live probe creeping in a loading queue for 40 min reads flat: not a dead probe
{
  const rows = series(T - 7 * HOUR, [{ min: 420, from: 300 }, { min: 40, from: 300, to: 220 }, { min: 60, from: 220 }, { min: 40, from: 220, to: 218, spd: 5 }, { min: 300, from: 218 }]);
  const m = meterCheck({ kind: 'parked', rows, t0: T, t: T + 40 * MIN, amountL: 80, cal, th });
  check('queue creeping is not a stuck probe', m.verdict === 'drop' && m.lost === 80, m);
}
// 7. few readings (trackers asleep while parked): one before, one after
{
  const rows = [
    { t: T - 3 * HOUR, f: mv(300), spd: 0, pwr: 27000 },
    { t: T - 1 * HOUR, f: mv(300), spd: 0, pwr: 27000 },
    { t: T + 2 * HOUR, f: mv(200), spd: 0, pwr: 27000 },
    { t: T + 4 * HOUR, f: mv(200), spd: 0, pwr: 27000 },
  ];
  const m = meterCheck({ kind: 'parked', rows, t0: T, t: T + HOUR, amountL: 100, cal, th });
  check('sparse readings still show the drop', m.verdict === 'drop' && m.lost === 100, m);
  const none = meterCheck({ kind: 'parked', rows: rows.slice(0, 1), t0: T, t: T + HOUR, amountL: 100, cal, th });
  check('one reading -> nodata', none.verdict === 'nodata', none);
}
// 8. receipts: a full fill, a short fill, no fill at all, a dead probe
{
  const fill = (inL) => series(T - 7 * HOUR, [{ min: 400, from: 100, to: 90, spd: 0 }, { min: 20, from: 90, to: 90 + inL }, { min: 400, from: 90 + inL }]);
  const t0 = T - 20 * MIN;
  const full = meterCheck({ kind: 'receipt', rows: fill(380), t0, t: T, receiptL: 400, missingL: 20, refuelSeen: true, cal, th });
  check('receipt 400 L, 380 L went in -> full', full.verdict === 'full' && Math.abs(full.wentIn - 380) < 2, full);
  check('full: before / after are the bottom and top of the fill', Math.abs(full.before.v - 90) < 2 && Math.abs(full.after.v - 470) < 2, { before: full.before, after: full.after });
  const short = meterCheck({ kind: 'receipt', rows: fill(280), t0, t: T, receiptL: 400, missingL: 110, refuelSeen: true, cal, th });
  check('receipt 400 L, 280 L went in -> short, the smaller missing figure', short.verdict === 'short' && short.lost === 110, short);
  const within = meterCheck({ kind: 'receipt', rows: fill(350), t0, t: T, receiptL: 400, missingL: 50, refuelSeen: true, cal, th });
  check('50 L of 400 L missing is within tank-table error -> full', within.verdict === 'full', within);
  const day = Date.UTC(2026, 9, 9, 16, 0); // 00:00 local
  const none = series(day - 7 * HOUR, [{ min: 600, from: 300 }, { min: 600, from: 300, to: 120, spd: 60 }, { min: 900, from: 120 }]);
  const nf = meterCheck({ kind: 'receipt', rows: none, t0: day, t: day, receiptL: 300, dayOnly: true, cal, th });
  check('no rise on the receipt\'s day -> norefuel', nf.verdict === 'norefuel' && nf.lost === 300, nf);
  const dead = series(day - 7 * HOUR, [{ min: 600, from: 15 }, { min: 600, from: 15, mv: mv(15), spd: 60 }, { min: 900, from: 15 }]);
  const d = meterCheck({ kind: 'receipt', rows: dead, t0: day, t: day, receiptL: 300, dayOnly: true, cal, th });
  check('flat probe while driving -> sensor, not norefuel', d.verdict === 'sensor' && d.note === 'stuck', d);
  // a dead probe that jitters while driving but reads the same 15 L at every stop
  const jitter = series(day - 7 * HOUR, [{ min: 300, from: 15 }, { min: 300, from: 15, spd: 60 }, { min: 300, from: 15 }, { min: 300, from: 15, spd: 60 }, { min: 300, from: 15 }]);
  const j = meterCheck({ kind: 'receipt', rows: jitter, t0: day, t: day, receiptL: 300, dayOnly: true, cal, th });
  check('same level at every stop across drives -> sensor', j.verdict === 'sensor' && j.note === 'stuck', j);
  const noTable = meterCheck({ kind: 'receipt', rows: dead, t0: day, t: day, receiptL: 300, dayOnly: true, cal: null, th });
  check('receipt without a tank table -> nodata', noTable.verdict === 'nodata', noTable);
}

// 9. the fleet screen's probe check over a day of readings
{
  const day = T - 24 * HOUR;
  const live = series(day, [{ min: 300, from: 400 }, { min: 240, from: 400, to: 280, spd: 60 }, { min: 300, from: 280 }, { min: 180, from: 280, to: 200, spd: 55 }, { min: 420, from: 200 }]);
  check('a live probe -> no fault', probeFault({ rows: live, cal, th }) === null, probeFault({ rows: live, cal, th }));
  const limit = series(day, [{ min: 600, from: 0, mv: 9990 }, { min: 240, from: 0, mv: 9995, spd: 60 }, { min: 600, from: 0, mv: 9990 }]);
  check('reads 10 V all day -> limit', probeFault({ rows: limit, cal, th })?.code === 'limit', probeFault({ rows: limit, cal, th }));
  const spike = series(day, [{ min: 600, from: 300 }, { min: 10, from: 0, mv: 9990 }, { min: 600, from: 300 }]);
  check('one short spike to 10 V -> no fault', probeFault({ rows: spike, cal, th }) === null, probeFault({ rows: spike, cal, th }));
  const dead = series(day, [{ min: 300, from: 120 }, { min: 240, from: 120, mv: mv(120), spd: 60 }, { min: 300, from: 120 }, { min: 180, from: 120, mv: mv(120), spd: 55 }, { min: 420, from: 120 }]);
  check('the same 120 L through 7 h of driving -> stuck', probeFault({ rows: dead, cal, th })?.code === 'stuck', probeFault({ rows: dead, cal, th }));
  const fullTank = series(day, [{ min: 300, from: 480 }, { min: 150, from: 480, mv: mv(480), spd: 60 }, { min: 300, from: 480 }]);
  check('a full tank holding the probe at the top while driving -> no fault', probeFault({ rows: fullTank, cal, th }) === null, probeFault({ rows: fullTank, cal, th }));
  const short = series(day, [{ min: 300, from: 120 }, { min: 70, from: 120, mv: mv(120), spd: 60 }, { min: 300, from: 120 }]);
  check('flat through only 70 min of driving -> not enough to call it stuck', probeFault({ rows: short, cal, th }) === null, probeFault({ rows: short, cal, th }));
  const small = { tankLiters: 300, table: cal.table }; // a table past the tank's size: the probe reads 400 L
  const over = series(day, [{ min: 600, from: 400 }]);
  check('standing at 400 L in a 300 L tank -> outside', probeFault({ rows: over, cal: small, th })?.code === 'outside', probeFault({ rows: over, cal: small, th }));
  check('too few readings -> no verdict', probeFault({ rows: live.slice(0, 10), cal, th }) === null);
}

console.log(`\n${failed ? 'FAILED' : 'OK'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
