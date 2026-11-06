// Second opinion on an Автомат шалгалт case (shown as "Хоёр дахь дүгнэлт"). After the nightly
// rules raise a case, a Claude model reads the case, the truck's meter line around it, its own
// norm and the receipts of that time, and writes back in Mongolian: is it likely theft, unclear,
// or likely normal, how sure, why, and what to check. It never marks a case: the litres and the
// proof stay the rules' (meter.js / autocheck.js), and a person still decides.
//
// Off unless ANTHROPIC_API_KEY is set. Model OFFICER_MODEL (default claude-opus-5-5). At most
// OFFICER_MONTHLY_MAX calls a month (default 200, about 12 USD at worst; a usual month has ~30
// cases, ~2 USD).
import Anthropic from '@anthropic-ai/sdk';

export const OFFICER_MODEL = process.env.OFFICER_MODEL || 'claude-opus-5-5';
export const OFFICER_MONTHLY_MAX = Number(process.env.OFFICER_MONTHLY_MAX) > 0 ? Number(process.env.OFFICER_MONTHLY_MAX) : 200;
export const officerOn = () => Boolean(process.env.ANTHROPIC_API_KEY);

export const VIEWS = { likely_theft: 'Хулгай байж магадгүй', unclear: 'Тодорхойгүй', likely_normal: 'Хэвийн байж магадгүй' };

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['view', 'confidence', 'reason', 'checks'],
  properties: {
    view: { type: 'string', enum: Object.keys(VIEWS) },
    confidence: { type: 'integer', description: '0-100' },
    reason: { type: 'string', description: 'Two or three plain Mongolian Cyrillic sentences' },
    checks: { type: 'array', items: { type: 'string' }, description: 'Up to 3 short things a person should check, Mongolian' },
  },
};

const SYSTEM = `You give a second opinion on fuel cases for a Mongolian coal trucking company (trucks of 500-600 L tanks on routes Таван-толгой → Цагаанхад → Ганцмод, Таван-толгой → Ханги → Мандал, and a short Ханги–Мандал border shuttle that idles about 5 h a trip in the border queue). A nightly rule check raised the case below from the tank's fuel sensor and the GPS.

What you are given is the whole evidence: the case, the truck's meter line (litres at rest and while moving, speed, power voltage), its own learned norm (litres a km and litres an idle hour from its clean past days) and the refuel receipts of that time. Judge only from it.

How fuel behaves here: driving burns about 0.7-0.9 L/km on the long routes and more on the shuttle; idling about 4-8 L/h (power above 26.4 V usually means the engine runs); a level read while driving swings with sloshing, the level at rest is the one to trust; a refuel shows as a rise at a stop. Theft looks like a fall at a stop that stays down, a lower level after the GPS went silent, litres on a receipt that never reached the tank, or a fall just after a refuel. Normal looks like a fall that matches the km and idle hours, or a dip that comes back by itself.

Answer with view likely_theft, unclear or likely_normal, a confidence 0-100, a reason of two or three plain sentences in Mongolian Cyrillic that a fleet manager understands (litres and times, no jargon, do not mention AI or models), and up to three short checks (for example who drove, the receipt photo, the camera at that place). Never claim more litres than the case states.`;

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

/** One second opinion. input: { name, title, detail, rule, lostL, facts, norm, line, receipts }.
 *  Returns { view, label, confidence, reason, checks, model } or null (off, refused, failed). */
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
  return {
    view: out.view,
    label: VIEWS[out.view],
    confidence: Math.max(0, Math.min(100, Math.round(Number(out.confidence) || 0))),
    reason: String(out.reason || '').trim().slice(0, 800),
    checks: (Array.isArray(out.checks) ? out.checks : []).map((c) => String(c).trim()).filter(Boolean).slice(0, 3),
    model: res.model || model,
    usage: res.usage ? { in: res.usage.input_tokens, out: res.usage.output_tokens } : null,
  };
}

/** The line added to the case's text. */
export function opinionText(o) {
  if (!o?.view) return '';
  return `\nХоёр дахь дүгнэлт: ${o.label} (итгэл ${o.confidence} %). ${o.reason}${o.checks.length ? ` Шалгах: ${o.checks.join('; ')}.` : ''}`;
}
