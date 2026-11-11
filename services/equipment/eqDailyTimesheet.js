// services/equipment/eqDailyTimesheet.js — the WEEKLY EQUIPMENT TIMESHEET as an Excel workbook (Nov 2026).
// (The file keeps its first name: the weekly sheet replaced the daily one.)
// One worksheet per vendor, A4 landscape, two machines per page:
//   letterhead + the week (the day after the weekly off day .. the day before it, e.g. Saturday .. Thursday)
//   vendor bar (repeated on every printed page)
//   one framed block per machine (site + shift): a row per day with Day | In | Out | Lunch (min) | Our supervisor |
//     Vendor driver | Remarks. The two signature cells are always empty (signed by hand every day).
//     A day the machine is not on site is a grey line with the reason; the weekly off day (Friday) appears only when
//     the machine worked that day.
//   at the end of the vendor: Accountant and Administration (final approval) signatures.
// A day with nothing recorded keeps its cells empty for the pen; a recorded day comes out filled.
//   weekOf(date, offDay) -> { start, days[7], from, to, offDate }
//   loadData(conn, { date, offDay, shift, siteIds|null, supervisorPairs|null }) -> plain data (no Excel)
//   renderWorkbook(data, meta) -> { buffer, fileName }
'use strict';

const fs = require('fs');
const ExcelJS = require('exceljs');
const { covers } = require('../../utils/ranges');
const { addDays, dayOfWeek } = require('../../utils/businessDate');

const BRAND = {
  charcoal: 'FF3B3B3B', gold: 'FFC5A55A', goldText: 'FFB08D3E', goldLight: 'FFF4EFE2', goldSoft: 'FFFAF6EC', grid: 'FFD9D3C4',
  ink: 'FF2B2B2B', muted: 'FF6E6A62', white: 'FFFFFFFF', off: 'FFF2F2F2', offText: 'FF8A8A8A',
};
const FONT = 'Calibri';
const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const WIDTHS = [14, 9, 9, 10, 23, 23, 45];
const HEAD = ['Day', 'In', 'Out', 'Lunch (min)', 'Our supervisor', 'Vendor driver', 'Remarks'];
const SHIFT_ORDER = { Day: 0, Night: 1 };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// row heights (points) and the page budget used to keep a machine block on one page
const H = { r1: 22, r2: 16, r3: 12, line: 3, gap: 3, vendor: 18, blockGap: 8, machine: 19, head: 16, day: 21, footGap: 10, footTitle: 16, name: 20, sign: 26, date: 18 };
const PAGE = 512; // A4 landscape with these margins holds about 523 pt of rows (Excel); a small margin is kept
const VENDOR_ROW = 6;

const thin = (argb = BRAND.grid) => ({ style: 'thin', color: { argb } });
const medium = { style: 'medium', color: { argb: BRAND.charcoal } };
const dashed = { style: 'dashed', color: { argb: BRAND.gold } };

// ------------------------------------------------------------------ dates (pure)

const parts = (d) => String(d).slice(0, 10).split('-').map(Number);
/** 'YYYY-MM-DD' -> 'Sat 7 Nov' */
function shortDay(d) { const [, m, day] = parts(d); return `${WD[dayOfWeek(d)]} ${day} ${MONTHS[m - 1]}`; }
/** 'YYYY-MM-DD' -> 'Saturday 7 Nov 2026' */
function longDay(d) { const [y, m, day] = parts(d); return `${WEEKDAYS[dayOfWeek(d)]} ${day} ${MONTHS[m - 1]} ${y}`; }
function dayDiff(a, b) { const ms = (s) => { const [y, m, d] = parts(s); return Date.UTC(y, m - 1, d); }; return Math.round((ms(b) - ms(a)) / 86400000); }

/** The week of a date: it starts the day after the weekly off day; the off day is its last (7th) day. */
function weekOf(date, offDay) {
  const off = Number.isInteger(offDay) && offDay >= 0 && offDay <= 6 ? offDay : 5;
  const startDow = (off + 1) % 7;
  const back = (dayOfWeek(date) - startDow + 7) % 7;
  const start = addDays(date, -back);
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(start, i));
  return { start, days, from: days[0], to: days[5], offDate: days[6] };
}

