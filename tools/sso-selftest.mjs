// Sign-in from the admin web (POST /api/sso) and the read-only accountant session.
// The Open Teever API lookup is stubbed; no network.
//
//   node --no-warnings tools/sso-selftest.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import { createHandler, adminWebUser } from '../src/routes.js';

const TOKENS = {
  'admin-token-0123456789abcdef': { id: 'u1', readOnly: false },
  'accountant-token-0123456789ab': { id: 'u2', readOnly: true },
};
const cfg = { dashboardPassword: 'pw-for-test-only', sessionSecret: 'x'.repeat(64), publicDir: 'public', host: '0.0.0.0', trustProxy: false };
const engine = { alertTypes: [], groups: () => [], putVehicleSettings: () => ({ ok: true }) };
const handler = createHandler({ cfg, engine, poller: { statusView: () => ({ ok: true }) }, notifier: {}, hub: {}, ledger: {}, lookupAdminWeb: async (t) => TOKENS[t] || null });
const server = http.createServer(handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const call = (p, { method = 'GET', body, cookie } = {}) => fetch(base + p, {
  method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined,
});
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
let n = 0;
const ok = (name) => { n++; console.log('ok', name); };

try {
  assert.equal((await call('/api/status')).status, 401); ok('no cookie = login required');

  let r = await call('/api/sso', { method: 'POST', body: { token: 'nope-nope-nope-nope-nope' } });
  assert.equal(r.status, 401); ok('unknown admin token refused');

  r = await call('/api/sso', { method: 'POST', body: { token: 'admin-token-0123456789abcdef' } });
  assert.equal(r.status, 200);
  const admin = cookieOf(r);
  assert.match(r.headers.get('set-cookie'), new RegExp(`Max-Age=${15 * 86400}`)); ok('admin signed in for 15 days');
  assert.equal((await call('/api/status', { cookie: admin })).status, 200); ok('admin session reads');
  assert.notEqual((await call('/api/no-such-route', { method: 'POST', body: {}, cookie: admin })).status, 403); ok('admin session may change');

  r = await call('/api/sso', { method: 'POST', body: { token: 'accountant-token-0123456789ab' } });
  const acc = cookieOf(r);
  assert.equal((await call('/api/status', { cookie: acc })).status, 200); ok('accountant reads');
  assert.equal((await call('/api/no-such-route', { method: 'POST', body: {}, cookie: acc })).status, 403); ok('accountant cannot change');

  const forged = acc.replace('.r.', '.');
  assert.equal((await call('/api/status', { cookie: forged })).status, 401); ok('dropping the read-only mark breaks the signature');

  r = await call('/api/login', { method: 'POST', body: { password: 'pw-for-test-only' } });
  assert.equal(r.status, 200);
  assert.equal((await call('/api/status', { cookie: cookieOf(r) })).status, 200); ok('dashboard password still works');

  // the real lookup: roles from GET /api/v1/user/getMe
  const stub = (data, status = 200) => async () => ({ ok: status === 200, json: async () => ({ data }) });
  const OD = '16e26851-0dcc-5693-8c8e-5ed380e0c70d';
  const T = 'eyJhbGciOiJIUzI1NiJ9.eyJJZCI6IjEifQ.abc_def-123';
  assert.deepEqual(await adminWebUser('https://x', T, [OD], stub({ _id: 'a', role: 'dispatcher', companyId: OD })), { id: 'a', readOnly: false });
  assert.deepEqual(await adminWebUser('https://x', T, [OD], stub({ _id: 'b', role: 'accountant', companyId: OD })), { id: 'b', readOnly: true });
  assert.deepEqual(await adminWebUser('https://x', T, [OD], stub({ _id: 'c', role: 'accountant', roles: ['mechanic'], companyId: OD })), { id: 'c', readOnly: false });
  assert.equal(await adminWebUser('https://x', T, [OD], stub({ id: 'd', role: 'hr' })), null);
  assert.equal(await adminWebUser('https://x', T, [OD], stub({ id: 'e', role: 'driver' })), null);
  assert.equal(await adminWebUser('https://x', T, [OD], stub(null, 401)), null);
  assert.equal(await adminWebUser('https://x', 'short', stub({ id: 'f', role: 'superadmin' })), null);
  assert.equal(await adminWebUser('https://x', T, [OD], stub({ _id: 'g', role: 'company_admin', companyId: '11111111-2222-3333-4444-555555555555' })), null);
  assert.equal(await adminWebUser('https://x', T, [OD], stub({ _id: 'h', role: 'dispatcher', companyId: null })), null);
  assert.deepEqual(await adminWebUser('https://x', T, [OD], stub({ _id: 'i', role: 'superadmin', companyId: null })), { id: 'i', readOnly: false });
  ok('company rule: only Open Development staff (and superadmin); other companies refused');
  ok('role rules: staff in, accountant read-only, HR and drivers out');
} finally {
  server.close();
}
console.log(`${n} checks passed`);
