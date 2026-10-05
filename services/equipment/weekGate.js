// services/equipment/weekGate.js — a day cannot be submitted while the PREVIOUS week still has Draft rows
// for the same site + shift (BR-22). Missing rows never block. Week start = setting week_start_day.
const settings = require('../settings');
const { addDays, dayOfWeek } = require('../../utils/businessDate');

async function weekBounds(dateStr) {
  const start = await settings.getInt('week_start_day');
  const offset = (dayOfWeek(dateStr) - start + 7) % 7;
  const weekStart = addDays(dateStr, -offset);
  return { weekStart, weekEnd: addDays(weekStart, 6) };
}

async function previousWeekDrafts(executor, siteId, shiftType, recordDate) {
  const { weekStart } = await weekBounds(recordDate);
  const prevStart = addDays(weekStart, -7);
  const prevEnd = addDays(weekStart, -1);
  if (!(await settings.getBool('week_gate_enabled'))) return { enabled: false, blocked: false, prev_start: prevStart, prev_end: prevEnd, days: [] };
  const [rows] = await executor.execute(
    `SELECT record_date, COUNT(*) AS drafts FROM eq_attendance
     WHERE site_id = ? AND shift_type = ? AND status = 'Draft' AND record_date BETWEEN ? AND ?
     GROUP BY record_date ORDER BY record_date`, [siteId, shiftType, prevStart, prevEnd]);
  const days = rows.map((r) => ({ record_date: r.record_date, drafts: Number(r.drafts) }));
  return { enabled: true, blocked: days.length > 0, prev_start: prevStart, prev_end: prevEnd, days };
}

module.exports = { weekBounds, previousWeekDrafts };
