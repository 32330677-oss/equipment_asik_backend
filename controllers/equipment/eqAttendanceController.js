// Supervisor recording of machine attendance (document 03 §5.5; BR-11..BR-22, BR-25).
const { pool, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { v, validate, parseId } = require('../../utils/validate');
const audit = require('../../services/audit');
const { businessToday, businessNow, addDays, monthOf } = require('../../utils/businessDate');
const { datePart, addMinutes, wallMs } = require('../../utils/dateTime');
const { assertCanActOnSite, supervisorSitesOn } = require('../../services/siteAccess');
const C = require('../../services/equipment/eqCommon');
const S = require('../../services/equipment/eqAttendanceService');
const lock = require('../../services/equipment/eqLock');
const sheets = require('../../services/equipment/eqTimesheetService');
const weekGate = require('../../services/equipment/weekGate');

const FUTURE_TOLERANCE_MIN = 5;
const SHIFT = v.enumOf(['Day', 'Night'], { default: 'Day' });

function assertNotFutureTime(value, field) {
  const limit = addMinutes(businessNow(), FUTURE_TOLERANCE_MIN);
  if (wallMs(value) > wallMs(limit)) throw AppError.badRequest('FUTURE_TIME', `${field} cannot be in the future.`);
}
function assertNotFutureDate(date) {
  if (date > businessToday()) throw AppError.badRequest('FUTURE_DATE', 'The date cannot be in the future.');
}
function assertEditableStatus(row) {
  if (!['Draft', 'Rejected'].includes(row.status)) {
    throw AppError.conflict('INVALID_STATE', `This row is ${row.status}. Only Draft or Rejected rows can be changed here.`);
  }
}

/** Loads a row for a recording action and checks: site permission on its date, editable status, payroll lock. */
async function rowForAction(conn, req, id) {
  const row = await S.loadRow(conn, id, true);
  await assertCanActOnSite(req.user, row.site_id, row.shift_type, row.record_date, conn);
  assertEditableStatus(row);
  await lock.assertEqEditable(conn, row);
  return row;
}

async function assertOperatorUsable(conn, operatorId, row) {
  const op = await C.loadOperator(conn, operatorId);
  if (op.vendor_id !== row.vendor_id) throw AppError.badRequest('OPERATOR_OTHER_VENDOR', 'The operator belongs to another vendor.');
  if (op.status !== 'Active') throw AppError.badRequest('OPERATOR_INACTIVE', 'The operator is Inactive.');
  return op;
}

/** Create a new attendance row with its permanent sheet row number. */
async function insertRow(conn, req, data) {
  const sheet = await sheets.getOrCreate(conn, data.equipment_id, data.site_id, monthOf(data.record_date));
  const rowNo = await sheets.allocateRow(conn, sheet);
  const [r] = await conn.execute(
    `INSERT INTO eq_attendance (equipment_id, site_id, shift_type, record_date, day_status, operator_id, check_in_time, check_out_time,
       meter_start, meter_end, remarks, status, recorded_by_user_id, timesheet_id, sheet_row_no)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Draft', ?, ?, ?)`,
    [data.equipment_id, data.site_id, data.shift_type, data.record_date, data.day_status, data.operator_id || null,
      data.check_in_time || null, data.check_out_time || null, data.meter_start ?? null, data.meter_end ?? null,
      data.remarks || null, req.user.user_id, sheet.timesheet_id, rowNo]);
  return r.insertId;
}

/** The day-board representation of one row. */
async function rowView(conn, id) {
  const row = await S.loadRow(conn, id);
  const periods = await S.loadDowntime(conn, id);
  const open = periods.find((p) => !p.end_time) || null;
  const [[sheet]] = await conn.execute('SELECT timesheet_id, sheet_code, status FROM eq_timesheets WHERE timesheet_id = ?', [row.timesheet_id]);
  let operatorName = null;
  if (row.operator_id) { const [[op]] = await conn.execute('SELECT full_name FROM eq_operators WHERE operator_id = ?', [row.operator_id]); operatorName = op ? op.full_name : null; }
  return {
    eq_attendance_id: row.eq_attendance_id, equipment_id: row.equipment_id, equipment_code: row.equipment_code, type_name: row.type_name,
    vendor_id: row.vendor_id, site_id: row.site_id, site_code: row.site_code, site_name: row.site_name, shift_type: row.shift_type, record_date: row.record_date, day_status: row.day_status, status: row.status,
    operator_id: row.operator_id, operator_name: operatorName, check_in_time: row.check_in_time, check_out_time: row.check_out_time,
    meter_start: row.meter_start, meter_end: row.meter_end, gross_minutes: row.gross_minutes, break_minutes: row.break_minutes,
    breakdown_minutes: row.breakdown_minutes, standby_minutes: row.standby_minutes, working_minutes: row.working_minutes,
    standby_credit_minutes: row.standby_credit_minutes ?? null, standby_credit_at: row.standby_credit_at ?? null, standby_credit_note: row.standby_credit_note ?? null,
    work_description: row.work_description, remarks: row.remarks, admin_rejection_notes: row.admin_rejection_notes,
    anomaly_code: row.anomaly_code, anomaly_detail: row.anomaly_detail, anomaly_acknowledged: Boolean(row.anomaly_ack_at),
    edited_after_approval: Boolean(row.edited_after_approval), admin_edit_reason: row.admin_edit_reason ?? null, admin_edit_at: row.admin_edit_at ?? null,
    paper_status: row.paper_status, sheet: sheet ? { ...sheet, sheet_row_no: row.sheet_row_no } : null,
    open_downtime: open, downtime: periods, live_state: S.liveState(row, open),
  };
}

// ------------------------------------------------------------------ reads
exports.mySites = async (req, res) => {
  const date = req.query.date || businessToday();
  if (req.user.role === 'Admin') {
    const [rows] = await pool.query(
      `SELECT site_id, site_code, site_name, 'Day' AS shift_type, status FROM sites WHERE status = 'Active'
       UNION ALL SELECT site_id, site_code, site_name, 'Night', status FROM sites WHERE status = 'Active' AND has_night_shift = 1
       ORDER BY site_code, shift_type`);
    return res.json({ status: 'success', data: rows, meta: { date } });
  }
  const sites = await supervisorSitesOn(req.user.user_id, date);
  for (const s of sites) {
    const [[c]] = await pool.execute(
      `SELECT COUNT(*) AS n FROM eq_site_assignments WHERE site_id = ? AND shift_type = ? AND assigned_date <= ? AND (unassigned_date IS NULL OR unassigned_date >= ?)`,
      [s.site_id, s.shift_type, date, date]);
    s.deployed_machines = Number(c.n);
  }
  return res.json({ status: 'success', data: sites, meta: { date } });
};

exports.siteDay = async (req, res) => {
  const siteId = parseId(req.params.siteId, 'site');
  const q = validate(req.query, { date: v.date({ default: businessToday() }), shift: SHIFT });
  const date = q.date; const shift = q.shift;
  await assertCanActOnSite(req.user, siteId, shift, date);
  const site = await C.loadSite(pool, siteId);
  const [machines] = await pool.execute(
    `SELECT e.equipment_id, e.equipment_code, e.plate_number, e.make, e.model, t.type_name, t.type_name_ar, t.meter_unit,
            v.vendor_id, v.vendor_name, a.eq_assignment_id, a.default_operator_id, o.full_name AS default_operator_name
     FROM eq_site_assignments a JOIN eq_equipment e ON e.equipment_id = a.equipment_id AND e.status = 'Active'
     JOIN eq_types t ON t.type_id = e.type_id JOIN eq_vendors v ON v.vendor_id = e.vendor_id
     LEFT JOIN eq_operators o ON o.operator_id = a.default_operator_id
     WHERE a.site_id = ? AND a.shift_type = ? AND a.assigned_date <= ? AND (a.unassigned_date IS NULL OR a.unassigned_date >= ?)
     ORDER BY t.type_name, e.equipment_code`, [siteId, shift, date, date]);
  const ids = machines.map((m) => m.equipment_id);
  const byMachine = {};
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    // today's rows + a still-open row of the previous day (night shift crossing midnight)
    const [rows] = await pool.query(
      `SELECT eq_attendance_id, equipment_id, record_date FROM eq_attendance
       WHERE site_id = ? AND shift_type = ? AND equipment_id IN (${ph})
         AND (record_date = ? OR (record_date = ? AND check_in_time IS NOT NULL AND check_out_time IS NULL))
       ORDER BY record_date`, [siteId, shift, ...ids, date, addDays(date, -1)]);
    for (const r of rows) {
      const view = await rowView(pool, r.eq_attendance_id);
      view.from_previous_day = r.record_date !== date;
      if (!byMachine[r.equipment_id] || view.from_previous_day) byMachine[r.equipment_id] = view;
    }
    const [meters] = await pool.query(
      `SELECT equipment_id, meter_end FROM eq_attendance x WHERE equipment_id IN (${ph}) AND meter_end IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM eq_attendance y WHERE y.equipment_id = x.equipment_id AND y.meter_end IS NOT NULL
                          AND (y.record_date > x.record_date OR (y.record_date = x.record_date AND y.eq_attendance_id > x.eq_attendance_id)))`, ids);
    for (const m of meters) { const mm = machines.find((x) => x.equipment_id === m.equipment_id); if (mm) mm.last_meter_end = m.meter_end; }
  }
  const summary = { deployed: machines.length, working: 0, on_break: 0, breakdown: 0, standby: 0, not_arrived: 0, finished: 0, absent: 0, holiday: 0 };
  const key = { Working: 'working', OnBreak: 'on_break', Breakdown: 'breakdown', Standby: 'standby', NotArrived: 'not_arrived', Finished: 'finished', Absent: 'absent', Holiday: 'holiday' };
  const out = machines.map((m) => {
    const att = byMachine[m.equipment_id] || null;
    const state = att ? att.live_state : 'NotArrived';
    summary[key[state]] += 1;
    return { ...m, last_meter_end: m.last_meter_end ?? null, live_state: state, attendance: att };
  });
  const order = { Breakdown: 0, NotArrived: 1, Standby: 2, OnBreak: 3, Working: 4, Finished: 5, Absent: 6, Holiday: 7 };
  out.sort((a, b) => order[a.live_state] - order[b.live_state] || a.equipment_code.localeCompare(b.equipment_code));
  const gate = await weekGate.previousWeekDrafts(pool, siteId, shift, date);
  const [[drafts]] = await pool.execute(
    "SELECT COUNT(*) AS n, SUM(day_status = 'Working' AND check_out_time IS NULL) AS open_rows FROM eq_attendance WHERE site_id = ? AND shift_type = ? AND record_date = ? AND status = 'Draft'",
    [siteId, shift, date]);
  const [[submitted]] = await pool.execute(
    "SELECT COUNT(*) AS n FROM eq_attendance WHERE site_id = ? AND shift_type = ? AND record_date = ? AND status = 'Submitted'", [siteId, shift, date]);
  res.json({
    status: 'success',
    data: {
      site: { site_id: site.site_id, site_code: site.site_code, site_name: site.site_name, shift_type: shift },
      date, summary, machines: out,
      submit: { draft_rows: Number(drafts.n), open_rows: Number(drafts.open_rows || 0), can_submit: Number(drafts.n) > 0 && !Number(drafts.open_rows || 0) && !gate.blocked, week_gate: gate, submitted_rows: Number(submitted.n) },
    },
  });
};

