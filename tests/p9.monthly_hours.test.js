// P9 — monthly machines billed on the hours due in the month; rate card changes from a date.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, standardFleet } = require('./fixtures');
const engine = require('../services/equipment/equipmentBillingEngine');
const { workingDaysOfMonth } = require('../services/equipment/eqPayrollService');

require('../utils/businessDate').setClock(() => new Date(Date.UTC(2026, 9, 5, 9, 0, 0)));
const ACC = () => h.auth(h.T.accountant());
let F;
before(async () => { await h.resetDatabase(); F = await standardFleet(); });
after(h.closePool);

const card = { billing_mode: 'Monthly', monthly_rate: 6500, standard_hours_per_day: 10, standby_billable_pct: 50, breakdown_billable_pct: 0, break_policy: 'Deduct', overtime_rate: null };
const day = (date, hours) => ({ record_date: date, day_status: 'Working', gross_minutes: hours * 60, break_minutes: 0, breakdown_minutes: 0, standby_minutes: 0 });

test('working days = days of the month minus Fridays', () => {
  assert.strictEqual(workingDaysOfMonth('2026-10', 5), 26); // 31 days, 5 Fridays
  assert.strictEqual(workingDaysOfMonth('2026-09', 5), 26); // 30 days, 4 Fridays
  assert.strictEqual(workingDaysOfMonth('2026-02', 5), 24); // 28 days, 4 Fridays
});

test('hours complete -> full month; extra hours -> overtime at the month hourly price (or the typed rate)', () => {
  const ctx = { months: [{ month: '2026-10', workingDays: 26, assignedWorkingDays: 26, holidayDays: 0 }] };
  // 26 days x 10 h due = 260 h; hourly price = 6500 / 26 / 10 = 25
  const rows = Array.from({ length: 26 }, (_, i) => day(`2026-10-${String(i + 1).padStart(2, '0')}`, 11)); // 286 h
  const r = engine.billItem(rows, card, ctx);
  assert.strictEqual(r.net_cents, 650000 + 26 * 2500);
  const typed = engine.billItem(rows, { ...card, overtime_rate: 30 }, ctx);
  assert.strictEqual(typed.net_cents, 650000 + 26 * 3000);
  const exact = engine.billItem(rows.map((x) => ({ ...x, gross_minutes: 600 })), card, ctx);
  assert.strictEqual(exact.net_cents, 650000);
});

test('missing hours are deducted; standby = hours given, breakdown 0%; official holidays reduce the hours due', () => {
  const ctx = { months: [{ month: '2026-10', workingDays: 26, assignedWorkingDays: 26, holidayDays: 1 }] }; // 250 h due
  const rows = [
    ...Array.from({ length: 23 }, (_, i) => day(`2026-10-${String(i + 1).padStart(2, '0')}`, 10)), // 230 h
    { record_date: '2026-10-27', day_status: 'Standby', gross_minutes: 600, break_minutes: 0, breakdown_minutes: 0, standby_minutes: 0, standby_credit_minutes: 300 }, // 5 h given
    { record_date: '2026-10-28', day_status: 'Breakdown', gross_minutes: 600, break_minutes: 0, breakdown_minutes: 0, standby_minutes: 0 }, // 0 h
  ];
  const r = engine.billItem(rows, card, ctx);
  assert.strictEqual(r.lines.find((l) => l.line_type === 'HoursShortfall').quantity, 15); // 250 - 235
  assert.strictEqual(r.net_cents, 650000 - 15 * 2500);
});

test('rate card changed from a date: old card closed the day before, new card starts', async () => {
  const cards = await ok(h.api().get(`/api/equipment/machines/${F.crane.equipment_id}/rate-cards`).set(ACC()));
  const nc = await ok(h.api().post(`/api/equipment/rate-cards/${cards[0].rate_card_id}/revise`).set(ACC()).send({ effective_from: '2026-11-01', standard_hours_per_day: 10, overtime_rate: 30 }));
  assert.strictEqual(nc.effective_from, '2026-11-01');
  assert.strictEqual(Number(nc.monthly_rate), 6500);
  const after2 = await ok(h.api().get(`/api/equipment/machines/${F.crane.equipment_id}/rate-cards`).set(ACC()));
  assert.strictEqual(after2.find((c) => c.rate_card_id === cards[0].rate_card_id).effective_to, '2026-10-31');
  const bad = await h.api().post(`/api/equipment/rate-cards/${nc.rate_card_id}/revise`).set(ACC()).send({ effective_from: '2026-10-15' });
  assert.strictEqual(bad.body.code, 'VALIDATION_ERROR');
});

test('standby hours given: capped at one day, 0 when not set, never more than the standby inside a working day', () => {
  const ctx = { months: [{ month: '2026-10', workingDays: 26, assignedWorkingDays: 1, holidayDays: 0 }] }; // 10 h due
  const sb = (credit) => ({ record_date: '2026-10-08', day_status: 'Standby', gross_minutes: 0, break_minutes: 0, breakdown_minutes: 0, standby_minutes: 0, standby_credit_minutes: credit });
  const short = (r) => (r.lines.find((l) => l.line_type === 'HoursShortfall') || { quantity: 0 }).quantity;
  assert.strictEqual(short(engine.billItem([sb(null)], card, ctx)), 10);
  assert.strictEqual(short(engine.billItem([sb(600)], card, ctx)), 0);
  assert.strictEqual(engine.billItem([sb(900)], card, ctx).lines.find((l) => l.line_type === 'Overtime'), undefined, 'capped at 10 h');
  const w = { record_date: '2026-10-08', day_status: 'Working', gross_minutes: 600, break_minutes: 0, breakdown_minutes: 0, standby_minutes: 120, standby_credit_minutes: 300 };
  assert.strictEqual(short(engine.billItem([w], card, ctx)), 0); // 8 h work + at most the 2 h of standby recorded
});

test('fuel issued: the 3-decimal price is not rounded before multiplying', () => {
  const hourly = { billing_mode: 'Hourly', hourly_rate: 10, standard_hours_per_day: 8, standby_billable_pct: 50, breakdown_billable_pct: 0, break_policy: 'Deduct', fuel_policy: 'CompanySuppliesDeducted' };
  for (const [price, cents] of [[1.235, 123500], [1.005, 100500], [0.875, 87500]]) {
    const r = engine.billItem([], hourly, {}, { fuel: [{ liters: 1000, price_per_liter: price }] });
    assert.strictEqual(r.lines[0].amount_cents, -cents);
  }
});
