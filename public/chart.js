// Fuel chart: hand-written SVG. Two panels sharing one time axis (no dual y-axes):
//   1. Fuel: raw readings (faint line), trusted settled levels (bold line + dots), alert markers,
//      shaded periods where the sensor gave no valid reading while powered.
//   2. Activity band: speed area, engine (ignition) strip, tracker power strip.
// Crosshair tooltip on hover/tap, drag (mouse) to zoom, double-click to reset.
import { fmtFull, fmtDayShort, fmtClock, fmtNum, mvToPct, isNum, fuelAmount } from './util.js';

let uidSeq = 0;
const MIN = 60e3, HOUR = 3600e3, DAY = 864e5;

function bisect(arr, t) {
  // index of first element with arr[i][0] >= t
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid][0] < t) lo = mid + 1; else hi = mid; }
  return lo;
}
const r1 = (v) => Math.round(v * 10) / 10;

function niceStep(span, target) {
  const raw = span / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}

function timeTicks(v0, v1, plotW) {
  const steps = [10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY];
  const target = Math.max(2, Math.floor(plotW / 78));
  const span = v1 - v0;
  const step = steps.find((s) => span / s <= target) || 2 * DAY;
  const d = new Date(v0);
  if (step >= DAY) {
    d.setHours(0, 0, 0, 0);
  } else if (step >= HOUR) {
    d.setMinutes(0, 0, 0);
    const sh = step / HOUR;
    d.setHours(Math.floor(d.getHours() / sh) * sh);
  } else {
    const sm = step / MIN;
    d.setSeconds(0, 0);
    d.setMinutes(Math.floor(d.getMinutes() / sm) * sm);
  }
  const out = [];
  let t = d.getTime();
  let guard = 0;
  while (t <= v1 && guard++ < 500) {
    if (t >= v0) {
      const dt = new Date(t);
      const midnight = dt.getHours() === 0 && dt.getMinutes() === 0;
      out.push({ t, label: midnight ? fmtDayShort(t) : fmtClock(t), major: midnight });
    }
    if (step >= DAY) { const n = new Date(t); n.setDate(n.getDate() + step / DAY); t = n.getTime(); } else t += step;
  }
  return out;
}

/** Runs of consecutive samples satisfying pred → [[t0, t1], ...]; runs break at data gaps. */
function runs(samples, pred, gapMs, i0, i1) {
  const out = [];
  let start = null, lastT = null;
  for (let i = i0; i < i1; i++) {
    const s = samples[i];
    const ok = pred(s);
    const gap = lastT !== null && s[0] - lastT > gapMs;
    if (start !== null && (!ok || gap)) { out.push([start, gap ? lastT : s[0]]); start = null; }
    if (ok && start === null) start = s[0];
    lastT = s[0];
  }
  if (start !== null && lastT !== null) out.push([start, lastT]);
  return out;
}

export class FuelChart {
  constructor(host, opts = {}) {
    this.host = host;
    this.opts = opts;
    this.uid = 'fc' + ++uidSeq;
    this.d = null;
    this.view = null;
    host.classList.add('fchart');
    host.innerHTML = '';
    this.wrap = document.createElement('div');
    this.wrap.className = 'fchart-svg';
    this.tip = document.createElement('div');
    this.tip.className = 'chart-tip';
    this.tip.hidden = true;
    this.tip.setAttribute('role', 'status');
    host.append(this.wrap, this.tip);
    this.lastW = 0;
    this.ro = new ResizeObserver(() => {
      const w = Math.floor(host.clientWidth);
      if (w && w !== this.lastW) this.render();
    });
    this.ro.observe(host);
  }

  destroy() {
    this.ro.disconnect();
    this.host.innerHTML = '';
  }