// ------------------------------------------------------------------ check-in
exports.checkIn = async (req, res) => {
  const d = validate(req.body, {
    equipment_id: v.id({ required: true }), site_id: v.id({ required: true }), shift_type: SHIFT,
    check_in_time: v.datetime({ required: true }), operator_id: v.id(),
    meter_start: v.number({ min: 0, max: 99999999, decimals: 1 }), remarks: v.string({ max: 2000 }),
  });
  const recordDate = datePart(d.check_in_time);
  assertNotFutureDate(recordDate);
  assertNotFutureTime(d.check_in_time, 'check_in_time');
  const id = await withTransaction(async (conn) => {
    await assertCanActOnSite(req.user, d.site_id, d.shift_type, recordDate, conn);
    const machine = await C.loadMachine(conn, d.equipment_id, true);
    if (machine.status !== 'Active') throw AppError.badRequest('MACHINE_NOT_ACTIVE', 'The machine is not Active.');
    const dep = await C.assertMachineDeployed(conn, d.equipment_id, d.site_id, d.shift_type, recordDate);
    await lock.assertEqEditable(conn, { equipment_id: d.equipment_id, vendor_id: machine.vendor_id, site_id: d.site_id, record_date: recordDate });
    await S.assertNoOpenSession(conn, d.equipment_id);
    await S.assertNoTimeOverlap(conn, d.equipment_id, d.check_in_time, null);
    const operatorId = d.operator_id || dep.default_operator_id || null;
    if (operatorId) await assertOperatorUsable(conn, operatorId, { vendor_id: machine.vendor_id });
    const [existing] = await conn.execute(
      'SELECT * FROM eq_attendance WHERE equipment_id = ? AND site_id = ? AND shift_type = ? AND record_date = ? FOR UPDATE',
      [d.equipment_id, d.site_id, d.shift_type, recordDate]);
    let rowId;
    if (existing[0]) {
      const ex = existing[0];
      const reusable = ['Draft', 'Rejected'].includes(ex.status) && !ex.check_in_time && ex.day_status !== 'Working';
      if (!reusable) throw AppError.conflict('ATTENDANCE_EXISTS', 'There is already a session for this machine on this date. Edit it instead.', { eq_attendance_id: ex.eq_attendance_id });
      await conn.execute(
        `UPDATE eq_attendance SET day_status = 'Working', check_in_time = ?, check_out_time = NULL, operator_id = ?, meter_start = ?, meter_end = NULL,
           remarks = COALESCE(?, remarks) WHERE eq_attendance_id = ?`,
        [d.check_in_time, operatorId, d.meter_start ?? null, d.remarks || null, ex.eq_attendance_id]);
      await conn.execute('DELETE FROM eq_downtime_periods WHERE eq_attendance_id = ?', [ex.eq_attendance_id]);
      rowId = ex.eq_attendance_id;
    } else {
      rowId = await insertRow(conn, req, {
        equipment_id: d.equipment_id, site_id: d.site_id, shift_type: d.shift_type, record_date: recordDate, day_status: 'Working',
        operator_id: operatorId, check_in_time: d.check_in_time, meter_start: d.meter_start, remarks: d.remarks,
      });
    }
    await S.recompute(conn, rowId);
    await audit.log(conn, { table: 'eq_attendance', id: rowId, action: 'check_in', newValues: { ...d, operator_id: operatorId }, ...audit.ctx(req) });
    return rowId;
  });
  res.status(201).json({ status: 'success', data: await rowView(pool, id) });
};

