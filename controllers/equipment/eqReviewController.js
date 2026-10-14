// Office review: list, approve, reject, anomalies, office edit, void row, change requests (§5.6).
//
// Policy (14 Oct 2026, see services/equipment/eqLock.js): the office (Admin or Accountant) corrects a row directly while
// its invoice is a draft or issued (the invoice is brought up to date with the same numbers; the audit keeps the before /
// after values). An invoice handed over to finance locks its days for everybody: withdraw it first, or make a debit /
// credit note. Withdrawn from finance: the Admin only. The old "official correction" workflow is gone.
const { pool, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { v, validate, parseId, pageParams } = require('../../utils/validate');
const audit = require('../../services/audit');
const { businessNow } = require('../../utils/businessDate');
const S = require('../../services/equipment/eqAttendanceService');
const lock = require('../../services/equipment/eqLock');
const att = require('./eqAttendanceController');
const C = require('../../services/equipment/eqCommon');
const CORR = require('../../services/equipment/eqCorrectionService');

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
  else where.push("ea.status <> 'Cancelled'");
  if (req.query.paper_status) f('ea.paper_status = ?', String(req.query.paper_status));
  if (req.query.day_status) f('ea.day_status = ?', String(req.query.day_status));
  if (req.query.late === 'only') where.push('ea.late_entry = 1');
  if (req.query.anomaly === 'only') where.push('ea.anomaly_code IS NOT NULL');
  if (req.query.anomaly === 'unacknowledged') where.push('ea.anomaly_code IS NOT NULL AND ea.anomaly_ack_at IS NULL');
  if (req.query.anomaly === 'none') where.push('ea.anomaly_code IS NULL');
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM eq_attendance ea JOIN eq_equipment e ON e.equipment_id = ea.equipment_id JOIN eq_types t ON t.type_id = e.type_id
    JOIN eq_vendors vd ON vd.vendor_id = e.vendor_id JOIN sites s ON s.site_id = ea.site_id LEFT JOIN eq_operators o ON o.operator_id = ea.operator_id`;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} ${w}`, params);
  const [rows] = await pool.query(
    `SELECT ea.*, e.equipment_code, e.machine_label, t.type_name, vd.vendor_name, s.site_code, s.site_name, o.full_name AS operator_name,
       (SELECT COUNT(*) FROM eq_attendance_change_requests cr WHERE cr.eq_attendance_id = ea.eq_attendance_id AND cr.status = 'Pending') AS pending_change_requests
     ${from} ${w} ORDER BY ea.record_date DESC, s.site_code, e.equipment_code LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
  const [[counts]] = await pool.query(
    `SELECT SUM(ea.status='Submitted') AS submitted, SUM(ea.status='Draft') AS draft, SUM(ea.status='Rejected') AS rejected,
       SUM(ea.anomaly_code IS NOT NULL AND ea.anomaly_ack_at IS NULL) AS unacknowledged_anomalies, SUM(ea.late_entry = 1) AS late_entries ${from} ${w}`, params);
  res.json({ status: 'success', data: rows, meta: { total: Number(total), page, page_size: pageSize, counts } });
};

exports.get = async (req, res) => {
  const id = parseId(req.params.id);
  const view = await att.rowView(pool, id);
  const [checks] = await pool.execute('SELECT * FROM eq_paper_checks WHERE eq_attendance_id = ? ORDER BY paper_check_id DESC', [id]);
  const [corrections] = await pool.execute('SELECT * FROM eq_attendance_corrections WHERE eq_attendance_id = ? ORDER BY correction_id DESC', [id]);
  const [changeRequests] = await pool.execute(
    `SELECT cr.*, u.full_name AS requested_by, d.full_name AS decided_by FROM eq_attendance_change_requests cr
     JOIN users u ON u.user_id = cr.requested_by_user_id LEFT JOIN users d ON d.user_id = cr.decided_by_user_id
     WHERE cr.eq_attendance_id = ? ORDER BY cr.change_request_id DESC`, [id]);
  const [history] = await pool.execute(
    `SELECT a.action_type, a.created_at, a.reason, a.changed_fields, a.payroll_effect, u.full_name AS user_name FROM audit_logs a
     LEFT JOIN users u ON u.user_id = a.user_id
     WHERE (a.table_name = 'eq_attendance' AND a.record_id = ?) OR (a.related_type = 'eq_attendance' AND a.related_id = ?) ORDER BY a.log_id`, [id, id]);
  const card = await C.rateCardOn(pool, view.equipment_id, view.record_date);
  const standby = {
    billing_mode: card ? card.billing_mode : null,
    applies: Boolean(card && card.billing_mode === 'Monthly' && (view.day_status === 'Standby' || Number(view.standby_minutes) > 0)),
    max_hours: card ? maxStandbyHours(view, card) : null,
  };
  const lockedBy = await lock.findLock(pool, view);
  const covered = await lock.coveringRow(pool, view);
  const generated = await lock.generatedBatchHoldingRow(pool, id);
  res.json({
    status: 'success',
    data: {
      ...view, standby_credit: standby,
      // the invoice that stops the current user from changing the row (null = editable), and the invoice that covers it
      locked_by_batch_id: lockedBy ? lockedBy.eq_batch_id : null, locked_by_state: lockedBy ? lock.stateOf(lockedBy) : null,
      locked_reason: lockedBy ? lock.lockedError(lockedBy, 'This day').message : null,
      covered_by: covered ? { eq_batch_id: covered.eq_batch_id, state: lock.stateOf(covered), invoice_no: covered.invoice_no || null } : null,
      generated_batch_id: generated,
      paper_checks: checks, corrections: corrections.map((c) => ({ ...c, proposed_changes: C.parseJson(c.proposed_changes) })),
      change_requests: changeRequests.map((c) => ({ ...c, proposed_changes: C.parseJson(c.proposed_changes) })),
      history: history.map((h) => ({ ...h, changed_fields: C.parseJson(h.changed_fields) })),
    },
  });
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
      // inside an invoice handed over to finance: withdraw it first (an issued invoice is brought up to date by itself)
      const locked = await lock.findLock(conn, row);
      if (locked) { skipped.push({ id, reason: 'INVOICE_LOCKED', eq_batch_id: locked.eq_batch_id, message: lock.lockedError(locked, 'This day').message }); continue; }
      if (row.anomaly_code && !row.anomaly_ack_at) { skipped.push({ id, reason: 'UNACK_ANOMALY', anomaly_code: row.anomaly_code }); continue; }
      if (row.day_status === 'Working' && !row.check_out_time) { skipped.push({ id, reason: 'OPEN_SESSION' }); continue; }
      await conn.execute(
        "UPDATE eq_attendance SET status = 'Approved', approved_by_user_id = ?, approval_date = ?, admin_rejection_notes = NULL WHERE eq_attendance_id = ?",
        [req.user.user_id, now, id]);
      await audit.log(conn, { table: 'eq_attendance', id, action: 'approve', oldValues: { status: 'Submitted' }, newValues: { status: 'Approved' }, ...audit.ctx(req) });
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
      const locked = await lock.findLock(conn, row);
      if (locked) { skipped.push({ id, reason: 'INVOICE_LOCKED', eq_batch_id: locked.eq_batch_id, message: lock.lockedError(locked, 'This day').message }); continue; }
      await conn.execute("UPDATE eq_attendance SET status = 'Rejected', admin_rejection_notes = ? WHERE eq_attendance_id = ?", [notes, id]);
      await audit.log(conn, { table: 'eq_attendance', id, action: 'reject', oldValues: { status: 'Submitted' }, newValues: { status: 'Rejected' }, reason: notes, ...audit.ctx(req) });
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
    await lock.assertEqEditable(conn, row);
    await conn.execute('UPDATE eq_attendance SET anomaly_ack_by_user_id = ?, anomaly_ack_at = ?, anomaly_ack_note = ? WHERE eq_attendance_id = ?',
      [req.user.user_id, businessNow(), note, id]);
    await audit.log(conn, { table: 'eq_attendance', id, action: 'ack_anomaly', newValues: { anomaly_code: row.anomaly_code, note }, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await att.rowView(pool, id) });
};

/** Paper status back to Pending when values change after a paper check (BR-28). */
const resetPaper = (conn, row, userId) => att.resetPaper(conn, row, userId);

/** Only what is compared with the signed paper sheet resets the paper check; a remark or a work description does not. */
const PAPER_FIELDS = ['day_status', 'check_in_time', 'check_out_time', 'meter_start', 'meter_end', 'operator_id', 'downtime', 'cancel_row'];
const touchesPaper = (changes) => PAPER_FIELDS.some((k) => changes && changes[k] !== undefined);

/**
 * Office edit of a row (refused only inside an invoice handed over to finance, or withdrawn for a non-Admin): any field,
 * the day status and the stops, several at once. An Approved row stays Approved but is flagged "edited after approval"
 * (reason optional). Shared by the direct office edit and by an approved supervisor change request.
 */
async function officeEdit(conn, req, id, changes, reason, extra = {}) {
  const row = await S.loadRow(conn, id, true);
  if (row.status === 'Cancelled') throw AppError.conflict('ROW_CANCELLED', 'This row was cancelled; it cannot be changed.');
  await lock.assertEqEditable(conn, row);
  if (changes.cancel_row) throw AppError.validation({ cancel_row: 'use "Void row" to cancel a row' });
  const approved = row.status === 'Approved';
  const status = changes.day_status || row.day_status;
  if (status !== 'Working' && (changes.operator_id || changes.meter_start !== undefined || changes.meter_end !== undefined)) {
    throw AppError.conflict('INVALID_STATE', `A ${status} row has no operator or meter readings.`);
  }
  for (const k of ['check_in_time', 'check_out_time']) if (changes[k]) att.assertNotFutureTime(changes[k], k);
  if (changes.operator_id) await att.assertOperatorUsable(conn, changes.operator_id, row);
  const before = { ...row, downtime: await S.loadDowntime(conn, id) };
  const after = await CORR.applyChanges(conn, id, changes, req.user.user_id, { allowOpen: true });
  if (touchesPaper(changes)) await resetPaper(conn, row, req.user.user_id);
  if (approved) {
    await conn.execute('UPDATE eq_attendance SET edited_after_approval = 1, admin_edit_reason = ?, admin_edit_by_user_id = ?, admin_edit_at = ? WHERE eq_attendance_id = ?',
      [reason && reason.trim() ? reason.trim() : null, req.user.user_id, businessNow(), id]);
  }
  const afterFull = { ...after, downtime: await S.loadDowntime(conn, id) };
  await audit.log(conn, {
    table: 'eq_attendance', id, action: approved ? 'office_edit_after_approval' : 'office_edit', oldValues: before, newValues: afterFull,
    reason: reason || null, payrollEffect: await lock.rowPayrollEffect(conn, id), ...extra, ...audit.ctx(req),
  });
  return afterFull;
}
exports.officeEdit = officeEdit;

exports.adminEdit = async (req, res) => {
  const id = parseId(req.params.id);
  const body = req.body || {};
  const { reason } = validate(body, { reason: v.string({ max: 1000 }) });
  if (body.standby_credit_hours !== undefined) throw AppError.validation({ standby_credit_hours: 'use the standby hours action' });
  const changes = CORR.normalizeChanges(body);
  delete changes.standby_credit_hours;
  if (!Object.keys(changes).length) throw AppError.validation({ changes: 'nothing to change' });
  await withTransaction((conn) => officeEdit(conn, req, id, changes, reason));
  res.json({ status: 'success', data: await att.rowView(pool, id) });
};

/**
 * Void a row that should not exist (wrong machine, wrong date, duplicate). It stays as Cancelled; a draft over it must be
 * recalculated, an issued invoice is brought up to date. Refused inside an invoice handed over to finance.
 */
exports.voidRow = async (req, res) => {
  const id = parseId(req.params.id);
  const { reason } = validate(req.body || {}, { reason: v.string({ max: 1000 }) }); // optional before the lock (11 Oct 2026)
  await withTransaction(async (conn) => {
    const row = await S.loadRow(conn, id, true);
    if (row.status === 'Cancelled') throw AppError.conflict('ROW_CANCELLED', 'This row is already cancelled.');
    await lock.assertEqEditable(conn, row);
    if (row.day_status === 'Working' && row.check_in_time && !row.check_out_time) {
      throw AppError.conflict('OPEN_SESSION', 'The machine is still checked in on this row. Check it out (or fix the times) first.');
    }
    await att.cancelRow(conn, req, row, reason && reason.trim() ? reason.trim() : null, 'void');
  });
  res.json({ status: 'success', data: await att.rowView(pool, id), message: 'Row voided (kept as Cancelled).' });
};

// ------------------------------------------------------------------ supervisor change requests

const REQUEST_FIELDS = (body) => {
  const changes = CORR.normalizeChanges(body);
  if (changes.standby_credit_hours !== undefined) throw AppError.validation({ standby_credit_hours: 'standby hours are set by the office' });
  if (changes.cancel_row) throw AppError.validation({ cancel_row: 'ask the office to void the row in the reason instead' });
  return changes;
};

/**
 * A supervisor asks the office to change a row they cannot change directly: an Approved row of their site, or a
 * historical row of the site/shift they supervise today (before their assignment). Admin or Accountant decides.
 */
exports.createChangeRequest = async (req, res) => {
  const id = parseId(req.params.id);
  const body = req.body || {};
  const { reason } = validate(body, { reason: v.string({ required: true, min: 5, max: 1000 }) });
  const changes = REQUEST_FIELDS(body.changes);
  const site = require('../../services/siteAccess');
  const out = await withTransaction(async (conn) => {
    const row = await S.loadRow(conn, id, true);
    if (row.status === 'Cancelled') throw AppError.conflict('ROW_CANCELLED', 'This row was cancelled.');
    if (req.user.role === 'Supervisor') {
      if (!(await site.isCurrentSupervisor(req.user.user_id, row.site_id, row.shift_type, conn))) {
        throw AppError.forbidden('SITE_HISTORY_READ_ONLY', 'Only the current supervisor of this site/shift (or the office) can ask for a change.');
      }
      const denial = await site.editDenial(req.user, row.site_id, row.shift_type, row.record_date, conn);
      if (!denial && ['Draft', 'Rejected'].includes(row.status)) {
        throw AppError.conflict('EDIT_DIRECTLY', 'You can change this row yourself (it is not sent / was returned to you).');
      }
      if (!denial && row.status === 'Submitted') throw AppError.conflict('RECALL_FIRST', 'Recall the row and change it yourself: the office has not approved it yet.');
    }
    const [[open]] = await conn.execute("SELECT change_request_id FROM eq_attendance_change_requests WHERE eq_attendance_id = ? AND status = 'Pending' LIMIT 1", [id]);
    if (open) throw AppError.conflict('REQUEST_PENDING', `Change request #${open.change_request_id} for this row is still waiting for the office.`);
    const [r] = await conn.execute(
      `INSERT INTO eq_attendance_change_requests (eq_attendance_id, proposed_changes, reason, requested_by_user_id, requested_at)
       VALUES (?, ?, ?, ?, ?)`, [id, JSON.stringify(changes), reason, req.user.user_id, businessNow()]);
    await audit.log(conn, { table: 'eq_attendance_change_requests', id: r.insertId, action: 'request', newValues: { eq_attendance_id: id, changes }, reason,
      relatedType: 'eq_attendance', relatedId: id, ...audit.ctx(req) });
    return r.insertId;
  });
  res.status(201).json({ status: 'success', data: await changeRequestView(pool, out), message: 'Change request sent. The Admin or the Accountant approves it.' });
};

