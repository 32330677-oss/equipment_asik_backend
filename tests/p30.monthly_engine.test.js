// P30 — monthly engine, rules of 12 Oct 2026 (pure, no database): the worked example of the decision — 6500 / month,
// 10 h per day, Fridays off, overtime price 40. Every day on its own; extra hours cover missing hours only when the Admin
// decides; overtime paid in an earlier invoice of the month is never reused; kept hours are offered again.
const { test } = require('node:test');
const assert = require('node:assert');
const E = require('../services/equipment/equipmentBillingEngine');
const { monthsFromDays } = require('../services/equipment/eqPayrollService');

const pad = (x) => String(x).padStart(2, '0');
const wk = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const all = Array.from({ length: 31 }, (_, i) => `2026-10-${pad(i + 1)}`);
const W = (d, h) => ({ eq_attendance_id: d, record_date: d, day_status: 'Working', gross_minutes: h * 60, break_minutes: 0, breakdown_minutes: 0, standby_minutes: 0 });
const special = { '2026-10-08': { record_date: '2026-10-08', day_status: 'Absent' }, '2026-10-09': W('2026-10-09', 10), '2026-10-12': W('2026-10-12', 1), '2026-10-13': W('2026-10-13', 13),
  '2026-10-20': { record_date: '2026-10-20', day_status: 'Breakdown', gross_minutes: 600 },
  '2026-10-22': { record_date: '2026-10-22', day_status: 'Standby', gross_minutes: 600, standby_credit_minutes: 600 }, '2026-10-27': null };
const rows = all.filter((d) => wk(d) !== 5 || special[d]).map((d) => (d in special ? special[d] : W(d, 10))).filter(Boolean);
const ex = (ot) => ({ billing_mode: 'Monthly', monthly_rate: 6500, standard_hours_per_day: 10, breakdown_billable_pct: 0, break_policy: 'Paid', overtime_enabled: ot, overtime_rate: ot ? 40 : null });
const months = (days) => monthsFromDays(days, ex(false), 5);
test('example: whole month, no offset', () => {
  assert.strictEqual(E.billItem(rows, ex(false), { months: months(all) }).net_cents, 552500);
  assert.strictEqual(E.billItem(rows, ex(true), { months: months(all) }).net_cents, 604500);
});
test('example: whole month, Admin offset', () => {
  const r = E.billItem(rows, ex(false), { months: months(all), offset: true });
  assert.strictEqual(r.net_cents, 585000);
  assert.strictEqual(r.lines.find((l) => l.line_type === 'ExtraHoursOffset').quantity, 13);
  assert.strictEqual(E.billItem(rows, ex(true), { months: months(all), offset: true }).net_cents, 585000);
  const d = r.monthly_details[0];
  assert.strictEqual(d.month_missing_hours, 29); assert.strictEqual(d.month_extra_hours, 13); assert.strictEqual(d.offset_possible_hours, 13);
});
const d1 = all.slice(0, 15); const r1 = rows.filter((r) => r.record_date <= '2026-10-15'); const r2 = rows.filter((r) => r.record_date > '2026-10-15');
const used = (p) => ({ '2026-10': { offset_minutes: p.monthly_details[0].offset_minutes, overtime_minutes: p.monthly_details[0].overtime_minutes } });
test('example: two invoices, no offset (OT off) = 2775 + 2750', () => {
  const p1 = E.billItem(r1, ex(false), { months: months(d1) });
  const p2 = E.billItem(r2, ex(false), { months: months(all), prev: { rows: r1, months: months(d1), used: used(p1) } });
  assert.strictEqual(p1.net_cents, 277500); assert.strictEqual(p2.net_cents, 275000);
  assert.strictEqual(p1.monthly_details[0].unpaid_extra_hours, 13);
  assert.strictEqual(p2.monthly_details[0].offset_possible_hours, 13, 'the 13 h of the first invoice are offered again');
});
test('example: two invoices, offset in both = 3100 + 2750; stored hours used later = 2775 + 3000', () => {
  const p1 = E.billItem(r1, ex(false), { months: months(d1), offset: true });
  const p2 = E.billItem(r2, ex(false), { months: months(all), offset: true, prev: { rows: r1, months: months(d1), used: used(p1) } });
  assert.strictEqual(p1.net_cents, 310000); assert.strictEqual(p2.net_cents, 275000);
  const q1 = E.billItem(r1, ex(false), { months: months(d1) });
  const q2 = E.billItem(r2, ex(false), { months: months(all), offset: true, prev: { rows: r1, months: months(d1), used: used(q1) } });
  assert.strictEqual(q1.net_cents + q2.net_cents, 585000, 'same total as one invoice with offset');
});
test('example: overtime paid in invoice 1 is never reused', () => {
  const p1 = E.billItem(r1, ex(true), { months: months(d1) });
  const p2 = E.billItem(r2, ex(true), { months: months(all), offset: true, prev: { rows: r1, months: months(d1), used: used(p1) } });
  assert.strictEqual(p1.net_cents, 277500 + 52000);
  assert.strictEqual(p2.monthly_details[0].offset_possible_hours, 0);
  assert.strictEqual(p2.net_cents, 275000);
});
test('example: split without ledger (old snapshot) = parts add up', () => {
  const p1 = E.billItem(r1, ex(false), { months: months(d1) });
  const p2 = E.billItem(r2, ex(false), { months: months(all), prev: { rows: r1, months: months(d1) } });
  assert.strictEqual(p1.net_cents + p2.net_cents, 552500);
});
test('one hour on a day no longer hides the missing hours (no offset)', () => {
  const days = ['2026-10-01', '2026-10-03', '2026-10-04'];
  const ctx = { months: monthsFromDays(days, ex(false), 5) };
  const r = E.billItem([W('2026-10-01', 1), W('2026-10-03', 14.5), W('2026-10-04', 14.5)], ex(false), ctx);
  assert.strictEqual(r.lines.find((l) => l.line_type === 'HoursShortfall').quantity, 9);
});
test('rate card test-this-price (rows without dates)', () => {
  const ctx = { months: [{ month: '2026-10', workingDays: 26, assignedWorkingDays: 26, holidayDays: 0, divisor: 26 }] };
  const rr = [{ record_date: null, day_status: 'Working', gross_minutes: 660 }, { record_date: null, day_status: 'Working', gross_minutes: 540 }];
  const card = { billing_mode: 'Monthly', monthly_rate: 6500, standard_hours_per_day: 10, standby_billable_pct: 50, breakdown_billable_pct: 0, break_policy: 'Deduct', overtime_rate: null };
  const r = E.billItem(rr, card, ctx);
  assert.strictEqual(r.lines.find((l) => l.line_type === 'AbsenceDeduction').quantity, 240); // 24 days not in the sample
  assert.strictEqual(r.lines.find((l) => l.line_type === 'HoursShortfall').quantity, 1);
});

test('after', async () => { await require('../config/db').pool.end(); });
