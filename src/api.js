// Client for the GPS-server "User API" (https://fms.gpsbox.mn/api/api.php?api=user).
// All tracker timestamps, and the from/to parameters, are UTC "YYYY-MM-DD HH:MM:SS".
import { setTimeout as sleep } from 'node:timers/promises';
import { toApiDate, fromApiDate } from './util.js';

export { toApiDate, fromApiDate };

/** .code 'RATE_LIMIT': the server refused the call because the API key's call limit is used
 *  up ("ERROR: API call limit exceeded"); the poller then pauses instead of retrying. */
export class ApiError extends Error {
  constructor(message, code) {
    super(message);
    if (code) this.code = code;
  }
}

const RATE_LIMIT_RE = /call limit|limit exceeded|too many (requests|calls)/i;

// The server answers some failures (e.g. a missing key) with HTTP 200 and an empty body.
// call() returns this marker for it; only calls where "nothing" is a normal answer map it to [].
export const EMPTY = Symbol('empty response');

export function createApi({ server, apiKey, apiTimeoutSeconds = 90 }) {
  const base = String(server || '').replace(/\/+$/, '');
  // requests sent, per command (shown in /api/status, to keep an eye on the key's call limit)
  const stats = { since: Date.now(), total: 0, byCommand: {} };

  async function call(cmd, { timeoutMs = apiTimeoutSeconds * 1000, retries = 2 } = {}) {
    const name = cmd.split(',')[0];
    if (!base) throw new ApiError('no GPS server configured');
    if (!apiKey) throw new ApiError('no API key configured');
    const url = `${base}/api/api.php?api=user&key=${encodeURIComponent(apiKey)}&cmd=${encodeURIComponent(cmd)}`;
    let res;
    for (let attempt = 0; ; attempt++) {
      stats.total++;
      stats.byCommand[name] = (stats.byCommand[name] || 0) + 1;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
        break;
      } catch (e) {
        // connection-level failures (the server sometimes does not accept a connection in
        // time) are retried after a short pause; a request that timed out as a whole is not
        if (e.name !== 'TimeoutError' && e.name !== 'AbortError' && attempt < retries) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        throw new ApiError(`${name}: ${e.name === 'TimeoutError' ? `timed out after ${Math.round(timeoutMs / 1000)} s` : e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''}`);
      }
    }
    let text;
    try {
      text = await res.text();
    } catch (e) {
      throw new ApiError(`${name}: reading response failed: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`);
    }
    if (!res.ok) throw new ApiError(`${name}: HTTP ${res.status} ${text.slice(0, 120)}`, res.status === 429 ? 'RATE_LIMIT' : undefined);
    const body = text.replace(/^\uFEFF/, '').trim();
    if (body === '') return EMPTY;
    // the server reports problems as plain text with HTTP 200, e.g. "ERROR: wrong API key"
    if (/^ERROR\b/i.test(body)) throw new ApiError(`${name}: ${body.slice(0, 160)}`, RATE_LIMIT_RE.test(body) ? 'RATE_LIMIT' : undefined);
    try {
      return JSON.parse(body);
    } catch {
      throw new ApiError(`${name}: server returned non-JSON: ${body.slice(0, 120)}`);
    }
  }

  const orEmpty = (x) => (x === EMPTY ? [] : x);

  function expectArray(name, x) {
    if (Array.isArray(x)) return x;
    // the server reports some problems as a JSON object/string instead of an array
    throw new ApiError(`${name}: unexpected response ${JSON.stringify(x).slice(0, 160)}`);
  }

  return {
    call,
    stats,
    async getObjects() {
      const r = await call('USER_GET_OBJECTS');
      // an empty body or list is an error here (the account has vehicles): treating it as
      // "no data" would mark the whole fleet offline while the status stays green
      if (r === EMPTY || (Array.isArray(r) && r.length === 0)) throw new ApiError('USER_GET_OBJECTS: empty response from the GPS server');
      return expectArray('USER_GET_OBJECTS', r);
    },
    /** rows: [dt, lat, lng, altitude, angle, speed, params{}] */
    async getMessages(imei, fromMs, toMs) {
      const r = await call(`OBJECT_GET_MESSAGES,${imei},${toApiDate(fromMs)},${toApiDate(toMs)}`);
      if (r === EMPTY) return [];
      if (r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length === 0) return [];
      return expectArray('OBJECT_GET_MESSAGES', r);
    },
    async getRoute(imei, fromMs, toMs, minStopMinutes = 1) {
      const r = await call(`OBJECT_GET_ROUTE,${imei},${toApiDate(fromMs)},${toApiDate(toMs)},${minStopMinutes}`);
      return r === EMPTY ? null : r;
    },
    getLastEvents30m: async () => orEmpty(await call('OBJECT_GET_LAST_EVENTS_30M')),
    getLastEvents12h: async () => orEmpty(await call('OBJECT_GET_LAST_EVENTS')),
    getLastEvents7d: async () => orEmpty(await call('OBJECT_GET_LAST_EVENTS_7D')),
  };
}
