// services/equipment/eqCorrectionService.js — official corrections of rows inside a FINALIZED payroll period.
// The finalized batch is never touched: the difference is recalculated with the batch's own frozen prices and settings
// and settled by an adjustment in the first open period, with an official debit / credit note number.
// Flow (6 Oct 2026): an Admin or an Accountant requests it (several fields at once) -> ANOTHER Admin/Accountant approves it.
// Whoever changes a request (amends it) cannot approve that version: the content is always seen by two people.
const { pool } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { v, validate } = require('../../utils/validate');
const { businessToday, businessNow, addDays } = require('../../utils/businessDate');
const engine = require('./equipmentBillingEngine');
const P = require('./eqPayrollService');
const S = require('./eqAttendanceService');
const lock = require('./eqLock');

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
  cancel_row: v.bool(), // the row should not exist (wrong machine / date / duplicate): it is cancelled, its value settled
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
 * No payroll-lock check here: the callers (office edit before the lock, official correction after it) check it.
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

/** Runs fn(conn) in a transaction that is ALWAYS rolled back: a preview of a change, nothing written. */
async function dryRun(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    return await fn(conn);
  } finally {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    conn.release();
  }
}

/** Engine row rebuilt from a payroll snapshot row (the figures the finalized batch paid). */
function rowFromSnapshot(s, rate) {
  const detail = P.parseJson(s.calc_detail) || {};
  const deductBreak = rate.break_policy === 'Paid' ? 0 : Number(s.break_minutes || 0);
  let gross = 0;
  if (s.day_status === 'Working') gross = Number(s.work_minutes || 0) + deductBreak + Number(s.breakdown_minutes || 0) + Number(s.standby_minutes || 0);
  else if (s.day_status === 'Standby') gross = Number(s.standby_minutes || 0);
  else if (s.day_status === 'Breakdown') gross = Number(s.breakdown_minutes || 0);
  return {
    eq_attendance_id: s.eq_attendance_id, record_date: String(s.record_date).slice(0, 10), day_status: s.day_status,
    gross_minutes: gross, break_minutes: Number(s.break_minutes || 0), breakdown_minutes: s.day_status === 'Working' ? Number(s.breakdown_minutes || 0) : 0,
    standby_minutes: s.day_status === 'Working' ? Number(s.standby_minutes || 0) : 0,
    standby_credit_minutes: s.standby_credit_minutes === undefined ? null : s.standby_credit_minutes,
    check_in_time: s.check_in_time, check_out_time: s.check_out_time, shift_type: s.shift_type,
    regular_allow: detail.regular_allow, day_plan: detail.day_plan,
  };
}

/**
 * Re-splits the shifts of one machine (continuous-shift overtime, minimum top-up per day, second shift) over a set
 * of rows; each entry is { row, rate, cardId }. Rows are copied, never changed in place.
 */
function resplit(entries, gapMin) {
  const out = entries.map((e) => ({ ...e, row: { ...e.row, regular_allow: undefined, day_plan: undefined } }));
  const hourlyDaily = out.filter((e) => e.rate.billing_mode !== 'Monthly');
  const byId = new Map(hourlyDaily.map((e) => [e.row, e]));
  const allow = engine.blockAllowances(hourlyDaily.map((e) => e.row), (r) => engine.otThresholdMin(byId.get(r).rate),
    (r) => engine.dayMinutes(r, byId.get(r).rate).work, gapMin);
  const byCard = new Map();
  for (const e of hourlyDaily) {
    const a = allow[e.row.eq_attendance_id];
    if (a && Number.isFinite(a.allow)) e.row.regular_allow = a.allow;
    if (!byCard.has(e.cardId)) byCard.set(e.cardId, []);
    byCard.get(e.cardId).push(e);
  }
  for (const list of byCard.values()) {
    const plans = engine.planDays(list.map((e) => e.row), list[0].rate);
    for (const e of list) e.row.day_plan = plans.get(e.row);
  }
  return out;
}

