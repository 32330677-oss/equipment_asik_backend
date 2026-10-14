// services/equipment/eqCertificateXlsx.js — the vendor invoice as an Excel workbook in the company's payment
// certificate format (Plant_Payment_Voucher, Oct 2026), with the ASIK logo and its colours (charcoal #3B3B3B, gold #C5A55A).
//   Sheet 1 "Vendor invoice": the vendor invoice (VI) with one line per machine invoice and the total.
//   One sheet per machine: the payment certificate of the machine invoice (MI) — payee, contract and period, the machine,
//   the certified hours and amounts (from the approved attendance), the controls before payment, the supporting
//   documents, the payment instruction left to finance, and the six signatures.
// Yellow cells are for finance (vendor's own invoice no., taxes, bank details...). Nothing is written about payments.
'use strict';

const fs = require('fs');
const ExcelJS = require('exceljs');
const settings = require('../settings');
const { LOGO } = require('../pdfKit');
const { businessNow } = require('../../utils/businessDate');
const { amountInWords, lineDesc } = require('./eqStatements');

const BRAND = { charcoal: 'FF3B3B3B', gold: 'FFC5A55A', goldLight: 'FFF4EFE2', band: 'FFEFE7D3', grid: 'FFD9D3C4', ink: 'FF2B2B2B', muted: 'FF6E6A62',
  white: 'FFFFFFFF', input: 'FFFFF6D5', inputText: 'FF1F4E79', red: 'FFB03A2E', green: 'FF2E7D4F' };
const FONT = 'Calibri';
const n = (v) => Number(v || 0);
const day = (d) => (d ? String(d).slice(0, 10) : '');
const dmy = (d) => (d ? `${day(d).slice(8, 10)}/${day(d).slice(5, 7)}/${day(d).slice(0, 4)}` : '');
const STATE_TEXT = { draft: 'DRAFT - not valid for payment', issued: 'Issued', handed_over: 'Handed over to finance', returned: 'Withdrawn from finance', cancelled: 'CANCELLED', superseded: 'OLD CALCULATION - not valid', replaced: 'CANCELLED (re-issued)' };
const BASIS = { Hourly: 'Hourly', Daily: 'Daily', Monthly: 'Monthly', DNR: 'Per unit (delivery notes)' };
const FUEL_BY = { VendorSupplies: 'Lessor', CompanySuppliesDeducted: 'Company (deducted)', CompanySuppliesFree: 'Company (free)' };

const thin = { style: 'thin', color: { argb: BRAND.grid } };
const allBorders = { top: thin, left: thin, bottom: thin, right: thin };

/** Writes a value with a style into a cell or a merged range ("A1" or "A1:C1"). */
function put(ws, range, value, style = {}) {
  const [first] = range.split(':');
  if (range.includes(':')) ws.mergeCells(range);
  const c = ws.getCell(first);
  c.value = value === undefined ? null : value;
  c.font = { name: FONT, size: style.size || 9.5, bold: Boolean(style.bold), italic: Boolean(style.italic), color: { argb: style.color || BRAND.ink } };
  c.alignment = { vertical: 'middle', horizontal: style.align || 'left', wrapText: style.wrap !== false, ...(style.rtl ? { readingOrder: 'rtl' } : {}) };
  if (style.fill) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: style.fill } };
  if (style.numFmt) c.numFmt = style.numFmt;
  if (style.border !== false) {
    const cells = cellsOf(range);
    for (const a of cells) ws.getCell(a).border = allBorders;
  }
  return c;
}

function cellsOf(range) {
  if (!range.includes(':')) return [range];
  const [a, b] = range.split(':');
  const col = (s) => s.replace(/\d+/g, '').charCodeAt(0) - 64;
  const row = (s) => Number(s.replace(/[A-Z]+/g, ''));
  const out = [];
  for (let r = row(a); r <= row(b); r += 1) for (let c = col(a); c <= col(b); c += 1) out.push(`${String.fromCharCode(64 + c)}${r}`);
  return out;
}

/** An input cell for finance (light yellow, blue text). */
function input(ws, range, value = '[ enter ]', style = {}) {
  return put(ws, range, value, { ...style, fill: BRAND.input, color: BRAND.inputText });
}

