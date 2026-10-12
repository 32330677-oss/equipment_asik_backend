// services/equipment/eqPayrollService.js — loads data, calls the PURE billing engine, writes batches (§5.9).
const AppError = require('../../utils/AppError');
const settings = require('../settings');
const engine = require('./equipmentBillingEngine');
const { addDays, daysInMonth, monthOf } = require('../../utils/businessDate');
const { covers } = require('../../utils/ranges');
const { parseJson } = require('./eqCommon');
const dnr = require('./eqDnr');

const toNum = (v) => (v === null || v === undefined ? null : Number(v));

/** Normalize a rate card row from MySQL (DECIMAL strings, tinyint flags) for the engine. */
function engineRate(rc) {
  return {
    ...rc,
    hourly_rate: toNum(rc.hourly_rate), daily_rate: toNum(rc.daily_rate), monthly_rate: toNum(rc.monthly_rate),
    standard_hours_per_day: Number(rc.standard_hours_per_day), min_billable_hours_per_day: toNum(rc.min_billable_hours_per_day),
    overtime_enabled: Number(rc.overtime_enabled) === 1 || rc.overtime_enabled === true,
    overtime_threshold_hours: toNum(rc.overtime_threshold_hours), overtime_rate: toNum(rc.overtime_rate),
    overtime_multiplier: Number(rc.overtime_multiplier || 1), standby_billable_pct: Number(rc.standby_billable_pct),
    breakdown_billable_pct: Number(rc.breakdown_billable_pct), half_day_threshold_hours: toNum(rc.half_day_threshold_hours),
    monthly_working_days: Number(rc.monthly_working_days), monthly_divisor: rc.monthly_divisor || 'MonthDays',
    operator_included: Number(rc.operator_included) === 1 || rc.operator_included === true,
    operator_daily_rate: toNum(rc.operator_daily_rate), second_shift_pct: Number(rc.second_shift_pct || 0),
  };
}

/** The machines of a scope: a list chosen by hand (equipment_ids), the single equipment_id of older batches, or null (all). */
function scopeMachines(scope) {
  if (Array.isArray(scope.equipment_ids) && scope.equipment_ids.length) return scope.equipment_ids.map(Number);
  if (scope.equipment_id) return [Number(scope.equipment_id)];
  return null;
}

function scopeSql(scope, alias = 'ea', eAlias = 'e') {
  const w = []; const p = [];
  const machines = scopeMachines(scope);
  if (scope.vendor_id) { w.push(`${eAlias}.vendor_id = ?`); p.push(scope.vendor_id); }
  if (machines) { w.push(`${alias}.equipment_id IN (?)`); p.push(machines); }
  if (scope.site_id) { w.push(`${alias}.site_id = ?`); p.push(scope.site_id); }
  return { sql: w.length ? ` AND ${w.join(' AND ')}` : '', params: p };
}

/** Scope of a stored batch, with the machines chosen by hand (eq_payroll_batch_machines; empty = whole scope). */
async function batchScope(conn, batch) {
  const [m] = await conn.query('SELECT equipment_id FROM eq_payroll_batch_machines WHERE eq_batch_id = ? ORDER BY equipment_id', [batch.eq_batch_id]);
  return {
    start_date: String(batch.start_date).slice(0, 10), end_date: String(batch.end_date).slice(0, 10),
    vendor_id: batch.scope_vendor_id, equipment_id: m.length ? null : batch.scope_equipment_id,
    equipment_ids: m.length ? m.map((x) => x.equipment_id) : null, site_id: batch.scope_site_id,
  };
}

const ACTIVE_BATCH = "b.status IN ('Generated','Paid')";

/** Rate cards of the machines in scope that overlap the period. */
async function loadRateCards(conn, equipmentIds, start, end) {
  if (!equipmentIds.length) return [];
  const [rows] = await conn.query(
    `SELECT rc.*, vc.currency, vc.vendor_id, vc.contract_number FROM eq_rate_cards rc
     JOIN eq_vendor_contracts vc ON vc.vendor_contract_id = rc.vendor_contract_id
     WHERE rc.equipment_id IN (?) AND rc.effective_from <= ? AND (rc.effective_to IS NULL OR rc.effective_to >= ?)`,
    [equipmentIds, end, start]);
  return rows;
}
function cardFor(cards, equipmentId, date) {
  return cards.find((c) => c.equipment_id === equipmentId && covers(c.effective_from, c.effective_to, date)) || null;
}

const weekday = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();

/** Working days of a calendar month: every day except the weekly day off (Friday = 5 by default). */
function workingDaysOfMonth(month, offDay) {
  const n = daysInMonth(month); let wd = 0;
  for (let i = 1; i <= n; i += 1) if (weekday(`${month}-${String(i).padStart(2, '0')}`) !== offDay) wd += 1;
  return wd;
}

/**
 * Terms of the month of each machine (11 Oct 2026): divisor D and hourly price. D = typed for the month
 * (eq_monthly_terms), else the card (fixed number of days, or the working days of the calendar month).
 * termsOf(month) -> eq_monthly_terms row or null.
 */
function monthTerms(month, card, offDay, termsOf = null) {
  const wd = workingDaysOfMonth(month, offDay);
  const t = termsOf ? termsOf(month) : null;
  const typedD = t && t.working_days !== null && t.working_days !== undefined ? Number(t.working_days) : null;
  const fixed = card && card.monthly_divisor === 'Fixed' && Number(card.monthly_working_days) > 0;
  const typedH = t && t.hourly_rate !== null && t.hourly_rate !== undefined && Number(t.hourly_rate) > 0 ? Number(t.hourly_rate) : null;
  return {
    workingDays: wd,
    divisor: typedD ?? (fixed ? Number(card.monthly_working_days) : wd),
    divisorSource: typedD ? 'manual' : fixed ? 'card' : 'calendar',
    hourlyCents: typedH === null ? null : Math.round(typedH * 1000000) / 10000,
    hourlySource: typedH === null ? 'auto' : 'manual',
  };
}

/** Months context of a set of days (Monthly billing): deployed days, deployed WORKING days, official holidays, terms. */
function monthsFromDays(days, card, offDay = 5, holidayDates = new Set(), termsOf = null, extraMonths = []) {
  const months = {};
  for (const m of extraMonths) months[m] = months[m] || { assignedDays: 0, assignedWorkingDays: 0, holidayDays: 0, workingDates: [] };
  for (const d of [...new Set(days)].sort()) {
    const m = monthOf(d);
    const mo = (months[m] = months[m] || { assignedDays: 0, assignedWorkingDays: 0, holidayDays: 0, workingDates: [] });
    mo.assignedDays += 1;
    if (weekday(d) !== offDay) {
      mo.assignedWorkingDays += 1;
      if (holidayDates.has(d)) mo.holidayDays += 1;
      else mo.workingDates.push(d); // deployed working day that is not an official holiday: must be worked or excused
    }
  }
  return Object.keys(months).sort().map((month) => ({ month, daysInMonth: daysInMonth(month), ...months[month], ...monthTerms(month, card, offDay, termsOf) }));
}

/** Days of [start,end] inside the card and the deployments (and not refused by ownsDay). */
function deployedDays(start, end, deployRanges, card, ownsDay = null) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (!covers(card.effective_from, card.effective_to, d)) continue;
    if (!deployRanges.some((r) => covers(r.from, r.to, d))) continue;
    if (ownsDay && !ownsDay(d)) continue;
    out.push(d);
  }
  return out;
}

/**
 * Per calendar month inside [start,end] ∩ deployments ∩ [card range] (for Monthly billing):
 * deployed days, deployed WORKING days (weekly day off excluded), official holidays recorded on working days, terms.
 */
function monthsContext(start, end, deployRanges, card, ownsDay = null, offDay = 5, holidayDates = new Set(), termsOf = null) {
  return monthsFromDays(deployedDays(start, end, deployRanges, card, ownsDay), card, offDay, holidayDates, termsOf);
}

