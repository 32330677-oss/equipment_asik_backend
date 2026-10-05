// P7 — two shifts per machine, monthly base billed once, fuel price difference, scan before finalize, invoice numbers.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const QRCode = require('qrcode');
const h = require('./helpers');
const { ok, standardFleet, A, S8 } = require('./fixtures');

require('../utils/businessDate').setClock(() => new Date(Date.UTC(2026, 10, 5, 9, 0, 0)));
const ACC = () => h.auth(h.T.accountant());
const bin = (r) => r.buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
let F;

async function workDay(m, date, inT, outT, brk) {
  const r = await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: m.equipment_id, site_id: 8, check_in_time: `${date} ${inT}` }));
  if (brk) await ok(h.api().post(`/api/equipment/attendance/${r.eq_attendance_id}/downtime/start`).set(S8()).send({ downtime_type: 'Break', start_time: `${date} ${brk[0]}`, end_time: `${date} ${brk[1]}` }));
  await ok(h.api().post(`/api/equipment/attendance/${r.eq_attendance_id}/check-out`).set(S8()).send({ check_out_time: `${date} ${outT}` }));
  await ok(h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: date }));
  await ok(h.api().post('/api/equipment/admin/attendance/approve').set(A()).send({ ids: [r.eq_attendance_id] }));
  return r.eq_attendance_id;
}

before(async () => {
  await h.resetDatabase();
  F = await standardFleet();
});
after(h.closePool);

test('a machine can work Day and Night at the same time, never two deployments on one shift', async () => {
  await ok(h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: F.crane.equipment_id, site_id: 9, shift_type: 'Night', assigned_date: '2026-10-01' }));
  const clash = await h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: F.crane.equipment_id, site_id: 9, shift_type: 'Day', assigned_date: '2026-10-15' });
  assert.strictEqual(clash.body.code, 'DEPLOYMENT_OVERLAP');
  const list = await ok(h.api().get('/api/equipment/machines?status=Active').set(A()));
  const crane = list.filter((m) => m.equipment_id === F.crane.equipment_id);
  assert.strictEqual(crane.length, 1); // one row per machine
  assert.match(crane[0].deployments_today, /S08.*S09 \(Night\)/);
});

test('monthly base is billed once per day even with two deployments', async () => {
  const p = await ok(h.api().post('/api/equipment/payroll/preview').set(ACC()).send({ start_date: '2026-10-01', end_date: '2026-10-31', equipment_id: F.crane.equipment_id }));
  const months = p.items.flatMap((i) => i.lines.filter((l) => l.line_type === 'MonthlyBase')).reduce((a, l) => a + Number(l.quantity), 0);
  assert.strictEqual(months, 1);
  assert.strictEqual(p.items.find((i) => i.site_code === 'S08').lines.find((l) => l.line_type === 'MonthlyBase').amount, '6500.00');
});

let batch;
test('fuel price difference: official price - base, x L/h x work hours; blocker without price', async () => {
  await ok(h.api().post(`/api/equipment/machines/${F.exc.equipment_id}/fuel-terms`).set(A()).send({ effective_from: '2026-09-01', base_price_per_liter: 1.0, liters_per_hour: 2 }));
  await workDay(F.exc, '2026-10-05', '07:00', '17:00', ['12:00', '13:00']); // 9 h
  await workDay(F.exc, '2026-10-12', '07:00', '12:00'); // 5 h
  let b = await ok(h.api().get('/api/equipment/payroll/blockers?start_date=2026-10-01&end_date=2026-10-31').set(ACC()));
  assert.ok(b.find((x) => x.code === 'FUEL_PRICE_MISSING'));
  await ok(h.api().post('/api/equipment/fuel-prices').set(A()).send({ currency: 'USD', effective_from: '2026-09-01', price_per_liter: 1.0 }));
  await ok(h.api().post('/api/equipment/fuel-prices').set(A()).send({ currency: 'USD', effective_from: '2026-10-10', price_per_liter: 1.2 }));
  b = await ok(h.api().get('/api/equipment/payroll/blockers?start_date=2026-10-01&end_date=2026-10-31').set(ACC()));
  assert.ok(!b.find((x) => x.code === 'FUEL_PRICE_MISSING'));
  assert.ok(b.find((x) => x.code === 'SCAN_MISSING')); // information only
  const p = await ok(h.api().post('/api/equipment/payroll/preview').set(ACC()).send({ start_date: '2026-10-01', end_date: '2026-10-31', equipment_id: F.exc.equipment_id }));
  const it = p.items[0];
  const fd = it.lines.filter((l) => l.line_type === 'FuelPriceDifference');
  assert.strictEqual(fd.length, 1);
  assert.strictEqual(fd[0].amount, '2.00'); // 5 h x 2 L/h x (1.20 - 1.00)
  assert.strictEqual(it.fuel_difference, '2.00');
  batch = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-10-01', end_date: '2026-10-31', equipment_id: F.exc.equipment_id }));
  assert.strictEqual(batch.items[0].rate_snapshot.fuel_diff.days.length, 1);
  assert.strictEqual(batch.items[0].rate_snapshot.labels.vendor_name, 'Al-Bunyan Heavy Equipment');
});

