// Self-test for the nightly automatic check (src/autocheck.js and engine.runAutoCheck): synthetic
// readings for each rule, and one full nightly run on a throw-away database. Nothing is fetched
// or sent.
//
//   node --no-warnings tools/autocheck-selftest.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gapCases, roomCases, sensorDay, sensorCase, dayBalance, balanceCase, transferCases, afterfillCases, fitNorm } from '../src/autocheck.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { Engine } from '../src/engine.js';

let failed = 0;
let passed = 0;
function check(name, ok, info) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info !== undefined ? `  -- ${typeof info === 'string' ? info : JSON.stringify(info)}` : ''}`);
}

const MIN = 60e3;
const HOUR = 60 * MIN;
const cal = { tankLiters: 500, table: [[0, 0], [10000, 500]] }; // 20 mV a litre
const mv = (l) => l * 20;
const th = { sensorMinValidMv: 100, powerCutMv: 5000 };
const T = Date.UTC(2026, 10, 3, 16, 0); // 2026-11-04 00:00 local (UTC+8)

/** readings every `step`; segment { min, from, to (litres), spd, f (mV override), lat, lng, dlat } */
function series(start, segs, step = 2 * MIN) {
  const rows = [];
  let t = start;
  let lat = 43.6;
  for (const s of segs) {
    const n = Math.max(1, Math.round((s.min * MIN) / step));
    for (let k = 0; k < n; k++, t += step) {
      const l = s.from + ((s.to ?? s.from) - s.from) * (k / n);
      if (s.spd) lat += (s.spd * step / HOUR) / 111; // drive north
      rows.push({ t, f: s.f !== undefined ? s.f : mv(l), spd: s.spd ?? 0, pwr: s.spd ? 27500 : 25500, lat, lng: 105.5 });
    }
  }
  return rows;
}

// 13: a 4 h silence parked, 80 L lower after it -> case; flat -> none; drove 200 km in it -> burnt
{
  const a = series(T - 7 * HOUR, [{ min: 600, from: 300 }]);
  const gapEnd = a[a.length - 1].t + 4 * HOUR;
  const b = series(gapEnd, [{ min: 600, from: 220 }]);
  const c = gapCases({ rows: [...a, ...b], from: T - 7 * HOUR, to: T + 24 * HOUR, cal, th });
  check('GPS gap: 80 L lower after a 4 h silence parked -> case', c.length === 1 && c[0].rule === 'gap' && Math.abs(c[0].lostL - 80) < 3, c[0]);
  const flat = series(gapEnd, [{ min: 600, from: 300 }]);
  check('GPS gap: same level after -> no case', gapCases({ rows: [...a, ...flat], from: T - 7 * HOUR, to: T + 24 * HOUR, cal, th }).length === 0);
  // turned up 200 km away 4 h later, 220 L: 100 L/h ceiling covers 80 L -> no case
  const far = b.map((s) => ({ ...s, lat: s.lat + 1.8 }));
  check('GPS gap: moved 200 km in it, 80 L lower -> burnable, no case', gapCases({ rows: [...a, ...far], from: T - 7 * HOUR, to: T + 24 * HOUR, cal, th }).length === 0);
  check('GPS gap: texts in Mongolian', /GPS/.test(c[0]?.detail || '') && /дутуу/.test(c[0]?.title || ''), c[0]?.title);
}

// 1: receipt bigger than the room
{
  const rs = [{ id: 'r1', date: '2026-10-28', litres: 550, room: 366, nofit: true, status: 'norefuel' }, { id: 'r2', date: '2026-10-28', litres: 300, room: 366, nofit: false }];
  const c = roomCases({ receipts: rs, tankLiters: 590 });
  check('receipt 550 L into 366 L room -> case of 184 L', c.length === 1 && c[0].lostL === 184 && c[0].key === 'room:r1', c);
}

// 15: dead sensor while driving, 2 days running
{
  const dead = series(T, [{ min: 300, from: 0, f: 0, spd: 60 }, { min: 60, from: 0, f: 0 }]);
  const d = sensorDay({ rows: dead, th });
  check('sensor day: 0 on all driving, 300 km -> bad', d.bad && d.km > 250, d);
  const ok = sensorDay({ rows: series(T, [{ min: 300, from: 400, to: 200, spd: 60 }]), th });
  check('sensor day: live sensor -> not bad', !ok.bad, ok);
  const one = sensorCase({ days: [{ day: '2026-11-03', bad: false }, { day: '2026-11-04', bad: true, km: 300 }], receipts: [] });
  check('sensor: one bad day -> no case yet', one === null);
  const c = sensorCase({
    days: [{ day: '2026-11-02', bad: false }, { day: '2026-11-03', bad: true, km: 300 }, { day: '2026-11-04', bad: true, km: 250 }],
    receipts: [{ date: '2026-11-03', litres: 400 }, { date: '2026-11-01', litres: 300 }],
  });
  check('sensor: 2 bad days -> case with days, km, receipt litres of that time', c && c.facts.days === 2 && c.facts.km === 550 && c.facts.receiptLitres === 400 && c.key === 'sensor:2026-11-03', c);
}

// 9: the day's balance
{
  // rest 400 L, drive 200 km burning 160 L (0.8 L/km), rest; then 100 L gone at night
  const rows = series(T - 2 * HOUR, [{ min: 600, from: 400 }, { min: 240, from: 400, to: 240, spd: 50 }, { min: 300, from: 240 }, { min: 10, from: 240, to: 140 }, { min: 500, from: 140 }]);
  const bal = dayBalance({ rows, dayStart: T, cal, th, refuelsL: 0 });
  check('balance: used = start - end', bal && Math.abs(bal.used - 260) < 3 && bal.km > 180, bal);
  const c = balanceCase({ bal, usualPerKm: null, tolL: 25 });
  check('balance: 260 L for 200 km (ceiling 260 + idle) -> no hard case unless beyond ceiling', c === null || c.severity !== 'critical' || c.lostL > 0, c);
  const c2 = balanceCase({ bal, usualPerKm: 0.8, tolL: 25 });
  check('balance: 260 L vs usual 0.8 L/km x 200 km -> "higher than usual" (warning, no litres claimed)', c2 && c2.severity === 'warning' && c2.lostL === null, c2);
  const quiet = series(T - 2 * HOUR, [{ min: 600, from: 400 }, { min: 600, from: 400, to: 300 }, { min: 300, from: 300 }]);
  const qb = dayBalance({ rows: quiet, dayStart: T, cal, th, refuelsL: 0 });
  const qc = balanceCase({ bal: qb, usualPerKm: null, tolL: 25 });
  check('balance: 100 L gone standing still all day -> hard case', qc && qc.severity === 'critical' && qc.lostL > 60, qc);
  const filled = dayBalance({ rows, dayStart: T, cal, th, refuelsL: (a, b) => 0 });
  check('balance: refuels taken as a function of the window', filled && filled.refuelsL === 0);
}

// 11 + 21
{
  const alerts = [
    { id: 1, imei: 'A', type: 'fuel_drain', t: T + 2 * HOUR, fromT: T + HOUR + 50 * MIN, lat: 43.6, lng: 105.5, amountL: 80, shortName: '1111АА' },
    { id: 2, imei: 'B', type: 'refuel', t: T + 2 * HOUR, fromT: T + HOUR + 55 * MIN, lat: 43.6005, lng: 105.5, amountL: 75, shortName: '2222ББ' },
    { id: 3, imei: 'C', type: 'refuel', t: T + 2 * HOUR, fromT: T + HOUR + 55 * MIN, lat: 44.6, lng: 105.5, amountL: 80 },
    { id: 4, imei: 'A', type: 'refuel', t: T + HOUR, fromT: T + 50 * MIN, lat: 43.7, lng: 105.5, amountL: 350 },
  ];
  const tr = transferCases(alerts);
  check('transfer: A fell 80 L as B rose 75 L 55 m away -> one case, not C (far away)', tr.length === 1 && tr[0].facts.otherImei === 'B', tr);
  const af = afterfillCases(alerts);
  check('afterfill: A dropped 50 min after its 350 L refuel -> case', af.length === 1 && af[0].imei === 'A', af);
}

// learned norm per truck
{
  const wob = (i) => ((i * 37) % 11) / 10 - 0.5; // -0.5 .. 0.5, fixed
  // a shuttle that honestly burns 1.65 L/km with no idle hours seen (border queue, engine on)
  const shuttle = Array.from({ length: 12 }, (_, i) => ({ day: `d${i}`, km: 90 + i * 3, idleH: 0, used: (90 + i * 3) * 1.65 + wob(i) * 6 }));
  const ns = fitNorm(shuttle);
  check('norm: shuttle fitted near 1.65 L/km', ns && Math.abs(ns.perKm - 1.65) < 0.05, ns);
  check('norm: fewer than 7 days -> none', fitNorm(shuttle.slice(0, 6)) === null);
  const day = { start: { t: 0, v: 400 }, end: { t: 1, v: 235 }, refuelsL: 0, km: 100, idleH: 0, used: 165, ceiling: 130, perKm: 1.65 };
  const fixed = balanceCase({ bal: day, tolL: 25 });
  check('norm: 165 L / 100 km on the fixed ceiling alone -> a hard case (the old false alarm)', fixed?.severity === 'critical', fixed?.lostL);
  check('norm: same day with the shuttle\'s own norm -> no case', balanceCase({ bal: day, norm: ns, tolL: 25 }) === null);
  // a long-route truck, 0.8 L/km and 6 L/h idle
  const long = Array.from({ length: 20 }, (_, i) => { const km = 180 + (i % 5) * 30; const h = 1 + (i % 3); return { day: `l${i}`, km, idleH: h, used: km * 0.8 + h * 6 + wob(i) * 10 }; });
  const nl = fitNorm(long);
  check('norm: long route fitted near 0.8 L/km and 6 L/h', nl && Math.abs(nl.perKm - 0.8) < 0.05 && Math.abs(nl.perIdleH - 6) < 2, nl);
  // 1874-like day: 370.6 L for 229.5 km, 1 h idle
  const d1874 = { start: { t: 0, v: 500.8 }, end: { t: 1, v: 130.2 }, refuelsL: 0, km: 229.5, idleH: 1, used: 370.6, ceiling: 304.4 };
  const c1874 = balanceCase({ bal: d1874, norm: nl, tolL: 29.5 });
  check('norm: 1874-like day stays a hard case and says ~180 L over its own norm', c1874?.severity === 'critical' && c1874.facts.overNorm > 160 && /норм/.test(c1874.detail), c1874 && { lostL: c1874.lostL, overNorm: c1874.facts.overNorm });
  // inside the ceiling but well over its norm -> softer case with the litres
  const dw = { start: { t: 0, v: 400 }, end: { t: 1, v: 170 }, refuelsL: 0, km: 200, idleH: 1, used: 230, ceiling: 266 };
  const cw = balanceCase({ bal: dw, norm: nl, tolL: 25 });
  check('norm: 230 L for 200 km (norm ~166 L) -> "Зарцуулалт нормоос их" with ~64 L', cw?.severity === 'warning' && cw.facts.overNorm > 50 && cw.lostL === null, cw && cw.facts.overNorm);
  const dn = { ...dw, end: { t: 1, v: 230 }, used: 170 };
  check('norm: a normal day -> no case', balanceCase({ bal: dn, norm: nl, tolL: 25 }) === null);
}

// a full nightly run on a throw-away database
{
  const IMEI = '999999061234500';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftw-autocheck-'));
  const db = openDb(dir);
  try {
    const cfg = loadConfig({ DATA_DIR: dir, NO_BACKFILL: '1' });
    cfg.excelFile = '';
    cfg.calibrations = { [IMEI]: { tankLiters: 500, table: [[0, 0], [10000, 500]] } };
    const engine = new Engine({ cfg, db, hub: null });
    await engine.loadDetector();
    engine.applyObjects([{
      imei: IMEI, name: '1234ӨМЕ/Түлшний мэдрэгчтэй/', group_name: 'Test', dt_tracker: '2026-11-04 06:00:00', dt_server: '2026-11-04 06:00:00',
      lat: '43.6', lng: '105.5', speed: '0', params: { io9: '6000', io239: '0', io66: '25500' },
    }], T + 2 * HOUR);
    const a = series(T - 7 * HOUR, [{ min: 600, from: 300 }]);
    const b = series(a[a.length - 1].t + 4 * HOUR, [{ min: 900, from: 220 }]);
    db.insertSamples(IMEI, [...a, ...b].map((s) => ({ ...s, ign: 0, odo: null })));
    const asked = [];
    engine.secondOpinionFn = async (input) => { asked.push(input); return { view: 'likely_theft', label: 'Хулгай байж магадгүй', confidence: 80, reason: 'Зогсож байхад 80 л буурсан.', checks: ['Жолоочоос асуух'], model: 'test' }; };
    const n = engine.runAutoCheck('2026-11-04', T + 26 * HOUR);
    await engine.officerChain;
    const list = engine.queryAlerts({ types: ['auto_check'], limit: 50 });
    check('nightly run: the GPS-gap case is stored as an "Автомат шалгалт" alert', n >= 1 && list.some((x) => x.imei === IMEI && /GPS/.test(x.title)), list.map((x) => x.title));
    const withOp = engine.queryAlerts({ types: ['auto_check'], limit: 50 }).filter((x) => /Хоёр дахь дүгнэлт: Хулгай байж магадгүй \(итгэл 80 %\)/.test(x.detail));
    check('second opinion: asked once per new case, its line added to the case, meter line sent', asked.length === n && withOp.length === n && asked[0].line.length > 10, { asked: asked.length, n, withOp: withOp.length });
        check('nightly run: alert type label is Автомат шалгалт', engine.alertTypes.auto_check?.label === 'Автомат шалгалт', engine.alertTypes.auto_check);
    const again = engine.runAutoCheck('2026-11-04', T + 26 * HOUR);
    await engine.officerChain;
    check('second opinion: a second run asks nothing new', asked.length === n, asked.length);
    check('nightly run twice: no duplicate cases', again === 0 && engine.queryAlerts({ types: ['auto_check'], limit: 50 }).length === list.length, again);
    const id = list[0]?.id;
    const rv = id ? engine.reviewAlert(id, { verdict: 'false_alarm', note: 'test' }) : null;
    check('a person can mark an automatic-check case', rv?.verdict === 'false_alarm', rv?.verdict);
    // due only once a day, after 01:00 local
    engine.historyReady = true;
    const due0 = engine.runAutoCheckIfDue(Date.UTC(2026, 10, 4, 16, 30)); // 00:30 local 11-05
    const due1 = engine.runAutoCheckIfDue(Date.UTC(2026, 10, 4, 17, 30)); // 01:30 local 11-05
    const due2 = engine.runAutoCheckIfDue(Date.UTC(2026, 10, 4, 18, 30));
    check('due: not before 01:00, once after it', due0 === null && due1 !== null && due2 === null, { due0, due1, due2 });
  } finally {
    db.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${failed ? 'FAILED' : 'OK'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
