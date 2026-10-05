// middleware/requireAuth.js — JWT proves WHO the caller is; role/status are re-read from the DB on
// every request (BR-P4), so deactivation or a role change applies immediately.
const jwt = require('jsonwebtoken');
const { env } = require('../config/env');
const { pool } = require('../config/db');
const AppError = require('../utils/AppError');

// Routes still reachable while must_change_password = 1.
const PASSWORD_GATE_ALLOW = new Set(['/api/auth/me', '/api/auth/change-password']);

/** Version of the user's password put in the token (the date-time it was last changed or reset). */
function passwordVersion(user) { return user.password_changed_at ? String(user.password_changed_at) : null; }

async function requireAuth(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) throw AppError.unauthorized('TOKEN_MISSING', 'Please sign in.');
    let payload;
    try {
      payload = jwt.verify(token, env.jwtSecret);
    } catch (e) {
      if (e.name === 'TokenExpiredError') throw AppError.unauthorized('TOKEN_EXPIRED', 'Your session has expired. Please sign in again.');
      throw AppError.unauthorized('TOKEN_INVALID', 'Invalid session. Please sign in again.');
    }
    const userId = Number(payload && payload.user_id);
    if (!Number.isInteger(userId) || userId < 1) throw AppError.unauthorized('TOKEN_INVALID', 'Invalid session. Please sign in again.');
    const [rows] = await pool.execute(
      'SELECT user_id, username, full_name, role, status, must_change_password, password_changed_at FROM users WHERE user_id = ? LIMIT 1',
      [userId]
    );
    const user = rows[0];
    if (!user) throw AppError.unauthorized('USER_NOT_FOUND', 'This account no longer exists.');
    if (user.status !== 'Active') throw AppError.unauthorized('ACCOUNT_INACTIVE', 'This account is deactivated.');
    // a token is valid only for the password it was issued with: changing / resetting the password ends every other session
    if ((payload.pwv ?? null) !== passwordVersion(user)) throw AppError.unauthorized('TOKEN_REVOKED', 'Your password was changed. Please sign in again.');
    const { password_changed_at: _p, ...pub } = user;
    req.user = { ...pub, must_change_password: Number(user.must_change_password) === 1 };
    const path = req.originalUrl.split('?')[0];
    if (req.user.must_change_password && !PASSWORD_GATE_ALLOW.has(path)) {
      throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'You must change your password before continuing.');
    }
    next();
  } catch (e) {
    next(e);
  }
}

module.exports = requireAuth;
module.exports.passwordVersion = passwordVersion;
