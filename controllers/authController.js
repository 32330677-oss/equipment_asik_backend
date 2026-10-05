const jwt = require('jsonwebtoken');
const { env } = require('../config/env');
const { pool, withTransaction } = require('../config/db');
const AppError = require('../utils/AppError');
const { v, validate } = require('../utils/validate');
const passwords = require('../services/passwords');
const audit = require('../services/audit');
const { businessNow, businessToday } = require('../utils/businessDate');
const { addMinutes } = require('../utils/dateTime');
const { supervisorSitesOn } = require('../services/siteAccess');

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

function publicUser(u) {
  return {
    user_id: u.user_id, username: u.username, full_name: u.full_name, email: u.email || null,
    role: u.role, must_change_password: Number(u.must_change_password) === 1,
  };
}

async function recordAttempt(userId, username, success, req) {
  await pool.execute(
    'INSERT INTO login_history (user_id, username_tried, success, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)',
    [userId, String(username).slice(0, 255), success ? 1 : 0, req.ip || null, String(req.get('user-agent') || '').slice(0, 500)]
  );
}

exports.login = async (req, res) => {
  const { username, password } = validate(req.body, {
    username: v.string({ required: true, max: 255 }),
    password: v.any({ required: true }),
  });
  const [rows] = await pool.execute('SELECT * FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1', [username]);
  const user = rows[0];
  const nowStr = businessNow();

  if (user && user.locked_until && user.locked_until > nowStr) {
    await recordAttempt(user.user_id, username, false, req);
    throw new AppError(423, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again after ${user.locked_until.slice(11, 16)}.`, { locked_until: user.locked_until });
  }
  const ok = user ? await passwords.verify(password, user.password_hash) : false;
  if (!ok) {
    if (user) {
      const attempts = Number(user.failed_login_attempts || 0) + 1;
      if (attempts >= MAX_FAILED) {
        await pool.execute('UPDATE users SET failed_login_attempts = 0, locked_until = ? WHERE user_id = ?', [addMinutes(nowStr, LOCK_MINUTES), user.user_id]);
      } else {
        await pool.execute('UPDATE users SET failed_login_attempts = ? WHERE user_id = ?', [attempts, user.user_id]);
      }
    }
    await recordAttempt(user ? user.user_id : null, username, false, req);
    throw AppError.unauthorized('INVALID_CREDENTIALS', 'Wrong username or password.');
  }
  if (user.status !== 'Active') {
    await recordAttempt(user.user_id, username, false, req);
    throw AppError.unauthorized('ACCOUNT_INACTIVE', 'This account is deactivated. Contact the administrator.');
  }
  await pool.execute('UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = ? WHERE user_id = ?', [nowStr, user.user_id]);
  await recordAttempt(user.user_id, username, true, req);
  const token = jwt.sign({ user_id: user.user_id }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
  const { exp } = jwt.decode(token);
  res.json({ status: 'success', data: { token, expires_at: new Date(exp * 1000).toISOString(), user: publicUser(user) } });
};

exports.me = async (req, res) => {
  const [rows] = await pool.execute('SELECT * FROM users WHERE user_id = ?', [req.user.user_id]);
  const user = publicUser(rows[0]);
  const today = businessToday();
  const sites = user.role === 'Supervisor' ? await supervisorSitesOn(user.user_id, today) : [];
  res.json({ status: 'success', data: { user, today, sites } });
};

exports.changePassword = async (req, res) => {
  const { current_password, new_password } = validate(req.body, {
    current_password: v.any({ required: true }),
    new_password: v.any({ required: true }),
  });
  passwords.assertStrong(new_password);
  if (String(current_password) === String(new_password)) {
    throw AppError.badRequest('WEAK_PASSWORD', 'The new password must be different from the current one.');
  }
  await withTransaction(async (conn) => {
    const [rows] = await conn.execute('SELECT user_id, password_hash FROM users WHERE user_id = ? FOR UPDATE', [req.user.user_id]);
    if (!(await passwords.verify(current_password, rows[0].password_hash))) {
      throw AppError.badRequest('INVALID_CREDENTIALS', 'The current password is wrong.');
    }
    await conn.execute(
      'UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = ? WHERE user_id = ?',
      [await passwords.hash(new_password), businessNow(), req.user.user_id]
    );
    await audit.log(conn, { table: 'users', id: req.user.user_id, action: 'change_password', ...audit.ctx(req) });
  });
  res.json({ status: 'success', data: { changed: true }, message: 'Password changed.' });
};
