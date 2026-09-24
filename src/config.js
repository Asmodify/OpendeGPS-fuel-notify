// Loads config.json (or $CONFIG), fills in defaults and applies environment overrides.
// Settings changed from the dashboard are stored in the database and layered on top
// of this base config at runtime (see engine.js); config.json itself is never rewritten.
//
// Secrets never go in config.json (it is published): the GPS API key comes from the
// environment variable GPS_API_KEY, else from config.local.json next to config.json (not
// published; any other setting may be put there too and wins over config.json).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepMerge, isPlainObject } from './util.js';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_THRESHOLDS = Object.freeze({
  drainParkedMv: 300,
  drainTripMv: 600,
  consumptionMvPerHour: 600,
  refuelMv: 300,
  sensorMinValidMv: 100,
  lowFuelPct: 10,
  overspeedKmh: 90,
  idleMinutes: 30,
  offlineMinutes: 60,
  powerCutMv: 5000,
  afterHoursEnabled: false,
  afterHoursStart: '22:00',
  afterHoursEnd: '06:00',
});

export const DEFAULT_CALIBRATION = Object.freeze({ emptyMv: 0, fullMv: 10000, tankLiters: null });

const DEFAULTS = {
  server: 'https://fms.gpsbox.mn',
  apiKey: '',
  host: '127.0.0.1',
  port: 8080,
  // "Check every": how often the GPS server is asked (minutes, 5..120; changeable in the
  // dashboard's Settings, which wins over this): one USER_GET_OBJECTS call for the whole fleet,
  // then OBJECT_GET_MESSAGES for each vehicle that has new data (its complete history since the
  // last stored sample, so nothing is missed - alerts are only delayed by up to this long), then
  // the server's events. Offline judgements use the trackers' own report times, so a long
  // interval does not make vehicles look offline.
  checkEveryMinutes: 30,
  // "full": every stored row of a vehicle that drove or ran its engine (one OBJECT_GET_MESSAGES
  // per check for it; parked vehicles come from the objects poll for free);
  // "gaps": the objects poll's one point a minute, messages only after a jump > 3 min (far fewer
  // calls, but it misses fuel drains; see poller.js). gapFetchesPerCycle caps the "gaps" calls.
  messagesMode: 'full',
  gapFetchesPerCycle: 10,
  // history fetched at start-up (from the last stored message, at most this far back): a
  // week, so the Excel fuel ledger starts with a week of refuels and thefts
  backfillHours: 168,
  // Stored samples replayed into the detectors at start-up so they resume with the same state
  // as before a restart (trusted level, learned consumption, "sensor never worked" judgement,
  // which needs ~90 min of driving to be seen). Should cover at least backfillHours.
  replayHours: 48,
  keepHours: 168,
  keepDays: 90,
  apiConcurrency: 4,
  apiTimeoutSeconds: 90,
  // Parked trackers only report about once an hour; a vehicle whose last report was
  // stationary is given this much extra time before it is called "offline".
  parkedReportMinutes: 65,
  // per-vehicle sensor mV -> litres tables exported from the GPS server (optional)
  calibrationsFile: 'calibrations.json',
  // Excel fuel ledger (every refuel and suspected theft), rewritten automatically; relative to
  // this folder; "" = don't write a file (the dashboard download still works)
  excelFile: 'Fuel events.xlsx',
  timezone: 'Asia/Ulaanbaatar',
  fuelParam: 'io9',
  ignitionParam: 'io239',
  powerParam: 'io66',
  odometerParam: 'io16',
  thresholds: { ...DEFAULT_THRESHOLDS },
  defaultCalibration: { ...DEFAULT_CALIBRATION },
  notify: {
    windowsToast: true,
    severities: ['critical', 'warning'],
    throttleMinutes: 10,
  },
};

