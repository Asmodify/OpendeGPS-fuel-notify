// One check of the cloud version: POST (or GET) /api/cron/tick, Bearer CRON_SECRET.
//
// The endpoint may be called as often as one likes (Supabase pg_cron every minute, Vercel's
// daily cron as a fallback): a call only does something when the check interval has passed
// since the last check (setting checkIntervalMinutes, default 30, 5 min .. 2 h), when a
// previous check left vehicles waiting, or with ?force=1.
//
//   1. take the tick lease (a row in fuel.tick_lease; an overlapping call just skips)
//   2. USER_GET_OBJECTS: one request gives the newest point of every vehicle
//      -> vehicle status, offline / back online (the local Engine code)
//   3. OBJECT_GET_MESSAGES for every vehicle with data newer than its last stored sample: the
//      full-resolution history since then (10 min overlap for rows that reached the server
//      late; a data hold or a backlog upload re-fetches from the gap). A vehicle seen for the
//      first time gets initialBackfillHours of history, stored as history (no pop-ups). Only
//      when the newest point is the sole new one (within GAP_FILL_MS of the last stored sample)
//      the point from the objects answer is used and the request saved. At most
//      maxCallsPerTick requests and a time budget per tick; the rest is fetched by the next
//      call a minute later (and is not fed meanwhile, so the detectors see every sample in
//      time order).
//   4. restore the detectors of the vehicles that got samples (fuel.detector_state), feed them
//   5. write samples, levels, alerts, vehicle state, snapshots and the poller status in one
//      transaction, which also checks that the lease is still held
//
// "API call limit exceeded" -> no requests for 10 min (x1.5 on each repeat, at most 1 h).
import crypto from 'node:crypto';
import { createApi } from '../api.js';
import { errText, fromApiDate, mapPool, isPlainObject, haversineM } from '../util.js';
import { MemDb } from './memdb.js';
import { isPendingDrain } from '../ledger.js';
import { CloudEngine, recStateOf, checkIntervalOf } from './engine.js';
import { cloudConfig } from './config.js';
import { js } from './pg.js';
import { VEHICLE_SELECT, loadCalibrationRows, plain, settingsObject, vehicleMaps } from './data.js';

const MIN = 60e3;
const HOUR = 3600e3;
const LEASE_SECONDS = 65; // longer than the function may run (maxDuration 60 s)
const GAP_FILL_MS = 3 * MIN;
const OVERLAP_MS = 10 * MIN; // re-fetch this much before the last stored sample (late rows)
const HOLD_RECHECK_MS = 20 * MIN;
const PAUSE_MS = 10 * MIN;
const PAUSE_MAX_MS = HOUR;
const FETCH_CONCURRENCY = 5;
const FETCH_BUDGET_MS = 38e3; // no new request is started after this much of the tick
const DUE_SLACK_MS = 45e3; // cron fires a little early or late
const SAMPLE_BATCH = 4000; // rows per INSERT

const VEHICLE_COLS = ['name', 'group_name', 'device', 'plate', 'sim', 'has_fuel', 'last_seen', 'server_seen', 'lat', 'lng', 'speed', 'angle', 'ign', 'pwr', 'fuel_raw', 'odometer_km', 'status'];

// What this instance wrote in its last tick: reused while nothing else changed the data
// (poller_state.ver is bumped by every tick and every change made in the dashboard).
let warm = null; // { ver, vehicles, settings, ongoing, nextAlertId }
const snapCache = new Map(); // imei -> { ver, snap }

export function resetTickCache() {
  warm = null;
  snapCache.clear();
}

function newState() {
  return {
    firstTickAt: null,
    lastRunAt: null, // last check that made requests
    lastObjectsPoll: null,
    lastMessagesPoll: null,
    apiOk: null,
    lastError: null,
    lastErrorAt: null,
    pausedUntil: null,
    rateHits: 0,
    lastObjCount: 0,
    errors: { objects: null, messages: null },
    backfill: { running: false, done: 0, total: 0 },
    lastMessages: { vehicles: 0, samples: 0, failed: 0, waiting: 0 },
    waiting: 0, // vehicles the last check could not fetch (fetched by the next call)
    lastTick: null,
    calls: { day: null, objects: 0, messages: 0 },
    stats: { alertsCreated: 0, samplesIngested: 0, lateRows: 0, detectorErrors: 0 },
  };
}

