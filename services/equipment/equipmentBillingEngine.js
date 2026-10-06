// services/equipmentBillingEngine.js  — REFERENCE IMPLEMENTATION (pure, no DB)
// All durations are integer minutes; all money is integer minor units (cents).
// Input rows must already be Approved (and paper-Matched when that setting is on).
'use strict';

const toCents = (v) => Math.round(Number(v || 0) * 100);
const roundCents = (x) => Math.round(x); // half-away-from-zero is fine for positive values
/** Money amount -> cents, rounded once; toFixed removes binary noise (1000 x 1.235 = 1234.9999...). */
const exactCents = (amount) => Math.round(Number((Number(amount) * 100).toFixed(6)));
const DAY_STATUSES = ['Working', 'Standby', 'Breakdown', 'Absent', 'Holiday'];

/** Minutes for one attendance row (already clipped/validated when stored). */
function dayMinutes(row, rate) {
  const stdMin = Math.round(Number(rate.standard_hours_per_day) * 60);
  const status = row.day_status;
  if (!DAY_STATUSES.includes(status)) throw new Error(`Unknown day_status ${status}`);
  if (status === 'Absent' || status === 'Holiday') {
    return { status, work: 0, standby: 0, breakdown: 0, brk: 0 };
  }
  const gross = Number(row.gross_minutes || 0);
  if (status === 'Standby') return { status, work: 0, standby: gross > 0 ? gross : stdMin, breakdown: 0, brk: 0 };
  if (status === 'Breakdown') return { status, work: 0, standby: 0, breakdown: gross > 0 ? gross : stdMin, brk: 0 };
  // Working
  const brk = Number(row.break_minutes || 0);
  const breakdown = Number(row.breakdown_minutes || 0);
  const standby = Number(row.standby_minutes || 0);
  const deductibleBreak = rate.break_policy === 'Paid' ? 0 : brk;
  const work = Math.max(0, gross - deductibleBreak - breakdown - standby);
  return { status, work, standby, breakdown, brk };
}

function otThresholdMin(rate) {
  if (!rate.overtime_enabled) return Infinity;
  const h = rate.overtime_threshold_hours != null ? rate.overtime_threshold_hours : rate.standard_hours_per_day;
  return Math.round(Number(h) * 60);
}

function minimumTopUp(m, rate) {
  if (rate.min_billable_hours_per_day == null) return 0;
  if (m.status !== 'Working' && m.status !== 'Standby') return 0;
  const minMin = Math.round(Number(rate.min_billable_hours_per_day) * 60);
  // Breakdown time is the vendor's responsibility: it is never topped up.
  return Math.max(0, minMin - (m.work + m.standby + m.breakdown));
}

/** Overtime price per hour in cents. */
function otRateCents(rate, baseHourlyCents) {
  if (rate.overtime_rate != null) return toCents(rate.overtime_rate);
  return baseHourlyCents * Number(rate.overtime_multiplier || 1); // not rounded: the AMOUNT is rounded once
}

// ---------------------------------------------------------------- Hourly
function billHourly(rows, rate) {
  const hourly = toCents(rate.hourly_rate);
  const thr = otThresholdMin(rate);
  const t = { work: 0, regular: 0, ot: 0, standby: 0, breakdown: 0, topup: 0, standbyBill: 0, breakdownBill: 0, workedDays: 0 };
  const plans = plansFor(rows, rate);
  for (const r of rows) {
    const m = dayMinutes(r, rate);
    const regular = Math.min(m.work, allowOf(r, thr));
    t.work += m.work; t.regular += regular; t.ot += m.work - regular;
    t.standby += m.standby; t.breakdown += m.breakdown;
    t.standbyBill += m.standby * Number(rate.standby_billable_pct) / 100;
    t.breakdownBill += m.breakdown * Number(rate.breakdown_billable_pct) / 100;
    t.topup += plans.get(r).topup;
    if (m.status === 'Working' && m.work > 0) t.workedDays += 1;
  }
  const lines = [
    line('Work', t.regular / 60, 'h', hourly),
    line('Overtime', t.ot / 60, 'h', otRateCents(rate, hourly)),
    line('Standby', t.standbyBill / 60, 'h', hourly),
    line('Breakdown', t.breakdownBill / 60, 'h', hourly),
    line('MinimumTopUp', t.topup / 60, 'h', hourly),
  ];
  return { totals: t, lines: lines.filter((l) => l.quantity !== 0) };
}

