// Equipment types, machines and operators.
const { pool, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { v, validate, parseId, pageParams } = require('../../utils/validate');
const audit = require('../../services/audit');
const storage = require('../../services/fileStorage');
const uploads = require('../../services/uploads');
const { businessToday } = require('../../utils/businessDate');
const { activeOnSql } = require('../../utils/ranges');
const C = require('../../services/equipment/eqCommon');

// ------------------------------------------------------------------ types
exports.listTypes = async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM eq_types ORDER BY is_active DESC, type_name');
  res.json({ status: 'success', data: rows });
};

const TYPE_FIELDS = { type_name: v.string({ max: 100 }), type_name_ar: v.string({ max: 100 }), meter_unit: v.enumOf(['Hours', 'Km', 'None']), is_active: v.bool() };

exports.createType = async (req, res) => {
  const d = validate(req.body, { ...TYPE_FIELDS, type_name: v.string({ required: true, max: 100 }) });
  const row = await withTransaction(async (conn) => {
    const [r] = await conn.execute('INSERT INTO eq_types (type_name, type_name_ar, meter_unit, is_active) VALUES (?, ?, ?, ?)',
      [d.type_name, d.type_name_ar || null, d.meter_unit || 'Hours', d.is_active === false ? 0 : 1]);
    const [[t]] = await conn.execute('SELECT * FROM eq_types WHERE type_id = ?', [r.insertId]);
    await audit.log(conn, { table: 'eq_types', id: r.insertId, action: 'create', newValues: t, ...audit.ctx(req) });
    return t;
  });
  res.status(201).json({ status: 'success', data: row });
};

exports.updateType = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body, TYPE_FIELDS);
  const row = await withTransaction(async (conn) => {
    const [[before]] = await conn.execute('SELECT * FROM eq_types WHERE type_id = ? FOR UPDATE', [id]);
    if (!before) throw AppError.notFound('Type');
    const keys = Object.keys(d);
    if (keys.length) await conn.execute(`UPDATE eq_types SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE type_id = ?`, [...keys.map((k) => (k === 'is_active' ? (d[k] ? 1 : 0) : d[k])), id]);
    if (d.type_name !== undefined && d.type_name !== before.type_name) await C.refreshTypeLabels(conn, id);
    const [[after]] = await conn.execute('SELECT * FROM eq_types WHERE type_id = ?', [id]);
    await audit.log(conn, { table: 'eq_types', id, action: 'update', oldValues: before, newValues: after, ...audit.ctx(req) });
    return after;
  });
  res.json({ status: 'success', data: row });
};

// ------------------------------------------------------------------ machines
const MACHINE_FIELDS = {
  vendor_id: v.id(), type_id: v.id(),
  make: v.string({ max: 100 }), model: v.string({ max: 100 }),
  plate_number: v.string({ max: 50 }), serial_number: v.string({ max: 100 }),
  manufacture_year: v.int({ min: 1950, max: 2100 }), capacity: v.string({ max: 100 }), notes: v.string({ max: 5000 }),
};

/**
 * One row per machine. A machine may be deployed on two shifts at once (Day + Night, same or different sites):
 * the joined deployment is the Day one first; `deployments_today` lists all of them.
 * Placeholders: 6 x today (in order), then the caller's WHERE params.
 */
