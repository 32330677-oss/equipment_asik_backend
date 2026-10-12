// services/equipment/eqClientReport.js — Daily Equipment Report for an external party (main contractor / client).
// Every machine on site that day with its state (Standby only when asked), what it did, the breakdowns and stoppages
// with their reason, month-to-date figures: no vendor, no hours or times, no money, no internal codes. One PDF per language (English = main copy, Arabic = separate copy).
'use strict';

const P = require('../pdfKit');
const settings = require('../settings');
const B = require('../pdfBidi');
const { businessNow, businessToday } = require('../../utils/businessDate');

const { COLORS } = P;
const day = (d) => (d ? String(d).slice(0, 10) : null);

// ------------------------------------------------------------------ data
const MACHINE_COLS = 'e.equipment_id, e.machine_label, e.type_seq, e.plate_number, e.make, e.model, e.capacity, t.type_name, t.type_name_ar';
const SHIFT_ORDER = { Day: 0, Night: 1 };
/** Machine order inside a site: shift, type, number on the type, plate. */
const byMachine = (a, b) => (a.site_id - b.site_id) || (SHIFT_ORDER[a.shift_type] - SHIFT_ORDER[b.shift_type])
  || String(a.type_name).localeCompare(String(b.type_name)) || ((a.type_seq || 0) - (b.type_seq || 0))
  || String(a.plate_number || '').localeCompare(String(b.plate_number || ''));
const firstOfMonth = (d) => `${d.slice(0, 7)}-01`;

/**
 * Everything the report shows, read once.
 * opts: { date, siteIds (array, empty = every active site), shift: 'Day' | 'Night' | 'All', includeStandby (default false) }
 * fleet   = every machine on site that day (deployed or recorded) with its state:
 *           Working | Standby | Breakdown | Absent | Holiday | Pending (deployed, nothing recorded yet)
 *           Standby machines are left out unless includeStandby.
 * machines = the fleet machines that worked (a check-in on a Working row).
 * events  = breakdowns / stoppages / absences of the day with their reason (no times).
 * mtd     = month to date: machine-days worked per type (a machine counts once a day, whatever its shifts),
 *           shifts worked per type (day and night shift count apart), delivery trips.
 */
