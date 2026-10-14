// P25 — terms of the month of monthly machines: a normal month by default (price / working days of the calendar month);
// an EXCEPTION per machine and month (12 Oct 2026: amount, days, hourly price), locked only while an invoice handed over to finance bills the month (14 Oct 2026);
// overtime only when the card pays it. The card no longer has a "Fixed" divisor.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const QRCode = require('qrcode');
const h = require('./helpers');
const { ok, standardFleet, A, S8 } = require('./fixtures');
const engine = require('../services/equipment/equipmentBillingEngine');
const BD = require('../utils/businessDate');

BD.setClock(() => new Date(Date.UTC(2026, 10, 20, 9, 0, 0))); // 2026-11-20 12:00 Syria time
const ACC = () => h.auth(h.T.accountant());
const code = async (req) => (await req).body.code;
let F; let M2; let M3; let M4; const m2rows = [];

async function monthlyMachine(plate, cardBody, assigned = '2026-10-01') {
  const m = await ok(h.api().post('/api/equipment/machines').set(A()).send({ vendor_id: F.vendor.vendor_id, type_id: 4, plate_number: plate, make: 'XCMG' }));
  await ok(h.api().post(`/api/equipment/machines/${m.equipment_id}/rate-cards`).set(A())
    .send({ vendor_contract_id: F.contract.vendor_contract_id, effective_from: '2026-07-01', billing_mode: 'Monthly', monthly_rate: 2000, standard_hours_per_day: 10, ...cardBody }));
  await ok(h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: m.equipment_id, site_id: 8, shift_type: 'Day', assigned_date: assigned, default_operator_id: F.op1.operator_id }));
  return m;
}
async function workDay(m, date, inT, outT) {
  const r = await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: m.equipment_id, site_id: 8, check_in_time: `${date} ${inT}`, check_out_time: `${date} ${outT}`, late_reason: 'paper sheet typed late' }));
  await ok(h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: date }));
  await ok(h.api().post('/api/equipment/admin/attendance/approve').set(A()).send({ ids: [r.eq_attendance_id] }));
  return r.eq_attendance_id;
}
const isFriday = (d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 5;
const OCT = () => ({ start_date: '2026-10-01', end_date: '2026-10-31', equipment_id: M2.equipment_id });
const terms = (body) => h.api().put('/api/equipment/payroll/monthly-terms').set(ACC()).send(body);

before(async () => {
  await h.resetDatabase();
  F = await standardFleet();
  M2 = await monthlyMachine('M-002', { overtime_enabled: true });
  M3 = await monthlyMachine('M-003', {});
  M4 = await monthlyMachine('M-004', {});
  // October 2026: 26 working days (5 Fridays off); 10 h every working day = 260 h
  for (let i = 1; i <= 31; i += 1) {
    const d = `2026-10-${String(i).padStart(2, '0')}`;
    if (!isFriday(d)) m2rows.push(await workDay(M2, d, '07:00', '17:00'));
  }
});
after(h.closePool);

test('the examples of the plan (2000 per month, 10 h per day)', () => {
  const card = { billing_mode: 'Monthly', monthly_rate: 2000, standard_hours_per_day: 10, standby_billable_pct: 0, breakdown_billable_pct: 0, break_policy: 'Deduct', overtime_enabled: true, overtime_rate: null };
  const days = (n, hours, month = '2026-10') => Array.from({ length: n }, (_, i) => ({ record_date: `${month}-${String(i + 1).padStart(2, '0')}`, day_status: 'Working', gross_minutes: hours * 60, break_minutes: 0, breakdown_minutes: 0, standby_minutes: 0 }));
  const mo = (x) => ({ months: [{ month: '2026-10', workingDays: 27, assignedWorkingDays: 27, holidayDays: 0, ...x }] });
  const feb = (x) => ({ months: [{ month: '2026-02', workingDays: 24, assignedWorkingDays: 24, holidayDays: 0, ...x }] });
  const net = (rows, rate, ctx) => engine.billItem(rows, rate, ctx).net_cents / 100;
  assert.strictEqual(net(days(27, 10), card, mo({})), 2000.00); // 27 (calendar), overtime paid at the month price: nothing extra
  assert.strictEqual(net(days(27, 10), card, mo({ divisor: 26, divisorSource: 'manual' })), 2076.92);
  assert.strictEqual(net(days(27, 10), { ...card, overtime_rate: 9 }, mo({ divisor: 26 })), 2090.00);
  assert.strictEqual(net(days(27, 10), { ...card, overtime_enabled: false }, mo({ divisor: 26 })), 2000.00);
  assert.strictEqual(net(days(25, 10), card, mo({ divisor: 26 })), 1923.08);
  assert.strictEqual(net(days(24, 10, '2026-02'), card, feb({})), 2000.00);
  assert.strictEqual(net(days(24, 10, '2026-02'), card, feb({ divisor: 26 })), 1846.15);
  assert.strictEqual(net(days(13, 10), card, mo({ divisor: 26, assignedWorkingDays: 13 })), 1000.00);
  // 12 Oct 2026: a typed hourly price prices the deductions / offset / overtime, never the base: 2000 + 10 h x 8
  assert.strictEqual(net(days(27, 10), card, mo({ divisor: 26, hourlyCents: 800, hourlySource: 'manual' })), 2080.00);
  // the vendor who is paid the 27th day: amount of the month typed (2000 x 27 / 26), divided by the 27 days
  assert.strictEqual(net(days(27, 10), card, mo({ amountCents: 207692, amountSource: 'manual' })), 2076.92);
  const off = engine.billItem(days(27, 10), { ...card, overtime_enabled: false }, mo({ divisor: 26 }));
  assert.strictEqual(off.monthly_details[0].overtime_paid, false);
  assert.strictEqual(off.monthly_details[0].unpaid_extra_hours, 10);
});

let draft;
test('a card without terms gives exactly the old amount; a new monthly card pays overtime by default', async () => {
  const cards = await ok(h.api().get(`/api/equipment/machines/${M3.equipment_id}/rate-cards`).set(ACC()));
  assert.strictEqual(Number(cards[0].overtime_enabled), 1, 'default ON for a new monthly card');
  assert.strictEqual(cards[0].monthly_divisor, 'MonthDays');
  draft = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send(OCT()));
  assert.strictEqual(draft.total_net, '2000.00'); // 26 calendar working days, 260 h due, 260 h done
  const mc = draft.items[0].rate_snapshot.monthly_calc[0];
  assert.strictEqual(mc.divisor, 26);
  assert.strictEqual(mc.divisor_source, 'calendar');
  assert.deepStrictEqual(draft.items[0].rate_snapshot.monthly_terms, [{ month: '2026-10', divisor: 26, divisor_source: 'calendar', amount: null, amount_source: 'card', hourly: null, hourly_source: 'auto' }]);
});

