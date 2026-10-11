// services/equipment/eqLedger.js — running statements (decision of 11 Oct 2026).
//
// 1. Vendor statement of account (كشف حساب تراكمي): every official movement with the vendor, oldest first, with the
//    running balance = what the company still owes the vendor.
//      + vendor invoice (VI) of every FINALIZED batch (date = finalize date), opening balances (money owed before the system),
//        debit notes, a payment reversed (its reversal line)
//      - payments (vouchers), credit notes
//    Not in it: drafts; balances carried from a batch to another ("Add previous balances": an internal move).
//    A debit / credit note is counted when it is issued; the vendor invoice that later pays its settlement adjustment shows
//    its amount WITHOUT that adjustment (said on the line), so nothing is counted twice.
//    One section per currency. Lines before `from` are summed into the balance brought forward.
//    At the end, an ESTIMATE of what is earned but not invoiced yet (approved days not in any batch), clearly marked.
//
// 2. Machine billing history (كشف الآلية): every batch item of the machine (period billed, invoice numbers, days, hours,
//    gross / deductions / net, state of the batch and its payment), the debit / credit notes of the machine, and the days
//    NOT billed yet (approved, waiting for approval, monthly deployed days) so a forgotten period shows at once.
'use strict';

const P = require('../pdfKit');
const settings = require('../settings');
const PS = require('./eqPayrollService');
const S = require('./eqSettlement');
const { businessToday, businessNow, addDays } = require('../../utils/businessDate');

const { COLORS, fmt } = P;
const n = (v) => Number(v || 0);
const cents = (v) => Math.round(n(v) * 100);
const day = (d) => (d ? String(d).slice(0, 10) : null);
const money = (c, cur) => fmt.money(c, cur); // c = cents
const BEGIN = '2000-01-01';
const ACTIVE = "b.status IN ('Generated','Paid')";

const KIND_TEXT = {
  opening: { en: 'Opening balance', ar: 'رصيد افتتاحي' },
  invoice: { en: 'Invoice', ar: 'فاتورة' },
  DebitNote: { en: 'Debit note', ar: 'إشعار مدين' },
  CreditNote: { en: 'Credit note', ar: 'إشعار دائن' },
  payment: { en: 'Payment', ar: 'سند صرف' },
  reversal: { en: 'Payment reversed', ar: 'عكس دفعة' },
  marked: { en: 'Marked paid', ar: 'تسديد' },
};
const METHOD_TEXT = { BankTransfer: 'bank transfer', Cheque: 'cheque', Cash: 'cash', Other: 'other' };
const ORDER = { opening: 0, invoice: 1, DebitNote: 2, CreditNote: 3, payment: 4, marked: 4, reversal: 5 };

/** Consecutive dates -> "dd/mm/yyyy - dd/mm/yyyy (n)" ranges. A gap made only of the weekly off day (offDay, 0-6) does not cut a range. */
function ranges(dates, offDay = null) {
  const ds = [...new Set(dates.map(day))].sort();
  const isOff = (d) => offDay !== null && new Date(`${d}T00:00:00Z`).getUTCDay() === offDay;
  const out = [];
  for (const d of ds) {
    const last = out[out.length - 1];
    const next = last ? addDays(last.to, 1) : null;
    if (last && (next === d || (isOff(next) && addDays(next, 1) === d))) { last.to = d; last.count += 1; } else out.push({ from: d, to: d, count: 1 });
  }
  return out;
}
const rangeText = (r) => (r.from === r.to ? fmt.date(r.from) : `${fmt.date(r.from)} - ${fmt.date(r.to)}`) + (r.count > 1 ? ` (${r.count})` : '');

