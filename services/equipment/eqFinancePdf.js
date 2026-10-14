// services/equipment/eqFinancePdf.js — the official papers of the hand-over to finance (14 Oct 2026):
//   * hand-over sheet (كشف تسليم للمالية, HO-YYYY-00001): the invoices / notes handed over, signed by the receiver;
//   * withdrawal acknowledgement (إقرار سحب من المالية, WD-YYYY-00001): signed by finance when a document comes back;
//   * debit / credit note (إشعار مدين / دائن, DN- / CN-): a stand-alone amount for a machine or the vendor in general.
// Same look as the invoices: the company logo, its charcoal + gold colours.
'use strict';

const P = require('../pdfKit');
const settings = require('../settings');
const { businessNow } = require('../../utils/businessDate');
const { amountInWords } = require('./eqStatements');

const { COLORS, fmt } = P;
const n = (v) => Number(v || 0);
const cents = (v) => Math.round(n(v) * 100);
const money = (v, cur) => fmt.money(cents(v), cur);
const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');

function numberBlock(doc, no, sub) {
  return (xr, top) => {
    const w = 190;
    P.text(doc, 'No.', xr - w, top, { size: 7, color: COLORS.muted, width: w - 80, align: 'right', lineBreak: false });
    P.text(doc, 'رقم المستند', xr - w, top + 9, { size: 6.5, color: COLORS.muted, width: w - 80, align: 'right', lineBreak: false });
    P.text(doc, no, xr - 78, top, { size: 9, bold: true, color: COLORS.navy, width: 78, align: 'right', lineBreak: false });
    if (sub) P.text(doc, sub, xr - w, top + 24, { size: 7, width: w, align: 'right', lineBreak: false });
  };
}

function sectionTitle(doc, y, en, ar) {
  const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right;
  if (y + 40 > doc.page.height - doc.page.margins.bottom - 14) { doc.addPage(); y = doc.page.margins.top + 4; }
  doc.rect(L, y + 2, 3, 12).fill(COLORS.gold);
  P.text(doc, en, L + 8, y + 3, { size: 9.5, bold: true, color: COLORS.navy, width: W / 2, lineBreak: false });
  if (ar) P.text(doc, ar, L + W / 2, y + 1, { size: 9, color: COLORS.navy, width: W / 2, align: 'right', lineBreak: false });
  return y + 18;
}

function signatures(doc, y, labels) {
  const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right;
  if (y + 60 > doc.page.height - doc.page.margins.bottom - 14) { doc.addPage(); y = doc.page.margins.top + 10; }
  const w = W / labels.length;
  labels.forEach(([en, ar], i) => {
    const x = L + i * w;
    P.text(doc, 'Name / الاسم:', x + 10, y, { size: 7, color: COLORS.muted, width: w - 20, lineBreak: false });
    doc.moveTo(x + 10, y + 34).lineTo(x + w - 10, y + 34).lineWidth(0.6).strokeColor('#888').stroke();
    P.text(doc, en, x, y + 37, { size: 7.5, width: w, align: 'center', lineBreak: false });
    P.text(doc, ar, x, y + 47, { size: 7, color: COLORS.muted, width: w, align: 'center', lineBreak: false });
  });
  return y + 62;
}

function box(doc, y, en, ar, val, opts = {}) {
  const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right;
  const bw = 300; const x = L + W - bw; const h = 22;
  doc.rect(x, y, bw, h).fill(opts.fill || COLORS.navy);
  P.text(doc, en, x + 6, y, { size: 9, bold: true, color: COLORS.white, width: bw * 0.38, height: h, valign: 'middle', lineBreak: false });
  P.text(doc, ar, x + bw * 0.38, y, { size: 8.5, color: '#E9DDBE', width: bw * 0.28, height: h, valign: 'middle', align: 'right', lineBreak: false });
  P.text(doc, val, x + bw * 0.67, y, { size: 9.5, bold: true, color: COLORS.white, width: bw * 0.33 - 6, height: h, valign: 'middle', align: 'right', lineBreak: false });
  return y + h;
}

