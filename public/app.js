// Fuel Tank Warner — dashboard (vanilla JS, no build step).
// Consumes only the HTTP API documented in README / the interface contract.
import {
  html, raw, esc, setHTML, icon, $, $$, fmtTime, fmtFull, fmtRel, fmtDur, fmtDayHeading, dayKey,
  fmtNum, clamp, isNum, toMs, normCal, mvToPct, dMvToL, dMvToPct, fuelAmount, api, loadPref, savePref,
  debounce, downloadText, csvCell, onLoginRequired,
} from './util.js';
import { FuelChart } from './chart.js';

const HOUR = 3600e3;
const SEVS = ['critical', 'warning', 'info'];
const SEV_LABEL = { critical: 'Critical', warning: 'Warning', info: 'Info', good: 'Done' };
const SEV_ICON = { critical: 'octagon', warning: 'triangle', info: 'info', good: 'check' };
const FALLBACK_TYPES = {
  fuel_drain: { severity: 'critical', label: 'Fuel drain' },
  power_cut: { severity: 'critical', label: 'Tracker power cut' },
  sensor_lost: { severity: 'warning', label: 'Fuel sensor lost' },
  low_fuel: { severity: 'warning', label: 'Low fuel' },
  long_idle: { severity: 'warning', label: 'Long idle' },
  overspeed: { severity: 'warning', label: 'Overspeed' },
  offline: { severity: 'warning', label: 'Offline' },
  server_event: { severity: 'warning', label: 'GPS server event' },
  after_hours: { severity: 'warning', label: 'After-hours movement' },
  refuel: { severity: 'info', label: 'Refuel' },
  sensor_restored: { severity: 'info', label: 'Sensor restored' },
  power_restored: { severity: 'info', label: 'Power restored' },
  back_online: { severity: 'info', label: 'Back online' },
};
const TYPE_ICON = {
  fuel_drain: 'drop-down', refuel: 'drop-up', power_cut: 'bolt-off', power_restored: 'bolt', sensor_lost: 'sensor-off',
  sensor_restored: 'sensor', low_fuel: 'fuel', long_idle: 'clock', overspeed: 'gauge', offline: 'wifi-off',
  back_online: 'wifi', server_event: 'server', after_hours: 'moon',
};
// Owner's verdict on a fuel drain (saved in the Excel fuel ledger)
const VERDICTS = { unchecked: 'Unchecked', confirmed: 'Confirmed theft', false_alarm: 'False alarm' };
const LEDGER_TYPES = ['refuel', 'fuel_drain'];
const NOTE_MAX = 500;
const STATUS = {
  moving: { label: 'Moving', long: 'Driving now', order: 0 },
  idle: { label: 'Idle', long: 'Idle — engine on, not moving', order: 1 },
  parked: { label: 'Parked', long: 'Parked — engine off', order: 2 },
  offline: { label: 'Offline', long: 'Not reporting', order: 3 },
};

// Alert rule definitions (global settings form + per-vehicle overrides)
const RULES = [
  {
    group: 'Fuel', items: [
      { k: 'drainParkedMv', label: 'Fuel drop while parked', unit: 'mV', min: 50, max: 5000, step: 10, eq: true,
        help: 'Critical alert when the settled fuel level falls by more than this while the vehicle stands still — including when the battery switch was off and the level is lower after power comes back. The litres this means for your tanks are shown next to the box.' },
      { k: 'drainTripMv', label: 'Unexplained loss on a trip', unit: 'mV', min: 100, max: 10000, step: 10, eq: true,
        help: 'Critical alert when, after a trip, the tank holds less than expected (engine hours × normal consumption) by more than this.' },
      { k: 'consumptionMvPerHour', label: 'Normal consumption', unit: 'mV / hour', min: 10, max: 5000, step: 10, eq: true, per: '/h',
        help: 'How much the level normally falls per hour of engine running. Used to judge whether a trip used too much; heavy consumers get a higher allowance learned from their own trips, never a lower one. A typical truck uses about 400–600.' },
      { k: 'refuelMv', label: 'Refuel detected above', unit: 'mV', min: 50, max: 5000, step: 10, eq: true,
        help: 'A rise of the settled level bigger than this is logged as a refuel (information only).' },
      { k: 'lowFuelPct', label: 'Low fuel warning below', unit: '% of tank', min: 0, max: 100, step: 1,
        help: 'Warning when the tank is emptier than this.' },
    ],
  },
  {
    group: 'Sensor and tracker power', items: [
      { k: 'sensorMinValidMv', label: 'Fuel sensor dead below', unit: 'mV', min: 0, max: 2000, step: 1,
        help: 'A reading under this value while the tracker has power means the fuel sensor is disconnected or broken (warning). Dead sensors typically read 0, 43 or 87 mV.' },
      { k: 'powerCutMv', label: 'Tracker power lost below', unit: 'mV', min: 0, max: 30000, step: 100,
        help: 'If the tracker’s external supply drops below this while the vehicle is moving, someone may have disconnected it (critical). 24 V trucks normally read 24 000–28 000 mV. Power going off while parked (battery master switch) is normal and not alerted.' },
    ],
  },
  {
    group: 'Driving', items: [
      { k: 'overspeedKmh', label: 'Speed limit', unit: 'km/h', min: 10, max: 250, step: 1, help: 'Warning when a vehicle drives faster than this.' },
      { k: 'idleMinutes', label: 'Long idle after', unit: 'minutes', min: 1, max: 1440, step: 1, help: 'Warning when the engine runs without the vehicle moving for longer than this (wastes fuel).' },
      { k: 'offlineMinutes', label: 'Offline after', unit: 'minutes', min: 5, max: 10080, step: 1, help: 'Warning when a vehicle that was reporting goes silent for longer than this. Vehicles that went silent while the program was not running are recorded as history, without a pop-up.' },
    ],
  },
  {
    group: 'Night-time movement', items: [
      { k: 'afterHoursEnabled', type: 'bool', label: 'Warn when a vehicle moves at night', help: 'Useful if vehicles should stay parked overnight.' },
      { k: 'afterHoursStart', type: 'time', label: 'Night starts at', help: 'Local time.' },
      { k: 'afterHoursEnd', type: 'time', label: 'Night ends at', help: 'Local time.' },
    ],
  },
];
const RULE_BY_KEY = Object.fromEntries(RULES.flatMap((g) => g.items).map((r) => [r.k, r]));
const OVERRIDE_KEYS = ['drainParkedMv', 'drainTripMv', 'consumptionMvPerHour', 'refuelMv', 'lowFuelPct', 'sensorMinValidMv', 'powerCutMv', 'overspeedKmh', 'idleMinutes', 'offlineMinutes'];

// ---------------------------------------------------------------- state
const S = {
  view: null,
  meta: { alertTypes: FALLBACK_TYPES, groups: [] },
  // 'local' (Windows program, live updates over SSE) or 'cloud' (Vercel: polled, sign-in)
  mode: 'local',
  features: { sse: true, windowsToast: true, excelFile: true, openFolder: true },
  needLogin: false,
  skew: 0,
  vehicles: [],
  byImei: new Map(),
  vehiclesLoaded: false,
  vehiclesError: null,
  status: null,
  serverDown: false,
  settings: null,
  conn: 'connecting',
  es: null,
  sseDropped: false,
  fleet: { q: '', group: '', status: '', fuel: false, problems: false, sort: 'alerts', dir: -1, ...pick(loadPref('fleet', {}), ['group', 'status', 'fuel', 'problems', 'sort', 'dir']) },
  map: { filter: loadPref('mapFilter', 'all'), names: loadPref('mapNames', false) },
  alerts: {
    list: [], loading: false, error: null, hasMore: false, loaded: false, newIds: new Set(),
    f: savedAlertFilters(),
    temp: null, // { label }: a shortcut (counter badge, "All alerts for this vehicle") is showing its own filter
  },
  report: { hours: 24, rows: null, loading: false, error: null, sort: 'used', dir: -1, loadedAt: 0 },
  seen: new Set(),
  prefs: { sound: loadPref('sound', true), bsev: loadPref('bsev', ['critical', 'warning']), theme: loadPref('theme', 'auto') },
  detail: null,
  lastFocus: null,
};
function savedAlertFilters() {
  return { sev: [...SEVS], type: '', imei: '', range: 72, unacked: false, ...pick(loadPref('alertFilters', {}), ['sev', 'type', 'imei', 'range', 'unacked']) };
}
function pick(o, keys) {
  const out = {};
  if (o && typeof o === 'object') for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}
const now = () => Date.now() + S.skew;
const typeInfo = (t) => S.meta.alertTypes?.[t] || FALLBACK_TYPES[t] || { severity: 'warning', label: String(t || 'Alert').replace(/_/g, ' ') };
const typeLabel = (t) => typeInfo(t).label;
const shortName = (n) => String(n ?? '').replace(/\s*\/?\s*Түлш(?:ний)?\s+мэдрэгчтэй\s*\/?\s*/giu, ' ').trim();
const groupKey = (g) => (g === null || g === undefined || g === '' ? '__none' : String(g));
const groupLabel = (g) => (g === null || g === undefined || g === '' ? 'No group' : String(g));
const vName = (imei, fallback) => S.byImei.get(String(imei))?.shortName || shortName(fallback) || String(imei ?? '');
const aName = (a) => S.byImei.get(a.imei)?.shortName || a.shortName || shortName(a.name) || a.imei || 'GPS server';
const validLatLng = (v) => isNum(v.lat) && isNum(v.lng) && !(Number(v.lat) === 0 && Number(v.lng) === 0) && Math.abs(v.lat) <= 90 && Math.abs(v.lng) <= 180;
const calFor = (imei) => S.byImei.get(String(imei))?.cal || normCal(S.settings?.vehicles?.[imei]?.cal);
const thFor = (imei) => ({ ...(S.settings?.thresholds || {}), ...(S.settings?.vehicles?.[imei]?.th || {}) });

// ---------------------------------------------------------------- normalisation
function normVehicle(v) {
  const o = { ...v };
  o.imei = String(v.imei);
  o.name = String(v.name ?? '');
  o.shortName = v.shortName ? String(v.shortName) : shortName(v.name) || o.imei;
  o.lastSeen = toMs(v.lastSeen);
  o.activeAlerts = { critical: 0, warning: 0, info: 0, ...(v.activeAlerts || {}) };
  o.cal = normCal(v.cal || S.settings?.vehicles?.[o.imei]?.cal);
  o.status = STATUS[v.status] ? v.status : 'offline';
  o.lat = isNum(v.lat) ? Number(v.lat) : null;
  o.lng = isNum(v.lng) ? Number(v.lng) : null;
  o.speed = isNum(v.speed) ? Number(v.speed) : null;
  o.angle = isNum(v.angle) ? Number(v.angle) : 0;
  o.ign = isNum(v.ign) ? Number(v.ign) : null;
  o.pwrMv = isNum(v.pwrMv) ? Number(v.pwrMv) : null;
  o.hasFuel = !!v.hasFuel;
  o.muted = !!v.muted;
  o.fuel = v.fuel && typeof v.fuel === 'object' ? { ...v.fuel, trustedAt: toMs(v.fuel.trustedAt), mv: isNum(v.fuel.mv) ? Number(v.fuel.mv) : null } : null;
  o.idleSince = toMs(v.idleSince);
  o._search = [o.shortName, o.name, o.imei, o.group, o.device, o.plate].filter(Boolean).join(' ').toLowerCase();
  return o;
}
function normAlert(a) {
  const o = { ...a };
  o.t = toMs(a.t);
  o.fromT = toMs(a.fromT);
  o.imei = String(a.imei ?? '');
  o.severity = SEVS.includes(a.severity) ? a.severity : typeInfo(a.type).severity;
  o.acked = !!a.acked;
  o.historical = !!a.historical;
  o.ongoing = !!a.ongoing;
  o.verdict = VERDICTS[a.verdict] ? a.verdict : 'unchecked';
  o.note = typeof a.note === 'string' ? a.note : '';
  return o;
}
const hasProblem = (v) => v.activeAlerts.critical > 0 || v.activeAlerts.warning > 0 || (v.hasFuel && v.fuel?.sensorOk === false);
const topSev = (v) => (v.activeAlerts.critical > 0 ? 'critical' : v.activeAlerts.warning > 0 ? 'warning' : null);
const problemScore = (v) => (v.activeAlerts.critical || 0) * 1e6 + (v.activeAlerts.warning || 0) * 1e3 + (v.hasFuel && v.fuel?.sensorOk === false ? 1 : 0);

// ---------------------------------------------------------------- small render helpers
const relSpan = (ms) => (isNum(ms) ? html`<span data-rel="${ms}" title="${fmtFull(ms)}">${fmtRel(ms, now())}</span>` : html`<span>never</span>`);
const statusPill = (v) => html`<span class="pill st-${v.status}" title="${statusLong(v)}">${STATUS[v.status].label}</span>`;
function statusLong(v) {
  if (v.status === 'idle' && isNum(v.idleSince) && v.idleSince < now()) return `Engine running, not moving for ${fmtDur(now() - v.idleSince)}`;
  if (v.status === 'offline' && v.lastSeen) return `Not reporting since ${fmtFull(v.lastSeen)}`;
  return STATUS[v.status].long;
}

function fuelPct(v) {
  const f = v.fuel;
  if (!f || !isNum(f.mv)) return null;
  return isNum(f.pct) ? Number(f.pct) : mvToPct(f.mv, v.cal);
}
function fuelLitres(v) {
  const f = v.fuel;
  if (!f || !isNum(f.mv)) return null;
  if (isNum(f.liters)) return Number(f.liters);
  const p = fuelPct(v);
  return v.cal.tankLiters && p !== null ? (clamp(p, 0, 100) / 100) * v.cal.tankLiters : null;
}
/** Why a fuel vehicle shows no level: 'fault' (sensor not reading while powered), 'offline'
 *  (no data), 'wait' (reporting, no steady parked reading yet) or null (a level is known). */
function fuelState(v) {
  const f = v.fuel;
  if (f && f.sensorOk === false) return 'fault';
  if (fuelPct(v) !== null) return null;
  if (v.status === 'offline') return 'offline';
  const th = thFor(v.imei);
  const minMv = Number(th.sensorMinValidMv ?? 100);
  const cut = Number(th.powerCutMv ?? 5000);
  if (f && isNum(f.rawMv) && Number(f.rawMv) < minMv && isNum(v.pwrMv) && v.pwrMv >= cut) return 'fault';
  return 'wait';
}
function fuelCell(v) {
  if (!v.hasFuel) return html`<span class="muted small">No fuel sensor</span>`;
  const f = v.fuel;
  const fs = fuelState(v);
  if (fs === 'fault') {
    return html`<div class="gauge nosig" title="The fuel sensor is not giving valid readings — it may be disconnected or broken."><span class="gbar"><i></i></span><span class="gtxt"><b>No signal</b><small>sensor fault</small></span></div>`;
  }
  if (fs === 'offline') {
    return html`<div class="gauge wait" title="${v.lastSeen ? `No data since ${fmtFull(v.lastSeen)}` : 'No data from this vehicle'}"><span class="gbar"></span><span class="gtxt"><span class="muted">No data</span><small>${v.lastSeen ? `offline since ${fmtTime(v.lastSeen, now())}` : 'offline'}</small></span></div>`;
  }
  const pct = fuelPct(v);
  if (fs === 'wait') {
    return html`<div class="gauge wait" title="The level is measured while the vehicle is parked. Waiting for a steady reading."><span class="gbar"></span><span class="gtxt"><span class="muted">Waiting…</span><small>not yet measured</small></span></div>`;
  }
  const low = Number(thFor(v.imei).lowFuelPct ?? 10);
  const p = clamp(pct, 0, 100);
  const L = fuelLitres(v);
  const stale = f.trustedAt && now() - f.trustedAt > 12 * HOUR;
  const cls = p <= low ? 'low' : p <= 25 ? 'mid' : '';
  const title = `${fmtNum(f.mv)} mV${f.trustedAt ? ` — measured ${fmtRel(f.trustedAt, now())} (${fmtFull(f.trustedAt)}) while parked` : ''}`;
  return html`<div class="gauge ${cls}${stale ? ' stale' : ''}" title="${title}"><span class="gbar"><i style="width:${p.toFixed(1)}%"></i></span><span class="gtxt"><b>${fmtNum(p)}%</b><small>${L !== null ? `${fmtNum(L)} L` : `${fmtNum(f.mv)} mV`}</small></span></div>`;
}
function alertBadges(a, muted) {
  const out = [];
  if (a.critical) out.push(html`<span class="badge crit" title="${a.critical} unacknowledged critical alert(s)">${icon('octagon')}${a.critical}</span>`);
  if (a.warning) out.push(html`<span class="badge warn" title="${a.warning} unacknowledged warning(s)">${icon('triangle')}${a.warning}</span>`);
  if (muted) out.push(html`<span class="badge mute" title="Notifications muted for this vehicle">${icon('mute')}</span>`);
  if (!a.critical && !a.warning) out.unshift(html`<span class="ok-mark" title="No open alerts">${icon('check')}</span>`);
  return out;
}
function emptyState(ic, title, body, action) {
  return html`<div class="empty">${icon(ic, 'big')}<b>${title}</b>${body ? html`<p>${body}</p>` : ''}${action ? html`<button type="button" class="btn" data-action="${action.id}">${action.label}</button>` : ''}</div>`;
}
function vehicleOptionLabel(v, dupes) {
  return dupes.has(v.shortName) ? `${v.shortName} · …${v.imei.slice(-4)}` : v.shortName;
}