/** Typed terms of the month (eq_monthly_terms) of these machines: lookup (equipmentId, month) -> row or null. */
async function loadMonthlyTerms(conn, equipmentIds, fromMonth, toMonth) {
  if (!equipmentIds.length) return () => null;
  const [rows] = await conn.query('SELECT * FROM eq_monthly_terms WHERE equipment_id IN (?) AND month BETWEEN ? AND ?', [equipmentIds, fromMonth, toMonth]);
  const map = new Map(rows.map((r) => [`${r.equipment_id}|${r.month}`, r]));
  return (equipmentId, month) => map.get(`${equipmentId}|${month}`) || null;
}

/** A row has standby time (full Standby day, or standby periods inside a Working day). */
function hasStandby(r) { return r.day_status === 'Standby' || Number(r.standby_minutes || 0) > 0; }

/** The fields of an attendance row that the billing engine reads. */
function engineRow(r) {
  return { eq_attendance_id: r.eq_attendance_id, record_date: r.record_date, shift_type: r.shift_type, check_in_time: r.check_in_time, check_out_time: r.check_out_time,
    day_status: r.day_status, gross_minutes: r.gross_minutes, break_minutes: r.break_minutes,
    breakdown_minutes: r.breakdown_minutes, standby_minutes: r.standby_minutes,
    standby_credit_minutes: r.standby_credit_minutes === undefined ? null : r.standby_credit_minutes,
    regular_allow: r.regular_allow, day_plan: r.day_plan };
}

/** How a row was billed beside its minutes (continuous shifts, second shift): kept in the snapshot. */
function calcDetail(r) {
  const d = {};
  if (r.regular_allow !== undefined && r.regular_allow !== null && Number.isFinite(r.regular_allow)) d.regular_allow = r.regular_allow;
  if (r.block_shifts > 1) d.block_shifts = r.block_shifts;
  if (r.day_plan) d.day_plan = Object.fromEntries(Object.entries(r.day_plan).map(([k, v]) => [k, Math.round(Number(v) * 1e6) / 1e6]));
  return Object.keys(d).length ? d : null;
}

/** Billed minutes of one row (what goes into the payroll snapshot). thr = overtime threshold in minutes. */
function rowFigures(r, rate, thr) {
  const m = engine.dayMinutes(r, rate);
  const credit = rate.billing_mode === 'Monthly' && r.standby_credit_minutes !== null && r.standby_credit_minutes !== undefined
    ? engine.standbyCredit(r, Math.round(Number(rate.standard_hours_per_day) * 60)) : null;
  return { work: m.work, ot: Math.max(0, m.work - engine.allowOf(r, thr)), standby: m.standby, breakdown: m.breakdown, brk: m.brk, topup: r.day_plan ? r.day_plan.topup : engine.minimumTopUp(m, rate), credit };
}

/**
 * Stale check of a batch: rows whose BILLED figures are no longer what the batch used. Only changes that move money
 * count (times, downtime, day status, standby hours given, approval). Paper checks, scans, meters, remarks do not.
 */
async function changedRows(conn, batchId) {
  const [rows] = await conn.query(
    `SELECT s.eq_attendance_id, s.day_status AS s_day_status, s.check_in_time AS s_in, s.check_out_time AS s_out,
       s.work_minutes AS s_work, s.overtime_minutes AS s_ot, s.standby_minutes AS s_standby, s.breakdown_minutes AS s_breakdown,
       s.break_minutes AS s_break, s.topup_minutes AS s_topup, s.standby_credit_minutes AS s_credit, i.rate_snapshot, i.billing_mode,
       a.status, a.day_status, a.check_in_time, a.check_out_time, a.gross_minutes, a.break_minutes, a.breakdown_minutes, a.standby_minutes,
       a.standby_credit_minutes
     FROM eq_payroll_attendance_snapshot s JOIN eq_payroll_items i ON i.eq_item_id = s.eq_item_id
     LEFT JOIN eq_attendance a ON a.eq_attendance_id = s.eq_attendance_id
     WHERE s.eq_batch_id = ?`, [batchId]);
  const out = [];
  for (const r of rows) {
    if (!r.status || r.status !== 'Approved') { out.push({ eq_attendance_id: r.eq_attendance_id, reason: 'not approved any more' }); continue; }
    const rate = engineRate(parseJson(r.rate_snapshot) || {});
    const thr = r.billing_mode === 'Monthly' ? Infinity : engine.otThresholdMin(rate);
    const f = rowFigures(r, rate, thr);
    const same = r.s_day_status === r.day_status && String(r.s_in) === String(r.check_in_time) && String(r.s_out) === String(r.check_out_time)
      // overtime is not compared: with continuous shifts it depends on the neighbour rows (the amount check catches it)
      && Number(r.s_work) === f.work && Number(r.s_standby) === f.standby && Number(r.s_breakdown) === f.breakdown
      && Number(r.s_break) === f.brk // top-up is shared by the shifts of a day: the amount check catches it
      && (r.billing_mode !== 'Monthly' || (r.s_credit === null ? null : Number(r.s_credit)) === f.credit);
    if (!same) out.push({ eq_attendance_id: r.eq_attendance_id, reason: 'billed figures changed' });
  }
  return out;
}

// ------------------------------------------------------------------ fuel price difference
/** Effective-dated fuel terms of the machines (base price + litres per working hour). */
async function loadFuelTerms(conn, equipmentIds, start, end) {
  if (!equipmentIds.length) return [];
  const [rows] = await conn.query(
    `SELECT * FROM eq_fuel_terms WHERE equipment_id IN (?) AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)`,
    [equipmentIds, end, start]);
  return rows;
}
function termsFor(terms, equipmentId, date) {
  return terms.find((t) => t.equipment_id === equipmentId && covers(t.effective_from, t.effective_to, date)) || null;
}
async function loadFuelPrices(conn) {
  const [rows] = await conn.query('SELECT * FROM eq_fuel_prices ORDER BY currency, effective_from');
  return rows;
}
/** National price valid on a date: the last price of that currency starting on or before it. */
function priceOn(prices, currency, date) {
  let found = null;
  for (const p of prices) if (p.currency === currency && p.effective_from <= date) found = p;
  return found;
}

/**
 * Fuel price difference of one item, per day: (national price on the day - base price) x litres/hour x working hours
 * (normal + overtime). Returns { lines, days, missing } — lines grouped by (terms, price) period.
 */
function fuelDifference(perRow, equipmentId, currency, terms, prices, allowNegative) {
  const days = []; const missing = []; const groups = new Map();
  for (const pr of perRow) {
    if (!(pr.work > 0)) continue;
    const date = pr.row.record_date;
    const t = termsFor(terms, equipmentId, date);
    if (!t) continue;
    const p = priceOn(prices, currency, date);
    if (!p) { missing.push({ record_date: date }); continue; }
    const base = Number(t.base_price_per_liter); const price = Number(p.price_per_liter);
    const diff = Math.round((price - base) * 1000) / 1000;
    if (diff === 0 || (diff < 0 && !allowNegative)) continue;
    const hours = pr.work / 60;
    const liters = hours * Number(t.liters_per_hour);
    const amountCents = Math.round(liters * diff * 100);
    days.push({ record_date: date, hours: Math.round(hours * 100) / 100, liters_per_hour: Number(t.liters_per_hour), liters: Math.round(liters * 100) / 100,
      base_price: base, national_price: price, diff, amount: amountCents / 100, fuel_terms_id: t.fuel_terms_id, fuel_price_id: p.fuel_price_id });
    const key = `${t.fuel_terms_id}|${p.fuel_price_id}`;
    const g = groups.get(key) || { t, p, diff, hours: 0, liters: 0, amountCents: 0, from: date, to: date };
    g.hours += hours; g.liters += liters; g.amountCents += amountCents; g.to = date;
    groups.set(key, g);
  }
  const lines = [...groups.values()].map((g) => ({
    line_type: 'FuelPriceDifference', quantity: Math.round(g.liters * 10000) / 10000, unit: 'L',
    unit_price_cents: Math.round(g.diff * 100), unit_price_exact: g.diff, amount_cents: g.amountCents,
    source_table: 'eq_fuel_terms', source_id: g.t.fuel_terms_id,
    note: `${g.from} to ${g.to}: ${(Math.round(g.hours * 100) / 100).toFixed(2)} h x ${Number(g.t.liters_per_hour)} L/h; price ${Number(g.p.price_per_liter).toFixed(3)} vs base ${Number(g.t.base_price_per_liter).toFixed(3)}`,
  }));
  return { lines, days, missing };
}

