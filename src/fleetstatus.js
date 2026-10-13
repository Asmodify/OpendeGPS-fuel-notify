// Health of each vehicle's equipment: is the GPS tracker working, is the fuel sensor working.
// The same rules feed the dashboard (vehicleView -> gpsFault / fuelSensor) and the
// "Fleet status" Excel download (GET /api/export/fleet-status.xlsx).
import { fmtDuration, round } from './util.js';
import { mnUnits } from './mn.js';

const HOUR = 3600e3;
const MIN = 60e3;
// silence shorter than this is usually lost coverage (the same 6 h after which "offline" is alerted)
export const GPS_SILENT_MS = 6 * HOUR;

const STATUS_LABEL = { moving: 'Явж байна', idle: 'Асаалттай зогссон', parked: 'Зогсоолд', offline: 'Холбогдоогүй' };

/**
 * Why the GPS tracker looks broken, or null. `v` is a vehicleView (status, lastSeen, gps, pwrMv).
 *   never   - has never reported
 *   silent  - no data for GPS_SILENT_MS or more
 *   nofix   - reporting, but without a GPS position fix
 *   nopower - moving / idling while the tracker has no vehicle power (unplugged, wires cut);
 *             no power while parked is the master switch being off, which is normal
 */
export function gpsFault(v, th, now = Date.now()) {
  if (!v.lastSeen) return { code: 'never', text: 'Хэзээ ч мэдээлээгүй' };
  if (v.status === 'offline') {
    return now - v.lastSeen >= GPS_SILENT_MS ? { code: 'silent', text: `${mnUnits(fmtDuration(now - v.lastSeen))} мэдээлэлгүй` } : null;
  }
  const g = v.gps;
  if (g && (g.valid === 0 || ((g.valid === null || g.valid === undefined) && g.sats === 0))) return { code: 'nofix', text: 'GPS байршил тогтоогоогүй' };
  const cut = Number(th?.powerCutMv ?? 5000);
  if ((v.status === 'moving' || v.status === 'idle') && Number.isFinite(v.pwrMv) && v.pwrMv < cut) {
    return { code: 'nopower', text: `Машины тэжээлгүй явж байна (${(v.pwrMv / 1000).toFixed(1)} В)` };
  }
  return null;
}

/**
 * The fuel sensor's state for a vehicleView:
 *   none    - no fuel sensor fitted
 *   fault   - not giving valid readings while the vehicle has power
 *   ok      - giving a level
 *   nodata  - the tracker has been silent GPS_SILENT_MS or more (or never reported): the
 *             sensor cannot be judged now, whatever it showed before
 *   waiting - reporting, but no steady parked reading yet
 */
export function fuelSensorState(v, th, now = Date.now()) {
  if (!v.hasFuel) return 'none';
  const f = v.fuel;
  if (f && f.sensorOk === false) return 'fault';
  if (!v.lastSeen || (v.status === 'offline' && now - v.lastSeen >= GPS_SILENT_MS)) return 'nodata';
  if (f && Number.isFinite(f.mv)) return 'ok';
  if (v.status === 'offline') return 'nodata';
  const minMv = Number(th?.sensorMinValidMv ?? 100);
  const cut = Number(th?.powerCutMv ?? 5000);
  if (f && Number.isFinite(f.rawMv) && f.rawMv < minMv && Number.isFinite(v.pwrMv) && v.pwrMv >= cut) return 'fault';
  return 'waiting';
}

// ---- "Fleet status" workbook ----------------------------------------------------------------
const GPS_WORD = { ok: 'АЖИЛЛАЖ БАЙНА', bad: 'АЖИЛЛАХГҮЙ' };
const FUEL_WORD = { ok: 'АЖИЛЛАЖ БАЙНА', fault: 'ГЭМТЭЛТЭЙ', nodata: 'ШАЛГАГДААГҮЙ', waiting: 'ШАЛГАГДААГҮЙ', none: 'МЭДРЭГЧГҮЙ' };
const YES = 'ТИЙМ';
const NO = 'үгүй';
const FUEL_PROBLEM = {
  fault: 'хүчинтэй заалт өгөхгүй — салсан эсвэл эвдэрсэн',
  nodata: 'шалгах боломжгүй — трекер мэдээлэл илгээхгүй байна',
  waiting: 'хараахан шалгагдаагүй — зогсоолын тогтвортой заалт алга',
};
const TONE = { 'АЖИЛЛАЖ БАЙНА': 'good', 'АЖИЛЛАХГҮЙ': 'bad', 'ГЭМТЭЛТЭЙ': 'bad', 'ШАЛГАГДААГҮЙ': 'warn', [YES]: 'bad', [NO]: 'good' };
const toneOf = (value) => TONE[value] ?? null;

const mapLink = (lat, lng) => (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)
  ? { text: 'Газрын зураг', url: `https://maps.google.com/?q=${lat.toFixed(6)},${lng.toFixed(6)}` } : null);

