// Self-test for src/xlsx.js. Builds a workbook that exercises every feature (several sheets,
// Mongolian Cyrillic, XML-special and control characters, number formats, date-times across
// midnight UTC vs Ulaanbaatar, empty cells, hyperlinks, booleans, frozen header, AutoFilter,
// totals row, info sheet, 5,000+ rows, columns beyond Z), checks the ZIP/XML structure in JS,
// then (Windows + Excel installed) opens it in a private, hidden Excel instance via COM and
// verifies what Excel reads back. Also checks writeFileAtomic while Excel holds the file open.
//
//   node --no-warnings tools/xlsx-selftest.mjs [outDir] [--no-excel]
//
// Only the Excel instance this test starts is touched; it is always quit (and, as a last
// resort, terminated by its own PID). Other Excel windows the user has open are left alone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { buildXlsx, writeFileAtomic, colName, cellRef, excelSerial } from '../src/xlsx.js';

const args = process.argv.slice(2);
const noExcel = args.includes('--no-excel');
const outDir = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(os.tmpdir(), 'fuel-tank-warner-xlsx-selftest'));
const FILE = path.join(outDir, 'xlsx-selftest.xlsx');
const TZ = 480;
const MIN = 60_000;
let failed = 0;
let passed = 0;

function check(name, ok, info) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info !== undefined ? `  -- ${typeof info === 'string' ? info : JSON.stringify(info)}` : ''}`);
}

const localSerial = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 86_400_000 + 25569;
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-8;

// ---- 1. pure JS helpers -------------------------------------------------------------------
{
  const cols = [[0, 'A'], [25, 'Z'], [26, 'AA'], [51, 'AZ'], [52, 'BA'], [701, 'ZZ'], [702, 'AAA'], [16383, 'XFD']];
  check('colName A..XFD', cols.every(([i, s]) => colName(i) === s), cols.map(([i]) => colName(i)).join(' '));
  check('cellRef (0,0)=A1, (9,26)=AA10', cellRef(0, 0) === 'A1' && cellRef(9, 26) === 'AA10');
  const T1 = Date.UTC(2026, 8, 24, 16, 30); // 00:30 on the 25th in Ulaanbaatar
  check('excelSerial epoch, tz 0', excelSerial(0, 0) === 25569);
  check('excelSerial UB crosses midnight', near(excelSerial(T1, TZ), localSerial(2026, 9, 25, 0, 30)), excelSerial(T1, TZ));
  check('excelSerial local date string', excelSerial('2026-09-25') === localSerial(2026, 9, 25) && near(excelSerial('2026-09-25 13:45'), localSerial(2026, 9, 25, 13, 45)));
  check('excelSerial rejects junk', excelSerial('yesterday') === null && excelSerial(NaN) === null && excelSerial(-3e12) === null);
}

// ---- 2. the test workbook -----------------------------------------------------------------
const T0 = Date.UTC(2026, 8, 24, 15, 59); // 2026-09-24 23:59 UB
const T1 = Date.UTC(2026, 8, 24, 16, 30); // 2026-09-25 00:30 UB (UTC date is still the 24th)
const CYR = 'Шатахуун хулгай — Өвөрхангай, Үүрийн цагаан, ӨҮөү Ёё';
const SPECIAL = 'A & B < C > D " E \' F & amp; &lt;';
const MAP_URL = 'https://maps.google.com/?q=43.123456,104.654321';
const AMP_URL = 'https://example.com/path?a=1&b=2&c=%D0%A8';
const NAMES = ['1111 УНӨ', '2291 УБҮ', '5530 ӨМА', 'Ачааны 12', 'Hino 700'];
const GROUPS = ['Өмнөговь — ҮЙЛДВЭР', 'Улаанбаатар', 'Дархан'];

const theftCols = [
  { header: 'Start time', type: 'datetime' },
  { header: 'Detected at', type: 'datetime' },
  { header: 'Vehicle', type: 'string' },
  { header: 'Group', type: 'string' },
  { header: 'Litres lost', type: 'number', numFmt: '0.0' },
  { header: 'Level before (L)', type: 'number', numFmt: '0' },
  { header: 'Level after (L)', type: 'number', numFmt: '0' },
  { header: 'Situation', type: 'string' },
  { header: 'Duration (min)', type: 'number', numFmt: '0' },
  { header: 'Map', type: 'link' },
  { header: 'Verdict', type: 'string' },
  { header: 'Note', type: 'string' },
  { header: 'Status', type: 'string' },
  { header: 'mV', type: 'number', numFmt: '#,##0' },
  { header: 'IMEI', type: 'string' },
  { header: 'Details', type: 'string', width: 60 },
  { header: 'Alert ID', type: 'number', numFmt: '0' },
];
const theftRows = [
  [T0, T1, NAMES[0], GROUPS[0], 12.34, 250.4, null, 'parked', 31, { text: 'Open map', url: MAP_URL }, 'Confirmed theft', SPECIAL, 'Ongoing', 1234.56, '999999051234567', CYR, 42],
  [T1, T1, 'ctrl', '', 0, 0, 0, 'during trip', 0, { text: 'Amp link', url: AMP_URL }, 'Unchecked', 'bell\x07 nul\x00 vt\x0B esc\x1B c1\x85 ok', 'Closed', -5.26, '0012345', 'x_x0041_y _X00e9_', 43],
  [T1, undefined, '  lead and trail  ', 'line1\nline2\r\nline3', null, null, null, '⛽ 🚚 fuel', null, 'javascript:alert(1)', 'False alarm', 'a\uD800b\uDFFFc', '=1+1', 7, 999999051234567, 'tab\there', 44],
];
const BULK = 5200;
for (let i = 0; i < BULK; i++) {
  const t = T1 - (i + 1) * 37 * MIN;
  theftRows.push([
    t - 20 * MIN, t, NAMES[i % NAMES.length], GROUPS[i % GROUPS.length],
    i % 7 === 0 ? null : Math.round(((i * 1.7) % 300) * 10) / 10, 200 + (i % 50), 150 + (i % 40), i % 2 ? 'parked' : 'master switch off',
    20 + (i % 30), { text: 'Open map', url: `https://maps.google.com/?q=${(43 + i / 1e4).toFixed(6)},${(104 + i / 1e4).toFixed(6)}` },
    'Unchecked', i % 11 === 0 ? `Тэмдэглэл ${i}` : null, i % 3 ? 'Closed' : 'Cancelled — level came back', i * 3,
    String(862095050000000 + i), `Drain of ${i * 3} mV at ${NAMES[i % NAMES.length]}`, 1000 + i,
  ]);
}
const lastTheft = theftRows[theftRows.length - 1];
const theftLinks = theftRows.filter((r) => r[9] && typeof r[9] === 'object').length;

