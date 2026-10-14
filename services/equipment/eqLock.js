// services/equipment/eqLock.js — what an invoice locks, and for whom (decisions of 13-14 Oct 2026).
//
// An invoice batch covers a PERIOD of each of its machines (eq_invoice_coverage). Everything dated inside that period for
// that machine (attendance, fuel issued, adjustments, delivery notes, deployments, rate card and month terms) follows
// the state of the invoice:
//   Draft        -> anybody who may edit edits; the draft shows it must be recalculated.
//   Issued       -> the office (Admin, Accountant) edits; the invoice is brought up to date with the SAME numbers
//                   (only the audit trail shows it). A supervisor is refused.
//   Handed over  -> nobody edits: withdraw the invoice from finance first (signed acknowledgement), or make a
//                   debit / credit note.
//   Returned     -> (withdrawn from finance) only the Admin edits; the invoice is then re-issued with NEW numbers.
// The current user comes from the request context (utils/requestContext); without one (scripts) the Admin rules apply.
'use strict';

const AppError = require('../../utils/AppError');
const { currentUser } = require('../../utils/requestContext');

/** Batches that bill units and reserve their period. */
const ACTIVE = "b.status IN ('Generated','HandedOver','Returned')";
/** Active and numbered (issued, handed over or returned). */
const NUMBERED = `${ACTIVE} AND b.is_finalized = 1`;
const OPEN_END = '9999-12-31';

const day = (d) => (d ? String(d).slice(0, 10) : null);

/** 'draft' | 'issued' | 'handed_over' | 'returned' | 'cancelled' | 'superseded' | 'replaced' */
function stateOf(b) {
  if (!b) return null;
  switch (b.status) {
    case 'HandedOver': return 'handed_over';
    case 'Returned': return 'returned';
    case 'Voided': return 'cancelled';
    case 'Superseded': return 'superseded';
    case 'Replaced': return 'replaced';
    default: return Number(b.is_finalized) ? 'issued' : 'draft';
  }
}

/** Does this batch stop this user from changing what it covers? */
function denies(b, user = currentUser()) {
  const st = stateOf(b);
  const role = user ? user.role : 'Admin';
  if (st === 'handed_over') return true;
  if (st === 'returned') return role !== 'Admin';
  if (st === 'issued') return role === 'Supervisor';
  return false;
}

const STATE_TEXT = { issued: 'issued', handed_over: 'handed over to finance', returned: 'withdrawn from finance', draft: 'a draft' };

/** The error for a change refused by batch b. */
function lockedError(b, what = 'This date') {
  const st = stateOf(b);
  const ref = `invoice ${b.invoice_no || `batch #${b.eq_batch_id}`} (${day(b.c_from || b.start_date)} to ${day(b.c_to || b.end_date)})`;
  const todo = {
    handed_over: 'Withdraw the invoice from finance first (signed acknowledgement), or make a debit / credit note.',
    returned: 'Only the Admin changes it now (it will be re-issued with new numbers).',
    issued: 'Ask the office (Admin or Accountant) to change it.',
  }[st] || '';
  return AppError.conflict('INVOICE_LOCKED', `${what} is in ${ref}, which is ${STATE_TEXT[st] || st}. ${todo}`.trim(), {
    eq_batch_id: b.eq_batch_id, state: st, invoice_no: b.invoice_no || null, start_date: day(b.c_from || b.start_date), end_date: day(b.c_to || b.end_date),
  });
}

const INVOICE_NO = `(SELECT x.invoice_no FROM eq_invoices x LEFT JOIN eq_invoice_cancellations xc ON xc.invoice_id = x.invoice_id
   WHERE x.eq_batch_id = b.eq_batch_id AND x.kind = 'Vendor' AND x.status = 'Issued' AND xc.invoice_id IS NULL ORDER BY x.invoice_id LIMIT 1)`;

/**
 * Numbered active batches whose coverage of this machine overlaps [from, to] (siteId null = any site), the most locking
 * first (handed over, returned, issued).
 */
async function coveringBatches(executor, { equipmentId, siteId = null, from, to = null }) {
  if (!equipmentId || !from) return [];
  const [rows] = await executor.query(
    `SELECT b.eq_batch_id, b.start_date, b.end_date, b.status, b.is_finalized, c.start_date AS c_from, c.end_date AS c_to, c.site_id AS c_site, ${INVOICE_NO} AS invoice_no
     FROM eq_invoice_coverage c JOIN eq_payroll_batches b ON b.eq_batch_id = c.eq_batch_id
     WHERE c.equipment_id = ? AND ${NUMBERED} AND c.start_date <= ? AND c.end_date >= ?
       AND (? IS NULL OR c.site_id IS NULL OR c.site_id = ?)
     ORDER BY FIELD(b.status, 'HandedOver', 'Returned', 'Generated'), b.eq_batch_id DESC`,
    [equipmentId, day(to || from) || OPEN_END, day(from), siteId ?? null, siteId ?? null]);
  return rows;
}