function machineSummarySql(where) {
  const active = (x) => activeOnSql(x, 'assigned_date', 'unassigned_date');
  return `SELECT e.*, t.type_name, t.type_name_ar, t.meter_unit, vd.vendor_name, vd.vendor_code,
      (SELECT GROUP_CONCAT(CONCAT(s3.site_code, IF(a3.shift_type = 'Night', ' (Night)', '')) ORDER BY a3.shift_type, s3.site_code SEPARATOR ', ')
         FROM eq_site_assignments a3 JOIN sites s3 ON s3.site_id = a3.site_id WHERE a3.equipment_id = e.equipment_id AND ${active('a3')}) AS deployments_today,
      a.eq_assignment_id, a.site_id, a.shift_type, a.assigned_date, a.unassigned_date, s.site_code, s.site_name,
      rc.rate_card_id, rc.billing_mode, rc.hourly_rate, rc.daily_rate, rc.monthly_rate, vc.currency,
      (SELECT COUNT(*) FROM eq_dnr_rates dr WHERE dr.status = 'Active' AND dr.vendor_id = e.vendor_id
         AND (dr.equipment_id IS NULL OR dr.equipment_id = e.equipment_id) AND (dr.effective_to IS NULL OR dr.effective_to >= CURDATE())) AS dnr_rates
    FROM eq_equipment e
    JOIN eq_types t ON t.type_id = e.type_id
    JOIN eq_vendors vd ON vd.vendor_id = e.vendor_id
    LEFT JOIN eq_site_assignments a ON a.eq_assignment_id = (
      SELECT a2.eq_assignment_id FROM eq_site_assignments a2 WHERE a2.equipment_id = e.equipment_id AND ${active('a2')}
      ORDER BY a2.shift_type, a2.assigned_date, a2.eq_assignment_id LIMIT 1)
    LEFT JOIN sites s ON s.site_id = a.site_id
    LEFT JOIN eq_rate_cards rc ON rc.equipment_id = e.equipment_id AND ${activeOnSql('rc', 'effective_from', 'effective_to')}
    LEFT JOIN eq_vendor_contracts vc ON vc.vendor_contract_id = rc.vendor_contract_id
    ${where}`;
}
const todayParams = (today) => [today, today, today, today, today, today];

exports.listMachines = async (req, res) => {
  const { page, pageSize, offset } = pageParams(req.query);
  const today = businessToday();
  const where = []; const params = [];
  if (req.query.vendor_id) { where.push('e.vendor_id = ?'); params.push(Number(req.query.vendor_id)); }
  if (req.query.type_id) { where.push('e.type_id = ?'); params.push(Number(req.query.type_id)); }
  if (req.query.site_id) {
    where.push(`EXISTS (SELECT 1 FROM eq_site_assignments a4 WHERE a4.equipment_id = e.equipment_id AND a4.site_id = ? AND ${activeOnSql('a4', 'assigned_date', 'unassigned_date')})`);
    params.push(Number(req.query.site_id), today, today);
  }
  if (req.query.status) { where.push('e.status = ?'); params.push(String(req.query.status)); }
  if (req.query.deployed === 'true') where.push('a.eq_assignment_id IS NOT NULL');
  if (req.query.deployed === 'false') where.push('a.eq_assignment_id IS NULL');
  if (req.query.q) { where.push('(e.equipment_code LIKE ? OR e.plate_number LIKE ? OR e.serial_number LIKE ? OR e.model LIKE ?)'); const q = `%${req.query.q}%`; params.push(q, q, q, q); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const base = machineSummarySql(w);
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM (${base}) x`, [...todayParams(today), ...params]);
  const [rows] = await pool.query(`${base} ORDER BY e.equipment_code LIMIT ? OFFSET ?`, [...todayParams(today), ...params, pageSize, offset]);
  res.json({ status: 'success', data: rows.map(({ photo_path, ...r }) => ({ ...r, has_photo: Boolean(photo_path) })), meta: { total: Number(total), page, page_size: pageSize } });
};

exports.createMachine = async (req, res) => {
  const d = validate(req.body, { ...MACHINE_FIELDS, vendor_id: v.id({ required: true }), type_id: v.id({ required: true }) });
  const machine = await withTransaction(async (conn) => {
    const vendor = await C.loadVendor(conn, d.vendor_id);
    if (vendor.status !== 'Active') throw AppError.conflict('VENDOR_INACTIVE', 'The vendor is Inactive.');
    const [[type]] = await conn.execute('SELECT * FROM eq_types WHERE type_id = ?', [d.type_id]);
    if (!type) throw AppError.validation({ type_id: 'unknown type' });
    const code = await C.nextCode(conn, 'eq_equipment', 'equipment_code', 'EQ-', 4);
    const [r] = await conn.execute(
      `INSERT INTO eq_equipment (equipment_code, vendor_id, type_id, make, model, plate_number, serial_number, manufacture_year, capacity, notes, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [code, d.vendor_id, d.type_id, d.make || null, d.model || null, d.plate_number || null, d.serial_number || null,
        d.manufacture_year || null, d.capacity || null, d.notes || null, req.user.user_id]);
    await C.assignTypeSeq(conn, r.insertId); // "Excavator #3": next number of this vendor + type
    const created = await C.loadMachine(conn, r.insertId);
    await audit.log(conn, { table: 'eq_equipment', id: r.insertId, action: 'create', newValues: created, ...audit.ctx(req) });
    return created;
  });
  res.status(201).json({ status: 'success', data: machine });
};

