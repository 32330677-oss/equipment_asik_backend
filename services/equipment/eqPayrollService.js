// services/equipment/eqPayrollService.js — loads data, calls the PURE billing engine, writes batches (§5.9).
const AppError = require('../../utils/AppError');
const settings = require('../settings');
const engine = require('./equipmentBillingEngine');
const { addDays, daysInMonth, monthOf } = require('../../utils/businessDate');
const { covers } = require('../../utils/ranges');
const { parseJson } = require('./eqCommon');

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
    monthly_working_days: Number(rc.monthly_working_days), operator_included: Number(rc.operator_included) === 1 || rc.operator_included === true,
    operator_daily_rate: toNum(rc.operator_daily_rate), second_shift_pct: Number(rc.second_shift_pct || 0),
  };
}

function scopeSql(scope, alias = 'ea', eAlias = 'e') {
  const w = []; const p = [];
  if (scope.vendor_id) { w.push(`${eAlias}.vendor_id = ?`); p.push(scope.vendor_id); }
  if (scope.equipment_id) { w.push(`${alias}.equipment_id = ?`); p.push(scope.equipment_id); }
  if (scope.site_id) { w.push(`${alias}.site_id = ?`); p.push(scope.site_id); }
  return { sql: w.length ? ` AND ${w.join(' AND ')}` : '', params: p };
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
 * Per calendar month inside [start,end] ∩ deployments ∩ [card range] (for Monthly billing):
 * deployed days, deployed WORKING days (weekly day off excluded) and official holidays recorded on working days.
 */
function monthsContext(start, end, deployRanges, card, ownsDay = null, offDay = 5, holidayDates = new Set()) {
  const months = {};
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (!covers(card.effective_from, card.effective_to, d)) continue;
    if (!deployRanges.some((r) => covers(r.from, r.to, d))) continue;
    if (ownsDay && !ownsDay(d)) continue;
    const m = monthOf(d);
    const mo = (months[m] = months[m] || { assignedDays: 0, assignedWorkingDays: 0, holidayDays: 0 });
    mo.assignedDays += 1;
    if (weekday(d) !== offDay) {
      mo.assignedWorkingDays += 1;
      if (holidayDates.has(d)) mo.holidayDays += 1;
    }
  }
  return Object.entries(months).map(([month, v]) => ({
    month, daysInMonth: daysInMonth(month), workingDays: workingDaysOfMonth(month, offDay), ...v,
  }));
}

/** A row has standby time (full Standby day, or standby periods inside a Working day). */
function hasStandby(r) { return r.day_status === 'Standby' || Number(r.standby_minutes || 0) > 0; }

/** The fields of an attendance row that the billing engine reads. */
function engineRow(r) {
  return { eq_attendance_id: r.eq_attendance_id, record_date: r.record_date, shift_type: r.shift_type, check_in_time: r.check_in_time, check_out_time: r.check_out_time,
    day_status: r.day_status, gross_minutes: r.gross_minutes, break_minutes: r.break_minutes,
    breakdown_minutes: r.breakdown_minutes, standby_minutes: r.standby_minutes,
    standby_credit_minutes: r.standby_credit_minutes === undefined ? null : r.standby_credit_minutes,
    regular_allow: r.regular_allow, day_used_before: r.day_used_before };
}

/** How a row was billed beside its minutes (continuous shifts, second shift): kept in the snapshot. */
function calcDetail(r) {
  const d = {};
  if (r.regular_allow !== undefined && r.regular_allow !== null && Number.isFinite(r.regular_allow)) d.regular_allow = r.regular_allow;
  if (r.block_shifts > 1) d.block_shifts = r.block_shifts;
  if (r.day_used_before !== undefined && r.day_used_before !== null) d.day_used_before = Math.round(r.day_used_before * 1e6) / 1e6;
  return Object.keys(d).length ? d : null;
}