// ------------------------------------------------------------------ signed sheet scans
/**
 * For attendance rows (eq_attendance_id list or SQL rows with timesheet_id/sheet_row_no): which monthly sheets are not
 * uploaded far enough. Returns [{ timesheet_id, sheet_code, equipment_code, site_code, period_month, needed_row, scanned_row }].
 */
async function sheetsMissingScan(conn, attendanceIds) {
  if (!attendanceIds.length) return [];
  const [rows] = await conn.query(
    `SELECT ts.timesheet_id, ts.sheet_code, ts.period_month, e.equipment_code, s.site_code, MAX(ea.sheet_row_no) AS needed_row,
       (SELECT COALESCE(MAX(sc.through_row_no), 0) FROM eq_timesheet_scans sc WHERE sc.timesheet_id = ts.timesheet_id) AS scanned_row
     FROM eq_attendance ea JOIN eq_timesheets ts ON ts.timesheet_id = ea.timesheet_id
     JOIN eq_equipment e ON e.equipment_id = ea.equipment_id JOIN sites s ON s.site_id = ea.site_id
     WHERE ea.eq_attendance_id IN (?) GROUP BY ts.timesheet_id, ts.sheet_code, ts.period_month, e.equipment_code, s.site_code`, [attendanceIds]);
  return rows.filter((r) => Number(r.scanned_row) < Number(r.needed_row))
    .map((r) => ({ ...r, needed_row: Number(r.needed_row), scanned_row: Number(r.scanned_row) }));
}

// ------------------------------------------------------------------ shifts (continuous shifts, second shift)
/**
 * Sets on each row of an Hourly / Daily machine:
 *  - regular_allow: regular minutes it may use before overtime (continuous shifts share threshold x shifts);
 *  - day_plan: the share of the calendar day of each shift (minimum top-up once per day; Daily: work first,
 *    second shift, then breakdown and standby).
 * Every row of these machines around the period is read (any site, any status but Rejected) so the split is the same in
 * every batch and does not depend on the scope.
 */
async function applyShiftRules(conn, rows, cards, scope) {
  const ids = [...new Set(rows.filter((r) => {
    const c = cardFor(cards, r.equipment_id, r.record_date);
    return c && c.billing_mode !== 'Monthly';
  }).map((r) => r.equipment_id))];
  if (!ids.length) return;
  const gap = await settings.getInt('eq_shift_continuity_minutes');
  const [ctx] = await conn.query(
    `SELECT eq_attendance_id, equipment_id, record_date, shift_type, check_in_time, check_out_time, day_status, gross_minutes, break_minutes,
       breakdown_minutes, standby_minutes FROM eq_attendance WHERE equipment_id IN (?) AND record_date BETWEEN ? AND ? AND status NOT IN ('Rejected','Cancelled')`,
    [ids, addDays(scope.start_date, -2), addDays(scope.end_date, 2)]);
  const rateOf = (r) => { const c = cardFor(cards, r.equipment_id, String(r.record_date).slice(0, 10)); return c ? engineRate(c) : null; };
  const allow = {}; const plans = {};
  for (const id of ids) {
    const mine = ctx.filter((r) => r.equipment_id === id && rateOf(r) && rateOf(r).billing_mode !== 'Monthly');
    Object.assign(allow, engine.blockAllowances(mine, (r) => engine.otThresholdMin(rateOf(r)), (r) => engine.dayMinutes(r, rateOf(r)).work, gap));
    const byCard = new Map();
    for (const r of mine) {
      const c = cardFor(cards, id, String(r.record_date).slice(0, 10));
      if (!byCard.has(c.rate_card_id)) byCard.set(c.rate_card_id, { c, list: [] });
      byCard.get(c.rate_card_id).list.push(r);
    }
    for (const { c, list } of byCard.values()) Object.assign(plans, engine.dayPlans(list, engineRate(c)));
  }
  for (const r of rows) {
    const a = allow[r.eq_attendance_id];
    if (a && Number.isFinite(a.allow)) { r.regular_allow = a.allow; r.block_shifts = a.shifts; }
    if (plans[r.eq_attendance_id]) r.day_plan = plans[r.eq_attendance_id];
  }
}

/**
 * Site-scoped runs: a MONTHLY machine that also works at another site in the period is one contract; its hours
 * are only right when all its sites are billed together.
 */
async function monthlyMultiSite(conn, scope) {
  if (!scope.site_id) return [];
  const [rows] = await conn.query(
    `SELECT DISTINCT e.equipment_code, a.equipment_id, s2.site_code AS other_site
     FROM eq_site_assignments a JOIN eq_equipment e ON e.equipment_id = a.equipment_id
     JOIN eq_rate_cards rc ON rc.equipment_id = a.equipment_id AND rc.billing_mode = 'Monthly' AND rc.effective_from <= ? AND (rc.effective_to IS NULL OR rc.effective_to >= ?)
     JOIN eq_site_assignments b ON b.equipment_id = a.equipment_id AND b.site_id <> a.site_id
       AND b.assigned_date <= ? AND (b.unassigned_date IS NULL OR b.unassigned_date >= ?) AND (b.unassigned_date IS NULL OR b.unassigned_date >= b.assigned_date)
     JOIN sites s2 ON s2.site_id = b.site_id
     WHERE a.site_id = ? AND a.assigned_date <= ? AND (a.unassigned_date IS NULL OR a.unassigned_date >= ?) AND (a.unassigned_date IS NULL OR a.unassigned_date >= a.assigned_date)`,
    [scope.end_date, scope.start_date, scope.end_date, scope.start_date, scope.site_id, scope.end_date, scope.start_date]);
  return rows;
}

/**
 * Monthly machines: deployed WORKING days of the scope (weekly day off excluded, inside a Monthly rate card) that have
 * no attendance row at all (any site, any status except Cancelled). Such a day counts in the hours due with 0 hours
 * done, so it is deducted as missing hours: usually right (the machine did not work), but also what happens when the
 * supervisor forgot the row. Information only: shown before generating, never blocks.
 */
