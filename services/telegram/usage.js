// services/telegram/usage.js — one row per AI read (model, time, tokens, ok); the daily limit per supervisor.
//   BOT_DAILY_LIMIT   AI reads per supervisor per day (default 150)
const { pool } = require('../../config/db');

const limit = () => Number(process.env.BOT_DAILY_LIMIT) || 150;

async function log(userId, kind, { model = null, ok = true, code = null, latencyMs = null, usage = null } = {}) {
  try {
    await pool.execute(
      'INSERT INTO tg_agent_log (user_id, kind, model, ok, error_code, latency_ms, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, kind, model, ok ? 1 : 0, code, latencyMs, usage ? usage.input_tokens ?? null : null, usage ? usage.output_tokens ?? null : null]);
  } catch (e) { console.error('agent log failed:', e.message); }
}

async function overLimit(userId) {
  try {
    const [[r]] = await pool.execute('SELECT COUNT(*) AS n FROM tg_agent_log WHERE user_id = ? AND created_at >= CURDATE()', [userId]);
    return Number(r.n) >= limit();
  } catch (_) { return false; }
}

module.exports = { log, overLimit, limit };
