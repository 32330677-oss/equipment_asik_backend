// services/equipment/eqDailyTimesheet.js — the DAILY EQUIPMENT TIMESHEET as an Excel workbook (Nov 2026).
// One worksheet, printable on A4 landscape: every machine of the chosen day, grouped Site -> Shift -> Vendor,
// with 8 columns (# | Machine | Status | Start | End | Downtime (h) | Work (h) | Remarks) and two signatures at the end
// (Supervisor, Approved by). A machine with nothing recorded on the day keeps its cells EMPTY, so the sheet can be
// printed before the day and filled by hand; a recorded machine shows its data. Colours and logo of the company
// (charcoal #3B3B3B + gold #C5A55A, as on the payment certificate).
//   loadData(conn, { date, shift, siteIds|null, supervisorPairs|null }) -> plain data (no Excel)
//   renderWorkbook(data, meta) -> { buffer, fileName }
'use strict';

const fs = require('fs');
const ExcelJS = require('exceljs');
const { activeOnSql } = require('../../utils/ranges');

const BRAND = {
  charcoal: 'FF3B3B3B', gold: 'FFC5A55A', goldLight: 'FFF4EFE2', goldSoft: 'FFFAF6EC', grid: 'FFD9D3C4', ink: 'FF2B2B2B',
  muted: 'FF6E6A62', white: 'FFFFFFFF', totalFill: 'FFF7F5EF',
};
// light fill of the Status cell of a recorded machine
const STATUS_FILL = {
  Working: 'FFE3F1E8', Finished: 'FFE3F1E8', 'In progress': 'FFE4ECF7', Pending: 'FFF2F2F2',
  Breakdown: 'FFF7DEDA', Standby: 'FFFBEFD6', Absent: 'FFECECEC', Holiday: 'FFECECEC',
};
const STATUS_TEXT = { 'In progress': 'FF1F4E79', Breakdown: 'FFB03A2E', Standby: 'FF9A6700', Absent: 'FF555555', Holiday: 'FF555555' };
const SHIFT_ORDER = { Day: 0, Night: 1 };
const FONT = 'Calibri';
const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const WIDTHS = [5, 30, 13, 9, 10, 12, 10, 46];
const HEAD = ['#', 'Machine', 'Status', 'Start', 'End', 'Downtime (h)', 'Work (h)', 'Remarks'];
const HEAD_ROW = 9;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const thin = { style: 'thin', color: { argb: BRAND.grid } };
const ALL_BORDERS = { top: thin, left: thin, bottom: thin, right: thin };

// ------------------------------------------------------------------ small formatters (pure)

/** 'YYYY-MM-DD' -> 'Tuesday, 10 Nov 2026' */
function longDate(d) {
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
  return `${WEEKDAYS[wd]}, ${day} ${MONTHS[m - 1]} ${y}`;
}

/** 'YYYY-MM-DD HH:mm[:ss]' -> 'dd/mm/yyyy HH:mm' */
function dmyTime(s) {
  const t = String(s || '');
  if (t.length < 16) return t;
  return `${t.slice(8, 10)}/${t.slice(5, 7)}/${t.slice(0, 4)} ${t.slice(11, 16)}`;
}

/** Days between two 'YYYY-MM-DD' dates (b - a). */
function dayDiff(a, b) {
  const ms = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((ms(b) - ms(a)) / 86400000);
}

/** A time of the session as HH:mm, with (+1)/(-1) when it is not on the record date (night shift). */
function timeOn(dt, recordDate) {
  if (!dt) return '';
  const s = String(dt);
  const hm = s.slice(11, 16);
  const diff = dayDiff(recordDate, s.slice(0, 10));
  if (!diff) return hm;
  return `${hm} (${diff > 0 ? '+' : ''}${diff})`;
}

const hours = (min) => Math.round((Number(min || 0) / 60) * 100) / 100;

