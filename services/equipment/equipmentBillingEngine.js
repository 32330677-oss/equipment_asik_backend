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

// A monthly machine owes a number of hours per month (terms of 11 Oct 2026):
//   D (divisor)  = per month: typed for this machine and month (eq_monthly_terms), else the card: the working days of
//                  the calendar month (calendar days minus the weekly day off, Friday by default) or a fixed number (26)
//   hourly price H = typed for this machine and month, else monthly price / D / hours per day (standard_hours_per_day)
//   base days    = min(deployed working days, D); base = H x hours per day x base days (= monthly x base days / D)
//   required hours = (base days - official holidays recorded) x hours per day
//   billable hours = work + standby hours GIVEN by the Admin/Accountant per row (standby_credit_minutes, max hours per day)
//                    + breakdown x breakdown%   (breaks deducted per break_policy). No standby % for monthly machines.
// Breakdown (vendor fault): its unpaid part (breakdown x (100% - breakdown%)) is deducted on its own line
//                         (BreakdownDeduction = hours x H) and taken out of the hours due, so extra hours worked on
//                         other days NEVER make up for it. Stoppages caused by the company are recorded as Standby.
// Absence: a deployed working day (not an official holiday) with no Working / Standby / Breakdown row — Absent or not
//                         recorded at all — is deducted in full (AbsenceDeduction = hours per day x H) and taken out of
//                         the hours due: extra hours on other days NEVER make up for it. Needs ctx month.workingDates
//                         (old snapshots without it keep the old rule).
// Billable >  required -> overtime ONLY when the card has overtime_enabled: extra hours x overtime_rate (or H when empty).
//                         Overtime off: the extra hours are not paid (shown as unpaid_extra_hours).
// Billable <  required -> base - missing hours x H.
// ctx.months: [{ month:'2026-10', workingDays:26, assignedWorkingDays:26, holidayDays:0, daysInMonth, assignedDays,
//                divisor?, divisorSource?: 'calendar'|'card'|'manual', hourlyCents?, hourlySource?: 'auto'|'manual' }]
// A rate without overtime_enabled at all (old callers) keeps the old rule: overtime paid.
function monthlyOvertimePaid(rate) {
  return !(rate.overtime_enabled === false || rate.overtime_enabled === 0 || rate.overtime_enabled === '0');
}

