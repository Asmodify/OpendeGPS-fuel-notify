// Configuration of the cloud version (Vercel + Supabase Postgres): everything comes from
// environment variables and the database, nothing from config.json.
//
//   GPS_API_KEY         User API key of the GPS server (required for polling)
//   GPS_SERVER          default https://fms.gpsbox.mn
//   DATABASE_URL        Supabase transaction pooler URL (port 6543)
//   CRON_SECRET         bearer token the Supabase pg_cron job sends to POST /api/cron/tick
//   DASHBOARD_PASSWORD  password of the dashboard login
//   SESSION_SECRET      key that signs the login cookie (long random string)
//   TZ_OFFSET_MINUTES   optional, default 480 (Asia/Ulaanbaatar, no daylight saving)
//   TICK_MAX_CALLS      optional, OBJECT_GET_MESSAGES requests per tick (default 10)
import { DEFAULT_THRESHOLDS, DEFAULT_CALIBRATION } from '../config.js';

export const TIMEZONE = 'Asia/Ulaanbaatar';

/** [[mV, litres], ...] from the database -> { emptyMv, fullMv, tankLiters, table } like
 *  config.js loadCalibrations (null when the table is unusable). */
export function calFromPoints(points) {
  if (!Array.isArray(points)) return null;
  const clean = points
    .filter((p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
    .map((p) => [Number(p[0]), Number(p[1])])
    .sort((a, b) => a[0] - b[0]);
  if (clean.length < 2 || !(clean[clean.length - 1][0] > clean[0][0]) || !(clean[clean.length - 1][1] > 0)) return null;
  return { emptyMv: clean[0][0], fullMv: clean[clean.length - 1][0], tankLiters: Math.max(...clean.map((p) => p[1])), table: clean };
}

const posInt = (x, dflt, min, max) => {
  const n = Math.round(Number(x));
  return Number.isFinite(n) && n >= min && n <= max ? n : dflt;
};

/** The cfg object Engine expects (see config.js loadConfig), for the cloud. */
export function cloudConfig(env = process.env, calibrationRows = []) {
  const calibrations = {};
  for (const r of calibrationRows) {
    const c = calFromPoints(typeof r.points === 'string' ? JSON.parse(r.points) : r.points);
    if (c) calibrations[String(r.imei)] = c;
  }
  const tzOffsetMinutes = posInt(env.TZ_OFFSET_MINUTES, 480, -720, 840);
  return {
    mode: 'cloud',
    server: String(env.GPS_SERVER || 'https://fms.gpsbox.mn').trim(),
    apiKey: String(env.GPS_API_KEY || '').trim(),
    // the whole call has to fit in one function run
    apiTimeoutSeconds: 20,
    timezone: TIMEZONE,
    tzOffsetMinutes,
    pollObjectsSeconds: 60,
    // history fetched for a vehicle seen for the first time (spread over several ticks)
    initialBackfillHours: 6,
    // a gap in a vehicle's data is filled from at most this far back (one request)
    backfillHours: 24,
    maxCallsPerTick: posInt(env.TICK_MAX_CALLS, 10, 0, 50),
    parkedReportMinutes: 65,
    keepSampleHours: 72,
    fuelParam: 'io9',
    ignitionParam: 'io239',
    powerParam: 'io66',
    odometerParam: 'io16',
    thresholds: { ...DEFAULT_THRESHOLDS },
    defaultCalibration: { ...DEFAULT_CALIBRATION },
    // the cloud only notifies in the open dashboard
    notify: { windowsToast: false, severities: ['critical', 'warning'], throttleMinutes: 10 },
    calibrations,
    configError: null,
  };
}