/** 'Saturday 7 – Thursday 12 Nov 2026' (months / years written when they differ) */
function weekLabel(w) {
  const [y1, m1, d1] = parts(w.from); const [y2, m2, d2] = parts(w.to);
  const a = `${WEEKDAYS[dayOfWeek(w.from)]} ${d1}${m1 !== m2 || y1 !== y2 ? ` ${MONTHS[m1 - 1]}` : ''}${y1 !== y2 ? ` ${y1}` : ''}`;
  return `${a} – ${WEEKDAYS[dayOfWeek(w.to)]} ${d2} ${MONTHS[m2 - 1]} ${y2}`;
}

/** A time of the session as HH:mm, with (+1)/(-1) when it is not on the record date (night shift). */
function timeOn(dt, recordDate) {
  if (!dt) return '';
  const s = String(dt);
  const diff = dayDiff(recordDate, s.slice(0, 10));
  return diff ? `${s.slice(11, 16)} (${diff > 0 ? '+' : ''}${diff})` : s.slice(11, 16);
}

function dmyTime(s) {
  const t = String(s || '');
  return t.length < 16 ? t : `${t.slice(8, 10)}/${t.slice(5, 7)}/${t.slice(0, 4)} ${t.slice(11, 16)}`;
}

// ------------------------------------------------------------------ lines (pure)

const STATUS_NOTE = { Standby: 'Standby (all day)', Breakdown: 'Breakdown (all day)', Absent: 'Absent', Holiday: 'Holiday' };

/** One day of a machine. kind: 'filled' | 'blank' (on site, nothing recorded) | 'off' (not on site). */
function dayLine(day, row, periods, offReason) {
  if (!row) return offReason ? { day, kind: 'off', note: offReason } : { day, kind: 'blank' };
  const notes = [];
  const seen = new Set();
  const add = (t) => { const s = String(t || '').trim(); if (s && !seen.has(s)) { seen.add(s); notes.push(s); } };
  if (row.day_status !== 'Working') add(STATUS_NOTE[row.day_status] || row.day_status);
  else if (row.check_in_time && !row.check_out_time) add('In progress');
  add(row.work_description);
  add(row.remarks);
  for (const p of periods || []) {
    const span = `${timeOn(p.start_time, day)}-${p.end_time ? timeOn(p.end_time, day) : '...'}`;
    add(`${p.downtime_type} ${span}${p.reason ? `: ${String(p.reason).trim()}` : ''}`);
  }
  const finished = Boolean(row.check_in_time && row.check_out_time);
  const brk = Number(row.break_minutes || 0);
  return {
    day, kind: 'filled',
    in: timeOn(row.check_in_time, day),
    out: timeOn(row.check_out_time, day),
    lunch: row.check_in_time && (finished || brk > 0) ? brk : null,
    remarks: notes.join(' · '),
  };
}

/** Why a machine is not on site on a day, from its deployments in the week ([{from, to}]). */
function offReason(day, ranges) {
  if (!ranges.length) return 'Not on site';
  const starts = ranges.map((r) => r.from).sort();
  const ends = ranges.map((r) => r.to).filter(Boolean).sort();
  if (starts.every((s) => s > day)) return `Not on site: arrives ${shortDay(starts[0])}`;
  if (ends.length === ranges.length && ends.every((e) => e < day)) return `Not on site: left after ${shortDay(ends[ends.length - 1])}`;
  return 'Not on site';
}

// ------------------------------------------------------------------ data

/**
 * opts: { date, offDay, shift: 'Day'|'Night'|'All', siteIds: number[]|null, supervisorPairs: [{site_id, shift_type}]|null }
 * Machines = deployed at least one day of the week + any machine with a (not cancelled) row in the week.
 */
