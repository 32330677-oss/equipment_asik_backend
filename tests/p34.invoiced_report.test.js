// P34 — "all invoiced" report (view=invoiced): only invoices, one line per machine, totals per vendor and grand total.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, standardFleet, A, S8 } = require('./fixtures');
const BD = require('../utils/businessDate');

BD.setClock(() => new Date(Date.UTC(2026, 10, 20, 9, 0, 0))); // 2026-11-20 12:00
const ACC = () => h.auth(h.T.accountant());
const bin = (req) => req.buffer(true).parse((res, cb) => { const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); });
let F;

async function workDay(m, date, out = '15:00') {
  const r = await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: m.equipment_id, site_id: 8, check_in_time: `${date} 07:00`, check_out_time: `${date} ${out}`, late_reason: 'paper sheet typed late' }));
  await ok(h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: date }));
  await ok(h.api().post('/api/equipment/admin/attendance/approve').set(A()).send({ ids: [r.eq_attendance_id] }));
}

before(async () => {
  await h.resetDatabase();
  await h.query("UPDATE settings SET setting_value = 'false' WHERE setting_key = 'eq_finalize_requires_scan'");
  require('../services/settings').invalidate();
  F = await standardFleet();
  await workDay(F.exc, '2026-10-05');
  await workDay(F.exc, '2026-10-06', '18:00'); // overtime day
  await workDay(F.loader, '2026-10-07');
  const oct = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-10-01', end_date: '2026-10-31', vendor_id: F.vendor.vendor_id }));
  await h.issue(oct.eq_batch_id);
  await workDay(F.exc, '2026-11-10');
  await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-11-01', end_date: '2026-11-15', equipment_id: F.exc.equipment_id })); // draft
  await workDay(F.exc, '2026-11-17'); // approved, NOT invoiced: not in this report
});
after(h.closePool);

test('invoiced report: only invoices, one line per machine, totals add up', async () => {
  const d = await ok(h.api().get('/api/equipment/reports/hours').query({ view: 'invoiced' }).set(ACC()));
  assert.strictEqual(d.invoices, 2);
  assert.strictEqual(d.draft_invoices, 1);
  const all = d.vendors.flatMap((g) => g.machines);
  const items = await h.query(`SELECT i.equipment_id, b.currency, SUM(i.net_amount) n, SUM(i.work_hours) w, SUM(i.overtime_hours) o, COUNT(DISTINCT i.eq_batch_id) c
    FROM eq_payroll_items i JOIN eq_payroll_batches b ON b.eq_batch_id = i.eq_batch_id WHERE b.status IN ('Generated','HandedOver','Returned') GROUP BY i.equipment_id, b.currency`);
  assert.strictEqual(all.length, items.length);
  for (const it of items) {
    const m = all.find((x) => x.equipment_id === it.equipment_id && x.currency === it.currency);
    assert.ok(m, `machine ${it.equipment_id}`);
    assert.strictEqual(m.net, Number(it.n));
    assert.strictEqual(m.total_hours, Number(it.w));
    assert.strictEqual(m.invoices, Number(it.c));
    assert.strictEqual(Math.round((m.regular + m.overtime + m.additions + m.deductions) * 100), Math.round(m.net * 100));
  }
  const exc = all.find((m) => m.equipment_id === F.exc.equipment_id);
  assert.strictEqual(exc.invoices, 2);
  assert.ok(exc.overtime_hours > 0 && exc.overtime > 0);
  assert.strictEqual(exc.last_day, '2026-11-10'); // the 17th is not invoiced
  assert.strictEqual(exc.first_day, '2026-10-05');
  for (const g of d.vendors) {
    for (const t of g.money) {
      const ms = g.machines.filter((m) => m.currency === t.currency);
      assert.strictEqual(Math.round(t.net * 100), Math.round(ms.reduce((a, m) => a + m.net, 0) * 100));
      assert.strictEqual(t.total_hours, Math.round(ms.reduce((a, m) => a + m.total_hours, 0) * 100) / 100);
    }
  }
  for (const t of d.money) {
    assert.strictEqual(Math.round(t.net * 100), Math.round(d.vendors.flatMap((g) => g.money).filter((x) => x.currency === t.currency).reduce((a, x) => a + x.net, 0) * 100));
  }
  // filters
  const one = await ok(h.api().get('/api/equipment/reports/hours').query({ view: 'invoiced', equipment_id: F.loader.equipment_id }).set(ACC()));
  assert.strictEqual(one.vendors.length, 1);
  assert.deepStrictEqual(one.vendors[0].machines.map((m) => m.equipment_id), [F.loader.equipment_id]);
  // the default view is unchanged
  const def = await ok(h.api().get('/api/equipment/reports/hours').set(ACC()));
  assert.ok(def.vendors[0].machines[0].not_invoiced_hours !== undefined);
});

test('invoiced report: PDF and Excel, office only', async () => {
  const pdf = await bin(h.api().get('/api/equipment/reports/hours').query({ view: 'invoiced', format: 'pdf' }).set(ACC()));
  assert.strictEqual(pdf.status, 200);
  assert.strictEqual(pdf.body.slice(0, 4).toString(), '%PDF');
  assert.match(String(pdf.headers['content-disposition']), /equipment-invoiced-since-start/);
  const x = await bin(h.api().get('/api/equipment/reports/hours').query({ view: 'invoiced', format: 'xlsx' }).set(ACC()));
  assert.strictEqual(x.status, 200);
  assert.strictEqual(x.body.slice(0, 2).toString(), 'PK');
  const empty = await bin(h.api().get('/api/equipment/reports/hours').query({ view: 'invoiced', format: 'pdf', vendor_id: 999999 }).set(ACC()));
  assert.strictEqual(empty.status, 200);
  const bad = await h.api().get('/api/equipment/reports/hours').query({ view: 'nope' }).set(ACC());
  assert.ok([400, 422].includes(bad.status), String(bad.status));
  const sup = await h.api().get('/api/equipment/reports/hours').query({ view: 'invoiced' }).set(S8());
  assert.strictEqual(sup.status, 403);
});
