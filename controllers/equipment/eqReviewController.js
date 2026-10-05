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
  const lockedBy = await lock.findLock(pool, view);
  res.json({ status: 'success', data: { ...view, standby_credit: standby, locked_by_batch_id: lockedBy ? lockedBy.eq_batch_id : null, paper_checks: checks, corrections, history } });
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
const resetPaper = (conn, row, userId) => att.resetPaper(conn, row, userId);

/**
 * Admin edit of a row that is not in a finalized period: any field, the day status and the downtime list.
 * An Approved row stays Approved but is flagged "edited after approval" (reason required); a batch already
 * generated (not finalized) over it becomes out of date and must be regenerated.
 */
exports.adminEdit = async (req, res) => {
  const id = parseId(req.params.id);
  const body = req.body || {};
  const { reason } = validate(body, { reason: v.string({ max: 1000 }) });
  if (body.standby_credit_hours !== undefined) throw AppError.validation({ standby_credit_hours: 'use the standby hours action' });
  const changes = CORR.normalizeChanges(body);
  delete changes.standby_credit_hours;
  if (!Object.keys(changes).length) throw AppError.validation({ changes: 'nothing to change' });
  await withTransaction(async (conn) => {
    const row = await S.loadRow(conn, id, true);
    await lock.assertEqEditable(conn, row);
    const approved = row.status === 'Approved';
    if (approved && (!reason || reason.trim().length < 5)) throw AppError.validation({ reason: 'explain why an approved row is changed (at least 5 characters)' });
    const status = changes.day_status || row.day_status;
    if (status !== 'Working' && (changes.operator_id || changes.meter_start !== undefined || changes.meter_end !== undefined)) {
      throw AppError.conflict('INVALID_STATE', `A ${status} row has no operator or meter readings.`);
    }
    for (const k of ['check_in_time', 'check_out_time']) if (changes[k]) att.assertNotFutureTime(changes[k], k);
    if (changes.operator_id) await att.assertOperatorUsable(conn, changes.operator_id, row);
    const after = await CORR.applyChanges(conn, id, changes, req.user.user_id);
    await resetPaper(conn, row, req.user.user_id);
    if (approved) {
      await conn.execute('UPDATE eq_attendance SET edited_after_approval = 1, admin_edit_reason = ?, admin_edit_by_user_id = ?, admin_edit_at = ? WHERE eq_attendance_id = ?',
        [reason.trim(), req.user.user_id, businessNow(), id]);
    }
    await audit.log(conn, {
      table: 'eq_attendance', id, action: approved ? 'admin_edit_after_approval' : 'admin_edit', oldValues: row, newValues: { changes, after }, reason: reason || null, ...audit.ctx(req),
    });
  });
  res.json({ status: 'success', data: await att.rowView(pool, id) });
};

// ------------------------------------------------------------------ official corrections (finalized periods)

