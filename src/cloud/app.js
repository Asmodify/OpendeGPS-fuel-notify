// HTTP API of the cloud version (one Vercel function, api/index.js). Same JSON as the local
// program (src/routes.js), built by the same Engine code over data loaded from Postgres, plus:
//   POST /api/login {password}   -> signed session cookie (30 days)
//   POST /api/logout
//   POST /api/cron/tick          -> one polling cycle (Authorization: Bearer CRON_SECRET)
// Every other /api/* route needs the session cookie (401 {error:'login_required'}). No live
// stream (/api/stream): the dashboard polls. No Windows toasts, Excel file or folder opening.
import crypto from 'node:crypto';
import { HttpError } from '../engine.js';
import { buildXlsx } from '../xlsx.js';
import { buildLedgerSheets, ledgerXlsxOpts } from '../ledger.js';
import { shortName, num, clamp, errText } from '../util.js';
import { getSql, js } from './pg.js';
import { MemDb } from './memdb.js';
import { CloudEngine } from './engine.js';
import { cloudConfig } from './config.js';
import { runTick } from './tick.js';
import { VEHICLE_SELECT, loadCalibrationRows, plain, settingsObject } from './data.js';

const HOUR = 3600e3;
const COOKIE = 'ftw_session';
const SESSION_DAYS = 30;
const LOGIN_MAX_FAILS = 10; // per IP ...
const LOGIN_WINDOW_MIN = 15; // ... in this many minutes
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const LEDGER_TYPES = ['refuel', 'fuel_drain'];

const bad = (msg) => new HttpError(400, msg);

// ---- responses / requests -------------------------------------------------------------
function send(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(data);
}

async function readJson(req, limit = 64 * 1024) {
  let text;
  // Vercel's Node runtime may have read (and parsed) the body already
  const pre = req.body;
  if (Buffer.isBuffer(pre)) text = pre.toString('utf8');
  else if (typeof pre === 'string') text = pre;
  else if (pre && typeof pre === 'object') return pre;
  if (text === undefined) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new HttpError(413, 'request body too large');
      chunks.push(c);
    }
    text = Buffer.concat(chunks).toString('utf8');
  }
  if (text.length > limit) throw new HttpError(413, 'request body too large');
  text = text.trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw bad('request body is not valid JSON');
  }
}

/** Vercel's Node runtime parses JSON bodies itself when its getter is read; reading a body
 *  that is invalid JSON through it throws. */
async function body(req, limit) {
  try {
    return await readJson(req, limit);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw bad('request body is not valid JSON');
  }
}

function attachment(name) {
  const ascii = name.replace(/[^\x20-\x7E]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const intParam = (v) => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const listParam = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

// ---- secrets / session --------------------------------------------------------------------
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
/** Constant-time comparison of two strings. */
export function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  return crypto.timingSafeEqual(digest(a), digest(b));
}

function sessionSecret() {
  const s = process.env.SESSION_SECRET || '';
  if (s.length < 16) throw new HttpError(503, 'SESSION_SECRET is not set (at least 16 characters)');
  return s;
}

const hmac = (payload) => crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');

export function makeSession(now = Date.now()) {
  const exp = Math.floor(now / 1000) + SESSION_DAYS * 86400;
  return `${exp}.${hmac(`ftw1.${exp}`)}`;
}

export function validSession(token, now = Date.now()) {
  const m = /^(\d{9,12})\.([A-Za-z0-9_-]{43})$/.exec(String(token || ''));
  if (!m || Number(m[1]) * 1000 <= now) return false;
  return sameSecret(m[2], hmac(`ftw1.${m[1]}`));
}

function cookieOf(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function sessionCookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || String(req.headers['x-real-ip'] || '') || req.socket?.remoteAddress || 'unknown';
}

/** Changes must come from the dashboard itself, not from another web site. */
function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'cross-site request refused');
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let oh = '';
    try {
      oh = new URL(origin).host.toLowerCase();
    } catch {
      /* invalid */
    }
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
    if (oh !== host) throw new HttpError(403, 'cross-origin request refused');
  }
}