function vehicleSig(r) {
  return JSON.stringify([...VEHICLE_COLS.map((c) => r[c] ?? null), r.rec ?? null, r.det_state ?? null]);
}

/** alert ids a detector snapshot refers to (open drains, idles, power cuts, ...) */
function snapAlertIds(x, out = new Set()) {
  if (Array.isArray(x)) for (const y of x) snapAlertIds(y, out);
  else if (x && typeof x === 'object') {
    for (const [k, v] of Object.entries(x)) {
      if ((k === 'id' || k === 'alertId') && Number.isInteger(v) && v > 0) out.add(v);
      else if (v && typeof v === 'object') snapAlertIds(v, out);
    }
  }
  return out;
}

/** A parked tracker reports only about hourly: when the last stored sample and the new point
 *  both show the vehicle standing still with the engine off at the same place, there is
 *  nothing in between to fetch (the tracker sent nothing), so the point is used directly. */
function parkedThrough(engine, rec, s) {
  const p = rec.lastPushed;
  if (!s || !p || p.t !== rec.lastT || engine.active(rec, p) || engine.active(rec, s)) return false;
  if (Number.isFinite(p.odo) && Number.isFinite(s.odo)) return Math.abs(s.odo - p.odo) < 300;
  if (![p.lat, p.lng, s.lat, s.lng].every(Number.isFinite)) return false;
  return haversineM(p.lat, p.lng, s.lat, s.lng) < 300;
}

/** The GPS server is receiving old records from this tracker (a backlog after a coverage gap). */
function backlogActive(rec, now) {
  const i = rec.info;
  return i.serverSeen != null && i.lastSeen != null && i.serverSeen - i.lastSeen > 5 * MIN && now - i.serverSeen < 30 * MIN;
}

/** Runs one tick. Returns a summary (also stored in the poller status as lastTick). */
export async function runTick(sql, { env = process.env, now = Date.now(), force = false } = {}) {
  const t0 = performance.now();
  const cpu0 = process.cpuUsage();
  const holder = crypto.randomUUID();
  const got = await sql`update fuel.tick_lease set holder = ${holder}, until = now() + make_interval(secs => ${LEASE_SECONDS}), started = now()
    where id = 1 and (until is null or until < now()) returning id`;
  if (!got.length) return { ok: true, skipped: 'another tick is still running' };
  const timing = () => {
    const c = process.cpuUsage(cpu0);
    return { ms: Math.round(performance.now() - t0), cpuMs: Math.round((c.user + c.system) / 1000) };
  };
  try {
    return await tick(sql, env, holder, now, force, timing, t0);
  } finally {
    await sql`update fuel.tick_lease set until = null where id = 1 and holder = ${holder}`.catch(() => {});
  }
}

