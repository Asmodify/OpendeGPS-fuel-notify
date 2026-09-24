// Downloads fresh test data for tools/replay.mjs and tools/selftest.mjs:
// USER_GET_OBJECTS -> <dir>/objects.json and OBJECT_GET_MESSAGES for every vehicle with a
// fuel sensor (io9) -> <dir>/hist/<imei>.json.
//
//   node --no-warnings tools/fetch-history.mjs [dir] [--hours 48] [--force]
//
// dir defaults to testdata/ (not published). The API key comes from $GPS_API_KEY or
// config.local.json ("apiKey"); the server from $GPS_SERVER or config.json ("server"), default
// https://fms.gpsbox.mn. Each vehicle is one OBJECT_GET_MESSAGES call per day of history.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DATA_DIR } from './lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let dir = DEFAULT_DATA_DIR;
let hours = 48;
let force = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--hours') hours = +args[++i];
  else if (args[i] === '--force') force = true;
  else dir = args[i];
}

let cfg = {};
for (const f of ['config.json', 'config.local.json']) {
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(path.join(root, f), 'utf8').replace(/^﻿/, '')) }; } catch { /* optional */ }
}
const key = process.env.GPS_API_KEY || cfg.apiKey;
const server = (process.env.GPS_SERVER || cfg.server || 'https://fms.gpsbox.mn').replace(/\/$/, '');
if (!key) { console.error('No API key: set GPS_API_KEY or "apiKey" in config.local.json'); process.exit(2); }

const apiDate = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' '); // API times are UTC
async function call(cmd) {
  const url = `${server}/api/api.php?api=user&key=${encodeURIComponent(key)}&cmd=${encodeURIComponent(cmd)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(await res.text());
}

fs.mkdirSync(path.join(dir, 'hist'), { recursive: true });
const objects = await call('USER_GET_OBJECTS');
fs.writeFileSync(path.join(dir, 'objects.json'), JSON.stringify(objects));
const fuel = objects.filter((o) => o.params && o.params.io9 !== undefined);
console.log(`${objects.length} vehicles, ${fuel.length} with a fuel sensor; fetching ${hours} h into ${dir}`);

const to = Date.now();
const from = to - hours * 3_600_000;
let next = 0;
let done = 0;
async function worker() {
  while (next < fuel.length) {
    const o = fuel[next++];
    const file = path.join(dir, 'hist', `${o.imei}.json`);
    if (!force && fs.existsSync(file)) { done++; continue; }
    try {
      const rows = await call(`OBJECT_GET_MESSAGES,${o.imei},${apiDate(from)},${apiDate(to)}`);
      fs.writeFileSync(file, JSON.stringify(Array.isArray(rows) ? rows : []));
      console.log(`  ${++done}/${fuel.length} ${o.imei} ${Array.isArray(rows) ? rows.length : 0} rows`);
    } catch (e) {
      console.log(`  ${o.imei} failed: ${e.message}`);
    }
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);
console.log('done');