exports.getMachine = async (req, res) => {
  const id = parseId(req.params.id);
  const today = businessToday();
  const [rows] = await pool.query(`${machineSummarySql('WHERE e.equipment_id = ?')}`, [...todayParams(today), id]);
  if (!rows[0]) throw AppError.notFound('Machine');
  const { photo_path, ...machine } = rows[0];
  const [deployments] = await pool.execute(
    `SELECT a.*, s.site_code, s.site_name, o.full_name AS default_operator_name FROM eq_site_assignments a
     JOIN sites s ON s.site_id = a.site_id LEFT JOIN eq_operators o ON o.operator_id = a.default_operator_id
     WHERE a.equipment_id = ? ORDER BY a.assigned_date DESC`, [id]);
  const [rateCards] = await pool.execute(
    `SELECT rc.*, vc.contract_number, vc.currency FROM eq_rate_cards rc JOIN eq_vendor_contracts vc ON vc.vendor_contract_id = rc.vendor_contract_id
     WHERE rc.equipment_id = ? ORDER BY rc.effective_from DESC`, [id]);
  const [attendance] = await pool.execute(
    `SELECT ea.eq_attendance_id, ea.record_date, ea.site_id, s.site_code, ea.shift_type, ea.day_status, ea.status, ea.check_in_time,
       ea.check_out_time, ea.working_minutes, ea.paper_status, ea.anomaly_code
     FROM eq_attendance ea JOIN sites s ON s.site_id = ea.site_id WHERE ea.equipment_id = ? ORDER BY ea.record_date DESC LIMIT 10`, [id]);
  const [open] = await pool.execute(
    'SELECT eq_attendance_id, site_id, shift_type, record_date, check_in_time FROM eq_attendance WHERE equipment_id = ? AND check_in_time IS NOT NULL AND check_out_time IS NULL AND status <> \'Cancelled\'', [id]);
  const [fuelTerms] = await pool.execute('SELECT * FROM eq_fuel_terms WHERE equipment_id = ? ORDER BY effective_from DESC', [id]);
  res.json({ status: 'success', data: { ...machine, has_photo: Boolean(photo_path), deployments, rate_cards: rateCards, recent_attendance: attendance, open_session: open[0] || null, fuel_terms: fuelTerms } });
};

exports.updateMachine = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body, MACHINE_FIELDS);
  const machine = await withTransaction(async (conn) => {
    const before = await C.loadMachine(conn, id, true);
    if (d.vendor_id && d.vendor_id !== before.vendor_id) {
      const [[{ n }]] = await conn.execute('SELECT COUNT(*) AS n FROM eq_rate_cards WHERE equipment_id = ?', [id]);
      const [[{ m }]] = await conn.execute('SELECT COUNT(*) AS m FROM eq_attendance WHERE equipment_id = ?', [id]);
      if (Number(n) || Number(m)) throw AppError.conflict('MACHINE_VENDOR_LOCKED', 'The vendor cannot change once the machine has rate cards or attendance.');
      await C.loadVendor(conn, d.vendor_id);
    }
    const keys = Object.keys(d);
    const regroup = (d.vendor_id && d.vendor_id !== before.vendor_id) || (d.type_id && d.type_id !== before.type_id);
    // the old number must not collide with a machine of the new vendor / type (unique per vendor + type)
    if (regroup) await conn.execute('UPDATE eq_equipment SET type_seq = NULL WHERE equipment_id = ?', [id]);
    if (keys.length) await conn.execute(`UPDATE eq_equipment SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE equipment_id = ?`, [...keys.map((k) => d[k]), id]);
    // another vendor or type: the machine takes the next number there (its old number is not reused)
    if (regroup) await C.assignTypeSeq(conn, id);
    const after = await C.loadMachine(conn, id);
    await audit.log(conn, { table: 'eq_equipment', id, action: 'update', oldValues: before, newValues: after, ...audit.ctx(req) });
    return after;
  });
  res.json({ status: 'success', data: machine });
};

