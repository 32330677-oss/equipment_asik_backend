// services/audit.js — append-only audit trail of every change.
const { pool } = require('../config/db');

function toJson(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value, (k, v) => (k === 'password_hash' ? undefined : v));
}

/**
 * audit.log(conn, { table, id, action, userId, oldValues, newValues, reason, ip })
 * Pass the transaction connection so the audit row commits/rolls back with the change.
 */
async function log(executor, { table, id, action, userId = null, oldValues = null, newValues = null, reason = null, ip = null }) {
  await (executor || pool).execute(
    `INSERT INTO audit_logs (table_name, record_id, action_type, user_id, old_values, new_values, reason, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [table, id, action, userId, toJson(oldValues), toJson(newValues), reason, ip]
  );
}

/** Build the audit context from an Express request. */
function ctx(req) { return { userId: req.user ? req.user.user_id : null, ip: req.ip }; }

module.exports = { log, ctx };