function readJson(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

function posNum(x, fallback, min = 0) {
  const n = Number(x);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export const CHECK_MIN_MINUTES = 5;
export const CHECK_MAX_MINUTES = 120;

/** "Check every" minutes within the allowed range (whole minutes); fallback when not a number. */
export function clampCheckMinutes(x, fallback = 30) {
  const n = Number(x);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(CHECK_MAX_MINUTES, Math.max(CHECK_MIN_MINUTES, Math.round(n)));
}

export function loadConfig(env = process.env) {
  const configPath = path.resolve(env.CONFIG || path.join(ROOT_DIR, 'config.json'));
  let fileCfg = {};
  let configError = null;
  if (fs.existsSync(configPath)) {
    try {
      fileCfg = readJson(configPath);
      if (!isPlainObject(fileCfg)) throw new Error('top level must be a JSON object');
    } catch (e) {
      configError = `Cannot read ${configPath}: ${e.message}`;
      fileCfg = {};
    }
  } else {
    configError = `Config file not found: ${configPath} (using defaults)`;
  }
  // config.local.json (next to the config file): the API key and any private overrides
  const localPath = path.join(path.dirname(configPath), 'config.local.json');
  if (fs.existsSync(localPath)) {
    try {
      const local = readJson(localPath);
      if (!isPlainObject(local)) throw new Error('top level must be a JSON object');
      fileCfg = deepMerge(fileCfg, local);
    } catch (e) {
      configError = [configError, `Cannot read ${localPath}: ${e.message}`].filter(Boolean).join('; ');
    }
  }
  if (isPlainObject(fileCfg.notify)) delete fileCfg.notify.telegram; // (removed feature)

  const cfg = deepMerge(DEFAULTS, fileCfg);
  if (env.GPS_API_KEY) cfg.apiKey = env.GPS_API_KEY.trim();
  if (env.GPS_SERVER) cfg.server = env.GPS_SERVER.trim();
  cfg.apiKey = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
  // keep only the threshold keys we know about plus any extra numeric/boolean keys
  cfg.thresholds = { ...DEFAULT_THRESHOLDS, ...(isPlainObject(fileCfg.thresholds) ? fileCfg.thresholds : {}) };
  cfg.defaultCalibration = { ...DEFAULT_CALIBRATION, ...(isPlainObject(fileCfg.defaultCalibration) ? fileCfg.defaultCalibration : {}) };

  if (env.PORT) cfg.port = Number(env.PORT);
  if (env.HOST) cfg.host = env.HOST;
  cfg.port = posNum(cfg.port, 8080, 1);
  // older config files: pollObjectsSeconds instead of checkEveryMinutes
  if (fileCfg.checkEveryMinutes === undefined && Number(fileCfg.pollObjectsSeconds) > 0) cfg.checkEveryMinutes = Number(fileCfg.pollObjectsSeconds) / 60;
  cfg.checkEveryMinutes = clampCheckMinutes(cfg.checkEveryMinutes, 30);
  delete cfg.pollObjectsSeconds;
  delete cfg.pollMessagesSeconds;
  delete cfg.pollEventsSeconds;
  if (cfg.messagesMode !== 'gaps') cfg.messagesMode = 'full';
  cfg.gapFetchesPerCycle = Math.round(posNum(cfg.gapFetchesPerCycle, 10, 1));
  cfg.backfillHours = posNum(cfg.backfillHours, 168, 0);
  cfg.replayHours = posNum(cfg.replayHours, 48, 0);
  cfg.keepHours = posNum(cfg.keepHours, 168, 1);
  cfg.keepDays = posNum(cfg.keepDays, 90, 1);
  cfg.apiConcurrency = Math.round(posNum(cfg.apiConcurrency, 4, 1));
  cfg.apiTimeoutSeconds = posNum(cfg.apiTimeoutSeconds, 90, 5);
  cfg.parkedReportMinutes = posNum(cfg.parkedReportMinutes, 65, 0);
  if (!Array.isArray(cfg.notify.severities)) cfg.notify.severities = ['critical', 'warning'];

  cfg.dataDir = path.resolve(env.DATA_DIR || path.join(ROOT_DIR, 'data'));
  const excel = env.EXCEL_FILE !== undefined && env.EXCEL_FILE !== '' ? env.EXCEL_FILE : cfg.excelFile;
  cfg.excelFile = typeof excel === 'string' && excel.trim() ? path.resolve(ROOT_DIR, excel.trim()) : null;
  if (cfg.excelFile && !/\.xlsx$/i.test(cfg.excelFile)) cfg.excelFile += '.xlsx';
  cfg.noBackfill = env.NO_BACKFILL === '1' || env.NO_BACKFILL === 'true';
  cfg.openBrowser = env.OPEN_BROWSER === '1' || env.OPEN_BROWSER === 'true';
  cfg.configPath = configPath;
  cfg.configError = configError;
  cfg.publicDir = path.join(ROOT_DIR, 'public');
  const cal = loadCalibrations(cfg.calibrationsFile ? path.resolve(ROOT_DIR, cfg.calibrationsFile) : null);
  cfg.calibrations = cal.vehicles;
  cfg.calibrationsError = cal.error;
  return cfg;
}

/**
 * calibrations.json: { tables: { name: [[mV, litres], ...] }, vehicles: { imei: { table: name } } }
 * Returns { vehicles: { imei: { emptyMv, fullMv, tankLiters, table } }, error }. The linear
 * emptyMv/fullMv/tankLiters come from the table's first and last points; `table` is kept for
 * exact litre conversion.
 */
export function loadCalibrations(file) {
  const out = { vehicles: {}, error: null };
  if (!file || !fs.existsSync(file)) return out;
  try {
    const j = readJson(file);
    const tables = {};
    for (const [name, pts] of Object.entries(isPlainObject(j.tables) ? j.tables : {})) {
      if (!Array.isArray(pts)) continue;
      const clean = pts
        .filter((p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
        .map((p) => [Number(p[0]), Number(p[1])])
        .sort((a, b) => a[0] - b[0]);
      if (clean.length >= 2 && clean[clean.length - 1][0] > clean[0][0] && clean[clean.length - 1][1] > 0) tables[name] = clean;
    }
    for (const [imei, v] of Object.entries(isPlainObject(j.vehicles) ? j.vehicles : {})) {
      const pts = tables[v?.table];
      if (!pts) continue;
      out.vehicles[String(imei)] = {
        emptyMv: pts[0][0],
        fullMv: pts[pts.length - 1][0],
        tankLiters: Math.max(...pts.map((p) => p[1])),
        table: pts,
      };
    }
  } catch (e) {
    out.error = `Cannot read ${file}: ${e.message}`;
  }
  return out;
}