/** Status text of a recorded row (no row -> '' : the cell stays empty for the pen). */
function statusOf(row) {
  if (!row) return '';
  if (row.day_status === 'Working') {
    if (!row.check_in_time) return 'Pending';
    if (!row.check_out_time) return 'In progress';
    return 'Working';
  }
  return row.day_status; // Standby | Breakdown | Absent | Holiday
}

/** Remarks of a recorded row: work done, remarks, then each breakdown/standby period with its reason. */
function remarksOf(row, periods, recordDate) {
  if (!row) return '';
  const parts = [];
  const seen = new Set();
  const add = (t) => { const s = String(t || '').trim(); if (s && !seen.has(s)) { seen.add(s); parts.push(s); } };
  add(row.work_description);
  add(row.remarks);
  for (const p of periods || []) {
    if (p.downtime_type !== 'Breakdown' && p.downtime_type !== 'Standby') continue;
    const span = `${timeOn(p.start_time, recordDate)}-${p.end_time ? timeOn(p.end_time, recordDate) : '...'}`;
    add(`${p.downtime_type} ${span}${p.reason ? `: ${String(p.reason).trim()}` : ''}`);
  }
  return parts.join(' · ');
}

/** One printed line of a machine. Every value is '' / null when nothing is recorded (paper mode). */
function lineOf(m, row, periods, date) {
  const machine = { code: m.equipment_code, label: m.machine_label || m.type_name || '' };
  if (!row) return { machine, filled: false, status: '', start: '', end: '', downtime: null, work: null, remarks: '' };
  const status = statusOf(row);
  const hasTimes = Boolean(row.check_in_time);
  const finished = Boolean(row.check_in_time && row.check_out_time);
  let work = null;
  if (row.day_status === 'Working') work = finished && row.working_minutes !== null && row.working_minutes !== undefined ? hours(row.working_minutes) : null;
  else work = 0; // Standby, Breakdown, Absent, Holiday: no work
  const downMin = Number(row.breakdown_minutes || 0) + Number(row.standby_minutes || 0);
  return {
    machine, filled: true, status,
    start: timeOn(row.check_in_time, date),
    end: timeOn(row.check_out_time, date),
    downtime: hasTimes && (finished || downMin > 0) ? hours(downMin) : null, // a session still open: only what is known
    work,
    remarks: remarksOf(row, periods, date),
  };
}

// ------------------------------------------------------------------ data

/**
 * opts: { date, shift: 'Day'|'Night'|'All', siteIds: number[]|null (null = every site),
 *         supervisorPairs: [{site_id, shift_type}]|null (a supervisor: only these site/shifts) }
 * Machines = deployed on the date (active machine) + any machine with a (not cancelled) row on the date.
 */
