// P40 — hours report for a period (from / to, 2 Nov 2026): an invoice counts when its whole period lies inside the dates;
// one that crosses a limit is listed apart, not counted; the not-invoiced part and the rows waiting are those of the
// dates. Without from / to the report is exactly what it was.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, standardFleet, A, S8 } = require('./fixtures');
const BD = require('../utils/businessDate');

BD.setClock(() => new Date(Date.UTC(2026, 10, 20, 9, 0, 0))); // 2026-11-20 12:00
const ACC = () => h.auth(h.T.accountant());
const bin = (req) => req.buffer(true).parse((res, cb) => { const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); });
const get = (q) => ok(h.api().get('/api/equipment/reports/hours').query(q).set(ACC()));
const machine = (d, id) => d.vendors.flatMap((g) => g.machines).find((m) => m.equipment_id === id);
let F; let OCT; let NOV;

async function workDay(m, date, approve = true, out = '15:00') {
  const r = await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: m.equipment_id, site_id: 8, check_in_time: `${date} 07:00`, check_out_time: `${date} ${out}`, late_reason: 'paper sheet typed late' }));
  await ok(h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: date }));
  if (approve) await ok(h.api().post('/api/equipment/admin/attendance/approve').set(A()).send({ ids: [r.eq_attendance_id] }));
}

before(async () => {
  await h.resetDatabase();
  await h.query("UPDATE settings SET setting_value = 'false' WHERE setting_key = 'eq_finalize_requires_scan'");
  require('../services/settings').invalidate();
  F = await standardFleet();
  await workDay(F.exc, '2026-10-05');
  await workDay(F.exc, '2026-10-06', true, '18:00');
  OCT = (await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-10-01', end_date: '2026-10-31', equipment_id: F.exc.equipment_id }))).eq_batch_id;
  await h.issue(OCT);
  await workDay(F.exc, '2026-11-10');
  NOV = (await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-11-01', end_date: '2026-11-15', equipment_id: F.exc.equipment_id }))).eq_batch_id; // draft
  await workDay(F.exc, '2026-11-17'); // approved, not in any invoice
  await workDay(F.loader, '2026-11-12');
  await workDay(F.exc, '2026-11-19', false); // waiting for approval
});
after(h.closePool);

const hoursOf = async (batch, id) => Number((await h.query('SELECT SUM(work_hours) w FROM eq_payroll_items WHERE eq_batch_id = ? AND equipment_id = ?', [batch, id]))[0].w);
const netOf = async (batch) => Number((await h.query('SELECT SUM(net_amount) n FROM eq_payroll_items WHERE eq_batch_id = ?', [batch]))[0].n);

test('without dates nothing changes: since the start, no period, nothing listed apart', async () => {
  for (const view of ['since_start', 'invoiced']) {
    const d = await get({ view });
    assert.strictEqual(d.period, null);
    assert.deepStrictEqual(d.crossing, []);
  }
  const all = await get({ view: 'invoiced' });
  assert.strictEqual(all.invoices, 2);
});

test('all invoiced, October: only the October invoice', async () => {
  const d = await get({ view: 'invoiced', from: '2026-10-01', to: '2026-10-31' });
  assert.deepStrictEqual(d.period, { from: '2026-10-01', to: '2026-10-31' });
  assert.strictEqual(d.invoices, 1);
  assert.strictEqual(d.draft_invoices, 0);
  assert.deepStrictEqual(d.crossing, []);
  const exc = machine(d, F.exc.equipment_id);
  assert.strictEqual(exc.total_hours, await hoursOf(OCT, F.exc.equipment_id));
  assert.strictEqual(d.money[0].net, await netOf(OCT));
  assert.strictEqual(machine(d, F.loader.equipment_id), undefined);
});

test('incl. not invoiced, November: the November draft + approved days of November; rows waiting of November', async () => {
  const d = await get({ from: '2026-11-01', to: '2026-11-30' });
  const exc = machine(d, F.exc.equipment_id);
  assert.strictEqual(exc.invoiced_hours, await hoursOf(NOV, F.exc.equipment_id));
  assert.strictEqual(exc.not_invoiced_hours, 8); // 17/11, 07:00-15:00
  assert.strictEqual(exc.rows_waiting_approval, 1);
  assert.ok(machine(d, F.loader.equipment_id).not_invoiced_hours > 0);
  assert.strictEqual(exc.money[0].invoiced_net, await netOf(NOV));
  // October only: the issued invoice, nothing pending, nothing waiting
  const o = await get({ from: '2026-10-01', to: '2026-10-31' });
  const eo = machine(o, F.exc.equipment_id);
  assert.strictEqual(eo.invoiced_hours, await hoursOf(OCT, F.exc.equipment_id));
  assert.strictEqual(eo.not_invoiced_hours, 0);
  assert.strictEqual(eo.rows_waiting_approval, 0);
});

test('an invoice crossing a limit is listed apart and not counted', async () => {
  const d = await get({ view: 'invoiced', from: '2026-11-10', to: '2026-11-30' });
  assert.strictEqual(d.invoices, 0);
  assert.deepStrictEqual(d.crossing.map((x) => [x.eq_batch_id, x.start_date, x.end_date, x.draft]), [[NOV, '2026-11-01', '2026-11-15', true]]);
  const s = await get({ from: '2026-11-10', to: '2026-11-30' });
  assert.strictEqual(machine(s, F.exc.equipment_id).invoiced_hours, 0);
  assert.strictEqual(s.crossing.length, 1);
  // a single limit works too
  const f = await get({ view: 'invoiced', from: '2026-11-01' });
  assert.strictEqual(f.invoices, 1);
  assert.deepStrictEqual(f.period, { from: '2026-11-01', to: null });
});

test('wrong dates are refused; PDF and Excel of a period', async () => {
  const bad = await h.api().get('/api/equipment/reports/hours').query({ from: '2026-10-31', to: '2026-10-01' }).set(ACC());
  assert.strictEqual(bad.status, 400);
  assert.ok(bad.body.details.fields.to);
  const bad2 = await h.api().get('/api/equipment/reports/hours').query({ from: '31/10/2026' }).set(ACC());
  assert.strictEqual(bad2.status, 400);
  for (const view of ['invoiced', 'since_start']) {
    const pdf = await bin(h.api().get('/api/equipment/reports/hours').query({ view, format: 'pdf', from: '2026-11-10', to: '2026-11-30' }).set(ACC()));
    assert.strictEqual(pdf.status, 200);
    assert.strictEqual(pdf.body.slice(0, 4).toString(), '%PDF');
    require('fs').writeFileSync(`/tmp/hours-period-${view}.pdf`, pdf.body);
    const x = await bin(h.api().get('/api/equipment/reports/hours').query({ view, format: 'xlsx', from: '2026-10-01', to: '2026-10-31' }).set(ACC()));
    assert.strictEqual(x.status, 200);
    assert.strictEqual(x.body.slice(0, 2).toString(), 'PK');
    assert.match(x.headers['content-disposition'], /2026-10-01_2026-10-31/);
  }
});
