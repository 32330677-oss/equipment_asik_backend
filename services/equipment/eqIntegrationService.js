// services/equipment/eqIntegrationService.js — read-only summaries for Team Flow's combined Project Daily Report.
//
// Same rules as the client daily report (eqClientReport.loadData):
//   * a day's rows = eq_attendance dated D, any approval state except Cancelled;
//   * a machine deployed on D (eq_site_assignments covering D, machine Active) with no row yet = Pending;
//   * a Working row without a check-in is Pending too (the machine has not started).
// A machine is counted ONCE for the day, whatever its shifts or sites in the request, with its best state:
//   Working > Breakdown > Standby > Pending > Absent > Holiday
// No vendor, no operator, no hours, no money: counts per equipment type only (+ the work descriptions typed
// by the supervisors, which Team Flow may print under "activities").
'use strict';

const { pool } = require('../../config/db');

const RANK = { Working: 6, Breakdown: 5, Standby: 4, Pending: 3, Absent: 2, Holiday: 1 };
const STATES = Object.keys(RANK);

async function listSites() {
  const [rows] = await pool.query(
    `SELECT site_id, site_code, site_name, project_name, location, status, has_night_shift
     FROM sites ORDER BY status = 'Active' DESC, site_code`);
  return rows.map((r) => ({
    site_id: Number(r.site_id), site_code: r.site_code, site_name: r.site_name, project_name: r.project_name || null,
    location: r.location || null, status: r.status, has_night_shift: Number(r.has_night_shift) === 1,
  }));
}

async function listTypes() {
  const [rows] = await pool.query('SELECT type_id, type_name, type_name_ar, is_active FROM eq_types ORDER BY type_name');
  return rows.map((r) => ({ type_id: Number(r.type_id), type_name: r.type_name, type_name_ar: r.type_name_ar || null, is_active: Number(r.is_active) === 1 }));
}

/**
 * @param {{date: string, siteIds: number[]}} p  siteIds already validated (non-empty)
 */
async function dailyPlantSummary({ date, siteIds }) {
  const [sites] = await pool.query(
    'SELECT site_id, site_code, site_name FROM sites WHERE site_id IN (?) ORDER BY site_code', [siteIds]);
  const ids = sites.map((s) => s.site_id);
  const empty = { date, sites: [], types: [], totals: emptyCounts(), work_descriptions: [] };
  if (!ids.length) return empty;

  const [rows] = await pool.query(
    `SELECT ea.equipment_id, ea.site_id, ea.shift_type, ea.day_status, ea.check_in_time, ea.work_description,
            t.type_id, t.type_name, t.type_name_ar
     FROM eq_attendance ea
     JOIN eq_equipment e ON e.equipment_id = ea.equipment_id
     JOIN eq_types t ON t.type_id = e.type_id
     WHERE ea.record_date = ? AND ea.site_id IN (?) AND ea.status <> 'Cancelled'`, [date, ids]);
  const [deps] = await pool.query(
    `SELECT a.equipment_id, a.site_id, a.shift_type, t.type_id, t.type_name, t.type_name_ar
     FROM eq_site_assignments a
     JOIN eq_equipment e ON e.equipment_id = a.equipment_id AND e.status = 'Active'
     JOIN eq_types t ON t.type_id = e.type_id
     WHERE a.site_id IN (?) AND a.assigned_date <= ? AND (a.unassigned_date IS NULL OR a.unassigned_date >= ?)
       AND (a.unassigned_date IS NULL OR a.unassigned_date >= a.assigned_date)`, [ids, date, date]);

  // best state per machine for the day
  const machines = new Map();
  const consider = (r, state) => {
    const cur = machines.get(r.equipment_id);
    if (!cur || RANK[state] > RANK[cur.state]) {
      machines.set(r.equipment_id, { type_id: r.type_id, type_name: r.type_name, type_name_ar: r.type_name_ar, state });
    }
  };
  const recorded = new Set();
  for (const r of rows) {
    recorded.add(`${r.equipment_id}|${r.site_id}|${r.shift_type}`);
    const state = r.day_status === 'Working' ? (r.check_in_time ? 'Working' : 'Pending') : r.day_status;
    consider(r, RANK[state] ? state : 'Pending');
  }
  for (const d of deps) {
    if (!recorded.has(`${d.equipment_id}|${d.site_id}|${d.shift_type}`)) consider(d, 'Pending');
  }

  const byType = new Map();
  for (const m of machines.values()) {
    const t = byType.get(m.type_id) || { type_id: Number(m.type_id), type_name: m.type_name, type_name_ar: m.type_name_ar || null, ...emptyCounts() };
    t.machines += 1;
    t[m.state.toLowerCase()] += 1;
    byType.set(m.type_id, t);
  }
  const types = [...byType.values()].sort((a, b) => a.type_name.localeCompare(b.type_name));
  const totals = emptyCounts();
  for (const t of types) for (const k of Object.keys(totals)) totals[k] += t[k];

  // what the machines did (typed on the working rows), one line per distinct text and site
  const siteName = new Map(sites.map((s) => [s.site_id, s.site_name]));
  const seen = new Set();
  const work = [];
  for (const r of rows) {
    const text = String(r.work_description || '').replace(/\s+/g, ' ').trim();
    if (!text || r.day_status !== 'Working') continue;
    const k = `${r.site_id}|${text.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    work.push({ site_id: Number(r.site_id), site_name: siteName.get(r.site_id) || '', type_name: r.type_name, text: text.slice(0, 500) });
  }

  return {
    date,
    sites: sites.map((s) => ({ site_id: Number(s.site_id), site_code: s.site_code, site_name: s.site_name })),
    types,
    totals,
    work_descriptions: work.slice(0, 100),
  };
}

function emptyCounts() {
  const c = { machines: 0 };
  for (const s of STATES) c[s.toLowerCase()] = 0;
  return c;
}

module.exports = { listSites, listTypes, dailyPlantSummary, STATES };