async function loadData(conn, opts) {
  const { date } = opts;
  const shifts = opts.shift === 'Day' || opts.shift === 'Night' ? [opts.shift] : ['Day', 'Night'];
  let siteIds = opts.siteIds && opts.siteIds.length ? [...new Set(opts.siteIds)] : null;
  let pairKeys = null;
  if (opts.supervisorPairs) {
    const pairs = opts.supervisorPairs.filter((p) => shifts.includes(p.shift_type) && (!siteIds || siteIds.includes(p.site_id)));
    pairKeys = new Set(pairs.map((p) => `${p.site_id}|${p.shift_type}`));
    siteIds = [...new Set(pairs.map((p) => p.site_id))];
    if (!siteIds.length) return { date, shift: opts.shift, sites: [], machineCount: 0, filledCount: 0 };
  }

  const siteSql = siteIds ? ' AND x.site_id IN (?)' : '';
  const params = (lead) => [...lead, shifts, ...(siteIds ? [siteIds] : [])];
  const MACHINE = `e.equipment_code, e.machine_label, e.vendor_id, vd.vendor_name, t.type_name`;
  const JOINS = 'JOIN eq_types t ON t.type_id = e.type_id JOIN eq_vendors vd ON vd.vendor_id = e.vendor_id';

  const [deps] = await conn.query(
    `SELECT x.site_id, x.shift_type, x.equipment_id, ${MACHINE}
     FROM eq_site_assignments x JOIN eq_equipment e ON e.equipment_id = x.equipment_id AND e.status = 'Active' ${JOINS}
     WHERE ${activeOnSql('x', 'assigned_date', 'unassigned_date')} AND x.shift_type IN (?)${siteSql}`,
    params([date, date]));
  const [rows] = await conn.query(
    `SELECT x.eq_attendance_id, x.site_id, x.shift_type, x.equipment_id, x.day_status, x.status, x.check_in_time, x.check_out_time,
            x.breakdown_minutes, x.standby_minutes, x.working_minutes, x.work_description, x.remarks, ${MACHINE}
     FROM eq_attendance x JOIN eq_equipment e ON e.equipment_id = x.equipment_id ${JOINS}
     WHERE x.record_date = ? AND x.status <> 'Cancelled' AND x.shift_type IN (?)${siteSql}`,
    params([date]));

  const inScope = (r) => !pairKeys || pairKeys.has(`${r.site_id}|${r.shift_type}`);
  const key = (r) => `${r.site_id}|${r.shift_type}|${r.equipment_id}`;
  const rowBy = new Map();
  for (const r of rows) if (inScope(r)) rowBy.set(key(r), r);
  const machines = new Map();
  for (const d of deps) if (inScope(d) && !machines.has(key(d))) machines.set(key(d), d);
  for (const r of rows) if (inScope(r) && !machines.has(key(r))) machines.set(key(r), r); // recorded without a deployment

  const list = [...machines.values()];
  if (!list.length) return { date, shift: opts.shift, sites: [], machineCount: 0, filledCount: 0 };

  const rowIds = [...rowBy.values()].map((r) => r.eq_attendance_id);
  const periodsBy = {};
  if (rowIds.length) {
    const [periods] = await conn.query(
      `SELECT eq_attendance_id, downtime_type, start_time, end_time, reason FROM eq_downtime_periods
       WHERE eq_attendance_id IN (?) AND downtime_type IN ('Breakdown', 'Standby') ORDER BY start_time, downtime_id`, [rowIds]);
    for (const p of periods) (periodsBy[p.eq_attendance_id] = periodsBy[p.eq_attendance_id] || []).push(p);
  }
  const usedSites = [...new Set(list.map((m) => m.site_id))];
  const [sites] = await conn.query('SELECT site_id, site_code, site_name FROM sites WHERE site_id IN (?)', [usedSites]);
  const [sups] = await conn.query(
    `SELECT ss.site_id, ss.shift_type, u.full_name FROM site_supervisors ss JOIN users u ON u.user_id = ss.user_id
     WHERE ss.site_id IN (?) AND ${activeOnSql('ss', 'from_date', 'to_date')} ORDER BY u.full_name`, [usedSites, date, date]);
  const supBy = {};
  for (const s of sups) {
    const k = `${s.site_id}|${s.shift_type}`;
    supBy[k] = supBy[k] || [];
    if (!supBy[k].includes(s.full_name)) supBy[k].push(s.full_name);
  }

  // group Site -> Shift -> Vendor -> machines
  const byCode = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
  const siteInfo = Object.fromEntries(sites.map((s) => [s.site_id, s]));
  const out = [];
  let filledCount = 0;
  for (const siteId of usedSites) {
    const s = siteInfo[siteId] || { site_id: siteId, site_code: `#${siteId}`, site_name: '' };
    const siteMachines = list.filter((m) => m.site_id === siteId);
    const shiftGroups = [];
    for (const sh of shifts) {
      const shMachines = siteMachines.filter((m) => m.shift_type === sh);
      if (!shMachines.length) continue;
      const vendors = new Map();
      for (const m of shMachines) {
        if (!vendors.has(m.vendor_id)) vendors.set(m.vendor_id, { vendor_id: m.vendor_id, vendor_name: m.vendor_name, lines: [] });
        const row = rowBy.get(key(m)) || null;
        const line = lineOf(m, row, row ? periodsBy[row.eq_attendance_id] : null, date);
        if (line.filled) filledCount += 1;
        vendors.get(m.vendor_id).lines.push(line);
      }
      const vList = [...vendors.values()].sort((a, b) => byCode(a.vendor_name, b.vendor_name));
      for (const v of vList) v.lines.sort((a, b) => byCode(a.machine.code, b.machine.code));
      shiftGroups.push({ shift_type: sh, supervisors: supBy[`${siteId}|${sh}`] || [], count: shMachines.length, vendors: vList });
    }
    if (shiftGroups.length) out.push({ site_id: siteId, site_code: s.site_code, site_name: s.site_name, shifts: shiftGroups });
  }
  out.sort((a, b) => byCode(a.site_code, b.site_code));
  return { date, shift: opts.shift, sites: out, machineCount: list.length, filledCount };
}

