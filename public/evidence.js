// Evidence pack: printable pages for theft alerts, opened from the dashboard's "Нотлох баримт"
// view (or an alert's "Нотлох баримт" button) as evidence.html#ids=12,15,40.
// The first page sums them up (per truck, then every incident in one table); after it comes one
// A4 page per incident: the facts, the fuel chart around it (the thick orange line is the fuel
// meter's own readings while the truck stood still and the fuel had settled, the thin one every
// reading as the tracker sent it), the track on a map, the fuel receipts of those days and lines
// to sign. Only litres the meter itself shows beyond what the truck could have burnt are counted:
// an incident where the meter went up (a refuel), dipped and came back, fell by no more than the
// engine could burn, or the sensor is broken, and one a person marked a false alarm, is marked
// "not evidence" and left out of the totals; two incidents of one truck over the same time count
// once. The browser's print dialog turns it into paper or a PDF.
import { html, setHTML, $, $$, fmtNum, fmtDur, isNum, normCal, api, METER_LABEL, meterConfirms } from './util.js';
import { FuelChart } from './chart.js';

const MAX_PAGES = 300;
const CONCURRENCY = 4;
const HOUR = 3600e3;
const TILE = 256;
const TILE_URL = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const VERDICTS = { unchecked: 'Шалгаагүй', confirmed: 'Хулгай батлагдсан', false_alarm: 'Худал дохио' };
const SEV_LABEL = { critical: 'Ноцтой', warning: 'Сэрэмжлүүлэг', info: 'Мэдээлэл' };
const RC_STATUS = {
  short: 'Түлш дутуу',
  norefuel: 'Цэнэглэлт бүртгэгдээгүй',
  ok: 'Таарсан',
  waiting: 'Мэдээлэл хүлээж байна',
  nodata: 'Тэр үед мэдээлэлгүй',
  nosensor: 'Түлшний мэдрэгчгүй',
};
const COMPANY = 'Опендевелопмент ХХК';

const ids = [...new Set((new URLSearchParams(location.hash.slice(1)).get('ids') || '').split(',').map(Number))]
  .filter((n) => Number.isSafeInteger(n) && n > 0)
  .slice(0, MAX_PAGES);
let types = {};
const typeLabel = (t) => types[t]?.label || { fuel_drain: 'Түлш алдагдал', receipt_mismatch: 'Баримтаас дутуу цэнэглэлт', refuel: 'Түлш цэнэглэлт' }[t] || t;
const L = (v, d = 0) => (isNum(v) ? `${fmtNum(Number(v), d)} л` : '—');
const valid = (lat, lng) => isNum(lat) && isNum(lng) && !(Number(lat) === 0 && Number(lng) === 0) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
const mapsUrl = (p) => `https://maps.google.com/?q=${Number(p.lat).toFixed(6)},${Number(p.lng).toFixed(6)}`;
const coord = (p) => `${Number(p.lat).toFixed(5)}, ${Number(p.lng).toFixed(5)}`;
const p2 = (n) => String(n).padStart(2, '0');
/** "2026.09.23 17:20" (local time): short enough for tables and the facts grid. */
const fmtShort = (ms, withTime = true) => {
  if (!isNum(ms)) return '—';
  const d = new Date(Number(ms));
  const day = `${d.getFullYear()}.${p2(d.getMonth() + 1)}.${p2(d.getDate())}`;
  return withTime ? `${day} ${p2(d.getHours())}:${p2(d.getMinutes())}` : day;
};
const plateOf = (e) => e.vehicle.shortName || e.vehicle.plate || e.vehicle.imei || '';
const lostOf = (e) => (isNum(e.lostL) ? Number(e.lostL) : null);
/** Counted as theft: the fuel meter shows the loss (no meter check: an older server, taken as
 *  shown) and no one has marked the alert a false alarm. */