// ---------------------------------------------------------------- Daily
function workFraction(workMin, stdMin, rate) {
  if (workMin <= 0) return 0;
  switch (rate.daily_partial_rule) {
    case 'FullDayIfWorked': return 1;
    case 'HalfDayThreshold':
      return workMin >= Math.round(Number(rate.half_day_threshold_hours) * 60) ? 1 : 0.5;
    case 'ProRata':
    default: return Math.min(1, workMin / stdMin);
  }
}

/**
 * Regular (not overtime) minutes this row may still use. A row alone: the threshold. Continuous shifts
 * (gap <= eq_shift_continuity_minutes) share threshold x shifts; the caller then sets row.regular_allow.
 */
function allowOf(r, thr) {
  const a = r.regular_allow;
  return a === null || a === undefined || !Number.isFinite(Number(a)) ? thr : Math.max(0, Number(a));
}

const wallMinutes = (v) => Date.parse(`${String(v).slice(0, 19).replace(' ', 'T')}Z`) / 60000;

/**
 * Continuous shifts of ONE machine: Working rows where the next check-in comes at most `gapMin` minutes after the
 * previous check-out form a block. The block may work thr x (number of shifts) regular minutes before overtime;
 * they are used in time order, so overtime falls on the last hours. Returns { [eq_attendance_id]: { allow, shifts } }.
 * thrOf(row) gives the threshold of the row's card (Infinity = no overtime).
 */
function blockAllowances(rows, thrOf, workOf, gapMin) {
  const list = rows.filter((r) => r.day_status === 'Working' && r.check_in_time && r.check_out_time)
    .sort((a, b) => wallMinutes(a.check_in_time) - wallMinutes(b.check_in_time) || Number(a.eq_attendance_id) - Number(b.eq_attendance_id));
  const out = {};
  let block = [];
  const flush = () => {
    let remaining = block.reduce((acc, r) => acc + thrOf(r), 0);
    for (const r of block) {
      out[r.eq_attendance_id] = { allow: remaining, shifts: block.length };
      if (Number.isFinite(remaining)) remaining = Math.max(0, remaining - Math.min(workOf(r), remaining));
    }
    block = [];
  };
  for (const r of list) {
    const prev = block[block.length - 1];
    if (prev && wallMinutes(r.check_in_time) - wallMinutes(prev.check_out_time) > gapMin) flush();
    block.push(r);
  }
  if (block.length) flush();
  return out;
}

/** Order of the shifts inside one day: Day shift first, then by check-in. */
function shiftOrder(a, b) {
  const sa = a.shift_type === 'Night' ? 1 : 0; const sb = b.shift_type === 'Night' ? 1 : 0;
  return sa - sb || String(a.check_in_time || '').localeCompare(String(b.check_in_time || '')) || Number(a.eq_attendance_id || 0) - Number(b.eq_attendance_id || 0);
}

/**
 * Plan of ONE calendar day for all the rows of ONE machine that day (any site, same rate card).
 *  - minimum top-up: once per day, = minimum - (work + standby + breakdown of all shifts), on the last Working/Standby shift;
 *  - Daily day shares: work of all shifts first (up to one day; the rest is the SECOND SHIFT), then breakdown, then
 *    standby fill what is left of the day. billed day = min(1, sum of work) + second_shift_pct x max(0, sum of work - 1).
 * Returns Map(row -> { topup, wp, extra, bf, sf }) (minutes / day fractions).
 */