test('an exception changes under a draft: the draft asks to be recalculated (14 Oct 2026)', async () => {
  const t = await ok(terms({ equipment_id: M2.equipment_id, month: '2026-10', working_days: 25, hourly_rate: null }));
  assert.strictEqual(t.divisor, 25);
  assert.strictEqual(t.divisor_source, 'manual');
  assert.strictEqual(t.is_exception, true);
  assert.strictEqual(t.hourly, 8); // 2000 / 25 / 10
  const list = await ok(h.api().get(`/api/equipment/payroll/monthly-terms?start_date=2026-10-01&end_date=2026-10-31&equipment_ids=${M2.equipment_id}`).set(ACC()));
  assert.strictEqual(list[0].locked, false, 'a draft never locks the month');
  const d = await ok(h.api().get(`/api/equipment/payroll/batches/${draft.eq_batch_id}`).set(ACC()));
  assert.strictEqual(d.stale, true);
  const v2 = await ok(h.api().post(`/api/equipment/payroll/batches/${draft.eq_batch_id}/supersede`).set(ACC()).send({}));
  // D = 25: base = full month (26 deployed days, 25 paid as base); the 26th day's 10 h are extra hours -> overtime x 8
  assert.strictEqual(v2.total_net, '2080.00');
  draft = v2;
});

