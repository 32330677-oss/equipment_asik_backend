// P33 — hours since the start, per machine and vendor: invoiced + approved not invoiced yet, never twice.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, standardFleet, A, S8 } = require('./fixtures');
const BD = require('../utils/businessDate');

BD.setClock(() => new Date(Date.UTC(2026, 10, 20, 9, 0, 0))); // 2026-11-20 12:00
const ACC = () => h.auth(h.T.accountant());
const bin = (req) => req.buffer(true).parse((res, cb) => { const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); });
let F;

async function workDay(m, date, approve = true, out = '15:00') {
  const r = await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: m.equipment_id, site_id: 8, check_in_time: `${date} 07:00`, check_out_time: `${date} ${out}`, late_reason: 'paper sheet typed late' }));
  await ok(h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: date }));
  if (approve) await ok(h.api().post('/api/equipment/admin/attendance/approve').set(A()).send({ ids: [r.eq_attendance_id] }));
  return r.eq_attendance_id;
}

before(async () => {
  await h.resetDatabase();
  await h.query("UPDATE settings SET setting_value = 'false' WHERE setting_key = 'eq_finalize_requires_scan'");
  require('../services/settings').invalidate();
  F = await standardFleet();
  await workDay(F.exc, '2026-10-05');
  await workDay(F.exc, '2026-10-06', true, '18:00'); // overtime day
  const oct = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-10-01', end_date: '2026-10-31', equipment_id: F.exc.equipment_id }));
  await h.issue(oct.eq_batch_id);
  await workDay(F.exc, '2026-11-10');
  await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-11-01', end_date: '2026-11-15', equipment_id: F.exc.equipment_id })); // draft
  await workDay(F.exc, '2026-11-17'); // approved, not in any invoice
  await workDay(F.loader, '2026-11-12');
  await workDay(F.exc, '2026-11-19', false); // waiting for approval
});
after(h.closePool);

test('hours report: invoiced + not invoiced, OT split, totals per vendor', async () => {
  const d = await ok(h.api().get('/api/equipment/reports/hours').set(ACC()));
  const items = await h.query('SELECT equipment_id, SUM(work_hours) w, SUM(overtime_hours) o FROM eq_payroll_items GROUP BY equipment_id');
  const all = d.vendors.flatMap((g) => g.machines);
  const exc = all.find((m) => m.equipment_id === F.exc.equipment_id);
  const ld = all.find((m) => m.equipment_id === F.loader.equipment_id);
  const ei = items.find((i) => i.equipment_id === F.exc.equipment_id);
  assert.strictEqual(exc.invoiced_hours, Number(ei.w));
  assert.ok(exc.overtime_hours > 0);
  assert.ok(exc.not_invoiced_hours > 0);
  assert.strictEqual(exc.total_hours, Math.round((exc.invoiced_hours + exc.not_invoiced_hours) * 100) / 100);
  assert.strictEqual(exc.rows_waiting_approval, 1);
  assert.ok(ld.not_invoiced_hours > 0 && ld.invoiced_hours === 0);
  for (const g of d.vendors) assert.strictEqual(g.totals.total_hours, Math.round(g.machines.reduce((a, m) => a + m.total_hours, 0) * 100) / 100);
  assert.deepStrictEqual(d.errors, []);
  // amounts: invoiced net = the invoices, not invoiced = the provisional calculation, parts add up, totals per currency
  const net = await h.query('SELECT i.equipment_id, b.currency, SUM(i.net_amount) n FROM eq_payroll_items i JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id GROUP BY i.equipment_id, b.currency');
  const PS = require('../services/equipment/eqPayrollService');
  const { pool } = require('../config/db');
  const { items: pend } = await PS.calculate(pool, { start_date: '2026-01-01', end_date: '2026-11-20' });
  for (const m of all) {
    for (const x of m.money) {
      const inv = net.filter((r) => r.equipment_id === m.equipment_id && r.currency === x.currency).reduce((a, r) => a + Number(r.n), 0);
      const p = pend.filter((i) => i.equipment_id === m.equipment_id && i.currency === x.currency).reduce((a, i) => a + i.net_cents, 0) / 100;
      assert.strictEqual(x.invoiced_net, inv, `invoiced ${m.equipment_code}`);
      assert.strictEqual(x.not_invoiced_net, p, `not invoiced ${m.equipment_code}`);
      assert.strictEqual(Math.round((x.regular + x.overtime + x.other) * 100), Math.round(x.total * 100));
      assert.strictEqual(Math.round((x.invoiced_net + x.not_invoiced_net) * 100), Math.round(x.total * 100));
    }
  }
  assert.ok(exc.money[0].overtime > 0 && exc.money[0].regular > 0);
  for (const g of d.vendors) for (const t of g.money) assert.strictEqual(Math.round(t.total * 100), Math.round(g.machines.flatMap((m) => m.money).filter((x) => x.currency === t.currency).reduce((a, x) => a + x.total, 0) * 100));
  // vendor filter
  const v = await ok(h.api().get('/api/equipment/reports/hours').query({ vendor_id: F.vendor.vendor_id }).set(ACC()));
  assert.ok(v.vendors.every((g) => g.vendor_id === F.vendor.vendor_id));
  // one machine
  const one = await ok(h.api().get('/api/equipment/reports/hours').query({ equipment_id: F.exc.equipment_id }).set(ACC()));
  assert.strictEqual(one.vendors.length, 1);
  assert.strictEqual(one.vendors[0].machines.length, 1);
  assert.deepStrictEqual(one.vendors[0].machines[0], exc);
});

test('hours report: PDF and Excel', async () => {
  const pdf = await bin(h.api().get('/api/equipment/reports/hours').query({ format: 'pdf' }).set(ACC()));
  assert.strictEqual(pdf.status, 200);
  assert.strictEqual(pdf.body.slice(0, 4).toString(), '%PDF');
  require('fs').writeFileSync('/tmp/hours.pdf', pdf.body);
  const p1 = await bin(h.api().get('/api/equipment/reports/hours').query({ format: 'pdf', equipment_id: F.exc.equipment_id }).set(ACC()));
  assert.strictEqual(p1.status, 200);
  require('fs').writeFileSync('/tmp/hours1.pdf', p1.body);
  const x = await bin(h.api().get('/api/equipment/reports/hours').query({ format: 'xlsx' }).set(ACC()));
  assert.strictEqual(x.status, 200);
  assert.strictEqual(x.body.slice(0, 2).toString(), 'PK');
  const sup = await h.api().get('/api/equipment/reports/hours').set(S8());
  assert.strictEqual(sup.status, 403);
});
