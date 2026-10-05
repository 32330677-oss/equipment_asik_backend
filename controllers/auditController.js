const { pool } = require('../config/db');
const { pageParams } = require('../utils/validate');

exports.list = async (req, res) => {
  const { page, pageSize, offset } = pageParams(req.query);
  const where = []; const params = [];
  if (req.query.table) { where.push('a.table_name = ?'); params.push(String(req.query.table)); }
  if (req.query.record_id) { where.push('a.record_id = ?'); params.push(Number(req.query.record_id)); }
  if (req.query.user_id) { where.push('a.user_id = ?'); params.push(Number(req.query.user_id)); }
  if (req.query.action) { where.push('a.action_type LIKE ?'); params.push(`${req.query.action}%`); }
  if (req.query.from) { where.push('a.created_at >= ?'); params.push(`${req.query.from} 00:00:00`); }
  if (req.query.to) { where.push('a.created_at <= ?'); params.push(`${req.query.to} 23:59:59`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM audit_logs a ${w}`, params);
  const [rows] = await pool.query(
    `SELECT a.*, u.full_name AS user_name FROM audit_logs a LEFT JOIN users u ON u.user_id = a.user_id ${w}
     ORDER BY a.log_id DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
  for (const r of rows) {
    for (const k of ['old_values', 'new_values']) {
      if (typeof r[k] === 'string') { try { r[k] = JSON.parse(r[k]); } catch (_) { /* keep */ } }
    }
  }
  res.json({ status: 'success', data: rows, meta: { total: Number(total), page, page_size: pageSize } });
};