/**
 * Sheets for xlsx.js buildXlsx: every vehicle by name with WORKING / NOT WORKING for its GPS
 * tracker and fuel sensor, the lists of names per state, and the broken ones on their own sheets.
 *   vehicles: vehicleView objects (with gpsFault / fuelSensor filled in)
 */
export function buildFleetStatusSheets({ vehicles = [], now = Date.now(), tzOffsetMinutes: tzMin = 480, timezone } = {}) {
  const DT = 'yyyy-mm-dd hh:mm';
  const byName = (a, b) => String(a.shortName).localeCompare(String(b.shortName), 'mn', { numeric: true });
  // two tracker entries with the same name (usually an old, replaced tracker still on the GPS
  // server): tell them apart by the end of the IMEI
  const seen = new Map();
  for (const v of vehicles) seen.set(v.shortName, (seen.get(v.shortName) || 0) + 1);
  const label = (v) => (seen.get(v.shortName) > 1 ? `${v.shortName} (трекер …${String(v.imei).slice(-4)})` : v.shortName);
  const gpsBad = (v) => !!v.gpsFault;
  const fuelBad = (v) => v.fuelSensor === 'fault';
  const unchecked = (v) => v.fuelSensor === 'nodata' || v.fuelSensor === 'waiting';
  const repair = (v) => gpsBad(v) || fuelBad(v);
  // broken first (GPS, then fuel sensor), then the ones that could not be checked, then working
  const rank = (v) => (gpsBad(v) ? 0 : fuelBad(v) ? 1 : unchecked(v) ? 2 : 3);
  const list = [...vehicles].sort((a, b) => rank(a) - rank(b) || byName(a, b));
  const problems = (v) => [
    v.gpsFault ? `GPS: ${v.gpsFault.text.charAt(0).toLowerCase()}${v.gpsFault.text.slice(1)}` : '',
    FUEL_PROBLEM[v.fuelSensor] ? `Түлшний мэдрэгч: ${FUEL_PROBLEM[v.fuelSensor]}` : '',
  ].filter(Boolean).join('; ');
  const row = (v) => [
    label(v),
    v.group ?? '',
    gpsBad(v) ? GPS_WORD.bad : GPS_WORD.ok,
    FUEL_WORD[v.fuelSensor] ?? '',
    repair(v) ? YES : NO,
    problems(v),
    v.lastSeen ?? null,
    STATUS_LABEL[v.status] ?? v.status,
    Number.isFinite(v.fuel?.liters) && v.fuelSensor === 'ok' ? v.fuel.liters : null,
    Number.isFinite(v.fuel?.pct) && v.fuelSensor === 'ok' ? v.fuel.pct : null,
    Number.isFinite(v.gps?.sats) ? v.gps.sats : null,
    Number.isFinite(v.pwrMv) ? round(v.pwrMv / 1000, 1) : null,
    v.plate ?? '',
    v.device ?? '',
    v.imei,
    mapLink(v.lat, v.lng),
  ];
  const columns = [
    { header: 'Машин', type: 'string' },
    { header: 'Бүлэг', type: 'string' },
    { header: 'GPS трекер', type: 'string', tone: toneOf },
    { header: 'Түлшний мэдрэгч', type: 'string', tone: toneOf },
    { header: 'Засвар хэрэгтэй', type: 'string', tone: toneOf },
    { header: 'Юу нь буруу', type: 'string', width: 58, wrap: true },
    { header: 'Сүүлийн мэдээ', type: 'datetime', numFmt: DT },
    { header: 'Одоо', type: 'string' },
    { header: 'Түлш (л)', type: 'number', numFmt: '#,##0' },
    { header: 'Түлш (%)', type: 'number', numFmt: '0' },
    { header: 'Хиймэл дагуул', type: 'number', numFmt: '0' },
    { header: 'Тэжээл (В)', type: 'number', numFmt: '0.0' },
    { header: 'Улсын дугаар', type: 'string' },
    { header: 'Төхөөрөмж', type: 'string' },
    { header: 'IMEI', type: 'string' },
    { header: 'Газрын зураг', type: 'link' },
  ];

  const names = (a) => (a.length ? [...a].sort(byName).map(label).join(', ') : '—');
  const dupes = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
  const pick = (f) => list.filter(f);
  const G = {
    gpsBad: pick(gpsBad),
    gpsOk: pick((v) => !gpsBad(v)),
    fuelBad: pick(fuelBad),
    fuelOk: pick((v) => v.fuelSensor === 'ok'),
    fuelUnchecked: pick(unchecked),
    fuelNone: pick((v) => v.fuelSensor === 'none'),
    repair: pick(repair),
    allOk: pick((v) => !gpsBad(v) && v.fuelSensor === 'ok'),
  };
  const byCode = (code) => G.gpsBad.filter((v) => v.gpsFault.code === code);
  const local = new Date(now + tzMin * MIN).toISOString().slice(0, 16).replace('T', ' ');
  const p = (text, more = {}) => ({ text, wrap: true, ...more });
  const sub = (label, a) => (a.length ? [p(`   ${label} (${a.length}): ${names(a)}`)] : []);

  return [
    { name: 'Машинуудын төлөв', freezeHeader: true, autoFilter: true, columns, rows: list.map(row) },
    {
      name: 'Хураангуй',
      width: 120,
      orientation: 'portrait',
      fitToWidth: true,
      titleLines: [
        'Машинуудын төлөв — аль машины GPS трекер, түлшний мэдрэгч ажиллаж байна',
        `Бэлтгэсэн: ${local} (${timezone || 'орон нутгийн'} цаг) · ${list.length} машин · машин бүр “Машинуудын төлөв” хуудсанд байна (ажиллахгүй нь эхэндээ)`,
        '',
        { text: `ЗАСВАР ХЭРЭГТЭЙ — ${G.repair.length} машин: ${names(G.repair)}`, bold: true, wrap: true },
        '',
        { text: `GPS трекер АЖИЛЛАХГҮЙ — ${G.gpsBad.length} машин:`, bold: true },
        ...sub('6 цаг ба түүнээс удаан мэдээлэлгүй', byCode('silent')),
        ...sub('хэзээ ч мэдээлээгүй', byCode('never')),
        ...sub('GPS байршилгүй мэдээлж байгаа', byCode('nofix')),
        ...sub('машины тэжээлгүй явж байгаа (трекерийг салгасан?)', byCode('nopower')),
        ...(G.gpsBad.length ? [] : [p('   алга')]),
        '',
        { text: `Түлшний мэдрэгч ГЭМТЭЛТЭЙ — ${G.fuelBad.length} машин: ${names(G.fuelBad)}`, bold: true, wrap: true },
        p(`Түлшний мэдрэгч ШАЛГАГДААГҮЙ — ${G.fuelUnchecked.length} машин (трекер мэдээлэл илгээхгүй, эсвэл тогтвортой заалт хараахан алга): ${names(G.fuelUnchecked)}`),
        '',
        { text: `GPS трекер АЖИЛЛАЖ БАЙНА — ${G.gpsOk.length} машин: ${names(G.gpsOk)}`, bold: true, wrap: true },
        '',
        { text: `Түлшний мэдрэгч АЖИЛЛАЖ БАЙНА — ${G.fuelOk.length} машин: ${names(G.fuelOk)}`, bold: true, wrap: true },
        '',
        p(`Хоёулаа ажиллаж байна (GPS ба түлшний мэдрэгч) — ${G.allOk.length} машин: ${names(G.allOk)}`),
        p(`Түлшний мэдрэгч суулгаагүй — ${G.fuelNone.length} машин: ${names(G.fuelNone)}`),
        '',
        { text: 'ХЭРХЭН ДҮГНЭСЭН', bold: true },
        p('GPS АЖИЛЛАХГҮЙ: 6 цаг ба түүнээс удаан мэдээлэлгүй (богино тасалдал ихэвчлэн сүлжээгүй газраас болдог), хэзээ ч мэдээлээгүй, GPS байршилгүй мэдээлж байгаа, эсвэл трекер машины тэжээлгүй байхад явж / асаалттай зогсож байгаа (салгасан эсвэл утас тасарсан). Зогсоолд тэжээлгүй байх нь масс таслуур унтраасных бөгөөд хэвийн.'),
        p('Түлшний мэдрэгч ГЭМТЭЛТЭЙ: машин тэжээлтэй байхад хүчинтэй заалт өгөхгүй. ШАЛГАГДААГҮЙ: трекер мэдээлэл илгээхгүй тул мэдрэгчийг харах боломжгүй (эхлээд GPS-ийг засна уу), эсвэл машин тогтвортой заалт авах хангалттай удаан зогсоогүй.'),
        p('Excel дээр “Машинуудын төлөв” хуудасны гарчгийн мөрийн шүүлтүүрийн товчоор жишээ нь зөвхөн GPS трекер = АЖИЛЛАХГҮЙ-г харуулж болно.'),
        ...(dupes.length ? [p(`GPS сервер дээр нэг машинд хоёр трекер бүртгэгдсэн: ${dupes.join(', ')} — “(трекер …IMEI-ийн сүүлийн 4 орон)” гэж харуулсан. Ихэвчлэн нэг нь солигдсон хуучин трекер байдаг; GPS серверээс устгавал АЖИЛЛАХГҮЙ жагсаалтаас хасагдана.`)] : []),
      ],
    },
    { name: 'GPS ажиллахгүй', freezeHeader: true, autoFilter: true, tabColor: 'D03B3B', columns, rows: G.gpsBad.map(row) },
    { name: 'Түлшний мэдрэгч асуудалтай', freezeHeader: true, autoFilter: true, tabColor: 'E0A020', columns, rows: [...G.fuelBad, ...G.fuelUnchecked].map(row) },
  ];
}

export function fleetStatusXlsxOpts(tzOffsetMin = 480) {
  return { tzOffsetMinutes: tzOffsetMin, creator: 'Fuel Tank Warner', title: 'Машинуудын төлөв — GPS трекер ба түлшний мэдрэгч' };
}
