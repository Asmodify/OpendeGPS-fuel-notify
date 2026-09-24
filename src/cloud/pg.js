// Postgres client for the cloud version (Supabase transaction pooler: no prepared statements).
// Only the cloud entry point (api/index.js) loads this module; the local program never does.
import postgres from 'postgres';

let client = null;

/** Shared client (one per function instance; reused while the instance stays warm). */
export function getSql(url = process.env.DATABASE_URL) {
  if (client) return client;
  if (!url) throw new Error('DATABASE_URL is not set');
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    /* postgres() reports the bad URL */
  }
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host) || /sslmode=disable/.test(url);
  client = postgres(url, {
    prepare: false, // required by the transaction pooler (port 6543)
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
    max_lifetime: 30 * 60,
    ssl: local ? false : 'require',
    onnotice: () => {},
    // bigint columns (millisecond times, ids, counts) as plain numbers
    types: { int8num: { to: 20, from: [20], serialize: (x) => String(x), parse: (x) => Number(x) } },
  });
  return client;
}

/** For tests: use this client instead of one from DATABASE_URL. */
export function setSql(sql) {
  client = sql;
}

/** JSON text for jsonb_to_recordset($1::jsonb) bulk writes. */
export const js = (rows) => JSON.stringify(rows);
