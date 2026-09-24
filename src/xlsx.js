// Minimal, dependency-free .xlsx writer (Office Open XML spreadsheet in a hand-built ZIP).
// Covers what the fuel ledger needs: several sheets, shared strings (UTF-8, Mongolian
// Cyrillic), numbers with formats, real Excel date-times in a fixed time zone, booleans,
// hyperlinks, bold header / total rows, frozen header, AutoFilter, column widths and
// simple "info" sheets made of text lines. Plus an atomic file writer that reports a
// file held open by Excel as { code: 'LOCKED' } instead of failing obscurely.
//
//   buildXlsx(sheets, opts) -> Buffer
//   writeFileAtomic(file, buffer) -> Promise<void>
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const DAY_MS = 86_400_000;
const EXCEL_EPOCH_DAYS = 25569; // serial number of 1970-01-01 in the 1900 date system
const MAX_SERIAL = 2958465; // 9999-12-31
const MAX_ROWS = 1_048_576;
const MAX_COLS = 16_384;
const MAX_CELL_TEXT = 32_767;
const MAX_LINKS_PER_SHEET = 65_530;
const MAX_URL = 2_000;
const DEFAULT_DATETIME_FMT = 'yyyy-mm-dd hh:mm';
const DEFAULT_DATE_FMT = 'yyyy-mm-dd';
const HEADER_FILL = 'FFDDEBF7';
const LINK_COLOR = 'FF0563C1';

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_DOC = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// ---- text helpers --------------------------------------------------------------------------
// Characters not allowed in XML 1.0 (C0 controls except tab/LF/CR, U+FFFE/U+FFFF, lone
// surrogates) plus the C1 controls, which are legal but never meaningful in cell text.
const BAD_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Plain cell text: illegal characters removed, line breaks normalised, Excel's length cap. */
function cleanText(s) {
  let t = String(s).replace(BAD_CHARS, '').replace(/\r\n?/g, '\n');
  if (t.length > MAX_CELL_TEXT) {
    t = t.slice(0, MAX_CELL_TEXT);
    if (/[\uD800-\uDBFF]$/.test(t)) t = t.slice(0, -1);
  }
  return t;
}

function escXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(s) {
  return escXml(String(s).replace(BAD_CHARS, '')).replace(/'/g, '&apos;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
}

/** Shared-string body for an <si>: Excel treats "_xHHHH_" as an escape, so protect literal ones. */
function siXml(text) {
  const body = escXml(text.replace(/_([xX][0-9A-Fa-f]{4}_)/g, '_x005F_$1'));
  const preserve = /^\s|\s$|[\t\n]/.test(text) ? ' xml:space="preserve"' : '';
  return `<si><t${preserve}>${body}</t></si>`;
}

/** 0-based column index -> letters (0 -> A, 25 -> Z, 26 -> AA, 701 -> ZZ, 702 -> AAA). */
export function colName(i) {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Cell reference from 0-based row/column: (0, 0) -> "A1". */
export function cellRef(row, col) {
  return colName(col) + (row + 1);
}

/**
 * Excel serial date-time for an epoch-ms UTC instant shown in a zone `tzOffsetMinutes`
 * east of UTC (480 = Asia/Ulaanbaatar). Also accepts a Date, or a 'YYYY-MM-DD[ HH:MM[:SS]]'
 * string that is already local wall time (no zone shift). Returns null when not a date.
 */
export function excelSerial(v, tzOffsetMinutes = 480) {
  let serial = null;
  if (v instanceof Date) v = v.getTime();
  if (typeof v === 'number' && Number.isFinite(v)) {
    serial = (v + tzOffsetMinutes * 60_000) / DAY_MS + EXCEL_EPOCH_DAYS;
  } else if (typeof v === 'string') {
    const m = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?\s*$/.exec(v);
    if (m) {
      const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
      serial = ms / DAY_MS + EXCEL_EPOCH_DAYS;
    }
  }
  if (serial === null || !Number.isFinite(serial) || serial < 1 || serial >= MAX_SERIAL + 1) return null;
  return serial;
}

function sheetNameOf(name, used) {
  let s = String(name ?? '').replace(BAD_CHARS, '').replace(/[\[\]:*?/\\]/g, '_').replace(/[\r\n\t]/g, ' ');
  s = s.trim().replace(/^'+|'+$/g, '').trim().slice(0, 31).trim() || 'Sheet';
  const base = s;
  for (let n = 2; used.has(s.toLowerCase()) || s.toLowerCase() === 'history'; n++) {
    const suffix = ` (${n})`;
    s = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(s.toLowerCase());
  return s;
}

const quoteSheet = (name) => `'${name.replace(/'/g, "''")}'`;

function safeUrl(url) {
  if (typeof url !== 'string') return null;
  const u = url.trim().replace(BAD_CHARS, '');
  if (!u || u.length > MAX_URL || !/^(https?:\/\/|mailto:)/i.test(u) || /\s/.test(u)) return null;
  return u;
}

// ---- styles --------------------------------------------------------------------------------
const BUILTIN_FMTS = { General: 0, '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4, '0%': 9, '0.00%': 10, '@': 49 };
const FONT = { normal: 0, bold: 1, link: 2, title: 3, boldLink: 4 };
const FONTS_XML = [
  '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>',
  '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>',
  `<font><u/><sz val="11"/><color rgb="${LINK_COLOR}"/><name val="Calibri"/><family val="2"/></font>`,
  '<font><b/><sz val="14"/><name val="Calibri"/><family val="2"/></font>',
  `<font><b/><u/><sz val="11"/><color rgb="${LINK_COLOR}"/><name val="Calibri"/><family val="2"/></font>`,
];

class Styles {
  constructor() {
    this.fmts = new Map(); // custom format code -> id (>= 164)
    this.xfs = [];
    this.xfIndex = new Map();
    this.get({}); // xf 0 = default
  }

  fmtId(code) {
    if (code == null || code === '') return 0;
    if (code in BUILTIN_FMTS) return BUILTIN_FMTS[code];
    if (!this.fmts.has(code)) this.fmts.set(code, 164 + this.fmts.size);
    return this.fmts.get(code);
  }

  /** xf index for { numFmt, font, header, wrap }. */
  get({ numFmt = null, font = 'normal', header = false, wrap = false }) {
    const fmt = this.fmtId(numFmt);
    const key = `${fmt}|${font}|${header ? 1 : 0}|${wrap ? 1 : 0}`;
    let i = this.xfIndex.get(key);
    if (i === undefined) {
      i = this.xfs.length;
      this.xfs.push({ fmt, font: FONT[font] ?? 0, fill: header ? 2 : 0, border: header ? 1 : 0, wrap, header });
      this.xfIndex.set(key, i);
    }
    return i;
  }

  xml() {
    const fmts = [...this.fmts].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${escAttr(code)}"/>`);
    const xfs = this.xfs.map((x) => {
      const align = x.wrap || x.header
        ? `<alignment vertical="${x.header ? 'center' : 'top'}"${x.wrap ? ' wrapText="1"' : ''}/>`
        : '';
      return `<xf numFmtId="${x.fmt}" fontId="${x.font}" fillId="${x.fill}" borderId="${x.border}" xfId="0"`
        + `${x.fmt ? ' applyNumberFormat="1"' : ''}${x.font ? ' applyFont="1"' : ''}`
        + `${x.fill ? ' applyFill="1"' : ''}${x.border ? ' applyBorder="1"' : ''}`
        + (align ? ` applyAlignment="1">${align}</xf>` : '/>');
    });
    return XML_HEAD
      + `<styleSheet xmlns="${NS_MAIN}">`
      + (fmts.length ? `<numFmts count="${fmts.length}">${fmts.join('')}</numFmts>` : '')
      + `<fonts count="${FONTS_XML.length}">${FONTS_XML.join('')}</fonts>`
      + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
      + `<fill><patternFill patternType="solid"><fgColor rgb="${HEADER_FILL}"/><bgColor indexed="64"/></patternFill></fill></fills>`
      + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
      + '<border><left/><right/><top/><bottom style="thin"><color rgb="FF8EA9DB"/></bottom><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>`
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
      + '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>'
      + '</styleSheet>';
  }
}

class SharedStrings {
  constructor() {
    this.map = new Map();
    this.list = [];
    this.count = 0;
  }

  id(text) {
    this.count++;
    let i = this.map.get(text);
    if (i === undefined) {
      i = this.list.length;
      this.list.push(text);
      this.map.set(text, i);
    }
    return i;
  }

  xml() {
    return XML_HEAD + `<sst xmlns="${NS_MAIN}" count="${this.count}" uniqueCount="${this.list.length}">`
      + this.list.map(siXml).join('') + '</sst>';
  }
}

// ---- cells ---------------------------------------------------------------------------------
const NUMERIC_TEXT = /^\s*-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i;

/**
 * Resolve one value to { kind: 'n'|'s'|'b'|'link', v, text?, url?, fmt? } or null (empty cell).
 * `col` is the column spec (may be {}), `tz` the zone offset in minutes.
 */
function resolveCell(value, col, tz) {
  if (value === null || value === undefined || value === '') return null;
  const type = col.type;
  if (typeof value === 'object' && !(value instanceof Date) && ('url' in value || 'text' in value)) {
    const url = safeUrl(value.url);
    const text = value.text != null && value.text !== '' ? String(value.text) : (url || '');
    if (!text) return null;
    return url ? { kind: 'link', v: cleanText(text), url } : { kind: 's', v: cleanText(text) };
  }
  if (type === 'datetime' || type === 'date') {
    let serial = excelSerial(value, tz);
    if (serial !== null) {
      if (type === 'date') serial = Math.floor(serial);
      return { kind: 'n', v: serial, fmt: col.numFmt || (type === 'date' ? DEFAULT_DATE_FMT : DEFAULT_DATETIME_FMT) };
    }
    if (typeof value === 'number' || value instanceof Date) return null; // out-of-range instant
    return { kind: 's', v: cleanText(value) };
  }
  if (type === 'link' && typeof value === 'string') {
    const url = safeUrl(value);
    return url ? { kind: 'link', v: cleanText(value), url } : { kind: 's', v: cleanText(value) };
  }
  if (type === 'bool') {
    if (typeof value === 'boolean') return { kind: 'b', v: value };
    if (value === 0 || value === 1) return { kind: 'b', v: value === 1 };
  }
  if (type === 'string') {
    if (value instanceof Date) return { kind: 's', v: value.toISOString() };
    return { kind: 's', v: cleanText(value) };
  }
  // 'number', 'bool' fallbacks and untyped columns: infer from the value
  if (typeof value === 'bigint') value = Number(value);
  if (typeof value === 'number') return Number.isFinite(value) ? { kind: 'n', v: value, fmt: col.numFmt } : null;
  if (typeof value === 'boolean') return { kind: 'b', v: value };
  if (value instanceof Date) {
    const serial = excelSerial(value, tz);
    return serial === null ? null : { kind: 'n', v: serial, fmt: col.numFmt || DEFAULT_DATETIME_FMT };
  }
  if (type === 'number' && typeof value === 'string' && NUMERIC_TEXT.test(value)) {
    const n = Number(value);
    if (Number.isFinite(n)) return { kind: 'n', v: n, fmt: col.numFmt };
  }
  return { kind: 's', v: cleanText(value) };
}

function numText(n) {
  if (Object.is(n, -0)) return '0';
  return String(n);
}

/** Rough display width (characters) of a resolved cell, for automatic column widths. */
function displayLen(cell) {
  if (!cell) return 0;
  if (cell.kind === 's' || cell.kind === 'link') {
    let max = 0;
    for (const line of cell.v.split('\n')) max = Math.max(max, line.length);
    return max;
  }
  if (cell.kind === 'b') return 5;
  const fmt = cell.fmt || '';
  if (/y|d/i.test(fmt) && !/[0#]/.test(fmt)) return fmt.replace(/"[^"]*"|\\./g, 'x').length;
  const digits = String(Math.round(Math.abs(cell.v))).length;
  const decimals = fmt
    ? (/\.(0+)/.exec(fmt)?.[1].length ?? 0)
    : Math.min(String(cell.v).split('.')[1]?.length ?? 0, 9);
  const commas = fmt.includes(',') ? Math.floor((digits - 1) / 3) : 0;
  return digits + commas + (decimals ? decimals + 1 : 0) + (cell.v < 0 ? 1 : 0);
}

// ---- worksheet -----------------------------------------------------------------------------
function buildSheet(sheet, index, ctx) {
  const { strings, styles, tz } = ctx;
  const columns = Array.isArray(sheet.columns) ? sheet.columns.slice(0, MAX_COLS).map((c) => (c && typeof c === 'object' ? c : { header: c })) : [];
  const titleLines = Array.isArray(sheet.titleLines) ? sheet.titleLines : [];
  const rowsXml = [];
  const links = [];
  // header: bold text, plus room for the AutoFilter button (measured in Excel 16: a bold header
  // needs about len + 2.5 characters, the button about 2.2 more)
  const headerWidth = (h) => {
    const len = String(h).length;
    return sheet.autoFilter ? Math.max(len * 1.15 + 3, 8.5) : len * 1.1 + 1;
  };
  const widths = columns.map((c) => (c.header != null ? headerWidth(c.header) : 0));
  let rowNo = 0; // 0-based index of the next row to write
  let maxCol = -1;

  const cellXml = (r, c, cell, { bold = false, header = false, wrap = false, title = false } = {}) => {
    const ref = cellRef(r, c);
    if (c > maxCol) maxCol = c;
    let font = title ? 'title' : bold ? 'bold' : 'normal';
    if (cell.kind === 'link') {
      if (links.length < MAX_LINKS_PER_SHEET) {
        links.push({ ref, url: cell.url });
        font = bold ? 'boldLink' : 'link';
      }
      cell = { kind: 's', v: cell.v };
    }
    const s = styles.get({ numFmt: cell.kind === 'n' ? cell.fmt : null, font, header, wrap });
    const sAttr = s ? ` s="${s}"` : '';
    if (cell.kind === 'n') return `<c r="${ref}"${sAttr}><v>${numText(cell.v)}</v></c>`;
    if (cell.kind === 'b') return `<c r="${ref}"${sAttr} t="b"><v>${cell.v ? 1 : 0}</v></c>`;
    return `<c r="${ref}"${sAttr} t="s"><v>${strings.id(cell.v)}</v></c>`;
  };

  const pushRow = (cellsXml) => {
    if (cellsXml.length) rowsXml.push(`<row r="${rowNo + 1}">${cellsXml.join('')}</row>`);
    rowNo++;
  };

  // Free text lines (info sheet, or a caption above a table). Line 0 is the title.
  let infoWidth = 0;
  titleLines.forEach((line, i) => {
    if (rowNo >= MAX_ROWS) return;
    const spec = line && typeof line === 'object' ? line : { text: line };
    const text = spec.text == null ? '' : String(spec.text);
    const cell = text === '' ? null : resolveCell(spec.url ? { text, url: spec.url } : text, {}, tz);
    if (!cell) {
      pushRow([]);
      return;
    }
    const title = spec.title ?? i === 0;
    infoWidth = Math.max(infoWidth, displayLen(cell) * (title ? 1.3 : 1));
    pushRow([cellXml(rowNo, 0, cell, { title, bold: !!spec.bold, wrap: !!spec.wrap })]);
  });

  let headerRow = -1;
  let lastDataRow = -1;
  if (columns.length) {
    if (titleLines.length) pushRow([]); // gap between caption and table
    headerRow = rowNo;
    pushRow(columns.map((c, i) => cellXml(rowNo, i, { kind: 's', v: cleanText(c.header ?? '') }, { bold: true, header: true })));
    const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
    for (const row of rows) {
      if (rowNo >= MAX_ROWS - (sheet.totalRow ? 2 : 0)) break;
      if (!Array.isArray(row)) continue;
      const cells = [];
      for (let c = 0; c < row.length && c < MAX_COLS; c++) {
        const col = columns[c] || {};
        const cell = resolveCell(row[c], col, tz);
        if (!cell) continue;
        if (c < widths.length) widths[c] = Math.max(widths[c], displayLen(cell));
        cells.push(cellXml(rowNo, c, cell, { wrap: !!col.wrap }));
      }
      pushRow(cells);
    }
    lastDataRow = rowNo - 1;
    if (Array.isArray(sheet.totalRow)) {
      // One blank row first: Excel grows an AutoFilter range over an adjacent row on load,
      // which would sort/filter the totals in with the data.
      pushRow([]);
      const cells = [];
      sheet.totalRow.slice(0, MAX_COLS).forEach((v, c) => {
        const cell = resolveCell(v, columns[c] || {}, tz);
        if (!cell) return;
        if (c < widths.length) widths[c] = Math.max(widths[c], displayLen(cell));
        cells.push(cellXml(rowNo, c, cell, { bold: true }));
      });
      pushRow(cells);
    }
    maxCol = Math.max(maxCol, columns.length - 1);
  }

  // column widths: explicit, else estimated from content (clamped)
  const colsXml = [];
  if (columns.length) {
    columns.forEach((c, i) => {
      const w = Number.isFinite(c.width) && c.width > 0 ? Math.min(c.width, 255) : Math.min(Math.max(widths[i] + 1.5, 6), 60);
      colsXml.push(`<col min="${i + 1}" max="${i + 1}" width="${+w.toFixed(2)}" customWidth="1"/>`);
    });
  } else if (titleLines.length) {
    const w = Number.isFinite(sheet.width) ? sheet.width : Math.min(Math.max(infoWidth + 2, 20), 120);
    colsXml.push(`<col min="1" max="1" width="${+w.toFixed(2)}" customWidth="1"/>`);
  }

  const freeze = headerRow >= 0 && !!sheet.freezeHeader;
  const filterRef = headerRow >= 0 && sheet.autoFilter ? `${cellRef(headerRow, 0)}:${cellRef(Math.max(lastDataRow, headerRow), columns.length - 1)}` : null;
  const dim = rowNo > 0 && maxCol >= 0 ? `A1:${cellRef(rowNo - 1, maxCol)}` : 'A1';

  let views = `<sheetView workbookViewId="0"${index === 0 ? ' tabSelected="1"' : ''}`;
  if (freeze) {
    const top = cellRef(headerRow + 1, 0);
    views += `><pane ySplit="${headerRow + 1}" topLeftCell="${top}" activePane="bottomLeft" state="frozen"/>`
      + `<selection pane="bottomLeft" activeCell="${top}" sqref="${top}"/></sheetView>`;
  } else {
    views += '/>';
  }

  // printing: landscape for tables unless told otherwise; fitToWidth = one page wide (as many
  // pages down as needed)
  const fit = !!sheet.fitToWidth;
  const orientation = ['portrait', 'landscape'].includes(sheet.orientation) ? sheet.orientation : columns.length ? 'landscape' : null;
  const tab = typeof sheet.tabColor === 'string' && /^#?[0-9a-f]{6}$/i.test(sheet.tabColor)
    ? `<tabColor rgb="FF${sheet.tabColor.replace('#', '').toUpperCase()}"/>` : '';
  const sheetPr = tab || fit ? `<sheetPr>${tab}${fit ? '<pageSetUpPr fitToPage="1"/>' : ''}</sheetPr>` : '';
  const pageSetup = orientation || fit
    ? `<pageSetup${orientation ? ` orientation="${orientation}"` : ''}${fit ? ' fitToWidth="1" fitToHeight="0"' : ''}/>` : '';
  const xml = XML_HEAD
    + `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_R}">`
    + sheetPr
    + `<dimension ref="${dim}"/>`
    + `<sheetViews>${views}</sheetViews>`
    + '<sheetFormatPr defaultRowHeight="15"/>'
    + (colsXml.length ? `<cols>${colsXml.join('')}</cols>` : '')
    + `<sheetData>${rowsXml.join('')}</sheetData>`
    + (filterRef ? `<autoFilter ref="${filterRef}"/>` : '')
    + (links.length ? `<hyperlinks>${links.map((l, i) => `<hyperlink ref="${l.ref}" r:id="rId${i + 1}"/>`).join('')}</hyperlinks>` : '')
    + '<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
    + pageSetup
    + '</worksheet>';

  const rels = links.length
    ? XML_HEAD + `<Relationships xmlns="${NS_PKG_REL}">`
      + links.map((l, i) => `<Relationship Id="rId${i + 1}" Type="${REL_DOC}/hyperlink" Target="${escAttr(l.url)}" TargetMode="External"/>`).join('')
      + '</Relationships>'
    : null;

  const printTitles = freeze ? `$${headerRow + 1}:$${headerRow + 1}` : null;
  const filterAbs = filterRef ? filterRef.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2') : null;
  return { xml, rels, filterAbs, printTitles };
}

// ---- package -------------------------------------------------------------------------------
/**
 * Build a complete .xlsx file.
 *
 * sheets: [{ name, columns: [{ header, width?, type?, numFmt?, wrap? }], rows: [[value, ...]],
 *            freezeHeader?, autoFilter?, totalRow?: [value, ...], titleLines?: [line, ...],
 *            tabColor?: 'RRGGBB', width?: number (info sheet column A),
 *            orientation?: 'portrait' | 'landscape' (printing; tables default to landscape),
 *            fitToWidth?: true (print one page wide) }]
 *   type: 'string' | 'number' | 'datetime' | 'date' | 'link' | 'bool' (omitted: inferred)
 *   values: null/undefined/'' -> empty; datetime/date: epoch ms UTC (or Date, or local
 *   'YYYY-MM-DD[ HH:MM]' string); link: { text, url } (http/https/mailto only, else plain text).
 *   titleLines: strings or { text, bold?, title?, url?, wrap? }; line 0 is the title; '' = blank.
 * opts: { tzOffsetMinutes = 480, creator, title }
 */
export function buildXlsx(sheets, opts = {}) {
  const tz = Number.isFinite(opts.tzOffsetMinutes) ? opts.tzOffsetMinutes : 480;
  const strings = new SharedStrings();
  const styles = new Styles();
  const ctx = { strings, styles, tz };
  const list = Array.isArray(sheets) && sheets.length ? sheets : [{ name: 'Sheet1', titleLines: [] }];

  const used = new Set();
  const built = list.map((s, i) => ({ name: sheetNameOf(s?.name, used), ...buildSheet(s || {}, i, ctx) }));

  const files = [];
  const add = (name, text) => files.push({ name, data: Buffer.from(text, 'utf8') });

  add('[Content_Types].xml', XML_HEAD
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + built.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    + '</Types>');

  add('_rels/.rels', XML_HEAD
    + `<Relationships xmlns="${NS_PKG_REL}">`
    + `<Relationship Id="rId1" Type="${REL_DOC}/officeDocument" Target="xl/workbook.xml"/>`
    + `<Relationship Id="rId2" Type="${NS_PKG_REL}/metadata/core-properties" Target="docProps/core.xml"/>`
    + `<Relationship Id="rId3" Type="${REL_DOC}/extended-properties" Target="docProps/app.xml"/>`
    + '</Relationships>');

  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  add('docProps/core.xml', XML_HEAD
    + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"'
    + ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"'
    + ' xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + (opts.title ? `<dc:title>${escXml(cleanText(opts.title))}</dc:title>` : '')
    + (opts.creator ? `<dc:creator>${escXml(cleanText(opts.creator))}</dc:creator>` : '')
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>`
    + `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>`
    + '</cp:coreProperties>');

  add('docProps/app.xml', XML_HEAD
    + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"'
    + ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
    + `<Application>${escXml(cleanText(opts.creator || 'Fuel Tank Warner'))}</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>`
    + '<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant>'
    + `<vt:variant><vt:i4>${built.length}</vt:i4></vt:variant></vt:vector></HeadingPairs>`
    + `<TitlesOfParts><vt:vector size="${built.length}" baseType="lpstr">${built.map((s) => `<vt:lpstr>${escXml(s.name)}</vt:lpstr>`).join('')}</vt:vector></TitlesOfParts>`
    + '<LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0300</AppVersion>'
    + '</Properties>');

  const defined = [];
  built.forEach((s, i) => {
    if (s.filterAbs) defined.push({ name: '_xlnm._FilterDatabase', i, hidden: true, ref: `${quoteSheet(s.name)}!${s.filterAbs}` });
  });
  built.forEach((s, i) => {
    if (s.printTitles) defined.push({ name: '_xlnm.Print_Titles', i, ref: `${quoteSheet(s.name)}!${s.printTitles}` });
  });
  defined.sort((a, b) => (a.name === b.name ? a.i - b.i : a.name < b.name ? -1 : 1));
  add('xl/workbook.xml', XML_HEAD
    + `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_R}">`
    + '<workbookPr/>'
    + '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="15000" activeTab="0"/></bookViews>'
    + `<sheets>${built.map((s, i) => `<sheet name="${escAttr(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>`
    + (defined.length
      ? `<definedNames>${defined.map((d) => `<definedName name="${d.name}" localSheetId="${d.i}"${d.hidden ? ' hidden="1"' : ''}>${escXml(d.ref)}</definedName>`).join('')}</definedNames>`
      : '')
    + '<calcPr calcId="191029"/>'
    + '</workbook>');

  add('xl/_rels/workbook.xml.rels', XML_HEAD
    + `<Relationships xmlns="${NS_PKG_REL}">`
    + built.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL_DOC}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${built.length + 1}" Type="${REL_DOC}/styles" Target="styles.xml"/>`
    + `<Relationship Id="rId${built.length + 2}" Type="${REL_DOC}/sharedStrings" Target="sharedStrings.xml"/>`
    + '</Relationships>');

  built.forEach((s, i) => {
    add(`xl/worksheets/sheet${i + 1}.xml`, s.xml);
    if (s.rels) add(`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, s.rels);
  });
  add('xl/styles.xml', styles.xml()); // after the sheets: they register the styles they use
  add('xl/sharedStrings.xml', strings.xml());

  return zip(files);
}

// ---- ZIP (deflate, no zip64: parts are far below 4 GB) --------------------------------------
function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function zip(files) {
  const { time, date } = dosDateTime(new Date());
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = zlib.crc32(f.data) >>> 0;
    const packed = zlib.deflateRawSync(f.data, { level: 6 });
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, packed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by (MS-DOS/FAT)
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(packed.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    // extra len, comment len, disk no., internal attrs, external attrs = 0
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + packed.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, end]);
}

// ---- atomic write ----------------------------------------------------------------------------
const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STALE_TEMP_MS = 10 * 60_000;

async function unlinkQuiet(file) {
  try {
    await fsp.unlink(file);
  } catch {
    /* already gone */
  }
}

/** Remove temp files our earlier runs may have left behind (crash between write and rename). */
async function removeStaleTemps(dir, base) {
  try {
    const now = Date.now();
    for (const f of await fsp.readdir(dir)) {
      if (!f.startsWith(`.${base}.`) || !f.endsWith('.tmp')) continue;
      const full = path.join(dir, f);
      const st = await fsp.stat(full).catch(() => null);
      if (st && now - st.mtimeMs > STALE_TEMP_MS) await unlinkQuiet(full);
    }
  } catch {
    /* best effort */
  }
}

/** Opening the existing file for writing is refused for lack of permission (not a lock). */
async function accessDenied(file) {
  try {
    const fh = await fsp.open(file, 'r+');
    await fh.close();
    return false;
  } catch (e) {
    // a file held open by Excel answers EBUSY (sharing violation) here
    return e.code === 'EACCES' || e.code === 'EPERM';
  }
}

/** The existing file has the read-only attribute (Windows) / no write permission. */
async function isReadOnly(file) {
  try {
    const st = await fsp.stat(file);
    return st.isFile() && (st.mode & 0o200) === 0;
  } catch {
    return false;
  }
}

/**
 * Write `buffer` to `filePath` atomically: a temp file in the same folder, flushed to disk,
 * then renamed over the target (readers never see a half-written file). When the target is
 * held open by another program (Excel) the rename fails with EBUSY/EPERM/EACCES; after a few
 * short retries the promise rejects with an Error whose `.code === 'LOCKED'` (original error
 * in `.cause`). A target marked read-only rejects with `.code === 'READONLY'`, one this user may
 * not change (file permissions) with `.code === 'NOACCESS'` instead. The temp file is always
 * removed on failure. Other errors (disk full, no permission to create the temp file, ...) are
 * passed through unchanged.
 */
export async function writeFileAtomic(filePath, buffer) {
  const target = path.resolve(filePath);
  const dir = path.dirname(target);
  const base = path.basename(target);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${base}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);

  let fh = null;
  try {
    fh = await fsp.open(tmp, 'wx');
    await fh.writeFile(buffer);
    await fh.sync();
  } catch (e) {
    if (fh) await fh.close().catch(() => {});
    fh = null;
    await unlinkQuiet(tmp);
    throw e;
  } finally {
    if (fh) await fh.close();
  }

  let err = null;
  let readOnly = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await fsp.rename(tmp, target);
      removeStaleTemps(dir, base);
      return;
    } catch (e) {
      err = e;
      if (!LOCK_CODES.has(e.code)) break;
      // a file marked read-only refuses the rename the same way as one held open by Excel, but
      // closing Excel will not help: report it as what it is
      if (e.code !== 'EBUSY' && (readOnly = await isReadOnly(target))) break;
      if (attempt < 3) await sleep(150 * (attempt + 1)); // antivirus / indexer hold it briefly
    }
  }
  await unlinkQuiet(tmp);
  if (readOnly) {
    const ro = new Error(`${base} is marked read-only, so it cannot be updated. In Explorer, right-click it, choose Properties and untick "Read-only"`);
    ro.code = 'READONLY';
    ro.path = target;
    ro.cause = err;
    throw ro;
  }
  if (LOCK_CODES.has(err.code) && err.code !== 'EBUSY' && (await accessDenied(target))) {
    const na = new Error(`no permission to change ${base} (${err.code}) - check the file's permissions, or set another excelFile in config.json`);
    na.code = 'NOACCESS';
    na.path = target;
    na.cause = err;
    throw na;
  }
  if (LOCK_CODES.has(err.code)) {
    const locked = new Error(`${base} is open in another program (${err.code}); it will be written when it is closed`);
    locked.code = 'LOCKED';
    locked.path = target;
    locked.cause = err;
    throw locked;
  }
  throw err;
}