async function loadData(conn, opts) {
  const week = weekOf(opts.date, opts.offDay);
  const first = week.days[0]; const last = week.days[6];
  const shifts = opts.shift === 'Day' || opts.shift === 'Night' ? [opts.shift] : ['Day', 'Night'];
  let siteIds = opts.siteIds && opts.siteIds.length ? [...new Set(opts.siteIds)] : null;
  let pairKeys = null;
  const empty = { week, shift: opts.shift, vendors: [], machineCount: 0 };
  if (opts.supervisorPairs) {
    const pairs = opts.supervisorPairs.filter((p) => shifts.includes(p.shift_type) && (!siteIds || siteIds.includes(p.site_id)));
    pairKeys = new Set(pairs.map((p) => `${p.site_id}|${p.shift_type}`));
    siteIds = [...new Set(pairs.map((p) => p.site_id))];
    if (!siteIds.length) return empty;
  }
  const siteSql = siteIds ? ' AND x.site_id IN (?)' : '';
  const tail = [shifts, ...(siteIds ? [siteIds] : [])];
  const MACHINE = 'e.equipment_code, e.machine_label, e.plate_number, e.vendor_id, vd.vendor_name, t.type_name';
  const JOINS = 'JOIN eq_types t ON t.type_id = e.type_id JOIN eq_vendors vd ON vd.vendor_id = e.vendor_id';

  const [deps] = await conn.query(
    `SELECT x.site_id, x.shift_type, x.equipment_id, x.assigned_date, x.unassigned_date, o.full_name AS default_operator_name, ${MACHINE}
     FROM eq_site_assignments x JOIN eq_equipment e ON e.equipment_id = x.equipment_id ${JOINS}
     LEFT JOIN eq_operators o ON o.operator_id = x.default_operator_id
     WHERE x.assigned_date <= ? AND (x.unassigned_date IS NULL OR x.unassigned_date >= ?)
       AND (x.unassigned_date IS NULL OR x.unassigned_date >= x.assigned_date) AND x.shift_type IN (?)${siteSql}
     ORDER BY x.assigned_date`,
    [last, first, ...tail]);
  const [rows] = await conn.query(
    `SELECT x.eq_attendance_id, x.site_id, x.shift_type, x.equipment_id, x.record_date, x.day_status, x.check_in_time, x.check_out_time,
            x.break_minutes, x.work_description, x.remarks, o.full_name AS operator_name, ${MACHINE}
     FROM eq_attendance x JOIN eq_equipment e ON e.equipment_id = x.equipment_id ${JOINS}
     LEFT JOIN eq_operators o ON o.operator_id = x.operator_id
     WHERE x.record_date BETWEEN ? AND ? AND x.status <> 'Cancelled' AND x.shift_type IN (?)${siteSql}
     ORDER BY x.record_date`,
    [first, last, ...tail]);

  const inScope = (r) => !pairKeys || pairKeys.has(`${r.site_id}|${r.shift_type}`);
  const key = (r) => `${r.site_id}|${r.shift_type}|${r.equipment_id}`;
  const blocks = new Map();
  const blockOf = (r) => {
    const k = key(r);
    if (!blocks.has(k)) {
      blocks.set(k, {
        site_id: r.site_id, shift_type: r.shift_type, equipment_id: r.equipment_id, equipment_code: r.equipment_code,
        label: r.machine_label || r.type_name || '', plate: r.plate_number || '', vendor_id: r.vendor_id, vendor_name: r.vendor_name,
        ranges: [], rowsByDay: {}, driver: null,
      });
    }
    return blocks.get(k);
  };
  for (const d of deps) {
    if (!inScope(d)) continue;
    const b = blockOf(d);
    b.ranges.push({ from: String(d.assigned_date).slice(0, 10), to: d.unassigned_date ? String(d.unassigned_date).slice(0, 10) : null });
    if (d.default_operator_name) b.driver = d.default_operator_name; // ordered by assigned_date: the latest deployment wins
  }
  for (const r of rows) {
    if (!inScope(r)) continue;
    const b = blockOf(r);
    b.rowsByDay[String(r.record_date).slice(0, 10)] = r;
    if (!b.driver && r.operator_name) b.lastOperator = r.operator_name;
  }
  if (!blocks.size) return empty;

  const rowIds = [];
  for (const b of blocks.values()) for (const r of Object.values(b.rowsByDay)) rowIds.push(r.eq_attendance_id);
  const periodsBy = {};
  if (rowIds.length) {
    const [periods] = await conn.query(
      `SELECT eq_attendance_id, downtime_type, start_time, end_time, reason FROM eq_downtime_periods
       WHERE eq_attendance_id IN (?) AND downtime_type IN ('Breakdown', 'Standby') ORDER BY start_time, downtime_id`, [rowIds]);
    for (const p of periods) (periodsBy[p.eq_attendance_id] = periodsBy[p.eq_attendance_id] || []).push(p);
  }
  const usedSites = [...new Set([...blocks.values()].map((b) => b.site_id))];
  const [sites] = await conn.query('SELECT site_id, site_code, site_name FROM sites WHERE site_id IN (?)', [usedSites]);
  const siteInfo = Object.fromEntries(sites.map((s) => [s.site_id, s]));

  const byText = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
  const vendors = new Map();
  for (const b of blocks.values()) {
    const s = siteInfo[b.site_id] || { site_code: `#${b.site_id}`, site_name: '' };
    const lines = [];
    week.days.forEach((day, i) => {
      const row = b.rowsByDay[day] || null;
      const onSite = b.ranges.some((r) => covers(r.from, r.to, day));
      if (i === 6 && !row) return; // the weekly off day: only when the machine worked
      lines.push(dayLine(day, row, row ? periodsBy[row.eq_attendance_id] : null, row || onSite ? null : offReason(day, b.ranges)));
    });
    const block = {
      site_id: b.site_id, site_code: s.site_code, site_name: s.site_name, shift_type: b.shift_type,
      equipment_code: b.equipment_code, label: b.label, plate: b.plate, driver: b.driver || b.lastOperator || '', lines,
    };
    if (!vendors.has(b.vendor_id)) vendors.set(b.vendor_id, { vendor_id: b.vendor_id, vendor_name: b.vendor_name, blocks: [] });
    vendors.get(b.vendor_id).blocks.push(block);
  }
  const list = [...vendors.values()].sort((a, b) => byText(a.vendor_name, b.vendor_name));
  for (const v of list) {
    v.blocks.sort((a, b) => byText(a.site_code, b.site_code) || SHIFT_ORDER[a.shift_type] - SHIFT_ORDER[b.shift_type] || byText(a.equipment_code, b.equipment_code));
    v.sites = [...new Set(v.blocks.map((x) => x.site_code))];
  }
  return { week, shift: opts.shift, vendors: list, machineCount: blocks.size };
}

