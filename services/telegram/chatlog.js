// services/telegram/chatlog.js — the conversation, kept for the Admin to check mistakes (never shown to anyone else).
//   BOT_KEEP_CHAT_DAYS   days kept (default 30; 0 = nothing is kept). Older rows are deleted automatically.
// Never throws: a failed log never stops the bot.
const { pool } = require('../../config/db');

const days = () => {
  const v = process.env.BOT_KEEP_CHAT_DAYS;
  if (v === undefined || v === '') return 30;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 30;
};
let lastPurge = 0;

async function add(chatId, direction, kind, text, userId = null) {
  if (!days()) return;
  try {
    await pool.execute('INSERT INTO tg_chat_log (user_id, chat_id, direction, kind, text) VALUES (?, ?, ?, ?, ?)',
      [userId, chatId, direction, kind, String(text || '').slice(0, 8000)]);
    if (Date.now() - lastPurge > 3600 * 1000) {
      lastPurge = Date.now();
      await pool.execute(`DELETE FROM tg_chat_log WHERE created_at < NOW() - INTERVAL ${days()} DAY`);
    }
  } catch (e) { if (!/doesn't exist/i.test(e.message)) console.error('chat log failed:', e.message); }
}

/** GET /chat-log (Admin): the messages of one supervisor, newest first. */
async function list(userId, limit = 200) {
  const [rows] = await pool.execute(
    `SELECT log_id, direction, kind, text, created_at FROM tg_chat_log
     WHERE user_id = ? OR chat_id IN (SELECT chat_id FROM tg_links WHERE user_id = ? AND chat_id IS NOT NULL)
     ORDER BY log_id DESC LIMIT ${Math.min(Math.max(Number(limit) || 200, 1), 1000)}`, [userId, userId]);
  return rows;
}

module.exports = { add, list, days };
