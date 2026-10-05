// services/equipment/eqStatements.js — D2 machine statement, D3 vendor statement, D4 payroll summary (PDF) + Excel.
const ExcelJS = require('exceljs');
const P = require('../pdfKit');
const settings = require('../settings');
const { businessNow } = require('../../utils/businessDate');

const { COLORS, fmt } = P;
const LINE_LABEL = {
  Work: 'Work', Overtime: 'Overtime', Standby: 'Standby (billable part)', Breakdown: 'Breakdown (billable part)',
  MinimumTopUp: 'Minimum guarantee top-up', MonthlyBase: 'Monthly base', AbsenceDeduction: 'Absence deduction',
  BreakdownDeduction: 'Breakdown deduction', Operator: 'Operator (not included in rate)', Fuel: 'Fuel issued by us', Adjustment: 'Adjustment',
  FuelPriceDifference: 'Fuel price difference (compensation)', HoursShortfall: 'Hours below the monthly hours due',
};

const n = (v) => Number(v || 0);
const cents = (v) => Math.round(n(v) * 100);
const money = (v, cur) => fmt.money(cents(v), cur);

// --------------------------------------------------------------- amount in words (EN)
const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function under1000(x) {
  const parts = [];
  if (x >= 100) { parts.push(`${ONES[Math.floor(x / 100)]} hundred`); x %= 100; }
  if (x >= 20) { parts.push(TENS[Math.floor(x / 10)] + (x % 10 ? `-${ONES[x % 10]}` : '')); } else if (x > 0) parts.push(ONES[x]);
  return parts.join(' ');
}
function intWords(x) {
  if (x === 0) return 'zero';
  const scales = [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];
  const parts = [];
  for (const [v, w] of scales) if (x >= v) { parts.push(`${under1000(Math.floor(x / v))} ${w}`); x %= v; }
  if (x) parts.push(under1000(x));
  return parts.join(' ');
}
function amountInWords(amount, currency) {
  const c = Math.round(Math.abs(amount) * 100);
  const whole = Math.floor(c / 100); const fr = c % 100;
  const name = { USD: ['US dollars', 'cents'], SYP: ['Syrian pounds', 'piastres'], EUR: ['euros', 'cents'] }[currency] || [currency, 'cents'];
  let s = `${intWords(whole)} ${name[0]}`;
  if (fr && currency !== 'SYP') s += ` and ${intWords(fr)} ${name[1]}`;
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return amount < 0 ? `Minus ${s.toLowerCase()}` : s;
}

// --------------------------------------------------------------- shared bits
function scopeText(b) {
  const parts = [];
  parts.push(b.scope_vendor_name ? `Vendor: ${b.scope_vendor_name}` : 'All vendors');
  if (b.scope_equipment_code) parts.push(`Machine: ${b.scope_equipment_code}`);
  if (b.scope_site_code) parts.push(`Site: ${b.scope_site_code}`);
  return parts.join(' | ');
}

function statusText(b) {
  if (b.provisional) return 'PROVISIONAL';
  if (b.status === 'Generated') return b.is_finalized ? 'Final' : 'Draft (not final)';
  return b.status;
}
const isFinal = (b) => !b.provisional && b.is_finalized && (b.status === 'Generated' || b.status === 'Paid');

/** Right block of the header: document number (or DRAFT) + batch + currency. */
function numberBlock(doc, b, no, cur, internal = false) {
  return (xr, top) => {
    const w = 190;
    if (internal) {
      P.text(doc, isFinal(b) ? 'INTERNAL SUMMARY - FINAL' : 'INTERNAL SUMMARY - DRAFT', xr - w, top + 2, { size: 7.5, bold: true, color: isFinal(b) ? COLORS.navy : COLORS.red, width: w, align: 'right', lineBreak: false });
    } else if (no) {
      P.text(doc, 'No.', xr - w, top, { size: 7, color: COLORS.muted, width: w - 70, align: 'right', lineBreak: false });
      P.text(doc, 'رقم المستند', xr - w, top + 9, { size: 6.5, color: COLORS.muted, width: w - 70, align: 'right', lineBreak: false });
      P.text(doc, no, xr - 66, top, { size: 9, bold: true, color: COLORS.navy, width: 66, align: 'right', lineBreak: false });
    } else {
      P.text(doc, b.provisional ? 'PROVISIONAL - NO NUMBER' : 'DRAFT - NOT YET NUMBERED', xr - w, top + 2, { size: 7.5, bold: true, color: COLORS.red, width: w, align: 'right', lineBreak: false });
    }
    P.text(doc, b.provisional ? 'Not a payroll batch' : `Batch #${b.eq_batch_id} | v${b.version_number}`, xr - w, top + 22, { size: 7, width: w, align: 'right', lineBreak: false });
    P.text(doc, `Currency ${cur}`, xr - w, top + 32, { size: 7, width: w, align: 'right', lineBreak: false });
  };
}

function watermark(doc, label) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    doc.save();
    doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
    doc.font('Helvetica-Bold').fontSize(48).fillColor('#C0392B').fillOpacity(0.10)
      .text(label, 0, doc.page.height / 2 - 30, { width: doc.page.width, align: 'center', lineBreak: false });
    doc.restore();
    doc.fillOpacity(1);
  }
}

function signatureRow(doc, y, labels) {
  const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right;
  if (y + 50 > doc.page.height - doc.page.margins.bottom - 14) { doc.addPage(); y = doc.page.margins.top + 10; }
  const w = W / labels.length;
  labels.forEach(([en, ar], i) => {
    const x = L + i * w;
    doc.moveTo(x + 10, y + 30).lineTo(x + w - 10, y + 30).lineWidth(0.6).strokeColor('#888').stroke();
    P.text(doc, en, x, y + 33, { size: 7.5, width: w, align: 'center', lineBreak: false });
    P.text(doc, ar, x, y + 43, { size: 7, color: COLORS.muted, width: w, align: 'center', lineBreak: false });
  });
  return y + 56;
}

function sectionTitle(doc, y, en, ar) {
  const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right;
  if (y + 40 > doc.page.height - doc.page.margins.bottom - 14) { doc.addPage(); y = doc.page.margins.top + 4; }
  doc.rect(L, y + 2, 3, 12).fill(COLORS.gold);
  P.text(doc, en, L + 8, y + 3, { size: 9.5, bold: true, color: COLORS.navy, width: W / 2, lineBreak: false });
  if (ar) P.text(doc, ar, L + W / 2, y + 1, { size: 9, color: COLORS.navy, width: W / 2, align: 'right', lineBreak: false });
  return y + 18;
}