exports.setMachineStatus = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body, {
    status: v.enumOf(['Active', 'Inactive', 'Released'], { required: true }),
    effective_date: v.date({ default: businessToday() }),
    reason: v.string({ max: 500 }),
  });
  const machine = await withTransaction(async (conn) => {
    const before = await C.loadMachine(conn, id, true);
    if (d.status !== 'Active') {
      const [dep] = await conn.execute(
        `SELECT a.eq_assignment_id, s.site_code, a.assigned_date, a.unassigned_date FROM eq_site_assignments a JOIN sites s ON s.site_id = a.site_id
         WHERE a.equipment_id = ? AND (a.unassigned_date IS NULL OR a.unassigned_date >= ?) AND (a.unassigned_date IS NULL OR a.unassigned_date >= a.assigned_date)`, [id, d.effective_date]);
      if (dep.length) throw AppError.conflict('MACHINE_STILL_DEPLOYED', `End the machine's deployment before ${d.effective_date} first.`, { deployments: dep });
    }
    await conn.execute('UPDATE eq_equipment SET status = ? WHERE equipment_id = ?', [d.status, id]);
    await audit.log(conn, { table: 'eq_equipment', id, action: 'status', oldValues: { status: before.status }, newValues: { status: d.status, effective_date: d.effective_date }, reason: d.reason || null, ...audit.ctx(req) });
    return C.loadMachine(conn, id);
  });
  res.json({ status: 'success', data: machine });
};

