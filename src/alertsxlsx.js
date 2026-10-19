// "Alerts" Excel download (GET /api/export/alerts.xlsx): every alert that matches the filter
// the Alerts view is showing — all of them, not only the pages loaded on screen — one row each,
// plus a sheet that says which filter it was. Refuels carry where the fuel went in (the fill
// spot from the track, see refuelplaces.js) and a sheet of those places. Used by the local
// server and the cloud version.
import { SEV_LABEL, TYPE_LABELS } from './mn.js';
import { round } from './util.js';
import { PLACE_RADIUS_M, groupPlaces, namedPlaces, validPos } from './refuelplaces.js';

const MIN = 60e3;
// far more than a 90-day range ever holds, and well inside Excel's 1 048 576 rows
export const ALERTS_EXPORT_MAX = 100_000;
export const ALERT_IDS_MAX = 2000;

const VERDICT_LABEL = { unchecked: 'Шалгаагүй', confirmed: 'Хулгай батлагдсан', false_alarm: 'Худал дохио' };
const YES = 'ТИЙМ';
const NO = 'үгүй';
const SEV_TONE = { [SEV_LABEL.critical]: 'bad', [SEV_LABEL.warning]: 'warn' };

/** The filter of GET /api/alerts and the export, from a request's query string. */
export function alertFilterFromQuery(q, { intParam, listParam }) {
  // ids: the alerts picked one by one (the evidence page), at most ALERT_IDS_MAX of them
  const ids = listParam(q.get('ids'))?.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, ALERT_IDS_MAX);
  return {
    ...(ids ? { ids } : {}),
    imei: q.get('imei') || undefined,
    severities: listParam(q.get('severity')),
    types: listParam(q.get('type')),
    since: intParam(q.get('since')),
    until: intParam(q.get('until')),
    unacked: ['1', 'true', 'yes'].includes(String(q.get('unacked') || '').toLowerCase()),
  };
}

// litres of an alert: the refuel / drain amount, or what a fuel receipt is missing from the tank
const litresOf = (a) => (Number.isFinite(a.amountL) ? a.amountL : a.type === 'receipt_mismatch' && Number.isFinite(a.receipt?.missing) ? a.receipt.missing : null);
const THEFT_TYPES = ['fuel_drain', 'receipt_mismatch'];
const typeLabel = (type, alertTypes) => alertTypes?.[type]?.label ?? TYPE_LABELS[type] ?? type;
const localTime = (t, tzMin) => new Date(t + tzMin * MIN).toISOString().slice(0, 16).replace('T', ' ');
const mapLink = (lat, lng) => (validPos(lat, lng) ? { text: 'Газрын зураг', url: `https://maps.google.com/?q=${lat.toFixed(6)},${lng.toFixed(6)}` } : null);
const coordText = (lat, lng) => (validPos(lat, lng) ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : '');
const UNKNOWN_PLACE = 'Тодорхойгүй';
const unknownTone = (v) => (v === UNKNOWN_PLACE ? 'warn' : null);

function stateText(a) {
  return [
    a.pending ? 'Шалгагдаж байна (5 цаг)' : '',
    a.ongoing ? 'Үргэлжилж байна' : '',
    a.historical ? 'Түүх (мэдэгдэл илгээгээгүй)' : '',
  ].filter(Boolean).join('; ');
}

/**
 * Sheets for xlsx.js buildXlsx.
 *   alerts: alertView objects, newest first
 *   filter: { imei, severities, types, since, until, unacked } as the request gave it
 *   vehicleName: display name of filter.imei
 *   limited: true when there were more than ALERTS_EXPORT_MAX matching alerts
 *   fillSpots: Map alert id -> { lat, lng } | null, the fill spot of each refuel (fillSpot())
 *   refuelPlaces: named places from the config (namedPlaces() input)
 */