function totalsBox(doc, y, { gross, deductions, net, currency }) {
  const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right;
  if (y + 74 > doc.page.height - doc.page.margins.bottom - 14) { doc.addPage(); y = doc.page.margins.top + 4; }
  const bw = 290; const x = L + W - bw;
  const row = (en, ar, val, yy, opts = {}) => {
    const h = opts.fill ? 20 : 17;
    if (opts.fill) doc.rect(x, yy, bw, h).fill(opts.fill);
    else doc.rect(x, yy, bw, h).lineWidth(0.4).strokeColor(COLORS.grid).stroke();
    P.text(doc, en, x + 6, yy, { size: opts.size || 8, bold: opts.bold, color: opts.color, width: bw * 0.42, height: h, valign: 'middle', lineBreak: false });
    P.text(doc, ar, x + bw * 0.36, yy, { size: (opts.size || 8) - 0.5, color: opts.arColor || opts.color || COLORS.muted, width: bw * 0.31, height: h, valign: 'middle', align: 'right', lineBreak: false });
    P.text(doc, val, x + bw * 0.68, yy, { size: opts.size || 8, bold: opts.bold, color: opts.valColor || opts.color, width: bw * 0.32 - 6, height: h, valign: 'middle', align: 'right', lineBreak: false });
  };
  row('Total earnings and additions', 'إجمالي المستحقات والإضافات', money(gross, currency), y);
  row('Total deductions', 'إجمالي الحسومات', n(deductions) ? `-${money(deductions, currency)}` : money(0, currency), y + 17, { valColor: n(deductions) ? COLORS.red : undefined });
  row(`NET AMOUNT DUE (${currency})`, 'صافي المبلغ المستحق', money(net, currency), y + 34, { fill: COLORS.navy, color: COLORS.white, arColor: '#E9DDBE', bold: true, size: 9.5 });
  P.text(doc, amountInWords(n(net), currency), L, y + 58, { size: 7.5, color: COLORS.muted, width: W, align: 'right', lineBreak: false });
  return y + 72;
}

function lineDesc(l, rate) {
  let s = LINE_LABEL[l.line_type] || l.line_type;
  if (l.line_type === 'Standby' && rate) s += ` @ ${n(rate.standby_billable_pct)}%`;
  if (l.line_type === 'Breakdown' && rate) s += ` @ ${n(rate.breakdown_billable_pct)}%`;
  if (l.line_type === 'Overtime' && rate && rate.billing_mode !== 'Monthly') s += ` (> ${n(rate.overtime_threshold_hours ?? rate.standard_hours_per_day)} h/day)`;
  if (l.line_type === 'Overtime' && rate && rate.billing_mode === 'Monthly') s += ' (hours above the monthly hours due)';
  if (l.line_type === 'MinimumTopUp' && rate) s += ` (${n(rate.min_billable_hours_per_day)} h/day)`;
  if (l.note) s += ` - ${l.note}`;
  return s;
}

function rateSummary(r) {
  if (!r) return '';
  if (r.billing_mode === 'Monthly') {
    const parts = [`Monthly ${fmt.num(r.monthly_rate)}`, `${n(r.standard_hours_per_day)} h per working day`,
      'hourly price = monthly / working days of the month / hours per day',
      `overtime ${r.overtime_rate !== null && r.overtime_rate !== undefined ? `at ${fmt.num(r.overtime_rate)}/h` : 'at the hourly price'}`,
      'standby: hours given per day by the accountant', `breakdown ${n(r.breakdown_billable_pct)}%`, `breaks ${r.break_policy === 'Paid' ? 'paid' : 'deducted'}`];
    return parts.join(' | ');
  }
  const price = r.billing_mode === 'Hourly' ? `${fmt.num(r.hourly_rate)}/h` : `${fmt.num(r.daily_rate)}/day`;
  const parts = [`${r.billing_mode} ${price}`, `std ${n(r.standard_hours_per_day)} h/day`];
  if (r.min_billable_hours_per_day !== null && r.min_billable_hours_per_day !== undefined) parts.push(`min ${n(r.min_billable_hours_per_day)} h/day`);
  if (n(r.overtime_enabled)) parts.push(`OT > ${n(r.overtime_threshold_hours ?? r.standard_hours_per_day)} h at ${r.overtime_rate !== null && r.overtime_rate !== undefined ? fmt.num(r.overtime_rate) : `x${n(r.overtime_multiplier)}`}`);
  parts.push(`standby ${n(r.standby_billable_pct)}%`, `breakdown ${n(r.breakdown_billable_pct)}%`, `breaks ${r.break_policy === 'Paid' ? 'paid' : 'deducted'}`);
  parts.push(`fuel: ${r.fuel_policy}`);
  return parts.join(' | ');
}

/** Monthly machines: how the hours due were computed (one row per month). */
function drawMonthlyCalc(doc, y, it, cur) {
  const mc = (it.rate && it.rate.monthly_calc) || it.monthly_calc;
  if (!mc || !mc.length) return y;
  y = sectionTitle(doc, y, 'Monthly hours', 'احتساب الساعات الشهرية');
  return P.table(doc, {
    y, rowHeight: 15, headHeight: 26, fontSize: 7, onNewPage: () => doc.page.margins.top + 4,
    columns: [
      { key: 'm', en: 'Month', ar: 'الشهر', width: 50 }, { key: 'wd', en: 'Working days', ar: 'أيام العمل', width: 52 },
      { key: 'dep', en: 'Deployed', ar: 'أيام التخصيص', width: 52 }, { key: 'hol', en: 'Holidays', ar: 'عطل رسمية', width: 44 },
      { key: 'hpd', en: 'H per day', ar: 'ساعات اليوم', width: 46 }, { key: 'req', en: 'Hours due', ar: 'الساعات المطلوبة', width: 56 },
      { key: 'done', en: 'Hours done', ar: 'الساعات المنفذة', width: 56 }, { key: 'hp', en: 'Hourly price', ar: 'سعر الساعة', width: 60, align: 'right' },
      { key: 'res', en: 'Result', ar: 'النتيجة', width: 131, align: 'left' },
    ],
    rows: mc.map((x) => ({
      m: x.month, wd: x.working_days, dep: x.deployed_working_days, hol: x.holiday_days || '', hpd: fmt.num(x.hours_per_day), req: fmt.num(x.required_hours),
      done: fmt.num(x.billable_hours), hp: fmt.num(x.hourly_price, 3),
      res: x.overtime_hours > 0 ? `+${fmt.num(x.overtime_hours)} h overtime` : x.missing_hours > 0 ? `-${fmt.num(x.missing_hours)} h missing` : 'hours complete',
      _color: x.missing_hours > 0 ? COLORS.red : undefined,
    })),
  }) + 6;
}

// --------------------------------------------------------------- data shaping
/** Normalized statement model from a batch detail. */
async function modelFromBatch(conn, detail) {
  const [rows] = await conn.query(
    `SELECT s.*, i.equipment_id, i.site_id FROM eq_payroll_attendance_snapshot s JOIN eq_payroll_items i ON i.eq_item_id = s.eq_item_id
     WHERE s.eq_batch_id = ? ORDER BY s.record_date`, [detail.eq_batch_id]);
  const [[scope]] = await conn.query(
    `SELECT vd.vendor_name AS scope_vendor_name, e.equipment_code AS scope_equipment_code, s.site_code AS scope_site_code
     FROM eq_payroll_batches b LEFT JOIN eq_vendors vd ON vd.vendor_id = b.scope_vendor_id LEFT JOIN eq_equipment e ON e.equipment_id = b.scope_equipment_id
     LEFT JOIN sites s ON s.site_id = b.scope_site_id WHERE b.eq_batch_id = ?`, [detail.eq_batch_id]);
  const items = detail.items.map((i) => ({
    ...i, rate: i.rate_snapshot, fuel_diff: i.rate_snapshot && i.rate_snapshot.fuel_diff, rows: rows.filter((r) => r.eq_item_id === i.eq_item_id),
    lines: i.lines.map((l) => ({ ...l, quantity: n(l.quantity), unit_price: n(l.unit_price), amount: n(l.amount) })),
  }));
  return { batch: { ...detail, ...scope }, items };
}