function billMonthly(rows, rate, ctx) {
  const monthly = toCents(rate.monthly_rate);
  const hpd = Number(rate.standard_hours_per_day);
  const maxCredit = Math.round(hpd * 60);
  const bdPct = Number(rate.breakdown_billable_pct) / 100;
  const otPaid = monthlyOvertimePaid(rate);
  const t = { work: 0, ot: 0, standby: 0, breakdown: 0, workedDays: 0, baseCents: 0, shortMinutes: 0, requiredMinutes: 0, billableMinutes: 0, unpaidExtraMinutes: 0 };
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
    const D = Math.max(1, Number(mo.divisor ?? wd));
    const divisorSource = mo.divisorSource || 'calendar';
    const manualH = mo.hourlyCents !== null && mo.hourlyCents !== undefined && Number(mo.hourlyCents) > 0;
    const hourlyC = manualH ? Number(mo.hourlyCents) : monthly / D / hpd; // cents per hour, not rounded
    const baseDays = Math.min(Number(mo.assignedWorkingDays), D);
    const baseC = manualH ? roundCents(hourlyC * hpd * baseDays) : roundCents(monthly * baseDays / D);
    const requiredMin = Math.max(0, Math.round((baseDays - (mo.holidayDays || 0)) * hpd * 60));
    const billableMin = Math.round(work + credit + breakdown * bdPct);
    // vendor-fault breakdown: deducted directly, never covered by extra hours (never more than the hours due)
    const bdDeductMin = Math.min(requiredMin, Math.round(breakdown * (1 - bdPct)));
    // deployed working days with no presence at all (Absent, or no row): deducted in full, never covered by extra hours
    const present = new Set(mRows.filter((r) => ['Working', 'Standby', 'Breakdown'].includes(r.day_status)).map((r) => String(r.record_date).slice(0, 10)));
    const absentDates = Array.isArray(mo.workingDates) ? mo.workingDates.filter((d) => !present.has(d)) : [];
    // deployed days above the divisor are not paid as base: their absences cost nothing
    const absentDays = Math.max(0, absentDates.length - Math.max(0, Number(mo.assignedWorkingDays) - baseDays));
    const absentMin = Math.min(requiredMin - bdDeductMin, Math.round(absentDays * hpd * 60));
    const dueMin = requiredMin - bdDeductMin - absentMin; // hours due from the days the machine was there and not broken down
    const label = `${mo.month}: ${mo.assignedWorkingDays} deployed working days, divisor ${D} (${divisorSource}), ${baseDays} paid as base`
      + `${manualH ? `, hourly price ${(hourlyC / 100).toFixed(2)} (manual)` : ''}`;
    lines.push({ line_type: 'MonthlyBase', quantity: round4(baseDays / D), unit: 'month', unit_price_cents: manualH ? roundCents(hourlyC * hpd * D) : monthly,
      amount_cents: baseC, note: label, month: mo.month });
    if (bdDeductMin > 0) {
      lines.push({ line_type: 'BreakdownDeduction', quantity: round4(bdDeductMin / 60), unit: 'h', unit_price_cents: -roundCents(hourlyC), unit_price_exact: -Math.round(hourlyC * 10) / 1000,
        amount_cents: -roundCents((bdDeductMin / 60) * hourlyC), note: `${mo.month}: breakdown (vendor fault) not paid${bdPct > 0 ? ` (${Math.round(bdPct * 10000) / 100}% paid)` : ''}`, month: mo.month });
    }
    if (absentMin > 0) {
      lines.push({ line_type: 'AbsenceDeduction', quantity: round4(absentMin / 60), unit: 'h', unit_price_cents: -roundCents(hourlyC), unit_price_exact: -Math.round(hourlyC * 10) / 1000,
        amount_cents: -roundCents((absentMin / 60) * hourlyC), note: `${mo.month}: ${absentDays} deployed day(s) absent or not recorded (${absentDates.map((d) => d.slice(8, 10) + '/' + d.slice(5, 7)).join(', ')})`, month: mo.month });
    }
    let otMin = 0; let shortMin = 0; let unpaidMin = 0;
    const done = `${mo.month}: ${(billableMin / 60).toFixed(2)} h done, ${(dueMin / 60).toFixed(2)} h due after breakdown and absence`;
    if (billableMin > dueMin) {
      if (otPaid) {
        otMin = billableMin - dueMin;
        const otC = rate.overtime_rate !== null && rate.overtime_rate !== undefined ? toCents(rate.overtime_rate) : hourlyC;
        lines.push({ line_type: 'Overtime', quantity: round4(otMin / 60), unit: 'h', unit_price_cents: roundCents(otC), unit_price_exact: Math.round(otC * 10) / 1000,
          amount_cents: roundCents((otMin / 60) * otC), note: done, month: mo.month });
      } else {
        unpaidMin = billableMin - dueMin;
      }
    } else if (billableMin < dueMin) {
      shortMin = dueMin - billableMin;
      lines.push({ line_type: 'HoursShortfall', quantity: round4(shortMin / 60), unit: 'h', unit_price_cents: -roundCents(hourlyC), unit_price_exact: -Math.round(hourlyC * 10) / 1000,
        amount_cents: -roundCents((shortMin / 60) * hourlyC), note: done, month: mo.month });
    }
    t.work += work; t.standby += standby; t.breakdown += breakdown; t.ot += otMin; t.baseCents += baseC; t.unpaidExtraMinutes += unpaidMin;
    t.shortMinutes += shortMin; t.requiredMinutes += requiredMin; t.billableMinutes += billableMin;
    details.push({ month: mo.month, working_days: wd, deployed_working_days: mo.assignedWorkingDays, holiday_days: mo.holidayDays || 0,
      divisor: D, divisor_source: divisorSource, hourly_source: manualH ? 'manual' : 'auto', base_days: baseDays,
      hours_per_day: hpd, hourly_price: Math.round(hourlyC * 10) / 1000, daily_price: Math.round(hourlyC * hpd) / 100,
      required_hours: requiredMin / 60, billable_hours: billableMin / 60, overtime_hours: otMin / 60, missing_hours: shortMin / 60,
      overtime_paid: otPaid, unpaid_extra_hours: unpaidMin / 60,
      overtime_price: otPaid ? Math.round((rate.overtime_rate !== null && rate.overtime_rate !== undefined ? toCents(rate.overtime_rate) : hourlyC) * 10) / 1000 : null,
      work_hours: work / 60, standby_hours: standby / 60, standby_paid_hours: credit / 60, breakdown_hours: breakdown / 60,
      breakdown_deducted_hours: bdDeductMin / 60, absent_days: absentDays, absence_deducted_hours: absentMin / 60 });
  }
  return { totals: t, lines: lines.filter((l) => l.quantity !== 0 || l.line_type === 'MonthlyBase'), monthly_details: details };
}

