// services/equipment/weekGate.js — a day cannot be submitted while the PREVIOUS week still has Draft rows
// for the same site + shift (BR-22). Missing rows never block. Week start = setting week_start_day.
// A supervisor is only blocked by Drafts they can act on (dates they supervised): Drafts left by a previous
// supervisor are reported (left_by_others) but do not block; the office handles them.
const settings = require('../settings');
const { addDays, dayOfWeek } = require('../../utils/businessDate');

async function weekBounds(dateStr) {
  const start = await settings.getInt('week_start_day');
  const offset = (dayOfWeek(dateStr) - start + 7) % 7;
  const weekStart = addDays(dateStr, -offset);
  return { weekStart, weekEnd: addDays(weekStart, 6) };
}

async function previousWeekDrafts(executor, siteId, shiftType, recordDate, user = null) {
  const { weekStart } = await weekBounds(recordDate);
  const prevStart = addDays(weekStart, -7);
  const prevEnd = addDays(weekStart, -1);
  if (!(await settings.getBool('week_gate_enabled'))) return { enabled: false, blocked: false, prev_start: prevStart, prev_end: prevEnd, days: [], left_by_others: [] };
  const [rows] = await executor.execute(
    `SELECT record_date, COUNT(*) AS drafts FROM eq_attendance
     WHERE site_id = ? AND shift_type = ? AND status = 'Draft' AND record_date BETWEEN ? AND ?
     GROUP BY record_date ORDER BY record_date`, [siteId, shiftType, prevStart, prevEnd]);
  let mine = rows;
  let others = [];
  if (user && user.role === 'Supervisor') {
    const [periods] = await executor.execute(
      'SELECT from_date, to_date FROM site_supervisors WHERE user_id = ? AND site_id = ? AND shift_type = ? AND from_date <= ? AND (to_date IS NULL OR to_date >= ?)',
      [user.user_id, siteId, shiftType, prevEnd, prevStart]);
    const covered = (d) => periods.some((p) => String(p.from_date).slice(0, 10) <= d && (!p.to_date || String(p.to_date).slice(0, 10) >= d));
    mine = rows.filter((r) => covered(String(r.record_date).slice(0, 10)));
    others = rows.filter((r) => !covered(String(r.record_date).slice(0, 10)));
  }
  const days = mine.map((r) => ({ record_date: r.record_date, drafts: Number(r.drafts) }));
  return {
    enabled: true, blocked: days.length > 0, prev_start: prevStart, prev_end: prevEnd, days,
    left_by_others: others.map((r) => ({ record_date: r.record_date, drafts: Number(r.drafts) })),
  };
}

module.exports = { weekBounds, previousWeekDrafts };
