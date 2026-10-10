// services/equipment/eqLiveService.js — live board: a CONSTANT number of set-based queries (document 01 §10).
const { pool } = require('../../config/db');
const settings = require('../settings');
const { businessToday, businessNow, addDays } = require('../../utils/businessDate');
const { wallMs } = require('../../utils/dateTime');
const { activeOnSql } = require('../../utils/ranges');
const { liveState } = require('./eqAttendanceService');
const { workingDaysOfMonth } = require('./eqPayrollService');

/**
 * opts: { date, siteId, supervisorUserId (limit to his site/shifts), withMoney }
 */
async function live(opts = {}) {
  const today = businessToday();
  const date = opts.date || today;
  const nowStr = date === today ? businessNow() : `${date} 23:59:59`;
  const nowMs = wallMs(nowStr);
  const longH = await settings.getInt('eq_long_session_review_hours');
  const refresh = await settings.getInt('eq_live_refresh_seconds');
  const offDay = await settings.getInt('eq_weekly_off_day');

  const depWhere = []; const depParams = [date, date];
  if (opts.siteId) { depWhere.push('a.site_id = ?'); depParams.push(opts.siteId); }
  if (opts.supervisorUserId) {
    depWhere.push(`EXISTS (SELECT 1 FROM site_supervisors ss WHERE ss.user_id = ? AND ss.site_id = a.site_id AND ss.shift_type = a.shift_type AND ${activeOnSql('ss', 'from_date', 'to_date')})`);
    depParams.push(opts.supervisorUserId, date, date);
  }
  const prev = addDays(date, -1);
  const [[deps], [rows], [downs], [cards]] = await Promise.all([
    pool.query(
      `SELECT a.equipment_id, a.site_id, a.shift_type, e.equipment_code, e.machine_label, e.plate_number, e.vendor_id, vd.vendor_name, t.type_name, t.type_name_ar,
              s.site_code, s.site_name, s.day_shift_start, s.night_shift_start, o.full_name AS default_operator_name
       FROM eq_site_assignments a JOIN eq_equipment e ON e.equipment_id = a.equipment_id AND e.status = 'Active'
       JOIN eq_vendors vd ON vd.vendor_id = e.vendor_id JOIN eq_types t ON t.type_id = e.type_id JOIN sites s ON s.site_id = a.site_id
       LEFT JOIN eq_operators o ON o.operator_id = a.default_operator_id
       WHERE ${activeOnSql('a', 'assigned_date', 'unassigned_date')}${depWhere.length ? ` AND ${depWhere.join(' AND ')}` : ''}
       ORDER BY s.site_code, e.equipment_code`, depParams),
    pool.query(
      `SELECT ea.eq_attendance_id, ea.equipment_id, ea.site_id, ea.shift_type, ea.record_date, ea.day_status, ea.status, ea.check_in_time, ea.check_out_time,
              ea.working_minutes, ea.anomaly_code, ea.remarks, ea.work_description, o.full_name AS operator_name
       FROM eq_attendance ea LEFT JOIN eq_operators o ON o.operator_id = ea.operator_id
       WHERE ea.status <> 'Cancelled' AND (ea.record_date = ? OR (ea.record_date = ? AND ea.check_in_time IS NOT NULL AND (ea.check_out_time IS NULL OR ea.check_out_time > ?)))`,
      [date, prev, `${date} 00:00:00`]),
    pool.query(
      `SELECT d.* FROM eq_downtime_periods d JOIN eq_attendance ea ON ea.eq_attendance_id = d.eq_attendance_id
       WHERE ea.record_date IN (?, ?) AND ea.status <> 'Cancelled' ORDER BY d.start_time`, [date, prev]),
    opts.withMoney ? pool.query(
      `SELECT rc.*, vc.currency FROM eq_rate_cards rc JOIN eq_vendor_contracts vc ON vc.vendor_contract_id = rc.vendor_contract_id
       WHERE ${activeOnSql('rc', 'effective_from', 'effective_to')}`, [date, date]) : Promise.resolve([[]]),
  ]);

  const downBy = {};
  for (const d of downs) (downBy[d.eq_attendance_id] = downBy[d.eq_attendance_id] || []).push(d);
  const cardBy = Object.fromEntries(cards.map((c) => [c.equipment_id, c]));

  const kpis = { deployed: 0, on_site_now: 0, working: 0, on_break: 0, breakdown: 0, standby: 0, not_arrived: 0, finished: 0, absent: 0, holiday: 0, forgotten_checkout: 0, late: 0, hours_today: 0 };
  const cost = {};
  const machines = deps.map((d) => {
    const mine = rows.filter((r) => r.equipment_id === d.equipment_id && r.site_id === d.site_id && r.shift_type === d.shift_type);
    // prefer the session still open from the previous day (night shift), then today's row
    const row = mine.find((r) => r.record_date === prev && !r.check_out_time) || mine.find((r) => r.record_date === date) || null;
    const periods = row ? (downBy[row.eq_attendance_id] || []) : [];
    const open = periods.find((p) => !p.end_time) || null;
    const state = liveState(row, open);
    let workMin = 0;
    if (row && row.day_status === 'Working' && row.check_in_time) {
      if (row.check_out_time) workMin = Number(row.working_minutes || 0);
      else {
        const elapsed = Math.max(0, Math.floor((nowMs - wallMs(row.check_in_time)) / 60000));
        const down = periods.reduce((a, p) => a + Math.max(0, Math.floor(((p.end_time ? wallMs(p.end_time) : nowMs) - wallMs(p.start_time)) / 60000)), 0);
        workMin = Math.max(0, elapsed - down);
      }
    }
    const since = open ? open.start_time : (row && row.check_in_time && !row.check_out_time ? row.check_in_time : null);
    const forgotten = Boolean(row && row.check_in_time && !row.check_out_time && (nowMs - wallMs(row.check_in_time)) / 3600000 > longH);
    const shiftStart = d.shift_type === 'Night' ? d.night_shift_start : d.day_shift_start;
    const late = state === 'NotArrived' && Boolean(shiftStart) && date === today && nowStr.slice(11) > shiftStart;
    kpis.deployed += 1;
    const k = { Working: 'working', OnBreak: 'on_break', Breakdown: 'breakdown', Standby: 'standby', NotArrived: 'not_arrived', Finished: 'finished', Absent: 'absent', Holiday: 'holiday' }[state];
    kpis[k] += 1;
    if (['Working', 'OnBreak', 'Breakdown', 'Standby'].includes(state) && row && row.check_in_time && !row.check_out_time) kpis.on_site_now += 1;
    else if (['Breakdown', 'Standby'].includes(state)) kpis.on_site_now += 1;
    if (forgotten) kpis.forgotten_checkout += 1;
    if (late) kpis.late += 1;
    kpis.hours_today += workMin / 60;
    let estimate = null;
    const c = cardBy[d.equipment_id];
    if (opts.withMoney && c && row && row.day_status !== 'Absent' && row.day_status !== 'Holiday') {
      const std = Number(c.standard_hours_per_day) || 8;
      if (c.billing_mode === 'Hourly') estimate = (workMin / 60) * Number(c.hourly_rate);
      else if (c.billing_mode === 'Daily') estimate = workMin > 0 ? Math.min(1, workMin / 60 / std) * Number(c.daily_rate) : 0;
      else estimate = (workMin / 60) * Number(c.monthly_rate) / workingDaysOfMonth(date.slice(0, 7), offDay) / std; // hours x the month's hourly price
      estimate = Math.round(estimate * 100) / 100;
      cost[c.currency] = Math.round(((cost[c.currency] || 0) + estimate) * 100) / 100;
    }
    return {
      equipment_id: d.equipment_id, equipment_code: d.equipment_code, machine_label: d.machine_label || null, plate_number: d.plate_number, type_name: d.type_name, type_name_ar: d.type_name_ar,
      vendor_id: d.vendor_id, vendor_name: d.vendor_name, site_id: d.site_id, site_code: d.site_code, site_name: d.site_name, shift_type: d.shift_type,
      operator_name: (row && row.operator_name) || d.default_operator_name || null, live_state: state, since,
      elapsed_minutes: since ? Math.max(0, Math.floor((nowMs - wallMs(since)) / 60000)) : null,
      check_in_time: row ? row.check_in_time : null, check_out_time: row ? row.check_out_time : null,
      work_minutes_today: workMin, open_downtime: open ? { downtime_type: open.downtime_type, start_time: open.start_time, reason: open.reason } : null,
      downtime: periods.map((p) => ({ downtime_type: p.downtime_type, start_time: p.start_time, end_time: p.end_time, reason: p.reason })),
      eq_attendance_id: row ? row.eq_attendance_id : null, workflow_status: row ? row.status : null, anomaly_code: row ? row.anomaly_code : null,
      remarks: row ? (row.remarks || row.work_description || null) : null,
      forgotten_checkout: forgotten, late, ...(opts.withMoney ? { estimated_cost_today: estimate, currency: c ? c.currency : null } : {}),
    };
  });
  kpis.hours_today = Math.round(kpis.hours_today * 100) / 100;
  if (opts.withMoney) kpis.estimated_cost_today = cost;

  const group = (keyFn, nameFn) => {
    const m = new Map();
    for (const x of machines) {
      const key = keyFn(x);
      if (!m.has(key)) m.set(key, { ...nameFn(x), deployed: 0, working: 0, on_break: 0, breakdown: 0, standby: 0, not_arrived: 0, finished: 0, absent: 0, holiday: 0 });
      const g = m.get(key); g.deployed += 1;
      g[{ Working: 'working', OnBreak: 'on_break', Breakdown: 'breakdown', Standby: 'standby', NotArrived: 'not_arrived', Finished: 'finished', Absent: 'absent', Holiday: 'holiday' }[x.live_state]] += 1;
    }
    return [...m.values()];
  };
  return {
    as_of: nowStr.slice(0, 16), date, refresh_seconds: refresh, kpis,
    sites: group((x) => `${x.site_id}|${x.shift_type}`, (x) => ({ site_id: x.site_id, site_code: x.site_code, site_name: x.site_name, shift_type: x.shift_type })),
    vendors: group((x) => x.vendor_id, (x) => ({ vendor_id: x.vendor_id, vendor_name: x.vendor_name })),
    machines,
  };
}

module.exports = { live };
