// services/pdfBidi.js — text that mixes Arabic and Latin (site names, operator names, typed notes) for pdfkit.
// pdfkit/fontkit shape a whole string with the script of its FIRST letter, so "S08 - برج" or a wrapped line that starts
// with a Latin word comes out broken. Here every line is cut into runs (Arabic / Latin+digits / neutral), each run is
// drawn on its own, and the runs are placed right-to-left (Arabic paragraph) or left-to-right (Latin paragraph).
// Font: Tajawal (Arabic + Latin, SIL Open Font License, assets/fonts/OFL-Tajawal.txt).
'use strict';

const fs = require('fs');
const path = require('path');

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const TJ = path.join(FONT_DIR, 'Tajawal-Regular.ttf');
const TJB = path.join(FONT_DIR, 'Tajawal-Bold.ttf');

const AR_CHAR = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const LTR_CHAR = /[A-Za-z0-9À-ɏ]/;
const hasArabic = (s) => AR_CHAR.test(String(s || ''));
const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '<': '>', '>': '<', '{': '}', '}': '{' };

/** Register the fonts on a document. Returns false when the font files are missing. */
function register(doc) {
  if (!fs.existsSync(TJ) || !fs.existsSync(TJB)) return false;
  doc.registerFont('TJ', TJ);
  doc.registerFont('TJB', TJB);
  return true;
}

/** Cut one line into runs: { kind: 'A' | 'L' | 'N', text } in logical order. */
function runs(line) {
  const cls = (c) => (AR_CHAR.test(c) ? 'A' : LTR_CHAR.test(c) ? 'L' : 'N');
  const out = [];
  for (const c of Array.from(line)) {
    const k = cls(c);
    if (out.length && out[out.length - 1].kind === k) out[out.length - 1].text += c;
    else out.push({ kind: k, text: c });
  }
  // a neutral between two runs of the same kind joins them ("P-001 (CAT", "حمزة الأحمد")
  for (let i = 1; i < out.length - 1; i += 1) {
    if (out[i].kind === 'N' && out[i - 1].kind === out[i + 1].kind) {
      out[i - 1].text += out[i].text + out[i + 1].text;
      out.splice(i, 2);
      i -= 1;
    }
  }
  // a closing bracket right after a Latin run that opened it stays with it: "(CAT 320)"
  for (let i = 1; i < out.length; i += 1) {
    const prev = out[i - 1];
    if (out[i].kind === 'N' && prev.kind === 'L') {
      const open = (prev.text.match(/[([]/g) || []).length - (prev.text.match(/[)\]]/g) || []).length;
      const m = open > 0 ? out[i].text.match(/^[)\]]+/) : null;
      if (m) { prev.text += m[0]; out[i].text = out[i].text.slice(m[0].length); if (!out[i].text) { out.splice(i, 1); i -= 1; } }
    }
  }
  return out;
}

/**
 * A writer bound to a document. lang 'ar' = Arabic report (Tajawal for every string, right-to-left paragraphs);
 * 'en' = Helvetica for Latin strings, Tajawal + right-to-left only for strings that contain Arabic.
 */
