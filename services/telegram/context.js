// services/telegram/context.js — what the supervisor can record on a date: his sites / shifts (my-sites) and, for
// each, the machines deployed with their row of the day (the day board). Read through the app's own routes.
const loopback = require('./loopback');

/** A short Arabic / English name of a machine: "حفارة 2 · Al-Bunyan". */
function machineName(m, lang) {
  const type = lang === 'en' ? (m.type_name || m.type_name_ar) : (m.type_name_ar || m.type_name);
  const num = m.type_seq ? ` ${m.type_seq}` : '';
  return `${type || m.equipment_code}${num} · ${m.vendor_name || ''}`.trim();
}

/**
 * load(userId, date) -> { ok, date, boards: [{ site_id, site_code, site_name, shift, can_edit, reason }], machines: [...] , error }
 * machines: one entry per machine per board: { n, equipment_id, site_id, site_code, shift, code, type_name, type_name_ar,
 *   type_seq, vendor_name, plate, operator, state, row } where row = { id, status, day_status, in, out, from_previous_day } | null
 */
async function load(userId, date) {
  const sites = await loopback.call(userId, 'GET', '/api/equipment/my-sites', { query: { date } });
  if (!sites.ok) return { ok: false, error: sites };
  const boards = [];
  const machines = [];
  for (const s of Array.isArray(sites.data) ? sites.data : []) {
    const shift = s.shift_type === 'Night' ? 'Night' : 'Day';
    const day = await loopback.call(userId, 'GET', `/api/equipment/attendance/site/${Number(s.site_id)}`, { query: { date, shift } });
    if (!day.ok) {
      boards.push({ site_id: s.site_id, site_code: s.site_code, site_name: s.site_name, shift, error: day });
      continue;
    }
    const access = (day.data && day.data.access) || {};
    boards.push({ site_id: s.site_id, site_code: s.site_code, site_name: s.site_name, shift, can_edit: access.can_edit !== false, reason: access.reason || null, summary: day.data.summary });
    for (const m of (day.data && day.data.machines) || []) {
      const a = m.attendance;
      machines.push({
        n: machines.length + 1, equipment_id: m.equipment_id, site_id: s.site_id, site_code: s.site_code, shift,
        code: m.equipment_code, type_name: m.type_name, type_name_ar: m.type_name_ar, type_seq: m.type_seq, vendor_name: m.vendor_name,
        plate: m.plate_number, operator: m.default_operator_name, state: m.live_state,
        row: a ? { id: a.eq_attendance_id, status: a.status, day_status: a.day_status, in: a.check_in_time, out: a.check_out_time, from_previous_day: Boolean(a.from_previous_day) } : null,
      });
    }
  }
  return { ok: true, date, boards, machines };
}

module.exports = { load, machineName };
