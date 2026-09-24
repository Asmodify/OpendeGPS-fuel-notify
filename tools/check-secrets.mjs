// Scans every file that would be committed (respecting .gitignore) for things that must never
// be published: the GPS API key (32 hex characters), tracker IMEIs (15-digit numbers - anyone
// who knows one can send fake positions to the GPS server), the fleet's real vehicle names /
// plates / IMEIs, passwords in URLs, tokens, default passwords and absolute user paths.
//
//   node tools/check-secrets.mjs [folder]      (default: the project folder)
//
// Real names and IMEIs are taken from the local (not published) calibrations.json and, when
// present, an objects list: $FTW_OBJECTS or testdata/objects.json (USER_GET_OBJECTS answer).
// A synthetic test IMEI must contain six equal digits in a row (e.g. 999999051234567).
// A line can be exempted with the comment "check-secrets: allow" (use sparingly).
// Exit code 1 when anything is found.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SELF = path.resolve(fileURLToPath(import.meta.url));
const MAX_BYTES = 5 * 1024 * 1024;

// ---- files that would be committed -------------------------------------------------------
function gitFiles() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) return null;
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.split('\0').filter(Boolean).map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f));
  } catch {
    return null;
  }
}

/** Minimal .gitignore matcher (patterns, dir/, *, **, leading /, negation with !). */
function loadIgnore() {
  const file = path.join(ROOT, '.gitignore');
  const rules = [];
  if (!fs.existsSync(file)) return rules;
  for (let line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    line = line.replace(/\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    let neg = false;
    if (line.startsWith('!')) { neg = true; line = line.slice(1); }
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith('/') || line.includes('/');
    line = line.replace(/^\//, '');
    const re = line.split('**').map((part) => part.split('*').map((p) => p.split('?').map((q) => q.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('[^/]')).join('[^/]*')).join('.*');
    rules.push({ neg, dirOnly, re: new RegExp(anchored ? `^${re}$` : `(^|/)${re}$`) });
  }
  return rules;
}
function ignored(rel, isDir, rules) {
  let out = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.re.test(rel)) out = !r.neg;
  }
  return out;
}
function walkFiles() {
  const rules = loadIgnore();
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      if (ent.name === '.git') continue;
      if (ignored(rel, ent.isDirectory(), rules)) continue;
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) out.push(full);
    }
  };
  walk(ROOT);
  return out;
}

// ---- what to look for ----------------------------------------------------------------------
function readJsonQuiet(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}
const known = new Map(); // literal -> what it is
const plateOf = (name) => String(name || '').split('/')[0].trim();
const addName = (n, what) => { const s = plateOf(n); if (s.length >= 5 && !/^\d+$/.test(s)) known.set(s, what); };
const cal = readJsonQuiet(path.join(ROOT, 'calibrations.json'));
if (cal && cal.vehicles && typeof cal.vehicles === 'object') {
  for (const [imei, v] of Object.entries(cal.vehicles)) {
    if (/^\d{15}$/.test(imei)) known.set(imei, 'real tracker IMEI');
    addName(v && v.name, 'real vehicle name');
  }
}
const objFile = process.env.FTW_OBJECTS || path.join(ROOT, 'testdata', 'objects.json');
const objs = readJsonQuiet(objFile);
if (Array.isArray(objs)) {
  for (const o of objs) {
    if (!o || typeof o !== 'object') continue;
    if (/^\d{15}$/.test(String(o.imei))) known.set(String(o.imei), 'real tracker IMEI');
    addName(o.name, 'real vehicle name');
    addName(o.plate_number, 'real plate number');
  }
}

const PATTERNS = [
  ['API key (32 hex characters)', /(?<![0-9A-Za-z])[0-9A-Fa-f]{32}(?![0-9A-Za-z])/g],
  ['IMEI-like 15-digit number', /(?<![0-9])[0-9]{15}(?![0-9])/g, (m) => !/(\d)\1{5}/.test(m)],
  ['password in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:[^\s@/'"`]{3,}@/gi, (m) => !/:\/\/[^:]+:(\*+|\.\.\.|<[^>]*>|\[[^\]]*\]|password|PASSWORD|YOUR[-_A-Z]*|x+)@/i.test(m)],
  ['JWT / service key', /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/g],
  ['Telegram bot token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g],
  ['default password', new RegExp(['admin', '123'].join(''), 'gi')],
  ['absolute user path', /\b[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[^\\/\s'"`]+|\/home\/[a-z][^/\s'"`]*|\/Users\/[A-Za-z][^/\s'"`]*|AppData[\\/]{1,2}Local[\\/]{1,2}Temp|C--Users-[A-Za-z]/g],
];

// ---- scan ----------------------------------------------------------------------------------------
const files = (gitFiles() || walkFiles()).filter((f) => path.resolve(f) !== SELF);
const hits = [];
const mask = (s) => (s.length <= 8 ? s : `${s.slice(0, 4)}…${s.slice(-2)}`);
for (const file of files) {
  let buf;
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_BYTES) { hits.push({ file, line: 0, kind: `large file (${st.size} bytes) not checked - keep data files out of the repository`, text: '' }); continue; }
    buf = fs.readFileSync(file);
  } catch {
    continue;
  }
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (buf.includes(0)) {
    // binary (xlsx, images, databases): a database or workbook may hold real data
    if (/\.(xlsx|db|sqlite|db-wal|db-shm)$/i.test(rel)) hits.push({ file: rel, line: 0, kind: 'data file (may hold real fleet data)', text: '' });
    continue;
  }
  const lines = buf.toString('utf8').split(/\r?\n/);
  lines.forEach((text, i) => {
    if (text.includes('check-secrets: allow')) return;
    for (const [kind, re, keep] of PATTERNS) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) if (!keep || keep(m[0])) hits.push({ file: rel, line: i + 1, kind, text: mask(m[0]) });
    }
    for (const [lit, what] of known) if (text.includes(lit)) hits.push({ file: rel, line: i + 1, kind: what, text: mask(lit) });
  });
}

if (!known.size) console.warn('note: no calibrations.json / objects list found - real names and IMEIs were not checked by value');
if (hits.length) {
  console.error(`check-secrets: ${hits.length} problem(s) in ${files.length} files:`);
  for (const h of hits) console.error(`  ${h.file}${h.line ? `:${h.line}` : ''}  ${h.kind}${h.text ? `  (${h.text})` : ''}`);
  process.exit(1);
}
console.log(`check-secrets: OK - ${files.length} files checked, ${known.size} real names/IMEIs checked by value`);