async function changeRequestView(conn, id) {
  const [[r]] = await conn.execute(
    `SELECT cr.*, u.full_name AS requested_by, d.full_name AS decided_by, ea.record_date, ea.sheet_row_no, ea.status AS row_status, ea.site_id, ea.shift_type,
       e.equipment_code, e.machine_label, s.site_code FROM eq_attendance_change_requests cr
     JOIN eq_attendance ea ON ea.eq_attendance_id = cr.eq_attendance_id JOIN eq_equipment e ON e.equipment_id = ea.equipment_id
     JOIN sites s ON s.site_id = ea.site_id JOIN users u ON u.user_id = cr.requested_by_user_id LEFT JOIN users d ON d.user_id = cr.decided_by_user_id
     WHERE cr.change_request_id = ?`, [id]);
  if (!r) throw AppError.notFound('Change request');
  return { ...r, proposed_changes: C.parseJson(r.proposed_changes) };
}

exports.listChangeRequests = async (req, res) => {
  const where = []; const params = [];
  if (req.query.status) { where.push('cr.status = ?'); params.push(String(req.query.status)); }
  if (req.user.role === 'Supervisor') { where.push('cr.requested_by_user_id = ?'); params.push(req.user.user_id); }
  const [rows] = await pool.query(
    `SELECT cr.change_request_id FROM eq_attendance_change_requests cr ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY cr.change_request_id DESC LIMIT 300`, params);
  const out = [];
  for (const r of rows) out.push(await changeRequestView(pool, r.change_request_id));
  res.json({ status: 'success', data: out });
};