test('issued: the exception is listed before issuing; handed over to finance: the month is locked (409)', async () => {
  const review = await ok(h.api().get(`/api/equipment/payroll/batches/${draft.eq_batch_id}/review-summary`).set(A()));
  assert.ok(review.items.find((i) => i.kind === 'monthly_exception' && /divided by 25 days/.test(i.ref)));
  draft = await h.issue(draft.eq_batch_id);
  await h.handOver(draft.eq_batch_id);
  const r = await terms({ equipment_id: M2.equipment_id, month: '2026-10', working_days: 24 });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'MONTHLY_TERMS_LOCKED');
  assert.strictEqual(r.body.details.state, 'handed_over');
  assert.match(r.body.message, /Withdraw it from finance first/);
  const list = await ok(h.api().get(`/api/equipment/payroll/monthly-terms?start_date=2026-10-01&end_date=2026-10-31&equipment_ids=${M2.equipment_id}`).set(ACC()));
  assert.strictEqual(list[0].locked, true);
  assert.strictEqual(list[0].locked_by_batch_id, draft.eq_batch_id);
  assert.strictEqual(list[0].locked_state, 'handed_over');
});

test('a batch over two months: one line per month, each with its own terms', async () => {
  await ok(terms({ equipment_id: M3.equipment_id, month: '2026-11', working_days: 20 }));
  const p = await ok(h.api().post('/api/equipment/payroll/preview').set(ACC()).send({ start_date: '2026-10-20', end_date: '2026-11-19', equipment_id: M3.equipment_id }));
  const mc = p.items[0].monthly_calc;
  assert.deepStrictEqual(mc.map((x) => x.month), ['2026-10', '2026-11']);
  assert.strictEqual(mc[0].divisor, 26);
  assert.strictEqual(mc[0].divisor_source, 'calendar');
  assert.strictEqual(mc[1].divisor, 20);
  assert.strictEqual(mc[1].divisor_source, 'manual');
  assert.strictEqual(p.items[0].lines.filter((l) => l.line_type === 'MonthlyBase').length, 2);
  // both null = back to the card
  await ok(terms({ equipment_id: M3.equipment_id, month: '2026-11', working_days: null, hourly_rate: null }));
  const [left] = await h.query("SELECT COUNT(*) AS n FROM eq_monthly_terms WHERE equipment_id = ? AND month = '2026-11'", [M3.equipment_id]);
  assert.strictEqual(Number(left.n), 0);
});

test('no "Fixed" divisor on the card any more: December is a normal month of 27 days; an exception pays the 27th day', async () => {
  const dec = `/api/equipment/payroll/monthly-terms?start_date=2026-12-01&end_date=2026-12-31&equipment_ids=${M4.equipment_id}`;
  let list = await ok(h.api().get(dec).set(ACC()));
  assert.strictEqual(list[0].calendar_days, 27);
  assert.strictEqual(list[0].divisor, 27);
  assert.strictEqual(list[0].divisor_source, 'calendar');
  assert.strictEqual(list[0].amount, 2000);
  assert.strictEqual(list[0].is_exception, false);
  const bad = await h.api().post(`/api/equipment/machines/${M4.equipment_id}/rate-cards`).set(A())
    .send({ vendor_contract_id: F.contract.vendor_contract_id, effective_from: '2027-01-01', billing_mode: 'Monthly', monthly_rate: 2000, monthly_divisor: 'Fixed', monthly_working_days: 26 });
  assert.strictEqual(bad.body.code, 'VALIDATION_ERROR');
  // the vendor who is paid per working day (2000 / 26): December = 27 x 76.92 = 2076.92
  await ok(terms({ equipment_id: M4.equipment_id, month: '2026-12', monthly_amount: 2076.92, working_days: 27, note: 'paid per working day' }));
  list = await ok(h.api().get(dec).set(ACC()));
  assert.strictEqual(list[0].amount, 2076.92);
  assert.strictEqual(list[0].amount_source, 'manual');
  assert.strictEqual(list[0].typed_amount, 2076.92);
  assert.strictEqual(list[0].hourly, 7.6923); // 2076.92 / 27 / 10
  assert.strictEqual(list[0].is_exception, true);
  // all empty = a normal month again
  await ok(terms({ equipment_id: M4.equipment_id, month: '2026-12', monthly_amount: null, working_days: null, hourly_rate: null }));
  assert.strictEqual((await ok(h.api().get(dec).set(ACC())))[0].is_exception, false);
  assert.strictEqual(await code(terms({ equipment_id: F.exc.equipment_id, month: '2026-10', working_days: 25 })), 'NOT_MONTHLY');
});
