// Self-test for the officer's verdict (src/officer.js via engine.secondOpinions /
// engine.runOfficerSweep): a stubbed officer on a throw-away database. Nothing is fetched or sent.
//
//   node --no-warnings tools/officer-verdict-selftest.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const IMEI = '999999061234501';
const NOW = Date.UTC(2026, 10, 27, 8, 0);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftw-officer-'));
const db = openDb(dir);
try {
  const cfg = loadConfig({ DATA_DIR: dir, NO_BACKFILL: '1' });
  cfg.excelFile = '';
  cfg.calibrations = { [IMEI]: { tankLiters: 500, table: [[0, 0], [10000, 500]] } };
  const engine = new Engine({ cfg, db, hub: null });
  await engine.loadDetector();
  engine.applyObjects([{
    imei: IMEI, name: '1234ӨМЕ/Түлшний мэдрэгчтэй/', group_name: 'Test', dt_tracker: '2026-11-27 06:00:00', dt_server: '2026-11-27 06:00:00',
    lat: '43.6', lng: '105.5', speed: '0', params: { io9: '6000', io239: '0', io66: '25500' },
  }], NOW);
  engine.historyReady = true;

  const drain = (t, detail) => engine.raiseAlert({ imei: IMEI, name: '1234ӨМЕ', type: 'fuel_drain', severity: 'warning', t, fromT: t - 30 * MIN, title: 'Fuel drop while parked', detail, amountMv: 1200 }, 'live');
  const a1 = drain(NOW - 10 * HOUR, 'case 1');
  const a2 = drain(NOW - 9 * HOUR, 'case 2');
  const a3 = drain(NOW - 8 * HOUR, 'case 3');
  const aFresh = drain(NOW - 1 * HOUR, 'too fresh');
  // an earlier case a person already judged, with a note: shown to the officer as an example
  const aOld = drain(NOW - 20 * HOUR, 'judged by a person');
  engine.reviewAlert(aOld, { verdict: 'false_alarm', note: 'busad mahindaa ogson' });

  const answers = {
    'case 1': { view: 'likely_normal', confidence: 85, verdict: 'false_alarm', note: 'Явж байхад хэвийн зарцуулалт' },
    'case 2': { view: 'likely_theft', confidence: 90, verdict: 'confirmed', note: 'Зогсоолд 60 л буурч эргэж ирээгүй' },
    'case 3': { view: 'unclear', confidence: 50, verdict: 'unchecked', note: '' },
  };
  const asked = [];
  engine.secondOpinionFn = async (input) => {
    asked.push(input);
    const key = Object.keys(answers).find((k) => input.detail.includes(k));
    const a = answers[key] || { view: 'unclear', confidence: 40, verdict: 'unchecked', note: '' };
    return { ...a, label: a.view, reason: 'Шалгалт.', checks: [], model: 'test' };
  };

  const n = engine.runOfficerSweep(NOW);
  await engine.officerChain;
  const v = (id) => engine.alertView(db.getAlert(id));
  check('sweep: asks about settled drops nobody marked, skips a fresh one and a judged one', n === 3 && asked.length === 3 && !asked.some((x) => x.detail.includes('too fresh')), { n, asked: asked.length });
  check('sweep: the person\'s earlier verdict and note are sent as an example', asked[0]?.examples?.some((e) => e[2] === 'Худал дохио' && e[3] === 'busad mahindaa ogson'), asked[0]?.examples);
  check('officer marks a false alarm, with its note, as the officer\'s', v(a1).verdict === 'false_alarm' && v(a1).reviewedBy === 'officer' && v(a1).note === 'Явж байхад хэвийн зарцуулалт', v(a1));
  check('officer marks a theft', v(a2).verdict === 'confirmed' && v(a2).reviewedBy === 'officer');
  check('an unsure case stays unchecked', v(a3).verdict === 'unchecked' && v(a3).reviewedBy === null);
  check('the opinion line is added to the text once', (db.getAlert(a1).detail.match(/Хоёр дахь дүгнэлт/g) || []).length === 1, db.getAlert(a1).detail);
  check('a person\'s earlier verdict stays the person\'s', v(aOld).verdict === 'false_alarm' && v(aOld).reviewedBy === 'person');

  // a person's click replaces the officer's verdict; a note alone keeps who gave it
  engine.reviewAlert(a2, { note: 'Жолоочоос асуусан' });
  check('a note alone keeps the officer as the reviewer', v(a2).reviewedBy === 'officer' && v(a2).note === 'Жолоочоос асуусан');
  engine.reviewAlert(a2, { verdict: 'false_alarm' });
  check('a person\'s verdict replaces the officer\'s', v(a2).verdict === 'false_alarm' && v(a2).reviewedBy === 'person');

  // nothing is asked twice; the hourly gate holds
  check('sweep: not again within the hour', engine.runOfficerSweep(NOW + 10 * MIN) === null);
  const again = engine.runOfficerSweep(NOW + 2 * HOUR);
  await engine.officerChain;
  check('sweep: an hour later only the drop that has since settled is asked', again === 1 && asked.length === 4 && asked[3].detail.includes('too fresh'), { again, asked: asked.length });

  // a person's verdict arriving while the officer is thinking wins
  const a4 = drain(NOW - 5 * HOUR, 'case 2 race');
  engine.secondOpinionFn = async () => {
    engine.reviewAlert(a4, { verdict: 'false_alarm' });
    return { view: 'likely_theft', label: 'x', confidence: 95, verdict: 'confirmed', note: 'x', reason: 'x', checks: [], model: 'test' };
  };
  await engine.secondOpinions([a4]);
  check('a person who marked it meanwhile is not overwritten', v(a4).verdict === 'false_alarm' && v(a4).reviewedBy === 'person');

} finally {
  db.close?.();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failed ? 'FAILED' : 'OK'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