// ------------------------------------------------------------------ Excel

function style(cell, o = {}) {
  cell.font = { name: FONT, size: o.size || 10, bold: Boolean(o.bold), italic: Boolean(o.italic), color: { argb: o.color || BRAND.ink } };
  cell.alignment = { vertical: 'middle', horizontal: o.align || 'left', wrapText: o.wrap !== false, indent: o.indent || 0, shrinkToFit: Boolean(o.shrink) && o.wrap === false };
  if (o.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: o.fill } };
  if (o.numFmt) cell.numFmt = o.numFmt;
}

/** Writes a value into a row range of A..G ("A5:B5" or "C7"), merged when needed, styled on every cell. */
function put(ws, range, value, o = {}) {
  const [a, b] = range.split(':');
  if (b) ws.mergeCells(range);
  const first = ws.getCell(a);
  first.value = value === undefined || value === '' ? null : value;
  const row = Number(a.replace(/[A-Z]+/, ''));
  const c1 = COLS.indexOf(a.replace(/\d+/, ''));
  const c2 = b ? COLS.indexOf(b.replace(/\d+/, '')) : c1;
  for (let c = c1; c <= c2; c += 1) {
    const cell = ws.getCell(`${COLS[c]}${row}`);
    style(cell, o);
    if (o.border !== false) cell.border = o.border || { top: thin(), left: thin(), bottom: thin(), right: thin() };
  }
  return first;
}