// ---------------------------------------------------------------- toasts & banners
function toast({ sev = 'info', title, body, action, timeout }) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast sev-${sev}`;
  el.setAttribute('role', sev === 'critical' ? 'alert' : 'status');
  setHTML(el, html`<div class="toast-ico">${icon(SEV_ICON[sev] || 'info')}</div>
    <div class="toast-body"><b>${title}</b>${body ? html`<div class="toast-text">${body}</div>` : ''}${action ? html`<button type="button" class="link toast-act">${action.label}</button>` : ''}</div>
    <button type="button" class="icon-btn toast-x" aria-label="Dismiss">${icon('x')}</button>`);
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 220); };
  el.querySelector('.toast-x').addEventListener('click', close);
  if (action) el.querySelector('.toast-act').addEventListener('click', () => { action.fn(); close(); });
  box.prepend(el);
  while (box.children.length > 4) box.lastElementChild.remove();
  const ms = timeout ?? (sev === 'critical' ? 0 : 7000);
  if (ms) setTimeout(close, ms);
  return close;
}

function renderBanners() {
  const out = [];
  const b = (sev, ic, title, body, extra) => html`<div class="banner sev-${sev}">${icon(ic)}<div class="banner-text"><b>${title}</b>${body ? html` <span>${body}</span>` : ''}</div>${extra || ''}</div>`;
  if (S.serverDown) {
    out.push(S.mode === 'cloud'
      ? b('critical', 'server', 'Cannot reach the Fuel Tank Warner server.', 'Check the internet connection. Retrying automatically…')
      : b('critical', 'server', 'Cannot reach the Fuel Tank Warner program on this computer.', 'Make sure it is running (start.bat). Retrying automatically…'));
  } else if (S.status) {
    const st = S.status;
    const lp = toMs(st.lastObjectsPoll);
    const paused = toMs(st.pausedUntil);
    if (paused && paused > now()) {
      out.push(b('warning', 'clock', 'The GPS server’s call limit is reached.', `Not asking it again until ${fmtTime(paused, now())} (asking more often would keep the limit hit) — showing the last known data; new refuels and thefts are checked after that.`));
    } else if (st.apiOk === false) {
      out.push(b('critical', 'wifi-off', 'The GPS server is not answering.', `${st.lastError ? String(st.lastError).slice(0, 200) + ' — ' : ''}showing the last known data, retrying automatically.`));
    } else if (lp && now() - lp > 5 * 60e3) {
      out.push(b('warning', 'clock', `No fresh data for ${fmtDur(now() - lp)}.`, 'The GPS server has not been polled successfully recently.'));
    }
    if (st.configError) out.push(b('warning', 'sliders', 'There is a problem in config.json.', String(st.configError).slice(0, 240)));
    if (st.detector && st.detector.ok === false) out.push(b('critical', 'fuel', 'The fuel analysis module could not start.', `${st.detector.error ? String(st.detector.error).slice(0, 200) + ' — ' : ''}fuel alerts are not being checked.`));
    const bf = st.backfill;
    if (bf && bf.running) {
      const pct = bf.total ? clamp((bf.done / bf.total) * 100, 0, 100) : 0;
      out.push(b('info', 'refresh', `Catching up on history: ${fmtNum(bf.done ?? 0)} of ${fmtNum(bf.total ?? 0)} vehicles.`, 'Alerts found in past data are marked “History” and do not send notifications.', html`<span class="progress" aria-hidden="true"><i style="width:${pct.toFixed(0)}%"></i></span>`));
    }
    const x = st.excel;
    if (x && x.enabled && x.locked) {
      out.push(b('warning', 'sheet', 'Excel file is open — it will be updated when you close it.', `${x.file || ''} — new refuels and thefts are kept safe in the meantime.`));
    } else if (x && x.enabled && x.lastError) {
      out.push(b('warning', 'sheet', 'The Excel fuel ledger could not be saved.', `${String(x.lastError).slice(0, 200)} — ${x.blocked ? 'tried again when something changes' : 'retrying every minute'}. Refuels and thefts are kept safe in the meantime.`));
    }
  }
  if (!S.serverDown && S.settings && !loadPref('notifHintDismissed', false)) {
    const sevs = serverPopupSevs();
    if (sevs.length) {
      // the program already shows Windows pop-ups on this computer: browser pop-ups would only duplicate them
      out.push(html`<div class="banner sev-hint">${icon('bell')}<div class="banner-text"><b>Windows pop-ups are on</b> <span>— ${sevs.map((x) => SEV_LABEL[x].toLowerCase()).join(' and ')} alerts pop up on this computer even when the browser is closed (change in Settings → Notifications).</span></div>
        <button type="button" class="icon-btn" data-action="dismiss-notif-hint" aria-label="Dismiss">${icon('x')}</button></div>`);
    } else if (notifSupported() && Notification.permission === 'default') {
      out.push(html`<div class="banner sev-hint">${icon('bell')}<div class="banner-text"><b>Get a pop-up when fuel is drained</b> <span>— even while this tab is in the background.</span></div>
        <button type="button" class="btn small primary" data-action="enable-notif">Turn on pop-ups</button>
        <button type="button" class="icon-btn" data-action="dismiss-notif-hint" aria-label="Dismiss">${icon('x')}</button></div>`);
    }
  }
  setHTML($('#banners'), html`${out}`);
}

function renderConn() {
  const el = $('#conn');
  const state = S.serverDown ? 'down' : S.conn === 'polling' && S.polledAt ? 'live' : S.conn;
  el.dataset.state = state;
  const lp = toMs(S.status?.lastObjectsPoll);
  let txt;
  if (state === 'down') txt = 'Server offline';
  else if (S.conn === 'polling') txt = lp ? `Updated ${fmtRel(lp, now())}` : state === 'live' ? 'Online' : 'Connecting…';
  else if (state === 'live') txt = lp ? `Live · updated ${fmtRel(lp, now())}` : 'Live';
  else if (state === 'connecting') txt = 'Connecting…';
  else txt = 'Reconnecting…';
  $('#conn-text').textContent = txt;
  el.title = `Live updates: ${state === 'live' ? 'connected' : 'not connected'}${lp ? `\nLast GPS poll: ${fmtFull(lp)}` : ''}`;
}

function renderCounts() {
  let c = 0, w = 0;
  for (const v of S.vehicles) { c += Number(v.activeAlerts.critical) || 0; w += Number(v.activeAlerts.warning) || 0; }
  const cc = $('#cnt-crit'), cw = $('#cnt-warn');
  cc.querySelector('b').textContent = fmtNum(c);
  cw.querySelector('b').textContent = fmtNum(w);
  cc.classList.toggle('zero', !c);
  cw.classList.toggle('zero', !w);
  cw.querySelector('.count-lab').textContent = w === 1 ? 'warning' : 'warnings';
  const tb = $('#tab-badge');
  tb.hidden = !(c + w);
  tb.textContent = c + w > 99 ? '99+' : String(c + w);
  tb.classList.toggle('crit', c > 0);
  document.title = (c ? `(${c}) ` : '') + 'Fuel Tank Warner';
}

// ---------------------------------------------------------------- notifications & sound
const notifSupported = () => 'Notification' in window && window.isSecureContext;
let actx = null;
function unlockAudio() {
  try {
    if (!actx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) actx = new AC(); }
    if (actx && actx.state === 'suspended') actx.resume();
  } catch { /* audio not available */ }
}
function beep(kind = 'critical') {
  unlockAudio();
  if (!actx) return;
  const t0 = actx.currentTime + 0.02;
  const seq = kind === 'critical' ? [[880, 0], [660, 0.2], [880, 0.4]] : [[660, 0]];
  for (const [f, dt] of seq) {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + dt);
    g.gain.exponentialRampToValueAtTime(0.3, t0 + dt + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.17);
    o.connect(g).connect(actx.destination);
    o.start(t0 + dt);
    o.stop(t0 + dt + 0.19);
  }
}
function renderNotifBtn() {
  const b = $('#btn-notif');
  const p = notifSupported() ? Notification.permission : 'unsupported';
  b.querySelector('use').setAttribute('href', p === 'granted' ? '#i-bell' : '#i-bell-off');
  b.classList.toggle('on', p === 'granted');
  b.title = {
    granted: 'Pop-up notifications are on',
    default: 'Turn on pop-up notifications',
    denied: 'Pop-ups are blocked — allow notifications for this site in the browser settings',
    unsupported: 'Pop-ups are not available here. Open the dashboard on the server computer at http://localhost:8080',
  }[p];
  b.setAttribute('aria-label', b.title);
  const sb = $('#btn-sound');
  sb.querySelector('use').setAttribute('href', S.prefs.sound ? '#i-volume' : '#i-volume-off');
  sb.classList.toggle('on', S.prefs.sound);
  sb.title = S.prefs.sound ? 'Alarm sound for critical alerts is on (click to turn off)' : 'Alarm sound is off (click to turn on)';
  sb.setAttribute('aria-label', sb.title);
  renderBrowserCard();
}
async function requestNotif() {
  if (!notifSupported()) {
    toast({ sev: 'warning', title: 'Pop-ups not available', body: 'Browsers only allow notifications on a secure address. Open the dashboard on the server computer at http://localhost:8080.' });
    return;
  }
  if (Notification.permission === 'denied') {
    toast({ sev: 'warning', title: 'Pop-ups are blocked', body: 'Click the lock icon next to the address bar and allow notifications for this site.' });
    return;
  }
  if (Notification.permission === 'granted') {
    toast({ sev: 'good', title: 'Pop-ups are already on', body: 'Use “Send test” to check them.' });
    return;
  }
  try { await Notification.requestPermission(); } catch { /* ignore */ }
  renderNotifBtn();
  renderBanners();
  if (Notification.permission === 'granted') {
    try { new Notification('Pop-ups are on', { body: 'You will be told about fuel drains and other problems.', tag: 'ftw-perm' }); } catch { /* ignore */ }
  }
}
/** Severities the server itself pops up on this computer (Windows toast). */
const serverPopupSevs = () => {
  const n = S.settings?.notify;
  if (!S.features.windowsToast || !n || n.windowsToast === false) return [];
  return Array.isArray(n.severities) ? n.severities : ['critical', 'warning'];
};
const lastNotified = new Map(); // imei:type -> time shown (same throttle as the server)
function notifyAlert(a) {
  const v = S.byImei.get(a.imei);
  if (v?.muted) return;
  if (!S.prefs.bsev.includes(a.severity)) return;
  const thrMs = Number(S.settings?.notify?.throttleMinutes ?? 10) * 60e3;
  const tk = `${a.imei}:${a.type}`;
  const tNow = Date.now();
  if (thrMs > 0 && tNow - (lastNotified.get(tk) ?? -Infinity) < thrMs) return;
  lastNotified.set(tk, tNow);
  if (lastNotified.size > 500) lastNotified.delete(lastNotified.keys().next().value);
  const name = aName(a);
  const title = a.title || typeLabel(a.type);
  toast({
    sev: a.severity,
    title: `${name}: ${title}`,
    body: `${typeLabel(a.type)} · ${fmtTime(a.t, now())}${a.detail ? ' — ' + String(a.detail).slice(0, 140) : ''}`,
    action: { label: 'Show details', fn: () => openVehicle(a.imei, a.t) },
  });
  if (a.severity === 'critical' && S.prefs.sound) beep('critical');
  // the dashboard is only allowed pop-ups on this computer, where the program already shows
  // Windows pop-ups for these severities: don't show the same alert twice
  if (!serverPopupSevs().includes(a.severity) && notifSupported() && Notification.permission === 'granted' && (document.hidden || !document.hasFocus())) {
    try {
      const n = new Notification(`${SEV_LABEL[a.severity]}: ${name} — ${title}`, {
        body: `${fmtTime(a.t, now())}${a.detail ? ' · ' + String(a.detail).slice(0, 180) : ''}`,
        tag: String(a.key || a.id),
        requireInteraction: a.severity === 'critical',
      });
      n.onclick = () => { window.focus(); openVehicle(a.imei, a.t); n.close(); };
    } catch { /* ignore */ }
  }
}
async function testNotification() {
  let body = '';
  if (S.features.windowsToast) try {
    const r = await api('/api/test-notification', { method: 'POST', body: {} });
    const names = { windowsToast: 'Windows pop-up' };
    const parts = [];
    if (r && typeof r === 'object') {
      for (const [k, v] of Object.entries(r)) {
        if (!v || typeof v !== 'object' || !('ok' in v)) continue;
        parts.push(`${names[k] || k}: ${v.ok ? 'sent' : (v.skipped ? 'not used' : 'failed') + (v.error ? ` (${v.error})` : '')}`);
      }
    }
    body = parts.length ? parts.join('. ') + '.' : 'The server sent a test.';
  } catch (e) {
    body = `Server test failed: ${e.message}.`;
  }
  if (S.prefs.sound) beep('critical');
  const p = notifSupported() ? Notification.permission : 'unsupported';
  if (p === 'granted') {
    try { new Notification('Test notification', { body: 'Browser pop-ups are working.', tag: 'ftw-test' }); } catch { /* ignore */ }
    body += body ? ' A browser pop-up was shown too.' : 'A browser pop-up was shown.';
  } else body += p === 'denied' ? ' Browser pop-ups are blocked.' : ' Browser pop-ups are off (use the bell button).';
  body = body.trim();
  toast({ sev: 'info', title: 'Test notification', body });
}

// ---------------------------------------------------------------- data loading
function markServer(ok, err) {
  const was = S.serverDown;
  S.serverDown = Boolean(!ok && err && err.status === 0);
  if (was !== S.serverDown) { renderBanners(); renderConn(); if (was && !S.serverDown) resync(); }
}
async function loadMeta() {
  try {
    const m = await api('/api/meta');
    if (m && m.alertTypes && typeof m.alertTypes === 'object') S.meta.alertTypes = { ...FALLBACK_TYPES, ...m.alertTypes };
    if (m && Array.isArray(m.groups)) S.meta.groups = m.groups;
    if (m && (m.mode === 'cloud' || m.mode === 'local')) S.mode = m.mode;
    if (m && m.features && typeof m.features === 'object') S.features = { ...S.features, ...m.features };
    if (m && isNum(m.serverTimeMs)) S.skew = Number(m.serverTimeMs) - Date.now();
    if (Math.abs(S.skew) < 5000) S.skew = 0;
    markServer(true);
  } catch (e) { markServer(false, e); }
}
async function loadVehicles() {
  try {
    const list = await api('/api/vehicles');
    setVehicles(Array.isArray(list) ? list : []);
    S.vehiclesError = null;
    markServer(true);
  } catch (e) {
    S.vehiclesError = e.message;
    markServer(false, e);
    if (!S.vehiclesLoaded) renderFleet();
  }
}
const refreshVehiclesSoon = debounce(loadVehicles, 1500);
async function loadSettings() {
  try {
    S.settings = await api('/api/settings');
    if (!S.settings || typeof S.settings !== 'object') S.settings = null;
    markServer(true);
  } catch (e) { markServer(false, e); }
}
async function loadStatus() {
  try {
    setStatus(await api('/api/status'));
    markServer(true);
  } catch (e) { markServer(false, e); }
}
function setStatus(st) {
  if (!st || typeof st !== 'object') return;
  S.status = st;
  renderBanners();
  renderConn();
  if (S.view === 'report') renderExcelBar();
}
async function loadRecentAlertIds() {
  // Remember recent alerts so that later SSE updates of them are not mistaken for new ones.
  try {
    const list = await api(`/api/alerts?since=${Math.round(now() - 6 * HOUR)}&limit=1000`);
    if (Array.isArray(list)) for (const a of list) { S.seen.add(a.id); alertSigs.set(a.id, JSON.stringify(a)); }
  } catch { /* not critical */ }
}

function setVehicles(list) {
  S.vehicles = list.map(normVehicle);
  S.byImei = new Map(S.vehicles.map((v) => [v.imei, v]));
  const first = !S.vehiclesLoaded;
  S.vehiclesLoaded = true;
  renderCounts();
  if (first) populateSelects();
  if (S.view === 'fleet') renderFleet();
  if (S.view === 'map') renderMap();
  if (S.view === 'settings' && first && S.settings) renderCalTable();
  if (S.detail) {
    renderDetailHead();
    renderDetailStats();
    updateDetailMap();
    if (first) { renderDetailForm(); if (S.detail.data) drawDetailChart(true); }
    else if (S.detail.data && Date.now() - S.detail.loadedAt > 150e3) loadDetail(true);
  }
}

function resync() {
  loadVehicles();
  loadStatus();
  if (S.alerts.loaded) loadAlerts();
  if (S.detail) loadDetail(true);
}

// ---------------------------------------------------------------- live stream (SSE)
let sseRetry = null;
const probeServerSoon = debounce(loadStatus, 1500);
function connectSSE() {
  clearTimeout(sseRetry);
  if (S.es) { try { S.es.close(); } catch { /* ignore */ } }
  if (!('EventSource' in window)) { startPolling(); return; }
  const es = new EventSource('/api/stream');
  S.es = es;
  S.conn = S.conn === 'live' ? 'reconnecting' : S.conn;
  renderConn();
  es.onopen = () => {
    S.conn = 'live';
    renderConn();
    if (S.sseDropped) { S.sseDropped = false; resync(); }
  };
  es.onerror = () => {
    S.sseDropped = true;
    S.conn = 'reconnecting';
    renderConn();
    probeServerSoon(); // find out quickly whether the whole server is down (shows the banner)
    if (es.readyState === 2) sseRetry = setTimeout(connectSSE, 5000);
  };
  es.addEventListener('vehicles', (e) => {
    try { const list = JSON.parse(e.data); if (Array.isArray(list)) setVehicles(list); } catch (err) { console.warn('bad vehicles event', err); }
  });
  es.addEventListener('alert', (e) => {
    try { onAlert(JSON.parse(e.data)); } catch (err) { console.warn('bad alert event', err); }
  });
  es.addEventListener('acked', () => {
    if (S.alerts.loaded) loadAlerts();
    if (S.detail) loadDetail(true);
    refreshVehiclesSoon();
  });
  es.addEventListener('status', (e) => {
    try { setStatus(JSON.parse(e.data)); } catch (err) { console.warn('bad status event', err); }
  });
}

// ---------------------------------------------------------------- polling (cloud version: no SSE)
const POLL_MS = 20e3;
const alertSigs = new Map(); // alert id -> JSON last seen (only changed alerts are processed)
/** New and changed alerts of the last 2 h, handled like SSE "alert" events. */
async function pollAlerts() {
  try {
    const list = await api(`/api/alerts?since=${Math.round(now() - 2 * HOUR)}&limit=500`);
    if (!Array.isArray(list)) return;
    for (const a of list.slice().reverse()) { // oldest first, like live events
      if (!a || a.id === undefined || a.id === null) continue;
      const sig = JSON.stringify(a);
      if (alertSigs.get(a.id) === sig) continue;
      alertSigs.set(a.id, sig);
      onAlert(a);
    }
    if (alertSigs.size > 5000) alertSigs.delete(alertSigs.keys().next().value);
    markServer(true);
  } catch (e) { markServer(false, e); }
}
let pollTimer = null;
async function pollOnce() {
  if (S.needLogin) return;
  await Promise.all([loadStatus(), loadVehicles(), pollAlerts()]);
  S.polledAt = Date.now();
  renderConn();
}
function startPolling() {
  S.conn = 'polling';
  renderConn();
  clearInterval(pollTimer);
  pollTimer = setInterval(pollOnce, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - (S.polledAt || 0) > 5000) pollOnce(); });
  pollOnce();
}

// ---------------------------------------------------------------- sign-in (cloud version)
function showLogin() {
  if (S.needLogin) return;
  S.needLogin = true;
  clearInterval(pollTimer);
  const box = $('#login');
  box.hidden = false;
  $('#login-err').textContent = '';
  setTimeout(() => $('#login-pw').focus(), 0);
}
async function submitLogin(e) {
  e.preventDefault();
  const pw = $('#login-pw').value;
  const err = $('#login-err');
  if (!pw) { err.textContent = 'Enter the password.'; return; }
  const btn = $('#login-btn');
  btn.disabled = true;
  err.textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }), cache: 'no-store',
    });
    const j = await res.json().catch(() => null);
    if (res.ok && j && j.ok) { location.reload(); return; }
    err.textContent = res.status === 401 || res.status === 403 ? 'Wrong password.'
      : res.status === 429 ? 'Too many attempts — wait a minute and try again.'
      : (j && j.error) || `Sign-in failed (HTTP ${res.status}).`;
  } catch {
    err.textContent = 'Cannot reach the server.';
  } finally {
    btn.disabled = false;
  }
}
async function logout() {
  try { await fetch('/api/logout', { method: 'POST', cache: 'no-store' }); } catch { /* signed out locally anyway */ }
  location.reload();
}

function alertMatches(a) {
  const f = S.alerts.f;
  if (!f.sev.includes(a.severity)) return false;
  if (f.type && a.type !== f.type) return false;
  if (f.imei && a.imei !== f.imei) return false;
  if (f.unacked && a.acked) return false;
  if (isNum(a.t) && a.t < now() - f.range * HOUR) return false;
  return true;
}
const renderAlertsSoon = debounce(() => renderAlerts(), 120);
const reloadReportSoon = debounce(() => { if (S.view === 'report') loadReport(); }, 2000);
function onAlert(rawA) {
  if (!rawA || rawA.id === undefined || rawA.id === null) return;
  const a = normAlert(rawA);
  const known = S.seen.has(a.id);
  S.seen.add(a.id);
  const fresh = isNum(a.t) && now() - a.t < HOUR;
  if (!known && !a.historical && !a.acked && fresh) {
    S.alerts.newIds.add(a.id);
    setTimeout(() => { S.alerts.newIds.delete(a.id); }, 60e3);
    notifyAlert(a);
  }
  const st = S.alerts;
  const idx = st.list.findIndex((x) => x.id === a.id);
  if (idx >= 0) {
    // acknowledged elsewhere: gone from the "unacknowledged" list. Not when the owner just gave
    // it a verdict here (that acknowledges it too): the card stays, to add a note or undo.
    if (st.f.unacked && a.acked && !keepInList.has(String(a.id))) st.list.splice(idx, 1);
    else st.list[idx] = a;
    if (S.view === 'alerts') renderAlertsSoon();
  } else if (st.loaded && alertMatches(a)) {
    st.list.push(a);
    st.list.sort((x, y) => (y.t ?? 0) - (x.t ?? 0));
    if (S.view === 'alerts') renderAlertsSoon();
  }
  if (LEDGER_TYPES.includes(a.type)) {
    // refuel / theft totals (and verdicts) changed: the Report must not show old figures
    S.report.loadedAt = 0;
    if (S.view === 'report' && S.report.rows) reloadReportSoon();
  }
  const d = S.detail;
  if (d && d.imei === a.imei && d.data) {
    const i = d.data.alerts.findIndex((x) => x.id === a.id);
    if (i >= 0) d.data.alerts[i] = a;
    else if (isNum(a.t) && a.t >= d.data.from) d.data.alerts.unshift(a);
    if (d.oldAlert?.alert?.id === a.id) d.oldAlert.alert = a;
    d.chart?.setAlerts(d.data.alerts);
    renderDetailAlerts();
  }
  refreshVehiclesSoon();
}

// ---------------------------------------------------------------- routing
const VIEWS = ['fleet', 'map', 'alerts', 'report', 'settings'];
function parseHash() {
  // Canonical: #/<view>?v=<imei>&at=<ms>. Also accepts #/vehicle/<imei> as a deep-link alias.
  const h = location.hash.replace(/^#\/?/, '');
  let [p, qs = ''] = h.split('?');
  const params = new URLSearchParams(qs);
  const m = p.match(/^(?:vehicles?|v)\/([^/]+)/);
  if (m) {
    try { params.set('v', decodeURIComponent(m[1])); } catch { params.set('v', m[1]); }
    p = 'fleet';
  }
  return { view: VIEWS.includes(p) ? p : 'fleet', params };
}
function nav(view, params) {
  const target = `#/${view}${params ? '?' + params : ''}`;
  if (location.hash === target) route();
  else location.hash = target;
}
function openVehicle(imei, at) {
  const p = new URLSearchParams({ v: String(imei) });
  if (isNum(at)) p.set('at', String(Math.round(at)));
  nav(S.view || 'fleet', p.toString());
}
function closeVehicle() { nav(S.view || 'fleet'); }
function route() {
  const { view, params } = parseHash();
  if (view !== S.view) showView(view);
  const v = params.get('v');
  if (v) showDrawer(v, toMs(params.get('at')));
  else hideDrawer();
}
function showView(view) {
  S.view = view;
  for (const vw of VIEWS) $(`#view-${vw}`).hidden = vw !== view;
  $$('.tabs a').forEach((a) => {
    if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.body.dataset.view = view;
  if (view === 'fleet') renderFleet();
  if (view === 'map') { renderMap(); setTimeout(() => mapObj?.invalidateSize(), 50); }
  if (view === 'alerts') { syncAlertControls(); if (!S.alerts.loaded || Date.now() - (S.alerts.loadedAt || 0) > 60e3) loadAlerts(); else renderAlerts(); }
  if (view === 'report') { if (!S.report.rows || Date.now() - S.report.loadedAt > 5 * 60e3) loadReport(); else renderReport(); }
  if (view === 'settings') renderSettings();
}

// ---------------------------------------------------------------- selects
function populateSelects() {
  const groups = new Map();
  for (const g of S.meta.groups || []) groups.set(groupKey(g), groupLabel(g));
  for (const v of S.vehicles) groups.set(groupKey(v.group), groupLabel(v.group));
  const gOpts = [...groups.entries()].sort((a, b) => (a[0] === '__none') - (b[0] === '__none') || a[1].localeCompare(b[1]));
  for (const id of ['#f-group', '#r-group']) {
    const sel = $(id);
    const cur = sel.value || (id === '#f-group' ? S.fleet.group : '');
    setHTML(sel, html`<option value="">All groups</option>${gOpts.map(([k, l]) => html`<option value="${k}">${l}</option>`)}`);
    sel.value = gOpts.some(([k]) => k === cur) ? cur : '';
  }
  S.fleet.group = $('#f-group').value;
  const typeSel = $('#a-type');
  const types = Object.entries(S.meta.alertTypes).sort((a, b) => SEVS.indexOf(a[1].severity) - SEVS.indexOf(b[1].severity) || a[1].label.localeCompare(b[1].label));
  setHTML(typeSel, html`<option value="">All types</option>${types.map(([k, t]) => html`<option value="${k}">${t.label}</option>`)}`);
  const vehSel = $('#a-veh');
  const counts = new Map();
  for (const v of S.vehicles) counts.set(v.shortName, (counts.get(v.shortName) || 0) + 1);
  const dupes = new Set([...counts].filter(([, n]) => n > 1).map(([k]) => k));
  const vs = [...S.vehicles].sort((a, b) => a.shortName.localeCompare(b.shortName, undefined, { numeric: true }));
  setHTML(vehSel, html`<option value="">All vehicles</option>${vs.map((v) => html`<option value="${v.imei}">${vehicleOptionLabel(v, dupes)}</option>`)}`);
  syncAlertControls();
}

// ---------------------------------------------------------------- FLEET view
const SORTERS = {
  name: (a, b) => a.shortName.localeCompare(b.shortName, undefined, { numeric: true }),
  group: (a, b) => groupLabel(a.group).localeCompare(groupLabel(b.group)),
  status: (a, b) => STATUS[a.status].order - STATUS[b.status].order,
  fuel: (a, b) => fuelSortVal(a) - fuelSortVal(b),
  speed: (a, b) => (a.status === 'offline' ? -1 : a.speed ?? -1) - (b.status === 'offline' ? -1 : b.speed ?? -1),
  seen: (a, b) => (a.lastSeen ?? 0) - (b.lastSeen ?? 0),
  alerts: (a, b) => problemScore(a) - problemScore(b),
};
const SORT_DEFAULT_DIR = { name: 1, group: 1, status: 1, fuel: 1, speed: -1, seen: -1, alerts: -1 };
function fuelSortVal(v) {
  if (!v.hasFuel) return -300;
  if (v.fuel?.sensorOk === false) return -100;
  const p = fuelPct(v);
  return p === null ? -200 : p;
}
function fleetFiltered() {
  const f = S.fleet;
  const q = f.q.trim().toLowerCase();
  return S.vehicles.filter((v) => (!q || v._search.includes(q))
    && (!f.group || groupKey(v.group) === f.group)
    && (!f.status || v.status === f.status)
    && (!f.fuel || v.hasFuel)
    && (!f.problems || hasProblem(v)));
}
function renderFleetTiles() {
  const c = { moving: 0, idle: 0, parked: 0, offline: 0, fuel: 0, problems: 0, nosig: 0 };
  for (const v of S.vehicles) {
    c[v.status]++;
    if (v.hasFuel) c.fuel++;
    if (hasProblem(v)) c.problems++;
  }
  const f = S.fleet;
  const tile = (key, label, n, cls, pressed, hint) => html`<button type="button" class="tile ${cls}" data-tile="${key}" aria-pressed="${pressed ? 'true' : 'false'}" title="${hint}">
      <span class="t-num">${fmtNum(n)}</span><span class="t-lab">${label}</span></button>`;
  setHTML($('#fleet-tiles'), html`
    ${tile('all', 'Vehicles', S.vehicles.length, 't-all', !f.status && !f.fuel && !f.problems, 'Show all vehicles')}
    ${tile('problems', 'Need attention', c.problems, c.problems ? 't-problems hot' : 't-problems', f.problems, 'Vehicles with unacknowledged critical/warning alerts or a faulty fuel sensor')}
    ${tile('moving', 'Moving', c.moving, 'st-moving', f.status === 'moving', 'Driving now')}
    ${tile('idle', 'Idle', c.idle, 'st-idle', f.status === 'idle', 'Engine running but not moving')}
    ${tile('parked', 'Parked', c.parked, 'st-parked', f.status === 'parked', 'Engine off')}
    ${tile('offline', 'Offline', c.offline, 'st-offline', f.status === 'offline', 'Not reporting')}
    ${tile('fuel', 'Fuel sensors', c.fuel, 't-fuel', f.fuel, 'Vehicles with a fuel level sensor')}
  `);
}
function renderFleet() {
  renderFleetTiles();
  const body = $('#fleet-body');
  const empty = $('#fleet-empty');
  $$('.fleet-tbl th').forEach((th) => {
    const b = th.querySelector('button');
    const on = b && b.dataset.sort === S.fleet.sort;
    th.setAttribute('aria-sort', on ? (S.fleet.dir > 0 ? 'ascending' : 'descending') : 'none');
  });
  if (!S.vehiclesLoaded) {
    body.innerHTML = '';
    empty.hidden = false;
    setHTML(empty, S.vehiclesError
      ? emptyState('wifi-off', 'Could not load vehicles', S.vehiclesError, { id: 'retry-vehicles', label: 'Try again' })
      : html`<div class="empty"><span class="spinner"></span><b>Loading vehicles…</b></div>`);
    $('#f-count').textContent = '';
    return;
  }
  const f = S.fleet;
  const list = fleetFiltered();
  const cmp = SORTERS[f.sort] || SORTERS.alerts;
  list.sort((a, b) => cmp(a, b) * f.dir || SORTERS.name(a, b));
  $('#f-count').textContent = list.length === S.vehicles.length ? `${list.length} vehicles` : `${list.length} of ${S.vehicles.length}`;
  if (!list.length) {
    body.innerHTML = '';
    empty.hidden = false;
    setHTML(empty, emptyState('search', S.vehicles.length ? 'No vehicles match these filters' : 'No vehicles yet', S.vehicles.length ? 'Try clearing the search or filters.' : 'The program has not received the vehicle list from the GPS server yet.', S.vehicles.length ? { id: 'clear-fleet', label: 'Clear filters' } : null));
    return;
  }
  empty.hidden = true;
  const t = now();
  setHTML(body, html`${list.map((v) => {
    const sev = topSev(v);
    return html`<tr data-imei="${v.imei}" tabindex="0" class="${sev ? 'sev-' + sev : ''}${v.status === 'offline' ? ' is-off' : ''}">
      <td class="c-name"><div class="vname">${v.shortName}</div><div class="vsub"><span class="d-only">${[v.plate, v.device].filter(Boolean).join(' · ')}</span><span class="m-only"><span class="st-txt st-${v.status}">${STATUS[v.status].label}</span> · ${relSpan(v.lastSeen)}</span></div></td>
      <td class="c-group">${groupLabel(v.group)}</td>
      <td class="c-status">${statusPill(v)}</td>
      <td class="c-fuel">${fuelCell(v)}</td>
      <td class="c-speed num">${v.status === 'offline' || v.speed === null ? html`<span class="muted">—</span>` : `${fmtNum(v.speed)} km/h`}</td>
      <td class="c-seen">${relSpan(v.lastSeen)}${v.lastSeen && t - v.lastSeen > 30 * 864e5 ? html`<div class="vsub">${fmtTime(v.lastSeen, t)}</div>` : ''}</td>
      <td class="c-alerts"><span class="badges">${alertBadges(v.activeAlerts, v.muted)}</span></td>
    </tr>`;
  })}`);
}

// ---------------------------------------------------------------- MAP view
let mapObj = null;
const markers = new Map();
let mapFitted = false;
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
function ensureMap() {
  if (mapObj) return true;
  if (!window.L) {
    const err = $('#map-error');
    err.hidden = false;
    setHTML(err, emptyState('map', 'The map could not be loaded', 'This needs an internet connection to load the map library and tiles. Everything else works without it.'));
    return false;
  }
  mapObj = L.map('map', { zoomControl: true, worldCopyJump: false }).setView([46.8, 103.8], 5);
  L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTR }).addTo(mapObj);
  return true;
}
function mapFilterPass(v) {
  const f = S.map.filter;
  if (f === 'all') return true;
  if (f === 'problems') return hasProblem(v);
  return v.status === f;
}
const sevZ = (v) => (topSev(v) === 'critical' ? 2000 : topSev(v) === 'warning' ? 1000 : v.status === 'offline' ? -500 : 0);
function markerKey(v) { return [v.status, topSev(v) || '', Math.round((v.angle || 0) / 10)].join('|'); }
function markerIcon(v) {
  const sev = topSev(v);
  const arrow = v.status === 'moving' ? `<svg class="mk-arrow" viewBox="0 0 24 24" style="transform:rotate(${Math.round(v.angle || 0)}deg)"><path d="M12 2.5l5.5 13-5.5-3.2-5.5 3.2z"/></svg>` : '';
  return L.divIcon({ className: 'mk-wrap', html: `<div class="mk st-${v.status}${sev ? ' ring-' + sev : ''}">${arrow}</div>`, iconSize: [22, 22], iconAnchor: [11, 11], popupAnchor: [0, -10], tooltipAnchor: [10, 0] });
}
function popupHtml(v) {
  if (!v) return '';
  return html`<div class="pop">
    <div class="pop-title">${v.shortName}</div>
    <div class="pop-sub">${groupLabel(v.group)}${v.device ? ' · ' + v.device : ''}</div>
    <div class="pop-row">${statusPill(v)}${v.status === 'moving' && v.speed !== null ? html`<b>${fmtNum(v.speed)} km/h</b>` : ''}</div>
    <div class="pop-row">${fuelCell(v)}</div>
    <div class="pop-row muted">Last report ${fmtRel(v.lastSeen, now())}</div>
    <div class="pop-row"><span class="badges">${alertBadges(v.activeAlerts, v.muted)}</span><button type="button" class="btn small primary" data-open="${v.imei}">Details${icon('chevron')}</button></div>
  </div>`.s;
}
function renderMap() {
  if (!ensureMap()) return;
  const shown = new Set();
  for (const v of S.vehicles) {
    if (!validLatLng(v) || !mapFilterPass(v)) continue;
    shown.add(v.imei);
    let m = markers.get(v.imei);
    const key = markerKey(v);
    if (!m) {
      const imei = v.imei;
      m = L.marker([v.lat, v.lng], { icon: markerIcon(v), title: v.shortName, alt: v.shortName, riseOnHover: true, zIndexOffset: sevZ(v) });
      m.bindPopup(() => popupHtml(S.byImei.get(imei)), { maxWidth: 300, minWidth: 230 });
      m._key = key;
      m.addTo(mapObj);
      markers.set(v.imei, m);
    } else {
      m.setLatLng([v.lat, v.lng]);
      if (m._key !== key) { m.setIcon(markerIcon(v)); m._key = key; }
      m.setZIndexOffset(sevZ(v));
      if (m.isPopupOpen()) m.getPopup().update();
    }
    if (S.map.names) {
      if (!m.getTooltip()) m.bindTooltip(esc(v.shortName), { permanent: true, direction: 'right', className: 'mk-label' });
    } else if (m.getTooltip()) m.unbindTooltip();
  }
  for (const [imei, m] of markers) if (!shown.has(imei)) { m.remove(); markers.delete(imei); }
  if (!mapFitted && S.vehiclesLoaded) { fitMap(); mapFitted = true; }
  $$('#map-filter button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === S.map.filter)));
  $('#map-names').checked = !!S.map.names;
}
function fitMap() {
  if (!mapObj) return;
  const pts = [...markers.values()].map((m) => m.getLatLng());
  if (!pts.length) return;
  if (pts.length === 1) mapObj.setView(pts[0], 12);
  else mapObj.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 12 });
}