async function tick(sql, env, holder, now, force, timing, t0) {
  const [psRow] = await sql`select state, ver from fuel.poller_state where id = 1`;
  const ps = { ...newState(), ...(isPlainObject(psRow?.state) ? psRow.state : {}) };
  ps.errors = { objects: null, warmup: null, messages: null, ...(ps.errors || {}) };
  const day = new Date(now).toISOString().slice(0, 10);
  if (ps.calls?.day !== day) ps.calls = { day, objects: 0, messages: 0 };
  const calls = { objects: 0, messages: 0 };

  if (ps.pausedUntil && ps.pausedUntil > now) {
    return { ok: true, skipped: 'GPS server call limit: paused', pausedUntil: ps.pausedUntil, ...timing() };
  }

  const basePromise = warm && warm.ver === psRow?.ver ? Promise.resolve(warm) : loadBase(sql);
  const base = await basePromise;
  const intervalMs = checkIntervalOf(base.settings.global) * MIN;
  const nextDue = ps.lastRunAt ? ps.lastRunAt + intervalMs : now;
  const continuation = ps.waiting > 0 && (!ps.lastRunAt || now - ps.lastRunAt >= MIN - 5e3);
  if (!force && !continuation && now < nextDue - DUE_SLACK_MS) {
    return { ok: true, skipped: 'not due', nextDue, checkIntervalMinutes: intervalMs / MIN, ...timing() };
  }
  ps.firstTickAt ??= now;

  const cfg = cloudConfig(env, await loadCalibrationRows(sql, now));
  const saveError = async (where, e) => {
    const limited = e?.code === 'RATE_LIMIT';
    if (limited) {
      ps.rateHits = (ps.rateHits || 0) + 1;
      ps.pausedUntil = now + Math.min(PAUSE_MS * 1.5 ** (ps.rateHits - 1), PAUSE_MAX_MS);
    }
    const msg = `${where}: ${limited ? 'GPS server call limit reached — pausing requests' : errText(e)}`;
    Object.assign(ps, { lastError: msg, lastErrorAt: now, apiOk: false });
    ps.errors[where] = { message: msg, at: now, partial: false };
    ps.calls.objects += calls.objects;
    ps.calls.messages += calls.messages;
    ps.lastTick = { at: now, error: msg, calls: calls.objects + calls.messages, ...timing() };
    await sql`update fuel.poller_state set state = ${js(ps)}::jsonb, ver = ver + 1 where id = 1`;
    warm = null;
    return { ok: false, error: msg, pausedUntil: ps.pausedUntil, calls: calls.objects + calls.messages, ...timing() };
  };
  if (!cfg.apiKey) return saveError('objects', new Error('GPS_API_KEY is not set'));

  // ---- 1. objects --------------------------------------------------------------------
  const api = createApi({ server: cfg.server, apiKey: cfg.apiKey, apiTimeoutSeconds: cfg.apiTimeoutSeconds });
  let objs;
  try {
    calls.objects++;
    objs = await api.getObjects();
  } catch (e) {
    return saveError('objects', e);
  }
  ps.lastRunAt = now;

  const maps = vehicleMaps(base.vehicles);
  const db = new MemDb({ vehicles: base.vehicles, settings: base.settings, alerts: base.ongoing, nextAlertId: base.nextAlertId, lastT: maps.lastT, lastLevel: maps.lastLevel });
  const engine = await new CloudEngine({ cfg, db, recStates: maps.recStates, detStates: maps.detStates, startedAt: ps.firstTickAt }).init();
  engine.lastObjCount = ps.lastObjCount || 0;
  const alerts0 = engine.stats.alertsCreated;
  engine.applyObjects(objs, now);
  ps.lastObjCount = engine.lastObjCount;
  ps.lastObjectsPoll = now;
  ps.errors.objects = null;
  ps.rateHits = 0;
  ps.pausedUntil = null;
  const byImei = new Map();
  for (const o of objs) if (isPlainObject(o) && o.imei != null) byImei.set(String(o.imei).trim(), o);

  // ---- 2. plan: which vehicles need messages, which just get their newest point ----------
  const points = [];
  const fetches = [];
  let pendingBackfill = 0;
  for (const rec of engine.allRecs()) {
    const i = rec.info;
    const seen = i.lastSeen;
    if (!seen) continue;
    const to = Math.min(Math.max(now, seen) + MIN, now + 5 * MIN);
    if (rec.lastT === null || rec.lastT === undefined) {
      const from = to - cfg.initialBackfillHours * HOUR;
      if (seen < from) continue; // silent for longer than that: fetched once it reports again
      pendingBackfill++;
      fetches.push({ rec, from, to, mode: 'backfill', hole: false, prio: 1 });
      continue;
    }
    const serverNews = (i.serverSeen ?? 0) > (rec.fetchedServerSeen ?? 0);
    const backlog = backlogActive(rec, now);
    let from = null;
    if (rec.hold) {
      if (serverNews || seen > rec.lastT || now - rec.hold.since >= HOLD_RECHECK_MS) from = Math.min(rec.hold.from + 1000, rec.lastT - OVERLAP_MS);
    } else if (seen > rec.lastT) {
      const o = byImei.get(rec.imei);
      const row = o && fromApiDate(o.dt_tracker) === seen ? [o.dt_tracker, o.lat, o.lng, o.altitude, o.angle, o.speed, o.params] : null;
      const gap = seen - rec.lastT;
      // The newest point is the only new one, so no request is needed: it follows the last
      // stored sample closely, or it is a parked tracker's hourly report (still, engine off,
      // same place, and a gap longer than the check interval, which a tracker reporting every
      // minute while parked could not produce).
      const hourly = gap >= Math.max(50 * MIN, intervalMs + 10 * MIN) && row && parkedThrough(engine, rec, engine.parseRow(row));
      if (row && !(backlog && serverNews) && (gap <= GAP_FILL_MS || hourly)) {
        points.push({ rec, rows: [row], mode: 'live' });
      } else from = rec.lastT - OVERLAP_MS;
    } else if (backlog && serverNews) from = rec.lastT - OVERLAP_MS;
    if (from === null) continue;
    const floor = to - cfg.backfillHours * HOUR;
    const hole = rec.lastT + 1000 < floor;
    fetches.push({ rec, from: Math.max(from, floor), to, mode: hole ? 'backfill' : 'live', hole, prio: 0 });
  }
  for (const f of fetches) f.rec.dueSince ??= now;
  // live data first (longest waiting first), then first-time history (fuel vehicles first)
  fetches.sort((a, b) => a.prio - b.prio || (a.prio === 0
    ? a.rec.dueSince - b.rec.dueSince
    : Number(b.rec.v.hasFuel) - Number(a.rec.v.hasFuel) || b.rec.info.lastSeen - a.rec.info.lastSeen));
  const doFetch = fetches.slice(0, cfg.maxCallsPerTick);
  let waiting = fetches.length - doFetch.length;

  // ---- 3. messages ---------------------------------------------------------------------
  let limitErr = null;
  let lastErr = null;
  let failed = 0;
  let outOfTime = 0;
  await mapPool(doFetch, FETCH_CONCURRENCY, async (f) => {
    if (limitErr || performance.now() - t0 > FETCH_BUDGET_MS) {
      f.skipped = true;
      if (!limitErr) outOfTime++;
      return;
    }
    try {
      const rows = [];
      for (let a = f.from; a < f.to;) {
        const b = Math.min(f.to, a + 24 * HOUR);
        calls.messages++;
        const r = await api.getMessages(f.rec.imei, a, b);
        if (Array.isArray(r)) for (const x of r) rows.push(x);
        a = b;
      }
      f.rows = rows;
      f.seen = f.rec.info.lastSeen;
      f.serverSeen = f.rec.info.serverSeen;
    } catch (e) {
      failed++;
      lastErr = e;
      if (e.code === 'RATE_LIMIT') limitErr = e;
    }
  });
  waiting += doFetch.filter((f) => f.skipped).length + failed;
  if (doFetch.length) ps.lastMessagesPoll = now;
  const fetched = doFetch.filter((f) => f.rows);

  // ---- 4. restore the detectors that get samples, feed them ----------------------------
  const feeds = [...points, ...fetched];
  const snaps = await loadFeedContext(sql, db, feeds);
  let samples = 0;
  for (const f of feeds) {
    const rec = f.rec;
    try {
      engine.ensureDetector(rec, snaps.get(rec.imei) ?? null);
    } catch (e) {
      engine.stats.detectorErrors++;
      console.error(`restoring the detector of ${rec.imei} failed:`, e);
      rec.det = null;
      engine.ensureDetector(rec, null);
    }
    if (f.hole) engine.markGap(rec);
    samples += engine.ingest(rec, f.rows, f.mode, { now, backlog: backlogActive(rec, now), allowHold: f.mode === 'live' });
    if (f.from !== undefined) {
      rec.fetchedSeen = f.seen;
      rec.fetchedServerSeen = f.serverSeen;
      rec.fetchedAt = now;
      rec.dueSince = null;
      if (f.mode === 'backfill' && !rec.backfilled) {
        rec.backfilled = true;
        pendingBackfill--;
      }
    }
    if (f.mode !== 'backfill') rec.backfilled = true;
  }

  engine.checkPendingDrains(now); // fuel drops held for the 5 h check

  // ---- 5. save ---------------------------------------------------------------------------
  const fedImeis = new Set(feeds.map((f) => f.rec.imei));
  const snapOut = [];
  for (const imei of fedImeis) {
    const rec = engine.recs.get(imei);
    if (rec?.det) snapOut.push({ imei, snap: rec.det.snapshot() });
  }
  const baseByImei = new Map(base.vehicles.map((r) => [r.imei, r]));
  const vehiclesNow = [];
  const vehiclesOut = [];
  for (const rec of engine.allRecs()) {
    const row = db.out.vehicles.get(rec.imei) ?? { ...baseByImei.get(rec.imei) };
    row.rec = recStateOf(rec);
    row.det_state = rec.det ? engine.detState(rec) : (baseByImei.get(rec.imei)?.det_state ?? null);
    delete row.updated_at;
    vehiclesNow.push(row);
    const old = baseByImei.get(rec.imei);
    if (!old || vehicleSig(old) !== vehicleSig(row)) vehiclesOut.push({ ...row, updated_at: now });
  }

  const backfilledCount = engine.allRecs().filter((r) => r.backfilled).length;
  ps.backfill = { running: pendingBackfill > 0, done: backfilledCount, total: backfilledCount + Math.max(0, pendingBackfill) };
  ps.lastMessages = { vehicles: doFetch.length, samples, failed, waiting, outOfTime, points: points.length };
  ps.waiting = waiting;
  if (limitErr) {
    ps.rateHits = 1;
    ps.pausedUntil = now + PAUSE_MS;
  }
  if (failed) {
    const msg = `messages: ${limitErr ? 'GPS server call limit reached — pausing requests' : errText(lastErr)} (${failed}/${doFetch.length} vehicles failed, retried next time)`;
    Object.assign(ps, { lastError: msg, lastErrorAt: now });
    ps.errors.messages = { message: msg, at: now, partial: failed < doFetch.length };
  } else if (doFetch.length) ps.errors.messages = null;
  ps.apiOk = !(failed && failed === doFetch.length);
  const st = ps.stats;
  st.alertsCreated += engine.stats.alertsCreated - alerts0;
  st.samplesIngested += engine.stats.samplesIngested;
  st.lateRows += engine.stats.lateRows;
  st.detectorErrors += engine.stats.detectorErrors;
  ps.calls.objects += calls.objects;
  ps.calls.messages += calls.messages;
  const summary = {
    ok: true, vehicles: engine.recs.size, points: points.length, fetched: fetched.length, waiting, failed, outOfTime, samples,
    alerts: db.out.newAlerts.size, alertUpdates: db.out.alertUpdates.size, levels: db.out.levels.size,
    calls: calls.objects + calls.messages, pausedUntil: ps.pausedUntil, checkIntervalMinutes: intervalMs / MIN,
  };
  ps.lastTick = { at: now, ...summary, ...timing() };

  const newVer = await save(sql, holder, { db, vehiclesOut, snapOut, ps });
  warm = {
    ver: newVer,
    vehicles: vehiclesNow,
    settings: base.settings,
    ongoing: [...db.alerts.values()].filter((a) => a.ongoing || isPendingDrain(a)),
    nextAlertId: db.nextAlertId,
  };
  return { ...summary, ...timing() };
}

