// Автомат шалгалт: the nightly fuel check. Once a day (after 01:00 local) it looks at the day
// before for every truck and raises an `auto_check` alert for each case the live detector cannot
// see on its own. Plain rules, no outside service, nothing hidden: a case that may be harmless
// still shows, with a tag, and a person decides.
//
//   gap        13  the level after a GPS silence of 2 h or more is lower than the most the truck
//                  could have burnt in it (meter.js burn ceilings: 100 L/h when it turned up
//                  elsewhere, 6 L/h idling, 0 with the engine off). The live detector drops its
//                  levels across such a silence, so unplugging the tracker hid a drain.
//   room        1  a receipt bigger than the free room in the tank at that time
//   sensor     15  the fuel sensor gave no valid reading on most of a day's driving, 2 days or
//                  more running: the days, the km and the receipt litres of that time
//   balance     9  the day's fuel: level at the start + refuels - level at the end, against the
//                  most the day's driving and idling could burn (hard case), and against the
//                  truck's own usual litres a km (a softer "higher than usual" case)
//   transfer   11  one truck's level fell while another's rose, at the same place and time
//   afterfill  21  a drop within 2 h after a refuel (fuel filled, then taken off into cans)
//
// No "heating" tag: a drop is a drop (the user, 2026-11-05: winter, the sun does not swell the
// fuel; a cold night's shrink is already allowed for by meter.js THERMAL).
//
// The functions here are pure (rows in, cases out); engine.runAutoCheck feeds them and stores
// the cases. Texts are in Mongolian: the user-facing name is "Автомат шалгалт".
import { meterCheck, BURN } from './meter.js';
import { litersAt } from './ledger.js';

const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const GAP_MIN_MS = 2 * HOUR; // the live detector compares levels across shorter silences
const SETTLE = 10 * MIN;
const MOVE_KMH = 3;
const SENSOR_BAD_SHARE = 0.5; // half or more of the readings while driving had no valid level
const SENSOR_MIN_KM = 30;
const TRANSFER_MS = 45 * MIN;
const TRANSFER_M = 300;
const AFTERFILL_MS = 2 * HOUR;
const BALANCE_MIN_L = 30; // the smallest daily excess worth a case (tank tables read within a few %)
const USUAL_FACTOR = 1.25; // "higher than usual": 25 % over the truck's own median litres a km

const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pos = (s) => Number.isFinite(s?.lat) && Number.isFinite(s?.lng) && !(s.lat === 0 && s.lng === 0);
export function distM(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371e3 * Math.asin(Math.sqrt(Math.min(1, h)));
}
/** Km driven across rows: GPS where both readings have a position (jumps over 250 km/h dropped),
 *  else speed over time; silences over 15 min are not counted. */
export function kmOf(rows) {
  let km = 0;
  for (let i = 1; i < rows.length; i++) {
    const p = rows[i - 1];
    const s = rows[i];
    const h = (s.t - p.t) / HOUR;
    if (h > 0.25) continue;
    if (pos(p) && pos(s)) {
      const d = distM(p, s) / 1000;
      if (d <= h * 250 + 0.1) { km += d; continue; }
    }
    if ((p.spd ?? 0) >= MOVE_KMH || (s.spd ?? 0) >= MOVE_KMH) km += (((p.spd ?? 0) + (s.spd ?? 0)) / 2) * h;
  }
  return km;
}
const validOf = (th) => {
  const sensorMin = Number.isFinite(th?.sensorMinValidMv) ? th.sensorMinValidMv : 100;
  const powerCut = Number.isFinite(th?.powerCutMv) ? th.powerCutMv : 5000;
  return (s) => s.f !== null && s.f !== undefined && s.f >= sensorMin && (s.pwr === null || s.pwr === undefined || s.pwr >= powerCut);
};
/** Standing readings at least SETTLE after the last moving one: the level at rest. */
function settled(rows, th) {
  const valid = validOf(th);
  const out = [];
  let lastMove = -Infinity;
  for (const s of rows) {
    if ((s.spd ?? 0) >= MOVE_KMH) { lastMove = s.t; continue; }
    if (valid(s) && s.t - lastMove >= SETTLE) out.push(s);
  }
  return out;
}
const hasTable = (cal) => !!(cal && (cal.tankLiters || (Array.isArray(cal.table) && cal.table.length >= 2)));