export function buildAlertSheets({ alerts = [], filter = {}, alertTypes = {}, vehicleName, now = Date.now(), tzOffsetMinutes: tzMin = 480, timezone, limited = false, fillSpots = new Map(), refuelPlaces = [] } = {}) {
  const DT = 'yyyy-mm-dd hh:mm';
  const L1 = '#,##0.0';

  // where each refuel was filled, grouped into places
  const refuels = alerts.filter((a) => a.type === 'refuel');
  const spots = refuels.map((a) => fillSpots.get(a.id) ?? null);
  const { placeOf, places } = groupPlaces(spots, namedPlaces(refuelPlaces));
  const fill = new Map(refuels.map((a, i) => [a.id, { spot: spots[i], place: placeOf[i] }]));
  const placeLabel = (a) => (a.type !== 'refuel' ? '' : fill.get(a.id)?.place?.name ?? UNKNOWN_PLACE);
  // a refuel's fill spot; otherwise (and for other alerts) the alert's own position
  const pos = (a) => fill.get(a.id)?.spot ?? { lat: a.lat, lng: a.lng };
  const columns = [
    { header: 'Илэрсэн цаг', type: 'datetime', numFmt: DT },
    { header: 'Эхэлсэн цаг', type: 'datetime', numFmt: DT },
    { header: 'Машин', type: 'string' },
    { header: 'Бүлэг', type: 'string' },
    { header: 'Зэрэглэл', type: 'string', tone: (v) => SEV_TONE[v] ?? null },
    { header: 'Төрөл', type: 'string' },
    { header: 'Гарчиг', type: 'string', width: 40, wrap: true },
    { header: 'Литр', type: 'number', numFmt: L1 },
    { header: 'Цэнэглэсэн газар', type: 'string', tone: unknownTone },
    { header: 'Газрын зураг', type: 'link' },
    { header: 'Байршил', type: 'string' },
    { header: 'Дүгнэлт', type: 'string' },
    { header: 'Тэмдэглэл', type: 'string', width: 36, wrap: true },
    { header: 'Төлөв', type: 'string' },
    { header: 'Танилцсан', type: 'string' },
    { header: 'Дэлгэрэнгүй', type: 'string', width: 60, wrap: true },
    { header: 'IMEI', type: 'string' },
    { header: 'Анхааруулгын №', type: 'number', numFmt: '0' },
  ];
  const rows = alerts.map((a) => [
    a.t ?? null,
    Number.isFinite(a.fromT) && a.fromT !== a.t ? a.fromT : null,
    a.shortName || a.name || a.imei || '',
    a.group ?? '',
    SEV_LABEL[a.severity] ?? a.severity ?? '',
    typeLabel(a.type, alertTypes),
    a.title ?? '',
    litresOf(a),
    placeLabel(a),
    mapLink(pos(a).lat, pos(a).lng),
    coordText(pos(a).lat, pos(a).lng),
    a.type === 'fuel_drain' ? VERDICT_LABEL[a.verdict] ?? '' : '',
    a.note ?? '',
    stateText(a),
    a.acked ? YES : NO,
    a.detail ?? '',
    a.imei ?? '',
    a.id ?? null,
  ]);

  // one type of alert (e.g. only refuels), or only thefts: their litres add up to something meaningful
  const types = new Set(alerts.map((a) => a.type));
  const litres = alerts.map(litresOf).filter((L) => L !== null);
  const sameKind = types.size === 1 || [...types].every((t) => THEFT_TYPES.includes(t));
  const totalL = sameKind && litres.length ? round(litres.reduce((s, L) => s + L, 0), 1) : null;
  const totalRow = totalL === null ? undefined : ['Нийт', null, `${alerts.length} анхааруулга`, null, null, null, null, totalL];

  const sevs = filter.severities?.length ? filter.severities : null;
  const typeList = filter.types?.length ? filter.types : null;
  const from = Number.isFinite(filter.since) ? filter.since : null;
  const to = Number.isFinite(filter.until) ? Math.min(filter.until, now) : now;
  const byType = new Map();
  for (const a of alerts) byType.set(a.type, (byType.get(a.type) || 0) + 1);
  const p = (text) => ({ text, wrap: true });

  // one row per place the refuels were filled at, most used first
  const placeSheet = [];
  if (refuels.length) {
    const agg = new Map(places.map((pl) => [pl, { trucks: new Set(), litres: 0, first: null, last: null }]));
    const unknown = { trucks: new Set(), litres: 0, first: null, last: null, count: 0 };
    for (const a of refuels) {
      const pl = fill.get(a.id)?.place;
      const g = pl ? agg.get(pl) : unknown;
      if (!pl) unknown.count++;
      g.trucks.add(a.imei);
      if (Number.isFinite(a.amountL)) g.litres += a.amountL;
      if (Number.isFinite(a.t)) {
        g.first = g.first === null ? a.t : Math.min(g.first, a.t);
        g.last = g.last === null ? a.t : Math.max(g.last, a.t);
      }
    }
    const row = (name, n, g, lat, lng) => [name, n, g.trucks.size, round(g.litres, 1), g.first, g.last, mapLink(lat, lng), coordText(lat, lng)];
    placeSheet.push({
      name: 'Цэнэглэсэн газрууд',
      freezeHeader: true,
      autoFilter: true,
      columns: [
        { header: 'Газар', type: 'string', tone: unknownTone },
        { header: 'Цэнэглэлт', type: 'number', numFmt: '0' },
        { header: 'Машин', type: 'number', numFmt: '0' },
        { header: 'Литр', type: 'number', numFmt: L1 },
        { header: 'Эхний', type: 'datetime', numFmt: DT },
        { header: 'Сүүлийн', type: 'datetime', numFmt: DT },
        { header: 'Газрын зураг', type: 'link' },
        { header: 'Байршил', type: 'string' },
      ],
      rows: [
        ...places.map((pl) => row(pl.name, pl.count, agg.get(pl), pl.lat, pl.lng)),
        ...(unknown.count ? [row(UNKNOWN_PLACE, unknown.count, unknown, null, null)] : []),
      ],
    });
  }

  return [
    { name: 'Анхааруулга', freezeHeader: true, autoFilter: true, columns, rows, totalRow },
    ...placeSheet,
    {
      name: 'Шүүлтүүр',
      width: 110,
      orientation: 'portrait',
      fitToWidth: true,
      titleLines: [
        'Анхааруулга — шүүлтүүрт тохирох бүгд',
        `Бэлтгэсэн: ${localTime(now, tzMin)} (${timezone || 'орон нутгийн'} цаг)`,
        '',
        { text: 'ШҮҮЛТҮҮР', bold: true },
        `Хугацаа: ${from === null ? 'эхнээс' : localTime(from, tzMin)} — ${localTime(to, tzMin)}`,
        `Зэрэглэл: ${sevs ? sevs.map((s) => SEV_LABEL[s] ?? s).join(', ') : 'бүгд'}`,
        `Төрөл: ${typeList ? typeList.map((t) => typeLabel(t, alertTypes)).join(', ') : 'бүгд'}`,
        `Машин: ${filter.imei ? vehicleName || filter.imei : 'бүх машин'}`,
        ...(filter.ids ? [`Нэг бүрчлэн сонгосон: ${filter.ids.length} анхааруулга`] : []),
        `Зөвхөн танилцаагүй: ${filter.unacked ? YES : NO}`,
        '',
        { text: `НИЙТ: ${alerts.length} анхааруулга${totalL === null ? '' : ` · ${totalL.toLocaleString('en-US')} литр`}`, bold: true },
        ...[...byType].sort((a, b) => b[1] - a[1]).map(([t, n]) => `   ${typeLabel(t, alertTypes)}: ${n}`),
        ...(refuels.length ? [
          '',
          { text: 'ЦЭНЭГЛЭСЭН ГАЗАР', bold: true },
          p('Машин зогсож, түлшний түвшин нэмэгдсэн цэг — GPS-ийн хадгалсан бичлэгээс олсон. Цэнэглэлт илэрсэн цэг биш: машин станцаас гарсны дараа илэрсэн бол тэр цэг хэдэн км зайтай байж болно.'),
          p(`${PLACE_RADIUS_M} м дотрох цэгүүдийг нэг газар гэж үзэж, хамгийн олон цэнэглэсэнийг “Газар 1” гэж дугаарласан; бүх газар “Цэнэглэсэн газрууд” хуудсанд байна.`),
          p(`${UNKNOWN_PLACE}: тэр үеийн GPS бичлэг хадгалагдаагүй (61 хоногоос өмнөх) эсвэл аль зогсолтод цэнэглэсэн нь бичлэгээс харагдахгүй — Байршил ба Газрын зураг нь цэнэглэлт илэрсэн цэгийг харуулна.`),
        ] : []),
        ...(limited ? ['', p(`Хамгийн сүүлийн ${ALERTS_EXPORT_MAX.toLocaleString('en-US')} анхааруулгыг л оруулсан — хугацааг богиносгож дахин татна уу.`)] : []),
      ],
    },
  ];
}

/** Download name: "Анхааруулга <type> <vehicle> <day>.xlsx" (the parts that were filtered). */
export function alertsXlsxName({ filter = {}, alertTypes = {}, vehicleName, now = Date.now(), tzOffsetMinutes: tzMin = 480 } = {}) {
  const day = new Date(now + tzMin * MIN).toISOString().slice(0, 10);
  const parts = [filter.ids ? 'Нотлох баримт' : 'Анхааруулга'];
  if (filter.types?.length === 1) parts.push(typeLabel(filter.types[0], alertTypes));
  if (filter.imei) parts.push(vehicleName || filter.imei);
  parts.push(day);
  return `${parts.join(' ').replace(/[\\/:*?"<>|\x00-\x1F]+/g, '-')}.xlsx`;
}

export function alertsXlsxOpts(tzOffsetMin = 480) {
  return { tzOffsetMinutes: tzOffsetMin, creator: 'Fuel Tank Warner', title: 'Анхааруулга — шүүлтүүрт тохирох бүгд' };
}
