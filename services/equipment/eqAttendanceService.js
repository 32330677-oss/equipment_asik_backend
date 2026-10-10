// services/equipment/eqAttendanceService.js — minutes recomputation, anomalies, session rules.
const AppError = require('../../utils/AppError');
const settings = require('../settings');
const { diffMinutes, wallMs, datePart, timePart } = require('../../utils/dateTime');
const { addDays } = require('../../utils/businessDate');

const MAX_SESSION_MINUTES = 24 * 60;

async function loadRow(conn, id, lock = false) {
  const [rows] = await conn.execute(
    `SELECT ea.*, e.vendor_id, e.equipment_code, t.meter_unit, t.type_name, st.site_code, st.site_name FROM eq_attendance ea
     JOIN eq_equipment e ON e.equipment_id = ea.equipment_id JOIN eq_types t ON t.type_id = e.type_id
     JOIN sites st ON st.site_id = ea.site_id
     WHERE ea.eq_attendance_id = ?${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw AppError.notFound('Attendance row');
  return rows[0];
}

async function loadDowntime(conn, id) {
  const [rows] = await conn.execute('SELECT * FROM eq_downtime_periods WHERE eq_attendance_id = ? ORDER BY start_time, downtime_id', [id]);
  return rows;
}

/** Minutes of one period clipped to the session [in, out]. */
function clippedMinutes(p, checkIn, checkOut) {
  if (!p.end_time) return 0;
  const start = Math.max(wallMs(p.start_time), wallMs(checkIn));
  const end = checkOut ? Math.min(wallMs(p.end_time), wallMs(checkOut)) : wallMs(p.end_time);
  return Math.max(0, Math.floor((end - start) / 60000));
}

/** BR-17: recompute stored minutes, then anomalies. */
async function recompute(conn, id) {
  const row = await loadRow(conn, id, true);
  const periods = await loadDowntime(conn, id);
  let gross = null; let brk = 0; let breakdown = 0; let standby = 0; let working = null;
  if (row.check_in_time && row.check_out_time) gross = diffMinutes(row.check_in_time, row.check_out_time);
  if (row.day_status === 'Working' && row.check_in_time) {
    for (const p of periods) {
      const m = clippedMinutes(p, row.check_in_time, row.check_out_time);
      if (p.downtime_type === 'Break' || p.downtime_type === 'Refuel') brk += m;
      else if (p.downtime_type === 'Breakdown') breakdown += m;
      else if (p.downtime_type === 'Standby') standby += m;
    }
    if (gross !== null) working = Math.max(0, gross - brk - breakdown - standby);
  } else if (row.day_status === 'Standby' || row.day_status === 'Breakdown') {
    working = 0;
    if (gross !== null) { if (row.day_status === 'Standby') standby = gross; else breakdown = gross; }
  } else {
    working = 0;
  }
  await conn.execute(
    `UPDATE eq_attendance SET gross_minutes = ?, break_minutes = ?, breakdown_minutes = ?, standby_minutes = ?, working_minutes = ?
     WHERE eq_attendance_id = ?`, [gross, brk, breakdown, standby, working, id]);
  // standby hours given (monthly machines) lose their meaning when the row has no standby any more
  if (row.standby_credit_minutes !== null && row.standby_credit_minutes !== undefined && row.day_status !== 'Standby' && !(standby > 0)) {
    await conn.execute(
      'UPDATE eq_attendance SET standby_credit_minutes = NULL, standby_credit_by_user_id = NULL, standby_credit_at = NULL, standby_credit_note = NULL WHERE eq_attendance_id = ?', [id]);
  }
  await evaluateAnomalies(conn, id);
  return loadRow(conn, id);
}

/** BR-18/19 + operator licence. Warning only: never changes values. Keeps an ack when the code is unchanged. */
async function evaluateAnomalies(conn, id) {
  const row = await loadRow(conn, id);
  let code = null; let detail = null;
  const longH = await settings.getInt('eq_long_session_review_hours');
  if (row.gross_minutes !== null && row.gross_minutes > longH * 60) {
    code = 'long_session'; detail = `Session lasts ${(row.gross_minutes / 60).toFixed(2)} h (review threshold ${longH} h).`;
  }
  if (!code && row.meter_start !== null && row.meter_start !== undefined) {
    const [prev] = await conn.execute(
      `SELECT meter_end, record_date FROM eq_attendance
       WHERE equipment_id = ? AND eq_attendance_id <> ? AND meter_end IS NOT NULL AND status <> 'Cancelled'
         AND (record_date < ? OR (record_date = ? AND check_in_time < ?))
       ORDER BY record_date DESC, check_in_time DESC LIMIT 1`,
      [row.equipment_id, id, row.record_date, row.record_date, row.check_in_time || '9999-12-31 00:00:00']);
    if (prev[0] && Number(row.meter_start) < Number(prev[0].meter_end)) {
      code = 'meter_backwards'; detail = `Meter start ${row.meter_start} is below the previous meter end ${prev[0].meter_end} (${prev[0].record_date}).`;
    }
  }
  if (!code && row.meter_unit === 'Hours' && row.meter_start !== null && row.meter_end !== null && Number(row.working_minutes) > 0) {
    const tol = await settings.getInt('eq_meter_tolerance_pct');
    const delta = Number(row.meter_end) - Number(row.meter_start);
    const workH = Number(row.working_minutes) / 60;
    const pct = (Math.abs(delta - workH) / workH) * 100;
    if (pct > tol) { code = 'meter_mismatch'; detail = `Hour meter moved ${delta.toFixed(1)} h but working time is ${workH.toFixed(2)} h (${pct.toFixed(0)}% > ${tol}%).`; }
  }
  // The operator's licence expiry is informative only: it never raises an anomaly nor blocks anything.
  if (code === row.anomaly_code) {
    if (detail !== row.anomaly_detail) await conn.execute('UPDATE eq_attendance SET anomaly_detail = ? WHERE eq_attendance_id = ?', [detail, id]);
    return;
  }
  await conn.execute(
    `UPDATE eq_attendance SET anomaly_code = ?, anomaly_detail = ?, anomaly_ack_by_user_id = NULL, anomaly_ack_at = NULL, anomaly_ack_note = NULL
     WHERE eq_attendance_id = ?`, [code, detail, id]);
}

/** BR-12: one open session per machine across all sites. */
async function assertNoOpenSession(conn, equipmentId, exceptId = 0) {
  const [rows] = await conn.execute(
    `SELECT ea.eq_attendance_id, s.site_code, ea.shift_type, ea.check_in_time FROM eq_attendance ea JOIN sites s ON s.site_id = ea.site_id
     WHERE ea.equipment_id = ? AND ea.eq_attendance_id <> ? AND ea.check_in_time IS NOT NULL AND ea.check_out_time IS NULL
       AND ea.status <> 'Cancelled' FOR UPDATE`,
    [equipmentId, exceptId]);
  if (rows[0]) {
    throw AppError.conflict('MACHINE_HAS_OPEN_SESSION',
      `The machine is still checked in at ${rows[0].site_code} (${rows[0].shift_type}) since ${rows[0].check_in_time.slice(0, 16)}. Check it out first.`, rows[0]);
  }
}

/** BR-13: sessions of one machine never overlap (any site). */
async function assertNoTimeOverlap(conn, equipmentId, checkIn, checkOut, exceptId = 0) {
  const [rows] = await conn.execute(
    `SELECT ea.eq_attendance_id, s.site_code, ea.check_in_time, ea.check_out_time FROM eq_attendance ea JOIN sites s ON s.site_id = ea.site_id
     WHERE ea.equipment_id = ? AND ea.eq_attendance_id <> ? AND ea.check_in_time IS NOT NULL AND ea.status <> 'Cancelled'
       AND ea.check_in_time < ? AND COALESCE(ea.check_out_time, '9999-12-31 23:59:59') > ? LIMIT 1`,
    [equipmentId, exceptId, checkOut || '9999-12-31 23:59:59', checkIn]);
  if (rows[0]) {
    throw AppError.conflict('MACHINE_TIME_OVERLAP',
      `These times overlap another session of the machine at ${rows[0].site_code} (${rows[0].check_in_time.slice(0, 16)} – ${(rows[0].check_out_time || 'open').slice(0, 16)}).`, rows[0]);
  }
}

function assertSessionLength(checkIn, checkOut) {
  const m = diffMinutes(checkIn, checkOut);
  if (m === null || m <= 0) throw AppError.validation({ check_out_time: 'must be after check_in_time' });
  if (m > MAX_SESSION_MINUTES) {
    throw AppError.badRequest('SESSION_TOO_LONG', 'A session cannot be longer than 24 hours. Check the date and time of the check-out; work longer than 24 hours is recorded as one session per day.');
  }
  return m;
}

/** Periods must stay inside the session and not overlap each other. */
function assertPeriodsValid(periods, checkIn, checkOut) {
  const sorted = [...periods].sort((a, b) => wallMs(a.start_time) - wallMs(b.start_time));
  let open = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const p = sorted[i];
    if (wallMs(p.start_time) < wallMs(checkIn)) throw AppError.badRequest('DOWNTIME_OUTSIDE_SESSION', 'A downtime period starts before the check-in.');
    if (checkOut && wallMs(p.end_time || p.start_time) > wallMs(checkOut)) throw AppError.badRequest('DOWNTIME_OUTSIDE_SESSION', 'A downtime period ends after the check-out.');
    if (!p.end_time) open += 1;
    const next = sorted[i + 1];
    if (next && (!p.end_time || wallMs(p.end_time) > wallMs(next.start_time))) {
      throw AppError.conflict('DOWNTIME_OVERLAP', 'Downtime periods overlap each other.');
    }
  }
  if (open > 1) throw AppError.conflict('DOWNTIME_ALREADY_OPEN', 'Only one downtime period can be open at a time.');
}

/**
 * A night shift belongs to the evening it starts: from 12:00 of its date to 11:59 of the next day.
 * A check-in at 00:30 is still the night of the day before (the paper sheet and the board say so).
 */
const NIGHT_DAY_CHANGE = '12:00';

/** The business date of a session from its check-in and shift. */
function shiftDateOf(checkIn, shift) {
  const date = datePart(checkIn);
  return shift === 'Night' && timePart(checkIn) < NIGHT_DAY_CHANGE ? addDays(date, -1) : date;
}

/** The check-in must fall on the shift of [recordDate] (Day: that date; Night: 12:00 of it to 11:59 of the next day). */
function assertOnShiftDate(checkIn, shift, recordDate, field = 'check_in_time') {
  const rd = String(recordDate).slice(0, 10);
  if (shiftDateOf(checkIn, shift) === rd) return;
  throw AppError.validation({
    [field]: shift === 'Night'
      ? `must be within the night shift of ${rd} (${rd} ${NIGHT_DAY_CHANGE} to ${addDays(rd, 1)} 11:59)`
      : `must be on ${rd}`,
  });
}

/** live_state of a day row (see document 01 §10). */
function liveState(row, openDowntime) {
  if (!row) return 'NotArrived';
  if (row.day_status === 'Absent') return 'Absent';
  if (row.day_status === 'Holiday') return 'Holiday';
  if (row.day_status === 'Standby') return 'Standby';
  if (row.day_status === 'Breakdown') return 'Breakdown';
  if (!row.check_in_time) return 'NotArrived';
  if (row.check_out_time) return 'Finished';
  if (openDowntime) {
    if (openDowntime.downtime_type === 'Breakdown') return 'Breakdown';
    if (openDowntime.downtime_type === 'Standby') return 'Standby';
    return 'OnBreak';
  }
  return 'Working';
}

module.exports = {
  loadRow, loadDowntime, recompute, evaluateAnomalies, assertNoOpenSession, assertNoTimeOverlap,
  assertSessionLength, assertPeriodsValid, liveState, MAX_SESSION_MINUTES, shiftDateOf, assertOnShiftDate,
};