  /** d: { samples:[[t,f,spd,ign,pwr]], levels:[[t,mv]], alerts:[], from, to, cal, th, typeLabel(type) } */
  setData(d, { keepView = false } = {}) {
    const prevView = this.view;
    const wasZoomed = !!this.d && this.isZoomed();
    const samples = (d.samples || []).filter((s) => Array.isArray(s) && isNum(s[0])).map((s) => [Number(s[0]), isNum(s[1]) ? Number(s[1]) : null, isNum(s[2]) ? Number(s[2]) : null, isNum(s[3]) ? Number(s[3]) : null, isNum(s[4]) ? Number(s[4]) : null]);
    samples.sort((a, b) => a[0] - b[0]);
    const levels = (d.levels || []).filter((l) => Array.isArray(l) && isNum(l[0]) && isNum(l[1])).map((l) => [Number(l[0]), Number(l[1])]).sort((a, b) => a[0] - b[0]);
    // typical sample interval → gap threshold
    let gapMs = 15 * MIN;
    if (samples.length > 10) {
      const diffs = [];
      for (let i = 1; i < samples.length; i += Math.max(1, Math.floor(samples.length / 400))) diffs.push(samples[i][0] - samples[i - 1][0]);
      diffs.sort((a, b) => a - b);
      gapMs = Math.max(15 * MIN, diffs[Math.floor(diffs.length / 2)] * 8);
    }
    this.d = { ...d, samples, levels, gapMs, alerts: (d.alerts || []).filter((a) => isNum(a.t)) };
    if (keepView && wasZoomed && prevView) {
      const a = Math.max(d.from, prevView[0]), b = Math.min(d.to, prevView[1]);
      this.view = b - a > 60e3 ? [a, b] : [d.from, d.to];
    } else this.view = [d.from, d.to];
    this.render();
  }

  /** Replace the alert markers without touching data or zoom. */
  setAlerts(alerts) {
    if (!this.d) return;
    this.d.alerts = (alerts || []).filter((a) => isNum(a.t));
    this.render();
  }

  isZoomed() { return !!this.d && (this.view[0] > this.d.from || this.view[1] < this.d.to); }

  zoomTo(t0, t1) {
    if (!this.d) return;
    const { from, to } = this.d;
    let a = Math.max(from, Math.min(t0, t1)), b = Math.min(to, Math.max(t0, t1));
    const minSpan = 20 * MIN;
    if (b - a < minSpan) { const c = (a + b) / 2; a = Math.max(from, c - minSpan / 2); b = Math.min(to, a + minSpan); }
    this.view = [a, b];
    this.render();
    this.opts.onZoomChange?.(this.isZoomed());
  }

  /** Centre on a moment with a window of `span` ms (used when opening from an alert). */
  focus(t, span = 6 * HOUR) {
    // a moment outside the loaded period (e.g. an alert older than the kept history) would
    // otherwise clamp to an empty 20-minute window at the edge
    if (!this.d || t + span / 2 < this.d.from || t - span / 2 > this.d.to) return;
    this.zoomTo(t - span / 2, t + span / 2);
  }

  resetZoom() {
    if (!this.d) return;
    this.view = [this.d.from, this.d.to];
    this.render();
    this.opts.onZoomChange?.(false);
  }

  unit() {
    const cal = this.d.cal;
    if (cal.tankLiters) return { name: 'L', of: (mv) => (mvToPct(mv, cal) / 100) * cal.tankLiters, max: cal.tankLiters };
    return { name: '%', of: (mv) => mvToPct(mv, cal), max: 100 };
  }

