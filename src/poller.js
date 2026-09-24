// Polling loops against the GPS server. Each loop runs its job, then sleeps until the next
// interval, so runs never overlap. Errors are logged and shown in /api/status; the loop
// simply tries again next time.
//
// All three GPS-server loops run every "check every" minutes (Settings, default 30; 5..120):
//   objects  USER_GET_OBJECTS (one call, newest point of every vehicle) -> vehicle status,
//            offline/back online; objects-first: a vehicle's new point goes straight to its
//            detector when no OBJECT_GET_MESSAGES call is needed for it (see takeObjectPoints:
//            parked with the ignition off, or messagesMode "gaps")
//   messages OBJECT_GET_MESSAGES since the last stored message (with a 10 min overlap for rows
//            that reach the server late), for each vehicle with new data the objects poll could
//            not supply, or that is uploading a backlog after a coverage gap -> samples ->
//            detectors. The complete tracker history is fetched ("full"), so detection is the
//            same as with a live feed. messagesMode "gaps": only when the newest point jumped more
//            than 3 min past the last stored one, at most gapFetchesPerCycle vehicles a cycle.
//   events   OBJECT_GET_LAST_EVENTS_30M (or the 12 h list when checks are further apart) ->
//            server_event alerts
//   prune    hourly: drop old samples / levels / alerts (not refuels and fuel drains: those are
//            the permanent fuel ledger)
//
// Call budget (128 vehicles, measured on 7 days of the fleet's data, "full" mode): every 30 min
// about 48 objects + 48 events + ~3 000 messages calls a day, with the same refuels and fuel
// drains found as from the complete series; every 5 min ~20 000/day; every 2 h ~1 100/day.
// "gaps" mode saves most messages calls but missed half of the fuel drains in that data.
//
// When the server answers "API call limit exceeded", every request is paused for 10 min (longer
// on repeats, at most an hour) instead of being retried each poll, which would keep the key
// over its limit.
//
// Start-up: after the first objects poll, missing history (up to backfillHours) is fetched
// for every vehicle with concurrency apiConcurrency. Alerts found in that history are stored
// as historical and never pushed as notifications. Then the Excel fuel ledger is written.
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiError } from './api.js';
import { log, errText, mapPool } from './util.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const MIN = 60e3;
const OVERLAP_MS = 10 * MIN; // re-fetch this much before the last stored message
const HOLD_RECHECK_MS = 20 * MIN; // a vehicle waiting for its backlog is re-fetched each poll after this
const PAUSE_MS = 10 * MIN; // after "API call limit exceeded" (x1.5 on each repeat) ...
const PAUSE_MAX_MS = HOUR; // ... up to this
const NEXT_REPORT_MS = 75e3; // a parked tracker's next regular report (they report every 60 s or hourly)
const GAP_MS = 3 * MIN; // messagesMode "gaps": a jump larger than this is fetched

/** Stopped with the ignition off: the tracker is in its sparse "parked" reporting mode, so the
 *  objects poll (every minute) sees every point it sends. */
const parkedOff = (s) => !((s.spd ?? 0) >= 3) && s.ign === 0;

export class Poller {
  constructor({ cfg, api, engine, db, hub }) {
    this.cfg = cfg;
    this.api = api;
    this.engine = engine;
    this.db = db;
    this.hub = hub;
    this.ac = new AbortController();
    this.stopped = false;
    this.firstObjects = null;
    this.firstObjectsDone = new Promise((resolve) => {
      this.firstObjects = resolve;
    });
    this.loopOk = { objects: null, messages: null, events: null };
    this.eventsPolled = false;
    this.pauseUntil = 0; // no requests before this (API call limit reached)
    this.rateHits = 0; // call-limit refusals in a row (the pause grows with them)
    this.status = {
      startedAt: Date.now(),
      phase: 'starting', // starting -> backfill -> live
      lastObjectsPoll: null,
      lastMessagesPoll: null,
      lastEventsPoll: null,
      lastPrune: null,
      apiOk: null,
      lastError: null,
      lastErrorAt: null,
      pausedUntil: null, // set while requests are paused because of the API call limit
      errors: { objects: null, messages: null, events: null },
      backfill: { done: 0, total: 0, running: false, startedAt: null, finishedAt: null, durationMs: null, samples: 0, failed: 0, skipped: false },
      lastMessages: { vehicles: 0, samples: 0, failed: 0, durationMs: null },
    };
  }

