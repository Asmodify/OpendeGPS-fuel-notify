// Автомат шалгалт's verdict (the case's text gets a "Хоёр дахь дүгнэлт" line). On every new
// Автомат шалгалт case and every settled fuel-drop alert, a Claude model reads the case, the
// truck's meter line around it, its own norm, the receipts of that time and how the company's
// people judged earlier alerts, and writes back in Mongolian: likely theft, unclear or likely
// normal, how sure, why, what to check, and a verdict with a short note, the same two buttons a
// person presses (Хулгай батлагдсан / Худал дохио). The engine saves that verdict as the
// officer's (reviewed_by 'officer') only when it is sure enough (OFFICER_VERDICT_MIN, default
// 70 %) and nobody has marked the alert yet; unsure cases stay "Шалгаагүй". A person's click
// always replaces it. The litres and the proof stay the rules' (meter.js / autocheck.js).
//
// Off unless ANTHROPIC_API_KEY is set. Model OFFICER_MODEL (default claude-opus-5-5). At most
// OFFICER_MONTHLY_MAX calls a month (default 200, about 12 USD at worst; a usual month has ~60
// cases and drops, ~3-4 USD).
import Anthropic from '@anthropic-ai/sdk';

export const OFFICER_MODEL = process.env.OFFICER_MODEL || 'claude-opus-5-5';
export const OFFICER_MONTHLY_MAX = Number(process.env.OFFICER_MONTHLY_MAX) > 0 ? Number(process.env.OFFICER_MONTHLY_MAX) : 200;
export const OFFICER_VERDICT_MIN = Number(process.env.OFFICER_VERDICT_MIN) > 0 ? Number(process.env.OFFICER_VERDICT_MIN) : 70;
export const officerOn = () => Boolean(process.env.ANTHROPIC_API_KEY);

export const VIEWS = { likely_theft: 'Хулгай байж магадгүй', unclear: 'Тодорхойгүй', likely_normal: 'Хэвийн байж магадгүй' };

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['view', 'confidence', 'reason', 'checks', 'verdict', 'note'],
  properties: {
    view: { type: 'string', enum: Object.keys(VIEWS) },
    confidence: { type: 'integer', description: '0-100' },
    reason: { type: 'string', description: 'Two or three plain Mongolian Cyrillic sentences' },
    checks: { type: 'array', items: { type: 'string' }, description: 'Up to 3 short things a person should check, Mongolian' },
    verdict: { type: 'string', enum: ['confirmed', 'false_alarm', 'unchecked'] },
    note: { type: 'string', description: 'One short Mongolian Cyrillic note for the case, like a person writes (at most ~120 characters)' },
  },
};

const SYSTEM = `You give a second opinion on fuel cases for a Mongolian coal trucking company (trucks of 500-600 L tanks on routes Таван-толгой → Цагаанхад → Ганцмод, Таван-толгой → Ханги → Мандал, and a short Ханги–Мандал border shuttle that idles about 5 h a trip in the border queue). A rule check (the nightly Автомат шалгалт or the live fuel-drop detector) raised the case below from the tank's fuel sensor and the GPS.

What you are given is the whole evidence: the case, the truck's meter line (litres at rest and while moving, speed, power voltage), its own learned norm (litres a km and litres an idle hour from its clean past days) and the refuel receipts of that time. Judge only from it.

How fuel behaves here: driving burns about 0.7-0.9 L/km on the long routes and more on the shuttle; idling about 4-8 L/h (power above 26.4 V usually means the engine runs); a level read while driving swings with sloshing, the level at rest is the one to trust; a refuel shows as a rise at a stop. Theft looks like a fall at a stop that stays down, a lower level after the GPS went silent, litres on a receipt that never reached the tank, or a fall just after a refuel. Normal looks like a fall that matches the km and idle hours, or a dip that comes back by itself.

Answer with view likely_theft, unclear or likely_normal, a confidence 0-100, a reason of two or three plain sentences in Mongolian Cyrillic that a fleet manager understands (litres and times, no jargon, do not mention AI or models), and up to three short checks (for example who drove, the receipt photo, the camera at that place). Never claim more litres than the case states.

Then give the verdict a reviewer would click, which counts in the company's fuel ledger:
- confirmed (Хулгай батлагдсан): the meter clearly shows fuel that left the tank and nothing in the evidence explains it (no refuel, no matching km or idle hours, no level coming back). Only with view likely_theft.
- false_alarm (Худал дохио): the evidence shows it is normal: burn that matches the km and idle hours, sloshing while driving, a dip that came back, a sensor fault, or the same situation the company's people already marked a false alarm. Only with view likely_normal.
- unchecked: anything you are not sure about, or with view unclear. A person then decides. When in doubt, choose unchecked: a wrong false_alarm hides a theft, a wrong confirmed blames a driver.
The confidence is how sure you are of the verdict. Write the note the way a reviewer writes theirs in a few words (for example "Явж байхад хэвийн зарцуулалт, 120 км-т 95 л" or "Зогсоолд 64 л буурч эргэж ирээгүй"). Earlier verdicts of the company's people, with their notes, are given when there are some: follow their reasoning where the situation matches.`;