async function loadBase(sql) {
  const [vehicles, settings, ongoing, maxId] = await Promise.all([
    sql.unsafe(`select ${VEHICLE_SELECT}, rec, det_state from fuel.vehicles`),
    sql`select k, v from fuel.settings where k not like 'learned:%'`,
    sql`select * from fuel.alerts where ongoing or (type = 'fuel_drain' and extra like '%"pending":true%')`,
    sql`select coalesce(max(id), 0) as m from fuel.alerts`,
  ]);
  return { ver: null, vehicles: plain(vehicles), settings: settingsObject(settings), ongoing: plain(ongoing), nextAlertId: Number(maxId[0].m) + 1 };
}

/** Snapshots of the vehicles to feed (only those this instance does not hold already), the
 *  stored samples their new rows may repeat (or that a data hold releases), and the alerts
 *  their detectors may update. Returns Map imei -> snapshot. */
async function loadFeedContext(sql, db, feeds) {
  const snaps = new Map();
  if (!feeds.length) return snaps;
  const imeis = [...new Set(feeds.map((f) => f.rec.imei))];
  const cImeis = [];
  const cVers = [];
  for (const imei of imeis) {
    const c = snapCache.get(imei);
    if (c) {
      cImeis.push(imei);
      cVers.push(c.ver);
    }
  }
  const froms = feeds.map((f) => {
    let from = Infinity;
    for (const r of f.rows) {
      const t = Array.isArray(r) ? fromApiDate(r[0]) : null;
      if (t !== null && t < from) from = t;
    }
    if (f.rec.hold && Number.isFinite(f.rec.detT)) from = Math.min(from, Math.floor(f.rec.detT) + 1);
    return Number.isFinite(from) ? from : Date.now();
  });
  const [snapRows, sampleRows] = await Promise.all([
    sql`select d.imei, d.ver, case when c.ver is distinct from d.ver then d.snap end as snap
        from fuel.detector_state d
        left join unnest(${cImeis}::text[], ${cVers}::bigint[]) as c(imei, ver) on c.imei = d.imei
        where d.imei = any(${imeis}::text[])`,
    sql`select s.imei, s.t, s.f, s.spd, s.ign, s.pwr, s.lat, s.lng, s.odo
        from fuel.samples s
        join unnest(${feeds.map((f) => f.rec.imei)}::text[], ${froms}::bigint[]) as q(imei, f) on s.imei = q.imei and s.t >= q.f
        order by s.imei, s.t`,
  ]);
  for (const r of snapRows) {
    if (r.snap) snapCache.set(r.imei, { ver: r.ver, snap: r.snap });
    const c = snapCache.get(r.imei);
    if (c && c.ver === r.ver) snaps.set(r.imei, c.snap);
  }
  // stored samples: MemDb decides which fetched rows are new, and a released hold reads them
  const fromOf = new Map();
  feeds.forEach((f, k) => fromOf.set(f.rec.imei, Math.min(fromOf.get(f.rec.imei) ?? Infinity, froms[k])));
  for (const [imei, from] of fromOf) db.sampleTimes.set(imei, { from, times: new Set() });
  for (const r of sampleRows) {
    db.sampleTimes.get(r.imei)?.times.add(r.t);
    let list = db.samples.get(r.imei);
    if (!list) db.samples.set(r.imei, (list = []));
    list.push({ t: r.t, f: r.f, spd: r.spd, ign: r.ign, pwr: r.pwr, lat: r.lat, lng: r.lng, odo: r.odo });
  }
  const ids = new Set();
  for (const s of snaps.values()) snapAlertIds(s, ids);
  const missing = [...ids].filter((id) => !db.alerts.has(id));
  if (missing.length) for (const a of await sql`select * from fuel.alerts where id = any(${missing}::bigint[])`) db.addKnownAlert({ ...a });
  return snaps;
}

