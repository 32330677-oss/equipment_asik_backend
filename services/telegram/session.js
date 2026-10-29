// services/telegram/session.js — what the supervisor is working on: the day, the site / shift, the open draft.
// Set when he says it ("بدي سجّل Bridges ليوم 28") or picks it with the buttons; every next message uses it until he
// changes it, says "today", or 3 hours pass without a message. Never throws (a missing session = today, no site).
const { pool } = require('../../config/db');

const IDLE_HOURS = 3;

async function get(userId) {
  try {
    const [[r]] = await pool.execute(
      `SELECT DATE_FORMAT(work_date, '%Y-%m-%d') AS work_date, site_id, shift_type, draft_id,
              updated_at > NOW() - INTERVAL ${IDLE_HOURS} HOUR AS fresh
       FROM tg_session WHERE user_id = ?`, [userId]);
    if (!r || Number(r.fresh) !== 1) return { date: null, siteId: null, shift: null, draftId: null };
    return { date: r.work_date || null, siteId: r.site_id || null, shift: r.shift_type || null, draftId: r.draft_id || null };
  } catch (_) { return { date: null, siteId: null, shift: null, draftId: null }; }
}

/** Sets the given fields (undefined = keep). */
async function set(userId, { date, siteId, shift, draftId } = {}) {
  const cur = await get(userId);
  const next = {
    date: date !== undefined ? date : cur.date,
    siteId: siteId !== undefined ? siteId : cur.siteId,
    shift: shift !== undefined ? shift : cur.shift,
    draftId: draftId !== undefined ? draftId : cur.draftId,
  };
  try {
    await pool.execute(
      `INSERT INTO tg_session (user_id, work_date, site_id, shift_type, draft_id) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE work_date = VALUES(work_date), site_id = VALUES(site_id), shift_type = VALUES(shift_type),
         draft_id = VALUES(draft_id), updated_at = CURRENT_TIMESTAMP`,
      [userId, next.date, next.siteId, next.shift, next.draftId]);
  } catch (e) { console.error('session save failed:', e.message); }
  return next;
}

async function clear(userId) {
  try { await pool.execute('DELETE FROM tg_session WHERE user_id = ?', [userId]); } catch (_) { /* fine */ }
}

module.exports = { get, set, clear, IDLE_HOURS };