// ---------------------------------------------------------------- ALERTS view
let alertsReq = 0;
function syncAlertControls() {
  const f = S.alerts.f;
  $$('#a-sev button').forEach((b) => b.setAttribute('aria-pressed', String(f.sev.includes(b.dataset.sev))));
  const typeSel = $('#a-type');
  typeSel.value = f.type;
  if (typeSel.value !== f.type) f.type = '';
  const vehSel = $('#a-veh');
  if (f.imei && !vehSel.querySelector(`option[value="${CSS.escape(f.imei)}"]`)) {
    const o = document.createElement('option');
    o.value = f.imei;
    o.textContent = vName(f.imei);
    vehSel.append(o);
  }
  vehSel.value = f.imei;
  const rangeSel = $('#a-range');
  rangeSel.value = String(f.range);
  if (rangeSel.value !== String(f.range)) { f.range = 72; rangeSel.value = '72'; }
  $('#a-unacked').checked = !!f.unacked;
  const who = f.imei ? vName(f.imei) : null;
  $('#a-ackall').title = who ? `Mark every open alert of ${who} as seen` : 'Mark every open alert of all vehicles as seen';
}
function saveAlertFilters() { S.alerts.temp = null; savePref('alertFilters', S.alerts.f); }
/** Show the Alerts view with a shortcut's filter, without replacing the saved filters. */
function showTempAlerts(f, label) {
  S.alerts.f = { ...S.alerts.f, ...f };
  S.alerts.temp = { label };
  S.alerts.loaded = false;
  S.alerts.list = [];
  const already = S.view === 'alerts';
  nav('alerts');
  if (already) { syncAlertControls(); loadAlerts(); }
}
function restoreAlertFilters(reload = true) {
  S.alerts.temp = null;
  S.alerts.f = savedAlertFilters();
  S.alerts.loaded = false;
  S.alerts.list = [];
  if (reload && S.view === 'alerts') { syncAlertControls(); loadAlerts(); }
}
function renderTempChip() {
  const el = $('#a-temp');
  if (!el) return;
  const t = S.alerts.temp;
  el.hidden = !t;
  if (t) setHTML(el, html`<span>Showing: <b>${t.label}</b></span><button type="button" class="link" data-action="alerts-show-saved">Show my usual filters</button>`);
}
async function loadAlerts(append = false) {
  const st = S.alerts;
  const f = st.f;
  if (!f.sev.length) { st.list = []; st.hasMore = false; st.loaded = true; renderAlerts(); return; }
  const p = new URLSearchParams();
  if (f.sev.length < SEVS.length) p.set('severity', f.sev.join(','));
  if (f.type) p.set('type', f.type);
  if (f.imei) p.set('imei', f.imei);
  if (f.unacked) p.set('unacked', '1');
  p.set('since', String(Math.round(now() - f.range * HOUR)));
  p.set('limit', '200');
  if (append && st.list.length) p.set('until', String(st.list[st.list.length - 1].t));
  if (!append) keepInList.clear(); // a fresh list: reviewed cards follow the filter again
  const req = ++alertsReq;
  st.loading = true;
  $('#alert-list').classList.add('is-loading');
  if (!st.list.length) renderAlerts();
  try {
    const data = await api('/api/alerts?' + p.toString());
    if (req !== alertsReq) return;
    const list = (Array.isArray(data) ? data : []).map(normAlert);
    for (const a of list) S.seen.add(a.id);
    if (append) {
      const ids = new Set(st.list.map((a) => a.id));
      const add = list.filter((a) => !ids.has(a.id));
      st.list = st.list.concat(add);
      st.hasMore = list.length >= 200 && add.length > 0;
    } else {
      st.list = list;
      st.hasMore = list.length >= 200;
    }
    st.error = null;
    st.loaded = true;
    st.loadedAt = Date.now();
    markServer(true);
  } catch (e) {
    if (req !== alertsReq) return;
    st.error = e.message;
    markServer(false, e);
    if (st.list.length) toast({ sev: 'warning', title: 'Could not load alerts', body: e.message });
  } finally {
    if (req === alertsReq) {
      st.loading = false;
      $('#alert-list').classList.remove('is-loading');
      renderAlerts();
    }
  }
}
function alertItem(a, { compact = false } = {}) {
  const ti = typeInfo(a.type);
  const sev = a.severity;
  const amt = fuelAmount(a.amountMv, calFor(a.imei), a.amountL);
  const isNew = S.alerts.newIds.has(a.id);
  const sign = a.type === 'refuel' ? '+' : a.type === 'fuel_drain' ? '−' : '';
  const span = isNum(a.fromT) && isNum(a.t) && a.fromT < a.t - 60e3 ? a.t - a.fromT : null;
  return html`<article class="al sev-${sev} t-${a.type}${a.acked ? ' acked' : ''}${isNew ? ' is-new' : ''}" data-id="${a.id}" data-imei="${a.imei}" data-t="${a.t ?? ''}" tabindex="0" aria-label="${SEV_LABEL[sev]}: ${a.title || ti.label}, ${aName(a)}">
    <div class="al-ico" title="${SEV_LABEL[sev]}">${icon(TYPE_ICON[a.type] || SEV_ICON[sev])}</div>
    <div class="al-main">
      <div class="al-top">
        ${compact ? '' : html`<b class="al-veh">${aName(a)}</b>`}
        <span class="al-title">${a.title || ti.label}</span>
        ${a.ongoing ? html`<span class="tag ongoing">Ongoing</span>` : ''}
        ${a.type === 'fuel_drain' && a.verdict !== 'unchecked' ? html`<span class="tag verdict v-${a.verdict}">${VERDICTS[a.verdict]}</span>` : ''}
        ${a.historical ? html`<span class="tag hist" title="Found while catching up on past data — no notification was sent.">History</span>` : ''}
        ${isNew ? html`<span class="tag new">New</span>` : ''}
      </div>
      <div class="al-meta">
        <span class="sev-label sev-${sev}">${SEV_LABEL[sev]}</span><span class="sep">·</span><span>${ti.label}</span><span class="sep">·</span>
        <time datetime="${isNum(a.t) ? new Date(a.t).toISOString() : ''}" title="${fmtFull(a.t)}">${fmtTime(a.t, now())}</time>
        <span class="muted">(${isNum(a.t) ? relSpan(a.t) : ''})</span>
        ${span ? html`<span class="muted">· over ${fmtDur(span)}</span>` : ''}
      </div>
      ${a.detail ? html`<div class="al-detail">${a.detail}</div>` : ''}
      ${LEDGER_TYPES.includes(a.type) ? reviewControls(a) : ''}
    </div>
    ${amt ? html`<div class="al-amt t-${a.type}"><b>${sign}${amt.main}</b><small>${amt.sub}</small></div>` : html`<div class="al-amt"></div>`}
    <div class="al-act">${a.acked
      ? html`<span class="acked-mark" title="Acknowledged">${icon('check')}<span>Seen</span></span>`
      : html`<button type="button" class="btn small js-ack" data-id="${a.id}" title="Mark as seen">${icon('check')}<span class="hide-sm">Acknowledge</span></button>`}</div>
  </article>`;
}
/** Verdict buttons (fuel drains) and a note field on refuel / fuel drain alerts; both are saved
 *  on the server and written to the Excel fuel ledger. */