test('finalize needs the signed sheet uploaded by the accountant; then invoice numbers are issued', async () => {
  const no = await h.api().patch(`/api/equipment/payroll/batches/${batch.eq_batch_id}/finalize`).set(A());
  assert.strictEqual(no.body.code, 'SCAN_MISSING');
  const accFin = await h.api().patch(`/api/equipment/payroll/batches/${batch.eq_batch_id}/finalize`).set(ACC());
  assert.strictEqual(accFin.status, 403); // Admin finalizes
  const sheets = await ok(h.api().get(`/api/equipment/timesheets?month=2026-10&equipment_id=${F.exc.equipment_id}`).set(ACC()));
  await ok(h.api().post(`/api/equipment/timesheets/${sheets[0].timesheet_id}/scans`).set(ACC()).attach('files', await QRCode.toBuffer('signed'), 'scan.png'));
  const fin = await ok(h.api().patch(`/api/equipment/payroll/batches/${batch.eq_batch_id}/finalize`).set(A()));
  const nos = fin.invoices.map((i) => i.invoice_no).sort();
  assert.deepStrictEqual(nos, ['FD-2026-00001', 'MI-2026-00001', 'VI-2026-00001']);
  assert.strictEqual(fin.items[0].fuel_invoice_no, 'FD-2026-00001');
  for (const view of ['summary', 'vendor', 'machine', 'fueldiff']) {
    const r = await bin(h.api().get(`/api/equipment/payroll/batches/${batch.eq_batch_id}/export.pdf?view=${view}`).set(ACC()));
    assert.strictEqual(r.status, 200, view);
    assert.strictEqual(r.body.slice(0, 4).toString(), '%PDF');
    if (process.env.DUMP_PDF) require('fs').writeFileSync(`${process.env.DUMP_PDF}/${view}.pdf`, r.body);
  }
  const x = await bin(h.api().get(`/api/equipment/payroll/batches/${batch.eq_batch_id}/export.xlsx`).set(ACC()));
  assert.strictEqual(x.status, 200);
});

test('used fuel terms and prices cannot be rewritten', async () => {
  const t = await h.api().post(`/api/equipment/machines/${F.exc.equipment_id}/fuel-terms`).set(A()).send({ effective_from: '2026-10-10', base_price_per_liter: 1.1, liters_per_hour: 2 });
  assert.strictEqual(t.body.code, 'PAYROLL_PERIOD_FINALIZED');
  const prices = await ok(h.api().get('/api/equipment/fuel-prices').set(ACC()));
  const del = await h.api().delete(`/api/equipment/fuel-prices/${prices[0].fuel_price_id}`).set(A());
  assert.strictEqual(del.body.code, 'PAYROLL_PERIOD_FINALIZED');
  await ok(h.api().post(`/api/equipment/machines/${F.exc.equipment_id}/fuel-terms`).set(A()).send({ effective_from: '2026-11-01', base_price_per_liter: 1.2, liters_per_hour: 2.5 }));
  const terms = await ok(h.api().get(`/api/equipment/machines/${F.exc.equipment_id}/fuel-terms`).set(A()));
  assert.strictEqual(terms.length, 2);
  assert.strictEqual(terms[1].effective_to, '2026-10-31'); // history kept, old terms closed
});

test('official price below the base price: the difference is deducted', () => {
  const { fuelDifference } = require('../services/equipment/eqPayrollService');
  const perRow = [{ work: 600, row: { record_date: '2026-12-02' } }]; // 10 h
  const terms = [{ fuel_terms_id: 1, equipment_id: 7, effective_from: '2026-01-01', effective_to: null, base_price_per_liter: '1.000', liters_per_hour: '2' }];
  const prices = [{ fuel_price_id: 1, currency: 'USD', effective_from: '2026-12-01', price_per_liter: '0.900' }];
  const r = fuelDifference(perRow, 7, 'USD', terms, prices, true);
  assert.strictEqual(r.lines[0].amount_cents, -200); // 10 h x 2 L/h x (0.90 - 1.00) = -2.00
  assert.strictEqual(r.days[0].amount, -2);
});