// ======================================================================= vendor
/** All movements of a vendor (every date), in cents, unsorted. */
async function vendorMovements(conn, vendorId) {
  const out = [];
  // vendor invoices of finalized batches
  const [inv] = await conn.query(
    `SELECT b.eq_batch_id, b.start_date, b.end_date, b.currency, b.finalized_at, b.status, b.version_number, SUM(i.net_amount) AS net, COUNT(*) AS items
     FROM eq_payroll_items i JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id
     WHERE i.vendor_id = ? AND ${ACTIVE} AND b.is_finalized = 1
     GROUP BY b.eq_batch_id, b.start_date, b.end_date, b.currency, b.finalized_at, b.status, b.version_number`, [vendorId]);
  for (const b of inv) {
    const [[no]] = await conn.query(
      `SELECT x.invoice_no FROM eq_invoices x LEFT JOIN eq_invoice_cancellations c ON c.invoice_id = x.invoice_id
       WHERE x.eq_batch_id = ? AND x.vendor_id = ? AND x.kind = 'Vendor' AND x.status = 'Issued' AND c.invoice_id IS NULL ORDER BY x.invoice_id DESC LIMIT 1`, [b.eq_batch_id, vendorId]);
    // settlement adjustments of corrections paid by this invoice: their note was counted when it was issued
    const [corr] = await conn.query(
      `SELECT l.amount, a.reason FROM eq_payroll_lines l JOIN eq_payroll_items i ON i.eq_item_id = l.eq_item_id
       JOIN eq_adjustments a ON l.source_table = 'eq_adjustments' AND a.adjustment_id = l.source_id
       WHERE i.eq_batch_id = ? AND i.vendor_id = ? AND a.correction_id IS NOT NULL`, [b.eq_batch_id, vendorId]);
    const corrCents = corr.reduce((a, l) => a + cents(l.amount), 0);
    const notes = corr.map((l) => (String(l.reason || '').match(/^(DN|CN)-\d{4}-\d{5}/) || [])[0]).filter(Boolean);
    out.push({
      kind: 'invoice', date: day(b.finalized_at) || day(b.end_date), currency: b.currency, doc_no: no ? no.invoice_no : `Batch #${b.eq_batch_id}`,
      description: `${fmt.date(day(b.start_date))} - ${fmt.date(day(b.end_date))}, ${b.items} item(s), batch #${b.eq_batch_id}${Number(b.version_number) > 1 ? ` v${b.version_number}` : ''}`
        + (corrCents ? `; excl. ${notes.join(', ') || 'corrections'} already counted (${money(corrCents, b.currency)})` : ''),
      debit: cents(b.net) - corrCents, credit: 0, eq_batch_id: b.eq_batch_id,
    });
    // batches marked paid before payments were recorded: the whole balance was settled at that time
    if (b.status === 'Paid') {
      const [[p]] = await conn.query('SELECT COUNT(*) AS n FROM eq_payments WHERE eq_batch_id = ?', [b.eq_batch_id]);
      if (!Number(p.n)) {
        const [[bb]] = await conn.query('SELECT * FROM eq_payroll_batches WHERE eq_batch_id = ?', [b.eq_batch_id]);
        const money2 = await S.balances(conn, bb);
        const v = money2._vendors.find((x) => x.vendor_id === vendorId);
        if (v && v._paid) {
          out.push({ kind: 'marked', date: day(bb.paid_at) || day(bb.finalized_at), currency: b.currency, doc_no: no ? no.invoice_no : '',
            description: 'Marked paid (no voucher recorded)', debit: 0, credit: v._paid });
        }
      }
    }
  }
  // debit / credit notes (official corrections)
  const [notes] = await conn.query(
    `SELECT x.invoice_no, x.kind, x.amount, x.currency, x.issued_at, e.equipment_code, e.machine_label FROM eq_invoices x
     LEFT JOIN eq_invoice_cancellations c ON c.invoice_id = x.invoice_id LEFT JOIN eq_equipment e ON e.equipment_id = x.equipment_id
     WHERE x.vendor_id = ? AND x.kind IN ('DebitNote','CreditNote') AND c.invoice_id IS NULL`, [vendorId]);
  for (const x of notes) {
    const c = cents(x.amount);
    out.push({ kind: x.kind, date: day(x.issued_at), currency: x.currency, doc_no: x.invoice_no,
      description: `Correction${x.equipment_code ? `: ${x.machine_label || x.equipment_code}` : ''}`, debit: c > 0 ? c : 0, credit: c < 0 ? -c : 0 });
  }
  // payments (and their reversal)
  const [pays] = await conn.query('SELECT * FROM eq_payments WHERE vendor_id = ?', [vendorId]);
  for (const p of pays) {
    const how = [METHOD_TEXT[p.method] || p.method, p.reference].filter(Boolean).join(' ');
    out.push({ kind: 'payment', date: day(p.paid_on), currency: p.currency, doc_no: p.voucher_no, description: `${how}${p.note ? ` - ${p.note}` : ''}`, debit: 0, credit: cents(p.amount) });
    if (p.status === 'Reversed') {
      out.push({ kind: 'reversal', date: day(p.reversed_at) || day(p.paid_on), currency: p.currency, doc_no: p.voucher_no,
        description: `Reversed${p.reverse_reason ? `: ${p.reverse_reason}` : ''}`, debit: cents(p.amount), credit: 0 });
    }
  }
  // opening balances (money owed before the system)
  const [ob] = await conn.query("SELECT * FROM eq_opening_balances WHERE vendor_id = ? AND status = 'Active'", [vendorId]);
  for (const o of ob) {
    out.push({ kind: 'opening', date: day(o.as_of_date), currency: o.currency, doc_no: o.reference || '',
      description: `${o.description}${o.period_from ? ` (${fmt.date(day(o.period_from))} - ${fmt.date(day(o.period_to))})` : ''}`, debit: cents(o.amount), credit: 0 });
  }
  return out;
}

