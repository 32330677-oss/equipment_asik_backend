// services/pdfKit.js — shared pdfkit helpers: fonts (Latin + Arabic), colours, header, tables, footers.
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

// Documents use the cropped logo (no white margins); colours are the logo's charcoal + gold.
const LOGO = fs.existsSync(path.join(__dirname, '..', 'assets', 'logo_doc.png'))
  ? path.join(__dirname, '..', 'assets', 'logo_doc.png') : path.join(__dirname, '..', 'assets', 'logo.png');
const ARABIC_FONT = path.join(__dirname, '..', 'assets', 'fonts', 'NotoNaskhArabic-Regular.ttf');

const COLORS = {
  // brand (from the ASIK logo): navy = the logo's charcoal, gold = the logo's gold
  navy: '#3B3B3B', gold: '#C5A55A', ink: '#2B2B2B', muted: '#6E6A62', grid: '#D9D3C4', zebra: '#FBF9F4',
  soft: '#F4EFE2', band: '#EFE7D3', bandStrong: '#E4D7B5', white: '#FFFFFF', red: '#B03A2E', green: '#2E7D4F', amber: '#C27C0E', light: '#AAAAAA',
};

const AR_RE = /[؀-ۿ]/;
const isArabic = (s) => AR_RE.test(String(s || ''));

/**
 * Arabic: fontkit shapes the letters and, with the 'rtla' feature, lays the whole run right-to-left
 * (word order and spaces stay correct). Digit runs would be mirrored by that, so they are pre-reversed.
 * Characters missing from the Arabic font (/ - ( ) x %) are replaced so no empty boxes are printed.
 */
const AR_MISSING = { '/': ' ', '-': ' ', '(': ' ', ')': ' ', '×': ' ', '%': ' ', '[': ' ', ']': ' ' };
function prepArabic(s) {
  return String(s).trim().replace(/[\/\-()×%[\]]/g, (c) => AR_MISSING[c] || ' ').replace(/\s+/g, ' ')
    .replace(/[0-9][0-9.,]*/g, (run) => run.split('').reverse().join(''));
}

/** Helvetica (WinAnsi) cannot draw some symbols: replace them. */
function latinSafe(s) {
  return String(s ?? '').replace(/[–—]/g, '-').replace(/[·•]/g, '|').replace(/→/g, '->').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

function createDoc(opts = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 24, bufferPages: true, ...opts, info: { Author: 'Equipment Flow', ...(opts.info || {}) } });
  const hasArabic = fs.existsSync(ARABIC_FONT);
  if (hasArabic) doc.registerFont('Arabic', ARABIC_FONT);
  doc.hasArabic = hasArabic;
  doc.hasLogo = fs.existsSync(LOGO);
  return doc;
}

/** Collect a pdfkit document into a Buffer. */
function toBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

/**
 * Draw text in a box. Arabic strings use the Arabic font and are right-aligned unless align is given.
 * opts: { size, bold, color, align, width, height, valign: 'middle'|'top' }
 */
function text(doc, str, x, y, opts = {}) {
  const s = str === null || str === undefined ? '' : String(str);
  const ar = isArabic(s) && doc.hasArabic;
  const size = opts.size || 8;
  doc.font(ar ? 'Arabic' : (opts.bold ? 'Helvetica-Bold' : 'Helvetica')).fontSize(size).fillColor(opts.color || COLORS.ink);
  const out = ar ? prepArabic(s) : latinSafe(s);
  const features = ar ? ['rtla'] : undefined;
  let yy = y;
  if (opts.valign === 'middle' && opts.height) {
    const h = doc.heightOfString(out, { width: opts.width, lineBreak: opts.lineBreak !== false, features });
    yy = y + Math.max(0, (opts.height - Math.min(h, opts.height)) / 2) - (ar ? 1 : 0);
  }
  doc.text(out, x, yy, {
    width: opts.width, height: opts.height, align: opts.align || (ar ? 'right' : 'left'),
    lineBreak: opts.lineBreak !== false, ellipsis: !ar && opts.ellipsis !== false && opts.height ? true : undefined, features,
  });
}

/** Bilingual label: English on top, Arabic underneath (smaller). */
function label2(doc, en, ar, x, y, w, opts = {}) {
  const size = opts.size || 7;
  const h = opts.height || 24;
  text(doc, en, x, y, { size, bold: true, color: opts.color || COLORS.white, align: opts.align || 'center', width: w, height: ar ? h - size - 4 : h, ellipsis: false });
  if (ar) text(doc, ar, x, y + h - size - 6, { size: size - 0.5, color: opts.arColor || '#E9DDBE', align: opts.align || 'center', width: w, lineBreak: false });
}

/** Standard header: logo left, titles centre, optional right block (function). Returns the y below it. */
function header(doc, { title, titleAr, subtitle, right }) {
  const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right;
  const top = doc.page.margins.top;
  if (doc.hasLogo) doc.image(LOGO, L, top - 4, { height: 46 });
  text(doc, title, L, top + 2, { size: 15, bold: true, color: COLORS.navy, align: 'center', width: W, lineBreak: false });
  if (titleAr) text(doc, titleAr, L, top + 21, { size: 11, color: COLORS.gold, align: 'center', width: W, lineBreak: false });
  if (subtitle) text(doc, subtitle, L, top + 38, { size: 8, color: COLORS.muted, align: 'center', width: W, lineBreak: false });
  if (right) right(L + W, top);
  const y = top + 56;
  doc.moveTo(L, y).lineTo(L + W, y).lineWidth(2).strokeColor(COLORS.gold).stroke();
  return y + 6;
}

