// Small shared helpers: logging, numbers, names, time and distance formatting.
import fs from 'node:fs';

// ---- logging -----------------------------------------------------------------
let logFile = null;
let logLines = 0;
const LOG_MAX_BYTES = 5 * 1024 * 1024;

export function setLogFile(file) {
  logFile = file;
}

function fmtArg(a) {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

export function log(level, ...args) {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${args.map(fmtArg).join(' ')}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
  if (!logFile) return;
  try {
    // rotate once the file gets big (checked every 200 lines to keep it cheap)
    if (++logLines % 200 === 0 && fs.existsSync(logFile) && fs.statSync(logFile).size > LOG_MAX_BYTES) {
      fs.renameSync(logFile, logFile + '.1');
    }
    fs.appendFileSync(logFile, line + '\n');
  } catch {
    /* logging must never throw */
  }
}

/** Short, human readable error text (fetch errors hide the real reason in `cause`). */
export function errText(e) {
  if (!e) return 'unknown error';
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'request timed out';
  let msg = e.message || String(e);
  const c = e.cause;
  if (c) msg += ` (${c.code || c.message || c})`;
  return msg;
}

// ---- numbers -----------------------------------------------------------------
/** Parse API string values; '' / undefined / non-numeric -> null. */
export function num(x) {
  if (x === undefined || x === null || x === '') return null;
  const n = typeof x === 'number' ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

export function int01(x) {
  const n = num(x);
  if (n === null) return null;
  return n ? 1 : 0;
}

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

export function round(x, digits = 0) {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

// ---- API dates (always UTC "YYYY-MM-DD HH:MM:SS") ----------------------------
export function toApiDate(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

export function fromApiDate(s) {
  if (!s || typeof s !== 'string' || s.startsWith('0000')) return null;
  const t = Date.parse(s.trim().replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? t : null;
}

// ---- names -------------------------------------------------------------------
// Vehicle names embed "/Түлшний мэдрэгчтэй/" ("with fuel sensor"), sometimes misspelled
// or lower-case; strip any "/…түлш…/" segment for the short display name.
const FUEL_SUFFIX = /\s*\/[^/]*т[үу]лш[^/]*(\/|$)/giu;

export function shortName(name) {
  if (name === null || name === undefined) return '';
  const full = String(name).trim();
  const s = full.replace(FUEL_SUFFIX, ' ').replace(/\s+/g, ' ').trim();
  return s || full;
}

// ---- geo ---------------------------------------------------------------------
export function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---- time formatting -----------------------------------------------------------
export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60} min`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}

const fmtCache = new Map();
/** "24 Sep 11:20" in the given IANA time zone. */
export function fmtLocal(ms, timeZone) {
  let f = fmtCache.get(timeZone);
  if (!f) {
    const opts = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
    try {
      f = new Intl.DateTimeFormat('en-US', { ...opts, timeZone });
    } catch {
      f = new Intl.DateTimeFormat('en-US', opts);
    }
    fmtCache.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.day} ${p.month} ${p.hour}:${p.minute}`;
}

/** UTC offset (minutes) of an IANA zone at a given moment, e.g. Asia/Ulaanbaatar -> 480. */
export function tzOffsetMinutes(timeZone, at = Date.now()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    }).formatToParts(new Date(at));
    const g = (t) => Number(parts.find((p) => p.type === t).value);
    const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'));
    return Math.round((asUtc - Math.floor(at / 60000) * 60000) / 60000);
  } catch {
    return 480;
  }
}

/** "HH:MM" -> minutes after midnight, or null. */
export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// ---- async ---------------------------------------------------------------------
/** Run fn over items with at most n in flight. fn must handle its own errors. */
export async function mapPool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

export function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/** Recursive merge of plain objects (arrays and scalars replace). */
export function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}