/** Billed minutes of one row (what goes into the payroll snapshot). thr = overtime threshold in minutes. */
function rowFigures(r, rate, thr) {
  const m = engine.dayMinutes(r, rate);
  const credit = rate.billing_mode === 'Monthly' && r.standby_credit_minutes !== null && r.standby_credit_minutes !== undefined
    ? engine.standbyCredit(r, Math.round(Number(rate.standard_hours_per_day) * 60)) : null;
  return { work: m.work, ot: Math.max(0, m.work - engine.allowOf(r, thr)), standby: m.standby, breakdown: m.breakdown, brk: m.brk, topup: engine.minimumTopUp(m, rate), credit };
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
      && Number(r.s_break) === f.brk && Number(r.s_topup) === f.topup
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
 *  - day_used_before (Daily): part of the calendar day already billed to earlier shifts of the machine.
 * Every row of these machines around the period is read (any site, any status) so the split is the same in
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
       breakdown_minutes, standby_minutes FROM eq_attendance WHERE equipment_id IN (?) AND record_date BETWEEN ? AND ?`,
    [ids, addDays(scope.start_date, -2), addDays(scope.end_date, 2)]);
  const rateOf = (r) => { const c = cardFor(cards, r.equipment_id, String(r.record_date).slice(0, 10)); return c ? engineRate(c) : null; };
  const allow = {}; const used = {};
  for (const id of ids) {
    const mine = ctx.filter((r) => r.equipment_id === id && rateOf(r) && rateOf(r).billing_mode !== 'Monthly');
    Object.assign(allow, engine.blockAllowances(mine, (r) => engine.otThresholdMin(rateOf(r)), (r) => engine.dayMinutes(r, rateOf(r)).work, gap));
    const byCard = new Map();
    for (const r of mine) {
      const c = cardFor(cards, id, String(r.record_date).slice(0, 10));
      if (c.billing_mode !== 'Daily') continue;
      if (!byCard.has(c.rate_card_id)) byCard.set(c.rate_card_id, { c, list: [] });
      byCard.get(c.rate_card_id).list.push(r);
    }
    for (const { c, list } of byCard.values()) Object.assign(used, engine.dayUsedBefore(list, engineRate(c)));
  }
  for (const r of rows) {
    const a = allow[r.eq_attendance_id];
    if (a && Number.isFinite(a.allow)) { r.regular_allow = a.allow; r.block_shifts = a.shifts; }
    if (used[r.eq_attendance_id] !== undefined) r.day_used_before = used[r.eq_attendance_id];
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

/** Everything that prevents rows of the scope from being paid. */
async function blockers(conn, scope) {
  const requirePaper = await settings.getBool('eq_payroll_requires_paper_match');
  const s = scopeSql(scope);
  const out = [];
  const add = (code, message, items) => { if (items.length) out.push({ code, message, count: items.length, items: items.slice(0, 200) }); };
  const base = `FROM eq_attendance ea JOIN eq_equipment e ON e.equipment_id = ea.equipment_id JOIN sites st ON st.site_id = ea.site_id
    WHERE ea.record_date BETWEEN ? AND ?${s.sql}`;
  const params = [scope.start_date, scope.end_date, ...s.params];
  const cols = 'ea.eq_attendance_id, e.equipment_code, st.site_code, ea.record_date, ea.status, ea.paper_status, ea.day_status';
  const notInActive = `NOT EXISTS (SELECT 1 FROM eq_payroll_attendance_snapshot ps JOIN eq_payroll_batches b ON b.eq_batch_id = ps.eq_batch_id
    WHERE ps.eq_attendance_id = ea.eq_attendance_id AND ${ACTIVE_BATCH}${scope.exclude_batch_id ? ' AND b.eq_batch_id <> ?' : ''})`;
  const exParams = scope.exclude_batch_id ? [scope.exclude_batch_id] : [];
  const [notApproved] = await conn.query(`SELECT ${cols} ${base} AND ea.status <> 'Approved' ORDER BY ea.record_date`, params);
  add('NOT_APPROVED', 'Rows not approved yet (Draft, Submitted or Rejected).', notApproved);
  const [open] = await conn.query(`SELECT ${cols} ${base} AND ea.day_status = 'Working' AND ea.check_in_time IS NOT NULL AND ea.check_out_time IS NULL`, params);
  add('OPEN_SESSION', 'Sessions still open (no check-out).', open);
  const [unack] = await conn.query(`SELECT ${cols}, ea.anomaly_code ${base} AND ea.anomaly_code IS NOT NULL AND ea.anomaly_ack_at IS NULL`, params);
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
  const [approved] = await conn.query(`SELECT ea.eq_attendance_id, ea.equipment_id, e.equipment_code, st.site_code, ea.record_date, ea.day_status, ea.standby_minutes, ea.standby_credit_minutes ${base} AND ea.status = 'Approved'`, params);
  const ids = [...new Set(approved.map((r) => r.equipment_id))];
  const cards = await loadRateCards(conn, ids, scope.start_date, scope.end_date);
  add('NO_RATE_CARD', 'Rows on dates without a rate card.', approved.filter((r) => !cardFor(cards, r.equipment_id, r.record_date)));
  // monthly machines: the standby hours paid are decided per row by the Admin/Accountant (no %)
  add('STANDBY_HOURS_NOT_SET', 'Monthly machines with standby: set the standby hours to pay (Attendance review).',
    approved.filter((r) => {
      const c = cardFor(cards, r.equipment_id, r.record_date);
      return c && c.billing_mode === 'Monthly' && hasStandby(r) && (r.standby_credit_minutes === null || r.standby_credit_minutes === undefined);
    }).map(({ standby_credit_minutes: _x, ...r }) => r));
  const fs = scopeSql(scope, 'f');
  const [fuel] = await conn.query(
    `SELECT f.fuel_issue_id, e.equipment_code, f.issue_date, f.liters FROM eq_fuel_issues f JOIN eq_equipment e ON e.equipment_id = f.equipment_id
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

const BLOCKING = ['NOT_APPROVED', 'OPEN_SESSION', 'UNACK_ANOMALY', 'PAPER_NOT_MATCHED', 'NO_RATE_CARD', 'STANDBY_HOURS_NOT_SET', 'FUEL_UNPRICED', 'FUEL_PRICE_MISSING', 'MONTHLY_MULTI_SITE'];
/** Shown with the blockers but never prevent generating. */
const INFO_ONLY = ['IN_OTHER_BATCH', 'SCAN_MISSING'];

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
     WHERE ea.record_date BETWEEN ? AND ? AND ea.status = 'Approved' ${requirePaper ? "AND ea.paper_status = 'Matched'" : ''}${s.sql}
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

  const equipmentIds = [...new Set([...rows, ...deps, ...fuel, ...adjs].map((r) => r.equipment_id))];
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
  const groups = new Map();
  const groupFor = (equipmentId, siteId, card, vendorId) => {
    const key = `${equipmentId}|${siteId}|${card ? card.rate_card_id : 'none'}`;
    if (!groups.has(key)) groups.set(key, { equipment_id: equipmentId, site_id: siteId, vendor_id: vendorId, card, rows: [], fuel: [], adjustments: [] });
    return groups.get(key);
  };
  for (const r of rows) {
    const card = cardFor(cards, r.equipment_id, r.record_date);
    if (!card) throw AppError.conflict('NO_RATE_CARD', `${r.equipment_code} has no rate card on ${r.record_date}.`);
    // a monthly machine working two shifts on two sites is ONE monthly contract: its hours go to the owner (Day-shift) site
    const site = card.billing_mode === 'Monthly' ? (ownerSite(r.equipment_id, r.record_date) || r.site_id) : r.site_id;
    groupFor(r.equipment_id, site, card, r.vendor_id).rows.push(r);
  }
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
    if (!card) throw AppError.conflict('NO_RATE_CARD', `Fuel issue #${f.fuel_issue_id} is on a date without a rate card.`);
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
    if (!card) throw AppError.conflict('NO_RATE_CARD', `Adjustment #${a.adjustment_id} is on a date without a rate card.`);
    groupFor(a.equipment_id, siteId, card, a.vendor_id).adjustments.push(a);
  }

  const items = [];
  for (const g of groups.values()) {
    const rate = engineRate(g.card);
    let ctx = {};
    if (rate.billing_mode === 'Monthly') {
      const ranges = g.deployRanges || [];
      const holidays = new Set(g.rows.filter((r) => r.day_status === 'Holiday').map((r) => String(r.record_date)));
      ctx = { months: monthsContext(scope.start_date, scope.end_date, ranges, g.card, (d) => ownerSite(g.equipment_id, d) === g.site_id, offDay, holidays) };
      if (!ranges.length) ctx.months = [];
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
    if (rate.billing_mode === 'Monthly' && !g.rows.length) warnings.push({ code: 'NO_ATTENDANCE_ROWS', equipment_id: g.equipment_id, site_id: g.site_id, message: 'Monthly base billed without any attendance row in the period.' });
    items.push({
      equipment_id: g.equipment_id, vendor_id: g.vendor_id, site_id: g.site_id, currency: g.card.currency,
      rate_card_id: g.card.rate_card_id, rate_snapshot: g.card, fuel_diff: fuelDiffSnapshot, monthly_calc: res.monthly_details || null, billing_mode: rate.billing_mode,
      days_recorded: g.rows.length, worked_days: t.workedDays || 0,
      work_minutes: t.work || 0, overtime_minutes: t.ot || 0, standby_minutes: t.standby || 0, breakdown_minutes: t.breakdown || 0, topup_minutes: t.topup || 0,
      gross_cents: res.gross_cents, deductions_cents: res.deductions_cents, net_cents: res.net_cents,
      lines: res.lines, per_row: perRow, months: ctx.months || null, site_allocation: siteAllocation,
    });
  }
  return { items, warnings };
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
  const cost = lines.filter((l) => ['MonthlyBase', 'Overtime', 'HoursShortfall', 'Operator'].includes(l.line_type)).reduce((a, l) => a + l.amount_cents, 0);
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
  const scope = { start_date: String(batch.start_date).slice(0, 10), end_date: String(batch.end_date).slice(0, 10),
    vendor_id: batch.scope_vendor_id, equipment_id: batch.scope_equipment_id, site_id: batch.scope_site_id, exclude_batch_id: batch.eq_batch_id };
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
  const [stored] = await conn.query('SELECT eq_item_id, equipment_id, site_id, rate_card_id, net_amount FROM eq_payroll_items WHERE eq_batch_id = ?', [batch.eq_batch_id]);
  const key = (x) => `${x.equipment_id}|${x.site_id}|${x.rate_card_id || 'none'}`;
  const was = new Map(stored.map((x) => [key(x), Math.round(Number(x.net_amount) * 100)]));
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

module.exports = { calcDetail, applyShiftRules, allocateBySite, monthlyMultiSite, batchDrift, billingSettings, BILLING_SETTINGS, calculate, blockers, changedRows, hasStandby, engineRow, rowFigures, BLOCKING, INFO_ONLY, engineRate, monthsContext, workingDaysOfMonth, scopeSql, parseJson, sheetsMissingScan, fuelDifference, priceOn };
