// services/equipment/eqHoursReport.js — hours since the start of the project, per machine and per vendor (read only).
//
// Hours = what the billing engine counts, so the report agrees with the invoices:
//   1. Invoiced: items of active invoices (drafts and issued, same rule as the engine) (work_hours, overtime_hours, worked_days).
//   2. Not invoiced yet: approved attendance not taken by any active invoice, calculated by the same engine as the
//      invoices (eqPayrollService.calculate), one calendar year at a time (the engine reads at most one year).
// Every unit is billed once, so 1 + 2 never counts a day twice. Rows waiting for approval are only counted (not hours).
'use strict';

const ExcelJS = require('exceljs');
const P = require('../pdfKit');
const PS = require('./eqPayrollService');
const settings = require('../settings');
const { businessToday, businessNow } = require('../../utils/businessDate');

const { COLORS, fmt } = P;
const n = (v) => Number(v || 0);
const r2 = (x) => Math.round(x * 100) / 100;
const day = (d) => (d ? String(d).slice(0, 10) : null);

async function hoursReport(conn, { vendor_id: vendorId = null, site_id: siteId = null } = {}) {
  const today = businessToday();
  const byMachine = new Map();
  const get = (id) => {
    if (!byMachine.has(id)) byMachine.set(id, { equipment_id: id, vendor_id: null, modes: new Set(), worked_days: 0, inv_reg: 0, inv_ot: 0, pend_reg: 0, pend_ot: 0, pending_rows: 0, first: null, last: null });
    return byMachine.get(id);
  };
  const seen = (m, d) => { if (!d) return; if (!m.first || d < m.first) m.first = d; if (!m.last || d > m.last) m.last = d; };

  // 1. invoiced
  const w = []; const p = [];
  if (vendorId) { w.push('i.vendor_id = ?'); p.push(vendorId); }
  if (siteId) { w.push('i.site_id = ?'); p.push(siteId); }
  const [items] = await conn.query(
    `SELECT i.equipment_id, i.vendor_id, i.billing_mode, i.worked_days, i.work_hours, i.overtime_hours, b.start_date, b.end_date,
       (SELECT MIN(ps.record_date) FROM eq_payroll_attendance_snapshot ps WHERE ps.eq_item_id = i.eq_item_id) AS r_from,
       (SELECT MAX(ps.record_date) FROM eq_payroll_attendance_snapshot ps WHERE ps.eq_item_id = i.eq_item_id) AS r_to,
       (SELECT MIN(md.day) FROM eq_payroll_monthly_days md WHERE md.eq_item_id = i.eq_item_id) AS m_from,
       (SELECT MAX(md.day) FROM eq_payroll_monthly_days md WHERE md.eq_item_id = i.eq_item_id) AS m_to
     FROM eq_payroll_items i JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id
     WHERE ${PS.ACTIVE_BATCH}${w.length ? ` AND ${w.join(' AND ')}` : ''}`, p);
  for (const it of items) {
    const m = get(it.equipment_id);
    const ot = Math.max(0, n(it.overtime_hours));
    m.vendor_id = m.vendor_id || it.vendor_id;
    if (it.billing_mode) m.modes.add(it.billing_mode);
    m.worked_days += n(it.worked_days);
    m.inv_reg += Math.max(0, n(it.work_hours) - ot);
    m.inv_ot += ot;
    if (n(it.work_hours) > 0 || n(it.worked_days) > 0) {
      const days = [day(it.r_from), day(it.r_to), day(it.m_from), day(it.m_to)].filter(Boolean);
      if (days.length) days.forEach((d) => seen(m, d)); else { seen(m, day(it.start_date)); seen(m, day(it.end_date)); }
    }
  }

  // 2. not invoiced yet: from the first attendance row / deployment of the scope, one calendar year at a time
  const s = PS.scopeSql({ vendor_id: vendorId, site_id: siteId });
  const ds = PS.scopeSql({ vendor_id: vendorId, site_id: siteId }, 'a');
  const [[r1]] = await conn.query(`SELECT MIN(ea.record_date) AS d FROM eq_attendance ea JOIN eq_equipment e ON e.equipment_id = ea.equipment_id WHERE ea.status = 'Approved'${s.sql}`, s.params);
  const [[r2_]] = await conn.query(`SELECT MIN(a.assigned_date) AS d FROM eq_site_assignments a JOIN eq_equipment e ON e.equipment_id = a.equipment_id WHERE 1 = 1${ds.sql}`, ds.params);
  const start = [day(r1.d), day(r2_.d)].filter(Boolean).sort()[0] || null;
  const errors = [];
  if (start && start <= today) {
    for (let y = Number(start.slice(0, 4)); y <= Number(today.slice(0, 4)); y += 1) {
      const from = y === Number(start.slice(0, 4)) ? start : `${y}-01-01`;
      const to = y === Number(today.slice(0, 4)) ? today : `${y}-12-31`;
      try {
        const { items: its } = await PS.calculate(conn, { start_date: from, end_date: to, vendor_id: vendorId, site_id: siteId });
        for (const it of its) {
          const work = n(it.work_minutes) / 60; const ot = Math.max(0, n(it.overtime_minutes) / 60);
          if (!work && !n(it.worked_days)) continue;
          const m = get(it.equipment_id);
          m.vendor_id = m.vendor_id || it.vendor_id;
          if (it.billing_mode) m.modes.add(it.billing_mode);
          m.worked_days += n(it.worked_days);
          m.pend_reg += Math.max(0, work - ot);
          m.pend_ot += ot;
          for (const r of it.per_row || []) seen(m, day((r.row || r).record_date));
          if (!(it.per_row || []).length) { seen(m, from); seen(m, to); }
        }
      } catch (e) {
        errors.push({ from, to, message: e.message });
      }
    }
  }

  // rows waiting for approval (not counted in the hours)
  const [subs] = await conn.query(
    `SELECT ea.equipment_id, e.vendor_id, COUNT(*) AS c FROM eq_attendance ea JOIN eq_equipment e ON e.equipment_id = ea.equipment_id
     WHERE ea.status = 'Submitted'${s.sql} GROUP BY ea.equipment_id, e.vendor_id`, s.params);
  for (const r of subs) { const m = get(r.equipment_id); m.vendor_id = m.vendor_id || r.vendor_id; m.pending_rows += n(r.c); }

  const ids = [...byMachine.keys()];
  if (!ids.length) return { generated_on: today, vendor_id: vendorId, site_id: siteId, vendors: [], totals: emptyTotals(), errors };
  const [machines] = await conn.query(
    `SELECT e.equipment_id, e.equipment_code, e.machine_label, e.plate_number, e.vendor_id, t.type_name FROM eq_equipment e
     JOIN eq_types t ON t.type_id = e.type_id WHERE e.equipment_id IN (?)`, [ids]);
  const info = new Map(machines.map((x) => [x.equipment_id, x]));
  const vids = [...new Set([...byMachine.values()].map((m) => m.vendor_id || (info.get(m.equipment_id) || {}).vendor_id).filter(Boolean))];
  const [vendors] = vids.length ? await conn.query('SELECT vendor_id, vendor_code, vendor_name FROM eq_vendors WHERE vendor_id IN (?)', [vids]) : [[]];
  const vInfo = new Map(vendors.map((x) => [x.vendor_id, x]));

  const groups = new Map();
  for (const m of byMachine.values()) {
    const mi = info.get(m.equipment_id) || {};
    const vid = m.vendor_id || mi.vendor_id;
    const reg = r2(m.inv_reg + m.pend_reg); const ot = r2(m.inv_ot + m.pend_ot);
    const row = {
      equipment_id: m.equipment_id, equipment_code: mi.equipment_code || `#${m.equipment_id}`, machine_label: mi.machine_label || null, type_name: mi.type_name || null,
      plate_number: mi.plate_number || null, billing_modes: [...m.modes].sort().join(', '), first_day: m.first, last_day: m.last,
      worked_days: m.worked_days, regular_hours: reg, overtime_hours: ot, total_hours: r2(reg + ot),
      invoiced_hours: r2(m.inv_reg + m.inv_ot), not_invoiced_hours: r2(m.pend_reg + m.pend_ot), rows_waiting_approval: m.pending_rows,
    };
    if (!groups.has(vid)) { const vi = vInfo.get(vid) || {}; groups.set(vid, { vendor_id: vid, vendor_code: vi.vendor_code || '', vendor_name: vi.vendor_name || `Vendor #${vid}`, machines: [] }); }
    groups.get(vid).machines.push(row);
  }
  const out = [...groups.values()].sort((a, b) => a.vendor_name.localeCompare(b.vendor_name));
  for (const g of out) { g.machines.sort((a, b) => a.equipment_code.localeCompare(b.equipment_code)); g.totals = sum(g.machines); }
  return { generated_on: today, vendor_id: vendorId, site_id: siteId, vendors: out, totals: sum(out.flatMap((g) => g.machines)), errors };
}