function planDay(list, rate) {
  const stdMin = Math.round(Number(rate.standard_hours_per_day) * 60);
  const rows = [...list].sort(shiftOrder);
  const ms = rows.map((r) => dayMinutes(r, rate));
  let topIdx = -1; let topup = 0;
  if (rate.min_billable_hours_per_day != null) {
    ms.forEach((m, i) => { if (m.status === 'Working' || m.status === 'Standby') topIdx = i; });
    if (topIdx >= 0) {
      const covered = ms.reduce((acc, m) => acc + m.work + m.standby + m.breakdown, 0); // breakdown is never topped up
      topup = Math.max(0, Math.round(Number(rate.min_billable_hours_per_day) * 60) - covered);
    }
  }
  const f = rows.map((r, i) => {
    const m = ms[i]; const tu = i === topIdx ? topup : 0;
    return { r, topup: tu, wf: workFraction(m.work + tu, stdMin, rate),
      sf: Math.min(1, m.standby / stdMin) * Number(rate.standby_billable_pct) / 100,
      bf: Math.min(1, m.breakdown / stdMin) * Number(rate.breakdown_billable_pct) / 100 };
  });
  let used = 0;
  for (const x of f) { x.wp = Math.min(x.wf, Math.max(0, 1 - used)); used += x.wp; x.extra = x.wf - x.wp; }
  let avail = Math.max(0, 1 - used);
  for (const x of f) { x.bfx = Math.min(x.bf, avail); avail -= x.bfx; }
  for (const x of f) { x.sfx = Math.min(x.sf, avail); avail -= x.sfx; }
  const out = new Map();
  for (const x of f) out.set(x.r, { topup: x.topup, wp: x.wp, extra: x.extra, bf: x.bfx, sf: x.sfx });
  return out;
}

/** Day plans of rows of ONE machine: Map(row -> plan). A row without a date is a day of its own. */
function planDays(rows, rate) {
  const byDay = new Map();
  for (const r of rows) {
    const k = r.record_date ? String(r.record_date).slice(0, 10) : {};
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(r);
  }
  const out = new Map();
  for (const list of byDay.values()) for (const [r, p] of planDay(list, rate)) out.set(r, p);
  return out;
}

/** Same, keyed by eq_attendance_id (the payroll passes every row of the machine those days, any site). */
function dayPlans(rows, rate) {
  const out = {};
  for (const [r, p] of planDays(rows, rate)) out[r.eq_attendance_id] = p;
  return out;
}

/** Plan of each row of an item: the one given by the caller (row.day_plan), else computed among the item's rows. */
function plansFor(rows, rate) {
  const local = planDays(rows.filter((r) => !r.day_plan), rate);
  const out = new Map();
  for (const r of rows) out.set(r, r.day_plan || local.get(r));
  return out;
}

function billDaily(rows, rate) {
  const daily = toCents(rate.daily_rate);
  const thr = otThresholdMin(rate);
  const hourlyEquiv = daily / Number(rate.standard_hours_per_day);
  const pct = Number(rate.second_shift_pct || 0) / 100;
  const t = { work: 0, ot: 0, standby: 0, breakdown: 0, topup: 0, workDays: 0, standbyDays: 0, breakdownDays: 0, workedDays: 0, secondShiftDays: 0 };
  const plans = plansFor(rows, rate);
  for (const r of rows) {
    const m = dayMinutes(r, rate);
    const d = plans.get(r);
    t.work += m.work; t.ot += Math.max(0, m.work - allowOf(r, thr)); t.topup += d.topup;
    t.standby += m.standby; t.breakdown += m.breakdown;
    t.workDays += d.wp; t.standbyDays += d.sf; t.breakdownDays += d.bf; t.secondShiftDays += d.extra;
    if (m.status === 'Working' && m.work > 0) t.workedDays += 1;
  }
  const lines = [
    line('Work', t.workDays, 'day', daily),
    line('Overtime', t.ot / 60, 'h', otRateCents(rate, hourlyEquiv)),
    line('Standby', t.standbyDays, 'day', daily),
    line('Breakdown', t.breakdownDays, 'day', daily),
  ];
  if (t.secondShiftDays > 0 && pct > 0) {
    lines.push({ line_type: 'SecondShift', quantity: round4(t.secondShiftDays), unit: 'day', unit_price_cents: roundCents(daily * pct),
      unit_price_exact: Math.round(daily * pct * 10) / 1000, amount_cents: roundCents(t.secondShiftDays * daily * pct),
      note: `second shift at ${Math.round(pct * 10000) / 100}% of the daily price` });
  }
  return { totals: t, lines: lines.filter((l) => l.quantity !== 0) };
}

