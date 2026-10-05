// Live board (§5.10), daily site report (D5) and utilization report (D6).
const ExcelJS = require('exceljs');
const { pool } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { v, validate, parseId } = require('../../utils/validate');
const { businessToday, businessNow, addDays, daysBetweenInclusive } = require('../../utils/businessDate');
const { covers } = require('../../utils/ranges');
const { assertCanActOnSite } = require('../../services/siteAccess');
const settings = require('../../services/settings');
const L = require('../../services/equipment/eqLiveService');
const P = require('../../services/pdfKit');

const { COLORS, fmt } = P;

function liveOpts(req, extra = {}) {
  const q = validate(req.query, { date: v.date({ default: businessToday() }), site_id: v.id() });
  return {
    date: q.date, siteId: extra.siteId || q.site_id || null,
    supervisorUserId: req.user.role === 'Supervisor' ? req.user.user_id : null,
    withMoney: req.user.role === 'Admin' || req.user.role === 'Accountant',
  };
}

exports.live = async (req, res) => {
  res.json({ status: 'success', data: await L.live(liveOpts(req)) });
};

exports.liveSite = async (req, res) => {
  const siteId = parseId(req.params.siteId, 'site');
  const opts = liveOpts(req, { siteId });
  const data = await L.live(opts);
  if (req.user.role === 'Supervisor' && !data.machines.length) {
    const [[sup]] = await pool.execute('SELECT 1 AS ok FROM site_supervisors WHERE user_id = ? AND site_id = ? LIMIT 1', [req.user.user_id, siteId]);
    if (!sup) throw AppError.forbidden('SITE_FORBIDDEN', 'You do not supervise this site.');
  }
  const [[site]] = await pool.execute('SELECT site_id, site_code, site_name, has_night_shift, day_shift_start, night_shift_start FROM sites WHERE site_id = ?', [siteId]);
  if (!site) throw AppError.notFound('Site');
  const problems = data.machines.filter((m) => m.live_state === 'Breakdown' || m.late || m.forgotten_checkout || m.anomaly_code)
    .map((m) => ({ equipment_code: m.equipment_code, live_state: m.live_state, late: m.late, forgotten_checkout: m.forgotten_checkout, anomaly_code: m.anomaly_code }));
  res.json({ status: 'success', data: { site, ...data, problems } });
};