const PICK = ['day_status', 'check_in_time', 'check_out_time', 'operator_id', 'meter_start', 'meter_end', 'work_description', 'remarks',
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

/** Step 1 — the Admin asks for a correction of a row inside a finalized period. Nothing changes yet. */
exports.correction = async (req, res) => {
  const id = parseId(req.params.id);
  const body = req.body || {};
  const { reason } = validate(body, { reason: v.string({ required: true, min: 5, max: 1000 }) });
  const changes = CORR.normalizeChanges(body.changes);
  const row = await S.loadRow(pool, id);
  const lockedBy = await lock.findLock(pool, row);
  if (!lockedBy) throw AppError.conflict('NOT_LOCKED', 'This row is not in a finalized period; edit it normally.');
  const delta = await CORR.computeDelta(id, changes, req.user.user_id); // validates the changes on a dry run
  const out = await withTransaction(async (conn) => {
    const [[open]] = await conn.execute("SELECT correction_id FROM eq_attendance_corrections WHERE eq_attendance_id = ? AND request_status IN ('Requested','Reviewed') LIMIT 1", [id]);
    if (open) throw AppError.conflict('CORRECTION_PENDING', `Correction #${open.correction_id} of this row is still in progress.`);
    const [r] = await conn.execute(
      `INSERT INTO eq_attendance_corrections (eq_attendance_id, original_values, corrected_values, proposed_changes, reason, request_status, locked_batch_id,
         payroll_effect, adjustment_status, delta_amount, delta_detail, currency, corrected_by_user_id, corrected_at)
       VALUES (?, ?, ?, ?, ?, 'Requested', ?, 'AdjustmentRequired', 'Open', ?, ?, ?, ?, ?)`,
      [id, JSON.stringify(pick(row)), JSON.stringify(delta.after), JSON.stringify(changes), reason, lockedBy.eq_batch_id,
        delta.auto ? (delta.delta_cents / 100).toFixed(2) : null, JSON.stringify(delta), delta.currency || null, req.user.user_id, businessNow()]);
    await corrEvent(conn, r.insertId, 'request', req, reason, { changes, delta_cents: delta.auto ? delta.delta_cents : null });
    await audit.log(conn, { table: 'eq_attendance_corrections', id: r.insertId, action: 'request', newValues: { eq_attendance_id: id, changes }, reason, ...audit.ctx(req) });
    return r.insertId;
  });
  res.status(201).json({ status: 'success', data: await correctionView(pool, out), message: 'Correction requested. The accountant reviews it, then you approve it.' });
};

async function correctionView(conn, id) {
  const c = await loadCorrection(conn, id);
  const [ev] = await conn.execute(
    `SELECT e.action, e.note, e.data, e.created_at, u.full_name AS user_name FROM eq_correction_events e JOIN users u ON u.user_id = e.user_id
     WHERE e.correction_id = ? ORDER BY e.event_id`, [id]);
  const [[note]] = c.note_invoice_id ? await conn.execute('SELECT invoice_no, kind, amount, currency, issued_at FROM eq_invoices WHERE invoice_id = ?', [c.note_invoice_id]) : [[null]];
  const [[ctx]] = await conn.execute(
    `SELECT ea.record_date, ea.sheet_row_no, ea.equipment_id, ea.site_id, e.equipment_code, s.site_code FROM eq_attendance ea
     JOIN eq_equipment e ON e.equipment_id = ea.equipment_id JOIN sites s ON s.site_id = ea.site_id WHERE ea.eq_attendance_id = ?`, [c.eq_attendance_id]);
  const amount = c.amount_override !== null && c.amount_override !== undefined ? c.amount_override : c.delta_amount;
  return { ...c, ...ctx, settle_amount: amount, note, events: ev.map((x) => ({ ...x, data: C.parseJson(x.data) })) };
}

exports.getCorrection = async (req, res) => {
  res.json({ status: 'success', data: await correctionView(pool, parseId(req.params.id)) });
};

/** Step 2 — the Accountant checks it, may change the changes or the amount, and sends it to the Admin. */
exports.reviewCorrection = async (req, res) => {
  const id = parseId(req.params.id);
  const body = req.body || {};
  const d = validate(body, { note: v.string({ required: true, max: 1000 }), amount_override: v.number({ min: -99999999, max: 99999999, decimals: 2 }), override_reason: v.string({ max: 1000 }) });
  const clearOverride = body.amount_override === null;
  const c0 = await loadCorrection(pool, id);
  if (c0.request_status !== 'Requested') throw AppError.conflict('INVALID_STATE', `This correction is ${c0.request_status}.`);
  const changes = body.changes !== undefined ? CORR.normalizeChanges(body.changes) : c0.proposed_changes;
  const delta = await CORR.computeDelta(c0.eq_attendance_id, changes, req.user.user_id);
  const override = clearOverride ? null : (d.amount_override !== undefined ? d.amount_override : c0.amount_override);
  if (override !== null && override !== undefined && !(d.override_reason || c0.override_reason)) throw AppError.validation({ override_reason: 'explain why the amount is not the computed one' });
  if (!delta.auto && (override === null || override === undefined)) throw AppError.validation({ amount_override: 'this row was not paid by a finalized batch: give the amount to settle (0 if none)' });
  await withTransaction(async (conn) => {
    const c = await loadCorrection(conn, id, true);
    if (c.request_status !== 'Requested') throw AppError.conflict('INVALID_STATE', `This correction is ${c.request_status}.`);
    await conn.execute(
      `UPDATE eq_attendance_corrections SET proposed_changes = ?, corrected_values = ?, delta_amount = ?, delta_detail = ?, currency = COALESCE(?, currency),
         amount_override = ?, override_reason = ?, reviewed_by_user_id = ?, reviewed_at = ?, review_note = ?, request_status = 'Reviewed' WHERE correction_id = ?`,
      [JSON.stringify(changes), JSON.stringify(delta.after), delta.auto ? (delta.delta_cents / 100).toFixed(2) : null, JSON.stringify(delta), delta.currency || null,
        override ?? null, override === null || override === undefined ? null : (d.override_reason || c.override_reason), req.user.user_id, businessNow(), d.note, id]);
    await corrEvent(conn, id, 'review', req, d.note, { changes, delta_cents: delta.auto ? delta.delta_cents : null, amount_override: override ?? null });
    await audit.log(conn, { table: 'eq_attendance_corrections', id, action: 'review', newValues: { changes, amount_override: override ?? null }, reason: d.note, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await correctionView(pool, id) });
};

/** The Admin sends it back to the Accountant (as many times as needed). */
exports.returnCorrection = async (req, res) => {
  const id = parseId(req.params.id);
  const { note } = validate(req.body, { note: v.string({ required: true, max: 1000 }) });
  await withTransaction(async (conn) => {
    const c = await loadCorrection(conn, id, true);
    if (c.request_status !== 'Reviewed') throw AppError.conflict('INVALID_STATE', 'Only a reviewed correction can be returned.');
    await conn.execute("UPDATE eq_attendance_corrections SET request_status = 'Requested', return_count = return_count + 1 WHERE correction_id = ?", [id]);
    await corrEvent(conn, id, 'return', req, note);
    await audit.log(conn, { table: 'eq_attendance_corrections', id, action: 'return', reason: note, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await correctionView(pool, id) });
};

/** Step 3 — the Admin approves: the row is corrected, the difference is settled in the first open period with a note number. */
exports.approveCorrection = async (req, res) => {
  const id = parseId(req.params.id);
  const { note } = validate(req.body, { note: v.string({ max: 1000 }) });
  const c0 = await loadCorrection(pool, id);
  if (c0.request_status !== 'Reviewed') throw AppError.conflict('INVALID_STATE', 'The accountant must review this correction first.');
  const delta = await CORR.computeDelta(c0.eq_attendance_id, c0.proposed_changes, req.user.user_id); // fresh numbers
  await withTransaction(async (conn) => {
    const c = await loadCorrection(conn, id, true);
    if (c.request_status !== 'Reviewed') throw AppError.conflict('INVALID_STATE', `This correction is ${c.request_status}.`);
    const before = await S.loadRow(conn, c.eq_attendance_id, true);
    const after = await CORR.applyChanges(conn, c.eq_attendance_id, c.proposed_changes, req.user.user_id);
    await resetPaper(conn, before, req.user.user_id);
    const cents = c.amount_override !== null && c.amount_override !== undefined ? Math.round(Number(c.amount_override) * 100) : (delta.auto ? delta.delta_cents : 0);
    let adjustmentId = null; let noteId = null;
    if (cents !== 0) {
      const item = await CORR.paidItemOf(conn, c.eq_attendance_id);
      const [[b]] = await conn.execute('SELECT eq_batch_id, currency FROM eq_payroll_batches WHERE eq_batch_id = ?', [item ? item.eq_batch_id : c.locked_batch_id]);
      const date = await CORR.firstOpenDate(conn, before.equipment_id, before.site_id);
      const n = await CORR.issueNote(conn, { kind: cents > 0 ? 'DebitNote' : 'CreditNote', batchId: b.eq_batch_id, vendorId: before.vendor_id,
        equipmentId: before.equipment_id, itemId: item ? item.eq_item_id : null, currency: b.currency, amountCents: cents });
      noteId = n.invoice_id;
      const ref = item && item.invoice_no ? `invoice ${item.invoice_no}` : `batch #${b.eq_batch_id}`;
      const [a] = await conn.execute(
        `INSERT INTO eq_adjustments (equipment_id, site_id, adjustment_date, adjustment_type, amount, currency, reason, correction_id, created_by_user_id)
         VALUES (?, ?, ?, 'Correction', ?, ?, ?, ?, ?)`,
        [before.equipment_id, before.site_id, date, (cents / 100).toFixed(2), b.currency,
          `${n.invoice_no} - correction of ${ref}, sheet row ${before.sheet_row_no} (${before.record_date}): ${c.reason}`.slice(0, 500), id, req.user.user_id]);
      adjustmentId = a.insertId;
    }
    await conn.execute(
      `UPDATE eq_attendance_corrections SET request_status = 'Approved', approved_by_user_id = ?, approved_at = ?, corrected_values = ?,
         delta_amount = ?, delta_detail = ?, note_invoice_id = ?, resolved_adjustment_id = ?, adjustment_status = ?, resolved_by_user_id = ?, resolved_at = ?,
         resolution_note = ? WHERE correction_id = ?`,
      [req.user.user_id, businessNow(), JSON.stringify(pick(after)), delta.auto ? (delta.delta_cents / 100).toFixed(2) : c.delta_amount, JSON.stringify(delta),
        noteId, adjustmentId, 'Resolved', req.user.user_id, businessNow(), note || (cents === 0 ? 'No money difference' : null), id]);
    await corrEvent(conn, id, 'approve', req, note || null, { settled_cents: cents, adjustment_id: adjustmentId });
    await audit.log(conn, { table: 'eq_attendance', id: c.eq_attendance_id, action: 'correction', oldValues: pick(before), newValues: pick(after), reason: c.reason, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await correctionView(pool, id), message: 'Correction approved. The finalized payroll was not changed; the difference is settled in the next period.' });
};

exports.cancelCorrection = async (req, res) => {
  const id = parseId(req.params.id);
  const { note } = validate(req.body, { note: v.string({ required: true, max: 1000 }) });
  await withTransaction(async (conn) => {
    const c = await loadCorrection(conn, id, true);
    if (!['Requested', 'Reviewed'].includes(c.request_status)) throw AppError.conflict('INVALID_STATE', `This correction is ${c.request_status}.`);
    await conn.execute("UPDATE eq_attendance_corrections SET request_status = 'Cancelled', adjustment_status = 'NotApplicable' WHERE correction_id = ?", [id]);
    await corrEvent(conn, id, 'cancel', req, note);
    await audit.log(conn, { table: 'eq_attendance_corrections', id, action: 'cancel', reason: note, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await correctionView(pool, id) });
};

exports.listCorrections = async (req, res) => {
  const where = []; const params = [];
  if (req.query.status) { where.push('c.adjustment_status = ?'); params.push(String(req.query.status)); }
  if (req.query.request_status) { where.push('c.request_status = ?'); params.push(String(req.query.request_status)); }
  const [rows] = await pool.query(
    `SELECT c.*, ea.record_date, ea.sheet_row_no, ea.equipment_id, ea.site_id, e.equipment_code, s.site_code, u.full_name AS corrected_by,
       rv.full_name AS reviewed_by, ap.full_name AS approved_by, ni.invoice_no AS note_invoice_no, ni.kind AS note_kind
     FROM eq_attendance_corrections c JOIN eq_attendance ea ON ea.eq_attendance_id = c.eq_attendance_id
     JOIN eq_equipment e ON e.equipment_id = ea.equipment_id JOIN sites s ON s.site_id = ea.site_id
     JOIN users u ON u.user_id = c.corrected_by_user_id
     LEFT JOIN users rv ON rv.user_id = c.reviewed_by_user_id LEFT JOIN users ap ON ap.user_id = c.approved_by_user_id
     LEFT JOIN eq_invoices ni ON ni.invoice_id = c.note_invoice_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY c.correction_id DESC LIMIT 500`, params);
  for (const r of rows) { for (const k of ['original_values', 'corrected_values', 'proposed_changes', 'delta_detail']) r[k] = C.parseJson(r[k]); }
  res.json({ status: 'success', data: rows });
};

exports.resolveCorrection = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body, { adjustment_id: v.id(), resolution_note: v.string({ required: true, max: 1000 }) });
  await withTransaction(async (conn) => {
    const [[c]] = await conn.execute('SELECT * FROM eq_attendance_corrections WHERE correction_id = ? FOR UPDATE', [id]);
    if (!c) throw AppError.notFound('Correction');
    if (c.adjustment_status !== 'Open') throw AppError.conflict('INVALID_STATE', 'This correction is not open.');
    if (c.request_status !== 'Approved') throw AppError.conflict('INVALID_STATE', 'Use review and approve: this correction is still in the approval flow.');
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