// ---------------------------------------------------------------- Monthly
/** Standby minutes given (paid) on one row of a monthly machine: set by the Admin/Accountant, never above one day. */
function standbyCredit(row, maxCredit) {
  const c = Number(row.standby_credit_minutes);
  if (row.standby_credit_minutes === null || row.standby_credit_minutes === undefined || !Number.isFinite(c) || c <= 0) return 0;
  if (row.day_status === 'Standby') return Math.min(Math.round(c), maxCredit);
  if (row.day_status !== 'Working') return 0; // no standby on this row any more
  return Math.min(Math.round(c), maxCredit, Math.round(Number(row.standby_minutes || 0)));
}

// A monthly machine owes a number of hours per month:
//   working days of the month = calendar days minus the weekly day off (Friday by default)
//   daily price  = monthly price / working days of that month
//   hourly price = daily price / hours per day agreed for the machine (standard_hours_per_day)
//   required hours = deployed working days (minus official holidays recorded) x hours per day
//   billable hours = work + standby hours GIVEN by the Admin/Accountant per row (standby_credit_minutes, max hours per day)
//                    + breakdown x breakdown%   (breaks deducted per break_policy). No standby % for monthly machines.
// Billable >= required -> full base + overtime (extra hours x hourly price, or the overtime_rate typed on the card).
// Billable <  required -> base - missing hours x hourly price.
// ctx.months: [{ month:'2026-10', workingDays:26, assignedWorkingDays:26, holidayDays:0, daysInMonth, assignedDays }]
function billMonthly(rows, rate, ctx) {
  const monthly = toCents(rate.monthly_rate);
  const hpd = Number(rate.standard_hours_per_day);
  const maxCredit = Math.round(hpd * 60);
  const bdPct = Number(rate.breakdown_billable_pct) / 100;
  const t = { work: 0, ot: 0, standby: 0, breakdown: 0, workedDays: 0, baseCents: 0, shortMinutes: 0, requiredMinutes: 0, billableMinutes: 0 };
  const lines = [];
  const details = [];
  const months = ctx.months || [];
  for (const mo of months) {
    const mRows = rows.filter((r) => !r.record_date || String(r.record_date).slice(0, 7) === mo.month);
    let work = 0; let standby = 0; let breakdown = 0; let credit = 0;
    for (const r of mRows) {
      const m = dayMinutes(r, rate);
      work += m.work; standby += m.standby; breakdown += m.breakdown;
      credit += standbyCredit(r, maxCredit);
      if (m.status === 'Working' && m.work > 0) t.workedDays += 1;
    }
    const wd = Math.max(1, Number(mo.workingDays));
    const hourlyC = monthly / wd / hpd; // cents per hour, not rounded
    const baseC = roundCents(monthly * mo.assignedWorkingDays / wd);
    const requiredMin = Math.max(0, Math.round((mo.assignedWorkingDays - (mo.holidayDays || 0)) * hpd * 60));
    const billableMin = Math.round(work + credit + breakdown * bdPct);
    const label = `${mo.month}: ${mo.assignedWorkingDays} of ${wd} working days`;
    lines.push({ line_type: 'MonthlyBase', quantity: round4(mo.assignedWorkingDays / wd), unit: 'month', unit_price_cents: monthly, amount_cents: baseC, note: label });
    let otMin = 0; let shortMin = 0;
    if (billableMin > requiredMin) {
      otMin = billableMin - requiredMin;
      const otC = rate.overtime_rate !== null && rate.overtime_rate !== undefined ? toCents(rate.overtime_rate) : hourlyC;
      lines.push({ line_type: 'Overtime', quantity: round4(otMin / 60), unit: 'h', unit_price_cents: roundCents(otC), unit_price_exact: Math.round(otC * 10) / 1000,
        amount_cents: roundCents((otMin / 60) * otC), note: `${mo.month}: ${(billableMin / 60).toFixed(2)} h done, ${(requiredMin / 60).toFixed(2)} h due` });
    } else if (billableMin < requiredMin) {
      shortMin = requiredMin - billableMin;
      lines.push({ line_type: 'HoursShortfall', quantity: round4(shortMin / 60), unit: 'h', unit_price_cents: -roundCents(hourlyC), unit_price_exact: -Math.round(hourlyC * 10) / 1000,
        amount_cents: -roundCents((shortMin / 60) * hourlyC), note: `${mo.month}: ${(billableMin / 60).toFixed(2)} h done, ${(requiredMin / 60).toFixed(2)} h due` });
    }
    t.work += work; t.standby += standby; t.breakdown += breakdown; t.ot += otMin; t.baseCents += baseC;
    t.shortMinutes += shortMin; t.requiredMinutes += requiredMin; t.billableMinutes += billableMin;
    details.push({ month: mo.month, working_days: wd, deployed_working_days: mo.assignedWorkingDays, holiday_days: mo.holidayDays || 0,
      hours_per_day: hpd, hourly_price: Math.round(hourlyC * 10) / 1000, daily_price: Math.round(monthly / wd) / 100,
      required_hours: requiredMin / 60, billable_hours: billableMin / 60, overtime_hours: otMin / 60, missing_hours: shortMin / 60,
      work_hours: work / 60, standby_hours: standby / 60, standby_paid_hours: credit / 60, breakdown_hours: breakdown / 60 });
  }
  return { totals: t, lines: lines.filter((l) => l.quantity !== 0 || l.line_type === 'MonthlyBase'), monthly_details: details };
}