/** Same model from a provisional calculation (no batch). */
async function modelFromCalc(conn, { kind, scope, items }) {
  const eqIds = [...new Set(items.map((i) => i.equipment_id))];
  const [eqs] = await conn.query('SELECT e.equipment_id, e.equipment_code, e.plate_number, t.type_name FROM eq_equipment e JOIN eq_types t ON t.type_id = e.type_id WHERE e.equipment_id IN (?)', [eqIds]);
  const [vds] = await conn.query('SELECT vendor_id, vendor_name, vendor_code FROM eq_vendors WHERE vendor_id IN (?)', [[...new Set(items.map((i) => i.vendor_id))]]);
  const [sts] = await conn.query('SELECT site_id, site_code, site_name FROM sites WHERE site_id IN (?)', [[...new Set(items.map((i) => i.site_id))]]);
  const by = (arr, k) => Object.fromEntries(arr.map((x) => [x[k], x]));
  const E = by(eqs, 'equipment_id'); const V = by(vds, 'vendor_id'); const S = by(sts, 'site_id');
  const h = (m) => (n(m) / 60).toFixed(2);
  const out = items.map((i) => ({
    equipment_id: i.equipment_id, equipment_code: E[i.equipment_id].equipment_code, type_name: E[i.equipment_id].type_name,
    vendor_id: i.vendor_id, vendor_name: V[i.vendor_id].vendor_name, vendor_code: V[i.vendor_id].vendor_code,
    site_id: i.site_id, site_code: S[i.site_id].site_code, site_name: S[i.site_id].site_name, billing_mode: i.billing_mode,
    rate: i.rate_snapshot, fuel_diff: i.fuel_diff || null, monthly_calc: i.monthly_calc || null, plate_number: E[i.equipment_id].plate_number, days_recorded: i.days_recorded, worked_days: i.worked_days,
    work_hours: h(i.work_minutes), overtime_hours: h(i.overtime_minutes), standby_hours: h(i.standby_minutes), breakdown_hours: h(i.breakdown_minutes), topup_hours: h(i.topup_minutes),
    gross_amount: i.gross_cents / 100, deductions_amount: i.deductions_cents / 100, net_amount: i.net_cents / 100,
    lines: i.lines.map((l) => ({ line_type: l.line_type, quantity: l.quantity, unit: l.unit, unit_price: l.unit_price_exact ?? l.unit_price_cents / 100, amount: l.amount_cents / 100, note: l.note || null, source_table: l.source_table, source_id: l.source_id })),
    rows: i.per_row.map((p) => ({ record_date: p.row.record_date, day_status: p.row.day_status, check_in_time: p.row.check_in_time, check_out_time: p.row.check_out_time, operator_name: p.row.operator_name, work_minutes: p.work, overtime_minutes: p.ot, standby_minutes: p.standby, breakdown_minutes: p.breakdown, topup_minutes: p.topup, meter_start: p.row.meter_start, meter_end: p.row.meter_end, sheet_row_no: p.row.sheet_row_no, paper_status: p.row.paper_status })),
  }));
  const sum = (k) => out.reduce((a, i) => a + n(i[k]), 0);
  const batch = {
    provisional: true, eq_batch_id: null, version_number: null, start_date: scope.start_date, end_date: scope.end_date, currency: items[0].currency,
    total_gross: sum('gross_amount'), total_deductions: sum('deductions_amount'), total_net: sum('net_amount'), total_equipment: eqIds.length,
    scope_vendor_name: kind === 'vendor' ? out[0].vendor_name : null, scope_equipment_code: kind === 'machine' ? out[0].equipment_code : null,
  };
  return { batch, items: out };
}

// --------------------------------------------------------------- D2 machine invoice / statement
const fuelDiffOf = (it) => it.lines.filter((l) => l.line_type === 'FuelPriceDifference').reduce((a, l) => a + n(l.amount), 0);

function drawMachine(doc, ctx, b, items) {
  const first = items[0];
  const cur = b.currency;
  const final = isFinal(b);
  const numbers = [...new Set(items.map((i) => i.invoice_no).filter(Boolean))].join(', ');
  let y = P.header(doc, {
    title: final ? 'MACHINE RENTAL INVOICE' : 'MACHINE RENTAL STATEMENT',
    titleAr: final ? 'فاتورة استئجار آلية' : 'كشف حساب استئجار آلية',
    subtitle: ctx.company,
    right: numberBlock(doc, b, final ? numbers : null, cur),
  });
  y = P.infoGrid(doc, [
    { label: 'Machine', labelAr: 'الآلية', value: `${first.equipment_code} | ${first.type_name}${first.plate_number ? ` | ${first.plate_number}` : ''}` },
    { label: 'Lessor (vendor)', labelAr: 'الجهة المؤجرة', value: `${first.vendor_name}${first.vendor_code ? ` (${first.vendor_code})` : ''}` },
    { label: 'Billing period', labelAr: 'فترة المطالبة', value: `${fmt.date(b.start_date)} - ${fmt.date(b.end_date)}` },
    { label: 'Contract', labelAr: 'رقم العقد', value: (first.rate && first.rate.contract_number) || first.contract_number || '-' },
  ], y, 2);
  for (const it of items) {
    y = sectionTitle(doc, y, `${it.site_code} - ${it.site_name || ''} | ${it.billing_mode} billing`, 'شروط التسعير');
    P.text(doc, rateSummary(it.rate), doc.page.margins.left, y, { size: 7.2, color: COLORS.muted, width: doc.page.width - 48 });
    y = doc.y + 4;
    y = drawMonthlyCalc(doc, y, it, cur);
    const rows = it.rows.map((r) => ({
      date: fmt.dayDate(r.record_date), status: r.day_status, op: r.operator_name || '', in: fmt.time(r.check_in_time), out: fmt.time(r.check_out_time),
      work: fmt.hours(r.work_minutes), ot: n(r.overtime_minutes) ? fmt.hours(r.overtime_minutes) : '', sb: n(r.standby_minutes) ? fmt.hours(r.standby_minutes) : '',
      bd: n(r.breakdown_minutes) ? fmt.hours(r.breakdown_minutes) : '', tu: n(r.topup_minutes) ? fmt.hours(r.topup_minutes) : '',
      meter: r.meter_start !== null && r.meter_end !== null && r.meter_start !== undefined ? fmt.num(n(r.meter_end) - n(r.meter_start), 1) : '',
      row: r.sheet_row_no, paper: r.paper_status,
    }));
    y = P.table(doc, {
      y, rows, rowHeight: 15, headHeight: 24, fontSize: 7,
      columns: [
        { key: 'date', en: 'Date', ar: 'التاريخ', width: 50 }, { key: 'status', en: 'Status', ar: 'الحالة', width: 48 },
        { key: 'op', en: 'Operator', ar: 'المشغل', width: 70, align: 'left' }, { key: 'in', en: 'Start', ar: 'البدء', width: 30 },
        { key: 'out', en: 'End', ar: 'الانتهاء', width: 30 }, { key: 'work', en: 'Work h', ar: 'ساعات العمل', width: 34, bold: true },
        { key: 'ot', en: 'OT h', ar: 'إضافي', width: 30 }, { key: 'sb', en: 'Standby h', ar: 'انتظار', width: 36 },
        { key: 'bd', en: 'Breakdown h', ar: 'أعطال', width: 36 }, { key: 'tu', en: 'Min. top-up', ar: 'حد أدنى', width: 34 },
        { key: 'meter', en: 'Meter diff', ar: 'فرق العداد', width: 34 }, { key: 'row', en: 'Sheet row', ar: 'السطر', width: 28 },
        { key: 'paper', en: 'Paper', ar: 'الورقة', width: 37 },
      ],
      onNewPage: () => doc.page.margins.top + 4,
    });
    y += 6;
    y = drawLines(doc, y, [it], cur, false);
    y = totalsBox(doc, y + 4, { gross: it.gross_amount, deductions: it.deductions_amount, net: it.net_amount, currency: cur });
    if (fuelDiffOf(it)) {
      P.text(doc, `Includes a fuel price difference of ${money(fuelDiffOf(it), cur)} ${cur}, detailed in the attached statement${it.fuel_invoice_no ? ` ${it.fuel_invoice_no}` : ''}.`,
        doc.page.margins.left, y, { size: 7, color: COLORS.muted, width: doc.page.width - 48 });
      y = doc.y + 4;
    }
  }
  if (items.length > 1) {
    const sum = (k) => items.reduce((a, i) => a + n(i[k]), 0);
    y = sectionTitle(doc, y, 'Machine total', 'إجمالي الآلية');
    y = totalsBox(doc, y, { gross: sum('gross_amount'), deductions: sum('deductions_amount'), net: sum('net_amount'), currency: cur });
  }
  signatureRow(doc, y + 6, [['Prepared by', 'إعداد'], ['Reviewed by', 'تدقيق'], ['Approved by', 'اعتماد']]);
}