// ------------------------------------------------------------------ 13: lower level after a GPS gap
/** GPS silences of GAP_MIN_MS or more inside [from, to) and the meter's word on each. rows cover
 *  from - 7 h .. to + 7 h. A case only where the meter (meter.js, settled readings, burn ceiling)
 *  shows a drop. */
export function gapCases({ rows, from, to, cal, th }) {
  if (!hasTable(cal)) return [];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const p = rows[i - 1];
    const s = rows[i];
    if (s.t - p.t < GAP_MIN_MS || p.t < from || p.t >= to) continue;
    const m = meterCheck({ kind: 'parked', rows, t0: p.t, t: s.t, amountL: null, cal, th });
    if (m.verdict !== 'drop' || !(m.lost > 0)) continue;
    const moved = pos(p) && pos(s) ? distM(p, s) : null;
    out.push({
      rule: 'gap', severity: 'critical', fromT: p.t, t: s.t, lostL: round1(m.lost),
      lat: s.lat ?? p.lat, lng: s.lng ?? p.lng,
      title: 'GPS тасарсны дараа түлш дутуу',
      detail: `GPS ${fmtDur(s.t - p.t)} мэдээлэлгүй байсан${moved !== null ? (moved >= 1000 ? `, тэр хооронд ${round1(moved / 1000)} км өөр газар очсон` : ', тэр хооронд хөдлөөгүй') : ''}. ` +
        `Түвшин ${round1(m.before.v)} л → ${round1(m.after.v)} л. Шатаж болох дээд хэмжээ ${round1(m.burn?.total ?? 0)} л-ийг хассаны дараа ${round1(m.lost)} л дутуу.`,
      facts: { gapMs: s.t - p.t, movedM: moved === null ? null : Math.round(moved), before: m.before, after: m.after, burn: m.burn ?? null },
    });
  }
  return out;
}

// ------------------------------------------------------------------ 1: receipt bigger than tank room
/** Receipts (engine.receiptResults rows) whose litres exceed the free room in the tank. */
export function roomCases({ receipts, tankLiters }) {
  return receipts.filter((r) => r.nofit && Number.isFinite(r.room) && Number.isFinite(r.litres)).map((r) => {
    const over = round1(r.litres - r.room);
    return {
      rule: 'room', severity: 'critical', key: `room:${r.id}`, t: r.refuel?.t ?? r.t ?? null, fromT: null, lostL: over,
      title: 'Баримт савны багтаамжаас их',
      detail: `${r.date}${r.station ? ` (${r.station})` : ''} баримт ${round1(r.litres)} л, гэвч тэр үед саванд ${round1(r.room)} л л багтах зай байсан` +
        `${tankLiters ? ` (сав ${tankLiters} л)` : ''}. ${over} л саванд орох боломжгүй.`,
      facts: { receiptId: r.id, litres: r.litres, room: r.room, status: r.status },
    };
  });
}

// ------------------------------------------------------------------ 15: sensor dead for days
/** One day's sensor state: { km, drivingReadings, badShare, bad } (bad = most of the driving had
 *  no valid reading, and the truck drove SENSOR_MIN_KM or more). */