async function monthlyDaysWithoutRows(conn, scope) {
  const ds = scopeSql(scope, 'a');
  const [deps] = await conn.query(
    `SELECT a.equipment_id, a.site_id, a.assigned_date, a.unassigned_date, e.equipment_code, e.vendor_id, st.site_code FROM eq_site_assignments a
     JOIN eq_equipment e ON e.equipment_id = a.equipment_id JOIN sites st ON st.site_id = a.site_id
     WHERE a.assigned_date <= ? AND (a.unassigned_date IS NULL OR a.unassigned_date >= ?) AND (a.unassigned_date IS NULL OR a.unassigned_date >= a.assigned_date)${ds.sql}
     ORDER BY a.equipment_id, a.assigned_date`,
    [scope.end_date, scope.start_date, ...ds.params]);
  if (!deps.length) return [];
  const ids = [...new Set(deps.map((d) => d.equipment_id))];
  const monthlyCards = (await loadRateCards(conn, ids, scope.start_date, scope.end_date)).filter((c) => c.billing_mode === 'Monthly');
  if (!monthlyCards.length) return [];
  const monthlyIds = [...new Set(monthlyCards.map((c) => c.equipment_id))];
  const [rows] = await conn.query(
    `SELECT DISTINCT equipment_id, record_date FROM eq_attendance
     WHERE equipment_id IN (?) AND record_date BETWEEN ? AND ? AND status <> 'Cancelled'`, [monthlyIds, scope.start_date, scope.end_date]);
  const recorded = new Set(rows.map((r) => `${r.equipment_id}|${String(r.record_date).slice(0, 10)}`));
  // a day another active batch already billed is not this scope's business any more (each monthly day billed once)
  const [held] = await conn.query(
    `SELECT md.equipment_id, md.day FROM eq_payroll_monthly_days md JOIN eq_payroll_batches b ON b.eq_batch_id = md.eq_batch_id
     WHERE md.equipment_id IN (?) AND md.day BETWEEN ? AND ? AND ${ACTIVE_BATCH} AND b.eq_batch_id <> ?`,
    [monthlyIds, scope.start_date, scope.end_date, scope.exclude_batch_id || 0]);
  for (const x of held) recorded.add(`${x.equipment_id}|${String(x.day).slice(0, 10)}`);
  const offDay = await settings.getInt('eq_weekly_off_day');
  const out = []; const seen = new Set();
  for (const d of deps) {
    if (!monthlyIds.includes(d.equipment_id)) continue;
    const from = String(d.assigned_date).slice(0, 10) > scope.start_date ? String(d.assigned_date).slice(0, 10) : scope.start_date;
    const to = d.unassigned_date && String(d.unassigned_date).slice(0, 10) < scope.end_date ? String(d.unassigned_date).slice(0, 10) : scope.end_date;
    for (let day = from; day <= to; day = addDays(day, 1)) {
      const key = `${d.equipment_id}|${day}`;
      if (seen.has(key) || recorded.has(key) || weekday(day) === offDay) continue;
      if (!monthlyCards.some((c) => c.equipment_id === d.equipment_id && covers(c.effective_from, c.effective_to, day))) continue;
      seen.add(key);
      out.push({ equipment_code: d.equipment_code, site_code: d.site_code, record_date: day, _v: d.vendor_id, _e: d.equipment_id, _s: d.site_id, _d: day });
    }
  }
  return out.sort((a, b) => a.equipment_code.localeCompare(b.equipment_code) || a.record_date.localeCompare(b.record_date));
}

/** Everything that prevents rows of the scope from being paid. */
async function blockers(conn, scope) {
  const requirePaper = await settings.getBool('eq_payroll_requires_paper_match');
  const s = scopeSql(scope);
  const out = [];
  // 11 Oct 2026: a Finalize closes what it billed, not the whole period (each row / day / fuel / adjustment is billed
  // once). A row approved late in a finalized period is simply paid by the next batch: no more IN_CLOSED_PERIOD.
  const strip = ({ _v, _e, _s, _d, ...x }) => x;
  const add = (code, message, list) => {
    const items = list.map(strip);
    if (items.length) out.push({ code, message, count: items.length, items: items.slice(0, 200) });
  };
  const base = `FROM eq_attendance ea JOIN eq_equipment e ON e.equipment_id = ea.equipment_id JOIN sites st ON st.site_id = ea.site_id
    WHERE ea.record_date BETWEEN ? AND ?${s.sql}`;
  const params = [scope.start_date, scope.end_date, ...s.params];
  const cols = 'ea.eq_attendance_id, e.equipment_code, st.site_code, ea.record_date, ea.status, ea.paper_status, ea.day_status, e.vendor_id AS _v, ea.equipment_id AS _e, ea.site_id AS _s, ea.record_date AS _d';
  const notInActive = `NOT EXISTS (SELECT 1 FROM eq_payroll_attendance_snapshot ps JOIN eq_payroll_batches b ON b.eq_batch_id = ps.eq_batch_id
    WHERE ps.eq_attendance_id = ea.eq_attendance_id AND ${ACTIVE_BATCH}${scope.exclude_batch_id ? ' AND b.eq_batch_id <> ?' : ''})`;
  const exParams = scope.exclude_batch_id ? [scope.exclude_batch_id] : [];
  const [notApproved] = await conn.query(`SELECT ${cols} ${base} AND ea.status NOT IN ('Approved','Cancelled') AND ${notInActive} ORDER BY ea.record_date`, [...params, ...exParams]);
  add('NOT_APPROVED', 'Rows not approved yet (Draft, Submitted or Rejected).', notApproved);
  const [open] = await conn.query(`SELECT ${cols} ${base} AND ea.status <> 'Cancelled' AND ea.day_status = 'Working' AND ea.check_in_time IS NOT NULL AND ea.check_out_time IS NULL`, params);
  add('OPEN_SESSION', 'Sessions still open (no check-out).', open);
  const [unack] = await conn.query(`SELECT ${cols}, ea.anomaly_code ${base} AND ea.status <> 'Cancelled' AND ea.anomaly_code IS NOT NULL AND ea.anomaly_ack_at IS NULL`, params);
  add('UNACK_ANOMALY', 'Rows with an anomaly that was not acknowledged.', unack);
  if (requirePaper) {
    const [paper] = await conn.query(`SELECT ${cols} ${base} AND ea.status = 'Approved' AND ea.paper_status <> 'Matched' AND ${notInActive}`, [...params, ...exParams]);
    add('PAPER_NOT_MATCHED', 'Approved rows not matched with the signed paper sheet.', paper);
  }
  const [inOther] = await conn.query(
    `SELECT ${cols}, b.eq_batch_id ${base.replace('WHERE', `JOIN eq_payroll_attendance_snapshot ps ON ps.eq_attendance_id = ea.eq_attendance_id
      JOIN eq_payroll_batches b ON b.eq_batch_id = ps.eq_batch_id AND ${ACTIVE_BATCH}${scope.exclude_batch_id ? ' AND b.eq_batch_id <> ?' : ''} WHERE`)}`,
    [...exParams, ...params]);
  add('IN_OTHER_BATCH', 'Rows already paid in another active batch (they are skipped).', inOther);
  // rate cards: for eligible rows and for Monthly deployments
  const [approved] = await conn.query(`SELECT ea.eq_attendance_id, ea.equipment_id, e.equipment_code, st.site_code, ea.record_date, ea.day_status, ea.standby_minutes, ea.standby_credit_minutes,
    e.vendor_id AS _v, ea.equipment_id AS _e, ea.site_id AS _s, ea.record_date AS _d ${base} AND ea.status = 'Approved' AND ${notInActive}`, [...params, ...exParams]);
  const ids = [...new Set(approved.map((r) => r.equipment_id))];
  const cards = await loadRateCards(conn, ids, scope.start_date, scope.end_date);
  add('NO_RATE_CARD', 'Rows on dates without a rate card.', approved.filter((r) => !cardFor(cards, r.equipment_id, r.record_date)));
  // monthly machines: the standby hours paid are decided per row by the Admin/Accountant (no %)
  add('STANDBY_HOURS_NOT_SET', 'Monthly machines with standby: set the standby hours to pay (Attendance review).',
    approved.filter((r) => {
      const c = cardFor(cards, r.equipment_id, r.record_date);
      return c && c.billing_mode === 'Monthly' && hasStandby(r) && (r.standby_credit_minutes === null || r.standby_credit_minutes === undefined);
    }).map(({ standby_credit_minutes: _x, ...r }) => r));
  // monthly machines are billed from their deployments: a row on a day without deployment would be billed in no month
  const monthlyRows = approved.filter((r) => { const c = cardFor(cards, r.equipment_id, r.record_date); return c && c.billing_mode === 'Monthly'; });
  if (monthlyRows.length) {
    const [dps] = await conn.query(
      'SELECT equipment_id, assigned_date, unassigned_date FROM eq_site_assignments WHERE equipment_id IN (?) AND (unassigned_date IS NULL OR unassigned_date >= assigned_date)',
      [[...new Set(monthlyRows.map((r) => r.equipment_id))]]);
    add('MONTHLY_ROW_NOT_DEPLOYED', 'Monthly machines with attendance on days they were not deployed (fix the deployment dates).',
      monthlyRows.filter((r) => !dps.some((d) => d.equipment_id === r.equipment_id && covers(d.assigned_date, d.unassigned_date, String(r.record_date).slice(0, 10))))
        .map(({ standby_credit_minutes: _x, standby_minutes: _y, ...r }) => r));
  }
  add('MONTHLY_DAYS_WITHOUT_ROWS', 'Monthly machines deployed on working days that have no attendance row: the hours due of those days are deducted as missing hours.',
    await monthlyDaysWithoutRows(conn, scope));
  const fs = scopeSql(scope, 'f');
  const [fuel] = await conn.query(
    `SELECT f.fuel_issue_id, e.equipment_code, f.issue_date, f.liters, e.vendor_id AS _v, f.equipment_id AS _e, f.site_id AS _s, f.issue_date AS _d
     FROM eq_fuel_issues f JOIN eq_equipment e ON e.equipment_id = f.equipment_id
     WHERE f.issue_date BETWEEN ? AND ? AND f.is_cancelled = 0 AND f.price_per_liter IS NULL${fs.sql}`, [scope.start_date, scope.end_date, ...fs.params]);
  add('FUEL_UNPRICED', 'Fuel issues without a price per litre.', fuel);
  // fuel price difference: a machine with fuel terms needs a national price on every working day
  const payable = approved.filter((r) => cardFor(cards, r.equipment_id, r.record_date));
  if (payable.length) {
    const terms = await loadFuelTerms(conn, ids, scope.start_date, scope.end_date);
    if (terms.length) {
      const prices = await loadFuelPrices(conn);
      const noPrice = payable.filter((r) => termsFor(terms, r.equipment_id, r.record_date)
        && !priceOn(prices, cardFor(cards, r.equipment_id, r.record_date).currency, r.record_date));
      add('FUEL_PRICE_MISSING', 'Machines with a fuel difference agreement have days without a national fuel price.', noPrice);
    }
  }
  add('MONTHLY_MULTI_SITE', 'Monthly machines that also work at another site in this period: generate per vendor or per machine (not per site), so their hours due are counted once.',
    await monthlyMultiSite(conn, scope));
  // signed monthly sheets: needed to FINALIZE (not to generate) — shown early as information
  const [toPay] = await conn.query(`SELECT ea.eq_attendance_id ${base} AND ea.status = 'Approved' AND ${notInActive}`, [...params, ...exParams]);
  add('SCAN_MISSING', 'Signed monthly sheets not uploaded yet (needed before finalizing).', await sheetsMissingScan(conn, toPay.map((r) => r.eq_attendance_id)));
  return out;
}

