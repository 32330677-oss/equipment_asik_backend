// Admin review: list, approve, reject, anomalies, admin edit, corrections in finalized periods (§5.6).
const { pool, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { v, validate, parseId, pageParams } = require('../../utils/validate');
const audit = require('../../services/audit');
const { businessNow } = require('../../utils/businessDate');
const S = require('../../services/equipment/eqAttendanceService');
const lock = require('../../services/equipment/eqLock');
const sheets = require('../../services/equipment/eqTimesheetService');
const att = require('./eqAttendanceController');
const C = require('../../services/equipment/eqCommon');

exports.list = async (req, res) => {
  const { page, pageSize, offset } = pageParams(req.query);
  const where = []; const params = [];
  const f = (cond, val) => { where.push(cond); params.push(val); };
  if (req.query.from) f('ea.record_date >= ?', String(req.query.from));
  if (req.query.to) f('ea.record_date <= ?', String(req.query.to));
  if (req.query.site_id) f('ea.site_id = ?', Number(req.query.site_id));
  if (req.query.vendor_id) f('e.vendor_id = ?', Number(req.query.vendor_id));
  if (req.query.equipment_id) f('ea.equipment_id = ?', Number(req.query.equipment_id));
  if (req.query.status) f('ea.status = ?', String(req.query.status));
  if (req.query.paper_status) f('ea.paper_status = ?', String(req.query.paper_status));
  if (req.query.day_status) f('ea.day_status = ?', String(req.query.day_status));
  if (req.query.anomaly === 'only') where.push('ea.anomaly_code IS NOT NULL');
  if (req.query.anomaly === 'unacknowledged') where.push('ea.anomaly_code IS NOT NULL AND ea.anomaly_ack_at IS NULL');
  if (req.query.anomaly === 'none') where.push('ea.anomaly_code IS NULL');
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM eq_attendance ea JOIN eq_equipment e ON e.equipment_id = ea.equipment_id JOIN eq_types t ON t.type_id = e.type_id
    JOIN eq_vendors vd ON vd.vendor_id = e.vendor_id JOIN sites s ON s.site_id = ea.site_id LEFT JOIN eq_operators o ON o.operator_id = ea.operator_id`;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} ${w}`, params);
  const [rows] = await pool.query(
    `SELECT ea.*, e.equipment_code, t.type_name, vd.vendor_name, s.site_code, s.site_name, o.full_name AS operator_name
     ${from} ${w} ORDER BY ea.record_date DESC, s.site_code, e.equipment_code LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
  const [[counts]] = await pool.query(
    `SELECT SUM(ea.status='Submitted') AS submitted, SUM(ea.status='Draft') AS draft, SUM(ea.status='Rejected') AS rejected,
       SUM(ea.anomaly_code IS NOT NULL AND ea.anomaly_ack_at IS NULL) AS unacknowledged_anomalies ${from} ${w}`, params);
  res.json({ status: 'success', data: rows, meta: { total: Number(total), page, page_size: pageSize, counts } });
};

exports.get = async (req, res) => {
  const id = parseId(req.params.id);
  const view = await att.rowView(pool, id);
  const [checks] = await pool.execute('SELECT * FROM eq_paper_checks WHERE eq_attendance_id = ? ORDER BY paper_check_id DESC', [id]);
  const [corrections] = await pool.execute('SELECT * FROM eq_attendance_corrections WHERE eq_attendance_id = ? ORDER BY correction_id DESC', [id]);
  const [history] = await pool.execute(
    `SELECT a.action_type, a.created_at, a.reason, u.full_name AS user_name FROM audit_logs a LEFT JOIN users u ON u.user_id = a.user_id
     WHERE a.table_name = 'eq_attendance' AND a.record_id = ? ORDER BY a.log_id`, [id]);
  const card = await C.rateCardOn(pool, view.equipment_id, view.record_date);
  const standby = {
    billing_mode: card ? card.billing_mode : null,
    applies: Boolean(card && card.billing_mode === 'Monthly' && (view.day_status === 'Standby' || Number(view.standby_minutes) > 0)),
    max_hours: card ? maxStandbyHours(view, card) : null,
  };
  res.json({ status: 'success', data: { ...view, standby_credit: standby, paper_checks: checks, corrections, history } });
};

exports.approve = async (req, res) => {
  const { ids } = validate(req.body, { ids: v.ids({ required: true }) });
  const result = await withTransaction(async (conn) => {
    const approved = []; const skipped = [];
    const now = businessNow();
    for (const id of ids) {
      const [[row]] = await conn.execute('SELECT * FROM eq_attendance WHERE eq_attendance_id = ? FOR UPDATE', [id]);
      if (!row) { skipped.push({ id, reason: 'NOT_FOUND' }); continue; }
      if (row.status !== 'Submitted') { skipped.push({ id, reason: `STATUS_${row.status.toUpperCase()}` }); continue; }
      if (row.anomaly_code && !row.anomaly_ack_at) { skipped.push({ id, reason: 'UNACK_ANOMALY', anomaly_code: row.anomaly_code }); continue; }
      if (row.day_status === 'Working' && !row.check_out_time) { skipped.push({ id, reason: 'OPEN_SESSION' }); continue; }
      await conn.execute(
        "UPDATE eq_attendance SET status = 'Approved', approved_by_user_id = ?, approval_date = ?, admin_rejection_notes = NULL WHERE eq_attendance_id = ?",
        [req.user.user_id, now, id]);
      await audit.log(conn, { table: 'eq_attendance', id, action: 'approve', ...audit.ctx(req) });
      approved.push(id);
    }
    return { approved, skipped };
  });
  res.json({ status: 'success', data: result, message: `${result.approved.length} approved, ${result.skipped.length} skipped.` });
};

exports.reject = async (req, res) => {
  const { ids, notes } = validate(req.body, { ids: v.ids({ required: true }), notes: v.string({ required: true, max: 2000 }) });
  const result = await withTransaction(async (conn) => {
    const rejected = []; const skipped = [];
    for (const id of ids) {
      const [[row]] = await conn.execute('SELECT * FROM eq_attendance WHERE eq_attendance_id = ? FOR UPDATE', [id]);
      if (!row) { skipped.push({ id, reason: 'NOT_FOUND' }); continue; }
      if (row.status !== 'Submitted') { skipped.push({ id, reason: `STATUS_${row.status.toUpperCase()}` }); continue; }
      await conn.execute("UPDATE eq_attendance SET status = 'Rejected', admin_rejection_notes = ? WHERE eq_attendance_id = ?", [notes, id]);
      await audit.log(conn, { table: 'eq_attendance', id, action: 'reject', reason: notes, ...audit.ctx(req) });
      rejected.push(id);
    }
    return { rejected, skipped };
  });
  res.json({ status: 'success', data: result });
};

exports.ackAnomaly = async (req, res) => {
  const id = parseId(req.params.id);
  const { note } = validate(req.body, { note: v.string({ required: true, max: 500 }) });
  await withTransaction(async (conn) => {
    const [[row]] = await conn.execute('SELECT * FROM eq_attendance WHERE eq_attendance_id = ? FOR UPDATE', [id]);
    if (!row) throw AppError.notFound('Attendance row');
    if (!row.anomaly_code) throw AppError.conflict('NO_ANOMALY', 'This row has no anomaly.');
    await conn.execute('UPDATE eq_attendance SET anomaly_ack_by_user_id = ?, anomaly_ack_at = ?, anomaly_ack_note = ? WHERE eq_attendance_id = ?',
      [req.user.user_id, businessNow(), note, id]);
    await audit.log(conn, { table: 'eq_attendance', id, action: 'ack_anomaly', newValues: { anomaly_code: row.anomaly_code, note }, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await att.rowView(pool, id) });
};

/** Paper status back to Pending when values change after a paper check (BR-28). */
async function resetPaper(conn, row, userId) {
  if (row.paper_status !== 'Pending') {
    await conn.execute("UPDATE eq_attendance SET paper_status = 'Pending' WHERE eq_attendance_id = ?", [row.eq_attendance_id]);
    await conn.execute('UPDATE eq_paper_checks SET is_current = 0 WHERE eq_attendance_id = ?', [row.eq_attendance_id]);
    if (row.timesheet_id) await sheets.refreshStatus(conn, row.timesheet_id, userId);
  }
}

exports.adminEdit = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body, att.EDIT_FIELDS);
  await withTransaction(async (conn) => {
    const row = await S.loadRow(conn, id, true);
    await lock.assertEqEditable(conn, row);
    const after = await att.applyEdit(conn, row, d);
    await resetPaper(conn, row, req.user.user_id);
    await audit.log(conn, { table: 'eq_attendance', id, action: 'admin_edit', oldValues: row, newValues: after, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await att.rowView(pool, id) });
};

/** Correction of a row inside a FINALIZED period: the payroll is never changed; an open adjustment item is recorded. */
exports.correction = async (req, res) => {
  const id = parseId(req.params.id);
  const body = req.body || {};
  const { reason } = validate(body, { reason: v.string({ required: true, min: 5, max: 1000 }) });
  const changes = validate(body.changes, att.EDIT_FIELDS);
  if (!Object.keys(changes).length) throw AppError.validation({ changes: 'nothing to change' });
  const result = await withTransaction(async (conn) => {
    const row = await S.loadRow(conn, id, true);
    const lockedBy = await lock.findLock(conn, row);
    if (!lockedBy) throw AppError.conflict('NOT_LOCKED', 'This row is not in a finalized period; use the normal edit.');
    const after = await att.applyEdit(conn, row, changes);
    await resetPaper(conn, row, req.user.user_id);
    const pick = (r) => Object.fromEntries(['check_in_time', 'check_out_time', 'operator_id', 'meter_start', 'meter_end', 'work_description', 'remarks', 'working_minutes', 'breakdown_minutes', 'standby_minutes', 'break_minutes'].map((k) => [k, r[k]]));
    const [r] = await conn.execute(
      `INSERT INTO eq_attendance_corrections (eq_attendance_id, original_values, corrected_values, reason, locked_batch_id, payroll_effect, adjustment_status, corrected_by_user_id, corrected_at)
       VALUES (?, ?, ?, ?, ?, 'AdjustmentRequired', 'Open', ?, ?)`,
      [id, JSON.stringify(pick(row)), JSON.stringify(pick(after)), reason, lockedBy.eq_batch_id, req.user.user_id, businessNow()]);
    await audit.log(conn, { table: 'eq_attendance', id, action: 'correction', oldValues: pick(row), newValues: pick(after), reason, ...audit.ctx(req) });
    return { correction_id: r.insertId, locked_batch_id: lockedBy.eq_batch_id };
  });
  res.status(201).json({ status: 'success', data: { ...result, row: await att.rowView(pool, id) }, message: 'Corrected. The finalized payroll was not changed; settle the difference with an adjustment.' });
};

exports.listCorrections = async (req, res) => {
  const where = []; const params = [];
  if (req.query.status) { where.push('c.adjustment_status = ?'); params.push(String(req.query.status)); }
  const [rows] = await pool.query(
    `SELECT c.*, ea.record_date, ea.equipment_id, ea.site_id, e.equipment_code, s.site_code, u.full_name AS corrected_by
     FROM eq_attendance_corrections c JOIN eq_attendance ea ON ea.eq_attendance_id = c.eq_attendance_id
     JOIN eq_equipment e ON e.equipment_id = ea.equipment_id JOIN sites s ON s.site_id = ea.site_id
     JOIN users u ON u.user_id = c.corrected_by_user_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY c.correction_id DESC LIMIT 500`, params);
  for (const r of rows) { for (const k of ['original_values', 'corrected_values']) if (typeof r[k] === 'string') r[k] = JSON.parse(r[k]); }
  res.json({ status: 'success', data: rows });
};

exports.resolveCorrection = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body, { adjustment_id: v.id(), resolution_note: v.string({ required: true, max: 1000 }) });
  await withTransaction(async (conn) => {
    const [[c]] = await conn.execute('SELECT * FROM eq_attendance_corrections WHERE correction_id = ? FOR UPDATE', [id]);
    if (!c) throw AppError.notFound('Correction');
    if (c.adjustment_status !== 'Open') throw AppError.conflict('INVALID_STATE', 'This correction is not open.');
    if (d.adjustment_id) {
      const [[a]] = await conn.execute("SELECT adjustment_id FROM eq_adjustments WHERE adjustment_id = ? AND status = 'Active'", [d.adjustment_id]);
      if (!a) throw AppError.validation({ adjustment_id: 'unknown or cancelled adjustment' });
    }
    await conn.execute(
      "UPDATE eq_attendance_corrections SET adjustment_status = 'Resolved', resolved_adjustment_id = ?, resolution_note = ?, resolved_by_user_id = ?, resolved_at = ? WHERE correction_id = ?",
      [d.adjustment_id || null, d.resolution_note, req.user.user_id, businessNow(), id]);
    await audit.log(conn, { table: 'eq_attendance_corrections', id, action: 'resolve', newValues: d, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: { correction_id: id, adjustment_status: 'Resolved' } });
};

// ------------------------------------------------------------------ standby hours given (monthly machines)
/** Most hours that can be given: one day of the card; inside a Working day, not more than the standby recorded. */
function maxStandbyHours(row, card) {
  const day = Number(card.standard_hours_per_day);
  if (row.day_status === 'Standby') return day;
  return Math.min(day, Math.round((Number(row.standby_minutes || 0) / 60) * 100) / 100);
}

/** Admin/Accountant decide how many standby hours a MONTHLY machine is paid for on this row (no %). hours = null clears it. */
exports.standbyCredit = async (req, res) => {
  const id = parseId(req.params.id);
  const body = req.body || {};
  const d = validate(body, { hours: v.number({ min: 0, max: 24, decimals: 2 }), note: v.string({ max: 500 }) });
  const clear = body.hours === null;
  if (!clear && d.hours === undefined) throw AppError.validation({ hours: 'is required (or null to clear)' });
  await withTransaction(async (conn) => {
    const row = await S.loadRow(conn, id, true);
    await lock.assertEqEditable(conn, row);
    const card = await C.rateCardOn(conn, row.equipment_id, row.record_date);
    if (!card) throw AppError.conflict('NO_RATE_CARD', `The machine has no rate card on ${row.record_date}.`);
    if (card.billing_mode !== 'Monthly') throw AppError.conflict('NOT_MONTHLY', 'Standby hours are given only for monthly machines; hourly and daily cards use the standby % of the card.');
    if (!(row.day_status === 'Standby' || Number(row.standby_minutes) > 0)) throw AppError.conflict('NO_STANDBY', 'This row has no standby time.');
    const max = maxStandbyHours(row, card);
    if (!clear && d.hours > max) throw AppError.validation({ hours: `cannot be more than ${max} h for this row` });
    const minutes = clear ? null : Math.round(d.hours * 60);
    await conn.execute(
      `UPDATE eq_attendance SET standby_credit_minutes = ?, standby_credit_by_user_id = ?, standby_credit_at = ?, standby_credit_note = ?
       WHERE eq_attendance_id = ?`,
      [minutes, clear ? null : req.user.user_id, clear ? null : businessNow(), clear ? null : (d.note || null), id]);
    await audit.log(conn, { table: 'eq_attendance', id, action: 'standby_credit',
      oldValues: { standby_credit_minutes: row.standby_credit_minutes }, newValues: { standby_credit_minutes: minutes, note: d.note || null }, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await att.rowView(pool, id) });
};
