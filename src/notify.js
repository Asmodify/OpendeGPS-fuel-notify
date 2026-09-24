// Push notifications for live alerts: Windows desktop toast.
// (The dashboard itself is updated over SSE, see sse.js, and shows its own browser
// notification + sound while it is open.)
//
// - Only severities listed in notify.severities are pushed (default critical + warning).
// - Muted vehicles are never pushed.
// - Same vehicle + alert type is pushed at most once per notify.throttleMinutes (default 10).
// - Alerts arriving close together are batched into one toast.
import { spawn } from 'node:child_process';
import { log, errText, fmtLocal } from './util.js';

// PowerShell AppUserModelID that can show toasts on Windows 10/11 without registering an app.
const TOAST_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

// Fixed script. All text arrives base64(JSON) in the FTW_TOAST environment variable and is
// inserted as XML text nodes, so vehicle names / alert text can never inject commands or markup.
const TOAST_SCRIPT = `
$ErrorActionPreference = 'Stop'
$d = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:FTW_TOAST)) | ConvertFrom-Json
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml('<toast><visual><binding template="ToastGeneric"><text/><text/></binding></visual></toast>')
$root = $x.DocumentElement
if ($d.url) { $root.SetAttribute('launch', [string]$d.url); $root.SetAttribute('activationType', 'protocol') }
if ($d.long) { $root.SetAttribute('duration', 'long') }
$t = $x.GetElementsByTagName('text')
[void]$t.Item(0).AppendChild($x.CreateTextNode([string]$d.title))
[void]$t.Item(1).AppendChild($x.CreateTextNode([string]$d.body))
$a = $x.CreateElement('audio')
$a.SetAttribute('src', [string]$d.sound)
[void]$root.AppendChild($a)
$n = [Windows.UI.Notifications.ToastNotification]::new($x)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier([string]$d.appId).Show($n)
`;
const TOAST_ENCODED = Buffer.from(TOAST_SCRIPT, 'utf16le').toString('base64');

const SEV_LABEL = { critical: 'CRITICAL', warning: 'WARNING', info: 'INFO' };
const SEV_RANK = { critical: 0, warning: 1, info: 2 };

function channelStatus() {
  return { sent: 0, lastOkAt: null, lastError: null, lastErrorAt: null };
}

export class Notifier {
  /**
   * @param {object} o
   * @param {() => {windowsToast:boolean, severities:string[], throttleMinutes:number}} o.getSettings
   * @param {(imei:string) => boolean} o.isMuted
   * @param {string} o.dashboardUrl
   * @param {string} o.timezone
   */
  constructor({ getSettings, isMuted, dashboardUrl, timezone }) {
    this.getSettings = getSettings;
    this.isMuted = isMuted;
    this.dashboardUrl = dashboardUrl;
    this.timezone = timezone;
    this.pending = [];
    this.flushTimer = null;
    this.firstPendingAt = 0;
    this.lastSent = new Map(); // `${imei}:${type}` -> ms
    this.toastChain = Promise.resolve();
    this.status = { toast: channelStatus(), throttled: 0, muted: 0 };
    this.closed = false;
  }