const BLOCKING = ['NOT_APPROVED', 'OPEN_SESSION', 'UNACK_ANOMALY', 'PAPER_NOT_MATCHED', 'NO_RATE_CARD', 'STANDBY_HOURS_NOT_SET', 'FUEL_UNPRICED', 'FUEL_PRICE_MISSING', 'MONTHLY_MULTI_SITE', 'MONTHLY_ROW_NOT_DEPLOYED'];
/** Shown with the blockers but never prevent generating. */
const INFO_ONLY = ['IN_OTHER_BATCH', 'SCAN_MISSING', 'MONTHLY_DAYS_WITHOUT_ROWS'];

/* include_submitted (provisional statements ONLY, never preview / generate): Submitted rows not approved yet are counted too. */
/**
 * Full calculation for a scope. Returns { currency_groups, items (with lines, rows), warnings, blockers }.
 * Nothing is written.
 */
async function calculate(conn, scope) {
  if (scope.end_date < scope.start_date) throw AppError.validation({ end_date: 'must be on or after start_date' });
  if (Date.parse(scope.end_date) - Date.parse(scope.start_date) > 366 * 86400000) throw AppError.validation({ end_date: 'the period cannot exceed one year' });
  const requirePaper = await settings.getBool('eq_payroll_requires_paper_match');
  const s = scopeSql(scope);
  const exParams = scope.exclude_batch_id ? [scope.exclude_batch_id] : [];
  const [rows] = await conn.query(
    `SELECT ea.*, e.vendor_id, e.equipment_code, o.full_name AS operator_name FROM eq_attendance ea
     JOIN eq_equipment e ON e.equipment_id = ea.equipment_id LEFT JOIN eq_operators o ON o.operator_id = ea.operator_id
     WHERE ea.record_date BETWEEN ? AND ? AND ${scope.include_submitted ? "ea.status IN ('Approved','Submitted')" : "ea.status = 'Approved'"} ${requirePaper ? "AND ea.paper_status = 'Matched'" : ''}${s.sql}
       AND NOT EXISTS (SELECT 1 FROM eq_payroll_attendance_snapshot ps JOIN eq_payroll_batches b ON b.eq_batch_id = ps.eq_batch_id
         WHERE ps.eq_attendance_id = ea.eq_attendance_id AND ${ACTIVE_BATCH}${scope.exclude_batch_id ? ' AND b.eq_batch_id <> ?' : ''})
     ORDER BY ea.equipment_id, ea.site_id, ea.record_date${scope.lock ? ' FOR UPDATE' : ''}`,
    [scope.start_date, scope.end_date, ...s.params, ...exParams]);

  // Monthly machines are billed from their deployments even on days without rows.
  const ds = scopeSql(scope, 'a');
  const [deps] = await conn.query(
    `SELECT a.eq_assignment_id, a.equipment_id, a.site_id, a.shift_type, a.assigned_date, a.unassigned_date, e.vendor_id, e.equipment_code FROM eq_site_assignments a
     JOIN eq_equipment e ON e.equipment_id = a.equipment_id
     WHERE a.assigned_date <= ? AND (a.unassigned_date IS NULL OR a.unassigned_date >= ?) AND (a.unassigned_date IS NULL OR a.unassigned_date >= a.assigned_date)${ds.sql}`,
    [scope.end_date, scope.start_date, ...ds.params]);
  const fs = scopeSql(scope, 'f');
  const [fuel] = await conn.query(
    `SELECT f.*, e.vendor_id FROM eq_fuel_issues f JOIN eq_equipment e ON e.equipment_id = f.equipment_id
     WHERE f.issue_date BETWEEN ? AND ? AND f.is_cancelled = 0 AND f.price_per_liter IS NOT NULL${fs.sql}
       AND NOT EXISTS (SELECT 1 FROM eq_payroll_lines l JOIN eq_payroll_items i ON i.eq_item_id = l.eq_item_id JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id
         WHERE l.source_table = 'eq_fuel_issues' AND l.source_id = f.fuel_issue_id AND ${ACTIVE_BATCH}${scope.exclude_batch_id ? ' AND b.eq_batch_id <> ?' : ''})`,
    [scope.start_date, scope.end_date, ...fs.params, ...exParams]);
  const as = scopeSql({ ...scope, site_id: null }, 'ad');
  const [adjs] = await conn.query(
    `SELECT ad.*, e.vendor_id FROM eq_adjustments ad JOIN eq_equipment e ON e.equipment_id = ad.equipment_id
     WHERE ad.adjustment_date BETWEEN ? AND ? AND ad.status = 'Active'${as.sql}${scope.site_id ? ' AND (ad.site_id IS NULL OR ad.site_id = ?)' : ''}
       AND NOT EXISTS (SELECT 1 FROM eq_payroll_lines l JOIN eq_payroll_items i ON i.eq_item_id = l.eq_item_id JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id
         WHERE l.source_table = 'eq_adjustments' AND l.source_id = ad.adjustment_id AND ${ACTIVE_BATCH}${scope.exclude_batch_id ? ' AND b.eq_batch_id <> ?' : ''})`,
    [scope.start_date, scope.end_date, ...as.params, ...(scope.site_id ? [scope.site_id] : []), ...exParams]);
  // DNR delivery notes (per-unit billing): not yet paid by an active batch. The note's own vendor decides the scope.
  const dnw = []; const dnp = [];
  if (scope.vendor_id) { dnw.push('dn.vendor_id = ?'); dnp.push(scope.vendor_id); }
  if (scopeMachines(scope)) { dnw.push('dn.equipment_id IN (?)'); dnp.push(scopeMachines(scope)); }
  if (scope.site_id) { dnw.push('dn.site_id = ?'); dnp.push(scope.site_id); }
  const [dns] = await conn.query(
    `SELECT dn.*, r.item_name, r.unit, vc.contract_number FROM eq_delivery_notes dn
     JOIN eq_dnr_rates r ON r.dnr_rate_id = dn.dnr_rate_id JOIN eq_vendor_contracts vc ON vc.vendor_contract_id = r.vendor_contract_id
     WHERE dn.note_date BETWEEN ? AND ? AND dn.status = 'Active'${dnw.length ? ` AND ${dnw.join(' AND ')}` : ''}
       AND NOT EXISTS (SELECT 1 FROM eq_payroll_lines l JOIN eq_payroll_items i ON i.eq_item_id = l.eq_item_id JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id
         WHERE l.source_table = 'eq_delivery_notes' AND l.source_id = dn.delivery_note_id AND ${ACTIVE_BATCH}${scope.exclude_batch_id ? ' AND b.eq_batch_id <> ?' : ''})
     ORDER BY dn.equipment_id, dn.site_id, dn.note_date${scope.lock ? ' FOR UPDATE' : ''}`,
    [scope.start_date, scope.end_date, ...dnp, ...exParams]);

  // 11 Oct 2026 (replaces the closed-period rule of 6 Oct 2026): every unit is billed ONCE — a row, a monthly day, a fuel
  // issue, an adjustment, a delivery note — by whichever batch takes it first (draft or finalized). What a finalized
  // batch did not bill (a row approved late, a machine left out) is paid by the next batch; nothing blocks another batch.
  const equipmentIds = [...new Set([...rows, ...deps, ...fuel, ...adjs, ...dns].map((r) => r.equipment_id))];
  const cards = await loadRateCards(conn, equipmentIds, scope.start_date, scope.end_date);
  const fuelTerms = await loadFuelTerms(conn, equipmentIds, scope.start_date, scope.end_date);
  const fuelPrices = fuelTerms.length ? await loadFuelPrices(conn) : [];
  const allowNegative = await settings.getBool('eq_fuel_diff_allow_negative');
  const offDay = await settings.getInt('eq_weekly_off_day');
  await applyShiftRules(conn, rows, cards, scope);
  // A machine deployed on two shifts at two sites the same day: its MONTHLY base is billed once, to the Day-shift site.
  // Every deployment of these machines is read (not only the site in scope) so the owner site is always right.
  const depIds = [...new Set([...deps, ...rows].map((d) => d.equipment_id))];
  const [allDeps] = depIds.length ? await conn.query(
    `SELECT eq_assignment_id, equipment_id, site_id, shift_type, assigned_date, unassigned_date FROM eq_site_assignments
     WHERE equipment_id IN (?) AND assigned_date <= ? AND (unassigned_date IS NULL OR unassigned_date >= ?) AND (unassigned_date IS NULL OR unassigned_date >= assigned_date)`,
    [depIds, scope.end_date, scope.start_date]) : [[]];
  const ownerSite = (equipmentId, day) => {
    const c = allDeps.filter((d) => d.equipment_id === equipmentId && covers(d.assigned_date, d.unassigned_date, day))
      .sort((a, b) => (a.shift_type === b.shift_type ? 0 : a.shift_type === 'Day' ? -1 : 1) || String(a.assigned_date).localeCompare(String(b.assigned_date)) || a.eq_assignment_id - b.eq_assignment_id);
    return c.length ? c[0].site_id : null;
  };
  const warnings = [];
  // Monthly machines: days already billed by another active batch (each monthly day once), the rows those batches paid
  // (the hours of the month are settled on the whole month: F-difference), and the terms of each month.
  const monthlyIds = [...new Set(cards.filter((c) => c.billing_mode === 'Monthly').map((c) => c.equipment_id))];
  const monthFrom = `${monthOf(scope.start_date)}-01`;
  const monthTo = `${monthOf(scope.end_date)}-${String(daysInMonth(monthOf(scope.end_date))).padStart(2, '0')}`;
  const termsOf = await loadMonthlyTerms(conn, monthlyIds, monthOf(scope.start_date), monthOf(scope.end_date));
  const [heldDays] = monthlyIds.length ? await conn.query(
    `SELECT md.equipment_id, md.day, md.eq_batch_id, i.rate_card_id FROM eq_payroll_monthly_days md
     JOIN eq_payroll_batches b ON b.eq_batch_id = md.eq_batch_id JOIN eq_payroll_items i ON i.eq_item_id = md.eq_item_id
     WHERE md.equipment_id IN (?) AND md.day BETWEEN ? AND ? AND ${ACTIVE_BATCH} AND b.eq_batch_id <> ?`,
    [monthlyIds, monthFrom, monthTo, scope.exclude_batch_id || 0]) : [[]];
  const [prevRowsAll] = monthlyIds.length ? await conn.query(
    `SELECT ea.*, i.rate_card_id AS held_rate_card_id FROM eq_payroll_attendance_snapshot ps JOIN eq_payroll_batches b ON b.eq_batch_id = ps.eq_batch_id
     JOIN eq_payroll_items i ON i.eq_item_id = ps.eq_item_id JOIN eq_attendance ea ON ea.eq_attendance_id = ps.eq_attendance_id
     WHERE i.equipment_id IN (?) AND i.billing_mode = 'Monthly' AND ps.record_date BETWEEN ? AND ? AND ${ACTIVE_BATCH} AND b.eq_batch_id <> ?
       AND ea.status <> 'Cancelled'`,
    [monthlyIds, monthFrom, monthTo, scope.exclude_batch_id || 0]) : [[]];
  const groups = new Map();
  // A MONTHLY card is one contract per machine: one group whatever the site (hours due settled once per month);
  // it is billed on the site where the machine spent most deployed days, with the cost split by site.
  const mainSite = (equipmentId) => {
    const count = new Map();
    for (let d = scope.start_date; d <= scope.end_date; d = addDays(d, 1)) {
      const s = ownerSite(equipmentId, d);
      if (s) count.set(s, (count.get(s) || 0) + 1);
    }
    let best = null; let n = -1;
    for (const [s, c] of count) if (c > n) { best = s; n = c; }
    return best;
  };
  const groupFor = (equipmentId, siteId, card, vendorId) => {
    if (card && card.billing_mode === 'Monthly') siteId = mainSite(equipmentId) || siteId;
    const key = `${equipmentId}|${card && card.billing_mode === 'Monthly' ? 'M' : siteId}|${card ? card.rate_card_id : 'none'}`;
    if (!groups.has(key)) groups.set(key, { equipment_id: equipmentId, site_id: siteId, vendor_id: vendorId, card, rows: [], fuel: [], adjustments: [] });
    return groups.get(key);
  };
  for (const r of rows) {
    const card = cardFor(cards, r.equipment_id, r.record_date);
    if (!card) throw AppError.conflict('NO_RATE_CARD', `${r.equipment_code} has no rate card on ${r.record_date}.`);
    groupFor(r.equipment_id, r.site_id, card, r.vendor_id).rows.push(r);
  }
  // DNR: one group per machine x site x currency, separate from any rate card of the same machine (both are paid)
  const dnrRates = await dnr.ratesForMachines(conn, equipmentIds, scope.start_date, scope.end_date);
  const dnrGroupFor = (equipmentId, siteId, vendorId, currency) => {
    const key = `${equipmentId}|${siteId}|DNR|${currency}`;
    if (!groups.has(key)) groups.set(key, { dnr: true, equipment_id: equipmentId, site_id: siteId, vendor_id: vendorId, currency, card: null, rows: [], fuel: [], adjustments: [], delivery_notes: [] });
    return groups.get(key);
  };
  for (const n of dns) dnrGroupFor(n.equipment_id, n.site_id, n.vendor_id, n.currency).delivery_notes.push(n);
  /** Fuel / adjustment of a machine WITHOUT a rate card on that date: it goes with the machine's DNR item (same site first). */
  const dnrFallback = (equipmentId, siteId, vendorId, date, currency = null) => {
    const mine = [...groups.values()].filter((g) => g.dnr && g.equipment_id === equipmentId && (!currency || g.currency === currency));
    const same = mine.find((g) => siteId && g.site_id === siteId) || mine[0];
    if (same) return same;
    // no delivery note of this machine in the period: only a machine that HAS a DNR price on that date gets a DNR item
    const priced = dnr.currencyOn(dnrRates, equipmentId, date);
    if (!priced || !siteId) return null;
    return dnrGroupFor(equipmentId, siteId, vendorId, currency || priced);
  };
  // monthly bases from deployments
  for (const d of deps) {
    const monthlyCards = cards.filter((c) => c.equipment_id === d.equipment_id && c.billing_mode === 'Monthly');
    for (const c of monthlyCards) {
      const g = groupFor(d.equipment_id, d.site_id, c, d.vendor_id);
      g.deployRanges = g.deployRanges || [];
      g.deployRanges.push({ from: d.assigned_date, to: d.unassigned_date });
    }
  }
  for (const f of fuel) {
    const card = cardFor(cards, f.equipment_id, f.issue_date);
    if (!card) {
      const dg = dnrFallback(f.equipment_id, f.site_id, f.vendor_id, f.issue_date);
      if (dg) { dg.fuel.push(f); continue; }
      throw AppError.conflict('NO_RATE_CARD', `Fuel issue #${f.fuel_issue_id} is on a date without a rate card or DNR price.`);
    }
    groupFor(f.equipment_id, f.site_id, card, f.vendor_id).fuel.push(f);
  }
  for (const a of adjs) {
    const card = cardFor(cards, a.equipment_id, a.adjustment_date);
    let siteId = a.site_id;
    if (!siteId) {
      const candidates = [...groups.values()].filter((g) => g.equipment_id === a.equipment_id);
      candidates.sort((x, y) => y.rows.length - x.rows.length);
      siteId = candidates[0] ? candidates[0].site_id : (deps.find((d) => d.equipment_id === a.equipment_id) || {}).site_id;
    }
    if (!siteId) { warnings.push({ code: 'ADJUSTMENT_WITHOUT_SITE', adjustment_id: a.adjustment_id }); continue; }
    if (!card) {
      const dg = dnrFallback(a.equipment_id, siteId, a.vendor_id, a.adjustment_date, a.currency);
      if (dg) { dg.adjustments.push(a); continue; }
      throw AppError.conflict('NO_RATE_CARD', `Adjustment #${a.adjustment_id} is on a date without a rate card or DNR price.`);
    }
    groupFor(a.equipment_id, siteId, card, a.vendor_id).adjustments.push(a);
  }

  const items = [];
  for (const g of groups.values()) {
    if (g.dnr) {
      if (g.delivery_notes.length || g.fuel.length || g.adjustments.length) items.push(dnr.billGroup(g));
      continue;
    }
    const rate = engineRate(g.card);
    let ctx = {};
    let monthly = null;
    if (rate.billing_mode === 'Monthly') {
      monthly = monthlyContext(g, { scope, offDay, heldDays, prevRowsAll, termsOf: (m) => termsOf(g.equipment_id, m), ownerSite });
      ctx = monthly.ctx;
    }
    if (rate.billing_mode !== 'Monthly' && !g.rows.length && !g.fuel.length && !g.adjustments.length) continue;
    if (rate.billing_mode === 'Monthly' && !ctx.months.length && !g.rows.length && !g.fuel.length && !g.adjustments.length) continue;
    const engineRows = g.rows.map(engineRow);
    const thr = rate.billing_mode === 'Monthly' ? Infinity : engine.otThresholdMin(rate); // monthly overtime is counted on the month, not per day
    const perRow = g.rows.map((r) => ({ row: r, ...rowFigures(r, rate, thr) }));
    const fd = fuelDifference(perRow, g.equipment_id, g.card.currency, fuelTerms, fuelPrices, allowNegative);
    if (fd.missing.length) warnings.push({ code: 'FUEL_PRICE_MISSING', equipment_id: g.equipment_id, site_id: g.site_id, days: fd.missing.map((x) => x.record_date), message: 'No national fuel price on some days: no fuel difference for them.' });
    const res = engine.billItem(engineRows, rate, ctx, {
      fuel: g.fuel.map((f) => ({ liters: Number(f.liters), price_per_liter: Number(f.price_per_liter) })),
      adjustments: g.adjustments.map((a) => ({ amount: Number(a.amount), type: a.adjustment_type, reason: a.reason })),
      fuel_diff: fd.lines,
    });
    // attach sources to fuel/adjustment lines (engine appends them in the same order)
    const fuelLines = res.lines.filter((l) => l.line_type === 'Fuel');
    fuelLines.forEach((l, i) => { l.source_table = 'eq_fuel_issues'; l.source_id = g.fuel[i].fuel_issue_id; l.note = `${g.fuel[i].issue_date}${g.fuel[i].receipt_number ? ` receipt ${g.fuel[i].receipt_number}` : ''}`; });
    const adjLines = res.lines.filter((l) => l.line_type === 'Adjustment');
    adjLines.forEach((l, i) => { l.source_table = 'eq_adjustments'; l.source_id = g.adjustments[i].adjustment_id; });
    const fuelDiffSnapshot = fd.days.length ? {
      days: fd.days,
      terms: fuelTerms.filter((t) => fd.days.some((d) => d.fuel_terms_id === t.fuel_terms_id)),
      prices: fuelPrices.filter((p) => fd.days.some((d) => d.fuel_price_id === p.fuel_price_id)),
    } : null;
    const t = res.totals;
    const siteAllocation = rate.billing_mode === 'Monthly' ? allocateBySite(perRow, res.lines, rate) : null;
    if (rate.billing_mode === 'Monthly' && !g.rows.length && monthly.days.length) warnings.push({ code: 'NO_ATTENDANCE_ROWS', equipment_id: g.equipment_id, site_id: g.site_id, message: 'Monthly base billed without any attendance row in the period.' });
    items.push({
      equipment_id: g.equipment_id, vendor_id: g.vendor_id, site_id: g.site_id, currency: g.card.currency,
      rate_card_id: g.card.rate_card_id, rate_snapshot: g.card, fuel_diff: fuelDiffSnapshot, monthly_calc: res.monthly_details || null, billing_mode: rate.billing_mode,
      days_recorded: g.rows.length, worked_days: t.workedDays || 0,
      work_minutes: t.work || 0, overtime_minutes: t.ot || 0, standby_minutes: t.standby || 0, breakdown_minutes: t.breakdown || 0, topup_minutes: t.topup || 0,
      gross_cents: res.gross_cents, deductions_cents: res.deductions_cents, net_cents: res.net_cents,
      lines: res.lines, per_row: perRow, months: ctx.months || null, site_allocation: siteAllocation,
      // monthly: the days this item bills (held once), the part already billed by other batches, the terms used
      monthly_days: monthly ? monthly.days : null,
      monthly_prev: monthly && ctx.prev ? { months: ctx.prev.months, row_ids: monthly.prevRowIds } : null,
      monthly_terms: monthly ? (ctx.months || []).map((m) => ({ month: m.month, divisor: m.divisor, divisor_source: m.divisorSource,
        hourly: m.hourlyCents === null || m.hourlyCents === undefined ? null : m.hourlyCents / 100, hourly_source: m.hourlySource })) : null,
    });
  }
  return { items, warnings };
}