function drawLines(doc, y, items, cur, withMachine = true) {
  const rows = [];
  for (const it of items) {
    for (const l of it.lines) {
      rows.push({
        m: it.equipment_code, desc: lineDesc(l, it.rate), qty: fmt.num(l.quantity, l.unit === 'day' || l.unit === 'month' ? 3 : 2).replace(/\.?0+$/, (m) => (m.startsWith('.') ? '' : m)),
        unit: l.unit, price: fmt.num(l.unit_price, l.line_type === 'FuelPriceDifference' || l.line_type === 'Fuel' ? 3 : 2), amount: money(l.amount, cur),
        _color: n(l.amount) < 0 ? COLORS.red : undefined,
      });
    }
  }
  const cols = [
    ...(withMachine ? [{ key: 'm', en: 'Machine', ar: 'الآلية', width: 60 }] : []),
    { key: 'desc', en: 'Description', ar: 'البيان', width: withMachine ? 250 : 310, align: 'left' }, { key: 'qty', en: 'Qty', ar: 'الكمية', width: 50 },
    { key: 'unit', en: 'Unit', ar: 'الوحدة', width: 40 }, { key: 'price', en: 'Unit price', ar: 'سعر الوحدة', width: 70, align: 'right' },
    { key: 'amount', en: `Amount (${cur})`, ar: 'المبلغ', width: 77, align: 'right', bold: true },
  ];
  return P.table(doc, { y, rows, columns: cols, rowHeight: 15, headHeight: 24, fontSize: 7.2, onNewPage: () => doc.page.margins.top + 4 }) + 4;
}

