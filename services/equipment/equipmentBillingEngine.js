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

// A monthly machine, month by month (rules of 12 Oct 2026 — every day on its own, the Admin decides the offset):
//   amount A     = the monthly price of the card, or the amount typed for this machine and month (exception)
//   divisor D    = the working days of the calendar month (calendar days minus the weekly day off, Friday by
//                  default), or the number typed for this machine and month (exception)
//   hourly price H = typed for this machine and month, else A / D / hours per day. H prices the deductions, the
//                  offset and the overtime; it never changes the base.
//   base days    = min(deployed working days, D); base = A x base days / D
//   each deployed working day (not an official holiday) is DUE hours per day (10 h), and on its own:
//     - no Working / Standby / Breakdown row (Absent, or nothing recorded)  -> ABSENCE: the whole day is missing
//     - breakdown (vendor fault): its unpaid part (breakdown x (100% - breakdown%)) -> BREAKDOWN deduction, the
//       rest of the day is still due. A breakdown is never covered by extra hours.
//     - done = work + standby hours GIVEN by the Admin/Accountant + breakdown x breakdown%
//       done < due -> MISSING hours of that day; done > due -> EXTRA hours
//   weekly day off / official holiday / any day not due: everything done is EXTRA hours
//   deployed days above D (only when a smaller D is typed) are not paid as base: they first cover missing days,
//   what is left of them is extra hours.
// Missing hours (absence + short days) are deducted x H. Extra hours are NEVER used automatically:
//   - the Admin decides per machine and month (ctx.offset) whether extra hours cover missing hours (each hour
//     covers one missing hour, paid back x H: line ExtraHoursOffset);
//   - extra hours not used for that: overtime when the card pays it (x overtime price, or H), else kept unpaid and
//     still available to cover missing hours in a later invoice of the SAME month.
//   An hour is either an offset or overtime, never both.
// Several invoices in one month: base and deductions are F(month so far) - F(already billed); the extra hours are
// a ledger: ctx.prev.used[month] = { offset_minutes, overtime_minutes } already given by earlier invoices.
// ctx.months: [{ month, workingDays, assignedWorkingDays, holidayDays, workingDates, divisor?, divisorSource?,
//                amountCents?, amountSource?, hourlyCents?, hourlySource? }]
// ctx.offset: true (every month) | { 'YYYY-MM': true } | falsy
// A rate without overtime_enabled at all (old callers) keeps the old rule: overtime paid.
function monthlyOvertimePaid(rate) {
  return !(rate.overtime_enabled === false || rate.overtime_enabled === 0 || rate.overtime_enabled === '0');
}

const PRESENT = ['Working', 'Standby', 'Breakdown'];
const dateKey = (r, i) => (r.record_date ? String(r.record_date).slice(0, 10) : `#${i}`);

/** Terms of one month: amount, divisor, hourly price (cents, not rounded), base days. */
function monthTermsOf(mo, rate) {
  const hpd = Number(rate.standard_hours_per_day);
  const D = Math.max(1, Number(mo.divisor ?? mo.workingDays ?? 1));
  const amountTyped = mo.amountCents !== null && mo.amountCents !== undefined && Number(mo.amountCents) > 0;
  const amountC = amountTyped ? Number(mo.amountCents) : toCents(rate.monthly_rate);
  const manualH = mo.hourlyCents !== null && mo.hourlyCents !== undefined && Number(mo.hourlyCents) > 0;
  const hourlyC = manualH ? Number(mo.hourlyCents) : amountC / D / hpd;
  const baseDays = Math.min(Number(mo.assignedWorkingDays || 0), D);
  return { hpd, D, amountC, amountTyped, hourlyC, manualH, baseDays };
}

/**
 * Hours of one month, day by day (no money). rows = every row of the machine in the month that counts.
 * Without mo.workingDates (hand-made contexts of older callers), the dates of the rows are the working days and
 * the deployed days without any row are counted as absent.
 */