function emptyTotals() { return { machines: 0, worked_days: 0, regular_hours: 0, overtime_hours: 0, total_hours: 0, invoiced_hours: 0, not_invoiced_hours: 0, rows_waiting_approval: 0 }; }
function sum(rows) {
  const t = emptyTotals();
  for (const r of rows) for (const k of Object.keys(t)) if (k !== 'machines') t[k] += n(r[k]);
  for (const k of ['regular_hours', 'overtime_hours', 'total_hours', 'invoiced_hours', 'not_invoiced_hours']) t[k] = r2(t[k]);
  t.machines = rows.length;
  return t;
}

const machineName = (r) => `${r.equipment_code} ${r.machine_label || r.type_name || ''}`.trim();
const h = (v) => fmt.num(v, 2);

async function hoursReportPdf(data, { siteLabel } = {}) {
  const company = await settings.getString('company_name');
  const doc = P.createDoc({ layout: 'landscape', info: { Title: 'Equipment hours since the start' } });
  const scope = [data.vendors.length === 1 && data.vendor_id ? data.vendors[0].vendor_name : 'All vendors', siteLabel || 'All sites'].join(' | ');
  let y = P.header(doc, {
    title: 'EQUIPMENT HOURS SINCE THE START', titleAr: 'ساعات الآليات منذ بداية المشروع', subtitle: company,
    right: (xr, top) => [`Up to ${fmt.date(data.generated_on)}`, scope].forEach((t, k) => P.text(doc, t, xr - 220, top + k * 11, { size: k ? 7 : 8, bold: !k, color: k ? COLORS.ink : COLORS.navy, width: 220, align: 'right', lineBreak: false })),
  });
  const rows = [];
  for (const g of data.vendors) {
    rows.push({ m: `${g.vendor_name}${g.vendor_code ? ` (${g.vendor_code})` : ''}`, _bold: true, _fill: COLORS.soft });
    g.machines.forEach((r, i) => rows.push({
      no: String(i + 1), m: machineName(r), mode: r.billing_modes, period: r.first_day ? `${fmt.date(r.first_day)} - ${fmt.date(r.last_day)}` : '-',
      days: String(r.worked_days), reg: h(r.regular_hours), ot: r.overtime_hours ? h(r.overtime_hours) : '-', tot: h(r.total_hours),
      inv: h(r.invoiced_hours), pend: r.not_invoiced_hours ? h(r.not_invoiced_hours) : '-', wait: r.rows_waiting_approval ? String(r.rows_waiting_approval) : '-',
    }));
    const t = g.totals;
    rows.push({ m: `Total ${g.vendor_name} (${t.machines} machines)`, days: String(t.worked_days), reg: h(t.regular_hours), ot: h(t.overtime_hours), tot: h(t.total_hours),
      inv: h(t.invoiced_hours), pend: h(t.not_invoiced_hours), wait: t.rows_waiting_approval ? String(t.rows_waiting_approval) : '-', _bold: true });
  }
  const T = data.totals;
  if (data.vendors.length > 1) {
    rows.push({ m: `GRAND TOTAL (${T.machines} machines)`, days: String(T.worked_days), reg: h(T.regular_hours), ot: h(T.overtime_hours), tot: h(T.total_hours),
      inv: h(T.invoiced_hours), pend: h(T.not_invoiced_hours), wait: T.rows_waiting_approval ? String(T.rows_waiting_approval) : '-', _bold: true, _fill: COLORS.soft, _height: 18 });
  }
  if (!rows.length) rows.push({ m: 'No hours recorded for this selection.' });
  y = P.table(doc, {
    y, rows, rowHeight: 16, headHeight: 34, fontSize: 7.2, onNewPage: () => doc.page.margins.top + 4,
    columns: [
      { key: 'no', en: '#', ar: '', width: 18 }, { key: 'm', en: 'Machine', ar: 'الآلية', width: 170, align: 'left' },
      { key: 'mode', en: 'Billing', ar: 'الأساس', width: 52 }, { key: 'period', en: 'First - last day', ar: 'أول - آخر يوم', width: 104 },
      { key: 'days', en: 'Worked days', ar: 'أيام العمل', width: 44 },
      { key: 'reg', en: 'Regular hours', ar: 'الساعات العادية', width: 58, align: 'right' }, { key: 'ot', en: 'OT hours', ar: 'ساعات الإضافي', width: 52, align: 'right' },
      { key: 'tot', en: 'Total hours', ar: 'إجمالي الساعات', width: 62, align: 'right', bold: true },
      { key: 'inv', en: 'Invoiced hours', ar: 'ساعات مفوترة', width: 58, align: 'right' }, { key: 'pend', en: 'Not invoiced yet', ar: 'غير مفوترة بعد', width: 58, align: 'right' },
      { key: 'wait', en: 'Rows awaiting approval', ar: 'سجلات بانتظار الاعتماد', width: 58 },
    ],
  });
  const notes = ['Hours as billed: invoiced = hours in invoices (drafts and issued, not cancelled); not invoiced yet = approved attendance not in any invoice (same calculation as the invoices).',
    'Rows awaiting approval are counted only, their hours are not in the totals.'];
  if (data.errors.length) notes.push(`Could not calculate the not-invoiced part for: ${data.errors.map((e) => `${e.from} - ${e.to} (${e.message})`).join('; ')}`);
  const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right;
  if (y + 40 > doc.page.height - doc.page.margins.bottom - 18) { doc.addPage(); y = doc.page.margins.top; }
  P.text(doc, notes.join('\n'), L, y + 6, { size: 6.8, color: data.errors.length ? COLORS.red : COLORS.muted, width: W });
  P.footers(doc, `${company} | Equipment Flow | hours since the start | printed ${businessNow().slice(0, 16)}`);
  return P.toBuffer(doc);
}

