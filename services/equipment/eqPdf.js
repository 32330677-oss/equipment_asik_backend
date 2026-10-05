// services/equipment/eqPdf.js — PDF documents of the equipment module (document 05).
const QRCode = require('qrcode');
const P = require('../pdfKit');

const { COLORS, fmt } = P;

const STATUS_AR = { Working: 'عمل', Standby: 'انتظار', Breakdown: 'عطل', Absent: 'غياب', Holiday: 'عطلة رسمية' };

// ======================================================================= D1 Monthly timesheet
/**
 * data: { company, sheet, machine, vendor, contractNumber, site, shifts, rows, blankRows, printedBy, printedAt, printCount }
 * rows: [{ sheet_row_no, record_date, day_status, operator_name, check_in_time, check_out_time, break_minutes,
 *          breakdown_minutes, standby_minutes, working_minutes, meter_start, meter_end, fuel_liters, work_description, remarks, cancelled }]
 */
async function renderTimesheet(data) {
  const doc = P.createDoc({ layout: 'landscape', info: { Title: `Monthly Equipment Timesheet ${data.sheet.sheet_code}` } });
  const qr = await QRCode.toBuffer(`TFEQ|${data.sheet.sheet_code}|${data.sheet.verify_token}`, { margin: 1, width: 180, errorCorrectionLevel: 'M' });
  const L = doc.page.margins.left;

  const pageHeader = () => {
    let y = P.header(doc, {
      title: 'MONTHLY EQUIPMENT TIMESHEET', titleAr: 'سجل الدوام الشهري للآلية',
      subtitle: data.company,
      right: (xr, top) => {
        doc.image(qr, xr - 56, top - 6, { width: 54 });
        P.text(doc, data.sheet.sheet_code, xr - 150, top + 49, { size: 6.5, bold: true, width: 150, align: 'right', lineBreak: false });
      },
    });
    y = P.infoGrid(doc, [
      { label: 'Month', labelAr: 'الشهر', value: monthName(data.sheet.period_month) },
      { label: 'Site / shift', labelAr: 'الموقع والوردية', value: `${data.site.site_code} - ${data.site.site_name} | ${data.shifts}` },
      { label: 'Machine code', labelAr: 'رمز الآلية', value: data.machine.equipment_code },
      { label: 'Type', labelAr: 'النوع', value: [data.machine.type_name, data.machine.make, data.machine.model].filter(Boolean).join(' | ') },
      { label: 'Plate / serial', labelAr: 'رقم اللوحة والهيكل', value: [data.machine.plate_number, data.machine.serial_number].filter(Boolean).join(' | ') || '-' },
      { label: 'Vendor', labelAr: 'الجهة المؤجرة', value: data.vendor.vendor_name },
      { label: 'Vendor contract', labelAr: 'رقم العقد', value: data.contractNumber || '-' },
      { label: 'Meter unit', labelAr: 'وحدة العداد', value: data.machine.meter_unit },
    ], y, 4);
    return y;
  };

  const columns = [
    { key: 'no', en: 'Row', ar: 'رقم السطر', width: 24, bold: true },
    { key: 'date', en: 'Date', ar: 'التاريخ', width: 50 },
    { key: 'status', en: 'Status', ar: 'الحالة', width: 52 },
    { key: 'operator', en: 'Operator', ar: 'المشغل', width: 78, align: 'left' },
    { key: 'in', en: 'In', ar: 'وقت البدء', width: 32 },
    { key: 'out', en: 'Out', ar: 'وقت الانتهاء', width: 38 },
    { key: 'brk', en: 'Breaks min', ar: 'استراحة', width: 36 },
    { key: 'bd', en: 'Breakdown min', ar: 'أعطال', width: 42 },
    { key: 'sb', en: 'Standby min', ar: 'انتظار', width: 38 },
    { key: 'work', en: 'Work h', ar: 'ساعات العمل', width: 38, bold: true },
    { key: 'ms', en: 'Meter start', ar: 'قراءة البداية', width: 44 },
    { key: 'me', en: 'Meter end', ar: 'قراءة النهاية', width: 44 },
    { key: 'fuel', en: 'Fuel L', ar: 'محروقات (ليتر)', width: 30 },
    { key: 'desc', en: 'Work done / remarks', ar: 'الأعمال المنفذة والملاحظات', width: 105, align: 'left', size: 6.5, wrap: true },
    { key: 'sig1', en: 'Employee signature', ar: 'توقيع مندوب الشركة', width: 70 },
    { key: 'sig2', en: 'Operator signature', ar: 'توقيع المشغل', width: 70 },
  ];
  const W = doc.page.width - L - doc.page.margins.right;
  const scale = W / columns.reduce((s, c) => s + c.width, 0);
  for (const c of columns) c.width *= scale;

  const tableRows = [];
  for (const r of data.rows) {
    if (r.cancelled) {
      tableRows.push({ no: r.sheet_row_no, date: '', status: '', operator: '- cancelled -', _color: COLORS.light });
      continue;
    }
    const nextDay = r.check_out_time && String(r.check_out_time).slice(0, 10) !== String(r.record_date).slice(0, 10);
    tableRows.push({
      no: r.sheet_row_no, date: fmt.dayDate(r.record_date), status: r.day_status,
      operator: r.operator_name || '-', in: fmt.time(r.check_in_time), out: fmt.time(r.check_out_time) + (nextDay ? ' +1' : ''),
      brk: fmt.minutes(r.break_minutes), bd: fmt.minutes(r.breakdown_minutes), sb: fmt.minutes(r.standby_minutes),
      work: r.day_status === 'Working' && r.working_minutes !== null ? fmt.hours(r.working_minutes) : (r.day_status === 'Working' ? '' : '0.00'),
      ms: r.meter_start ?? '', me: r.meter_end ?? '', fuel: r.fuel_liters ? fmt.num(r.fuel_liters, 0) : '',
      desc: [r.work_description, r.remarks].filter(Boolean).join(' | '),
    });
  }
  const last = data.rows.length ? Math.max(...data.rows.map((r) => r.sheet_row_no)) : 0;
  for (let i = 1; i <= data.blankRows; i += 1) tableRows.push({ no: last + i, _color: COLORS.light });

  let y = pageHeader();
  y = P.table(doc, { columns, rows: tableRows, y, rowHeight: 21, headHeight: 30, onNewPage: () => pageHeader() });

  // totals + month-end sign-off (keep together)
  const blockH = 78;
  if (y + blockH > doc.page.height - doc.page.margins.bottom - 14) { doc.addPage(); y = pageHeader(); }
  y += 6;
  const valid = data.rows.filter((r) => !r.cancelled);
  const count = (s) => valid.filter((r) => r.day_status === s).length;
  const sum = (k) => valid.reduce((a, r) => a + Number(r[k] || 0), 0);
  const boxes = [
    { w: 0.3, title: 'Totals of printed rows', ar: 'الإجمالي', body: [
      `Working ${count('Working')} | Standby ${count('Standby')} | Breakdown ${count('Breakdown')} | Absent ${count('Absent')} | Holiday ${count('Holiday')} days`,
      `Work ${fmt.hours(sum('working_minutes'))} h | Timed breakdown ${fmt.hours(sum('breakdown_minutes'))} h | Timed standby ${fmt.hours(sum('standby_minutes'))} h | Fuel ${fmt.num(sum('fuel_liters'), 0)} L`] },
    { w: 0.27, title: 'Site engineer', ar: 'المهندس المقيم', body: [`Name: ${data.sheet.site_engineer_name || '______________________'}   Date: __________`] },
    { w: 0.29, title: 'Vendor representative', ar: 'ممثل الجهة المؤجرة', body: [`Name: ${data.sheet.vendor_rep_name || '______________________'}   Date: __________`] },
    { w: 0.14, title: 'Stamp', ar: 'الختم', body: [] },
  ];
  let x = L;
  for (const b of boxes) {
    const bw = W * b.w - 6;
    doc.roundedRect(x, y, bw, blockH - 14, 4).lineWidth(0.6).strokeColor(COLORS.grid).stroke();
    P.text(doc, b.title, x + 6, y + 5, { size: 8, bold: true, color: COLORS.navy, width: bw / 2, lineBreak: false });
    P.text(doc, b.ar, x + bw / 2, y + 3, { size: 8, color: COLORS.navy, width: bw / 2 - 6, align: 'right', lineBreak: false });
    b.body.forEach((line, i) => P.text(doc, line, x + 6, y + 19 + i * 11, { size: 7, width: bw - 12 }));
    if (b.title !== 'Totals of printed rows' && b.title !== 'Stamp') {
      doc.moveTo(x + 6, y + blockH - 22).lineTo(x + bw - 6, y + blockH - 22).dash(2, { space: 2 }).strokeColor(COLORS.light).stroke().undash();
    }
    x += W * b.w;
  }
  y += blockH - 8;
  P.text(doc, 'Standby = machine ready, idle by our decision  |  Breakdown = machine out of order (vendor)  |  Blank rows are for manual entries if the app is unavailable  |  Both signatures are required on every row.', L, y, { size: 6.3, color: COLORS.muted, width: W, lineBreak: false });
  P.footers(doc, `Printed ${data.printedAt} by ${data.printedBy} | print #${data.printCount} | rows 1-${last} | ${data.sheet.sheet_code} | Equipment Flow`);
  return P.toBuffer(doc);
}

function monthName(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${y}`;
}

// ======================================================================= scans: images -> one PDF
async function imagesToPdf(buffers) {
  const doc = P.createDoc({ autoFirstPage: false, margin: 18 });
  for (const buf of buffers) {
    const img = doc.openImage(buf);
    doc.addPage({ size: 'A4', margin: 18, layout: img.width > img.height ? 'landscape' : 'portrait' });
    const W = doc.page.width - 36; const H = doc.page.height - 36;
    doc.image(img, 18, 18, { fit: [W, H], align: 'center', valign: 'center' });
  }
  return P.toBuffer(doc);
}

module.exports = { renderTimesheet, imagesToPdf, monthName, STATUS_AR };
