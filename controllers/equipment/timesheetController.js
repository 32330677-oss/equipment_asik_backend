// Monthly paper timesheets: list, print (D1 with QR), scans (immutable, versioned), paper checks, close/reopen.
const { pool, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { v, validate, parseId } = require('../../utils/validate');
const audit = require('../../services/audit');
const storage = require('../../services/fileStorage');
const uploads = require('../../services/uploads');
const settings = require('../../services/settings');
const { businessNow, businessToday } = require('../../utils/businessDate');
const { diffMinutes } = require('../../utils/dateTime');
const sheets = require('../../services/equipment/eqTimesheetService');
const eqPdf = require('../../services/equipment/eqPdf');

async function loadSheet(conn, id, lock = false) {
  const [rows] = await conn.execute(`SELECT * FROM eq_timesheets WHERE timesheet_id = ?${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw AppError.notFound('Timesheet');
  return rows[0];
}

/** Supervisors may use the sheets of sites they supervised at some point of that month. */
async function assertSheetAccess(user, sheet, conn = pool) {
  if (user.role === 'Admin' || user.role === 'Accountant') return;
  const from = `${sheet.period_month}-01`; const to = `${sheet.period_month}-31`;
  const [rows] = await conn.execute(
    `SELECT 1 FROM site_supervisors WHERE user_id = ? AND site_id = ? AND from_date <= ? AND (to_date IS NULL OR to_date >= ?) LIMIT 1`,
    [user.user_id, sheet.site_id, to, from]);
  if (!rows.length) throw AppError.forbidden('SITE_FORBIDDEN', 'You do not supervise this site in that month.');
}

const SHEET_LIST_SQL = `
  SELECT ts.*, e.equipment_code, e.machine_label, t.type_name, vd.vendor_name, s.site_code, s.site_name,
    (SELECT COUNT(*) FROM eq_attendance a WHERE a.timesheet_id = ts.timesheet_id AND a.status <> 'Cancelled') AS rows_count,
    (SELECT COUNT(*) FROM eq_attendance a WHERE a.timesheet_id = ts.timesheet_id AND a.status <> 'Cancelled' AND a.paper_status = 'Matched') AS matched,
    (SELECT COUNT(*) FROM eq_attendance a WHERE a.timesheet_id = ts.timesheet_id AND a.status <> 'Cancelled' AND a.paper_status = 'Mismatch') AS mismatch,
    (SELECT COUNT(*) FROM eq_attendance a WHERE a.timesheet_id = ts.timesheet_id AND a.status <> 'Cancelled' AND a.paper_status = 'Pending') AS pending,
    (SELECT COUNT(*) FROM eq_attendance a WHERE a.timesheet_id = ts.timesheet_id AND a.status <> 'Cancelled' AND a.paper_status = 'Missing') AS missing,
    (SELECT MAX(version_no) FROM eq_timesheet_scans sc WHERE sc.timesheet_id = ts.timesheet_id) AS last_scan_version,
    (SELECT MAX(uploaded_at) FROM eq_timesheet_scans sc WHERE sc.timesheet_id = ts.timesheet_id) AS last_scan_at,
    (SELECT MAX(through_row_no) FROM eq_timesheet_scans sc WHERE sc.timesheet_id = ts.timesheet_id) AS scanned_through_row
  FROM eq_timesheets ts JOIN eq_equipment e ON e.equipment_id = ts.equipment_id JOIN eq_types t ON t.type_id = e.type_id
  JOIN eq_vendors vd ON vd.vendor_id = e.vendor_id JOIN sites s ON s.site_id = ts.site_id`;

exports.list = async (req, res) => {
  const where = []; const params = [];
  const f = (c, val) => { where.push(c); params.push(val); };
  if (req.query.month) f('ts.period_month = ?', String(req.query.month));
  if (req.query.site_id) f('ts.site_id = ?', Number(req.query.site_id));
  if (req.query.equipment_id) f('ts.equipment_id = ?', Number(req.query.equipment_id));
  if (req.query.vendor_id) f('e.vendor_id = ?', Number(req.query.vendor_id));
  if (req.query.status) f('ts.status = ?', String(req.query.status));
  if (req.user.role === 'Supervisor') {
    where.push(`EXISTS (SELECT 1 FROM site_supervisors ss WHERE ss.user_id = ? AND ss.site_id = ts.site_id
      AND ss.from_date <= CONCAT(ts.period_month, '-31') AND (ss.to_date IS NULL OR ss.to_date >= CONCAT(ts.period_month, '-01')))`);
    params.push(req.user.user_id);
  }
  let [rows] = await pool.query(`${SHEET_LIST_SQL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ts.period_month DESC, s.site_code, e.equipment_code`, params);
  rows = rows.map(({ verify_token, ...r }) => ({
    ...r, needs_scan: Number(r.scanned_through_row || 0) < Number(r.last_row_no), needs_check: Number(r.pending) + Number(r.mismatch) > 0,
  }));
  if (req.query.needs === 'scan') rows = rows.filter((r) => r.needs_scan);
  if (req.query.needs === 'check') rows = rows.filter((r) => r.needs_check);
  res.json({ status: 'success', data: rows });
};

exports.getOrCreate = async (req, res) => {
  const d = validate(req.body, { equipment_id: v.id({ required: true }), site_id: v.id({ required: true }), period_month: v.month({ required: true }) });
  const sheet = await withTransaction(async (conn) => {
    const s = await sheets.getOrCreate(conn, d.equipment_id, d.site_id, d.period_month);
    await assertSheetAccess(req.user, s, conn);
    return s;
  });
  const { verify_token, ...out } = sheet;
  res.status(201).json({ status: 'success', data: out });
};

async function sheetRows(conn, sheetId) {
  const [rows] = await conn.execute(
    `SELECT a.eq_attendance_id, a.sheet_row_no, a.record_date, a.shift_type, a.day_status, a.status, a.check_in_time, a.check_out_time,
       a.gross_minutes, a.break_minutes, a.breakdown_minutes, a.standby_minutes, a.working_minutes, a.meter_start, a.meter_end,
       a.work_description, a.remarks, a.paper_status, a.cancel_reason, a.operator_id, o.full_name AS operator_name,
       (SELECT SUM(f.liters) FROM eq_fuel_issues f WHERE f.equipment_id = a.equipment_id AND f.site_id = a.site_id AND f.issue_date = a.record_date AND f.is_cancelled = 0) AS fuel_liters
     FROM eq_attendance a LEFT JOIN eq_operators o ON o.operator_id = a.operator_id
     WHERE a.timesheet_id = ? ORDER BY a.sheet_row_no`, [sheetId]);
  return rows;
}

exports.get = async (req, res) => {
  const id = parseId(req.params.id);
  const sheet = await loadSheet(pool, id);
  await assertSheetAccess(req.user, sheet);
  const [[info]] = await pool.query(`${SHEET_LIST_SQL} WHERE ts.timesheet_id = ?`, [id]);
  const rows = await sheetRows(pool, id);
  const [scans] = await pool.execute(
    `SELECT sc.scan_id, sc.version_no, sc.through_row_no, sc.original_name, sc.mime_type, sc.page_count, sc.size_bytes, sc.sha256, sc.note,
       sc.uploaded_at, u.full_name AS uploaded_by FROM eq_timesheet_scans sc JOIN users u ON u.user_id = sc.uploaded_by_user_id
     WHERE sc.timesheet_id = ? ORDER BY sc.version_no DESC`, [id]);
  const [checks] = await pool.execute(
    `SELECT pc.* FROM eq_paper_checks pc JOIN eq_attendance a ON a.eq_attendance_id = pc.eq_attendance_id
     WHERE a.timesheet_id = ? AND pc.is_current = 1`, [id]);
  const byRow = Object.fromEntries(checks.map((c) => [c.eq_attendance_id, c]));
  // a row deleted while Draft leaves a gap; a row CANCELLED later stays with its reason: both are cancelled on paper
  const live = rows.filter((r) => r.status !== 'Cancelled');
  const present = new Set(live.map((r) => r.sheet_row_no));
  const cancelled = [];
  for (let n = 1; n <= sheet.last_row_no; n += 1) if (!present.has(n)) cancelled.push(n);
  const { verify_token, ...out } = info;
  res.json({ status: 'success', data: { ...out, rows: rows.map((r) => ({ ...r, cancelled: r.status === 'Cancelled', current_check: byRow[r.eq_attendance_id] || null })), cancelled_rows: cancelled, scans } });
};

exports.print = async (req, res) => {
  const id = parseId(req.params.id);
  const blankDefault = await settings.getInt('eq_timesheet_blank_rows');
  const blank = Math.min(20, Math.max(0, parseInt(req.query.blank_rows, 10) || blankDefault));
  const pdf = await withTransaction(async (conn) => {
    const sheet = await loadSheet(conn, id, true);
    await assertSheetAccess(req.user, sheet, conn);
    const [[machine]] = await conn.execute(
      `SELECT e.*, t.type_name, t.type_name_ar, t.meter_unit FROM eq_equipment e JOIN eq_types t ON t.type_id = e.type_id WHERE e.equipment_id = ?`, [sheet.equipment_id]);
    const [[vendor]] = await conn.execute('SELECT * FROM eq_vendors WHERE vendor_id = ?', [machine.vendor_id]);
    const [[site]] = await conn.execute('SELECT * FROM sites WHERE site_id = ?', [sheet.site_id]);
    const [contracts] = await conn.execute(
      `SELECT DISTINCT vc.contract_number FROM eq_rate_cards rc JOIN eq_vendor_contracts vc ON vc.vendor_contract_id = rc.vendor_contract_id
       WHERE rc.equipment_id = ? AND rc.effective_from <= ? AND (rc.effective_to IS NULL OR rc.effective_to >= ?)`,
      [sheet.equipment_id, `${sheet.period_month}-31`, `${sheet.period_month}-01`]);
    const rows = (await sheetRows(conn, id)).filter((r) => r.status !== 'Cancelled');
    const present = new Set(rows.map((r) => r.sheet_row_no));
    const all = [...rows];
    for (let n = 1; n <= sheet.last_row_no; n += 1) if (!present.has(n)) all.push({ sheet_row_no: n, cancelled: true });
    all.sort((a, b) => a.sheet_row_no - b.sheet_row_no);
    const shifts = [...new Set(rows.map((r) => r.shift_type))].join(' + ') || 'Day';
    const printCount = Number(sheet.print_count) + 1;
    const now = businessNow();
    await conn.execute('UPDATE eq_timesheets SET print_count = ?, last_printed_at = ? WHERE timesheet_id = ?', [printCount, now, id]);
    return eqPdf.renderTimesheet({
      company: await settings.getString('company_name'), sheet, machine, vendor, site, shifts,
      contractNumber: contracts.map((c) => c.contract_number).join(', '), rows: all, blankRows: blank,
      printedBy: req.user.full_name, printedAt: now.slice(0, 16), printCount,
    });
  });
  const [[s]] = await pool.execute('SELECT sheet_code FROM eq_timesheets WHERE timesheet_id = ?', [id]);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="${s.sheet_code}.pdf"`);
  res.send(pdf);
};

exports.resolve = async (req, res) => {
  let code = String(req.query.code || ''); let token = String(req.query.token || '');
  if (req.query.qr) { const parts = String(req.query.qr).split('|'); code = parts[1] || ''; token = parts[2] || ''; }
  const [[sheet]] = await pool.execute('SELECT * FROM eq_timesheets WHERE sheet_code = ?', [code]);
  if (!sheet || sheet.verify_token !== token) throw AppError.notFound('Timesheet (code or token not valid)');
  await assertSheetAccess(req.user, sheet);
  res.json({ status: 'success', data: { timesheet_id: sheet.timesheet_id, sheet_code: sheet.sheet_code } });
};

// ------------------------------------------------------------------ scans
function countPdfPages(buf) {
  const m = buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
  return m ? m.length : 1;
}

exports.uploadScan = [uploads.many('files', 10), async (req, res) => {
  const id = parseId(req.params.id);
  const meta = validate(req.body, { through_row_no: v.int({ min: 0 }), note: v.string({ max: 500 }) });
  const kinds = req.files.map((f) => uploads.detect(f.buffer, ['pdf', 'jpg', 'png']));
  let buffer; let pages;
  if (kinds.some((k) => k.ext === 'pdf')) {
    if (req.files.length > 1) throw AppError.badRequest('VALIDATION_ERROR', 'Upload either one PDF or several images, not both.');
    buffer = req.files[0].buffer; pages = countPdfPages(buffer);
  } else {
    try {
      buffer = await eqPdf.imagesToPdf(req.files.map((f) => f.buffer));
    } catch (e) {
      throw new AppError(415, 'FILE_CORRUPT', 'One of the images is damaged or not a valid JPEG/PNG.');
    }
    pages = req.files.length;
  }
  const hash = storage.sha256(buffer);
  const scan = await withTransaction(async (conn) => {
    const sheet = await loadSheet(conn, id, true);
    await assertSheetAccess(req.user, sheet, conn);
    const [dup] = await conn.execute('SELECT scan_id, version_no FROM eq_timesheet_scans WHERE timesheet_id = ? AND sha256 = ?', [id, hash]);
    if (dup[0]) throw AppError.conflict('DUPLICATE_SCAN', `This exact file was already uploaded as version ${dup[0].version_no}.`);
    const [[{ v: maxV }]] = await conn.execute('SELECT COALESCE(MAX(version_no), 0) AS v FROM eq_timesheet_scans WHERE timesheet_id = ?', [id]);
    const version = Number(maxV) + 1;
    const through = meta.through_row_no ?? sheet.last_row_no;
    if (through > sheet.last_row_no) throw AppError.validation({ through_row_no: `cannot be more than the last row (${sheet.last_row_no})` });
    const key = `equipment/timesheets/${sheet.sheet_code}/v${version}-${hash.slice(0, 16)}.pdf`;
    await storage.put({ key, buffer, contentType: 'application/pdf' });
    const [r] = await conn.execute(
      `INSERT INTO eq_timesheet_scans (timesheet_id, version_no, through_row_no, storage_key, original_name, mime_type, page_count, size_bytes, sha256, note, uploaded_by_user_id, uploaded_at)
       VALUES (?, ?, ?, ?, ?, 'application/pdf', ?, ?, ?, ?, ?, ?)`,
      [id, version, through, key, req.files.map((f) => f.originalname).join(', ').slice(0, 255), pages, buffer.length, hash, meta.note || null, req.user.user_id, businessNow()]);
    // rows marked Missing that are now covered go back to Pending
    await conn.execute(
      "UPDATE eq_attendance SET paper_status = 'Pending' WHERE timesheet_id = ? AND paper_status = 'Missing' AND sheet_row_no <= ?", [id, through]);
    await audit.log(conn, { table: 'eq_timesheet_scans', id: r.insertId, action: 'upload', newValues: { timesheet_id: id, version, through_row_no: through, sha256: hash, pages }, ...audit.ctx(req) });
    return { scan_id: r.insertId, version_no: version, through_row_no: through, page_count: pages, size_bytes: buffer.length, sha256: hash };
  });
  res.status(201).json({ status: 'success', data: scan, message: `Version ${scan.version_no} uploaded.` });
}];

exports.listScans = async (req, res) => {
  const id = parseId(req.params.id);
  const sheet = await loadSheet(pool, id);
  await assertSheetAccess(req.user, sheet);
  const [rows] = await pool.execute(
    `SELECT sc.scan_id, sc.version_no, sc.through_row_no, sc.page_count, sc.size_bytes, sc.sha256, sc.note, sc.uploaded_at, u.full_name AS uploaded_by
     FROM eq_timesheet_scans sc JOIN users u ON u.user_id = sc.uploaded_by_user_id WHERE sc.timesheet_id = ? ORDER BY sc.version_no DESC`, [id]);
  res.json({ status: 'success', data: rows });
};

exports.scanFile = async (req, res) => {
  const id = parseId(req.params.id);
  const scanId = parseId(req.params.scanId, 'scan');
  const sheet = await loadSheet(pool, id);
  await assertSheetAccess(req.user, sheet);
  const [[scan]] = await pool.execute('SELECT * FROM eq_timesheet_scans WHERE scan_id = ? AND timesheet_id = ?', [scanId, id]);
  if (!scan) throw AppError.notFound('Scan');
  await storage.send(res, scan.storage_key, { contentType: scan.mime_type, fileName: `${sheet.sheet_code}-v${scan.version_no}.pdf` });
};

// ------------------------------------------------------------------ paper checks (BR-27)
exports.paperChecks = async (req, res) => {
  const id = parseId(req.params.id);
  const body = req.body || {};
  const { scan_id } = validate(body, { scan_id: v.id() });
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 200) throw AppError.validation({ items: 'give 1 to 200 items' });
  const tolerance = await settings.getInt('eq_paper_tolerance_minutes');
  const result = await withTransaction(async (conn) => {
    const sheet = await loadSheet(conn, id, true);
    let scan = null;
    if (scan_id) {
      const [[s]] = await conn.execute('SELECT * FROM eq_timesheet_scans WHERE scan_id = ? AND timesheet_id = ?', [scan_id, id]);
      if (!s) throw AppError.validation({ scan_id: 'does not belong to this sheet' });
      scan = s;
    } else {
      const [[s]] = await conn.execute('SELECT * FROM eq_timesheet_scans WHERE timesheet_id = ? ORDER BY version_no DESC LIMIT 1', [id]);
      scan = s || null;
    }
    const out = []; const errors = [];
    const now = businessNow();
    for (const [i, raw] of body.items.entries()) {
      try {
        const it = validate(raw, {
          eq_attendance_id: v.id({ required: true }), result: v.enumOf(['Matched', 'Mismatch', 'Missing'], { required: true }),
          paper_check_in: v.datetime(), paper_check_out: v.datetime(),
          paper_meter_start: v.number({ min: 0, decimals: 1 }), paper_meter_end: v.number({ min: 0, decimals: 1 }),
          employee_signed: v.bool({ default: false }), operator_signed: v.bool({ default: false }), note: v.string({ max: 500 }),
        });
        const [[row]] = await conn.execute('SELECT * FROM eq_attendance WHERE eq_attendance_id = ? AND timesheet_id = ? FOR UPDATE', [it.eq_attendance_id, id]);
        if (!row) throw AppError.validation({ eq_attendance_id: 'not on this sheet' });
        if (it.result !== 'Missing' && !scan) throw AppError.badRequest('SCAN_REQUIRED', 'Upload a scan of the sheet first.');
        if (it.result === 'Mismatch' && !it.note) throw AppError.validation({ note: 'explain the mismatch' });
        let diff = null;
        if (it.result !== 'Missing' && row.check_in_time) {
          const pin = it.paper_check_in || row.check_in_time;
          const pout = it.paper_check_out || row.check_out_time;
          const a = Math.abs(diffMinutes(row.check_in_time, pin));
          const b = row.check_out_time && pout ? Math.abs(diffMinutes(row.check_out_time, pout)) : 0;
          diff = Math.max(a, b);
        }
        if (it.result === 'Matched') {
          const missingSig = [!it.employee_signed && 'employee', !it.operator_signed && 'operator'].filter(Boolean);
          if (missingSig.length || (diff !== null && diff > tolerance)) {
            throw new AppError(400, 'CANNOT_MATCH', missingSig.length
              ? `Cannot mark Matched: missing ${missingSig.join(' and ')} signature.`
              : `Cannot mark Matched: the paper differs by ${diff} min (tolerance ${tolerance} min).`, { diff_minutes: diff, tolerance, missing_signatures: missingSig });
          }
        }
        await conn.execute('UPDATE eq_paper_checks SET is_current = 0 WHERE eq_attendance_id = ?', [row.eq_attendance_id]);
        const [r] = await conn.execute(
          `INSERT INTO eq_paper_checks (eq_attendance_id, scan_id, result, paper_check_in, paper_check_out, paper_meter_start, paper_meter_end,
             employee_signed, operator_signed, diff_minutes, note, is_current, checked_by_user_id, checked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [row.eq_attendance_id, scan ? scan.scan_id : null, it.result, it.paper_check_in || null, it.paper_check_out || null,
            it.paper_meter_start ?? null, it.paper_meter_end ?? null, it.employee_signed ? 1 : 0, it.operator_signed ? 1 : 0, diff, it.note || null, req.user.user_id, now]);
        await conn.execute('UPDATE eq_attendance SET paper_status = ? WHERE eq_attendance_id = ?', [it.result, row.eq_attendance_id]);
        await audit.log(conn, { table: 'eq_paper_checks', id: r.insertId, action: `paper_${it.result.toLowerCase()}`, newValues: { ...it, diff_minutes: diff }, ...audit.ctx(req) });
        out.push({ eq_attendance_id: row.eq_attendance_id, sheet_row_no: row.sheet_row_no, result: it.result, diff_minutes: diff });
      } catch (e) {
        if (!e.isAppError) throw e;
        errors.push({ index: i, eq_attendance_id: raw && raw.eq_attendance_id, code: e.code, message: e.message, details: e.details });
      }
    }
    if (errors.length && !out.length) {
      const first = errors[0];
      throw new AppError(400, first.code, first.message, { errors });
    }
    const after = await sheets.refreshStatus(conn, sheet.timesheet_id, req.user.user_id);
    return { checked: out, errors, sheet_status: after.status };
  });
  res.json({ status: 'success', data: result });
};

exports.close = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body, { site_engineer_name: v.string({ required: true, max: 255 }), vendor_rep_name: v.string({ required: true, max: 255 }) });
  const sheet = await withTransaction(async (conn) => {
    const s = await loadSheet(conn, id, true);
    if (s.status !== 'Open') throw AppError.conflict('INVALID_STATE', `The sheet is already ${s.status}.`);
    if (`${s.period_month}-01` > businessToday()) throw AppError.conflict('INVALID_STATE', 'A future month cannot be closed.');
    const [[{ t }]] = await conn.execute('SELECT MAX(through_row_no) AS t FROM eq_timesheet_scans WHERE timesheet_id = ?', [id]);
    if (Number(t || 0) < Number(s.last_row_no) || s.last_row_no === 0) {
      throw AppError.conflict('FINAL_SCAN_REQUIRED', `Upload a scan covering all ${s.last_row_no} rows before closing.`, { scanned_through_row: Number(t || 0), last_row_no: s.last_row_no });
    }
    await conn.execute(
      "UPDATE eq_timesheets SET status = 'Closed', closed_by_user_id = ?, closed_at = ?, site_engineer_name = ?, vendor_rep_name = ? WHERE timesheet_id = ?",
      [req.user.user_id, businessNow(), d.site_engineer_name, d.vendor_rep_name, id]);
    await audit.log(conn, { table: 'eq_timesheets', id, action: 'close', newValues: d, ...audit.ctx(req) });
    return sheets.refreshStatus(conn, id, req.user.user_id);
  });
  const { verify_token, ...out } = sheet;
  res.json({ status: 'success', data: out });
};

exports.reopen = async (req, res) => {
  const id = parseId(req.params.id);
  const { reason } = validate(req.body, { reason: v.string({ required: true, max: 500 }) });
  const sheet = await withTransaction(async (conn) => {
    const s = await loadSheet(conn, id, true);
    if (s.status === 'Open') throw AppError.conflict('INVALID_STATE', 'The sheet is already Open.');
    await conn.execute("UPDATE eq_timesheets SET status = 'Open', reconciled_at = NULL, reconciled_by_user_id = NULL WHERE timesheet_id = ?", [id]);
    await audit.log(conn, { table: 'eq_timesheets', id, action: 'reopen', oldValues: { status: s.status }, newValues: { status: 'Open' }, reason, ...audit.ctx(req) });
    return loadSheet(conn, id);
  });
  const { verify_token, ...out } = sheet;
  res.json({ status: 'success', data: out });
};