function writer(doc, lang, colors) {
  const tj = register(doc);
  const ar = lang === 'ar';

  const fontFor = (s, bold) => {
    if (tj && (ar || hasArabic(s))) return bold ? 'TJB' : 'TJ';
    return bold ? 'Helvetica-Bold' : 'Helvetica';
  };
  const latinSafe = (s) => String(s).replace(/[–—]/g, '-').replace(/[·•]/g, '|').replace(/→/g, '->').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

  /** Visual pieces of one line: [{ text, features, width }] from left to right, and the total width. */
  function pieces(line, font, size) {
    doc.font(font).fontSize(size);
    // paragraph direction: Arabic report = right-to-left; English report = the direction of the first letter
    const first = (String(line).match(/[A-Za-z0-9\u00C0-\u024F\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/) || [''])[0];
    const rtl = hasArabic(line) && (ar || AR_CHAR.test(first));
    let rs = runs(line);
    if (!rtl && hasArabic(line)) {
      rs = rs.map((r) => (r.kind === 'A' ? { text: r.text, features: ['rtla'] } : { text: r.text }));
    } else if (rtl) {
      rs = rs.reverse().map((r) => {
        if (r.kind === 'A') return { text: r.text, features: ['rtla'] };
        if (r.kind === 'N') return { text: Array.from(r.text).reverse().map((c) => MIRROR[c] || c).join('') };
        return { text: r.text };
      });
    } else {
      rs = [{ text: line }];
    }
    let total = 0;
    for (const p of rs) { p.width = doc.widthOfString(p.text, { features: p.features }); total += p.width; }
    return { list: rs, width: total };
  }

  const lineHeight = (font, size) => { doc.font(font).fontSize(size); return doc.currentLineHeight(true); };

  /** Words -> lines that fit [width] (logical order). */
  function wrapLines(s, font, size, width) {
    const lines = [];
    for (const para of String(s).split(/\n/)) {
      let cur = '';
      for (const w of para.split(/\s+/).filter(Boolean)) {
        const cand = cur ? `${cur} ${w}` : w;
        if (!cur || pieces(cand, font, size).width <= width) cur = cand;
        else { lines.push(cur); cur = w; }
      }
      lines.push(cur);
    }
    return lines;
  }

  /** Height the text takes in [width]. */
  function height(str, width, size, bold = false, wrap = true) {
    const s = latinSafe(str ?? '').trim() || ' ';
    const font = fontFor(s, bold);
    const n = wrap ? wrapLines(s, font, size, width).length : 1;
    return n * lineHeight(font, size);
  }

  /**
   * Draw text in a box. opts: { size, bold, color, width, height, align ('left'|'right'|'center'), valign ('top'|'middle'), wrap }
   * Without wrap, a line that is too long is shrunk (down to 70 %) and then cut.
   */
  function tx(str, x, y, opts = {}) {
    const s = latinSafe(str ?? '').trim();
    if (!s) return 0;
    let size = opts.size || 8;
    const font = fontFor(s, opts.bold);
    const width = opts.width || 200;
    const align = opts.align || (ar || hasArabic(s) ? 'right' : 'left');
    let lines;
    if (opts.wrap) lines = wrapLines(s, font, size, width);
    else {
      lines = [s];
      while (size > (opts.size || 8) * 0.7 && pieces(s, font, size).width > width) size -= 0.25;
      if (pieces(s, font, size).width > width) {
        // still too long: cut words from the end (logical) and add "..."
        const words = s.split(/\s+/);
        while (words.length > 1 && pieces(`${words.join(' ')}...`, font, size).width > width) words.pop();
        lines = [`${words.join(' ')}...`];
      }
    }
    const lh = lineHeight(font, size);
    const total = lines.length * lh;
    let yy = y;
    if (opts.valign === 'middle' && opts.height) yy = y + Math.max(0, (opts.height - Math.min(total, opts.height)) / 2) + (font.startsWith('TJ') ? 1 : 0);
    doc.fillColor(opts.color || colors.ink);
    for (const line of lines) {
      if (opts.height && yy + lh > y + opts.height + 2 && line !== lines[0]) break;
      const p = pieces(line, font, size);
      let xx = align === 'right' ? x + width - p.width : align === 'center' ? x + (width - p.width) / 2 : x;
      doc.font(font).fontSize(size);
      for (const piece of p.list) {
        doc.text(piece.text, xx, yy, { lineBreak: false, features: piece.features });
        xx += piece.width;
      }
      yy += lh;
    }
    return total;
  }

  /** Width of one line of text. */
  function width(str, size, bold = false) {
    const s = latinSafe(str ?? '').trim();
    return s ? pieces(s, fontFor(s, bold), size).width : 0;
  }

  return { tx, height, width, hasArabic, fontFor };
}

module.exports = { writer, runs, hasArabic, register };
