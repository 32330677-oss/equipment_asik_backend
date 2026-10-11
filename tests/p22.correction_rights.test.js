// P22 — correction rights (policy of 11 Oct 2026): an Admin's correction applies at once (no second person);
// an Accountant's correction waits for an Admin; another Accountant can never approve it.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const QRCode = require('qrcode');
const h = require('./helpers');
const { ok, standardFleet, A, S8 } = require('./fixtures');

require('../utils/businessDate').setClock(() => new Date(Date.UTC(2026, 10, 20, 9, 0, 0)));
const ACC = () => h.auth(h.T.accountant());
const ACC2 = () => h.auth(h.token(5));
const code = async (req) => (await req).body.code;
let F; let oct; const rows = {};

async function workDay(m, date, inT, outT) {
  const r = await ok(h.api().post('/api/equipment/attendance/check-in').set(S8()).send({ equipment_id: m.equipment_id, site_id: 8, check_in_time: `${date} ${inT}`, check_out_time: `${date} ${outT}`, late_reason: 'paper sheet typed late' }));
  await ok(h.api().post('/api/equipment/attendance/submit').set(S8()).send({ site_id: 8, record_date: date }));
  await ok(h.api().post('/api/equipment/admin/attendance/approve').set(A()).send({ ids: [r.eq_attendance_id] }));
  return r.eq_attendance_id;
}

before(async () => {
  await h.resetDatabase();
  await h.query("INSERT INTO users (user_id, username, full_name, password_hash, role, must_change_password) VALUES (5, 'acc2', 'Accountant Two', 'x', 'Accountant', 0)");
  F = await standardFleet();
  rows.a = await workDay(F.exc, '2026-10-05', '07:00', '15:00');
  rows.b = await workDay(F.exc, '2026-10-06', '07:00', '15:00');
  rows.c = await workDay(F.exc, '2026-10-07', '07:00', '15:00');
  oct = await ok(h.api().post('/api/equipment/payroll/generate').set(ACC()).send({ start_date: '2026-10-01', end_date: '2026-10-31', equipment_id: F.exc.equipment_id }));
  const sheets = await ok(h.api().get(`/api/equipment/timesheets?month=2026-10&equipment_id=${F.exc.equipment_id}`).set(ACC()));
  await ok(h.api().post(`/api/equipment/timesheets/${sheets[0].timesheet_id}/scans`).set(ACC()).attach('files', await QRCode.toBuffer('signed'), 'scan.png'));
  await ok(h.api().patch(`/api/equipment/payroll/batches/${oct.eq_batch_id}/finalize`).set(A()).send({ acknowledge_changes: true }));
});
after(h.closePool);

test('the Admin asks for a correction: applied at once, with a note and the settlement adjustment', async () => {
  const res = await h.api().post(`/api/equipment/admin/attendance/${rows.a}/correction`).set(A())
    .send({ reason: 'Signed sheet shows 16:00', changes: { check_out_time: '2026-10-05 16:00' } });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  assert.match(res.body.message, /Correction applied/);
  const c = res.body.data;
  assert.strictEqual(c.request_status, 'Approved');
  assert.strictEqual(c.approved_by_user_id, 1);
  assert.strictEqual(Number(c.delta_amount), 40); // 8 h -> 9 h at 40
  assert.match(c.note.invoice_no, /^DN-\d{4}-\d{5}$/);
  const [adj] = await h.query('SELECT amount FROM eq_adjustments WHERE correction_id = ?', [c.correction_id]);
  assert.strictEqual(Number(adj.amount), 40);
  const [row] = await h.query('SELECT check_out_time FROM eq_attendance WHERE eq_attendance_id = ?', [rows.a]);
  assert.strictEqual(row.check_out_time, '2026-10-05 16:00:00');
  assert.deepStrictEqual(c.events.map((e) => e.action), ['request', 'approve']);
});

