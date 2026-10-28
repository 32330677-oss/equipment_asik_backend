// services/telegram/aliases.js — the names a supervisor uses for machines ("البوكلين الكبير"), learned when he picks
// the machine he meant. Given to the AI with his machine list next time. Never throws (learning is a bonus).
const { pool } = require('../../config/db');

const KEEP = 60;

function normalize(s) {
  return String(s || '').replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 120);
}

async function save(userId, said, equipmentId) {
  const text = normalize(said);
  if (!text || text.length < 2) return;
  try {
    await pool.execute(
      'INSERT INTO eq_machine_aliases (user_id, alias_text, equipment_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE equipment_id = VALUES(equipment_id), created_at = CURRENT_TIMESTAMP',
      [userId, text, equipmentId]);
  } catch (e) { console.error('alias save failed:', e.message); }
}

async function forUser(userId) {
  try {
    const [rows] = await pool.execute(`SELECT alias_text, equipment_id FROM eq_machine_aliases WHERE user_id = ? ORDER BY created_at DESC LIMIT ${KEEP}`, [userId]);
    return rows;
  } catch (_) { return []; }
}

module.exports = { save, forUser, normalize };
