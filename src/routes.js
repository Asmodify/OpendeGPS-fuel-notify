// HTTP API (JSON) + static dashboard files from public/.
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './engine.js';
import { log, errText } from './util.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.webmanifest': 'application/manifest+json',
};

const PLACEHOLDER = `<!doctype html><meta charset="utf-8"><title>Fuel Tank Warner</title>
<body style="font-family:system-ui;margin:40px"><h1>Fuel Tank Warner</h1>
<p>The server is running, but the dashboard files (public/index.html) are missing.</p>
<p>API: <a href="/api/vehicles">/api/vehicles</a> &middot; <a href="/api/alerts">/api/alerts</a> &middot; <a href="/api/status">/api/status</a></p></body>`;

function send(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(data);
}

async function readJson(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'request body too large');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
}

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Content-Disposition for a download: ASCII fallback plus the UTF-8 name (RFC 6266 / 5987). */
function attachment(name) {
  const ascii = name.replace(/[^\x20-\x7E]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const isLoopback = (addr) => /^(127\.|::1$|::ffff:127\.)/.test(String(addr || ''));

const intParam = (v) => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const listParam = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

export function createHandler({ cfg, engine, poller, notifier, hub, ledger }) {
  const publicDir = path.resolve(cfg.publicDir);
  const loopbackOnly = ['127.0.0.1', 'localhost', '::1'].includes(cfg.host);
  const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

  function guard(req, url) {
    // Bound to this computer only: refuse other Host names (DNS-rebinding protection).
    if (loopbackOnly) {
      const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
      if (host && !LOCAL_HOSTS.has(host)) throw new HttpError(403, 'forbidden host');
    }
    // Changes must come from the dashboard itself, not from another web site.
    if (req.method !== 'GET' && req.method !== 'HEAD' && url.pathname.startsWith('/api/')) {
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'cross-site request refused');
      const origin = req.headers.origin;
      if (origin && origin !== 'null') {
        let oh = '';
        try {
          oh = new URL(origin).host.toLowerCase();
        } catch {
          /* invalid */
        }
        if (oh !== String(req.headers.host || '').toLowerCase()) throw new HttpError(403, 'cross-origin request refused');
      }
    }
  }

  async function api(req, res, url) {
    const m = req.method;
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const q = url.searchParams;
    let seg; // path segments after /api
    try {
      seg = p.split('/').slice(2).map(decodeURIComponent);
    } catch {
      throw new HttpError(400, 'bad path');
    }

    if (m === 'GET' && p === '/api/meta') {
      return send(res, 200, {
        alertTypes: engine.alertTypes,
        groups: engine.groups(),
        serverTimeMs: Date.now(),
        timezone: cfg.timezone,
        severities: ['critical', 'warning', 'info'],
        // the cloud version (api/) answers mode 'cloud' with all features false
        mode: 'local',
        features: { sse: true, windowsToast: true, excelFile: true, openFolder: true },
      });
    }
    if (m === 'GET' && p === '/api/status') return send(res, 200, poller.statusView());
    if (m === 'GET' && p === '/api/vehicles') return send(res, 200, engine.vehiclesView());
    if (seg[0] === 'vehicles' && seg[1]) {
      const imei = seg[1];
      const rec = engine.recs.get(imei);
      if (!rec) throw new HttpError(404, 'unknown vehicle');
      if (m === 'GET' && seg.length === 2) return send(res, 200, engine.vehicleView(rec, engine.db.activeCounts().get(imei)));
      if (m === 'GET' && seg[2] === 'history' && seg.length === 3) return send(res, 200, engine.history(imei, intParam(q.get('hours')) ?? 24));
      if (m === 'PUT' && seg[2] === 'settings' && seg.length === 3) {
        const r = engine.putVehicleSettings(imei, await readJson(req));
        hub.broadcast('vehicles', engine.vehiclesView());
        return send(res, 200, r);
      }
    }
    if (m === 'GET' && p === '/api/alerts') {
      const limit = Math.min(5000, Math.max(1, Math.round(intParam(q.get('limit')) ?? 200)));
      return send(res, 200, engine.queryAlerts({
        imei: q.get('imei') || undefined,
        severities: listParam(q.get('severity')),
        types: listParam(q.get('type')),
        since: intParam(q.get('since')),
        until: intParam(q.get('until')),
        unacked: ['1', 'true', 'yes'].includes(String(q.get('unacked') || '').toLowerCase()),
        beforeId: intParam(q.get('beforeId')),
        limit,
      }));
    }
    if (m === 'POST' && p === '/api/alerts/ack-all') {
      const body = await readJson(req);
      const imei = typeof body.imei === 'string' && body.imei ? body.imei : undefined;
      return send(res, 200, { ok: true, acked: engine.ackAll(imei) });
    }
    if (seg[0] === 'alerts' && /^\d+$/.test(seg[1] || '')) {
      const id = Number(seg[1]);
      if (m === 'GET' && seg.length === 2) {
        const row = engine.db.getAlert(id);
        if (!row) throw new HttpError(404, 'unknown alert');
        return send(res, 200, engine.alertView(row));
      }
      if (m === 'POST' && (seg[2] === 'ack' || seg[2] === 'unack') && seg.length === 3) {
        await readJson(req).catch(() => ({}));
        const view = engine.ackAlert(id, seg[2] === 'ack');
        if (!view) throw new HttpError(404, 'unknown alert');
        return send(res, 200, view);
      }
      if (m === 'PUT' && seg[2] === 'review' && seg.length === 3) {
        const view = engine.reviewAlert(id, await readJson(req, 16 * 1024));
        if (!view) throw new HttpError(404, 'unknown alert');
        return send(res, 200, view);
      }
    }
    // ---- Excel fuel ledger ----
    if ((m === 'GET' || m === 'HEAD') && p === '/api/export/fuel-events.xlsx') {
      if (!ledger) throw new HttpError(404, 'the Excel fuel ledger is not available');
      const now = Date.now();
      const buf = await ledger.buildBuffer(now);
      const day = new Date(now + engine.tzOffsetMin * 60e3).toISOString().slice(0, 10);
      res.writeHead(200, {
        'content-type': XLSX_TYPE,
        'content-length': buf.length,
        'content-disposition': attachment(`Fuel events ${day}.xlsx`),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      return res.end(m === 'HEAD' ? undefined : buf);
    }
    if (m === 'GET' && p === '/api/excel') {
      if (!ledger) throw new HttpError(404, 'the Excel fuel ledger is not available');
      return send(res, 200, ledger.statusView());
    }
    if (m === 'POST' && p === '/api/excel/open-folder') {
      await readJson(req).catch(() => ({})); // the body is ignored: the path is never taken from a request
      if (!ledger) throw new HttpError(404, 'the Excel fuel ledger is not available');
      // opens a window on this computer's screen: only for the person sitting at it
      if (!isLoopback(req.socket?.remoteAddress)) throw new HttpError(403, 'the folder can only be opened from this computer');
      const r = ledger.openFolder();
      if (!r.ok) throw new HttpError(409, r.error);
      return send(res, 200, r);
    }
    if (m === 'GET' && p === '/api/summary') return send(res, 200, engine.summary(intParam(q.get('hours')) ?? 24));
    if (m === 'GET' && p === '/api/settings') return send(res, 200, engine.settingsView());
    if (m === 'PUT' && p === '/api/settings') {
      const r = engine.putSettings(await readJson(req));
      hub.broadcast('vehicles', engine.vehiclesView());
      return send(res, 200, r);
    }
    if (m === 'POST' && p === '/api/test-notification') {
      await readJson(req).catch(() => ({}));
      return send(res, 200, await notifier.test());
    }
    if (m === 'GET' && p === '/api/stream') {
      hub.add(req, res, [
        ['status', poller.statusView()],
        ['vehicles', engine.vehiclesView()],
      ]);
      return undefined;
    }
    throw new HttpError(404, `no such API endpoint: ${m} ${p}`);
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, 'bad path');
    }
    if (rel === '/' || rel === '') rel = '/index.html';
    if (rel.startsWith('/public/')) rel = rel.slice('/public'.length);
    const file = path.resolve(publicDir, '.' + path.posix.normalize(rel));
    if (file !== publicDir && !file.startsWith(publicDir + path.sep)) throw new HttpError(403, 'forbidden');
    let st;
    try {
      st = fs.statSync(file);
      if (st.isDirectory()) {
        return serveStatic(req, res, new URL(url.pathname.replace(/\/?$/, '/') + 'index.html', url));
      }
    } catch {
      if (rel === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(PLACEHOLDER);
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    return undefined;
  }

  return async function handler(req, res) {
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
      guard(req, url);
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) await api(req, res, url);
      else serveStatic(req, res, url);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) log('error', `${req.method} ${req.url} failed:`, e);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      send(res, status, { error: status >= 500 ? `internal error: ${errText(e)}` : e.message });
    }
  };
}
