// services/equipmentBillingEngine.js  — REFERENCE IMPLEMENTATION (pure, no DB)
// All durations are integer minutes; all money is integer minor units (cents).
// Input rows must already be Approved (and paper-Matched when that setting is on).
'use strict';

const toCents = (v) => Math.round(Number(v || 0) * 100);
const roundCents = (x) => Math.round(x); // half-away-from-zero is fine for positive values
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
  return roundCents(baseHourlyCents * Number(rate.overtime_multiplier || 1));
}

// ---------------------------------------------------------------- Hourly
function billHourly(rows, rate) {
  const hourly = toCents(rate.hourly_rate);
  const thr = otThresholdMin(rate);
  const t = { work: 0, regular: 0, ot: 0, standby: 0, breakdown: 0, topup: 0, standbyBill: 0, breakdownBill: 0, workedDays: 0 };
  for (const r of rows) {
    const m = dayMinutes(r, rate);
    const regular = Math.min(m.work, thr);
    t.work += m.work; t.regular += regular; t.ot += m.work - regular;
    t.standby += m.standby; t.breakdown += m.breakdown;
    t.standbyBill += m.standby * Number(rate.standby_billable_pct) / 100;
    t.breakdownBill += m.breakdown * Number(rate.breakdown_billable_pct) / 100;
    t.topup += minimumTopUp(m, rate);
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

function billDaily(rows, rate) {
  const daily = toCents(rate.daily_rate);
  const stdMin = Math.round(Number(rate.standard_hours_per_day) * 60);
  const thr = otThresholdMin(rate);
  const hourlyEquiv = daily / Number(rate.standard_hours_per_day);
  const t = { work: 0, ot: 0, standby: 0, breakdown: 0, topup: 0, workDays: 0, standbyDays: 0, breakdownDays: 0, workedDays: 0 };
  for (const r of rows) {
    const m = dayMinutes(r, rate);
    const topup = minimumTopUp(m, rate);
    let wf = workFraction(m.work + topup, stdMin, rate);
    let sf = Math.min(1, m.standby / stdMin) * Number(rate.standby_billable_pct) / 100;
    let bf = Math.min(1, m.breakdown / stdMin) * Number(rate.breakdown_billable_pct) / 100;
    // A day is never billed above 1 day (overtime aside): trim standby, then breakdown.
    if (wf + sf + bf > 1) { sf = Math.max(0, 1 - wf - bf); if (wf + bf > 1) bf = Math.max(0, 1 - wf); }
    t.work += m.work; t.ot += Math.max(0, m.work - thr); t.topup += topup;
    t.standby += m.standby; t.breakdown += m.breakdown;
    t.workDays += wf; t.standbyDays += sf; t.breakdownDays += bf;
    if (m.status === 'Working' && m.work > 0) t.workedDays += 1;
  }
  const lines = [
    line('Work', t.workDays, 'day', daily),
    line('Overtime', t.ot / 60, 'h', otRateCents(rate, hourlyEquiv)),
    line('Standby', t.standbyDays, 'day', daily),
    line('Breakdown', t.breakdownDays, 'day', daily),
  ];
  return { totals: t, lines: lines.filter((l) => l.quantity !== 0) };
}

// ---------------------------------------------------------------- Monthly
// A monthly machine owes a number of hours per month:
//   working days of the month = calendar days minus the weekly day off (Friday by default)
//   daily price  = monthly price / working days of that month
//   hourly price = daily price / hours per day agreed for the machine (standard_hours_per_day)
//   required hours = deployed working days (minus official holidays recorded) x hours per day
//   billable hours = work + standby x standby% + breakdown x breakdown%   (breaks deducted per break_policy)
// Billable >= required -> full base + overtime (extra hours x hourly price, or the overtime_rate typed on the card).
// Billable <  required -> base - missing hours x hourly price.
// ctx.months: [{ month:'2026-10', workingDays:26, assignedWorkingDays:26, holidayDays:0, daysInMonth, assignedDays }]
function billMonthly(rows, rate, ctx) {
  const monthly = toCents(rate.monthly_rate);
  const hpd = Number(rate.standard_hours_per_day);
  const sbPct = Number(rate.standby_billable_pct) / 100;
  const bdPct = Number(rate.breakdown_billable_pct) / 100;
  const t = { work: 0, ot: 0, standby: 0, breakdown: 0, workedDays: 0, baseCents: 0, shortMinutes: 0, requiredMinutes: 0, billableMinutes: 0 };
  const lines = [];
  const details = [];
  const months = ctx.months || [];
  for (const mo of months) {
    const mRows = rows.filter((r) => !r.record_date || months.length === 1 || String(r.record_date).slice(0, 7) === mo.month);
    let work = 0; let standby = 0; let breakdown = 0;
    for (const r of mRows) {
      const m = dayMinutes(r, rate);
      work += m.work; standby += m.standby; breakdown += m.breakdown;
      if (m.status === 'Working' && m.work > 0) t.workedDays += 1;
    }
    const wd = Math.max(1, Number(mo.workingDays));
    const hourlyC = monthly / wd / hpd; // cents per hour, not rounded
    const baseC = roundCents(monthly * mo.assignedWorkingDays / wd);
    const requiredMin = Math.max(0, Math.round((mo.assignedWorkingDays - (mo.holidayDays || 0)) * hpd * 60));
    const billableMin = Math.round(work + standby * sbPct + breakdown * bdPct);
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
      work_hours: work / 60, standby_hours: standby / 60, breakdown_hours: breakdown / 60 });
  }
  return { totals: t, lines: lines.filter((l) => l.quantity !== 0 || l.line_type === 'MonthlyBase'), monthly_details: details };
}

function round4(x) { return Math.round(x * 10000) / 10000; }
function line(type, quantity, unit, unitPriceCents) {
  return { line_type: type, quantity: round4(quantity), unit, unit_price_cents: roundCents(unitPriceCents),
           amount_cents: roundCents(quantity * unitPriceCents) };
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
      res.lines.push({ line_type: 'Fuel', quantity: Number(f.liters), unit: 'L', unit_price_cents: toCents(f.price_per_liter),
                       amount_cents: -roundCents(Number(f.liters) * toCents(f.price_per_liter)) });
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

module.exports = { dayMinutes, billItem, billHourly, billDaily, billMonthly, minimumTopUp, otThresholdMin };