  /** Queue a live alert (alert view object: id, imei, shortName, type, severity, title, detail, t, lat, lng, group). */
  enqueue(alert) {
    if (this.closed) return;
    const s = this.getSettings();
    const sevs = Array.isArray(s.severities) ? s.severities : ['critical', 'warning'];
    if (!sevs.includes(alert.severity)) return;
    if (alert.imei && this.isMuted(alert.imei)) {
      this.status.muted++;
      return;
    }
    const key = `${alert.imei}:${alert.type}`;
    const now = Date.now();
    const throttleMs = Math.max(0, Number(s.throttleMinutes ?? 10)) * 60000;
    const last = this.lastSent.get(key);
    if (last && now - last < throttleMs) {
      this.status.throttled++;
      return;
    }
    this.lastSent.set(key, now);
    if (this.lastSent.size > 5000) {
      for (const [k, v] of this.lastSent) if (now - v > throttleMs) this.lastSent.delete(k);
    }
    this.pending.push(alert);
    if (!this.firstPendingAt) this.firstPendingAt = now;
    // debounce 2 s so simultaneous alerts become one notification, but never wait > 6 s
    clearTimeout(this.flushTimer);
    const wait = Math.max(0, Math.min(2000, this.firstPendingAt + 6000 - now));
    this.flushTimer = setTimeout(() => this.flush(), wait);
  }

  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.firstPendingAt = 0;
    const batch = this.pending.splice(0);
    if (!batch.length) return;
    batch.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.t - b.t);
    const s = this.getSettings();
    if (s.windowsToast && process.platform === 'win32') {
      this.showToast(this.toastPayload(batch)).catch(() => {});
    }
  }

  // ---- formatting ----------------------------------------------------------------
  toastPayload(batch) {
    const crit = batch.filter((a) => a.severity === 'critical').length;
    let title;
    let body;
    if (batch.length === 1) {
      const a = batch[0];
      title = `${SEV_LABEL[a.severity] || ''} ${a.shortName || a.name || a.imei}: ${a.title}`.trim();
      body = a.detail || '';
    } else {
      title = `${batch.length} new alerts${crit ? ` (${crit} critical)` : ''}`;
      const lines = batch.slice(0, 5).map((a) => `${a.shortName || a.name || a.imei}: ${a.title}`);
      if (batch.length > 5) lines.push(`... and ${batch.length - 5} more`);
      body = lines.join('\n');
    }
    return {
      title: title.slice(0, 200),
      body: body.slice(0, 600),
      url: this.dashboardUrl,
      long: crit > 0,
      sound: crit > 0 ? 'ms-winsoundevent:Notification.Reminder' : 'ms-winsoundevent:Notification.Default',
      appId: TOAST_APP_ID,
    };
  }

  // ---- channels ------------------------------------------------------------------
  /** Serialised so several toasts never start PowerShell at the same time. */
  showToast(payload) {
    const run = () => this.spawnToast(payload).then((r) => {
      const st = this.status.toast;
      if (r.ok) {
        st.sent++;
        st.lastOkAt = Date.now();
      } else {
        st.lastError = r.error;
        st.lastErrorAt = Date.now();
        log('warn', 'Windows toast failed:', r.error);
      }
      return r;
    });
    const p = this.toastChain.then(run, run);
    this.toastChain = p.catch(() => {});
    return p;
  }

  spawnToast(payload) {
    return new Promise((resolve) => {
      if (process.platform !== 'win32') {
        resolve({ ok: false, error: 'Windows toasts are only available on Windows' });
        return;
      }
      let done = false;
      let timer = null;
      const finish = (r) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      let stderr = '';
      let child;
      const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
      try {
        child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', TOAST_ENCODED], {
          env: { ...process.env, FTW_TOAST: data },
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      } catch (e) {
        finish({ ok: false, error: errText(e) });
        return;
      }
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        finish({ ok: false, error: 'powershell did not finish within 30 s' });
      }, 30000);
      child.stderr.on('data', (d) => {
        if (stderr.length < 4000) stderr += d.toString();
      });
      child.on('error', (e) => finish({ ok: false, error: errText(e) }));
      child.on('close', (code) => {
        if (code === 0) finish({ ok: true });
        else {
          const msg = stderr.replace(/#< CLIXML[\s\S]*$/, '').replace(/\s+/g, ' ').trim().slice(0, 300);
          finish({ ok: false, error: `powershell exited with code ${code}${msg ? ': ' + msg : ''}` });
        }
      });
    });
  }

  /** POST /api/test-notification: send a test through every enabled channel now. */
  async test() {
    const s = this.getSettings();
    const now = Date.now();
    const sample = {
      id: 0, imei: '', shortName: 'Test', name: 'Test', type: 'test', severity: 'warning', t: now,
      title: 'Test notification', detail: `Fuel Tank Warner notifications are working (${fmtLocal(now, this.timezone)}).`,
    };
    const out = {};
    if (process.platform !== 'win32') out.windowsToast = { ok: false, skipped: true, error: 'not running on Windows' };
    else if (!s.windowsToast) out.windowsToast = { ok: false, skipped: true, error: 'Windows notifications are turned off in settings' };
    else out.windowsToast = await this.showToast(this.toastPayload([sample]));
    out.ok = Boolean(out.windowsToast.ok);
    out.sent = out.windowsToast.ok ? ['Windows notification'] : [];
    out.error = out.windowsToast.ok ? null : out.windowsToast.skipped ? 'Windows notifications are not available (turned off in settings, or not running on Windows).' : out.windowsToast.error;
    return out;
  }

  close() {
    this.closed = true;
    clearTimeout(this.flushTimer);
  }
}