async function loadData(conn, { date, siteIds, shift, includeStandby = false }) {
  const [sites] = siteIds && siteIds.length
    ? await conn.query('SELECT site_id, site_code, site_name, project_name, location FROM sites WHERE site_id IN (?) ORDER BY site_code', [siteIds])
    : await conn.query("SELECT site_id, site_code, site_name, project_name, location FROM sites WHERE status = 'Active' ORDER BY site_code");
  const ids = sites.map((s) => s.site_id);
  if (!ids.length) return { sites: [], fleet: [], machines: [], events: [], deliveries: [], movements: [], mtd: { byType: {}, machineDays: 0, shifts: 0, trips: 0 } };
  const shiftSql = shift === 'Day' || shift === 'Night' ? ' AND ea.shift_type = ?' : '';
  const shiftA = shiftSql ? ' AND a.shift_type = ?' : '';
  const shiftParams = shiftSql ? [shift] : [];

  // every row recorded on the day (any approval state except Cancelled)
  const [rows] = await conn.query(
    `SELECT ea.eq_attendance_id, ea.site_id, ea.shift_type, ea.day_status, ea.check_in_time, ea.check_out_time, ea.work_description, ea.remarks,
       ${MACHINE_COLS}, o.full_name AS operator_name
     FROM eq_attendance ea JOIN eq_equipment e ON e.equipment_id = ea.equipment_id JOIN eq_types t ON t.type_id = e.type_id
     LEFT JOIN eq_operators o ON o.operator_id = ea.operator_id
     WHERE ea.record_date = ? AND ea.site_id IN (?) AND ea.status <> 'Cancelled'${shiftSql}`, [date, ids, ...shiftParams]);
  // machines deployed on the day (a deployment that ends today still counts; a cancelled one never does)
  const [deps] = await conn.query(
    `SELECT a.site_id, a.shift_type, ${MACHINE_COLS}, o.full_name AS operator_name
     FROM eq_site_assignments a JOIN eq_equipment e ON e.equipment_id = a.equipment_id AND e.status = 'Active' JOIN eq_types t ON t.type_id = e.type_id
     LEFT JOIN eq_operators o ON o.operator_id = a.default_operator_id
     WHERE a.site_id IN (?) AND a.assigned_date <= ? AND (a.unassigned_date IS NULL OR a.unassigned_date >= ?)${shiftA}`, [ids, date, date, ...shiftParams]);

  const key = (r) => `${r.site_id}|${r.shift_type}|${r.equipment_id}`;
  const seen = new Set();
  const all = [];
  for (const r of rows) {
    if (seen.has(key(r))) continue;
    seen.add(key(r));
    const state = r.day_status === 'Working' ? (r.check_in_time ? 'Working' : 'Pending') : r.day_status;
    all.push({ ...r, state, partlyStopped: false });
  }
  for (const d of deps) {
    if (seen.has(key(d))) continue;
    seen.add(key(d));
    all.push({ ...d, eq_attendance_id: null, day_status: null, check_in_time: null, check_out_time: null, work_description: null, remarks: null, state: 'Pending', partlyStopped: false });
  }
  const fleet = all.filter((f) => includeStandby || f.state !== 'Standby').sort(byMachine);

  // stoppages inside a working day (Breakdown, and Standby when shown); breaks and refuels are not reported
  const working = fleet.filter((f) => f.state === 'Working');
  const kinds = includeStandby ? ['Breakdown', 'Standby'] : ['Breakdown'];
  let periods = [];
  if (working.length) {
    [periods] = await conn.query(
      `SELECT eq_attendance_id, downtime_type, start_time, end_time, reason FROM eq_downtime_periods
       WHERE eq_attendance_id IN (?) AND downtime_type IN (?) ORDER BY start_time`, [working.map((f) => f.eq_attendance_id), kinds]);
  }
  const byRow = new Map(working.map((f) => [f.eq_attendance_id, f]));
  const events = [];
  for (const f of fleet) {
    if (['Breakdown', 'Standby', 'Absent'].includes(f.state)) events.push({ ...f, kind: f.state, extent: 'FullDay', reason: f.remarks || '' });
  }
  for (const p of periods) {
    const f = byRow.get(p.eq_attendance_id);
    if (!f) continue;
    f.partlyStopped = true;
    // an open stoppage is closed by the check-out: it then lasted until the end of the work
    const tillEnd = !p.end_time || (f.check_out_time && String(p.end_time) >= String(f.check_out_time));
    events.push({ ...f, kind: p.downtime_type, extent: tillEnd ? 'TillEnd' : 'Resumed', reason: p.reason || '' });
  }
  events.sort(byMachine);

  // deliveries (per-unit work, DNR) of the day, grouped by what was moved and where
  const [deliveries] = await conn.query(
    `SELECT dn.site_id, r.item_name, r.unit, COALESCE(dn.material, '') AS material, COALESCE(dn.from_location, '') AS from_location,
       COALESCE(dn.to_location, '') AS to_location, COUNT(*) AS notes, SUM(dn.quantity) AS quantity
     FROM eq_delivery_notes dn JOIN eq_dnr_rates r ON r.dnr_rate_id = dn.dnr_rate_id
     WHERE dn.note_date = ? AND dn.status = 'Active' AND dn.site_id IN (?)
     GROUP BY dn.site_id, r.item_name, r.unit, COALESCE(dn.material, ''), COALESCE(dn.from_location, ''), COALESCE(dn.to_location, '')
     ORDER BY dn.site_id, r.item_name`, [date, ids]);
  // fleet movements: first day on site today (arrived) / last day on site today (released)
  const [movements] = await conn.query(
    `SELECT a.site_id, a.shift_type, IF(a.assigned_date = ?, 'Arrived', 'Released') AS movement, e.machine_label, e.type_seq, e.plate_number, t.type_name, t.type_name_ar
     FROM eq_site_assignments a JOIN eq_equipment e ON e.equipment_id = a.equipment_id JOIN eq_types t ON t.type_id = e.type_id
     WHERE a.site_id IN (?) AND (a.assigned_date = ? OR a.unassigned_date = ?) AND (a.unassigned_date IS NULL OR a.unassigned_date >= a.assigned_date)${shiftA}
     ORDER BY a.site_id, movement, t.type_name, e.type_seq`, [date, ids, date, date, ...shiftParams]);

  // month to date (1st of the month .. the report date)
  const from = firstOfMonth(date);
  const [mtdTypes] = await conn.query(
    `SELECT t.type_name, t.type_name_ar, COUNT(DISTINCT ea.equipment_id, ea.record_date) AS days, COUNT(*) AS shifts
     FROM eq_attendance ea JOIN eq_equipment e ON e.equipment_id = ea.equipment_id JOIN eq_types t ON t.type_id = e.type_id
     WHERE ea.record_date BETWEEN ? AND ? AND ea.site_id IN (?) AND ea.status <> 'Cancelled' AND ea.day_status = 'Working' AND ea.check_in_time IS NOT NULL${shiftSql}
     GROUP BY t.type_name, t.type_name_ar`, [from, date, ids, ...shiftParams]);
  const [[trips]] = await conn.query(
    "SELECT COUNT(*) AS n FROM eq_delivery_notes WHERE note_date BETWEEN ? AND ? AND status = 'Active' AND site_id IN (?)", [from, date, ids]);
  const byType = {};
  for (const r of mtdTypes) byType[r.type_name] = { type_name: r.type_name, type_name_ar: r.type_name_ar, days: Number(r.days), shifts: Number(r.shifts) };
  const mtd = { byType, machineDays: mtdTypes.reduce((a, r) => a + Number(r.days), 0), shifts: mtdTypes.reduce((a, r) => a + Number(r.shifts), 0), trips: Number(trips.n) };

  return { sites, fleet, machines: fleet.filter((f) => f.state === 'Working'), events, deliveries, movements, mtd };
}

