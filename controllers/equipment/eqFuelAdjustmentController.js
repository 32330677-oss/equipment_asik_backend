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
    await C.loadMachine(conn, d.equipment_id);
    await C.loadSite(conn, d.site_id);
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

exports.updateFuel = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body, {
    price_per_liter: v.number({ min: 0, max: 100000, decimals: 3 }), liters: v.number({ min: 0.01, max: 100000, decimals: 2 }),
    receipt_number: v.string({ max: 100 }),
  });
  const row = await withTransaction(async (conn) => {
    const before = await loadFuel(conn, id);
    if (before.is_cancelled) throw AppError.conflict('INVALID_STATE', 'This fuel issue is cancelled.');
    const used = await lock.sourceConsumed(conn, 'eq_fuel_issues', id, true);
    if (used) throw AppError.conflict('PAYROLL_PERIOD_FINALIZED', `This fuel issue is in finalized payroll batch #${used.eq_batch_id}.`);
    const keys = Object.keys(d);
    if (keys.length) await conn.execute(`UPDATE eq_fuel_issues SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE fuel_issue_id = ?`, [...keys.map((k) => d[k]), id]);
    const after = await loadFuel(conn, id);
    await audit.log(conn, { table: 'eq_fuel_issues', id, action: 'update', oldValues: before, newValues: after, ...audit.ctx(req) });
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
    const used = await lock.sourceConsumed(conn, 'eq_fuel_issues', id);
    if (used) throw AppError.conflict('FUEL_IN_BATCH', `This fuel issue is used by payroll batch #${used.eq_batch_id}. Void that batch first.`);
    await conn.execute('UPDATE eq_fuel_issues SET is_cancelled = 1, cancel_reason = ? WHERE fuel_issue_id = ?', [reason, id]);
    await audit.log(conn, { table: 'eq_fuel_issues', id, action: 'cancel', reason, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: { fuel_issue_id: id, is_cancelled: true } });
};

exports.uploadReceipt = [uploads.single('file'), async (req, res) => {
  const id = parseId(req.params.id);
  const type = uploads.detect(req.file.buffer, ['jpg', 'png', 'webp', 'pdf']);
  const hash = storage.sha256(req.file.buffer);
  const key = `equipment/fuel/${id}-${hash.slice(0, 16)}.${type.ext}`;
  await withTransaction(async (conn) => {
    const f = await loadFuel(conn, id);
    if (req.user.role === 'Supervisor') await assertCanActOnSite(req.user, f.site_id, 'Day', f.issue_date, conn).catch(async () => assertCanActOnSite(req.user, f.site_id, 'Night', f.issue_date, conn));
    await storage.put({ key, buffer: req.file.buffer, contentType: type.mime });
    await conn.execute('UPDATE eq_fuel_issues SET receipt_path = ? WHERE fuel_issue_id = ?', [key, id]);
    await audit.log(conn, { table: 'eq_fuel_issues', id, action: 'upload_receipt', newValues: { receipt_path: key }, ...audit.ctx(req) });
  });
  res.status(201).json({ status: 'success', data: { fuel_issue_id: id, has_receipt: true } });
}];

exports.downloadReceipt = async (req, res) => {
  const id = parseId(req.params.id);
  const [[f]] = await pool.execute('SELECT receipt_path FROM eq_fuel_issues WHERE fuel_issue_id = ?', [id]);
  if (!f || !f.receipt_path) throw AppError.notFound('Receipt');
  const ext = f.receipt_path.split('.').pop();
  await storage.send(res, f.receipt_path, { contentType: { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' }[ext], fileName: `fuel-receipt-${id}.${ext}` });
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
    `SELECT a.*, e.equipment_code, vd.vendor_name, s.site_code, u.full_name AS created_by
     FROM eq_adjustments a JOIN eq_equipment e ON e.equipment_id = a.equipment_id JOIN eq_vendors vd ON vd.vendor_id = e.vendor_id
     LEFT JOIN sites s ON s.site_id = a.site_id JOIN users u ON u.user_id = a.created_by_user_id
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
    await C.loadMachine(conn, d.equipment_id);
    if (d.site_id) await C.loadSite(conn, d.site_id);
    const card = await C.rateCardOn(conn, d.equipment_id, d.adjustment_date);
    if (!card) throw AppError.conflict('NO_RATE_CARD', 'The machine has no rate card on that date; the currency is unknown.');
    const [r] = await conn.execute(
      `INSERT INTO eq_adjustments (equipment_id, site_id, adjustment_date, adjustment_type, amount, currency, reason, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [d.equipment_id, d.site_id || null, d.adjustment_date, d.adjustment_type, d.amount, card.currency, d.reason, req.user.user_id]);
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
    const used = await lock.sourceConsumed(conn, 'eq_adjustments', id);
    if (used) throw AppError.conflict('ADJUSTMENT_IN_BATCH', `This adjustment is used by payroll batch #${used.eq_batch_id}. Void that batch first.`);
    await conn.execute("UPDATE eq_adjustments SET status = 'Cancelled', cancelled_by_user_id = ?, cancelled_at = ? WHERE adjustment_id = ?", [req.user.user_id, businessNow(), id]);
    await audit.log(conn, { table: 'eq_adjustments', id, action: 'cancel', reason, ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: { adjustment_id: id, status: 'Cancelled' } });
};
