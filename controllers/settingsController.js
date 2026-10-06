const { withTransaction, pool } = require('../config/db');
const settings = require('../services/settings');
const audit = require('../services/audit');
const AppError = require('../utils/AppError');

exports.list = async (req, res) => {
  res.json({ status: 'success', data: await settings.list() });
};

exports.update = async (req, res) => {
  const key = String(req.params.key);
  const value = settings.normalizeValue(key, req.body && req.body.value);
  const reason = req.body && typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  if (settings.CONTROL_KEYS.has(key) && reason.length < 5) {
    throw AppError.validation({ reason: 'this setting changes amounts or a control: explain why it changes (at least 5 characters)' });
  }
  await withTransaction(async (conn) => {
    const [rows] = await conn.execute('SELECT setting_value FROM settings WHERE setting_key = ? FOR UPDATE', [key]);
    const old = rows[0] ? rows[0].setting_value : settings.DEFAULTS[key];
    await conn.execute(
      `INSERT INTO settings (setting_key, setting_value, description, updated_by_user_id) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by_user_id = VALUES(updated_by_user_id)`,
      [key, value, settings.DEFINITIONS[key].description, req.user.user_id]);
    await audit.log(conn, { table: 'settings', id: 0, action: `set:${key}`, oldValues: { value: old }, newValues: { value }, reason: reason || null, ...audit.ctx(req) });
  });
  settings.invalidate();
  const [rows] = await pool.execute('SELECT * FROM settings WHERE setting_key = ?', [key]);
  res.json({ status: 'success', data: rows[0] });
};
