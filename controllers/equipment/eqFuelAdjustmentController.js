// Fuel issued by us and manual adjustments (§5.7).
const { pool, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { v, validate, parseId } = require('../../utils/validate');
const audit = require('../../services/audit');
const storage = require('../../services/fileStorage');
const uploads = require('../../services/uploads');
const { businessToday, businessNow } = require('../../utils/businessDate');
const { assertCanActOnSite } = require('../../services/siteAccess');
const C = require('../../services/equipment/eqCommon');
const lock = require('../../services/equipment/eqLock');
const FV = require('../../services/equipment/eqFileVersions');
const DNR = require('../../services/equipment/eqDnr');

const SUPERVISOR_FUEL_COLS = 'f.fuel_issue_id, f.equipment_id, f.site_id, f.issue_date, f.liters, f.receipt_number, f.is_cancelled, e.equipment_code, s.site_code';

exports.listFuel = async (req, res) => {
  const where = []; const params = [];
  const f = (c, val) => { where.push(c); params.push(val); };
  if (req.query.from) f('f.issue_date >= ?', String(req.query.from));
  if (req.query.to) f('f.issue_date <= ?', String(req.query.to));
  if (req.query.equipment_id) f('f.equipment_id = ?', Number(req.query.equipment_id));
  if (req.query.site_id) f('f.site_id = ?', Number(req.query.site_id));
  if (req.query.vendor_id) f('e.vendor_id = ?', Number(req.query.vendor_id));
  if (req.query.unpriced === 'true') where.push('f.price_per_liter IS NULL AND f.is_cancelled = 0');
  const [rows] = await pool.query(
    `SELECT f.*, e.equipment_code, s.site_code, vd.vendor_name, u.full_name AS issued_by
     FROM eq_fuel_issues f JOIN eq_equipment e ON e.equipment_id = f.equipment_id JOIN sites s ON s.site_id = f.site_id
     JOIN eq_vendors vd ON vd.vendor_id = e.vendor_id JOIN users u ON u.user_id = f.issued_by_user_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY f.issue_date DESC, f.fuel_issue_id DESC LIMIT 1000`, params);
  res.json({ status: 'success', data: rows.map(({ receipt_path, ...r }) => ({ ...r, has_receipt: Boolean(receipt_path) })) });
};

exports.createFuel = async (req, res) => {
  const d = validate(req.body, {
    equipment_id: v.id({ required: true }), site_id: v.id({ required: true }), issue_date: v.date({ default: businessToday() }),
    liters: v.number({ required: true, min: 0.01, max: 100000, decimals: 2 }), receipt_number: v.string({ max: 100 }),
    price_per_liter: v.number({ min: 0, max: 100000, decimals: 3 }), shift_type: v.enumOf(['Day', 'Night'], { default: 'Day' }),
  });
  if (d.issue_date > businessToday()) throw AppError.badRequest('FUTURE_DATE', 'The date cannot be in the future.');
  if (req.user.role === 'Supervisor') {
    delete d.price_per_liter;
    await assertCanActOnSite(req.user, d.site_id, d.shift_type, d.issue_date);
  }
  const row = await withTransaction(async (conn) => {
    const machine = await C.loadMachine(conn, d.equipment_id);
    await C.loadSite(conn, d.site_id);
    // a fuel issue dated inside a finalized period would never be billed: refuse it
    await lock.assertOpen(conn, { vendorId: machine.vendor_id, equipmentId: d.equipment_id, siteId: d.site_id, from: d.issue_date, what: 'This fuel issue date' });
    const [r] = await conn.execute(
      'INSERT INTO eq_fuel_issues (equipment_id, site_id, issue_date, liters, price_per_liter, receipt_number, issued_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [d.equipment_id, d.site_id, d.issue_date, d.liters, d.price_per_liter ?? null, d.receipt_number || null, req.user.user_id]);
    await audit.log(conn, { table: 'eq_fuel_issues', id: r.insertId, action: 'create', newValues: d, ...audit.ctx(req) });
    const [[out]] = await conn.query(
      `SELECT ${req.user.role === 'Supervisor' ? SUPERVISOR_FUEL_COLS : 'f.*, e.equipment_code, s.site_code'} FROM eq_fuel_issues f
       JOIN eq_equipment e ON e.equipment_id = f.equipment_id JOIN sites s ON s.site_id = f.site_id WHERE f.fuel_issue_id = ?`, [r.insertId]);
    return out;
  });
  res.status(201).json({ status: 'success', data: row });
};

async function loadFuel(conn, id) {
  const [[f]] = await conn.execute('SELECT * FROM eq_fuel_issues WHERE fuel_issue_id = ? FOR UPDATE', [id]);
  if (!f) throw AppError.notFound('Fuel issue');
  return f;
}

/**
 * Price, litres or receipt number of a fuel issue in an OPEN period. The first price needs no reason; changing the litres
 * or a price already set does. A fuel issue of a closed (finalized) period is corrected through an official Correction.
 */
exports.updateFuel = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body, {
    price_per_liter: v.number({ min: 0, max: 100000, decimals: 3 }), liters: v.number({ min: 0.01, max: 100000, decimals: 2 }),
    receipt_number: v.string({ max: 100 }), reason: v.string({ max: 500 }),
  });
  const reason = d.reason ? d.reason.trim() : ''; delete d.reason;
  const row = await withTransaction(async (conn) => {
    const before = await loadFuel(conn, id);
    if (before.is_cancelled) throw AppError.conflict('INVALID_STATE', 'This fuel issue is cancelled.');
    const used = await lock.sourceConsumed(conn, 'eq_fuel_issues', id, true);
    if (used) throw AppError.conflict('PAYROLL_PERIOD_FINALIZED', `This fuel issue is in finalized payroll batch #${used.eq_batch_id}. Ask for an official Correction (Corrections tab).`);
    const machine = await C.loadMachine(conn, before.equipment_id);
    // never billed but dated in a closed month: pricing it now must not reopen that month
    await lock.assertOpen(conn, { vendorId: machine.vendor_id, equipmentId: before.equipment_id, siteId: before.site_id, from: String(before.issue_date).slice(0, 10), what: 'This fuel issue date' });
    const changesMoney = (d.liters !== undefined && Number(d.liters) !== Number(before.liters))
      || (d.price_per_liter !== undefined && before.price_per_liter !== null && Number(d.price_per_liter) !== Number(before.price_per_liter));
    if (changesMoney && reason.length < 5) throw AppError.validation({ reason: 'say why the litres or the price already set change (at least 5 characters)' });
    const keys = Object.keys(d);
    if (keys.length) await conn.execute(`UPDATE eq_fuel_issues SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE fuel_issue_id = ?`, [...keys.map((k) => d[k]), id]);
    const after = await loadFuel(conn, id);
    const inBatch = await lock.sourceConsumed(conn, 'eq_fuel_issues', id);
    await audit.log(conn, { table: 'eq_fuel_issues', id, action: before.price_per_liter === null && d.price_per_liter !== undefined && !changesMoney ? 'price' : 'update',
      oldValues: before, newValues: after, reason: reason || null, payrollEffect: inBatch ? `stale:${inBatch.eq_batch_id}` : 'none', ...audit.ctx(req) });
    return after;
  });
  res.json({ status: 'success', data: row });
};