// ---- data -----------------------------------------------------------------------------------
let base = null; // { ver, vehicles, settings } for the dashboard, per warm instance
const summaryCache = new Map(); // hours -> { at, ver, data }

async function loadBase(sql) {
  const [ps] = await sql`select state, ver from fuel.poller_state where id = 1`;
  if (!ps) throw new HttpError(503, 'the database is not set up (run supabase/migrations/0001_fuel.sql)');
  if (!base || base.ver !== ps.ver) {
    const [vehicles, settings] = await Promise.all([
      sql.unsafe(`select ${VEHICLE_SELECT}, det_state, rec->'lastLevel' as last_level from fuel.vehicles`),
      sql`select k, v from fuel.settings where k not like 'learned:%'`,
    ]);
    base = { ver: ps.ver, vehicles: plain(vehicles), settings: settingsObject(settings) };
  }
  return { state: ps.state || {}, ...base };
}

/** An Engine over the vehicles / settings (+ `extra` MemDb data for the request). */
async function engineFor(sql, b, extra = {}) {
  const cfg = cloudConfig(process.env, await loadCalibrationRows(sql));
  const lastLevel = new Map();
  const detStates = new Map();
  for (const r of b.vehicles) {
    if (r.last_level) lastLevel.set(r.imei, r.last_level);
    if (r.det_state) detStates.set(r.imei, r.det_state);
  }
  const db = new MemDb({ vehicles: b.vehicles, settings: b.settings, lastLevel, ...extra });
  const engine = await new CloudEngine({ cfg, db, detStates }).init();
  return { engine, db, cfg };
}

async function activeCounts(sql) {
  return plain(await sql`select imei, severity, count(*) as n from fuel.alerts where not acked group by imei, severity`);
}

/** Writes what a dashboard change recorded in the MemDb (settings, acks, reviews). */
async function flush(sql, db) {
  const o = db.out;
  const set = [...o.settings].filter(([, v]) => v !== null).map(([k, v]) => ({ k, v }));
  const del = [...o.settings].filter(([, v]) => v === null).map(([k]) => k);
  const reviews = [...o.alertReviews].map((id) => db.alerts.get(id)).filter(Boolean);
  await sql.begin((tx) => {
    const q = [];
    if (set.length) q.push(tx`insert into fuel.settings (k, v) select k, v from jsonb_to_recordset(${js(set)}::jsonb) as x(k text, v jsonb) on conflict (k) do update set v = excluded.v`);
    if (del.length) q.push(tx`delete from fuel.settings where k = any(${del}::text[])`);
    if (reviews.length) {
      q.push(tx`update fuel.alerts a set acked = x.acked, acked_at = x.acked_at, verdict = x.verdict, note = x.note, reviewed_at = x.reviewed_at, updated_at = x.updated_at
        from jsonb_to_recordset(${js(reviews)}::jsonb) as x(id bigint, acked boolean, acked_at bigint, verdict text, note text, reviewed_at bigint, updated_at bigint)
        where a.id = x.id`);
    }
    q.push(tx`update fuel.poller_state set ver = ver + 1 where id = 1`);
    return q;
  });
  base = null;
  summaryCache.clear();
}

async function bumpVer(sql) {
  await sql`update fuel.poller_state set ver = ver + 1 where id = 1`;
  base = null;
  summaryCache.clear();
}

