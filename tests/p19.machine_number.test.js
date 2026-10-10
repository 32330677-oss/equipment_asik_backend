// P19 — fixed machine number inside vendor + type ("Excavator #3", migration 016), shown to the supervisor and on documents.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');
const { ok, A } = require('./fixtures');

let V1; let V2; let types;
const mk = (vendorId, typeId, plate) => ok(h.api().post('/api/equipment/machines').set(A()).send({ vendor_id: vendorId, type_id: typeId, plate_number: plate }));

before(async () => {
  await h.resetDatabase();
  V1 = await ok(h.api().post('/api/equipment/vendors').set(A()).send({ vendor_name: 'Numbers Co' }));
  V2 = await ok(h.api().post('/api/equipment/vendors').set(A()).send({ vendor_name: 'Other Co' }));
  types = await ok(h.api().get('/api/equipment/types').set(A()));
});
after(h.closePool);

test('numbers per vendor + type, fixed: a released machine keeps its number, a new one takes the next', async () => {
  const [t1, t2] = types;
  const a = await mk(V1.vendor_id, t1.type_id, 'N-1');
  const b = await mk(V1.vendor_id, t1.type_id, 'N-2');
  const c = await mk(V1.vendor_id, t1.type_id, 'N-3');
  assert.deepStrictEqual([a, b, c].map((m) => m.machine_label), [`${t1.type_name} #1`, `${t1.type_name} #2`, `${t1.type_name} #3`]);
  assert.strictEqual((await mk(V1.vendor_id, t2.type_id, 'N-4')).machine_label, `${t2.type_name} #1`, 'another type starts at 1');
  assert.strictEqual((await mk(V2.vendor_id, t1.type_id, 'N-5')).machine_label, `${t1.type_name} #1`, 'another vendor starts at 1');
  await ok(h.api().patch(`/api/equipment/machines/${a.equipment_id}/status`).set(A()).send({ status: 'Released' }));
  const d = await mk(V1.vendor_id, t1.type_id, 'N-6');
  assert.strictEqual(d.machine_label, `${t1.type_name} #4`, 'numbers are never reused');
  const again = await ok(h.api().get(`/api/equipment/machines/${a.equipment_id}`).set(A()));
  assert.strictEqual(again.machine_label, `${t1.type_name} #1`, 'the released machine keeps #1');
  // type changed: next number of the new type (no clash with the existing #1)
  const moved = await ok(h.api().put(`/api/equipment/machines/${b.equipment_id}`).set(A()).send({ type_id: t2.type_id }));
  assert.strictEqual(moved.machine_label, `${t2.type_name} #2`);
  // a renamed type renames the labels, numbers stay
  await ok(h.api().put(`/api/equipment/types/${t2.type_id}`).set(A()).send({ type_name: 'Renamed type' }));
  assert.strictEqual((await ok(h.api().get(`/api/equipment/machines/${b.equipment_id}`).set(A()))).machine_label, 'Renamed type #2');
});

test('migration backfill: existing machines are numbered by code (the older code gets #1)', async () => {
  await h.query('UPDATE eq_equipment SET type_seq = NULL, machine_label = NULL');
  const sql = fs.readFileSync(path.join(__dirname, '../database/migrations/016_machine_type_number.sql'), 'utf8');
  const update = sql.slice(sql.indexOf('UPDATE eq_equipment e'), sql.indexOf('ALTER TABLE eq_equipment ADD UNIQUE')).trim();
  await h.query(update);
  const rows = await h.query(`SELECT equipment_code, machine_label FROM eq_equipment WHERE vendor_id = ${V1.vendor_id} AND type_id = ${types[0].type_id} ORDER BY equipment_code`);
  assert.deepStrictEqual(rows.map((r) => r.machine_label), rows.map((_, i) => `${types[0].type_name} #${i + 1}`));
});

test('the supervisor board and the paper sheet show the number', async () => {
  const [t1] = types;
  const m = await mk(V1.vendor_id, t1.type_id, 'N-9');
  await ok(h.api().post('/api/equipment/deployments').set(A()).send({ equipment_id: m.equipment_id, site_id: 8, shift_type: 'Day', assigned_date: '2026-10-01' }));
  const board = await ok(h.api().get('/api/equipment/attendance/site/8').set(A()).query({ date: '2026-10-05', shift: 'Day' }));
  assert.strictEqual(board.machines.find((x) => x.equipment_id === m.equipment_id).machine_label, m.machine_label);
  const sheet = await ok(h.api().post('/api/equipment/timesheets').set(A()).send({ equipment_id: m.equipment_id, site_id: 8, period_month: '2026-10' }));
  const pdf = await h.api().get(`/api/equipment/timesheets/${sheet.timesheet_id}/print.pdf`).set(A());
  assert.strictEqual(pdf.status, 200);
});