  statusView() {
    const e = this.engine;
    return {
      ...this.status,
      backfill: { ...this.status.backfill },
      serverTimeMs: Date.now(),
      vehicles: e.recs.size,
      detector: e.DetectorClass
        ? { ok: true, errors: e.stats.detectorErrors, reportsLevels: e.detectorCallsOnLevel, afterHoursBy: e.backendAfterHours ? 'backend' : 'detector' }
        : { ok: false, error: e.detectorError },
      stats: { ...e.stats },
      notify: e.notifier ? structuredClone(e.notifier.status) : null,
      excel: e.ledger ? e.ledger.statusView() : null,
      config: {
        server: this.cfg.server, backfillHours: this.cfg.backfillHours, checkEveryMinutes: e.checkEveryMinutes(),
        messagesMode: this.cfg.messagesMode,
      },
      apiCalls: this.api.stats ? { ...this.api.stats, byCommand: { ...this.api.stats.byCommand } } : null,
      configError: this.cfg.configError,
    };
  }

  broadcastStatus() {
    this.hub.broadcast('status', this.statusView());
  }

  /** partial=true: some requests of a cycle failed but the GPS server did answer others, so
   *  the error is reported without marking the API as down. */
  recordError(where, e, extra = '', partial = false) {
    if (e?.code === 'RATE_LIMIT') this.rateLimited(e);
    const limited = e?.code === 'RATE_LIMIT' || e?.code === 'PAUSED';
    const msg = limited ? `${where}: ${this.pauseText()}` : `${where}: ${errText(e)}${extra}`;
    this.status.lastError = msg;
    this.status.lastErrorAt = Date.now();
    this.status.errors[where] = { message: msg, at: this.status.lastErrorAt, partial };
    if (where in this.loopOk) this.loopOk[where] = partial;
    this.updateApiOk();
    log('warn', msg);
  }

  markOk(where) {
    this.loopOk[where] = true;
    this.status.errors[where] = null;
    if (where !== 'messages') this.rateHits = 0; // (a messages cycle may have made no request)
    if (!this.pausedFor()) this.status.pausedUntil = null;
    this.updateApiOk();
  }

  // ---- API call limit ---------------------------------------------------------------
  pausedFor(now = Date.now()) {
    return Math.max(0, this.pauseUntil - now);
  }

  /** The server refused a call: the API key's call limit is used up. Stop asking for a while
   *  (every retry would count against the limit too). */
  rateLimited(e) {
    const now = Date.now();
    if (this.pausedFor(now) > 0) return; // other requests already in flight failed the same way
    this.rateHits++;
    this.pauseUntil = now + Math.min(PAUSE_MS * 1.5 ** (this.rateHits - 1), PAUSE_MAX_MS);
    this.status.pausedUntil = this.pauseUntil;
    log('warn', `GPS server call limit reached (${errText(e)}): pausing all requests until ${this.clock(this.pauseUntil)}`);
  }

  pauseText() {
    return `GPS server call limit reached — pausing until ${this.clock(this.pauseUntil)}`;
  }