function reviewControls(a) {
  const drain = a.type === 'fuel_drain';
  const vb = (v, label, title) => html`<button type="button" class="js-verdict v-${v}" data-id="${a.id}" data-v="${v}" aria-pressed="${String(a.verdict === v)}" title="${title}">${label}</button>`;
  return html`<div class="al-review" data-id="${a.id}">
    ${drain ? html`<div class="seg small verdict-seg" role="group" aria-label="Your verdict">
      ${vb('confirmed', 'Confirmed theft', 'You checked it: fuel really was stolen or lost')}
      ${vb('false_alarm', 'False alarm', 'You checked it: no fuel was lost (not counted in the Excel totals)')}
      ${a.verdict !== 'unchecked' ? vb('unchecked', 'Reset', 'Back to unchecked') : ''}
    </div>` : ''}
    <label class="al-note-wrap"><span class="sr-only">Note</span>
      <input type="text" class="al-note js-note" data-id="${a.id}" data-saved="${a.note}" value="${a.note}" maxlength="${NOTE_MAX}" placeholder="${drain ? 'Add a note (who, what was found…)' : 'Add a note (station, receipt…)'}" autocomplete="off" spellcheck="true" title="Saved when you press Enter or leave the box; goes into the Excel file">
    </label>
    ${(recentSaves.get(String(a.id)) || 0) > Date.now() - 2500 ? html`<span class="note-state ok" aria-live="polite">Saved</span>` : html`<span class="note-state" aria-live="polite"></span>`}
  </div>`;
}
const recentSaves = new Map(); // alert id -> time its review was saved (the "Saved" hint survives re-renders)
const keepInList = new Set(); // alert ids reviewed in this tab: kept in the alert list until it is reloaded
/** Re-render a list of alert cards without losing (or half-saving) a note being typed. */
let rerendering = false;
function keepNoteDrafts(container, render) {
  const drafts = new Map();
  let focus = null;
  for (const inp of $$('.js-note', container)) {
    if (inp.value !== inp.dataset.saved) drafts.set(inp.dataset.id, inp.value);
    if (inp === document.activeElement) focus = { id: inp.dataset.id, a: inp.selectionStart, b: inp.selectionEnd };
  }
  // removing the focused field fires focusout: that is not the user leaving the box
  rerendering = true;
  try { render(); } finally { rerendering = false; }
  if (!drafts.size && !focus) return;
  for (const inp of $$('.js-note', container)) {
    const id = inp.dataset.id;
    if (drafts.has(id)) inp.value = drafts.get(id);
    if (focus && focus.id === id) {
      inp.focus({ preventScroll: true });
      try { inp.setSelectionRange(focus.a, focus.b); } catch { /* not a text field */ }
      focus = null;
    }
  }
}
async function saveReview(id, body, stateEl) {
  if (stateEl) { stateEl.textContent = 'Saving…'; stateEl.className = 'note-state'; }
  keepInList.add(String(id)); // before the request: the SSE update can arrive before its answer
  try {
    const a = await api(`/api/alerts/${encodeURIComponent(id)}/review`, { method: 'PUT', body });
    recentSaves.set(String(id), Date.now());
    if (a && a.id !== undefined) onAlert(a);
    for (const st of $$(`.al-review[data-id="${CSS.escape(String(id))}"] .note-state`)) { st.textContent = 'Saved'; st.className = 'note-state ok'; }
    setTimeout(() => {
      recentSaves.delete(String(id));
      for (const st of $$(`.al-review[data-id="${CSS.escape(String(id))}"] .note-state.ok`)) st.textContent = '';
    }, 2600);
    return true;
  } catch (e) {
    if (stateEl?.isConnected) { stateEl.textContent = 'Not saved'; stateEl.className = 'note-state err'; }
    toast({ sev: 'warning', title: 'Could not save', body: e.message });
    return false;
  }
}
async function setVerdict(btn) {
  const id = btn.dataset.id;
  const pressed = btn.getAttribute('aria-pressed') === 'true';
  const v = pressed ? 'unchecked' : btn.dataset.v; // clicking the chosen verdict again resets it
  const box = btn.closest('.al-review');
  $$('.js-verdict', box).forEach((b) => { b.disabled = true; });
  const ok = await saveReview(id, { verdict: v }, box?.querySelector('.note-state'));
  if (!ok) $$('.js-verdict', box).forEach((b) => { b.disabled = false; });
}
function saveNote(inp) {
  if (rerendering || !inp.isConnected) return; // re-rendered: the draft was carried over to the new field
  const text = inp.value.trim();
  if (text === (inp.dataset.saved || '').trim()) return;
  inp.dataset.saved = inp.value; // not saved twice (blur after Enter)
  saveReview(inp.dataset.id, { note: text }, inp.closest('.al-review')?.querySelector('.note-state')).then((ok) => {
    if (!ok && inp.isConnected) inp.dataset.saved = '\u0000'; // keep it "unsaved" so leaving the box tries again
  });
}
function renderAlerts() {
  keepNoteDrafts($('#alert-list'), renderAlertsNow);
}
function renderAlertsNow() {
  const el = $('#alert-list');
  const st = S.alerts;
  renderTempChip();
  $('#a-more').hidden = !st.hasMore;
  if (!st.f.sev.length) { setHTML(el, emptyState('info', 'Choose at least one severity', 'Use the Critical / Warning / Info buttons above.')); return; }
  if (!st.list.length) {
    if (st.loading || !st.loaded) setHTML(el, html`<div class="empty"><span class="spinner"></span><b>Loading alerts…</b></div>`);
    else if (st.error) setHTML(el, emptyState('wifi-off', 'Could not load alerts', st.error, { id: 'retry-alerts', label: 'Try again' }));
    else setHTML(el, emptyState('check', 'All quiet', st.f.unacked ? 'No unacknowledged alerts match these filters.' : 'No alerts match these filters in this period.'));
    return;
  }
  const groups = [];
  let cur = null;
  const t = now();
  for (const a of st.list) {
    const k = isNum(a.t) ? dayKey(a.t) : 'none';
    if (!cur || cur.k !== k) { cur = { k, t: a.t, items: [] }; groups.push(cur); }
    cur.items.push(a);
  }
  setHTML(el, html`${groups.map((g) => html`<section class="day">
      <h3 class="day-h">${isNum(g.t) ? fmtDayHeading(g.t, t) : 'Unknown date'} <span class="muted">${g.items.length} alert${g.items.length === 1 ? '' : 's'}</span></h3>
      <div class="day-items">${g.items.map((a) => alertItem(a))}</div>
    </section>`)}`);
}
async function ackAlert(id, btn) {
  if (btn) btn.disabled = true;
  try {
    await api(`/api/alerts/${encodeURIComponent(id)}/ack`, { method: 'POST', body: {} });
  } catch (e) {
    if (btn) btn.disabled = false;
    toast({ sev: 'warning', title: 'Could not acknowledge', body: e.message });
    return;
  }
  const mark = (list) => { const a = list?.find((x) => String(x.id) === String(id)); if (a) a.acked = true; };
  mark(S.alerts.list);
  if (S.alerts.f.unacked) S.alerts.list = S.alerts.list.filter((a) => String(a.id) !== String(id));
  if (S.view === 'alerts') renderAlerts();
  if (S.detail?.data) { mark(S.detail.data.alerts); renderDetailAlerts(); }
  refreshVehiclesSoon();
}
async function ackAll() {
  const f = S.alerts.f;
  const who = f.imei ? vName(f.imei) : 'all vehicles';
  if (!window.confirm(`Mark every unacknowledged alert of ${who} as seen?\n\nThis includes all types and dates, not only the ones listed.`)) return;
  try {
    await api('/api/alerts/ack-all', { method: 'POST', body: f.imei ? { imei: f.imei } : {} });
    toast({ sev: 'good', title: 'All alerts acknowledged', body: f.imei ? who : '' });
  } catch (e) {
    toast({ sev: 'warning', title: 'Could not acknowledge', body: e.message });
    return;
  }
  loadAlerts();
  loadVehicles();
  if (S.detail) loadDetail(true);
}

