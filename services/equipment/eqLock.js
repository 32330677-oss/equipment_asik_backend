// services/equipment/eqLock.js — what a FINALIZED active equipment payroll batch BILLED is locked for normal operations
// (BR-23): its attendance rows and, for monthly machines, the days it billed. Only the official correction workflow may
// change them. Decision of 11 Oct 2026 (replaces the closed-period rule of 6 Oct 2026): the Finalize closes what was
// billed, not the whole period — a row of a finalized period that no batch billed is edited and paid by the next batch.
const AppError = require('../../utils/AppError');

async function batchHoldingRow(executor, eqAttendanceId) {
  if (!eqAttendanceId) return null;
  const [rows] = await executor.execute(
    `SELECT b.eq_batch_id, b.start_date, b.end_date, b.status FROM eq_payroll_attendance_snapshot s
     JOIN eq_payroll_batches b ON b.eq_batch_id = s.eq_batch_id
     WHERE s.eq_attendance_id = ? AND b.status IN ('Generated','Paid') AND b.is_finalized = 1
     ORDER BY b.eq_batch_id DESC LIMIT 1`, [eqAttendanceId]);
  return rows[0] || null;
}

/** The finalized active batch that billed this day of a MONTHLY machine (eq_payroll_monthly_days), or null. */
async function batchHoldingMonthlyDay(executor, equipmentId, date) {
  if (!equipmentId || !date) return null;
  const [rows] = await executor.execute(
    `SELECT b.eq_batch_id, b.start_date, b.end_date, b.status FROM eq_payroll_monthly_days md
     JOIN eq_payroll_batches b ON b.eq_batch_id = md.eq_batch_id
     WHERE md.equipment_id = ? AND md.day = ? AND b.status IN ('Generated','Paid') AND b.is_finalized = 1
     ORDER BY b.eq_batch_id DESC LIMIT 1`, [equipmentId, String(date).slice(0, 10)]);
  return rows[0] || null;
}

/**
 * Returns the locking batch for a (possibly new) row, or null. row: {eq_attendance_id?, equipment_id, site_id, record_date}
 * Locked = the row itself was billed by a finalized batch, or (monthly machine) its day was.
 */
async function findLock(executor, row) {
  const held = await batchHoldingRow(executor, row.eq_attendance_id);
  if (held) return held;
  return batchHoldingMonthlyDay(executor, row.equipment_id, row.record_date);
}

async function assertEqEditable(executor, row) {
  const b = await findLock(executor, row);
  if (b) {
    throw AppError.conflict('PAYROLL_PERIOD_FINALIZED',
      `${String(row.record_date).slice(0, 10)} was billed by equipment invoice batch #${b.eq_batch_id} (${b.start_date} to ${b.end_date}), which is ${b.status === 'Paid' ? 'Paid' : 'Finalized'}. Normal changes are locked; use an official Correction (reason required).`,
      { eq_batch_id: b.eq_batch_id });
  }
}

/** The active, NOT finalized (Generated) batch that holds this row: changing the row makes that batch stale. */
async function generatedBatchHoldingRow(executor, eqAttendanceId) {
  const [rows] = await executor.execute(
    `SELECT b.eq_batch_id FROM eq_payroll_attendance_snapshot s JOIN eq_payroll_batches b ON b.eq_batch_id = s.eq_batch_id
     WHERE s.eq_attendance_id = ? AND b.status = 'Generated' AND b.is_finalized = 0 ORDER BY b.eq_batch_id DESC LIMIT 1`, [eqAttendanceId]);
  return rows[0] ? rows[0].eq_batch_id : null;
}

/** Text for audit_logs.payroll_effect of a change to an attendance row. */
async function rowPayrollEffect(executor, eqAttendanceId) {
  const g = await generatedBatchHoldingRow(executor, eqAttendanceId);
  return g ? `stale:${g}` : 'none';
}

/** Is a fuel issue / adjustment already consumed by an active batch? (finalizedOnly limits to finalized ones) */
async function sourceConsumed(executor, sourceTable, sourceId, finalizedOnly = false) {
  const [rows] = await executor.execute(
    `SELECT b.eq_batch_id, b.is_finalized FROM eq_payroll_lines l JOIN eq_payroll_items i ON i.eq_item_id = l.eq_item_id
     JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id
     WHERE l.source_table = ? AND l.source_id = ? AND b.status IN ('Generated','Paid') ${finalizedOnly ? 'AND b.is_finalized = 1' : ''}
     LIMIT 1`, [sourceTable, sourceId]);
  return rows[0] || null;
}

const OPEN_END = '9999-12-31';

/**
 * A finalized active batch whose period overlaps [from, to] for this machine (its vendor, the machine — or the list of
 * machines chosen by hand for the batch — the site). siteId null = any site (an adjustment without site, a deployment).
 * Used for what still follows the period (deployments, fuel terms, the date of a correction settlement).
 */