function round4(x) { return Math.round(x * 10000) / 10000; }
function line(type, quantity, unit, unitPriceCents) {
  const l = { line_type: type, quantity: round4(quantity), unit, unit_price_cents: roundCents(unitPriceCents),
    amount_cents: roundCents(quantity * unitPriceCents) };
  if (Math.abs(unitPriceCents - Math.round(unitPriceCents)) > 1e-9) l.unit_price_exact = Math.round(unitPriceCents * 10) / 1000;
  return l;
}

/**
 * Bill one item = one machine x one site x one rate card inside the period.
 * extras: { fuel:[{liters, price_per_liter}], adjustments:[{amount (signed), type, reason}] }
 */
function billItem(rows, rate, ctx = {}, extras = {}) {
  let res;
  if (rate.billing_mode === 'Hourly') res = billHourly(rows, rate);
  else if (rate.billing_mode === 'Daily') res = billDaily(rows, rate);
  else if (rate.billing_mode === 'Monthly') res = billMonthly(rows, rate, ctx);
  else throw new Error(`Unknown billing_mode ${rate.billing_mode}`);

  if (!rate.operator_included && rate.operator_daily_rate != null) {
    res.lines.push(line('Operator', res.totals.workedDays, 'day', toCents(rate.operator_daily_rate)));
  }
  if (rate.fuel_policy !== 'CompanySuppliesFree') {
    for (const f of extras.fuel || []) {
      const price = Number(f.price_per_liter || 0);
      // the price has 3 decimals: multiply first, round the AMOUNT once (never the unit price)
      res.lines.push({ line_type: 'Fuel', quantity: Number(f.liters), unit: 'L', unit_price_cents: roundCents(price * 100), unit_price_exact: price,
                       amount_cents: -exactCents(Number(f.liters) * price) });
    }
  }
  // fuel price difference (company pays the increase of the national fuel price): computed by the caller per day
  for (const fd of extras.fuel_diff || []) res.lines.push({ ...fd });
  for (const a of extras.adjustments || []) {
    res.lines.push({ line_type: 'Adjustment', quantity: 1, unit: 'item', unit_price_cents: toCents(a.amount),
                     amount_cents: toCents(a.amount), note: `${a.type}: ${a.reason}` });
  }
  const gross = res.lines.filter((l) => l.amount_cents > 0).reduce((s, l) => s + l.amount_cents, 0);
  const deductions = -res.lines.filter((l) => l.amount_cents < 0).reduce((s, l) => s + l.amount_cents, 0);
  return { ...res, gross_cents: gross, deductions_cents: deductions, net_cents: gross - deductions };
}

module.exports = {
  standbyCredit, exactCents, dayMinutes, billItem, billHourly, billDaily, billMonthly, minimumTopUp, otThresholdMin,
  allowOf, planDay, planDays, dayPlans, plansFor, shiftOrder, blockAllowances,
};