  render() {
    const host = this.host;
    const W = Math.max(280, Math.floor(host.clientWidth || 600));
    this.lastW = W;
    this.tip.hidden = true;
    if (!this.d) { this.wrap.innerHTML = ''; return; }
    const d = this.d;
    const narrow = W < 520;
    const mL = narrow ? 40 : 48, mR = narrow ? 8 : 14;
    const topRow = 20; // alert markers
    const fuelH = narrow ? 170 : 230;
    const fy0 = topRow, fy1 = topRow + fuelH;
    const gap = 16;
    const spH = 34, stripH = 7, stripGap = 4;
    const sy0 = fy1 + gap, sy1 = sy0 + spH;
    const iy0 = sy1 + stripGap, iy1 = iy0 + stripH;
    const py0 = iy1 + stripGap, py1 = py0 + stripH;
    const axisY = py1 + 4;
    const H = axisY + 20;
    const plotW = W - mL - mR;
    const [v0, v1] = this.view;
    const sx = (t) => mL + ((t - v0) / (v1 - v0)) * plotW;
    const u = this.unit();
    const th = d.th || {};
    const sensorMin = isNum(th.sensorMinValidMv) ? Number(th.sensorMinValidMv) : 100;
    const powerCut = isNum(th.powerCutMv) ? Number(th.powerCutMv) : 5000;

    const S = d.samples;
    const i0 = Math.max(0, bisect(S, v0) - 1);
    const i1 = Math.min(S.length, bisect(S, v1) + 1);
    const L = d.levels;
    const l0 = Math.max(0, bisect(L, v0) - 1);
    const l1 = Math.min(L.length, bisect(L, v1) + 1);

    // y domain for the fuel panel
    let vmax = u.max;
    for (let i = l0; i < l1; i++) vmax = Math.max(vmax, u.of(L[i][1]));
    // raw readings may slosh above full; allow some headroom but cap it
    let rawMax = 0;
    for (let i = i0; i < i1; i++) { const f = S[i][1]; if (f !== null && f >= sensorMin) rawMax = Math.max(rawMax, u.of(f)); }
    vmax = Math.min(Math.max(vmax, rawMax), u.max * 1.3);
    const yStep = niceStep(vmax, narrow ? 4 : 5);
    vmax = Math.ceil(vmax / yStep - 1e-9) * yStep;
    const fy = (v) => fy1 - (Math.max(0, v) / vmax) * (fuelH);

    let maxSpd = 0;
    for (let i = i0; i < i1; i++) if (S[i][2] !== null) maxSpd = Math.max(maxSpd, S[i][2]);
    const spMax = Math.max(100, Math.ceil(maxSpd / 20) * 20);
    const spy = (v) => sy1 - (Math.max(0, v) / spMax) * spH;

    const parts = [];
    const uid = this.uid;
    parts.push(`<defs>
      <clipPath id="${uid}-clip"><rect x="${mL}" y="${fy0 - 2}" width="${plotW}" height="${fuelH + 4}"/></clipPath>
      <clipPath id="${uid}-clipb"><rect x="${mL}" y="${sy0 - 2}" width="${plotW}" height="${py1 - sy0 + 4}"/></clipPath>
      <pattern id="${uid}-hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" class="c-hatch"/></pattern>
      <pattern id="${uid}-hatch2" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(135)"><line x1="0" y1="0" x2="0" y2="5" class="c-hatch2"/></pattern>
    </defs>`);

    // y grid + labels
    for (let v = 0; v <= vmax + 1e-9; v += yStep) {
      const y = r1(fy(v));
      parts.push(`<line class="${v === 0 ? 'c-base' : 'c-grid'}" x1="${mL}" x2="${W - mR}" y1="${y}" y2="${y}"/>`);
      parts.push(`<text class="c-ylab" x="${mL - 6}" y="${y + 3.5}" text-anchor="end">${fmtNum(v, yStep < 1 ? 1 : 0)}${v === vmax ? (u.name === '%' ? '%' : ' L') : ''}</text>`);
    }
    // x grid + labels
    const ticks = timeTicks(v0, v1, plotW);
    for (const tk of ticks) {
      const x = r1(sx(tk.t));
      parts.push(`<line class="c-vgrid${tk.major ? ' major' : ''}" x1="${x}" x2="${x}" y1="${fy0}" y2="${py1}"/>`);
      parts.push(`<text class="c-xlab${tk.major ? ' major' : ''}" x="${x}" y="${axisY + 12}" text-anchor="middle">${tk.label}</text>`);
    }
    // strip labels
    parts.push(`<text class="c-slab" x="${mL - 6}" y="${sy0 + 10}" text-anchor="end">km/h</text>`);
    parts.push(`<text class="c-slab" x="${mL - 6}" y="${iy1}" text-anchor="end">Engine</text>`);
    parts.push(`<text class="c-slab" x="${mL - 6}" y="${py1}" text-anchor="end">Power</text>`);
    parts.push(`<rect class="c-strip-bg" x="${mL}" y="${iy0}" width="${plotW}" height="${stripH}" rx="2"/>`);
    parts.push(`<rect class="c-strip-bg" x="${mL}" y="${py0}" width="${plotW}" height="${stripH}" rx="2"/>`);

    const empty = i1 - i0 <= 0 && l1 - l0 <= 0;
    const noFuel = d.hasFuel === false;
    if (empty || noFuel) {
      const msg = empty ? 'No data from this vehicle in this period' : 'This vehicle has no fuel sensor — only driving activity is shown';
      parts.push(`<text class="c-empty" x="${mL + plotW / 2}" y="${(fy0 + fy1) / 2}" text-anchor="middle">${msg}</text>`);
    }

    const gapMs = d.gapMs;
    // Shaded: no valid fuel reading although powered (sensor problem)
    const bandParts = [];
    const nosig = noFuel ? [] : runs(S, (s) => (s[1] === null || s[1] < sensorMin) && (s[4] === null || s[4] >= powerCut), gapMs, i0, i1);
    for (const [a, b] of nosig) {
      const x0 = sx(a), x1 = Math.max(sx(b), x0 + 1.5);
      bandParts.push(`<rect class="c-nosig" x="${r1(x0)}" y="${fy0}" width="${r1(x1 - x0)}" height="${fuelH}" fill="url(#${uid}-hatch)"/>`);
    }
    // Spans for drain/refuel alerts (fromT → t)
    for (const a of d.alerts) {
      if (!isNum(a.fromT) || !(a.type === 'fuel_drain' || a.type === 'refuel')) continue;
      const fa = Number(a.fromT), ta = Number(a.t);
      if (ta < v0 || fa > v1 || ta <= fa) continue;
      const x0 = sx(Math.max(v0, fa)), x1 = sx(Math.min(v1, ta));
      bandParts.push(`<rect class="c-span ${a.type === 'refuel' ? 'refuel' : 'drain'}" x="${r1(x0)}" y="${fy0}" width="${r1(Math.max(2, x1 - x0))}" height="${fuelH}"/>`);
    }
    parts.push(`<g clip-path="url(#${uid}-clip)">${bandParts.join('')}`);

    // Raw readings: faint line, broken at invalid readings and data gaps
    let rawPath = '';
    let prevT = null, pen = false;
    for (let i = i0; i < i1; i++) {
      const s = S[i];
      const valid = s[1] !== null && s[1] >= sensorMin && (s[4] === null || s[4] >= powerCut);
      if (!valid || (prevT !== null && s[0] - prevT > gapMs)) pen = false;
      if (valid) {
        rawPath += `${pen ? 'L' : 'M'}${r1(sx(s[0]))} ${r1(fy(u.of(s[1])))}`;
        pen = true;
      }
      prevT = s[0];
    }
    if (rawPath) parts.push(`<path class="c-raw" d="${rawPath}"/>`);

    // Trusted levels
    let lvPath = '';
    const dots = [];
    const nVis = l1 - l0;
    for (let i = l0; i < l1; i++) {
      const [t, mv] = L[i];
      const x = r1(sx(t)), y = r1(fy(u.of(mv)));
      lvPath += `${i === l0 ? 'M' : 'L'}${x} ${y}`;
      if (t >= v0 && t <= v1) dots.push(`<circle class="c-level-dot${d.sensorOk === false ? ' fault' : ''}" cx="${x}" cy="${y}" r="${nVis > 120 ? 2 : 3.2}"/>`);
    }
    const fault = d.sensorOk === false; // stuck/faulty sensor: its "levels" are not reliable
    if (lvPath) parts.push(`<path class="c-level${fault ? ' fault' : ''}" d="${lvPath}"/>`);
    if (fault && !noFuel) parts.push(`<text class="c-fault" x="${mL + 8}" y="${fy0 + 16}">Sensor fault — readings not reliable</text>`);
    parts.push(dots.join(''));
    parts.push('</g>');

    // Activity band
    const b = [];
    let spPath = '';
    let segStart = null, lastX = null;
    prevT = null;
    for (let i = i0; i < i1; i++) {
      const s = S[i];
      if (s[2] === null) continue;
      const x = r1(sx(s[0])), y = r1(spy(s[2]));
      if (segStart !== null && prevT !== null && s[0] - prevT > gapMs) { spPath += `L${lastX} ${sy1}Z`; segStart = null; }
      if (segStart === null) { spPath += `M${x} ${sy1}L${x} ${y}`; segStart = x; } else spPath += `L${x} ${y}`;
      lastX = x; prevT = s[0];
    }
    if (segStart !== null) spPath += `L${lastX} ${sy1}Z`;
    b.push(`<line class="c-base" x1="${mL}" x2="${W - mR}" y1="${sy1}" y2="${sy1}"/>`);
    if (spPath) b.push(`<path class="c-speed" d="${spPath}"/>`);
    const ovs = Number(th.overspeedKmh);
    if (isNum(ovs) && ovs < spMax) b.push(`<line class="c-ovs" x1="${mL}" x2="${W - mR}" y1="${r1(spy(ovs))}" y2="${r1(spy(ovs))}"><title>Speed limit ${ovs} km/h</title></line>`);
    for (const [a, c] of runs(S, (s) => s[3] === 1, gapMs, i0, i1)) {
      const x0 = sx(a), x1 = Math.max(sx(c), x0 + 1.5);
      b.push(`<rect class="c-ign" x="${r1(x0)}" y="${iy0}" width="${r1(x1 - x0)}" height="${stripH}"/>`);
    }
    for (const [a, c] of runs(S, (s) => s[4] !== null && s[4] >= powerCut, gapMs, i0, i1)) {
      const x0 = sx(a), x1 = Math.max(sx(c), x0 + 1.5);
      b.push(`<rect class="c-pwr-on" x="${r1(x0)}" y="${py0}" width="${r1(x1 - x0)}" height="${stripH}"/>`);
    }
    for (const [a, c] of runs(S, (s) => s[4] !== null && s[4] < powerCut, gapMs, i0, i1)) {
      const x0 = sx(a), x1 = Math.max(sx(c), x0 + 1.5);
      b.push(`<rect class="c-pwr-off" x="${r1(x0)}" y="${py0}" width="${r1(x1 - x0)}" height="${stripH}" fill="url(#${uid}-hatch2)"/>`);
    }
    parts.push(`<g clip-path="url(#${uid}-clipb)">${b.join('')}</g>`);

    // Interaction overlay (below markers)
    parts.push(`<line class="c-cross" x1="0" x2="0" y1="${fy0}" y2="${py1}" visibility="hidden"/>`);
    parts.push(`<circle class="c-cross-raw" r="3.5" cx="0" cy="0" visibility="hidden"/>`);
    parts.push(`<circle class="c-cross-lv" r="5" cx="0" cy="0" visibility="hidden"/>`);
    parts.push(`<rect class="c-brush" x="0" y="${fy0}" width="0" height="${py1 - fy0}" visibility="hidden"/>`);
    parts.push(`<rect class="c-overlay" x="${mL}" y="${fy0}" width="${plotW}" height="${py1 - fy0}"/>`);

    // Alert markers
    const mk = [];
    const visAlerts = [];
    d.alerts.forEach((a, idx) => {
      const t = Number(a.t);
      if (t < v0 || t > v1) return;
      visAlerts.push(idx);
      const x = r1(sx(t));
      const sev = a.severity || 'info';
      const kind = a.type === 'fuel_drain' ? 'drain' : a.type === 'refuel' ? 'refuel' : sev;
      mk.push(`<line class="c-mk-line ${kind}" x1="${x}" x2="${x}" y1="${fy0 + 2}" y2="${fy1}"/>`);
      let shape;
      const y = 9;
      if (kind === 'drain') shape = `<path class="c-mk drain" d="M${x - 6} ${y - 5}L${x + 6} ${y - 5}L${x} ${y + 6}Z"/>`;
      else if (kind === 'refuel') shape = `<path class="c-mk refuel" d="M${x - 6} ${y + 5}L${x + 6} ${y + 5}L${x} ${y - 6}Z"/>`;
      else if (sev === 'critical') shape = `<path class="c-mk critical" d="M${x} ${y - 6}L${x + 6} ${y}L${x} ${y + 6}L${x - 6} ${y}Z"/>`;
      else shape = `<circle class="c-mk ${sev}" cx="${x}" cy="${y}" r="4.5"/>`;
      mk.push(`<g class="c-mk-g" data-i="${idx}" tabindex="0" role="button" aria-label="Alert">${shape}<circle class="c-hit" cx="${x}" cy="${y}" r="12"/></g>`);
    });
    parts.push(mk.join(''));

    const aria = `Fuel level chart, ${fmtFull(v0)} to ${fmtFull(v1)}. ${l1 - l0} trusted level readings, ${visAlerts.length} alerts.`;
    this.wrap.innerHTML = `<svg class="fchart-el" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="group" aria-label="${aria.replace(/"/g, '')}">${parts.join('')}</svg>`;
    const svg = this.wrap.firstChild;
    this.geo = { W, H, mL, mR, plotW, fy0, fy1, py1, sx, fy, u, v0, v1, i0, i1, sensorMin, powerCut };
    this.bind(svg);
  }