// --------------------------------------------------------------- D3 vendor invoice / statement
function drawVendor(doc, ctx, b, items) {
  const cur = b.currency;
  const v = items[0];
  const final = isFinal(b);
  let y = P.header(doc, {
    title: final ? 'VENDOR INVOICE - RENTED EQUIPMENT' : 'VENDOR STATEMENT - RENTED EQUIPMENT',
    titleAr: final ? 'فاتورة مستحقات الجهة المؤجرة' : 'كشف مستحقات الجهة المؤجرة',
    subtitle: ctx.company,
    right: numberBlock(doc, b, final ? v.vendor_invoice_no : null, cur),
  });
  y = P.infoGrid(doc, [
    { label: 'Lessor (vendor)', labelAr: 'الجهة المؤجرة', value: v.vendor_name },
    { label: 'Contract(s)', labelAr: 'العقود', value: [...new Set(items.map((i) => (i.rate && i.rate.contract_number) || i.contract_number).filter(Boolean))].join(', ') || '-' },
    { label: 'Billing period', labelAr: 'فترة المطالبة', value: `${fmt.date(b.start_date)} - ${fmt.date(b.end_date)}` },
    { label: 'Issued', labelAr: 'تاريخ الإصدار', value: final && b.finalized_at ? fmt.date(String(b.finalized_at).slice(0, 10)) : `${ctx.printedAt} (draft)` },
  ], y, 4);
  y = sectionTitle(doc, y, '1. Machines summary', 'ملخص الآليات');
  const fuelOf = (it) => it.lines.filter((l) => l.line_type === 'Fuel').reduce((a, l) => a + n(l.amount), 0);
  const adjOf = (it) => it.lines.filter((l) => l.line_type === 'Adjustment').reduce((a, l) => a + n(l.amount), 0);
  const special = ['Fuel', 'Adjustment', 'FuelPriceDifference'];
  const otherDed = (it) => it.lines.filter((l) => !special.includes(l.line_type) && n(l.amount) < 0).reduce((a, l) => a + n(l.amount), 0);
  const earn = (it) => it.lines.filter((l) => !special.includes(l.line_type) && n(l.amount) > 0).reduce((a, l) => a + n(l.amount), 0);
  const rows = items.map((it) => ({
    m: `${it.equipment_code} ${it.type_name}`, site: it.site_code, bill: it.billing_mode, days: it.worked_days, work: fmt.num(it.work_hours), ot: fmt.num(it.overtime_hours),
    sb: fmt.num(it.standby_hours), bd: fmt.num(it.breakdown_hours), earn: money(earn(it), cur), fd: fuelDiffOf(it) ? money(fuelDiffOf(it), cur) : '-',
    fuel: fuelOf(it) ? money(fuelOf(it), cur) : '-', adj: adjOf(it) ? money(adjOf(it), cur) : '-', ded: otherDed(it) ? money(otherDed(it), cur) : '-', net: money(it.net_amount, cur),
  }));
  const tot = (f) => items.reduce((a, it) => a + f(it), 0);
  rows.push({ m: 'Totals', net: money(tot((i) => n(i.net_amount)), cur), earn: money(tot(earn), cur), fd: money(tot(fuelDiffOf), cur), fuel: money(tot(fuelOf), cur), adj: money(tot(adjOf), cur), ded: money(tot(otherDed), cur), _bold: true, _fill: COLORS.soft });
  y = P.table(doc, {
    y, rows, rowHeight: 16, headHeight: 26, fontSize: 6.8,
    columns: [
      { key: 'm', en: 'Machine', ar: 'الآلية', width: 66, align: 'left' }, { key: 'site', en: 'Site', ar: 'الموقع', width: 30 },
      { key: 'bill', en: 'Billing', ar: 'الأساس', width: 34 }, { key: 'days', en: 'Days', ar: 'الأيام', width: 28 },
      { key: 'work', en: 'Work h', ar: 'العمل', width: 34 }, { key: 'ot', en: 'OT h', ar: 'إضافي', width: 28 },
      { key: 'sb', en: 'Standby h', ar: 'انتظار', width: 34 }, { key: 'bd', en: 'Brkdn h', ar: 'أعطال', width: 30 },
      { key: 'earn', en: 'Earnings', ar: 'المستحق', width: 48, align: 'right' }, { key: 'fd', en: 'Fuel diff.', ar: 'فرق محروقات', width: 40, align: 'right' },
      { key: 'fuel', en: 'Fuel', ar: 'محروقات', width: 38, align: 'right' }, { key: 'adj', en: 'Adjust.', ar: 'تسويات', width: 38, align: 'right' },
      { key: 'ded', en: 'Other ded.', ar: 'حسومات', width: 38, align: 'right' }, { key: 'net', en: 'Net', ar: 'الصافي', width: 61, align: 'right', bold: true },
    ],
    onNewPage: () => doc.page.margins.top + 4,
  });
  let sec = 2;
  y = sectionTitle(doc, y + 6, `${sec++}. Invoice lines`, 'تفاصيل البنود');
  y = drawLines(doc, y, items, cur, true);
  const fdItems = items.filter((it) => fuelDiffOf(it));
  if (fdItems.length) {
    y = sectionTitle(doc, y + 4, `${sec++}. Fuel price difference (attached statements)`, 'فروقات أسعار المحروقات');
    y = P.table(doc, { y, rowHeight: 15, headHeight: 24, fontSize: 7.2, onNewPage: () => doc.page.margins.top + 4,
      columns: [{ key: 'm', en: 'Machine', ar: 'الآلية', width: 90 }, { key: 'no', en: 'Statement no.', ar: 'رقم البيان', width: 110 },
        { key: 'l', en: 'Litres', ar: 'الليترات', width: 80 }, { key: 'note', en: 'Basis', ar: 'الأساس', width: 170, align: 'left' }, { key: 'amount', en: 'Amount', ar: 'المبلغ', width: 97, align: 'right' }],
      rows: fdItems.map((it) => {
        const ls = it.lines.filter((l) => l.line_type === 'FuelPriceDifference');
        return { m: it.equipment_code, no: it.fuel_invoice_no || (final ? '-' : 'draft'), l: fmt.num(ls.reduce((a, l) => a + n(l.quantity), 0)),
          note: 'Working hours x L/h x (national - base price)', amount: money(fuelDiffOf(it), cur) };
      }) }) + 4;
  }
  const fuelLines = items.flatMap((it) => it.lines.filter((l) => l.line_type === 'Fuel').map((l) => ({ ...l, m: it.equipment_code, site: it.site_code })));
  if (fuelLines.length) {
    y = sectionTitle(doc, y + 4, `${sec++}. Fuel supplied by the company`, 'المحروقات المسلمة من الشركة');
    y = P.table(doc, { y, rowHeight: 15, headHeight: 24, fontSize: 7.2, onNewPage: () => doc.page.margins.top + 4,
      columns: [{ key: 'm', en: 'Machine', ar: 'الآلية', width: 70 }, { key: 'site', en: 'Site', ar: 'الموقع', width: 50 }, { key: 'note', en: 'Date / receipt', ar: 'التاريخ والإيصال', width: 150, align: 'left' },
        { key: 'qty', en: 'Litres', ar: 'الليترات', width: 60 }, { key: 'price', en: 'Price/L', ar: 'سعر الليتر', width: 70, align: 'right' }, { key: 'amount', en: 'Amount', ar: 'المبلغ', width: 147, align: 'right' }],
      rows: fuelLines.map((l) => ({ m: l.m, site: l.site, note: l.note || '', qty: fmt.num(l.quantity), price: fmt.num(l.unit_price, 3), amount: money(l.amount, cur), _color: COLORS.red })) }) + 4;
  }
  const adjLines = items.flatMap((it) => it.lines.filter((l) => l.line_type === 'Adjustment').map((l) => ({ ...l, m: it.equipment_code })));
  if (adjLines.length) {
    y = sectionTitle(doc, y + 4, `${sec++}. Additions and deductions`, 'الإضافات والحسومات');
    y = P.table(doc, { y, rowHeight: 15, headHeight: 24, fontSize: 7.2, onNewPage: () => doc.page.margins.top + 4,
      columns: [{ key: 'm', en: 'Machine', ar: 'الآلية', width: 70 }, { key: 'note', en: 'Type: reason', ar: 'النوع والسبب', width: 380, align: 'left' }, { key: 'amount', en: 'Amount', ar: 'المبلغ', width: 97, align: 'right' }],
      rows: adjLines.map((l) => ({ m: l.m, note: l.note || '', amount: money(l.amount, cur), _color: n(l.amount) < 0 ? COLORS.red : undefined })) }) + 4;
  }
  const sum = (k) => items.reduce((a, i) => a + n(i[k]), 0);
  y = totalsBox(doc, y + 6, { gross: sum('gross_amount'), deductions: sum('deductions_amount'), net: sum('net_amount'), currency: cur });
  P.text(doc, `Only approved attendance rows are included${ctx.requirePaper ? ', matched with the signed monthly timesheets' : ''}. Machine invoices: ${[...new Set(items.map((i) => i.invoice_no).filter(Boolean))].join(', ') || '-'}.`,
    doc.page.margins.left, y, { size: 6.8, color: COLORS.muted, width: doc.page.width - 48 });
  signatureRow(doc, doc.y + 10, [['Prepared by (Finance)', 'إعداد: الإدارة المالية'], ['Approved by (Project Manager)', 'اعتماد: مدير المشروع'], ['Acknowledged by the lessor', 'إقرار ممثل الجهة المؤجرة']]);
}