function statusView(state, b, cfg) {
  const s = state || {};
  return {
    mode: 'cloud',
    startedAt: s.firstTickAt ?? null,
    phase: s.backfill?.running ? 'backfill' : s.lastObjectsPoll ? 'live' : 'starting',
    lastObjectsPoll: s.lastObjectsPoll ?? null,
    lastMessagesPoll: s.lastMessagesPoll ?? null,
    lastEventsPoll: null,
    lastPrune: null,
    apiOk: s.apiOk ?? null,
    lastError: s.lastError ?? null,
    lastErrorAt: s.lastErrorAt ?? null,
    pausedUntil: s.pausedUntil && s.pausedUntil > Date.now() ? s.pausedUntil : null,
    errors: s.errors || { objects: null, messages: null },
    backfill: { done: 0, total: 0, running: false, ...(s.backfill || {}) },
    lastMessages: s.lastMessages || null,
    lastTick: s.lastTick || null,
    calls: s.calls || null,
    serverTimeMs: Date.now(),
    vehicles: b.vehicles.length,
    detector: { ok: true },
    stats: s.stats || {},
    notify: null,
    excel: null,
    config: { server: cfg.server, backfillHours: cfg.initialBackfillHours, pollObjectsSeconds: cfg.pollObjectsSeconds, maxCallsPerTick: cfg.maxCallsPerTick },
    configError: cfg.apiKey ? null : 'GPS_API_KEY is not set in the Vercel project settings.',
  };
}

// ---- alerts ---------------------------------------------------------------------------------
async function queryAlertRows(sql, { imei, severities, types, since, until, unacked, beforeId, limit = 200 }) {
  const c = [sql`true`];
  if (imei) c.push(sql`imei = ${imei}`);
  if (severities?.length) c.push(sql`severity = any(${severities}::text[])`);
  if (types?.length) c.push(sql`type = any(${types}::text[])`);
  if (Number.isFinite(since)) c.push(sql`t >= ${Math.round(since)}::bigint`);
  if (Number.isFinite(until)) c.push(sql`t <= ${Math.round(until)}::bigint`);
  if (unacked) c.push(sql`not acked`);
  if (Number.isFinite(beforeId)) c.push(sql`id < ${Math.round(beforeId)}::bigint`);
  const where = c.reduce((a, x) => sql`${a} and ${x}`);
  return plain(await sql`select * from fuel.alerts where ${where} order by t desc, id desc limit ${Math.round(limit)}::int`);
}