const confirmed = (e) => e.alert.verdict !== 'false_alarm' && (!e.meter || meterConfirms(e.meter));
const meterLabel = (e) => (e.meter ? METER_LABEL[e.meter.verdict] || e.meter.verdict : '');
/** What the burn ceiling rests on: "12.4 км явсан, хөдөлгүүр 2 ц асаалттай зогссон, GPS 40 мин мэдээлэлгүй". */
function burnText(b) {
  if (!b) return '';
  const parts = [];
  if (b.km >= 0.5) parts.push(`${fmtNum(b.km, 1)} км явсан`);
  if (b.idleMs >= 5 * 60e3) parts.push(`хөдөлгүүр ${fmtDur(b.idleMs)} асаалттай зогссон`);
  if (b.silentMs >= 15 * 60e3) parts.push(`GPS ${fmtDur(b.silentMs)} мэдээлэлгүй${b.silentMovedMs >= 15 * 60e3 ? ', тэр хооронд өөр газар очсон' : ''}`);
  if (b.moveBias > 0) parts.push(`нэг заалтыг явж байхад уншсан: ${L(b.moveBias)} алдаа`);
  return parts.join(', ');
}
/** Why an incident is not counted, in one sentence. */
function whyNot(e) {
  if (e.alert.verdict === 'false_alarm') return 'Шалгасан хүн худал дохио гэж тэмдэглэсэн';
  const m = e.meter;
  if (!m) return '';
  if (m.verdict === 'burnt' && m.burn) {
    const how = burnText(m.burn);
    return `Тоолуур ${L(m.fell, 1)} буурсан ч ${how ? `${how}: ` : ''}шатаж болох дээд хэмжээ ${L(m.burn.total ?? m.burn.liters, 1)}-ээс хэтрээгүй тул нотолгоо биш`;
  }
  return meterLabel(e);
}
/** Confirmed drains of one truck over the same time are one theft the detector raised twice (a
 *  stop's drain inside a longer parked one): the larger stays, the other is marked as overlapping.
 *  Map of list index -> index of the one it overlaps. */
function overlaps(list) {
  const dup = new Map();
  const byTruck = new Map();
  list.forEach((e, i) => {
    if (!e || e.error || e.alert.type !== 'fuel_drain' || !confirmed(e)) return;
    const k = e.vehicle.imei || plateOf(e);
    if (!byTruck.has(k)) byTruck.set(k, []);
    byTruck.get(k).push(i);
  });
  for (const idx of byTruck.values()) {
    idx.sort((a, b) => (lostOf(list[b]) ?? 0) - (lostOf(list[a]) ?? 0) || a - b);
    const kept = [];
    for (const i of idx) {
      const e = list[i];
      const hit = kept.find((j) => list[j].eventFrom <= e.eventTo && e.eventFrom <= list[j].eventTo);
      if (hit !== undefined) dup.set(i, hit);
      else kept.push(i);
    }
  }
  return dup;
}

/** The litres the fuel fell by (before → after), when the alert knows both levels. */
function fellBy(e) {
  return isNum(e.before?.liters) && isNum(e.after?.liters) ? Number(e.before.liters) - Number(e.after.liters) : null;
}

// ---------------------------------------------------------------- loading
function setProgress(done, total, failed) {
  const el = $('#ev-progress');
  if (done < total) el.textContent = `Бэлтгэж байна… ${done} / ${total}`;
  else el.textContent = failed ? `${total - failed} хуудас бэлэн, ${failed} ачаалагдсангүй` : `${total} тохиолдол бэлэн`;
}

