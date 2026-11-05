// P42 — vendor invoice PDF columns (4 Nov 2026, display only, as the "All invoiced" report): Regular amount = the work
// as calculated (a monthly machine after its missing days), OT, Fuel and Fuel diff. apart, Additions / Deductions =
// only the adjustments typed in the system; the totals box deducts the fuel and the "Deduct" adjustments; the net and
// everything saved stay as they are.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, standardFleet, A, S8 } = require('./fixtures');
const BD = require('../utils/businessDate');
const P = require('../services/pdfKit');

BD.setClock(() => new Date(Date.UTC(2026, 10, 20, 9, 0, 0))); // 2026-11-20 12:00
const ACC = () => h.auth(h.T.accountant());
const bin = (req) => req.buffer(true).parse((res, cb) => { const b = []; res.on('data', (c) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
let F; let BATCH;

async function workDay(m, date, out = '15:00') {
  const r = await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: m.equipment_id, site_id: 8, check_in_time: `${date} 07:00`, check_out_time: `${date} ${out}`, late_reason: 'paper sheet typed late' }));
  await ok(h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: date }));
  await ok(h.api().post('/api/equipment/admin/attendance/approve').set(A()).send({ ids: [r.eq_attendance_id] }));
}

before(async () => {
  await h.resetDatabase();
  await h.query("UPDATE settings SET setting_value = 'false' WHERE setting_key = 'eq_finalize_requires_scan'");
  await h.query("UPDATE settings SET setting_value = 'false' WHERE setting_key = 'eq_block_monthly_days_without_rows'");
  require('../services/settings').invalidate();
  F = await standardFleet();
  await workDay(F.exc, '2026-10-05');
  await workDay(F.exc, '2026-10-06', '18:00'); // overtime day
  await workDay(F.crane, '2026-10-05'); // monthly machine: one day only
  await ok(h.api().post('/api/equipment/adjustments').set(ACC()).send({ equipment_id: F.exc.equipment_id, site_id: 8, adjustment_date: '2026-10-15', adjustment_type: 'Bonus', amount: 25, reason: 'bonus' }));
  await ok(h.api().post('/api/equipment/adjustments').set(ACC()).send({ equipment_id: F.exc.equipment_id, site_id: 8, adjustment_date: '2026-10-16', adjustment_type: 'Penalty', amount: -15, reason: 'penalty' }));
  await ok(h.api().post('/api/equipment/fuel-issues').set(ACC()).send({ equipment_id: F.exc.equipment_id, site_id: 8, issue_date: '2026-10-05', liters: 50, price_per_liter: 1 }));
  const g = await h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-10-01', end_date: '2026-10-31', vendor_id: F.vendor.vendor_id, accept_blockers: true, accept_blockers_reason: 'test of the vendor invoice columns' });
  assert.strictEqual(g.status, 201, JSON.stringify(g.body));
  BATCH = g.body.data.eq_batch_id;
});
after(h.closePool);

/** Renders the vendor PDF and records the machines table and the texts drawn (the PDF itself is compressed). */
async function render() {
  const tables = []; const texts = [];
  const table = P.table; const text = P.text;
  P.table = (doc, o) => { tables.push(o); return table(doc, o); };
  P.text = (doc, s, ...rest) => { texts.push(String(s)); return text(doc, s, ...rest); };
  try {
    const r = await bin(h.api().get(`/api/equipment/payroll/batches/${BATCH}/export.pdf`).query({ view: 'vendor', vendor_id: F.vendor.vendor_id }).set(ACC()));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.slice(0, 4).toString(), '%PDF');
    require('fs').writeFileSync('/tmp/vendor-columns.pdf', r.body);
  } finally { P.table = table; P.text = text; }
  return { machines: tables.find((t) => t.columns.some((c) => c.key === 'ra')), texts };
}

test('vendor invoice: adjustments only in Additions / Deductions, fuel apart, the work in Regular amount, net unchanged', async () => {
  const saved = await h.query('SELECT eq_item_id, gross_amount, deductions_amount, net_amount FROM eq_payroll_items WHERE eq_batch_id = ? ORDER BY eq_item_id', [BATCH]);
  const { machines, texts } = await render();
  const keys = machines.columns.map((c) => c.key);
  assert.deepStrictEqual(keys.slice(-6), ['oa', 'fuel', 'fd', 'add', 'ded', 'net']);
  assert.ok(!keys.includes('oth') && !keys.includes('adj'));
  assert.strictEqual(machines.columns.find((c) => c.key === 'ra').en, 'Regular amount');
  const exc = machines.rows.find((r) => String(r.m).startsWith(F.exc.equipment_code));
  const crane = machines.rows.find((r) => String(r.m).startsWith(F.crane.equipment_code));
  assert.deepStrictEqual([exc.ra, exc.fuel, exc.add, exc.ded, exc.net], ['720.00', '-50.00', '25.00', '-15.00', '730.00']);
  assert.deepStrictEqual([crane.ra, crane.fuel, crane.add, crane.ded, crane.net], ['250.00', '-', '-', '-', '250.00']);
  const totals = machines.rows.find((r) => r.m === 'Totals');
  assert.deepStrictEqual([totals.ra, totals.oa, totals.fuel, totals.add, totals.ded, totals.net], ['970.00', '50.00', '-50.00', '25.00', '-15.00', '980.00']);
  // totals box: deductions = fuel 50 + "Deduct" 15; earnings - deductions = the stored net
  assert.ok(texts.includes('1,045.00'), 'total earnings and additions');
  assert.ok(texts.includes('-65.00'), 'total deductions');
  assert.ok(texts.includes('980.00'), 'net');
  // nothing saved changed
  assert.deepStrictEqual(await h.query('SELECT eq_item_id, gross_amount, deductions_amount, net_amount FROM eq_payroll_items WHERE eq_batch_id = ? ORDER BY eq_item_id', [BATCH]), saved);
});
