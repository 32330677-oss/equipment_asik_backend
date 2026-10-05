// services/equipment/eqCommon.js — shared loaders and small helpers for the equipment module.
const AppError = require('../../utils/AppError');
const { activeOnSql } = require('../../utils/ranges');

async function one(conn, sql, params, what) {
  const [rows] = await conn.execute(sql, params);
  if (!rows[0]) throw AppError.notFound(what);
  return rows[0];
}

const lockSuffix = (lock) => (lock ? ' FOR UPDATE' : '');
const loadVendor = (conn, id, lock) => one(conn, `SELECT * FROM eq_vendors WHERE vendor_id = ?${lockSuffix(lock)}`, [id], 'Vendor');
const loadContract = (conn, id, lock) => one(conn, `SELECT * FROM eq_vendor_contracts WHERE vendor_contract_id = ?${lockSuffix(lock)}`, [id], 'Contract');
const loadMachine = (conn, id, lock) => one(conn, `SELECT * FROM eq_equipment WHERE equipment_id = ?${lockSuffix(lock)}`, [id], 'Machine');
const loadOperator = (conn, id, lock) => one(conn, `SELECT * FROM eq_operators WHERE operator_id = ?${lockSuffix(lock)}`, [id], 'Operator');
const loadRateCard = (conn, id, lock) => one(conn, `SELECT * FROM eq_rate_cards WHERE rate_card_id = ?${lockSuffix(lock)}`, [id], 'Rate card');
const loadSite = (conn, id, lock) => one(conn, `SELECT * FROM sites WHERE site_id = ?${lockSuffix(lock)}`, [id], 'Site');
const loadDeployment = (conn, id, lock) => one(conn, `SELECT * FROM eq_site_assignments WHERE eq_assignment_id = ?${lockSuffix(lock)}`, [id], 'Deployment');

/** Next code like VND-001 / EQ-0001 (table locked by the caller's transaction via FOR UPDATE on the max row). */
async function nextCode(conn, table, column, prefix, width) {
  const [rows] = await conn.query(
    `SELECT ${column} AS code FROM ${table} WHERE ${column} LIKE ? ORDER BY LENGTH(${column}) DESC, ${column} DESC LIMIT 1 FOR UPDATE`,
    [`${prefix}%`]);
  const last = rows[0] ? parseInt(String(rows[0].code).slice(prefix.length), 10) || 0 : 0;
  return `${prefix}${String(last + 1).padStart(width, '0')}`;
}

/** Rate card in force for a machine on a date (with contract currency + vendor). */
async function rateCardOn(conn, equipmentId, date) {
  const [rows] = await conn.execute(
    `SELECT rc.*, vc.currency, vc.vendor_id, vc.contract_number FROM eq_rate_cards rc
     JOIN eq_vendor_contracts vc ON vc.vendor_contract_id = rc.vendor_contract_id
     WHERE rc.equipment_id = ? AND ${activeOnSql('rc', 'effective_from', 'effective_to')}
     ORDER BY rc.effective_from DESC LIMIT 1`, [equipmentId, date, date]);
  return rows[0] || null;
}

/** True when the rate card is referenced by an active finalized payroll batch. */
async function rateCardLocked(conn, rateCardId) {
  const [rows] = await conn.execute(
    `SELECT b.eq_batch_id FROM eq_payroll_items i JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id
     WHERE i.rate_card_id = ? AND b.status IN ('Generated','Paid') AND b.is_finalized = 1 LIMIT 1`, [rateCardId]);
  return rows[0] ? rows[0].eq_batch_id : null;
}

/** Last record date billed by an active batch for a rate card (for close rules). */
async function rateCardLastBilledDate(conn, rateCardId) {
  const [rows] = await conn.execute(
    `SELECT MAX(s.record_date) AS d FROM eq_payroll_attendance_snapshot s
     JOIN eq_payroll_items i ON i.eq_item_id = s.eq_item_id JOIN eq_payroll_batches b ON b.eq_batch_id = s.eq_batch_id
     WHERE i.rate_card_id = ? AND b.status IN ('Generated','Paid')`, [rateCardId]);
  return rows[0] && rows[0].d ? rows[0].d : null;
}

/** Deployment covering (machine, date), any site. */
async function deploymentOn(conn, equipmentId, date) {
  const [rows] = await conn.execute(
    `SELECT * FROM eq_site_assignments WHERE equipment_id = ? AND ${activeOnSql('', 'assigned_date', 'unassigned_date')}
     AND (unassigned_date IS NULL OR unassigned_date >= assigned_date) LIMIT 1`, [equipmentId, date, date]);
  return rows[0] || null;
}

/** BR-11: machine deployed to (site, shift) on the date. */
async function assertMachineDeployed(conn, equipmentId, siteId, shiftType, date) {
  const [rows] = await conn.execute(
    `SELECT eq_assignment_id, default_operator_id FROM eq_site_assignments
     WHERE equipment_id = ? AND site_id = ? AND shift_type = ? AND ${activeOnSql('', 'assigned_date', 'unassigned_date')} LIMIT 1`,
    [equipmentId, siteId, shiftType, date, date]);
  if (!rows[0]) throw AppError.badRequest('MACHINE_NOT_ASSIGNED', `The machine is not deployed to this site/shift on ${date}.`);
  return rows[0];
}

/** Parse JSON columns that MariaDB may return as strings. */
function parseJson(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return v; } }
  return v;
}

module.exports = {
  loadVendor, loadContract, loadMachine, loadOperator, loadRateCard, loadSite, loadDeployment,
  nextCode, rateCardOn, rateCardLocked, rateCardLastBilledDate, deploymentOn, assertMachineDeployed, parseJson,
};