/** Everything in one transaction; nothing is written if the lease was lost meanwhile. */
async function save(sql, holder, { db, vehiclesOut, snapOut, ps }) {
  const o = db.out;
  const newAlerts = [...o.newAlerts.values()];
  const updates = [...o.alertUpdates].map((id) => db.alerts.get(id)).filter(Boolean);
  const settingsSet = [...o.settings].filter(([, v]) => v !== null).map(([k, v]) => ({ k, v }));
  const settingsDel = [...o.settings].filter(([, v]) => v === null).map(([k]) => k);
  const levels = [...o.levels.values()];
  let ver = null;
  await sql.begin(async (tx) => {
    const lease = await tx`select 1 from fuel.tick_lease where id = 1 and holder = ${holder} and until > now() for update`;
    if (!lease.length) throw new Error('tick lease lost (the tick took too long): nothing saved');
    const q = [];
    if (vehiclesOut.length) {
      q.push(tx`insert into fuel.vehicles (imei, ${tx.unsafe(VEHICLE_COLS.join(', '))}, updated_at, rec, det_state)
        select imei, ${tx.unsafe(VEHICLE_COLS.join(', '))}, updated_at, rec, det_state
        from jsonb_to_recordset(${js(vehiclesOut)}::jsonb) as x(imei text, name text, group_name text, device text, plate text, sim text,
          has_fuel boolean, last_seen bigint, server_seen bigint, lat float8, lng float8, speed float8, angle float8, ign smallint,
          pwr float8, fuel_raw float8, odometer_km float8, status text, updated_at bigint, rec jsonb, det_state jsonb)
        on conflict (imei) do update set name = excluded.name, group_name = excluded.group_name, device = excluded.device,
          plate = excluded.plate, sim = excluded.sim, has_fuel = excluded.has_fuel, last_seen = excluded.last_seen,
          server_seen = excluded.server_seen, lat = excluded.lat, lng = excluded.lng, speed = excluded.speed, angle = excluded.angle,
          ign = excluded.ign, pwr = excluded.pwr, fuel_raw = excluded.fuel_raw, odometer_km = excluded.odometer_km,
          status = excluded.status, updated_at = excluded.updated_at, rec = excluded.rec, det_state = excluded.det_state`);
    }
    for (let i = 0; i < o.samples.length; i += SAMPLE_BATCH) {
      q.push(tx`insert into fuel.samples (imei, t, f, spd, ign, pwr, lat, lng, odo)
        select imei, t, f, spd, ign, pwr, lat, lng, odo
        from jsonb_to_recordset(${js(o.samples.slice(i, i + SAMPLE_BATCH))}::jsonb) as x(imei text, t bigint, f float8, spd float8, ign smallint, pwr float8, lat float8, lng float8, odo float8)
        on conflict (imei, t) do nothing`);
    }
    if (levels.length) {
      q.push(tx`insert into fuel.levels (imei, t, mv)
        select imei, t, mv from jsonb_to_recordset(${js(levels)}::jsonb) as x(imei text, t bigint, mv float8)
        on conflict (imei, t) do update set mv = excluded.mv`);
    }
    if (newAlerts.length) {
      q.push(tx`insert into fuel.alerts (id, key, imei, name, type, severity, t, from_t, lat, lng, title, detail, amount_mv, ongoing,
          acked, acked_at, historical, extra, verdict, note, reviewed_at, created_at, updated_at)
        select id, key, imei, name, type, severity, t, from_t, lat, lng, title, detail, amount_mv, ongoing,
          false, null, historical, extra, null, null, null, created_at, updated_at
        from jsonb_to_recordset(${js(newAlerts)}::jsonb) as x(id bigint, key text, imei text, name text, type text, severity text,
          t bigint, from_t bigint, lat float8, lng float8, title text, detail text, amount_mv float8, ongoing boolean,
          historical boolean, extra text, created_at bigint, updated_at bigint)
        on conflict (key) do nothing`);
    }
    if (updates.length) {
      // only the columns the detectors / offline checks change (acks and reviews stay as the dashboard set them)
      q.push(tx`update fuel.alerts a set title = x.title, detail = x.detail, amount_mv = x.amount_mv, ongoing = x.ongoing,
          severity = x.severity, lat = x.lat, lng = x.lng, extra = x.extra, t = x.t, updated_at = x.updated_at
        from jsonb_to_recordset(${js(updates)}::jsonb) as x(id bigint, title text, detail text, amount_mv float8, ongoing boolean,
          severity text, lat float8, lng float8, extra text, t bigint, updated_at bigint)
        where a.id = x.id`);
    }
    if (settingsSet.length) {
      q.push(tx`insert into fuel.settings (k, v) select k, v from jsonb_to_recordset(${js(settingsSet)}::jsonb) as x(k text, v jsonb)
        on conflict (k) do update set v = excluded.v`);
    }
    if (settingsDel.length) q.push(tx`delete from fuel.settings where k = any(${settingsDel}::text[])`);
    let snapQ = null;
    if (snapOut.length) {
      snapQ = tx`insert into fuel.detector_state (imei, snap, ver, updated_at)
        select imei, snap, 1, ${Date.now()}::bigint from jsonb_to_recordset(${js(snapOut)}::jsonb) as x(imei text, snap jsonb)
        on conflict (imei) do update set snap = excluded.snap, ver = fuel.detector_state.ver + 1, updated_at = excluded.updated_at
        returning imei, ver`;
      q.push(snapQ);
    }
    const verQ = tx`update fuel.poller_state set state = ${js(ps)}::jsonb, ver = ver + 1 where id = 1 returning ver`;
    q.push(verQ);
    await Promise.all(q);
    ver = (await verQ)[0].ver;
    if (snapQ) {
      const bySnap = new Map(snapOut.map((s) => [s.imei, s.snap]));
      for (const r of await snapQ) snapCache.set(r.imei, { ver: r.ver, snap: JSON.parse(JSON.stringify(bySnap.get(r.imei))) });
    }
  });
  return ver;
}
