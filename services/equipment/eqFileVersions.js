// services/equipment/eqFileVersions.js — versioned documents (fuel receipts, contract scans).
// A new upload is a new version: the old file stays stored and downloadable; replacing one needs a reason.
const AppError = require('../../utils/AppError');
const { businessNow } = require('../../utils/businessDate');

async function list(conn, ownerTable, ownerId) {
  const [rows] = await conn.execute(
    `SELECT v.file_version_id, v.version_no, v.sha256, v.content_type, v.size_bytes, v.original_name, v.reason, v.uploaded_at, u.full_name AS uploaded_by
     FROM eq_file_versions v LEFT JOIN users u ON u.user_id = v.uploaded_by_user_id
     WHERE v.owner_table = ? AND v.owner_id = ? ORDER BY v.version_no DESC`, [ownerTable, ownerId]);
  return rows.map((r, i) => ({ ...r, is_current: i === 0 }));
}

/** One version (null = the latest). */
async function get(conn, ownerTable, ownerId, versionNo = null) {
  const [rows] = versionNo
    ? await conn.execute('SELECT * FROM eq_file_versions WHERE owner_table = ? AND owner_id = ? AND version_no = ?', [ownerTable, ownerId, versionNo])
    : await conn.execute('SELECT * FROM eq_file_versions WHERE owner_table = ? AND owner_id = ? ORDER BY version_no DESC LIMIT 1', [ownerTable, ownerId]);
  return rows[0] || null;
}

/**
 * Adds a version (caller's transaction, owner row already locked). reasonRequired forces a reason even for the
 * first file (e.g. a receipt attached after the payroll was finalized).
 */
async function add(conn, { ownerTable, ownerId, key, sha256, contentType, size, originalName, reason, userId, reasonRequired = false }) {
  const latest = await get(conn, ownerTable, ownerId);
  if (latest && latest.sha256 && latest.sha256 === sha256) throw AppError.conflict('SAME_FILE', 'This file is already the current version.');
  const why = reason ? String(reason).trim() : '';
  if ((latest || reasonRequired) && why.length < 5) {
    throw AppError.validation({ reason: latest ? 'say why the current file is replaced (at least 5 characters); the old one is kept' : 'say why the file is attached now (at least 5 characters)' });
  }
  if (why.length > 500) throw AppError.validation({ reason: 'at most 500 characters' });
  const versionNo = latest ? Number(latest.version_no) + 1 : 1;
  await conn.execute(
    `INSERT INTO eq_file_versions (owner_table, owner_id, version_no, storage_key, sha256, content_type, size_bytes, original_name, reason, uploaded_by_user_id, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [ownerTable, ownerId, versionNo, key, sha256 || null, contentType || null, size || null, originalName ? String(originalName).slice(0, 255) : null, why || null, userId, businessNow()]);
  return { version_no: versionNo, replaced_version: latest ? Number(latest.version_no) : null };
}

const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };
const extOf = (key) => String(key).split('.').pop();

module.exports = { list, get, add, MIME, extOf };
