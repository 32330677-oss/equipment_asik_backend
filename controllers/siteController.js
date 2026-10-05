const { pool, withTransaction } = require('../config/db');
const AppError = require('../utils/AppError');
const { v, validate, parseId } = require('../utils/validate');
const audit = require('../services/audit');
const { businessToday, addDays } = require('../utils/businessDate');
const { overlapsSql, activeOnSql } = require('../utils/ranges');
const { supervisorSiteIdsEver } = require('../services/siteAccess');

const SITE_FIELDS = {
  site_code: v.string({ max: 20, pattern: /^[A-Za-z0-9-]+$/, patternMessage: 'letters, digits and dash only' }),
  site_name: v.string({ max: 255 }),
  project_name: v.string({ max: 255 }),
  location: v.string({ max: 255 }),
  has_night_shift: v.bool(),
  day_shift_start: v.time(),
  night_shift_start: v.time(),
};

async function loadSite(conn, id, lock = false) {
  const [rows] = await conn.execute(`SELECT * FROM sites WHERE site_id = ?${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw AppError.notFound('Site');
  return rows[0];
}

async function openDeployments(conn, siteId, shiftType = null) {
  const today = businessToday();
  const [rows] = await conn.execute(
    `SELECT a.eq_assignment_id, e.equipment_code, a.shift_type FROM eq_site_assignments a
     JOIN eq_equipment e ON e.equipment_id = a.equipment_id
     WHERE a.site_id = ? ${shiftType ? 'AND a.shift_type = ?' : ''} AND (a.unassigned_date IS NULL OR a.unassigned_date >= ?)`,
    shiftType ? [siteId, shiftType, today] : [siteId, today]);
  return rows;
}

exports.list = async (req, res) => {
  const where = []; const params = [];
  if (req.query.status) { where.push('s.status = ?'); params.push(String(req.query.status)); }
  if (req.query.q) { where.push('(s.site_code LIKE ? OR s.site_name LIKE ? OR s.project_name LIKE ?)'); const q = `%${req.query.q}%`; params.push(q, q, q); }
  if (req.user.role === 'Supervisor') {
    const ids = await supervisorSiteIdsEver(req.user.user_id);
    if (!ids.length) return res.json({ status: 'success', data: [] });
    where.push(`s.site_id IN (${ids.map(() => '?').join(',')})`); params.push(...ids);
  }
  const today = businessToday();
  const [rows] = await pool.query(
    `SELECT s.*,
       (SELECT COUNT(*) FROM eq_site_assignments a WHERE a.site_id = s.site_id AND ${activeOnSql('a', 'assigned_date', 'unassigned_date')}) AS deployed_machines
     FROM sites s ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.status, s.site_code`,
    [today, today, ...params]);
  res.json({ status: 'success', data: rows });
};

exports.create = async (req, res) => {
  const data = validate(req.body, {
    ...SITE_FIELDS,
    site_code: v.string({ required: true, max: 20, pattern: /^[A-Za-z0-9-]+$/, patternMessage: 'letters, digits and dash only' }),
    site_name: v.string({ required: true, max: 255 }),
  });
  const site = await withTransaction(async (conn) => {
    const [r] = await conn.execute(
      `INSERT INTO sites (site_code, site_name, project_name, location, has_night_shift, day_shift_start, night_shift_start)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [data.site_code.toUpperCase(), data.site_name, data.project_name || null, data.location || null,
        data.has_night_shift ? 1 : 0, data.day_shift_start || null, data.has_night_shift ? (data.night_shift_start || null) : null]);
    const created = await loadSite(conn, r.insertId);
    await audit.log(conn, { table: 'sites', id: r.insertId, action: 'create', newValues: created, ...audit.ctx(req) });
    return created;
  });
  res.status(201).json({ status: 'success', data: site });
};

exports.get = async (req, res) => {
  const id = parseId(req.params.id);
  const site = await loadSite(pool, id);
  const today = businessToday();
  const [supervisors] = await pool.execute(
    `SELECT ss.*, u.full_name, u.username FROM site_supervisors ss JOIN users u ON u.user_id = ss.user_id
     WHERE ss.site_id = ? AND ${activeOnSql('ss', 'from_date', 'to_date')} ORDER BY ss.shift_type`, [id, today, today]);
  const [machines] = await pool.execute(
    `SELECT a.eq_assignment_id, a.shift_type, a.assigned_date, a.unassigned_date, e.equipment_id, e.equipment_code, t.type_name, v.vendor_name
     FROM eq_site_assignments a JOIN eq_equipment e ON e.equipment_id = a.equipment_id
     JOIN eq_types t ON t.type_id = e.type_id JOIN eq_vendors v ON v.vendor_id = e.vendor_id
     WHERE a.site_id = ? AND ${activeOnSql('a', 'assigned_date', 'unassigned_date')} ORDER BY e.equipment_code`, [id, today, today]);
  res.json({ status: 'success', data: { ...site, current_supervisors: supervisors, deployed_machines: machines } });
};