// ------------------------------------------------------------------ D5 daily site report
exports.dailyPdf = async (req, res) => {
  const q = validate(req.query, { site_id: v.id({ required: true }), date: v.date({ default: businessToday() }), shift: v.enumOf(['Day', 'Night'], { default: 'Day' }) });
  await assertCanActOnSite(req.user.role === 'Accountant' ? { ...req.user, role: 'Admin' } : req.user, q.site_id, q.shift, q.date);
  const data = await L.live({ date: q.date, siteId: q.site_id });
  const machines = data.machines.filter((m) => m.shift_type === q.shift);
  const [[site]] = await pool.execute('SELECT * FROM sites WHERE site_id = ?', [q.site_id]);
  if (!site) throw AppError.notFound('Site');
  const doc = P.createDoc({ info: { Title: `Daily equipment report ${site.site_code} ${q.date}` } });
  let y = P.header(doc, { title: 'DAILY SITE EQUIPMENT REPORT', titleAr: 'تقرير الآليات اليومي للموقع', subtitle: await settings.getString('company_name') });
  const count = (s) => machines.filter((m) => m.live_state === s).length;
  y = P.infoGrid(doc, [
    { label: 'Site', labelAr: 'الموقع', value: `${site.site_code} - ${site.site_name}` },
    { label: 'Shift', labelAr: 'الوردية', value: q.shift },
    { label: 'Date', labelAr: 'التاريخ', value: fmt.date(q.date) },
    { label: 'Deployed', labelAr: 'الآليات', value: String(machines.length) },
    { label: 'Worked / finished', labelAr: 'قيد العمل', value: String(count('Working') + count('Finished') + count('OnBreak')) },
    { label: 'Breakdown', labelAr: 'متوقفة لعطل', value: String(count('Breakdown')) },
    { label: 'Standby', labelAr: 'انتظار', value: String(count('Standby')) },
    { label: 'Not arrived / absent', labelAr: 'غائبة أو لم تصل', value: String(count('NotArrived') + count('Absent')) },
  ], y, 4);
  const rows = machines.map((m) => ({
    m: `${m.equipment_code} ${m.type_name}`, v: m.vendor_name, st: m.live_state, op: m.operator_name || '', in: fmt.time(m.check_in_time), out: fmt.time(m.check_out_time),
    dt: m.downtime.map((d) => `${d.downtime_type} ${fmt.time(d.start_time)}-${fmt.time(d.end_time) || '...'}`).join(', '),
    w: (m.work_minutes_today / 60).toFixed(2), r: m.remarks || '', _color: m.live_state === 'Breakdown' ? COLORS.red : undefined,
  }));
  y = P.table(doc, {
    y, rows, rowHeight: 24, headHeight: 24, fontSize: 7, onNewPage: () => doc.page.margins.top + 4,
    columns: [
      { key: 'm', en: 'Machine', ar: 'الآلية', width: 70, align: 'left', wrap: true }, { key: 'v', en: 'Vendor', ar: 'الجهة المؤجرة', width: 62, align: 'left', wrap: true },
      { key: 'st', en: 'State', ar: 'الحالة', width: 48 }, { key: 'op', en: 'Operator', ar: 'المشغل', width: 60, align: 'left', wrap: true },
      { key: 'in', en: 'In', ar: 'البدء', width: 30 }, { key: 'out', en: 'Out', ar: 'الانتهاء', width: 30 },
      { key: 'dt', en: 'Downtime', ar: 'فترات التوقف', width: 100, align: 'left', wrap: true, size: 6.3 }, { key: 'w', en: 'Work h', ar: 'عمل', width: 32, bold: true },
      { key: 'r', en: 'Remarks', ar: 'ملاحظات', width: 115, align: 'left', wrap: true, size: 6.3 },
    ],
  });
  y += 30;
  if (y + 40 > doc.page.height - 50) { doc.addPage(); y = doc.page.margins.top + 20; }
  const W = doc.page.width - 48;
  doc.moveTo(24 + W * 0.6, y).lineTo(24 + W, y).lineWidth(0.6).strokeColor('#888').stroke();
  P.text(doc, 'Site supervisor signature', 24 + W * 0.6, y + 3, { size: 7.5, width: W * 0.4, align: 'center', lineBreak: false });
  P.text(doc, 'توقيع مشرف الموقع', 24 + W * 0.6, y + 13, { size: 7, width: W * 0.4, align: 'center', lineBreak: false });
  P.footers(doc, `Equipment Flow | daily report ${site.site_code} ${q.date} ${q.shift} | printed ${businessNow().slice(0, 16)} by ${req.user.full_name}`);
  const buf = await P.toBuffer(doc);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="daily-equipment-${site.site_code}-${q.date}-${q.shift}.pdf"`);
  res.send(buf);
};

// ------------------------------------------------------------------ D6 utilization
async function utilizationData(q) {
  const where = []; const params = [q.to, q.from];
  if (q.vendor_id) { where.push('e.vendor_id = ?'); params.push(q.vendor_id); }
  if (q.site_id) { where.push('a.site_id = ?'); params.push(q.site_id); }
  const [deps] = await pool.query(
    `SELECT a.equipment_id, a.site_id, a.assigned_date, a.unassigned_date, e.equipment_code, e.vendor_id, vd.vendor_name, t.type_name
     FROM eq_site_assignments a JOIN eq_equipment e ON e.equipment_id = a.equipment_id JOIN eq_vendors vd ON vd.vendor_id = e.vendor_id
     JOIN eq_types t ON t.type_id = e.type_id
     WHERE a.assigned_date <= ? AND (a.unassigned_date IS NULL OR a.unassigned_date >= ?) AND (a.unassigned_date IS NULL OR a.unassigned_date >= a.assigned_date)
     ${where.length ? `AND ${where.join(' AND ')}` : ''}`, params);
  const ids = [...new Set(deps.map((d) => d.equipment_id))];
  if (!ids.length) return [];
  const [rows] = await pool.query(
    `SELECT equipment_id, day_status, working_minutes, breakdown_minutes, standby_minutes, gross_minutes FROM eq_attendance
     WHERE equipment_id IN (?) AND record_date BETWEEN ? AND ?${q.site_id ? ' AND site_id = ?' : ''}`, [ids, q.from, q.to, ...(q.site_id ? [q.site_id] : [])]);
  const [cards] = await pool.query('SELECT equipment_id, standard_hours_per_day FROM eq_rate_cards WHERE equipment_id IN (?) AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)', [ids, q.to, q.from]);
  const std = Object.fromEntries(cards.map((c) => [c.equipment_id, Number(c.standard_hours_per_day)]));
  const out = [];
  for (const id of ids) {
    const ds = deps.filter((d) => d.equipment_id === id);
    let deployedDays = 0;
    for (let d = q.from; d <= q.to; d = addDays(d, 1)) if (ds.some((x) => covers(x.assigned_date, x.unassigned_date, d))) deployedDays += 1;
    const rs = rows.filter((r) => r.equipment_id === id);
    const s = std[id] || 8;
    const fullDay = (r, st) => (r.day_status === st && !r.gross_minutes ? s * 60 : 0);
    const work = rs.reduce((a, r) => a + Number(r.working_minutes || 0), 0);
    const bd = rs.reduce((a, r) => a + Number(r.breakdown_minutes || 0) + fullDay(r, 'Breakdown'), 0);
    const sb = rs.reduce((a, r) => a + Number(r.standby_minutes || 0) + fullDay(r, 'Standby'), 0);
    const capacity = deployedDays * s * 60;
    out.push({
      equipment_id: id, equipment_code: ds[0].equipment_code, type_name: ds[0].type_name, vendor_id: ds[0].vendor_id, vendor_name: ds[0].vendor_name,
      deployed_days: deployedDays, recorded_days: rs.length, worked_days: rs.filter((r) => r.day_status === 'Working' && Number(r.working_minutes) > 0).length,
      work_hours: +(work / 60).toFixed(2), standby_hours: +(sb / 60).toFixed(2), breakdown_hours: +(bd / 60).toFixed(2),
      utilization_pct: capacity ? +((work / capacity) * 100).toFixed(1) : 0, availability_pct: capacity ? +((1 - bd / capacity) * 100).toFixed(1) : 0,
    });
  }
  out.sort((a, b) => a.utilization_pct - b.utilization_pct);
  return out;
}

exports.utilization = async (req, res) => {
  const q = validate(req.query, { from: v.date({ required: true }), to: v.date({ required: true }), vendor_id: v.id(), site_id: v.id(), format: v.enumOf(['json', 'xlsx', 'pdf'], { default: 'json' }) });
  if (q.to < q.from) throw AppError.validation({ to: 'must be on or after from' });
  if (daysBetweenInclusive(q.from, q.to) > 366) throw AppError.validation({ to: 'the period cannot exceed one year' });
  const data = await utilizationData(q);
  if (q.format === 'json') return res.json({ status: 'success', data, meta: { from: q.from, to: q.to } });
  if (q.format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Utilization');
    ws.columns = [
      { header: 'Vendor', key: 'vendor_name', width: 26 }, { header: 'Machine', key: 'equipment_code', width: 12 }, { header: 'Type', key: 'type_name', width: 16 },
      { header: 'Deployed days', key: 'deployed_days', width: 10 }, { header: 'Worked days', key: 'worked_days', width: 10 }, { header: 'Work h', key: 'work_hours', width: 10 },
      { header: 'Standby h', key: 'standby_hours', width: 10 }, { header: 'Breakdown h', key: 'breakdown_hours', width: 11 },
      { header: 'Utilization %', key: 'utilization_pct', width: 12 }, { header: 'Availability %', key: 'availability_pct', width: 12 },
    ];
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B3B3B' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    data.forEach((r) => ws.addRow(r));
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="equipment-utilization-${q.from}_${q.to}.xlsx"`);
    return res.send(Buffer.from(await wb.xlsx.writeBuffer()));
  }
  const doc = P.createDoc({ layout: 'landscape', info: { Title: 'Equipment utilization' } });
  const y = P.header(doc, { title: 'EQUIPMENT UTILIZATION', titleAr: 'نسبة استخدام الآليات', subtitle: `${fmt.date(q.from)} - ${fmt.date(q.to)}` });
  P.table(doc, {
    y, rowHeight: 16, headHeight: 24, onNewPage: () => doc.page.margins.top + 4,
    rows: data.map((r) => ({ ...r, m: `${r.equipment_code} ${r.type_name}`, u: `${r.utilization_pct}%`, a: `${r.availability_pct}%`, _color: r.utilization_pct < 50 ? COLORS.red : undefined })),
    columns: [
      { key: 'vendor_name', en: 'Vendor', ar: 'الجهة المؤجرة', width: 150, align: 'left' }, { key: 'm', en: 'Machine', ar: 'الآلية', width: 130, align: 'left' },
      { key: 'deployed_days', en: 'Deployed days', ar: 'أيام التخصيص', width: 60 }, { key: 'worked_days', en: 'Worked days', ar: 'أيام العمل', width: 60 },
      { key: 'work_hours', en: 'Work h', ar: 'ساعات العمل', width: 60 }, { key: 'standby_hours', en: 'Standby h', ar: 'انتظار', width: 60 },
      { key: 'breakdown_hours', en: 'Breakdown h', ar: 'أعطال', width: 60 }, { key: 'u', en: 'Utilization', ar: 'نسبة الاستخدام', width: 103, bold: true },
      { key: 'a', en: 'Availability', ar: 'الجاهزية', width: 110 },
    ],
  });
  P.footers(doc, `Equipment Flow | utilization ${q.from} to ${q.to} | utilization = work / (deployed days x standard hours)`);
  const buf = await P.toBuffer(doc);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="equipment-utilization-${q.from}_${q.to}.pdf"`);
  return res.send(buf);
};