// ======================================================================= hand-over sheet
/** h: { handover_no, handed_on, receiver_name, note, by_name, created_at, lines: [{ doc_no, kind, vendor_name, period, currency, amount }] } */
async function handoverPdf(h, user) {
  const company = await settings.getString('company_name');
  const printedAt = businessNow().slice(0, 16);
  const doc = P.createDoc({ info: { Title: `Hand-over ${h.handover_no}` } });
  const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right;
  let y = P.header(doc, { title: 'HAND-OVER TO FINANCE', titleAr: 'كشف تسليم فواتير إلى القسم المالي', subtitle: company, right: numberBlock(doc, h.handover_no, `${h.lines.length} document(s)`) });
  y = P.infoGrid(doc, [
    { label: 'Handed over on', labelAr: 'تاريخ التسليم', value: fmt.date(h.handed_on) },
    { label: 'Received by (finance)', labelAr: 'المستلم في المالية', value: h.receiver_name },
    { label: 'Handed over by', labelAr: 'المسلِّم', value: h.by_name || '' },
    { label: 'Documents', labelAr: 'عدد المستندات', value: String(h.lines.length) },
  ], y, 4);
  y = sectionTitle(doc, y + 4, 'Documents handed over', 'المستندات المسلَّمة');
  const KIND = { invoice: 'Vendor invoice', Debit: 'Debit note', Credit: 'Credit note' };
  const rows = h.lines.map((l, i) => ({
    i: String(i + 1), no: l.doc_no, k: KIND[l.kind] || l.kind, v: l.vendor_name, p: l.period || '', c: l.currency,
    a: money(l.amount, l.currency), _color: n(l.amount) < 0 ? COLORS.red : undefined,
  }));
  const totals = {};
  for (const l of h.lines) totals[l.currency] = (totals[l.currency] || 0) + cents(l.amount);
  for (const [cur, c] of Object.entries(totals)) rows.push({ v: `Total (${cur})`, a: fmt.money(c, cur), _bold: true, _fill: COLORS.band });
  y = P.table(doc, {
    y, rows, rowHeight: 18, headHeight: 24, fontSize: 7.5, onNewPage: () => doc.page.margins.top + 4,
    columns: [
      { key: 'i', en: '#', ar: '#', width: 22 }, { key: 'no', en: 'Number', ar: 'الرقم', width: 82 }, { key: 'k', en: 'Document', ar: 'المستند', width: 70 },
      { key: 'v', en: 'Lessor (vendor)', ar: 'الجهة المؤجرة', width: 150, align: 'left', wrap: true }, { key: 'p', en: 'Period', ar: 'الفترة', width: 92 },
      { key: 'c', en: 'Cur.', ar: 'العملة', width: 32 }, { key: 'a', en: 'Amount', ar: 'المبلغ', width: W - 448, align: 'right', bold: true },
    ],
  }) + 8;
  if (h.note) { P.text(doc, `Note: ${h.note}`, L, y, { size: 8, width: W }); y = doc.y + 6; }
  P.text(doc, 'The documents above were handed over to the finance department for payment. From now on they are not changed: a correction needs a signed withdrawal acknowledgement, or a debit / credit note.',
    L, y, { size: 7.2, color: COLORS.muted, width: W });
  P.text(doc, 'تم تسليم المستندات أعلاه إلى القسم المالي. لا يتم تعديلها بعد التسليم إلا بإقرار سحب موقّع، أو بإشعار مدين / دائن.', L, doc.y + 2, { size: 7.5, color: COLORS.muted, width: W, align: 'right' });
  signatures(doc, doc.y + 16, [['Handed over by (Plant & Equipment)', 'المسلِّم: إدارة الآليات'], ['Received by (Finance)', 'المستلم: القسم المالي']]);
  P.footers(doc, `${company} | Hand-over ${h.handover_no} | printed ${printedAt} by ${user.full_name}`);
  return { buffer: await P.toBuffer(doc), fileName: safeName(`${h.handover_no}.pdf`) };
}

// ======================================================================= withdrawal acknowledgement
/** w: { withdrawal_no, withdrawn_on, finance_person, reason, was_paid, paid_amount, by_name, doc_no, doc_kind, vendor_name, period, currency, amount, handover_no } */
async function withdrawalPdf(w, user) {
  const company = await settings.getString('company_name');
  const printedAt = businessNow().slice(0, 16);
  const doc = P.createDoc({ info: { Title: `Withdrawal ${w.withdrawal_no}` } });
  const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right;
  let y = P.header(doc, { title: 'WITHDRAWAL FROM FINANCE', titleAr: 'إقرار سحب مستند من القسم المالي', subtitle: company, right: numberBlock(doc, w.withdrawal_no, w.handover_no ? `Hand-over ${w.handover_no}` : '') });
  y = P.infoGrid(doc, [
    { label: 'Document withdrawn', labelAr: 'المستند المسحوب', value: `${w.doc_kind} ${w.doc_no}` },
    { label: 'Lessor (vendor)', labelAr: 'الجهة المؤجرة', value: w.vendor_name },
    { label: 'Period', labelAr: 'الفترة', value: w.period || '-' },
    { label: 'Amount', labelAr: 'المبلغ', value: `${money(w.amount, w.currency)} ${w.currency}` },
    { label: 'Withdrawn on', labelAr: 'تاريخ السحب', value: fmt.date(w.withdrawn_on) },
    { label: 'Given back by (finance)', labelAr: 'أعاده من المالية', value: w.finance_person },
    { label: 'Paid by finance?', labelAr: 'هل تم الصرف؟', value: w.was_paid ? `YES ${w.paid_amount !== null && w.paid_amount !== undefined ? money(w.paid_amount, w.currency) : ''}`.trim() : 'NO' },
    { label: 'Recorded by', labelAr: 'سجّله', value: w.by_name || '' },
  ], y, 4);
  y = sectionTitle(doc, y + 4, 'Reason', 'سبب السحب');
  P.text(doc, w.reason, L + 8, y, { size: 9, width: W - 8 });
  y = doc.y + 14;
  if (w.was_paid) {
    y = box(doc, y, 'ALREADY PAID', 'تم صرفه سابقاً', w.paid_amount !== null && w.paid_amount !== undefined ? money(w.paid_amount, w.currency) : '-', { fill: COLORS.amber });
    y += 6;
  }
  P.text(doc, 'Finance confirms that the document above is given back to the Plant & Equipment department and is no longer valid for payment. '
    + 'It will be cancelled, or re-issued with a NEW number.', L, y, { size: 7.5, color: COLORS.muted, width: W });
  P.text(doc, 'يقرّ القسم المالي بإعادة المستند أعلاه إلى إدارة الآليات، وأنه لم يعد صالحاً للصرف. سيتم إلغاؤه أو إصداره من جديد برقم جديد.', L, doc.y + 2, { size: 8, color: COLORS.muted, width: W, align: 'right' });
  signatures(doc, doc.y + 18, [['Finance (gives it back)', 'القسم المالي: المُعيد'], ['Plant & Equipment (receives it)', 'إدارة الآليات: المستلم'], ['Approved by', 'الاعتماد']]);
  P.footers(doc, `${company} | Withdrawal ${w.withdrawal_no} | printed ${printedAt} by ${user.full_name}`);
  return { buffer: await P.toBuffer(doc), fileName: safeName(`${w.withdrawal_no}.pdf`) };
}