// ---------------------------------------------------------------- REPORT view
function normSummary(x) {
  const imei = String(x.imei);
  const v = S.byImei.get(imei);
  const cal = calFor(imei);
  const n = (k) => (isNum(x[k]) ? Number(x[k]) : null);
  const usedMv = n('fuelUsedMv');
  const usedL = isNum(x.fuelUsedL) ? Number(x.fuelUsedL) : dMvToL(usedMv, cal);
  const dist = n('distanceKm');
  const fuelKm = n('fuelKm');
  const hasFuel = x.hasFuel ?? v?.hasFuel ?? false;
  // "fuel used" only covers the driving between the first and last steady parked reading
  const partial = hasFuel && usedMv !== null && (dist ?? 0) > 20 && (fuelKm ?? 0) < 0.8 * dist;
  const noUse = partial && (fuelKm ?? 0) < 10;
  // % of tank on the same basis as the litres shown (tank table), else linear
  const pctOf = (L, mv) => (isNum(L) && cal.tankLiters ? (Number(L) / cal.tankLiters) * 100 : dMvToPct(mv, cal));
  const refuelL = n('refuelL') ?? dMvToL(n('refuelMv'), cal);
  const drainL = n('drainL') ?? dMvToL(n('drainMv'), cal);
  const counts = x.alerts && typeof x.alerts === 'object' ? x.alerts : {};
  let crit = 0, warn = 0, total = 0;
  for (const [t, c] of Object.entries(counts)) {
    const s = typeInfo(t).severity;
    total += Number(c) || 0;
    if (s === 'critical') crit += Number(c) || 0;
    if (s === 'warning') warn += Number(c) || 0;
  }
  return {
    imei, name: x.name ?? v?.name ?? '', shortName: x.shortName || v?.shortName || shortName(x.name) || imei,
    group: x.group !== undefined ? x.group : v?.group, hasFuel, cal,
    distanceKm: dist, engineHours: n('engineHours'), fuelKm, partial, noUse,
    usedMv, usedL, usedPct: pctOf(usedL, usedMv),
    refuelMv: n('refuelMv'), refuelL, refuelPct: pctOf(refuelL, n('refuelMv')),
    drainMv: n('drainMv'), drainL, drainPct: pctOf(drainL, n('drainMv')),
    // litres per 100 km over the distance the fuel figure actually covers (between the first
    // and last steady parked reading), not the whole period
    rate: (() => { const km = fuelKm ?? dist; return usedL !== null && km >= 10 ? (usedL / km) * 100 : null; })(),
    counts, crit, warn, total,
    _search: [x.shortName, x.name, imei, x.group].filter(Boolean).join(' ').toLowerCase(),
  };
}
async function loadReport() {
  const r = S.report;
  r.loading = true;
  renderReport();
  try {
    const data = await api(`/api/summary?hours=${r.hours}`);
    r.rows = (Array.isArray(data) ? data : []).map(normSummary);
    r.error = null;
    r.loadedAt = Date.now();
    markServer(true);
  } catch (e) {
    r.error = e.message;
    markServer(false, e);
  } finally {
    r.loading = false;
    renderReport();
  }
}
function reportFiltered() {
  const q = $('#r-q').value.trim().toLowerCase();
  const g = $('#r-group').value;
  const fuel = $('#r-fuel').checked;
  return (S.report.rows || []).filter((x) => (!q || x._search.includes(q)) && (!g || groupKey(x.group) === g) && (!fuel || x.hasFuel));
}
/** Sort on the litres shown when both rows have them, else on % of tank. */
const byAmount = (L, pct, skip = () => false) => (a, b) => {
  const sa = skip(a), sb = skip(b);
  if (sa || sb) return sa && sb ? 0 : sa ? -1 : 1;
  if (isNum(a[L]) && isNum(b[L])) return a[L] - b[L];
  return (a[pct] ?? -1) - (b[pct] ?? -1);
};
const R_SORT = {
  name: (a, b) => a.shortName.localeCompare(b.shortName, undefined, { numeric: true }),
  group: (a, b) => groupLabel(a.group).localeCompare(groupLabel(b.group)),
  distance: (a, b) => (a.distanceKm ?? -1) - (b.distanceKm ?? -1),
  engine: (a, b) => (a.engineHours ?? -1) - (b.engineHours ?? -1),
  used: byAmount('usedL', 'usedPct', (x) => x.noUse),
  rate: (a, b) => (a.rate ?? -1) - (b.rate ?? -1),
  refuel: byAmount('refuelL', 'refuelPct'),
  drain: byAmount('drainL', 'drainPct'),
  alerts: (a, b) => (a.crit * 1e6 + a.warn * 1e3 + a.total) - (b.crit * 1e6 + b.warn * 1e3 + b.total),
};
function amountCell(mv, L, pct, cls = '', prefix = '') {
  if (!isNum(mv) && !isNum(L)) return html`<span class="muted">—</span>`;
  if (isNum(L)) return html`<b class="${cls}">${prefix}${fmtNum(L)} L</b><small>${isNum(pct) ? `${fmtNum(pct, 1)}%` : ''}</small>`;
  return html`<b class="${cls}">${prefix}${fmtNum(pct, 1)}%</b><small>${fmtNum(mv)} mV</small>`;
}
/** Fuel used: incomplete when the steady parked readings cover only part of the distance. */
function usedCell(x) {
  if (!x.hasFuel) return html`<span class="muted">no sensor</span>`;
  if (x.noUse) return html`<span class="muted" title="Not enough steady parked readings to measure the fuel used over this distance">—</span>`;
  const cell = amountCell(x.usedMv, x.usedL, x.usedPct, '', x.partial ? '≥ ' : '');
  return x.partial ? html`<span title="Covers ${fmtNum(x.fuelKm ?? 0)} of ${fmtNum(x.distanceKm)} km (between the first and last steady parked reading)">${cell}</span>` : cell;
}
/** Report view: where the Excel fuel ledger is saved and whether it is up to date. */
function renderExcelBar() {
  const el = $('#r-excel-status');
  if (!el) return;
  const x = S.status?.excel;
  $('#r-excel-folder').hidden = !(S.features.openFolder && x && x.enabled && x.file);
  if (!S.features.excelFile) { setHTML(el, html`Made from the latest data when you click <b>Download Excel</b>.`); return; }
  if (!x) { setHTML(el, html`<span class="muted">Status unknown.</span>`); return; }
  const ev = x.events;
  const counts = ev ? html` · ${fmtNum(ev.refuels)} refuel${ev.refuels === 1 ? '' : 's'}, ${fmtNum(ev.thefts)} suspected theft${ev.thefts === 1 ? '' : 's'}` : '';
  if (!x.enabled) {
    setHTML(el, html`Not saved to a file automatically (<code>excelFile</code> is empty in config.json) — use <b>Download Excel</b>.`);
    return;
  }
  const where = html`<span class="excel-path" title="${x.file}">${x.file}</span>`;
  const written = isNum(x.lastWrittenAt) ? html`updated ${relSpan(toMs(x.lastWrittenAt))}` : html`not written yet`;
  let warn = '';
  if (x.locked) warn = html`<div class="excel-warn">${icon('triangle')} The file is open in Excel — it will be updated when you close it${isNum(x.nextRetryAt) ? ' (tried again every minute)' : ''}.</div>`;
  else if (x.lastError) warn = html`<div class="excel-warn">${icon('triangle')} Not saved: ${x.lastError} — ${x.blocked ? 'tried again when something changes' : 'retrying every minute'}.</div>`;
  else if (x.pending) warn = html`<div class="muted">${S.status?.backfill?.running ? 'New changes will be written once the history has loaded.' : 'New changes are being saved…'}</div>`;
  setHTML(el, html`${isNum(x.lastWrittenAt) ? 'Saved automatically to' : 'Will be saved automatically to'} ${where} · ${written}${counts}${warn}`);
}
/** Download the workbook (built on the fly); errors show as a message instead of a broken file. */
async function downloadExcel(link) {
  if (link.classList.contains('busy')) return;
  link.classList.add('busy');
  link.setAttribute('aria-busy', 'true');
  try {
    let res;
    try {
      res = await fetch(link.getAttribute('href'), { cache: 'no-store' });
    } catch {
      throw new Error('Cannot reach the server');
    }
    if (res.status === 401 && S.mode === 'cloud') { showLogin(); throw new Error('Please sign in again.'); }
    if (!res.ok) {
      let msg = `Server error (HTTP ${res.status})`;
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch { /* not JSON */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const cd = res.headers.get('content-disposition') || '';
    let name = 'Fuel events.xlsx';
    const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="([^"]+)"/i.exec(cd);
    if (m) { try { name = decodeURIComponent(m[1]); } catch { name = m[1]; } }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    toast({ sev: 'warning', title: 'Could not create the Excel file', body: e.message });
  } finally {
    link.classList.remove('busy');
    link.removeAttribute('aria-busy');
  }
}
async function openExcelFolder(btn) {
  btn.disabled = true;
  try {
    await api('/api/excel/open-folder', { method: 'POST', body: {} });
    toast({ sev: 'good', title: 'Folder opened', body: 'Look for the Explorer window on this computer.', timeout: 4000 });
  } catch (e) {
    toast({ sev: 'warning', title: 'Could not open the folder', body: e.message });
  } finally {
    btn.disabled = false;
  }
}
function renderReport() {
  renderExcelBar();
  const r = S.report;
  $$('#r-period button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.h) === r.hours)));
  $$('.report-tbl th').forEach((th) => {
    const b = th.querySelector('button');
    th.setAttribute('aria-sort', b && b.dataset.sort === r.sort ? (r.dir > 0 ? 'ascending' : 'descending') : 'none');
  });
  const body = $('#r-body'), empty = $('#r-empty'), tiles = $('#r-tiles');
  document.querySelector('.report-tbl').classList.toggle('is-loading', r.loading && !!r.rows);
  if (!r.rows) {
    body.innerHTML = '';
    tiles.innerHTML = '';
    empty.hidden = false;
    setHTML(empty, r.error ? emptyState('wifi-off', 'Could not load the report', r.error, { id: 'retry-report', label: 'Try again' }) : html`<div class="empty"><span class="spinner"></span><b>Preparing report…</b></div>`);
    return;
  }
  const rows = reportFiltered();
  const cmp = R_SORT[r.sort] || R_SORT.used;
  rows.sort((a, b) => cmp(a, b) * r.dir || R_SORT.name(a, b));
  // Totals for the tiles (same slice as the table)
  let dist = 0, eng = 0, usedL = 0, usedLn = 0, usedPartial = 0, refuelL = 0, refuelN = 0, refuelLn = 0, drainL = 0, drainN = 0, drainLn = 0, crit = 0, active = 0;
  for (const x of rows) {
    dist += x.distanceKm || 0;
    eng += x.engineHours || 0;
    if (x.partial) usedPartial++; // incomplete figures are left out of the total
    else if (x.usedL !== null) { usedL += x.usedL; usedLn++; }
    if (x.refuelMv > 0) { refuelN++; if (x.refuelL !== null) { refuelL += x.refuelL; refuelLn++; } }
    if (x.drainMv > 0) { drainN++; if (x.drainL !== null) { drainL += x.drainL; drainLn++; } }
    crit += x.crit;
    if ((x.distanceKm || 0) > 1) active++;
  }
  const veh = (n) => `${n} vehicle${n === 1 ? '' : 's'}`;
  const tile = (label, value, sub, cls = '') => html`<div class="tile static ${cls}"><span class="t-num">${value}</span><span class="t-lab">${label}</span>${sub ? html`<span class="t-sub">${sub}</span>` : ''}</div>`;
  setHTML(tiles, html`
    ${tile('Distance driven', `${fmtNum(dist)} km`, `${active} vehicle${active === 1 ? '' : 's'} moved`)}
    ${tile('Engine hours', fmtNum(eng, 1), '')}
    ${tile('Fuel used', usedLn ? `${fmtNum(usedL)} L` : '—', usedLn || usedPartial
      ? `${veh(usedLn)}${usedPartial ? ` — ${usedPartial} more with an incomplete figure not counted` : ''}`
      : 'Set tank sizes in Settings to see litres')}
    ${tile('Refuels', !refuelN ? '0' : refuelLn === refuelN ? `${fmtNum(refuelL)} L` : veh(refuelN), !refuelN ? '' : refuelLn === refuelN ? veh(refuelN) : refuelLn ? `${fmtNum(refuelL)} L known (tank size missing for ${refuelN - refuelLn})` : 'set tank sizes to see litres')}
    ${tile('Suspected fuel loss', !drainN ? 'None' : drainLn === drainN ? `${fmtNum(drainL)} L` : veh(drainN), !drainN ? 'no drain alerts (false alarms and cancelled drains not counted)' : drainLn === drainN ? `${veh(drainN)} — false alarms and cancelled drains not counted` : drainLn ? `${fmtNum(drainL)} L known — check the alerts` : 'check the alerts', drainN ? 'hot' : 'calm')}
    ${tile('Critical alerts', fmtNum(crit), '', crit ? 'hot' : 'calm')}
  `);
  if (!rows.length) {
    body.innerHTML = '';
    empty.hidden = false;
    setHTML(empty, emptyState('search', 'No vehicles match', 'Try clearing the search or the group filter.'));
    return;
  }
  empty.hidden = true;
  const typeOrder = Object.keys(S.meta.alertTypes);
  setHTML(body, html`${rows.map((x) => {
    const chips = Object.entries(x.counts).filter(([, c]) => Number(c) > 0)
      .sort((a, b) => SEVS.indexOf(typeInfo(a[0]).severity) - SEVS.indexOf(typeInfo(b[0]).severity) || typeOrder.indexOf(a[0]) - typeOrder.indexOf(b[0]));
    return html`<tr data-imei="${x.imei}" tabindex="0">
      <td class="c-name"><div class="vname">${x.shortName}</div><div class="vsub m-only">${groupLabel(x.group)}</div></td>
      <td class="c-group">${groupLabel(x.group)}</td>
      <td class="num">${isNum(x.distanceKm) ? `${fmtNum(x.distanceKm)} km` : '—'}</td>
      <td class="num c-eng">${isNum(x.engineHours) ? `${fmtNum(x.engineHours, 1)} h` : '—'}</td>
      <td class="num amt">${usedCell(x)}</td>
      <td class="num c-rate">${x.rate !== null ? `${fmtNum(x.rate, 1)} L` : html`<span class="muted">—</span>`}</td>
      <td class="num amt c-refuel">${x.refuelMv > 0 ? amountCell(x.refuelMv, x.refuelL, x.refuelPct, 'good') : html`<span class="muted">—</span>`}</td>
      <td class="num amt">${x.drainMv > 0 ? amountCell(x.drainMv, x.drainL, x.drainPct, 'bad') : html`<span class="muted">—</span>`}</td>
      <td class="c-ralerts">${chips.length ? chips.slice(0, 4).map(([t, c]) => html`<span class="chip sev-${typeInfo(t).severity}" title="${typeLabel(t)}">${icon(TYPE_ICON[t] || SEV_ICON[typeInfo(t).severity])}${c}</span>`) : html`<span class="muted">—</span>`}${chips.length > 4 ? html`<span class="chip">+${chips.length - 4}</span>` : ''}</td>
    </tr>`;
  })}`);
}
function exportCsv() {
  const r = S.report;
  if (!r.rows) return;
  const rows = reportFiltered();
  const cmp = R_SORT[r.sort] || R_SORT.used;
  rows.sort((a, b) => cmp(a, b) * r.dir || R_SORT.name(a, b));
  const types = Object.keys(S.meta.alertTypes);
  const f = (v, d = 1) => (isNum(v) ? Number(v).toFixed(d) : '');
  const head = ['Vehicle', 'Full name', 'IMEI', 'Group', 'Fuel sensor', 'Distance (km)', 'Engine hours', 'Fuel used (L)', 'Fuel used (% of tank)', 'Fuel used (mV)',
    'Litres per 100 km', 'Fuel figure covers (km)', 'Fuel figure complete', 'Refuelled (L)', 'Refuelled (mV)', 'Suspected loss (L)', 'Suspected loss (mV)', ...types.map((t) => `${typeLabel(t)} (count)`)];
  const lines = [head.map(csvCell).join(',')];
  for (const x of rows) {
    lines.push([x.shortName, x.name, x.imei, groupLabel(x.group), x.hasFuel ? 'yes' : 'no', f(x.distanceKm), f(x.engineHours, 2), f(x.usedL), f(x.usedPct), f(x.usedMv, 0),
      f(x.rate), f(x.fuelKm), x.usedMv === null ? '' : x.noUse ? 'no' : x.partial ? 'partial' : 'yes',
      f(x.refuelL), f(x.refuelMv, 0), f(x.drainL), f(x.drainMv, 0), ...types.map((t) => x.counts[t] || 0)].map(csvCell).join(','));
  }
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  downloadText(`fuel-report-${r.hours === 24 ? '24h' : '7days'}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.csv`, '﻿' + lines.join('\r\n'));
}

// ---------------------------------------------------------------- SETTINGS view
function renderSettings() {
  if (!S.settings) {
    setHTML($('#s-rules-fields'), html`<div class="empty"><span class="spinner"></span><b>Loading settings…</b></div>`);
    loadSettings().then(() => { if (S.settings && S.view === 'settings') renderSettings(); else if (!S.settings) setHTML($('#s-rules-fields'), emptyState('wifi-off', 'Could not load settings', 'Check that the program is running.', { id: 'retry-settings', label: 'Try again' })); });
    renderBrowserCard();
    return;
  }
  renderRulesForm();
  renderNotifyForm();
  renderBrowserCard();
  renderCalTable();
}
/** What an mV threshold means in litres: for one calibration (a vehicle), or for each tank
 *  type in the fleet ("≈ 16 L on 480 L tanks, 21 L on 590 L tanks"). */
function ruleEq(k, val, cal) {
  const r = RULE_BY_KEY[k];
  if (!r || !r.eq || !isNum(val)) return '';
  const per = r.per || '';
  const litres = (c) => (Number(val) / Math.abs(c.fullMv - c.emptyMv)) * c.tankLiters;
  if (cal) {
    const c = normCal(cal);
    if (c.tankLiters) return `≈ ${fmtNum(litres(c))} L${per} on this ${fmtNum(c.tankLiters)} L tank`;
    return `≈ ${fmtNum(dMvToPct(Number(val), c), 1)}% of the tank${per}`;
  }
  const types = new Map();
  for (const v of S.vehicles) {
    if (!v.hasFuel || !v.cal?.tankLiters) continue;
    const key = `${v.cal.tankLiters}|${Math.abs(v.cal.fullMv - v.cal.emptyMv)}`;
    const t = types.get(key) || { cal: v.cal, n: 0 };
    t.n++;
    types.set(key, t);
  }
  const list = [...types.values()].sort((a, b) => b.n - a.n).slice(0, 3).sort((a, b) => a.cal.tankLiters - b.cal.tankLiters);
  if (!list.length) return `≈ ${fmtNum(Number(val) / 100, 1)}% of the sensor range${per}`;
  return `≈ ${list.map((t) => `${fmtNum(litres(t.cal))} L${per} on ${fmtNum(t.cal.tankLiters)} L tanks`).join(', ')}`;
}
function renderRulesForm() {
  const th = S.settings.thresholds || {};
  setHTML($('#s-rules-fields'), html`${RULES.map((g) => html`<fieldset class="rule-group"><legend>${g.group}</legend>${g.items.map((r) => {
    const id = `rule-${r.k}`;
    if (r.type === 'bool') {
      return html`<div class="rule"><label class="switch"><input type="checkbox" id="${id}" name="${r.k}" ${th[r.k] ? raw('checked') : ''}><span>${r.label}</span></label><p class="help">${r.help}</p></div>`;
    }
    if (r.type === 'time') {
      return html`<div class="rule rule-inline"><label for="${id}" class="rule-label">${r.label}</label><div class="rule-input"><input type="time" id="${id}" name="${r.k}" value="${th[r.k] ?? ''}"></div><p class="help">${r.help}</p></div>`;
    }
    return html`<div class="rule"><label for="${id}" class="rule-label">${r.label}</label>
      <div class="rule-input"><input type="number" id="${id}" name="${r.k}" inputmode="decimal" min="${r.min}" max="${r.max}" step="${r.step}" value="${th[r.k] ?? ''}" required><span class="unit">${r.unit}</span><output class="eq" data-eq="${r.k}">${ruleEq(r.k, th[r.k])}</output></div>
      <p class="help">${r.help}</p></div>`;
  })}</fieldset>`)}`);
  $('#s-rules-state').textContent = '';
}
function renderNotifyForm() {
  const n = S.settings.notify || {};
  const form = $('#s-notify');
  form.elements.windowsToast.checked = n.windowsToast !== false;
  const sev = Array.isArray(n.severities) ? n.severities : ['critical', 'warning'];
  $$('input[name="sev"]', form).forEach((c) => { c.checked = sev.includes(c.value); });
}
function renderBrowserCard() {
  const perm = $('#s-perm');
  if (!perm) return;
  const p = notifSupported() ? Notification.permission : 'unsupported';
  perm.textContent = {
    granted: 'On — you will get a pop-up when an alert arrives while this tab is in the background.',
    default: 'Off — click Enable and allow notifications when the browser asks.',
    denied: 'Blocked — allow notifications for this site in the browser settings (lock icon in the address bar).',
    unsupported: 'Not available on this address. Open the dashboard on the server computer at http://localhost:8080.',
  }[p];
  const btn = $('#s-perm-btn');
  btn.hidden = p === 'granted' || p === 'unsupported';
  $('#s-sound').checked = !!S.prefs.sound;
  $$('input[name="bsev"]').forEach((c) => { c.checked = S.prefs.bsev.includes(c.value); });
  $('#s-theme').value = S.prefs.theme;
  const note = $('#s-perm-note');
  if (note) {
    const sevs = serverPopupSevs();
    note.hidden = !sevs.length;
    note.textContent = sevs.length
      ? `Windows pop-ups from the program are on for ${sevs.map((x) => SEV_LABEL[x].toLowerCase()).join(' and ')} alerts, so the browser does not pop those up again (it still shows them inside this page).`
      : '';
  }
}
function calRowDirty(tr) { tr.querySelector('.js-save').disabled = false; tr.classList.add('dirty'); }
function renderCalTable() {
  const tbody = $('#sv-body');
  if (tbody.querySelector('tr.dirty')) return; // do not clobber unsaved edits
  const q = $('#sv-q').value.trim().toLowerCase();
  const all = $('#sv-all').checked;
  const list = S.vehicles.filter((v) => (all || v.hasFuel) && (!q || v._search.includes(q)))
    .sort((a, b) => (b.hasFuel - a.hasFuel) || a.shortName.localeCompare(b.shortName, undefined, { numeric: true }));
  if (!list.length) {
    setHTML(tbody, html`<tr><td colspan="8">${S.vehiclesLoaded ? emptyState('search', 'No vehicles match', '') : html`<div class="empty"><span class="spinner"></span><b>Loading…</b></div>`}</td></tr>`);
    return;
  }
  setHTML(tbody, html`${list.map((v) => {
    const vs = S.settings?.vehicles?.[v.imei] || {};
    const cal = normCal(v.cal || vs.cal);
    const nOver = Object.values(vs.th || {}).filter((x) => x !== null && x !== undefined && x !== '').length;
    const dis = v.hasFuel ? '' : raw('disabled');
    return html`<tr data-imei="${v.imei}">
      <td><div class="vname">${v.shortName}</div><div class="vsub">${groupLabel(v.group)}${v.hasFuel && v.cal.source === 'gps-server' ? html` · <span title="Litres come from the tank table set up on the GPS server. Enter your own values to override it.">tank table</span>` : ''}</div></td>
      <td class="num">${v.hasFuel ? (v.fuel && isNum(v.fuel.mv) ? `${fmtNum(v.fuel.mv)} mV` : html`<span class="muted">—</span>`) : html`<span class="muted">no sensor</span>`}</td>
      <td class="num"><input type="number" name="emptyMv" min="0" max="20000" step="1" value="${cal.emptyMv}" ${dis} aria-label="Empty reading, ${v.shortName}"></td>
      <td class="num"><input type="number" name="fullMv" min="0" max="20000" step="1" value="${cal.fullMv}" ${dis} aria-label="Full reading, ${v.shortName}"></td>
      <td class="num"><input type="number" name="tankLiters" min="1" max="10000" step="1" value="${cal.tankLiters ?? ''}" placeholder="—" ${dis} aria-label="Tank size in litres, ${v.shortName}"></td>
      <td><label class="switch sm"><input type="checkbox" name="muted" ${v.muted ? raw('checked') : ''}><span class="sr-only">Mute ${v.shortName}</span></label></td>
      <td>${nOver ? html`<button type="button" class="link js-open" data-imei="${v.imei}">${nOver} custom</button>` : html`<button type="button" class="link subtle js-open" data-imei="${v.imei}">none</button>`}</td>
      <td><button type="button" class="btn small primary js-save" disabled>Save</button></td>
    </tr>`;
  })}`);
}
function readCal(get) {
  const e = get('emptyMv'), f = get('fullMv'), t = get('tankLiters');
  const cal = { emptyMv: Number(e), fullMv: Number(f), tankLiters: t === '' || t === null || t === undefined ? null : Number(t) };
  if (!isNum(e) || !isNum(f)) return { error: 'Enter numbers for the empty and full readings.' };
  if (Math.abs(cal.fullMv - cal.emptyMv) < 100) return { error: 'Full and empty readings must differ by at least 100 mV.' };
  if (cal.emptyMv < 0 || cal.fullMv < 0 || cal.emptyMv > 20000 || cal.fullMv > 20000) return { error: 'Readings must be between 0 and 20 000 mV.' };
  if (cal.tankLiters !== null && !(cal.tankLiters > 0 && cal.tankLiters <= 10000)) return { error: 'Tank size must be between 1 and 10 000 litres (or empty).' };
  return { cal };
}
async function saveVehicleSettings(imei, body) {
  const res = await api(`/api/vehicles/${encodeURIComponent(imei)}/settings`, { method: 'PUT', body });
  if (S.settings) {
    S.settings.vehicles = S.settings.vehicles || {};
    const cur = S.settings.vehicles[imei] || {};
    if (res && res.settings && typeof res.settings === 'object') S.settings.vehicles[imei] = res.settings;
    else {
      const th = { ...(cur.th || {}) };
      for (const [k, val] of Object.entries(body.th || {})) { if (val === null) delete th[k]; else th[k] = val; }
      S.settings.vehicles[imei] = { ...cur, ...body, th };
    }
  }
  const v = S.byImei.get(imei);
  if (res && res.vehicle && String(res.vehicle.imei) === imei && v) {
    const nv = normVehicle(res.vehicle);
    const i = S.vehicles.indexOf(v);
    if (i >= 0) S.vehicles[i] = nv;
    S.byImei.set(imei, nv);
  } else if (v) {
    if (body.cal) v.cal = normCal(body.cal);
    if (body.muted !== undefined) v.muted = !!body.muted;
  }
  if (S.view === 'fleet') renderFleet();
  if (S.detail && S.detail.imei === imei) { renderDetailHead(); renderDetailStats(); if (S.detail.data) drawDetailChart(true); renderDetailAlerts(); }
  refreshVehiclesSoon();
}

// ---------------------------------------------------------------- VEHICLE DETAIL drawer
function hoursFor(at) {
  if (!isNum(at)) return 24;
  const age = now() - at;
  if (age <= 20 * HOUR) return 24;
  if (age <= 44 * HOUR) return 48;
  return 168;
}
const focusSpan = (hours) => (hours <= 24 ? 6 * HOUR : hours <= 48 ? 10 * HOUR : 36 * HOUR);
const HISTORY_KEPT_H = 168; // the server keeps detailed samples this long
const beyondHistory = (at) => isNum(at) && at < now() - HISTORY_KEPT_H * HOUR;
/** Opened from an alert older than the detailed history: show that alert's card and a note
 *  instead of zooming the chart into an empty window. */
async function showOldAlert(d, at) {
  d.oldAlert = { t: at, alert: null };
  renderDetailAlerts();
  let a = S.alerts.list.find((x) => x.imei === d.imei && x.t === at) || null;
  if (!a) {
    try {
      const r = await api(`/api/alerts?imei=${encodeURIComponent(d.imei)}&since=${Math.round(at) - 1000}&until=${Math.round(at) + 1000}&limit=5`);
      a = (Array.isArray(r) ? r.map(normAlert) : []).find((x) => x.t === at) || (Array.isArray(r) && r[0] ? normAlert(r[0]) : null);
    } catch { a = null; }
  }
  if (S.detail !== d || !d.oldAlert || d.oldAlert.t !== at) return;
  d.oldAlert.alert = a;
  renderDetailAlerts();
}
function showDrawer(imei, at) {
  const dr = $('#drawer');
  if (S.detail && S.detail.imei === imei) {
    if (isNum(at) && at !== S.detail.at) {
      S.detail.at = at;
      const need = hoursFor(at);
      if (need > S.detail.hours) { S.detail.hours = need; setRangeButtons(); loadDetail(); }
      else if (beyondHistory(at)) showOldAlert(S.detail, at);
      else if (S.detail.data) focusChartOn(at);
    }
    return;
  }
  teardownDetail();
  if (dr.hidden) S.lastFocus = document.activeElement;
  S.detail = { imei, at, hours: hoursFor(at), data: null, chart: null, map: null, marker: null, alertLayer: null, req: 0, loadedAt: 0 };
  dr.hidden = false;
  document.body.classList.add('drawer-open');
  requestAnimationFrame(() => dr.classList.add('open'));
  $('#d-body').scrollTop = 0;
  setRangeButtons();
  renderDetailHead();
  renderDetailStats();
  renderDetailForm();
  setHTML($('#d-alerts'), html`<div class="empty small"><span class="spinner"></span>Loading…</div>`);
  $('#d-levels').innerHTML = '';
  $('#d-zoomreset').hidden = true;
  S.detail.chart = new FuelChart($('#d-chart'), {
    onAlertClick: (a) => highlightDetailAlert(a.t, a.id),
    onZoomChange: (z) => { $('#d-zoomreset').hidden = !z; },
  });
  initDetailMap();
  loadDetail();
  setTimeout(() => $('#d-close')?.focus({ preventScroll: true }), 60);
}
function hideDrawer() {
  const dr = $('#drawer');
  if (!S.detail && dr.hidden) return;
  teardownDetail();
  dr.classList.remove('open');
  document.body.classList.remove('drawer-open');
  setTimeout(() => { if (!S.detail) dr.hidden = true; }, 230);
  if (S.lastFocus && document.contains(S.lastFocus)) { try { S.lastFocus.focus({ preventScroll: true }); } catch { /* ignore */ } }
  S.lastFocus = null;
}
function teardownDetail() {
  const d = S.detail;
  if (!d) return;
  try { d.chart?.destroy(); } catch { /* ignore */ }
  try { d.map?.remove(); } catch { /* ignore */ }
  const m = $('#d-map');
  m.className = 'd-map';
  m.textContent = '';
  S.detail = null;
}
function setRangeButtons() {
  const h = S.detail?.hours ?? 24;
  $$('#d-range button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.h) === h)));
}
function renderDetailHead() {
  const d = S.detail;
  if (!d) return;
  const v = S.byImei.get(d.imei);
  $('#d-title').textContent = v ? v.shortName : S.vehiclesLoaded ? 'Unknown vehicle' : 'Loading…';
  setHTML($('#d-sub'), v
    ? html`${statusPill(v)}<span>${groupLabel(v.group)}</span>${v.device ? html`<span class="sep">·</span><span>${v.device}</span>` : ''}<span class="sep">·</span><span class="mono">IMEI ${v.imei}</span>${v.muted ? html`<span class="tag">${icon('mute')}Muted</span>` : ''}${v.name && v.name.trim() !== v.shortName ? html`<div class="d-fullname">${v.name}</div>` : ''}`
    : html`<span class="mono">IMEI ${d.imei}</span>`);
}
function renderDetailStats() {
  const d = S.detail;
  if (!d) return;
  const v = S.byImei.get(d.imei);
  const el = $('#d-stats');
  if (!v) { setHTML(el, S.vehiclesLoaded ? emptyState('search', 'Vehicle not found', 'It may have been removed from the GPS account.') : html`<div class="empty small"><span class="spinner"></span>Loading…</div>`); return; }
  const f = v.fuel;
  const th = thFor(v.imei);
  let fuelBlock;
  const fs = v.hasFuel ? fuelState(v) : null;
  if (!v.hasFuel) fuelBlock = html`<div class="big-fuel none"><span class="bf-num">—</span><span class="bf-sub">This vehicle has no fuel sensor.</span></div>`;
  else if (fs === 'fault') fuelBlock = html`<div class="big-fuel nosig"><span class="bf-num">No signal</span><span class="bf-sub">The fuel sensor is not giving valid readings (disconnected, stuck or faulty), so no level is shown — its readings are not reliable.</span></div>`;
  else if (fs === 'offline') fuelBlock = html`<div class="big-fuel wait"><span class="bf-num">No data</span><span class="bf-sub">${v.lastSeen ? `Offline since ${fmtFull(v.lastSeen)}.` : 'This vehicle has not reported.'} The level is measured again once it reports while parked.</span></div>`;
  else if (fs === 'wait') fuelBlock = html`<div class="big-fuel wait"><span class="bf-num">Waiting…</span><span class="bf-sub">The level is measured when the vehicle stands still. No steady reading yet.</span></div>`;
  else {
    const p = clamp(fuelPct(v), 0, 100);
    const L = fuelLitres(v);
    const low = Number(th.lowFuelPct ?? 10);
    fuelBlock = html`<div class="big-fuel ${p <= low ? 'low' : p <= 25 ? 'mid' : ''}">
      <div class="bf-top"><span class="bf-num">${fmtNum(p)}%</span>${L !== null ? html`<span class="bf-l">${fmtNum(L)} L${v.cal.tankLiters ? ` of ${fmtNum(v.cal.tankLiters)}` : ''}</span>` : ''}</div>
      <span class="gbar big"><i style="width:${p.toFixed(1)}%"></i></span>
      <span class="bf-sub">${fmtNum(f.mv)} mV · measured ${f.trustedAt ? relSpan(f.trustedAt) : 'recently'} while parked</span></div>`;
  }
  const pwr = v.pwrMv;
  const pcut = Number(th.powerCutMv ?? 5000);
  const off = v.status === 'offline';
  // engine state follows the status (charging voltage / movement); the ignition wire alone
  // reads "on" permanently on many trackers
  const engine = off ? '—' : v.status === 'moving' || v.status === 'idle' ? 'On' : 'Off';
  const engineNote = off ? (v.ign === 1 ? 'last known: ignition on' : v.ign === 0 ? 'last known: off' : '')
    : engine === 'Off' && v.ign === 1 ? 'ignition wire reads on' : '';
  const pwrTxt = isNum(pwr) ? `${fmtNum(pwr / 1000, 1)} V` : '—';
  setHTML(el, html`
    <div class="stat fuel-stat"><span class="k">${icon('fuel')}Fuel in tank</span>${fuelBlock}</div>
    <div class="stat"><span class="k">Status</span><span class="v">${statusPill(v)}</span><small>${v.status === 'offline' ? STATUS.offline.long : statusLong(v)}</small></div>
    <div class="stat"><span class="k">Speed</span><span class="v">${v.status === 'offline' || v.speed === null ? '—' : `${fmtNum(v.speed)} km/h`}</span></div>
    <div class="stat"><span class="k">Engine</span><span class="v">${engine}</span><small>${engineNote}</small></div>
    <div class="stat"><span class="k">Tracker power</span><span class="v">${off ? '—' : pwrTxt}</span><small>${off ? (isNum(pwr) ? `last known ${pwrTxt}` : '') : isNum(pwr) && pwr < pcut ? 'off — battery switch?' : ''}</small></div>
    <div class="stat"><span class="k">Last report</span><span class="v">${relSpan(v.lastSeen)}</span><small>${v.lastSeen ? fmtFull(v.lastSeen) : ''}</small></div>
    <div class="stat"><span class="k">Open alerts</span><span class="v badges">${alertBadges(v.activeAlerts, v.muted)}${!v.activeAlerts.critical && !v.activeAlerts.warning ? html`<span class="none-txt">None</span>` : ''}</span>${(v.activeAlerts.critical || v.activeAlerts.warning) ? html`<button type="button" class="link small" data-action="ack-vehicle">Acknowledge all</button>` : ''}</div>
  `);
}
async function loadDetail(keepView = false) {
  const d = S.detail;
  if (!d) return;
  const req = ++d.req;
  const hours = d.hours;
  const host = $('#d-chart');
  host.classList.add('loading');
  try {
    const data = await api(`/api/vehicles/${encodeURIComponent(d.imei)}/history?hours=${hours}`);
    if (S.detail !== d || req !== d.req) return;
    const to = now();
    d.data = {
      track: Array.isArray(data?.track) ? data.track : [],
      samples: Array.isArray(data?.samples) ? data.samples : [],
      levels: Array.isArray(data?.levels) ? data.levels : [],
      alerts: (Array.isArray(data?.alerts) ? data.alerts : []).map(normAlert).sort((a, b) => (b.t ?? 0) - (a.t ?? 0)),
      from: to - hours * HOUR,
      to,
    };
    for (const a of d.data.alerts) S.seen.add(a.id);
    d.loadedAt = Date.now();
    d.error = null;
    drawDetailChart(keepView);
    renderDetailAlerts();
    renderLevelsTable();
    updateDetailMap();
    if (isNum(d.at) && !keepView) {
      if (beyondHistory(d.at)) showOldAlert(d, d.at);
      else focusChartOn(d.at);
    }
  } catch (e) {
    if (S.detail !== d || req !== d.req) return;
    d.error = e.message;
    if (!d.data) setHTML($('#d-alerts'), emptyState('wifi-off', 'Could not load history', e.message, { id: 'retry-detail', label: 'Try again' }));
    toast({ sev: 'warning', title: 'Could not load vehicle history', body: e.message });
  } finally {
    if (S.detail === d && req === d.req) host.classList.remove('loading');
  }
}
function drawDetailChart(keepView) {
  const d = S.detail;
  if (!d || !d.data || !d.chart) return;
  const v = S.byImei.get(d.imei);
  d.chart.setData({ ...d.data, cal: calFor(d.imei), th: thFor(d.imei), hasFuel: v ? v.hasFuel : true, sensorOk: v?.fuel?.sensorOk !== false, typeLabel }, { keepView });
  $('#d-zoomreset').hidden = !d.chart.isZoomed();
}
function renderDetailAlerts() {
  const d = S.detail;
  if (!d || !d.data) return;
  const list = d.data.alerts;
  const el = $('#d-alerts');
  const old = d.oldAlert;
  const oldBlock = old ? html`<div class="old-alert"><p class="help">${icon('info')} Detailed history is kept for 7 days; this alert is from ${fmtFull(old.t)}, so the chart shows the last 7 days instead.</p>${old.alert ? alertItem(old.alert, { compact: true }) : ''}</div>` : '';
  if (!list.length) { keepNoteDrafts(el, () => setHTML(el, html`${oldBlock}${emptyState('check', 'No alerts', `Nothing unusual in the last ${d.hours === 168 ? '7 days' : d.hours + ' hours'}.`)}`)); return; }
  keepNoteDrafts(el, () => setHTML(el, html`${oldBlock}${list.slice(0, 100).map((a) => alertItem(a, { compact: true }))}${list.length > 100 ? html`<p class="muted small">Showing the latest 100 of ${list.length}.</p>` : ''}`));
}
/** Zoom the detail chart around an alert moment (covering the whole anomaly when it has a start). */
function focusChartOn(t, id) {
  const d = S.detail;
  if (!d || !d.chart || !isNum(t)) return;
  const a = d.data?.alerts.find((x) => (id !== undefined && String(x.id) === String(id)) || x.t === t);
  let center = t, span = focusSpan(d.hours);
  if (a && isNum(a.fromT) && a.fromT < a.t) {
    center = (a.fromT + a.t) / 2;
    span = Math.max(span, (a.t - a.fromT) * 1.6);
  }
  d.chart.focus(center, span);
  highlightDetailAlert(t, a ? a.id : id);
}
function highlightDetailAlert(t, id) {
  const el = $('#d-alerts');
  $$('.al.focus', el).forEach((x) => x.classList.remove('focus'));
  let target = null;
  if (id !== undefined) target = el.querySelector(`.al[data-id="${CSS.escape(String(id))}"]`);
  if (!target && isNum(t)) target = $$('.al', el).find((x) => Number(x.dataset.t) === t);
  if (target) {
    target.classList.add('focus');
    target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}
function renderLevelsTable() {
  const d = S.detail;
  if (!d || !d.data) return;
  const cal = calFor(d.imei);
  const lv = d.data.levels.filter((l) => Array.isArray(l) && isNum(l[0]) && isNum(l[1])).slice().sort((a, b) => b[0] - a[0]);
  if (!lv.length) { setHTML($('#d-levels'), html`<p class="muted small">No trusted readings in this period.</p>`); return; }
  const fault = S.byImei.get(d.imei)?.fuel?.sensorOk === false;
  setHTML($('#d-levels'), html`${fault ? html`<p class="help warn-text">The fuel sensor is faulty — these readings are not reliable.</p>` : ''}<table class="tbl mini${fault ? ' fault' : ''}"><thead><tr><th>Time</th><th class="num">Level</th>${cal.tankLiters ? html`<th class="num">Litres</th>` : ''}<th class="num">Sensor (mV)</th></tr></thead><tbody>
    ${lv.slice(0, 400).map(([t, mv]) => html`<tr><td>${fmtFull(t)}</td><td class="num">${fmtNum(mvToPct(mv, cal), 1)}%</td>${cal.tankLiters ? html`<td class="num">${fmtNum((mvToPct(mv, cal) / 100) * cal.tankLiters)} L</td>` : ''}<td class="num">${fmtNum(mv)}</td></tr>`)}
  </tbody></table>`);
}
function initDetailMap() {
  const d = S.detail;
  const el = $('#d-map');
  if (!d) return;
  if (!window.L) { el.classList.add('no-map'); el.textContent = 'Map unavailable (no internet connection to load the map).'; return; }
  d.map = L.map(el, { zoomControl: true, scrollWheelZoom: false, attributionControl: true }).setView([46.8, 103.8], 5);
  L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTR }).addTo(d.map);
  d.alertLayer = L.layerGroup().addTo(d.map);
  d.centered = false;
  updateDetailMap();
  setTimeout(() => { if (S.detail === d) d.map?.invalidateSize(); }, 260);
}
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'; }
function updateDetailMap() {
  const d = S.detail;
  if (!d) return;
  const v = S.byImei.get(d.imei);
  const foot = $('#d-map-foot');
  if (v && validLatLng(v)) {
    setHTML(foot, html`${icon('pin')}<span class="mono">${v.lat.toFixed(5)}, ${v.lng.toFixed(5)}</span><a class="link" href="https://www.openstreetmap.org/?mlat=${v.lat}&mlon=${v.lng}#map=14/${v.lat}/${v.lng}" target="_blank" rel="noopener noreferrer">Open larger map</a>`);
  } else setHTML(foot, html`<span class="muted">No position reported yet.</span>`);
  if (!d.map || !v || !validLatLng(v)) return;
  if (!d.marker) d.marker = L.marker([v.lat, v.lng], { icon: markerIcon(v), keyboard: false, zIndexOffset: 1000 }).addTo(d.map);
  else { d.marker.setLatLng([v.lat, v.lng]); d.marker.setIcon(markerIcon(v)); }
  d.alertLayer.clearLayers();
  // Route driven in the chart period (history.track = [[t, lat, lng, speed], ...])
  const pts = (d.data?.track || []).filter((p) => Array.isArray(p) && isNum(p[1]) && isNum(p[2]) && !(Number(p[1]) === 0 && Number(p[2]) === 0)).map((p) => [Number(p[1]), Number(p[2])]);
  if (pts.length > 1) L.polyline(pts, { color: cssVar('--accent'), weight: 3, opacity: 0.7, interactive: false }).addTo(d.alertLayer);
  if (!d.centered || (pts.length > 1 && !d.trackFitted)) {
    if (pts.length > 1) { d.map.fitBounds(L.latLngBounds([...pts, [v.lat, v.lng]]), { padding: [18, 18], maxZoom: 13 }); d.trackFitted = true; }
    else d.map.setView([v.lat, v.lng], 12);
    d.centered = true;
  }
  const colors = { critical: cssVar('--crit'), warning: cssVar('--warn'), info: cssVar('--info') };
  for (const a of d.data?.alerts || []) {
    if (!isNum(a.lat) || !isNum(a.lng) || (Number(a.lat) === 0 && Number(a.lng) === 0)) continue;
    const c = a.type === 'refuel' ? cssVar('--good') : colors[a.severity];
    L.circleMarker([Number(a.lat), Number(a.lng)], { radius: 6, color: cssVar('--surface'), weight: 2, fillColor: c, fillOpacity: 0.95 })
      .bindTooltip(esc(`${a.title || typeLabel(a.type)} — ${fmtTime(a.t, now())}`))
      .on('click', () => focusChartOn(a.t, a.id))
      .addTo(d.alertLayer);
  }
}
function renderDetailForm() {
  const d = S.detail;
  if (!d) return;
  const form = $('#d-form');
  const v = S.byImei.get(d.imei);
  const vs = S.settings?.vehicles?.[d.imei] || {};
  const cal = normCal(v?.cal || vs.cal);
  const th = vs.th || {};
  const g = S.settings?.thresholds || {};
  const nOver = OVERRIDE_KEYS.filter((k) => isNum(th[k])).length;
  const muted = v ? v.muted : !!vs.muted;
  setHTML(form, html`
    <h3>Settings for this vehicle</h3>
    <div class="form-grid3">
      <label class="field"><span>Empty reading (mV)</span><input type="number" name="emptyMv" min="0" max="20000" step="1" value="${cal.emptyMv}"></label>
      <label class="field"><span>Full reading (mV)</span><input type="number" name="fullMv" min="0" max="20000" step="1" value="${cal.fullMv}"></label>
      <label class="field"><span>Tank size (litres)</span><input type="number" name="tankLiters" min="1" max="10000" step="1" value="${cal.tankLiters ?? ''}" placeholder="unknown"></label>
    </div>
    <p class="help">${v?.fuel && isNum(v.fuel.mv) ? `Latest settled reading: ${fmtNum(v.fuel.mv)} mV. ` : ''}${v?.fuel && isNum(v.fuel.rawMv) ? `Sensor right now: ${fmtNum(v.fuel.rawMv)} mV${v.status === 'moving' ? ' (moving, unreliable)' : ''}. ` : ''}${cal.source === 'gps-server' ? 'Litres currently come from the tank table set up on the GPS server; change these boxes only to override it. ' : ''}To calibrate, note the settled reading with an almost empty tank, and again right after filling it up. With the tank size set, amounts are shown in litres.${cal.source === 'user' ? html` <button type="button" class="link" data-action="reset-cal">Use the default calibration</button>` : ''}</p>
    <label class="switch"><input type="checkbox" name="muted" ${muted ? raw('checked') : ''}><span>Mute notifications for this vehicle</span></label>
    <p class="help">Alerts are still recorded and listed, but no pop-ups, sounds or Windows messages are sent.</p>
    <details class="overrides" ${nOver ? raw('open') : ''}>
      <summary>Own alert rules for this vehicle ${nOver ? html`<span class="tag">${nOver} set</span>` : html`<span class="muted">(using fleet-wide rules)</span>`}</summary>
      <p class="help">Leave a box empty to use the fleet-wide value shown in grey.</p>
      <div class="form-grid3">${OVERRIDE_KEYS.map((k) => html`<label class="field"><span>${RULE_BY_KEY[k].label} <small>${RULE_BY_KEY[k].unit}</small></span><input type="number" name="th_${k}" inputmode="decimal" min="0" step="any" value="${isNum(th[k]) ? th[k] : ''}" placeholder="${isNum(g[k]) ? String(g[k]) : ''}">${RULE_BY_KEY[k].eq ? html`<output class="eq small" data-veq="${k}">${ruleEq(k, isNum(th[k]) ? th[k] : g[k], cal)}</output>` : ''}</label>`)}</div>
    </details>
    <div class="form-actions"><button type="submit" class="btn primary">Save vehicle settings</button><span class="save-state" role="status"></span></div>
  `);
}
async function saveDetailForm(e) {
  e.preventDefault();
  const d = S.detail;
  if (!d) return;
  const form = $('#d-form');
  const fd = new FormData(form);
  const state = form.querySelector('.save-state');
  const { cal, error } = readCal((k) => fd.get(k));
  if (error) { state.textContent = error; state.className = 'save-state err'; return; }
  const th = {};
  for (const k of OVERRIDE_KEYS) {
    const val = fd.get('th_' + k);
    if (val !== null && val !== '') {
      if (!isNum(val) || Number(val) < 0) { state.textContent = `“${RULE_BY_KEY[k].label}” must be a positive number.`; state.className = 'save-state err'; return; }
      th[k] = Number(val);
    } else th[k] = null; // null = remove this vehicle's own value, use the fleet-wide rule
  }
  const body = { cal, th, muted: fd.get('muted') === 'on' };
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  state.textContent = 'Saving…';
  state.className = 'save-state';
  try {
    await saveVehicleSettings(d.imei, body);
    if (S.detail !== d) return;
    state.textContent = 'Saved';
    state.className = 'save-state ok';
    const n = Object.values(th).filter((x) => x !== null).length;
    const sum = form.querySelector('.overrides summary');
    if (sum) setHTML(sum, html`Own alert rules for this vehicle ${n ? html`<span class="tag">${n} set</span>` : html`<span class="muted">(using fleet-wide rules)</span>`}`);
  } catch (err) {
    state.textContent = `Not saved: ${err.message}`;
    state.className = 'save-state err';
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- event wiring
function bindStatic() {
  window.addEventListener('hashchange', route);
  document.addEventListener('pointerdown', unlockAudio, { passive: true });
  document.addEventListener('keydown', (e) => {
    // alert notes: Enter saves, Escape puts back the saved text
    const note = e.target.closest?.('.js-note');
    if (note) {
      if (e.key === 'Enter') { e.preventDefault(); saveNote(note); note.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); note.value = note.dataset.saved === '\u0000' ? note.value : (note.dataset.saved || ''); note.blur(); }
      return;
    }
    if (e.key === 'Escape' && S.detail) {
      if (document.activeElement && document.activeElement.closest('.leaflet-container')) return;
      closeVehicle();
    }
  });
  document.addEventListener('focusout', (e) => {
    if (e.target.matches?.('.js-note')) saveNote(e.target);
  });

  // Top bar
  $('#btn-notif').addEventListener('click', requestNotif);
  $('#btn-sound').addEventListener('click', () => {
    S.prefs.sound = !S.prefs.sound;
    savePref('sound', S.prefs.sound);
    if (S.prefs.sound) beep('warning');
    renderNotifBtn();
  });
  $('#btn-test').addEventListener('click', testNotification);
  // Counter badges show a temporary view; the Alerts tab's own (saved) filters are kept.
  const showOpen = (sev) => {
    showTempAlerts({ sev: [sev], unacked: true, range: 2160, type: '', imei: '' }, `unacknowledged ${sev === 'critical' ? 'critical alerts' : 'warnings'}, last 90 days`);
  };
  $('#cnt-crit').addEventListener('click', () => showOpen('critical'));
  $('#cnt-warn').addEventListener('click', () => showOpen('warning'));

  // Generic actions (buttons rendered inside empty states, banners, etc.)
  document.addEventListener('click', (e) => {
    const act = e.target.closest('[data-action]');
    if (act) {
      const a = act.dataset.action;
      if (a === 'retry-vehicles') { S.vehiclesError = null; renderFleet(); loadVehicles(); }
      else if (a === 'retry-alerts') loadAlerts();
      else if (a === 'retry-report') loadReport();
      else if (a === 'retry-settings') renderSettings();
      else if (a === 'retry-detail') loadDetail();
      else if (a === 'clear-fleet') {
        Object.assign(S.fleet, { q: '', group: '', status: '', fuel: false, problems: false });
        syncFleetControls();
        renderFleet();
      } else if (a === 'enable-notif') requestNotif();
      else if (a === 'dismiss-notif-hint') { savePref('notifHintDismissed', true); renderBanners(); }
      else if (a === 'alerts-show-saved') restoreAlertFilters();
      else if (a === 'ack-vehicle' && S.detail) ackVehicle(S.detail.imei);
      else if (a === 'reset-cal' && S.detail) resetCalibration(S.detail.imei);
      return;
    }
    const ack = e.target.closest('.js-ack');
    if (ack) { e.stopPropagation(); ackAlert(ack.dataset.id, ack); return; }
    const verdict = e.target.closest('.js-verdict');
    if (verdict) { e.stopPropagation(); setVerdict(verdict); return; }
    const open = e.target.closest('[data-open]');
    if (open) { openVehicle(open.dataset.open); return; }
    const closeBtn = e.target.closest('[data-close]');
    if (closeBtn) { closeVehicle(); }
  });

  // Fleet
  $('#f-q').addEventListener('input', debounce((e) => { S.fleet.q = e.target.value; renderFleet(); }, 120));
  $('#f-group').addEventListener('change', (e) => { S.fleet.group = e.target.value; saveFleet(); renderFleet(); });
  $('#f-status').addEventListener('change', (e) => { S.fleet.status = e.target.value; saveFleet(); renderFleet(); });
  $('#f-fuel').addEventListener('change', (e) => { S.fleet.fuel = e.target.checked; saveFleet(); renderFleet(); });
  $('#f-problems').addEventListener('change', (e) => { S.fleet.problems = e.target.checked; saveFleet(); renderFleet(); });
  $('#fleet-tiles').addEventListener('click', (e) => {
    const t = e.target.closest('[data-tile]');
    if (!t) return;
    const k = t.dataset.tile;
    const f = S.fleet;
    if (k === 'all') Object.assign(f, { status: '', fuel: false, problems: false });
    else if (k === 'fuel') f.fuel = !f.fuel;
    else if (k === 'problems') f.problems = !f.problems;
    else f.status = f.status === k ? '' : k;
    syncFleetControls();
    saveFleet();
    renderFleet();
  });
  $('.fleet-tbl thead').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]');
    if (!b) return;
    const k = b.dataset.sort;
    if (S.fleet.sort === k) S.fleet.dir = -S.fleet.dir;
    else { S.fleet.sort = k; S.fleet.dir = SORT_DEFAULT_DIR[k] ?? 1; }
    saveFleet();
    renderFleet();
  });
  const rowOpen = (tbodySel) => {
    const tb = $(tbodySel);
    tb.addEventListener('click', (e) => {
      if (e.target.closest('a, button, input, label')) return;
      const tr = e.target.closest('tr[data-imei]');
      if (tr) openVehicle(tr.dataset.imei);
    });
    tb.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const tr = e.target.closest('tr[data-imei]');
      if (tr && e.target === tr) { e.preventDefault(); openVehicle(tr.dataset.imei); }
    });
  };
  rowOpen('#fleet-body');
  rowOpen('#r-body');

  // Map
  $('#map-filter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]');
    if (!b) return;
    S.map.filter = b.dataset.f;
    savePref('mapFilter', S.map.filter);
    renderMap();
  });
  $('#map-names').addEventListener('change', (e) => {
    S.map.names = e.target.checked;
    savePref('mapNames', S.map.names);
    renderMap();
  });
  $('#map-fit').addEventListener('click', fitMap);

  // Alerts
  $('#a-sev').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sev]');
    if (!b) return;
    const f = S.alerts.f;
    const s = b.dataset.sev;
    f.sev = f.sev.includes(s) ? f.sev.filter((x) => x !== s) : SEVS.filter((x) => x === s || f.sev.includes(x));
    alertFilterChanged();
  });
  $('#a-type').addEventListener('change', (e) => { S.alerts.f.type = e.target.value; alertFilterChanged(); });
  $('#a-veh').addEventListener('change', (e) => { S.alerts.f.imei = e.target.value; alertFilterChanged(); });
  $('#a-range').addEventListener('change', (e) => { S.alerts.f.range = Number(e.target.value); alertFilterChanged(); });
  $('#a-unacked').addEventListener('change', (e) => { S.alerts.f.unacked = e.target.checked; alertFilterChanged(); });
  $('#a-refresh').addEventListener('click', () => loadAlerts());
  $('#a-more').addEventListener('click', () => loadAlerts(true));
  $('#a-ackall').addEventListener('click', ackAll);
  const alertOpen = (container, inDrawer) => {
    container.addEventListener('click', (e) => {
      if (e.target.closest('button, a, input, label, .al-review')) return;
      const art = e.target.closest('.al');
      if (!art) return;
      const t = toMs(art.dataset.t);
      if (inDrawer) { focusChartOn(t, art.dataset.id); $('#d-chart').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      else openVehicle(art.dataset.imei, t);
    });
    container.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const art = e.target.closest('.al');
      if (art && e.target === art) art.click();
    });
  };
  alertOpen($('#alert-list'), false);
  alertOpen($('#d-alerts'), true);

  // Report
  $('#r-period').addEventListener('click', (e) => {
    const b = e.target.closest('[data-h]');
    if (!b) return;
    const h = Number(b.dataset.h);
    if (h === S.report.hours && S.report.rows) return;
    S.report.hours = h;
    loadReport();
  });
  $('#r-group').addEventListener('change', renderReport);
  $('#r-q').addEventListener('input', debounce(renderReport, 120));
  $('#r-fuel').addEventListener('change', renderReport);
  $('#r-refresh').addEventListener('click', loadReport);
  $('#r-csv').addEventListener('click', exportCsv);
  $('#r-excel-folder').addEventListener('click', (e) => openExcelFolder(e.currentTarget));
  $('#r-xlsx').addEventListener('click', (e) => { e.preventDefault(); downloadExcel(e.currentTarget); });
  $('.report-tbl thead').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]');
    if (!b) return;
    const k = b.dataset.sort;
    if (S.report.sort === k) S.report.dir = -S.report.dir;
    else { S.report.sort = k; S.report.dir = k === 'name' || k === 'group' ? 1 : -1; }
    renderReport();
  });

  // Settings: rules
  $('#s-rules').addEventListener('input', (e) => {
    const k = e.target.name;
    const out = k && $(`output[data-eq="${k}"]`);
    if (out) out.textContent = ruleEq(k, e.target.value);
    $('#s-rules-state').textContent = 'Unsaved changes';
    $('#s-rules-state').className = 'save-state warn';
  });
  $('#s-rules').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const state = $('#s-rules-state');
    const th = {};
    for (const r of RULES.flatMap((g) => g.items)) {
      const el = form.elements[r.k];
      if (!el) continue;
      if (r.type === 'bool') th[r.k] = el.checked;
      else if (r.type === 'time') {
        if (el.value && !/^\d{2}:\d{2}$/.test(el.value)) { state.textContent = `Check “${r.label}”.`; state.className = 'save-state err'; el.focus(); return; }
        th[r.k] = el.value || (S.settings?.thresholds?.[r.k] ?? '');
      } else {
        if (!isNum(el.value) || Number(el.value) < (r.min ?? 0) || Number(el.value) > (r.max ?? Infinity)) {
          state.textContent = `“${r.label}” must be between ${fmtNum(r.min)} and ${fmtNum(r.max)}.`;
          state.className = 'save-state err';
          el.focus();
          return;
        }
        th[r.k] = Number(el.value);
      }
    }
    state.textContent = 'Saving…';
    state.className = 'save-state';
    try {
      const res = await api('/api/settings', { method: 'PUT', body: { thresholds: th } });
      if (res && res.thresholds) S.settings.thresholds = res.thresholds;
      else S.settings.thresholds = { ...S.settings.thresholds, ...th };
      state.textContent = `Saved ${fmtTime(Date.now())}`;
      state.className = 'save-state ok';
      if (S.view === 'fleet') renderFleet();
    } catch (err) {
      state.textContent = `Not saved: ${err.message}`;
      state.className = 'save-state err';
    }
  });
  $('#s-rules-reset').addEventListener('click', () => { if (S.settings) renderRulesForm(); });

  // Settings: server notifications
  $('#s-notify').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const state = $('#s-notify-state');
    const severities = $$('input[name="sev"]', form).filter((c) => c.checked).map((c) => c.value);
    const notify = { windowsToast: form.elements.windowsToast.checked, severities };
    state.textContent = 'Saving…';
    state.className = 'save-state';
    try {
      const res = await api('/api/settings', { method: 'PUT', body: { notify } });
      if (res && res.notify) S.settings.notify = res.notify;
      else S.settings.notify = { ...(S.settings.notify || {}), windowsToast: notify.windowsToast, severities };
      renderNotifyForm();
      renderBrowserCard();
      renderBanners();
      state.textContent = `Saved ${fmtTime(Date.now())}`;
      state.className = 'save-state ok';
    } catch (err) {
      state.textContent = `Not saved: ${err.message}`;
      state.className = 'save-state err';
    }
  });
  $('#s-test').addEventListener('click', testNotification);

  // Settings: this browser
  $('#s-perm-btn').addEventListener('click', requestNotif);
  $('#s-sound').addEventListener('change', (e) => { S.prefs.sound = e.target.checked; savePref('sound', S.prefs.sound); renderNotifBtn(); });
  $('#s-sound-test').addEventListener('click', () => beep('critical'));
  $('#s-browser').addEventListener('change', (e) => {
    if (e.target.name !== 'bsev') return;
    S.prefs.bsev = $$('input[name="bsev"]').filter((c) => c.checked).map((c) => c.value);
    savePref('bsev', S.prefs.bsev);
  });
  $('#s-theme').addEventListener('change', (e) => { S.prefs.theme = e.target.value; savePref('theme', S.prefs.theme); applyTheme(); });

  // Settings: vehicle calibration table
  $('#sv-q').addEventListener('input', debounce(() => renderCalTableForce(), 150));
  $('#sv-all').addEventListener('change', () => renderCalTableForce());
  $('#sv-body').addEventListener('input', (e) => { const tr = e.target.closest('tr[data-imei]'); if (tr) calRowDirty(tr); });
  $('#sv-body').addEventListener('change', (e) => { const tr = e.target.closest('tr[data-imei]'); if (tr) calRowDirty(tr); });
  $('#sv-body').addEventListener('click', async (e) => {
    const openB = e.target.closest('.js-open');
    if (openB) { openVehicle(openB.dataset.imei); return; }
    const save = e.target.closest('.js-save');
    if (!save) return;
    const tr = save.closest('tr[data-imei]');
    const imei = tr.dataset.imei;
    const v = S.byImei.get(imei);
    const get = (k) => tr.querySelector(`[name="${k}"]`).value;
    const body = { muted: tr.querySelector('[name="muted"]').checked };
    if (v?.hasFuel) {
      const { cal, error } = readCal(get);
      if (error) { toast({ sev: 'warning', title: `${v.shortName}: not saved`, body: error }); return; }
      body.cal = cal;
    }
    save.disabled = true;
    try {
      await saveVehicleSettings(imei, body);
      tr.classList.remove('dirty');
      tr.classList.add('saved');
      setTimeout(() => tr.classList.remove('saved'), 1500);
    } catch (err) {
      save.disabled = false;
      toast({ sev: 'warning', title: 'Not saved', body: err.message });
    }
  });

  // Drawer
  $('#d-range').addEventListener('click', (e) => {
    const b = e.target.closest('[data-h]');
    if (!b || !S.detail) return;
    S.detail.hours = Number(b.dataset.h);
    S.detail.at = null;
    S.detail.trackFitted = false;
    setRangeButtons();
    loadDetail();
  });
  $('#d-zoomreset').addEventListener('click', () => S.detail?.chart?.resetZoom());
  $('#d-form').addEventListener('submit', saveDetailForm);
  $('#d-form').addEventListener('input', (e) => {
    const k = e.target.name?.startsWith('th_') ? e.target.name.slice(3) : null;
    const out = k && $(`output[data-veq="${k}"]`, $('#d-form'));
    if (!out || !S.detail) return;
    const val = e.target.value !== '' ? e.target.value : e.target.placeholder;
    out.textContent = ruleEq(k, val, calFor(S.detail.imei));
  });
  $('#d-all-alerts').addEventListener('click', (e) => {
    e.preventDefault();
    if (!S.detail) return;
    const imei = S.detail.imei;
    showTempAlerts({ imei, sev: [...SEVS], type: '', unacked: false, range: Math.max(S.alerts.f.range, 168) }, `all alerts of ${vName(imei)}`);
  });
  // Opening the Alerts tab from the navigation brings back its own filters.
  $('.tabs a[data-view="alerts"]').addEventListener('click', () => { if (S.alerts.temp) restoreAlertFilters(S.view === 'alerts'); });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { tickRelative(); if (S.conn !== 'live') resync(); }
  });
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  mq?.addEventListener?.('change', () => { if (S.detail) updateDetailMap(); });
}
function renderCalTableForce() {
  const dirty = $$('#sv-body tr.dirty');
  if (dirty.length && !window.confirm('Discard unsaved calibration changes?')) return;
  dirty.forEach((tr) => tr.classList.remove('dirty'));
  renderCalTable();
}
async function resetCalibration(imei) {
  if (!window.confirm(`Go back to the default calibration for ${vName(imei)}?\n\nThis uses the GPS server's tank table if there is one, otherwise 0–10 000 mV.`)) return;
  try {
    await saveVehicleSettings(imei, { cal: null });
    if (S.detail?.imei === imei) renderDetailForm();
    renderCalTableForce();
    toast({ sev: 'good', title: 'Calibration reset', body: vName(imei) });
  } catch (e) { toast({ sev: 'warning', title: 'Could not reset the calibration', body: e.message }); }
}
async function ackVehicle(imei) {
  if (!window.confirm(`Mark every open alert of ${vName(imei)} as seen?`)) return;
  try {
    await api('/api/alerts/ack-all', { method: 'POST', body: { imei } });
    toast({ sev: 'good', title: 'Alerts acknowledged', body: vName(imei) });
  } catch (e) { toast({ sev: 'warning', title: 'Could not acknowledge', body: e.message }); return; }
  loadVehicles();
  if (S.detail?.imei === imei) loadDetail(true);
  if (S.alerts.loaded) loadAlerts();
}
function alertFilterChanged() {
  saveAlertFilters();
  syncAlertControls();
  loadAlerts();
}
function saveFleet() {
  const { group, status, fuel, problems, sort, dir } = S.fleet;
  savePref('fleet', { group, status, fuel, problems, sort, dir });
}
function syncFleetControls() {
  $('#f-q').value = S.fleet.q;
  $('#f-group').value = S.fleet.group;
  $('#f-status').value = S.fleet.status;
  $('#f-fuel').checked = S.fleet.fuel;
  $('#f-problems').checked = S.fleet.problems;
}
function applyTheme() {
  const t = S.prefs.theme;
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
  if (S.detail) updateDetailMap();
}
function tickRelative() {
  const t = now();
  for (const el of document.querySelectorAll('[data-rel]')) {
    const ms = toMs(el.dataset.rel);
    if (ms !== null) el.textContent = fmtRel(ms, t);
  }
  renderConn();
}

// ---------------------------------------------------------------- boot
async function init() {
  bindStatic();
  applyTheme();
  syncFleetControls();
  renderNotifBtn();
  renderCounts();
  route();
  onLoginRequired(showLogin);
  $('#login-form').addEventListener('submit', submitLogin);
  $('#btn-logout').addEventListener('click', logout);
  await loadMeta();
  if (S.needLogin) return; // the sign-in screen reloads the page once signed in
  document.body.classList.toggle('mode-cloud', S.mode === 'cloud');
  await Promise.all([loadSettings(), loadStatus()]);
  await loadVehicles();
  populateSelects();
  syncFleetControls();
  await loadRecentAlertIds();
  if (S.features.sse) connectSSE();
  else startPolling();
  renderBanners();
  setInterval(tickRelative, 15000);
  if (S.features.sse) {
    setInterval(() => { if (S.conn !== 'live' || S.serverDown) { loadStatus(); loadVehicles(); } }, 30000);
    setInterval(() => { loadVehicles(); if (S.conn === 'live') loadStatus(); }, 5 * 60e3);
  }
  setInterval(renderBanners, 60e3);
}
init();
