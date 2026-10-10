// services/equipment/eqClientReport.js — Daily Equipment Report for an external party (main contractor / client).
// Only the machines that WORKED on the day (a check-in on a Working row) are listed: no vendor, no hours, no money,
// no internal codes. One PDF per language (English = main copy, Arabic = separate copy).
'use strict';

const P = require('../pdfKit');
const settings = require('../settings');
const B = require('../pdfBidi');
const { businessNow, businessToday } = require('../../utils/businessDate');

const { COLORS } = P;
const day = (d) => (d ? String(d).slice(0, 10) : null);

// ------------------------------------------------------------------ data
/**
 * Everything the report shows, read once.
 * opts: { date, siteIds (array, empty = every active site), shift: 'Day' | 'Night' | 'All' }
 */
async function loadData(conn, { date, siteIds, shift }) {
  const [sites] = siteIds && siteIds.length
    ? await conn.query('SELECT site_id, site_code, site_name, project_name, location FROM sites WHERE site_id IN (?) ORDER BY site_code', [siteIds])
    : await conn.query("SELECT site_id, site_code, site_name, project_name, location FROM sites WHERE status = 'Active' ORDER BY site_code");
  const ids = sites.map((s) => s.site_id);
  if (!ids.length) return { sites: [], machines: [], deliveries: [], movements: [] };
  const shiftSql = shift === 'Day' || shift === 'Night' ? ' AND ea.shift_type = ?' : '';
  const shiftParams = shiftSql ? [shift] : [];
  // machines that worked: a Working row with a check-in (any approval state except Cancelled)
  const [machines] = await conn.query(
    `SELECT ea.site_id, ea.shift_type, ea.check_in_time, ea.work_description, e.equipment_id, e.machine_label, e.type_seq, e.plate_number,
       t.type_name, t.type_name_ar, o.full_name AS operator_name
     FROM eq_attendance ea JOIN eq_equipment e ON e.equipment_id = ea.equipment_id JOIN eq_types t ON t.type_id = e.type_id
     LEFT JOIN eq_operators o ON o.operator_id = ea.operator_id
     WHERE ea.record_date = ? AND ea.site_id IN (?) AND ea.status <> 'Cancelled' AND ea.day_status = 'Working' AND ea.check_in_time IS NOT NULL${shiftSql}
     ORDER BY ea.site_id, ea.shift_type, t.type_name, e.type_seq, ea.check_in_time`, [date, ids, ...shiftParams]);
  // deliveries (per-unit work, DNR) of the day, grouped by what was moved and where
  const [deliveries] = await conn.query(
    `SELECT dn.site_id, r.item_name, r.unit, COALESCE(dn.material, '') AS material, COALESCE(dn.from_location, '') AS from_location,
       COALESCE(dn.to_location, '') AS to_location, COUNT(*) AS notes, SUM(dn.quantity) AS quantity
     FROM eq_delivery_notes dn JOIN eq_dnr_rates r ON r.dnr_rate_id = dn.dnr_rate_id
     WHERE dn.note_date = ? AND dn.status = 'Active' AND dn.site_id IN (?)
     GROUP BY dn.site_id, r.item_name, r.unit, COALESCE(dn.material, ''), COALESCE(dn.from_location, ''), COALESCE(dn.to_location, '')
     ORDER BY dn.site_id, r.item_name`, [date, ids]);
  // fleet movements: first day on site today (arrived) / last day on site today (released)
  const shiftA = shiftSql ? ' AND a.shift_type = ?' : '';
  const [movements] = await conn.query(
    `SELECT a.site_id, a.shift_type, IF(a.assigned_date = ?, 'Arrived', 'Released') AS movement, e.machine_label, e.type_seq, e.plate_number, t.type_name, t.type_name_ar
     FROM eq_site_assignments a JOIN eq_equipment e ON e.equipment_id = a.equipment_id JOIN eq_types t ON t.type_id = e.type_id
     WHERE a.site_id IN (?) AND (a.assigned_date = ? OR a.unassigned_date = ?) AND (a.unassigned_date IS NULL OR a.unassigned_date >= a.assigned_date)${shiftA}
     ORDER BY a.site_id, movement, t.type_name, e.type_seq`, [date, ids, date, date, ...shiftParams]);
  return { sites, machines, deliveries, movements };
}

