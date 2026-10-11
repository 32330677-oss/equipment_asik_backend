// P22b — decisions of 11 Oct 2026:
//  A. an Admin applies a correction at once; an Accountant's correction waits for an Admin (an Accountant never approves).
//  B. before the lock the office changes everything without a mandatory reason; a draft batch is recalculated in one step.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { ok, standardFleet, A, S8 } = require('./fixtures');
const BD = require('../utils/businessDate');

BD.setClock(() => new Date(Date.UTC(2026, 10, 20, 9, 0, 0))); // 2026-11-20 12:00
const ACC = () => h.auth(h.T.accountant());
const code = async (req) => (await req).body.code;
let F; let oct; let paidRow;

async function workDay(m, date, inT, outT, approve = true) {
  const r = await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: m.equipment_id, site_id: 8, check_in_time: `${date} ${inT}`, check_out_time: `${date} ${outT}`, late_reason: 'paper sheet typed late' }));
  await ok(h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: date }));
  if (approve) await ok(h.api().post('/api/equipment/admin/attendance/approve').set(A()).send({ ids: [r.eq_attendance_id] }));
  return r.eq_attendance_id;
}

before(async () => {
  await h.resetDatabase();
  await h.query("UPDATE settings SET setting_value = 'false' WHERE setting_key = 'eq_finalize_requires_scan'");
  require('../services/settings').invalidate();
  F = await standardFleet();
  paidRow = await workDay(F.exc, '2026-10-05', '07:00', '15:00');
  await workDay(F.exc, '2026-10-06', '07:00', '15:00');
  oct = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-10-01', end_date: '2026-10-31', equipment_id: F.exc.equipment_id }));
  await ok(h.api().patch(`/api/equipment/payroll/batches/${oct.eq_batch_id}/finalize`).set(A()).send({ acknowledge_changes: true }));
});
after(h.closePool);

test('A: an Admin\'s correction is applied at once (attendance and financial)', async () => {
  const c = await ok(h.api().post(`/api/equipment/admin/attendance/${paidRow}/correction`).set(A()).send({ reason: 'Signed sheet shows 16:00', changes: { check_out_time: '2026-10-05 16:00' } }));
  assert.strictEqual(c.request_status, 'Approved');
  assert.deepStrictEqual(c.events.map((e) => e.action), ['request', 'approve']);
  assert.ok(c.note && c.note.kind === 'DebitNote');
  const [row] = await h.query('SELECT check_out_time FROM eq_attendance WHERE eq_attendance_id = ?', [paidRow]);
  assert.strictEqual(row.check_out_time, '2026-10-05 16:00:00');
  const b = await ok(h.api().get(`/api/equipment/payroll/batches/${oct.eq_batch_id}`).set(ACC()));
  const fin = await ok(h.api().post('/api/equipment/admin/corrections/financial').set(A())
    .send({ target_type: 'rate_card', target_id: b.items[0].rate_card_id, eq_item_id: b.items[0].eq_item_id, amount: -10, reason: 'Agreed discount' }));
  assert.strictEqual(fin.request_status, 'Approved');
  assert.strictEqual(fin.note.kind, 'CreditNote');
});

test('A: an Accountant\'s correction waits; only an Admin approves it (the Admin may also return it)', async () => {
  const [row2] = await h.query("SELECT eq_attendance_id FROM eq_attendance WHERE equipment_id = ? AND record_date = '2026-10-06'", [F.exc.equipment_id]);
  const c = await ok(h.api().post(`/api/equipment/admin/attendance/${row2.eq_attendance_id}/correction`).set(ACC()).send({ reason: 'Signed sheet shows 15:30', changes: { check_out_time: '2026-10-06 15:30' } }));
  assert.strictEqual(c.request_status, 'Requested');
  const [still] = await h.query('SELECT check_out_time FROM eq_attendance WHERE eq_attendance_id = ?', [row2.eq_attendance_id]);
  assert.strictEqual(still.check_out_time, '2026-10-06 15:00:00', 'nothing changes before the Admin approves');
  assert.strictEqual(await code(h.api().patch(`/api/equipment/admin/corrections/${c.correction_id}/approve`).set(ACC()).send({})), 'ADMIN_APPROVES');
  const ret = await ok(h.api().patch(`/api/equipment/admin/corrections/${c.correction_id}/return`).set(A()).send({ note: 'attach the sheet' }));
  assert.strictEqual(ret.return_count, 1);
  const done = await ok(h.api().patch(`/api/equipment/admin/corrections/${c.correction_id}/approve`).set(A()).send({}));
  assert.strictEqual(done.request_status, 'Approved');
  // an Accountant's financial correction waits too
  const b = await ok(h.api().get(`/api/equipment/payroll/batches/${oct.eq_batch_id}`).set(ACC()));
  const fin = await ok(h.api().post('/api/equipment/admin/corrections/financial').set(ACC())
    .send({ target_type: 'other', eq_item_id: b.items[0].eq_item_id, amount: 5, reason: 'Transport not billed' }));
  assert.strictEqual(fin.request_status, 'Requested');
  assert.strictEqual((await ok(h.api().patch(`/api/equipment/admin/corrections/${fin.correction_id}/approve`).set(A()).send({}))).request_status, 'Approved');
});