/**
 * Vendor statement of account over [from, to]. Returns
 * { vendor, from, to, sections: [{ currency, brought_forward, rows, total_debit, total_credit, closing, estimate }], cancelled_numbers }
 * (amounts in cents; rows carry `balance`).
 */
async function vendorStatement(conn, vendorId, { from = BEGIN, to = businessToday(), estimate = true } = {}) {
  const [[vendor]] = await conn.query('SELECT vendor_id, vendor_code, vendor_name, vendor_type, tax_number, national_id FROM eq_vendors WHERE vendor_id = ?', [vendorId]);
  if (!vendor) throw require('../../utils/AppError').notFound('Vendor');
  const all = (await vendorMovements(conn, vendorId)).filter((m) => m.date && m.date <= to);
  const currencies = [...new Set(all.map((m) => m.currency))].sort();
  // the currency of the vendor's contracts, even with no movement yet
  const [cc] = await conn.query('SELECT DISTINCT currency FROM eq_vendor_contracts WHERE vendor_id = ?', [vendorId]);
  for (const c of cc) if (!currencies.includes(c.currency)) currencies.push(c.currency);
  const sections = [];
  for (const cur of currencies) {
    const ms = all.filter((m) => m.currency === cur).sort((a, b) => a.date.localeCompare(b.date) || (ORDER[a.kind] - ORDER[b.kind]));
    const before = ms.filter((m) => m.date < from);
    const brought = before.reduce((a, m) => a + m.debit - m.credit, 0);
    let bal = brought;
    const rows = ms.filter((m) => m.date >= from).map((m) => { bal += m.debit - m.credit; return { ...m, balance: bal }; });
    sections.push({
      currency: cur, brought_forward: brought, rows, total_debit: rows.reduce((a, r) => a + r.debit, 0), total_credit: rows.reduce((a, r) => a + r.credit, 0),
      closing: bal, last_payment: [...rows].reverse().find((r) => r.kind === 'payment') || null, estimate: null,
    });
  }
  // what is earned but not invoiced yet (approved days, fuel, adjustments... not in any batch): an estimate
  if (estimate && sections.length) {
    const end = to; const start = from > addDays(end, -365) ? from : addDays(end, -365);
    try {
      const { items } = await PS.calculate(conn, { start_date: start, end_date: end, vendor_id: vendorId });
      for (const s of sections) {
        const its = items.filter((i) => i.currency === s.currency);
        s.estimate = { amount: its.reduce((a, i) => a + i.net_cents, 0), machines: new Set(its.map((i) => i.equipment_id)).size, from: start, to: end };
      }
    } catch (e) {
      for (const s of sections) s.estimate = { error: e.message, from: start, to: end };
    }
  }
  const [cancelled] = await conn.query(
    `SELECT x.invoice_no FROM eq_invoices x JOIN eq_invoice_cancellations c ON c.invoice_id = x.invoice_id
     WHERE x.vendor_id = ? AND x.kind = 'Vendor' AND DATE(x.issued_at) <= ? ORDER BY x.invoice_no`, [vendorId, to]);
  return { vendor, from, to, sections, cancelled_numbers: cancelled.map((c) => c.invoice_no) };
}

