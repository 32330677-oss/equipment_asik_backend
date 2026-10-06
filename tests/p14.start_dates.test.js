// P14 — entering history backwards: the first day of fuel price difference terms and of a supervisor period can be
// corrected (with a reason) while the days involved are in an open period; never inside a finalized payroll.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const QRCode = require('qrcode');
const h = require('./helpers');
const { ok, standardFleet, A, S8 } = require('./fixtures');
const BD = require('../utils/businessDate');

const NOW = new Date(Date.UTC(2026, 9, 6, 9, 0, 0)); // 2026-10-06 12:00 Syria time
BD.setClock(() => NOW);
const ACC = () => h.auth(h.T.accountant());
const code = async (req) => (await req).body.code;
let F; let sup9Site10; let terms1; let terms2;

before(async () => {
  await h.resetDatabase();
  F = await standardFleet();
});
after(async () => { await h.closePool(); });

test('supervisor period entered from today is moved back to the real first day (reason, overlap check)', async () => {
  sup9Site10 = await ok(h.api().post('/api/sites/10/supervisors').set(A()).send({ user_id: 4, shift_type: 'Day', from_date: '2026-10-06' }));
  const id = sup9Site10.site_supervisor_id;
  assert.strictEqual(await code(h.api().patch(`/api/site-supervisors/${id}/start`).set(A()).send({ from_date: '2026-08-01' })), 'VALIDATION_ERROR');
  assert.strictEqual((await h.api().patch(`/api/site-supervisors/${id}/start`).set(ACC()).send({ from_date: '2026-08-01', reason: 'started with the project' })).status, 403);
  const moved = await ok(h.api().patch(`/api/site-supervisors/${id}/start`).set(A()).send({ from_date: '2026-08-01', reason: 'started with the project' }));
  assert.strictEqual(moved.from_date, '2026-08-01');
  const [log] = await h.query("SELECT reason, old_values FROM audit_logs WHERE table_name = 'site_supervisors' AND record_id = ? AND action_type = 'change_start'", [id]);
  assert.strictEqual(log.reason, 'started with the project');
  assert.ok(JSON.stringify(log.old_values).includes('2026-10-06'), 'the old first day stays in the history');
  // another supervisor already covers part of the new range: refused
  await ok(h.api().post('/api/sites/10/supervisors').set(A()).send({ user_id: 3, shift_type: 'Day', from_date: '2026-07-01', to_date: '2026-07-20' }));
  assert.strictEqual(await code(h.api().patch(`/api/site-supervisors/${id}/start`).set(A()).send({ from_date: '2026-07-10', reason: 'try an overlap' })), 'SUPERVISOR_PERIOD_OVERLAP');
  assert.strictEqual(await code(h.api().patch(`/api/site-supervisors/${id}/start`).set(A()).send({ from_date: '2026-08-01', reason: 'same day again' })), 'VALIDATION_ERROR');
});

test('fuel terms entered from today are moved back to the day the machine joined (reason, overlap, after the last day)', async () => {
  terms1 = await ok(h.api().post(`/api/equipment/machines/${F.exc.equipment_id}/fuel-terms`).set(ACC()).send({ effective_from: '2026-10-06', base_price_per_liter: 0.8, liters_per_hour: 15 }));
  assert.strictEqual(await code(h.api().patch(`/api/equipment/fuel-terms/${terms1.fuel_terms_id}/start`).set(ACC()).send({ effective_from: '2026-09-01' })), 'VALIDATION_ERROR');
  const moved = await ok(h.api().patch(`/api/equipment/fuel-terms/${terms1.fuel_terms_id}/start`).set(ACC()).send({ effective_from: '2026-09-01', reason: 'compensated since it joined' }));
  assert.strictEqual(moved.effective_from, '2026-09-01');
  // later terms (new consumption from 10-10) close the first ones on 10-09
  terms2 = await ok(h.api().post(`/api/equipment/machines/${F.exc.equipment_id}/fuel-terms`).set(ACC()).send({ effective_from: '2026-10-10', base_price_per_liter: 0.8, liters_per_hour: 12 }));
  assert.strictEqual(await code(h.api().patch(`/api/equipment/fuel-terms/${terms2.fuel_terms_id}/start`).set(ACC()).send({ effective_from: '2026-10-05', reason: 'agreement date' })), 'FUEL_TERMS_OVERLAP');
  assert.strictEqual(await code(h.api().patch(`/api/equipment/fuel-terms/${terms1.fuel_terms_id}/start`).set(ACC()).send({ effective_from: '2026-10-12', reason: 'after its end' })), 'VALIDATION_ERROR');
  const [log] = await h.query("SELECT reason FROM audit_logs WHERE table_name = 'eq_fuel_terms' AND record_id = ? AND action_type = 'change_start'", [terms1.fuel_terms_id]);
  assert.strictEqual(log.reason, 'compensated since it joined');
});

