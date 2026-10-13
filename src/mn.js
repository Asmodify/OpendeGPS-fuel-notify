// Mongolian (Cyrillic) texts for everything the server shows to people: alert titles and
// details, alert type labels, notification texts.
//
// Alerts are stored in the database in English (the detector and the engine write them that
// way, and old alerts stay as they were); they are translated when they are shown
// (engine.alertView), so the dashboard, the notifications and the Excel files all read
// Mongolian — including alerts written before this translation existed. A text that matches
// none of the patterns below is shown unchanged (with its units translated).

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

/** Units, durations and dates inside an already translated sentence. */
export function mnUnits(s) {
  return String(s)
    // "21 Sep 20:59" (util.fmtLocal) -> "9-р сарын 21 20:59"
    .replace(/\b(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g, (_, d, m) => `${MONTHS[m]}-р сарын ${d}`)
    // "540 mV (≈5.4% of tank)" -> "540 мВ (савны ≈5.4%)"
    .replace(/(\d[\d.,]*) mV \(≈([\d.]+)% of tank\)/g, '$1 мВ (савны ≈$2%)')
    .replace(/(\d[\d.,]*) ?mV\b/g, '$1 мВ')
    .replace(/(\d[\d.,]*) ?L\b/g, '$1 л')
    .replace(/(\d[\d.,]*) ?km\/h\b/g, '$1 км/ц')
    .replace(/(\d[\d.,]*) ?km\b/g, '$1 км')
    .replace(/(\d[\d.,]*) V\b/g, '$1 В')
    // durations (util.fmtDuration / detector fmtDuration)
    .replace(/(\d+) d (\d+) h\b/g, '$1 хоног $2 ц')
    .replace(/(\d+) h (\d+) min\b/g, '$1 ц $2 мин')
    .replace(/(\d+) min\b/g, '$1 мин')
    .replace(/(\d+) h\b/g, '$1 ц')
    .replace(/(\d+) d\b/g, '$1 хоног')
    .replace(/\?/g, '?');
}

// ---- alert type labels ------------------------------------------------------------------------
export const TYPE_LABELS = {
  fuel_drain: 'Түлш алдагдал',
  power_cut: 'Трекерийн тэжээл тасарсан',
  sensor_lost: 'Түлшний мэдрэгч ажиллахгүй',
  low_fuel: 'Түлш бага',
  long_idle: 'Удаан сул ажилласан',
  overspeed: 'Хурд хэтрүүлсэн',
  offline: 'Холболт тасарсан',
  server_event: 'GPS серверийн үйл явдал',
  after_hours: 'Ажлын бус цагт хөдөлсөн',
  refuel: 'Түлш цэнэглэлт',
  sensor_restored: 'Түлшний мэдрэгч сэргэсэн',
  power_restored: 'Тэжээл сэргэсэн',
  back_online: 'Дахин холбогдсон',
  receipt_mismatch: 'Баримт зөрсөн',
};
/** alertTypes map ({ type: { severity, label } }) with Mongolian labels. */
export function mnAlertTypes(types) {
  const out = {};
  for (const [k, v] of Object.entries(types || {})) out[k] = { ...v, label: TYPE_LABELS[k] ?? v.label };
  return out;
}

export const SEV_LABEL = { critical: 'Ноцтой', warning: 'Сэрэмжлүүлэг', info: 'Мэдээлэл' };

// ---- alert titles -----------------------------------------------------------------------------
const TITLES = {
  'Refuel': 'Түлш цэнэглэлт',
  'Fuel drop': 'Түлш буурсан',
  'Fuel drop while parked': 'Зогсоолд түлш буурсан',
  'Fuel drop at a stop': 'Зогсолтын үед түлш буурсан',
  'Fuel drop while power was off': 'Тэжээл унтраатай үед түлш буурсан',
  'Abnormal fuel loss between stops': 'Зогсоол хооронд хэвийн бус түлш алдагдсан',
  'Fuel sensor dip (level recovered)': 'Мэдрэгчийн түр уналт (түвшин сэргэсэн)',
  'Tracker power cut while driving': 'Явж байхад трекерийн тэжээл тасарсан',
  'Tracker power restored': 'Трекерийн тэжээл сэргэсэн',
  'Overspeed': 'Хурд хэтрүүлсэн',
  'Driving outside working hours': 'Ажлын бус цагт явсан',
  'Moving outside working hours': 'Ажлын бус цагт явсан',
  'Long engine idle': 'Хөдөлгүүр удаан сул ажилласан',
  'Low fuel': 'Түлш бага',
  'Tank nearly empty': 'Сав бараг хоосон',
  'Fuel sensor working again': 'Түлшний мэдрэгч дахин ажиллаж байна',
  'Fuel sensor not reading': 'Түлшний мэдрэгч заахгүй байна',
  'Fuel sensor reading frozen': 'Түлшний мэдрэгчийн заалт хөдлөхгүй байна',
  'Tracker stopped reporting': 'Трекер мэдээлэл илгээхээ больсон',
  'Tracker back online': 'Трекер дахин холбогдсон',
  'Fuel dropped while tracker was offline': 'Трекер холбогдоогүй үед түлш буурсан',
  'Fuel rose while tracker was offline': 'Трекер холбогдоогүй үед түлш нэмэгдсэн',
  'Possible fuel drop — checking (5 h)': 'Түлш буурсан байж болзошгүй — шалгаж байна (5 ц)',
  'False alarm — fuel sensor misreading (level came back)': 'Худал дохио — мэдрэгчийн алдаа (түвшин буцаж сэргэсэн)',
  'Test notification': 'Туршилтын мэдэгдэл',
};
const TITLE_PATTERNS = [
  [/^Receipt (.+?), tank got (.+)$/, 'Баримт $1, савд $2 орсон'],
  [/^Receipt (.+?), no refuel recorded$/, 'Баримт $1, цэнэглэлт бүртгэгдээгүй'],
  [/^GPS server: (.+)$/, 'GPS сервер: $1'],
];
export function mnTitle(title) {
  if (title === null || title === undefined || title === '') return title;
  const s = String(title);
  if (TITLES[s]) return TITLES[s];
  for (const [re, to] of TITLE_PATTERNS) if (re.test(s)) return mnUnits(s.replace(re, to));
  return mnUnits(s);
}

// ---- alert details ----------------------------------------------------------------------------
const POWER_OFF = "the vehicle's power \\(master switch\\)";
/** "X at the next stop" / "about X while driving on" (the level after a stop, detector.js). */
const est = (s) => s
  .replace(/^about (.+) while driving on$/, 'цааш явах үед ойролцоогоор $1')
  .replace(/^(.+) at the next stop$/, 'дараагийн зогсоолд $1');
const about = (a) => (a ? 'ойролцоогоор ' : '');

// Ordered: the first pattern of a sentence that matches translates it. `to` is a replacement
// string or a function (same arguments as String.replace).
const DETAIL_PATTERNS = [
  // ---- fuel drops (detector.js) ----
  [/Fuel fell by (.+?) within (.+?) while parked \((.+?)\)(, across a period with vehicle power \(master switch\) off)?(, just before driving off)?(?:; idling explains at most (.+?))?\./g,
    (_, amt, dur, lv, pw, dep, idle) => `Зогсож байхад ${dur} дотор түлш ${amt} буурсан (${lv})`
      + (pw ? ', машины тэжээл (масс таслуур) унтраатай хугацааг хамарсан' : '')
      + (dep ? ', хөдлөхийн өмнөхөн' : '')
      + (idle ? `; сул ажиллагаа хамгийн ихдээ ${idle} зарцуулна` : '') + '.'],
  [new RegExp(`Fuel fell by about (.+?) across a stop with ${POWER_OFF} off \\((about )?(.+?) before the power was cut, (.+?)\\)\\.`, 'g'),
    (_, amt, ab, before, e) => `Машины тэжээл (масс таслуур) унтраатай зогсолтын үеэр түлш ойролцоогоор ${amt} буурсан (тэжээл тасрахаас өмнө ${about(ab)}${before}, ${est(e)}).`],
  [/Fuel fell by about (.+?) at a stop of (.+?) \((about )?(.+?) (while parked|when it stopped), (.+?)\)\./g,
    (_, amt, dur, ab, before, when, e) => `${dur} үргэлжилсэн зогсолтын үеэр түлш ойролцоогоор ${amt} буурсан (${when === 'while parked' ? 'зогсож байхад' : 'зогсох үед'} ${about(ab)}${before}, ${est(e)}).`],
  [new RegExp(`Fuel fell by (.+?) while ${POWER_OFF} was off \\(about (.+?) before the power was cut, (.+?) after it came back\\)\\.`, 'g'),
    'Машины тэжээл (масс таслуур) унтраатай байхад түлш $1 буурсан (тэжээл тасрахаас өмнө ойролцоогоор $2, тэжээл орсны дараа $3).'],
  [/Fuel fell by (.+?) over (.+?) \((.+?)\); ([\d.]+) engine-hours( and (\d+) km driven while the tracker was silent)? explain at most (.+?)\./g,
    (_, amt, dur, lv, eh, unseen, km, max) => `${dur} хугацаанд түлш ${amt} буурсан (${lv}); хөдөлгүүрийн ${eh} цаг${unseen ? ` болон трекер чимээгүй байхад явсан ${km} км` : ''} нь хамгийн ихдээ ${max} зарцуулалтыг тайлбарлана.`],
  // ---- refuels (detector.js) ----
  [/Fuel rose by (.+?) while stopped \((.+?)\)\./g, 'Зогсож байхад түлш $1 нэмэгдсэн ($2).'],
  [new RegExp(`Fuel rose by about (.+?) at a stop( with ${POWER_OFF} off)? \\(about (.+?) before, about (.+?) while driving on\\)\\.`, 'g'),
    (_, amt, pw, a, b) => `Зогсолтын үеэр${pw ? ' машины тэжээл (масс таслуур) унтраатай байхад' : ''} түлш ойролцоогоор ${amt} нэмэгдсэн (өмнө нь ойролцоогоор ${a}, цааш явах үед ойролцоогоор ${b}).`],
  [/Fuel rose by about (.+?) while the vehicle's power was off \(about (.+?) before the power was cut, (.+?) after it came back\)\./g,
    'Машины тэжээл унтраатай байхад түлш ойролцоогоор $1 нэмэгдсэн (тэжээл тасрахаас өмнө ойролцоогоор $2, тэжээл орсны дараа $3).'],
  [/Fuel rose by about (.+?) \(from roughly (.+?) while driving to (.+?)\)\./g, 'Түлш ойролцоогоор $1 нэмэгдсэн (явж байхад ойролцоогоор $2 байсан, $3 болсон).'],
  [/Fuel rose by at least (.+?) between stops \((.+?), ([^,()]+)\)\./g, 'Зогсоол хооронд түлш дор хаяж $1 нэмэгдсэн ($2, $3).'],
  [/Fuel rose by about (.+?) at a short stop \((.+?) → about (.+?) while driving on\)\./g, 'Богино зогсолтын үеэр түлш ойролцоогоор $1 нэмэгдсэн ($2 → цааш явах үед ойролцоогоор $3).'],
  // ---- trailing sentences ----
  [/ ?Possible theft or leak on the way\./g, ' Замд хулгай эсвэл алдагдал гарсан байж болзошгүй.'],
  [/ ?Possible theft or leak\./g, ' Хулгай эсвэл алдагдал байж болзошгүй.'],
  [/ ?Possible theft\./g, ' Хулгай байж болзошгүй.'],
  [/ ?The reading later returned to (.+?), so this was most likely a sensor or tilt artefact, not a loss\./g,
    ' Дараа нь заалт буцаад $1 болсон тул энэ нь алдагдал биш, мэдрэгч эсвэл налуугийн нөлөө байх магадлалтай.'],
  [/ ?Level still down after (\d+) h\./g, ' $1 цагийн дараа ч түвшин сэргээгүй.'],
  // ---- power, speed, idle, night (detector.js / engine.js) ----
  [/External power fell to ([\d.]+) V while driving at (\d+) km\/h - the tracker may have been disconnected\./g,
    'Явж байхад ($2 км/ц) гадаад тэжээл $1 В болж буурсан — трекерийг салгасан байж болзошгүй.'],
  [/External power back at ([\d.]+) V after (.+?)\./g, '$2 дараа гадаад тэжээл дахин $1 В болсон.'],
  [/Up to (\d+) km\/h for (.+?) \(limit (\d+) km\/h\)\./g, '$2 хугацаанд хамгийн ихдээ $1 км/ц хурдтай явсан (хязгаар $3 км/ц).'],
  [/^(\d+) km\/h \(limit (\d+) km\/h\)\.$/g, '$1 км/ц (хязгаар $2 км/ц).'],
  [/Driving at (\d+) km\/h at (\d{1,2}:\d{2}) local time \(quiet hours (.+?)\)\./g, 'Орон нутгийн цагаар $2 үед $1 км/ц хурдтай явсан (амралтын цаг $3).'],
  [/Moving at (\d+) km\/h at (.+?) \(after-hours window (.+?)\)\./g, '$2 үед $1 км/ц хурдтай явсан (ажлын бус цаг $3).'],
  [/Engine running without moving for (.+?)\./g, 'Хөдөлгүүр $1 хугацаанд хөдлөхгүйгээр асаалттай байна.'],
  [/Engine ran without moving for (.+?)\./g, 'Хөдөлгүүр $1 хугацаанд хөдлөхгүйгээр асаалттай байсан.'],
  // ---- fuel level and sensor (detector.js) ----
  [/Fuel is down to (.+?) \(alert below (\d+)%\)\./g, 'Түлш $1 болж багассан ($2%-иас доош бол анхааруулна).'],
  [/Fuel sensor reads normally again \((\d+) mV\) after (.+?) without a valid signal\./g,
    'Түлшний мэдрэгч $2 хугацаанд хүчинтэй дохиогүй байсны дараа дахин хэвийн заах болсон ($1 мВ).'],
  [/The fuel reading slid gradually below the sensor's range \(now (\d+) mV; last trusted level (.+?)\) - the tank is \(nearly\) empty\./g,
    'Түлшний заалт аажмаар мэдрэгчийн хязгаараас доош орсон (одоо $1 мВ; сүүлийн найдвартай түвшин $2) — сав (бараг) хоосон байна.'],
  [/Fuel sensor reads (\d+) mV while the vehicle has power - cut wire, unplugged or failed sensor\./g,
    'Машин тэжээлтэй байхад түлшний мэдрэгч $1 мВ заасан — утас тасарсан, салгасан эсвэл мэдрэгч эвдэрсэн.'],
  [/Last trusted level (.+?)\./g, 'Сүүлийн найдвартай түвшин $1.'],
  [/Fuel reading has stayed at (\d+) mV through (.+?) of driving - sensor disconnected or stuck\./g,
    '$2 явах хугацаанд түлшний заалт $1 мВ дээрээ өөрчлөгдөөгүй — мэдрэгч салсан эсвэл гацсан.'],
  [/Fuel reading is changing again \((\d+) mV\)\./g, 'Түлшний заалт дахин өөрчлөгдөж байна ($1 мВ).'],
  // ---- tracker offline / back online (engine.js) ----
  [/No data for (.+?) \(last report (.+?), (?:moving at (\d+) km\/h|(stopped))\)\./g,
    (_, dur, last, spd) => `${dur} хугацаанд мэдээлэл ирээгүй (сүүлийн мэдээ ${last}, ${spd ? `${spd} км/ц хурдтай явж байсан` : 'зогссон байсан'}).`],
  [/ ?Possible causes: no mobile coverage, tracker unplugged or powered off\./g, ' Боломжит шалтгаан: сүлжээгүй газар, трекерийг салгасан эсвэл унтраасан.'],
  [/No data from (.+?) until (.+?) \((.+?)\)\./g, 'Мэдээлэл ирээгүй хугацаа: $1 – $2 ($3).'],
  [/Reporting again after (.+?) without data \(silent since (.+?)\)\./g, '$1 мэдээлэлгүй байсны дараа дахин мэдээлж эхэлсэн (чимээгүй болсон: $2).'],
  [/Fuel (.+?) before, (.+?) after( \(the vehicle moved meanwhile\))?\./g,
    (_, a, b, moved) => `Түлш өмнө нь ${a}, дараа нь ${b}${moved ? ' (энэ хооронд машин хөдөлсөн)' : ''}.`],
  // ---- fuel receipts (engine.js checkReceipts) ----
  [/Fuel receipt for (.+?) \((.+?)\), but the tank rose only (.+?)(?: \(([^()]+ → [^()]+)\))? at (.+?): (.+?) missing\./g,
    (_, r, when, got, lv, at, miss) => `Түлшний баримт ${r} (${when}), гэвч ${at} үед сав ердөө ${got} нэмэгдсэн${lv ? ` (${lv})` : ''}: ${miss} дутуу.`],
  [/ ?The receipt does not even fit: the tank had room for only (.+?)\./g, ' Баримт савд багтахгүй: сав ердөө $1 сул зайтай байсан.'],
  [/Fuel receipt for (.+?) \((.+?)\), but the fuel sensor shows no refuel (around that time|that day)\./g,
    (_, r, when, w) => `Түлшний баримт ${r} (${when}), гэвч түлшний мэдрэгч ${w === 'that day' ? 'тэр өдөр' : 'тэр үед'} цэнэглэлт харуулаагүй.`],
  // ---- GPS server events (engine.js) ----
  [/Event "(.+?)" reported by the GPS server(?: at (\d+) km\/h)?\./g,
    (_, e, spd) => `GPS сервер “${e}” үйл явдал мэдээлсэн${spd ? ` (${spd} км/ц)` : ''}.`],
  // ---- test notification (notify.js) ----
  [/Fuel Tank Warner notifications are working \((.+?)\)\./g, 'Fuel Tank Warner-ийн мэдэгдэл ажиллаж байна ($1).'],
];
export function mnDetail(detail) {
  if (detail === null || detail === undefined || detail === '') return detail;
  let s = String(detail);
  for (const [re, to] of DETAIL_PATTERNS) {
    re.lastIndex = 0;
    s = s.replace(re, to);
  }
  return mnUnits(s).replace(/\s{2,}/g, ' ').trim();
}

/** A place / level word used by the ledger's "Situation" column etc. is translated where it is made. */
export const mn = { title: mnTitle, detail: mnDetail, units: mnUnits };