exports.update = async (req, res) => {
  const id = parseId(req.params.id);
  const data = validate(req.body, SITE_FIELDS);
  const site = await withTransaction(async (conn) => {
    const before = await loadSite(conn, id, true);
    if (data.has_night_shift === false && Number(before.has_night_shift) === 1) {
      const today = businessToday();
      const [sup] = await conn.execute("SELECT 1 FROM site_supervisors WHERE site_id = ? AND shift_type = 'Night' AND (to_date IS NULL OR to_date >= ?) LIMIT 1", [id, today]);
      const dep = await openDeployments(conn, id, 'Night');
      if (sup.length || dep.length) throw AppError.conflict('NIGHT_SHIFT_IN_USE', 'End the Night supervisors and Night deployments first.');
    }
    const sets = []; const params = [];
    for (const [k, val] of Object.entries(data)) {
      sets.push(`${k} = ?`);
      params.push(k === 'has_night_shift' ? (val ? 1 : 0) : k === 'site_code' ? val.toUpperCase() : val);
    }
    if (sets.length) await conn.execute(`UPDATE sites SET ${sets.join(', ')} WHERE site_id = ?`, [...params, id]);
    const after = await loadSite(conn, id);
    await audit.log(conn, { table: 'sites', id, action: 'update', oldValues: before, newValues: after, ...audit.ctx(req) });
    return after;
  });
  res.json({ status: 'success', data: site });
};

exports.setStatus = async (req, res) => {
  const id = parseId(req.params.id);
  const { status, reason } = validate(req.body, {
    status: v.enumOf(['Active', 'Suspended', 'Completed'], { required: true }),
    reason: v.string({ max: 500 }),
  });
  const site = await withTransaction(async (conn) => {
    const before = await loadSite(conn, id, true);
    if (status !== 'Active') {
      const dep = await openDeployments(conn, id);
      if (dep.length) throw AppError.conflict('SITE_HAS_DEPLOYED_MACHINES', 'End or transfer the deployed machines first.', { deployments: dep });
    }
    await conn.execute('UPDATE sites SET status = ? WHERE site_id = ?', [status, id]);
    await audit.log(conn, { table: 'sites', id, action: 'status', oldValues: { status: before.status }, newValues: { status }, reason: reason || null, ...audit.ctx(req) });
    return loadSite(conn, id);
  });
  res.json({ status: 'success', data: site });
};

// ---------------------------------------------------------------- supervisors
exports.listSupervisors = async (req, res) => {
  const id = parseId(req.params.id);
  await loadSite(pool, id);
  const [rows] = await pool.execute(
    `SELECT ss.*, u.full_name, u.username, u.status AS user_status FROM site_supervisors ss JOIN users u ON u.user_id = ss.user_id
     WHERE ss.site_id = ? ORDER BY ss.shift_type, ss.from_date DESC`, [id]);
  res.json({ status: 'success', data: rows });
};

async function insertPeriod(conn, req, { siteId, userId, shiftType, fromDate, toDate }) {
  const site = await loadSite(conn, siteId, true);
  if (site.status !== 'Active') throw AppError.conflict('SITE_NOT_ACTIVE', 'The site is not Active.');
  if (shiftType === 'Night' && Number(site.has_night_shift) !== 1) throw AppError.badRequest('NO_NIGHT_SHIFT', 'This site has no Night shift.');
  if (toDate && toDate < fromDate) throw AppError.validation({ to_date: 'must be on or after from_date' });
  const [u] = await conn.execute('SELECT user_id, role, status FROM users WHERE user_id = ?', [userId]);
  if (!u[0] || u[0].role !== 'Supervisor' || u[0].status !== 'Active') {
    throw AppError.badRequest('NOT_A_SUPERVISOR', 'The user must be an Active user with the Supervisor role.');
  }
  const [clash] = await conn.execute(
    `SELECT site_supervisor_id, user_id, from_date, to_date FROM site_supervisors
     WHERE site_id = ? AND shift_type = ? AND ${overlapsSql('', 'from_date', 'to_date')} FOR UPDATE`,
    [siteId, shiftType, toDate || null, fromDate]);
  if (clash.length) {
    throw AppError.conflict('SUPERVISOR_PERIOD_OVERLAP', 'Another supervisor is in charge of this site/shift in that period.', { conflicts: clash });
  }
  const [r] = await conn.execute(
    'INSERT INTO site_supervisors (site_id, shift_type, user_id, from_date, to_date, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?)',
    [siteId, shiftType, userId, fromDate, toDate || null, req.user.user_id]);
  const row = { site_supervisor_id: r.insertId, site_id: siteId, shift_type: shiftType, user_id: userId, from_date: fromDate, to_date: toDate || null };
  await audit.log(conn, { table: 'site_supervisors', id: r.insertId, action: 'assign', newValues: row, ...audit.ctx(req) });
  return row;
}