test('backfilled September is paid with its fuel difference; afterwards its start dates are locked', async () => {
  await ok(h.api().post('/api/equipment/fuel-prices').set(A()).send({ currency: 'USD', effective_from: '2026-08-01', price_per_liter: 1.0 }));
  // a September day recorded today by the Admin (history): one whole session in one step
  const r = await ok(h.api().post('/api/equipment/attendance/check-in').set(A())
    .send({ equipment_id: F.exc.equipment_id, site_id: 8, shift_type: 'Day', check_in_time: '2026-09-10 07:00', check_out_time: '2026-09-10 15:00' }));
  assert.strictEqual(r.late_entry, true, 'flagged as a late entry, never blocked');
  await ok(h.api().post('/api/equipment/attendance/submit').set(A()).send({ site_id: 8, shift_type: 'Day', record_date: '2026-09-10' }));
  await ok(h.api().post('/api/equipment/admin/attendance/approve').set(A()).send({ ids: [r.eq_attendance_id] }));
  const sheets = await ok(h.api().get(`/api/equipment/timesheets?month=2026-09&equipment_id=${F.exc.equipment_id}`).set(ACC()));
  await ok(h.api().post(`/api/equipment/timesheets/${sheets[0].timesheet_id}/scans`).set(ACC()).attach('files', await QRCode.toBuffer('signed sept'), 'scan.png'));
  const sept = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-09-01', end_date: '2026-09-30', equipment_id: F.exc.equipment_id }));
  const item = sept.items ? sept.items[0] : (await ok(h.api().get(`/api/equipment/payroll/batches/${sept.eq_batch_id}`).set(ACC()))).items[0];
  const fd = item.lines.find((l) => l.line_type === 'FuelPriceDifference');
  assert.ok(fd, 'the fuel difference of the corrected terms is paid');
  assert.strictEqual(Number(fd.amount), 24, '(1.000 - 0.800) x 15 L/h x 8 h');
  await ok(h.api().patch(`/api/equipment/payroll/batches/${sept.eq_batch_id}/finalize`).set(A()).send({ acknowledge_changes: true }));
  await ok(h.api().patch(`/api/equipment/payroll/batches/${sept.eq_batch_id}/mark-paid`).set(A()).send({ payment_reference: 'TRF-0905 (paid 2026-09-05)' }));
  // September is closed: its start dates cannot move any more
  // moving the start earlier into August only adds August days: August is still open, so it is allowed
  const aug = await ok(h.api().patch(`/api/equipment/fuel-terms/${terms1.fuel_terms_id}/start`).set(ACC()).send({ effective_from: '2026-08-20', reason: 'joined on the 20th of August' }));
  assert.strictEqual(aug.effective_from, '2026-08-20');
  assert.strictEqual(await code(h.api().patch(`/api/equipment/fuel-terms/${terms1.fuel_terms_id}/start`).set(ACC()).send({ effective_from: '2026-09-15', reason: 'later start' })), 'PAYROLL_PERIOD_FINALIZED');
  assert.strictEqual(await code(h.api().patch(`/api/site-supervisors/${sup9Site10.site_supervisor_id}/start`).set(A()).send({ from_date: '2026-09-15', reason: 'later start' })), 'PAYROLL_PERIOD_FINALIZED');
  // an open period can still be corrected (October)
  const oct = await ok(h.api().patch(`/api/equipment/fuel-terms/${terms2.fuel_terms_id}/start`).set(ACC()).send({ effective_from: '2026-10-11', reason: 'agreement signed on the 11th' }));
  assert.strictEqual(oct.effective_from, '2026-10-11');
  void S8;
});