function monthHours(rows, rate, mo) {
  const { hpd, baseDays } = monthTermsOf(mo, rate);
  const dayMin = Math.round(hpd * 60);
  const bdPct = Number(rate.breakdown_billable_pct || 0) / 100;
  const mRows = rows.filter((r) => !r.record_date || String(r.record_date).slice(0, 7) === mo.month);
  const byDate = new Map();
  mRows.forEach((r, i) => {
    const k = dateKey(r, i);
    if (!byDate.has(k)) byDate.set(k, []);
    byDate.get(k).push(r);
  });
  const legacy = !Array.isArray(mo.workingDates);
  const working = new Set(legacy
    ? [...byDate.entries()].filter(([, list]) => !list.every((r) => r.day_status === 'Holiday')).map(([k]) => k)
    : mo.workingDates);
  const h = { dayMin, work: 0, standby: 0, breakdown: 0, credit: 0, done: 0, workedDays: 0,
    bdMin: 0, absenceMin: 0, absentDays: 0, shortMin: 0, extraMin: 0, freeUsedMin: 0, days: [] };
  const dates = [...new Set([...working, ...byDate.keys()])].sort();
  for (const d of dates) {
    const list = byDate.get(d) || [];
    let done = 0; let bdRaw = 0;
    for (const r of list) {
      const m = dayMinutes(r, rate);
      const credit = standbyCredit(r, dayMin);
      h.work += m.work; h.standby += m.standby; h.breakdown += m.breakdown; h.credit += credit;
      if (m.status === 'Working' && m.work > 0) h.workedDays += 1;
      done += m.work + credit + m.breakdown * bdPct;
      bdRaw += m.breakdown;
    }
    h.done += done;
    const show = d.startsWith('#') ? null : d;
    if (!working.has(d)) {
      if (done > 0) { h.extraMin += done; h.days.push({ date: show, kind: 'off', done: done / 60, extra: done / 60 }); }
      continue;
    }
    if (!list.some((r) => PRESENT.includes(r.day_status))) {
      h.absenceMin += dayMin; h.absentDays += 1;
      h.days.push({ date: show, kind: 'absent', due: hpd, done: 0, missing: hpd });
      continue;
    }
    const bdDed = Math.min(dayMin, bdRaw * (1 - bdPct));
    const due = dayMin - bdDed;
    h.bdMin += bdDed;
    const short = Math.max(0, due - done); const extra = Math.max(0, done - due);
    h.shortMin += short; h.extraMin += extra;
    if (bdDed > 0 || short > 0 || extra > 0) {
      h.days.push({ date: show, kind: bdDed > 0 ? 'breakdown' : short > 0 ? 'short' : 'extra', due: due / 60, done: done / 60,
        ...(bdDed > 0 ? { breakdown_deducted: bdDed / 60 } : {}), ...(short > 0 ? { missing: short / 60 } : {}), ...(extra > 0 ? { extra: extra / 60 } : {}) });
    }
  }
  // older callers: deployed working days (not holidays) that have no row at all are absences
  if (legacy) {
    const unknown = Math.max(0, Number(mo.assignedWorkingDays || 0) - Number(mo.holidayDays || 0) - working.size);
    h.absenceMin += unknown * dayMin; h.absentDays += unknown;
  }
  // deployed working days above D are not paid as base: they cover missing days first, the rest is extra hours
  let free = Math.max(0, Number(mo.assignedWorkingDays || 0) - baseDays) * dayMin;
  const a = Math.min(free, h.absenceMin); h.absenceMin -= a; free -= a; h.absentDays = Math.max(0, h.absentDays - Math.round(a / dayMin));
  const s = Math.min(free, h.shortMin); h.shortMin -= s; free -= s;
  h.freeUsedMin = a + s;
  h.extraMin += free;
  h.requiredMin = Math.max(0, Math.round((baseDays - (mo.holidayDays || 0)) * dayMin));
  for (const k of ['bdMin', 'absenceMin', 'shortMin', 'extraMin', 'done']) h[k] = Math.round(h[k]);
  return h;
}

const EMPTY_HOURS = { work: 0, standby: 0, breakdown: 0, credit: 0, done: 0, workedDays: 0, bdMin: 0, absenceMin: 0, absentDays: 0, shortMin: 0, extraMin: 0, requiredMin: 0, days: [] };

function offsetWanted(ctx, month) {
  const o = ctx.offset;
  if (o === true) return true;
  if (!o || typeof o !== 'object') return false;
  return Array.isArray(o) ? o.includes(month) : Boolean(o[month]);
}