async function loadChangeRequest(conn, id, lockRow = true) {
  const [[r]] = await conn.execute(`SELECT * FROM eq_attendance_change_requests WHERE change_request_id = ?${lockRow ? ' FOR UPDATE' : ''}`, [id]);
  if (!r) throw AppError.notFound('Change request');
  if (r.status !== 'Pending') throw AppError.conflict('INVALID_STATE', `This change request is ${r.status}.`);
  return { ...r, proposed_changes: C.parseJson(r.proposed_changes) };
}

/**
 * Admin or Accountant approves: the change is applied as an office edit (reason = the request). Refused while the
 * row's invoice is handed over to finance (withdraw it first).
 */
exports.approveChangeRequest = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body, { note: v.string({ max: 1000 }) });
  await withTransaction(async (conn) => {
    const cr = await loadChangeRequest(conn, id);
    if (cr.requested_by_user_id === req.user.user_id) throw AppError.forbidden('SAME_PERSON', 'You sent this request; another person approves it.');
    const row = await S.loadRow(conn, cr.eq_attendance_id, true);
    const locked = await lock.findLock(conn, row);
    if (locked) throw lock.lockedError(locked, 'This day');
    const [[who]] = await conn.execute('SELECT full_name FROM users WHERE user_id = ?', [cr.requested_by_user_id]);
    const reason = `Change request #${id} (${who ? who.full_name : 'supervisor'}): ${cr.reason}${d.note ? ` / ${d.note}` : ''}`.slice(0, 1000);
    await officeEdit(conn, req, cr.eq_attendance_id, cr.proposed_changes, reason, { relatedType: 'eq_attendance_change_requests', relatedId: id });
    await conn.execute("UPDATE eq_attendance_change_requests SET status = 'Applied', decided_by_user_id = ?, decided_at = ?, decision_note = ? WHERE change_request_id = ?",
      [req.user.user_id, businessNow(), d.note || null, id]);
    await audit.log(conn, { table: 'eq_attendance_change_requests', id, action: 'apply', reason: d.note || null,
      relatedType: 'eq_attendance', relatedId: cr.eq_attendance_id, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await changeRequestView(pool, id), message: 'Change applied.' });
};

exports.rejectChangeRequest = async (req, res) => {
  const id = parseId(req.params.id);
  const { note } = validate(req.body, { note: v.string({ required: true, min: 3, max: 1000 }) });
  await withTransaction(async (conn) => {
    await loadChangeRequest(conn, id);
    await conn.execute("UPDATE eq_attendance_change_requests SET status = 'Rejected', decided_by_user_id = ?, decided_at = ?, decision_note = ? WHERE change_request_id = ?",
      [req.user.user_id, businessNow(), note, id]);
    await audit.log(conn, { table: 'eq_attendance_change_requests', id, action: 'reject', reason: note, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await changeRequestView(pool, id) });
};

exports.withdrawChangeRequest = async (req, res) => {
  const id = parseId(req.params.id);
  await withTransaction(async (conn) => {
    const cr = await loadChangeRequest(conn, id);
    if (cr.requested_by_user_id !== req.user.user_id) throw AppError.forbidden('FORBIDDEN_ROLE', 'Only the person who sent it can withdraw it.');
    await conn.execute("UPDATE eq_attendance_change_requests SET status = 'Withdrawn', decided_at = ? WHERE change_request_id = ?", [businessNow(), id]);
    await audit.log(conn, { table: 'eq_attendance_change_requests', id, action: 'withdraw', ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await changeRequestView(pool, id) });
};

// ------------------------------------------------------------------ standby hours given (monthly machines)
/** Most hours that can be given: one day of the card; inside a Working day, not more than the standby recorded. */
function maxStandbyHours(row, card) {
  const day = Number(card.standard_hours_per_day);
  if (row.day_status === 'Standby') return day;
  return Math.min(day, Math.round((Number(row.standby_minutes || 0) / 60) * 100) / 100);
}

/**
 * Admin/Accountant decide how many standby hours a MONTHLY machine is paid for on this row (no %). hours = null clears it.
 * The first decision needs no reason; changing or clearing a decision does.
 */
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
    const overriding = row.standby_credit_minutes !== null && row.standby_credit_minutes !== undefined && Number(row.standby_credit_minutes) !== minutes;
    if (overriding && (!d.note || d.note.trim().length < 5)) throw AppError.validation({ note: 'say why the standby hours already decided are changed (at least 5 characters)' });
    await conn.execute(
      `UPDATE eq_attendance SET standby_credit_minutes = ?, standby_credit_by_user_id = ?, standby_credit_at = ?, standby_credit_note = ?
       WHERE eq_attendance_id = ?`,
      [minutes, clear ? null : req.user.user_id, clear ? null : businessNow(), clear ? null : (d.note || null), id]);
    await audit.log(conn, { table: 'eq_attendance', id, action: 'standby_credit',
      oldValues: { standby_credit_minutes: row.standby_credit_minutes }, newValues: { standby_credit_minutes: minutes }, reason: d.note || null,
      payrollEffect: await lock.rowPayrollEffect(conn, id), ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await att.rowView(pool, id) });
};
