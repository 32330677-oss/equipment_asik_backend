const { pool, withTransaction } = require('../config/db');
const AppError = require('../utils/AppError');
const { v, validate, pageParams, parseId } = require('../utils/validate');
const passwords = require('../services/passwords');
const audit = require('../services/audit');
const { businessToday } = require('../utils/businessDate');

const ROLES = ['Admin', 'Supervisor', 'Accountant'];
const PUBLIC_COLS = `user_id, username, email, full_name, phone_number, role, status, must_change_password,
  failed_login_attempts, locked_until, last_login_at, password_changed_at, created_at, updated_at`;

async function loadUser(conn, id, lock = false) {
  const [rows] = await conn.execute(`SELECT ${PUBLIC_COLS} FROM users WHERE user_id = ?${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw AppError.notFound('User');
  return rows[0];
}

/** BR-P5: never leave the system without an active Admin. */
async function assertNotLastAdmin(conn, user) {
  if (user.role !== 'Admin' || user.status !== 'Active') return;
  const [[{ n }]] = await conn.execute("SELECT COUNT(*) AS n FROM users WHERE role = 'Admin' AND status = 'Active' AND user_id <> ? FOR UPDATE", [user.user_id]);
  if (Number(n) === 0) throw AppError.conflict('LAST_ADMIN', 'This is the last active Admin. Create or activate another Admin first.');
}

/** A supervisor with current/future site periods must be released from the sites first. */
async function assertNoOpenSitePeriods(conn, userId) {
  const today = businessToday();
  const [rows] = await conn.execute(
    `SELECT ss.site_supervisor_id, s.site_code, ss.shift_type FROM site_supervisors ss JOIN sites s ON s.site_id = ss.site_id
     WHERE ss.user_id = ? AND (ss.to_date IS NULL OR ss.to_date >= ?)`, [userId, today]);
  if (rows.length) {
    throw AppError.conflict('USER_HAS_SITE_ASSIGNMENTS', 'End this supervisor\'s site assignments first.', { assignments: rows });
  }
}

exports.list = async (req, res) => {
  const { page, pageSize, offset } = pageParams(req.query);
  const where = []; const params = [];
  if (req.query.role) { where.push('role = ?'); params.push(String(req.query.role)); }
  if (req.query.status) { where.push('status = ?'); params.push(String(req.query.status)); }
  if (req.query.q) { where.push('(username LIKE ? OR full_name LIKE ? OR email LIKE ?)'); const q = `%${req.query.q}%`; params.push(q, q, q); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM users ${w}`, params);
  const [rows] = await pool.query(`SELECT ${PUBLIC_COLS} FROM users ${w} ORDER BY status, role, full_name LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
  res.json({ status: 'success', data: rows, meta: { total: Number(total), page, page_size: pageSize } });
};

exports.create = async (req, res) => {
  const data = validate(req.body, {
    username: v.string({ required: true, min: 3, max: 100, pattern: /^[A-Za-z0-9._-]+$/, patternMessage: 'may contain letters, digits, dot, dash and underscore only' }),
    full_name: v.string({ required: true, max: 255 }),
    email: v.string({ max: 255, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/, patternMessage: 'must be a valid email' }),
    phone_number: v.string({ max: 50 }),
    role: v.enumOf(ROLES, { required: true }),
  });
  const temp = passwords.temporary();
  const hash = await passwords.hash(temp);
  const user = await withTransaction(async (conn) => {
    const [dup] = await conn.execute('SELECT user_id FROM users WHERE LOWER(username) = LOWER(?) OR (email IS NOT NULL AND email = ?)', [data.username, data.email || null]);
    if (dup.length) throw AppError.conflict('DUPLICATE', 'Username or email already used.');
    const [r] = await conn.execute(
      `INSERT INTO users (username, email, full_name, phone_number, password_hash, role, must_change_password, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      [data.username, data.email || null, data.full_name, data.phone_number || null, hash, data.role, req.user.user_id]
    );
    const created = await loadUser(conn, r.insertId);
    await audit.log(conn, { table: 'users', id: r.insertId, action: 'create', newValues: created, ...audit.ctx(req) });
    return created;
  });
  res.status(201).json({ status: 'success', data: { ...user, temporary_password: temp }, message: 'User created. Give the temporary password to the user; it is shown only once.' });
};