test('B: no reason needed before the lock: edit an approved row, void a row, void / recalculate a draft', async () => {
  const id = await workDay(F.exc, '2026-11-10', '07:00', '15:00');
  const extra = await workDay(F.loader, '2026-11-10', '07:00', '15:00');
  const draft = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-11-01', end_date: '2026-11-15', vendor_id: F.vendor.vendor_id }));
  const e = await ok(h.api().patch(`/api/equipment/admin/attendance/${id}`).set(ACC()).send({ check_out_time: '2026-11-10 17:00' }));
  assert.strictEqual(e.status, 'Approved');
  assert.strictEqual(e.edited_after_approval, true);
  assert.strictEqual(e.admin_edit_reason, null);
  const v = await ok(h.api().patch(`/api/equipment/admin/attendance/${extra}/cancel`).set(A()).send({}));
  assert.strictEqual(v.status, 'Cancelled');
  let d = await ok(h.api().get(`/api/equipment/payroll/batches/${draft.eq_batch_id}`).set(ACC()));
  assert.strictEqual(d.stale, true);
  assert.strictEqual(await code(h.api().patch(`/api/equipment/payroll/batches/${draft.eq_batch_id}/finalize`).set(A()).send({ acknowledge_changes: true })), 'BATCH_STALE');
  // Recalculate = a new version of the draft, same scope, no reason
  const r = await h.api().post(`/api/equipment/payroll/batches/${draft.eq_batch_id}/supersede`).set(ACC()).send({});
  assert.strictEqual(r.status, 201, r.text);
  const nv = r.body.data;
  assert.strictEqual(nv.version_number, 2);
  assert.strictEqual(nv.supersedes_batch_id, draft.eq_batch_id);
  assert.strictEqual(nv.is_finalized, false);
  assert.strictEqual(nv.stale, false);
  assert.strictEqual(nv.invoices.length, 0, 'a draft has no official numbers');
  assert.ok(Number(nv.total_net) > Number(draft.total_net) - 1000);
  assert.ok(!nv.items.find((i) => i.equipment_id === F.loader.equipment_id), 'the voided row is gone');
  assert.ok(nv.items.find((i) => i.equipment_id === F.exc.equipment_id));
  d = await ok(h.api().get(`/api/equipment/payroll/batches/${draft.eq_batch_id}`).set(ACC()));
  assert.strictEqual(d.status, 'Superseded');
  // a draft is voided without a reason
  const vd = await ok(h.api().patch(`/api/equipment/payroll/batches/${nv.eq_batch_id}/void`).set(ACC()).send({}));
  assert.strictEqual(vd.status, 'Voided');
});

test('B: a recalculated draft keeps the blockers that were accepted', async () => {
  await workDay(F.crane, '2026-11-12', '07:00', '15:00', false); // submitted, not approved
  const scope = { start_date: '2026-11-01', end_date: '2026-11-15', equipment_id: F.crane.equipment_id };
  assert.strictEqual(await code(h.api().post('/api/equipment/payroll/generate').set(ACC()).send(scope)), 'BLOCKERS_PRESENT');
  const draft = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ ...scope, accept_blockers: true, accept_reason: 'sheet still on site' }));
  const r = await h.api().post(`/api/equipment/payroll/batches/${draft.eq_batch_id}/supersede`).set(ACC()).send({});
  assert.strictEqual(r.status, 201, r.text);
  assert.match(r.body.data.accept_blockers_reason, /NOT_APPROVED: sheet still on site/);
  await ok(h.api().patch(`/api/equipment/payroll/batches/${r.body.data.eq_batch_id}/void`).set(ACC()).send({}));
});

test('B: once finalized, void and new version still need a reason', async () => {
  assert.strictEqual(await code(h.api().patch(`/api/equipment/payroll/batches/${oct.eq_batch_id}/void`).set(A()).send({})), 'VALIDATION_ERROR');
  assert.strictEqual(await code(h.api().post(`/api/equipment/payroll/batches/${oct.eq_batch_id}/supersede`).set(A()).send({})), 'VALIDATION_ERROR');
});