/**
 * Bills the months of ctx.months. With ctx.prev ({ rows, months, used }), only the part not billed before: base and
 * deductions as a difference, extra hours through the ledger of what earlier invoices already used.
 */
function billMonthly(rows, rate, ctx) {
  const otPaid = monthlyOvertimePaid(rate);
  const prev = ctx.prev || null;
  const prevRows = prev ? prev.rows || [] : [];
  const t = { work: 0, ot: 0, standby: 0, breakdown: 0, workedDays: 0, baseCents: 0, shortMinutes: 0, requiredMinutes: 0, billableMinutes: 0, unpaidExtraMinutes: 0, offsetMinutes: 0 };
  for (const r of rows) {
    const m = dayMinutes(r, rate);
    t.work += m.work; t.standby += m.standby; t.breakdown += m.breakdown;
    if (m.status === 'Working' && m.work > 0) t.workedDays += 1;
  }
  const lines = [];
  const details = [];
  for (const mo of ctx.months || []) {
    const T = monthTermsOf(mo, rate);
    const H = T.hourlyC;
    const A = monthHours([...prevRows, ...rows], rate, mo);
    const pmo = prev ? (prev.months || []).find((x) => x.month === mo.month) : null;
    const B = prev && pmo ? monthHours(prevRows, rate, pmo) : EMPTY_HOURS;
    const TB = pmo ? monthTermsOf(pmo, rate) : { baseDays: 0 };
    const baseA = Math.round(T.amountC * T.baseDays / T.D);
    const baseB = pmo ? Math.round(T.amountC * TB.baseDays / T.D) : 0;
    const label = `${mo.month}: ${mo.assignedWorkingDays} deployed working days, divided by ${T.D} (${mo.divisorSource || 'calendar'}), ${T.baseDays} paid as base`
      + `${T.amountTyped ? `, amount ${(T.amountC / 100).toFixed(2)} (typed)` : ''}${T.manualH ? `, hourly price ${(H / 100).toFixed(2)} (typed)` : ''}`;
    const baseQty = round4((T.baseDays - (pmo ? TB.baseDays : 0)) / T.D);
    if (!pmo || baseA !== baseB || baseQty !== 0) {
      lines.push({ line_type: 'MonthlyBase', quantity: baseQty, unit: 'month', unit_price_cents: T.amountC, amount_cents: baseA - baseB, note: label, month: mo.month });
    }
    const ded = (type, minA, minB, note) => {
      const min = minA - minB;
      if (min === 0) return;
      lines.push({ line_type: type, quantity: round4(min / 60), unit: 'h', unit_price_cents: -roundCents(H), unit_price_exact: -Math.round(H * 10) / 1000,
        amount_cents: -roundCents((minA / 60) * H) + roundCents((minB / 60) * H), note, month: mo.month });
    };
    const dl = (kind) => A.days.filter((x) => x.kind === kind && x.date).map((x) => `${x.date.slice(8, 10)}/${x.date.slice(5, 7)}`).join(', ');
    ded('BreakdownDeduction', A.bdMin, B.bdMin, `${mo.month}: breakdown (vendor fault) not paid${Number(rate.breakdown_billable_pct) > 0 ? ` (${n2(rate.breakdown_billable_pct)}% paid)` : ''}${dl('breakdown') ? ` - ${dl('breakdown')}` : ''}`);
    ded('AbsenceDeduction', A.absenceMin, B.absenceMin, `${mo.month}: ${A.absentDays - B.absentDays} deployed day(s) absent or not recorded${dl('absent') ? ` (${dl('absent')})` : ''}`);
    ded('HoursShortfall', A.shortMin, B.shortMin, `${mo.month}: days below the ${n2(T.hpd)} h due${dl('short') ? ` (${dl('short')})` : ''}`);
    // extra hours: what earlier invoices of this month already used (offset or overtime), then the decision
    const used = prev && prev.used && prev.used[mo.month]
      ? { off: Number(prev.used[mo.month].offset_minutes || 0), ot: Number(prev.used[mo.month].overtime_minutes || 0) }
      : { off: 0, ot: prev && otPaid ? B.extraMin : 0 };
    const missingAll = A.absenceMin + A.shortMin;
    const available = A.extraMin - used.off - used.ot;
    const wanted = offsetWanted(ctx, mo.month);
    const possible = Math.max(0, Math.min(available, missingAll - used.off));
    let off = 0; let ot = 0; let stored = 0;
    if (available >= 0) {
      off = wanted ? possible : 0;
      if (otPaid) ot = available - off; else stored = available - off;
    } else if (otPaid) {
      ot = available; // rows of an earlier invoice changed: overtime already paid is settled back
    } else {
      off = Math.max(available, -used.off);
    }
    const otC = rate.overtime_rate !== null && rate.overtime_rate !== undefined ? toCents(rate.overtime_rate) : H;
    if (off !== 0) {
      lines.push({ line_type: 'ExtraHoursOffset', quantity: round4(off / 60), unit: 'h', unit_price_cents: roundCents(H), unit_price_exact: Math.round(H * 10) / 1000,
        amount_cents: roundCents((off / 60) * H), note: `${mo.month}: extra hours used to cover missing hours (decided by the Admin)`, month: mo.month });
    }
    if (ot !== 0) {
      lines.push({ line_type: 'Overtime', quantity: round4(ot / 60), unit: 'h', unit_price_cents: roundCents(otC), unit_price_exact: Math.round(otC * 10) / 1000,
        amount_cents: roundCents((ot / 60) * otC), note: `${mo.month}: extra hours paid as overtime`, month: mo.month });
    }
    t.ot += ot; t.offsetMinutes += off; t.unpaidExtraMinutes += stored; t.baseCents += baseA - baseB;
    t.shortMinutes += (A.absenceMin + A.shortMin) - (B.absenceMin + B.shortMin);
    t.requiredMinutes += A.requiredMin - B.requiredMin; t.billableMinutes += A.done - B.done;
    details.push({
      month: mo.month, working_days: Number(mo.workingDays), deployed_working_days: mo.assignedWorkingDays, holiday_days: mo.holidayDays || 0,
      divisor: T.D, divisor_source: mo.divisorSource || 'calendar', amount: T.amountC / 100, amount_source: T.amountTyped ? 'manual' : 'card',
      hourly_source: T.manualH ? 'manual' : 'auto', base_days: T.baseDays, hours_per_day: T.hpd,
      hourly_price: Math.round(H * 10) / 1000, daily_price: Math.round(H * T.hpd) / 100,
      required_hours: A.requiredMin / 60, billable_hours: A.done / 60,
      work_hours: A.work / 60, standby_hours: A.standby / 60, standby_paid_hours: A.credit / 60, breakdown_hours: A.breakdown / 60,
      // this invoice (a difference when the month was partly billed before)
      breakdown_deducted_hours: (A.bdMin - B.bdMin) / 60, absent_days: A.absentDays - B.absentDays, absence_deducted_hours: (A.absenceMin - B.absenceMin) / 60,
      missing_hours: (A.shortMin - B.shortMin) / 60,
      // the month so far: extra and missing hours, and how the extra hours are used
      month_missing_hours: missingAll / 60, month_extra_hours: A.extraMin / 60,
      offset_used: wanted, offset_hours: off / 60, offset_possible_hours: possible / 60, offset_minutes: off,
      overtime_paid: otPaid, overtime_hours: ot / 60, overtime_minutes: ot, overtime_price: otPaid ? Math.round(otC * 10) / 1000 : null,
      unpaid_extra_hours: stored / 60,
      used_before: prev ? { offset_hours: used.off / 60, overtime_hours: used.ot / 60 } : null,
      part: Boolean(pmo),
      billed_before: pmo ? { base_days: TB.baseDays, deployed_working_days: pmo.assignedWorkingDays, required_hours: B.requiredMin / 60, billable_hours: B.done / 60 } : null,
      days: A.days,
    });
  }
  return { totals: t, lines: lines.filter((l) => l.quantity !== 0 || l.amount_cents !== 0 || l.line_type === 'MonthlyBase'), monthly_details: details };
}

/** Kept for older callers: a part of a month is billed by billMonthly with ctx.prev. */
const billMonthlySplit = billMonthly;

const n2 = (v) => Math.round(Number(v) * 100) / 100;

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