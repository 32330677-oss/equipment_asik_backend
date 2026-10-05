# Billing Engine — Specification

**Hourly · Daily · Monthly — minimums, overtime, standby, breakdown, fuel**

Exact rules, reference implementation and worked examples that must pass as unit tests.

_Equipment Flow · Doc 04 · v2.0 standalone · 2026-10-03_

---

# 1. Principles

1. **Pure engine.** `services/equipment/equipmentBillingEngine.js` receives rows + a rate card + context and returns lines and totals. It never touches the database, so it is unit-tested in isolation and re-used by preview, generate, provisional statements and the "test this price" panel.
2. **Integers.** Durations in **minutes** (integers) and money in **cents** (integers). Conversion to DECIMAL only when writing to the database.
3. **Aggregate first, price once.** Minutes are summed per category over the item, then multiplied by the price once. This avoids rounding drift across 30 days.
4. **Rate on the record date.** Every row is priced with the rate card in force on its `record_date` (BR-32). One payroll item = machine × site × rate card.
5. **Explainable.** Every amount is a statement line with quantity × unit price, so the vendor can check it.

# 2. Per-row minutes (`dayMinutes`)

| Day status | work | standby | breakdown | break |
|---|---|---|---|---|
| Working | `gross − (break if policy = Deduct) − breakdown − standby` (≥ 0) | sum of Standby periods | sum of Breakdown periods | Break + Refuel periods |
| Standby (full day) | 0 | `gross` if times given, else `standard_hours_per_day × 60` | 0 | 0 |
| Breakdown (full day) | 0 | 0 | `gross` if times given, else `standard_hours_per_day × 60` | 0 |
| Absent / Holiday | 0 | 0 | 0 | 0 |

`gross = check_out − check_in` in minutes, stored on the row by `eqAttendanceService.recompute`.

# 3. Common options

- **Overtime threshold** `thr = overtime_threshold_hours ?? standard_hours_per_day` (minutes); if `overtime_enabled = 0` → no overtime (`thr = ∞`).
- **Overtime price** `overtime_rate` if set, else (hourly price or hourly equivalent) × `overtime_multiplier`.
- **Minimum guarantee** (only if `min_billable_hours_per_day` is set, only on Working and Standby days):
  `topup = max(0, min − (work + standby + breakdown))`. Breakdown hours are counted as "covered" so a breakdown — the vendor's fault — is never compensated by the minimum. Topped-up hours are paid at the normal hourly price.
- **Standby billable** `standby × standby_billable_pct / 100`; **breakdown billable** `breakdown × breakdown_billable_pct / 100`.
- **Operator** (if `operator_included = 0` and `operator_daily_rate` set): `worked_days × operator_daily_rate`, where a worked day = Working row with work > 0.
- **Fuel**: every non-cancelled fuel issue of the machine in the period is a negative line `liters × price_per_liter`, unless the rate card in force on the issue date has `fuel_policy = CompanySuppliesFree`.
- **Adjustments**: each active adjustment dated in the period is a signed line with its reason.

# 4. Billing modes

## 4.1 Hourly

Per row: `regular = min(work, thr)`, `ot = work − regular`.

| Line | Quantity | Unit price |
|---|---|---|
| Work | Σ regular / 60 h | `hourly_rate` |
| Overtime | Σ ot / 60 h | OT price |
| Standby | Σ standby × pct / 60 h | `hourly_rate` |
| Breakdown | Σ breakdown × pct / 60 h | `hourly_rate` |
| MinimumTopUp | Σ topup / 60 h | `hourly_rate` |

## 4.2 Daily

`std = standard_hours_per_day × 60`. Per row (with `topup` from the minimum):