// ======================================================================= machine
async function machineHistory(conn, equipmentId, { from = BEGIN, to = businessToday() } = {}) {
  const [[m]] = await conn.query(
    `SELECT e.equipment_id, e.equipment_code, e.machine_label, e.plate_number, e.vendor_id, t.type_name, vd.vendor_name, vd.vendor_code
     FROM eq_equipment e JOIN eq_types t ON t.type_id = e.type_id JOIN eq_vendors vd ON vd.vendor_id = e.vendor_id WHERE e.equipment_id = ?`, [equipmentId]);
  if (!m) throw require('../../utils/AppError').notFound('Machine');
  const [items] = await conn.query(
    `SELECT i.eq_item_id, i.eq_batch_id, i.vendor_id, i.site_id, s.site_code, i.billing_mode, i.days_recorded, i.worked_days, i.work_hours, i.overtime_hours,
       i.gross_amount, i.deductions_amount, i.net_amount, b.start_date, b.end_date, b.currency, b.status, b.is_finalized, b.version_number, b.finalized_at,
       (SELECT MIN(ps.record_date) FROM eq_payroll_attendance_snapshot ps WHERE ps.eq_item_id = i.eq_item_id) AS r_from,
       (SELECT MAX(ps.record_date) FROM eq_payroll_attendance_snapshot ps WHERE ps.eq_item_id = i.eq_item_id) AS r_to,
       (SELECT MIN(md.day) FROM eq_payroll_monthly_days md WHERE md.eq_item_id = i.eq_item_id) AS m_from,
       (SELECT MAX(md.day) FROM eq_payroll_monthly_days md WHERE md.eq_item_id = i.eq_item_id) AS m_to,
       (SELECT COUNT(*) FROM eq_payroll_monthly_days md WHERE md.eq_item_id = i.eq_item_id) AS m_days,
       (SELECT x.invoice_no FROM eq_invoices x WHERE x.eq_item_id = i.eq_item_id AND x.kind = 'Machine' AND x.status = 'Issued' ORDER BY x.invoice_id DESC LIMIT 1) AS mi_no,
       (SELECT x.invoice_no FROM eq_invoices x WHERE x.eq_batch_id = i.eq_batch_id AND x.vendor_id = i.vendor_id AND x.kind = 'Vendor' AND x.status = 'Issued' ORDER BY x.invoice_id DESC LIMIT 1) AS vi_no
     FROM eq_payroll_items i JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id JOIN sites s ON s.site_id = i.site_id
     WHERE i.equipment_id = ? AND ${ACTIVE} AND b.start_date <= ? AND b.end_date >= ?
     ORDER BY b.start_date, i.eq_item_id`, [equipmentId, to, from]);
  // payment state of each batch for this vendor
  const pay = new Map();
  for (const id of [...new Set(items.filter((i) => Number(i.is_finalized)).map((i) => i.eq_batch_id))]) {
    const [[b]] = await conn.query('SELECT * FROM eq_payroll_batches WHERE eq_batch_id = ?', [id]);
    const bal = await S.balances(conn, b);
    const v = bal.vendors.find((x) => x.vendor_id === m.vendor_id);
    pay.set(id, v ? v.payment_status : null);
  }
  const STATE = { Paid: 'Paid', PartiallyPaid: 'Partly paid', Unpaid: 'Finalized - unpaid', CarriedForward: 'Carried forward', NothingDue: 'Nothing due' };
  const rows = items.map((i) => {
    const firsts = [day(i.r_from), day(i.m_from)].filter(Boolean).sort();
    const lasts = [day(i.r_to), day(i.m_to)].filter(Boolean).sort();
    const fin = Number(i.is_finalized) === 1;
    return {
      eq_batch_id: i.eq_batch_id, version_number: i.version_number, currency: i.currency, site_code: i.site_code, billing_mode: i.billing_mode,
      period_from: firsts[0] || day(i.start_date), period_to: lasts[lasts.length - 1] || day(i.end_date),
      batch_from: day(i.start_date), batch_to: day(i.end_date),
      mi_no: fin ? i.mi_no : null, vi_no: fin ? i.vi_no : null,
      days: i.billing_mode === 'Monthly' && Number(i.m_days) ? Number(i.m_days) : Number(i.worked_days || i.days_recorded || 0),
      work_hours: n(i.work_hours), overtime_hours: n(i.overtime_hours),
      gross: cents(i.gross_amount), deductions: cents(i.deductions_amount), net: cents(i.net_amount),
      state: fin ? (STATE[pay.get(i.eq_batch_id)] || 'Finalized') : 'Draft', finalized: fin,
    };
  });
  const [notes] = await conn.query(
    `SELECT x.invoice_no, x.kind, x.amount, x.currency, x.issued_at, x.eq_batch_id,
       (SELECT MIN(i.eq_batch_id) FROM eq_adjustments a JOIN eq_payroll_lines l ON l.source_table = 'eq_adjustments' AND l.source_id = a.adjustment_id
          JOIN eq_payroll_items i ON i.eq_item_id = l.eq_item_id JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id
        WHERE a.correction_id IS NOT NULL AND a.reason LIKE CONCAT(x.invoice_no, ' %') AND ${ACTIVE}) AS settled_batch_id
     FROM eq_invoices x LEFT JOIN eq_invoice_cancellations c ON c.invoice_id = x.invoice_id
     WHERE x.equipment_id = ? AND x.kind IN ('DebitNote','CreditNote') AND c.invoice_id IS NULL AND DATE(x.issued_at) BETWEEN ? AND ? ORDER BY x.issued_at`, [equipmentId, from, to]);
  // ---- not billed yet (attendance rows outside any active batch; monthly deployed days not billed)
  const until = to < businessToday() ? to : businessToday();
  const [free] = await conn.query(
    `SELECT ea.record_date, ea.status FROM eq_attendance ea
     WHERE ea.equipment_id = ? AND ea.record_date BETWEEN ? AND ? AND ea.status <> 'Cancelled'
       AND NOT EXISTS (SELECT 1 FROM eq_payroll_attendance_snapshot ps JOIN eq_payroll_batches b ON b.eq_batch_id = ps.eq_batch_id
                       WHERE ps.eq_attendance_id = ea.eq_attendance_id AND ${ACTIVE})
     ORDER BY ea.record_date`, [equipmentId, from, until]);
  const approved = ranges(free.filter((r) => r.status === 'Approved').map((r) => r.record_date));
  const pending = ranges(free.filter((r) => r.status !== 'Approved').map((r) => r.record_date));
  let monthly = [];
  const [cards] = await conn.query("SELECT effective_from, effective_to FROM eq_rate_cards WHERE equipment_id = ? AND billing_mode = 'Monthly' AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)",
    [equipmentId, until, from]);
  if (cards.length && from <= until) {
    const offDay = await settings.getInt('eq_weekly_off_day');
    const [deps] = await conn.query(
      'SELECT assigned_date, unassigned_date FROM eq_site_assignments WHERE equipment_id = ? AND assigned_date <= ? AND (unassigned_date IS NULL OR unassigned_date >= ?) AND (unassigned_date IS NULL OR unassigned_date >= assigned_date)',
      [equipmentId, until, from]);
    const [held] = await conn.query(
      `SELECT md.day FROM eq_payroll_monthly_days md JOIN eq_payroll_batches b ON b.eq_batch_id = md.eq_batch_id WHERE md.equipment_id = ? AND md.day BETWEEN ? AND ? AND ${ACTIVE}`,
      [equipmentId, from, until]);
    const heldSet = new Set(held.map((h) => day(h.day)));
    const inRange = (d, a, b) => d >= day(a) && (!b || d <= day(b));
    const days = [];
    const start = from < BEGIN ? BEGIN : from;
    // never walk more than ~3 years of days
    const first = cards.map((c) => day(c.effective_from)).sort()[0];
    for (let d = start > first ? start : first; d <= until; d = addDays(d, 1)) {
      if (new Date(`${d}T00:00:00Z`).getUTCDay() === offDay) continue;
      if (!cards.some((c) => inRange(d, c.effective_from, c.effective_to))) continue;
      if (!deps.some((x) => inRange(d, x.assigned_date, x.unassigned_date))) continue;
      if (!heldSet.has(d)) days.push(d);
    }
    monthly = ranges(days, offDay);
  }
  const currencies = [...new Set(rows.map((r) => r.currency))];
  const totals = currencies.map((cur) => {
    const rs = rows.filter((r) => r.currency === cur);
    const ns = notes.filter((x) => x.currency === cur);
    return {
      currency: cur, finalized: rs.filter((r) => r.finalized).reduce((a, r) => a + r.net, 0), draft: rs.filter((r) => !r.finalized).reduce((a, r) => a + r.net, 0),
      // a note already paid inside a listed batch is in that batch's net: not added again
      notes: ns.filter((x) => !x.settled_batch_id).reduce((a, x) => a + cents(x.amount), 0),
    };
  });
  return {
    machine: m, from, to, rows,
    notes: notes.map((x) => ({ invoice_no: x.invoice_no, kind: x.kind, amount: cents(x.amount), currency: x.currency, date: day(x.issued_at), eq_batch_id: x.eq_batch_id,
      settled_batch_id: x.settled_batch_id || null })),
    not_billed: { approved, pending, monthly_days: monthly, until }, totals,
  };
}