/** The finalized batch item that paid this row, with everything frozen in it. */
async function paidItemOf(conn, rowId) {
  const [rows] = await conn.query(
    `SELECT s.eq_item_id, s.eq_batch_id, b.currency, b.settings_snapshot, b.status, i.rate_snapshot, i.billing_mode, i.vendor_id, i.equipment_id, i.site_id,
       (SELECT invoice_no FROM eq_invoices x WHERE x.eq_item_id = i.eq_item_id AND x.kind = 'Machine' LIMIT 1) AS invoice_no
     FROM eq_payroll_attendance_snapshot s JOIN eq_payroll_batches b ON b.eq_batch_id = s.eq_batch_id JOIN eq_payroll_items i ON i.eq_item_id = s.eq_item_id
     WHERE s.eq_attendance_id = ? AND b.status IN ('Generated','Paid') AND b.is_finalized = 1 ORDER BY b.eq_batch_id DESC LIMIT 1`, [rowId]);
  return rows[0] || null;
}

function billWith(rows, rate, ctx, fdInput) {
  const res = engine.billItem(rows, rate, ctx, {});
  let fd = 0;
  if (fdInput) {
    const thr = rate.billing_mode === 'Monthly' ? Infinity : engine.otThresholdMin(rate);
    const perRow = rows.map((r) => ({ row: r, ...P.rowFigures(r, rate, thr) }));
    fd = P.fuelDifference(perRow, fdInput.equipmentId, fdInput.currency, fdInput.terms, fdInput.prices, fdInput.allowNegative).lines.reduce((a, l) => a + l.amount_cents, 0);
  }
  return { net: res.net_cents + fd, fuel_diff: fd };
}

/**
 * Money effect of the changes, at the prices of the finalized batch: re-bills the whole item (monthly hours due,
 * overtime, minimum top-up all follow) with the corrected row in place of the paid one.
 * Returns { auto:false } when the row was never paid by a finalized batch (the reviewer then gives the amount).
 */
async function computeDelta(rowId, changes, userId) {
  return dryRun(async (conn) => {
    const item = await paidItemOf(conn, rowId);
    const before = await S.loadRow(conn, rowId);
    const after = await applyChanges(conn, rowId, changes, userId);
    const fig = (r, cancelled = false) => ({ day_status: r.day_status, check_in_time: r.check_in_time, check_out_time: r.check_out_time, working_minutes: r.working_minutes,
      break_minutes: r.break_minutes, breakdown_minutes: r.breakdown_minutes, standby_minutes: r.standby_minutes, standby_credit_minutes: r.standby_credit_minutes,
      ...(cancelled ? { status: 'Cancelled' } : {}) });
    if (!item) return { auto: false, before: fig(before), after: fig(after, changes.cancel_row) };
    const settings = P.parseJson(item.settings_snapshot) || {};
    const gap = Number(settings.eq_shift_continuity_minutes ?? 30);
    const allowNegative = ['true', '1'].includes(String(settings.eq_fuel_diff_allow_negative ?? 'true'));
    // every item of this machine in the batch: a change on one shift can move the split of the other shifts of the day
    const [items] = await conn.query('SELECT eq_item_id, rate_card_id, rate_snapshot FROM eq_payroll_items WHERE eq_batch_id = ? AND equipment_id = ?',
      [item.eq_batch_id, item.equipment_id]);
    const meta = new Map(items.map((i) => {
      const snap = P.parseJson(i.rate_snapshot) || {};
      return [i.eq_item_id, { snap, rate: P.engineRate(snap), cardId: i.rate_card_id }];
    }));
    const [srows] = await conn.query(
      `SELECT s.*, a.shift_type FROM eq_payroll_attendance_snapshot s LEFT JOIN eq_attendance a ON a.eq_attendance_id = s.eq_attendance_id
       WHERE s.eq_batch_id = ? AND s.eq_item_id IN (?) ORDER BY s.record_date`, [item.eq_batch_id, items.map((i) => i.eq_item_id)]);
    const paidEntries = srows.map((x) => {
      const m = meta.get(x.eq_item_id);
      return { itemId: x.eq_item_id, rate: m.rate, cardId: m.cardId, row: rowFromSnapshot(x, m.rate) };
    });
    const correctedEntries = changes.cancel_row
      ? paidEntries.filter((e) => e.row.eq_attendance_id !== rowId)
      : paidEntries.map((e) => (e.row.eq_attendance_id === rowId
        ? { ...e, row: { ...P.engineRow(after), eq_attendance_id: rowId, shift_type: after.shift_type } } : e));
    const billAll = (entries) => {
      let net = 0; let mainNet = 0;
      for (const [itemId, m] of meta) {
        const rows = entries.filter((e) => e.itemId === itemId).map((e) => e.row);
        if (!rows.length) continue;
        const ctx = m.rate.billing_mode === 'Monthly' ? { months: m.snap.months || [] } : {};
        const fdInput = m.snap.fuel_diff ? { equipmentId: item.equipment_id, currency: item.currency, terms: m.snap.fuel_diff.terms || [],
          prices: m.snap.fuel_diff.prices || [], allowNegative } : null;
        const r = billWith(rows, m.rate, ctx, fdInput);
        net += r.net;
        if (itemId === item.eq_item_id) mainNet = r.net;
      }
      return { net, mainNet };
    };
    const b = billAll(resplit(paidEntries, gap));
    const a = billAll(resplit(correctedEntries, gap));
    return { auto: true, delta_cents: a.net - b.net, currency: item.currency, eq_batch_id: item.eq_batch_id, eq_item_id: item.eq_item_id,
      invoice_no: item.invoice_no, before: fig(before), after: fig(after, changes.cancel_row), item_net_before: b.mainNet / 100, item_net_after: a.mainNet / 100 };
  });
}