async function hoursReportXlsx(data) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Hours since start');
  ws.columns = [
    { header: 'Vendor', key: 'vendor', width: 28 }, { header: 'Machine', key: 'code', width: 12 }, { header: 'Type / machine no.', key: 'name', width: 22 },
    { header: 'Plate', key: 'plate', width: 12 }, { header: 'Billing', key: 'mode', width: 12 }, { header: 'First day', key: 'first', width: 12 }, { header: 'Last day', key: 'last', width: 12 },
    { header: 'Worked days', key: 'days', width: 11 }, { header: 'Regular hours', key: 'reg', width: 13 }, { header: 'OT hours', key: 'ot', width: 11 },
    { header: 'Total hours', key: 'tot', width: 12 }, { header: 'Invoiced hours', key: 'inv', width: 13 }, { header: 'Not invoiced yet', key: 'pend', width: 14 },
    { header: 'Rows awaiting approval', key: 'wait', width: 14 },
  ];
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B3B3B' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  const tot = (label, t, fill) => {
    const row = ws.addRow({ vendor: label, days: t.worked_days, reg: t.regular_hours, ot: t.overtime_hours, tot: t.total_hours, inv: t.invoiced_hours, pend: t.not_invoiced_hours, wait: t.rows_waiting_approval });
    row.font = { bold: true };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  };
  for (const g of data.vendors) {
    for (const r of g.machines) {
      ws.addRow({ vendor: g.vendor_name, code: r.equipment_code, name: r.machine_label || r.type_name, plate: r.plate_number, mode: r.billing_modes, first: r.first_day, last: r.last_day,
        days: r.worked_days, reg: r.regular_hours, ot: r.overtime_hours, tot: r.total_hours, inv: r.invoiced_hours, pend: r.not_invoiced_hours, wait: r.rows_waiting_approval });
    }
    tot(`Total ${g.vendor_name}`, g.totals, 'FFF3EEE2');
  }
  if (data.vendors.length > 1) tot('GRAND TOTAL', data.totals, 'FFE6DCC3');
  for (const k of ['reg', 'ot', 'tot', 'inv', 'pend']) ws.getColumn(k).numFmt = '#,##0.00';
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { hoursReport, hoursReportPdf, hoursReportXlsx };