exports.assignSupervisor = async (req, res) => {
  const siteId = parseId(req.params.id);
  const data = validate(req.body, {
    user_id: v.id({ required: true }),
    shift_type: v.enumOf(['Day', 'Night'], { default: 'Day' }),
    from_date: v.date({ required: true }),
    to_date: v.date(),
  });
  const row = await withTransaction((conn) => insertPeriod(conn, req, {
    siteId, userId: data.user_id, shiftType: data.shift_type, fromDate: data.from_date, toDate: data.to_date }));
  res.status(201).json({ status: 'success', data: row });
};

exports.endSupervisor = async (req, res) => {
  const id = parseId(req.params.id);
  const { to_date } = validate(req.body, { to_date: v.date({ required: true }) });
  const row = await withTransaction(async (conn) => {
    const [rows] = await conn.execute('SELECT * FROM site_supervisors WHERE site_supervisor_id = ? FOR UPDATE', [id]);
    const before = rows[0];
    if (!before) throw AppError.notFound('Supervisor period');
    if (to_date < addDays(before.from_date, -1)) throw AppError.validation({ to_date: 'cannot be before from_date - 1' });
    if (before.to_date && before.to_date < to_date) throw AppError.validation({ to_date: 'can only shorten a period' });
    if (to_date < before.from_date) {
      // from_date - 1 = the period never happened: delete it (the CHECK to_date >= from_date forbids storing it)
      await conn.execute('DELETE FROM site_supervisors WHERE site_supervisor_id = ?', [id]);
      await audit.log(conn, { table: 'site_supervisors', id, action: 'cancel', oldValues: before, ...audit.ctx(req) });
      return { ...before, to_date, cancelled: true };
    }
    await conn.execute('UPDATE site_supervisors SET to_date = ? WHERE site_supervisor_id = ?', [to_date, id]);
    await audit.log(conn, { table: 'site_supervisors', id, action: 'end', oldValues: { to_date: before.to_date }, newValues: { to_date }, ...audit.ctx(req) });
    return { ...before, to_date };
  });
  res.json({ status: 'success', data: row });
};

/** Replace the current supervisor of a site/shift from first_day (ends the old one at first_day - 1). */
exports.replaceSupervisor = async (req, res) => {
  const siteId = parseId(req.params.id);
  const data = validate(req.body, {
    user_id: v.id({ required: true }),
    shift_type: v.enumOf(['Day', 'Night'], { default: 'Day' }),
    first_day: v.date({ required: true }),
  });
  const result = await withTransaction(async (conn) => {
    const [cur] = await conn.execute(
      `SELECT * FROM site_supervisors WHERE site_id = ? AND shift_type = ? AND ${activeOnSql('', 'from_date', 'to_date')} FOR UPDATE`,
      [siteId, data.shift_type, data.first_day, data.first_day]);
    let ended = null;
    if (cur[0]) {
      if (cur[0].user_id === data.user_id) throw AppError.conflict('SAME_SUPERVISOR', 'This user is already the supervisor on that date.');
      const newEnd = addDays(data.first_day, -1);
      if (newEnd < cur[0].from_date) {
        // replaced from its very first day: the old period never happened
        await conn.execute('DELETE FROM site_supervisors WHERE site_supervisor_id = ?', [cur[0].site_supervisor_id]);
        await audit.log(conn, { table: 'site_supervisors', id: cur[0].site_supervisor_id, action: 'cancel', oldValues: cur[0], reason: 'replaced from the first day', ...audit.ctx(req) });
        ended = { ...cur[0], to_date: newEnd, cancelled: true };
      } else {
        await conn.execute('UPDATE site_supervisors SET to_date = ? WHERE site_supervisor_id = ?', [newEnd, cur[0].site_supervisor_id]);
        await audit.log(conn, { table: 'site_supervisors', id: cur[0].site_supervisor_id, action: 'end', oldValues: { to_date: cur[0].to_date }, newValues: { to_date: newEnd }, reason: 'replaced', ...audit.ctx(req) });
        ended = { ...cur[0], to_date: newEnd };
      }
    }
    const created = await insertPeriod(conn, req, { siteId, userId: data.user_id, shiftType: data.shift_type, fromDate: data.first_day, toDate: cur[0] ? cur[0].to_date : null });
    return { ended, created };
  });
  res.status(201).json({ status: 'success', data: result });
};
