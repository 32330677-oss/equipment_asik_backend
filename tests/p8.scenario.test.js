// P8 — the end-to-end scenario of the user test guide (September 2026), with the expected numbers.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const QRCode = require('qrcode');
const h = require('./helpers');
const { ok, A, S8 } = require('./fixtures');

require('../utils/businessDate').setClock(() => new Date(Date.UTC(2026, 9, 4, 9, 0, 0)));
const ACC = () => h.auth(h.T.accountant());
let F;
const ids = {};

async function work(key, m, date, inT, outT, { brk, down, meter, fuel } = {}) {
  const r = await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: m.equipment_id, site_id: 8, check_in_time: `${date} ${inT}`, meter_start: meter && meter[0] }));
  if (brk) await ok(h.api().post(`/api/equipment/attendance/${r.eq_attendance_id}/downtime/start`).set(S8()).send({ downtime_type: 'Break', start_time: `${date} ${brk[0]}`, end_time: `${date} ${brk[1]}` }));
  if (down) await ok(h.api().post(`/api/equipment/attendance/${r.eq_attendance_id}/downtime/start`).set(S8()).send({ downtime_type: 'Breakdown', start_time: `${date} ${down[0]}`, end_time: `${date} ${down[1]}`, reason: 'Hydraulic leak' }));
  await ok(h.api().post(`/api/equipment/attendance/${r.eq_attendance_id}/check-out`).set(S8()).send({ check_out_time: `${date} ${outT}`, meter_end: meter && meter[1], fuel_liters: fuel }));
  ids[key] = r.eq_attendance_id;
}
const day = async (key, m, date, status) => {
  const r = await ok(h.api().post('/api/equipment/attendance/day-status').set(S8()).send({ equipment_id: m.equipment_id, site_id: 8, record_date: date, day_status: status, remarks: `${status} reason` }));
  ids[key] = r.eq_attendance_id;
};
const submit = (date) => ok(h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: date }));

before(async () => {
  await h.resetDatabase();
  // set-up exactly as in the guide: the accountant creates vendor, machines, cards, deployments, fuel; the admin the contract
  const vendor = await ok(h.api().post('/api/equipment/vendors').set(ACC()).send({ vendor_name: 'Al-Bunyan' }));
  const contract = await ok(h.api().post(`/api/equipment/vendors/${vendor.vendor_id}/contracts`).set(A()).send({ contract_number: 'C-001', start_date: '2026-09-01', currency: 'USD' }));
  const mk = (type_id) => ok(h.api().post('/api/equipment/machines').set(ACC()).send({ vendor_id: vendor.vendor_id, type_id }));
  F = { exc: await mk(1), loader: await mk(2), crane: await mk(4) };
  const card = (m, body) => ok(h.api().post(`/api/equipment/machines/${m.equipment_id}/rate-cards`).set(ACC()).send({ vendor_contract_id: contract.vendor_contract_id, effective_from: '2026-09-01', ...body }));
  await card(F.exc, { billing_mode: 'Hourly', hourly_rate: 40, standard_hours_per_day: 8, min_billable_hours_per_day: 6, overtime_enabled: true, overtime_threshold_hours: 10, overtime_rate: 50, standby_billable_pct: 50 });
  await card(F.loader, { billing_mode: 'Daily', daily_rate: 300, standard_hours_per_day: 8, fuel_policy: 'CompanySuppliesFree' });
  await card(F.crane, { billing_mode: 'Monthly', monthly_rate: 6500, standard_hours_per_day: 8, overtime_enabled: true });
  for (const m of [F.exc, F.loader, F.crane]) await ok(h.api().post('/api/equipment/deployments').set(ACC()).send({ equipment_id: m.equipment_id, site_id: 8, shift_type: 'Day', assigned_date: '2026-09-01' }));
  await ok(h.api().post('/api/equipment/fuel-prices').set(ACC()).send({ currency: 'USD', effective_from: '2026-09-01', price_per_liter: 1.0 }));
  await ok(h.api().post('/api/equipment/fuel-prices').set(ACC()).send({ currency: 'USD', effective_from: '2026-09-15', price_per_liter: 1.2 }));
  await ok(h.api().post('/api/equipment/fuel-prices').set(ACC()).send({ currency: 'USD', effective_from: '2026-09-25', price_per_liter: 0.9 }));
  await ok(h.api().post(`/api/equipment/machines/${F.exc.equipment_id}/fuel-terms`).set(ACC()).send({ effective_from: '2026-09-01', base_price_per_liter: 1.0, liters_per_hour: 2 }));
  // Sep 10
  await work('e10', F.exc, '2026-09-10', '07:00', '17:30', { brk: ['12:00', '13:00'], meter: [1000, 1009.5] });
  await work('l10', F.loader, '2026-09-10', '07:00', '16:00', { brk: ['12:00', '13:00'] });
  await work('c10', F.crane, '2026-09-10', '07:00', '15:00');
  await submit('2026-09-10');
  // Sep 16
  await work('e16', F.exc, '2026-09-16', '07:00', '19:00', { brk: ['12:00', '13:00'], meter: [1009.5, 1020.5], fuel: 50 });
  await day('l16', F.loader, '2026-09-16', 'Breakdown');
  await work('c16', F.crane, '2026-09-16', '07:00', '17:00', { down: ['09:00', '12:00'] });
  await submit('2026-09-16');
  // Sep 26
  await work('e26', F.exc, '2026-09-26', '07:00', '11:00');
  await day('l26', F.loader, '2026-09-26', 'Absent');
  await day('c26', F.crane, '2026-09-26', 'Standby');
  await submit('2026-09-26');
  // Sep 27: meter goes backwards -> anomaly
  await work('e27', F.exc, '2026-09-27', '07:00', '15:00', { meter: [1015, 1023] });
  await submit('2026-09-27');
});
after(h.closePool);