// ------------------------------------------------------------------ Excel

function style(cell, o = {}) {
  cell.font = { name: FONT, size: o.size || 10, bold: Boolean(o.bold), italic: Boolean(o.italic), color: { argb: o.color || BRAND.ink } };
  cell.alignment = { vertical: 'middle', horizontal: o.align || 'left', wrapText: o.wrap !== false, indent: o.indent || 0, shrinkToFit: Boolean(o.shrink) && o.wrap === false };
  if (o.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: o.fill } };
  if (o.numFmt) cell.numFmt = o.numFmt;
}

/** Writes a value into A..H of a row range ("A5:B5" or "C7"), merged when needed, styled on every cell. */
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
    if (o.border !== false) cell.border = o.border || ALL_BORDERS;
  }
  return first;
}

const rich = (parts) => ({ richText: parts.map(([text, f]) => ({ text, font: { name: FONT, size: 10, color: { argb: BRAND.ink }, ...f } })) });

/** Rough row height for wrapped text in a column (Excel does not grow a row by itself when the file is written). */
function heightFor(text, widthChars, min) {
  const s = String(text || '');
  if (!s) return min;
  const perLine = Math.max(10, Math.floor(widthChars * 1.15));
  const lines = s.split('\n').reduce((a, part) => a + Math.max(1, Math.ceil(part.length / perLine)), 0);
  return Math.max(min, lines * 13 + 7);
}

function letterhead(ws, logoId, meta, data) {
  ws.mergeCells('A1:B3');
  if (logoId !== null) ws.addImage(logoId, { tl: { col: 0.12, row: 0.12 }, ext: { width: 112, height: 65 }, editAs: 'oneCell' });
  put(ws, 'C1:E1', meta.company, { bold: true, size: 13, color: BRAND.charcoal, border: false, wrap: false, shrink: true });
  put(ws, 'C2:E2', 'Plant & Equipment Department', { size: 9, color: BRAND.muted, border: false, wrap: false });
  put(ws, 'F1:H1', 'DAILY EQUIPMENT TIMESHEET', { bold: true, size: 16, color: BRAND.charcoal, align: 'right', border: false, wrap: false });
  put(ws, 'F2:H2', `${longDate(data.date)}  ·  ${meta.shiftLabel}`, { bold: true, size: 10.5, color: BRAND.gold, align: 'right', border: false, wrap: false });
  ws.getRow(1).height = 26; ws.getRow(2).height = 20; ws.getRow(3).height = 18;
  ws.getRow(4).height = 4;
  for (const c of COLS) ws.getCell(`${c}4`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.gold } };
  ws.getRow(5).height = 6;

  const info = (range, label, value) => put(ws, range, rich([[`${label}  `, { bold: true, color: { argb: BRAND.muted }, size: 9 }], [String(value), { bold: true, size: 10 }]]),
    { fill: BRAND.goldSoft, wrap: false, shrink: true, indent: 1 });
  info('A6:B6', 'Date', longDate(data.date));
  info('C6:E6', 'Shift', meta.shiftLabel);
  info('F6:H6', meta.personLabel, meta.personName);
  info('A7:B7', 'Sites', meta.sitesText);
  info('C7:E7', 'Machines', String(data.machineCount));
  info('F7:H7', 'Printed', `${dmyTime(meta.printedAt)}  by ${meta.printedBy}`);
  ws.getRow(6).height = 20; ws.getRow(7).height = 20;
  ws.getRow(8).height = 8;

  HEAD.forEach((h, i) => put(ws, `${COLS[i]}${HEAD_ROW}`, h, {
    bold: true, size: 10, color: BRAND.white, fill: BRAND.charcoal, align: i === 1 || i === 7 ? 'left' : 'center', indent: i === 1 || i === 7 ? 1 : 0,
    border: { top: { style: 'thin', color: { argb: BRAND.charcoal } }, bottom: { style: 'medium', color: { argb: BRAND.gold } }, left: { style: 'thin', color: { argb: 'FF5A5A5A' } }, right: { style: 'thin', color: { argb: 'FF5A5A5A' } } },
  }));
  ws.getRow(HEAD_ROW).height = 22;
}