function photoHandlers(table, idCol, loader, folder) {
  const upload = [uploads.single('file'), async (req, res) => {
    const id = parseId(req.params.id);
    const type = uploads.detect(req.file.buffer, ['jpg', 'png', 'webp']);
    const hash = storage.sha256(req.file.buffer);
    const key = `equipment/${folder}/${id}/photo-${hash.slice(0, 16)}.${type.ext}`;
    await withTransaction(async (conn) => {
      const before = await loader(conn, id, true);
      await storage.put({ key, buffer: req.file.buffer, contentType: type.mime });
      await conn.execute(`UPDATE ${table} SET photo_path = ? WHERE ${idCol} = ?`, [key, id]);
      await audit.log(conn, { table, id, action: 'upload_photo', oldValues: { photo_path: before.photo_path }, newValues: { photo_path: key }, ...audit.ctx(req) });
    });
    res.status(201).json({ status: 'success', data: { [idCol]: id, has_photo: true } });
  }];
  const download = async (req, res) => {
    const id = parseId(req.params.id);
    const row = await loader(pool, id);
    if (!row.photo_path) throw AppError.notFound('Photo');
    const ext = row.photo_path.split('.').pop();
    await storage.send(res, row.photo_path, { contentType: { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[ext], fileName: `photo.${ext}` });
  };
  return { upload, download };
}

const machinePhoto = photoHandlers('eq_equipment', 'equipment_id', C.loadMachine, 'machines');
exports.uploadMachinePhoto = machinePhoto.upload;
exports.downloadMachinePhoto = machinePhoto.download;

// ------------------------------------------------------------------ operators
const OPERATOR_FIELDS = {
  vendor_id: v.id(), full_name: v.string({ max: 255 }), phone_number: v.string({ max: 50 }),
  national_id: v.string({ max: 100 }), license_number: v.string({ max: 100 }), license_expiry: v.date(), notes: v.string({ max: 5000 }),
};

exports.listOperators = async (req, res) => {
  const where = []; const params = [];
  if (req.query.vendor_id) { where.push('o.vendor_id = ?'); params.push(Number(req.query.vendor_id)); }
  if (req.query.status) { where.push('o.status = ?'); params.push(String(req.query.status)); }
  if (req.query.q) { where.push('(o.full_name LIKE ? OR o.license_number LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const cols = req.user.role === 'Supervisor'
    ? 'o.operator_id, o.full_name, o.vendor_id, o.license_expiry, o.status, v.vendor_name'
    : 'o.*, v.vendor_name';
  const [rows] = await pool.query(`SELECT ${cols} FROM eq_operators o JOIN eq_vendors v ON v.vendor_id = o.vendor_id ${w} ORDER BY o.full_name`, params);
  const today = businessToday();
  res.json({ status: 'success', data: rows.map(({ photo_path, ...r }) => ({ ...r, license_expired: Boolean(r.license_expiry && r.license_expiry < today) })) });
};

exports.createOperator = async (req, res) => {
  const d = validate(req.body, { ...OPERATOR_FIELDS, vendor_id: v.id({ required: true }), full_name: v.string({ required: true, max: 255 }) });
  const op = await withTransaction(async (conn) => {
    await C.loadVendor(conn, d.vendor_id);
    const [r] = await conn.execute(
      `INSERT INTO eq_operators (vendor_id, full_name, phone_number, national_id, license_number, license_expiry, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [d.vendor_id, d.full_name, d.phone_number || null, d.national_id || null, d.license_number || null, d.license_expiry || null, d.notes || null]);
    const created = await C.loadOperator(conn, r.insertId);
    await audit.log(conn, { table: 'eq_operators', id: r.insertId, action: 'create', newValues: created, ...audit.ctx(req) });
    return created;
  });
  res.status(201).json({ status: 'success', data: op });
};

exports.updateOperator = async (req, res) => {
  const id = parseId(req.params.id);
  const d = validate(req.body, OPERATOR_FIELDS);
  const op = await withTransaction(async (conn) => {
    const before = await C.loadOperator(conn, id, true);
    if (d.vendor_id && d.vendor_id !== before.vendor_id) {
      const [[{ n }]] = await conn.execute('SELECT COUNT(*) AS n FROM eq_attendance WHERE operator_id = ?', [id]);
      if (Number(n)) throw AppError.conflict('OPERATOR_VENDOR_LOCKED', 'The vendor cannot change once the operator has attendance.');
    }
    const keys = Object.keys(d);
    if (keys.length) await conn.execute(`UPDATE eq_operators SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE operator_id = ?`, [...keys.map((k) => d[k]), id]);
    const after = await C.loadOperator(conn, id);
    await audit.log(conn, { table: 'eq_operators', id, action: 'update', oldValues: before, newValues: after, ...audit.ctx(req) });
    return after;
  });
  res.json({ status: 'success', data: op });
};

exports.setOperatorStatus = async (req, res) => {
  const id = parseId(req.params.id);
  const { status, reason } = validate(req.body, { status: v.enumOf(['Active', 'Inactive'], { required: true }), reason: v.string({ max: 500 }) });
  const op = await withTransaction(async (conn) => {
    const before = await C.loadOperator(conn, id, true);
    await conn.execute('UPDATE eq_operators SET status = ? WHERE operator_id = ?', [status, id]);
    if (status === 'Inactive') await conn.execute('UPDATE eq_site_assignments SET default_operator_id = NULL WHERE default_operator_id = ?', [id]);
    await audit.log(conn, { table: 'eq_operators', id, action: 'status', oldValues: { status: before.status }, newValues: { status }, reason: reason || null, ...audit.ctx(req) });
    return C.loadOperator(conn, id);
  });
  res.json({ status: 'success', data: op });
};

const operatorPhoto = photoHandlers('eq_operators', 'operator_id', C.loadOperator, 'operators');
exports.uploadOperatorPhoto = operatorPhoto.upload;
exports.downloadOperatorPhoto = operatorPhoto.download;