exports.get = async (req, res) => {
  const id = parseId(req.params.id);
  const user = await loadUser(pool, id);
  const [sites] = await pool.execute(
    `SELECT ss.site_supervisor_id, ss.site_id, s.site_code, s.site_name, ss.shift_type, ss.from_date, ss.to_date
     FROM site_supervisors ss JOIN sites s ON s.site_id = ss.site_id WHERE ss.user_id = ? ORDER BY ss.from_date DESC`, [id]);
  const [logins] = await pool.execute(
    'SELECT success, ip_address, created_at FROM login_history WHERE user_id = ? ORDER BY login_id DESC LIMIT 10', [id]);
  res.json({ status: 'success', data: { ...user, supervised_sites: sites, last_logins: logins } });
};

exports.update = async (req, res) => {
  const id = parseId(req.params.id);
  const data = validate(req.body, {
    full_name: v.string({ max: 255 }),
    email: v.string({ max: 255, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/, patternMessage: 'must be a valid email' }),
    phone_number: v.string({ max: 50 }),
    role: v.enumOf(ROLES),
  });
  const updated = await withTransaction(async (conn) => {
    const before = await loadUser(conn, id, true);
    if (data.role && data.role !== before.role) {
      await assertNotLastAdmin(conn, before);
      if (before.role === 'Supervisor') await assertNoOpenSitePeriods(conn, id);
    }
    const sets = []; const params = [];
    for (const k of ['full_name', 'email', 'phone_number', 'role']) {
      if (data[k] !== undefined) { sets.push(`${k} = ?`); params.push(data[k]); }
    }
    if (!sets.length) return before;
    await conn.execute(`UPDATE users SET ${sets.join(', ')} WHERE user_id = ?`, [...params, id]);
    const after = await loadUser(conn, id);
    await audit.log(conn, { table: 'users', id, action: 'update', oldValues: before, newValues: after, ...audit.ctx(req) });
    return after;
  });
  res.json({ status: 'success', data: updated });
};

exports.setStatus = async (req, res) => {
  const id = parseId(req.params.id);
  const { status, reason } = validate(req.body, {
    status: v.enumOf(['Active', 'Inactive'], { required: true }),
    reason: v.string({ max: 500 }),
  });
  const updated = await withTransaction(async (conn) => {
    const before = await loadUser(conn, id, true);
    if (before.status === status) return before;
    if (status === 'Inactive') {
      await assertNotLastAdmin(conn, before);
      if (before.role === 'Supervisor') await assertNoOpenSitePeriods(conn, id);
    }
    await conn.execute('UPDATE users SET status = ? WHERE user_id = ?', [status, id]);
    const after = await loadUser(conn, id);
    await audit.log(conn, { table: 'users', id, action: `status_${status.toLowerCase()}`, oldValues: { status: before.status }, newValues: { status }, reason: reason || null, ...audit.ctx(req) });
    return after;
  });
  res.json({ status: 'success', data: updated });
};

exports.resetPassword = async (req, res) => {
  const id = parseId(req.params.id);
  const temp = passwords.temporary();
  const hash = await passwords.hash(temp);
  await withTransaction(async (conn) => {
    await loadUser(conn, id, true);
    await conn.execute(
      'UPDATE users SET password_hash = ?, must_change_password = 1, failed_login_attempts = 0, locked_until = NULL WHERE user_id = ?', [hash, id]);
    await audit.log(conn, { table: 'users', id, action: 'reset_password', ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: { user_id: id, temporary_password: temp }, message: 'Temporary password created; it is shown only once.' });
};