- work fraction `wf` by `daily_partial_rule`: **ProRata** `min(1, (work + topup) / std)`; **FullDayIfWorked** `1` if work + topup > 0; **HalfDayThreshold** `1` if work + topup ≥ `half_day_threshold_hours`, else `0.5` (0 if no work).
- standby fraction `sf = min(1, standby / std) × standby_pct`; breakdown fraction `bf = min(1, breakdown / std) × breakdown_pct`.
- Cap: `wf + sf + bf ≤ 1` — reduce `sf` first, then `bf`.
- Overtime: `max(0, work − thr)` minutes at the OT price (default OT price = `daily_rate / standard_hours_per_day × multiplier`).

Lines: Work (Σwf days × `daily_rate`), Overtime (h), Standby (Σsf days), Breakdown (Σbf days).

## 4.3 Monthly

For each calendar month touched by the item: `base += monthly_rate × assigned_days / days_in_month`, where `assigned_days` = days of that month inside the billing period **and** inside the deployment **and** inside the rate card dates (built by `eqPayrollService`, passed as `ctx.months`).

- daily equivalent `de = monthly_rate / monthly_working_days`; hourly equivalent `he = de / standard_hours_per_day`.
- **AbsenceDeduction** = Absent days × `de` (negative).
- **BreakdownDeduction** = breakdown hours × `(1 − breakdown_pct)` × `he` (negative).
- Standby and Holiday days: no change (the month is already paid).
- **Overtime** = Σ max(0, work − thr) at the OT price (default `he × multiplier`).

Lines: MonthlyBase (quantity = fraction of month), AbsenceDeduction, BreakdownDeduction, Overtime.

# 5. Totals and rounding

- Each line: `amount_cents = Math.round(quantity × unit_price_cents)`; quantities kept to 4 decimals for display.
- `gross = Σ positive lines`, `deductions = Σ |negative lines|`, `net = gross − deductions`. A negative net is allowed (vendor owes us) and shown in red on the statement.
- Item → batch totals are sums of stored item values (never recomputed from floats).
- Display: hours 2 decimals; days up to 4 decimals trimmed (`2.625`); money 2 decimals with thousands separators; SYP shown without decimals.

# 6. Worked examples (must pass as unit tests)

All examples are executed by the reference implementation in §8 and the expected values below were produced by running it.

## Example A — Hourly excavator (USD)

Rate card: hourly 40.00, minimum 6 h/day, OT after 10 h at 50.00, standby 50 %, breakdown 0 %, breaks deducted, fuel policy VendorSupplies.

| Day | Record | work | standby | breakdown | Notes |
|---|---|---|---|---|---|
| 1 | 07:00–17:30, break 60 | 9.5 h | – | – | no OT, ≥ min |
| 2 | 06:00–19:00, break 60 | 12 h | – | – | 10 h regular + 2 h OT |
| 3 | 07:00–15:00, break 30, breakdown 10:00–13:00 | 4.5 h | – | 3 h | min covered by work + breakdown (7.5 h) |
| 4 | 07:00–12:00, standby 2 h | 3 h | 2 h | – | top-up 6 − 5 = 1 h |
| 5 | Standby full day | – | 8 h | – | billed 4 h |
| 6 | Breakdown full day | – | – | 8 h | 0 % |
| 7 | Absent | – | – | – | 0 |

Fuel issued by us: 100 L × 1.10. Adjustment: Mobilization +150.00.

| Line | Qty | Price | Amount |
|---|---|---|---|
| Work | 27 h | 40.00 | 1,080.00 |
| Overtime | 2 h | 50.00 | 100.00 |
| Standby | 5 h | 40.00 | 200.00 |
| MinimumTopUp | 1 h | 40.00 | 40.00 |
| Fuel | 100 L | 1.10 | −110.00 |
| Adjustment (Mobilization) | 1 | 150.00 | 150.00 |
| **Gross / Deductions / Net** | | | **1,570.00 / 110.00 / 1,460.00** |

## Example B — Daily loader (USD)