const wideCols = Array.from({ length: 32 }, (_, i) => ({ header: `C${i + 1}` }));
wideCols[0] = { header: 'C1', type: 'date' };
wideCols[1] = { header: 'C2', type: 'bool' };
wideCols[2] = { header: 'C3' };
const wideRows = [1, 2, 3].map((r) => wideCols.map((_, c) => `r${r}c${c + 1}`));
wideRows[0][0] = '2026-09-25';
wideRows[1][0] = Date.UTC(2026, 8, 25, 16, 0); // UB midnight starting the 26th
wideRows[2][0] = Date.UTC(2026, 8, 26, 3, 15); // 11:15 on the 26th in UB -> date only
wideRows[0][1] = true;
wideRows[1][1] = false;
wideRows[2][1] = 1;
wideRows[0][2] = 3.14159;
wideRows[1][2] = 'text in general col';
wideRows[2][2] = null;

const sheets = [
  { name: 'Thefts', columns: theftCols, rows: theftRows, freezeHeader: true, autoFilter: true, tabColor: 'C00000' },
  { name: 'Wide', columns: wideCols, rows: wideRows, freezeHeader: true, autoFilter: true },
  {
    name: 'By vehicle',
    columns: [{ header: 'Vehicle', type: 'string' }, { header: 'Group', type: 'string' }, { header: 'Litres', type: 'number', numFmt: '#,##0.0' }, { header: 'Count', type: 'number', numFmt: '0' }],
    rows: [[NAMES[0], GROUPS[0], 1000.25, 10], [NAMES[1], GROUPS[1], 200, 5], [NAMES[2], null, 34.25, 2]],
    totalRow: ['TOTAL', null, 1234.5, 17],
    freezeHeader: true,
    autoFilter: true,
  },
  { name: 'Түлш ӨҮ', columns: [{ header: 'Нэр' }, { header: 'Литр', type: 'number', numFmt: '0.0' }], rows: [['Өглөө', 55.55], ['Үдэш', 0.04]] },
  { name: 'Bad/Name?*[x]: very long name exceeding thirty-one chars', columns: [{ header: 'a' }, { header: 'b' }, { header: 'c' }], rows: [], freezeHeader: true, autoFilter: true },
  { name: 'THEFTS', columns: [{ header: 'dup' }], rows: [['x']] },
  {
    name: 'About',
    titleLines: [
      'Fuel ledger — Түлшний бүртгэл',
      'Generated at 2026-09-25 00:30 (Ulaanbaatar time)',
      '',
      { text: 'Sheets', bold: true },
      { text: 'This is a long explanation line that is wrapped. '.repeat(6).trim(), wrap: true },
      { text: 'Open the project page', url: 'https://maps.google.com/?q=47.918,106.917' },
      'This file is rewritten automatically — add notes in the dashboard.',
    ],
  },
];
const EXPECTED_NAMES = ['Thefts', 'Wide', 'By vehicle', 'Түлш ӨҮ', 'Bad_Name___x__ very long name e', 'THEFTS (2)', 'About'];

const t0 = performance.now();
const buf = buildXlsx(sheets, { tzOffsetMinutes: TZ, creator: 'Fuel Tank Warner', title: 'xlsx selftest — Түлш' });
check(`build ${sheets.length} sheets, ${theftRows.length} theft rows`, Buffer.isBuffer(buf) && buf.length > 10_000, `${(buf.length / 1024).toFixed(0)} KB in ${(performance.now() - t0).toFixed(0)} ms`);