// ======================================================================= PDFs
function head(doc, title, titleAr, company, rightLines) {
  return P.header(doc, {
    title, titleAr, subtitle: company,
    right: (xr, top) => rightLines.forEach((t, k) => P.text(doc, t, xr - 200, top + k * 11, { size: k ? 7 : 8, bold: !k, color: k ? COLORS.ink : COLORS.navy, width: 200, align: 'right', lineBreak: false })),
  });
}

function sectionTitle(doc, y, en, ar) {
  const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right;
  if (y + 44 > doc.page.height - doc.page.margins.bottom - 18) { doc.addPage(); y = doc.page.margins.top + 4; }
  doc.rect(L, y + 2, 3, 12).fill(COLORS.gold);
  P.text(doc, en, L + 8, y + 3, { size: 9.5, bold: true, color: COLORS.navy, width: W / 2, lineBreak: false });
  if (ar) P.text(doc, ar, L + W / 2, y + 1, { size: 9, color: COLORS.navy, width: W / 2, align: 'right', lineBreak: false });
  return y + 18;
}

function boxRow(doc, y, en, ar, val, opts = {}) {
  const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right;
  const bw = 300; const x = L + W - bw; const h = opts.fill ? 22 : 18;
  if (opts.fill) doc.rect(x, y, bw, h).fill(opts.fill); else doc.rect(x, y, bw, h).lineWidth(0.4).strokeColor(COLORS.grid).stroke();
  P.text(doc, en, x + 6, y, { size: opts.size || 8, bold: opts.bold, color: opts.color, width: bw * 0.36, height: h, valign: 'middle', lineBreak: false });
  P.text(doc, ar, x + bw * 0.38, y, { size: (opts.size || 8) - 0.5, color: opts.arColor || opts.color || COLORS.muted, width: bw * 0.28, height: h, valign: 'middle', align: 'right', lineBreak: false });
  P.text(doc, val, x + bw * 0.67, y, { size: opts.size || 8, bold: opts.bold, color: opts.valColor || opts.color, width: bw * 0.33 - 6, height: h, valign: 'middle', align: 'right', lineBreak: false });
  return y + h;
}