function band(ws, r, value, o, height) {
  put(ws, `A${r}:H${r}`, value, { ...o, wrap: false, border: false });
  ws.getRow(r).height = height;
}

function signatures(ws, r) {
  const block = (from, to, title) => {
    put(ws, `${from}${r}:${to}${r}`, title, { bold: true, size: 10, color: BRAND.white, fill: BRAND.charcoal, indent: 1, wrap: false, border: false });
    ['Name', 'Signature', 'Date'].forEach((label, i) => {
      put(ws, `${from}${r + 1 + i}:${to}${r + 1 + i}`, rich([[`${label}:`, { size: 9, color: { argb: BRAND.muted } }]]), {
        indent: 1, wrap: false, border: { bottom: { style: 'thin', color: { argb: BRAND.muted } } }, fill: i === 1 ? BRAND.goldSoft : undefined,
      });
    });
  };
  block('A', 'C', 'SUPERVISOR');
  block('F', 'H', 'APPROVED BY');
  ws.getRow(r).height = 20;
  ws.getRow(r + 1).height = 26; ws.getRow(r + 2).height = 40; ws.getRow(r + 3).height = 26;
}

/**
 * meta: { company, logoPath, shiftLabel, personLabel, personName, sitesText, printedAt, printedBy, fileName }
 */
