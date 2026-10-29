// services/telegram/aliases.js — the names a supervisor uses for machines ("البوكلين الكبير"), learned when he picks
// the machine he meant. Given to the AI with his machine list next time. Never throws (learning is a bonus).
const { pool } = require('../../config/db');

const KEEP = 60;

function normalize(s) {
  return String(s || '').replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 120);
}

// Words that only say WHICH KIND and WHICH NUMBER ("الحفارة 1", "excavator two"): such a name fits every vendor's
// machine of that type and number, so it is never learned (the bot keeps asking which one).
const TYPE_WORDS = ['حفاره', 'بوكلين', 'باكر', 'لودر', 'تركس', 'شيول', 'قلاب', 'شاحنه', 'تريلا', 'كرين', 'رافعه', 'بلدوزر', 'دوزر',
  'كومبرسه', 'مدحله', 'رصاصه', 'جريدر', 'بوبكات', 'مولده', 'تيليهاندلر', 'تلي', 'هاندلر', 'تلسكوبي', 'تلسكوبيه', 'اليه', 'ماكينه', 'مكنه'];
const NUMBER_WORDS = ['واحد', 'وحده', 'اول', 'الاول', 'اولي', 'اتنين', 'تنين', 'اثنين', 'تاني', 'ثاني', 'تلاته', 'ثلاثه', 'تالت', 'ثالث',
  'اربعه', 'رابع', 'خمسه', 'خامس', 'سته', 'سادس', 'سبعه', 'سابع', 'تمانه', 'ثمانيه', 'تامن', 'تسعه', 'تاسع', 'عشره', 'عاشر',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'first', 'second', 'third', 'no', 'number', 'رقم'];

/** True when the words say only a type and / or a number (nothing that names ONE machine). */
function isGeneric(said, machines = []) {
  const types = new Set(TYPE_WORDS);
  for (const m of machines) {
    for (const w of normalize(`${m.type_name || ''} ${m.type_name_ar || ''}`).split(' ')) if (w) types.add(w.replace(/^ال/, ''));
  }
  const words = normalize(said).split(' ').filter(Boolean).map((w) => w.replace(/^ال(?=..)/, ''));
  if (!words.length) return true;
  return words.every((w) => /^\d+$/.test(w) || types.has(w) || NUMBER_WORDS.includes(w) || NUMBER_WORDS.includes(`ال${w}`));
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

module.exports = { save, forUser, normalize, isGeneric };
