// services/audit.js — append-only audit trail of every change.
const { pool } = require('../config/db');

const SKIP_DIFF = new Set(['password_hash', 'updated_at', 'created_at']);

function toJson(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value, (k, v) => (k === 'password_hash' ? undefined : v));
}

const norm = (v) => {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

/**
 * Field-level difference of two flat records: { field: [old, new] } for the fields present in BOTH that changed.
 * Fields absent from either side are ignored, so a partial "new" object only reports what it carries.
 */
function diff(oldValues, newValues) {
  if (!oldValues || !newValues || typeof oldValues !== 'object' || typeof newValues !== 'object') return null;
  const out = {};
  for (const k of Object.keys(newValues)) {
    if (SKIP_DIFF.has(k) || !Object.prototype.hasOwnProperty.call(oldValues, k)) continue;
    const a = oldValues[k]; const b = newValues[k];
    if ((a !== null && typeof a === 'object' && !(a instanceof Date)) || (b !== null && typeof b === 'object' && !(b instanceof Date))) {
      if (norm(a) !== norm(b)) out[k] = [a ?? null, b ?? null];
      continue;
    }
    if (norm(a) !== norm(b)) out[k] = [a ?? null, b ?? null];
  }
  return Object.keys(out).length ? out : null;
}

/**
 * audit.log(conn, { table, id, action, userId, oldValues, newValues, reason, ip, changedFields?, relatedType?, relatedId?, payrollEffect?, source? })
 * Pass the transaction connection so the audit row commits/rolls back with the change.
 * changed_fields is computed from oldValues/newValues when not given.
 */
async function log(executor, {
  table, id, action, userId = null, oldValues = null, newValues = null, reason = null, ip = null,
  changedFields, relatedType = null, relatedId = null, payrollEffect = null, source = 'app',
}) {
  const changed = changedFields !== undefined ? changedFields : diff(oldValues, newValues);
  await (executor || pool).execute(
    `INSERT INTO audit_logs (table_name, record_id, action_type, user_id, old_values, new_values, changed_fields, reason,
       related_type, related_id, payroll_effect, source, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [table, id, action, userId, toJson(oldValues), toJson(newValues), toJson(changed), reason ? String(reason).slice(0, 500) : null,
      relatedType, relatedId ?? null, payrollEffect, source, ip]
  );
}

/** Build the audit context from an Express request. */
function ctx(req) { return { userId: req.user ? req.user.user_id : null, ip: req.ip }; }

module.exports = { log, ctx, diff };