exports.cancelFuel = async (req, res) => {
  const id = parseId(req.params.id);
  const { reason } = validate(req.body, { reason: v.string({ required: true, max: 500 }) });
  await withTransaction(async (conn) => {
    const before = await loadFuel(conn, id);
    if (before.is_cancelled) return;
    // in a FINALIZED batch: official Correction. In a Generated batch: allowed, that batch turns stale (void and regenerate).
    const used = await lock.sourceConsumed(conn, 'eq_fuel_issues', id, true);
    if (used) throw AppError.conflict('PAYROLL_PERIOD_FINALIZED', `This fuel issue is in finalized payroll batch #${used.eq_batch_id}. Ask for an official Correction (Corrections tab).`);
    const inBatch = await lock.sourceConsumed(conn, 'eq_fuel_issues', id);
    await conn.execute('UPDATE eq_fuel_issues SET is_cancelled = 1, cancel_reason = ? WHERE fuel_issue_id = ?', [reason, id]);
    await audit.log(conn, { table: 'eq_fuel_issues', id, action: 'cancel', oldValues: { is_cancelled: 0 }, newValues: { is_cancelled: 1 }, reason,
      payrollEffect: inBatch ? `stale:${inBatch.eq_batch_id}` : 'none', ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: { fuel_issue_id: id, is_cancelled: true } });
};

exports.uploadReceipt = [uploads.single('file'), async (req, res) => {
  const id = parseId(req.params.id);
  const type = uploads.detect(req.file.buffer, ['jpg', 'png', 'webp', 'pdf']);
  const hash = storage.sha256(req.file.buffer);
  const key = `equipment/fuel/${id}-${hash.slice(0, 16)}.${type.ext}`;
  const out = await withTransaction(async (conn) => {
    const f = await loadFuel(conn, id);
    if (req.user.role === 'Supervisor') await assertCanActOnSite(req.user, f.site_id, 'Day', f.issue_date, conn).catch(async () => assertCanActOnSite(req.user, f.site_id, 'Night', f.issue_date, conn));
    // a receipt of fuel already paid by a finalized batch: kept as evidence, but the reason is written down
    const paid = await lock.sourceConsumed(conn, 'eq_fuel_issues', id, true);
    const v = await FV.add(conn, {
      ownerTable: 'eq_fuel_issues', ownerId: id, key, sha256: hash, contentType: type.mime, size: req.file.size || req.file.buffer.length,
      originalName: req.file.originalname, reason: req.body && req.body.reason, userId: req.user.user_id, reasonRequired: Boolean(paid),
    });
    await storage.put({ key, buffer: req.file.buffer, contentType: type.mime });
    await conn.execute('UPDATE eq_fuel_issues SET receipt_path = ? WHERE fuel_issue_id = ?', [key, id]);
    await audit.log(conn, { table: 'eq_fuel_issues', id, action: v.replaced_version ? 'replace_receipt' : 'upload_receipt', oldValues: { receipt_path: f.receipt_path },
      newValues: { receipt_path: key, version_no: v.version_no, sha256: hash }, reason: (req.body && req.body.reason) || null, ...audit.ctx(req) });
    return v;
  });
  res.status(201).json({ status: 'success', data: { fuel_issue_id: id, has_receipt: true, version_no: out.version_no } });
}];

exports.listReceipts = async (req, res) => {
  const id = parseId(req.params.id);
  res.json({ status: 'success', data: await FV.list(pool, 'eq_fuel_issues', id) });
};

exports.downloadReceipt = async (req, res) => {
  const id = parseId(req.params.id);
  const version = req.query.version ? parseId(req.query.version) : null;
  const fv = await FV.get(pool, 'eq_fuel_issues', id, version);
  let key = fv ? fv.storage_key : null;
  if (!key && !version) { const [[f]] = await pool.execute('SELECT receipt_path FROM eq_fuel_issues WHERE fuel_issue_id = ?', [id]); key = f && f.receipt_path; }
  if (!key) throw AppError.notFound('Receipt');
  const ext = FV.extOf(key);
  await storage.send(res, key, { contentType: FV.MIME[ext], fileName: `fuel-receipt-${id}${fv ? `-v${fv.version_no}` : ''}.${ext}` });
};

// ------------------------------------------------------------------ adjustments
const TYPES = ['Mobilization', 'Demobilization', 'Bonus', 'Penalty', 'Damage', 'FuelCorrection', 'Other'];

exports.listAdjustments = async (req, res) => {
  const where = []; const params = [];
  const f = (c, val) => { where.push(c); params.push(val); };
  if (req.query.from) f('a.adjustment_date >= ?', String(req.query.from));
  if (req.query.to) f('a.adjustment_date <= ?', String(req.query.to));
  if (req.query.equipment_id) f('a.equipment_id = ?', Number(req.query.equipment_id));
  if (req.query.vendor_id) f('e.vendor_id = ?', Number(req.query.vendor_id));
  if (req.query.status) f('a.status = ?', String(req.query.status));
  const [rows] = await pool.query(
    `SELECT a.*, e.equipment_code, vd.vendor_name, s.site_code, u.full_name AS created_by, ni.invoice_no AS correction_note_no,
       (SELECT b.eq_batch_id FROM eq_payroll_lines l JOIN eq_payroll_items i ON i.eq_item_id = l.eq_item_id JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id
         WHERE l.source_table = 'eq_adjustments' AND l.source_id = a.adjustment_id AND b.status IN ('Generated','Paid') ORDER BY b.eq_batch_id DESC LIMIT 1) AS in_batch_id
     FROM eq_adjustments a JOIN eq_equipment e ON e.equipment_id = a.equipment_id JOIN eq_vendors vd ON vd.vendor_id = e.vendor_id
     LEFT JOIN sites s ON s.site_id = a.site_id JOIN users u ON u.user_id = a.created_by_user_id
     LEFT JOIN eq_attendance_corrections cc ON cc.correction_id = a.correction_id LEFT JOIN eq_invoices ni ON ni.invoice_id = cc.note_invoice_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.adjustment_date DESC, a.adjustment_id DESC LIMIT 1000`, params);
  res.json({ status: 'success', data: rows });
};

exports.createAdjustment = async (req, res) => {
  const d = validate(req.body, {
    equipment_id: v.id({ required: true }), site_id: v.id(), adjustment_date: v.date({ required: true }),
    adjustment_type: v.enumOf(TYPES, { required: true }), amount: v.number({ required: true, min: -99999999, max: 99999999, decimals: 2 }),
    reason: v.string({ required: true, max: 500 }),
  });
  if (d.amount === 0) throw AppError.validation({ amount: 'cannot be 0' });
  const row = await withTransaction(async (conn) => {
    const machine = await C.loadMachine(conn, d.equipment_id);
    if (d.site_id) await C.loadSite(conn, d.site_id);
    await lock.assertOpen(conn, { vendorId: machine.vendor_id, equipmentId: d.equipment_id, siteId: d.site_id || null, from: d.adjustment_date, what: 'This adjustment date' });
    const card = await C.rateCardOn(conn, d.equipment_id, d.adjustment_date);
    // a machine paid only per delivery note (DNR) has no rate card: the currency is the one of its DNR price
    const dnrPrice = card ? null : (await DNR.ratesForMachines(conn, [d.equipment_id], d.adjustment_date, d.adjustment_date))[0];
    if (!card && !dnrPrice) throw AppError.conflict('NO_RATE_CARD', 'The machine has no rate card or DNR price on that date; the currency is unknown.');
    if (!card && !d.site_id) throw AppError.validation({ site_id: 'is required for a machine paid per delivery note (DNR)' });
    const [r] = await conn.execute(
      `INSERT INTO eq_adjustments (equipment_id, site_id, adjustment_date, adjustment_type, amount, currency, reason, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [d.equipment_id, d.site_id || null, d.adjustment_date, d.adjustment_type, d.amount, card ? card.currency : dnrPrice.currency, d.reason, req.user.user_id]);
    const [[out]] = await conn.execute('SELECT * FROM eq_adjustments WHERE adjustment_id = ?', [r.insertId]);
    await audit.log(conn, { table: 'eq_adjustments', id: r.insertId, action: 'create', newValues: out, ...audit.ctx(req) });
    return out;
  });
  res.status(201).json({ status: 'success', data: row });
};

exports.cancelAdjustment = async (req, res) => {
  const id = parseId(req.params.id);
  const { reason } = validate(req.body, { reason: v.string({ required: true, max: 500 }) });
  await withTransaction(async (conn) => {
    const [[a]] = await conn.execute('SELECT * FROM eq_adjustments WHERE adjustment_id = ? FOR UPDATE', [id]);
    if (!a) throw AppError.notFound('Adjustment');
    if (a.status === 'Cancelled') return;
    // the settlement of an official correction is part of that correction (its debit / credit note is issued): never cancelled by hand
    if (a.correction_id) {
      throw AppError.conflict('CORRECTION_ADJUSTMENT_LOCKED',
        `This adjustment settles correction #${a.correction_id} (official note issued). It cannot be cancelled; a new correction reverses it if needed.`,
        { correction_id: a.correction_id });
    }
    const used = await lock.sourceConsumed(conn, 'eq_adjustments', id, true);
    if (used) throw AppError.conflict('PAYROLL_PERIOD_FINALIZED', `This adjustment is in finalized payroll batch #${used.eq_batch_id}. Reverse it with an official Correction.`);
    const inBatch = await lock.sourceConsumed(conn, 'eq_adjustments', id);
    await conn.execute("UPDATE eq_adjustments SET status = 'Cancelled', cancelled_by_user_id = ?, cancelled_at = ? WHERE adjustment_id = ?", [req.user.user_id, businessNow(), id]);
    await audit.log(conn, { table: 'eq_adjustments', id, action: 'cancel', oldValues: { status: 'Active' }, newValues: { status: 'Cancelled' }, reason,
      payrollEffect: inBatch ? `stale:${inBatch.eq_batch_id}` : 'none', ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: { adjustment_id: id, status: 'Cancelled' } });
};