export function sensorDay({ rows, th }) {
  const valid = validOf(th);
  const driving = rows.filter((s) => (s.spd ?? 0) >= MOVE_KMH);
  const km = kmOf(rows);
  const badShare = driving.length ? driving.filter((s) => !valid(s)).length / driving.length : 0;
  return { km: round1(km), drivingReadings: driving.length, badShare: round1(badShare * 100) / 100, bad: driving.length >= 20 && km >= SENSOR_MIN_KM && badShare >= SENSOR_BAD_SHARE };
}
/** days: [{ day, km, bad }] oldest first, ending with the day checked; receipts of the truck. */
export function sensorCase({ days, receipts }) {
  let n = 0;
  for (let i = days.length - 1; i >= 0 && days[i].bad; i--) n++;
  if (n < 2) return null;
  const streak = days.slice(days.length - n);
  const first = streak[0].day;
  const last = streak[streak.length - 1].day;
  const km = round1(streak.reduce((a, d) => a + (d.km || 0), 0));
  const rs = receipts.filter((r) => r.date >= first && r.date <= last);
  const litres = round1(rs.reduce((a, r) => a + (r.litres || 0), 0));
  return {
    rule: 'sensor', severity: 'critical', key: `sensor:${first}`, lostL: null,
    title: 'Түлшний мэдрэгч олон хоног заагаагүй',
    detail: `${first} - ${last}: ${n} хоног мэдрэгч заагаагүй, тэр хооронд ${km} км явсан. ` +
      `Энэ хугацааны баримт ${rs.length} ширхэг, нийт ${litres} л. Мэдрэгчгүй үед түлшийг зөвхөн баримт ба км-ээр шалгана.`,
    facts: { first, last, days: n, km, receipts: rs.length, receiptLitres: litres },
  };
}

// ------------------------------------------------------------------ 9: the day's fuel balance
/** The day's balance: level at rest near the day's start and end, the refuels between (litres),
 *  the km, and the burn ceiling. null when either level is missing (a dead sensor: rule 15). */
export function dayBalance({ rows, dayStart, cal, th, refuelsL = 0 }) {
  if (!hasTable(cal)) return null;
  const dayEnd = dayStart + DAY;
  const st = settled(rows, th);
  const near = (edge, dir) => {
    const xs = st.filter((s) => (dir > 0 ? s.t >= edge && s.t <= edge + 6 * HOUR : s.t <= edge && s.t >= edge - 6 * HOUR));
    const pick = dir > 0 ? xs.slice(0, 5) : xs.slice(-5);
    return pick.length >= 2 ? { t: pick[pick.length >> 1].t, v: litersAt(median(pick.map((s) => s.f)), cal) } : null;
  };
  // the level at the first / last rest of the day (the night before / after if it was driving then)
  const start = near(dayStart, 1) || near(dayStart, -1);
  const end = near(dayEnd, -1) || near(dayEnd, 1);
  if (!start || !end || end.t <= start.t) return null;
  const span = rows.filter((s) => s.t >= start.t && s.t <= end.t);
  const km = kmOf(span);
  let idleMs = 0;
  for (let i = 1; i < span.length; i++) {
    const p = span[i - 1];
    const dt = span[i].t - p.t;
    if (dt > 15 * MIN || (p.spd ?? 0) >= MOVE_KMH) continue;
    if (Number.isFinite(p.pwr) && p.pwr >= (p.pwr > 18000 ? 26400 : 13300)) idleMs += dt;
  }
  const fills = typeof refuelsL === 'function' ? refuelsL(start.t, end.t) : refuelsL;
  const used = start.v + fills - end.v;
  const ceiling = BURN.perKm * km + BURN.idle * (idleMs / HOUR);
  return { start, end, refuelsL: round1(fills), km: round1(km), idleH: round1(idleMs / HOUR), used: round1(used), ceiling: round1(ceiling), perKm: km >= 50 ? round1(used / km * 100) / 100 : null };
}
/** A case from a day's balance: beyond the burn ceiling (proof), or 25 % over the truck's usual
 *  litres a km (usualPerKm, from its own past days: a softer case to look at). */
