// P21 — Daily Equipment Report for an external party: only machines with a check-in on a Working row,
// deliveries of the day, fleet movements, typed info lines; English and Arabic PDFs; supervisor limits.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, standardFleet, A } = require('./fixtures');
const { pool } = require('../config/db');
const R = require('../services/equipment/eqClientReport');

// "now" = 2026-10-20 12:00 (helpers clock)
const ACC = () => h.auth(h.T.accountant());
const S8 = () => h.auth(h.T.sup8());
const S9 = () => h.auth(h.T.sup9());
const URL = '/api/equipment/reports/client-daily.pdf';
let F; let roller; let night;

before(async () => {
  await h.resetDatabase();
  F = await standardFleet(); // exc, loader, crane deployed at S08 Day since 2026-09-01
  // excavator worked, checked out with a work description
  const e = await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: F.exc.equipment_id, site_id: 8, check_in_time: '2026-10-20 07:00', operator_id: F.op1.operator_id }));
  await ok(h.api().post(`/api/equipment/attendance/${e.eq_attendance_id}/check-out`).set(S8()).send({ check_out_time: '2026-10-20 11:30', work_description: 'Excavation of foundation, zone B' }));
  // loader checked in, then broke down: it came and worked -> listed
  const l = await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: F.loader.equipment_id, site_id: 8, check_in_time: '2026-10-20 06:30' }));
  await ok(h.api().post(`/api/equipment/attendance/${l.eq_attendance_id}/downtime/start`).set(S8()).send({ downtime_type: 'Breakdown', start_time: '2026-10-20 09:15', reason: 'pump' }));
  // crane: no check-in -> not listed; its deployment ends today -> Released
  const [[dep]] = await pool.query('SELECT eq_assignment_id FROM eq_site_assignments WHERE equipment_id = ?', [F.crane.equipment_id]);
  await ok(h.api().patch(`/api/equipment/deployments/${dep.eq_assignment_id}/end`).set(A()).send({ unassigned_date: '2026-10-20' }));
  // a new roller arrives at S09 today (Day) and works
  roller = await ok(h.api().post('/api/equipment/machines').set(A()).send({ vendor_id: F.vendor.vendor_id, type_id: 11, plate_number: 'R-77' }));
  await ok(h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: roller.equipment_id, site_id: 9, shift_type: 'Day', assigned_date: '2026-10-20' }));
  await ok(h.api().post('/api/equipment/attendance/check-in').set(S9()).send({ equipment_id: roller.equipment_id, site_id: 9, check_in_time: '2026-10-20 08:10' }));
  // a cancelled deployment (end = start - 1) is not a movement
  const ghost = await ok(h.api().post('/api/equipment/machines').set(A()).send({ vendor_id: F.vendor.vendor_id, type_id: 1, plate_number: 'X-1' }));
  const gd = await ok(h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: ghost.equipment_id, site_id: 9, shift_type: 'Day', assigned_date: '2026-10-20' }));
  await ok(h.api().patch(`/api/equipment/deployments/${gd.eq_assignment_id}/end`).set(A()).send({ unassigned_date: '2026-10-19' }));
  // a night machine at S09 yesterday
  night = await ok(h.api().post('/api/equipment/machines').set(A()).send({ vendor_id: F.vendor.vendor_id, type_id: 2, plate_number: 'N-5' }));
  await ok(h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: night.equipment_id, site_id: 9, shift_type: 'Night', assigned_date: '2026-10-01' }));
  await ok(h.api().post('/api/equipment/attendance/check-in').set(S9()).send({ equipment_id: night.equipment_id, site_id: 9, shift_type: 'Night', check_in_time: '2026-10-19 19:00' }));
  // deliveries today at S08: two trips of sand
  const [sand] = await ok(h.api().post('/api/equipment/dnr-rates').set(ACC()).send({
    vendor_contract_id: F.contract.vendor_contract_id, effective_from: '2026-07-01', items: [{ item_name: 'Sand transport', unit: 'trip', unit_price: 50 }],
  }));
  for (const [n, q] of [['D-1', 1], ['D-2', 1]]) {
    await ok(h.api().post('/api/equipment/delivery-notes').set(ACC()).send({
      equipment_id: F.loader.equipment_id, site_id: 8, dnr_rate_id: sand.dnr_rate_id, dn_number: n, note_date: '2026-10-20', quantity: q,
      material: 'Sand', from_location: 'Quarry', to_location: 'Zone B',
    }));
  }
});
after(h.closePool);

