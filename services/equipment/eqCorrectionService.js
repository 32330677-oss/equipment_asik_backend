// services/equipment/eqCorrectionService.js — the changes the office may make to an attendance row (several fields
// at once), and how they are written. The old "official correction" workflow (debit / credit note settled in the next
// period) was removed on 14 Oct 2026: an issued invoice is brought up to date instead, and a debit / credit note is a
// stand-alone document (eqFinanceController).
const AppError = require('../../utils/AppError');
const { v, validate } = require('../../utils/validate');
const { businessNow } = require('../../utils/businessDate');
const S = require('./eqAttendanceService');

const DOWNTIME_TYPES = ['Break', 'Refuel', 'Breakdown', 'Standby'];
const DAY_STATUSES = ['Working', 'Standby', 'Breakdown', 'Absent', 'Holiday'];

/** What a correction may change on a row. */
const CHANGE_FIELDS = {
  day_status: v.enumOf(DAY_STATUSES),
  check_in_time: v.datetime(), check_out_time: v.datetime(), operator_id: v.id(),
  meter_start: v.number({ min: 0, max: 99999999, decimals: 1 }), meter_end: v.number({ min: 0, max: 99999999, decimals: 1 }),
  work_description: v.string({ max: 500 }), remarks: v.string({ max: 2000 }),
  standby_credit_hours: v.number({ min: 0, max: 24, decimals: 2 }),
  downtime: v.any(),
  cancel_row: v.bool(), // the row should not exist: refused here, use "Void row"
};

/** Validates a changes object; `downtime` (when given) replaces every downtime period of the row. */
function normalizeChanges(body) {
  const raw = body || {};
  const d = validate(raw, CHANGE_FIELDS);
  if (raw.standby_credit_hours === null) d.standby_credit_hours = null;
  for (const k of ['check_in_time', 'check_out_time']) if (raw[k] === null) d[k] = null;
  if (d.downtime !== undefined) {
    if (!Array.isArray(d.downtime) || d.downtime.length > 20) throw AppError.validation({ downtime: 'must be a list of at most 20 periods' });
    d.downtime = d.downtime.map((p, i) => {
      try {
        return validate(p, {
          downtime_type: v.enumOf(DOWNTIME_TYPES, { required: true }), start_time: v.datetime({ required: true }),
          end_time: v.datetime({ required: true }), reason: v.string({ max: 500 }),
        });
      } catch (e) {
        throw AppError.validation({ [`downtime[${i}]`]: Object.values((e.details && e.details.fields) || {}).join(', ') || 'invalid' });
      }
    });
  }
  if (d.cancel_row === false) delete d.cancel_row;
  if (d.cancel_row && Object.keys(d).length > 1) throw AppError.validation({ cancel_row: 'cancelling a row cannot be mixed with other changes' });
  if (!Object.keys(d).length) throw AppError.validation({ changes: 'nothing to change' });
  return d;
}

/**
 * Writes the changes on the live row (inside the caller's transaction) and recomputes its minutes.
 * No invoice-lock check here: the caller (office edit) checks it.
 * opts.allowOpen: an office edit may fix a session still running (Working, no check-out yet).
 */