// ------------------------------------------------------------------ downtime
exports.downtimeStart = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body, {
    downtime_type: v.enumOf(['Break', 'Refuel', 'Breakdown', 'Standby'], { required: true }),
    start_time: v.datetime({ required: true }), end_time: v.datetime(), reason: v.string({ max: 500 }),
  });
  if ((d.downtime_type === 'Breakdown' || d.downtime_type === 'Standby') && !d.reason) {
    throw AppError.validation({ reason: `is required for ${d.downtime_type}` });
  }
  assertNotFutureTime(d.start_time, 'start_time');
  if (d.end_time) { assertNotFutureTime(d.end_time, 'end_time'); if (wallMs(d.end_time) <= wallMs(d.start_time)) throw AppError.validation({ end_time: 'must be after start_time' }); }
  await withTransaction(async (conn) => {
    const row = await rowForAction(conn, req, id);
    if (row.day_status !== 'Working' || !row.check_in_time) throw AppError.conflict('INVALID_STATE', 'Downtime can only be recorded on a checked-in Working row.');
    if (row.check_out_time && !d.end_time) throw AppError.validation({ end_time: 'is required when the session is already closed' });
    const periods = await S.loadDowntime(conn, id);
    S.assertPeriodsValid([...periods, { start_time: d.start_time, end_time: d.end_time || null }], row.check_in_time, row.check_out_time);
    const [r] = await conn.execute(
      'INSERT INTO eq_downtime_periods (eq_attendance_id, downtime_type, start_time, end_time, reason, recorded_by_user_id) VALUES (?, ?, ?, ?, ?, ?)',
      [id, d.downtime_type, d.start_time, d.end_time || null, d.reason || null, req.user.user_id]);
    await S.recompute(conn, id);
    await audit.log(conn, { table: 'eq_downtime_periods', id: r.insertId, action: 'start', newValues: { eq_attendance_id: id, ...d }, ...audit.ctx(req) });
  });
  res.status(201).json({ status: 'success', data: await rowView(pool, id) });
};

