// Fuel price difference: national fuel price list + per-machine terms (base price, litres per hour).
// Both are effective-dated and never overwritten once used, so old invoices can always be explained.
const { pool, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { v, validate, parseId } = require('../../utils/validate');
const audit = require('../../services/audit');
const { addDays } = require('../../utils/businessDate');
const C = require('../../services/equipment/eqCommon');
const lock = require('../../services/equipment/eqLock');

const PRICE = (o = {}) => v.number({ min: 0.001, max: 9999999, decimals: 3, ...o });

// ------------------------------------------------------------------ national prices
exports.listPrices = async (req, res) => {
  const [rows] = await pool.query(
    `SELECT p.*, u.full_name AS created_by,
       (SELECT MIN(n.effective_from) FROM eq_fuel_prices n WHERE n.currency = p.currency AND n.effective_from > p.effective_from) AS next_from
     FROM eq_fuel_prices p LEFT JOIN users u ON u.user_id = p.created_by_user_id ORDER BY p.currency, p.effective_from DESC`);
  res.json({ status: 'success', data: rows.map((r) => ({ ...r, effective_to: r.next_from ? addDays(r.next_from, -1) : null })) });
};

/** A price is "used" when a finalized batch of that currency covers dates on or after it and has fuel-difference lines. */
async function priceUsedBy(conn, p) {
  const [[r]] = await conn.execute(
    `SELECT b.eq_batch_id FROM eq_payroll_batches b JOIN eq_payroll_items i ON i.eq_batch_id = b.eq_batch_id
     JOIN eq_payroll_lines l ON l.eq_item_id = i.eq_item_id AND l.line_type = 'FuelPriceDifference'
     WHERE b.currency = ? AND b.is_finalized = 1 AND b.status IN ('Generated','Paid') AND b.end_date >= ? LIMIT 1`, [p.currency, p.effective_from]);
  return r ? r.eq_batch_id : null;
}

exports.createPrice = async (req, res) => {
  const d = validate(req.body, {
    currency: v.currency({ required: true }), effective_from: v.date({ required: true }),
    price_per_liter: PRICE({ required: true }), note: v.string({ max: 500 }),
  });
  const row = await withTransaction(async (conn) => {
    const [[dup]] = await conn.execute('SELECT fuel_price_id FROM eq_fuel_prices WHERE currency = ? AND effective_from = ?', [d.currency, d.effective_from]);
    if (dup) throw AppError.conflict('FUEL_PRICE_EXISTS', 'There is already a price from this date. Delete it first or use another date.');
    const used = await priceUsedBy(conn, d);
    if (used) throw AppError.conflict('PAYROLL_PERIOD_FINALIZED', `Finalized payroll batch #${used} already used fuel prices after this date.`);
    const [r] = await conn.execute(
      'INSERT INTO eq_fuel_prices (currency, effective_from, price_per_liter, note, created_by_user_id) VALUES (?, ?, ?, ?, ?)',
      [d.currency, d.effective_from, d.price_per_liter, d.note || null, req.user.user_id]);
    const [[out]] = await conn.execute('SELECT * FROM eq_fuel_prices WHERE fuel_price_id = ?', [r.insertId]);
    await audit.log(conn, { table: 'eq_fuel_prices', id: r.insertId, action: 'create', newValues: out, ...audit.ctx(req) });
    return out;
  });
  res.status(201).json({ status: 'success', data: row });
};

/** A draft (Generated, not finalized) batch of that currency with fuel-difference lines on or after this price. */
async function priceInDraftBatch(conn, p) {
  const [[r]] = await conn.execute(
    `SELECT b.eq_batch_id FROM eq_payroll_batches b JOIN eq_payroll_items i ON i.eq_batch_id = b.eq_batch_id
     JOIN eq_payroll_lines l ON l.eq_item_id = i.eq_item_id AND l.line_type = 'FuelPriceDifference'
     WHERE b.currency = ? AND b.is_finalized = 0 AND b.status = 'Generated' AND b.end_date >= ? LIMIT 1`, [p.currency, p.effective_from]);
  return r ? r.eq_batch_id : null;
}

exports.deletePrice = async (req, res) => {
  const id = parseId(req.params.id);
  const { reason } = validate(req.body || {}, { reason: v.string({ max: 500 }) });
  await withTransaction(async (conn) => {
    const [[p]] = await conn.execute('SELECT * FROM eq_fuel_prices WHERE fuel_price_id = ? FOR UPDATE', [id]);
    if (!p) throw AppError.notFound('Fuel price');
    const used = await priceUsedBy(conn, p);
    if (used) throw AppError.conflict('PAYROLL_PERIOD_FINALIZED', `This price is used by finalized payroll batch #${used}; it cannot be deleted. A wrong price already paid is fixed by an official Correction.`);
    const draft = await priceInDraftBatch(conn, p);
    if (draft && (!reason || reason.trim().length < 5)) {
      throw AppError.validation({ reason: `draft payroll batch #${draft} uses fuel prices from this date: say why this price is deleted (at least 5 characters)` });
    }
    await conn.execute('DELETE FROM eq_fuel_prices WHERE fuel_price_id = ?', [id]);
    await audit.log(conn, { table: 'eq_fuel_prices', id, action: 'delete', oldValues: p, reason: reason || null, payrollEffect: draft ? `stale:${draft}` : 'none', ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: { deleted: id } });
};

// ------------------------------------------------------------------ machine terms
exports.listTerms = async (req, res) => {
  const id = parseId(req.params.id);
  await C.loadMachine(pool, id);
  const [rows] = await pool.execute(
    `SELECT t.*, u.full_name AS created_by FROM eq_fuel_terms t LEFT JOIN users u ON u.user_id = t.created_by_user_id
     WHERE t.equipment_id = ? ORDER BY t.effective_from DESC`, [id]);
  res.json({ status: 'success', data: rows });
};

/** Last date already paid in a finalized batch with a fuel difference for this machine. */
async function lastFinalizedFuelDay(conn, equipmentId) {
  const [[r]] = await conn.execute(
    `SELECT MAX(s.record_date) AS d FROM eq_payroll_attendance_snapshot s JOIN eq_payroll_items i ON i.eq_item_id = s.eq_item_id
     JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id
     WHERE i.equipment_id = ? AND b.is_finalized = 1 AND b.status IN ('Generated','Paid')
       AND EXISTS (SELECT 1 FROM eq_payroll_lines l WHERE l.eq_item_id = i.eq_item_id AND l.line_type = 'FuelPriceDifference')`, [equipmentId]);
  return r && r.d ? String(r.d) : null;
}

/** New terms from a date. The open terms are closed the day before: the history stays as it was. */
exports.createTerms = async (req, res) => {
  const equipmentId = parseId(req.params.id);
  const d = validate(req.body, {
    effective_from: v.date({ required: true }), base_price_per_liter: PRICE({ required: true }),
    liters_per_hour: v.number({ required: true, min: 0.01, max: 1000, decimals: 3 }), note: v.string({ max: 500 }),
  });
  const row = await withTransaction(async (conn) => {
    await C.loadMachine(conn, equipmentId, true);
    const last = await lastFinalizedFuelDay(conn, equipmentId);
    if (last && d.effective_from <= last) throw AppError.conflict('PAYROLL_PERIOD_FINALIZED', `The fuel difference is already finalized up to ${last}. New terms must start after it.`);
    const [later] = await conn.execute('SELECT fuel_terms_id FROM eq_fuel_terms WHERE equipment_id = ? AND effective_from >= ?', [equipmentId, d.effective_from]);
    if (later.length) throw AppError.conflict('FUEL_TERMS_OVERLAP', 'Terms already start on or after this date. Choose a later date.');
    const [open] = await conn.execute(
      'SELECT * FROM eq_fuel_terms WHERE equipment_id = ? AND (effective_to IS NULL OR effective_to >= ?) FOR UPDATE', [equipmentId, d.effective_from]);
    for (const o of open) {
      await conn.execute('UPDATE eq_fuel_terms SET effective_to = ? WHERE fuel_terms_id = ?', [addDays(d.effective_from, -1), o.fuel_terms_id]);
      await audit.log(conn, { table: 'eq_fuel_terms', id: o.fuel_terms_id, action: 'close', oldValues: { effective_to: o.effective_to }, newValues: { effective_to: addDays(d.effective_from, -1) }, ...audit.ctx(req) });
    }
    const [r] = await conn.execute(
      `INSERT INTO eq_fuel_terms (equipment_id, effective_from, base_price_per_liter, liters_per_hour, note, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`, [equipmentId, d.effective_from, d.base_price_per_liter, d.liters_per_hour, d.note || null, req.user.user_id]);
    const [[out]] = await conn.execute('SELECT * FROM eq_fuel_terms WHERE fuel_terms_id = ?', [r.insertId]);
    await audit.log(conn, { table: 'eq_fuel_terms', id: r.insertId, action: 'create', newValues: out, ...audit.ctx(req) });
    return out;
  });
  res.status(201).json({ status: 'success', data: row });
};

/** Stop the fuel difference of a machine from a date (last day included). */
exports.endTerms = async (req, res) => {
  const id = parseId(req.params.id);
  const { effective_to } = validate(req.body, { effective_to: v.date({ required: true }) });
  const row = await withTransaction(async (conn) => {
    const [[t]] = await conn.execute('SELECT * FROM eq_fuel_terms WHERE fuel_terms_id = ? FOR UPDATE', [id]);
    if (!t) throw AppError.notFound('Fuel terms');
    if (effective_to < addDays(t.effective_from, -1)) throw AppError.validation({ effective_to: 'cannot be before the start date' });
    if (t.effective_to && effective_to > t.effective_to) throw AppError.validation({ effective_to: 'can only shorten the terms' });
    const last = await lastFinalizedFuelDay(conn, t.equipment_id);
    if (last && effective_to < last) throw AppError.conflict('PAYROLL_PERIOD_FINALIZED', `The fuel difference is already finalized up to ${last}.`);
    await conn.execute('UPDATE eq_fuel_terms SET effective_to = ? WHERE fuel_terms_id = ?', [effective_to, id]);
    await audit.log(conn, { table: 'eq_fuel_terms', id, action: 'end', oldValues: { effective_to: t.effective_to }, newValues: { effective_to }, ...audit.ctx(req) });
    const [[out]] = await conn.execute('SELECT * FROM eq_fuel_terms WHERE fuel_terms_id = ?', [id]);
    return out;
  });
  res.json({ status: 'success', data: row });
};

/**
 * Correct the first day of fuel terms entered with a wrong date (e.g. today instead of the day the machine joined).
 * Reason required. Refused when the days added or removed fall inside a finalized payroll of the machine, or when the
 * terms would overlap the previous terms of the machine. Old values stay in the audit log.
 */
exports.changeTermsStart = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body, { effective_from: v.date({ required: true }), reason: v.string({ required: true, min: 5, max: 500 }) });
  const row = await withTransaction(async (conn) => {
    const [[t]] = await conn.execute('SELECT * FROM eq_fuel_terms WHERE fuel_terms_id = ? FOR UPDATE', [id]);
    if (!t) throw AppError.notFound('Fuel terms');
    const old = String(t.effective_from).slice(0, 10);
    if (d.effective_from === old) throw AppError.validation({ effective_from: 'is already the first day' });
    if (t.effective_to && d.effective_from > String(t.effective_to).slice(0, 10)) throw AppError.validation({ effective_from: 'must be on or before the last day of these terms' });
    // the days that change side (added or removed) must all be in an open period of this machine
    const from = d.effective_from < old ? d.effective_from : old;
    const to = addDays(d.effective_from < old ? old : d.effective_from, -1);
    await lock.assertRangeOpen(conn, { equipmentId: t.equipment_id, from, to, what: 'Moving the start of these fuel terms changes days that' });
    const [prev] = await conn.execute(
      `SELECT fuel_terms_id, effective_from, effective_to FROM eq_fuel_terms
       WHERE equipment_id = ? AND fuel_terms_id <> ? AND effective_from < ? AND (effective_to IS NULL OR effective_to >= ?)`,
      [t.equipment_id, id, old, d.effective_from]);
    if (prev.length) {
      throw AppError.conflict('FUEL_TERMS_OVERLAP', `Earlier terms (#${prev[0].fuel_terms_id}, from ${String(prev[0].effective_from).slice(0, 10)}) still cover that date. `
        + 'Stop them the day before first, or choose a later date.', { conflicts: prev });
    }
    await conn.execute('UPDATE eq_fuel_terms SET effective_from = ? WHERE fuel_terms_id = ?', [d.effective_from, id]);
    await audit.log(conn, { table: 'eq_fuel_terms', id, action: 'change_start', oldValues: { effective_from: old }, newValues: { effective_from: d.effective_from },
      reason: d.reason, relatedType: 'eq_equipment', relatedId: t.equipment_id, ...audit.ctx(req) });
    const [[out]] = await conn.execute('SELECT * FROM eq_fuel_terms WHERE fuel_terms_id = ?', [id]);
    return out;
  });
  res.json({ status: 'success', data: row });
};