/**
 * Monthly context of one group (one machine x one monthly card). Days of the scope inside the card and the deployments
 * that no other active batch holds are THIS part. Months this part touches (by its days or its rows) are billed as
 * F(days and rows of all parts) - F(days and rows already billed): the parts always add up to the whole month.
 * Returns { ctx, days: [{ day, site_id }], prevRowIds }.
 */
function monthlyContext(g, { scope, offDay, heldDays, prevRowsAll, termsOf, ownerSite }) {
  const ranges = g.deployRanges || [];
  const cardId = g.card.rate_card_id;
  const held = heldDays.filter((h) => h.equipment_id === g.equipment_id && h.rate_card_id === cardId).map((h) => String(h.day).slice(0, 10));
  const heldSet = new Set(held);
  const mine = ranges.length ? deployedDays(scope.start_date, scope.end_date, ranges, g.card, (d) => !heldSet.has(d)) : [];
  const touched = new Set([...mine.map(monthOf), ...g.rows.map((r) => monthOf(String(r.record_date).slice(0, 10)))]);
  const heldIn = held.filter((d) => touched.has(monthOf(d)));
  const prevRows = prevRowsAll.filter((r) => r.equipment_id === g.equipment_id && r.held_rate_card_id === cardId && touched.has(monthOf(String(r.record_date).slice(0, 10))));
  // a month is billed only when it has deployed days (this part's or another's); rows on other days wait for a deployment
  const withDays = new Set([...mine, ...heldIn].map(monthOf));
  const holidayOf = (list) => new Set(list.filter((r) => r.day_status === 'Holiday').map((r) => String(r.record_date).slice(0, 10)));
  const allDays = [...mine, ...heldIn];
  const months = monthsFromDays(allDays, g.card, offDay, holidayOf([...g.rows, ...prevRows]), termsOf);
  const days = mine.map((d) => ({ day: d, site_id: ownerSite(g.equipment_id, d) || g.site_id }));
  if (!heldIn.length && !prevRows.length) return { ctx: { months }, days, prevRowIds: [] };
  const prevMonthsList = [...new Set(prevRows.map((r) => monthOf(String(r.record_date).slice(0, 10))))].filter((m) => withDays.has(m));
  const prevMonths = monthsFromDays(heldIn, g.card, offDay, holidayOf(prevRows), termsOf, prevMonthsList);
  return {
    ctx: { months, prev: { rows: prevRows.filter((r) => withDays.has(monthOf(String(r.record_date).slice(0, 10)))).map(engineRow), months: prevMonths } },
    days,
    prevRowIds: prevRows.map((r) => r.eq_attendance_id),
  };
}