// ---- summary (GET /api/summary): the Engine's report over data loaded in two rounds --------
async function summary(sql, b, hoursParam) {
  const h = clamp(num(hoursParam) ?? 24, 1, 24 * 90);
  const hit = summaryCache.get(h);
  if (hit && hit.ver === b.ver && Date.now() - hit.at < 60e3) return hit.data;
  const now = Date.now();
  // a little wider than the Engine's own [now - h, now]: it filters by exact times
  const from = now - h * HOUR - 60e3;
  const to = now + 60e3;
  const { engine } = await engineFor(sql, b);
  const thr = [...engine.recs.values()].map((rec) => {
    const runV = engine.detState(rec)?.runV;
    const lim = Number.isFinite(runV) ? runV - 1000 : Infinity;
    return { imei: rec.imei, thr24: Math.min(26400, lim), thr12: Math.min(13300, lim) };
  });
  const [sums, levels, fuelEvents, before, motion] = await Promise.all([
    sql`select imei, type, count(*) as n, sum(amount_mv)::float8 as amount from fuel.alerts where t >= ${from}::bigint and t <= ${to}::bigint group by imei, type`,
    sql`select imei, t, mv from fuel.levels where t >= ${from}::bigint and t <= ${to}::bigint order by imei, t`,
    sql`select imei, type, severity, title, t, from_t, amount_mv, extra, verdict from fuel.alerts
        where type in ('refuel', 'fuel_drain') and t >= ${from}::bigint and t <= ${to}::bigint order by imei, coalesce(from_t, t)`,
    sql`select v.imei, l.t, l.mv from fuel.vehicles v
        cross join lateral (select t, mv from fuel.levels where imei = v.imei and t < ${from}::bigint order by t desc limit 1) l`,
    sql`select x.imei, count(*) as n,
          sum(case when podo is not null and odo is not null and odo >= podo and (odo - podo) <= (t - pt) * 0.07 + 1000 then odo - podo else 0 end)::float8 as odo_m,
          sum(case when podo is not null and odo is not null then 1 else 0 end)::float8 as odo_pairs,
          sum(case when t - pt <= 300000 and (
                (pspd >= 3 and (pign is null or pign <> 0))
                or ((pspd is null or pspd < 3) and pign = 1 and (ppwr is null or ppwr >= (case when ppwr > 18000 then q.thr24 else q.thr12 end))))
              then t - pt else 0 end)::float8 as engine_ms,
          max(spd) as max_spd
        from (select imei, t, odo, spd, lag(t) over w as pt, lag(odo) over w as podo, lag(ign) over w as pign, lag(spd) over w as pspd, lag(pwr) over w as ppwr
              from fuel.samples where t >= ${from}::bigint and t <= ${to}::bigint
              window w as (partition by imei order by t)) x
        join unnest(${thr.map((x) => x.imei)}::text[], ${thr.map((x) => x.thr24)}::float8[], ${thr.map((x) => x.thr12)}::float8[]) as q(imei, thr24, thr12)
          on q.imei = x.imei
        group by x.imei`,
  ]);
  // samples the report reads itself: GPS distance (no odometer) and the fuel balance span
  const motionBy = new Map(motion.map((r) => [r.imei, { ...r }]));
  const beforeBy = new Map(before.map((r) => [r.imei, { t: r.t, mv: r.mv }]));
  const levelsBy = new Map();
  for (const r of levels) {
    if (!levelsBy.has(r.imei)) levelsBy.set(r.imei, []);
    levelsBy.get(r.imei).push(r);
  }
  const need = [];
  for (const rec of engine.recs.values()) {
    let a = Infinity;
    let z = -Infinity;
    const m = motionBy.get(rec.imei);
    if (m && !(m.odo_pairs > 0)) {
      a = from;
      z = to;
    }
    if (rec.v.hasFuel && engine.detState(rec)?.sensorOk !== false) {
      const pts = levelsBy.get(rec.imei) || [];
      const bf = beforeBy.get(rec.imei);
      const first = bf && now - h * HOUR - bf.t < 48 * HOUR ? bf.t : pts[0]?.t;
      const n = pts.length + (bf && now - h * HOUR - bf.t < 48 * HOUR ? 1 : 0);
      if (n >= 2) {
        a = Math.min(a, first);
        z = Math.max(z, pts[pts.length - 1].t);
      }
    }
    if (a < z) need.push({ imei: rec.imei, a, z });
  }
  const samples = new Map();
  if (need.length) {
    const rows = await sql`select s.imei, s.t, s.spd, s.ign, s.pwr, s.lat, s.lng, s.odo from fuel.samples s
      join unnest(${need.map((x) => x.imei)}::text[], ${need.map((x) => x.a)}::bigint[], ${need.map((x) => x.z)}::bigint[]) as q(imei, a, z)
        on s.imei = q.imei and s.t >= q.a and s.t <= q.z
      order by s.imei, s.t`;
    for (const r of rows) {
      if (!samples.has(r.imei)) samples.set(r.imei, []);
      samples.get(r.imei).push({ t: r.t, f: null, spd: r.spd, ign: r.ign, pwr: r.pwr, lat: r.lat, lng: r.lng, odo: r.odo });
    }
  }
  const db = engine.db;
  db.alertSumRows = plain(sums);
  db.levelRows = plain(levels);
  db.fuelEventRows = plain(fuelEvents);
  db.levelsBefore = beforeBy;
  db.samples = samples;
  // the main period's motion sums come from SQL (Engine asks for exactly [now - h, now])
  const mainFrom = from + 60e3;
  const origMotion = db.motionStats.bind(db);
  db.motionStats = (imei, a, z, thr24, thr12) => {
    if (Math.abs(a - mainFrom) < 5 * 60e3 && Math.abs(z - now) < 5 * 60e3) return motionBy.get(imei) ?? null;
    return origMotion(imei, a, z, thr24, thr12);
  };
  const data = engine.summary(h);
  summaryCache.set(h, { at: Date.now(), ver: b.ver, data });
  return data;
}