test('the queries return exactly what the report shows', async () => {
  const d = await R.loadData(pool, { date: '2026-10-20', siteIds: [8, 9], shift: 'All' });
  assert.deepStrictEqual(d.sites.map((s) => s.site_code), ['S08', 'S09']);
  assert.deepStrictEqual(d.machines.map((m) => m.plate_number).sort(), ['P-001', 'P-002', 'R-77'], 'the crane did not check in: not listed');
  const exc = d.machines.find((m) => m.plate_number === 'P-001');
  assert.strictEqual(exc.work_description, 'Excavation of foundation, zone B');
  assert.strictEqual(exc.operator_name, 'Ahmad Khaled');
  assert.strictEqual(String(exc.check_in_time).slice(11, 16), '07:00');
  assert.ok(exc.machine_label, 'machine label (type + number) is there');
  assert.strictEqual(d.deliveries.length, 1);
  assert.strictEqual(Number(d.deliveries[0].notes), 2);
  assert.strictEqual(Number(d.deliveries[0].quantity), 2);
  assert.strictEqual(d.deliveries[0].from_location, 'Quarry');
  const mv = d.movements.map((m) => `${m.plate_number}:${m.movement}`).sort();
  assert.deepStrictEqual(mv, ['P-003:Released', 'R-77:Arrived'], 'the cancelled deployment is not a movement');

  // shift filter and site filter
  const day = await R.loadData(pool, { date: '2026-10-19', siteIds: [9], shift: 'Day' });
  assert.strictEqual(day.machines.length, 0);
  const nightRows = await R.loadData(pool, { date: '2026-10-19', siteIds: [9], shift: 'Night' });
  assert.deepStrictEqual(nightRows.machines.map((m) => m.plate_number), ['N-5']);
  // no site given = every active site
  const all = await R.loadData(pool, { date: '2026-10-20', siteIds: [], shift: 'All' });
  assert.deepStrictEqual(all.sites.map((s) => s.site_code), ['S08', 'S09', 'S10']);
});

test('English and Arabic PDFs, with info lines', async () => {
  const notes = JSON.stringify([{ label: 'Weather', value: 'Clear, 31 C' }, { label: 'ملاحظة', value: 'تم إغلاق الطريق المؤدي إلى المنطقة ب من الساعة 10 إلى 11' }]);
  for (const lang of ['en', 'ar']) {
    const r = await h.api().get(URL).set(A()).query({ lang, site_ids: '8,9', to: 'ABC Contracting', issued_by: 'Hamza', issued_title: 'Site Manager', notes });
    assert.strictEqual(r.status, 200, `${lang}: ${r.text}`);
    assert.strictEqual(r.headers['content-type'], 'application/pdf');
    assert.ok(r.body.length > 5000);
    assert.match(r.headers['content-disposition'], new RegExp(`DER-20261020-\\d{4}-${lang.toUpperCase()}\\.pdf`));
  }
  // defaults: today, all active sites, both shifts
  assert.strictEqual((await h.api().get(URL).set(ACC())).status, 200);
});

test('validation: no future date, notes must be a list, unknown site', async () => {
  const code = async (q) => (await h.api().get(URL).set(A()).query(q)).body.code;
  assert.strictEqual(await code({ date: '2026-10-21' }), 'VALIDATION_ERROR');
  assert.strictEqual(await code({ notes: '{bad' }), 'VALIDATION_ERROR');
  assert.strictEqual(await code({ notes: JSON.stringify(Array.from({ length: 21 }, () => ({ label: 'a', value: 'b' }))) }), 'VALIDATION_ERROR');
  assert.strictEqual(await code({ site_ids: '8,abc' }), 'VALIDATION_ERROR');
  assert.strictEqual(await code({ shift: 'Evening' }), 'VALIDATION_ERROR');
  assert.strictEqual((await h.api().get(URL).set(A()).query({ site_ids: '999' })).status, 404);
});

test('a supervisor reports only on his own site and shift', async () => {
  assert.strictEqual((await h.api().get(URL).set(S8()).query({ site_ids: '8', shift: 'Day' })).status, 200);
  assert.strictEqual((await h.api().get(URL).set(S8()).query({ site_ids: '9', shift: 'Day' })).status, 403);
  assert.strictEqual((await h.api().get(URL).set(S8()).query({ site_ids: '8', shift: 'All' })).status, 403, 'S08 has no night supervisor = him');
  assert.strictEqual((await h.api().get(URL).set(S8()).query({ shift: 'Day' })).status, 200, 'no site given = his sites');
  assert.strictEqual((await h.api().get(URL).set(S9()).query({ shift: 'All' })).status, 200);
});
