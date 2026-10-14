// services/equipment/eqDocFigures.js — figures shared by every invoice PDF and Excel (14 Oct 2026):
//   - regular hours and overtime shown apart, each with its own price and amount, then the other lines and the totals;
//   - a monthly base shown as "days x price of one day" (quantity x price = amount on paper);
//   - the titles of the people who sign (from the settings, one place for every document).
'use strict';

const settings = require('../settings');

const n = (v) => Number(v || 0);
const r2 = (x) => Math.round(x * 100) / 100;

/** Lines that pay the normal time of the machine (hours or days of work, the monthly base). */
const REGULAR_LINES = ['Work', 'MonthlyBase'];
/** Lines kept apart in the vendor summaries (they have their own columns / statements). */
const SPECIAL_LINES = ['Fuel', 'Adjustment', 'FuelPriceDifference'];

/**
 * Hours of one item: regular (not overtime), overtime and their total. work_hours already holds every worked hour
 * (overtime included), so regular = work - overtime. A negative overtime (paid before and settled back) is not
 * taken off the regular hours.
 */
function hoursSplit(it) {
  const total = n(it.work_hours);
  const overtime = n(it.overtime_hours);
  return { regular: r2(Math.max(0, total - Math.max(0, overtime))), overtime: r2(overtime), total: r2(total) };
}

/** Regular / overtime minutes of one attendance row (work_minutes holds both). */
function rowMinutes(r) {
  const work = n(r.work_minutes); const ot = Math.max(0, n(r.overtime_minutes));
  return { regular: Math.max(0, work - ot), overtime: ot, total: work };
}

/**
 * Money of one item by kind of line. regular + overtime + otherAdd + otherDed + fuel + adjustments + fuelDiff = net.
 * otherAdd: standby, breakdown, top-up, second shift, operator, extra hours covering missing hours...
 * otherDed (<= 0): absence, breakdown and shortfall deductions...
 */
function amountSplit(lines) {
  const out = { regular: 0, overtime: 0, otherAdd: 0, otherDed: 0, fuel: 0, adjustments: 0, fuelDiff: 0 };
  for (const l of lines || []) {
    const a = n(l.amount);
    if (REGULAR_LINES.includes(l.line_type)) out.regular += a;
    else if (l.line_type === 'Overtime') out.overtime += a;
    else if (l.line_type === 'Fuel') out.fuel += a;
    else if (l.line_type === 'Adjustment') out.adjustments += a;
    else if (l.line_type === 'FuelPriceDifference') out.fuelDiff += a;
    else if (a > 0) out.otherAdd += a;
    else out.otherDed += a;
  }
  for (const k of Object.keys(out)) out[k] = r2(out[k]);
  return out;
}

/** Monthly calculation of an item, wherever the model keeps it (batch snapshot or provisional calculation). */
function monthlyCalcOf(it) {
  return (it.rate && it.rate.monthly_calc) || (it.rate_snapshot && it.rate_snapshot.monthly_calc) || it.monthly_calc || [];
}

/** Decimals of a unit price: fuel prices and delivery-note prices have 3, everything else 2. */
function priceDecimals(l) {
  return ['FuelPriceDifference', 'Fuel', 'DeliveryNote'].includes(l.line_type) ? 3 : 2;
}

/**
 * How a line is printed. A monthly base is stored as a fraction of a month x the monthly price; it is printed as the
 * days paid x the price of one day (monthly price / days the month is divided by), which is the same amount:
 * 8 days x (6,500,000 / 26) = 2,000,000. Any other line is printed as stored.
 */
function displayLine(l, it) {
  const base = { quantity: n(l.quantity), unit: l.unit, unit_price: n(l.unit_price), amount: n(l.amount), decimals: priceDecimals(l) };
  if (l.line_type !== 'MonthlyBase') return base;
  const m = /^(\d{4}-\d{2})/.exec(String(l.note || ''));
  const calc = monthlyCalcOf(it).find((x) => m && x.month === m[1]);
  const D = calc ? n(calc.divisor ?? calc.working_days) : 0;
  if (!D) return base;
  return { ...base, quantity: r2(n(l.quantity) * D), unit: 'day', unit_price: n(l.unit_price) / D };
}

/** Titles printed under the signature lines (Settings > Documents). */
async function signatories() {
  return {
    preparedEn: await settings.getString('doc_prepared_by_en'),
    preparedAr: await settings.getString('doc_prepared_by_ar'),
    approverEn: await settings.getString('doc_approved_by_en'),
    approverAr: await settings.getString('doc_approved_by_ar'),
  };
}

module.exports = { REGULAR_LINES, SPECIAL_LINES, hoursSplit, rowMinutes, amountSplit, monthlyCalcOf, priceDecimals, displayLine, signatories };