// ------------------------------------------------------------------ texts
const T = {
  en: {
    title: 'DAILY EQUIPMENT REPORT', date: 'Date', to: 'To', issuedBy: 'Issued by', asOf: 'Status as of', reportNo: 'Report No.',
    endOfDay: 'End of day', working: 'Machines working', sites: 'Sites', types: 'Equipment types', trips: 'Delivery trips',
    byType: 'Summary by equipment type', type: 'Equipment type', total: 'Total', machine: 'Machine', plate: 'Plate No.',
    operator: 'Operator', start: 'Start', work: 'Work description', noMachine: 'No machine working on this site.',
    deliveries: 'Deliveries', site: 'Site', item: 'Item / material', route: 'From - To', notes: 'Trips', qty: 'Quantity',
    movements: 'Fleet movements', movement: 'Movement', Arrived: 'Arrived on site', Released: 'Released from site',
    info: 'Additional information', received: 'Received by', shiftDay: 'Day shift', shiftNight: 'Night shift', all: 'Day and night shifts',
    shiftLabel: 'Shift', page: 'Page', generated: 'Generated',
  },
  ar: {
    title: 'تقرير الآليات اليومي', date: 'التاريخ', to: 'إلى', issuedBy: 'صادر عن', asOf: 'الوضع حتى الساعة', reportNo: 'رقم التقرير',
    endOfDay: 'نهاية اليوم', working: 'الآليات العاملة', sites: 'المواقع', types: 'أنواع الآليات', trips: 'نقلات التوريد',
    byType: 'ملخص حسب نوع الآلية', type: 'نوع الآلية', total: 'المجموع', machine: 'الآلية', plate: 'رقم اللوحة',
    operator: 'السائق', start: 'البدء', work: 'وصف العمل', noMachine: 'لا توجد آليات عاملة في هذا الموقع.',
    deliveries: 'التوريدات', site: 'الموقع', item: 'البند أو المادة', route: 'من إلى', notes: 'النقلات', qty: 'الكمية',
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
    const h = Math.max(opts.rowHeight || 19, ...cols.filter((c) => c.wrap).map((c) => w.height(r[c.key], c.width - 10, size, c.bold || r._bold) + 9));
    if (yy + h > lay.bottom()) { doc.addPage(); yy = head(doc.page.margins.top); }
    if (r._fill) doc.rect(L, yy, total, h).fill(r._fill);
    else if (!opts.noHead && i % 2 === 1) doc.rect(L, yy, total, h).fill(COLORS.zebra);
    let x = L;
    for (const c of ordered) {
      if (c.fill) doc.rect(x, yy, c.width, h).fill(c.fill);
      const val = r[c.key];
      if (val !== undefined && val !== null && val !== '') {
        w.tx(val, x + 5, yy + (c.wrap ? 4.5 : 0), {
          size, bold: c.bold || r._bold, color: r._color || c.color, width: c.width - 10, height: c.wrap ? h - 6 : h,
          valign: c.wrap ? 'top' : 'middle', align: c.align || lay.align, wrap: Boolean(c.wrap),
        });
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

  // ---- key figures
  const sitesShown = data.sites;
  const trips = data.deliveries.reduce((a, d) => a + Number(d.notes), 0);
  const typeSet = new Set(data.machines.map((m) => m.type_name));
  const kpis = [[t.working, data.machines.length, true], [t.sites, sitesShown.length], [t.types, typeSet.size]];
  if (trips) kpis.push([t.trips, trips]);
  const kw = (W - (kpis.length - 1) * 8) / kpis.length;
  kpis.forEach(([label, value, main], i) => {
    const x = X(L + i * (kw + 8), kw);
    doc.rect(x, y, kw, 48).fill(main ? COLORS.navy : COLORS.soft);
    if (!main) doc.rect(x, y, kw, 2).fill(COLORS.gold);
    w.tx(String(value), x, y + 7, { size: 19, bold: true, color: main ? COLORS.white : COLORS.navy, width: kw, align: 'center' });
    w.tx(label, x, y + 32, { size: 7.5, color: main ? '#E9DDBE' : COLORS.muted, width: kw, align: 'center' });
  });
  y += 48 + 18;

  // ---- summary by type (one column per site when there are few sites)
  if (data.machines.length) {
    y = sectionHeading(doc, lay, w, y, t.byType);
    const types = [...new Set(data.machines.map((m) => m.type_name))].sort();
    const perSite = sitesShown.length <= 5;
    const siteCols = perSite ? sitesShown.map((s) => ({ key: `s${s.site_id}`, label: s.site_code, width: 0, align: 'center', headAlign: 'center' })) : [];
    const typeW = perSite ? 180 : W - 70; const totalW = 70;
    siteCols.forEach((c) => { c.width = (W - typeW - totalW) / siteCols.length; });
    const cols = [{ key: 'type', label: t.type, width: typeW, bold: true }, ...siteCols, { key: 'total', label: t.total, width: totalW, align: 'center', headAlign: 'center', bold: true }];
    const rows = types.map((ty) => {
      const ms = data.machines.filter((m) => m.type_name === ty);
      const r = { type: typeName(ms[0], lang), total: String(ms.length) };
      for (const s of sitesShown) { const n = ms.filter((m) => m.site_id === s.site_id).length; r[`s${s.site_id}`] = n ? String(n) : '-'; }
      return r;
    });
    const tot = { type: t.total, total: String(data.machines.length), _bold: true, _fill: COLORS.band };
    for (const s of sitesShown) tot[`s${s.site_id}`] = String(data.machines.filter((m) => m.site_id === s.site_id).length);
    y = drawTable(doc, lay, w, y, cols, [...rows, tot]);
  }

  // ---- one section per site
  for (const s of sitesShown) {
    const ms = data.machines.filter((m) => m.site_id === s.site_id);
    y = sectionHeading(doc, lay, w, y, `${s.site_code} - ${s.site_name}`, `${t.working}: ${ms.length}`);
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
        n: String(i + 1), m: machineName(m, lang), plate: m.plate_number || '-', op: m.operator_name || '-',
        start: String(m.check_in_time).slice(11, 16), work: m.work_description || '',
      }));
      y = drawTable(doc, lay, w, y, [
        { key: 'n', label: '#', width: 24, align: 'center', headAlign: 'center' },
        { key: 'm', label: t.machine, width: 112, bold: true, wrap: true },
        { key: 'plate', label: t.plate, width: 70 },
        { key: 'op', label: t.operator, width: 110, wrap: true },
        { key: 'start', label: t.start, width: 44, align: 'center', headAlign: 'center' },
        { key: 'work', label: t.work, width: W - 360, wrap: true },
      ], rows);
    }
  }

  // ---- deliveries of the day
  const code = Object.fromEntries(sitesShown.map((s) => [s.site_id, s.site_code]));
  if (data.deliveries.length) {
    y = sectionHeading(doc, lay, w, y, t.deliveries, `${t.trips}: ${trips}`);
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