async function loadAll() {
  const out = new Array(ids.length).fill(null);
  let next = 0;
  let done = 0;
  let failed = 0;
  setProgress(0, ids.length, 0);
  const worker = async () => {
    while (next < ids.length) {
      const i = next++;
      try {
        out[i] = await api(`/api/alerts/${ids[i]}/evidence`, { timeout: 60000 });
      } catch (e) {
        out[i] = { error: e.message, id: ids[i], status: e.status };
        failed++;
      }
      done++;
      setProgress(done, ids.length, failed);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
  return out;
}

// ---------------------------------------------------------------- summary page
function summaryPage(list, now, dup) {
  const ok = list.filter((e) => e && !e.error);
  const counted = (e) => confirmed(e) && !dup.has(list.indexOf(e));
  const inTotal = ok.filter(counted);
  const total = inTotal.reduce((s, e) => s + (lostOf(e) ?? 0), 0);
  const left = ok.length - inTotal.length;
  const trucks = new Map();
  for (const e of ok) {
    const k = e.vehicle.imei;
    if (!trucks.has(k)) trucks.set(k, { name: plateOf(e), group: e.vehicle.group, n: 0, all: 0, litres: 0, first: null, last: null });
    const g = trucks.get(k);
    g.all++;
    if (counted(e)) { g.n++; g.litres += lostOf(e) ?? 0; }
    g.first = g.first === null ? e.eventFrom : Math.min(g.first, e.eventFrom);
    g.last = g.last === null ? e.eventTo : Math.max(g.last, e.eventTo);
  }
  const first = ok.length ? Math.min(...ok.map((e) => e.eventFrom)) : null;
  const last = ok.length ? Math.max(...ok.map((e) => e.eventTo)) : null;
  const truckList = [...trucks.values()].sort((a, b) => b.litres - a.litres);
  return html`<section class="page summary">
    ${pageHead('Түлшний хулгайн нотлох баримт', 'Нэгтгэл')}
    <div class="sum-meta">
      <div><span>Хамрах хугацаа</span><b>${first === null ? '—' : `${fmtShort(first, false)} — ${fmtShort(last, false)}`}</b></div>
      <div><span>Машин</span><b>${truckList.length === 1 ? truckList[0].name : `${truckList.length} машин`}</b></div>
      <div><span>Бэлтгэсэн</span><b>${fmtShort(now)}</b></div>
    </div>
    <div class="sum-tiles">
      <div class="sum-tile"><span>Хулгайд тооцсон</span><b>${inTotal.length}${left ? html`<small> / ${ok.length}</small>` : ''}</b></div>
      <div class="sum-tile bad"><span>Алдсан түлш</span><b>${L(total)}</b></div>
      <div class="sum-tile"><span>Машин</span><b>${truckList.length}</b></div>
    </div>
    ${truckList.length > 1 ? html`<h3>Машин тус бүрээр</h3>
    <table class="ev-tbl">
      <thead><tr><th>Машин</th><th>Бүлэг</th><th class="num">Тохиолдол</th><th class="num">Алдсан түлш</th><th>Эхний</th><th>Сүүлийн</th></tr></thead>
      <tbody>${truckList.map((g) => html`<tr><td><b>${g.name}</b></td><td>${g.group || '—'}</td><td class="num">${g.n}${g.all > g.n ? html`<small class="muted"> / ${g.all}</small>` : ''}</td><td class="num bad"><b>${L(g.litres)}</b></td><td class="nowrap">${fmtShort(g.first)}</td><td class="nowrap">${fmtShort(g.last)}</td></tr>`)}</tbody>
    </table>` : ''}
    <h3>Тохиолдлууд</h3>
    <table class="ev-tbl incidents">
      <thead><tr><th class="num">№</th><th>Машин</th><th>Эхэлсэн</th><th>Юу болсон</th><th class="num">Тоолуур: өмнө → дараа</th><th class="num">Алдсан</th><th>Байршил</th><th>Дүгнэлт</th></tr></thead>
      <tbody>${list.map((e, i) => (!e || e.error
    ? html`<tr><td class="num">${i + 1}</td><td colspan="7" class="muted">Анхааруулга #${ids[i]}: ачаалж чадсангүй${e?.error ? ` (${e.error})` : ''}</td></tr>`
    : html`<tr class="${counted(e) ? '' : 'not-ev'}"><td class="num">${i + 1}</td><td class="nowrap"><b>${plateOf(e)}</b></td><td class="nowrap">${fmtShort(e.eventFrom)}</td><td>${e.alert.title || typeLabel(e.alert.type)}${counted(e) ? '' : html`<small class="m-no">${dup.has(i) ? `№ ${dup.get(i) + 1}-тэй нэг хугацаанд: нэг удаа тооцсон` : whyNot(e)}</small>`}</td>
          <td class="num nowrap">${isNum(e.before?.liters) && isNum(e.after?.liters) ? `${L(e.before.liters)} → ${L(e.after.liters)}` : e.receipt ? `баримт ${L(e.receipt.litres)}` : '—'}</td>
          <td class="num bad nowrap"><b>${counted(e) ? L(lostOf(e)) : '—'}</b></td>
          <td class="nowrap">${e.place ? html`<a href="${mapsUrl(e.place)}" target="_blank" rel="noopener">${coord(e.place)}</a>` : '—'}</td>
          <td>${e.alert.type === 'fuel_drain' ? VERDICTS[e.alert.verdict] || '' : ''}</td></tr>`))}</tbody>
      <tfoot><tr><td></td><td colspan="4"><b>Нийт</b>${left ? html` <span class="muted">(хулгайд тооцоогүй ${left} тохиолдлыг оруулаагүй)</span>` : ''}</td><td class="num bad nowrap"><b>${L(total)}</b></td><td colspan="2"></td></tr></tfoot>
    </table>
    <div class="how">
      <h3>Хэрхэн уншихыг</h3>
      <p>Тохиолдол бүр дараагийн хуудсуудад нэг A4 хуудастай. Графикийн <i class="k-raw"></i><b>улбар шар шугам</b> нь түлшний тоолуурын (мэдрэгчийн) заалт, GPS төхөөрөмжөөс ирсэн тэр чигээрээ, дундажлаагүй. <i class="k-thin"></i>Нарийн шугам бүх заалт: машин явж байхад болон зогссоноос хойш 10 минутад түлш савлаж заалт үсэрдэг тул тэр хэсгийг нарийнаар зурсан, явсан хугацааг <i class="k-drive"></i>саарал бүсээр тэмдэглэсэн. <b>Бүдүүн шугам</b> нь зогсож, түлш нь тогтсон үеийн заалт: тооцоонд зөвхөн үүнийг авсан. <i class="k-drain"></i>Улаан бүс нь түлш алдагдсан хугацаа. Графикийн доор машины хурд (0 бол зогсож байсан), хөдөлгүүр асаалттай эсэх, тэжээлийн (масс) төлөв.</p>
      <p>“Өмнө”, “дараа” нь тохиолдлын өмнөх ба дараах тогтсон заалт. Машин 10 минут зогсдоггүй бол явж байхад тогтвортой байсан заалтыг авч, “явж байхад” гэж тэмдэглэсэн; тийм заалт зогссон үеийнхээс савны 5 хувиар зөрж болох тул тэр хэмжээг нэмж хассан. Тэр хооронд машин явсан, хөдөлгүүр асаалттай зогссон, эсвэл GPS мэдээлэлгүй байсан бол шатаж болох дээд хэмжээг хассан: явсан км тутамд 1.3 л (эсвэл явсан цагт 50 л, алинаас нь их нь), хөдөлгүүр асаалттай зогссон цагт 6 л, GPS мэдээлэлгүй байхад өөр газар очсон бол тэр цагт 100 л. Энэ нь дундаж хэрэглээ биш, хамгийн ихдээ шатах хэмжээ. “Алдсан” нь үүнээс илүү буурсан хэсэг; системийн тооцоо үүнээс бага бол бага нь. Шөнийн хүйтэнд түлш агшдаг тул түвшингийн 2.5 хувиас бага бууралтыг тооцохгүй. Тоолуур өссөн (цэнэглэлт), буураад 3 цагийн дотор буцаж өссөн, мэдрэгч гэмтсэн эсвэл зогсож байхад заалт нь дээш доош савласан, бууралт нь шатах дээд хэмжээнд багтсан, эсвэл шалгасан хүн худал дохио гэж тэмдэглэсэн тохиолдлыг хулгайд тооцохгүй, нийтэд оруулахгүй. Нэг машины нэг хугацааны хоёр тохиолдлыг нэг удаа тооцсон. Литрийг машины савны тохируулгын хүснэгтээр тооцсон. Мэдээллийг GPS төхөөрөмжөөс (fms.gpsbox.mn) авсан, өөрчлөөгүй.</p>
    </div>
    ${pageFoot()}
  </section>`;
}

function pageHead(title, right) {
  return html`<header class="ph">
    <div class="ph-brand"><img src="mark.svg" alt=""><div><b>${COMPANY}</b><small>GPS түлшний хяналт</small></div></div>
    <div class="ph-title"><h1>${title}</h1>${right ? html`<span>${right}</span>` : ''}</div>
  </header>`;
}
function pageFoot(extra = '') {
  return html`<footer class="pf"><span>${COMPANY} · GPS түлшний хяналт · fuel.opendevelopment.mn</span><span>${extra}</span></footer>`;
}

// ---------------------------------------------------------------- incident page
function incidentPage(e, i, n, dup) {
  if (!e || e.error) {
    return html`<section class="page incident">
      ${pageHead(`Нотлох баримт № ${i + 1}`, `${i + 1} / ${n}`)}
      <p class="missing">Анхааруулга #${ids[i]}-ийг ачаалж чадсангүй${e?.error ? `: ${e.error}` : ''}.</p>
      ${pageFoot(`Анхааруулга #${ids[i]}`)}
    </section>`;
  }
  const a = e.alert;
  const act = e.activity;
  const fell = fellBy(e);
  const lost = lostOf(e);
  const span = e.eventTo - e.eventFrom;
  const fact = (label, value, cls = '') => html`<div class="fact ${cls}"><span>${label}</span><b>${value}</b></div>`;
  const facts = [
    fact('Эхэлсэн', fmtShort(e.eventFrom)),
    fact(span > 60e3 ? 'Илэрсэн' : 'Огноо', fmtShort(e.eventTo)),
    span > 60e3 ? fact('Үргэлжилсэн', fmtDur(span)) : '',
  ];
  const m = e.meter;
  if (a.type === 'receipt_mismatch' && e.receipt) {
    const wentIn = isNum(m?.wentIn) ? m.wentIn : e.receipt.wentIn;
    facts.push(
      fact('Баримтад', L(e.receipt.litres, 1)),
      fact('Тоолуурт орсон', isNum(wentIn) && wentIn > 0 ? L(wentIn, 1) : 'Цэнэглэлт харагдаагүй'),
      isNum(e.before?.liters) ? fact('Тоолуур (цэнэглэхийн өмнө)', L(e.before.liters, 1)) : '',
      isNum(e.after?.liters) ? fact('Тоолуур (цэнэглэсний дараа)', L(e.after.liters, 1)) : '',
      isNum(e.receipt.room) ? fact('Саванд багтах байсан', L(e.receipt.room, 1)) : '',
    );
  } else {
    facts.push(
      fact(`Тоолуур (өмнө${e.before?.moving ? ', явж байхад' : ''})`, L(e.before?.liters, 1)),
      fact(`Тоолуур (дараа${e.after?.moving ? ', явж байхад' : ''})`, L(e.after?.liters, 1)),
      isNum(fell) ? fact(fell < 0 ? 'Өссөн' : 'Буурсан', L(Math.abs(fell), 1), fell < 0 ? 'good' : '') : '',
      m?.burn ? html`<div class="fact wide"><span>Шатаж болох дээд хэмжээ (хассан)</span><b>${L(m.burn.total ?? m.burn.liters, 1)}</b><small>${burnText(m.burn)}</small></div>` : '',
    );
  }
  const actFacts = act ? [
    fact('Явсан зам', act.distanceKm > 0 ? `${fmtNum(act.distanceKm, 1)} км (${fmtDur(act.movingMs)})` : 'Зогсож байсан'),
    act.distanceKm > 0 && isNum(act.maxSpeed) ? fact('Хамгийн их хурд', `${fmtNum(act.maxSpeed)} км/ц`) : '',
    fact('Хөдөлгүүр асаалттай', act.engineOnMs > 0 ? fmtDur(act.engineOnMs) : 'Үгүй'),
    fact('Тэжээл (масс) унтраастай', act.powerOffMs > 0 ? fmtDur(act.powerOffMs) : 'Үгүй', act.powerOffMs > 0 ? 'bad' : ''),
    act.noDataMs > 0 ? fact('GPS мэдээлэлгүй', fmtDur(act.noDataMs), 'warn') : '',
  ] : [];
  const verdict = a.type === 'fuel_drain' ? VERDICTS[a.verdict] : null;
  const isEv = confirmed(e);
  const dupI = dup.get(i);
  const box = a.verdict === 'false_alarm' ? ['Шалгасан хүн', 'Худал дохио'] : isEv ? ['Алдсан', L(lost)] : ['Тоолуураар', 'Батлагдаагүй'];
  return html`<section class="page incident" data-i="${i}">
    ${pageHead(`Нотлох баримт № ${i + 1}`, `${i + 1} / ${n}`)}
    <div class="inc-top">
      <div class="inc-truck"><b>${plateOf(e)}</b><span>${[e.vehicle.group, e.vehicle.tankLiters ? `сав ${fmtNum(e.vehicle.tankLiters)} л` : ''].filter(Boolean).join(' · ')}</span></div>
      <div class="inc-what"><span class="kind">${typeLabel(a.type)} · ${SEV_LABEL[a.severity] || ''}</span><b>${a.title || typeLabel(a.type)}</b>
        ${verdict ? html`<span class="verdict v-${a.verdict}">${verdict}</span>` : ''}</div>
      <div class="inc-lost${isEv ? '' : ' none'}"><span>${box[0]}</span><b>${box[1]}</b></div>
    </div>
    ${isEv ? '' : html`<div class="not-evidence"><b>Энэ тохиолдлыг хулгайн нотолгоо болгож болохгүй.</b> ${whyNot(e)}${e.meter?.verdict === 'refuel' ? ': түлш нэмэгдсэн нь цэнэглэлт' : ''}. ${a.verdict === 'false_alarm' ? 'Нийтэд оруулаагүй.' : 'Графикийн тоолуурын заалтыг харна уу.'}</div>`}
    ${dupI === undefined ? '' : html`<div class="not-evidence"><b>Нотлох баримт № ${dupI + 1}-тэй нэг хугацаанд.</b> Систем нэг тохиолдлыг хоёр удаа илрүүлсэн тул нэгтгэлд их литртэйг нь нэг удаа тооцсон.</div>`}
    <div class="facts">${facts}${actFacts}
      ${e.place ? html`<div class="fact wide"><span>Байршил${e.place.source === 'stop' ? ' (зогсож байсан цэг)' : ''}</span><b><a href="${mapsUrl(e.place)}" target="_blank" rel="noopener">${coord(e.place)}</a></b></div>` : ''}
    </div>
    ${e.dataKept ? html`<div class="fig"><div class="fig-cap">Түлшний тоолуурын заалт ба машины төлөв, ${fmtShort(e.from)} — ${fmtShort(e.to)}</div><div class="ev-chart"></div>
      <div class="legend"><span><i class="lg-raw"></i>Тоолуурын заалт, зогсож тогтсон үед (тооцоонд орсон)</span><span><i class="lg-thin"></i>Бүх заалт (явж байхад савлана)</span><span><i class="lg-drive"></i>Явж байсан</span><span><i class="lg-drain"></i>Энэ тохиолдол</span><span><i class="lg-spd"></i>Хурд</span><span><i class="lg-ign"></i>Хөдөлгүүр асаалттай</span><span><i class="lg-ignoff"></i>унтраастай</span><span><i class="lg-pwroff"></i>Тэжээл унтраастай</span></div></div>
      <div class="fig"><div class="fig-cap">Явсан зам: <i class="k-track"></i>энэ хугацаанд, <i class="k-ev"></i>түлш алдагдсан үед, <i class="k-pin"></i>${e.place?.source === 'stop' ? 'зогсож байсан цэг' : 'илэрсэн цэг'}</div><div class="ev-map"></div></div>`
    : html`<p class="missing">Энэ үеийн GPS бичлэг хадгалагдаагүй (дэлгэрэнгүй бичлэгийг ${Math.round((e.keepHours || 1464) / 24)} хоног хадгалдаг) — тоолуурын заалт, график, газрын зураг гаргах боломжгүй.</p>`}
    ${e.receipts.length ? html`<div class="fig"><div class="fig-cap">Тэр өдрүүдийн түлшний баримт</div>
      <table class="ev-tbl small">
        <thead><tr><th>Огноо</th><th>Станц</th><th class="num">Баримтад</th><th class="num">Саванд орсон</th><th class="num">Зөрүү</th><th>Дүгнэлт</th></tr></thead>
        <tbody>${e.receipts.map((r0) => { const r = rcRow(r0, e); return html`<tr class="${r.main ? 'main' : ''}"><td class="nowrap">${r.date}${r.dateTo ? `/${r.dateTo.slice(8)}` : ''}${r.time ? ` ${r.time}` : ''}</td><td>${r.station || (r.source === 'opentee' ? 'Жолоочийн апп' : '—')}</td>
          <td class="num">${L(r.litres, 1)}</td><td class="num">${r.refuel ? L(r.refuel.wentIn, 1) : '—'}</td>
          <td class="num ${r.status === 'short' || r.status === 'norefuel' ? 'bad' : ''}">${r.status === 'norefuel' && !isNum(r.missing) ? L(r.litres, 1) : isNum(r.missing) ? L(r.missing, 1) : '—'}</td>
          <td>${r.statusText || RC_STATUS[r.status] || r.status}${r.nofit ? ' · саванд багтахгүй' : ''}</td></tr>`; })}</tbody>
      </table></div>` : ''}
    ${a.note ? html`<p class="detail"><span>Шалгасан хүний тэмдэглэл:</span> ${a.note}</p>` : ''}
    <div class="sign">
      <div class="sign-row"><span>Жолоочийн тайлбар:</span><i></i></div>
      <div class="sign-row"><span></span><i></i></div>
      <div class="sign-grid">
        <div><span>Танилцуулсан (албан тушаал, нэр):</span><i></i><small>гарын үсэг</small></div>
        <div><span>Танилцсан жолооч (нэр):</span><i></i><small>гарын үсэг</small></div>
        <div class="date"><span>Огноо:</span><i></i></div>
      </div>
    </div>
    ${pageFoot(`Анхааруулга #${a.id} · бэлтгэсэн ${fmtShort(e.generatedAt)}`)}
  </section>`;
}

/** The receipt this page is about reads what the fuel meter shows (as the facts above), not the
 *  receipt matcher's own figures. */
function rcRow(r, e) {
  const m = e.meter;
  if (!r.main || e.alert.type !== 'receipt_mismatch' || !m) return r;
  if (m.verdict === 'short' || m.verdict === 'full' || m.verdict === 'norefuel') {
    return { ...r, refuel: m.wentIn > 0 ? { wentIn: m.wentIn } : null, missing: m.verdict === 'full' ? 0 : m.lost, status: m.verdict === 'full' ? 'ok' : m.verdict };
  }
  return { ...r, refuel: null, missing: null, status: m.verdict, statusText: meterLabel(e) };
}

// ---------------------------------------------------------------- chart + map
function drawChart(host, e) {
  // the meter only, standing still: no averaged level, no speed graph, no other alerts' marks
  const chart = new FuelChart(host, { fuelHeight: 150, levels: false, plain: true });
  const own = (e.alerts || []).filter((x) => x.id === e.alert.id);
  chart.setData({
    samples: e.samples, levels: e.levels, alerts: own.length ? own : [e.alert], from: e.from, to: e.to,
    cal: normCal(e.cal), th: e.th || {}, hasFuel: e.vehicle.hasFuel, sensorOk: true, typeLabel,
  });
  chart.ro.disconnect(); // drawn once for the sheet's width: printing must not redraw it
  return chart;
}

function project(lat, lng, z) {
  const n = TILE * 2 ** z;
  const s = Math.sin((lat * Math.PI) / 180);
  return [((lng + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

/** A map image without a map library: OpenStreetMap tiles laid side by side, the track drawn
 *  over them. Resolves once every tile has loaded (or failed), so printing waits for them. */
function drawMap(host, e, height = null) {
  const W = Math.max(300, Math.floor(host.clientWidth || 700));
  const H = height ?? Math.round(W * 0.3);
  const track = (e.track || []).filter((p) => valid(p[1], p[2]));
  const near = track.filter((p) => p[0] >= e.eventFrom - HOUR && p[0] <= e.eventTo + HOUR);
  const focus = (near.length ? near : track).map((p) => [p[1], p[2]]);
  if (e.place) focus.push([e.place.lat, e.place.lng]);
  if (!focus.length) {
    setHTML(host, html`<p class="missing">Энэ үеийн байршил бүртгэгдээгүй.</p>`);
    return Promise.resolve();
  }
  const lats = focus.map((p) => p[0]);
  const lngs = focus.map((p) => p[1]);
  const box = [Math.min(...lats), Math.min(...lngs), Math.max(...lats), Math.max(...lngs)];
  let z = 15;
  for (; z > 3; z--) {
    const [x0, y1] = project(box[0], box[1], z);
    const [x1, y0] = project(box[2], box[3], z);
    if (x1 - x0 <= W - 80 && y1 - y0 <= H - 60) break;
  }
  const [ax, ay] = project(box[0], box[1], z);
  const [bx, by] = project(box[2], box[3], z);
  const ox = (ax + bx) / 2 - W / 2;
  const oy = (ay + by) / 2 - H / 2;
  const n = 2 ** z;
  const imgs = [];
  for (let tx = Math.floor(ox / TILE); tx <= Math.floor((ox + W) / TILE); tx++) {
    for (let ty = Math.floor(oy / TILE); ty <= Math.floor((oy + H) / TILE); ty++) {
      if (ty < 0 || ty >= n) continue;
      const wx = ((tx % n) + n) % n;
      imgs.push(`<img alt="" src="${TILE_URL(z, wx, ty)}" style="left:${Math.round(tx * TILE - ox)}px;top:${Math.round(ty * TILE - oy)}px">`);
    }
  }
  const pt = (lat, lng) => {
    const [x, y] = project(lat, lng, z);
    return `${(x - ox).toFixed(1)},${(y - oy).toFixed(1)}`;
  };
  const line = (pts) => pts.map((p) => pt(p[1], p[2])).join(' ');
  const during = track.filter((p) => p[0] >= e.eventFrom && p[0] <= e.eventTo);
  let pin = '';
  if (e.place) {
    const [x, y] = project(e.place.lat, e.place.lng, z).map((v, k) => v - (k ? oy : ox));
    pin = `<g class="m-pin" transform="translate(${x.toFixed(1)},${y.toFixed(1)})"><path d="M0 0c-5-7-9-11-9-16a9 9 0 0 1 18 0c0 5-4 9-9 16z"/><circle cx="0" cy="-16" r="3.4"/></g>`;
  }
  host.style.height = `${H}px`;
  host.innerHTML = `<div class="tiles">${imgs.join('')}</div>
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      ${track.length > 1 ? `<polyline class="m-track" points="${line(track)}"/>` : ''}
      ${during.length > 1 ? `<polyline class="m-ev-halo" points="${line(during)}"/><polyline class="m-ev" points="${line(during)}"/>` : ''}
      ${pin}
    </svg>
    <span class="attr">© OpenStreetMap</span>${scaleBar(z, (box[0] + box[2]) / 2)}`;
  return Promise.all($$('img', host).map((img) => (img.complete ? null : new Promise((res) => { img.onload = res; img.onerror = res; }))));
}

/** A scale bar of a round distance (about 80 px long) for the map's zoom at that latitude. */
function scaleBar(z, lat) {
  const mPerPx = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
  const target = mPerPx * 80;
  const mag = 10 ** Math.floor(Math.log10(target));
  const m = [1, 2, 5, 10].map((k) => k * mag).filter((v) => v <= target).pop() || mag;
  const px = Math.round(m / mPerPx);
  return `<span class="scale"><i style="width:${px}px"></i>${m >= 1000 ? `${fmtNum(m / 1000)} км` : `${fmtNum(m)} м`}</span>`;
}

function cssPx(len) {
  const d = document.createElement('div');
  d.style.cssText = `position:absolute;visibility:hidden;height:${len}`;
  document.body.append(d);
  const h = d.offsetHeight;
  d.remove();
  return h;
}

// ---------------------------------------------------------------- boot
async function main() {
  $('#ev-print').addEventListener('click', () => window.print());
  if (!ids.length) {
    setHTML($('#ev-pages'), html`<section class="page"><p class="missing">Тохиолдол сонгоогүй байна. Хяналтын самбарын “Нотлох баримт” хэсгээс сонгоно уу.</p></section>`);
    $('#ev-progress').textContent = '';
    return;
  }
  document.title = `Нотлох баримт · ${ids.length} тохиолдол`;
  try {
    const meta = await api('/api/meta');
    types = meta?.alertTypes || {};
  } catch (e) {
    if (e.status === 401) {
      setHTML($('#ev-pages'), html`<section class="page"><p class="missing">Нэвтрээгүй байна. <a href="./">Хяналтын самбар</a>-аар нэвтэрч, энэ хуудсыг дахин нээнэ үү.</p></section>`);
      $('#ev-progress').textContent = '';
      return;
    }
  }
  const list = await loadAll();
  const now = Date.now();
  const ok = list.filter((e) => e && !e.error);
  if (ok.length === 1 && ok.length === list.length) {
    document.title = `Нотлох баримт · ${plateOf(ok[0])} · ${fmtShort(ok[0].eventFrom, false)}`;
  } else if (ok.length) {
    const names = [...new Set(ok.map(plateOf))];
    document.title = `Нотлох баримт · ${names.length === 1 ? names[0] : `${names.length} машин`} · ${ok.length} тохиолдол`;
  }
  const dup = overlaps(list);
  setHTML($('#ev-pages'), html`${list.length > 1 ? summaryPage(list, now, dup) : ''}${list.map((e, i) => incidentPage(e, i, list.length, dup))}`);
  const waits = [];
  const a4 = cssPx('297mm');
  for (const page of $$('.page.incident[data-i]')) {
    const e = list[Number(page.dataset.i)];
    const chartHost = $('.ev-chart', page);
    if (chartHost) drawChart(chartHost, e);
    const mapHost = $('.ev-map', page);
    if (!mapHost) continue;
    drawMap(mapHost, e);
    // one sheet per incident: a page with more text (receipts, notes) gets a lower map
    const over = page.offsetHeight - a4;
    if (over > 0) waits.push(drawMap(mapHost, e, Math.max(110, mapHost.offsetHeight - over - 6)));
    else waits.push(drawMap(mapHost, e));
  }
  $('#ev-progress').textContent = 'Газрын зургийг ачаалж байна…';
  await Promise.race([Promise.all(waits), new Promise((res) => setTimeout(res, 20000))]);
  const failed = list.length - ok.length;
  $('#ev-progress').textContent = failed ? `${ok.length} хуудас бэлэн, ${failed} ачаалагдсангүй` : `${list.length} тохиолдол · ${list.length + (list.length > 1 ? 1 : 0)} хуудас бэлэн`;
  $('#ev-print').disabled = false;
  document.body.classList.add('ready');
}

main();