// --------------------------------------------------------------- D5 fuel price difference statement
function drawFuelDiff(doc, ctx, b, it) {
  const cur = b.currency;
  const final = isFinal(b);
  const fd = it.fuel_diff || { days: [], terms: [] };
  let y = P.header(doc, {
    title: 'FUEL PRICE DIFFERENCE STATEMENT', titleAr: 'بيان فروقات أسعار المحروقات', subtitle: ctx.company,
    right: numberBlock(doc, b, final ? it.fuel_invoice_no : null, cur),
  });
  const terms = fd.terms || [];
  y = P.infoGrid(doc, [
    { label: 'Machine', labelAr: 'الآلية', value: `${it.equipment_code} | ${it.type_name}` },
    { label: 'Lessor (vendor)', labelAr: 'الجهة المؤجرة', value: it.vendor_name },
    { label: 'Billing period', labelAr: 'فترة المطالبة', value: `${fmt.date(b.start_date)} - ${fmt.date(b.end_date)}` },
    { label: 'Attached to invoice', labelAr: 'ملحق بالفاتورة', value: it.invoice_no || (final ? '-' : 'draft') },
    { label: 'Site', labelAr: 'الموقع', value: `${it.site_code} ${it.site_name || ''}` },
    { label: 'Base fuel price', labelAr: 'السعر الأساسي', value: terms.map((t) => `${fmt.num(t.base_price_per_liter, 3)} from ${fmt.date(t.effective_from)}`).join(' | ') || '-' },
    { label: 'Consumption', labelAr: 'الاستهلاك التقديري', value: terms.map((t) => `${fmt.num(t.liters_per_hour, 2)} L/h`).join(' | ') || '-' },
    { label: 'Currency', labelAr: 'العملة', value: cur },
  ], y, 4);
  P.text(doc, 'Compensation for the increase of the official fuel price: (official price - base price) x litres per working hour x working hours (normal + overtime).', doc.page.margins.left, y, { size: 7.2, color: COLORS.muted, width: doc.page.width - 48 });
  P.text(doc, 'تعويض عن ارتفاع سعر المحروقات الرسمي، ويحسب بضرب الفرق بين السعر الرسمي والسعر الأساسي باستهلاك الآلية في الساعة وبعدد ساعات العمل العادية والإضافية', doc.page.margins.left, doc.y + 2, { size: 7.5, color: COLORS.muted, width: doc.page.width - 48, align: 'right' });
  y = doc.y + 6;
  const days = fd.days || [];
  const rows = days.map((d) => ({
    date: fmt.dayDate(d.record_date), h: fmt.num(d.hours), lph: fmt.num(d.liters_per_hour), l: fmt.num(d.liters),
    np: fmt.num(d.national_price, 3), bp: fmt.num(d.base_price, 3), diff: fmt.num(d.diff, 3), amount: money(d.amount, cur), _color: n(d.amount) < 0 ? COLORS.red : undefined,
  }));
  const tot = (k) => days.reduce((a, d) => a + n(d[k]), 0);
  rows.push({ date: 'Total', h: fmt.num(tot('hours')), l: fmt.num(tot('liters')), amount: money(fuelDiffOf(it), cur), _bold: true, _fill: COLORS.soft });
  y = P.table(doc, {
    y, rows, rowHeight: 15, headHeight: 26, fontSize: 7.2, onNewPage: () => doc.page.margins.top + 4,
    columns: [
      { key: 'date', en: 'Date', ar: 'التاريخ', width: 62 }, { key: 'h', en: 'Work h (incl. OT)', ar: 'ساعات العمل', width: 70 },
      { key: 'lph', en: 'L per hour', ar: 'ليتر لكل ساعة', width: 55 }, { key: 'l', en: 'Litres', ar: 'الليترات', width: 60 },
      { key: 'np', en: 'Official price', ar: 'السعر الرسمي', width: 68, align: 'right' }, { key: 'bp', en: 'Base price', ar: 'السعر الأساسي', width: 68, align: 'right' },
      { key: 'diff', en: 'Difference/L', ar: 'الفرق لليتر', width: 62, align: 'right' }, { key: 'amount', en: `Amount (${cur})`, ar: 'المبلغ', width: 102, align: 'right', bold: true },
    ],
  });
  y += 8;
  const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right;
  doc.rect(L + W - 290, y, 290, 22).fill(COLORS.navy);
  P.text(doc, `FUEL DIFFERENCE DUE (${cur})`, L + W - 284, y, { size: 9, bold: true, color: COLORS.white, width: 150, height: 22, valign: 'middle', lineBreak: false });
  P.text(doc, money(fuelDiffOf(it), cur), L + W - 140, y, { size: 9.5, bold: true, color: COLORS.white, width: 134, height: 22, valign: 'middle', align: 'right', lineBreak: false });
  y += 30;
  P.text(doc, 'This amount is already included in the machine invoice above; this statement explains it and is not paid separately.', L, y, { size: 6.8, color: COLORS.muted, width: W });
  signatureRow(doc, doc.y + 10, [['Prepared by (Finance)', 'إعداد: الإدارة المالية'], ['Approved by', 'اعتماد'], ['Acknowledged by the lessor', 'إقرار ممثل الجهة المؤجرة']]);
}

// --------------------------------------------------------------- D4 summary
function drawSummary(doc, ctx, b, items) {
  const cur = b.currency;
  let y = P.header(doc, { title: 'RENTED EQUIPMENT PAYROLL SUMMARY', titleAr: 'ملخص مستحقات الآليات المستأجرة', subtitle: ctx.company, right: numberBlock(doc, b, null, cur, true) });
  y = P.infoGrid(doc, [
    { label: 'Batch', labelAr: 'رقم الدفعة', value: b.provisional ? 'Provisional' : `#${b.eq_batch_id} | v${b.version_number}` },
    { label: 'Status', labelAr: 'الحالة', value: statusText(b) },
    { label: 'Billing period', labelAr: 'فترة المطالبة', value: `${fmt.date(b.start_date)} - ${fmt.date(b.end_date)}` },
    { label: 'Scope', labelAr: 'نطاق الكشف', value: scopeText(b) },
    { label: 'Machines', labelAr: 'عدد الآليات', value: String(new Set(items.map((i) => i.equipment_id)).size) },
    { label: 'Lessors', labelAr: 'الجهات المؤجرة', value: String(new Set(items.map((i) => i.vendor_id)).size) },
    { label: 'Work hours', labelAr: 'ساعات العمل', value: fmt.num(items.reduce((a, i) => a + n(i.work_hours), 0)) },
    { label: `Net (${cur})`, labelAr: 'صافي المستحق', value: money(items.reduce((a, i) => a + n(i.net_amount), 0), cur) },
  ], y, 4);
  const rows = [];
  const vendors = [...new Set(items.map((i) => i.vendor_id))];
  for (const vid of vendors) {
    const its = items.filter((i) => i.vendor_id === vid);
    rows.push({ v: `${its[0].vendor_name}${its[0].vendor_invoice_no ? `  [${its[0].vendor_invoice_no}]` : ''}`, _bold: true, _fill: COLORS.band });
    for (const it of its) {
      rows.push({ m: `${it.equipment_code} ${it.type_name}`, inv: it.invoice_no || '', site: it.site_code, bill: it.billing_mode, days: it.worked_days, work: fmt.num(it.work_hours), ot: fmt.num(it.overtime_hours), sb: fmt.num(it.standby_hours), fd: fuelDiffOf(it) ? money(fuelDiffOf(it), cur) : '', gross: money(it.gross_amount, cur), ded: money(it.deductions_amount, cur), net: money(it.net_amount, cur) });
    }
    const s = (k) => its.reduce((a, i) => a + n(i[k]), 0);
    rows.push({ m: 'Lessor subtotal', work: fmt.num(s('work_hours')), fd: money(its.reduce((a, i) => a + fuelDiffOf(i), 0), cur), gross: money(s('gross_amount'), cur), ded: money(s('deductions_amount'), cur), net: money(s('net_amount'), cur), _bold: true, _fill: COLORS.soft });
  }
  const s = (k) => items.reduce((a, i) => a + n(i[k]), 0);
  rows.push({ v: 'GRAND TOTAL', work: fmt.num(s('work_hours')), fd: money(items.reduce((a, i) => a + fuelDiffOf(i), 0), cur), gross: money(s('gross_amount'), cur), ded: money(s('deductions_amount'), cur), net: money(s('net_amount'), cur), _bold: true, _fill: COLORS.bandStrong });
  P.table(doc, {
    y, rows, rowHeight: 15, headHeight: 26, fontSize: 7.2, zebra: false, onNewPage: () => doc.page.margins.top + 4,
    columns: [
      { key: 'v', en: 'Lessor', ar: 'الجهة المؤجرة', width: 150, align: 'left' }, { key: 'm', en: 'Machine', ar: 'الآلية', width: 100, align: 'left' },
      { key: 'inv', en: 'Invoice no.', ar: 'رقم الفاتورة', width: 70 }, { key: 'site', en: 'Site', ar: 'الموقع', width: 38 }, { key: 'bill', en: 'Billing', ar: 'الأساس', width: 44 },
      { key: 'days', en: 'Days', ar: 'الأيام', width: 30 }, { key: 'work', en: 'Work h', ar: 'العمل', width: 42 }, { key: 'ot', en: 'OT h', ar: 'إضافي', width: 36 },
      { key: 'sb', en: 'Standby h', ar: 'انتظار', width: 40 }, { key: 'fd', en: 'Fuel diff.', ar: 'فرق محروقات', width: 56, align: 'right' },
      { key: 'gross', en: 'Gross', ar: 'الإجمالي', width: 66, align: 'right' }, { key: 'ded', en: 'Deductions', ar: 'الحسومات', width: 60, align: 'right' },
      { key: 'net', en: 'Net', ar: 'الصافي', width: 61, align: 'right', bold: true },
    ],
  });
}

