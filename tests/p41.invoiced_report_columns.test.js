// P41 — "All invoiced" report columns (2 Nov 2026, display only): Regular amount = the work as calculated (a monthly
// machine after its missing hours / absence), OT apart, Fuel and Fuel difference apart, Additions / Deductions = only the
// adjustments typed in the system. The net is the stored one and the columns add up to it.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, standardFleet, A, S8 } = require('./fixtures');
const BD = require('../utils/businessDate');

BD.setClock(() => new Date(Date.UTC(2026, 10, 20, 9, 0, 0))); // 2026-11-20 12:00
const ACC = () => h.auth(h.T.accountant());
let F;

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
  await workDay(F.crane, '2026-10-05'); // monthly machine: one day only, the rest of the month is missing
  await ok(h.api().post('/api/equipment/adjustments').set(ACC()).send({ equipment_id: F.exc.equipment_id, site_id: 8, adjustment_date: '2026-10-15', adjustment_type: 'Bonus', amount: 25, reason: 'bonus' }));
  await ok(h.api().post('/api/equipment/adjustments').set(ACC()).send({ equipment_id: F.exc.equipment_id, site_id: 8, adjustment_date: '2026-10-16', adjustment_type: 'Penalty', amount: -15, reason: 'penalty' }));
  await ok(h.api().post('/api/equipment/fuel-issues').set(ACC()).send({ equipment_id: F.exc.equipment_id, site_id: 8, issue_date: '2026-10-05', liters: 50, price_per_liter: 1 }));
  const g = await h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-10-01', end_date: '2026-10-31', vendor_id: F.vendor.vendor_id, accept_blockers: true, accept_blockers_reason: 'test of the report columns' });
  assert.strictEqual(g.status, 201, JSON.stringify(g.body));
});
after(h.closePool);

const sumLines = async (equipmentId, where) => Number((await h.query(
  `SELECT COALESCE(SUM(l.amount), 0) s FROM eq_payroll_lines l JOIN eq_payroll_items i ON i.eq_item_id = l.eq_item_id WHERE i.equipment_id = ? AND ${where}`, [equipmentId]))[0].s);

test('columns: adjustments only in Additions / Deductions, fuel apart, the work in Regular, the net unchanged', async () => {
  const d = await ok(h.api().get('/api/equipment/reports/hours').query({ view: 'invoiced', from: '2026-10-01', to: '2026-10-31' }).set(ACC()));
  const all = d.vendors.flatMap((g) => g.machines);
  assert.ok(all.length >= 2);
  for (const m of all) {
    const id = m.equipment_id;
    const [{ n }] = await h.query('SELECT SUM(net_amount) n FROM eq_payroll_items WHERE equipment_id = ?', [id]);
    assert.strictEqual(m.net, Number(n), `stored net ${m.equipment_code}`);
    assert.strictEqual(Math.round((m.regular + m.overtime + m.fuel + m.fuel_diff + m.additions + m.deductions) * 100), Math.round(m.net * 100), `columns add up ${m.equipment_code}`);
    assert.strictEqual(m.overtime, await sumLines(id, "l.line_type = 'Overtime'"));
    assert.strictEqual(m.fuel, await sumLines(id, "l.line_type = 'Fuel'"));
    assert.strictEqual(m.fuel_diff, await sumLines(id, "l.line_type = 'FuelPriceDifference'"));
    assert.strictEqual(m.additions, await sumLines(id, "l.line_type = 'Adjustment' AND l.amount > 0"));
    assert.strictEqual(m.deductions, await sumLines(id, "l.line_type = 'Adjustment' AND l.amount < 0"));
  }
  const exc = all.find((m) => m.equipment_id === F.exc.equipment_id);
  assert.strictEqual(exc.additions, 25);
  assert.strictEqual(exc.deductions, -15);
  assert.ok(exc.overtime > 0);
  // the monthly machine: its missing days are inside Regular amount, not in Deductions
  const crane = all.find((m) => m.equipment_id === F.crane.equipment_id);
  const calcDed = await sumLines(F.crane.equipment_id, "l.line_type IN ('AbsenceDeduction','BreakdownDeduction','HoursShortfall')");
  assert.ok(calcDed < 0, 'the calculation deducted the missing days');
  assert.strictEqual(crane.deductions, 0);
  assert.strictEqual(crane.additions, 0);
  assert.strictEqual(crane.regular, Math.round((crane.net - crane.overtime - crane.fuel - crane.fuel_diff) * 100) / 100);
  // totals per vendor and currency add up the same way
  for (const g of d.vendors) {
    for (const t of g.money) {
      assert.strictEqual(Math.round((t.regular + t.overtime + t.fuel + t.fuel_diff + t.additions + t.deductions) * 100), Math.round(t.net * 100));
    }
  }
});

test('PDF and Excel of the report', async () => {
  const bin = (req) => req.buffer(true).parse((res, cb) => { const b = []; res.on('data', (c) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
  const pdf = await bin(h.api().get('/api/equipment/reports/hours').query({ view: 'invoiced', format: 'pdf', from: '2026-10-01', to: '2026-10-31' }).set(ACC()));
  assert.strictEqual(pdf.status, 200);
  require('fs').writeFileSync('/tmp/invoiced-columns.pdf', pdf.body);
  const x = await bin(h.api().get('/api/equipment/reports/hours').query({ view: 'invoiced', format: 'xlsx' }).set(ACC()));
  assert.strictEqual(x.status, 200);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(x.body);
  const head = wb.worksheets[0].getRow(1).values.filter(Boolean);
  assert.deepStrictEqual(head.slice(-7), ['Regular amount', 'OT amount', 'Fuel', 'Fuel diff.', 'Additions', 'Deductions', 'Net invoiced']);
});