const rich = (list) => ({ richText: list.map(([text, f]) => ({ text, font: { name: FONT, size: 10, color: { argb: BRAND.ink }, ...f } })) });

/** Rough row height for wrapped text (Excel does not grow a row by itself when the file is written). */
function heightFor(text, widthChars, min) {
  const s = String(text || '');
  if (!s) return min;
  const perLine = Math.max(10, Math.floor(widthChars * 1.2));
  const lines = s.split('\n').reduce((a, p) => a + Math.max(1, Math.ceil(p.length / perLine)), 0);
  return Math.max(min, lines * 12 + 6);
}

/** Medium charcoal frame around rows r1..r2 of A..G (keeps the inner borders). */
function frame(ws, r1, r2) {
  for (let r = r1; r <= r2; r += 1) {
    for (let c = 0; c < COLS.length; c += 1) {
      const cell = ws.getCell(`${COLS[c]}${r}`);
      const b = { ...(cell.border || {}) };
      if (r === r1) b.top = medium;
      if (r === r2) b.bottom = medium;
      if (c === 0) b.left = medium;
      if (c === COLS.length - 1) b.right = medium;
      cell.border = b;
    }
  }
}

function letterhead(ws, logoId, meta, data) {
  ws.mergeCells('A1:B3');
  if (logoId !== null) ws.addImage(logoId, { tl: { col: 0.1, row: 0.08 }, ext: { width: 92, height: 54 }, editAs: 'oneCell' });
  put(ws, 'C1:E1', meta.company, { bold: true, size: 12, color: BRAND.charcoal, border: false, wrap: false, shrink: true });
  put(ws, 'C2:E2', 'Plant & Equipment Department', { size: 9, color: BRAND.muted, border: false, wrap: false });
  put(ws, 'F1:G1', 'Weekly equipment timesheet', { bold: true, size: 16, color: BRAND.charcoal, align: 'right', border: false, wrap: false });
  put(ws, 'F2:G2', `${weekLabel(data.week)}${meta.shiftLabel ? `   ·   ${meta.shiftLabel}` : ''}`, { bold: true, size: 10.5, color: BRAND.goldText, align: 'right', border: false, wrap: false });
  ws.getRow(1).height = H.r1; ws.getRow(2).height = H.r2; ws.getRow(3).height = H.r3;
  ws.getRow(4).height = H.line;
  for (const c of COLS) ws.getCell(`${c}4`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.gold } };
  ws.getRow(5).height = H.gap;
}

function vendorBar(ws, v) {
  const r = VENDOR_ROW;
  const sites = v.sites.length > 3 ? `${v.sites.length} sites` : v.sites.join(', ');
  put(ws, `A${r}`, 'Vendor', { bold: true, color: BRAND.white, fill: BRAND.gold, indent: 1, wrap: false });
  put(ws, `B${r}:E${r}`, v.vendor_name, { bold: true, size: 11, color: BRAND.charcoal, indent: 1, wrap: false, shrink: true });
  put(ws, `F${r}`, rich([['Site  ', { size: 9, color: { argb: BRAND.muted } }], [sites, { bold: true }]]), { indent: 1, wrap: false, shrink: true });
  put(ws, `G${r}`, rich([['Machines  ', { size: 9, color: { argb: BRAND.muted } }], [String(v.blocks.length), { bold: true }]]), { indent: 1, wrap: false });
  ws.getRow(r).height = H.vendor;
  frame(ws, r, r);
}