async function vendorStatementPdf(conn, st, user) {
  const company = await settings.getString('company_name');
  const printedAt = businessNow().slice(0, 16);
  const v = st.vendor;
  const doc = P.createDoc({ info: { Title: `Statement of account ${v.vendor_name}` } });
  const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right;
  const periodText = `${st.from <= BEGIN ? 'Since the start' : fmt.date(st.from)} - ${fmt.date(st.to)}`;
  let y = head(doc, 'STATEMENT OF ACCOUNT', 'كشف حساب', company, [v.vendor_name, v.vendor_code ? `Code ${v.vendor_code}` : '', periodText].filter(Boolean));
  y = P.infoGrid(doc, [
    { label: 'Lessor (vendor)', labelAr: 'الجهة المؤجرة', value: `${v.vendor_name}${v.vendor_code ? ` (${v.vendor_code})` : ''}` },
    { label: v.vendor_type === 'Individual' ? 'National ID' : 'Tax number', labelAr: v.vendor_type === 'Individual' ? 'الرقم الوطني' : 'الرقم الضريبي', value: (v.vendor_type === 'Individual' ? v.national_id : v.tax_number) || '-' },
    { label: 'Period', labelAr: 'الفترة', value: periodText },
    { label: 'Printed', labelAr: 'تاريخ الطباعة', value: printedAt },
  ], y, 4);
  if (!st.sections.length) {
    P.text(doc, 'No movement for this vendor yet. / لا توجد حركات لهذا المورد بعد.', L, y + 10, { size: 9, color: COLORS.muted, width: W });
  }
  st.sections.forEach((s, k) => {
    const cur = s.currency;
    if (k) { doc.addPage(); y = doc.page.margins.top + 4; }
    // summary
    y = sectionTitle(doc, y + 4, `Summary (${cur})`, 'ملخص الحساب');
    const cells = [
      { label: 'Brought forward', labelAr: 'رصيد مدوّر', value: money(s.brought_forward, cur) },
      { label: 'Invoiced and added', labelAr: 'فواتير وإضافات', value: money(s.total_debit, cur) },
      { label: 'Paid and deducted', labelAr: 'مدفوع وحسومات', value: money(s.total_credit, cur) },
      { label: 'Balance owed', labelAr: 'الرصيد المستحق', value: money(s.closing, cur) },
    ];
    y = P.infoGrid(doc, cells, y, 4);
    if (s.last_payment) P.text(doc, `Last payment: ${fmt.date(s.last_payment.date)} ${s.last_payment.doc_no} ${money(s.last_payment.credit, cur)}`, L, y - 2, { size: 7, color: COLORS.muted, width: W, lineBreak: false });
    y += 8;
    y = sectionTitle(doc, y, `Movements (${cur})`, 'الحركات');
    const rows = [];
    if (st.from > BEGIN) rows.push({ d: fmt.date(st.from), k: 'Brought forward', no: '', what: 'Balance before the period', bal: money(s.brought_forward, cur), _bold: true, _fill: COLORS.soft });
    for (const r of s.rows) {
      rows.push({
        d: fmt.date(r.date), k: (KIND_TEXT[r.kind] || {}).en || r.kind, no: r.doc_no || '', what: r.description,
        dr: r.debit ? money(r.debit, cur) : '', cr: r.credit ? money(r.credit, cur) : '', bal: money(r.balance, cur),
        _color: r.kind === 'reversal' ? COLORS.amber : undefined,
      });
    }
    rows.push({ k: 'Totals', what: '', dr: money(s.total_debit, cur), cr: money(s.total_credit, cur), bal: money(s.closing, cur), _bold: true, _fill: COLORS.band });
    y = P.table(doc, {
      y, rows, rowHeight: 20, headHeight: 24, fontSize: 7, onNewPage: () => doc.page.margins.top + 4,
      columns: [
        { key: 'd', en: 'Date', ar: 'التاريخ', width: 50 }, { key: 'k', en: 'Document', ar: 'المستند', width: 58 },
        { key: 'no', en: 'Number', ar: 'الرقم', width: 76 }, { key: 'what', en: 'Description', ar: 'البيان', width: 191, align: 'left', wrap: true, size: 6.6 },
        { key: 'dr', en: 'Due to vendor', ar: 'له', width: 57, align: 'right' }, { key: 'cr', en: 'Paid / less', ar: 'دفعنا', width: 57, align: 'right' },
        { key: 'bal', en: 'Balance', ar: 'الرصيد', width: 58, align: 'right', bold: true },
      ],
    }) + 10;
    if (y + 80 > doc.page.height - doc.page.margins.bottom - 18) { doc.addPage(); y = doc.page.margins.top + 4; }
    y = boxRow(doc, y, `BALANCE OWED (${cur})`, 'الرصيد المستحق للمورد', money(s.closing, cur),
      { fill: s.closing > 0 ? COLORS.navy : COLORS.green, color: COLORS.white, arColor: '#E9DDBE', bold: true, size: 9.5 });
    if (s.closing < 0) P.text(doc, 'Negative: the vendor was paid more than invoiced (advance).', L, y + 2, { size: 7, color: COLORS.amber, width: W, align: 'right' });
    y += 8;
    if (s.estimate) {
      const e = s.estimate;
      const label = e.error
        ? `Not invoiced yet: could not be estimated (${e.error})`
        : `Earned, not invoiced yet (estimate, approved days ${fmt.date(e.from)} - ${fmt.date(e.to)}, ${e.machines} machine(s)): ${money(e.amount, cur)}`;
      P.text(doc, label, L, y, { size: 7.5, color: COLORS.muted, width: W, align: 'right' });
      P.text(doc, 'تقدير لمستحقات لم تُفوتر بعد، وليست جزءاً من الرصيد', L, doc.y + 1, { size: 7, color: COLORS.muted, width: W, align: 'right' });
      y = doc.y + 6;
    }
  });
  if (st.cancelled_numbers.length) {
    P.text(doc, `Cancelled invoice numbers (kept, never reused; not counted): ${st.cancelled_numbers.join(', ')}`, L, y + 4, { size: 7, color: COLORS.muted, width: W });
    y = doc.y + 4;
  }
  P.text(doc, 'Balance = invoices of finalized batches + opening balances + debit notes - payments - credit notes. Drafts are not included. '
    + 'A balance moved from one batch to another ("previous balances") is an internal move and is not shown.', L, y + 6, { size: 6.8, color: COLORS.muted, width: W });
  const yy = doc.y + 14;
  const lw = W / 3;
  [['Prepared by (Finance)', 'إعداد: الإدارة المالية'], ['Approved by', 'اعتماد'], ['Acknowledged by the lessor', 'إقرار الجهة المؤجرة']].forEach(([en, ar], i) => {
    let sy = yy;
    if (sy + 50 > doc.page.height - doc.page.margins.bottom - 14) { if (!i) doc.addPage(); sy = doc.page.margins.top + 10; }
    const x = L + i * lw;
    doc.moveTo(x + 10, sy + 30).lineTo(x + lw - 10, sy + 30).lineWidth(0.6).strokeColor('#888').stroke();
    P.text(doc, en, x, sy + 33, { size: 7.5, width: lw, align: 'center', lineBreak: false });
    P.text(doc, ar, x, sy + 43, { size: 7, color: COLORS.muted, width: lw, align: 'center', lineBreak: false });
  });
  P.footers(doc, `${company} | Statement of account ${v.vendor_code || v.vendor_name} | printed ${printedAt} by ${user.full_name}`);
  const tag = `${v.vendor_code || `vendor-${v.vendor_id}`}-${st.to}`;
  return { buffer: await P.toBuffer(doc), fileName: `statement-of-account-${tag}.pdf`.replace(/[^A-Za-z0-9._-]/g, '_') };
}