Rate card: daily 300.00, standard 8 h, ProRata, OT after 8 h at 45.00, standby 50 %, breakdown 0 %, operator not included (20.00 / worked day), fuel CompanySuppliesFree.

| Day | Record | Fractions |
|---|---|---|
| 1 | 9 h gross, break 1 h → 8 h | 1 day |
| 2 | 11 h gross, break 1 h → 10 h | 1 day + 2 h OT |
| 3 | 8 h gross, breakdown 3 h → 5 h | 0.625 day |
| 4 | Standby full day | 0.5 day standby |

| Line | Qty | Price | Amount |
|---|---|---|---|
| Work | 2.625 day | 300.00 | 787.50 |
| Overtime | 2 h | 45.00 | 90.00 |
| Standby | 0.5 day | 300.00 | 150.00 |
| Operator | 3 day | 20.00 | 60.00 |
| Fuel 50 L | — | free policy | 0 (no line) |
| **Net** | | | **1,087.50** |

## Example C — Monthly crane (USD), full October

Rate card: monthly 6,500.00, 26 working days, 8 h/day, OT after 8 h at 40.00, breakdown 0 % (fully deducted).
Rows: 1 Absent day; Working days with 9 h, 10 h, 11 h work (1 + 2 + 3 = 6 h OT); 1 full-day Breakdown (8 h); 1 Working day with 4 h breakdown.

| Line | Qty | Price | Amount |
|---|---|---|---|
| MonthlyBase | 1 month (31/31) | 6,500.00 | 6,500.00 |
| AbsenceDeduction | 1 day | −250.00 | −250.00 |
| BreakdownDeduction | 12 h | −31.25 | −375.00 |
| Overtime | 6 h | 40.00 | 240.00 |
| **Net** | | | **6,115.00** |

## Example D — Monthly crane, partial month

Same card, deployed 10–31 October (22 of 31 days), no events: base = 6,500 × 22 / 31 = **4,612.90**.

# 7. Edge cases (each needs a test)

1. Rate change on the 15th → two items for the same machine and site, each with its own lines.
2. Machine transferred from site 8 to site 9 mid-month (Monthly) → base split by assigned days per site.
3. Night shift 18:00 → 04:00 next day → 600 gross minutes on the record date of the check-in.
4. Break policy `Paid` → breaks are not deducted from work.
5. `overtime_enabled = 0` with 12 h work → all 12 h regular.
6. Daily `HalfDayThreshold` 4 h: 3 h work → 0.5 day; 4 h → 1 day.
7. Full-day Standby on a Daily card with standby 100 % → exactly 1 day.
8. Working day with 6 h work + 4 h standby on a Daily card with standby 100 % → `wf 0.75 + sf 0.5` capped to `sf 0.25`.
9. Fuel issue priced 0 → line amount 0 (kept for traceability).
10. Adjustment negative (Penalty −200) → deduction line.
11. Net negative → allowed, flagged `NEGATIVE_NET` warning in the batch response.
12. Holiday on Monthly → no deduction; on Hourly/Daily → nothing billed.
13. Minimum guarantee on a Standby full day with standard 8 h and min 10 h → top-up 2 h.
14. A row in a Superseded batch is eligible again for the new version; a row in a Voided batch is eligible again.
15. SYP contract: amounts are whole numbers on print, engine still in "cents".

# 8. Reference implementation

Copy as `services/equipment/equipmentBillingEngine.js`. It is the specification: if the prose above and this code ever disagree, raise it — do not silently change either.