/** Rows of one machine block, as { h, draw(r) }; the block is kept on one page. */
function blockRows(ws, b) {
  const out = [{ h: H.blockGap, spacer: true, draw: (r) => { ws.getRow(r).height = H.blockGap; } }];
  out.push({
    h: H.machine,
    draw: (r) => {
      put(ws, `A${r}`, b.equipment_code, { bold: true, size: 11, color: BRAND.white, fill: BRAND.gold, indent: 1, wrap: false, border: false });
      put(ws, `B${r}:D${r}`, rich([[b.label || '', { bold: true, color: { argb: BRAND.charcoal } }], ...(b.plate ? [[`  ·  Plate ${b.plate}`, { color: { argb: BRAND.muted } }]] : [])]),
        { indent: 1, wrap: false, shrink: true, border: false });
      put(ws, `E${r}:F${r}`, rich([['Driver: ', { size: 9.5, color: { argb: BRAND.muted } }], [b.driver || '______________________', { color: { argb: BRAND.ink } }]]),
        { indent: 1, wrap: false, shrink: true, border: { left: thin() } });
      put(ws, `G${r}`, rich([[`${b.shift_type} shift`, { bold: true, color: { argb: BRAND.charcoal } }], [`   ·   ${b.site_code}${b.site_name ? ` ${b.site_name}` : ''}`, { color: { argb: BRAND.muted } }]]),
        { indent: 1, wrap: false, shrink: true, border: { left: thin() } });
      ws.getRow(r).height = H.machine;
      b.firstRow = r;
    },
  });
  out.push({
    h: H.head,
    draw: (r) => {
      HEAD.forEach((t, i) => put(ws, `${COLS[i]}${r}`, t, {
        bold: true, size: 9.5, color: BRAND.white, fill: BRAND.charcoal, align: i === 0 || i === 6 ? 'left' : 'center', indent: i === 0 || i === 6 ? 1 : 0,
        wrap: false, border: { left: thin('FF5A5A5A'), right: thin('FF5A5A5A') },
      }));
      ws.getRow(r).height = H.head;
    },
  });
  for (const l of b.lines) {
    const h = l.kind === 'filled' ? heightFor(l.remarks, WIDTHS[6] - 2, H.day) : H.day;
    out.push({
      h,
      draw: (r) => {
        const [wd, rest] = [shortDay(l.day).split(' ')[0], shortDay(l.day).split(' ').slice(1).join(' ')];
        if (l.kind === 'off') {
          put(ws, `A${r}`, rich([[wd, { bold: true, color: { argb: BRAND.offText } }], [` ${rest}`, { color: { argb: BRAND.offText } }]]), { indent: 1, fill: BRAND.off, wrap: false });
          put(ws, `B${r}:G${r}`, l.note, { italic: true, size: 9.5, color: BRAND.offText, fill: BRAND.off, indent: 1, wrap: false });
        } else {
          put(ws, `A${r}`, rich([[wd, { bold: true }], [` ${rest}`, {}]]), { indent: 1, wrap: false });
          put(ws, `B${r}`, l.kind === 'filled' ? l.in : null, { align: 'center' });
          put(ws, `C${r}`, l.kind === 'filled' ? l.out : null, { align: 'center' });
          put(ws, `D${r}`, l.kind === 'filled' ? l.lunch : null, { align: 'center', numFmt: '0' });
          const sig = { fill: BRAND.goldSoft, border: { top: dashed, left: dashed, bottom: dashed, right: dashed } };
          put(ws, `E${r}`, null, sig);
          put(ws, `F${r}`, null, sig);
          put(ws, `G${r}`, l.kind === 'filled' ? l.remarks : null, { size: 9, indent: 1, wrap: true });
        }
        ws.getRow(r).height = h;
        b.lastRow = r;
      },
    });
  }
  // the frame once the last day is drawn
  const lastDraw = out[out.length - 1].draw;
  out[out.length - 1].draw = (r) => { lastDraw(r); frame(ws, b.firstRow, r); };
  return out;
}