// ------------------------------------------------------------------ texts
const T = {
  en: {
    title: 'DAILY EQUIPMENT REPORT', date: 'Date', to: 'To', issuedBy: 'Issued by', asOf: 'Status as of', reportNo: 'Report No.',
    endOfDay: 'End of day', sites: 'Sites', trips: 'Delivery trips',
    onSite: 'Machines on site', working: 'Working', availability: 'Availability',
    byType: 'Summary by equipment type', type: 'Equipment type', total: 'Total', mtd: 'Month to date', mtdUnit: 'machine-days', mtdShifts: 'in brackets: shifts worked (day and night shifts on the same date)',
    machine: 'Machine', plate: 'Plate No.', operator: 'Operator', status: 'Status', work: 'Work done / remarks',
    noMachine: 'No machine on this site.',
    st: {
      Working: 'Working', Partly: 'Working, partly stopped', Standby: 'Standby', Breakdown: 'Breakdown', Absent: 'Absent',
      Holiday: 'Holiday', PendingToday: 'Not started yet', Pending: 'Not recorded',
    },
    kpi: { Breakdown: 'Breakdown', Standby: 'Standby', Absent: 'Absent' },
    events: 'Breakdowns and stoppages', noEvents: 'No breakdowns or stoppages.', event: 'Event', reason: 'Reason',
    ev: { Breakdown: 'Breakdown', Standby: 'Standby', Absent: 'Did not come' },
    ext: { FullDay: 'Whole day', Resumed: 'Back to work', TillEnd: 'Until end of work' },
    deliveries: 'Deliveries', site: 'Site', item: 'Item / material', route: 'From - To', notes: 'Trips', qty: 'Quantity',
    tripsToday: 'Trips today', tripsMtd: 'month to date',
    movements: 'Fleet movements', movement: 'Movement', Arrived: 'Arrived on site', Released: 'Released from site',
    info: 'Additional information', received: 'Received by', shiftDay: 'Day shift', shiftNight: 'Night shift', all: 'Day and night shifts',
    shiftLabel: 'Shift', page: 'Page', generated: 'Generated',
  },
  ar: {
    title: 'تقرير الآليات اليومي', date: 'التاريخ', to: 'إلى', issuedBy: 'صادر عن', asOf: 'الوضع حتى الساعة', reportNo: 'رقم التقرير',
    endOfDay: 'نهاية اليوم', sites: 'المواقع', trips: 'نقلات التوريد',
    onSite: 'الآليات في الموقع', working: 'العاملة', availability: 'نسبة الجاهزية',
    byType: 'ملخص حسب نوع الآلية', type: 'نوع الآلية', total: 'المجموع', mtd: 'منذ بداية الشهر', mtdUnit: 'يوم عمل آلية', mtdShifts: 'بين القوسين: عدد الورديات (نهارية وليلية في نفس اليوم)',
    machine: 'الآلية', plate: 'رقم اللوحة', operator: 'السائق', status: 'الحالة', work: 'العمل المنجز أو الملاحظات',
    noMachine: 'لا توجد آليات في هذا الموقع.',
    st: {
      Working: 'عاملة', Partly: 'عاملة مع توقف جزئي', Standby: 'جاهزة دون تشغيل', Breakdown: 'معطلة', Absent: 'لم تحضر',
      Holiday: 'عطلة', PendingToday: 'لم تباشر بعد', Pending: 'غير مسجلة',
    },
    kpi: { Breakdown: 'معطلة', Standby: 'جاهزة دون تشغيل', Absent: 'لم تحضر' },
    events: 'الأعطال والتوقفات', noEvents: 'لا توجد أعطال أو توقفات.', event: 'الحدث', reason: 'السبب',
    ev: { Breakdown: 'عطل', Standby: 'توقف دون تشغيل', Absent: 'لم تحضر' },
    ext: { FullDay: 'طوال اليوم', Resumed: 'عادت للعمل', TillEnd: 'حتى نهاية العمل' },
    deliveries: 'التوريدات', site: 'الموقع', item: 'البند أو المادة', route: 'من إلى', notes: 'النقلات', qty: 'الكمية',
    tripsToday: 'نقلات اليوم', tripsMtd: 'منذ بداية الشهر',
    movements: 'حركة الآليات', movement: 'الحركة', Arrived: 'وصلت إلى الموقع', Released: 'غادرت الموقع',
    info: 'معلومات إضافية', received: 'المستلم', shiftDay: 'الوردية النهارية', shiftNight: 'الوردية الليلية', all: 'الورديتان النهارية والليلية',
    shiftLabel: 'الوردية', page: 'صفحة', generated: 'تاريخ الإصدار',
  },
};
const UNIT = {
  en: { trip: 'trips', t: 't', m3: 'm3', km: 'km', pc: 'pcs', load: 'loads' },
  ar: { trip: 'نقلة', t: 'طن', m3: 'متر مكعب', km: 'كم', pc: 'قطعة', load: 'حمولة' },
};