export function balanceCase({ bal, usualPerKm, tolL = 0 }) {
  if (!bal) return null;
  const allow = Math.max(BALANCE_MIN_L, tolL);
  const overCeiling = bal.used - bal.ceiling;
  const base = `Өглөө ${round1(bal.start.v)} л + цэнэглэлт ${bal.refuelsL} л − орой ${round1(bal.end.v)} л = ${bal.used} л зарцуулсан, ${bal.km} км явсан`;
  if (overCeiling >= allow) {
    return {
      rule: 'balance', severity: 'critical', lostL: round1(overCeiling), fromT: bal.start.t, t: bal.end.t,
      title: 'Өдрийн түлшний тэнцэл зөрсөн',
      detail: `${base}. Шатаж болох дээд хэмжээ ${bal.ceiling} л (1.3 л/км, сул ажиллагаа 6 л/ц). ${round1(overCeiling)} л тайлбаргүй.`,
      facts: { ...bal, usualPerKm },
    };
  }
  if (Number.isFinite(usualPerKm) && bal.km >= 50) {
    const expected = usualPerKm * bal.km * USUAL_FACTOR;
    const over = bal.used - expected;
    if (over >= allow) {
      return {
        rule: 'balance', severity: 'warning', lostL: null, fromT: bal.start.t, t: bal.end.t,
        title: 'Зарцуулалт хэвийнээс их',
        detail: `${base} (${round1(bal.used / bal.km * 100)} л/100км). Энэ машины хэвийн ${round1(usualPerKm * 100)} л/100км. ` +
          `Хэвийнээс ${round1(bal.used - usualPerKm * bal.km)} л их. Нотолгоо биш: шалгах.`,
        facts: { ...bal, usualPerKm, overUsual: round1(bal.used - usualPerKm * bal.km) },
      };
    }
  }
  return null;
}

// ------------------------------------------------------------------ 11 + 21: from the day's alerts
/** alerts: views of the day's fuel_drain and refuel alerts (all trucks), each { id, imei, type,
 *  t, fromT, lat, lng, amountL, shortName }. */
export function transferCases(alerts) {
  const drains = alerts.filter((a) => a.type === 'fuel_drain' && pos(a) && a.amountL > 0);
  const fills = alerts.filter((a) => a.type === 'refuel' && pos(a) && a.amountL > 0);
  const out = [];
  for (const d of drains) {
    for (const f of fills) {
      if (f.imei === d.imei) continue;
      const dt = Math.abs((f.fromT ?? f.t) - (d.fromT ?? d.t));
      if (dt > TRANSFER_MS || distM(d, f) > TRANSFER_M) continue;
      const ratio = Math.min(d.amountL, f.amountL) / Math.max(d.amountL, f.amountL);
      if (ratio < 0.5) continue;
      out.push({
        rule: 'transfer', severity: 'critical', key: `transfer:${d.id}:${f.id}`, imei: d.imei, fromT: d.fromT ?? d.t, t: d.t, lat: d.lat, lng: d.lng, lostL: round1(d.amountL),
        title: 'Өөр машин руу түлш шилжүүлсэн байж болзошгүй',
        detail: `${d.shortName || d.imei}-ийн түлш ${round1(d.amountL)} л буурах үед ${f.shortName || f.imei}-д ${round1(f.amountL)} л нэмэгдсэн, ` +
          `${Math.round(distM(d, f))} м зайд, ${Math.round(dt / MIN)} мин зөрүүтэй.`,
        facts: { drainId: d.id, refuelId: f.id, otherImei: f.imei, distM: Math.round(distM(d, f)), dtMs: dt },
      });
    }
  }
  return out;
}
export function afterfillCases(alerts) {
  const out = [];
  const byImei = new Map();
  for (const a of alerts) {
    if (!byImei.has(a.imei)) byImei.set(a.imei, []);
    byImei.get(a.imei).push(a);
  }
  for (const list of byImei.values()) {
    const fills = list.filter((a) => a.type === 'refuel' && a.amountL > 0);
    for (const d of list.filter((a) => a.type === 'fuel_drain' && a.amountL > 0)) {
      const start = d.fromT ?? d.t;
      const f = fills.find((x) => start >= x.t && start - x.t <= AFTERFILL_MS);
      if (!f) continue;
      out.push({
        rule: 'afterfill', severity: 'critical', key: `afterfill:${d.id}`, imei: d.imei, fromT: start, t: d.t, lat: d.lat, lng: d.lng, lostL: round1(d.amountL),
        title: 'Цэнэглэсний дараахан түлш буурсан',
        detail: `${round1(f.amountL)} л цэнэглэснээс ${Math.round((start - f.t) / MIN)} мин дараа ${round1(d.amountL)} л буурсан.`,
        facts: { drainId: d.id, refuelId: f.id },
      });
    }
  }
  return out;
}

function fmtDur(ms) {
  const m = Math.round(ms / MIN);
  const h = Math.floor(m / 60);
  return h ? `${h} ц ${m % 60} мин` : `${m} мин`;
}