/** The batch that stops the current user from changing this machine over [from, to], or null. */
async function denyingBatch(executor, { equipmentId, siteId = null, from, to = null }, user = currentUser()) {
  const list = await coveringBatches(executor, { equipmentId, siteId, from, to });
  return list.find((b) => denies(b, user)) || null;
}

/** The numbered batch covering this attendance row (the most locking one), or null — for display. */
async function coveringRow(executor, row) {
  const list = await coveringBatches(executor, { equipmentId: row.equipment_id, siteId: row.site_id, from: row.record_date });
  return list[0] || null;
}

/** The batch that stops the current user from changing this (possibly new) row, or null. row: {equipment_id, site_id, record_date}. */
async function findLock(executor, row) {
  return denyingBatch(executor, { equipmentId: row.equipment_id, siteId: row.site_id, from: row.record_date });
}

async function assertEqEditable(executor, row) {
  const b = await findLock(executor, row);
  if (b) throw lockedError(b, `${day(row.record_date)} of this machine`);
}

/** The DRAFT (not numbered) batch that holds this row: changing the row makes that draft stale. */
async function generatedBatchHoldingRow(executor, eqAttendanceId) {
  const [rows] = await executor.execute(
    `SELECT b.eq_batch_id FROM eq_payroll_attendance_snapshot s JOIN eq_payroll_batches b ON b.eq_batch_id = s.eq_batch_id
     WHERE s.eq_attendance_id = ? AND b.status = 'Generated' ORDER BY b.eq_batch_id DESC LIMIT 1`, [eqAttendanceId]);
  return rows[0] ? rows[0].eq_batch_id : null;
}

/** Text for audit_logs.payroll_effect of a change to an attendance row. */
async function rowPayrollEffect(executor, eqAttendanceId) {
  const g = await generatedBatchHoldingRow(executor, eqAttendanceId);
  return g ? `stale:${g}` : 'none';
}

/**
 * Is a fuel issue / adjustment / delivery note billed by an active batch? With `lockingOnly`: only the batch that stops
 * the current user (handed over; returned for a non-Admin; issued for a supervisor).
 */
async function sourceConsumed(executor, sourceTable, sourceId, lockingOnly = false) {
  const [rows] = await executor.execute(
    `SELECT b.eq_batch_id, b.status, b.is_finalized, b.start_date, b.end_date, ${INVOICE_NO} AS invoice_no
     FROM eq_payroll_lines l JOIN eq_payroll_items i ON i.eq_item_id = l.eq_item_id
     JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id
     WHERE l.source_table = ? AND l.source_id = ? AND ${ACTIVE} ORDER BY b.eq_batch_id DESC`, [sourceTable, sourceId]);
  if (!lockingOnly) return rows[0] || null;
  return rows.find((b) => denies(b)) || null;
}

/** Refuse an entry dated inside a locked period of this machine (fuel, adjustment, delivery note...). */
async function assertOpen(executor, { equipmentId, siteId = null, from, to = null, what = 'This date' }) {
  const b = await denyingBatch(executor, { equipmentId, siteId, from, to: to || from });
  if (b) throw lockedError(b, what);
}

/** Same for a range left open at the end (to = null means "and after"). */
async function assertRangeOpen(executor, { equipmentId, siteId = null, from, to = null, what = 'This change' }) {
  const b = await denyingBatch(executor, { equipmentId, siteId, from, to: to || OPEN_END });
  if (b) throw lockedError(b, what);
}

/** Deployments: the machine over [from, to] (any site). */
async function assertMachineRangeOpen(executor, { equipmentId, from, to = null, what = 'This change' }) {
  return assertRangeOpen(executor, { equipmentId, from, to, what });
}

/**
 * Supervisor periods of a site: refused only while an invoice handed over to finance (or returned, for a non-Admin)
 * bills days of that site in [from, to].
 */
async function assertSiteRangeOpen(executor, { siteId, from, to = null, what = 'This change' }) {
  const [rows] = await executor.query(
    `SELECT DISTINCT b.eq_batch_id, b.start_date, b.end_date, b.status, b.is_finalized, ${INVOICE_NO} AS invoice_no
     FROM eq_payroll_items i JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id
     WHERE i.site_id = ? AND ${NUMBERED} AND b.start_date <= ? AND b.end_date >= ?`, [siteId, day(to) || OPEN_END, day(from)]);
  const b = rows.find((x) => denies(x));
  if (b) throw lockedError(b, what);
}

module.exports = {
  ACTIVE, NUMBERED, OPEN_END, stateOf, denies, lockedError, coveringBatches, denyingBatch, coveringRow,
  findLock, assertEqEditable, generatedBatchHoldingRow, rowPayrollEffect, sourceConsumed,
  assertOpen, assertRangeOpen, assertMachineRangeOpen, assertSiteRangeOpen,
};