async function renderWorkbook(data, meta) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Equipment Flow';
  wb.company = meta.company;
  wb.title = `Daily equipment timesheet ${data.date}`;
  wb.created = new Date();
  let logoId = null;
  try { if (meta.logoPath) logoId = wb.addImage({ buffer: fs.readFileSync(meta.logoPath), extension: 'png' }); } catch (_) { logoId = null; }

  const ws = wb.addWorksheet('Timesheet', {
    properties: { defaultRowHeight: 18 },
    views: [{ state: 'frozen', ySplit: HEAD_ROW, showGridLines: false, zoomScale: 100 }],
  });
  WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.pageSetup = {
    paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true,
    margins: { left: 0.35, right: 0.35, top: 0.45, bottom: 0.55, header: 0.2, footer: 0.25 },
    printTitlesRow: `${HEAD_ROW}:${HEAD_ROW}`,
  };
  ws.headerFooter = {
    oddFooter: `&L&8&K6E6A62Equipment Flow · Daily equipment timesheet ${data.date}&C&8&K6E6A62Page &P of &N&R&8&K6E6A62${meta.company.replace(/&/g, '&&')}`,
  };

  letterhead(ws, logoId, meta, data);

  // ---- the body is built as KEEP-TOGETHER groups of rows, then laid out page by page (manual page breaks), so a
  // site/shift/vendor title never stays alone at the bottom of a page and the signatures are never split.
  // Each row: { h: height in points, draw(r) } ; a spacer row has spacer: true (dropped at the top of a page).
  const groups = [];
  const vendorTotals = [];
  const siteRow = (site) => ({
    h: 22,
    draw: (r) => band(ws, r, rich([['SITE   ', { bold: true, size: 10, color: { argb: BRAND.gold } }],
      [`${site.site_code}${site.site_name ? `  —  ${site.site_name}` : ''}`, { bold: true, size: 11.5, color: { argb: BRAND.white } }]]), { fill: BRAND.charcoal, indent: 1 }, 22),
  });
  const shiftRow = (sh) => ({
    h: 19,
    draw: (r) => {
      const sup = sh.supervisors.length ? `   ·   Supervisor: ${sh.supervisors.join(', ')}` : '';
      band(ws, r, `${sh.shift_type === 'Night' ? 'NIGHT' : 'DAY'} SHIFT   ·   ${sh.count} machine${sh.count === 1 ? '' : 's'}${sup}`,
        { bold: true, size: 10, color: BRAND.white, fill: BRAND.gold, indent: 1 }, 19);
    },
  });
  const vendorRow = (v) => ({
    h: 19,
    draw: (r) => {
      band(ws, r, rich([['Vendor:  ', { size: 9.5, color: { argb: BRAND.muted } }], [v.vendor_name, { bold: true, size: 10.5, color: { argb: BRAND.charcoal } }],
        [`   ·   ${v.lines.length} machine${v.lines.length === 1 ? '' : 's'}`, { size: 9.5, color: { argb: BRAND.muted } }]]), { fill: BRAND.goldLight, indent: 1 }, 19);
      ws.getCell(`A${r}`).border = { left: { style: 'thick', color: { argb: BRAND.gold } } };
    },
  });
  const lineRow = (v, l, i) => {
    const min = l.filled ? 24 : 28; // an empty line leaves room to write by hand
    const h = Math.max(heightFor(l.remarks, WIDTHS[7] - 2, min), heightFor(`${l.machine.code}  ·  ${l.machine.label}`, WIDTHS[1] - 2, min));
    return {
      h,
      draw: (r) => {
        if (i === 0) v.firstRow = r;
        put(ws, `A${r}`, i + 1, { align: 'center', size: 9.5, color: BRAND.muted });
        put(ws, `B${r}`, rich([[l.machine.code, { bold: true }], ...(l.machine.label ? [[`  ·  ${l.machine.label}`, { color: { argb: BRAND.muted } }]] : [])]), { indent: 1, wrap: true });
        put(ws, `C${r}`, l.status, { align: 'center', bold: Boolean(l.status), size: 9.5, fill: STATUS_FILL[l.status], color: STATUS_TEXT[l.status] || BRAND.ink });
        put(ws, `D${r}`, l.start, { align: 'center' });
        put(ws, `E${r}`, l.end, { align: 'center' });
        put(ws, `F${r}`, l.downtime, { align: 'center', numFmt: '0.00' });
        put(ws, `G${r}`, l.work, { align: 'center', numFmt: '0.00', bold: true });
        put(ws, `H${r}`, l.remarks, { size: 9, indent: 1, wrap: true });
        ws.getRow(r).height = h;
      },
    };
  };
  // total of the vendor's work hours: a live formula when something is recorded, empty (for the pen) otherwise
  const totalRow = (v) => ({
    h: 18,
    draw: (r) => {
      const anyWork = v.lines.some((l) => l.work !== null);
      const sum = Math.round(v.lines.reduce((a, l) => a + (l.work || 0), 0) * 100) / 100;
      put(ws, `A${r}:F${r}`, `Total work hours  ·  ${v.vendor_name}`, { align: 'right', italic: true, size: 9, color: BRAND.muted, fill: BRAND.totalFill, wrap: false, shrink: true });
      put(ws, `G${r}`, anyWork ? { formula: `SUM(G${v.firstRow}:G${r - 1})`, result: sum } : null, { align: 'center', bold: true, numFmt: '0.00', fill: BRAND.totalFill });
      put(ws, `H${r}`, null, { fill: BRAND.totalFill });
      ws.getRow(r).height = 18;
      if (anyWork) vendorTotals.push({ cell: `G${r}`, value: sum });
    },
  });
  const spacer = (h) => ({ h, spacer: true, draw: (r) => { ws.getRow(r).height = h; } });

  data.sites.forEach((site, si) => {
    if (si > 0) groups.push([spacer(10)]);
    site.shifts.forEach((sh, hi) => {
      sh.vendors.forEach((v, vi) => {
        const head = [...(hi === 0 && vi === 0 ? [siteRow(site)] : []), ...(vi === 0 ? [shiftRow(sh)] : []), vendorRow(v)];
        const lines = v.lines.map((l, i) => lineRow(v, l, i));
        const last = lines.length - 1;
        lines.forEach((row, i) => {
          const g = [...(i === 0 ? head : []), row, ...(i === last ? [totalRow(v)] : [])];
          groups.push(g);
        });
      });
    });
  });

  // grand total (only when something is recorded) + the signatures: one block that is never split
  const anyRecorded = data.sites.some((s) => s.shifts.some((h) => h.vendors.some((v) => v.lines.some((l) => l.work !== null))));
  const closing = [];
  if (anyRecorded) {
    closing.push(spacer(10));
    closing.push({
      h: 20,
      draw: (r) => {
        const total = Math.round(vendorTotals.reduce((a, t) => a + t.value, 0) * 100) / 100;
        put(ws, `A${r}:F${r}`, 'TOTAL WORK HOURS  ·  all machines', { bold: true, align: 'right', color: BRAND.white, fill: BRAND.charcoal, wrap: false, border: false });
        put(ws, `G${r}`, { formula: vendorTotals.map((t) => t.cell).join('+'), result: total }, { bold: true, align: 'center', numFmt: '0.00', color: BRAND.white, fill: BRAND.charcoal, border: false });
        put(ws, `H${r}`, null, { fill: BRAND.charcoal, border: false });
        ws.getRow(r).height = 20;
      },
    });
  }
  closing.push(spacer(24));
  closing.push({ h: 20 + 26 + 40 + 26, draw: (r) => signatures(ws, r), rows: 4 });
  groups.push(closing);

  // layout: A4 landscape, 0.45" + 0.55" margins -> about 523 pt of rows per page; the column header repeats on every page.
  // A little margin is kept for the differences between Excel, LibreOffice and printer drivers.
  const PAGE = 510;
  const FIRST_PAGE_USED = [26, 20, 18, 4, 6, 20, 20, 8, 22].reduce((a, b) => a + b, 0); // rows 1..9
  const REPEAT_HEAD = 22;
  let r = HEAD_ROW + 1;
  let y = FIRST_PAGE_USED;
  let pageHasBody = false;
  for (const g of groups) {
    const total = g.reduce((a, row) => a + row.h, 0);
    if (pageHasBody && y + total > PAGE) {
      ws.getRow(r - 1).addPageBreak();
      y = REPEAT_HEAD;
      pageHasBody = false;
    }
    for (const row of g) {
      if (row.spacer && !pageHasBody && y === REPEAT_HEAD) continue; // no empty band at the top of a new page
      row.draw(r);
      r += row.rows || 1;
      y += row.h;
      if (!row.spacer) pageHasBody = true;
    }
  }
  const lastRow = r - 1;
  ws.pageSetup.printArea = `A1:H${lastRow}`;

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, fileName: meta.fileName };
}

module.exports = { loadData, renderWorkbook, lineOf, statusOf, timeOn, longDate };