exports.downtimeEnd = async (req, res) => {
  const id = parseId(req.params.id);
  const downtimeId = parseId(req.params.downtimeId, 'downtime');
  const d = validate(req.body, { end_time: v.datetime({ required: true }) });
  assertNotFutureTime(d.end_time, 'end_time');
  await withTransaction(async (conn) => {
    const row = await rowForAction(conn, req, id);
    const periods = await S.loadDowntime(conn, id);
    const p = periods.find((x) => x.downtime_id === downtimeId);
    if (!p) throw AppError.notFound('Downtime period');
    if (p.end_time) throw AppError.conflict('DOWNTIME_ALREADY_ENDED', 'This period is already closed.');
    if (wallMs(d.end_time) <= wallMs(p.start_time)) throw AppError.validation({ end_time: 'must be after the period start' });
    S.assertPeriodsValid(periods.map((x) => (x.downtime_id === downtimeId ? { ...x, end_time: d.end_time } : x)), row.check_in_time, row.check_out_time);
    await conn.execute('UPDATE eq_downtime_periods SET end_time = ? WHERE downtime_id = ?', [d.end_time, downtimeId]);
    await S.recompute(conn, id);
    await audit.log(conn, { table: 'eq_downtime_periods', id: downtimeId, action: 'end', newValues: d, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await rowView(pool, id) });
};

exports.downtimeDelete = async (req, res) => {
  const id = parseId(req.params.id);
  const downtimeId = parseId(req.params.downtimeId, 'downtime');
  await withTransaction(async (conn) => {
    await rowForAction(conn, req, id);
    const [[p]] = await conn.execute('SELECT * FROM eq_downtime_periods WHERE downtime_id = ? AND eq_attendance_id = ?', [downtimeId, id]);
    if (!p) throw AppError.notFound('Downtime period');
    await conn.execute('DELETE FROM eq_downtime_periods WHERE downtime_id = ?', [downtimeId]);
    await S.recompute(conn, id);
    await audit.log(conn, { table: 'eq_downtime_periods', id: downtimeId, action: 'delete', oldValues: p, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await rowView(pool, id) });
};

// ------------------------------------------------------------------ check-out
exports.checkOut = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body, {
    check_out_time: v.datetime({ required: true }), meter_end: v.number({ min: 0, max: 99999999, decimals: 1 }),
    operator_id: v.id(), fuel_liters: v.number({ min: 0, max: 100000, decimals: 2 }),
    work_description: v.string({ max: 500 }), remarks: v.string({ max: 2000 }),
  });
  assertNotFutureTime(d.check_out_time, 'check_out_time');
  await withTransaction(async (conn) => {
    const row = await rowForAction(conn, req, id);
    if (row.day_status !== 'Working' || !row.check_in_time) throw AppError.conflict('INVALID_STATE', 'This row has no open session.');
    if (row.check_out_time) throw AppError.conflict('ALREADY_CHECKED_OUT', 'The machine is already checked out. Edit the row to change the time.');
    S.assertSessionLength(row.check_in_time, d.check_out_time);
    await S.assertNoTimeOverlap(conn, row.equipment_id, row.check_in_time, d.check_out_time, id);
    // the operator (driver) is the vendor's business: optional, never required
    const operatorId = d.operator_id || row.operator_id || null;
    if (d.operator_id) await assertOperatorUsable(conn, d.operator_id, row);
    if (d.meter_end !== undefined && row.meter_start !== null && d.meter_end < Number(row.meter_start)) {
      throw AppError.validation({ meter_end: 'must be greater than or equal to the meter start' });
    }
    // auto-close an open downtime at the check-out time (BR-16)
    const periods = await S.loadDowntime(conn, id);
    const open = periods.find((p) => !p.end_time);
    if (open) {
      if (wallMs(open.start_time) >= wallMs(d.check_out_time)) throw AppError.conflict('DOWNTIME_AFTER_CHECKOUT', 'An open downtime period starts after this check-out time.');
      await conn.execute("UPDATE eq_downtime_periods SET end_time = ?, reason = CONCAT(COALESCE(reason, ''), ' [auto-closed at check-out]') WHERE downtime_id = ?", [d.check_out_time, open.downtime_id]);
    }
    S.assertPeriodsValid((await S.loadDowntime(conn, id)), row.check_in_time, d.check_out_time);
    await conn.execute(
      `UPDATE eq_attendance SET check_out_time = ?, meter_end = ?, operator_id = ?, work_description = COALESCE(?, work_description),
         remarks = COALESCE(?, remarks) WHERE eq_attendance_id = ?`,
      [d.check_out_time, d.meter_end ?? null, operatorId, d.work_description || null, d.remarks || null, id]);
    if (d.fuel_liters > 0) {
      await conn.execute(
        'INSERT INTO eq_fuel_issues (equipment_id, site_id, issue_date, liters, price_per_liter, issued_by_user_id) VALUES (?, ?, ?, ?, NULL, ?)',
        [row.equipment_id, row.site_id, row.record_date, d.fuel_liters, req.user.user_id]);
    }
    await S.recompute(conn, id);
    await audit.log(conn, { table: 'eq_attendance', id, action: 'check_out', newValues: d, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await rowView(pool, id) });
};

// ------------------------------------------------------------------ full-day status
exports.dayStatus = async (req, res) => {
  const d = validate(req.body, {
    equipment_id: v.id({ required: true }), site_id: v.id({ required: true }), shift_type: SHIFT,
    record_date: v.date({ required: true }),
    day_status: v.enumOf(['Standby', 'Breakdown', 'Absent', 'Holiday'], { required: true }),
    check_in_time: v.datetime(), check_out_time: v.datetime(), remarks: v.string({ max: 2000 }),
    confirm_discard_session: v.bool({ default: false }),
  });
  assertNotFutureDate(d.record_date);
  const hasTimes = Boolean(d.check_in_time || d.check_out_time);
  if (hasTimes) {
    if (!['Standby', 'Breakdown'].includes(d.day_status)) throw AppError.validation({ check_in_time: `${d.day_status} rows have no times` });
    if (!d.check_in_time || !d.check_out_time) throw AppError.validation({ check_out_time: 'give both times or none' });
    if (datePart(d.check_in_time) !== d.record_date) throw AppError.validation({ check_in_time: 'must be on record_date' });
    S.assertSessionLength(d.check_in_time, d.check_out_time);
    assertNotFutureTime(d.check_out_time, 'check_out_time');
  }
  if (['Standby', 'Breakdown'].includes(d.day_status) && !d.remarks) throw AppError.validation({ remarks: `explain the ${d.day_status.toLowerCase()} (reason)` });
  const id = await withTransaction(async (conn) => {
    await assertCanActOnSite(req.user, d.site_id, d.shift_type, d.record_date, conn);
    const machine = await C.loadMachine(conn, d.equipment_id, true);
    await C.assertMachineDeployed(conn, d.equipment_id, d.site_id, d.shift_type, d.record_date);
    await lock.assertEqEditable(conn, { equipment_id: d.equipment_id, vendor_id: machine.vendor_id, site_id: d.site_id, record_date: d.record_date });
    if (hasTimes) await S.assertNoTimeOverlap(conn, d.equipment_id, d.check_in_time, d.check_out_time);
    const [existing] = await conn.execute(
      'SELECT * FROM eq_attendance WHERE equipment_id = ? AND site_id = ? AND shift_type = ? AND record_date = ? FOR UPDATE',
      [d.equipment_id, d.site_id, d.shift_type, d.record_date]);
    let rowId;
    if (existing[0]) {
      const ex = existing[0];
      assertEditableStatus(ex);
      if (ex.day_status === 'Working' && ex.check_in_time && !d.confirm_discard_session) {
        throw AppError.conflict('SESSION_WILL_BE_DISCARDED', 'This machine has a recorded session that day. Send confirm_discard_session = true to replace it.');
      }
      if (hasTimes) await S.assertNoTimeOverlap(conn, d.equipment_id, d.check_in_time, d.check_out_time, ex.eq_attendance_id);
      await conn.execute('DELETE FROM eq_downtime_periods WHERE eq_attendance_id = ?', [ex.eq_attendance_id]);
      await conn.execute(
        `UPDATE eq_attendance SET day_status = ?, check_in_time = ?, check_out_time = ?, operator_id = NULL, meter_start = NULL, meter_end = NULL,
           work_description = NULL, remarks = ? WHERE eq_attendance_id = ?`,
        [d.day_status, d.check_in_time || null, d.check_out_time || null, d.remarks || null, ex.eq_attendance_id]);
      rowId = ex.eq_attendance_id;
    } else {
      rowId = await insertRow(conn, req, { ...d, operator_id: null });
    }
    await S.recompute(conn, rowId);
    await audit.log(conn, { table: 'eq_attendance', id: rowId, action: 'day_status', newValues: d, ...audit.ctx(req) });
    return rowId;
  });
  res.status(201).json({ status: 'success', data: await rowView(pool, id) });
};

// ------------------------------------------------------------------ edit / delete
const EDIT_FIELDS = {
  check_in_time: v.datetime(), check_out_time: v.datetime(), operator_id: v.id(),
  meter_start: v.number({ min: 0, max: 99999999, decimals: 1 }), meter_end: v.number({ min: 0, max: 99999999, decimals: 1 }),
  work_description: v.string({ max: 500 }), remarks: v.string({ max: 2000 }),
};

/** Shared by supervisor edit, admin edit and admin correction. Validates and writes the changes. */
async function applyEdit(conn, row, d) {
  const next = { ...row, ...d };
  if (row.day_status !== 'Working') {
    if (d.operator_id || d.meter_start !== undefined || d.meter_end !== undefined) {
      throw AppError.conflict('INVALID_STATE', `A ${row.day_status} row has no operator or meter readings.`);
    }
    if ((d.check_in_time || d.check_out_time) && !['Standby', 'Breakdown'].includes(row.day_status)) {
      throw AppError.conflict('INVALID_STATE', `A ${row.day_status} row has no times.`);
    }
    if (Boolean(next.check_in_time) !== Boolean(next.check_out_time)) throw AppError.validation({ check_out_time: 'give both times or none' });
  }
  if (next.check_in_time && datePart(next.check_in_time) !== row.record_date) throw AppError.validation({ check_in_time: `must stay on ${row.record_date}` });
  if (d.check_in_time) assertNotFutureTime(d.check_in_time, 'check_in_time');
  if (d.check_out_time) assertNotFutureTime(d.check_out_time, 'check_out_time');
  if (next.check_out_time && !next.check_in_time) throw AppError.validation({ check_in_time: 'is required with a check-out' });
  if (next.check_in_time && next.check_out_time) S.assertSessionLength(next.check_in_time, next.check_out_time);
  if (next.check_in_time) await S.assertNoTimeOverlap(conn, row.equipment_id, next.check_in_time, next.check_out_time, row.eq_attendance_id);
  if (next.meter_start !== null && next.meter_end !== null && next.meter_start !== undefined && next.meter_end !== undefined
    && Number(next.meter_end) < Number(next.meter_start)) throw AppError.validation({ meter_end: 'must be >= meter_start' });
  if (d.operator_id) await assertOperatorUsable(conn, d.operator_id, row);
  if (row.day_status === 'Working' && next.check_in_time) {
    S.assertPeriodsValid(await S.loadDowntime(conn, row.eq_attendance_id), next.check_in_time, next.check_out_time);
  }
  const keys = Object.keys(d);
  if (keys.length) {
    await conn.execute(`UPDATE eq_attendance SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE eq_attendance_id = ?`, [...keys.map((k) => d[k]), row.eq_attendance_id]);
  }
  return S.recompute(conn, row.eq_attendance_id);
}

exports.applyEdit = applyEdit;
exports.assertOperatorUsable = assertOperatorUsable;
exports.assertNotFutureTime = assertNotFutureTime;
exports.EDIT_FIELDS = EDIT_FIELDS;
exports.rowView = rowView;

exports.edit = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body, EDIT_FIELDS);
  await withTransaction(async (conn) => {
    const row = await rowForAction(conn, req, id);
    const after = await applyEdit(conn, row, d);
    await audit.log(conn, { table: 'eq_attendance', id, action: 'edit', oldValues: row, newValues: after, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await rowView(pool, id) });
};

exports.remove = async (req, res) => {
  const id = parseId(req.params.id);
  await withTransaction(async (conn) => {
    const row = await rowForAction(conn, req, id);
    if (row.status !== 'Draft') throw AppError.conflict('INVALID_STATE', 'Only Draft rows can be deleted.');
    const [[pc]] = await conn.execute('SELECT COUNT(*) AS n FROM eq_paper_checks WHERE eq_attendance_id = ?', [id]);
    if (Number(pc.n)) throw AppError.conflict('ROW_HAS_PAPER_CHECKS', 'This row was already checked against the paper; it cannot be deleted.');
    await conn.execute('DELETE FROM eq_downtime_periods WHERE eq_attendance_id = ?', [id]);
    await conn.execute('DELETE FROM eq_attendance WHERE eq_attendance_id = ?', [id]);
    await audit.log(conn, { table: 'eq_attendance', id, action: 'delete', oldValues: row, reason: `sheet row ${row.sheet_row_no} cancelled`, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: { deleted: id } });
};

// ------------------------------------------------------------------ submit / rejected / resubmit
exports.submit = async (req, res) => {
  const d = validate(req.body, { site_id: v.id({ required: true }), shift_type: SHIFT, record_date: v.date({ required: true }) });
  const result = await withTransaction(async (conn) => {
    await assertCanActOnSite(req.user, d.site_id, d.shift_type, d.record_date, conn);
    const [rows] = await conn.execute(
      `SELECT ea.*, e.equipment_code, e.vendor_id FROM eq_attendance ea JOIN eq_equipment e ON e.equipment_id = ea.equipment_id
       WHERE ea.site_id = ? AND ea.shift_type = ? AND ea.record_date = ? AND ea.status = 'Draft' FOR UPDATE`,
      [d.site_id, d.shift_type, d.record_date]);
    if (!rows.length) throw AppError.conflict('NOTHING_TO_SUBMIT', 'There are no Draft rows for this day.');
    const open = rows.filter((r) => r.day_status === 'Working' && !r.check_out_time).map((r) => r.equipment_code);
    if (open.length) throw AppError.conflict('OPEN_SESSIONS', `Check out these machines first: ${open.join(', ')}.`, { machines: open });
    const gate = await weekGate.previousWeekDrafts(conn, d.site_id, d.shift_type, d.record_date);
    if (gate.blocked) {
      throw AppError.conflict('PREVIOUS_WEEK_DRAFTS', `Submit the previous week (${gate.prev_start} to ${gate.prev_end}) first.`, gate);
    }
    for (const r of rows) await lock.assertEqEditable(conn, r);
    const now = businessNow();
    await conn.execute(
      `UPDATE eq_attendance SET status = 'Submitted', submitted_by_user_id = ?, submitted_at = ?
       WHERE site_id = ? AND shift_type = ? AND record_date = ? AND status = 'Draft'`,
      [req.user.user_id, now, d.site_id, d.shift_type, d.record_date]);
    for (const r of rows) await audit.log(conn, { table: 'eq_attendance', id: r.eq_attendance_id, action: 'submit', ...audit.ctx(req) });
    const [missing] = await conn.execute(
      `SELECT e.equipment_code FROM eq_site_assignments a JOIN eq_equipment e ON e.equipment_id = a.equipment_id
       WHERE a.site_id = ? AND a.shift_type = ? AND a.assigned_date <= ? AND (a.unassigned_date IS NULL OR a.unassigned_date >= ?)
         AND NOT EXISTS (SELECT 1 FROM eq_attendance x WHERE x.equipment_id = a.equipment_id AND x.site_id = a.site_id AND x.shift_type = a.shift_type AND x.record_date = ?)`,
      [d.site_id, d.shift_type, d.record_date, d.record_date, d.record_date]);
    return { submitted: rows.length, machines_without_row: missing.map((m) => m.equipment_code) };
  });
  res.json({ status: 'success', data: result, message: `${result.submitted} row(s) submitted.` });
};

// ------------------------------------------------------------------ recall (supervisor takes back a Submitted row before approval)
/** A Submitted row the office has not approved yet goes back to Draft; the reason is kept in the history. */
async function resetPaper(conn, row, userId) {
  if (row.paper_status !== 'Pending') {
    await conn.execute("UPDATE eq_attendance SET paper_status = 'Pending' WHERE eq_attendance_id = ?", [row.eq_attendance_id]);
    await conn.execute('UPDATE eq_paper_checks SET is_current = 0 WHERE eq_attendance_id = ?', [row.eq_attendance_id]);
    if (row.timesheet_id) await sheets.refreshStatus(conn, row.timesheet_id, userId);
  }
}
exports.resetPaper = resetPaper;

async function recallRows(conn, req, rows, reason) {
  for (const row of rows) {
    if (row.status !== 'Submitted') throw AppError.conflict('INVALID_STATE', `Row #${row.sheet_row_no} is ${row.status}; only Submitted rows (not approved yet) can be recalled.`);
    await lock.assertEqEditable(conn, row);
    await conn.execute("UPDATE eq_attendance SET status = 'Draft', submitted_by_user_id = NULL, submitted_at = NULL WHERE eq_attendance_id = ?", [row.eq_attendance_id]);
    await resetPaper(conn, row, req.user.user_id);
    await audit.log(conn, { table: 'eq_attendance', id: row.eq_attendance_id, action: 'recall', reason, ...audit.ctx(req) });
  }
  return rows.length;
}

exports.recall = async (req, res) => {
  const id = parseId(req.params.id);
  const { reason } = validate(req.body, { reason: v.string({ required: true, min: 3, max: 1000 }) });
  await withTransaction(async (conn) => {
    const row = await S.loadRow(conn, id, true);
    await assertCanActOnSite(req.user, row.site_id, row.shift_type, row.record_date, conn);
    await recallRows(conn, req, [row], reason);
  });
  res.json({ status: 'success', data: await rowView(pool, id), message: 'Row recalled to Draft. Fix it and submit the day again.' });
};

exports.recallDay = async (req, res) => {
  const d = validate(req.body, { site_id: v.id({ required: true }), shift_type: SHIFT, record_date: v.date({ required: true }), reason: v.string({ required: true, min: 3, max: 1000 }) });
  const n = await withTransaction(async (conn) => {
    await assertCanActOnSite(req.user, d.site_id, d.shift_type, d.record_date, conn);
    const [ids] = await conn.execute("SELECT eq_attendance_id FROM eq_attendance WHERE site_id = ? AND shift_type = ? AND record_date = ? AND status = 'Submitted' FOR UPDATE",
      [d.site_id, d.shift_type, d.record_date]);
    if (!ids.length) throw AppError.conflict('NOTHING_TO_RECALL', 'No Submitted row waits for approval on this day.');
    const rows = [];
    for (const r of ids) rows.push(await S.loadRow(conn, r.eq_attendance_id, true));
    return recallRows(conn, req, rows, d.reason);
  });
  res.json({ status: 'success', data: { recalled: n }, message: `${n} row(s) recalled to Draft.` });
};

exports.rejected = async (req, res) => {
  const params = []; let scope = '';
  if (req.user.role === 'Supervisor') {
    scope = `AND EXISTS (SELECT 1 FROM site_supervisors ss WHERE ss.user_id = ? AND ss.site_id = ea.site_id AND ss.shift_type = ea.shift_type
              AND ss.from_date <= ea.record_date AND (ss.to_date IS NULL OR ss.to_date >= ea.record_date))`;
    params.push(req.user.user_id);
  }
  if (req.query.site_id) { scope += ' AND ea.site_id = ?'; params.push(Number(req.query.site_id)); }
  const [rows] = await pool.query(
    `SELECT ea.eq_attendance_id FROM eq_attendance ea WHERE ea.status = 'Rejected' ${scope} ORDER BY ea.record_date DESC LIMIT 500`, params);
  const out = [];
  for (const r of rows) out.push(await rowView(pool, r.eq_attendance_id));
  res.json({ status: 'success', data: out });
};

exports.resubmit = async (req, res) => {
  const id = parseId(req.params.id);
  await withTransaction(async (conn) => {
    const row = await rowForAction(conn, req, id);
    if (row.status !== 'Rejected') throw AppError.conflict('INVALID_STATE', 'Only Rejected rows can be resubmitted.');
    if (row.day_status === 'Working' && !row.check_out_time) throw AppError.conflict('OPEN_SESSIONS', 'Check the machine out first.');
    await conn.execute(
      "UPDATE eq_attendance SET status = 'Submitted', submitted_by_user_id = ?, submitted_at = ? WHERE eq_attendance_id = ?",
      [req.user.user_id, businessNow(), id]);
    await audit.log(conn, { table: 'eq_attendance', id, action: 'resubmit', ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: await rowView(pool, id) });
};