/** Name of a machine for the reader: "Excavator #3" (EN) / "حفارة 3" (AR) — never the internal code. */
function machineName(m, lang) {
  if (lang === 'ar') return `${m.type_name_ar || m.type_name}${m.type_seq ? ` ${m.type_seq}` : ''}`;
  return m.machine_label || m.type_name;
}
/** Make, model and capacity on one line: "CAT 320D 20 t" (empty when none is known). */
const modelText = (m) => [m.make, m.model, m.capacity].map((x) => String(x ?? '').trim()).filter(Boolean).join(' ');
const typeName = (m, lang) => (lang === 'ar' ? (m.type_name_ar || m.type_name) : m.type_name);
const dateText = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
/** "Quarry > Zone B" / "من Quarry إلى Zone B" (either side may be empty). */
function routeText(d, lang) {
  const f = d.from_location; const to = d.to_location;
  if (!f && !to) return '-';
  if (lang === 'ar') return [f ? `من ${f}` : '', to ? `إلى ${to}` : ''].filter(Boolean).join(' ');
  return [f ? `${f}` : '', to ? `${to}` : ''].filter(Boolean).join('  >  ');
}
const num = (v) => { const x = Number(v); return Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/\.?0+$/, ''); };

// ------------------------------------------------------------------ PDF
function makeLayout(doc, lang) {
  const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right;
  const rtl = lang === 'ar';
  /** x of a box that starts at [x] (counted from the reading start) with width [w]. */
  const X = (x, w) => (rtl ? L + W - (x - L) - w : x);
  const align = rtl ? 'right' : 'left';
  const bottom = () => doc.page.height - doc.page.margins.bottom - 22;
  return { L, W, rtl, X, align, bottom };
}

function sectionHeading(doc, lay, w, y, label, side) {
  const { L, W, X, align } = lay;
  if (y + 50 > lay.bottom()) { doc.addPage(); y = doc.page.margins.top; }
  doc.rect(X(L, 3), y + 1, 3, 14).fill(COLORS.gold);
  w.tx(label, X(L + 10, W - 150), y, { size: 11, bold: true, color: COLORS.navy, width: W - 150, height: 16, valign: 'middle', align });
  if (side) w.tx(side, X(L + W - 140, 140), y, { size: 8, color: COLORS.muted, width: 140, height: 16, valign: 'middle', align: lay.rtl ? 'left' : 'right' });
  return y + 22;
}

/**
 * Table in reading order. cols: [{ key, label, width, align, wrap, bold, fill }].
 * opts: { size, rowHeight, noHead }. Rows may carry _fill, _bold, _color.
 */