async function finalizedOverlap(executor, { vendorId, equipmentId, siteId = null, from, to = null }) {
  let vid = vendorId;
  if (!vid && equipmentId) {
    const [[m]] = await executor.execute('SELECT vendor_id FROM eq_equipment WHERE equipment_id = ?', [equipmentId]);
    vid = m ? m.vendor_id : null;
  }
  const [rows] = await executor.execute(
    `SELECT eq_batch_id, start_date, end_date, status FROM eq_payroll_batches
     WHERE status IN ('Generated','Paid') AND is_finalized = 1 AND start_date <= ? AND end_date >= ?
       AND (scope_vendor_id IS NULL OR scope_vendor_id = ?)
       AND (scope_equipment_id IS NULL OR scope_equipment_id = ?)
       AND (NOT EXISTS (SELECT 1 FROM eq_payroll_batch_machines m WHERE m.eq_batch_id = eq_payroll_batches.eq_batch_id)
         OR EXISTS (SELECT 1 FROM eq_payroll_batch_machines m WHERE m.eq_batch_id = eq_payroll_batches.eq_batch_id AND m.equipment_id = ?))
       AND (? IS NULL OR scope_site_id IS NULL OR scope_site_id = ?)
     ORDER BY end_date DESC LIMIT 1`, [to || OPEN_END, String(from).slice(0, 10), vid, equipmentId, equipmentId, siteId, siteId]);
  return rows[0] || null;
}

/** A finalized active batch overlapping [from, to] that covers a site (any vendor / machine). For supervisor periods. */
async function finalizedOverlapForSite(executor, { siteId, from, to = null }) {
  const [rows] = await executor.execute(
    `SELECT eq_batch_id, start_date, end_date, status FROM eq_payroll_batches
     WHERE status IN ('Generated','Paid') AND is_finalized = 1 AND start_date <= ? AND end_date >= ?
       AND (scope_site_id IS NULL OR scope_site_id = ?)
     ORDER BY end_date DESC LIMIT 1`, [to || OPEN_END, String(from).slice(0, 10), siteId]);
  return rows[0] || null;
}

function closedError(b, what, from, to) {
  const when = to && to !== from ? `${from} to ${to === OPEN_END ? 'open' : to}` : from;
  return AppError.conflict('PAYROLL_PERIOD_FINALIZED',
    `${what} (${when}) falls inside invoice batch #${b.eq_batch_id} (${b.start_date} to ${b.end_date}), which is ${b.status === 'Paid' ? 'Paid' : 'Finalized'}. `
    + 'Use a date in an open period, or an official Correction for what that batch billed.',
    { eq_batch_id: b.eq_batch_id, start_date: b.start_date, end_date: b.end_date });
}

/** Refuse an entry dated inside a finalized period of this machine (fuel, adjustment, deployment...). */
async function assertOpen(executor, { vendorId, equipmentId, siteId = null, from, to = null, what = 'This date' }) {
  const b = await finalizedOverlap(executor, { vendorId, equipmentId, siteId, from, to: to || from });
  if (b) throw closedError(b, what, from, to || from);
}

/** Same for a range left open at the end (to = null means "and after"). */
async function assertRangeOpen(executor, { vendorId, equipmentId, siteId = null, from, to = null, what }) {
  const b = await finalizedOverlap(executor, { vendorId, equipmentId, siteId, from, to });
  if (b) throw closedError(b, what, from, to || OPEN_END);
}

/**
 * Deployments (11 Oct 2026, every unit billed once): a change is refused only when it touches what a FINALIZED batch
 * billed for THIS machine in [from, to] — its attendance rows or its monthly days. A machine nobody billed in a finalized
 * period (forgotten, deployed late) can be deployed there and is billed by the next batch.
 */
async function assertMachineRangeOpen(executor, { equipmentId, from, to = null, what }) {
  const end = to || OPEN_END;
  const start = String(from).slice(0, 10);
  const [rows] = await executor.execute(
    `SELECT b.eq_batch_id, b.start_date, b.end_date, b.status FROM eq_payroll_batches b
     WHERE b.status IN ('Generated','Paid') AND b.is_finalized = 1 AND (
       EXISTS (SELECT 1 FROM eq_payroll_monthly_days md WHERE md.eq_batch_id = b.eq_batch_id AND md.equipment_id = ? AND md.day BETWEEN ? AND ?)
       OR EXISTS (SELECT 1 FROM eq_payroll_attendance_snapshot s JOIN eq_payroll_items i ON i.eq_item_id = s.eq_item_id
                  WHERE s.eq_batch_id = b.eq_batch_id AND i.equipment_id = ? AND s.record_date BETWEEN ? AND ?))
     ORDER BY b.end_date DESC LIMIT 1`, [equipmentId, start, end, equipmentId, start, end]);
  if (rows[0]) {
    const b = { ...rows[0], start_date: String(rows[0].start_date).slice(0, 10), end_date: String(rows[0].end_date).slice(0, 10) };
    throw closedError(b, what, start, to || OPEN_END);
  }
}

async function assertSiteRangeOpen(executor, { siteId, from, to = null, what }) {
  const b = await finalizedOverlapForSite(executor, { siteId, from, to });
  if (b) throw closedError(b, what, from, to || OPEN_END);
}

module.exports = {
  findLock, assertEqEditable, batchHoldingRow, batchHoldingMonthlyDay, sourceConsumed, generatedBatchHoldingRow, rowPayrollEffect,
  finalizedOverlap, finalizedOverlapForSite, assertOpen, assertRangeOpen, assertMachineRangeOpen, assertSiteRangeOpen, OPEN_END,
};