/** First date on or after today that no finalized batch of this machine covers (the adjustment lands there). */
async function firstOpenDate(conn, equipmentId, siteId) {
  let d = businessToday();
  for (let i = 0; i < 24; i += 1) {
    const b = await lock.finalizedOverlap(conn, { equipmentId, siteId, from: d, to: d });
    if (!b) return d;
    d = addDays(String(b.end_date).slice(0, 10), 1);
  }
  throw AppError.conflict('NO_OPEN_PERIOD', 'No open period found for the settlement.');
}

const NOTE_PREFIX = { DebitNote: 'DN', CreditNote: 'CN' };

/** Official debit / credit note number for a settled correction (never reused). */
async function issueNote(conn, { kind, batchId, vendorId, equipmentId, itemId, currency, amountCents }) {
  const year = Number(businessNow().slice(0, 4));
  await conn.execute('INSERT IGNORE INTO eq_invoice_counters (kind, year, last_seq) VALUES (?, ?, 0)', [kind, year]);
  const [[c]] = await conn.execute('SELECT last_seq FROM eq_invoice_counters WHERE kind = ? AND year = ? FOR UPDATE', [kind, year]);
  const seq = Number(c.last_seq) + 1;
  await conn.execute('UPDATE eq_invoice_counters SET last_seq = ? WHERE kind = ? AND year = ?', [seq, kind, year]);
  const no = `${NOTE_PREFIX[kind]}-${year}-${String(seq).padStart(5, '0')}`;
  const [r] = await conn.execute(
    `INSERT INTO eq_invoices (invoice_no, kind, year, seq, eq_batch_id, vendor_id, equipment_id, eq_item_id, currency, amount, issued_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [no, kind, year, seq, batchId, vendorId, equipmentId, itemId, currency, (amountCents / 100).toFixed(2), businessNow()]);
  return { invoice_id: r.insertId, invoice_no: no };
}

module.exports = { CHANGE_FIELDS, normalizeChanges, applyChanges, computeDelta, firstOpenDate, issueNote, paidItemOf, rowFromSnapshot, resplit, dryRun };