function drawTable(doc, lay, w, y, cols, rows, opts = {}) {
  const { L, rtl } = lay;
  const size = opts.size || 8;
  const ordered = rtl ? [...cols].reverse() : cols;
  const total = ordered.reduce((a, c) => a + c.width, 0);
  const head = (yy) => {
    if (opts.noHead) return yy;
    doc.rect(L, yy, total, 20).fill(COLORS.navy);
    let x = L;
    for (const c of ordered) {
      w.tx(c.label, x + 5, yy, { size: 7.5, bold: true, color: COLORS.white, width: c.width - 10, height: 20, valign: 'middle', align: c.headAlign || c.align || lay.align });
      x += c.width;
    }
    return yy + 20;
  };
  if (y + 44 > lay.bottom()) { doc.addPage(); y = doc.page.margins.top; }
  let yy = head(y);
  if (opts.noHead) doc.moveTo(L, yy).lineTo(L + total, yy).lineWidth(0.4).strokeColor(COLORS.grid).stroke();
  rows.forEach((r, i) => {
    const cellH = (c) => w.height(r[c.key], c.width - 10, size, c.bold || r._bold) + (c.sub && r[c.sub] ? w.height(r[c.sub], c.width - 10, size - 1) + 1 : 0) + 9;
    const h = Math.max(opts.rowHeight || 19, ...cols.filter((c) => c.wrap || (c.sub && r[c.sub])).map(cellH));
    if (yy + h > lay.bottom()) { doc.addPage(); yy = head(doc.page.margins.top); }
    if (r._fill) doc.rect(L, yy, total, h).fill(r._fill);
    else if (!opts.noHead && i % 2 === 1) doc.rect(L, yy, total, h).fill(COLORS.zebra);
    let x = L;
    for (const c of ordered) {
      if (c.fill) doc.rect(x, yy, c.width, h).fill(c.fill);
      const val = r[c.key];
      const sub = c.sub ? r[c.sub] : '';
      if (val !== undefined && val !== null && val !== '') {
        const top = c.wrap || sub;
        const mainH = w.height(val, c.width - 10, size, c.bold || r._bold);
        w.tx(val, x + 5, yy + (top ? 4.5 : 0), {
          size, bold: c.bold || r._bold, color: r[`${c.key}_color`] || r._color || c.color, width: c.width - 10, height: top ? (sub ? mainH + 2 : h - 6) : h,
          valign: top ? 'top' : 'middle', align: c.align || lay.align, wrap: Boolean(c.wrap),
        });
        if (sub) {
          w.tx(sub, x + 5, yy + 4.5 + mainH + 1, { size: size - 1, color: COLORS.muted, width: c.width - 10, align: c.align || lay.align, wrap: true });
        }
      }
      x += c.width;
    }
    doc.moveTo(L, yy + h).lineTo(L + total, yy + h).lineWidth(0.4).strokeColor(COLORS.grid).stroke();
    yy += h;
  });
  return yy + 12;
}