/**
 * A monthly machine that worked at several sites is billed once (to its Day-shift site); its cost (base, overtime,
 * missing hours, operator) is shown split between the sites by the hours each site got. Null when one site only.
 */
function allocateBySite(perRow, lines, rate) {
  const bd = Number(rate.breakdown_billable_pct) / 100;
  const hours = new Map();
  for (const p of perRow) {
    const sid = p.row.site_id;
    const min = p.work + (p.credit || 0) + p.breakdown * bd;
    hours.set(sid, (hours.get(sid) || 0) + min);
  }
  if (hours.size < 2) return null;
  const cost = lines.filter((l) => ['MonthlyBase', 'BreakdownDeduction', 'AbsenceDeduction', 'Overtime', 'HoursShortfall', 'Operator'].includes(l.line_type)).reduce((a, l) => a + l.amount_cents, 0);
  const total = [...hours.values()].reduce((a, x) => a + x, 0);
  const entries = [...hours.entries()].sort((a, b) => a[0] - b[0]);
  let left = cost;
  return entries.map(([siteId, min], i) => {
    const share = total > 0 ? min / total : 1 / entries.length;
    const cents = i === entries.length - 1 ? left : Math.round(cost * share);
    left -= cents;
    return { site_id: siteId, hours: Math.round(min / 60 * 100) / 100, share_pct: Math.round(share * 10000) / 100, amount_cents: cents };
  });
}