/** A section bar: charcoal, English left, Arabic right. */
function section(ws, row, en, ar) {
  put(ws, `A${row}:E${row}`, en, { bold: true, size: 10.5, color: BRAND.white, fill: BRAND.charcoal, border: false });
  put(ws, `F${row}:H${row}`, ar, { bold: true, size: 10.5, color: BRAND.gold, fill: BRAND.charcoal, align: 'right', rtl: true, border: false });
  ws.getRow(row).height = 20;
}

function label(ws, range, text) { return put(ws, range, text, { bold: true, color: BRAND.muted, fill: BRAND.goldLight }); }

function setupSheet(ws, widths) {
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.pageSetup = { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
  ws.views = [{ showGridLines: false }];
}

/** Logo top-left (A1:B3) and the two title lines. */
function letterhead(wb, ws, logoId, company, titleEn, titleAr) {
  ws.mergeCells('A1:B3');
  if (logoId !== null) ws.addImage(logoId, { tl: { col: 0.15, row: 0.15 }, ext: { width: 132, height: 77 } });
  put(ws, 'C1:E1', company, { bold: true, size: 12, color: BRAND.charcoal, border: false, wrap: false });
  put(ws, 'C2:E2', 'Plant & Equipment Department  |  إدارة الآليات والمعدات', { size: 8.5, color: BRAND.muted, border: false, wrap: false });
  put(ws, 'F1:H1', titleEn, { bold: true, size: 14, color: BRAND.charcoal, align: 'right', border: false });
  put(ws, 'F2:H2', titleAr, { bold: true, size: 10.5, color: BRAND.gold, align: 'right', rtl: true, border: false });
  for (const r of [1, 2, 3]) ws.getRow(r).height = 22;
  ws.getRow(4).height = 4;
  for (const c of 'ABCDEFGH') ws.getCell(`${c}4`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.gold } };
}

function moneyFormat(cur) { return cur === 'SYP' ? '#,##0' : '#,##0.00'; }