// ---- 3. ZIP + XML structure (independent reader) --------------------------------------------
function unzip(b) {
  const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('no end of central directory');
  const n = b.readUInt16LE(eocd + 10);
  const cdSize = b.readUInt32LE(eocd + 12);
  const cdOff = b.readUInt32LE(eocd + 16);
  if (cdOff + cdSize !== eocd) throw new Error('central directory size/offset mismatch');
  const out = new Map();
  let p = cdOff;
  for (let i = 0; i < n; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central header ${i}`);
    const flags = b.readUInt16LE(p + 8);
    const crc = b.readUInt32LE(p + 16);
    const csize = b.readUInt32LE(p + 20);
    const usize = b.readUInt32LE(p + 24);
    const nlen = b.readUInt16LE(p + 28);
    const elen = b.readUInt16LE(p + 30);
    const clen = b.readUInt16LE(p + 32);
    const off = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nlen);
    if (!(flags & 0x0800)) throw new Error(`${name}: UTF-8 flag missing`);
    if (b.readUInt32LE(off) !== 0x04034b50) throw new Error(`${name}: bad local header`);
    if (b.readUInt32LE(off + 14) !== crc || b.readUInt32LE(off + 18) !== csize) throw new Error(`${name}: local/central header mismatch`);
    const start = off + 30 + b.readUInt16LE(off + 26) + b.readUInt16LE(off + 28);
    const raw = zlib.inflateRawSync(b.subarray(start, start + csize));
    if (raw.length !== usize) throw new Error(`${name}: size mismatch`);
    if ((zlib.crc32(raw) >>> 0) !== crc) throw new Error(`${name}: CRC mismatch`);
    out.set(name, raw.toString('utf8'));
    p += 46 + nlen + elen + clen;
  }
  return out;
}

/** Small well-formedness check: balanced tags, quoted attributes, no raw '<' '>' '&' or control chars in text. */
function xmlProblem(xml) {
  if (!xml.startsWith('<?xml version="1.0" encoding="UTF-8"')) return 'missing XML declaration';
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/.test(xml)) return 'illegal control character';
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(xml)) return 'lone surrogate';
  if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(xml)) return 'bare &';
  const stack = [];
  const re = /<[^<>]*>/g;
  let last = 0;
  let m;
  while ((m = re.exec(xml))) {
    const between = xml.slice(last, m.index);
    if (/[<>]/.test(between)) return `raw < or > in text near ${m.index}`;
    last = re.lastIndex;
    const tag = m[0];
    if (tag.startsWith('<?')) continue;
    if (tag.startsWith('</')) {
      const name = tag.slice(2, -1).trim();
      if (stack.pop() !== name) return `mismatched </${name}> at ${m.index}`;
      continue;
    }
    if (!/^<[A-Za-z_][\w:.-]*(\s+[\w:.-]+="[^"<>]*")*\s*\/?>$/.test(tag)) return `bad tag ${tag.slice(0, 80)}`;
    if (!tag.endsWith('/>')) stack.push(/^<([^\s/>]+)/.exec(tag)[1]);
  }
  if (/[<>]/.test(xml.slice(last))) return 'trailing raw < or >';
  return stack.length ? `unclosed <${stack.pop()}>` : null;
}

let parts = null;
try {
  parts = unzip(buf);
  check('zip: CRCs, sizes, UTF-8 names, central directory', true, `${parts.size} parts`);
} catch (e) {
  check('zip: CRCs, sizes, UTF-8 names, central directory', false, e.message);
}
if (parts) {
  const need = ['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'docProps/app.xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels',
    'xl/styles.xml', 'xl/sharedStrings.xml', ...sheets.map((_, i) => `xl/worksheets/sheet${i + 1}.xml`), 'xl/worksheets/_rels/sheet1.xml.rels'];
  check('all required parts present', need.every((n) => parts.has(n)), need.filter((n) => !parts.has(n)));
  const bad = [...parts].map(([n, x]) => [n, xmlProblem(x)]).filter(([, p]) => p);
  check('every part is well-formed XML', bad.length === 0, bad.length ? bad : undefined);
  const s1 = parts.get('xl/worksheets/sheet1.xml');
  const last = theftRows.length + 1;
  check('sheet1 frozen pane + autoFilter ref', s1.includes('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>') && s1.includes(`<autoFilter ref="A1:Q${last}"/>`));
  const rels = parts.get('xl/worksheets/_rels/sheet1.xml.rels');
  check('hyperlink relationships (one per link, & escaped)', (rels.match(/<Relationship /g) || []).length === theftLinks && rels.includes('a=1&amp;b=2') && !rels.includes('javascript:'));
  const sst = parts.get('xl/sharedStrings.xml');
  check('literal _x0041_ protected in shared strings', sst.includes('x_x005F_x0041_y _x005F_X00e9_'));
  check('xml:space="preserve" for edge whitespace', sst.includes('<t xml:space="preserve">  lead and trail  </t>'));
  const wbx = parts.get('xl/workbook.xml');
  check('workbook: _FilterDatabase + Print_Titles defined names', wbx.includes(`<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'Thefts'!$A$1:$Q$${last}</definedName>`)
    && wbx.includes(`<definedName name="_xlnm.Print_Titles" localSheetId="0">'Thefts'!$1:$1</definedName>`));
  check('sheet names sanitised / de-duplicated in workbook.xml', EXPECTED_NAMES.every((n) => wbx.includes(`name="${n.replace(/&/g, '&amp;')}"`)));
}
{
  let p;
  try {
    p = unzip(buildXlsx([]));
  } catch (e) {
    p = null;
  }
  check('empty input still gives a valid 1-sheet workbook', p && p.has('xl/worksheets/sheet1.xml') && [...p.values()].every((x) => !xmlProblem(x)));
}

// ---- 4. writeFileAtomic basics -------------------------------------------------------------
fs.mkdirSync(outDir, { recursive: true });
const TMP_PREFIX = `.${path.basename(FILE)}.`; // writeFileAtomic's temp files for FILE
fs.rmSync(FILE, { force: true });
const tmpLeft = () => fs.readdirSync(outDir).filter((f) => f.startsWith(TMP_PREFIX) && f.endsWith('.tmp'));
for (const f of tmpLeft()) fs.rmSync(path.join(outDir, f), { force: true });
await writeFileAtomic(FILE, buf);
check('writeFileAtomic writes the file', fs.readFileSync(FILE).equals(buf) && tmpLeft().length === 0, FILE);
{
  const blocker = path.join(outDir, 'not-a-dir.flag');
  fs.writeFileSync(blocker, 'x');
  let err = null;
  try {
    await writeFileAtomic(path.join(blocker, 'x.xlsx'), buf);
  } catch (e) {
    err = e;
  }
  check('non-lock errors pass through unchanged', err && err.code !== 'LOCKED', err?.code);
  fs.rmSync(blocker, { force: true });
}
{
  // a file marked read-only is not "open in Excel": closing Excel would not help
  const ro = path.join(outDir, 'read-only.xlsx');
  fs.rmSync(ro, { force: true });
  await writeFileAtomic(ro, buf);
  fs.chmodSync(ro, 0o444);
  let err = null;
  try {
    await writeFileAtomic(ro, Buffer.from('changed'));
  } catch (e) {
    err = e;
  }
  const same = fs.readFileSync(ro).equals(buf);
  const left = fs.readdirSync(outDir).filter((f) => f.startsWith('.read-only.xlsx.') && f.endsWith('.tmp'));
  check('read-only target -> code READONLY (not LOCKED), file unchanged, no temp left',
    err?.code === 'READONLY' && /read-only/i.test(err.message) && same && left.length === 0, `${err?.code}: ${err?.message}`);
  fs.chmodSync(ro, 0o666);
  await writeFileAtomic(ro, buf);
  check('after clearing read-only the write succeeds', fs.readFileSync(ro).equals(buf));
  fs.rmSync(ro, { force: true });
}
{
  // printing: fitToWidth -> one page wide; orientation
  const p = unzip(buildXlsx([
    { name: 'Fit', columns: [{ header: 'A' }], rows: [['x']], fitToWidth: true },
    { name: 'Info', titleLines: ['Title', 'line'], orientation: 'portrait', fitToWidth: true, tabColor: '00AA00' },
    { name: 'Plain', columns: [{ header: 'A' }], rows: [['x']] },
  ]));
  const s1 = p.get('xl/worksheets/sheet1.xml');
  const s2 = p.get('xl/worksheets/sheet2.xml');
  const s3 = p.get('xl/worksheets/sheet3.xml');
  check('fitToWidth: pageSetUpPr fitToPage + fitToWidth=1 fitToHeight=0 (landscape table)',
    s1.includes('<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>') && s1.includes('<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>'));
  check('info sheet: tabColor before pageSetUpPr, portrait',
    s2.includes('<sheetPr><tabColor rgb="FF00AA00"/><pageSetUpPr fitToPage="1"/></sheetPr>') && s2.includes('<pageSetup orientation="portrait" fitToWidth="1" fitToHeight="0"/>'));
  check('plain table: landscape, no fit', !s3.includes('sheetPr') && s3.includes('<pageSetup orientation="landscape"/>'));
  check('print setup parts are well-formed', [s1, s2, s3].every((x) => !xmlProblem(x)));
}

// ---- 5. real Excel -------------------------------------------------------------------------
const PS = String.raw`
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
$file = $env:XLSX_FILE; $sync = $env:XLSX_SYNC
function Say($s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }
function WaitFlag($name) {
  $f = Join-Path $sync $name; $until = (Get-Date).AddSeconds(120)
  while (-not (Test-Path $f)) { if ((Get-Date) -gt $until) { throw "timeout waiting for $name" }; Start-Sleep -Milliseconds 100 }
}
function Rel($o) { if ($null -ne $o) { try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($o) } catch {} } }
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class XlsxSelftestW32 { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); }
'@
$xl = $null; $wbs = $null
function OpenNamed($path, $readOnly) {
  # CorruptLoad = 0 (xlNormalLoad): a file that needs repair makes Open throw instead of silently repairing
  [System.__ComObject].InvokeMember('Open', [Reflection.BindingFlags]::InvokeMethod, $null, $wbs,
    [object[]]@($path, 0, $readOnly, 0), $null, $null, [string[]]@('Filename', 'UpdateLinks', 'ReadOnly', 'CorruptLoad'))
}
function ProbeCells($wb, $spec) {
  $cells = [ordered]@{}
  foreach ($p in $spec.PSObject.Properties) {
    $ws = $wb.Worksheets.Item($p.Name)
    foreach ($a in $p.Value) {
      $c = $ws.Range($a); $v = $c.Value2
      $o = [ordered]@{ v = $v; t = $c.Text; f = $c.NumberFormat; b = $c.Font.Bold; sz = $c.Font.Size; u = $c.Font.Underline; wrap = $c.WrapText; h = $c.RowHeight; w = $c.ColumnWidth; formula = $c.HasFormula; link = $null }
      if ($v -is [double]) { $o.vr = $v.ToString('R', [Globalization.CultureInfo]::InvariantCulture) }
      if ($c.Hyperlinks.Count -gt 0) { $o.link = $c.Hyperlinks.Item(1).Address }
      $cells["$($p.Name)!$a"] = $o
      Rel $c
    }
    Rel $ws
  }
  return $cells
}
try {
  $xl = New-Object -ComObject Excel.Application
  $xl.DisplayAlerts = $false; $xl.Visible = $false; $xl.ScreenUpdating = $false
  $xpid = 0; [void][XlsxSelftestW32]::GetWindowThreadProcessId([IntPtr]$xl.Hwnd, [ref]$xpid)
  Say "PID $xpid"
  $wbs = $xl.Workbooks
  $r = [ordered]@{ version = $xl.Version; decSep = $xl.International(3); thouSep = $xl.International(4); openPlain = $false; openNamed = $false; errors = @() }

  # 1) plain Open (CorruptLoad default), read-only
  try { $wb = $wbs.Open($file, 0, $true); $r.openPlain = $true; $r.plainSheetCount = $wb.Worksheets.Count; $wb.Close($false); Rel $wb }
  catch { $r.errors += "plain open: $($_.Exception.Message)" }

  # 2) Open with explicit CorruptLoad = xlNormalLoad, read-only; inspect everything
  $wb = OpenNamed $file $true
  $r.openNamed = $true
  $r.sheetCount = $wb.Worksheets.Count
  $r.sheetNames = @(foreach ($s in $wb.Worksheets) { $s.Name; Rel $s })
  $r.caption = $wb.Windows.Item(1).Caption
  $sheets = [ordered]@{}
  foreach ($s in $wb.Worksheets) {
    $s.Activate()
    $win = $wb.Windows.Item(1)
    $info = [ordered]@{ usedRows = $s.UsedRange.Rows.Count; usedCols = $s.UsedRange.Columns.Count; freeze = $win.FreezePanes; splitRow = $win.SplitRow; splitCol = $win.SplitColumn; filterMode = $s.AutoFilterMode; filterRange = $null; links = $s.Hyperlinks.Count; tab = $s.Tab.Color }
    if ($s.AutoFilterMode) { $info.filterRange = $s.AutoFilter.Range.Address($true, $true) }
    $sheets[$s.Name] = $info
    Rel $win; Rel $s
  }
  $r.sheets = $sheets
  $r.cells = ProbeCells $wb ($env:XLSX_PROBES | ConvertFrom-Json)
  $wb.Close($false); Rel $wb
  [IO.File]::WriteAllText((Join-Path $sync 'result1.json'), ($r | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
  Say 'VERIFIED'

  # 3) lock test: open for editing and hold it until the test says so
  $wb = OpenNamed $file $false
  Say "OPENED readonly=$($wb.ReadOnly)"
  WaitFlag 'close.flag'
  $wb.Close($false); Rel $wb
  Say 'CLOSED'

  # 4) re-open the replaced file and read the marker
  WaitFlag 'reverify.flag'
  $wb = OpenNamed $file $true
  $r2 = [ordered]@{ sheetNames = @(foreach ($s in $wb.Worksheets) { $s.Name; Rel $s }); cells = (ProbeCells $wb ($env:XLSX_PROBES2 | ConvertFrom-Json)) }
  $wb.Close($false); Rel $wb
  [IO.File]::WriteAllText((Join-Path $sync 'result2.json'), ($r2 | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
  Say 'REVERIFIED'
} catch {
  Say "ERROR $($_.Exception.Message)"
} finally {
  if ($null -ne $xl) {
    try { foreach ($w in @($xl.Workbooks)) { $w.Close($false); Rel $w } } catch {}
    Rel $wbs
    try { $xl.Quit() } catch {}
    Rel $xl; $xl = $null
    [GC]::Collect(); [GC]::WaitForPendingFinalizers(); [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  }
  Say 'QUIT'
}
`;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function excelTests() {
  const sync = path.join(outDir, 'xlsx-selftest-sync');
  fs.rmSync(sync, { recursive: true, force: true });
  fs.mkdirSync(sync, { recursive: true });
  const last = theftRows.length + 1;
  const probes = {
    Thefts: ['A1', 'Q1', 'A2', 'B2', 'C2', 'D2', 'E2', 'F2', 'G2', 'J2', 'K2', 'L2', 'N2', 'O2', 'P2', 'Q2',
      'C3', 'D3', 'J3', 'L3', 'N3', 'O3', 'P3', 'B4', 'C4', 'D4', 'H4', 'J4', 'L4', 'M4', 'O4', 'P4', `A${last}`, `B${last}`, `C${last}`, `E${last}`, `J${last}`, `O${last}`, `Q${last}`],
    Wide: ['A1', 'Z1', 'AA1', 'AD1', 'AF1', 'A2', 'A3', 'A4', 'B2', 'B3', 'B4', 'C2', 'C3', 'C4', 'AF4'],
    'By vehicle': ['A1', 'A4', 'C4', 'D3', 'A5', 'C5', 'A6', 'C6', 'D6'],
    'Түлш ӨҮ': ['A1', 'A2', 'B2', 'B3'],
    About: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'],
  };
  const MARKER = 'Second version ✓ — Өө Үү';
  const probes2 = { Marker: ['A1', 'A2', 'B2'] };
  const buf2 = buildXlsx([{ name: 'Marker', columns: [{ header: 'Marker' }, { header: 'When', type: 'datetime' }], rows: [[MARKER, T1]], freezeHeader: true }], { tzOffsetMinutes: TZ });

  const encoded = Buffer.from(PS, 'utf16le').toString('base64');
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    env: { ...process.env, XLSX_FILE: FILE, XLSX_SYNC: sync, XLSX_PROBES: JSON.stringify(probes), XLSX_PROBES2: JSON.stringify(probes2) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let excelPid = null;
  const lines = [];
  const waiters = [];
  let stderr = '';
  let buffered = '';
  ps.stdout.setEncoding('utf8');
  ps.stdout.on('data', (d) => {
    buffered += d;
    let i;
    while ((i = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, i).trim();
      buffered = buffered.slice(i + 1);
      if (!line) continue;
      lines.push(line);
      const pm = /^PID (\d+)/.exec(line);
      if (pm) excelPid = +pm[1];
      for (const w of [...waiters]) if (line.startsWith(w.prefix) || line.startsWith('ERROR') || line === 'QUIT') { waiters.splice(waiters.indexOf(w), 1); w.resolve(line); }
    }
  });
  ps.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((r) => ps.on('exit', r));
  const waitLine = (prefix, ms = 180_000) => {
    const hit = lines.find((l) => l.startsWith(prefix) || l.startsWith('ERROR'));
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => {
      const w = { prefix, resolve };
      waiters.push(w);
      setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); resolve('TIMEOUT'); } }, ms);
    });
  };
  const readJson = (f) => JSON.parse(fs.readFileSync(path.join(sync, f), 'utf8'));

  try {
    const v = await waitLine('VERIFIED');
    check('Excel COM run reached verification', v === 'VERIFIED', v === 'VERIFIED' ? `Excel PID ${excelPid}` : `${v} ${stderr.slice(0, 400)}`);
    if (v !== 'VERIFIED') return;
    const r = readJson('result1.json');
    const cell = (k) => r.cells[k] || {};
    const loc = (s) => s.replace(/[,.]/g, (ch) => (ch === ',' ? '\u0000' : '\u0001')).replace(/\u0000/g, r.thouSep).replace(/\u0001/g, r.decSep);
    console.log(`      Excel ${r.version}, separators decimal "${r.decSep}" thousands "${r.thouSep}"`);

    check('opens with default Open() (no repair, no error)', r.openPlain === true && r.plainSheetCount === 7, r.errors.length ? r.errors : undefined);
    check('opens with CorruptLoad=xlNormalLoad (throws if repair needed)', r.openNamed === true, r.caption);
    check('caption has no [Repaired] marker', !/repair/i.test(r.caption || ''), r.caption);
    check('7 sheets with expected names', r.sheetCount === 7 && JSON.stringify(r.sheetNames) === JSON.stringify(EXPECTED_NAMES), r.sheetNames);

    // Thefts sheet: structure
    const th = r.sheets.Thefts;
    check('Thefts: 5,000+ rows all present', th.usedRows === last && th.usedCols === 17, { usedRows: th.usedRows, usedCols: th.usedCols });
    check('Thefts: header frozen (SplitRow 1)', th.freeze === true && th.splitRow === 1 && th.splitCol === 0, { freeze: th.freeze, splitRow: th.splitRow });
    check('Thefts: AutoFilter over header+data', th.filterMode === true && th.filterRange === `$A$1:$Q$${last}`, th.filterRange);
    check('Thefts: hyperlink count', th.links === theftLinks, th.links);
    check('Thefts: header bold, filled', cell('Thefts!A1').b === true && cell('Thefts!A1').v === 'Start time' && cell('Thefts!Q1').v === 'Alert ID');
    // datetimes across midnight
    const a2 = cell('Thefts!A2');
    const b2 = cell('Thefts!B2');
    check('datetime 15:59Z -> UB 2026-09-24 23:59 (serial + text + format)', near(a2.v, localSerial(2026, 9, 24, 23, 59)) && a2.t === '2026-09-24 23:59' && a2.f === 'yyyy-mm-dd hh:mm', { v: a2.vr, t: a2.t, f: a2.f });
    check('datetime 16:30Z -> UB 2026-09-25 00:30 (crosses midnight)', near(b2.v, localSerial(2026, 9, 25, 0, 30)) && b2.t === '2026-09-25 00:30', { v: b2.vr, expected: localSerial(2026, 9, 25, 0, 30), t: b2.t });
    check('datetime column wide enough (no ####)', !a2.t.includes('#') && a2.w >= 16, a2.w);
    // text
    check('Cyrillic vehicle/group round-trip exactly', cell('Thefts!C2').v === NAMES[0] && cell('Thefts!D2').v === GROUPS[0], [cell('Thefts!C2').v, cell('Thefts!D2').v]);
    check('Cyrillic long text (Ө Ү ө ү Ё) exact', cell('Thefts!P2').v === CYR, cell('Thefts!P2').v);
    check('& < > " \' round-trip exactly', cell('Thefts!L2').v === SPECIAL, cell('Thefts!L2').v);
    check('control chars stripped (C0 + C1)', cell('Thefts!L3').v === 'bell nul vt esc c1 ok', cell('Thefts!L3').v);
    check('literal _x0041_ / _X00e9_ not decoded by Excel', cell('Thefts!P3').v === 'x_x0041_y _X00e9_', cell('Thefts!P3').v);
    check('leading/trailing spaces preserved', cell('Thefts!C4').v === '  lead and trail  ', JSON.stringify(cell('Thefts!C4').v));
    check('line breaks preserved (CRLF -> LF)', cell('Thefts!D4').v === 'line1\nline2\nline3', JSON.stringify(cell('Thefts!D4').v));
    check('emoji (surrogate pairs) preserved', cell('Thefts!H4').v === '⛽ 🚚 fuel', cell('Thefts!H4').v);
    check('lone surrogates stripped', cell('Thefts!L4').v === 'abc', JSON.stringify(cell('Thefts!L4').v));
    check('"=1+1" stays text, not a formula', cell('Thefts!M4').v === '=1+1' && cell('Thefts!M4').formula === false, cell('Thefts!M4'));
    check('IMEI in string column stays text', cell('Thefts!O2').v === '999999051234567' && cell('Thefts!O3').v === '0012345' && cell('Thefts!O4').v === '999999051234567', [cell('Thefts!O2').v, cell('Thefts!O3').v, cell('Thefts!O4').v]);
    check('tab inside text preserved', cell('Thefts!P4').v === 'tab\there', JSON.stringify(cell('Thefts!P4').v));
    // numbers
    check('number 0.0 format: 12.34 -> "12.3"', cell('Thefts!E2').v === 12.34 && cell('Thefts!E2').t === loc('12.3') && cell('Thefts!E2').f === '0.0', cell('Thefts!E2').t);
    check('number 0 format: 250.4 -> "250"', cell('Thefts!F2').v === 250.4 && cell('Thefts!F2').t === '250');
    check('number #,##0: 1234.56 -> "1,235"', cell('Thefts!N2').v === 1234.56 && cell('Thefts!N2').t === loc('1,235') && cell('Thefts!N2').f === '#,##0', cell('Thefts!N2').t);
    check('negative number -5.26 -> "-5"', cell('Thefts!N3').v === -5.26 && cell('Thefts!N3').t === '-5', cell('Thefts!N3').t);
    check('empty cells (null / undefined / "") are empty', cell('Thefts!G2').v === null && cell('Thefts!B4').v === null && cell('Thefts!D3').v === null && cell('Thefts!C3').v === 'ctrl',
      [cell('Thefts!G2').v, cell('Thefts!B4').v, cell('Thefts!D3').v]);
    // links
    check('hyperlink address + text', cell('Thefts!J2').link === MAP_URL && cell('Thefts!J2').v === 'Open map' && cell('Thefts!J2').u !== -4142, { link: cell('Thefts!J2').link, text: cell('Thefts!J2').v, underline: cell('Thefts!J2').u });
    check('hyperlink with & and %-escapes', cell('Thefts!J3').link === AMP_URL, cell('Thefts!J3').link);
    check('javascript: URL written as plain text, no link', cell('Thefts!J4').v === 'javascript:alert(1)' && cell('Thefts!J4').link === null);
    // last bulk row
    const lr = (c) => cell(`Thefts!${c}${last}`);
    check(`last row ${last} values`, near(lr('A').v, excelSerial(lastTheft[0], TZ)) && lr('C').v === lastTheft[2] && lr('E').v === lastTheft[4]
      && lr('J').link === lastTheft[9].url && lr('O').v === lastTheft[14] && lr('Q').v === lastTheft[16],
      { A: lr('A').t, C: lr('C').v, E: lr('E').v, J: lr('J').link, O: lr('O').v, Q: lr('Q').v });

    // Wide sheet: columns beyond Z, date, bool, general
    const w = r.sheets.Wide;
    check('Wide: 32 columns, headers beyond Z', w.usedCols === 32 && cell('Wide!Z1').v === 'C26' && cell('Wide!AA1').v === 'C27' && cell('Wide!AD1').v === 'C30' && cell('Wide!AF1').v === 'C32' && cell('Wide!AF4').v === 'r3c32',
      { Z1: cell('Wide!Z1').v, AA1: cell('Wide!AA1').v, AD1: cell('Wide!AD1').v, AF4: cell('Wide!AF4').v });
    check('Wide: AutoFilter to AF', w.filterRange === '$A$1:$AF$4', w.filterRange);
    check('date type: "2026-09-25" -> serial 46290 "2026-09-25"', cell('Wide!A2').v === localSerial(2026, 9, 25) && cell('Wide!A2').t === '2026-09-25' && cell('Wide!A2').f === 'yyyy-mm-dd', { v: cell('Wide!A2').v, t: cell('Wide!A2').t });
    check('date type: UB midnight instant -> 2026-09-26', cell('Wide!A3').v === localSerial(2026, 9, 26) && cell('Wide!A3').t === '2026-09-26', cell('Wide!A3').t);
    check('date type drops time of day', cell('Wide!A4').v === localSerial(2026, 9, 26) && cell('Wide!A4').t === '2026-09-26', cell('Wide!A4').vr);
    check('bool cells TRUE/FALSE', cell('Wide!B2').v === true && cell('Wide!B3').v === false && cell('Wide!B4').v === true, [cell('Wide!B2').t, cell('Wide!B3').t, cell('Wide!B4').t]);
    check('untyped column infers number/text/empty', cell('Wide!C2').v === 3.14159 && cell('Wide!C3').v === 'text in general col' && cell('Wide!C4').v === null);

    // totals row
    const bv = r.sheets['By vehicle'];
    check('By vehicle: AutoFilter excludes TOTAL row', bv.filterRange === '$A$1:$D$4', bv.filterRange);
    check('TOTAL row (after one blank row) bold with formatted numbers', cell('By vehicle!A5').v === null && cell('By vehicle!C5').v === null
      && cell('By vehicle!A6').v === 'TOTAL' && cell('By vehicle!A6').b === true && cell('By vehicle!C6').b === true
      && cell('By vehicle!C6').v === 1234.5 && cell('By vehicle!C6').t === loc('1,234.5') && cell('By vehicle!D6').v === 17 && cell('By vehicle!A4').b === false,
      { A5: cell('By vehicle!A5').v, A6: cell('By vehicle!A6').v, C6: cell('By vehicle!C6').t, bold: cell('By vehicle!C6').b });
    check('data rows not bold', cell('By vehicle!C4').b === false && cell('By vehicle!C4').t === loc('34.3'), cell('By vehicle!C4').t);

    // Cyrillic sheet name, default (no freeze / filter)
    const cy = r.sheets['Түлш ӨҮ'];
    check('Cyrillic sheet name + values', cy && cell('Түлш ӨҮ!A1').v === 'Нэр' && cell('Түлш ӨҮ!A2').v === 'Өглөө' && cell('Түлш ӨҮ!B3').t === loc('0.0'), cell('Түлш ӨҮ!A2').v);
    check('freeze/filter off unless asked', cy && cy.freeze === false && cy.filterMode === false);
    const bad = r.sheets[EXPECTED_NAMES[4]];
    check('empty table sheet: header-only filter + freeze', bad && bad.filterRange === '$A$1:$C$1' && bad.freeze === true && bad.usedRows === 1, bad);

    // info sheet
    const ab = r.sheets.About;
    check('About: title line bold 14pt', cell('About!A1').v === 'Fuel ledger — Түлшний бүртгэл' && cell('About!A1').b === true && cell('About!A1').sz === 14, cell('About!A1'));
    check('About: plain / blank / bold heading lines', cell('About!A2').b === false && cell('About!A3').v === null && cell('About!A4').v === 'Sheets' && cell('About!A4').b === true);
    check('About: wrapped line auto-heights', cell('About!A5').wrap === true && cell('About!A5').h > 15, { h: cell('About!A5').h, w: cell('About!A5').w });
    check('About: link line', cell('About!A6').link === 'https://maps.google.com/?q=47.918,106.917' && ab.links === 1);
    check('About: no freeze, no filter', ab.freeze === false && ab.filterMode === false);

    // ---- lock behaviour --------------------------------------------------------------------
    const opened = await waitLine('OPENED');
    check('Excel holds the file open for editing', opened.startsWith('OPENED') && opened.includes('readonly=False'), opened);
    if (!opened.startsWith('OPENED')) return;
    await sleep(500);
    const before = fs.readFileSync(FILE);
    let err = null;
    const tLock = performance.now();
    try {
      await writeFileAtomic(FILE, buf2);
    } catch (e) {
      err = e;
    }
    check('writeFileAtomic while open in Excel -> code LOCKED', err?.code === 'LOCKED' && ['EBUSY', 'EPERM', 'EACCES'].includes(err.cause?.code),
      err ? `${err.code} (cause ${err.cause?.code}) "${err.message}" after ${(performance.now() - tLock).toFixed(0)} ms` : 'no error');
    check('no temp file left behind after LOCKED', tmpLeft().length === 0, tmpLeft());
    check('locked file unchanged', fs.readFileSync(FILE).equals(before));
    fs.writeFileSync(path.join(sync, 'close.flag'), '1');
    const closed = await waitLine('CLOSED');
    check('Excel closed the file', closed === 'CLOSED', closed);
    let err2 = null;
    try {
      await writeFileAtomic(FILE, buf2);
    } catch (e) {
      err2 = e;
    }
    check('writeFileAtomic after close succeeds', !err2 && fs.readFileSync(FILE).equals(buf2) && tmpLeft().length === 0, err2?.message);
    fs.writeFileSync(path.join(sync, 'reverify.flag'), '1');
    const rv = await waitLine('REVERIFIED');
    if (rv === 'REVERIFIED') {
      const r2 = readJson('result2.json');
      const c2 = r2.cells;
      check('replaced file opens in Excel with new content', JSON.stringify(r2.sheetNames) === JSON.stringify(['Marker']) && c2['Marker!A2'].v === MARKER && c2['Marker!B2'].t === '2026-09-25 00:30',
        { sheets: r2.sheetNames, A2: c2['Marker!A2'].v, B2: c2['Marker!B2'].t });
    } else {
      check('replaced file opens in Excel with new content', false, rv);
    }
    // leave the full feature workbook behind for a human look (Excel has closed it by now)
    await writeFileAtomic(FILE, buf).catch((e) => console.log(`      note: could not restore the full workbook: ${e.message}`));
  } finally {
    // make sure PowerShell and our own Excel instance are gone
    for (const f of ['close.flag', 'reverify.flag']) {
      try { fs.writeFileSync(path.join(sync, f), '1'); } catch { /* ignore */ }
    }
    const quit = await Promise.race([exited.then(() => 'exit'), sleep(90_000).then(() => 'timeout')]);
    if (quit === 'timeout') ps.kill();
    let gone = excelPid == null || !alive(excelPid);
    for (let i = 0; i < 60 && !gone; i++) {
      await sleep(500);
      gone = !alive(excelPid);
    }
    if (!gone) {
      try { process.kill(excelPid); } catch { /* ignore */ }
    }
    check('our Excel instance quit cleanly', gone, gone ? `PID ${excelPid} exited` : `PID ${excelPid} had to be terminated`);
    fs.rmSync(sync, { recursive: true, force: true });
    const errs = lines.filter((l) => l.startsWith('ERROR'));
    // stderr holding only CLIXML progress records ("Preparing modules...") is noise
    const errOut = stderr.trim().startsWith('#< CLIXML') && !stderr.includes('S="Error"') ? '' : stderr.trim();
    if (errs.length || errOut) console.log(`      PowerShell: ${errs.join(' | ')} ${errOut.slice(0, 600)}`);
  }
}

if (noExcel) console.log('SKIP  Excel COM checks (--no-excel)');
else if (process.platform !== 'win32') console.log('SKIP  Excel COM checks (not Windows)');
else await excelTests();

console.log(`\n${failed ? 'FAILED' : 'OK'}: ${passed} passed, ${failed} failed  (file: ${FILE})`);
process.exitCode = failed ? 1 : 0;