// ---- Excel fuel ledger (download) ---------------------------------------------------------
async function exportXlsx(sql, b) {
  const now = Date.now();
  const rows = plain(await sql`select * from fuel.alerts where type in ('refuel', 'fuel_drain') order by t desc, id desc`);
  const { engine, cfg } = await engineFor(sql, b);
  const alerts = rows.map((row) => ({ ...engine.alertView(row), amountMv: row.amount_mv, extra: row.extra }));
  const calibrations = {};
  for (const a of alerts) if (a.imei && !calibrations[a.imei]) calibrations[a.imei] = engine.vehicleCal(a.imei);
  const vehicles = [...engine.recs.values()].map((rec) => ({
    imei: rec.imei, name: rec.v.name, shortName: shortName(rec.v.name), group: rec.info.group ?? null, hasFuel: rec.v.hasFuel, cal: engine.vehicleCal(rec.imei),
  }));
  const first = b.state?.firstTickAt;
  const periodStart = Number.isFinite(first) ? first - cfg.initialBackfillHours * HOUR : null;
  const sheets = buildLedgerSheets({
    alerts, vehicles, calibrations, tzOffsetMinutes: cfg.tzOffsetMinutes, generatedAt: now, periodStart, timezone: cfg.timezone,
  });
  const buf = buildXlsx(sheets, ledgerXlsxOpts(cfg.tzOffsetMinutes));
  const day = new Date(now + cfg.tzOffsetMinutes * 60e3).toISOString().slice(0, 10);
  return { buf, name: `Fuel events ${day}.xlsx` };
}

// ---- routes ---------------------------------------------------------------------------------
async function login(sql, req, res) {
  sameOrigin(req);
  const pw = process.env.DASHBOARD_PASSWORD || '';
  if (!pw) throw new HttpError(503, 'DASHBOARD_PASSWORD is not set');
  sessionSecret();
  const ip = clientIp(req).slice(0, 64);
  const [{ n }] = await sql`select count(*) as n from fuel.login_attempts where ip = ${ip} and at > now() - make_interval(mins => ${LOGIN_WINDOW_MIN})`;
  if (n >= LOGIN_MAX_FAILS) throw new HttpError(429, `too many failed logins - try again in ${LOGIN_WINDOW_MIN} minutes`);
  const b = await body(req, 4096);
  if (!sameSecret(typeof b.password === 'string' ? b.password : '', pw)) {
    await sql`insert into fuel.login_attempts (ip) values (${ip})`;
    throw new HttpError(401, 'wrong password');
  }
  await sql`delete from fuel.login_attempts where ip = ${ip}`;
  return send(res, 200, { ok: true }, { 'set-cookie': sessionCookie(makeSession(), SESSION_DAYS * 86400) });
}

async function tickRoute(sql, req, res) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) throw new HttpError(503, 'CRON_SECRET is not set');
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  if (!m || !sameSecret(m[1].trim(), secret)) throw new HttpError(401, 'unauthorized');
  const r = await runTick(sql);
  base = null;
  return send(res, 200, r);
}