/** Largest font size between [min] and [max] at which [str] fits on one line of [width] (the font of text()). */
function fitSize(doc, str, width, max, min, bold = false) {
  const s = str === null || str === undefined ? '' : String(str);
  const ar = isArabic(s) && doc.hasArabic;
  const out = ar ? prepArabic(s) : latinSafe(s);
  doc.font(ar ? 'Arabic' : (bold ? 'Helvetica-Bold' : 'Helvetica'));
  let size = max;
  while (size > min && doc.fontSize(size).widthOfString(out, ar ? { features: ['rtla'] } : undefined) > width) size -= 0.25;
  return size;
}

/** Info grid: cells [{label, labelAr, value}] in `cols` columns. Returns y below. */
function infoGrid(doc, cells, y, cols = 4) {
  const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right;
  const cw = W / cols; const ch = 26;
  cells.forEach((c, i) => {
    const x = L + (i % cols) * cw; const yy = y + Math.floor(i / cols) * ch;
    doc.rect(x, yy, cw, ch).lineWidth(0.5).strokeColor(COLORS.grid).stroke();
    text(doc, c.label, x + 4, yy + 3, { size: 6.5, color: COLORS.muted, width: cw / 2, lineBreak: false });
    if (c.labelAr) text(doc, c.labelAr, x + cw / 2, yy + 1, { size: 6.5, color: COLORS.muted, width: cw / 2 - 4, align: 'right', lineBreak: false });
    // a long value (site or vendor name...) stays on ONE line inside its box: smaller font first, then cut with "..."
    text(doc, c.value, x + 4, yy + 12, { size: fitSize(doc, c.value, cw - 8, 8.5, 6.5, true), bold: true, width: cw - 8, height: ch - 12, lineBreak: false });
  });
  return y + Math.ceil(cells.length / cols) * ch + 6;
}

/**
 * Table with repeating header. columns: [{ key, en, ar, width, align }], rows: array of objects or { _blank, _style }.
 * Returns y after the table. onNewPage(doc) must redraw the page header and return the y to continue at.
 */
function table(doc, { columns, rows, y, rowHeight = 18, headHeight = 24, onNewPage, bottom, zebra = true, fontSize = 7.5 }) {
  const L = doc.page.margins.left;
  const totalW = columns.reduce((s, c) => s + c.width, 0);
  const limit = () => (bottom || doc.page.height - doc.page.margins.bottom - 18);
  const drawHead = (yy) => {
    doc.rect(L, yy, totalW, headHeight).fill(COLORS.navy);
    let x = L;
    for (const c of columns) {
      label2(doc, c.en, c.ar, x + 1, yy + 2, c.width - 2, { size: 6.6, height: headHeight - 2 });
      x += c.width;
    }
    return yy + headHeight;
  };
  let yy = drawHead(y);
  rows.forEach((r, i) => {
    const h = r._height || rowHeight;
    if (yy + h > limit()) {
      doc.addPage();
      yy = drawHead(onNewPage ? onNewPage(doc) : doc.page.margins.top);
    }
    if (zebra && i % 2 === 1 && !r._fill) doc.rect(L, yy, totalW, h).fill(COLORS.zebra);
    if (r._fill) doc.rect(L, yy, totalW, h).fill(r._fill);
    let x = L;
    for (const c of columns) {
      doc.rect(x, yy, c.width, h).lineWidth(0.4).strokeColor(COLORS.grid).stroke();
      const val = r[c.key];
      if (val !== undefined && val !== null && val !== '') {
        text(doc, val, x + 2, yy, {
          size: c.size || fontSize, bold: c.bold || r._bold, color: r._color || c.color, width: c.width - 4,
          height: h, valign: 'middle', align: c.align || 'center', lineBreak: Boolean(c.wrap),
        });
      }
      x += c.width;
    }
    yy += h;
  });
  return yy;
}

/** Footer "label · Page x / y" on every buffered page. */
function footers(doc, label) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right;
    const y = doc.page.height - doc.page.margins.bottom - 4;
    const saved = doc.page.margins.bottom; doc.page.margins.bottom = 0;
    text(doc, label, L, y, { size: 6.5, color: COLORS.muted, width: W * 0.8, lineBreak: false });
    text(doc, `Page ${i - range.start + 1} / ${range.count}`, L, y, { size: 6.5, color: COLORS.muted, width: W, align: 'right', lineBreak: false });
    doc.page.margins.bottom = saved;
  }
}

const fmt = {
  hours: (min) => (min === null || min === undefined ? '' : (Number(min) / 60).toFixed(2)),
  minutes: (m) => (m ? String(m) : ''),
  time: (dt) => (dt ? String(dt).slice(11, 16) : ''),
  dayDate: (d) => {
    const [y, m, dd] = String(d).split('-').map(Number);
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(y, m - 1, dd)).getUTCDay()];
    return `${wd} ${String(dd).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
  },
  date: (d) => (d ? `${String(d).slice(8, 10)}/${String(d).slice(5, 7)}/${String(d).slice(0, 4)}` : ''),
  money: (cents, currency) => {
    const v = Number(cents) / 100;
    if (currency === 'SYP') return Math.round(v).toLocaleString('en-US');
    return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },
  num: (v, d = 2) => (v === null || v === undefined || v === '' ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })),
};

module.exports = { createDoc, toBuffer, text, label2, header, infoGrid, table, footers, fmt, COLORS, isArabic, LOGO };