async function machineHistoryPdf(conn, h, user) {
  const company = await settings.getString('company_name');
  const printedAt = businessNow().slice(0, 16);
  const m = h.machine;
  const doc = P.createDoc({ layout: 'landscape', info: { Title: `Billing history ${m.equipment_code}` } });
  const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right;
  const name = `${m.machine_label || m.type_name}`;
  const periodText = `${h.from <= BEGIN ? 'Since the start' : fmt.date(h.from)} - ${fmt.date(h.to)}`;
  let y = head(doc, 'MACHINE BILLING HISTORY', 'كشف فوترة الآلية', company, [name, m.equipment_code, periodText]);
  y = P.infoGrid(doc, [
    { label: 'Machine', labelAr: 'الآلية', value: `${name} (${m.equipment_code})` },
    { label: 'Plate', labelAr: 'رقم اللوحة', value: m.plate_number || '-' },
    { label: 'Lessor (vendor)', labelAr: 'الجهة المؤجرة', value: m.vendor_name },
    { label: 'Period', labelAr: 'الفترة', value: periodText },
  ], y, 4);
  y = sectionTitle(doc, y + 4, 'Billed', 'ما تمت فوترته');
  const rows = h.rows.map((r) => ({
    p: `${fmt.date(r.period_from)} - ${fmt.date(r.period_to)}`, b: `#${r.eq_batch_id}${r.version_number > 1 ? ` v${r.version_number}` : ''}`,
    vi: r.vi_no || '-', mi: r.mi_no || '-', site: r.site_code, mode: r.billing_mode,
    days: String(r.days), h: fmt.num(r.work_hours), ot: r.overtime_hours ? fmt.num(r.overtime_hours) : '',
    g: money(r.gross, r.currency), dd: r.deductions ? money(r.deductions, r.currency) : '', net: money(r.net, r.currency), st: r.state,
    _color: r.finalized ? undefined : COLORS.muted,
  }));
  for (const x of h.notes) {
    rows.push({ p: fmt.date(x.date), b: `#${x.eq_batch_id}`, vi: x.kind === 'DebitNote' ? 'Debit note' : 'Credit note', mi: x.invoice_no, net: money(x.amount, x.currency),
      st: x.settled_batch_id ? `In batch #${x.settled_batch_id}` : 'Correction - not paid yet', _color: COLORS.info });
  }
  for (const t of h.totals) {
    rows.push({ p: `Total finalized (${t.currency})`, net: money(t.finalized + t.notes, t.currency), _bold: true, _fill: COLORS.band });
    if (t.draft) rows.push({ p: `In drafts (${t.currency}, not final)`, net: money(t.draft, t.currency), _color: COLORS.muted, _fill: COLORS.soft });
  }
  if (!rows.length) rows.push({ p: 'Nothing billed in this period', _color: COLORS.muted });
  y = P.table(doc, {
    y, rows, rowHeight: 17, headHeight: 24, fontSize: 7.2, onNewPage: () => doc.page.margins.top + 4,
    columns: [
      { key: 'p', en: 'Period billed', ar: 'الفترة', width: 118, align: 'left' }, { key: 'b', en: 'Batch', ar: 'الدفعة', width: 46 },
      { key: 'vi', en: 'Vendor invoice', ar: 'فاتورة المورد', width: 72 }, { key: 'mi', en: 'Machine invoice', ar: 'فاتورة الآلية', width: 78 },
      { key: 'site', en: 'Site', ar: 'الموقع', width: 40 }, { key: 'mode', en: 'Billing', ar: 'الأساس', width: 46 },
      { key: 'days', en: 'Days', ar: 'الأيام', width: 32 }, { key: 'h', en: 'Work h', ar: 'العمل', width: 42 }, { key: 'ot', en: 'OT h', ar: 'إضافي', width: 36 },
      { key: 'g', en: 'Gross', ar: 'الإجمالي', width: 64, align: 'right' }, { key: 'dd', en: 'Deductions', ar: 'الحسومات', width: 58, align: 'right' },
      { key: 'net', en: 'Net', ar: 'الصافي', width: 66, align: 'right', bold: true }, { key: 'st', en: 'State', ar: 'الحالة', width: W - 698, align: 'left' },
    ],
  }) + 12;
  y = sectionTitle(doc, y, `Not billed yet (until ${fmt.date(h.not_billed.until)})`, 'لم تتم فوترته بعد');
  const nb = h.not_billed;
  const line = (label, list, color) => {
    const t = list.length ? list.map(rangeText).join(', ') : 'none';
    P.text(doc, `${label}: ${t}`, L + 8, y, { size: 7.8, color: list.length ? color : COLORS.muted, width: W - 8 });
    y = doc.y + 4;
  };
  line('Approved days, ready for the next invoice', nb.approved, COLORS.ink);
  line('Days waiting for approval (Draft / Submitted / Rejected)', nb.pending, COLORS.amber);
  if (nb.monthly_days.length || h.rows.some((r) => r.billing_mode === 'Monthly')) line('Monthly machine: deployed working days not billed', nb.monthly_days, COLORS.red);
  P.text(doc, 'The vendor is paid per vendor invoice (see the statement of account); a machine invoice is part of it.', L, y + 6, { size: 6.8, color: COLORS.muted, width: W });
  P.footers(doc, `${company} | Billing history ${m.equipment_code} | printed ${printedAt} by ${user.full_name}`);
  return { buffer: await P.toBuffer(doc), fileName: `billing-history-${m.equipment_code}-${h.to}.pdf`.replace(/[^A-Za-z0-9._-]/g, '_') };
}

module.exports = { vendorStatement, vendorStatementPdf, machineHistory, machineHistoryPdf, ranges };
