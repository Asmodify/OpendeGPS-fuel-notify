// Self-test for src/opentee.js (the link that sends fuel events to the Open Tee API). Uses a
// throw-away database and a fake API; nothing is sent anywhere.
//
//   node --no-warnings tools/opentee-selftest.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { OpenTeeLink, toOpenTeeEvent, openTeeSettings } from '../src/opentee.js';
import { RECEIPTS_KEY, matchReceipts, refuelsFromRows } from '../src/receipts.js';

let failed = 0;
let passed = 0;
function check(name, ok, info) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info !== undefined ? `  -- ${typeof info === 'string' ? info : JSON.stringify(info)}` : ''}`);
}

const IMEI = '999999051234567';
const KEY = 'selftest-key-0123456789abcdef';
const T = Date.UTC(2026, 9, 1, 2, 0);
const CAL = { emptyMv: 0, fullMv: 10000, tankLiters: 500, table: [[0, 0], [10000, 500]] };

// ---- settings ----------------------------------------------------------------------------
{
  check('off without a key', openTeeSettings({}, {}).enabled === false);
  check('off with a short key', openTeeSettings({ openTee: { key: 'short' } }, {}).enabled === false);
  const s = openTeeSettings({ openTee: { key: KEY } }, {});
  check('on with a key, default API address', s.enabled && s.url === 'https://api.opendevelopment.mn', s.url);
  check('environment wins', openTeeSettings({ openTee: { key: 'x' } }, { OPENTEE_KEY: KEY, OPENTEE_URL: 'http://127.0.0.1:5000/' }).url === 'http://127.0.0.1:5000');
}

// ---- mapping -----------------------------------------------------------------------------
const row = (o) => ({
  id: 1, key: `k-${o.type}-${o.t ?? T}`, imei: IMEI, name: 'Test truck', severity: 'info', t: T, from_t: T - 30 * 60000,
  lat: 47.9, lng: 106.9, title: '', detail: '', amount_mv: null, ongoing: 0, acked: 0, historical: 0, extra: null,
  verdict: null, note: null, created_at: T, updated_at: T, ...o,
});
{
  const refuel = toOpenTeeEvent(row({ type: 'refuel', amount_mv: 4000, extra: JSON.stringify({ fromMv: 2000 }) }), CAL);
  check('refuel -> REFUEL with litres', refuel?.type === 'REFUEL' && refuel.deltaLiters === 200 && refuel.beforeLiters === 100 && refuel.afterLiters === 300, refuel);
  check('event id carries no IMEI', refuel && !refuel.id.includes(IMEI) && /^[0-9a-f]{40}$/.test(refuel.id));
  check('started at the start of the change', refuel?.startedAt === new Date(T - 30 * 60000).toISOString());

  const drain = toOpenTeeEvent(row({ type: 'fuel_drain', severity: 'critical', amount_mv: 800, extra: JSON.stringify({ fromMv: 6000, detectedT: T - 5 * 3600000 }), verdict: 'confirmed', note: 'Баримтгүй' }), CAL);
  check('drain -> POSSIBLE_DRAIN, negative', drain?.type === 'POSSIBLE_DRAIN' && drain.deltaValue === -800 && drain.deltaLiters === -40 && drain.severity === 'critical', drain);
  check('drain keeps verdict and note', drain?.verdict === 'confirmed' && drain.note === 'Баримтгүй');
  check('detected when first seen, not when confirmed', drain?.detectedAt === new Date(T - 5 * 3600000).toISOString());

  const pending = toOpenTeeEvent(row({ type: 'fuel_drain', amount_mv: 800, extra: JSON.stringify({ pending: true, fromMv: 6000 }) }), CAL);
  check('a drop still being checked is not sent', pending === null);

  const back = toOpenTeeEvent(row({ type: 'fuel_drain', amount_mv: null, extra: JSON.stringify({ falseAlarm: true, dipMv: 500, fromMv: 6000 }) }), CAL);
  check('a drop whose level came back -> recovered', back?.status === 'recovered' && back.severity === 'info' && back.deltaValue === -500, back);

  const sensor = toOpenTeeEvent(row({ type: 'sensor_lost', severity: 'critical', ongoing: 1 }), CAL);
  check('sensor fault -> FUEL_SENSOR_INVALID, open', sensor?.type === 'FUEL_SENSOR_INVALID' && sensor.status === 'open' && sensor.endedAt === null);
  check('overspeed is sent too', toOpenTeeEvent(row({ type: 'overspeed', severity: 'warning' }), CAL)?.type === 'OVERSPEED');
  check('offline -> GPS_OFFLINE', toOpenTeeEvent(row({ type: 'offline', severity: 'critical', ongoing: 1 }), CAL)?.type === 'GPS_OFFLINE');
  const mismatch = toOpenTeeEvent(row({ type: 'receipt_mismatch', severity: 'critical', extra: JSON.stringify({ receiptId: 'ot-0b6f1c9e-1111-4222-8333-444455556666', receiptL: 300, missingL: 120.4 }) }), CAL);
  check('receipt mismatch -> RECEIPT_MISMATCH with the Open Tee receipt id and the missing litres',
    mismatch?.type === 'RECEIPT_MISMATCH' && mismatch.receiptId === '0b6f1c9e-1111-4222-8333-444455556666' && mismatch.deltaLiters === -120.4, mismatch);
  const ownReceipt = toOpenTeeEvent(row({ type: 'receipt_mismatch', extra: JSON.stringify({ receiptId: 'r-12', receiptL: 200 }) }), CAL);
  check('a receipt typed into the warner itself has no Open Tee id', ownReceipt?.receiptId === null && ownReceipt.deltaLiters === -200, ownReceipt);
  check('unknown alert types are not sent', toOpenTeeEvent(row({ type: 'test' }), CAL) === null);
  check('no litres without a calibration', toOpenTeeEvent(row({ type: 'refuel', amount_mv: 4000 }), null)?.deltaLiters === null);
}

// ---- sending -----------------------------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftw-opentee-'));
const db = openDb(dir);
try {
  const calls = []; // event batches sent
  const checkCalls = []; // receipt checks sent
  let answer = { status: 200, body: { success: true, unmatchedImeis: [] } };
  let receiptPages = []; // what GET /receipts answers, one page per call
  const fakeFetch = async (url, init) => {
    const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (url.includes('/receipts?')) return answer.status >= 300 ? reply(answer.status, answer.body) : reply(200, receiptPages.shift() || { success: true, receipts: [], cursor: null, more: false });
    if (url.endsWith('/receipt-checks')) {
      checkCalls.push(JSON.parse(init.body).checks);
      return reply(200, { success: true });
    }
    calls.push({ url, auth: init.headers.authorization, events: JSON.parse(init.body).events });
    return reply(answer.status, answer.body);
  };
  const engine = {
    db,
    tzOffsetMin: 480,
    checked: 0,
    vehicleCal: () => CAL,
    recs: new Map([[IMEI, { v: { name: 'Test truck', hasFuel: true } }]]),
    receiptsStored: () => db.getSetting(RECEIPTS_KEY, []),
    receiptResults: (now) => matchReceipts(engine.receiptsStored(), refuelsFromRows(db.ledgerAlerts()), { calFor: () => CAL, tzMin: 480, now }),
    checkReceipts: () => { engine.checked++; },
  };
  const link = new OpenTeeLink({ cfg: { openTee: { key: KEY, url: 'http://api.test' } }, engine, db, fetchImpl: fakeFetch });

  const insert = (o, now) => db.insertAlert({ key: `k${o.type}${o.t}`, imei: IMEI, name: 'Test truck', severity: 'info', fromT: o.t - 60000, title: 'Refuel', detail: '', historical: false, ongoing: false, ...o }, now);
  for (let i = 0; i < 250; i++) insert({ type: 'refuel', t: T + i * 60000, amountMv: 1000, extra: JSON.stringify({ fromMv: 1000 }) }, T + i);
  insert({ type: 'overspeed', t: T + 999 * 60000 }, T + 300);

  await link.sync();
  check('sends in batches of 200', calls.length === 2 && calls[0].events.length === 200 && calls[1].events.length === 51, calls.map((c) => c.events.length));
  check('uses the key and the events path', calls[0].auth === `Bearer ${KEY}` && calls[0].url === 'http://api.test/api/v1/integrations/fuel-warner/events');
  check('overspeed goes too', calls[1].events.at(-1)?.type === 'OVERSPEED');
  check('no error', link.status.lastError === null, link.status.lastError);

  calls.length = 0;
  await link.sync();
  check('nothing new -> nothing sent', calls.length === 0 && checkCalls.length === 0);

  // a review changes updated_at -> the event is sent again with the verdict
  const id = db.alertIdByKey(`krefuel${T}`);
  db.setReview(id, null, 'Шунхлай баримт', T + 10_000);
  await link.sync();
  check('a changed alert is sent again', calls.length === 1 && calls[0].events.length === 1 && calls[0].events[0].note === 'Шунхлай баримт');

  // ---- driver receipts: pulled, matched against the refuels, results sent back ----
  const at = new Date(T + 2 * 3600e3).toISOString();
  const E1 = '11111111-1111-4111-8111-111111111111';
  const E2 = '22222222-2222-4222-8222-222222222222';
  const E3 = '33333333-3333-4333-8333-333333333333';
  receiptPages = [{ success: true, cursor: 'c1', more: false, receipts: [
    { id: E1, imei: IMEI, plateNumber: '1234УБА', liters: 50, station: 'Шунхлай', at },
    { id: E2, imei: IMEI, plateNumber: '1234УБА', liters: 120, station: 'Шунхлай', at },
    { id: E3, imei: null, plateNumber: '5678УБА', liters: 30, station: '', at },
  ] }];
  await link.sync();
  const stored = engine.receiptsStored();
  check('driver receipts are added to the receipt list', stored.filter((r) => r.source === 'opentee').length === 2 && stored[0].date === '2026-09-30' && stored[0].dateTo === '2026-10-01', stored);
  check('the receipts are checked right away', engine.checked === 1);
  const sent = Object.fromEntries((checkCalls[0] || []).map((c) => [c.id, c]));
  check('receipt that went in fully -> ok', sent[E1]?.status === 'ok' && sent[E1].tankLiters === 50, sent[E1]);
  check('receipt for more than went in -> short, litres missing', sent[E2]?.status === 'short' && sent[E2].missingLiters === 70, sent[E2]);
  check('receipt without a known tracker -> nosensor', sent[E3]?.status === 'nosensor');
  check('the cursor is kept', db.getMeta('opentee.receiptCursor') === 'c1');

  checkCalls.length = 0;
  receiptPages = [{ success: true, cursor: 'c2', more: false, receipts: [{ id: E1, imei: IMEI, plateNumber: '1234УБА', liters: 50, station: 'Шунхлай', at }] }];
  await link.sync();
  check('unchanged receipts and checks are not sent again', checkCalls.length === 0 && engine.checked === 1);

  receiptPages = [{ success: true, cursor: 'c3', more: false, receipts: [{ id: E1, imei: IMEI, plateNumber: '1234УБА', liters: 95, station: 'Шунхлай', at }] }];
  await link.sync();
  check('a corrected receipt is re-checked and sent', checkCalls.length === 1 && checkCalls[0].length === 1 && checkCalls[0][0].status === 'short', checkCalls[0]);

  // API down: the cursor stays, the next try sends it
  calls.length = 0;
  answer = { status: 503, body: { success: false } };
  db.setReview(id, null, 'second note', T + 20_000);
  await link.sync();
  check('API error is reported', link.status.lastError?.includes('503'), link.status.lastError);
  answer = { status: 200, body: { success: true, unmatchedImeis: [IMEI] } };
  await link.sync();
  check('retried after the API came back', calls.length === 2 && calls[1].events[0].note === 'second note');
  check('unknown trackers are remembered', link.status.unmatched.includes(IMEI));

  // a wrong key pauses for 10 minutes
  calls.length = 0;
  answer = { status: 401, body: { success: false } };
  db.setReview(id, null, 'third note', T + 30_000);
  await link.sync();
  await link.sync();
  check('wrong key: one try, then a pause', calls.length === 1 && link.status.lastError.includes('key is wrong'));
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}