  bind(svg) {
    const g = this.geo;
    const cross = svg.querySelector('.c-cross');
    const crossRaw = svg.querySelector('.c-cross-raw');
    const crossLv = svg.querySelector('.c-cross-lv');
    const brush = svg.querySelector('.c-brush');
    const overlay = svg.querySelector('.c-overlay');
    const S = this.d.samples, L = this.d.levels;
    const xToT = (x) => g.v0 + ((x - g.mL) / g.plotW) * (g.v1 - g.v0);
    const localX = (ev) => {
      const r = svg.getBoundingClientRect();
      return Math.max(g.mL, Math.min(g.mL + g.plotW, ev.clientX - r.left));
    };
    const hide = () => {
      cross.setAttribute('visibility', 'hidden');
      crossRaw.setAttribute('visibility', 'hidden');
      crossLv.setAttribute('visibility', 'hidden');
      this.tip.hidden = true;
    };
    let brushStart = null;

    const showAt = (x) => {
      const t = xToT(x);
      let i = bisect(S, t);
      if (i >= S.length || (i > 0 && t - S[i - 1][0] < S[i][0] - t)) i--;
      const s = i >= 0 && i < S.length && Math.abs(S[i][0] - t) < this.d.gapMs ? S[i] : null;
      const tt = s ? s[0] : t;
      const cx = g.sx(tt);
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
      const rawValid = s && s[1] !== null && s[1] >= g.sensorMin && (s[4] === null || s[4] >= g.powerCut);
      if (rawValid) {
        crossRaw.setAttribute('cx', cx); crossRaw.setAttribute('cy', g.fy(g.u.of(s[1]))); crossRaw.setAttribute('visibility', 'visible');
      } else crossRaw.setAttribute('visibility', 'hidden');
      // trusted level: last one at or before tt
      const li = bisect(L, tt + 1) - 1;
      const lv = li >= 0 ? L[li] : null;
      if (lv && lv[0] >= g.v0) {
        crossLv.setAttribute('cx', g.sx(lv[0])); crossLv.setAttribute('cy', g.fy(g.u.of(lv[1]))); crossLv.setAttribute('visibility', 'visible');
      } else crossLv.setAttribute('visibility', 'hidden');

      const rows = [];
      const fmtU = (mv) => `${fmtNum(g.u.of(mv), g.u.name === 'L' ? 0 : 1)}${g.u.name === 'L' ? ' L' : '%'}`;
      rows.push(['time', fmtFull(tt)]);
      if (lv) rows.push(['Trusted level', `${fmtU(lv[1])}`, `measured ${fmtClock(lv[0])}${new Date(lv[0]).toDateString() !== new Date(tt).toDateString() ? ' ' + fmtDayShort(lv[0]) : ''} · ${fmtNum(lv[1])} mV`, 'lv']);
      if (s) {
        if (rawValid) rows.push(['Raw reading', fmtU(s[1]), `${fmtNum(s[1])} mV${s[2] > 3 ? ' · moving, unreliable' : ''}`, 'raw']);
        else if (s[4] !== null && s[4] < g.powerCut) rows.push(['Raw reading', 'Power off', s[1] !== null ? `${fmtNum(s[1])} mV` : '', 'raw']);
        else rows.push(['Raw reading', 'No valid reading', s[1] !== null ? `${fmtNum(s[1])} mV` : '', 'raw']);
        rows.push(['Speed', s[2] !== null ? `${fmtNum(s[2])} km/h` : '—']);
        rows.push(['Engine', s[3] === 1 ? 'On' : s[3] === 0 ? 'Off' : '—']);
        rows.push(['Power', s[4] !== null ? `${fmtNum(s[4] / 1000, 1)} V` : '—']);
      } else rows.push(['', 'No data at this time']);
      this.fillTip(rows);
      this.placeTip(cx);
    };

    const noData = !S.length && !L.length;
    overlay.addEventListener('pointermove', (ev) => {
      if (noData) return;
      const x = localX(ev);
      if (brushStart !== null) {
        const a = Math.min(brushStart, x), b = Math.max(brushStart, x);
        brush.setAttribute('x', a); brush.setAttribute('width', b - a); brush.setAttribute('visibility', 'visible');
        this.tip.hidden = true;
        return;
      }
      showAt(x);
    });
    overlay.addEventListener('pointerleave', () => { if (brushStart === null) hide(); });
    overlay.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'mouse' && ev.button === 0) {
        brushStart = localX(ev);
        overlay.setPointerCapture(ev.pointerId);
      } else if (ev.pointerType !== 'mouse' && !noData) {
        showAt(localX(ev));
      }
    });
    const endBrush = (ev) => {
      if (brushStart === null) return;
      const x = localX(ev);
      const a = Math.min(brushStart, x), b = Math.max(brushStart, x);
      brushStart = null;
      brush.setAttribute('visibility', 'hidden');
      if (b - a > 10) this.zoomTo(xToT(a), xToT(b));
    };
    overlay.addEventListener('pointerup', endBrush);
    overlay.addEventListener('pointercancel', () => { brushStart = null; brush.setAttribute('visibility', 'hidden'); hide(); });
    overlay.addEventListener('dblclick', () => this.resetZoom());

    svg.querySelectorAll('.c-mk-g').forEach((el) => {
      const a = this.d.alerts[Number(el.dataset.i)];
      if (!a) return;
      const show = () => {
        hide();
        const amt = fuelAmount(a.amountMv, this.d.cal, a.amountL);
        const rows = [['time', fmtFull(a.t)], ['alert', a.title || (this.d.typeLabel ? this.d.typeLabel(a.type) : a.type), '', a.severity]];
        if (amt) rows.push([a.type === 'refuel' ? 'Added' : 'Amount', amt.main, amt.sub]);
        if (a.detail) rows.push(['', String(a.detail).slice(0, 220)]);
        this.fillTip(rows);
        this.placeTip(g.sx(Number(a.t)));
      };
      el.setAttribute('aria-label', `${a.title || a.type}, ${fmtFull(a.t)}`);
      el.addEventListener('pointerenter', show);
      el.addEventListener('focus', show);
      el.addEventListener('pointerleave', hide);
      el.addEventListener('blur', hide);
      el.addEventListener('click', () => this.opts.onAlertClick?.(a));
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.opts.onAlertClick?.(a); } });
    });
  }

  fillTip(rows) {
    const tip = this.tip;
    tip.textContent = '';
    for (const [label, value, sub, kind] of rows) {
      const row = document.createElement('div');
      if (label === 'time') {
        row.className = 'tt-time';
        row.textContent = value;
      } else if (label === 'alert') {
        row.className = `tt-alert sev-${kind}`;
        row.textContent = value;
      } else {
        row.className = 'tt-row' + (kind ? ` tt-${kind}` : '');
        if (kind === 'lv' || kind === 'raw') {
          const key = document.createElement('i');
          key.className = 'tt-key';
          row.append(key);
        }
        const v = document.createElement('b');
        v.textContent = value;
        row.append(v);
        if (label) { const l = document.createElement('span'); l.textContent = label; row.append(l); }
        if (sub) { const s = document.createElement('small'); s.textContent = sub; row.append(s); }
      }
      tip.append(row);
    }
    tip.hidden = false;
  }

  placeTip(x) {
    const tip = this.tip;
    const W = this.geo.W;
    const tw = tip.offsetWidth || 200;
    let left = x + 14;
    if (left + tw > W - 4) left = x - tw - 14;
    if (left < 4) left = 4;
    tip.style.left = `${left}px`;
    tip.style.top = `${this.geo.fy0 + 6}px`;
  }
}