```js
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
// ctx.months: [{ month:'2026-10', daysInMonth:31, assignedDays:31 }] for the
// part of the billing period covered by this item (one entry per calendar month).
function billMonthly(rows, rate, ctx) {
  const monthly = toCents(rate.monthly_rate);
  const dailyEquiv = monthly / Number(rate.monthly_working_days);
  const hourlyEquiv = dailyEquiv / Number(rate.standard_hours_per_day);
  const thr = otThresholdMin(rate);
  const t = { work: 0, ot: 0, standby: 0, breakdown: 0, absentDays: 0, workedDays: 0, baseCents: 0 };
  for (const mo of ctx.months) t.baseCents += roundCents(monthly * mo.assignedDays / mo.daysInMonth);
  for (const r of rows) {
    const m = dayMinutes(r, rate);
    t.work += m.work; t.ot += Math.max(0, m.work - thr);
    t.standby += m.standby; t.breakdown += m.breakdown;
    if (m.status === 'Absent') t.absentDays += 1;
    if (m.status === 'Working' && m.work > 0) t.workedDays += 1;
  }
  const keepPct = 1 - Number(rate.breakdown_billable_pct) / 100;
  const lines = [
    { line_type: 'MonthlyBase', quantity: round4(ctx.months.reduce((s, mo) => s + mo.assignedDays / mo.daysInMonth, 0)), unit: 'month', unit_price_cents: monthly, amount_cents: t.baseCents },
    line('AbsenceDeduction', t.absentDays, 'day', -dailyEquiv),
    line('BreakdownDeduction', (t.breakdown / 60) * keepPct, 'h', -hourlyEquiv),
    line('Overtime', t.ot / 60, 'h', otRateCents(rate, hourlyEquiv)),
  ];
  return { totals: t, lines: lines.filter((l) => l.quantity !== 0) };
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
  for (const a of extras.adjustments || []) {
    res.lines.push({ line_type: 'Adjustment', quantity: 1, unit: 'item', unit_price_cents: toCents(a.amount),
                     amount_cents: toCents(a.amount), note: `${a.type}: ${a.reason}` });
  }
  const gross = res.lines.filter((l) => l.amount_cents > 0).reduce((s, l) => s + l.amount_cents, 0);
  const deductions = -res.lines.filter((l) => l.amount_cents < 0).reduce((s, l) => s + l.amount_cents, 0);
  return { ...res, gross_cents: gross, deductions_cents: deductions, net_cents: gross - deductions };
}

module.exports = { dayMinutes, billItem, billHourly, billDaily, billMonthly, minimumTopUp };
```

# 9. Unit tests for the examples

Copy as `tests/equipment.billing.test.js` and convert the `assert` calls into `node:test` `test()` blocks (the project runs `node --test`). This file was executed while writing this document and prints `ALL EXAMPLES PASS`.

