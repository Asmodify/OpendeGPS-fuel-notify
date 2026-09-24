// Small shared helpers: safe HTML templating, formatting, API calls, fuel unit maths.

// ---------- Safe HTML ----------
// `html` is a tagged template that escapes every interpolated value unless it is
// already a Raw (produced by html`` itself or raw()). Arrays are joined.
export class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = (s) => new Raw(String(s));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ESC[c]);
function part(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(part).join('');
  return esc(v);
}
export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += part(vals[i]) + strings[i + 1];
  return new Raw(out);
}
export function setHTML(el, content) {
  if (el) el.innerHTML = content instanceof Raw ? content.s : esc(content ?? '');
}
export const icon = (name, cls = '') => raw(`<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`);

// ---------- DOM ----------
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---------- Time (always rendered in the browser's local time zone) ----------
const fTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fTimeSec = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const fDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const fDayTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fFull = new Intl.DateTimeFormat(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const fDate = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const fLongDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

export const toMs = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const p = Date.parse(v);
  return Number.isFinite(p) ? p : null;
};
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Compact local time: "14:05" today, "Sep 23, 14:05" this year, "Mar 1, 2025" older. */
export function fmtTime(ms, now = Date.now()) {
  ms = toMs(ms);
  if (ms == null) return '—';
  const d = new Date(ms), n = new Date(now);
  if (sameDay(d, n)) return fTime.format(d);
  if (Math.abs(now - ms) < 300 * 864e5) return fDayTime.format(d);
  return fDate.format(d);
}
export const fmtClock = (ms) => (toMs(ms) == null ? '—' : fTime.format(new Date(toMs(ms))));
export const fmtClockSec = (ms) => (toMs(ms) == null ? '—' : fTimeSec.format(new Date(toMs(ms))));
export const fmtFull = (ms) => (toMs(ms) == null ? '—' : fFull.format(new Date(toMs(ms))));
export const fmtDayShort = (ms) => fDay.format(new Date(ms));
export const fmtDayTime = (ms) => fDayTime.format(new Date(ms));
export function fmtDayHeading(ms, now = Date.now()) {
  const d = new Date(ms), n = new Date(now);
  if (sameDay(d, n)) return 'Today';
  const y = new Date(now - 864e5);
  if (sameDay(d, y)) return 'Yesterday';
  return fLongDay.format(d);
}
export const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

/** "just now", "5 min ago", "3 h ago", "2 d ago", "4 mo ago", "over a year ago" */
export function fmtRel(ms, now = Date.now()) {
  ms = toMs(ms);
  if (ms == null) return 'never';
  const s = (now - ms) / 1000;
  if (s < 45) return 'just now';
  const m = s / 60;
  if (m < 60) return `${Math.round(m)} min ago`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)} h ago`;
  const d = h / 24;
  if (d < 60) return `${Math.round(d)} d ago`;
  const mo = d / 30.4;
  if (mo < 12) return `${Math.round(mo)} mo ago`;
  return 'over a year ago';
}
export function fmtDur(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 48) return r ? `${h} h ${r} min` : `${h} h`;
  return `${Math.round(h / 24)} d`;
}

// ---------- Numbers ----------
const nfCache = new Map();
export function fmtNum(n, digits = 0) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  let f = nfCache.get(digits);
  if (!f) { f = new Intl.NumberFormat(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits }); nfCache.set(digits, f); }
  return f.format(Number(n));
}
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

// ---------- Fuel maths ----------
export const DEFAULT_CAL = { emptyMv: 0, fullMv: 10000, tankLiters: null };
export function normCal(cal) {
  const c = { ...DEFAULT_CAL, ...(cal || {}) };
  c.emptyMv = isNum(c.emptyMv) ? Number(c.emptyMv) : 0;
  c.fullMv = isNum(c.fullMv) ? Number(c.fullMv) : 10000;
  if (c.fullMv === c.emptyMv) c.fullMv = c.emptyMv + 1;
  c.tankLiters = isNum(c.tankLiters) && Number(c.tankLiters) > 0 ? Number(c.tankLiters) : null;
  return c;
}
/** Litres from the GPS server's piecewise tank table [[mV, litres], ...] (sorted by mV);
 *  the end segments are extended so sloshing readings outside the table stay visible. */
function tableLitres(mv, tb) {
  let i = 1;
  while (i < tb.length - 1 && mv > tb[i][0]) i++;
  const [x0, y0] = tb[i - 1];
  const [x1, y1] = tb[i];
  return x1 === x0 ? y1 : y0 + ((mv - x0) * (y1 - y0)) / (x1 - x0);
}
const validTable = (cal) => (Array.isArray(cal?.table) && cal.table.length >= 2 ? cal.table : null);
/** mV → % of tank (not clamped, so sloshing readings can exceed 100). Uses the vehicle's
 *  tank table when the server sent one (cal.table), otherwise the linear empty/full points. */
export const mvToPct = (mv, cal) => {
  if (!isNum(mv)) return null;
  const tb = validTable(cal);
  if (tb) {
    const full = cal.tankLiters || Math.max(...tb.map((p) => p[1]));
    if (full > 0) return (tableLitres(Number(mv), tb) / full) * 100;
  }
  return ((mv - cal.emptyMv) / (cal.fullMv - cal.emptyMv)) * 100;
};
/** mV difference → litres (null if tank size unknown) */
export const dMvToL = (dmv, cal) => (isNum(dmv) && cal.tankLiters ? (dmv / (cal.fullMv - cal.emptyMv)) * cal.tankLiters : null);
export const dMvToPct = (dmv, cal) => (isNum(dmv) ? (dmv / (cal.fullMv - cal.emptyMv)) * 100 : null);

/** Human amount for a fuel delta: "35 L" / "6.2 % of tank", with mV as secondary. */
export function fuelAmount(dmv, cal, litres) {
  if (!isNum(dmv) && !isNum(litres)) return null;
  const L = isNum(litres) ? Number(litres) : dMvToL(dmv, cal);
  const pct = isNum(dmv) ? Math.abs(dMvToPct(dmv, cal)) : null;
  if (L != null) return { main: `${fmtNum(Math.abs(L), 0)} L`, sub: pct != null ? `${fmtNum(pct, 1)}% · ${fmtNum(Math.abs(dmv))} mV` : '' };
  return { main: `${fmtNum(pct, 1)}%`, sub: `${fmtNum(Math.abs(dmv))} mV` };
}

// ---------- API ----------
export class ApiError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}
// Cloud version: called when the server answers 401 (not signed in / session expired).
let loginRequired = null;
export function onLoginRequired(fn) { loginRequired = fn; }

export async function api(path, { method = 'GET', body, timeout = 20000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: ctl.signal,
    });
  } catch (e) {
    throw new ApiError(e.name === 'AbortError' ? 'Request timed out' : 'Cannot reach the server', 0);
  } finally {
    clearTimeout(timer);
  }
  const txt = await res.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (!res.ok) {
    if (res.status === 401 && loginRequired) { try { loginRequired(); } catch { /* ignore */ } }
    const msg = (data && typeof data === 'object' && (data.error || data.message)) || `Server error (HTTP ${res.status})`;
    throw new ApiError(String(msg), res.status);
  }
  return data;
}

// ---------- Local preferences (per browser; never required) ----------
export function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem('ftw.' + key);
    return v === null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
export function savePref(key, value) {
  try { localStorage.setItem('ftw.' + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

export function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Download text as a file (used for CSV export). */
export function downloadText(filename, text, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