// --------------------------------------------------------------- entry points
async function render(conn, model, opts, user) {
  const ctx = { company: await settings.getString('company_name'), printedAt: businessNow().slice(0, 16), printedBy: user.full_name, requirePaper: await settings.getBool('eq_payroll_requires_paper_match') };
  const { batch: b } = model;
  const items = model.items;
  const landscape = opts.view === 'summary';
  const doc = P.createDoc({ layout: landscape ? 'landscape' : 'portrait', info: { Title: `Equipment payroll ${opts.view}` } });
  let fileName;
  const tag = b.provisional ? `provisional-${b.start_date}_${b.end_date}` : `batch-${b.eq_batch_id}-v${b.version_number}`;
  if (opts.view === 'machine') {
    const ids = opts.equipmentId ? [opts.equipmentId] : [...new Set(items.map((i) => i.equipment_id))];
    ids.forEach((id, k) => { if (k) doc.addPage(); drawMachine(doc, ctx, b, items.filter((i) => i.equipment_id === id)); });
    const one = opts.equipmentId ? items.find((i) => i.equipment_id === opts.equipmentId) : null;
    fileName = `${one && one.invoice_no ? one.invoice_no : `machine-statement-${one ? one.equipment_code : 'all'}-${tag}`}.pdf`;
  } else if (opts.view === 'vendor') {
    const vids = opts.vendorId ? [opts.vendorId] : [...new Set(items.map((i) => i.vendor_id))];
    vids.forEach((vid, k) => { if (k) doc.addPage(); drawVendor(doc, ctx, b, items.filter((i) => i.vendor_id === vid)); });
    const one = opts.vendorId ? items.find((i) => i.vendor_id === opts.vendorId) : null;
    fileName = `${one && one.vendor_invoice_no ? one.vendor_invoice_no : `vendor-statement-${one ? one.vendor_code : 'all'}-${tag}`}.pdf`;
  } else if (opts.view === 'fueldiff') {
    const fdItems = items.filter((i) => fuelDiffOf(i) && (!opts.equipmentId || i.equipment_id === opts.equipmentId) && (!opts.vendorId || i.vendor_id === opts.vendorId));
    if (!fdItems.length) throw require('../../utils/AppError').notFound('Fuel price difference in this batch');
    fdItems.forEach((it, k) => { if (k) doc.addPage(); drawFuelDiff(doc, ctx, b, it); });
    fileName = `${fdItems.length === 1 && fdItems[0].fuel_invoice_no ? fdItems[0].fuel_invoice_no : `fuel-difference-${tag}`}.pdf`;
  } else {
    drawSummary(doc, ctx, b, items);
    fileName = `equipment-payroll-summary-${tag}.pdf`;
  }
  if (b.provisional) watermark(doc, 'PROVISIONAL - NOT AN INVOICE');
  else if (b.status === 'Voided' || b.status === 'Superseded') watermark(doc, b.status.toUpperCase());
  else if (!b.is_finalized) watermark(doc, 'DRAFT - NOT FINAL');
  P.footers(doc, `${ctx.company} | Equipment Flow | printed ${ctx.printedAt} by ${ctx.printedBy}`);
  return { buffer: await P.toBuffer(doc), fileName: fileName.replace(/[^A-Za-z0-9._-]/g, '_') };
}

async function batchPdf(conn, detail, opts, user) {
  const model = await modelFromBatch(conn, detail);
  if (opts.view === 'machine' && opts.equipmentId && !model.items.some((i) => i.equipment_id === opts.equipmentId)) throw require('../../utils/AppError').notFound('Machine in this batch');
  if (opts.view === 'vendor' && opts.vendorId && !model.items.some((i) => i.vendor_id === opts.vendorId)) throw require('../../utils/AppError').notFound('Vendor in this batch');
  if (opts.view === 'fueldiff' && opts.equipmentId && !model.items.some((i) => i.equipment_id === opts.equipmentId)) throw require('../../utils/AppError').notFound('Machine in this batch');
  if (!model.items.length) throw require('../../utils/AppError').notFound('Batch items');
  return render(conn, model, opts, user);
}

async function provisionalPdf(conn, calc, user) {
  const model = await modelFromCalc(conn, calc);
  return render(conn, model, { view: calc.kind === 'machine' ? 'machine' : 'vendor' }, user);
}

