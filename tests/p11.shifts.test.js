// P11 — edit / lock policy, phase 4: shifts. Continuous shifts share the overtime threshold, a Daily machine's
// second shift the same day is billed at second_shift_pct %, a monthly machine at two sites is billed once with
// its cost split by site, and site-scoped runs refuse such a machine.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, standardFleet, A, S8 } = require('./fixtures');

require('../utils/businessDate').setClock(() => new Date(Date.UTC(2026, 10, 20, 9, 0, 0)));
const ACC = () => h.auth(h.T.accountant());
const S9 = () => h.auth(h.T.sup9());
let F;

async function shift(m, site, shiftType, inT, outT) {
  const sup = site === 8 ? S8() : S9();
  const r = await ok(h.api().post('/api/equipment/attendance/check-in').set(sup).send({ equipment_id: m.equipment_id, site_id: site, shift_type: shiftType, check_in_time: inT }));
  await ok(h.api().post(`/api/equipment/attendance/${r.eq_attendance_id}/check-out`).set(sup).send({ check_out_time: outT }));
  await ok(h.api().post('/api/equipment/attendance/submit').set(sup).send({ site_id: site, shift_type: shiftType, record_date: inT.slice(0, 10) }));
  await ok(h.api().post('/api/equipment/admin/attendance/approve').set(A()).send({ ids: [r.eq_attendance_id] }));
  return r.eq_attendance_id;
}
const night = (m) => ok(h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: m.equipment_id, site_id: 9, shift_type: 'Night', assigned_date: '2026-11-01', default_operator_id: F.op1.operator_id }));
const amount = (item, type) => item.lines.filter((l) => l.line_type === type).reduce((a, l) => a + Number(l.amount), 0);

before(async () => {
  await h.resetDatabase();
  F = await standardFleet();
  await night(F.exc); await night(F.loader); await night(F.crane);
});
after(h.closePool);

test('continuous shifts (gap <= 30 min) share the overtime threshold: 13 h + 9 h -> 20 h regular, 2 h overtime', async () => {
  await shift(F.exc, 8, 'Day', '2026-11-03 06:00', '2026-11-03 19:00');
  await shift(F.exc, 9, 'Night', '2026-11-03 19:10', '2026-11-04 04:10');
  const p = await ok(h.api().post('/api/equipment/payroll/preview').set(ACC()).send({ start_date: '2026-11-01', end_date: '2026-11-15', equipment_id: F.exc.equipment_id }));
  const items = p.items.filter((i) => i.equipment_id === F.exc.equipment_id);
  const ot = items.reduce((a, i) => a + amount(i, 'Overtime'), 0);
  const work = items.reduce((a, i) => a + amount(i, 'Work'), 0);
  assert.strictEqual(ot, 100, '2 h x 50 (not 3 h as two separate days would give)');
  assert.strictEqual(work, 800, '20 h x 40');
});

test('a Daily machine on a second shift the same day (another site): 1 day + 50% of the extra day', async () => {
  const cards = await ok(h.api().get(`/api/equipment/machines/${F.loader.equipment_id}/rate-cards`).set(ACC()));
  await ok(h.api().put(`/api/equipment/rate-cards/${cards[0].rate_card_id}`).set(ACC()).send({ second_shift_pct: 50 }));
  const bad = await h.api().put(`/api/equipment/rate-cards/${(await ok(h.api().get(`/api/equipment/machines/${F.exc.equipment_id}/rate-cards`).set(ACC())))[0].rate_card_id}`).set(ACC()).send({ second_shift_pct: 50 });
  assert.strictEqual(bad.body.code, 'VALIDATION', 'second shift % is for Daily cards only');
  await shift(F.loader, 8, 'Day', '2026-11-05 07:00', '2026-11-05 15:00');
  await shift(F.loader, 9, 'Night', '2026-11-05 15:20', '2026-11-05 23:20');
  const b = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-11-01', end_date: '2026-11-15', equipment_id: F.loader.equipment_id }));
  const work = b.items.reduce((a, i) => a + amount(i, 'Work'), 0);
  const second = b.items.reduce((a, i) => a + amount(i, 'SecondShift'), 0);
  assert.strictEqual(work, 300, 'one full day for the first shift');
  assert.strictEqual(second, 150, 'the second shift at 50% of 300');
  const [snap] = await h.query("SELECT s.calc_detail FROM eq_payroll_attendance_snapshot s JOIN eq_attendance a ON a.eq_attendance_id = s.eq_attendance_id WHERE s.eq_batch_id = ? AND a.shift_type = 'Night'", [b.eq_batch_id]);
  const detail = typeof snap.calc_detail === 'string' ? JSON.parse(snap.calc_detail) : snap.calc_detail;
  assert.strictEqual(detail.day_used_before, 1, 'the snapshot keeps how the day was shared');
  await ok(h.api().patch(`/api/equipment/payroll/batches/${b.eq_batch_id}/void`).set(ACC()).send({ reason: 'test' }));
});

test('a monthly machine at two sites: site-scoped runs are refused; one item with its cost split by site', async () => {
  await shift(F.crane, 8, 'Day', '2026-11-03 07:00', '2026-11-03 15:00');
  await shift(F.crane, 9, 'Night', '2026-11-03 19:00', '2026-11-03 23:00');
  const bl = await ok(h.api().get('/api/equipment/payroll/blockers?start_date=2026-11-01&end_date=2026-11-15&site_id=8').set(ACC()));
  assert.ok(bl.find((x) => x.code === 'MONTHLY_MULTI_SITE'));
  const refused = await h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-11-01', end_date: '2026-11-15', site_id: 8, accept_blockers: true });
  assert.strictEqual(refused.body.code, 'MONTHLY_MULTI_SITE', 'cannot be accepted');
  const p = await ok(h.api().post('/api/equipment/payroll/preview').set(ACC()).send({ start_date: '2026-11-01', end_date: '2026-11-15', equipment_id: F.crane.equipment_id }));
  const it = p.items.find((i) => i.site_id === 8);
  assert.ok(it.site_allocation && it.site_allocation.length === 2);
  const shares = it.site_allocation.map((a) => a.share_pct).sort();
  assert.deepStrictEqual(shares, [33.33, 66.67]);
  const cost = ['MonthlyBase', 'Overtime', 'HoursShortfall'].reduce((a, t) => a + amount(it, t), 0);
  assert.strictEqual(Math.round(it.site_allocation.reduce((a, x) => a + Number(x.amount), 0) * 100), Math.round(cost * 100));
});