```js
const assert = require('assert');
const { billItem } = require('../services/equipment/equipmentBillingEngine');
const fmt = (c) => (c / 100).toFixed(2);

// ---------- Example A: Hourly excavator
const A = { billing_mode: 'Hourly', hourly_rate: 40, standard_hours_per_day: 8, min_billable_hours_per_day: 6,
  overtime_enabled: true, overtime_threshold_hours: 10, overtime_rate: 50, standby_billable_pct: 50,
  breakdown_billable_pct: 0, break_policy: 'Deduct', operator_included: true, fuel_policy: 'VendorSupplies' };
const rowsA = [
  { day_status: 'Working', gross_minutes: 630, break_minutes: 60 },                    // 07:00-17:30
  { day_status: 'Working', gross_minutes: 780, break_minutes: 60 },                    // 06:00-19:00
  { day_status: 'Working', gross_minutes: 480, break_minutes: 30, breakdown_minutes: 180 }, // 07:00-15:00
  { day_status: 'Working', gross_minutes: 300, break_minutes: 0, standby_minutes: 120 },   // 07:00-12:00
  { day_status: 'Standby' },
  { day_status: 'Breakdown' },
  { day_status: 'Absent' },
];
const ra = billItem(rowsA, A, {}, { fuel: [{ liters: 100, price_per_liter: 1.10 }],
  adjustments: [{ amount: 150, type: 'Mobilization', reason: 'Transport to site' }] });
console.log('A lines', ra.lines.map((l) => `${l.line_type} ${l.quantity}${l.unit} x ${fmt(l.unit_price_cents)} = ${fmt(l.amount_cents)}`));
console.log('A gross', fmt(ra.gross_cents), 'ded', fmt(ra.deductions_cents), 'net', fmt(ra.net_cents));
assert.strictEqual(ra.gross_cents - 15000, 142000);
assert.strictEqual(ra.net_cents, 146000);

// ---------- Example B: Daily loader
const B = { billing_mode: 'Daily', daily_rate: 300, standard_hours_per_day: 8, daily_partial_rule: 'ProRata',
  overtime_enabled: true, overtime_threshold_hours: null, overtime_rate: 45, standby_billable_pct: 50,
  breakdown_billable_pct: 0, break_policy: 'Deduct', operator_included: false, operator_daily_rate: 20,
  fuel_policy: 'CompanySuppliesFree' };
const rowsB = [
  { day_status: 'Working', gross_minutes: 540, break_minutes: 60 },                     // 8h
  { day_status: 'Working', gross_minutes: 660, break_minutes: 60 },                     // 10h
  { day_status: 'Working', gross_minutes: 480, break_minutes: 0, breakdown_minutes: 180 }, // 5h work
  { day_status: 'Standby' },
];
const rb = billItem(rowsB, B, {}, { fuel: [{ liters: 50, price_per_liter: 1.1 }] });
console.log('B lines', rb.lines.map((l) => `${l.line_type} ${l.quantity}${l.unit} x ${fmt(l.unit_price_cents)} = ${fmt(l.amount_cents)}`));
console.log('B net', fmt(rb.net_cents));
assert.strictEqual(rb.net_cents, 102750 + 6000);

// ---------- Example C: Monthly crane, full month
const C = { billing_mode: 'Monthly', monthly_rate: 6500, monthly_working_days: 26, standard_hours_per_day: 8,
  overtime_enabled: true, overtime_threshold_hours: 8, overtime_rate: 40, standby_billable_pct: 100,
  breakdown_billable_pct: 0, break_policy: 'Deduct', operator_included: true, fuel_policy: 'VendorSupplies' };
const rowsC = [
  { day_status: 'Absent' },
  { day_status: 'Working', gross_minutes: 600, break_minutes: 60, breakdown_minutes: 0 },   // 9h -> 1h OT
  { day_status: 'Working', gross_minutes: 660, break_minutes: 60 },                         // 10h -> 2h OT
  { day_status: 'Working', gross_minutes: 720, break_minutes: 60 },                         // 11h -> 3h OT
  { day_status: 'Breakdown', gross_minutes: 480 },                                          // 8h
  { day_status: 'Working', gross_minutes: 540, break_minutes: 60, breakdown_minutes: 240 }, // 4h breakdown
];
const rc = billItem(rowsC, C, { months: [{ month: '2026-10', daysInMonth: 31, assignedDays: 31 }] });
console.log('C lines', rc.lines.map((l) => `${l.line_type} ${l.quantity}${l.unit} x ${fmt(l.unit_price_cents)} = ${fmt(l.amount_cents)}`));
console.log('C net', fmt(rc.net_cents));
assert.strictEqual(rc.net_cents, 611500);

const rc2 = billItem([], C, { months: [{ month: '2026-10', daysInMonth: 31, assignedDays: 22 }] });
console.log('C2 partial month net', fmt(rc2.net_cents));
assert.strictEqual(rc2.net_cents, 461290);
console.log('ALL EXAMPLES PASS');
```

# 10. Where the engine is called

| Caller | Purpose | Writes? |
|---|---|---|
| `POST /rate-cards/preview` | "Test this price" panel with sample days | no |
| `POST /payroll/preview` | Full period preview | no |
| `GET /statements/...pdf` | Provisional statement | no |
| `POST /payroll/generate` / `supersede` | Saved batch | yes (batch, items, lines, snapshot) |