test('scenario: review, fuel, adjustments, preview numbers, finalize, invoices', async () => {
  const e27 = (await h.query('SELECT anomaly_code FROM eq_attendance WHERE eq_attendance_id = ?', [ids.e27]))[0];
  assert.strictEqual(e27.anomaly_code, 'meter_backwards');
  await ok(h.api().post(`/api/equipment/admin/attendance/${ids.e27}/ack-anomaly`).set(A()).send({ note: 'meter replaced' }));
  const all = await h.query("SELECT eq_attendance_id FROM eq_attendance WHERE status = 'Submitted'");
  await ok(h.api().post('/api/equipment/admin/attendance/approve').set(A()).send({ ids: all.map((r) => r.eq_attendance_id) }));
  // monthly crane standby day: no %; the accountant gives the hours (max = hours per day of the card)
  const tooMany = await h.api().patch(`/api/equipment/admin/attendance/${ids.c26}/standby-credit`).set(ACC()).send({ hours: 9 });
  assert.strictEqual(tooMany.body.code, 'VALIDATION_ERROR');
  const blk = await ok(h.api().get('/api/equipment/payroll/blockers?start_date=2026-09-01&end_date=2026-09-30').set(ACC()));
  assert.ok(blk.find((b) => b.code === 'STANDBY_HOURS_NOT_SET'), 'standby hours must be decided before paying');
  await ok(h.api().patch(`/api/equipment/admin/attendance/${ids.c26}/standby-credit`).set(ACC()).send({ hours: 4 }));
  const fuel = await ok(h.api().get('/api/equipment/fuel-issues?unpriced=true').set(ACC()));
  await ok(h.api().patch(`/api/equipment/fuel-issues/${fuel[0].fuel_issue_id}`).set(ACC()).send({ price_per_liter: 1.1 }));
  await ok(h.api().post('/api/equipment/adjustments').set(ACC()).send({ equipment_id: F.exc.equipment_id, adjustment_date: '2026-09-10', adjustment_type: 'Mobilization', amount: 150, reason: 'Transport' }));
  await ok(h.api().post('/api/equipment/adjustments').set(ACC()).send({ equipment_id: F.loader.equipment_id, adjustment_date: '2026-09-10', adjustment_type: 'Penalty', amount: -50, reason: 'Late' }));
  const SC = { start_date: '2026-09-01', end_date: '2026-09-30' };
  const p = await ok(h.api().post('/api/equipment/payroll/preview').set(ACC()).send(SC));
  const net = (m) => p.items.find((i) => i.equipment_id === m.equipment_id).net;
  assert.strictEqual(net(F.exc), '1487.00');
  assert.strictEqual(net(F.loader), '250.00'); // 1 day x 300 - penalty 50 (no operator line)
  assert.strictEqual(net(F.crane), '593.75'); // 208 h due, 19 h done (8 + 7 + standby 4 h given) -> 189 h x 31.25 missing
  assert.strictEqual(p.totals[0].net, '2330.75');
  const batch = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send(SC));
  const no = await h.api().patch(`/api/equipment/payroll/batches/${batch.eq_batch_id}/finalize`).set(A());
  assert.strictEqual(no.body.code, 'SCAN_MISSING');
  const sheets = await ok(h.api().get('/api/equipment/timesheets?month=2026-09').set(ACC()));
  for (const s of sheets) await ok(h.api().post(`/api/equipment/timesheets/${s.timesheet_id}/scans`).set(ACC()).attach('files', await QRCode.toBuffer(`signed ${s.sheet_code}`), 'scan.png'));
  const fin = await ok(h.api().patch(`/api/equipment/payroll/batches/${batch.eq_batch_id}/finalize`).set(A()));
  assert.strictEqual(fin.invoices.filter((i) => i.kind === 'Machine').length, 3);
});
