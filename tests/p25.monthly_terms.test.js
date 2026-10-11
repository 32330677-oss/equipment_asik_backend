// P25 — terms of the month of monthly machines (11 Oct 2026): divisor D (calendar, fixed on the card, or typed per
// machine and month), hourly price typed per month, and overtime only when the card pays it.
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
  M4 = await monthlyMachine('M-004', { monthly_divisor: 'Fixed', monthly_working_days: 26 });
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
  assert.strictEqual(net(days(27, 10), card, mo({ divisor: 26, hourlyCents: 800, hourlySource: 'manual' })), 2160.00);
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
  assert.deepStrictEqual(draft.items[0].rate_snapshot.monthly_terms, [{ month: '2026-10', divisor: 26, divisor_source: 'calendar', hourly: null, hourly_source: 'auto' }]);
});

test('typed terms make the draft stale; Recalculate gives the new amount', async () => {
  const t = await ok(terms({ equipment_id: M2.equipment_id, month: '2026-10', working_days: 25, hourly_rate: null }));
  assert.strictEqual(t.divisor, 25);
  assert.strictEqual(t.divisor_source, 'manual');
  assert.strictEqual(t.hourly, 8); // 2000 / 25 / 10
  const d = await ok(h.api().get(`/api/equipment/payroll/batches/${draft.eq_batch_id}`).set(ACC()));
  assert.strictEqual(d.stale, true);
  assert.ok(d.stale_reasons.find((r) => r.code === 'MONTHLY_TERMS_CHANGED'));
  const v2 = await ok(h.api().post(`/api/equipment/payroll/batches/${draft.eq_batch_id}/supersede`).set(ACC()).send({}));
  // D = 25: base = full month (26 deployed days, 25 paid as base), 250 h due, 260 h done -> 10 h x 8 overtime
  assert.strictEqual(v2.total_net, '2080.00');
  draft = v2;
});

test('after the Finalize the terms are locked (409); after the undo they can change again', async () => {
  const sheets = await ok(h.api().get(`/api/equipment/timesheets?month=2026-10&equipment_id=${M2.equipment_id}`).set(ACC()));
  await ok(h.api().post(`/api/equipment/timesheets/${sheets[0].timesheet_id}/scans`).set(ACC()).attach('files', await QRCode.toBuffer('signed'), 'scan.png'));
  await ok(h.api().patch(`/api/equipment/payroll/batches/${draft.eq_batch_id}/finalize`).set(A()).send({ acknowledge_changes: true }));
  const r = await terms({ equipment_id: M2.equipment_id, month: '2026-10', working_days: 24 });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'MONTHLY_TERMS_LOCKED');
  const list = await ok(h.api().get(`/api/equipment/payroll/monthly-terms?start_date=2026-10-01&end_date=2026-10-31&equipment_ids=${M2.equipment_id}`).set(ACC()));
  assert.strictEqual(list[0].locked, true);
  assert.strictEqual(list[0].locked_by_batch_id, draft.eq_batch_id);
  await ok(h.api().patch(`/api/equipment/payroll/batches/${draft.eq_batch_id}/unfinalize`).set(A()).send({ reason: 'check the terms' }));
  await ok(terms({ equipment_id: M2.equipment_id, month: '2026-10', working_days: 25, note: 'agreed 25 days' }));
  await ok(h.api().patch(`/api/equipment/payroll/batches/${draft.eq_batch_id}/finalize`).set(A()).send({ acknowledge_changes: true }));
});

test('a Correction uses the terms frozen in the batch, not the table', async () => {
  // someone changes the table behind the batch (cannot happen through the API once locked): the correction ignores it
  await h.query("UPDATE eq_monthly_terms SET working_days = 20 WHERE equipment_id = ? AND month = '2026-10'", [M2.equipment_id]);
  const [row] = await h.query("SELECT eq_attendance_id FROM eq_attendance WHERE equipment_id = ? AND record_date = '2026-10-05'", [M2.equipment_id]);
  const c = await ok(h.api().post(`/api/equipment/admin/attendance/${row.eq_attendance_id}/correction`).set(ACC())
    .send({ reason: 'Signed sheet shows 18:00', changes: { check_out_time: '2026-10-05 18:00' } }));
  assert.strictEqual(Number(c.delta_amount), 8, '+1 h overtime at 2000 / 25 / 10 = 8 (the table would say 10)');
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

test('a card "Fixed 26" without typed terms divides by 26 (December has 27 working days)', async () => {
  const list = await ok(h.api().get(`/api/equipment/payroll/monthly-terms?start_date=2026-12-01&end_date=2026-12-31&equipment_ids=${M4.equipment_id}`).set(ACC()));
  assert.strictEqual(list[0].calendar_days, 27);
  assert.strictEqual(list[0].divisor, 26);
  assert.strictEqual(list[0].divisor_source, 'card');
  assert.strictEqual(list[0].card_divisor_mode, 'Fixed');
  // a fixed divisor needs its number of days
  const bad = await h.api().post(`/api/equipment/machines/${M4.equipment_id}/rate-cards`).set(A())
    .send({ vendor_contract_id: F.contract.vendor_contract_id, effective_from: '2027-01-01', billing_mode: 'Monthly', monthly_rate: 2000, monthly_divisor: 'Fixed', monthly_working_days: 0 });
  assert.strictEqual(bad.body.code, 'VALIDATION_ERROR');
  assert.strictEqual(await code(terms({ equipment_id: F.exc.equipment_id, month: '2026-10', working_days: 25 })), 'NOT_MONTHLY');
});
