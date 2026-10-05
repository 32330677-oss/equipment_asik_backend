// services/equipment/eqLock.js — rows/dates covered by a FINALIZED active equipment payroll batch are
// locked for normal operations (BR-23). Only the Admin correction workflow may change them.
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

async function batchCoveringDate(executor, { vendorId, equipmentId, siteId, date }) {
  const [rows] = await executor.execute(
    `SELECT eq_batch_id, start_date, end_date, status FROM eq_payroll_batches
     WHERE status IN ('Generated','Paid') AND is_finalized = 1 AND start_date <= ? AND end_date >= ?
       AND (scope_vendor_id IS NULL OR scope_vendor_id = ?)
       AND (scope_equipment_id IS NULL OR scope_equipment_id = ?)
       AND (scope_site_id IS NULL OR scope_site_id = ?)
     ORDER BY eq_batch_id DESC LIMIT 1`, [date, date, vendorId, equipmentId, siteId]);
  return rows[0] || null;
}

/** Returns the locking batch for a (possibly new) row, or null. row: {eq_attendance_id?, equipment_id, site_id, record_date} */
async function findLock(executor, row) {
  const held = await batchHoldingRow(executor, row.eq_attendance_id);
  if (held) return held;
  let vendorId = row.vendor_id;
  if (!vendorId) {
    const [[m]] = await executor.execute('SELECT vendor_id FROM eq_equipment WHERE equipment_id = ?', [row.equipment_id]);
    vendorId = m ? m.vendor_id : null;
  }
  return batchCoveringDate(executor, { vendorId, equipmentId: row.equipment_id, siteId: row.site_id, date: String(row.record_date).slice(0, 10) });
}

async function assertEqEditable(executor, row) {
  const b = await findLock(executor, row);
  if (b) {
    throw AppError.conflict('PAYROLL_PERIOD_FINALIZED',
      `${String(row.record_date).slice(0, 10)} is inside equipment payroll batch #${b.eq_batch_id} (${b.start_date} to ${b.end_date}), which is ${b.status === 'Paid' ? 'Paid' : 'Finalized'}. Normal changes are locked; an Admin can use "Correction" (reason required).`,
      { eq_batch_id: b.eq_batch_id });
  }
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
 * A finalized active batch whose period overlaps [from, to] for this machine (its vendor, the machine, the site).
 * siteId null = any site (an adjustment without site, a monthly deployment).
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
       AND (? IS NULL OR scope_site_id IS NULL OR scope_site_id = ?)
     ORDER BY end_date DESC LIMIT 1`, [to || OPEN_END, String(from).slice(0, 10), vid, equipmentId, siteId, siteId]);
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
    `${what} (${when}) falls inside payroll batch #${b.eq_batch_id} (${b.start_date} to ${b.end_date}), which is ${b.status === 'Paid' ? 'Paid' : 'Finalized'}. `
    + 'Use a date in an open period, or an official Correction for the closed period.',
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

async function assertSiteRangeOpen(executor, { siteId, from, to = null, what }) {
  const b = await finalizedOverlapForSite(executor, { siteId, from, to });
  if (b) throw closedError(b, what, from, to || OPEN_END);
}

module.exports = {
  findLock, assertEqEditable, batchHoldingRow, sourceConsumed,
  finalizedOverlap, finalizedOverlapForSite, assertOpen, assertRangeOpen, assertSiteRangeOpen, OPEN_END,
};