function footerRows(ws) {
  const block = (r, from, to, title, sub) => {
    const at = (n) => (from === to ? `${from}${n}` : `${from}${n}:${to}${n}`);
    put(ws, at(r), rich([[title, { bold: true, color: { argb: BRAND.white } }], [`   ${sub}`, { size: 9, color: { argb: BRAND.gold } }]]),
      { fill: BRAND.charcoal, indent: 1, wrap: false, border: false });
    [['Name', H.name], ['Signature', H.sign], ['Date', H.date]].forEach(([label, h], i) => {
      put(ws, at(r + 1 + i), rich([[`${label}:`, { size: 9, color: { argb: BRAND.muted } }]]), {
        indent: 1, wrap: false, fill: i === 1 ? BRAND.goldSoft : undefined,
        border: { bottom: thin(BRAND.muted), left: thin(), right: thin() },
      });
    });
  };
  return [
    { h: H.footGap, spacer: true, draw: (r) => { ws.getRow(r).height = H.footGap; } },
    {
      h: H.footTitle + H.name + H.sign + H.date,
      rows: 4,
      draw: (r) => {
        block(r, 'A', 'D', 'Accountant', 'checked');
        block(r, 'G', 'G', 'Administration', 'final approval');
        ws.getRow(r).height = H.footTitle; ws.getRow(r + 1).height = H.name; ws.getRow(r + 2).height = H.sign; ws.getRow(r + 3).height = H.date;
      },
    },
  ];
}

/** A worksheet name Excel accepts (31 characters, no []:*?/\), unique in the workbook. */
function sheetName(name, used) {
  const base = (String(name || 'Vendor').replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim() || 'Vendor').slice(0, 31);
  let n = base; let i = 2;
  while (used.has(n.toLowerCase())) { const suffix = ` (${i})`; n = `${base.slice(0, 31 - suffix.length)}${suffix}`; i += 1; }
  used.add(n.toLowerCase());
  return n;
}

/**
 * meta: { company, logoPath, shiftLabel, printedAt, printedBy, fileName }
 */
async function renderWorkbook(data, meta) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Equipment Flow';
  wb.company = meta.company;
  wb.title = `Weekly equipment timesheet ${data.week.from} to ${data.week.to}`;
  wb.created = new Date();
  let logoId = null;
  try { if (meta.logoPath) logoId = wb.addImage({ buffer: fs.readFileSync(meta.logoPath), extension: 'png' }); } catch (_) { logoId = null; }
  const esc = (s) => String(s || '').replace(/&/g, '&&');
  const used = new Set();

  for (const v of data.vendors) {
    const ws = wb.addWorksheet(sheetName(v.vendor_name, used), {
      properties: { defaultRowHeight: 18 },
      views: [{ showGridLines: false, zoomScale: 100 }],
    });
    WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    ws.pageSetup = {
      paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true,
      margins: { left: 0.35, right: 0.35, top: 0.45, bottom: 0.55, header: 0.2, footer: 0.25 },
      printTitlesRow: `${VENDOR_ROW}:${VENDOR_ROW}`,
    };
    ws.headerFooter = {
      oddFooter: `&L&8&K6E6A62${esc(v.vendor_name)} · ${data.week.from} to ${data.week.to}&C&8&K6E6A62Page &P of &N&R&8&K6E6A62Printed ${esc(dmyTime(meta.printedAt))} by ${esc(meta.printedBy)}`,
    };
    letterhead(ws, logoId, meta, data);
    vendorBar(ws, v);

    // keep-together groups: one per machine block, then the signatures
    const groups = v.blocks.map((b) => blockRows(ws, b));
    groups.push(footerRows(ws));
    const FIRST = H.r1 + H.r2 + H.r3 + H.line + H.gap + H.vendor; // rows 1..6
    let r = VENDOR_ROW + 1;
    let y = FIRST;
    let pageHasBody = false;
    for (const g of groups) {
      const total = g.reduce((a, x) => a + x.h, 0);
      if (pageHasBody && y + total > PAGE) {
        ws.getRow(r - 1).addPageBreak();
        y = H.vendor; // the vendor bar repeats on the new page
        pageHasBody = false;
      }
      for (const x of g) {
        if (x.spacer && !pageHasBody) { // no empty band right under the vendor bar of a new page: a thin one
          ws.getRow(r).height = 4; r += 1; y += 4; continue;
        }
        x.draw(r);
        r += x.rows || 1;
        y += x.h;
        if (!x.spacer) pageHasBody = true;
      }
    }
    ws.pageSetup.printArea = `A1:G${r - 1}`;
  }
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, fileName: meta.fileName };
}

module.exports = { weekOf, weekLabel, loadData, renderWorkbook, dayLine, offReason, timeOn, shortDay, longDay };