// ======================================================================= machine certificate
function machineSheet(wb, logoId, ctx, it) {
  const name = `${it.equipment_code}${it.site_code ? ` ${it.site_code}` : ''}`.replace(/[[\]:*?/\\]/g, '-').slice(0, 31);
  let sheetName = name; let k = 2;
  while (wb.getWorksheet(sheetName)) { sheetName = `${name.slice(0, 28)} ${k}`; k += 1; }
  const ws = wb.addWorksheet(sheetName);
  setupSheet(ws, [9, 30, 10, 12, 12, 14, 16, 18]);
  const cur = ctx.currency; const mf = moneyFormat(cur);
  const rate = it.rate_snapshot || {};
  letterhead(wb, ws, logoId, ctx.company, 'PAYMENT CERTIFICATE', 'شهادة استحقاق – معدات مستأجرة');

  // ---- header: number, date, currency, status
  label(ws, 'A5:B5', 'Certificate No. (machine invoice)');
  put(ws, 'C5:D5', it.invoice_no || 'DRAFT', { bold: true, color: BRAND.charcoal });
  label(ws, 'E5', 'Date');
  put(ws, 'F5', dmy(ctx.issued_at), { align: 'center' });
  label(ws, 'G5', 'Currency');
  put(ws, 'H5', cur, { bold: true, align: 'center' });
  label(ws, 'A6:B6', 'Certificate status');
  const statusCell = put(ws, 'C6:H6', null, { bold: true });

  // ---- A. payee, contract, period
  section(ws, 8, 'A.  PAYEE, CONTRACT & PERIOD', 'بيانات المورد والعقد');
  label(ws, 'A9:B9', 'Lessor (payee)');
  put(ws, 'C9:E9', it.vendor_name, { bold: true });
  label(ws, 'F9', 'Vendor code');
  put(ws, 'G9:H9', it.vendor_code || '');
  label(ws, 'A10:B10', 'Contract / LPO No.');
  if (it.contract_number || rate.contract_number) put(ws, 'C10:E10', it.contract_number || rate.contract_number); else input(ws, 'C10:E10');
  label(ws, 'F10', 'Agreement date');
  input(ws, 'G10:H10');
  label(ws, 'A11:B11', 'Project / Site');
  put(ws, 'C11:E11', [it.site_code, it.site_name, it.project_name].filter(Boolean).join(' - '));
  label(ws, 'F11', 'Cost code / GL');
  input(ws, 'G11:H11');
  label(ws, 'A12:B12', 'Billing period from');
  put(ws, 'C12:E12', dmy(ctx.start_date));
  label(ws, 'F12', 'Billing period to');
  put(ws, 'G12:H12', dmy(ctx.end_date));
  label(ws, 'A13:B13', "Vendor's own invoice No.");
  input(ws, 'C13:E13');
  label(ws, 'F13', 'Its date');
  input(ws, 'G13:H13');
  label(ws, 'A14:B14', 'Source document');
  put(ws, 'C14:H14', `Equipment Flow - vendor invoice ${it.vendor_invoice_no || '(draft)'}, machine invoice ${it.invoice_no || '(draft)'} - ${STATE_TEXT[ctx.state] || ctx.state}`, { size: 9 });

  // ---- B. machine
  section(ws, 16, 'B.  EQUIPMENT DETAILS', 'بيانات الآلية');
  ['Asset ID', 'Description', 'Category', 'Hire basis', 'Operator', 'Fuel by', `Contract rate (${cur})`, `Billed rate (${cur})`].forEach((h, i) => {
    put(ws, `${'ABCDEFGH'[i]}17`, h, { bold: true, size: 8.5, color: BRAND.white, fill: BRAND.charcoal, align: 'center' });
  });
  ws.getRow(17).height = 26;
  const unitRate = it.billing_mode === 'Hourly' ? rate.hourly_rate : it.billing_mode === 'Daily' ? rate.daily_rate : it.billing_mode === 'Monthly' ? rate.monthly_rate : null;
  const work = (it.lines || []).find((l) => ['Work', 'MonthlyBase'].includes(l.line_type));
  put(ws, 'A18', it.equipment_code, { bold: true, align: 'center' });
  put(ws, 'B18', [it.machine_label || it.type_name, it.plate_number ? `plate ${it.plate_number}` : null, [it.make, it.model].filter(Boolean).join(' ') || null].filter(Boolean).join(' | '));
  put(ws, 'C18', it.type_name || '', { align: 'center' });
  put(ws, 'D18', `${BASIS[it.billing_mode] || it.billing_mode}${it.billing_mode === 'Monthly' ? ' (per month)' : ''}`, { align: 'center' });
  put(ws, 'E18', rate.operator_included === undefined || rate.operator_included === null ? '' : (n(rate.operator_included) ? 'Included' : 'Charged apart'), { align: 'center' });
  put(ws, 'F18', FUEL_BY[rate.fuel_policy] || '', { align: 'center' });
  put(ws, 'G18', unitRate === null || unitRate === undefined ? null : n(unitRate), { align: 'right', numFmt: mf });
  put(ws, 'H18', work ? n(work.unit_price) : (unitRate === null || unitRate === undefined ? null : n(unitRate)), { align: 'right', numFmt: mf });

  // ---- C. hours and amounts
  section(ws, 20, 'C.  CERTIFICATION OF HOURS & AMOUNT PAYABLE', 'المستحقات المعتمدة');
  put(ws, 'A21', 'Ref', { bold: true, size: 8.5, color: BRAND.white, fill: BRAND.charcoal, align: 'center' });
  put(ws, 'B21:C21', 'Description', { bold: true, size: 8.5, color: BRAND.white, fill: BRAND.charcoal });
  put(ws, 'D21', 'Unit', { bold: true, size: 8.5, color: BRAND.white, fill: BRAND.charcoal, align: 'center' });
  put(ws, 'E21', 'Quantity', { bold: true, size: 8.5, color: BRAND.white, fill: BRAND.charcoal, align: 'center' });
  put(ws, 'F21', `Rate (${cur})`, { bold: true, size: 8.5, color: BRAND.white, fill: BRAND.charcoal, align: 'center' });
  put(ws, 'G21:H21', `Amount certified (${cur})`, { bold: true, size: 8.5, color: BRAND.white, fill: BRAND.charcoal, align: 'center' });
  let r = 22;
  const first = r;
  (it.lines || []).forEach((l, i) => {
    const neg = n(l.amount) < 0;
    put(ws, `A${r}`, `C${i + 1}`, { align: 'center', fill: i % 2 ? BRAND.goldLight : undefined });
    put(ws, `B${r}:C${r}`, lineDesc(l, rate, ctx.hide), { size: 9, fill: i % 2 ? BRAND.goldLight : undefined });
    put(ws, `D${r}`, l.unit || '', { align: 'center', fill: i % 2 ? BRAND.goldLight : undefined });
    put(ws, `E${r}`, n(l.quantity), { align: 'right', numFmt: '#,##0.00', fill: i % 2 ? BRAND.goldLight : undefined });
    put(ws, `F${r}`, n(l.unit_price), { align: 'right', numFmt: '#,##0.000', fill: i % 2 ? BRAND.goldLight : undefined });
    put(ws, `G${r}:H${r}`, n(l.amount), { align: 'right', numFmt: mf, bold: true, color: neg ? BRAND.red : BRAND.ink, fill: i % 2 ? BRAND.goldLight : undefined });
    r += 1;
  });
  if (r === first) { put(ws, `A${r}:H${r}`, 'No line.', { italic: true, color: BRAND.muted }); r += 1; }
  const last = r - 1;
  const sumRow = (text, formula, result, opts = {}) => {
    put(ws, `A${r}:F${r}`, text, { bold: Boolean(opts.bold), align: 'right', fill: opts.fill, color: opts.color });
    put(ws, `G${r}:H${r}`, { formula, result }, { bold: true, align: 'right', numFmt: mf, fill: opts.fill, color: opts.color });
    r += 1;
    return r - 1;
  };
  const gross = (it.lines || []).filter((l) => n(l.amount) > 0).reduce((a, l) => a + n(l.amount), 0);
  const ded = -(it.lines || []).filter((l) => n(l.amount) < 0).reduce((a, l) => a + n(l.amount), 0);
  const gRow = sumRow('Gross earnings and additions  |  إجمالي المستحقات', `SUMIF(G${first}:G${last},">0")`, gross);
  const dRow = sumRow('Less: deductions (fuel issued, absences, breakdowns, penalties...)  |  الحسومات', `-SUMIF(G${first}:G${last},"<0")`, ded, { color: BRAND.red });
  const netRow = sumRow('Net amount before taxes & retention  |  الصافي قبل الضرائب', `G${gRow}-G${dRow}`, gross - ded, { fill: BRAND.band, bold: true });
  const taxRow = (text, sign) => {
    put(ws, `A${r}:E${r}`, text, { align: 'right' });
    input(ws, `F${r}`, 0, { align: 'center', numFmt: '0.00%' });
    put(ws, `G${r}:H${r}`, { formula: `ROUND(G${netRow}*F${r},${cur === 'SYP' ? 0 : 2})`, result: 0 }, { align: 'right', numFmt: mf, color: sign < 0 ? BRAND.red : BRAND.ink });
    r += 1;
    return r - 1;
  };
  const vat = taxRow('Add: VAT / sales tax (if the vendor is registered) - rate', 1);
  const wht = taxRow('Less: withholding tax (if applicable) - rate', -1);
  const ret = taxRow('Less: retention - rate', -1);
  put(ws, `A${r}:F${r}`, `NET AMOUNT PAYABLE (${cur})  |  صافي المبلغ المستحق`, { bold: true, size: 11, color: BRAND.white, fill: BRAND.charcoal, align: 'right' });
  put(ws, `G${r}:H${r}`, { formula: `G${netRow}+G${vat}-G${wht}-G${ret}`, result: gross - ded }, { bold: true, size: 11, color: BRAND.white, fill: BRAND.charcoal, align: 'right', numFmt: mf });
  ws.getRow(r).height = 22;
  r += 1;
  put(ws, `A${r}:B${r}`, 'Amount in words (before taxes):', { bold: true, color: BRAND.muted });
  put(ws, `C${r}:H${r}`, amountInWords(n(it.net_amount), cur), { italic: true });
  r += 1;
  put(ws, `A${r}:H${r}`, 'Basis: only attendance approved in Equipment Flow is certified (rates from the rate card of the machine; fuel issued by the company and other deductions as recorded).', { size: 8, italic: true, color: BRAND.muted, border: false });
  ws.getRow(r).height = 24;
  r += 2;

  // ---- D. controls (on a second printed page with E, F and G)
  ws.getRow(r - 1).addPageBreak();
  section(ws, r, 'D.  PRE-PAYMENT CONTROL CHECKS', 'ضوابط ما قبل الصرف');
  r += 1;
  put(ws, `A${r}`, '#', { bold: true, color: BRAND.white, fill: BRAND.charcoal, align: 'center' });
  put(ws, `B${r}:F${r}`, 'Control', { bold: true, color: BRAND.white, fill: BRAND.charcoal });
  put(ws, `G${r}`, 'Result', { bold: true, color: BRAND.white, fill: BRAND.charcoal, align: 'center' });
  put(ws, `H${r}`, 'Check', { bold: true, color: BRAND.white, fill: BRAND.charcoal, align: 'center' });
  r += 1;
  const dFirst = r;
  const eFirst = r + 8; // first supporting-document row: 6 controls, a blank row, the section E bar
  const eLast = eFirst + 6;
  const control = (text, result, check) => {
    put(ws, `A${r}`, r - dFirst + 1, { align: 'center' });
    put(ws, `B${r}:F${r}`, text);
    put(ws, `G${r}`, result, { align: 'center', size: 8.5 });
    put(ws, `H${r}`, check, { align: 'center', bold: true });
    r += 1;
  };
  const allOk = ['issued', 'handed_over', 'returned'].includes(ctx.state);
  control('All working days of the period approved (Equipment Flow)', allOk ? 'All approved' : 'Draft', allOk ? 'OK' : 'HOLD');
  control('Billed rate agrees to the contract rate (rate card)', 'From the rate card', 'OK');
  control('Contract / LPO reference recorded', { formula: 'IF(LEFT(C10,1)="[","Missing","Recorded")', result: it.contract_number || rate.contract_number ? 'Recorded' : 'Missing' },
    { formula: 'IF(LEFT(C10,1)="[","HOLD","OK")', result: it.contract_number || rate.contract_number ? 'OK' : 'HOLD' });
  control("Vendor's own invoice received and referenced", { formula: 'IF(LEFT(C13,1)="[","Missing","Recorded")', result: 'Missing' }, { formula: 'IF(LEFT(C13,1)="[","HOLD","OK")', result: 'HOLD' });
  control('Supporting documents complete (Section E)', { formula: `COUNTIF(H${eFirst}:H${eLast},"No")&" outstanding"`, result: '' }, { formula: `IF(COUNTIF(H${eFirst}:H${eLast},"No")=0,"OK","HOLD")`, result: 'HOLD' });
  control('Certified amount = machine invoice in the system', it.invoice_no || 'draft', it.invoice_no ? 'OK' : 'HOLD');
  const dLast = r - 1;
  for (let x = dFirst; x <= dLast; x += 1) {
    ws.addConditionalFormatting({ ref: `H${x}`, rules: [
      { type: 'cellIs', operator: 'equal', formulae: ['"OK"'], style: { font: { color: { argb: BRAND.green }, bold: true } } },
      { type: 'cellIs', operator: 'equal', formulae: ['"HOLD"'], style: { font: { color: { argb: BRAND.red }, bold: true } } },
    ] });
  }
  statusCell.value = { formula: `IF(COUNTIF(H${dFirst}:H${dLast},"HOLD")=0,"RELEASED FOR PAYMENT - all controls satisfied","ON HOLD - "&COUNTIF(H${dFirst}:H${dLast},"HOLD")&" control(s) not satisfied (see Section D)")`, result: '' };
  r += 1;

  // ---- E. supporting documents
  section(ws, r, 'E.  SUPPORTING DOCUMENTS ATTACHED', 'المستندات المرفقة');
  r += 1;
  const docs = [
    ['Signed rental agreement / LPO with rates', 'No'],
    ['Daily timesheets approved (Equipment Flow) and signed monthly sheet', allOk ? 'Yes' : 'No'],
    ["Vendor's own invoice (original)", 'No'],
    ['Mobilisation / on-hire note (and off-hire note if demobilised)', 'No'],
    ['Fuel issue log for the machine (or nil confirmation)', 'No'],
    ['Equipment Flow machine invoice (this certificate) and vendor invoice', it.invoice_no ? 'Yes' : 'No'],
    ['Valid vendor registration / bank details on file', 'No'],
  ];
  docs.forEach(([text, val], i) => {
    put(ws, `A${r}`, i + 1, { align: 'center' });
    put(ws, `B${r}:G${r}`, text);
    const c = input(ws, `H${r}`, val, { align: 'center', bold: true });
    c.dataValidation = { type: 'list', allowBlank: false, formulae: ['"Yes,No,N/A"'] };
    r += 1;
  });
  r += 1;

  // ---- F. payment instruction (finance)
  section(ws, r, 'F.  PAYMENT INSTRUCTION (Finance use)', 'تعليمات الدفع');
  r += 1;
  label(ws, `A${r}:B${r}`, 'Payment method');
  const pm = input(ws, `C${r}:E${r}`, 'Bank transfer');
  pm.dataValidation = { type: 'list', allowBlank: true, formulae: ['"Bank transfer,Cheque,Cash"'] };
  label(ws, `F${r}`, 'Bank / account');
  input(ws, `G${r}:H${r}`);
  r += 1;
  label(ws, `A${r}:B${r}`, 'Cheque / transfer ref.');
  input(ws, `C${r}:E${r}`);
  label(ws, `F${r}`, 'Payment date');
  input(ws, `G${r}:H${r}`);
  r += 2;

  // ---- G. signatures
  section(ws, r, 'G.  AUTHORISATION (segregation of duties)', 'الاعتمادات');
  r += 1;
  put(ws, `A${r}`, '#', { bold: true, color: BRAND.white, fill: BRAND.charcoal, align: 'center' });
  put(ws, `B${r}`, 'Role', { bold: true, color: BRAND.white, fill: BRAND.charcoal });
  put(ws, `C${r}:E${r}`, 'Responsibility', { bold: true, color: BRAND.white, fill: BRAND.charcoal });
  put(ws, `F${r}`, 'Name', { bold: true, color: BRAND.white, fill: BRAND.charcoal, align: 'center' });
  put(ws, `G${r}`, 'Signature', { bold: true, color: BRAND.white, fill: BRAND.charcoal, align: 'center' });
  put(ws, `H${r}`, 'Date', { bold: true, color: BRAND.white, fill: BRAND.charcoal, align: 'center' });
  r += 1;
  [
    ['Prepared by - Plant Coordinator / Clerk', 'Compiles the timesheets and this certificate'],
    ['Verified by - Plant & Equipment Manager', 'Hours, rate, machine, breakdowns'],
    ['Certified by - Project Director', `Work done on site ${it.site_code || ''}`.trim()],
    ['Checked by - Cost Control / QS', 'Cost code, budget, contract terms'],
    ['Reviewed by - Accounts Payable', 'Invoice, deductions, taxes, duplicates'],
    ['Approved for payment - Finance Manager', 'Final release per authority matrix'],
  ].forEach(([role, resp], i) => {
    put(ws, `A${r}`, i + 1, { align: 'center' });
    put(ws, `B${r}`, role, { size: 9 });
    put(ws, `C${r}:E${r}`, resp, { size: 9, color: BRAND.muted });
    put(ws, `F${r}`, '');
    put(ws, `G${r}`, '');
    put(ws, `H${r}`, '');
    ws.getRow(r).height = 26;
    r += 1;
  });
  r += 1;
  put(ws, `A${r}:H${r}`, 'Received by (Lessor): I confirm receipt of the net amount stated above in full settlement of this certificate.  |  أقر باستلام صافي المبلغ المذكور أعلاه.', { size: 9, border: false });
  r += 1;
  put(ws, `A${r}:C${r}`, 'Name: ______________________', { border: false });
  put(ws, `D${r}:F${r}`, 'Signature: ________________', { border: false });
  put(ws, `G${r}:H${r}`, 'Date: __________', { border: false });
  r += 2;
  put(ws, `A${r}:H${r}`, `Prepared from Equipment Flow on ${ctx.printedAt} by ${ctx.printedBy}. Yellow cells are filled by finance. Three-way match: contract / LPO - approved timesheets - vendor invoice.`,
    { size: 7.5, italic: true, color: BRAND.muted, border: false });
  ws.headerFooter.oddFooter = `&L&8${ctx.company}&C&8${it.invoice_no || 'DRAFT'}&R&8Page &P / &N`;
  return ws;
}