async function renderPdf(conn, data, opts, user) {
  const lang = opts.lang === 'ar' ? 'ar' : 'en';
  const t = T[lang];
  const company = await settings.getString('company_name');
  const now = businessNow().slice(0, 16);
  const isToday = opts.date === businessToday();
  const reportNo = `DER-${opts.date.replace(/-/g, '')}-${now.slice(11, 16).replace(':', '')}`;
  const doc = P.createDoc({ margin: 30, info: { Title: `${T.en.title} ${opts.date}` } });
  const lay = makeLayout(doc, lang);
  const w = B.writer(doc, lang, COLORS);
  const { L, W, X } = lay;
  const top = doc.page.margins.top;

  // ---- header: logo at the reading start, title in the middle, report number at the other side
  if (doc.hasLogo) doc.image(P.LOGO, X(L, 70), top - 4, { height: 46 });
  w.tx(t.title, L + 90, top, { size: 16, bold: true, color: COLORS.navy, width: W - 180, align: 'center' });
  w.tx(company, L + 90, top + 24, { size: 8.5, color: COLORS.muted, width: W - 180, align: 'center' });
  const side = lay.rtl ? 'left' : 'right';
  w.tx(t.reportNo, X(L + W - 140, 140), top + 4, { size: 7, color: COLORS.muted, width: 140, align: side });
  w.tx(reportNo, X(L + W - 140, 140), top + 15, { size: 9, bold: true, color: COLORS.navy, width: 140, align: side });
  let y = top + 52;
  doc.moveTo(L, y).lineTo(L + W, y).lineWidth(2).strokeColor(COLORS.gold).stroke();
  y += 12;

  // ---- details
  const shiftText = opts.shift === 'Day' ? t.shiftDay : opts.shift === 'Night' ? t.shiftNight : t.all;
  const issued = [opts.issuedBy, opts.issuedTitle].filter(Boolean).join(' - ');
  const rowsOfCells = [
    [[t.date, dateText(opts.date)], [t.shiftLabel, shiftText], [t.asOf, isToday ? now.slice(11, 16) : t.endOfDay]],
    [[t.to, opts.to || '-'], [t.issuedBy, issued || '-']],
  ];
  const ch = 32;
  doc.rect(L, y, W, ch * 2).fill(COLORS.zebra);
  rowsOfCells.forEach((cells, ri) => {
    const cw = W / cells.length;
    cells.forEach(([k, v], i) => {
      const x = X(L + i * cw, cw); const by = y + ri * ch;
      doc.rect(x, by, cw, ch).lineWidth(0.5).strokeColor(COLORS.grid).stroke();
      w.tx(k, x + 9, by + 4, { size: 7, color: COLORS.muted, width: cw - 18, align: lay.align });
      w.tx(v, x + 9, by + 14, { size: 10, bold: true, color: COLORS.ink, width: cw - 18, align: lay.align });
    });
  });
  y += ch * 2 + 14;

  // ---- key figures: the whole fleet on site, not only the machines that worked
  const sitesShown = data.sites;
  const count = (st) => data.fleet.filter((f) => f.state === st).length;
  const nWork = count('Working'); const nStandby = count('Standby');
  const base = data.fleet.length - count('Holiday') - count('Pending');
  const avail = base > 0 ? `${Math.round(((nWork + nStandby) / base) * 100)}%` : '-';
  const kpis = [[t.onSite, data.fleet.length, true], [t.working, nWork], [t.kpi.Breakdown, count('Breakdown')]];
  if (opts.includeStandby) kpis.push([t.kpi.Standby, nStandby]);
  kpis.push([t.kpi.Absent, count('Absent')], [t.availability, avail]);
  const kw = (W - (kpis.length - 1) * 8) / kpis.length;
  kpis.forEach(([label, value, main], i) => {
    const x = X(L + i * (kw + 8), kw);
    doc.rect(x, y, kw, 48).fill(main ? COLORS.navy : COLORS.soft);
    if (!main) doc.rect(x, y, kw, 2).fill(COLORS.gold);
    w.tx(String(value), x, y + 7, { size: 19, bold: true, color: main ? COLORS.white : COLORS.navy, width: kw, align: 'center' });
    w.tx(label, x, y + 32, { size: 7.5, color: main ? '#E9DDBE' : COLORS.muted, width: kw, align: 'center' });
  });
  y += 48 + 18;

  // ---- summary by type: today's state + machine-days worked since the 1st of the month
  const mtdTypes = Object.keys(data.mtd.byType);
  const mtdCell = (days, shifts) => (shifts > days ? `${days} (${shifts})` : String(days));
  if (data.fleet.length || mtdTypes.length) {
    y = sectionHeading(doc, lay, w, y, t.byType);
    const types = [...new Set([...data.fleet.map((m) => m.type_name), ...mtdTypes])].sort();
    const states = ['Working', 'Breakdown', ...(opts.includeStandby ? ['Standby'] : []), 'Absent'];
    const numW = 62; const mtdW = 92;
    const typeW = W - numW * (states.length + 1) - mtdW;
    const cols = [
      { key: 'type', label: t.type, width: typeW, bold: true },
      { key: 'onSite', label: t.onSite, width: numW, align: 'center', headAlign: 'center', bold: true },
      ...states.map((st) => ({ key: st, label: st === 'Working' ? t.working : t.kpi[st], width: numW, align: 'center', headAlign: 'center' })),
      { key: 'mtd', label: `${t.mtd}`, width: mtdW, align: 'center', headAlign: 'center' },
    ];
    const line = (list) => {
      const r = { onSite: String(list.length) };
      for (const st of states) { const n = list.filter((m) => m.state === st).length; r[st] = n ? String(n) : '-'; }
      return r;
    };
    const rows = types.map((ty) => {
      const ms = data.fleet.filter((m) => m.type_name === ty);
      const ref = ms[0] || data.mtd.byType[ty];
      const m = data.mtd.byType[ty];
      return { type: typeName(ref, lang), ...line(ms), mtd: mtdCell(m ? m.days : 0, m ? m.shifts : 0) };
    });
    const tot = { type: t.total, ...line(data.fleet), mtd: mtdCell(data.mtd.machineDays, data.mtd.shifts), _bold: true, _fill: COLORS.band };
    y = drawTable(doc, lay, w, y, cols, [...rows, tot]);
    // the shifts only show when they differ from the days (a machine worked day and night on the same date)
    const note = data.mtd.shifts > data.mtd.machineDays ? `  |  ${t.mtdShifts}` : '';
    w.tx(`${t.mtd}: ${t.mtdUnit}${note}`, X(L, W), y - 8, { size: 7, color: COLORS.muted, width: W, align: lay.align });
    y += 6;
  }

  // ---- one section per site: every machine on site with its state and what it did
  const STATE_COLOR = { Working: COLORS.green, Partly: COLORS.amber, Standby: COLORS.amber, Breakdown: COLORS.red, Absent: COLORS.red, Holiday: COLORS.muted, Pending: COLORS.muted };
  const stateKey = (m) => (m.state === 'Working' && m.partlyStopped ? 'Partly' : m.state);
  const stateText = (m) => { const k = stateKey(m); return k === 'Pending' ? (isToday ? t.st.PendingToday : t.st.Pending) : t.st[k]; };
  for (const s of sitesShown) {
    const ms = data.fleet.filter((m) => m.site_id === s.site_id);
    const nw = ms.filter((m) => m.state === 'Working').length;
    y = sectionHeading(doc, lay, w, y, `${s.site_code} - ${s.site_name}`, `${t.working}: ${nw} / ${ms.length}`);
    const sub = [s.project_name, s.location].filter(Boolean).join('  |  ');
    if (sub) { w.tx(sub, X(L + 10, W - 10), y - 5, { size: 8, color: COLORS.muted, width: W - 10, align: lay.align }); y += 10; }
    if (!ms.length) { w.tx(t.noMachine, X(L + 10, W - 10), y, { size: 8.5, color: COLORS.muted, width: W - 10, align: lay.align }); y += 22; continue; }
    const shifts = [...new Set(ms.map((m) => m.shift_type))];
    for (const sh of shifts) {
      if (shifts.length > 1 || opts.shift === 'All') {
        if (y + 60 > lay.bottom()) { doc.addPage(); y = doc.page.margins.top; }
        w.tx(sh === 'Night' ? t.shiftNight : t.shiftDay, X(L, W), y, { size: 9, bold: true, color: COLORS.gold, width: W, align: lay.align });
        y += 15;
      }
      const rows = ms.filter((m) => m.shift_type === sh).map((m, i) => ({
        n: String(i + 1), m: machineName(m, lang), model: modelText(m), plate: m.plate_number || '-', op: m.operator_name || '-',
        st: stateText(m), st_color: STATE_COLOR[stateKey(m)],
        // the supervisor's remarks are internal: printed only when the office asks (include_remarks, 12 Oct 2026)
        work: (m.state === 'Working' ? m.work_description : (opts.includeRemarks ? m.remarks : '')) || '',
      }));
      y = drawTable(doc, lay, w, y, [
        { key: 'n', label: '#', width: 22, align: 'center', headAlign: 'center' },
        { key: 'm', label: t.machine, width: 112, bold: true, wrap: true, sub: 'model' },
        { key: 'plate', label: t.plate, width: 64 },
        { key: 'op', label: t.operator, width: 96, wrap: true },
        { key: 'st', label: t.status, width: 82, bold: true, wrap: true },
        { key: 'work', label: t.work, width: W - 376, wrap: true },
      ], rows);
    }
  }

  // ---- breakdowns, stoppages and absences of the day (said explicitly when there is none)
  const code = Object.fromEntries(sitesShown.map((s) => [s.site_id, s.site_code]));
  y = sectionHeading(doc, lay, w, y, t.events, data.events.length ? String(data.events.length) : '');
  if (!data.events.length) {
    w.tx(t.noEvents, X(L + 10, W - 10), y - 2, { size: 8.5, color: COLORS.green, width: W - 10, align: lay.align });
    y += 22;
  } else {
    y = drawTable(doc, lay, w, y, [
      { key: 'site', label: t.site, width: 50 },
      { key: 'm', label: t.machine, width: 112, bold: true, wrap: true, sub: 'plate' },
      { key: 'ev', label: t.event, width: 80, bold: true, wrap: true },
      { key: 'ext', label: t.status, width: 84, wrap: true },
      { key: 'reason', label: t.reason, width: W - 326, wrap: true },
    ], data.events.map((e) => ({
      site: code[e.site_id], m: machineName(e, lang), plate: e.plate_number || '', ev: t.ev[e.kind], ev_color: e.kind === 'Standby' ? COLORS.amber : COLORS.red,
      // a stoppage keeps its own reason; a whole day's reason is the row's remarks: only when asked
      ext: t.ext[e.extent], ext_color: e.extent === 'Resumed' ? COLORS.green : COLORS.ink, reason: (e.extent === 'FullDay' && !opts.includeRemarks ? '' : e.reason) || '-',
    })));
  }

  // ---- deliveries of the day
  const trips = data.deliveries.reduce((a, d) => a + Number(d.notes), 0);
  if (data.deliveries.length) {
    y = sectionHeading(doc, lay, w, y, t.deliveries, `${t.tripsToday}: ${trips}  |  ${t.tripsMtd}: ${data.mtd.trips}`);
    y = drawTable(doc, lay, w, y, [
      { key: 'site', label: t.site, width: 60 },
      { key: 'item', label: t.item, width: 175, wrap: true },
      { key: 'route', label: t.route, width: W - 60 - 175 - 60 - 90, wrap: true },
      { key: 'notes', label: t.notes, width: 60, align: 'center', headAlign: 'center', bold: true },
      { key: 'qty', label: t.qty, width: 90, align: 'center', headAlign: 'center' },
    ], data.deliveries.map((d) => ({
      site: code[d.site_id], item: [d.item_name, d.material].filter(Boolean).join(' - '),
      route: routeText(d, lang),
      notes: String(d.notes), qty: `${num(d.quantity)} ${UNIT[lang][d.unit] || d.unit}`,
    })));
  }

  // ---- fleet movements of the day
  if (data.movements.length) {
    y = sectionHeading(doc, lay, w, y, t.movements);
    y = drawTable(doc, lay, w, y, [
      { key: 'site', label: t.site, width: 70 },
      { key: 'm', label: t.machine, width: 170, bold: true },
      { key: 'plate', label: t.plate, width: 110 },
      { key: 'mv', label: t.movement, width: W - 350, bold: true },
    ], data.movements.map((m) => ({
      site: code[m.site_id], m: machineName(m, lang), plate: m.plate_number || '-', mv: t[m.movement],
      _color: m.movement === 'Arrived' ? COLORS.green : COLORS.amber,
    })));
  }

  // ---- additional information typed when issuing (label / value records)
  const notes = (opts.notes || []).filter((n) => n && (n.label || n.value));
  if (notes.length) {
    y = sectionHeading(doc, lay, w, y, t.info);
    y = drawTable(doc, lay, w, y, [
      { key: 'label', label: '', width: 160, bold: true, wrap: true, fill: COLORS.soft, color: COLORS.navy },
      { key: 'value', label: '', width: W - 160, wrap: true },
    ], notes.map((n) => ({ label: n.label || '', value: n.value || '' })), { size: 8.5, rowHeight: 22, noHead: true });
  }

  // ---- signatures (kept together)
  if (y + 66 > lay.bottom()) { doc.addPage(); y = doc.page.margins.top; }
  y += 8;
  const sw = W / 2;
  [[t.issuedBy, issued], [t.received, opts.to || '']].forEach(([label, name], i) => {
    const x = X(L + i * sw, sw);
    doc.moveTo(x + 24, y + 30).lineTo(x + sw - 24, y + 30).lineWidth(0.6).strokeColor('#888888').stroke();
    w.tx(label, x, y + 35, { size: 8.5, bold: true, width: sw, align: 'center' });
    if (name) w.tx(name, x, y + 48, { size: 7.5, color: COLORS.muted, width: sw, align: 'center' });
  });

  // ---- footers
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const fy = doc.page.height - doc.page.margins.bottom - 6;
    const saved = doc.page.margins.bottom; doc.page.margins.bottom = 0;
    doc.moveTo(L, fy - 5).lineTo(L + W, fy - 5).lineWidth(0.5).strokeColor(COLORS.grid).stroke();
    // company | report no. | generated | by — each part drawn on its own so the order follows the reading direction
    let pos = 0;
    [company, reportNo, `${t.generated} ${now}`, user.full_name].filter(Boolean).forEach((part, k) => {
      const pw = w.width(part, 6.5) + 1;
      if (k) { w.tx('|', X(L + pos, 12), fy, { size: 6.5, color: COLORS.light, width: 12, align: 'center' }); pos += 12; }
      if (pos + pw > W * 0.8) return;
      w.tx(part, X(L + pos, pw), fy, { size: 6.5, color: COLORS.muted, width: pw, align: lay.align });
      pos += pw;
    });
    w.tx(`${t.page} ${i - range.start + 1} / ${range.count}`, X(L + W * 0.8, W * 0.2), fy, { size: 6.5, color: COLORS.muted, width: W * 0.2, align: lay.rtl ? 'left' : 'right' });
    doc.page.margins.bottom = saved;
  }
  return { buffer: await P.toBuffer(doc), fileName: `${reportNo}-${lang.toUpperCase()}.pdf` };
}

module.exports = { loadData, renderPdf, machineName };