  /** HH:MM in the configured time zone. */
  clock(t) {
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: this.cfg.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t);
    } catch {
      return new Date(t).toISOString().slice(11, 16) + ' UTC';
    }
  }

  pausedError() {
    return new ApiError(this.pauseText(), 'PAUSED');
  }

  updateApiOk() {
    const vals = Object.values(this.loopOk).filter((v) => v !== null);
    this.status.apiOk = vals.length ? vals.every(Boolean) : null;
  }

  start() {
    const every = () => this.engine.checkEveryMs();
    this.loops = [
      this.loop('objects', every, () => this.pollObjects()),
      this.messagesMain(),
      this.loop('events', every, () => this.pollEvents(), 5000),
      this.loop('prune', HOUR, () => this.prune(), 120e3, false),
    ];
  }

  async stop() {
    this.stopped = true;
    this.ac.abort();
    this.firstObjects?.();
  }

  async wait(ms) {
    if (this.stopped) return;
    try {
      await sleep(ms, undefined, { signal: this.ac.signal });
    } catch {
      /* aborted */
    }
  }

  /** interval: ms, or a function returning ms (re-read while waiting, so a new "check every"
   *  setting takes effect within half a minute). */
  async loop(name, interval, fn, initialDelayMs = 0, usesApi = true) {
    const intervalMs = typeof interval === 'function' ? interval : () => interval;
    if (initialDelayMs) await this.wait(initialDelayMs);
    while (!this.stopped) {
      if (usesApi && this.pausedFor() > 0) {
        await this.wait(this.pausedFor() + 1000); // API call limit: no request until the pause is over
        continue;
      }
      const t0 = Date.now();
      try {
        await fn();
      } catch (e) {
        this.recordError(name, e);
        this.broadcastStatus();
      }
      // retry the first objects poll sooner while the API has never answered
      for (;;) {
        const every = intervalMs();
        const due = t0 + (name === 'objects' && !this.status.lastObjectsPoll ? Math.min(every, 15000) : every);
        const left = due - Date.now();
        if (left <= 0 || this.stopped) break;
        await this.wait(Math.min(left, 30e3));
      }
      if (!this.stopped) await this.wait(Math.max(0, 1000 - (Date.now() - t0)));
    }
  }

  // ---- objects ---------------------------------------------------------------------
  async pollObjects() {
    const objs = await this.api.getObjects();
    if (this.stopped) return;
    const now = Date.now();
    const r = this.engine.applyObjects(objs, now);
    this.status.lastObjectsPoll = now;
    this.markOk('objects');
    if (r.added) log('info', `Vehicles: ${r.total} (${r.added} new)`);
    try {
      this.takeObjectPoints(now);
    } catch (e) {
      log('error', 'Taking points from the objects poll failed:', e);
    }
    this.hub.broadcast('vehicles', this.engine.vehiclesView(now));
    this.broadcastStatus();
    this.firstObjects();
  }

  /**
   * Objects-first: feed each vehicle's newest point from the objects answer to its detector
   * when that point is all there is to fetch, so no OBJECT_GET_MESSAGES call is spent on it:
   *   - parked with the ignition off before and now, and the point is the tracker's next regular
   *     report (<= 75 s later), or its hourly parked report (20 min - 2 h later, odometer unchanged);
   *   - messagesMode "gaps": also any point <= 3 min after the last stored one (the fleet's
   *     trackers send every ~10 s while driving: those rows are then not used).
   * Anything else (and a vehicle already waiting for a fetch) is left to pollMessages.
   */
  takeObjectPoints(now) {
    const e = this.engine;
    if (!e.historyReady || e.backfilling) return; // the start-up backfill fetches everything
    const gaps = this.cfg.messagesMode === 'gaps';
    let taken = 0;
    for (const rec of e.allRecs()) {
      if (!rec.objRow || rec.fetching || rec.hold || rec.historicalNext || rec.needFetch) continue;
      const s = e.parseRow(rec.objRow);
      if (!s || s.t > now + 10 * MIN || (rec.lastT != null && s.t <= rec.lastT)) continue;
      const prev = rec.lastPushed;
      let ok = false;
      if (prev && prev.t === rec.lastT) {
        const dt = s.t - prev.t;
        const odoSame = prev.odo !== null && s.odo !== null && Math.abs(s.odo - prev.odo) < 200;
        if (parkedOff(prev) && parkedOff(s)) ok = dt <= NEXT_REPORT_MS || (dt >= 20 * MIN && dt <= 2 * HOUR && odoSame);
        if (!ok && gaps) ok = dt <= GAP_MS || (parkedOff(prev) && parkedOff(s) && odoSame);
      }
      if (!ok) {
        rec.needFetch = true; // stays set until fetched, so no later point is taken past the missing rows
        continue;
      }
      try {
        e.ingest(rec, [rec.objRow], 'live', { now });
        taken++;
      } catch (err) {
        rec.needFetch = true;
        log('error', `Storing the objects point of ${rec.v.name} (${rec.imei}) failed:`, err);
      }
    }
    this.status.lastObjectPoints = { at: now, taken };
  }

  // ---- messages --------------------------------------------------------------------
  async messagesMain() {
    await this.firstObjectsDone;
    if (this.stopped) return;
    if (this.cfg.noBackfill) {
      const floor = Date.now() - 15 * 60e3;
      for (const rec of this.engine.allRecs()) rec.fetchFloor = floor;
      this.status.backfill.skipped = true;
      this.engine.historyReady = true;
      log('info', 'NO_BACKFILL=1: history backfill skipped');
    } else {
      this.status.phase = 'backfill';
      const todo = await this.backfill();
      // Vehicles with nothing to backfill: whatever they send from now on is live. Vehicles
      // whose backfill failed keep historicalNext, so the retry is still treated as history.
      for (const rec of this.engine.allRecs()) if (!todo.has(rec)) rec.historicalNext = false;
    }
    if (this.stopped) return;
    this.status.phase = 'live';
    this.engine.ledger?.historyReady(); // the Excel fuel ledger now covers the loaded history
    this.broadcastStatus();
    await this.loop('messages', () => this.engine.checkEveryMs(), () => this.pollMessages());
  }

  async backfill() {
    const now = Date.now();
    const since = now - this.cfg.backfillHours * HOUR;
    const todo = this.engine.allRecs().filter((r) => r.info.lastSeen && r.info.lastSeen > Math.max(r.lastT ?? 0, since));
    todo.sort((a, b) => Number(b.v.hasFuel) - Number(a.v.hasFuel) || b.info.lastSeen - a.info.lastSeen);
    const bf = this.status.backfill;
    Object.assign(bf, { done: 0, total: todo.length, running: true, startedAt: now, finishedAt: null, durationMs: null, samples: 0, failed: 0 });
    this.engine.historyReady = false;
    this.engine.backfilling = true; // the Excel ledger is written once at the end, not per alert
    log('info', `Backfill: fetching up to ${this.cfg.backfillHours} h of history for ${todo.length} vehicles`);
    this.broadcastStatus();
    let lastErr = null;
    try {
      await mapPool(todo, this.cfg.apiConcurrency, async (rec) => {
        if (this.stopped) return;
        try {
          const n = await this.fetchVehicle(rec); // (not `x += await`: workers run concurrently)
          bf.samples += n;
        } catch (e) {
          bf.failed++;
          lastErr = e;
          if (e.code !== 'PAUSED') log('warn', `Backfill ${rec.v.name} (${rec.imei}) failed: ${errText(e)}`);
        }
        bf.done++;
        if (bf.done % 5 === 0 || bf.done === bf.total) {
          this.broadcastStatus();
        }
      });
    } finally {
      this.engine.backfilling = false;
    }
    bf.running = false;
    bf.finishedAt = Date.now();
    bf.durationMs = bf.finishedAt - now;
    this.engine.historyReady = true;
    this.engine.saveLearned();
    if (lastErr) this.recordError('messages', lastErr, ` (backfill: ${bf.failed}/${bf.total} vehicles failed, retried in the next cycle)`, bf.failed < bf.total);
    else if (todo.length) this.markOk('messages');
    log('info', `Backfill done: ${bf.samples} messages from ${bf.total - bf.failed}/${bf.total} vehicles in ${(bf.durationMs / 1000).toFixed(1)} s`);
    this.hub.broadcast('vehicles', this.engine.vehiclesView());
    this.broadcastStatus();
    return new Set(todo);
  }

  /** The GPS server is receiving old records from this tracker (a backlog after a coverage
   *  gap): its last server contact is well after the newest record's own time. */
  backlogActive(rec, now = Date.now()) {
    const i = rec.info;
    return i.serverSeen != null && i.lastSeen != null && i.serverSeen - i.lastSeen > 5 * MIN && now - i.serverSeen < 30 * MIN;
  }

  /** Fetch everything newer than the last stored message for one vehicle. */
  async fetchVehicle(rec) {
    if (rec.fetching) return 0;
    if (this.pausedFor() > 0) throw this.pausedError(); // API call limit: not now
    rec.fetching = true;
    try {
      const now = Date.now();
      const seen = rec.info.lastSeen;
      const serverSeen = rec.info.serverSeen;
      // never ask for the future (a tracker clock ahead would otherwise pin lastT there)
      const to = Math.min(Math.max(now, seen ?? 0) + 60e3, now + 5 * MIN);
      const maxBack = Math.max(this.cfg.backfillHours * HOUR, 30 * MIN);
      // counted back from `to`, so a full backfill is exactly backfillHours / 24 one-day requests
      const floor = to - maxBack;
      let mode = rec.historicalNext ? 'backfill' : 'live';
      let hole = false;
      let from;
      if (rec.lastT === null || rec.lastT === undefined) {
        from = floor;
      } else {
        // overlap: rows that reached the server after newer ones are picked up (stored rows
        // are ignored); while waiting for a backlog, re-fetch from the start of the gap
        from = rec.hold ? Math.min(rec.hold.from + 1000, rec.lastT - OVERLAP_MS) : rec.lastT - OVERLAP_MS;
        if (rec.lastT + 1000 < floor) {
          // history older than the backfill window is not fetched: tell the detector there is
          // a hole, and treat what comes after it as history (no pop-ups for old events)
          hole = true;
          mode = 'backfill';
        }
        from = Math.max(from, floor);
      }
      from = Math.max(from, rec.fetchFloor ?? -Infinity);
      // nothing stored yet and its newest message is older than the window (a vehicle silent for
      // longer than backfillHours): no message can be found, so no request is spent on it
      const nothingToFetch = (rec.lastT === null || rec.lastT === undefined) && seen != null && seen < from;
      const rows = [];
      for (let a = from; a < to && !nothingToFetch && !this.stopped;) {
        const b = Math.min(to, a + DAY);
        let r;
        try {
          r = await this.api.getMessages(rec.imei, a, b);
        } catch (e) {
          if (e.code === 'RATE_LIMIT') this.rateLimited(e); // the other workers stop asking too
          throw e;
        }
        if (Array.isArray(r)) for (const x of r) rows.push(x);
        a = b;
      }
      if (this.stopped) return 0;
      if (hole) this.engine.markGap(rec);
      const n = this.engine.ingest(rec, rows, mode, { now: Date.now(), backlog: this.backlogActive(rec), allowHold: mode === 'live' });
      rec.historicalNext = false;
      rec.needFetch = false;
      rec.fetchFloor = null;
      rec.fetchedSeen = seen;
      rec.fetchedServerSeen = serverSeen;
      rec.fetchedAt = now;
      return n;
    } finally {
      rec.fetching = false;
    }
  }

  async pollMessages() {
    const t0 = Date.now();
    let due = this.engine.allRecs().filter((r) => {
      if (!r.info.lastSeen || r.fetching) return false;
      // new data the objects poll did not supply (see takeObjectPoints)
      if (r.needFetch || r.info.lastSeen > Math.max(r.lastT ?? 0, r.fetchedSeen ?? 0)) return true;
      const serverNews = (r.info.serverSeen ?? 0) > (r.fetchedServerSeen ?? 0);
      // uploading old records (dt_tracker behind): fetch again to pick up the late rows
      if (serverNews && this.backlogActive(r, t0)) return true;
      // waiting for a backlog: re-fetch when the server heard from it, and each poll after a while
      return !!r.hold && (serverNews || t0 - r.hold.since >= HOLD_RECHECK_MS);
    });
    const waiting = due.length;
    if (this.cfg.messagesMode === 'gaps' && due.length > this.cfg.gapFetchesPerCycle) {
      // call budget: the vehicles with a fuel sensor and the longest wait first, the rest next cycle
      due.sort((a, b) => Number(b.v.hasFuel) - Number(a.v.hasFuel) || (a.lastT ?? 0) - (b.lastT ?? 0));
      due = due.slice(0, this.cfg.gapFetchesPerCycle);
    }
    let samples = 0;
    let failed = 0;
    let lastErr = null;
    await mapPool(due, this.cfg.apiConcurrency, async (rec) => {
      if (this.stopped) return;
      try {
        const n = await this.fetchVehicle(rec);
        samples += n;
      } catch (e) {
        failed++;
        lastErr = e;
      }
    });
    this.status.lastMessagesPoll = Date.now();
    this.status.lastMessages = { vehicles: due.length, deferred: waiting - due.length, samples, failed, durationMs: Date.now() - t0, waitingForBacklog: this.engine.heldCount() };
    this.engine.stats.heldVehicles = this.engine.heldCount();
    this.engine.saveLearned();
    if (failed) this.recordError('messages', lastErr, ` (${failed}/${due.length} vehicles failed, retried next cycle)`, failed < due.length);
    else this.markOk('messages');
    if (samples) this.hub.broadcast('vehicles', this.engine.vehiclesView());
    this.broadcastStatus();
  }

  // ---- server events -----------------------------------------------------------------
  async pollEvents() {
    // first run after start: the last 12 h, stored as history; afterwards the last 30 min, or
    // the 12 h list again when the checks are further apart than that (events are de-duplicated)
    const first = !this.eventsPolled;
    const res = first || this.engine.checkEveryMs() > 25 * MIN ? await this.api.getLastEvents12h() : await this.api.getLastEvents30m();
    if (this.stopped) return;
    const r = this.engine.ingestServerEvents(res, first ? 'backfill' : 'live');
    this.eventsPolled = true;
    this.status.lastEventsPoll = Date.now();
    this.markOk('events');
    if (r.received) log('info', `GPS server events: ${r.received} received, ${r.created} new`);
    this.broadcastStatus();
  }

  // ---- maintenance ---------------------------------------------------------------------
  async prune() {
    const now = Date.now();
    const r = this.db.prune(now - this.cfg.keepHours * HOUR, now - this.cfg.keepDays * DAY);
    this.status.lastPrune = now;
    if (r.samples || r.levels || r.alerts) log('info', `Pruned ${r.samples} samples, ${r.levels} levels, ${r.alerts} alerts`);
  }
}