// ======================================================================= vendor invoice sheet
function vendorSheet(wb, logoId, ctx, items) {
  const ws = wb.addWorksheet('Vendor invoice');
  setupSheet(ws, [6, 18, 28, 10, 12, 10, 16, 18]);
  const cur = ctx.currency; const mf = moneyFormat(cur);
  letterhead(wb, ws, logoId, ctx.company, 'VENDOR INVOICE', 'فاتورة مستحقات الجهة المؤجرة');
  label(ws, 'A5:B5', 'Invoice No.');
  put(ws, 'C5', ctx.vendor_invoice_no || 'DRAFT', { bold: true, color: BRAND.charcoal });
  label(ws, 'D5:E5', 'Date');
  put(ws, 'F5', dmy(ctx.issued_at), { align: 'center' });
  label(ws, 'G5', 'Currency');
  put(ws, 'H5', cur, { bold: true, align: 'center' });
  label(ws, 'A6:B6', 'Lessor (vendor)');
  put(ws, 'C6', `${items[0].vendor_name}${items[0].vendor_code ? ` (${items[0].vendor_code})` : ''}`, { bold: true });
  label(ws, 'D6:E6', items[0].vendor_type === 'Individual' ? 'National ID' : 'Tax number');
  put(ws, 'F6:H6', (items[0].vendor_type === 'Individual' ? items[0].vendor_national_id : items[0].vendor_tax_number) || '');
  label(ws, 'A7:B7', 'Billing period');
  put(ws, 'C7', `${dmy(ctx.start_date)} - ${dmy(ctx.end_date)}`);
  label(ws, 'D7:E7', 'Contract(s)');
  put(ws, 'F7:H7', [...new Set(items.map((i) => i.contract_number || (i.rate_snapshot || {}).contract_number).filter(Boolean))].join(', ') || '');
  label(ws, 'A8:B8', 'Status');
  put(ws, 'C8:H8', STATE_TEXT[ctx.state] || ctx.state, { bold: true, color: ['draft', 'cancelled', 'replaced', 'superseded'].includes(ctx.state) ? BRAND.red : BRAND.ink });

  section(ws, 10, 'MACHINES', 'الآليات');
  const head = ['#', 'Machine invoice', 'Machine', 'Site', 'Basis', 'Shifts', 'Work h', `Net (${cur})`];
  head.forEach((h, i) => put(ws, `${'ABCDEFGH'[i]}11`, h, { bold: true, size: 8.5, color: BRAND.white, fill: BRAND.charcoal, align: 'center' }));
  let r = 12;
  const first = r;
  items.forEach((it, i) => {
    const fill = i % 2 ? BRAND.goldLight : undefined;
    put(ws, `A${r}`, i + 1, { align: 'center', fill });
    put(ws, `B${r}`, it.invoice_no || 'draft', { bold: true, fill });
    put(ws, `C${r}`, `${it.equipment_code} | ${it.machine_label || it.type_name || ''}`, { fill });
    put(ws, `D${r}`, it.site_code || '', { align: 'center', fill });
    put(ws, `E${r}`, BASIS[it.billing_mode] || it.billing_mode, { align: 'center', fill });
    put(ws, `F${r}`, n(it.worked_days), { align: 'center', fill });
    put(ws, `G${r}`, n(it.work_hours), { align: 'right', numFmt: '#,##0.00', fill });
    put(ws, `H${r}`, n(it.net_amount), { align: 'right', numFmt: mf, bold: true, fill, color: n(it.net_amount) < 0 ? BRAND.red : BRAND.ink });
    r += 1;
  });
  const total = items.reduce((a, i) => a + n(i.net_amount), 0);
  put(ws, `A${r}:G${r}`, `TOTAL DUE TO THE LESSOR (${cur})  |  إجمالي مستحقات الجهة المؤجرة`, { bold: true, size: 11, color: BRAND.white, fill: BRAND.charcoal, align: 'right' });
  put(ws, `H${r}`, { formula: `SUM(H${first}:H${r - 1})`, result: total }, { bold: true, size: 11, color: BRAND.white, fill: BRAND.charcoal, align: 'right', numFmt: mf });
  ws.getRow(r).height = 22;
  r += 1;
  put(ws, `A${r}:B${r}`, 'In words:', { bold: true, color: BRAND.muted });
  put(ws, `C${r}:H${r}`, amountInWords(total, cur), { italic: true });
  r += 2;
  put(ws, `A${r}:H${r}`, 'Each machine has its own payment certificate in this workbook (one sheet per machine). Only attendance approved in Equipment Flow is billed.',
    { size: 8, italic: true, color: BRAND.muted, border: false });
  r += 2;
  [['Prepared by (Plant & Equipment)', 'إعداد: إدارة الآليات'], ['Approved by (Project Manager)', 'اعتماد: مدير المشروع'], ['Acknowledged by the lessor', 'إقرار الجهة المؤجرة']].forEach(([en, ar], i) => {
    const cols = [['A', 'C'], ['D', 'F'], ['G', 'H']][i];
    put(ws, `${cols[0]}${r}:${cols[1]}${r}`, '', { border: false });
    ws.getCell(`${cols[0]}${r}`).border = { bottom: { style: 'thin', color: { argb: BRAND.muted } } };
    put(ws, `${cols[0]}${r + 1}:${cols[1]}${r + 1}`, en, { size: 8.5, align: 'center', border: false });
    put(ws, `${cols[0]}${r + 2}:${cols[1]}${r + 2}`, ar, { size: 8.5, align: 'center', color: BRAND.muted, border: false });
  });
  ws.getRow(r).height = 30;
  ws.headerFooter.oddFooter = `&L&8${ctx.company}&C&8${ctx.vendor_invoice_no || 'DRAFT'}&R&8Page &P / &N`;
  return ws;
}