async function api(req, res, url) {
  const m = req.method;
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const q = url.searchParams;
  let seg;
  try {
    seg = p.split('/').slice(2).map(decodeURIComponent);
  } catch {
    throw bad('bad path');
  }
  const sql = getSql();
  if (m !== 'GET' && m !== 'HEAD' && p !== '/api/cron/tick') sameOrigin(req);

  if (p === '/api/cron/tick' && m === 'POST') return tickRoute(sql, req, res);
  if (p === '/api/login' && m === 'POST') return login(sql, req, res);
  if (p === '/api/logout' && m === 'POST') return send(res, 200, { ok: true }, { 'set-cookie': sessionCookie('', 0) });
  if (!validSession(cookieOf(req, COOKIE))) return send(res, 401, { error: 'login_required' });

  const b = await loadBase(sql);
  if (m === 'GET' && p === '/api/status') {
    return send(res, 200, statusView(b.state, b, cloudConfig(process.env, await loadCalibrationRows(sql))));
  }
  if (m === 'GET' && p === '/api/meta') {
    const { engine } = await engineFor(sql, b);
    return send(res, 200, {
      alertTypes: engine.alertTypes,
      groups: engine.groups(),
      serverTimeMs: Date.now(),
      timezone: engine.cfg.timezone,
      severities: ['critical', 'warning', 'info'],
      mode: 'cloud',
      features: { sse: false, windowsToast: false, excelFile: false, openFolder: false },
    });
  }
  if (m === 'GET' && p === '/api/vehicles') {
    const { engine } = await engineFor(sql, b, { activeCounts: await activeCounts(sql) });
    return send(res, 200, engine.vehiclesView());
  }
  if (seg[0] === 'vehicles' && seg[1]) {
    const imei = seg[1];
    if (m === 'GET' && seg.length === 2) {
      const { engine } = await engineFor(sql, b, { activeCounts: await activeCounts(sql) });
      const rec = engine.recs.get(imei);
      if (!rec) throw new HttpError(404, 'unknown vehicle');
      return send(res, 200, engine.vehicleView(rec, engine.db.activeCounts().get(imei)));
    }
    if (m === 'GET' && seg[2] === 'history' && seg.length === 3) {
      if (!b.vehicles.some((v) => v.imei === imei)) throw new HttpError(404, 'unknown vehicle');
      const h = clamp(num(intParam(q.get('hours'))) ?? 24, 1, 168);
      const to = Date.now() + 60e3;
      const from = Date.now() - h * HOUR - 60e3;
      const [samples, levels, alerts] = await Promise.all([
        sql`select t, f, spd, ign, pwr, lat, lng, odo from fuel.samples where imei = ${imei} and t >= ${from}::bigint and t <= ${to}::bigint order by t`,
        sql`select imei, t, mv from fuel.levels where imei = ${imei} and t >= ${from}::bigint and t <= ${to}::bigint order by t`,
        queryAlertRows(sql, { imei, since: from + 60e3, limit: 2000 }),
      ]);
      const { engine } = await engineFor(sql, b, {
        samples: new Map([[imei, plain(samples)]]), levels: plain(levels), queryAlerts: alerts,
      });
      return send(res, 200, engine.history(imei, h));
    }
    if (m === 'PUT' && seg[2] === 'settings' && seg.length === 3) {
      const input = await body(req);
      const { engine, db } = await engineFor(sql, b, { activeCounts: await activeCounts(sql) });
      const r = engine.putVehicleSettings(imei, input);
      await flush(sql, db);
      return send(res, 200, r);
    }
  }
  if (m === 'GET' && p === '/api/alerts') {
    const limit = Math.min(5000, Math.max(1, Math.round(intParam(q.get('limit')) ?? 200)));
    const rows = await queryAlertRows(sql, {
      imei: q.get('imei') || undefined,
      severities: listParam(q.get('severity')),
      types: listParam(q.get('type')),
      since: intParam(q.get('since')),
      until: intParam(q.get('until')),
      unacked: ['1', 'true', 'yes'].includes(String(q.get('unacked') || '').toLowerCase()),
      beforeId: intParam(q.get('beforeId')),
      limit,
    });
    const { engine } = await engineFor(sql, b);
    return send(res, 200, rows.map((r) => engine.alertView(r)));
  }
  if (m === 'POST' && p === '/api/alerts/ack-all') {
    const input = await body(req);
    const imei = typeof input.imei === 'string' && input.imei ? input.imei : null;
    const now = Date.now();
    const r = imei
      ? await sql`update fuel.alerts set acked = true, acked_at = ${now}::bigint, updated_at = ${now}::bigint where not acked and imei = ${imei}`
      : await sql`update fuel.alerts set acked = true, acked_at = ${now}::bigint, updated_at = ${now}::bigint where not acked`;
    await bumpVer(sql);
    return send(res, 200, { ok: true, acked: r.count });
  }
  if (seg[0] === 'alerts' && /^\d+$/.test(seg[1] || '')) {
    const id = Number(seg[1]);
    if (m === 'GET' && seg.length === 2) {
      const [row] = await sql`select * from fuel.alerts where id = ${id}::bigint`;
      if (!row) throw new HttpError(404, 'unknown alert');
      const { engine } = await engineFor(sql, b);
      return send(res, 200, engine.alertView({ ...row }));
    }
    if (m === 'POST' && (seg[2] === 'ack' || seg[2] === 'unack') && seg.length === 3) {
      await body(req).catch(() => ({}));
      const acked = seg[2] === 'ack';
      const now = Date.now();
      const [row] = await sql`update fuel.alerts set acked = ${acked}, acked_at = ${acked ? now : null}::bigint, updated_at = ${now}::bigint
        where id = ${id}::bigint returning *`;
      if (!row) throw new HttpError(404, 'unknown alert');
      await bumpVer(sql);
      const { engine } = await engineFor(sql, b);
      return send(res, 200, engine.alertView({ ...row }));
    }
    if (m === 'PUT' && seg[2] === 'review' && seg.length === 3) {
      const input = await body(req, 16 * 1024);
      const [row] = await sql`select * from fuel.alerts where id = ${id}::bigint`;
      if (!row) throw new HttpError(404, 'unknown alert');
      const { engine, db } = await engineFor(sql, b, { alerts: [{ ...row }] });
      const view = engine.reviewAlert(id, input);
      if (!view) throw new HttpError(404, 'unknown alert');
      await flush(sql, db);
      return send(res, 200, view);
    }
  }
  if ((m === 'GET' || m === 'HEAD') && p === '/api/export/fuel-events.xlsx') {
    const { buf, name } = await exportXlsx(sql, b);
    res.writeHead(200, {
      'content-type': XLSX_TYPE,
      'content-length': buf.length,
      'content-disposition': attachment(name),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    return res.end(m === 'HEAD' ? undefined : buf);
  }
  if (m === 'GET' && p === '/api/summary') return send(res, 200, await summary(sql, b, q.get('hours')));
  if (m === 'GET' && p === '/api/settings') {
    const { engine } = await engineFor(sql, b);
    return send(res, 200, engine.settingsView());
  }
  if (m === 'PUT' && p === '/api/settings') {
    const input = await body(req);
    const { engine, db } = await engineFor(sql, b);
    const r = engine.putSettings(input);
    await flush(sql, db);
    return send(res, 200, r);
  }
  throw new HttpError(404, `no such API endpoint: ${m} ${p}`);
}

/** The path the dashboard asked for (vercel.json rewrites /api/* to this one function). */
function requestUrl(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  const rest = url.searchParams.get('__path');
  if (rest !== null) {
    url.searchParams.delete('__path');
    if (!url.pathname.startsWith('/api/') || url.pathname === '/api/index' || url.pathname === '/api/index.js') url.pathname = `/api/${rest}`;
  }
  return url;
}

/** Node (req, res) handler: Vercel's Node.js runtime, or node:http in tests. */
export async function handler(req, res) {
  let url;
  try {
    url = requestUrl(req);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) await api(req, res, url);
    else throw new HttpError(404, 'not found');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500) console.error(`${req.method} ${url?.pathname ?? req.url} failed:`, e);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    send(res, status, { error: status >= 500 && !(e instanceof HttpError) ? `internal error: ${errText(e).slice(0, 200)}` : e.message });
  }
}

export default handler;
export { LEDGER_TYPES };
