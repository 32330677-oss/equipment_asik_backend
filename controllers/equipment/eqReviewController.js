// Office review: list, approve, reject, anomalies, office edit, void row, change requests, and official corrections (§5.6).
//
// Policy (6 Oct 2026):
//  - Not financially committed (no FINALIZED batch covers the row) -> the office (Admin or Accountant) corrects it directly.
//    An Approved row stays Approved, flagged "edited after approval", with a reason; a Generated batch over it turns stale.
//  - Financially committed (Finalized / Paid)                     -> only the official Correction: requested by an Admin or
//    an Accountant, approved by ANOTHER Admin/Accountant; the difference is settled by a debit / credit note + adjustment.
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

const OFFICE = ['Admin', 'Accountant'];

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
  const generated = await lock.generatedBatchHoldingRow(pool, id);
  res.json({
    status: 'success',
    data: {
      ...view, standby_credit: standby,
      locked_by_batch_id: lockedBy ? lockedBy.eq_batch_id : null, locked_by_status: lockedBy ? (lockedBy.status === 'Paid' ? 'Paid' : 'Finalized') : null,
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
      // a row whose period is already finalized is never approved normally: a late row is an official Correction
      const locked = await lock.findLock(conn, row);
      if (locked) { skipped.push({ id, reason: 'PAYROLL_PERIOD_FINALIZED', eq_batch_id: locked.eq_batch_id }); continue; }
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
      // rejecting inside a finalized period would leave a row nobody can fix: use a Correction instead
      const locked = await lock.findLock(conn, row);
      if (locked) { skipped.push({ id, reason: 'PAYROLL_PERIOD_FINALIZED', eq_batch_id: locked.eq_batch_id }); continue; }
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
 * Office edit of a row that is NOT financially committed (no finalized batch covers it): any field, the day status and
 * the stops, several at once. An Approved row stays Approved but is flagged "edited after approval" (reason required).
 * Shared by the direct office edit and by an approved supervisor change request.
 */
async function officeEdit(conn, req, id, changes, reason, extra = {}) {
  const row = await S.loadRow(conn, id, true);
  if (row.status === 'Cancelled') throw AppError.conflict('ROW_CANCELLED', 'This row was cancelled; it cannot be changed.');
  await lock.assertEqEditable(conn, row);
  if (changes.cancel_row) throw AppError.validation({ cancel_row: 'use "Void row" to cancel a row' });
  const approved = row.status === 'Approved';
  if (approved && (!reason || reason.trim().length < 5)) throw AppError.validation({ reason: 'explain why an approved row is changed (at least 5 characters)' });
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
      [reason.trim(), req.user.user_id, businessNow(), id]);
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
 * Void a row that should not exist (wrong machine, wrong date, duplicate) before its period is finalized.
 * It stays as Cancelled; a Generated batch over it turns stale. Inside a finalized period: a Correction with cancel_row.
 */
exports.voidRow = async (req, res) => {
  const id = parseId(req.params.id);
  const { reason } = validate(req.body, { reason: v.string({ required: true, min: 5, max: 1000 }) });
  await withTransaction(async (conn) => {
    const row = await S.loadRow(conn, id, true);
    if (row.status === 'Cancelled') throw AppError.conflict('ROW_CANCELLED', 'This row is already cancelled.');
    await lock.assertEqEditable(conn, row);
    if (row.day_status === 'Working' && row.check_in_time && !row.check_out_time) {
      throw AppError.conflict('OPEN_SESSION', 'The machine is still checked in on this row. Check it out (or fix the times) first.');
    }
    await att.cancelRow(conn, req, row, reason, 'void');
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
 * Admin or Accountant approves: the change is applied as an office edit (reason = the request). If the row is now in a
 * finalized period, convert_to_correction turns the request into an official Correction instead.
 */
exports.approveChangeRequest = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body, { note: v.string({ max: 1000 }), convert_to_correction: v.bool({ default: false }) });
  // a conversion needs the money effect, computed on a dry run before the transaction (it locks the row on its own)
  const pre = await loadChangeRequest(pool, id, false);
  const preDelta = d.convert_to_correction && (await lock.findLock(pool, await S.loadRow(pool, pre.eq_attendance_id)))
    ? await CORR.computeDelta(pre.eq_attendance_id, pre.proposed_changes, req.user.user_id) : null;
  const result = await withTransaction(async (conn) => {
    const cr = await loadChangeRequest(conn, id);
    if (cr.requested_by_user_id === req.user.user_id) throw AppError.forbidden('SAME_PERSON', 'You sent this request; another person approves it.');
    const row = await S.loadRow(conn, cr.eq_attendance_id, true);
    const locked = await lock.findLock(conn, row);
    const [[who]] = await conn.execute('SELECT full_name FROM users WHERE user_id = ?', [cr.requested_by_user_id]);
    const reason = `Change request #${id} (${who ? who.full_name : 'supervisor'}): ${cr.reason}${d.note ? ` / ${d.note}` : ''}`.slice(0, 1000);
    let correctionId = null;
    if (locked) {
      if (!d.convert_to_correction) {
        throw AppError.conflict('ROW_LOCKED_USE_CORRECTION',
          `This row is in finalized payroll batch #${locked.eq_batch_id}. Approve with "convert to correction" to send it through the official Correction.`,
          { eq_batch_id: locked.eq_batch_id });
      }
      if (!preDelta) throw AppError.conflict('INVALID_STATE', 'The row was locked meanwhile; try again.');
      correctionId = await createCorrection(conn, req, cr.eq_attendance_id, cr.proposed_changes, reason, null, null, preDelta);
    } else {
      await officeEdit(conn, req, cr.eq_attendance_id, cr.proposed_changes, reason, { relatedType: 'eq_attendance_change_requests', relatedId: id });
    }
    await conn.execute("UPDATE eq_attendance_change_requests SET status = 'Applied', decided_by_user_id = ?, decided_at = ?, decision_note = ? WHERE change_request_id = ?",
      [req.user.user_id, businessNow(), correctionId ? `converted to correction #${correctionId}${d.note ? `: ${d.note}` : ''}` : (d.note || null), id]);
    await audit.log(conn, { table: 'eq_attendance_change_requests', id, action: correctionId ? 'convert_to_correction' : 'apply', reason: d.note || null,
      relatedType: correctionId ? 'eq_attendance_corrections' : 'eq_attendance', relatedId: correctionId || cr.eq_attendance_id, ...audit.ctx(req) });
    return { correctionId };
  });
  res.json({ status: 'success', data: await changeRequestView(pool, id),
    message: result.correctionId ? `Converted to correction #${result.correctionId}; another person approves it.` : 'Change applied.' });
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

// ------------------------------------------------------------------ official corrections (financially committed periods)

const PICK = ['status', 'day_status', 'check_in_time', 'check_out_time', 'operator_id', 'meter_start', 'meter_end', 'work_description', 'remarks',
  'working_minutes', 'breakdown_minutes', 'standby_minutes', 'break_minutes', 'standby_credit_minutes'];
const pick = (r) => Object.fromEntries(PICK.map((k) => [k, r[k] ?? null]));

async function corrEvent(conn, id, action, req, note = null, data = null) {
  await conn.execute('INSERT INTO eq_correction_events (correction_id, action, note, data, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, action, note, data ? JSON.stringify(data) : null, req.user.user_id, businessNow()]);
}

async function loadCorrection(conn, id, lockRow = false) {
  const [[c]] = await conn.execute(`SELECT * FROM eq_attendance_corrections WHERE correction_id = ?${lockRow ? ' FOR UPDATE' : ''}`, [id]);
  if (!c) throw AppError.notFound('Correction');
  for (const k of ['original_values', 'corrected_values', 'proposed_changes', 'delta_detail']) c[k] = C.parseJson(c[k]);
  return c;
}

/** The person whose version is on the table (the requester, or whoever amended it last) cannot approve it. */
function lastAuthor(c) {
  return c.request_status === 'Reviewed' && c.reviewed_by_user_id ? c.reviewed_by_user_id : c.corrected_by_user_id;
}
function assertMayApprove(c, user) {
  if (lastAuthor(c) === user.user_id) {
    throw AppError.forbidden('SAME_PERSON', c.request_status === 'Reviewed'
      ? 'You changed this correction last; another Admin or Accountant approves it.'
      : 'You asked for this correction; another Admin or Accountant approves it.');
  }
}

/**
 * Creates an attendance correction request (inside the caller's transaction). Returns its id.
 * `delta` is computed by the caller BEFORE its transaction (the dry run uses its own connection and row locks).
 */
async function createCorrection(conn, req, rowId, changes, reason, amount, amountReason, delta) {
  const row = await S.loadRow(conn, rowId);
  const lockedBy = await lock.findLock(conn, row);
  if (!lockedBy) throw AppError.conflict('NOT_LOCKED', 'This row is not in a finalized period; edit it normally.');
  const [[open]] = await conn.execute("SELECT correction_id FROM eq_attendance_corrections WHERE eq_attendance_id = ? AND request_status IN ('Requested','Reviewed') LIMIT 1", [rowId]);
  if (open) throw AppError.conflict('CORRECTION_PENDING', `Correction #${open.correction_id} of this row is still in progress. Change that one instead.`);
  // A row never paid by a finalized batch (e.g. a late row) has no computed amount: the requester (or an amendment)
  // gives the amount to settle before it can be approved.
  const [r] = await conn.execute(
    `INSERT INTO eq_attendance_corrections (eq_attendance_id, target_type, original_values, corrected_values, proposed_changes, reason, request_status, locked_batch_id,
       payroll_effect, adjustment_status, delta_amount, delta_detail, currency, amount_override, override_reason, corrected_by_user_id, corrected_at)
     VALUES (?, 'attendance', ?, ?, ?, ?, 'Requested', ?, 'AdjustmentRequired', 'Open', ?, ?, ?, ?, ?, ?, ?)`,
    [rowId, JSON.stringify(pick(row)), JSON.stringify(delta.after), JSON.stringify(changes), reason, lockedBy.eq_batch_id,
      delta.auto ? (delta.delta_cents / 100).toFixed(2) : null, JSON.stringify(delta), delta.currency || null,
      amount ?? null, amount !== null && amount !== undefined ? (amountReason || reason) : null, req.user.user_id, businessNow()]);
  await corrEvent(conn, r.insertId, 'request', req, reason, { changes, delta_cents: delta.auto ? delta.delta_cents : null, amount_override: amount ?? null });
  await audit.log(conn, { table: 'eq_attendance_corrections', id: r.insertId, action: 'request', newValues: { eq_attendance_id: rowId, changes }, reason,
    relatedType: 'eq_attendance', relatedId: rowId, payrollEffect: `correction:${r.insertId}`, ...audit.ctx(req) });
  return r.insertId;
}

/** Step 1 — an Admin or an Accountant asks for a correction of a row inside a finalized period (several fields at once). */
exports.correction = async (req, res) => {
  const id = parseId(req.params.id);
  const body = req.body || {};
  const d = validate(body, { reason: v.string({ required: true, min: 5, max: 1000 }), amount_override: v.number({ min: -99999999, max: 99999999, decimals: 2 }), override_reason: v.string({ max: 1000 }) });
  const changes = CORR.normalizeChanges(body.changes);
  const delta = await CORR.computeDelta(id, changes, req.user.user_id); // validates the changes on a dry run
  const cid = await withTransaction((conn) => createCorrection(conn, req, id, changes, d.reason, d.amount_override ?? null, d.override_reason || null, delta));
  res.status(201).json({ status: 'success', data: await correctionView(pool, cid), message: 'Correction requested. Another Admin or Accountant approves it.' });
};

/**
 * Official correction of money that is not an attendance row: a fuel issue, a rate card price, a fuel price / terms,
 * an adjustment or a deployment already inside a FINALIZED batch (or a fuel issue dated in a closed period).
 * Same approval as attendance corrections; settled by a debit / credit note + adjustment in the first open period.
 */
exports.financialCorrection = async (req, res) => {
  const body = req.body || {};
  const d = validate(body, {
    target_type: v.enumOf(['fuel_issue', 'rate_card', 'fuel_price', 'fuel_terms', 'adjustment', 'deployment', 'other'], { required: true }),
    target_id: v.id(), eq_item_id: v.id(), amount: v.number({ min: -99999999, max: 99999999, decimals: 2 }),
    reason: v.string({ required: true, min: 5, max: 1000 }),
  });
  const fuel = body.fuel_changes ? validate(body.fuel_changes, {
    liters: v.number({ min: 0.01, max: 100000, decimals: 2 }), price_per_liter: v.number({ min: 0, max: 100000, decimals: 3 }),
  }) : null;
  if (fuel && d.target_type !== 'fuel_issue') throw AppError.validation({ fuel_changes: 'only for a fuel issue' });
  if (fuel && !Object.keys(fuel).length) throw AppError.validation({ fuel_changes: 'give the corrected litres and / or price' });
  if (d.target_type !== 'other' && !d.target_id) throw AppError.validation({ target_id: 'is required' });
  const cid = await withTransaction(async (conn) => {
    let item = null; let lockedBatch = null; let equipmentId = null; let siteId = null; let currency = null; let auto = null; let original = {};
    if (d.eq_item_id) {
      const [[it]] = await conn.execute(
        `SELECT i.*, b.status AS batch_status, b.is_finalized, b.currency FROM eq_payroll_items i JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id
         WHERE i.eq_item_id = ?`, [d.eq_item_id]);
      if (!it) throw AppError.notFound('Payroll item');
      if (!Number(it.is_finalized) || !['Generated', 'Paid'].includes(it.batch_status)) {
        throw AppError.conflict('NOT_LOCKED', 'This item is not in a finalized batch: void and regenerate the batch instead.');
      }
      item = it; lockedBatch = it.eq_batch_id; equipmentId = it.equipment_id; siteId = it.site_id; currency = it.currency;
    }
    if (d.target_type === 'fuel_issue') {
      const [[f]] = await conn.execute('SELECT f.*, e.vendor_id FROM eq_fuel_issues f JOIN eq_equipment e ON e.equipment_id = f.equipment_id WHERE f.fuel_issue_id = ? FOR UPDATE', [d.target_id]);
      if (!f) throw AppError.notFound('Fuel issue');
      original = { liters: f.liters, price_per_liter: f.price_per_liter, issue_date: f.issue_date };
      equipmentId = equipmentId || f.equipment_id; siteId = siteId || f.site_id;
      if (item) {
        const [[line]] = await conn.execute("SELECT * FROM eq_payroll_lines WHERE eq_item_id = ? AND source_table = 'eq_fuel_issues' AND source_id = ?", [item.eq_item_id, f.fuel_issue_id]);
        if (!line) throw AppError.validation({ target_id: 'this fuel issue is not on that payroll item' });
        const oldValue = Number(f.liters) * Number(f.price_per_liter || 0);
        if (fuel && oldValue > 0) {
          const newValue = Number(fuel.liters ?? f.liters) * Number(fuel.price_per_liter ?? f.price_per_liter);
          auto = Math.round(Number(line.amount) * (newValue / oldValue) * 100) - Math.round(Number(line.amount) * 100);
        }
      } else {
        const b = await lock.finalizedOverlap(conn, { vendorId: f.vendor_id, equipmentId: f.equipment_id, siteId: f.site_id, from: f.issue_date, to: f.issue_date });
        if (!b) throw AppError.conflict('NOT_LOCKED', 'This fuel issue is not in a closed period: change it normally.');
        lockedBatch = b.eq_batch_id;
        const card = await C.rateCardOn(conn, f.equipment_id, String(f.issue_date).slice(0, 10));
        currency = card ? card.currency : null;
      }
    } else if (!item) {
      throw AppError.validation({ eq_item_id: 'choose the finalized payroll item (machine invoice) that is corrected' });
    }
    if (d.target_type === 'adjustment') {
      const [[a]] = await conn.execute("SELECT * FROM eq_payroll_lines WHERE eq_item_id = ? AND source_table = 'eq_adjustments' AND source_id = ?", [item.eq_item_id, d.target_id]);
      if (!a) throw AppError.validation({ target_id: 'this adjustment is not on that payroll item' });
      original = { amount: a.amount, note: a.note };
    }
    if (d.target_type === 'rate_card' && item.rate_card_id !== d.target_id) throw AppError.validation({ target_id: 'that payroll item was not billed with this rate card' });
    const cents = d.amount !== undefined ? Math.round(d.amount * 100) : auto;
    if (cents === null || cents === undefined) throw AppError.validation({ amount: 'give the amount to settle (+ we pay the vendor more, - we deduct)' });
    if (cents === 0 && !fuel) throw AppError.validation({ amount: 'cannot be 0' });
    const [[open]] = await conn.execute(
      "SELECT correction_id FROM eq_attendance_corrections WHERE target_type = ? AND target_id <=> ? AND eq_item_id <=> ? AND request_status IN ('Requested','Reviewed') LIMIT 1",
      [d.target_type, d.target_id ?? null, item ? item.eq_item_id : null]);
    if (open) throw AppError.conflict('CORRECTION_PENDING', `Correction #${open.correction_id} for this record is still in progress.`);
    const detail = { auto: auto !== null && d.amount === undefined, delta_cents: cents, currency, equipment_id: equipmentId, site_id: siteId, fuel_changes: fuel };
    const [r] = await conn.execute(
      `INSERT INTO eq_attendance_corrections (eq_attendance_id, target_type, target_id, eq_item_id, original_values, corrected_values, proposed_changes, reason,
         request_status, locked_batch_id, payroll_effect, adjustment_status, delta_amount, delta_detail, currency, amount_override, override_reason, corrected_by_user_id, corrected_at)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, 'Requested', ?, 'AdjustmentRequired', 'Open', ?, ?, ?, ?, ?, ?, ?)`,
      [d.target_type, d.target_id ?? null, item ? item.eq_item_id : null, JSON.stringify(original), JSON.stringify(fuel || {}), JSON.stringify({ fuel_changes: fuel }),
        d.reason, lockedBatch, auto !== null ? (auto / 100).toFixed(2) : null, JSON.stringify(detail), currency,
        d.amount !== undefined ? d.amount.toFixed(2) : null, d.amount !== undefined ? d.reason : null, req.user.user_id, businessNow()]);
    await corrEvent(conn, r.insertId, 'request', req, d.reason, { target_type: d.target_type, target_id: d.target_id ?? null, amount_cents: cents, fuel_changes: fuel });
    await audit.log(conn, { table: 'eq_attendance_corrections', id: r.insertId, action: 'request_financial', newValues: { ...d, fuel_changes: fuel },
      reason: d.reason, relatedType: d.target_type, relatedId: d.target_id ?? null, payrollEffect: `correction:${r.insertId}`, ...audit.ctx(req) });
    return r.insertId;
  });
  res.status(201).json({ status: 'success', data: await correctionView(pool, cid), message: 'Correction requested. Another Admin or Accountant approves it.' });
};

async function correctionView(conn, id) {
  const c = await loadCorrection(conn, id);
  const [ev] = await conn.execute(
    `SELECT e.action, e.note, e.data, e.created_at, u.full_name AS user_name FROM eq_correction_events e JOIN users u ON u.user_id = e.user_id
     WHERE e.correction_id = ? ORDER BY e.event_id`, [id]);
  const [[note]] = c.note_invoice_id ? await conn.execute('SELECT invoice_no, kind, amount, currency, issued_at FROM eq_invoices WHERE invoice_id = ?', [c.note_invoice_id]) : [[null]];
  let ctx = {};
  if (c.eq_attendance_id) {
    const [[x]] = await conn.execute(
      `SELECT ea.record_date, ea.sheet_row_no, ea.equipment_id, ea.site_id, e.equipment_code, s.site_code FROM eq_attendance ea
       JOIN eq_equipment e ON e.equipment_id = ea.equipment_id JOIN sites s ON s.site_id = ea.site_id WHERE ea.eq_attendance_id = ?`, [c.eq_attendance_id]);
    ctx = x || {};
  } else {
    const detail = c.delta_detail || {};
    const [[x]] = await conn.execute('SELECT e.equipment_id, e.equipment_code, s.site_id, s.site_code FROM eq_equipment e LEFT JOIN sites s ON s.site_id = ? WHERE e.equipment_id = ?',
      [detail.site_id || null, detail.equipment_id || 0]);
    ctx = x || {};
  }
  const [[people]] = await conn.execute(
    'SELECT (SELECT full_name FROM users WHERE user_id = ?) AS requested_by, (SELECT full_name FROM users WHERE user_id = ?) AS reviewed_by, (SELECT full_name FROM users WHERE user_id = ?) AS approved_by',
    [c.corrected_by_user_id, c.reviewed_by_user_id || 0, c.approved_by_user_id || 0]);
  const amount = c.amount_override !== null && c.amount_override !== undefined ? c.amount_override : c.delta_amount;
  return { ...c, ...ctx, ...people, last_author_user_id: lastAuthor(c), settle_amount: amount, note, events: ev.map((x) => ({ ...x, data: C.parseJson(x.data) })) };
}

exports.getCorrection = async (req, res) => {
  res.json({ status: 'success', data: await correctionView(pool, parseId(req.params.id)) });
};

/**
 * Amend a correction still in progress (several fields, or the amount). The requester amends their own request
 * (it stays Requested); anyone else's amendment makes it Reviewed — and that person can no longer approve that version.
 */
exports.reviewCorrection = async (req, res) => {
  const id = parseId(req.params.id);
  const body = req.body || {};
  const d = validate(body, { note: v.string({ required: true, max: 1000 }), amount_override: v.number({ min: -99999999, max: 99999999, decimals: 2 }), override_reason: v.string({ max: 1000 }) });
  const clearOverride = body.amount_override === null;
  const c0 = await loadCorrection(pool, id);
  if (!['Requested', 'Reviewed'].includes(c0.request_status)) throw AppError.conflict('INVALID_STATE', `This correction is ${c0.request_status}.`);
  const isAttendance = Boolean(c0.eq_attendance_id);
  const changes = isAttendance && body.changes !== undefined ? CORR.normalizeChanges(body.changes) : c0.proposed_changes;
  const delta = isAttendance ? await CORR.computeDelta(c0.eq_attendance_id, changes, req.user.user_id) : null;
  const override = clearOverride ? null : (d.amount_override !== undefined ? d.amount_override : c0.amount_override);
  if (override !== null && override !== undefined && !(d.override_reason || c0.override_reason)) throw AppError.validation({ override_reason: 'explain why the amount is not the computed one' });
  if (isAttendance && !delta.auto && (override === null || override === undefined)) {
    throw AppError.validation({ amount_override: 'this row was not paid by a finalized batch: give the amount to settle (0 if none)' });
  }
  const byRequester = c0.corrected_by_user_id === req.user.user_id;
  await withTransaction(async (conn) => {
    const c = await loadCorrection(conn, id, true);
    if (!['Requested', 'Reviewed'].includes(c.request_status)) throw AppError.conflict('INVALID_STATE', `This correction is ${c.request_status}.`);
    const status = byRequester ? 'Requested' : 'Reviewed';
    if (isAttendance) {
      await conn.execute(
        `UPDATE eq_attendance_corrections SET proposed_changes = ?, corrected_values = ?, delta_amount = ?, delta_detail = ?, currency = COALESCE(?, currency),
           amount_override = ?, override_reason = ?, reviewed_by_user_id = ?, reviewed_at = ?, review_note = ?, request_status = ? WHERE correction_id = ?`,
        [JSON.stringify(changes), JSON.stringify(delta.after), delta.auto ? (delta.delta_cents / 100).toFixed(2) : null, JSON.stringify(delta), delta.currency || null,
          override ?? null, override === null || override === undefined ? null : (d.override_reason || c.override_reason),
          byRequester ? c.reviewed_by_user_id : req.user.user_id, byRequester ? c.reviewed_at : businessNow(), d.note, status, id]);
    } else {
      await conn.execute(
        `UPDATE eq_attendance_corrections SET amount_override = ?, override_reason = ?, reviewed_by_user_id = ?, reviewed_at = ?, review_note = ?, request_status = ?
         WHERE correction_id = ?`,
        [override ?? null, override === null || override === undefined ? null : (d.override_reason || c.override_reason),
          byRequester ? c.reviewed_by_user_id : req.user.user_id, byRequester ? c.reviewed_at : businessNow(), d.note, status, id]);
    }
    await corrEvent(conn, id, byRequester ? 'amend' : 'review', req, d.note, { changes, delta_cents: delta && delta.auto ? delta.delta_cents : null, amount_override: override ?? null });
    await audit.log(conn, { table: 'eq_attendance_corrections', id, action: byRequester ? 'amend' : 'review', newValues: { changes, amount_override: override ?? null }, reason: d.note, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await correctionView(pool, id) });
};

/** Send it back to the person who wrote the version on the table, with a note (as many times as needed). */
exports.returnCorrection = async (req, res) => {
  const id = parseId(req.params.id);
  const { note } = validate(req.body, { note: v.string({ required: true, max: 1000 }) });
  await withTransaction(async (conn) => {
    const c = await loadCorrection(conn, id, true);
    if (!['Requested', 'Reviewed'].includes(c.request_status)) throw AppError.conflict('INVALID_STATE', `This correction is ${c.request_status}.`);
    if (lastAuthor(c) === req.user.user_id) throw AppError.conflict('INVALID_STATE', 'You wrote this version: amend it or cancel it instead.');
    await conn.execute("UPDATE eq_attendance_corrections SET request_status = 'Requested', return_count = return_count + 1, reviewed_by_user_id = NULL WHERE correction_id = ?", [id]);
    await corrEvent(conn, id, 'return', req, note);
    await audit.log(conn, { table: 'eq_attendance_corrections', id, action: 'return', reason: note, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await correctionView(pool, id) });
};

/** Issue the note and the settlement adjustment (inside the caller's transaction). */
async function settle(conn, req, c, cents, { equipmentId, siteId, vendorId, batchId, itemId, currency, refText }) {
  if (cents === 0) return { adjustmentId: null, noteId: null };
  const date = await CORR.firstOpenDate(conn, equipmentId, siteId);
  const n = await CORR.issueNote(conn, { kind: cents > 0 ? 'DebitNote' : 'CreditNote', batchId, vendorId, equipmentId, itemId, currency, amountCents: cents });
  const [a] = await conn.execute(
    `INSERT INTO eq_adjustments (equipment_id, site_id, adjustment_date, adjustment_type, amount, currency, reason, correction_id, created_by_user_id)
     VALUES (?, ?, ?, 'Correction', ?, ?, ?, ?, ?)`,
    [equipmentId, siteId, date, (cents / 100).toFixed(2), currency, `${n.invoice_no} - ${refText}: ${c.reason}`.slice(0, 500), c.correction_id, req.user.user_id]);
  await audit.log(conn, { table: 'eq_adjustments', id: a.insertId, action: 'create_settlement', newValues: { amount: cents / 100, currency, adjustment_date: date, note: n.invoice_no },
    relatedType: 'eq_attendance_corrections', relatedId: c.correction_id, payrollEffect: `adjustment:${a.insertId}`, ...audit.ctx(req) });
  return { adjustmentId: a.insertId, noteId: n.invoice_id };
}

/** Approve (by someone other than the author of the version on the table): the record is corrected, the difference settled. */
exports.approveCorrection = async (req, res) => {
  const id = parseId(req.params.id);
  const { note } = validate(req.body, { note: v.string({ max: 1000 }) });
  const c0 = await loadCorrection(pool, id);
  if (!['Requested', 'Reviewed'].includes(c0.request_status)) throw AppError.conflict('INVALID_STATE', `This correction is ${c0.request_status}.`);
  assertMayApprove(c0, req.user);
  const delta = c0.eq_attendance_id ? await CORR.computeDelta(c0.eq_attendance_id, c0.proposed_changes, req.user.user_id) : null; // fresh numbers
  await withTransaction(async (conn) => {
    const c = await loadCorrection(conn, id, true);
    if (!['Requested', 'Reviewed'].includes(c.request_status)) throw AppError.conflict('INVALID_STATE', `This correction is ${c.request_status}.`);
    assertMayApprove(c, req.user);
    const override = c.amount_override !== null && c.amount_override !== undefined;
    let settled = { adjustmentId: null, noteId: null }; let cents = 0; let afterValues = c.corrected_values;
    if (c.eq_attendance_id) {
      if (!delta.auto && !override) throw AppError.validation({ amount_override: 'this row was not paid by a finalized batch: amend the correction with the amount to settle (0 if none)' });
      const before = await S.loadRow(conn, c.eq_attendance_id, true);
      const changes = c.proposed_changes || {};
      await CORR.applyChanges(conn, c.eq_attendance_id, changes, req.user.user_id);
      if (touchesPaper(changes)) await resetPaper(conn, before, req.user.user_id);
      if (changes.cancel_row) {
        await conn.execute("UPDATE eq_attendance SET status = 'Cancelled', cancelled_by_user_id = ?, cancelled_at = ?, cancel_reason = ? WHERE eq_attendance_id = ?",
          [req.user.user_id, businessNow(), `Correction #${id}: ${c.reason}`.slice(0, 1000), c.eq_attendance_id]);
      } else if (before.status !== 'Approved') {
        // a late / stuck row inside the closed period: the office accepted its corrected values and settles them here
        await conn.execute("UPDATE eq_attendance SET status = 'Approved', approved_by_user_id = ?, approval_date = ?, admin_rejection_notes = NULL WHERE eq_attendance_id = ?",
          [req.user.user_id, businessNow(), c.eq_attendance_id]);
      }
      const afterRow = await S.loadRow(conn, c.eq_attendance_id);
      afterValues = pick(afterRow);
      cents = override ? Math.round(Number(c.amount_override) * 100) : (delta.auto ? delta.delta_cents : 0);
      const item = await CORR.paidItemOf(conn, c.eq_attendance_id);
      const [[b]] = await conn.execute('SELECT eq_batch_id, currency FROM eq_payroll_batches WHERE eq_batch_id = ?', [item ? item.eq_batch_id : c.locked_batch_id]);
      const currency = b.currency;
      const ref = item && item.invoice_no ? `invoice ${item.invoice_no}` : `batch #${b.eq_batch_id}`;
      settled = await settle(conn, req, c, cents, {
        equipmentId: before.equipment_id, siteId: before.site_id, vendorId: before.vendor_id, batchId: b.eq_batch_id, itemId: item ? item.eq_item_id : null, currency,
        refText: `correction of ${ref}, sheet row ${before.sheet_row_no} (${before.record_date})${changes.cancel_row ? ' cancelled' : ''}`,
      });
      await audit.log(conn, { table: 'eq_attendance', id: c.eq_attendance_id, action: 'correction', oldValues: pick(before), newValues: afterValues, reason: c.reason,
        relatedType: 'eq_attendance_corrections', relatedId: id, payrollEffect: settled.adjustmentId ? `adjustment:${settled.adjustmentId}` : `correction:${id}`, ...audit.ctx(req) });
    } else {
      const detail = c.delta_detail || {};
      cents = override ? Math.round(Number(c.amount_override) * 100) : Number(detail.delta_cents || 0);
      const [[eq]] = await conn.execute('SELECT vendor_id FROM eq_equipment WHERE equipment_id = ?', [detail.equipment_id]);
      const [[b]] = await conn.execute('SELECT eq_batch_id, currency FROM eq_payroll_batches WHERE eq_batch_id = ?', [c.locked_batch_id]);
      const currency = detail.currency || b.currency;
      let ref = `batch #${b.eq_batch_id}`;
      if (c.eq_item_id) {
        const [[inv]] = await conn.execute("SELECT invoice_no FROM eq_invoices WHERE eq_item_id = ? AND kind = 'Machine' LIMIT 1", [c.eq_item_id]);
        if (inv) ref = `invoice ${inv.invoice_no}`;
      }
      if (c.target_type === 'fuel_issue' && detail.fuel_changes) {
        const [[f]] = await conn.execute('SELECT * FROM eq_fuel_issues WHERE fuel_issue_id = ? FOR UPDATE', [c.target_id]);
        const keys = Object.keys(detail.fuel_changes);
        await conn.execute(`UPDATE eq_fuel_issues SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE fuel_issue_id = ?`, [...keys.map((k) => detail.fuel_changes[k]), c.target_id]);
        await audit.log(conn, { table: 'eq_fuel_issues', id: c.target_id, action: 'correction', oldValues: { liters: f.liters, price_per_liter: f.price_per_liter },
          newValues: detail.fuel_changes, reason: c.reason, relatedType: 'eq_attendance_corrections', relatedId: id, ...audit.ctx(req) });
      }
      settled = await settle(conn, req, c, cents, {
        equipmentId: detail.equipment_id, siteId: detail.site_id, vendorId: eq.vendor_id, batchId: b.eq_batch_id, itemId: c.eq_item_id, currency,
        refText: `correction of ${ref}, ${c.target_type.replace('_', ' ')}${c.target_id ? ` #${c.target_id}` : ''}`,
      });
    }
    await conn.execute(
      `UPDATE eq_attendance_corrections SET request_status = 'Approved', approved_by_user_id = ?, approved_at = ?, corrected_values = ?,
         delta_amount = COALESCE(?, delta_amount), delta_detail = COALESCE(?, delta_detail), note_invoice_id = ?, resolved_adjustment_id = ?, adjustment_status = 'Resolved',
         resolved_by_user_id = ?, resolved_at = ?, resolution_note = ? WHERE correction_id = ?`,
      [req.user.user_id, businessNow(), JSON.stringify(afterValues), delta && delta.auto ? (delta.delta_cents / 100).toFixed(2) : null, delta ? JSON.stringify(delta) : null,
        settled.noteId, settled.adjustmentId, req.user.user_id, businessNow(), note || (cents === 0 ? 'No money difference' : null), id]);
    await corrEvent(conn, id, 'approve', req, note || null, { settled_cents: cents, adjustment_id: settled.adjustmentId });
    await audit.log(conn, { table: 'eq_attendance_corrections', id, action: 'approve', newValues: { settled_cents: cents, adjustment_id: settled.adjustmentId, note_invoice_id: settled.noteId },
      reason: note || null, payrollEffect: settled.adjustmentId ? `adjustment:${settled.adjustmentId}` : 'none', ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await correctionView(pool, id), message: 'Correction approved. The finalized payroll was not changed; the difference is settled in the next open period.' });
};

/** Cancel a correction still in progress: its requester, the person who amended it, or an Admin. */
exports.cancelCorrection = async (req, res) => {
  const id = parseId(req.params.id);
  const { note } = validate(req.body, { note: v.string({ required: true, max: 1000 }) });
  await withTransaction(async (conn) => {
    const c = await loadCorrection(conn, id, true);
    if (!['Requested', 'Reviewed'].includes(c.request_status)) throw AppError.conflict('INVALID_STATE', `This correction is ${c.request_status}.`);
    if (req.user.role !== 'Admin' && ![c.corrected_by_user_id, c.reviewed_by_user_id].includes(req.user.user_id)) {
      throw AppError.forbidden('FORBIDDEN_ROLE', 'Only the person who asked for it (or an Admin) can cancel this correction.');
    }
    await conn.execute("UPDATE eq_attendance_corrections SET request_status = 'Cancelled', adjustment_status = 'NotApplicable' WHERE correction_id = ?", [id]);
    await corrEvent(conn, id, 'cancel', req, note);
    await audit.log(conn, { table: 'eq_attendance_corrections', id, action: 'cancel', reason: note, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await correctionView(pool, id) });
};

exports.listCorrections = async (req, res) => {
  const where = []; const params = [];
  if (req.query.status) { where.push('c.adjustment_status = ?'); params.push(String(req.query.status)); }
  if (req.query.request_status) {
    const list = String(req.query.request_status).split(',').filter((x) => ['Requested', 'Reviewed', 'Approved', 'Cancelled'].includes(x));
    if (list.length) { where.push(`c.request_status IN (${list.map(() => '?').join(',')})`); params.push(...list); }
  }
  const [rows] = await pool.query(
    `SELECT c.*, ea.record_date, ea.sheet_row_no, COALESCE(ea.equipment_id, e2.equipment_id) AS equipment_id, ea.site_id,
       COALESCE(e.equipment_code, e2.equipment_code) AS equipment_code, s.site_code, u.full_name AS corrected_by,
       rv.full_name AS reviewed_by, ap.full_name AS approved_by, ni.invoice_no AS note_invoice_no, ni.kind AS note_kind
     FROM eq_attendance_corrections c LEFT JOIN eq_attendance ea ON ea.eq_attendance_id = c.eq_attendance_id
     LEFT JOIN eq_equipment e ON e.equipment_id = ea.equipment_id LEFT JOIN sites s ON s.site_id = ea.site_id
     LEFT JOIN eq_payroll_items pi ON pi.eq_item_id = c.eq_item_id
     LEFT JOIN eq_equipment e2 ON e2.equipment_id = COALESCE(pi.equipment_id, JSON_UNQUOTE(JSON_EXTRACT(c.delta_detail, '$.equipment_id')))
     JOIN users u ON u.user_id = c.corrected_by_user_id
     LEFT JOIN users rv ON rv.user_id = c.reviewed_by_user_id LEFT JOIN users ap ON ap.user_id = c.approved_by_user_id
     LEFT JOIN eq_invoices ni ON ni.invoice_id = c.note_invoice_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY c.correction_id DESC LIMIT 500`, params);
  for (const r of rows) {
    for (const k of ['original_values', 'corrected_values', 'proposed_changes', 'delta_detail']) r[k] = C.parseJson(r[k]);
    r.last_author_user_id = lastAuthor(r);
    r.can_approve = ['Requested', 'Reviewed'].includes(r.request_status) && OFFICE.includes(req.user.role) && r.last_author_user_id !== req.user.user_id;
  }
  res.json({ status: 'success', data: rows });
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