/**
 * The vendor's workbook for one invoice batch (detail = eqPayrollController.batchDetail). equipmentId: only that machine.
 * Returns { buffer, fileName }.
 */
async function vendorWorkbook(conn, detail, { vendorId, equipmentId = null, user }) {
  const items = detail.items.filter((i) => i.vendor_id === vendorId && (!equipmentId || i.equipment_id === equipmentId));
  if (!items.length) throw require('../../utils/AppError').notFound('Machine of this vendor in the invoice');
  const company = await settings.getString('company_name');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Equipment Flow';
  wb.company = company;
  let logoId = null;
  try { logoId = wb.addImage({ buffer: fs.readFileSync(LOGO), extension: 'png' }); } catch (_) { logoId = null; }
  const ctx = {
    company, currency: detail.currency, start_date: detail.start_date, end_date: detail.end_date, state: detail.state,
    issued_at: detail.finalized_at || businessNow(), vendor_invoice_no: items[0].vendor_invoice_no || null,
    printedAt: businessNow().slice(0, 16), printedBy: user ? user.full_name : '', hide: new Set(),
  };
  if (!equipmentId) vendorSheet(wb, logoId, ctx, items);
  for (const it of items) machineSheet(wb, logoId, ctx, it);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const tag = equipmentId ? (items[0].invoice_no || `draft-${detail.eq_batch_id}-${items[0].equipment_code}`) : (ctx.vendor_invoice_no || `draft-${detail.eq_batch_id}`);
  return { buffer, fileName: `${tag}.xlsx`.replace(/[^A-Za-z0-9._-]/g, '_') };
}

module.exports = { vendorWorkbook };