let client = null;
function getClient() {
  if (!officerOn()) return null;
  if (!client) client = new Anthropic({ timeout: 180_000, maxRetries: 2 });
  return client;
}

/** The meter line as compact rows for the prompt: [local time, litres, km/h, volts], at most
 *  `max` rows, evenly thinned. */
export function meterLine(rows, toLitres, tzOffsetMin, max = 160) {
  const pick = rows.length > max ? rows.filter((_, i) => i % Math.ceil(rows.length / max) === 0) : rows;
  return pick.map((s) => [
    new Date(s.t + tzOffsetMin * 60e3).toISOString().slice(5, 16).replace('T', ' '),
    Number.isFinite(s.f) ? Math.round(toLitres(s.f) * 10) / 10 : null,
    Math.round(s.spd ?? 0),
    Number.isFinite(s.pwr) ? Math.round(s.pwr / 100) / 10 : null,
  ]);
}

/** One second opinion. input: { name, title, detail, rule, lostL, facts, norm, line, receipts,
 *  meter?, examples? }. Returns { view, label, confidence, reason, checks, verdict, note, model }
 *  or null (off, refused, failed), or { error } when the API call failed. */
export async function secondOpinion(input) {
  const anthropic = getClient();
  if (!anthropic) return null;
  const model = OFFICER_MODEL;
  const fallback = model.startsWith('claude-haiku') ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
  const text = [
    `Truck: ${input.name}`,
    `Case (${input.rule}): ${input.title}. ${input.detail}`,
    `Litres the rules call unexplained: ${input.lostL ?? 'none claimed (a case to look at, not proof)'}`,
    `Facts: ${JSON.stringify(input.facts ?? {})}`,
    `Its own norm: ${input.norm ? `${input.norm.perKm} L/km, ${input.norm.perIdleH} L per idle hour, spread ${input.norm.spread} L a day, from ${input.norm.days} clean days` : 'not learned yet'}`,
    `Refuel receipts of that time: ${JSON.stringify(input.receipts ?? [])}`,
    ...(input.meter ? [`What the fuel meter check says: ${JSON.stringify(input.meter)}`] : []),
    ...(input.examples?.length ? ['Earlier verdicts of the company\'s people [truck, alert, their verdict, their note]:', JSON.stringify(input.examples)] : []),
    'Meter line [local time, litres, km/h, volts]:',
    JSON.stringify(input.line ?? []),
  ].join('\n');
  let res;
  try {
    res = await anthropic.beta.messages.create({
      model,
      max_tokens: 16000,
      ...fallback,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: text }],
    });
  } catch (e) {
    if (e instanceof Anthropic.APIError) return { error: `${e.status} ${e.message}` };
    throw e;
  }
  if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') return null;
  const block = res.content.find((b) => b.type === 'text');
  let out;
  try {
    out = JSON.parse(block?.text || '{}');
  } catch {
    return null;
  }
  if (!VIEWS[out.view]) return null;
  // a verdict must agree with the view (a theft verdict only on likely theft, a false alarm only
  // on likely normal); anything else stays unchecked for a person
  const verdict = (out.verdict === 'confirmed' && out.view === 'likely_theft') || (out.verdict === 'false_alarm' && out.view === 'likely_normal') ? out.verdict : 'unchecked';
  return {
    view: out.view,
    label: VIEWS[out.view],
    confidence: Math.max(0, Math.min(100, Math.round(Number(out.confidence) || 0))),
    reason: String(out.reason || '').trim().slice(0, 800),
    checks: (Array.isArray(out.checks) ? out.checks : []).map((c) => String(c).trim()).filter(Boolean).slice(0, 3),
    verdict,
    note: String(out.note || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    model: res.model || model,
    usage: res.usage ? { in: res.usage.input_tokens, out: res.usage.output_tokens } : null,
  };
}

/** The case's text without an earlier opinion line (before a new one is added). */
export const withoutOpinion = (detail) => String(detail || '').split('\nХоёр дахь дүгнэлт:')[0];

/** The line added to the case's text. */
export function opinionText(o) {
  if (!o?.view) return '';
  return `\nХоёр дахь дүгнэлт: ${o.label} (итгэл ${o.confidence} %). ${o.reason}${o.checks.length ? ` Шалгах: ${o.checks.join('; ')}.` : ''}`;
}