// ======================================================================= debit / credit note
/** note: eq_notes row + vendor_name, vendor_code, tax_number, equipment_code, machine_label, plate_number, contract_number, issued_by */
async function notePdf(note, user) {
  const company = await settings.getString('company_name');
  const printedAt = businessNow().slice(0, 16);
  const debit = note.kind === 'Debit';
  const doc = P.createDoc({ info: { Title: `${debit ? 'Debit' : 'Credit'} note ${note.note_no || ''}` } });
  const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right;
  let y = P.header(doc, {
    title: debit ? 'DEBIT NOTE' : 'CREDIT NOTE', titleAr: debit ? 'إشعار مدين (إضافة لصالح المؤجر)' : 'إشعار دائن (حسم من المؤجر)', subtitle: company,
    right: note.note_no ? numberBlock(doc, note.note_no, `Currency ${note.currency}`) : (xr, top) => P.text(doc, 'DRAFT - NOT YET NUMBERED', xr - 190, top + 2, { size: 7.5, bold: true, color: COLORS.red, width: 190, align: 'right', lineBreak: false }),
  });
  y = P.infoGrid(doc, [
    { label: 'Lessor (vendor)', labelAr: 'الجهة المؤجرة', value: `${note.vendor_name}${note.vendor_code ? ` (${note.vendor_code})` : ''}` },
    { label: 'Machine', labelAr: 'الآلية', value: note.equipment_code ? `${note.equipment_code} | ${note.machine_label || ''}${note.plate_number ? ` | ${note.plate_number}` : ''}` : 'Vendor in general / عام للمورد' },
    { label: 'Date', labelAr: 'التاريخ', value: fmt.date(note.note_date) },
    { label: 'Period concerned', labelAr: 'الفترة المعنية', value: note.period_from ? `${fmt.date(note.period_from)} - ${fmt.date(note.period_to || note.period_from)}` : '-' },
  ], y, 2);
  y = sectionTitle(doc, y + 4, 'Reason', 'البيان');
  P.text(doc, note.reason, L + 8, y, { size: 9.5, width: W - 8 });
  y = doc.y + 16;
  y = box(doc, y, debit ? `AMOUNT ADDED (${note.currency})` : `AMOUNT DEDUCTED (${note.currency})`, debit ? 'المبلغ المضاف' : 'المبلغ المحسوم',
    money(note.amount, note.currency), { fill: debit ? COLORS.navy : COLORS.red });
  P.text(doc, amountInWords(n(note.amount), note.currency), L, y + 4, { size: 7.5, color: COLORS.muted, width: W, align: 'right', lineBreak: false });
  y += 24;
  P.text(doc, debit
    ? 'This amount is added to what the company owes the lessor. / يضاف هذا المبلغ إلى مستحقات الجهة المؤجرة.'
    : 'This amount is deducted from what the company owes the lessor. / يحسم هذا المبلغ من مستحقات الجهة المؤجرة.', L, y, { size: 7.5, color: COLORS.muted, width: W });
  signatures(doc, doc.y + 18, [['Prepared by', 'إعداد'], ['Approved by', 'اعتماد'], ['Acknowledged by the lessor', 'إقرار الجهة المؤجرة']]);
  P.footers(doc, `${company} | ${debit ? 'Debit' : 'Credit'} note ${note.note_no || 'draft'} | printed ${printedAt} by ${user.full_name}`);
  return { buffer: await P.toBuffer(doc), fileName: safeName(`${note.note_no || `note-draft-${note.note_id}`}.pdf`) };
}

module.exports = { handoverPdf, withdrawalPdf, notePdf };
