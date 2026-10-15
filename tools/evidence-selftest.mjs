// Self-test for the evidence pack's data (GET /api/alerts/:id/evidence, engine.evidence) and
// for picking alerts by id (the pack's Excel download). Uses a throw-away database; nothing is
// fetched or sent.
//
//   node --no-warnings tools/evidence-selftest.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { Engine } from '../src/engine.js';
import { alertFilterFromQuery, buildAlertSheets, ALERT_IDS_MAX } from '../src/alertsxlsx.js';

let failed = 0;
let passed = 0;
function check(name, ok, info) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info !== undefined ? `  -- ${typeof info === 'string' ? info : JSON.stringify(info)}` : ''}`);
}

const IMEI = '999999061234567';
const MIN = 60e3;
const T0 = Date.UTC(2026, 9, 10, 4, 0); // the drop starts at 12:00 local
const NOW = T0 + 30 * 60 * MIN;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftw-evidence-'));
const db = openDb(dir);
try {
  const cfg = loadConfig({ DATA_DIR: dir, NO_BACKFILL: '1' });
  cfg.excelFile = '';
  cfg.calibrations = { [IMEI]: { tankLiters: 500, table: [[0, 0], [10000, 500]] } };
  const engine = new Engine({ cfg, db, hub: null });
  await engine.loadDetector();
  engine.applyObjects([{
    imei: IMEI, name: '1234ӨМЕ/Түлшний мэдрэгчтэй/', group_name: 'Test', dt_tracker: '2026-10-10 06:00:00', dt_server: '2026-10-10 06:00:00',
    lat: '43.6', lng: '105.5', speed: '0', params: { io9: '6000', io239: '0', io66: '27000' },
  }], NOW);

  // parked from 10:00 to 15:00 local; 12:00-12:40 the power is off and 80 L (1600 mV) go
  const samples = [];
  for (let t = T0 - 2 * 60 * MIN; t <= T0 + 3 * 60 * MIN; t += 2 * MIN) {
    const off = t >= T0 && t < T0 + 40 * MIN;
    samples.push({ t, f: t < T0 ? 6000 : t < T0 + 40 * MIN ? null : 4400, spd: 0, ign: 0, pwr: off ? 0 : 27000, lat: 43.6 + (t % 7) * 1e-6, lng: 105.5, odo: null });
  }
  db.insertSamples(IMEI, samples);
  db.insertLevel?.(IMEI, T0 - 10 * MIN, 6000);

  const id = engine.raiseAlert({
    imei: IMEI, name: '1234ӨМЕ', type: 'fuel_drain', severity: 'critical', t: T0 + 50 * MIN, fromT: T0, lat: 43.61, lng: 105.51,
    title: 'Fuel drop while power was off', detail: 'Fuel fell by 80 L while the power was off.', amountMv: 1600, fromMv: 6000, toMv: 4400,
  }, 'backfill');
  // a drain is held for its 5 h check: settle it
  engine.checkPendingDrains(NOW);
  const ev = engine.evidence(id, NOW);
  check('evidence for a drain', !!ev && ev.alert.id === id && ev.alert.type === 'fuel_drain', ev && ev.alert);
  check('levels before / after in litres', ev?.before?.liters === 300 && ev?.after?.liters === 220, { before: ev?.before, after: ev?.after });
  check('litres lost = the alert amount', ev?.lostL === 80, ev?.lostL);
  check('window covers the event with margins', ev && ev.from <= T0 - 3 * 60 * MIN && ev.to >= T0 + 50 * MIN + 3 * 60 * MIN - 1, { from: ev?.from, to: ev?.to });
  check('samples and track sent', ev?.samples.length > 50 && ev?.track.length > 50 && ev.dataKept === true);
  check('power off time counted', ev?.activity?.powerOffMs === 40 * MIN, ev?.activity);
  check('stood still: no distance, no engine', ev?.activity?.distanceKm === 0 && ev.activity.engineOnMs === 0, ev?.activity);
  check('place = where it stood', ev?.place?.source === 'stop' && Math.abs(ev.place.lat - 43.6) < 1e-3, ev?.place);
  check('vehicle and tank', ev?.vehicle.shortName === '1234ӨМЕ' && ev.vehicle.tankLiters === 500, ev?.vehicle);
  check('unknown alert -> null', engine.evidence(987654, NOW) === null);

  // receipts: a receipt the tank does not account for
  const r = engine.addReceipts({ text: '1234ӨМЕ\t2026-10-10 13:00\t300' }, NOW);
  check('receipt added', r.added === 1, r);
  const rm = engine.queryAlerts({ types: ['receipt_mismatch'], limit: 10 });
  check('receipt without a refuel -> receipt_mismatch alert', rm.length === 1 && rm[0].receipt?.litres === 300 && rm[0].receipt.missing === 300, rm[0]?.receipt);
  const evR = rm.length ? engine.evidence(rm[0].id, NOW + 1) : null;
  check('receipt mismatch evidence: lost = missing litres, receipt listed first', evR?.lostL === 300 && evR.receipts[0]?.main === true && evR.receipts[0].status === 'norefuel', { lostL: evR?.lostL, receipts: evR?.receipts });
  check('drain evidence lists the receipts of those days', engine.evidence(id, NOW + 60e3)?.receipts.length === 1);

  // picking by id
  const rid = rm[0]?.id ?? 0;
  const both = engine.queryAlerts({ ids: [id, rid], limit: 10 });
  check('queryAlerts by ids', both.length === 2 && both.every((a) => [id, rid].includes(a.id)));
  check('empty id list matches nothing', engine.queryAlerts({ ids: [], limit: 10 }).length === 0);
  const q = new URLSearchParams({ ids: `${id},x,-3,${rid},${Array.from({ length: ALERT_IDS_MAX + 5 }, (_, i) => i + 1).join(',')}` });
  const f = alertFilterFromQuery(q, { intParam: (v) => (v ? Number(v) : undefined), listParam: (v) => (v ? v.split(',') : undefined) });
  check('ids parsed, junk dropped, capped', f.ids.length === ALERT_IDS_MAX && f.ids[0] === id && !f.ids.includes(-3), f.ids.length);
  check('no ids -> no id filter', !('ids' in alertFilterFromQuery(new URLSearchParams(''), { intParam: () => undefined, listParam: () => undefined })));
  const sheets = buildAlertSheets({ alerts: both, filter: { ids: [id, rid] }, now: NOW });
  const L = sheets[0].columns.findIndex((c) => c.header === 'Литр');
  check('Excel: receipt mismatch carries its missing litres', sheets[0].rows.some((row) => row[L] === 300), sheets[0].rows.map((row) => row[L]));
  check('Excel: thefts are totalled', sheets[0].totalRow?.[7] === 380, sheets[0].totalRow);
} finally {
  db.close?.();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failed ? 'FAILED' : 'OK'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
