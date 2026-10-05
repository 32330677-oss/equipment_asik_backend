// Deployments: machine -> site/shift between two INCLUSIVE dates (BR-07..BR-10).
const { pool, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { v, validate, parseId } = require('../../utils/validate');
const audit = require('../../services/audit');
const { addDays } = require('../../utils/businessDate');
const { overlapsSql, activeOnSql } = require('../../utils/ranges');
const C = require('../../services/equipment/eqCommon');
const lock = require('../../services/equipment/eqLock');

async function assertOperatorOk(conn, operatorId, machine) {
  if (!operatorId) return;
  const op = await C.loadOperator(conn, operatorId);
  if (op.vendor_id !== machine.vendor_id) throw AppError.badRequest('OPERATOR_OTHER_VENDOR', 'The operator belongs to another vendor.');
  if (op.status !== 'Active') throw AppError.badRequest('OPERATOR_INACTIVE', 'The operator is Inactive.');
}

async function insertDeployment(conn, req, d) {
  const machine = await C.loadMachine(conn, d.equipment_id, true);
  if (machine.status !== 'Active') throw AppError.badRequest('MACHINE_NOT_ACTIVE', 'The machine is not Active.');
  const site = await C.loadSite(conn, d.site_id);
  if (site.status !== 'Active') throw AppError.badRequest('SITE_NOT_ACTIVE', 'The site is not Active.');
  if (d.shift_type === 'Night' && Number(site.has_night_shift) !== 1) throw AppError.badRequest('NO_NIGHT_SHIFT', 'This site has no Night shift.');
  if (d.unassigned_date && d.unassigned_date < d.assigned_date) throw AppError.validation({ unassigned_date: 'must be on or after assigned_date' });
  await assertOperatorOk(conn, d.default_operator_id, machine);
  // a deployment inside a finalized period would change monthly bases already invoiced
  await lock.assertRangeOpen(conn, { vendorId: machine.vendor_id, equipmentId: d.equipment_id, from: d.assigned_date, to: d.unassigned_date || null, what: 'This deployment' });
  const [clash] = await conn.execute(
    `SELECT a.eq_assignment_id, s.site_code, a.shift_type, a.assigned_date, a.unassigned_date FROM eq_site_assignments a JOIN sites s ON s.site_id = a.site_id
     WHERE a.equipment_id = ? AND a.shift_type = ? AND (a.unassigned_date IS NULL OR a.unassigned_date >= a.assigned_date)
       AND ${overlapsSql('a', 'assigned_date', 'unassigned_date')}`,
    [d.equipment_id, d.shift_type, d.unassigned_date || null, d.assigned_date]);
  // A machine may work Day AND Night at the same time (even on two sites), but never two deployments on the same shift.
  if (clash.length) {
    throw AppError.conflict('DEPLOYMENT_OVERLAP',
      `The machine is already deployed on the ${d.shift_type} shift at ${clash[0].site_code} in that period. End that deployment first.`, { conflicts: clash });
  }
  const [r] = await conn.execute(
    `INSERT INTO eq_site_assignments (equipment_id, site_id, shift_type, assigned_date, unassigned_date, default_operator_id, assigned_by_user_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [d.equipment_id, d.site_id, d.shift_type, d.assigned_date, d.unassigned_date || null, d.default_operator_id || null, req.user.user_id, d.notes || null]);
  const row = await C.loadDeployment(conn, r.insertId);
  await audit.log(conn, { table: 'eq_site_assignments', id: r.insertId, action: 'create', newValues: row, ...audit.ctx(req) });
  const warnings = [];
  if (!(await C.rateCardOn(conn, d.equipment_id, d.assigned_date))) warnings.push('NO_RATE_CARD_ON_START_DATE');
  return { row, warnings };
}

exports.list = async (req, res) => {
  const where = []; const params = [];
  if (req.query.site_id) { where.push('a.site_id = ?'); params.push(Number(req.query.site_id)); }
  if (req.query.equipment_id) { where.push('a.equipment_id = ?'); params.push(Number(req.query.equipment_id)); }
  if (req.query.active_on) { where.push(activeOnSql('a', 'assigned_date', 'unassigned_date')); params.push(String(req.query.active_on), String(req.query.active_on)); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await pool.query(
    `SELECT a.*, e.equipment_code, t.type_name, s.site_code, s.site_name, vd.vendor_name, o.full_name AS default_operator_name
     FROM eq_site_assignments a JOIN eq_equipment e ON e.equipment_id = a.equipment_id JOIN eq_types t ON t.type_id = e.type_id
     JOIN sites s ON s.site_id = a.site_id JOIN eq_vendors vd ON vd.vendor_id = e.vendor_id
     LEFT JOIN eq_operators o ON o.operator_id = a.default_operator_id ${w}
     ORDER BY a.assigned_date DESC, e.equipment_code LIMIT 1000`, params);
  res.json({ status: 'success', data: rows });
};

exports.create = async (req, res) => {
  const d = validate(req.body, {
    equipment_id: v.id({ required: true }), site_id: v.id({ required: true }),
    shift_type: v.enumOf(['Day', 'Night'], { default: 'Day' }),
    assigned_date: v.date({ required: true }), unassigned_date: v.date(),
    default_operator_id: v.id(), notes: v.string({ max: 500 }),
  });
  const { row, warnings } = await withTransaction((conn) => insertDeployment(conn, req, d));
  res.status(201).json({ status: 'success', data: row, warnings });
};

async function assertNoRowsAfter(conn, dep, lastDay) {
  const [rows] = await conn.execute(
    `SELECT MIN(record_date) AS first_after, COUNT(*) AS n FROM eq_attendance
     WHERE equipment_id = ? AND site_id = ? AND shift_type = ? AND record_date > ?`,
    [dep.equipment_id, dep.site_id, dep.shift_type, lastDay]);
  if (Number(rows[0].n) > 0) {
    throw AppError.conflict('ATTENDANCE_AFTER_END', `There is attendance on ${rows[0].first_after}, after the new end date.`, { first_after: rows[0].first_after, rows: Number(rows[0].n) });
  }
}

exports.end = async (req, res) => {
  const id = parseId(req.params.id);
  const { unassigned_date, reason } = validate(req.body, { unassigned_date: v.date({ required: true }), reason: v.string({ max: 500 }) });
  const row = await withTransaction(async (conn) => {
    const before = await C.loadDeployment(conn, id, true);
    if (unassigned_date < addDays(before.assigned_date, -1)) throw AppError.validation({ unassigned_date: 'cannot be before assigned_date - 1 (cancelled deployment)' });
    if (before.unassigned_date && unassigned_date > before.unassigned_date) throw AppError.validation({ unassigned_date: 'can only shorten a deployment' });
    await lock.assertRangeOpen(conn, { equipmentId: before.equipment_id, from: addDays(unassigned_date, 1), to: before.unassigned_date, what: 'Ending this deployment removes days that' });
    await assertNoRowsAfter(conn, before, unassigned_date);
    await conn.execute('UPDATE eq_site_assignments SET unassigned_date = ? WHERE eq_assignment_id = ?', [unassigned_date, id]);
    await audit.log(conn, { table: 'eq_site_assignments', id, action: 'end', oldValues: { unassigned_date: before.unassigned_date }, newValues: { unassigned_date }, reason: reason || null, ...audit.ctx(req) });
    return C.loadDeployment(conn, id);
  });
  res.json({ status: 'success', data: row });
};

exports.transfer = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body, {
    target_site_id: v.id({ required: true }), target_shift_type: v.enumOf(['Day', 'Night'], { default: 'Day' }),
    first_day_at_target: v.date({ required: true }), default_operator_id: v.id(), notes: v.string({ max: 500 }),
  });
  const result = await withTransaction(async (conn) => {
    const before = await C.loadDeployment(conn, id, true);
    if (d.first_day_at_target <= before.assigned_date) throw AppError.validation({ first_day_at_target: 'must be after the current deployment start' });
    if (before.unassigned_date && d.first_day_at_target > before.unassigned_date) throw AppError.validation({ first_day_at_target: 'the current deployment already ended before that date' });
    if (before.site_id === d.target_site_id && before.shift_type === d.target_shift_type) throw AppError.badRequest('SAME_SITE', 'The target is the same site and shift.');
    const lastDay = addDays(d.first_day_at_target, -1);
    await lock.assertRangeOpen(conn, { equipmentId: before.equipment_id, from: d.first_day_at_target, to: before.unassigned_date, what: 'This transfer' });
    await assertNoRowsAfter(conn, before, lastDay);
    await conn.execute('UPDATE eq_site_assignments SET unassigned_date = ? WHERE eq_assignment_id = ?', [lastDay, id]);
    await audit.log(conn, { table: 'eq_site_assignments', id, action: 'transfer_out', oldValues: { unassigned_date: before.unassigned_date }, newValues: { unassigned_date: lastDay }, ...audit.ctx(req) });
    const created = await insertDeployment(conn, req, {
      equipment_id: before.equipment_id, site_id: d.target_site_id, shift_type: d.target_shift_type,
      assigned_date: d.first_day_at_target, unassigned_date: before.unassigned_date,
      default_operator_id: d.default_operator_id || before.default_operator_id, notes: d.notes || `Transferred from deployment #${id}`,
    });
    return { ended: await C.loadDeployment(conn, id), created: created.row, warnings: created.warnings };
  });
  res.status(201).json({ status: 'success', data: result, warnings: result.warnings });
};

exports.update = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body, { default_operator_id: v.id(), notes: v.string({ max: 500 }) });
  const row = await withTransaction(async (conn) => {
    const before = await C.loadDeployment(conn, id, true);
    if (Object.prototype.hasOwnProperty.call(d, 'default_operator_id') && d.default_operator_id) {
      await assertOperatorOk(conn, d.default_operator_id, await C.loadMachine(conn, before.equipment_id));
    }
    const keys = Object.keys(d);
    if (keys.length) await conn.execute(`UPDATE eq_site_assignments SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE eq_assignment_id = ?`, [...keys.map((k) => d[k]), id]);
    const after = await C.loadDeployment(conn, id);
    await audit.log(conn, { table: 'eq_site_assignments', id, action: 'update', oldValues: before, newValues: after, ...audit.ctx(req) });
    return after;
  });
  res.json({ status: 'success', data: row });
};
