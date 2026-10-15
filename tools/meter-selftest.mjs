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
 *  Driving readings slosh by up to ±5 L around the line (`calm`: ±1 L, a damped sensor). The
 *  voltage says the engine runs while moving (27.5 V) and rests while standing (25.5 V). */
function series(start, segs, step = 2 * MIN) {
  const rows = [];
  let t = start;
  let i = 0;
  for (const s of segs) {
    const n = Math.max(1, Math.round((s.min * MIN) / step));
    for (let k = 0; k < n; k++, i++, t += step) {
      const l = s.from + ((s.to ?? s.from) - s.from) * (k / n);
      const slosh = s.spd ? (s.calm ? (((i * 37) % 3) - 1) : s.wild ? (((i * 37) % 61) - 30) : (((i * 37) % 11) - 5)) : 0;
      rows.push({ t, f: s.mv ?? mv(l + slosh), spd: s.spd ?? 0, pwr: s.pwr ?? (s.spd ? 27500 : 25500), ign: s.ign });
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
  check('150 L over 120 km is within the burn ceiling (156 L) -> burnt, no litres claimed', m.verdict === 'burnt' && !CONFIRMS.has(m.verdict) && m.lost === undefined && Math.abs(m.fell - 150) < 2 && Math.abs(m.burn.liters - 156) < 4, m);
  const refuel = series(T - 7 * HOUR, [{ min: 400, from: 300 }, { min: 120, from: 300, to: 260, spd: 60 }, { min: 10, from: 260, to: 460 }, { min: 400, from: 460 }]);
  const r = meterCheck({ kind: 'trip', rows: refuel, t0, t: T + 114 * MIN, amountL: 80, fromMv: mv(300), toMv: mv(160), cal, th });
  check('trip ending fuller -> refuel', r.verdict === 'refuel', r);
}
// 5b. the road cannot burn it: 554 L to 140 L over 30 km (30 min at 60 km/h)
{
  const rows = series(T - 7 * HOUR, [{ min: 400, from: 450 }, { min: 30, from: 450, to: 40, spd: 60 }, { min: 400, from: 40 }]);
  const t0 = T - 22 * MIN;
  const t = T + 20 * MIN;
  const m = meterCheck({ kind: 'trip', rows, t0, t, amountL: 395, cal, th });
  check('410 L gone over 30 km -> road, lost = the fall beyond the ceiling', m.verdict === 'road' && CONFIRMS.has(m.verdict) && m.lost >= 365 && m.lost <= 395 && Math.abs(m.burn.km - 31) < 2, m);
  const small = meterCheck({ kind: 'trip', rows, t0, t, amountL: 200, cal, th });
  check('never more than the alert says', small.verdict === 'road' && small.lost === 200, small);
}
// 5c. GPS silence: the truck turned up 60 km away after 2 h of silence, 100 L less -> the silence
// alone could burn it; silent at the same spot with the engine off -> it stood, the loss is real
{
  const far = (rows, movedKm) => rows.map((s, i) => ({ ...s, lat: 43.6 + (i >= rows.length / 2 ? movedKm / 111 : 0), lng: 105.5 }));
  const stand = series(T - 7 * HOUR, [{ min: 420, from: 400 }, { min: 300, from: 300 }]);
  const gapRows = far(stand, 60).filter((s) => s.t < T - 60 * MIN || s.t >= T + 60 * MIN); // 2 h silent around T
  const m = meterCheck({ kind: 'parked', rows: gapRows, t0: T - 60 * MIN, t: T + 60 * MIN, amountL: 100, cal, th });
  check('2 h silent, 60 km away after: burnt, note silent', m.verdict === 'burnt' && m.note === 'silent' && m.burn.silentMovedMs >= 2 * HOUR && m.burn.silentMovedMs < 2.1 * HOUR, m);
  const same = far(stand, 0).filter((s) => s.t < T - 60 * MIN || s.t >= T + 60 * MIN);
  const d = meterCheck({ kind: 'parked', rows: same, t0: T - 60 * MIN, t: T + 60 * MIN, amountL: 100, cal, th });
  check('2 h silent at the same spot, engine off -> drop of the whole 100 L', d.verdict === 'drop' && d.lost === 100, d);
}
// 5d. a short move inside a stop (pulling across the yard: 2 km in 4 min) does not end the stop
{
  const rows = series(T - 7 * HOUR, [{ min: 380, from: 300 }, { min: 4, from: 300, to: 299, spd: 30 }, { min: 36, from: 299 }, { min: 40, from: 299, to: 220 }, { min: 300, from: 220 }]);
  const m = meterCheck({ kind: 'parked', rows, t0: T, t: T + 40 * MIN, amountL: 80, cal, th });
  check('level before taken across the short move -> drop, before 300', m.verdict === 'drop' && Math.abs(m.before.v - 300) < 2 && m.lost >= 75, m);
  const long = series(T - 7 * HOUR, [{ min: 380, from: 300 }, { min: 15, from: 300, to: 290, spd: 40 }, { min: 25, from: 290 }, { min: 40, from: 290, to: 220 }, { min: 300, from: 220 }]);
  const l = meterCheck({ kind: 'parked', rows: long, t0: T, t: T + 40 * MIN, amountL: 70, cal, th });
  check('a 15 min drive ends the stop: level before is from after it', l.verdict === 'drop' && Math.abs(l.before.v - 290) < 2, l);
}
// 5e. the engine on all night takes its ceiling off the fall; the engine off leaves it whole;
// a cold night's shrink is not a loss
{
  const idle = series(T - 7 * HOUR, [{ min: 420, from: 400 }, { min: 600, from: 400, to: 370 }, { min: 300, from: 370 }]).map((s) => ({ ...s, ign: 1 }));
  const m = meterCheck({ kind: 'parked', rows: idle, t0: T, t: T + 600 * MIN, amountL: 30, cal, th });
  check('30 L over 10 h with the engine on (ceiling 60 L) -> burnt', m.verdict === 'burnt' && m.burn.liters >= 58, m);
  const off = idle.map((s) => ({ ...s, ign: 0, pwr: 25500 }));
  const volts = idle.map((s) => ({ ...s, ign: 0, pwr: 27800 })); // the flag says off, the alternator says running
  const v = meterCheck({ kind: 'parked', rows: volts, t0: T, t: T + 600 * MIN, amountL: 30, cal, th });
  check('27.8 V while standing counts as the engine running -> burnt', v.verdict === 'burnt', v);
  const o = meterCheck({ kind: 'parked', rows: off, t0: T, t: T + 600 * MIN, amountL: 30, cal, th });
  check('the same with the engine off -> drop of 30 L', o.verdict === 'drop' && o.lost === 30, o);
  const cold = series(T - 7 * HOUR, [{ min: 420, from: 500 }, { min: 600, from: 500, to: 489 }, { min: 300, from: 489 }]);
  const c = meterCheck({ kind: 'parked', rows: cold, t0: T, t: T + 600 * MIN, amountL: 11, cal, th });
  check('11 L off a 500 L level overnight is within thermal shrink -> not a drop', !CONFIRMS.has(c.verdict), c);
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
    { t: T - 3 * HOUR, f: mv(300), spd: 0, pwr: 25500 },
    { t: T - 1 * HOUR, f: mv(300), spd: 0, pwr: 25500 },
    { t: T + 2 * HOUR, f: mv(200), spd: 0, pwr: 25500 },
    { t: T + 4 * HOUR, f: mv(200), spd: 0, pwr: 25500 },
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

// 8b. a "drain" right after the truck pulled up: the fuel was still settling, no settled level before it
{
  const rows = series(T - 7 * HOUR, [{ min: 417, from: 420, to: 410, spd: 60 }, { min: 5, from: 410, to: 388 }, { min: 300, from: 388 }]);
  const m = meterCheck({ kind: 'parked', rows, t0: T, t: T + 5 * MIN, amountL: 22, cal, th });
  check('drop in the first minutes of a stop -> no settled level before it, not evidence', !CONFIRMS.has(m.verdict), m);
}
// 8c. receipts read only settled levels: a stop's first minutes at the top of the scale are not a fill,
// and a fill at a pump stop too short to settle is never called short
{
  const day = Date.UTC(2026, 9, 9, 16, 0); // 00:00 local
  const foam = series(day - 7 * HOUR, [{ min: 600, from: 300 }, { min: 300, from: 300, to: 250, spd: 50 }, { min: 8, from: 0, mv: 9175 }, { min: 600, from: 250 }]);
  const f = meterCheck({ kind: 'receipt', rows: foam, t0: day, t: day, receiptL: 300, dayOnly: true, cal, th });
  check('9 V readings just after a drive are no fill, and no "no refuel" claim either', !CONFIRMS.has(f.verdict) && f.verdict === 'nodata' && !(f.after?.v > 400), f);
  const pump = series(T - 7 * HOUR, [{ min: 400, from: 200 }, { min: 30, from: 200, to: 190, spd: 50 }, { min: 6, from: 190, to: 390 }, { min: 30, from: 390, to: 380, spd: 50 }, { min: 400, from: 380 }]);
  const pu = meterCheck({ kind: 'receipt', rows: pump, t0: T - 7 * HOUR + 430 * MIN, t: T - 7 * HOUR + 436 * MIN, receiptL: 300, missingL: 120, refuelSeen: true, cal, th });
  check('fill at a 6 min pump stop, its rise only seen across the drives -> not short', !CONFIRMS.has(pu.verdict), pu);
  const queue = series(T - 7 * HOUR, [{ min: 400, from: 200 }, { min: 30, from: 200, to: 185, spd: 50 }, { min: 20, from: 185 }, { min: 6, from: 185, to: 285 }, { min: 20, from: 285 }, { min: 300, from: 285, to: 200, spd: 50 }]);
  const q = meterCheck({ kind: 'receipt', rows: queue, t0: T - 7 * HOUR + 450 * MIN, t: T - 7 * HOUR + 456 * MIN, receiptL: 300, missingL: 200, refuelSeen: true, cal, th });
  check('fill measured inside one stop (settled before and after) -> short, from that stop\'s levels', q.verdict === 'short' && Math.abs(q.wentIn - 100) < 3 && Math.abs(q.before.v - 185) < 3, q);
}
// 5f. a sensor that follows its supply: the reading swings 490 / 375 / 445 / 415 / 490 / 377 while the
// truck stands -> no level to trust
{
  const rows = series(T - 7 * HOUR, [{ min: 300, from: 490 }, { min: 15, from: 375 }, { min: 30, from: 445 }, { min: 30, from: 415 }, { min: 20, from: 490 }, { min: 300, from: 377 }]);
  const m = meterCheck({ kind: 'parked', rows, t0: T - 30 * MIN, t: T - 20 * MIN, amountL: 110, cal, th });
  check('swinging reading while standing -> sensor, flicker', m.verdict === 'sensor' && m.note === 'flicker', m);
  const theftThenFill = series(T - 7 * HOUR, [{ min: 420, from: 300 }, { min: 30, from: 300, to: 220 }, { min: 60, from: 220 }, { min: 20, from: 220, to: 450 }, { min: 300, from: 450 }]);
  const tf = meterCheck({ kind: 'parked', rows: theftThenFill, t0: T, t: T + 30 * MIN, amountL: 80, cal, th });
  check('a drop and a later refuel are two moves, not flicker', tf.verdict === 'drop' && tf.lost === 80, tf);
}
// 5g. the level comes back an hour later, the truck still standing: a dip, not a loss
{
  const rows = series(T - 7 * HOUR, [{ min: 420, from: 390 }, { min: 10, from: 390, to: 354 }, { min: 60, from: 354 }, { min: 10, from: 354, to: 390 }, { min: 300, from: 390 }]);
  const m = meterCheck({ kind: 'parked', rows, t0: T, t: T + 10 * MIN, amountL: 36, cal, th });
  check('back up within 3 h at the same stop -> recovered', m.verdict === 'recovered' && !CONFIRMS.has(m.verdict), m);
  const late = series(T - 7 * HOUR, [{ min: 420, from: 390 }, { min: 10, from: 390, to: 354 }, { min: 240, from: 354 }, { min: 10, from: 354, to: 390 }, { min: 300, from: 390 }]);
  const l = meterCheck({ kind: 'parked', rows: late, t0: T, t: T + 10 * MIN, amountL: 36, cal, th });
  check('back up only 4 h later -> still a drop', l.verdict === 'drop', l);
}
// 5h. a damped sensor, steady on the move: 275 L while driving, a 14 min stop with no settled
// reading, 187 L while driving on -> the levels come from the drives, the loss counts
{
  const stop = T - 40 * MIN;
  const mk = (o) => series(T - 7 * HOUR, [{ min: 380, from: 300, to: 275, spd: 50, ...o }, { min: 15, from: 275 }, { min: 25, from: 187, to: 176, spd: 50, ...o }, { min: 300, from: 176 }], MIN)
    .filter((s) => s.t <= stop || s.t >= stop + 15 * MIN); // the stop: one reading, then 14 min of silence
  const rows = mk({ calm: true });
  const t0 = stop;
  const m = meterCheck({ kind: 'parked', rows, t0, t: T - 25 * MIN, amountL: 90, cal, th });
  check('steady sensor on the move -> levels from the drives, marked moving', m.verdict === 'drop' && m.before?.moving === true && m.after?.moving === true && Math.abs(m.before.v - 275) < 4 && Math.abs(m.after.v - 187) < 4, m);
  check('the loss is the fall beyond what the drive could burn', m.lost >= 65 && m.lost <= 88, m);
  const w = meterCheck({ kind: 'parked', rows: mk({ wild: true }), t0, t: T - 25 * MIN, amountL: 90, cal, th });
  check('a sloshing sensor gives no level on the move -> nodata', w.verdict === 'nodata', w);
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