/** Settings that change amounts: frozen in each batch (shown on it, reused by corrections). */
const BILLING_SETTINGS = ['eq_weekly_off_day', 'eq_fuel_diff_allow_negative', 'eq_payroll_requires_paper_match', 'eq_shift_continuity_minutes'];
async function billingSettings() {
  const out = {};
  for (const k of BILLING_SETTINGS) out[k] = await settings.getString(k);
  return out;
}

/**
 * Would this batch come out differently if generated now? Re-runs the calculation for its scope (its own rows count
 * as free) and compares machine by machine: amounts, the rows taken, and the settings it was made with. Catches every
 * input: attendance, standby hours, fuel issued, adjustments, rate cards, fuel prices / terms, settings, rows approved
 * since. Paper checks, scans and remarks change nothing here.
 */
async function batchDrift(conn, batch) {
  const reasons = [];
  const scope = { ...(await batchScope(conn, batch)), exclude_batch_id: batch.eq_batch_id };
  const frozen = parseJson(batch.settings_snapshot);
  if (frozen) {
    const now = await billingSettings();
    for (const k of Object.keys(now)) if (frozen[k] !== undefined && String(frozen[k]) !== String(now[k])) reasons.push({ code: 'SETTING_CHANGED', setting: k, was: frozen[k], now: now[k] });
  }
  let calc;
  try {
    calc = await calculate(conn, scope);
  } catch (e) {
    if (!e.isAppError) throw e;
    return [...reasons, { code: e.code, message: e.message }];
  }
  const items = calc.items.filter((i) => i.currency === batch.currency);
  const [stored] = await conn.query('SELECT eq_item_id, equipment_id, site_id, rate_card_id, billing_mode, net_amount, rate_snapshot FROM eq_payroll_items WHERE eq_batch_id = ?', [batch.eq_batch_id]);
  const key = (x) => `${x.equipment_id}|${x.site_id}|${x.rate_card_id || 'none'}|${x.billing_mode === 'DNR' ? 'DNR' : ''}`;
  const was = new Map(stored.map((x) => [key(x), Math.round(Number(x.net_amount) * 100)]));
  // the terms of a month (divisor / hourly price) changed since the batch was made: said on its own line
  const termsText = (months) => (months || []).map((m) => `${m.month}: /${m.divisor ?? m.workingDays}${m.hourlyCents ? ` @${(m.hourlyCents / 100).toFixed(2)}` : ''}`).join(', ');
  for (const st of stored.filter((x) => x.billing_mode === 'Monthly')) {
    const now = items.find((i) => key(i) === key(st));
    if (!now) continue;
    const old = termsText((parseJson(st.rate_snapshot) || {}).months);
    const cur = termsText(now.months);
    if (old !== cur) reasons.push({ code: 'MONTHLY_TERMS_CHANGED', item: key(st), was: old, now: cur });
  }
  const now = new Map(items.map((x) => [key(x), x.net_cents]));
  for (const [k, cents] of now) {
    if (!was.has(k)) reasons.push({ code: 'ITEM_ADDED', item: k, net: cents / 100 });
    else if (was.get(k) !== cents) reasons.push({ code: 'AMOUNT_CHANGED', item: k, was: was.get(k) / 100, now: cents / 100 });
  }
  for (const [k, cents] of was) if (!now.has(k)) reasons.push({ code: 'ITEM_REMOVED', item: k, was: cents / 100 });
  const [snap] = await conn.query('SELECT eq_attendance_id FROM eq_payroll_attendance_snapshot WHERE eq_batch_id = ?', [batch.eq_batch_id]);
  const inBatch = new Set(snap.map((r) => r.eq_attendance_id));
  const taken = new Set(items.flatMap((i) => i.per_row.map((p) => p.row.eq_attendance_id)));
  const added = [...taken].filter((id) => !inBatch.has(id));
  const dropped = [...inBatch].filter((id) => !taken.has(id));
  if (added.length) reasons.push({ code: 'ROWS_ADDED', count: added.length, ids: added.slice(0, 50) });
  if (dropped.length) reasons.push({ code: 'ROWS_DROPPED', count: dropped.length, ids: dropped.slice(0, 50) });
  for (const c of await changedRows(conn, batch.eq_batch_id)) reasons.push({ code: 'ROW_CHANGED', ...c });
  return reasons;
}

module.exports = { scopeMachines, batchScope, monthTerms, monthsFromDays, deployedDays, monthlyContext, loadMonthlyTerms, ACTIVE_BATCH, calcDetail, applyShiftRules, allocateBySite, monthlyMultiSite, batchDrift, billingSettings, BILLING_SETTINGS, calculate, blockers, changedRows, hasStandby, engineRow, rowFigures, BLOCKING, INFO_ONLY, engineRate, monthsContext, workingDaysOfMonth, scopeSql, parseJson, sheetsMissingScan, fuelDifference, priceOn };