/**
 * Part of a month already partly billed by other batches (11 Oct 2026: each monthly day is billed once).
 *   amount(this part) = F(previous days + these days, previous rows + these rows) - F(previous days, previous rows)
 * line by line (MonthlyBase, Overtime, HoursShortfall) and month by month, so the parts always add up to the whole
 * month — also with a typed overtime price or overtime off. A part may carry a negative overtime or a positive
 * shortfall line: the settlement of the month's hours.
 * ctx: { months: <months of all the days>, prev: { rows: [...], months: [...] } }  (rows = the rows of this part only)
 */
function billMonthlySplit(rows, rate, ctx) {
  const prev = ctx.prev || {};
  const prevRows = prev.rows || [];
  const all = billMonthly([...prevRows, ...rows], rate, { months: ctx.months || [] });
  const before = billMonthly(prevRows, rate, { months: prev.months || [] });
  const t = { work: 0, ot: 0, standby: 0, breakdown: 0, workedDays: 0, baseCents: 0, shortMinutes: 0, requiredMinutes: 0, billableMinutes: 0, unpaidExtraMinutes: 0 };
  for (const r of rows) {
    const m = dayMinutes(r, rate);
    t.work += m.work; t.standby += m.standby; t.breakdown += m.breakdown;
    if (m.status === 'Working' && m.work > 0) t.workedDays += 1;
  }
  const sum = (res, type, month, k) => res.lines.filter((l) => l.line_type === type && l.month === month).reduce((a, l) => a + l[k], 0);
  const lines = [];
  const details = [];
  for (const mo of ctx.months || []) {
    const b = before.monthly_details.find((x) => x.month === mo.month) || null;
    const a = all.monthly_details.find((x) => x.month === mo.month);
    for (const type of ['MonthlyBase', 'BreakdownDeduction', 'AbsenceDeduction', 'Overtime', 'HoursShortfall']) {
      const amount = sum(all, type, mo.month, 'amount_cents') - sum(before, type, mo.month, 'amount_cents');
      const qty = round4(sum(all, type, mo.month, 'quantity') - sum(before, type, mo.month, 'quantity'));
      if (amount === 0 && qty === 0 && type !== 'MonthlyBase') continue;
      if (amount === 0 && qty === 0 && b && a.base_days === b.base_days) continue; // no new base day
      const ref = all.lines.find((l) => l.line_type === type && l.month === mo.month) || before.lines.find((l) => l.line_type === type && l.month === mo.month) || {};
      lines.push({ line_type: type, quantity: qty, unit: type === 'MonthlyBase' ? 'month' : 'h', unit_price_cents: ref.unit_price_cents || 0,
        ...(ref.unit_price_exact !== undefined ? { unit_price_exact: ref.unit_price_exact } : {}), amount_cents: amount, month: mo.month,
        note: b ? `${mo.month}: month settlement — whole month ${a.base_days} base day(s), ${a.billable_hours.toFixed(2)} h done / ${a.required_hours.toFixed(2)} h due; `
          + `already billed ${b.base_days} base day(s), ${b.billable_hours.toFixed(2)} h / ${b.required_hours.toFixed(2)} h` : (ref.note || '') });
    }
    const d = (k) => Math.round(((a[k] || 0) - (b ? b[k] || 0 : 0)) * 10000) / 10000;
    t.ot += Math.round(d('overtime_hours') * 60); t.shortMinutes += Math.round(d('missing_hours') * 60); t.unpaidExtraMinutes += Math.round(d('unpaid_extra_hours') * 60);
    t.requiredMinutes += Math.round(d('required_hours') * 60); t.billableMinutes += Math.round(d('billable_hours') * 60);
    details.push({ ...a, part: Boolean(b), overtime_hours: d('overtime_hours'), missing_hours: d('missing_hours'), unpaid_extra_hours: d('unpaid_extra_hours'),
      breakdown_deducted_hours: d('breakdown_deducted_hours'), absent_days: d('absent_days'), absence_deducted_hours: d('absence_deducted_hours'),
      billed_before: b ? { base_days: b.base_days, deployed_working_days: b.deployed_working_days, required_hours: b.required_hours, billable_hours: b.billable_hours } : null });
  }
  t.baseCents = lines.filter((l) => l.line_type === 'MonthlyBase').reduce((x, l) => x + l.amount_cents, 0);
  return { totals: t, lines, monthly_details: details };
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
  else if (rate.billing_mode === 'Monthly') res = ctx.prev ? billMonthlySplit(rows, rate, ctx) : billMonthly(rows, rate, ctx);
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
  monthlyOvertimePaid, billMonthlySplit, standbyCredit, exactCents, dayMinutes, billItem, billHourly, billDaily, billMonthly, minimumTopUp, otThresholdMin,
  allowOf, planDay, planDays, dayPlans, plansFor, shiftOrder, blockAllowances,
};