let pending;
test('the Accountant asks: the correction waits (Requested) and nothing changes yet', async () => {
  const res = await h.api().post(`/api/equipment/admin/attendance/${rows.b}/correction`).set(ACC())
    .send({ reason: 'Signed sheet shows 16:00', changes: { check_out_time: '2026-10-06 16:00' } });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  assert.match(res.body.message, /Sent to the Admin/);
  pending = res.body.data;
  assert.strictEqual(pending.request_status, 'Requested');
  const [row] = await h.query('SELECT check_out_time FROM eq_attendance WHERE eq_attendance_id = ?', [rows.b]);
  assert.strictEqual(row.check_out_time, '2026-10-06 15:00:00');
  const list = await ok(h.api().get('/api/equipment/admin/corrections?request_status=Requested,Reviewed').set(A()));
  assert.ok(list.find((x) => x.correction_id === pending.correction_id && x.can_approve === true), 'the Admin sees it as waiting for them');
  const accList = await ok(h.api().get('/api/equipment/admin/corrections?request_status=Requested,Reviewed').set(ACC()));
  assert.strictEqual(accList.find((x) => x.correction_id === pending.correction_id).can_approve, false);
});

test('another Accountant cannot approve it (403), nor can the requester', async () => {
  const r2 = await h.api().patch(`/api/equipment/admin/corrections/${pending.correction_id}/approve`).set(ACC2()).send({});
  assert.strictEqual(r2.status, 403);
  assert.strictEqual(r2.body.code, 'ADMIN_APPROVES');
  assert.strictEqual(await code(h.api().patch(`/api/equipment/admin/corrections/${pending.correction_id}/approve`).set(ACC()).send({})), 'ADMIN_APPROVES');
});

test('the Admin approves the Accountant\'s correction', async () => {
  const done = await ok(h.api().patch(`/api/equipment/admin/corrections/${pending.correction_id}/approve`).set(A()).send({ note: 'ok' }));
  assert.strictEqual(done.request_status, 'Approved');
  assert.strictEqual(done.note.kind, 'DebitNote');
  const [row] = await h.query('SELECT check_out_time FROM eq_attendance WHERE eq_attendance_id = ?', [rows.b]);
  assert.strictEqual(row.check_out_time, '2026-10-06 16:00:00');
});

test('the Admin amends the Accountant\'s request and approves that version', async () => {
  const c = await ok(h.api().post(`/api/equipment/admin/attendance/${rows.c}/correction`).set(ACC())
    .send({ reason: 'Signed sheet shows 16:00', changes: { check_out_time: '2026-10-07 16:00' } }));
  assert.strictEqual(Number(c.delta_amount), 40);
  const rv = await ok(h.api().patch(`/api/equipment/admin/corrections/${c.correction_id}/review`).set(A())
    .send({ note: 'the sheet says 17:00', changes: { check_out_time: '2026-10-07 17:00' } }));
  assert.strictEqual(rv.request_status, 'Reviewed');
  assert.strictEqual(Number(rv.delta_amount), 80);
  const done = await ok(h.api().patch(`/api/equipment/admin/corrections/${c.correction_id}/approve`).set(A()).send({}));
  assert.strictEqual(done.request_status, 'Approved');
  assert.deepStrictEqual(done.events.map((e) => e.action), ['request', 'review', 'approve']);
  const [adj] = await h.query('SELECT amount FROM eq_adjustments WHERE correction_id = ?', [c.correction_id]);
  assert.strictEqual(Number(adj.amount), 80);
});

test('a financial correction by the Admin is applied at once; by the Accountant it waits', async () => {
  const b = await ok(h.api().get(`/api/equipment/payroll/batches/${oct.eq_batch_id}`).set(ACC()));
  const item = b.items[0];
  const res = await h.api().post('/api/equipment/admin/corrections/financial').set(A())
    .send({ target_type: 'rate_card', target_id: item.rate_card_id, eq_item_id: item.eq_item_id, amount: -10, reason: 'Agreed discount not applied' });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  assert.strictEqual(res.body.data.request_status, 'Approved');
  assert.strictEqual(res.body.data.note.kind, 'CreditNote');
  const acc = await ok(h.api().post('/api/equipment/admin/corrections/financial').set(ACC())
    .send({ target_type: 'other', eq_item_id: item.eq_item_id, amount: 5, reason: 'Transport of the machine' }));
  assert.strictEqual(acc.request_status, 'Requested');
});
