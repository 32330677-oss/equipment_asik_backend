// services/telegram/pending.js — the proposal waiting for the supervisor's answer (one open per account).
// Nothing is written to attendance before he confirms; an open proposal expires after EXPIRE_MINUTES.
const { pool } = require('../../config/db');

const EXPIRE_MINUTES = 60;

async function open(userId, chatId, payload) {
  await pool.execute("UPDATE tg_pending SET status = 'Cancelled' WHERE user_id = ? AND status = 'Open'", [userId]);
  const [r] = await pool.execute('INSERT INTO tg_pending (user_id, chat_id, payload) VALUES (?, ?, ?)', [userId, chatId, JSON.stringify(payload)]);
  return r.insertId;
}

/** The open proposal of the account (or the one with this id), not expired. */
async function get(userId, id = null) {
  const [[row]] = await pool.execute(
    `SELECT pending_id, payload, message_id, status, created_at > NOW() - INTERVAL ${EXPIRE_MINUTES} MINUTE AS fresh
     FROM tg_pending WHERE user_id = ? ${id ? 'AND pending_id = ?' : "AND status = 'Open'"} ORDER BY pending_id DESC LIMIT 1`,
    id ? [userId, id] : [userId]);
  if (!row) return null;
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  return { id: row.pending_id, payload, messageId: row.message_id, status: row.status, fresh: Number(row.fresh) === 1 };
}

async function save(id, payload) { await pool.execute('UPDATE tg_pending SET payload = ? WHERE pending_id = ?', [JSON.stringify(payload), id]); }
async function setMessage(id, messageId) { await pool.execute('UPDATE tg_pending SET message_id = ? WHERE pending_id = ?', [messageId, id]); }
async function close(id, status = 'Done') { await pool.execute('UPDATE tg_pending SET status = ? WHERE pending_id = ?', [status, id]); }
/** Closes it only if still Open (two taps on Confirm: the second one finds nothing). Returns true when this call closed it. */
async function claim(id) {
  const [r] = await pool.execute("UPDATE tg_pending SET status = 'Done' WHERE pending_id = ? AND status = 'Open'", [id]);
  return r.affectedRows === 1;
}

module.exports = { open, get, save, setMessage, close, claim, EXPIRE_MINUTES };