// --------------------------------------------------------------- Excel
async function batchXlsx(conn, detail) {
  const { batch: b, items } = await modelFromBatch(conn, detail);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Equipment Flow';
  const head = (ws, cols) => {
    ws.columns = cols;
    const r = ws.getRow(1);
    r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B3B3B' } };
    r.alignment = { vertical: 'middle', wrapText: true };
    r.height = 28;
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  };
  const moneyFmt = b.currency === 'SYP' ? '#,##0' : '#,##0.00';

  const s = wb.addWorksheet('Summary');
  s.addRows([
    ['Equipment payroll batch', `#${b.eq_batch_id} v${b.version_number}`], ['Status', statusText(b)], ['Period', `${b.start_date} to ${b.end_date}`],
    ['Scope', scopeText(b)], ['Currency', b.currency], ['Machines', Number(b.total_equipment)], ['Gross', n(b.total_gross)], ['Deductions', n(b.total_deductions)], ['Net', n(b.total_net)], [],
    ['Vendor', 'Machines', 'Gross', 'Deductions', 'Net'],
  ]);
  s.getColumn(1).width = 28; s.getColumn(2).width = 40; s.getColumn(3).width = 16; s.getColumn(4).width = 16; s.getColumn(5).width = 16;
  for (const r of [7, 8, 9]) s.getCell(`B${r}`).numFmt = moneyFmt;
  s.getRow(11).font = { bold: true };
  for (const vid of [...new Set(items.map((i) => i.vendor_id))]) {
    const its = items.filter((i) => i.vendor_id === vid);
    const row = s.addRow([its[0].vendor_name, new Set(its.map((i) => i.equipment_id)).size, its.reduce((a, i) => a + n(i.gross_amount), 0), its.reduce((a, i) => a + n(i.deductions_amount), 0), its.reduce((a, i) => a + n(i.net_amount), 0)]);
    [3, 4, 5].forEach((c) => { row.getCell(c).numFmt = moneyFmt; });
  }

  const m = wb.addWorksheet('Machines');
  head(m, [
    { header: 'Vendor', key: 'vendor', width: 26 }, { header: 'Machine', key: 'code', width: 12 }, { header: 'Type', key: 'type', width: 16 },
    { header: 'Site', key: 'site', width: 8 }, { header: 'Billing', key: 'mode', width: 10 }, { header: 'Rows', key: 'rows', width: 7 },
    { header: 'Worked days', key: 'days', width: 9 }, { header: 'Work h', key: 'work', width: 9 }, { header: 'OT h', key: 'ot', width: 8 },
    { header: 'Standby h', key: 'sb', width: 9 }, { header: 'Breakdown h', key: 'bd', width: 10 }, { header: 'Top-up h', key: 'tu', width: 9 },
    { header: 'Fuel price diff.', key: 'fd', width: 14 }, { header: 'Gross', key: 'gross', width: 14 }, { header: 'Deductions', key: 'ded', width: 14 }, { header: 'Net', key: 'net', width: 14 },
    { header: 'Invoice no.', key: 'inv', width: 16 }, { header: 'Fuel diff. no.', key: 'finv', width: 16 },
  ]);
  for (const i of items) {
    const r = m.addRow({ vendor: i.vendor_name, code: i.equipment_code, type: i.type_name, site: i.site_code, mode: i.billing_mode, rows: i.days_recorded, days: i.worked_days,
      work: n(i.work_hours), ot: n(i.overtime_hours), sb: n(i.standby_hours), bd: n(i.breakdown_hours), tu: n(i.topup_hours), fd: fuelDiffOf(i), gross: n(i.gross_amount), ded: n(i.deductions_amount), net: n(i.net_amount),
      inv: i.invoice_no || '', finv: i.fuel_invoice_no || '' });
    ['fd', 'gross', 'ded', 'net'].forEach((k) => { r.getCell(k).numFmt = moneyFmt; });
  }
  const totalRow = m.addRow({ vendor: 'TOTAL', work: { formula: `SUM(H2:H${items.length + 1})` }, fd: { formula: `SUM(M2:M${items.length + 1})` }, gross: { formula: `SUM(N2:N${items.length + 1})` }, ded: { formula: `SUM(O2:O${items.length + 1})` }, net: { formula: `SUM(P2:P${items.length + 1})` } });
  totalRow.font = { bold: true };
  ['fd', 'gross', 'ded', 'net'].forEach((k) => { totalRow.getCell(k).numFmt = moneyFmt; });

  const l = wb.addWorksheet('Lines');
  head(l, [{ header: 'Machine', key: 'm', width: 12 }, { header: 'Site', key: 's', width: 8 }, { header: 'Line', key: 't', width: 22 }, { header: 'Description', key: 'd', width: 50 },
    { header: 'Qty', key: 'q', width: 10 }, { header: 'Unit', key: 'u', width: 7 }, { header: 'Unit price', key: 'p', width: 12 }, { header: 'Amount', key: 'a', width: 14 }]);
  for (const i of items) for (const ln of i.lines) {
    const r = l.addRow({ m: i.equipment_code, s: i.site_code, t: ln.line_type, d: lineDesc(ln, i.rate), q: n(ln.quantity), u: ln.unit, p: n(ln.unit_price), a: n(ln.amount) });
    r.getCell('a').numFmt = moneyFmt;
  }

  const rw = wb.addWorksheet('Rows');
  head(rw, [{ header: 'Machine', key: 'm', width: 12 }, { header: 'Site', key: 's', width: 8 }, { header: 'Date', key: 'd', width: 12 }, { header: 'Status', key: 'st', width: 11 },
    { header: 'Operator', key: 'o', width: 20 }, { header: 'In', key: 'i', width: 17 }, { header: 'Out', key: 'x', width: 17 }, { header: 'Work h', key: 'w', width: 8 },
    { header: 'OT h', key: 'ot', width: 7 }, { header: 'Standby h', key: 'sb', width: 9 }, { header: 'Breakdown h', key: 'bd', width: 10 }, { header: 'Break h', key: 'br', width: 8 },
    { header: 'Top-up h', key: 'tu', width: 8 }, { header: 'Meter start', key: 'ms', width: 11 }, { header: 'Meter end', key: 'me', width: 11 }, { header: 'Sheet row', key: 'r', width: 8 }, { header: 'Paper', key: 'p', width: 9 }]);
  const h = (x) => Math.round(n(x) / 60 * 100) / 100;
  for (const i of items) for (const r of i.rows) {
    rw.addRow({ m: i.equipment_code, s: i.site_code, d: r.record_date, st: r.day_status, o: r.operator_name, i: r.check_in_time, x: r.check_out_time, w: h(r.work_minutes), ot: h(r.overtime_minutes),
      sb: h(r.standby_minutes), bd: h(r.breakdown_minutes), br: h(r.break_minutes), tu: h(r.topup_minutes), ms: r.meter_start === null ? null : n(r.meter_start), me: r.meter_end === null ? null : n(r.meter_end), r: r.sheet_row_no, p: r.paper_status });
  }

  const fa = wb.addWorksheet('Fuel & Adjustments');
  head(fa, [{ header: 'Machine', key: 'm', width: 12 }, { header: 'Kind', key: 'k', width: 12 }, { header: 'Details', key: 'd', width: 50 }, { header: 'Qty', key: 'q', width: 10 }, { header: 'Unit price', key: 'p', width: 12 }, { header: 'Amount', key: 'a', width: 14 }]);
  for (const i of items) for (const ln of i.lines.filter((x) => x.line_type === 'Fuel' || x.line_type === 'Adjustment' || x.line_type === 'FuelPriceDifference')) {
    const r = fa.addRow({ m: i.equipment_code, k: ln.line_type, d: ln.note, q: n(ln.quantity), p: n(ln.unit_price), a: n(ln.amount) });
    r.getCell('a').numFmt = moneyFmt;
  }
  const fdDays = items.flatMap((i) => ((i.fuel_diff && i.fuel_diff.days) || []).map((d) => ({ ...d, m: i.equipment_code, s: i.site_code, no: i.fuel_invoice_no })));
  if (fdDays.length) {
    const f = wb.addWorksheet('Fuel difference');
    head(f, [{ header: 'Machine', key: 'm', width: 12 }, { header: 'Site', key: 's', width: 8 }, { header: 'Statement no.', key: 'no', width: 16 }, { header: 'Date', key: 'd', width: 12 },
      { header: 'Work h (incl. OT)', key: 'h', width: 12 }, { header: 'L per hour', key: 'lph', width: 10 }, { header: 'Litres', key: 'l', width: 10 },
      { header: 'Official price', key: 'np', width: 12 }, { header: 'Base price', key: 'bp', width: 12 }, { header: 'Diff / L', key: 'df', width: 10 }, { header: 'Amount', key: 'a', width: 14 }]);
    for (const d of fdDays) {
      const r = f.addRow({ m: d.m, s: d.s, no: d.no || '', d: d.record_date, h: d.hours, lph: d.liters_per_hour, l: d.liters, np: d.national_price, bp: d.base_price, df: d.diff, a: d.amount });
      r.getCell('a').numFmt = moneyFmt;
    }
  }
  if ((detail.invoices || []).length) {
    const inv = wb.addWorksheet('Invoice numbers');
    head(inv, [{ header: 'Number', key: 'no', width: 18 }, { header: 'Kind', key: 'k', width: 12 }, { header: 'Vendor', key: 'v', width: 26 }, { header: 'Machine', key: 'm', width: 12 },
      { header: 'Amount', key: 'a', width: 14 }, { header: 'Currency', key: 'c', width: 9 }, { header: 'Issued', key: 'i', width: 18 }]);
    const vname = Object.fromEntries(items.map((i) => [i.vendor_id, i.vendor_name]));
    const mcode = Object.fromEntries(items.map((i) => [i.equipment_id, i.equipment_code]));
    for (const x of detail.invoices) {
      const r = inv.addRow({ no: x.invoice_no, k: { Vendor: 'Vendor invoice', Machine: 'Machine invoice', FuelDiff: 'Fuel difference' }[x.kind], v: vname[x.vendor_id], m: x.equipment_id ? mcode[x.equipment_id] : '', a: n(x.amount), c: x.currency, i: x.issued_at });
      r.getCell('a').numFmt = moneyFmt;
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// invoice register sheet + fuel difference days are added by batchXlsx below
module.exports = { batchPdf, provisionalPdf, batchXlsx, amountInWords };