async function applyChanges(conn, rowId, changes, userId, opts = {}) {
  let row = await S.loadRow(conn, rowId, true);
  if (changes.cancel_row) return row; // status handled by the caller (it needs the reason)
  const wasOpen = row.day_status === 'Working' && row.check_in_time && !row.check_out_time;
  const status = changes.day_status || row.day_status;
  if (changes.day_status && changes.day_status !== row.day_status) {
    const keepTimes = ['Standby', 'Breakdown', 'Working'].includes(status);
    await conn.execute(
      `UPDATE eq_attendance SET day_status = ?, check_in_time = ?, check_out_time = ?,
         operator_id = ?, meter_start = ?, meter_end = ? WHERE eq_attendance_id = ?`,
      [status, keepTimes ? row.check_in_time : null, keepTimes ? row.check_out_time : null,
        status === 'Working' ? row.operator_id : null, status === 'Working' ? row.meter_start : null, status === 'Working' ? row.meter_end : null, rowId]);
    if (status !== 'Working') await conn.execute('DELETE FROM eq_downtime_periods WHERE eq_attendance_id = ?', [rowId]);
    row = await S.loadRow(conn, rowId, true);
  }
  const fields = ['check_in_time', 'check_out_time', 'operator_id', 'meter_start', 'meter_end', 'work_description', 'remarks'];
  const next = { ...row };
  for (const k of fields) if (changes[k] !== undefined) next[k] = changes[k];
  if (next.check_in_time) S.assertOnShiftDate(next.check_in_time, row.shift_type, row.record_date);
  const stillOpen = opts.allowOpen && wasOpen && status === 'Working' && next.check_in_time && !next.check_out_time && changes.check_out_time === undefined;
  if (status === 'Working' && (!next.check_in_time || (!next.check_out_time && !stillOpen))) throw AppError.validation({ check_out_time: 'a Working day needs a check-in and a check-out' });
  if (['Absent', 'Holiday'].includes(status) && (next.check_in_time || next.check_out_time)) throw AppError.validation({ check_in_time: `${status} rows have no times` });
  if (!stillOpen && Boolean(next.check_in_time) !== Boolean(next.check_out_time)) throw AppError.validation({ check_out_time: 'give both times or none' });
  if (next.check_in_time && next.check_out_time) {
    S.assertSessionLength(next.check_in_time, next.check_out_time);
    await S.assertNoTimeOverlap(conn, row.equipment_id, next.check_in_time, next.check_out_time, rowId);
  } else if (stillOpen) {
    await S.assertNoTimeOverlap(conn, row.equipment_id, next.check_in_time, null, rowId);
  }
  if (next.meter_start != null && next.meter_end != null && Number(next.meter_end) < Number(next.meter_start)) throw AppError.validation({ meter_end: 'must be >= meter_start' });
  const sets = fields.filter((k) => changes[k] !== undefined);
  if (sets.length) {
    await conn.execute(`UPDATE eq_attendance SET ${sets.map((k) => `${k} = ?`).join(', ')} WHERE eq_attendance_id = ?`, [...sets.map((k) => changes[k]), rowId]);
  }
  if (changes.downtime !== undefined) {
    if (status !== 'Working') {
      if (changes.downtime.length) throw AppError.validation({ downtime: 'only a Working day has downtime periods' });
    } else {
      S.assertPeriodsValid(changes.downtime, next.check_in_time, next.check_out_time);
      await conn.execute('DELETE FROM eq_downtime_periods WHERE eq_attendance_id = ?', [rowId]);
      for (const p of changes.downtime) {
        await conn.execute('INSERT INTO eq_downtime_periods (eq_attendance_id, downtime_type, start_time, end_time, reason, recorded_by_user_id) VALUES (?, ?, ?, ?, ?, ?)',
          [rowId, p.downtime_type, p.start_time, p.end_time, p.reason || null, userId]);
      }
    }
  } else if (status === 'Working' && next.check_in_time) {
    S.assertPeriodsValid(await S.loadDowntime(conn, rowId), next.check_in_time, next.check_out_time);
  }
  if (changes.standby_credit_hours !== undefined) {
    const minutes = changes.standby_credit_hours === null ? null : Math.round(changes.standby_credit_hours * 60);
    await conn.execute('UPDATE eq_attendance SET standby_credit_minutes = ?, standby_credit_by_user_id = ?, standby_credit_at = ? WHERE eq_attendance_id = ?',
      [minutes, minutes === null ? null : userId, minutes === null ? null : businessNow(), rowId]);
  }
  return S.recompute(conn, rowId);
}

module.exports = { CHANGE_FIELDS, normalizeChanges, applyChanges };
