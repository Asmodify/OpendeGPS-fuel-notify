// Wires everything together (loaded by server.js).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApi } from './api.js';
import { Engine } from './engine.js';
import { Ledger } from './ledger.js';
import { Poller } from './poller.js';
import { Notifier } from './notify.js';
import { SseHub } from './sse.js';
import { createHandler } from './routes.js';
import { log, setLogFile } from './util.js';

const cfg = loadConfig();
fs.mkdirSync(cfg.dataDir, { recursive: true });
setLogFile(path.join(cfg.dataDir, 'app.log'));
log('info', `Fuel Tank Warner starting (Node ${process.version}, pid ${process.pid}); config ${cfg.configPath}; data ${cfg.dataDir}`);
if (cfg.configError) log('warn', cfg.configError);
if (cfg.calibrationsError) log('warn', cfg.calibrationsError);
log('info', `Tank calibration tables loaded for ${Object.keys(cfg.calibrations || {}).length} vehicles`);
if (!cfg.apiKey) log('warn', 'No GPS API key (set GPS_API_KEY, or put {"apiKey": "..."} in config.local.json) - the GPS server cannot be polled.');

process.on('uncaughtException', (e) => log('error', 'Unexpected error (continuing):', e));
process.on('unhandledRejection', (e) => log('error', 'Unhandled promise rejection (continuing):', e));

let db;
try {
  db = openDb(cfg.dataDir);
} catch (e) {
  log('error', `Cannot open the database in ${cfg.dataDir}:`, e);
  process.exit(1);
}

const displayHost = ['0.0.0.0', '::', ''].includes(cfg.host) ? '127.0.0.1' : cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host;
const dashboardUrl = `http://${displayHost}:${cfg.port}/`;

const hub = new SseHub();
const engine = new Engine({ cfg, db, hub });
const notifier = new Notifier({
  getSettings: () => engine.notifySettings(),
  isMuted: (imei) => engine.isMuted(imei),
  dashboardUrl,
  timezone: cfg.timezone,
});
engine.notifier = notifier;
// Excel fuel ledger: refuels and suspected thefts, rewritten from the database on changes
const ledger = new Ledger({ cfg, engine, db });
engine.ledger = ledger;

await engine.loadDetector();
engine.loadVehiclesFromDb();
engine.replay();

const api = createApi(cfg);
const poller = new Poller({ cfg, api, engine, db, hub });
ledger.onStatus = () => poller.broadcastStatus();
ledger.start();
const server = http.createServer(createHandler({ cfg, engine, poller, notifier, hub, ledger }));
server.keepAliveTimeout = 65000;

function openBrowser(url) {
  if (process.platform !== 'win32') return;
  try {
    spawn('explorer.exe', [url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (e) {
    log('warn', 'Could not open the browser:', e.message);
  }
}

let shuttingDown = false;
async function shutdown(code = 0, why = '') {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', `Shutting down${why ? ` (${why})` : ''}...`);
  try {
    await poller.stop();
    notifier.close();
    hub.close();
    server.close();
    server.closeAllConnections?.();
  } catch (e) {
    log('error', 'Error while stopping:', e);
  }
  try {
    engine.saveLearned();
  } catch (e) {
    log('error', 'Saving learned detector state failed:', e);
  }
  try {
    await ledger.stop(); // writes the Excel file once more if changes were still waiting
  } catch (e) {
    log('error', 'Saving the Excel fuel ledger failed:', e);
  }
  try {
    db.close();
  } catch {
    /* already closed */
  }
  log('info', 'Stopped.');
  process.exit(code);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  try {
    process.on(sig, () => shutdown(0, sig));
  } catch {
    /* signal not supported on this platform */
  }
}

// lets a parent process (tests, service wrappers) ask for a clean stop over IPC
process.on('message', (m) => {
  if (m === 'shutdown') shutdown(0, 'shutdown message');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log('error', `Port ${cfg.port} is already in use. Is Fuel Tank Warner already running? Open ${dashboardUrl}`);
    if (cfg.openBrowser) openBrowser(dashboardUrl);
    shutdown(1, 'port in use');
  } else {
    log('error', 'HTTP server error:', e);
  }
});

server.listen(cfg.port, cfg.host, () => {
  log('info', `Dashboard: ${dashboardUrl}`);
  poller.start();
  if (cfg.openBrowser) setTimeout(() => openBrowser(dashboardUrl), 800);
});
